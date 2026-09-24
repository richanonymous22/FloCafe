/* ============================================================================
 * 03j-plemmo-sync.js — Offline / sync / licence status client
 * ----------------------------------------------------------------------------
 * Offline / Sync phase. Reads Plemmo's EXISTING sync engine + licence state via
 * /api/sync/status — it does NOT implement a second sync protocol. Plemmo's
 * outbox/idempotency/uploader/downloader/conflict machinery remains the single
 * source of offline correctness; this only surfaces its state to the Meridian
 * status pill (online / offline / syncing / sync-failed / licence-grace /
 * licence-blocked).
 * ==========================================================================*/
(function () {
  'use strict';

  const api = () => window.PlemmoAPI;

  const PlemmoSync = {
    status: function () { return api().request('/sync/status', { idempotent: false }); },
  };

  window.PlemmoSync = PlemmoSync;
})();
