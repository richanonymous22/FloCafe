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
  _sync: null,

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
  if (!PlemmoSession.isAuthed()) {
    // First-run: a fresh install has no Plemmo users yet, so there is nothing to
    // sign in to — the operator must create the first owner here. Ask the
    // authoritative backend; if it reports needsSetup, show the setup form
    // instead of the login form. If the status check can't be reached (offline,
    // or an older backend without the endpoint), fall back to the login gate so
    // an existing operator can still sign in.
    try {
      const st = await PlemmoAPI.setupStatus();
      if (st && st.needsSetup) { renderPlemmoSetup(st); return; }
    } catch (e) { /* offline / no setup endpoint → show login */ }
    renderPlemmoAuth();
    return;
  }
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

// Map a Plemmo role to a Meridian role key (Meridian's can()/S.roles only
// knows owner/manager/staff; other POS roles fold into staff).
function plemmoRoleToMeridian(role) {
  return (role === 'owner' || role === 'manager') ? role : 'staff';
}

// Build a running Meridian state from the authoritative Plemmo tenant + data,
// then enter the app signed in as the real Plemmo user. This replaces
// Meridian's local onboarding + per-staff PIN lock for the authenticated path:
// tenancy, identity and the catalogue are all real Plemmo data, not a local
// business rebuilt from scratch.
async function bootstrapFromPlemmo() {
  const ctx = PlemmoSession.ctx;
  const biz = ctx.business || {};
  const user = ctx.user || { id: 'plemmo-user', name: 'Owner', role: 'owner' };
  const cfg = {
    name: biz.name || 'My business',
    type: biz.type === 'retail' ? 'retail' : 'restaurant',
    ownerName: user.name || 'Owner',
    currency: biz.currencySymbol || '£',
    catalog: 'empty',
    demo: false,
  };
  S = buildBusiness(cfg);
  S.settings.language = biz.language || S.settings.language;

  // The signed-in Plemmo user is the current operator.
  const meRole = plemmoRoleToMeridian(user.role);
  S.employees = [{ id: user.id, name: user.name || 'Owner', role: meRole, plemmoRole: user.role,
    position: user.role ? user.role[0].toUpperCase() + user.role.slice(1) : 'Owner',
    pin: null, rate: 0, color: '#E8912D', active: true }];

  // Hydrate the real team, catalogue and floor plan (best-effort; the app still
  // runs if an optional endpoint is unavailable, e.g. tables when hospitality
  // tables aren't enabled).
  try {
    if (window.PlemmoStaff) {
      const staff = await window.PlemmoStaff.list();
      const merged = staff.map((s, i) => ({ id: s.id, name: s.name, role: plemmoRoleToMeridian(s.role), plemmoRole: s.role,
        position: s.position, rate: s.rate || 0, pin: null, active: s.active, color: EMP_COLORS[i % EMP_COLORS.length] }));
      if (merged.length) S.employees = merged;
      if (!S.employees.find((e) => e.id === user.id)) S.employees.unshift({ id: user.id, name: user.name, role: meRole, plemmoRole: user.role, position: 'Owner', pin: null, rate: 0, color: '#E8912D', active: true });
    }
  } catch (e) { /* keep the single signed-in operator */ }
  try { if (window.PlemmoCatalogue) await window.PlemmoCatalogue.load(S); } catch (e) { /* offline cache */ }
  try { if (window.PlemmoTables && S.settings.tables) await window.PlemmoTables.load(S); } catch (e) { /* tables optional */ }
  // Held carts live on the backend; the strip above the menu is a view of them.
  try { if (window.PlemmoTill) S.held = await window.PlemmoTill.held.list(); } catch (e) { S.held = S.held || []; }
  // Hydrate recent authoritative order history so the home dashboard, reports,
  // Z-report and CSV export compute over real Plemmo data, not just this
  // session's sales. Bounded window; best-effort (offline keeps what we have).
  try {
    if (window.PlemmoOrders && window.PlemmoOrders.history) {
      const from = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const hist = await window.PlemmoOrders.history({ fromDate: from, max: 400 });
      if (Array.isArray(hist)) S.orders = hist;
    }
  } catch (e) { /* reports fall back to session orders */ }

  U.user = user.id;
  U.cart = (typeof newCart === 'function') ? newCart() : U.cart;
  U.view = meRole === 'staff' ? 'pos' : 'home';
  applyTheme();
  hidePlemmoAuth();
  $('#lock').hidden = true; $('#onboard').hidden = true; $('#kiosk').hidden = true; $('#app').hidden = false;
  try { saveNow(); } catch (e) { /* cache best-effort */ }
  render();
  updatePlemmoStatus();
  if (typeof resolveCaps === 'function') resolveCaps();
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

/* ---------- First-run setup (create the first owner) ---------- */

// Client-side mirror of the backend password rule (validatePassword): at least
// 8 characters with one uppercase, one lowercase and one digit. The server
// re-validates authoritatively; this only gives immediate feedback.
function plemmoValidPassword(p) {
  return typeof p === 'string' && p.length >= 8 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p);
}

// Render the first-run setup form into the same gate container the login uses.
// `status` is the /auth/setup/status payload; masterPinAvailable decides whether
// a Master PIN is required (the backend requires one only when the OS keyring is
// available to store it).
function renderPlemmoSetup(status) {
  const el = $('#plemmo-auth');
  if (!el) return;
  $('#app').hidden = true; $('#lock').hidden = true; $('#onboard').hidden = true; $('#kiosk').hidden = true;
  el.hidden = false;
  const needPin = !!(status && status.masterPinAvailable);
  el.innerHTML = `<form class="pl-card pl-setup" id="plSetupForm" autocomplete="on">
    <div class="pl-brand"><div class="mark">P</div><b>Plemmo</b></div>
    <h2>Set up your business</h2>
    <p class="pl-sub">Welcome. Create the owner account for this POS. You can add your team and menu next.</p>
    <label class="pl-field"><span>Business name</span>
      <input class="input" type="text" name="business_name" id="plBiz" required autocomplete="organization" autofocus></label>
    <label class="pl-field"><span>Your name</span>
      <input class="input" type="text" name="name" id="plName" required autocomplete="name"></label>
    <label class="pl-field"><span>Email</span>
      <input class="input" type="email" name="email" id="plSetupEmail" required autocomplete="username"></label>
    <label class="pl-field"><span>Password</span>
      <input class="input" type="password" name="password" id="plSetupPass" required autocomplete="new-password">
      <small class="pl-hint">At least 8 characters, with an uppercase letter, a lowercase letter and a number.</small></label>
    <label class="pl-field"><span>Service style</span>
      <select class="input" name="service_model" id="plService">
        <option value="qsr" selected>Counter / quick service</option>
        <option value="finedine">Table service (dine-in)</option>
      </select></label>
    ${needPin ? `<label class="pl-field"><span>Manager Master PIN (4 digits)</span>
      <input class="input" type="password" name="master_pin" id="plPin" inputmode="numeric" pattern="\\d{4}" maxlength="4" required autocomplete="off">
      <small class="pl-hint">Used to approve refunds, voids and other manager actions.</small></label>` : ''}
    <label class="pl-check"><input type="checkbox" id="plTerms">
      <span>I accept the Terms &amp; Conditions, Privacy Policy and No-Warranty Disclaimer.</span></label>
    <p class="pl-err" id="plSetupErr"></p>
    <button class="pl-btn" type="submit" id="plSetupBtn">Create business</button>
    <p class="pl-foot">Meridian POS · powered by Plemmo</p>
  </form>`;
  const form = $('#plSetupForm');
  if (form) form.addEventListener('submit', onPlemmoSetupSubmit);
  const f = el.querySelector('[autofocus]'); if (f) f.focus();
}

async function onPlemmoSetupSubmit(ev) {
  if (ev) ev.preventDefault();
  const val = (id) => (($('#' + id) || {}).value || '').trim();
  const businessName = val('plBiz');
  const name = val('plName');
  const email = val('plSetupEmail');
  const password = ($('#plSetupPass') || {}).value || '';
  const serviceModel = val('plService') || 'qsr';
  const pinEl = $('#plPin');
  const masterPin = pinEl ? (pinEl.value || '').trim() : '';
  const terms = !!($('#plTerms') || {}).checked;
  const btn = $('#plSetupBtn'); const err = $('#plSetupErr');
  if (err) err.textContent = '';

  if (!businessName || !name || !email) { if (err) err.textContent = 'Please fill in your business name, your name and email.'; return; }
  if (!plemmoValidPassword(password)) { if (err) err.textContent = 'Password must be at least 8 characters and include an uppercase letter, a lowercase letter and a number.'; return; }
  if (pinEl && !/^\d{4}$/.test(masterPin)) { if (err) err.textContent = 'Enter a 4-digit Master PIN.'; return; }
  if (!terms) { if (err) err.textContent = 'Please accept the terms to continue.'; return; }

  const payload = {
    name: name,
    email: email,
    password: password,
    business_name: businessName,
    business_type: 'restaurant',
    setup_profile: 'express',
    service_model: serviceModel,
    terms_accepted: true,
    cloud_sync_enabled: false,
  };
  if (pinEl) payload.master_pin = masterPin;

  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="pl-spin"></span> Creating…'; }
  try {
    await PlemmoAPI.initializeSetup(payload);
    await PlemmoSession.load();
    updatePlemmoStatus();
    hidePlemmoAuth();
    if (typeof PlemmoSession._next === 'function') PlemmoSession._next();
    if (typeof toast === 'function') toast(`Welcome to ${businessName}`, 'ok');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Create business'; }
    const m = (e && e.data && e.data.error) ? e.data.error
      : (e && e.message) ? e.message
      : 'Could not complete setup. Check your connection and try again.';
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

// The last state fetched from Plemmo's real sync/licence engine (03j).
// null until the first successful poll; a failed poll means we can't reach the
// server, i.e. offline.
PlemmoSession._sync = null;

// Map the authoritative /api/sync/status `state` to a pill style + label.
var PLEMMO_SYNC_LABELS = {
  online: { cls: 'ok', label: 'Online' },
  syncing: { cls: 'syncing', label: 'Syncing' },
  sync_failed: { cls: 'warn', label: 'Sync failed' },
  license_grace: { cls: 'warn', label: 'Licence grace' },
  license_blocked: { cls: 'bad', label: 'Licence blocked' },
  offline: { cls: 'bad', label: 'Offline' },
};

function plemmoStatusState() {
  if (!PlemmoAPI.isOnline()) return PLEMMO_SYNC_LABELS.offline;
  var s = PlemmoSession._sync;
  if (s && s.state && PLEMMO_SYNC_LABELS[s.state]) {
    var base = PLEMMO_SYNC_LABELS[s.state];
    // Surface the outbox backlog while syncing so staff see progress.
    if (s.state === 'syncing' && s.sync && (s.sync.pending || s.sync.uploading)) {
      return { cls: base.cls, label: base.label + ' (' + ((s.sync.pending || 0) + (s.sync.uploading || 0)) + ')' };
    }
    return base;
  }
  return PLEMMO_SYNC_LABELS.online;
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

function pollPlemmoSync() {
  // Reflects Plemmo's real sync engine + licence state (03j). A failed request
  // means the server is unreachable → offline. Never starts sync work itself.
  if (!PlemmoSession.isAuthed() || !window.PlemmoSync) {
    return PlemmoAPI.request('/health', { idempotent: false }).then(() => updatePlemmoStatus()).catch(() => updatePlemmoStatus());
  }
  return window.PlemmoSync.status()
    .then((s) => { PlemmoSession._sync = s; updatePlemmoStatus(); })
    .catch(() => { PlemmoSession._sync = null; updatePlemmoStatus(); });
}

function startPlemmoStatus() {
  updatePlemmoStatus();
  PlemmoAPI.onConnectivity(() => updatePlemmoStatus());
  if (PlemmoSession._pollTimer) clearInterval(PlemmoSession._pollTimer);
  pollPlemmoSync();
  PlemmoSession._pollTimer = setInterval(pollPlemmoSync, 30000);
}

// Expose the session module for tests and cross-file access in the browser.
if (typeof window !== "undefined") window.PlemmoSession = PlemmoSession;
