/* ============================================================================
 * 03c-plemmo-catalogue.js — Catalogue adapter (Plemmo → Meridian shapes)
 * ----------------------------------------------------------------------------
 * Phase 2 (Catalogue) of the Meridian → Plemmo integration.
 *
 * Plemmo is authoritative for the catalogue. This module fetches categories,
 * products, addon groups (modifiers) and customers from the real Plemmo API
 * and maps them into the exact in-memory shapes Meridian's views already
 * render — so the register shows REAL products/prices without redesigning the
 * UI. Meridian's local `S` catalogue slices become a read-through cache of
 * Plemmo, not a source of truth.
 *
 * The mapping functions are PURE and exposed on window.PlemmoCatalogue so they
 * can be unit-tested directly (tests/meridian-catalogue.test.ts).
 *
 * Depends on window.PlemmoAPI (00-plemmo-api.js).
 * ==========================================================================*/
(function () {
  'use strict';

  // Deterministic emoji for a category when Plemmo stores an icon/none.
  function catEmoji(cat) {
    if (cat && cat.icon && /\p{Extended_Pictographic}/u.test(cat.icon)) return cat.icon;
    return '🏷️';
  }
  function catColor(cat) { return (cat && cat.color) || '#8C93A0'; }

  function mapCategory(c) {
    return { id: c.id, name: c.name, emoji: catEmoji(c), color: catColor(c) };
  }

  // Plemmo addon_group → Meridian modGroup.
  // req: required to pick (is_required or min_selection>0)
  // multi: more than one selectable (max_selection>1 or 0 == unlimited)
  function mapModGroup(g) {
    const addons = Array.isArray(g.addons) ? g.addons : [];
    const max = (g.max_selection == null) ? 1 : g.max_selection;
    return {
      id: g.id,
      name: g.name,
      req: !!g.is_required || (g.min_selection || 0) > 0,
      multi: max === 0 || max > 1,
      std: false,
      opts: addons.map((a) => [a.name, Number(a.price) || 0])
    };
  }

  function mapProduct(p) {
    const groups = Array.isArray(p.addon_groups) ? p.addon_groups : [];
    const tracks = !!p.track_inventory;
    return {
      id: p.id,
      name: p.name,
      cat: p.category_id || (p.category && p.category.id) || null,
      price: Number(p.price) || 0,
      cost: Number(p.cost) || 0,
      emoji: '🏷️',
      stock: tracks ? (Number(p.stock_quantity) || 0) : null,
      low: tracks ? (p.low_stock_threshold == null ? 5 : Number(p.low_stock_threshold)) : null,
      w: Number(p.sort_order) || 0,
      mods: groups.map((g) => g.id),
      allergens: Array.isArray(p.tags) ? p.tags : [],
      desc: p.description || '',
      sku: p.sku || '',
      barcode: p.barcode || '',
      available: p.is_active == null ? true : !!p.is_active,
      kiosk: true
    };
  }

  // Plemmo customers GET returns c.* plus visits_count, total_spent,
  // wallet_balance (loyalty), last_visit_at.
  function mapCustomer(c) {
    const last = c.last_visit_at || c.last_order_at;
    return {
      id: c.id,
      name: c.name || '',
      phone: c.phone || '',
      email: c.email || '',
      created: c.created_at ? Date.parse(c.created_at) || Date.now() : Date.now(),
      points: Number(c.wallet_balance != null ? c.wallet_balance : (c.points || c.loyalty_points)) || 0,
      visits: Number(c.visits_count != null ? c.visits_count : (c.visits || c.order_count)) || 0,
      spend: Number(c.total_spent != null ? c.total_spent : (c.total_spend || c.lifetime_spend)) || 0,
      last: last ? (Date.parse(last) || null) : null,
      notes: c.notes || ''
    };
  }

  // Load authoritative catalogue from Plemmo and hydrate the given state object
  // in place (categories, products, modGroups, customers). Returns the counts.
  async function load(S) {
    const api = window.PlemmoAPI;
    const [catsRes, prodsRes, groupsRes] = await Promise.all([
      api.resources.categories(),
      api.resources.products(),
      api.resources.addonGroups()
    ]);
    const cats = (catsRes && catsRes.categories) || [];
    const prods = (prodsRes && prodsRes.products) || [];
    const groups = (groupsRes && (groupsRes.addon_groups || groupsRes.addonGroups)) || [];

    let customers = [];
    try {
      const custRes = await api.resources.customers('per_page=500');
      customers = (custRes && (custRes.data || custRes.customers)) || [];
    } catch (e) { /* customers optional for catalogue hydration */ }

    if (S) {
      S.categories = cats.map(mapCategory);
      S.modGroups = groups.map(mapModGroup);
      S.products = prods.map(mapProduct);
      S.customers = customers.map(mapCustomer);
    }
    return {
      categories: cats.length, products: prods.length,
      modGroups: groups.length, customers: customers.length
    };
  }

  window.PlemmoCatalogue = {
    mapCategory: mapCategory,
    mapModGroup: mapModGroup,
    mapProduct: mapProduct,
    mapCustomer: mapCustomer,
    load: load
  };
})();
