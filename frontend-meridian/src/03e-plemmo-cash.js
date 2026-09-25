/* ============================================================================
 * 03e-plemmo-cash.js — Cash drawer + tips adapter (Meridian → Plemmo)
 * ----------------------------------------------------------------------------
 * Payments + Cash phase. Plemmo is authoritative for the cash drawer and for
 * payments/tips. This module is the client the Meridian drawer + pay views call
 * so no cash state lives only in the browser.
 *
 * Money crosses the wire in minor units for cash sessions (matching the backend
 * cash API), and as decimals for the bill payment route (matching that route's
 * existing contract, which converts to cents server-side).
 *
 * Pure helpers are exposed for unit testing.
 * ==========================================================================*/
(function () {
  'use strict';

  // Sum a denomination map (minorValue → quantity) → total minor units.
  // Mirrors main/core/cash.ts denominationTotal so the UI can preview a count.
  function denominationTotal(counts) {
    if (!counts || typeof counts !== 'object') return 0;
    let total = 0;
    Object.keys(counts).forEach((k) => {
      const value = Number(k), qty = Number(counts[k]);
      if (Number.isFinite(value) && value >= 0 && Number.isInteger(qty) && qty >= 0) total += Math.round(value) * qty;
    });
    return total;
  }

  const api = () => window.PlemmoAPI;

  const PlemmoCash = {
    denominationTotal: denominationTotal,
    current: function () { return api().get('/cash/session'); },
    getSession: function (id) { return api().get('/cash/session/' + encodeURIComponent(id)); },
    history: function (limit) { return api().get('/cash/sessions' + (limit ? ('?limit=' + limit) : '')); },
    open: function (opts) {
      // opts: { openingCounts } or { openingFloatMinor }, optional notes
      const body = {};
      if (opts && opts.openingCounts) body.opening_counts = opts.openingCounts;
      else body.opening_float_minor = (opts && opts.openingFloatMinor) || 0;
      if (opts && opts.notes) body.notes = opts.notes;
      return api().post('/cash/session/open', body, { idempotent: true });
    },
    movement: function (sessionId, type, amountMinor, reason, reference) {
      return api().post('/cash/session/' + encodeURIComponent(sessionId) + '/movement',
        { type: type, amount_minor: amountMinor, reason: reason || null, reference: reference || null }, { idempotent: true });
    },
    // Convenience wrappers for the drawer UI actions.
    payIn: function (id, minor, reason) { return this.movement(id, 'pay_in', minor, reason); },
    payOut: function (id, minor, reason) { return this.movement(id, 'pay_out', minor, reason); },
    drop: function (id, minor, reason) { return this.movement(id, 'drop', minor, reason); },
    noSale: function (id, reason) { return this.movement(id, 'no_sale', 0, reason); },
    close: function (sessionId, opts) {
      const body = {};
      if (opts && opts.closingCounts) body.closing_counts = opts.closingCounts;
      else body.counted_minor = (opts && opts.countedMinor) || 0;
      if (opts && opts.notes) body.notes = opts.notes;
      return api().post('/cash/session/' + encodeURIComponent(sessionId) + '/close', body, { idempotent: true });
    }
  };

  // Bill payment (incl. tips + split). Plemmo computes balance/change; the UI
  // never marks a payment successful on its own — it reflects the API result.
  const PlemmoPayments = {
    // pay(billId, { method, amount, tip, tendered, transactionId, customerId })
    pay: function (billId, p) {
      const body = { method: p.method, amount: p.amount };
      if (p.tip != null) body.tip = p.tip;
      if (p.tendered != null) body.tendered = p.tendered;
      if (p.transactionId) body.transaction_id = p.transactionId;
      if (p.customerId) body.customer_id = p.customerId;
      return api().post('/bills/' + encodeURIComponent(billId) + '/payment', body, { idempotent: true });
    },
    // paySplit(billId, [{ method, amount, tip, tendered }...])
    paySplit: function (billId, payments, customerId) {
      const body = { payments: payments };
      if (customerId) body.customer_id = customerId;
      return api().post('/bills/' + encodeURIComponent(billId) + '/payments', body, { idempotent: true });
    }
  };

  window.PlemmoCash = PlemmoCash;
  window.PlemmoPayments = PlemmoPayments;
})();
