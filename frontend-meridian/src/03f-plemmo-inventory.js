/* ============================================================================
 * 03f-plemmo-inventory.js — Inventory / purchasing adapter (Meridian → Plemmo)
 * ----------------------------------------------------------------------------
 * Inventory / Purchasing phase. Plemmo owns the single authoritative stock
 * ledger (inventory_movements + balances). Meridian's `S.stockLog` is NOT a
 * second ledger — every stock change goes through /api/inventory/adjust, and the
 * product's on-hand quantity is refreshed from the movement's balance_after.
 *
 * Meridian's three stock actions map to the one ledger:
 *   receive → +qty, movement_type 'receipt'
 *   waste   → -qty, movement_type 'adjustment' (with a reason)
 *   count   → set to a counted quantity (stocktake): delta = counted - current,
 *             movement_type 'adjustment'. A zero delta is a no-op.
 *
 * Pure helpers are exposed for unit testing.
 * ==========================================================================*/
(function () {
  'use strict';

  const api = () => window.PlemmoAPI;

  // Map a Meridian adjust action to a Plemmo /inventory/adjust request body.
  // Returns null when there is nothing to do (a count that matches on-hand).
  function buildAdjustBody(mode, productId, qty, currentQty, reason, locationId) {
    let delta, movementType, defaultReason;
    if (mode === 'receive') { delta = Math.abs(Math.round(qty)); movementType = 'receipt'; defaultReason = 'Delivery'; }
    else if (mode === 'waste') { delta = -Math.abs(Math.round(qty)); movementType = 'adjustment'; defaultReason = 'Wastage'; }
    else if (mode === 'count') { delta = Math.round(qty) - Math.round(currentQty || 0); movementType = 'adjustment'; defaultReason = 'Stock count'; }
    else throw new Error('Unknown stock adjust mode: ' + mode);
    if (delta === 0) return null;
    const body = { product_id: productId, quantity_delta: delta, movement_type: movementType, reason: reason || defaultReason };
    if (locationId) body.location_id = locationId;
    return body;
  }

  // Refresh a product's on-hand quantity in local state from the authoritative
  // balance returned by Plemmo (never trust a locally computed number).
  function applyBalance(S, productId, balanceAfter) {
    if (!S || !Array.isArray(S.products)) return;
    const p = S.products.find((x) => x.id === productId);
    if (p && typeof balanceAfter === 'number') p.stock = balanceAfter;
  }

  const PlemmoInventory = {
    buildAdjustBody: buildAdjustBody,
    applyBalance: applyBalance,

    balance: function (productId) { return api().get('/inventory/balance?product_id=' + encodeURIComponent(productId)); },
    history: function (productId, limit) { return api().get('/inventory/history?product_id=' + encodeURIComponent(productId) + (limit ? ('&limit=' + limit) : '')); },
    lowStock: function () { return api().get('/inventory/low-stock'); },

    // Core write path — returns { movement }. Caller applies balance_after.
    adjust: function (mode, productId, qty, currentQty, reason, locationId) {
      const body = buildAdjustBody(mode, productId, qty, currentQty, reason, locationId);
      if (!body) return Promise.resolve({ movement: null, noop: true });
      return api().post('/inventory/adjust', body, { idempotent: true });
    },
    receive: function (productId, qty, reason, locationId) { return this.adjust('receive', productId, qty, null, reason, locationId); },
    waste: function (productId, qty, reason, locationId) { return this.adjust('waste', productId, qty, null, reason, locationId); },
    count: function (productId, countedQty, currentQty, reason, locationId) { return this.adjust('count', productId, countedQty, currentQty, reason, locationId); },
  };

  // Thin clients for the existing Plemmo purchasing surfaces so Meridian can
  // surface suppliers, purchase orders and transfers without a second system.
  const PlemmoSuppliers = {
    list: function () { return api().get('/suppliers'); },
    get: function (id) { return api().get('/suppliers/' + encodeURIComponent(id)); },
    create: function (s) { return api().post('/suppliers', s, { idempotent: true }); },
    update: function (id, s) { return api().put('/suppliers/' + encodeURIComponent(id), s); },
    remove: function (id) { return api().del('/suppliers/' + encodeURIComponent(id)); },
  };

  const PlemmoPurchasing = {
    list: function (q) { return api().get('/purchase-orders' + (q ? ('?' + q) : '')); },
    get: function (id) { return api().get('/purchase-orders/' + encodeURIComponent(id)); },
    create: function (po) { return api().post('/purchase-orders', po, { idempotent: true }); },
    addItem: function (id, item) { return api().post('/purchase-orders/' + encodeURIComponent(id) + '/items', item, { idempotent: true }); },
    markOrdered: function (id) { return api().post('/purchase-orders/' + encodeURIComponent(id) + '/mark-ordered', {}, { idempotent: true }); },
    receive: function (id, items, idempotencyKey) { return api().post('/purchase-orders/' + encodeURIComponent(id) + '/receive', { items: items, idempotency_key: idempotencyKey }, { idempotent: true }); },
    cancel: function (id) { return api().post('/purchase-orders/' + encodeURIComponent(id) + '/cancel', {}, { idempotent: true }); },
  };

  const PlemmoTransfers = {
    list: function () { return api().get('/transfers'); },
    get: function (id) { return api().get('/transfers/' + encodeURIComponent(id)); },
    create: function (t) { return api().post('/transfers', t, { idempotent: true }); },
    addItem: function (id, item) { return api().post('/transfers/' + encodeURIComponent(id) + '/items', item, { idempotent: true }); },
    complete: function (id) { return api().post('/transfers/' + encodeURIComponent(id) + '/complete', {}, { idempotent: true }); },
    cancel: function (id) { return api().post('/transfers/' + encodeURIComponent(id) + '/cancel', {}, { idempotent: true }); },
  };

  window.PlemmoInventory = PlemmoInventory;
  window.PlemmoSuppliers = PlemmoSuppliers;
  window.PlemmoPurchasing = PlemmoPurchasing;
  window.PlemmoTransfers = PlemmoTransfers;
})();
