/* ============================================================================
 * 03i-plemmo-reports.js — Reports / digital receipts / AI adapter
 * ----------------------------------------------------------------------------
 * Reports / Digital Receipts / AI phase. Reports use authoritative Plemmo data;
 * digital receipts are assembled server-side from the authoritative bill; the
 * AI assistant is advisory, permission-gated and audited on the backend.
 *
 * The AI client mirrors Meridian's existing behaviour: try the real Plemmo AI
 * service first, fall back to a local rule engine only if the service is
 * unreachable — never inventing figures.
 * ==========================================================================*/
(function () {
  'use strict';

  const api = () => window.PlemmoAPI;

  const PlemmoReports = {
    dailyStats: function (q) { return api().get('/reports/daily-stats' + (q ? ('?' + q) : '')); },
    summary: function (q) { return api().get('/reports/summary' + (q ? ('?' + q) : '')); },
    sales: function (q) { return api().get('/reports/sales' + (q ? ('?' + q) : '')); },
    topProducts: function (q) { return api().get('/reports/topProducts' + (q ? ('?' + q) : '')); },
    recentOrders: function (q) { return api().get('/reports/recentOrders' + (q ? ('?' + q) : '')); },
    tables: function (q) { return api().get('/reports/tables' + (q ? ('?' + q) : '')); },
    taxComponents: function (q) { return api().get('/reports/tax-components' + (q ? ('?' + q) : '')); },
    insights: function (q) { return api().get('/reports/insights' + (q ? ('?' + q) : '')); },
  };

  const PlemmoReceipts = {
    // Authoritative digital receipt payload (JSON + rendered text) for a bill.
    get: function (billId) { return api().get('/bills/' + encodeURIComponent(billId) + '/receipt').then((r) => (r && r.receipt) || r); },
    // Record a digital-receipt request; returns { delivery, receipt }.
    deliver: function (billId, channel, destination) {
      return api().post('/bills/' + encodeURIComponent(billId) + '/receipt/deliver', { channel: channel, destination: destination || null }, { idempotent: true });
    },
  };

  const PlemmoAI = {
    // Advisory only. Returns { answer, source, snapshot }.
    ask: function (question) { return api().post('/ai/ask', { question: question }, { idempotent: false }); },
    snapshot: function () { return api().get('/ai/snapshot').then((r) => (r && r.snapshot) || r); },
  };

  window.PlemmoReports = PlemmoReports;
  window.PlemmoReceipts = PlemmoReceipts;
  window.PlemmoAI = PlemmoAI;
})();
