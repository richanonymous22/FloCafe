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

  window.PlemmoOrders = {
    orderTypeToChannel: orderTypeToChannel,
    cartLineToItem: cartLineToItem,
    cartToOrderBody: cartToOrderBody,
    createOrder: createOrder
  };
})();
