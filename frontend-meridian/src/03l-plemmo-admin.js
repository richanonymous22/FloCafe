/* ============================================================================
 * 03l-plemmo-admin.js — catalogue management on the backend
 * ----------------------------------------------------------------------------
 * Items, categories and option groups are authoritative on the till server (the
 * register sells at the server's prices and VAT). Every create/edit/delete on the
 * Items screen goes through here; the screen is refreshed from the server's own
 * answer afterwards, and a refusal (duplicate barcode, missing permission, an
 * unknown VAT rate …) is shown as the server wrote it, with nothing changed locally.
 *
 * Stock is NOT edited through the product record: a change to the quantity of an
 * existing item is a stock adjustment on the inventory ledger (PlemmoInventory),
 * so every unit that moves leaves a movement with a reason.
 * ==========================================================================*/
(function () {
  'use strict';

  const api = () => window.PlemmoAPI;
  const enc = encodeURIComponent;

  // The form's item → the product body the server expects.
  //   f: { name, categoryId, sku, barcode, price, cost, description, track, stock, low,
  //        groupIds, allergens, available, taxCategoryId }
  function productBody(f, isNew) {
    const body = {
      name: f.name,
      category_id: f.categoryId || null,
      sku: f.sku || '',
      barcode: f.barcode || '',
      description: f.description || '',
      price: Number(f.price),
      cost_price: Number(f.cost) || 0,
      track_inventory: !!f.track,
      low_stock_threshold: f.track ? Math.max(0, Math.round(Number(f.low) || 0)) : 0,
      is_active: f.available !== false,
      tags: f.allergens || [],
      addon_group_ids: f.groupIds || [],
    };
    if (f.taxCategoryId !== undefined) body.tax_category_id = f.taxCategoryId || null;
    // Opening stock only when the item is created; later changes are ledger adjustments.
    if (isNew) body.stock_quantity = f.track ? Math.max(0, Math.round(Number(f.stock) || 0)) : 0;
    return body;
  }

  const products = {
    create: function (f) { return api().post('/products', productBody(f, true), { idempotent: false }).then((r) => r.product); },
    update: function (id, f) { return api().request('/products/' + enc(id), { method: 'PUT', body: productBody(f, false), idempotent: false }).then((r) => r.product); },
    setActive: function (id, on) { return api().request('/products/' + enc(id), { method: 'PUT', body: { is_active: !!on }, idempotent: false }).then((r) => r.product); },
    remove: function (id) { return api().del('/products/' + enc(id), { idempotent: false }); },
  };

  // VAT / tax categories the store can assign (empty when no tax pack is configured).
  function taxCategories() {
    return api().get('/tax/categories').then((r) => ({
      ready: !!(r && r.configuration_ready),
      defaultId: (r && r.default_category_id) || null,
      list: ((r && r.categories) || []).filter((c) => c.id !== 'unclassified'),
    }));
  }

  const categories = {
    create: function (c) { return api().post('/categories', { name: c.name, color: c.color, icon: c.emoji }, { idempotent: false }).then((r) => r.category); },
    update: function (id, c) { return api().request('/categories/' + enc(id), { method: 'PUT', body: { name: c.name, color: c.color, icon: c.emoji }, idempotent: false }).then((r) => r.category); },
    remove: function (id) { return api().del('/categories/' + enc(id), { idempotent: false }); },
  };

  // Option groups: opts = [[label, extraPrice], ...]. The server stores a selection range,
  // not a flag: "must choose" = at least 1; "more than one" = up to the number of choices.
  function groupBody(g) {
    return {
      name: g.name,
      is_required: !!g.req,
      min_selection: g.req ? 1 : 0,
      max_selection: g.multi ? Math.max(2, g.opts.length) : 1,
      addons: g.opts.map((o) => ({ name: o[0], price: Number(o[1]) || 0 })),
    };
  }
  const optionGroups = {
    create: function (g) { return api().post('/addon-groups', groupBody(g), { idempotent: false }).then((r) => r.addon_group); },
    update: function (id, g) { return api().request('/addon-groups/' + enc(id), { method: 'PUT', body: groupBody(g), idempotent: false }).then((r) => r.addon_group); },
    remove: function (id) { return api().del('/addon-groups/' + enc(id), { idempotent: false }); },
  };

  /* ---------- Settings ----------
   * Two kinds. SHARED settings belong to the business and are saved on the till server, so every
   * terminal agrees (name, address, VAT number, tipping, kitchen display, loyalty, receipt text, …).
   * Everything else in Settings (screen lock, theme, kiosk wording) is "this till only" and stays
   * on this device — the screen says so. A shared setting is only changed on screen after the
   * server accepted it, and Meridian reads them back from the server at sign-in.
   */
  const SHARED = {
    name:            { route: 'business', field: 'business_name' },
    address:         { route: 'business', field: 'business_address' },
    phone:           { route: 'business', field: 'business_phone' },
    vatNo:           { route: 'business', field: 'tax_registration_number' },
    tables:          { route: 'business', field: 'tables_required', bool: true },
    'loyalty.on':    { route: 'loyalty', field: 'loyalty_enabled', bool: true },
    'loyalty.cashback': { route: 'loyalty', field: 'global_cashback_percent', num: true },
    receiptFooter:   { key: 'bill_footer_message' },
    showTaxLine:     { key: 'bill_show_tax_breakdown', bool: true },
    tipping:         { key: 'tipping_enabled', bool: true },
    kitchen:         { key: 'kds_enabled', bool: true },
    defaultFloat:    { key: 'default_cash_float', num: true },
    vatRegistered:   { special: 'vat' },
  };
  function isShared(k) { return Object.prototype.hasOwnProperty.call(SHARED, k); }

  function setPathDeep(obj, path, val) {
    const parts = path.split('.'); let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] || {}; o = o[parts[i]]; }
    o[parts[parts.length - 1]] = val;
  }

  // Save one shared setting. Resolves only when the server accepted it.
  function saveSetting(k, val, country) {
    const m = SHARED[k];
    if (!m) return Promise.reject(new Error('not a shared setting: ' + k));
    if (m.special === 'vat') {
      const next = val ? api().post('/tax-packs/ensure-country', { country: country || 'GB' }, { idempotent: false })
                       : api().request('/settings/taxes_enabled', { method: 'PUT', body: { value: 'false' }, idempotent: false });
      return next.then(() => api().request('/settings/tax', { method: 'PUT', body: { tax_registered: !!val }, idempotent: false }));
    }
    const v = m.bool ? !!val : (m.num ? Number(val) : String(val));
    if (m.route === 'business') return api().request('/settings/business', { method: 'PUT', body: { [m.field]: v }, idempotent: false });
    if (m.route === 'loyalty') return api().request('/settings/loyalty', { method: 'PUT', body: { [m.field]: v }, idempotent: false });
    return api().request('/settings/' + enc(m.key), { method: 'PUT', body: { value: m.bool ? (v ? 'true' : 'false') : String(v) }, idempotent: false });
  }

  // Read the shared settings (and the active tax pack's facts) into a partial Meridian settings object.
  function loadSettings() {
    return Promise.all([
      api().get('/settings'),
      api().get('/tax/categories').catch(() => null),
    ]).then((rs) => {
      const s = (rs[0] && rs[0].settings) || {};
      const tax = rs[1] || {};
      const flag = (v, dflt) => (v === undefined || v === '' ? dflt : (v === 'true' || v === '1'));
      const out = {
        name: s.business_name, address: s.business_address || '', phone: s.business_phone || '', vatNo: s.tax_registration_number || '',
        tables: flag(s.tables_required, true), tipping: flag(s.tipping_enabled, false), kitchen: flag(s.kds_enabled, true),
        defaultFloat: Number(s.default_cash_float) || 0, receiptFooter: s.bill_footer_message || '',
        showTaxLine: flag(s.bill_show_tax_breakdown, true), vatRegistered: flag(s.taxes_enabled, false),
        country: s.country || '',
      };
      if (tax.tax_name) out.taxName = tax.tax_name;
      if (tax.inclusive_pricing_default !== undefined) out.taxInclusive = !!tax.inclusive_pricing_default;
      out.vatRates = {};
      (tax.categories || []).forEach((c) => { if (c.rate_percent != null) out.vatRates[c.id] = Number(c.rate_percent); });
      out.loyaltyOn = flag(s.loyalty_enabled, false);
      out.loyaltyCashback = Number(s.global_cashback_percent) || 0;
      return out;
    });
  }
  // Apply a loaded settings object onto Meridian's state.
  function applySettings(S, o) {
    const st = S.settings;
    ['name', 'address', 'phone', 'vatNo', 'tables', 'tipping', 'kitchen', 'defaultFloat', 'receiptFooter', 'showTaxLine', 'vatRegistered', 'taxName', 'taxInclusive', 'country'].forEach((k) => {
      if (o[k] !== undefined && o[k] !== '' && !(k === 'name' && !o[k])) st[k] = o[k];
      else if (o[k] === '' && ['address', 'phone', 'vatNo', 'receiptFooter'].indexOf(k) >= 0) st[k] = '';
    });
    S._vatRates = o.vatRates || {};
    st._live = true;
    st.loyalty = st.loyalty || {};
    st.loyalty.on = !!o.loyaltyOn; st.loyalty.cashback = o.loyaltyCashback || 0;
  }

  // The server's message for a refused change, in plain words.
  function errorMessage(e, fallback) {
    if (!e) return fallback;
    if (e.status === 403) return 'You don’t have permission to change this';
    const d = e.data || {};
    const first = d.error || (Array.isArray(d.errors) ? d.errors[0] : (d.errors && Object.values(d.errors)[0])) || e.message;
    return first ? String(first) : fallback;
  }

  window.PlemmoAdmin = { products: products, taxCategories: taxCategories, categories: categories, optionGroups: optionGroups, errorMessage: errorMessage,
    settings: { isShared: isShared, save: saveSetting, load: loadSettings, apply: applySettings, setPath: setPathDeep } };
})();
