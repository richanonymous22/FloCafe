/* ============================================================================
 * 03g-plemmo-tables.js — Tables / floor plan / KDS / kiosk adapter
 * ----------------------------------------------------------------------------
 * Hospitality phase. Plemmo owns tables + floor-plan geometry (persisted via
 * migration v92: shape/size/width/height/rotation alongside position_x/y and
 * capacity), the kitchen display, and kiosk orders. Meridian's floor plan is no
 * longer frontend/localStorage state — it round-trips through /api/tables and is
 * safe for multi-device/location use.
 *
 * Pure mappers are exposed for unit testing.
 * ==========================================================================*/
(function () {
  'use strict';

  const api = () => window.PlemmoAPI;

  // Plemmo table row → Meridian floor-plan table shape.
  function mapPlemmoTable(t) {
    return {
      id: t.id,
      name: t.number != null ? String(t.number) : (t.name || ''),
      seats: Number(t.capacity) || 0,
      shape: t.shape || 'square',
      size: t.size || 'm',
      x: t.position_x != null ? Number(t.position_x) : 0,
      y: t.position_y != null ? Number(t.position_y) : 0,
      rotation: Number(t.rotation) || 0,
      floor: t.floor || null,
      section: t.section || null,
      status: t.status || 'available',
      activeOrder: t.activeOrder || t.current_order || null,
    };
  }

  // Meridian table → Plemmo create/update body (geometry + identity).
  function mapToPlemmoBody(t) {
    return {
      number: t.name,
      capacity: t.seats,
      position_x: t.x,
      position_y: t.y,
      shape: t.shape,
      size: t.size,
      rotation: t.rotation || 0,
      floor: t.floor || null,
      section: t.section || null,
    };
  }

  const PlemmoTables = {
    mapPlemmoTable: mapPlemmoTable,
    mapToPlemmoBody: mapToPlemmoBody,

    list: function () { return api().get('/tables').then((r) => ((r && r.tables) || []).map(mapPlemmoTable)); },
    // Hydrate S.tables from authoritative Plemmo data (read-through).
    load: async function (S) {
      const tables = await this.list();
      if (S) S.tables = tables;
      return tables;
    },
    create: function (t) { return api().post('/tables', mapToPlemmoBody(t), { idempotent: true }).then((r) => (r && r.table) || r); },
    // Persist a floor-plan edit (position/shape/size/rotation) for one table.
    saveLayout: function (id, t) { return api().put('/tables/' + encodeURIComponent(id), mapToPlemmoBody(t)).then((r) => (r && r.table) || r); },
    // Persist an entire layout in one pass (drag-and-drop editor save).
    saveAll: function (tables) { return Promise.all(tables.map((t) => this.saveLayout(t.id, t))); },
    setStatus: function (id, status) { return api().patch ? api().request('/tables/' + encodeURIComponent(id) + '/status', { method: 'PATCH', body: { status: status }, idempotent: true }) : null; },
  };

  // Kitchen display — real tickets from Plemmo, real status transitions.
  const PlemmoKDS = {
    orders: function () { return api().get('/kds/orders'); },
    kitchen: function () { return api().get('/kitchen/orders'); },
    setItemStatus: function (itemId, status) {
      return api().request('/kds/items/' + encodeURIComponent(itemId) + '/status', { method: 'PATCH', body: { status: status }, idempotent: true });
    },
    // Customer-facing collection board.
    board: function () { return api().get('/kds-info'); },
  };

  // Self-service kiosk — a real Plemmo sale (never a local-only order). Reuses
  // the authoritative order-commit path with the kiosk channel.
  const PlemmoKiosk = {
    submitOrder: function (cart) {
      const kioskCart = Object.assign({}, cart, { type: cart.type || 'kiosk' });
      return window.PlemmoOrders.createOrder(kioskCart, (typeof S !== 'undefined' && S && S._plemmoAddons) || {});
    },
  };

  window.PlemmoTables = PlemmoTables;
  window.PlemmoKDS = PlemmoKDS;
  window.PlemmoKiosk = PlemmoKiosk;
})();
