/*
 * Meridian → Plemmo integration — Phase 2 (Catalogue) verification.
 *
 * Loads the REAL catalogue adapter (frontend-meridian/src/03c-plemmo-catalogue.js)
 * into a sandbox, then:
 *   1. Unit-tests the pure mappers against representative Plemmo payloads.
 *   2. Contract test: seeds real catalogue rows, fetches them over HTTP through
 *      the Plemmo API, and asserts the adapter maps the live responses into the
 *      exact shapes Meridian's views consume.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-cat-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

// Load the adapter source and evaluate it with a fake `window`.
const adapterSrc = fs.readFileSync(
  path.join(__dirname, '..', 'frontend-meridian', 'src', '03c-plemmo-catalogue.js'), 'utf8');
const sandbox: any = { window: {} };
vm.runInNewContext(adapterSrc, sandbox);
const C = sandbox.window.PlemmoCatalogue;

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
const now = () => new Date().toISOString();

async function run() {
  console.log('Testing Meridian catalogue adapter (Phase 2)...');
  assert(!!C && typeof C.mapProduct === 'function', 'adapter exposes mappers');

  // 1. Unit tests on the pure mappers.
  const cat = C.mapCategory({ id: 'cat1', name: 'Coffee', color: '#B7794B', icon: '☕' });
  assert(cat.id === 'cat1' && cat.name === 'Coffee' && cat.color === '#B7794B' && cat.emoji === '☕', 'mapCategory maps fields');

  const grp = C.mapModGroup({ id: 'g1', name: 'Milk', is_required: 1, min_selection: 1, max_selection: 1,
    addons: [{ name: 'Whole', price: 0 }, { name: 'Oat', price: 0.4 }] });
  assert(grp.req === true && grp.multi === false && grp.opts.length === 2 && grp.opts[1][0] === 'Oat' && grp.opts[1][1] === 0.4, 'mapModGroup maps required/single + options');
  const grpMulti = C.mapModGroup({ id: 'g2', name: 'Extras', is_required: 0, min_selection: 0, max_selection: 5, addons: [] });
  assert(grpMulti.req === false && grpMulti.multi === true, 'mapModGroup maps optional/multi');

  const prod = C.mapProduct({ id: 'p1', category_id: 'cat1', name: 'Latte', price: 3.4, cost: 0.66,
    track_inventory: 1, stock_quantity: 12, low_stock_threshold: 5, is_active: 1, sort_order: 3,
    addon_groups: [{ id: 'g1' }], description: 'Milky', sku: 'SKU1', tags: ['milk'] });
  assert(prod.id === 'p1' && prod.cat === 'cat1' && prod.price === 3.4 && prod.cost === 0.66, 'mapProduct maps money + category');
  assert(prod.stock === 12 && prod.low === 5 && prod.mods[0] === 'g1' && prod.available === true, 'mapProduct maps stock + mods + availability');
  const prodNoTrack = C.mapProduct({ id: 'p2', name: 'Service', price: 1, track_inventory: 0, addon_groups: [] });
  assert(prodNoTrack.stock === null && prodNoTrack.low === null, 'mapProduct leaves stock null when not tracked');

  const cust = C.mapCustomer({ id: 'c1', name: 'Aisha Khan', phone: '0700', email: 'a@x.com',
    wallet_balance: 120, visits_count: 4, total_spent: 88.5, last_visit_at: '2026-09-01T10:00:00Z' });
  assert(cust.points === 120 && cust.visits === 4 && cust.spend === 88.5 && cust.last !== null, 'mapCustomer maps loyalty/visits/spend/last');

  // 2. Contract test against the live API.
  initDatabase();
  const db = getDatabase();
  db.prepare(`INSERT INTO categories (id, name, color, icon, is_active, sort_order, created_at, updated_at)
              VALUES ('cat-c', 'Coffee', '#B7794B', '☕', 1, 1, ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO addon_groups (id, name, is_required, min_selection, max_selection, is_active, sort_order, created_at, updated_at)
              VALUES ('ag-milk', 'Milk', 1, 1, 1, 1, 1, ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO addons (id, addon_group_id, name, price, is_active, sort_order, created_at, updated_at)
              VALUES ('ad-oat', 'ag-milk', 'Oat', 0.4, 1, 1, ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, description, price, cost, sku, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('prod-latte', 'cat-c', 'Latte', 'Milky', 3.4, 0.66, 'SKU-L', 1, 1, 1, 12, 5, ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO addon_group_product (addon_group_id, product_id) VALUES ('ag-milk', 'prod-latte')`).run();
  db.prepare(`INSERT INTO customers (id, name, phone, email, is_active, created_at, updated_at)
              VALUES ('cust-a', 'Aisha Khan', '0700900900', 'a@x.com', 1, ?, ?)`).run(now(), now());

  const bcrypt = require('bcryptjs');
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active)
              VALUES ('u-own', 'Owner', 'own@cat.local', ?, 'owner', 1)`).run(bcrypt.hashSync('OwnerPass123!', 10));

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  try {
    const token = (await request(base).post('/api/auth/login')
      .send({ email: 'own@cat.local', password: 'OwnerPass123!' })).body.access_token;
    const auth = (r: any) => r.set('Authorization', `Bearer ${token}`);

    const cats = (await auth(request(base).get('/api/categories'))).body.categories.map(C.mapCategory);
    assert(cats.length >= 1 && cats.find((x: any) => x.name === 'Coffee'), 'live categories map');

    const groups = (await auth(request(base).get('/api/addon-groups'))).body.addon_groups.map(C.mapModGroup);
    const milk = groups.find((g: any) => g.name === 'Milk');
    assert(!!milk && milk.req === true && milk.opts.some((o: any) => o[0] === 'Oat' && o[1] === 0.4), 'live addon group maps with options');

    const prods = (await auth(request(base).get('/api/products'))).body.products.map(C.mapProduct);
    const latte = prods.find((p: any) => p.name === 'Latte');
    assert(!!latte && latte.price === 3.4 && latte.cat === 'cat-c' && latte.mods.includes('ag-milk') && latte.stock === 12,
      'live product maps price/category/mods/stock');

    const custs = (await auth(request(base).get('/api/customers?per_page=500'))).body.data.map(C.mapCustomer);
    assert(custs.length >= 1 && custs.find((x: any) => x.name === 'Aisha Khan'), 'live customers map');

    console.log('✅ Meridian catalogue adapter (Phase 2) tests passed');
  } finally {
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
