/* ============================================================================
 * 03h-plemmo-staff.js — Staff / shifts / loyalty adapter (Meridian → Plemmo)
 * ----------------------------------------------------------------------------
 * Kiosk / Loyalty / Staff phase. Plemmo owns staff/roles (server-enforced
 * permissions), the timeclock (staff_shifts), and loyalty tiers (derived from
 * authoritative spend). Meridian's local employees/shifts/tiers are retired as
 * a source of truth.
 *
 * Pure mappers are exposed for unit testing.
 * ==========================================================================*/
(function () {
  'use strict';

  const api = () => window.PlemmoAPI;

  // Plemmo user (POS staff) → Meridian employee shape.
  function mapStaff(u) {
    return {
      id: u.id,
      name: u.name || '',
      role: u.role || 'staff',
      position: u.position || (u.role ? u.role[0].toUpperCase() + u.role.slice(1) : ''),
      email: u.email || '',
      active: u.is_active == null ? true : !!u.is_active,
      rate: Number(u.pay_rate) || 0,
    };
  }

  const PlemmoStaff = {
    mapStaff: mapStaff,
    list: function () { return api().get('/staff').then((r) => (((r && (r.staff || r.users || r.data)) || [])).map(mapStaff)); },
    create: function (u) { return api().post('/staff', u, { idempotent: true }); },
    update: function (id, u) { return api().put('/staff/' + encodeURIComponent(id), u); },
    deactivate: function (id) { return api().post('/staff/' + encodeURIComponent(id) + '/deactivate', {}, { idempotent: true }); },
    reactivate: function (id) { return api().post('/staff/' + encodeURIComponent(id) + '/reactivate', {}, { idempotent: true }); },

    // Timeclock (the caller acts on their own shift; managers read all).
    myShift: function () { return api().get('/shifts/me').then((r) => (r && r.shift) || null); },
    clockIn: function (note) { return api().post('/shifts/clock-in', { note: note || null }, { idempotent: false }); },
    clockOut: function (note) { return api().post('/shifts/clock-out', { note: note || null }, { idempotent: false }); },
    timesheet: function (q) { return api().get('/shifts' + (q ? ('?' + q) : '')); },
  };

  // Loyalty: tier comes authoritative from the customer record (server-derived
  // from lifetime spend). This helper is only for local display styling.
  const TIER_META = {
    bronze: { key: 'bronze', label: 'Bronze', color: '#C07A45' },
    silver: { key: 'silver', label: 'Silver', color: '#8E9AAB' },
    gold: { key: 'gold', label: 'Gold', color: '#E0A800' },
  };
  const PlemmoLoyalty = {
    tierMeta: function (customer) { return TIER_META[(customer && customer.tier) || 'bronze'] || TIER_META.bronze; },
  };

  window.PlemmoStaff = PlemmoStaff;
  window.PlemmoLoyalty = PlemmoLoyalty;
})();
