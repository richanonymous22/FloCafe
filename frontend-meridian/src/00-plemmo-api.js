/* ============================================================================
 * 00-plemmo-api.js — Real Plemmo backend client for the Meridian frontend
 * ----------------------------------------------------------------------------
 * This is the first seam of the Meridian → Plemmo integration (see
 * docs/MERIDIAN_PLEMMO_MASTER_INTEGRATION.md). It replaces Meridian's fake,
 * in-memory / localStorage-only "backend" with a real client that talks to the
 * authoritative Plemmo Express API on the same origin (:3001).
 *
 * Design rules (per the integration brief):
 *   - Plemmo is the source of truth. This client never invents business data.
 *   - Vanilla JS, no dependencies, no build tooling — same stack as the rest
 *     of Meridian. Concatenated first, so nothing here may depend on helpers
 *     defined in later files.
 *   - Security is server-enforced. The JWT is attached to every request; the
 *     client cannot grant itself permissions.
 *   - Offline is Plemmo's job: this client exposes online/offline signals and
 *     an idempotency-key helper so mutations can be safely queued/retried by
 *     the store adapter against Plemmo's outbox — it does NOT implement a
 *     second sync protocol.
 *
 * It exposes a single global: `window.PlemmoAPI`.
 * ==========================================================================*/
(function () {
  'use strict';

  var TOKEN_KEY = 'plemmo.token';
  var TENANT_KEY = 'plemmo.tenant';
  var USER_KEY = 'plemmo.user';

  // Base URL derived from the page origin (not a build-time constant) so LAN
  // clients that load the app via the server's IP talk back to that same host,
  // matching the existing Plemmo axios client and KDS standalone client.
  function baseUrl() {
    if (typeof window !== 'undefined' && window.location && window.location.origin) {
      return window.location.origin + '/api';
    }
    return '/api';
  }

  // ---- token / session storage (best-effort; never throws) ----------------
  function ls(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      if (val === null) { localStorage.removeItem(key); return null; }
      localStorage.setItem(key, val);
      return val;
    } catch (e) { return null; }
  }
  function getToken() { return ls(TOKEN_KEY); }
  function setToken(t) { ls(TOKEN_KEY, t || null); }
  function getJSON(key) { try { return JSON.parse(ls(key) || 'null'); } catch (e) { return null; } }
  function setJSON(key, v) { ls(key, v == null ? null : JSON.stringify(v)); }

  // ---- online/offline signal ---------------------------------------------
  // navigator.onLine is a coarse hint; the request layer also flips this on a
  // network failure so the UI can reflect reality between heartbeats.
  var _online = (typeof navigator !== 'undefined') ? navigator.onLine !== false : true;
  var _listeners = [];
  function isOnline() { return _online; }
  function setOnline(v) {
    v = !!v;
    if (v === _online) return;
    _online = v;
    for (var i = 0; i < _listeners.length; i++) {
      try { _listeners[i](_online); } catch (e) { /* ignore listener errors */ }
    }
  }
  function onConnectivity(fn) { if (typeof fn === 'function') _listeners.push(fn); }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', function () { setOnline(true); });
    window.addEventListener('offline', function () { setOnline(false); });
  }

  // ---- idempotency key ----------------------------------------------------
  // Stable client-generated key so retried mutations are de-duplicated by the
  // Plemmo outbox rather than double-applied. Prefer crypto UUIDs.
  function idempotencyKey() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* fall through */ }
    return 'idem-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // ---- core request -------------------------------------------------------
  // opts: { method, body, headers, retries, idempotent, signal }
  function request(path, opts) {
    opts = opts || {};
    var method = (opts.method || 'GET').toUpperCase();
    var url = baseUrl() + path;
    var headers = { 'Accept': 'application/json' };
    if (opts.body !== undefined && opts.body !== null) headers['Content-Type'] = 'application/json';
    var token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    // Idempotency for unsafe methods (opt-in via opts.idempotent or auto for POST).
    if (opts.idempotent || (method !== 'GET' && method !== 'HEAD' && opts.idempotent !== false)) {
      headers['Idempotency-Key'] = opts.idempotencyKey || idempotencyKey();
    }
    if (opts.headers) { for (var h in opts.headers) headers[h] = opts.headers[h]; }

    var fetchOpts = { method: method, headers: headers };
    if (opts.body !== undefined && opts.body !== null) fetchOpts.body = JSON.stringify(opts.body);
    if (opts.signal) fetchOpts.signal = opts.signal;

    var maxRetries = (typeof opts.retries === 'number') ? opts.retries : 0;

    function attempt(n) {
      return fetch(url, fetchOpts).then(function (res) {
        setOnline(true);
        if (res.status === 401) {
          // Session expired / not authenticated — clear and surface.
          setToken(null);
          var err401 = new Error('Not authenticated');
          err401.status = 401;
          throw err401;
        }
        var ct = res.headers.get('content-type') || '';
        var parse = ct.indexOf('application/json') !== -1 ? res.json() : res.text();
        return parse.then(function (data) {
          if (!res.ok) {
            var msg = (data && data.error) ? data.error : ('Request failed (' + res.status + ')');
            var err = new Error(msg);
            err.status = res.status;
            err.data = data;
            throw err;
          }
          return data;
        });
      }).catch(function (err) {
        // Network-level failure (not an HTTP error response) → offline + retry.
        var isNetwork = (err && err.status === undefined);
        if (isNetwork) setOnline(false);
        if (isNetwork && n < maxRetries) {
          var wait = Math.min(16000, 1000 * Math.pow(2, n)); // 1s,2s,4s,8s,16s
          return new Promise(function (r) { setTimeout(r, wait); }).then(function () { return attempt(n + 1); });
        }
        throw err;
      });
    }
    return attempt(0);
  }

  function get(path, opts) { return request(path, Object.assign({ method: 'GET' }, opts || {})); }
  function post(path, body, opts) { return request(path, Object.assign({ method: 'POST', body: body }, opts || {})); }
  function put(path, body, opts) { return request(path, Object.assign({ method: 'PUT', body: body }, opts || {})); }
  function del(path, opts) { return request(path, Object.assign({ method: 'DELETE' }, opts || {})); }

  // ---- auth ---------------------------------------------------------------
  // Real login against Plemmo: POST /api/auth/login, then /api/auth/tenants/select.
  // Replaces Meridian's in-memory 4-digit PIN as the authentication mechanism.
  function login(email, password, rememberMe) {
    return post('/auth/login', { email: email, password: password, rememberMe: !!rememberMe }, { idempotent: false })
      .then(function (res) {
        if (res && res.access_token) {
          setToken(res.access_token);
          setJSON(USER_KEY, res.user || null);
          var tenants = res.tenants || [];
          if (tenants.length === 1) {
            return selectTenant(tenants[0].id).then(function () { return res; });
          }
          setJSON(TENANT_KEY, tenants[0] || null);
        }
        return res;
      });
  }

  function selectTenant(tenantId) {
    return post('/auth/tenants/select', { tenant_id: tenantId }, { idempotent: false })
      .then(function (res) {
        if (res && (res.tenant || res.access_token)) {
          if (res.access_token) setToken(res.access_token);
          if (res.tenant) setJSON(TENANT_KEY, res.tenant);
        }
        return res;
      });
  }

  function me() { return get('/auth/me'); }

  function logout() {
    var done = function () { setToken(null); setJSON(USER_KEY, null); setJSON(TENANT_KEY, null); };
    return post('/auth/logout', {}, { idempotent: false }).then(done, done);
  }

  function isAuthenticated() { return !!getToken(); }
  function currentUser() { return getJSON(USER_KEY); }
  function currentTenant() { return getJSON(TENANT_KEY); }

  // Manager/override PIN verification is server-enforced (services/master-pin).
  // Client-side approval is UX only.
  function verifyManagerPin(pin) {
    return post('/auth/verify-pin', { pin: pin }, { idempotent: false });
  }

  // ---- resource helpers (thin; the store adapter builds on these) ---------
  // These intentionally mirror Plemmo's route names so mapping is explicit.
  var resources = {
    settings:    function () { return get('/settings'); },
    categories:  function () { return get('/categories'); },
    products:    function () { return get('/products'); },
    addonGroups: function () { return get('/addon-groups'); },
    tables:      function () { return get('/tables'); },
    customers:   function (q) { return get('/customers' + (q ? ('?' + q) : '')); },
    staff:       function () { return get('/staff'); },
    paymentMethods: function () { return get('/payment-methods'); },
    heldOrders:  function () { return get('/held-orders'); },
    inventory:   function () { return get('/inventory'); },
    reports:     function (q) { return get('/reports' + (q ? ('?' + q) : '')); },
    // Orders are created with an idempotency key so retries are safe.
    createOrder: function (order) { return post('/orders', order, { idempotent: true }); },
    getOrder:    function (id) { return get('/orders/' + encodeURIComponent(id)); },
    listOrders:  function (q) { return get('/orders' + (q ? ('?' + q) : '')); }
  };

  window.PlemmoAPI = {
    // config
    baseUrl: baseUrl,
    // low-level
    request: request, get: get, post: post, put: put, del: del,
    idempotencyKey: idempotencyKey,
    // connectivity
    isOnline: isOnline, onConnectivity: onConnectivity,
    // auth/session
    login: login, selectTenant: selectTenant, me: me, logout: logout,
    isAuthenticated: isAuthenticated, currentUser: currentUser, currentTenant: currentTenant,
    verifyManagerPin: verifyManagerPin, getToken: getToken, setToken: setToken,
    // resources
    resources: resources
  };
})();
