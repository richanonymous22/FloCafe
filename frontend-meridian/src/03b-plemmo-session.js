/* ============================================================================
 * 03b-plemmo-session.js — Plemmo authentication gate + session context + status
 * ----------------------------------------------------------------------------
 * Phase 1 (Foundation) of the Meridian → Plemmo integration.
 *
 * Adds a REAL authentication layer beneath Meridian's existing UX:
 *   - Before Meridian boots, the operator signs in with a real Plemmo account
 *     (email + password → JWT via window.PlemmoAPI). This replaces Meridian's
 *     fake "no backend" assumption at the session layer.
 *   - Session context (user, tenant/business, location, device, licence) is
 *     loaded from Plemmo and exposed via PlemmoSession.ctx for later phases.
 *   - A connection/licence status pill reflects real online/offline/sync/
 *     licence state, integrated into Meridian's design language (CSS vars).
 *
 * Meridian's own per-staff PIN lock screen is PRESERVED — it remains the
 * "who is on the till" UX and is backed by real Plemmo staff in a later phase.
 * This file only adds the account/session authentication that sits under it.
 *
 * Depends on: window.PlemmoAPI (00-plemmo-api.js), $ (02-data.js),
 * toast/esc/ic (02/03). Concatenated after 03-app-shell.js; all top-level
 * references (A, $) are already initialised by then.
 * ==========================================================================*/

const PlemmoSession = {
  ctx: { user: null, tenant: null, business: null, location: null, device: null, license: null },
  _next: null,
  _pollTimer: null,

  /** Load authoritative session context from Plemmo (/auth/me). */
  load: async function () {
    const res = await PlemmoAPI.me();
    const tenant = (res && res.tenants && res.tenants[0]) || PlemmoAPI.currentTenant() || null;
    this.ctx.user = (res && res.user) || PlemmoAPI.currentUser() || null;
    this.ctx.tenant = tenant;
    this.ctx.business = tenant ? { id: tenant.id, name: tenant.business_name, type: tenant.business_type,
      country: tenant.country, currency: tenant.currency, currencySymbol: tenant.currency_symbol,
      timezone: tenant.timezone, language: tenant.language, serviceModel: tenant.service_model } : null;
    // Location/device context: Plemmo desktop runs a single local tenant; the
    // richer multi-location/device model is wired in the tenancy phase. We
    // surface what the tenant record carries today rather than inventing IDs.
    this.ctx.location = tenant ? { slug: tenant.slug, plan: tenant.plan } : null;
    this.ctx.license = tenant ? { status: tenant.status || 'active', plan: tenant.plan || 'desktop' } : null;
    return this.ctx;
  },

  clear: function () {
    this.ctx = { user: null, tenant: null, business: null, location: null, device: null, license: null };
  },

  isAuthed: function () { return PlemmoAPI.isAuthenticated(); }
};

/* ---------- Authentication gate ---------- */

// Entry point called by boot(). If a valid session exists, load context and
// continue into Meridian (next). Otherwise show the Plemmo login screen and
// resume once authenticated.
async function plemmoStart(next) {
  PlemmoSession._next = next;
  startPlemmoStatus();
  if (!PlemmoSession.isAuthed()) { renderPlemmoAuth(); return; }
  try {
    await PlemmoSession.load();
    hidePlemmoAuth();
    next();
  } catch (e) {
    // Token invalid/expired, or backend unreachable.
    if (e && e.status === 401) {
      PlemmoAPI.setToken(null);
      renderPlemmoAuth();
    } else {
      // Offline / server not reachable: allow retry rather than stranding.
      renderPlemmoAuth('Could not reach the Plemmo server. Check the connection and try again.');
    }
  }
}

function renderPlemmoAuth(msg) {
  const el = $('#plemmo-auth');
  if (!el) return;
  $('#app').hidden = true; $('#lock').hidden = true; $('#onboard').hidden = true; $('#kiosk').hidden = true;
  el.hidden = false;
  const lastEmail = (PlemmoAPI.currentUser() && PlemmoAPI.currentUser().email) || '';
  el.innerHTML = `<form class="pl-card" id="plForm" autocomplete="on">
    <div class="pl-brand"><div class="mark">P</div><b>Plemmo</b></div>
    <h2>Sign in to your till</h2>
    <p class="pl-sub">Use your Plemmo account. This device connects to your business on the Plemmo platform.</p>
    <label class="pl-field"><span>Email</span>
      <input class="input" type="email" name="email" id="plEmail" value="${esc(lastEmail)}" required autocomplete="username" ${lastEmail ? '' : 'autofocus'}></label>
    <label class="pl-field"><span>Password</span>
      <input class="input" type="password" name="password" id="plPass" required autocomplete="current-password" ${lastEmail ? 'autofocus' : ''}></label>
    <p class="pl-err" id="plErr">${msg ? esc(msg) : ''}</p>
    <button class="pl-btn" type="submit" id="plBtn">Sign in</button>
    <p class="pl-foot">Meridian POS · powered by Plemmo</p>
  </form>`;
  const form = $('#plForm');
  if (form) form.addEventListener('submit', onPlemmoLoginSubmit);
  const f = el.querySelector('[autofocus]'); if (f) f.focus();
}

function hidePlemmoAuth() { const el = $('#plemmo-auth'); if (el) { el.hidden = true; el.innerHTML = ''; } }

async function onPlemmoLoginSubmit(ev) {
  if (ev) ev.preventDefault();
  const email = ($('#plEmail') || {}).value || '';
  const pass = ($('#plPass') || {}).value || '';
  const btn = $('#plBtn'); const err = $('#plErr');
  if (err) err.textContent = '';
  if (!email.trim() || !pass) { if (err) err.textContent = 'Enter your email and password.'; return; }
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="pl-spin"></span> Signing in…'; }
  try {
    await PlemmoAPI.login(email.trim(), pass, true);
    await PlemmoSession.load();
    updatePlemmoStatus();
    hidePlemmoAuth();
    if (typeof PlemmoSession._next === 'function') PlemmoSession._next();
    if (typeof toast === 'function') toast(`Connected to ${(PlemmoSession.ctx.business || {}).name || 'Plemmo'}`, 'ok');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
    const m = (e && e.status === 401) ? (e.message || 'Invalid email or password.')
      : (e && e.message) ? e.message
      : 'Could not sign in. Check your connection and try again.';
    if (err) err.textContent = m;
  }
}

// Sign out of the Plemmo account entirely (distinct from Meridian's PIN lock).
async function plemmoSignOut() {
  try { await PlemmoAPI.logout(); } catch (e) { /* best effort */ }
  PlemmoSession.clear();
  renderPlemmoAuth();
}
A.plemmoSignOut = () => plemmoSignOut();

/* ---------- Connection / licence status pill ---------- */

function plemmoStatusState() {
  if (!PlemmoAPI.isOnline()) return { cls: 'bad', label: 'Offline' };
  const lic = PlemmoSession.ctx.license;
  if (lic) {
    if (lic.status === 'suspended' || lic.status === 'revoked' || lic.status === 'expired')
      return { cls: 'bad', label: 'Licence blocked' };
    if (lic.status === 'grace') return { cls: 'warn', label: 'Licence grace' };
  }
  return { cls: 'ok', label: 'Online' };
}

function updatePlemmoStatus() {
  const el = $('#plemmo-status');
  if (!el) return;
  if (!PlemmoSession.isAuthed()) { el.hidden = true; return; }
  el.hidden = false;
  const st = plemmoStatusState();
  const biz = (PlemmoSession.ctx.business || {}).name || '';
  el.className = st.cls;
  el.innerHTML = `<span class="dot"></span><span>${esc(st.label)}${biz ? ' · ' + esc(biz) : ''}</span>`;
  el.title = biz ? `Signed in to ${biz}` : 'Plemmo';
}

function startPlemmoStatus() {
  updatePlemmoStatus();
  PlemmoAPI.onConnectivity(() => updatePlemmoStatus());
  if (PlemmoSession._pollTimer) clearInterval(PlemmoSession._pollTimer);
  // Lightweight heartbeat against the real API so the pill reflects reachability
  // even when no request is in flight. /api/health needs no auth.
  PlemmoSession._pollTimer = setInterval(() => {
    PlemmoAPI.request('/health', { idempotent: false })
      .then(() => updatePlemmoStatus())
      .catch(() => updatePlemmoStatus());
  }, 30000);
}
