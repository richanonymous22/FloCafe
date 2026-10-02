/* Operator console: merchants, plans, licences, activation codes.
 * Talks only to this server's /admin/v1 API with the operator token the person types in. The token is kept in
 * sessionStorage for this tab only. Every value from the server is placed in the page with textContent. */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var state = { token: null, view: 'merchants', plans: null, merchants: null, q: '', current: null, error: null, issued: null };
  try { state.token = sessionStorage.getItem('operator_token'); } catch (e) { /* storage blocked: sign in each time */ }

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') el.className = attrs[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] === true) el.setAttribute(k, '');
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k]);
    });
    function add(c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) { c.forEach(add); return; }
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    for (var i = 2; i < arguments.length; i++) add(arguments[i]);
    return el;
  }
  function toast(msg) { var t = document.getElementById('toast'); t.textContent = msg; t.className = 'show'; setTimeout(function () { t.className = ''; }, 3200); }
  function when(s) { if (!s) return 'never'; var d = new Date(s); return isNaN(d) ? String(s) : d.toLocaleString('en-GB'); }
  function badge(text, kind) { return h('span', { class: 'badge ' + (kind || '') }, text); }
  var STATUS_KIND = { active: 'ok', suspended: 'warn', closed: 'bad', expired: 'warn', revoked: 'bad', unlicensed: 'bad' };

  function api(method, path, body) {
    return fetch('/admin/v1' + path, {
      method: method, headers: Object.assign({ Authorization: 'Bearer ' + state.token }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) { signOut(); throw new Error('The operator token was not accepted.'); }
        if (r.status === 503) throw new Error('The operator API is switched off on this server (no operator token is configured).');
        if (r.status === 429) throw new Error('Too many requests. Wait a minute and try again.');
        if (!r.ok) throw new Error(j.error ? String(j.error).replace(/_/g, ' ') : 'The request failed (' + r.status + ').');
        return j;
      });
    });
  }
  function guard(p) { return p.catch(function (e) { state.error = e.message; render(); throw e; }).then(function (v) { state.error = null; return v; }); }

  function signOut() { state.token = null; try { sessionStorage.removeItem('operator_token'); } catch (e) { /* ignore */ } render(); }
  document.getElementById('signout').addEventListener('click', signOut);

  function loadMerchants() { return guard(api('GET', '/merchants' + (state.q ? '?q=' + encodeURIComponent(state.q) : ''))).then(function (r) { state.merchants = r.merchants; render(); }); }
  function loadPlans() { return guard(api('GET', '/plans')).then(function (r) { state.plans = r.plans; render(); }); }
  function openMerchant(code, keepIssued) { if (!keepIssued) state.issued = null; return guard(api('GET', '/merchants/' + encodeURIComponent(code))).then(function (r) { state.current = r; state.view = 'merchant'; render(); }); }

  function loginView() {
    var input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Operator token', 'aria-label': 'Operator token' });
    function go() {
      var v = input.value.trim(); if (!v) return;
      state.token = v; try { sessionStorage.setItem('operator_token', v); } catch (e) { /* ignore */ }
      loadPlans().then(loadMerchants).catch(function () { /* error shown */ });
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    return h('div', { class: 'card' }, h('h2', null, 'Sign in'), h('p', { class: 'muted' }, 'Enter the operator token for this cloud service. It stays in this browser tab only.'),
      h('div', { class: 'row' }, input, h('button', { class: 'primary', onclick: go }, 'Continue')), state.error ? h('p', { class: 'err' }, state.error) : null);
  }

  function tabs() {
    return h('div', { class: 'tabs' }, [['merchants', 'Merchants'], ['plans', 'Plans']].map(function (t) {
      return h('button', { class: state.view === t[0] || (t[0] === 'merchants' && state.view === 'merchant') ? 'on' : '', onclick: function () { state.view = t[0]; render(); } }, t[1]);
    }));
  }

  function merchantsView() {
    var q = h('input', { type: 'search', placeholder: 'Search name, code or email', value: state.q, 'aria-label': 'Search merchants' });
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.q = q.value.trim(); loadMerchants(); } });
    var rows = (state.merchants || []).map(function (m) {
      return h('tr', { class: 'click', tabindex: '0', onclick: function () { openMerchant(m.merchant_code); }, onkeydown: function (e) { if (e.key === 'Enter') openMerchant(m.merchant_code); } },
        h('td', { class: 'mono' }, m.merchant_code), h('td', null, m.name), h('td', null, m.plan_id || 'none'),
        h('td', null, badge(m.status, STATUS_KIND[m.status])), h('td', null, m.license_status ? badge(m.license_status, STATUS_KIND[m.license_status]) : badge('no licence', 'bad')));
    });
    return h('div', null, newMerchantCard(),
      h('div', { class: 'card' }, h('h2', null, 'Merchants'), h('div', { class: 'row' }, q, h('button', { onclick: function () { state.q = q.value.trim(); loadMerchants(); } }, 'Search')),
        state.merchants == null ? h('p', { class: 'muted' }, 'Loading…') :
          h('div', { class: 'tbl' }, h('table', null, h('thead', null, h('tr', null, ['Code', 'Name', 'Plan', 'Merchant', 'Licence'].map(function (x) { return h('th', null, x); }))),
            h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: '5', class: 'muted' }, 'No merchants found.')))))));
  }

  function newMerchantCard() {
    var name = h('input', { placeholder: 'Business name', maxlength: '120', 'aria-label': 'Business name' });
    var email = h('input', { type: 'email', placeholder: 'Contact email (optional)', 'aria-label': 'Contact email' });
    var plan = h('select', { 'aria-label': 'Plan' }, (state.plans || []).filter(function (p) { return p.is_active; }).map(function (p) { return h('option', { value: p.plan_id }, p.name); }));
    var term = h('input', { type: 'number', min: '1', max: '3650', placeholder: 'Term in days (plan default)', 'aria-label': 'Term in days' });
    var err = h('p', { class: 'err', hidden: true });
    return h('div', { class: 'card' }, h('h2', null, 'New merchant'),
      h('div', { class: 'row' }, name, email, plan, term, h('button', { class: 'primary', onclick: function () {
        err.hidden = true;
        var body = { name: name.value.trim(), contact_email: email.value.trim() || undefined, plan_id: plan.value };
        if (term.value) body.term_days = Number(term.value);
        api('POST', '/merchants', body).then(function (r) { toast('Created ' + r.merchant.merchant_code); state.q = ''; return loadMerchants().then(function () { return openMerchant(r.merchant.merchant_code); }); })
          .catch(function (e) { err.textContent = e.message; err.hidden = false; });
      } }, 'Create')), err);
  }

  function act(label, fn, opts) {
    opts = opts || {};
    return h('button', { class: opts.danger ? 'danger' : '', disabled: !!opts.disabled, onclick: function () {
      if (opts.confirm && !window.confirm(opts.confirm)) return;
      fn().then(function (r) { toast(label + ' done'); if (r && r.merchant) { state.current = Object.assign({}, state.current, r); } return openMerchant(state.current.merchant.merchant_code, true); }).catch(function (e) { state.error = e.message; render(); });
    } }, label);
  }

  function merchantView() {
    var c = state.current, m = c.merchant, l = c.license, hlt = c.health || {};
    var code = m.merchant_code;
    var planSel = h('select', { 'aria-label': 'New plan' }, (state.plans || []).filter(function (p) { return p.is_active; }).map(function (p) { return h('option', { value: p.plan_id, selected: p.plan_id === m.plan_id }, p.name); }));
    var days = h('input', { type: 'number', min: '1', max: '3650', value: '365', style: 'width:110px', 'aria-label': 'Renew days' });
    var closed = m.status === 'closed';
    var issued = state.issued;
    return h('div', null,
      h('p', null, h('button', { class: 'ghost', onclick: function () { state.view = 'merchants'; loadMerchants(); } }, '← All merchants')),
      h('div', { class: 'card' }, h('h2', null, m.name, ' ', badge(m.status, STATUS_KIND[m.status])),
        h('dl', { class: 'kv' },
          h('dt', null, 'Merchant code'), h('dd', { class: 'mono' }, code),
          h('dt', null, 'Contact'), h('dd', null, m.contact_email || 'none'),
          h('dt', null, 'Plan'), h('dd', null, m.plan_id || 'none'),
          h('dt', null, 'Created'), h('dd', null, when(m.created_at)),
          h('dt', null, 'Organisation'), h('dd', { class: 'mono' }, m.organization_uid))),
      h('div', { class: 'card' }, h('h2', null, 'Licence'),
        l ? h('dl', { class: 'kv' },
          h('dt', null, 'Status'), h('dd', null, badge(l.status, STATUS_KIND[l.status])),
          h('dt', null, 'Expires'), h('dd', null, when(l.expires_at)),
          h('dt', null, 'Grace'), h('dd', null, l.grace_days + ' days'),
          h('dt', null, 'Devices allowed'), h('dd', null, l.device_limit == null ? 'unlimited' : l.device_limit),
          h('dt', null, 'Locations allowed'), h('dd', null, l.location_limit == null ? 'unlimited' : l.location_limit),
          h('dt', null, 'Features'), h('dd', null, (l.features || []).join(', ') || 'none')) : h('p', { class: 'muted' }, 'No licence on record.')),
      h('div', { class: 'card' }, h('h2', null, 'Terminals'),
        h('dl', { class: 'kv' }, h('dt', null, 'Devices'), h('dd', null, (hlt.active_devices || 0) + ' active of ' + (hlt.devices || 0) + ' enrolled'),
          h('dt', null, 'Last data received'), h('dd', null, when(hlt.last_received_at)),
          h('dt', null, 'Unresolved gaps'), h('dd', null, hlt.open_deficits || 0)),
        h('div', { class: 'row', style: 'margin-top:12px' }, act('Issue activation code', function () {
          return api('POST', '/merchants/' + encodeURIComponent(code) + '/activation-tokens', {}).then(function (r) { state.issued = r; return r; });
        }, { disabled: m.status !== 'active' })),
        issued ? h('div', { class: 'code' }, h('p', { class: 'muted' }, 'Give the merchant this code. It is shown once, works once and expires in 24 hours.'),
          h('div', { class: 'mono' }, issued.activation_code || issued.token),
          issued.activation_code ? null : h('p', { class: 'muted' }, 'This server has no public address configured, so only the bare token is shown. Set PLEMMO_CLOUD_PUBLIC_URL for a full activation code.'),
          h('p', null, h('button', { onclick: function () { if (navigator.clipboard) navigator.clipboard.writeText(issued.activation_code || issued.token).then(function () { toast('Copied'); }); } }, 'Copy'))) : null),
      h('div', { class: 'card' }, h('h2', null, 'Account actions'),
        h('div', { class: 'row' },
          act('Suspend', function () { var r = window.prompt('Reason (optional)', ''); return api('POST', '/merchants/' + encodeURIComponent(code) + '/suspend', { reason: r || '' }); }, { disabled: m.status !== 'active', confirm: 'Suspend ' + m.name + '? Their tills pause sales the next time they check in.' }),
          act('Reactivate', function () { return api('POST', '/merchants/' + encodeURIComponent(code) + '/reactivate', {}); }, { disabled: m.status !== 'suspended' }),
          act('Close for good', function () { return api('POST', '/merchants/' + encodeURIComponent(code) + '/close', {}); }, { danger: true, disabled: closed, confirm: 'Close ' + m.name + ' permanently? This cannot be undone.' })),
        h('div', { class: 'row', style: 'margin-top:12px' }, days, act('Renew (days)', function () { return api('POST', '/merchants/' + encodeURIComponent(code) + '/renew', { term_days: Number(days.value) }); }, { disabled: closed }),
          planSel, act('Change plan', function () { return api('POST', '/merchants/' + encodeURIComponent(code) + '/plan', { plan_id: planSel.value }); }, { disabled: closed }))));
  }

  function plansView() {
    var rows = (state.plans || []).map(function (p) {
      return h('tr', null, h('td', { class: 'mono' }, p.plan_id), h('td', null, p.name, p.is_active ? null : [' ', badge('retired', 'warn')]),
        h('td', null, p.device_limit == null ? '∞' : p.device_limit), h('td', null, p.location_limit == null ? '∞' : p.location_limit),
        h('td', null, p.term_days == null ? 'no expiry' : p.term_days + ' d'), h('td', null, p.grace_days + ' d'), h('td', null, (p.features || []).join(', ')),
        h('td', null, h('button', { onclick: function () { state.editPlan = p; render(); } }, 'Edit')));
    });
    return h('div', null, planEditor(),
      h('div', { class: 'card' }, h('h2', null, 'Plans'), h('div', { class: 'tbl' }, h('table', null,
        h('thead', null, h('tr', null, ['Id', 'Name', 'Devices', 'Locations', 'Term', 'Grace', 'Features', ''].map(function (x) { return h('th', null, x); }))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: '8', class: 'muted' }, 'No plans yet.')))))));
  }
  function planEditor() {
    var p = state.editPlan || { plan_id: '', name: '', description: '', features: [], device_limit: 2, location_limit: 1, grace_days: 14, term_days: 365, is_active: true };
    var id = h('input', { value: p.plan_id, placeholder: 'plan-id (lowercase, dashes)', disabled: !!state.editPlan, 'aria-label': 'Plan id' });
    var name = h('input', { value: p.name, placeholder: 'Plan name', 'aria-label': 'Plan name' });
    var feats = h('input', { value: (p.features || []).join(', '), placeholder: 'Features, comma separated (core.pos, retail.catalog, …)', style: 'min-width:320px', 'aria-label': 'Features' });
    var dev = h('input', { type: 'number', min: '1', value: p.device_limit == null ? '' : p.device_limit, placeholder: 'Devices', style: 'width:100px', 'aria-label': 'Device limit' });
    var loc = h('input', { type: 'number', min: '1', value: p.location_limit == null ? '' : p.location_limit, placeholder: 'Locations', style: 'width:100px', 'aria-label': 'Location limit' });
    var grace = h('input', { type: 'number', min: '0', value: p.grace_days, placeholder: 'Grace days', style: 'width:110px', 'aria-label': 'Grace days' });
    var term = h('input', { type: 'number', min: '1', value: p.term_days == null ? '' : p.term_days, placeholder: 'Term days', style: 'width:110px', 'aria-label': 'Term days' });
    var active = h('input', { type: 'checkbox' }); active.checked = p.is_active !== false;
    var err = h('p', { class: 'err', hidden: true });
    return h('div', { class: 'card' }, h('h2', null, state.editPlan ? 'Edit plan' : 'New plan'),
      h('div', { class: 'row' }, id, name, feats, dev, loc, grace, term, h('label', { style: 'display:flex;gap:6px;align-items:center' }, active, 'On sale'),
        h('button', { class: 'primary', onclick: function () {
          err.hidden = true;
          var body = { name: name.value.trim(), description: p.description || '', features: feats.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
            device_limit: dev.value ? Number(dev.value) : null, location_limit: loc.value ? Number(loc.value) : null, grace_days: Number(grace.value || 0), term_days: term.value ? Number(term.value) : null, is_active: active.checked };
          api('PUT', '/plans/' + encodeURIComponent(id.value.trim()), body).then(function () { toast('Plan saved'); state.editPlan = null; return loadPlans(); }).catch(function (e) { err.textContent = e.message; err.hidden = false; });
        } }, 'Save'), state.editPlan ? h('button', { onclick: function () { state.editPlan = null; render(); } }, 'Cancel') : null), err,
      h('p', { class: 'muted' }, 'A retired plan can no longer be sold or switched to; merchants already on it keep it.'));
  }

  function render() {
    document.getElementById('signout').hidden = !state.token;
    app.textContent = '';
    if (!state.token) { app.appendChild(loginView()); return; }
    if (state.error) app.appendChild(h('div', { class: 'card' }, h('p', { class: 'err' }, state.error)));
    app.appendChild(tabs());
    app.appendChild(state.view === 'plans' ? plansView() : state.view === 'merchant' && state.current ? merchantView() : merchantsView());
  }

  render();
  if (state.token) loadPlans().then(loadMerchants).catch(function () { /* error shown */ });
})();
