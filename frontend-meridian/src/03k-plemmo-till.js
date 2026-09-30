/* ============================================================================
 * 03k-plemmo-till.js — Till operations adapter (Meridian → Plemmo)
 * ----------------------------------------------------------------------------
 * Refund, void, receipt printing, held carts, database backup, hardware status
 * and barcode lookup. Every function here is a thin call to an EXISTING Plemmo
 * backend route; none of them contains business logic and none of them writes
 * to Meridian's `S` cache. The backend decides (authorization, PIN approval,
 * idempotency, audit, stock, cash drawer, loyalty, printing); the UI only
 * reports what the backend answered.
 *
 *   refund      POST  /api/bills/:id/refund
 *   void        PATCH /api/orders/:id/status   { status: 'cancelled' }
 *   print       POST  /api/printers/print-bill (then /api/bills/:id/print → log)
 *   hold        /api/held-orders/carts…
 *   backup      POST  /api/db/backup           (owner + Master PIN)
 *   devices     /api/printers, /printers/detect, /printers/:id/test,
 *               /retail/cash-drawer/open, /kitchen-stations
 *   barcode     GET   /api/retail/lookup?code=
 *
 * The pure helpers (deviceRows, scan detector, cart sanitiser) are exposed for
 * unit tests. Depends on window.PlemmoAPI (00-plemmo-api.js).
 * ==========================================================================*/
(function () {
  'use strict';

  const api = () => window.PlemmoAPI;
  const enc = encodeURIComponent;

  // The message to show for a failed call: the backend's own words first.
  function errorMessage(e, fallback) {
    return (e && e.data && e.data.error) || (e && e.message) || fallback || 'Something went wrong';
  }
  // A network-level failure (server unreachable) as opposed to the server
  // answering with a refusal. PlemmoAPI leaves `status` undefined for the former.
  function isNetworkError(e) { return !!e && e.status === undefined; }

  // DB timestamps are UTC wall time "YYYY-MM-DD HH:MM:SS".
  function parseDbTime(s) {
    if (!s) return Date.now();
    const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(s) ? s.replace(' ', 'T') + 'Z' : s);
    return isNaN(t) ? Date.now() : t;
  }

  /* ---------- Refund / void ---------- */

  // Refund a bill. `key` makes a retry of the SAME refund replay instead of
  // refunding twice. `overridePin` is a manager/owner PIN when the signed-in
  // user cannot refund on their own; the backend validates it.
  function refundBill(billId, opts) {
    opts = opts || {};
    const body = { reason: opts.reason };
    if (opts.items && opts.items.length) body.items = opts.items.map((i) => ({ order_item_id: i.id, quantity: i.qty }));
    if (opts.amount != null) body.amount = opts.amount;
    if (opts.overridePin) body.override_pin = String(opts.overridePin);
    return api().post('/bills/' + enc(billId) + '/refund', body, { idempotent: true, idempotencyKey: opts.key });
  }

  // Void = cancel an UNPAID order. A paid order is refused by the backend (409)
  // and must be refunded instead.
  function cancelOrder(orderId, opts) {
    opts = opts || {};
    const body = { status: 'cancelled' };
    if (opts.reason) body.reason = opts.reason;
    if (opts.overridePin) body.override_pin = String(opts.overridePin);
    return api().request('/orders/' + enc(orderId) + '/status', { method: 'PATCH', body: body, idempotent: false });
  }

  // Apply (or, with value 0, remove) an order discount. The backend enforces who may
  // discount (owner/manager, or anyone with a manager PIN), the configured mode and
  // maximums, recomputes tax and the bill, and audits it. Rejects with e.data.requiresApproval
  // when a manager PIN is needed.
  function applyDiscount(orderId, d) {
    const body = { discount_type: d.kind === 'pct' ? 'percentage' : 'amount', discount_value: Number(d.value) || 0 };
    if (d.reason) body.discount_reason = String(d.reason);
    if (d.pin) body.override_pin = String(d.pin);
    return api().request('/orders/' + enc(orderId) + '/discount', { method: 'PATCH', body: body, idempotent: false });
  }

  // Re-read one order from the backend (the authoritative state after a change).
  function fetchOrder(orderId) {
    return api().get('/orders/' + enc(orderId)).then((r) => (r && r.order) || r);
  }

  /* ---------- Receipt printing ---------- */

  // Send a bill to the configured receipt printer. Resolves ONLY when the
  // backend reports the job was delivered to the printer transport; rejects
  // with the backend's reason (no printer, unreachable, …) otherwise. The print
  // log is written afterwards and never turns a real success into a failure.
  function printBill(billId, opts) {
    opts = opts || {};
    return api().post('/printers/print-bill', { billId: billId, isReprint: !!opts.reprint }, { idempotent: false })
      .then((res) => {
        api().post('/bills/' + enc(billId) + '/print', { print_type: opts.reprint ? 'reprint' : 'receipt' }, { idempotent: false })
          .catch(function () { /* the print happened; the log entry is best-effort */ });
        return res;
      });
  }

  /* ---------- Held carts ---------- */

  // What is sent to the backend for a held cart: the cart's content only —
  // never an approval PIN or any transient UI flag.
  function sanitizeCart(cart) {
    const items = (cart.items || []).map((l) => {
      const out = { uid: l.uid, key: l.key, pid: l.pid, name: l.name, price: l.price, cost: l.cost, qty: l.qty,
        mods: (l.mods || []).map((m) => ({ g: m.g, n: m.n, p: m.p })), note: l.note || '' };
      if (l.override) { out.override = { reason: l.override.reason }; out.listPrice = l.listPrice; }
      return out;
    });
    return { items: items, type: cart.type, table: cart.table || null, custId: cart.custId || null,
      discount: cart.discount || null, note: cart.note || '' };
  }
  // A held-cart id from the platform's CSPRNG (not Math.random), prefixed for readability.
  function newId(prefix) {
    let hex = '';
    try {
      const b = new Uint8Array(12);
      (window.crypto || window.msCrypto).getRandomValues(b);
      b.forEach((x) => { hex += ('0' + x.toString(16)).slice(-2); });
    } catch (e) { throw new Error('Secure random numbers are not available in this browser'); }
    return (prefix || 'id') + '_' + hex;
  }
  function toHeld(c) { return { id: c.id, ts: parseDbTime(c.heldAt), by: c.heldBy, label: c.label, cart: c.cart }; }

  const held = {
    hold: function (id, label, cart) { return api().post('/held-orders/carts', { id: id, label: label, cart: sanitizeCart(cart) }, { idempotent: false }); },
    list: function () { return api().get('/held-orders/carts').then((r) => ((r && r.carts) || []).map(toHeld)); },
    resume: function (id) { return api().post('/held-orders/carts/' + enc(id) + '/resume', {}, { idempotent: false }).then(toHeld); },
    discard: function (id) { return api().del('/held-orders/carts/' + enc(id), { idempotent: false }); },
  };

  /* ---------- Backup ---------- */

  function masterPinStatus() { return api().get('/db-tools/master-pin/status'); }
  // The authoritative SQLite backup. Owner + Master PIN, enforced by the server.
  function createBackup(masterPin) { return api().post('/db/backup', { master_pin: String(masterPin || '') }, { idempotent: false }); }

  /* ---------- Hardware ---------- */

  const hardware = {
    printers: function () { return api().get('/printers').then((r) => (r && r.printers) || []); },
    detect: function () { return api().get('/printers/detect').then((r) => (r && r.printers) || []); },
    stations: function () { return api().get('/kitchen-stations').then((r) => (r && r.kitchenStations) || []); },
    addPrinter: function (p) { return api().post('/printers', p, { idempotent: false }); },
    testPrinter: function (id) { return api().post('/printers/' + enc(id) + '/test', {}, { idempotent: false }); },
    openDrawer: function () { return api().post('/retail/cash-drawer/open', {}, { idempotent: false }); },
  };

  // Turn what the backend actually knows into rows for the Devices panel. PURE.
  // Nothing here is invented: a printer is "Configured" (the backend has no
  // live connection state), and only becomes "Test successful"/"Test failed"
  // after a real test. A card reader is never "connected" — no integration
  // exists. `state`: { loaded, error, printers, detected, stations, results,
  // online, lastScan }. `results`: { [key]: { ok, message, at } } from real tests.
  function deviceRows(state) {
    const st = state || {};
    const results = st.results || {};
    const printers = st.printers || [];
    const def = printers.find((p) => p.is_default) || printers[0] || null;
    const rows = [];

    const res = (key) => results[key] || null;
    const testBadge = (r, fallbackBadge) => r ? (r.ok ? { kind: 'ok', text: 'Test successful' } : { kind: 'bad', text: 'Test failed' }) : fallbackBadge;

    // Receipt printer
    if (!st.loaded) {
      rows.push({ key: 'printer', icon: 'printer', name: 'Receipt printer', detail: st.error ? errorMessage({ message: st.error }) : 'Checking…', badge: st.error ? { kind: 'warn', text: 'Unavailable' } : { kind: 'info', text: 'Checking' } });
    } else if (!def) {
      rows.push({ key: 'printer', icon: 'printer', name: 'Receipt printer', detail: 'No printer is set up. Add a network printer below, or set one up in the desktop app.', badge: { kind: 'warn', text: 'Not configured' }, action: null });
    } else if (def.connection_type === 'webusb') {
      rows.push({ key: 'printer', icon: 'printer', name: 'Receipt printer', detail: `${def.name} is a browser (WebUSB) printer, which this till can't drive.`, badge: { kind: 'warn', text: 'Unsupported here' }, action: null });
    } else {
      const where = def.connection_type === 'network' ? `${def.ip_address || '?'}:${def.port || 9100}` : (def.connection_type === 'usb' ? 'USB / system printer' : def.connection_type);
      const r = res('printer');
      rows.push({ key: 'printer', icon: 'printer', name: 'Receipt printer',
        detail: `${def.name}, ${where}, ${def.paper_width || 'default width'}${r ? ' — ' + r.message : ''}`,
        badge: testBadge(r, { kind: 'info', text: 'Configured' }), action: { id: 'test-printer', label: 'Print a test', printerId: def.id } });
    }

    // Cash drawer: the drawer is kicked through the receipt printer.
    {
      const r = res('drawer');
      if (!def || def.connection_type === 'webusb') {
        rows.push({ key: 'drawer', icon: 'drawer', name: 'Cash drawer', detail: 'Opens through the receipt printer, so it needs a printer first.', badge: { kind: 'warn', text: 'Not configured' }, action: null });
      } else {
        rows.push({ key: 'drawer', icon: 'drawer', name: 'Cash drawer',
          detail: r ? r.message : 'Opens through the receipt printer. The till cannot sense whether the drawer is connected — press the test and watch the drawer.',
          badge: testBadge(r, { kind: 'info', text: 'Not tested' }), action: { id: 'open-drawer', label: 'Open the drawer' } });
      }
    }

    // Kitchen printing
    {
      const stations = st.stations || [];
      const withPrinter = stations.filter((s) => s.printer_id);
      rows.push({ key: 'kitchen', icon: 'chef', name: 'Kitchen printing',
        detail: withPrinter.length ? `${withPrinter.length} station${withPrinter.length === 1 ? '' : 's'} print to a kitchen printer` : 'No kitchen station has a printer. Tickets use the kitchen display / default printer.',
        badge: withPrinter.length ? { kind: 'info', text: 'Configured' } : { kind: 'warn', text: 'Not configured' }, action: null });
    }

    // Card reader: there is no card-terminal integration in this product.
    rows.push({ key: 'card', icon: 'card', name: 'Card reader',
      detail: 'Not integrated. Take card payments on your card terminal, then record them at the till. The till never reports a reader as connected.',
      badge: { kind: 'warn', text: 'Not integrated' }, action: null });

    // Barcode scanner: keyboard-wedge, nothing to configure; report only what was seen.
    {
      const s = st.lastScan;
      rows.push({ key: 'scanner', icon: 'search', name: 'Barcode scanner',
        detail: s ? `Last scan: ${s.code} — ${s.ok ? (s.name || 'found') : (s.message || 'not found')}` : 'USB and Bluetooth keyboard-style scanners work in the item search. Scan an item to see it here.',
        badge: s ? (s.ok ? { kind: 'ok', text: 'Scan received' } : { kind: 'warn', text: 'Scan not matched' }) : { kind: 'info', text: 'No scan yet' }, action: null });
    }

    // Connection to the till server (what this browser can actually observe).
    rows.push({ key: 'link', icon: 'wifi', name: 'Till server connection',
      detail: 'Sales are saved by the till first and synced when a connection is available.',
      badge: st.online === false ? { kind: 'warn', text: 'Offline' } : { kind: 'ok', text: 'Online' }, action: null });

    return rows;
  }

  // Printers the backend detected that are not configured yet → "Add" offers.
  function detectedOffers(detected, printers) {
    const known = (printers || []).map((p) => (p.connection_type + '|' + (p.ip_address || '') + '|' + p.name).toLowerCase());
    return (detected || []).filter((d) => {
      const type = d.connectionType || d.connection_type;
      if (type !== 'usb' && type !== 'network') return false; // e.g. bluetooth: can't be added here
      const ip = d.ipAddress || d.ip_address || '';
      return !known.includes((type + '|' + ip + '|' + d.name).toLowerCase());
    });
  }

  /* ---------- Barcode ---------- */

  // Resolve a scanned code through the backend (products + variants, barcode or
  // SKU). Resolves { kind:'product'|'variant', product, variant } or rejects
  // with status 404 when nothing matches.
  function lookupBarcode(code) {
    return api().get('/retail/lookup?code=' + enc(String(code || '').trim()));
  }

  // Keyboard-wedge scan detector. A scanner "types" the code in a few
  // milliseconds and finishes with Enter (or Tab); a person cannot. So a run of
  // printable keys with tiny gaps, closed by a terminator, is ONE scan; anything
  // slower or shorter is ordinary typing and is left completely alone.
  //   det.key({ key, ts, value }) → { scan, restore } when a scan just completed,
  //   { scan: null } otherwise. `restore` is the field's text from BEFORE the
  //   scan started, so the caller can undo the characters the browser typed.
  function createScanDetector(opts) {
    opts = opts || {};
    const maxGap = opts.maxGap || 50;      // ms between keys inside a scan
    const minLen = opts.minLen || 4;       // shortest code treated as a scan
    let buf = '', last = 0, pre = '';
    function reset() { buf = ''; pre = ''; }
    return {
      key: function (ev) {
        const k = ev.key, ts = ev.ts;
        if (k && k.length === 1) {
          if (buf && ts - last > maxGap) reset();          // a pause → human typing
          if (!buf) pre = ev.value == null ? '' : ev.value; // text before the first char lands
          buf += k; last = ts;
          return { scan: null };
        }
        if (k === 'Enter' || k === 'Tab') {
          const isScan = buf.length >= minLen && ts - last <= maxGap * 2;
          const out = isScan ? { scan: buf, restore: pre } : { scan: null };
          reset();
          return out;
        }
        reset();                                            // editing keys, arrows, etc.
        return { scan: null };
      },
      reset: reset,
    };
  }

  window.PlemmoTill = {
    errorMessage: errorMessage, isNetworkError: isNetworkError, parseDbTime: parseDbTime,
    refundBill: refundBill, cancelOrder: cancelOrder, applyDiscount: applyDiscount, fetchOrder: fetchOrder,
    printBill: printBill,
    sanitizeCart: sanitizeCart, held: held, newId: newId,
    masterPinStatus: masterPinStatus, createBackup: createBackup,
    hardware: hardware, deviceRows: deviceRows, detectedOffers: detectedOffers,
    lookupBarcode: lookupBarcode,
  };
  window.PlemmoScan = { create: createScanDetector };
})();
