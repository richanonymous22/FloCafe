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

  // The server's message for a refused change, in plain words.
  function errorMessage(e, fallback) {
    if (!e) return fallback;
    if (e.status === 403) return 'You don’t have permission to change this';
    const d = e.data || {};
    const first = d.error || (Array.isArray(d.errors) ? d.errors[0] : (d.errors && Object.values(d.errors)[0])) || e.message;
    return first ? String(first) : fallback;
  }

  window.PlemmoAdmin = { products: products, taxCategories: taxCategories, categories: categories, optionGroups: optionGroups, errorMessage: errorMessage };
})();
