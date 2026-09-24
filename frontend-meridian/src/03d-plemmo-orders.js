/* ============================================================================
 * 03d-plemmo-orders.js — Order commit adapter (Meridian cart → Plemmo sale)
 * ----------------------------------------------------------------------------
 * Phase 2/3 (Core POS) of the Meridian → Plemmo integration.
 *
 * Plemmo is authoritative for prices, tax, discounts and totals. This module
 * turns a Meridian cart into a Plemmo sale by POSTing to /api/orders, where
 * the sale engine (core/sale.ts) computes the authoritative money. Meridian
 * never invents a total — it displays what Plemmo returns.
 *
 * Idempotency: each commit sends an Idempotency-Key so a retried request (a
 * dropped response, a reconnect) never creates a duplicate sale.
 *
 * Pure mappers are exposed on window.PlemmoOrders for unit testing.
 * ==========================================================================*/
(function () {
  'use strict';

  // Meridian order type → Plemmo sale channel (SaleChannel in core/sale.ts).
  const CHANNELS = { dine: 'dine_in', takeaway: 'takeaway', delivery: 'delivery', retail: 'in_store', kiosk: 'takeaway' };
  function orderTypeToChannel(type) { return CHANNELS[type] || 'takeaway'; }

  // One Meridian cart line → one Plemmo sale line input.
  // line.mods entries are { n: label, p: priceDelta, g: groupId }; resolve each
  // to its authoritative addon id via the catalogue addon index.
  function cartLineToItem(line, addonIndex) {
    const item = { product_id: line.pid, quantity: line.qty };
    const mods = Array.isArray(line.mods) ? line.mods : [];
    const addons = [];
    mods.forEach((m) => {
      const group = (addonIndex && m.g && addonIndex[m.g]) || null;
      const hit = group ? group[m.n] : null;
      if (hit && hit.id) addons.push({ id: hit.id, addon_group_id: m.g, name: m.n, price: hit.price, quantity: 1 });
      else addons.push({ name: m.n, price: Number(m.p) || 0, quantity: 1 }); // fallback: label-only
    });
    if (addons.length) item.addons = addons;
    if (line.note) item.special_instructions = line.note;
    return item;
  }

  // Build the full POST /api/orders body from a Meridian cart.
  function cartToOrderBody(cart, addonIndex) {
    const items = (cart.items || []).map((l) => cartLineToItem(l, addonIndex));
    const body = { type: orderTypeToChannel(cart.type), items: items };
    if (cart.customerId || cart.customer_id) body.customer_id = cart.customerId || cart.customer_id;
    if (cart.table) body.table_id = cart.table;
    if (cart.guests) body.guest_count = cart.guests;
    if (cart.note) body.special_instructions = cart.note;
    return body;
  }

  // Commit the cart to Plemmo. Returns the authoritative order (with totals).
  async function createOrder(cart, addonIndex) {
    const api = window.PlemmoAPI;
    const idx = addonIndex || (typeof S !== 'undefined' && S && S._plemmoAddons) || {};
    const body = cartToOrderBody(cart, idx);
    if (!body.items.length) throw new Error('The order is empty.');
    const res = await api.post('/orders', body, { idempotent: true, idempotencyKey: cart._idem || api.idempotencyKey() });
    return (res && res.order) || res;
  }

  // Plemmo sale channel → Meridian order type (reverse of orderTypeToChannel).
  const CHANNEL_TO_TYPE = { dine_in: 'dine', takeaway: 'takeaway', delivery: 'delivery', online: 'takeaway', in_store: 'retail' };

  function parseMaybeJson(v, fallback) {
    if (v == null) return fallback;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (e) { return fallback; }
  }

  // A full authoritative Plemmo order (with items + bills) → Meridian's order
  // shape, so the reports/dashboard/Z-report/CSV compute over real history.
  function mapPlemmoOrder(o) {
    const ts = o.created_at ? (Date.parse(o.created_at) || Date.now()) : Date.now();
    const bills = o.bills || (o.bill ? [o.bill] : []);
    const payments = []; let tip = 0;
    bills.forEach((b) => {
      parseMaybeJson(b && b.payment_details, []).forEach((p) => {
        payments.push({ m: p.method === 'cash' ? 'cash' : 'card', a: Number(p.amount) || 0 });
        tip += Number(p.tip) || 0;
      });
    });
    const paid = bills.some((b) => b && b.payment_status === 'paid') || o.status === 'completed' || o.status === 'paid';
    const status = (o.status === 'cancelled' || o.status === 'void') ? 'void'
      : o.status === 'refunded' ? 'refunded' : paid ? 'paid' : 'open';
    const items = (o.items || []).map((i) => {
      const mods = [];
      parseMaybeJson(i.addons, []).forEach((a) => mods.push({ n: (a && (a.name || a)) || '' }));
      return { pid: i.product_id, name: i.product_name, price: Number(i.unit_price) || 0, cost: 0,
        qty: Number(i.quantity) || 0, mods: mods, note: i.special_instructions || '', sent: true, uid: 'l' + i.id };
    });
    return {
      id: 'po' + o.id, no: o.order_number || o.id, plemmoOrderId: o.id,
      ts: ts, opened: ts, empId: o.user_id || null,
      type: CHANNEL_TO_TYPE[o.type] || 'takeaway', table: o.table_id || null, custId: o.customer_id || null,
      source: 'pos', items: items,
      subtotal: Number(o.subtotal) || 0, tax: Number(o.tax_amount) || 0, discAmt: Number(o.discount_amount) || 0,
      total: Number(o.total) || 0, tip: Math.round(tip * 100) / 100, payments: payments, status: status, pts: 0, discount: null,
    };
  }

  // Load recent authoritative order history (paged) mapped to Meridian's shape.
  async function history(opts) {
    opts = opts || {};
    const api = window.PlemmoAPI;
    const per = 100, max = opts.max || 400;
    let before = null, out = [], guard = 0;
    const range = 'start_date=' + encodeURIComponent(opts.fromDate) + (opts.toDate ? '&end_date=' + encodeURIComponent(opts.toDate) : '');
    do {
      const res = await api.get('/orders?per_page=' + per + '&' + range + (before ? '&before_id=' + before : ''));
      const orders = (res && res.orders) || [];
      for (let i = 0; i < orders.length; i++) out.push(mapPlemmoOrder(orders[i]));
      before = res && res.nextCursor;
      guard++;
    } while (before && out.length < max && guard < 10);
    return out;
  }

  window.PlemmoOrders = {
    orderTypeToChannel: orderTypeToChannel,
    cartLineToItem: cartLineToItem,
    cartToOrderBody: cartToOrderBody,
    createOrder: createOrder,
    mapPlemmoOrder: mapPlemmoOrder,
    history: history
  };
})();
