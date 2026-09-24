/*
 * Meridian → Plemmo integration — Core POS order-commit verification.
 *
 * Loads the real catalogue + order adapters, then:
 *   1. Unit-tests the pure cart→order mappers.
 *   2. End-to-end: seeds a catalogue, logs in, builds a Meridian-style cart,
 *      maps it with the real adapter, POSTs it to /api/orders, and asserts
 *      Plemmo returns AUTHORITATIVE totals (subtotal/tax/total incl. addon),
 *      and that the Idempotency-Key prevents duplicate sales on retry.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-ord-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const srcDir = path.join(__dirname, '..', 'frontend-meridian', 'src');
const sandbox: any = { window: {}, S: undefined };
vm.runInNewContext(fs.readFileSync(path.join(srcDir, '03c-plemmo-catalogue.js'), 'utf8'), sandbox);
vm.runInNewContext(fs.readFileSync(path.join(srcDir, '03d-plemmo-orders.js'), 'utf8'), sandbox);
const Cat = sandbox.window.PlemmoCatalogue;
const Ord = sandbox.window.PlemmoOrders;

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
const now = () => new Date().toISOString();

async function run() {
  console.log('Testing Meridian order-commit adapter (Core POS)...');

  // 1. Pure mapper unit tests.
  assert(Ord.orderTypeToChannel('dine') === 'dine_in', 'dine → dine_in');
  assert(Ord.orderTypeToChannel('takeaway') === 'takeaway', 'takeaway → takeaway');
  assert(Ord.orderTypeToChannel('retail') === 'in_store', 'retail → in_store');

  const idx = { 'ag-milk': { Oat: { id: 'ad-oat', price: 0.4 } } };
  const item = Ord.cartLineToItem({ pid: 'p1', qty: 2, mods: [{ n: 'Oat', p: 0.4, g: 'ag-milk' }], note: 'hot' }, idx);
  assert(item.product_id === 'p1' && item.quantity === 2, 'line maps product + qty');
  assert(item.addons.length === 1 && item.addons[0].id === 'ad-oat', 'mod resolves to authoritative addon id');
  assert(item.special_instructions === 'hot', 'note maps to special_instructions');

  const body = Ord.cartToOrderBody({ type: 'dine', table: 't1', items: [{ pid: 'p1', qty: 1, mods: [] }] }, idx);
  assert(body.type === 'dine_in' && body.table_id === 't1' && body.items.length === 1, 'cartToOrderBody builds request');

  // 2. End-to-end authoritative sale.
  initDatabase();
  const db = getDatabase();
  db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES ('cat-c','Coffee',1,1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO addon_groups (id, name, is_required, min_selection, max_selection, is_active, sort_order, created_at, updated_at) VALUES ('ag-milk','Milk',0,0,1,1,1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO addons (id, addon_group_id, name, price, is_active, sort_order, created_at, updated_at) VALUES ('ad-oat','ag-milk','Oat',0.4,1,1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('prod-latte','cat-c','Latte',3.4,0.66,'SKU-L',1,1,0,0,0,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO addon_group_product (addon_group_id, product_id) VALUES ('ag-milk','prod-latte')`).run();
  const bcrypt = require('bcryptjs');
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active) VALUES ('u-own','Owner','own@ord.local',?, 'owner',1)`).run(bcrypt.hashSync('OwnerPass123!', 10));

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  try {
    const token = (await request(base).post('/api/auth/login').send({ email: 'own@ord.local', password: 'OwnerPass123!' })).body.access_token;
    const auth = (r: any) => r.set('Authorization', `Bearer ${token}`);

    // Build the addon index from the live addon-groups response (real path).
    const groups = (await auth(request(base).get('/api/addon-groups'))).body.addon_groups;
    const addonIndex = Cat.buildAddonIndex(groups);
    assert(addonIndex['ag-milk'].Oat.id === 'ad-oat', 'addon index built from live data');

    // A Meridian cart: 2 lattes, one with Oat milk.
    const cart = { type: 'takeaway', items: [
      { pid: 'prod-latte', qty: 1, mods: [{ n: 'Oat', p: 0.4, g: 'ag-milk' }], note: '' },
      { pid: 'prod-latte', qty: 1, mods: [], note: '' }
    ] };
    const orderBody = Ord.cartToOrderBody(cart, addonIndex);

    const idem = 'test-idem-key-1';
    const created = await auth(request(base).post('/api/orders').set('Idempotency-Key', idem).send(orderBody));
    assert(created.status === 201, 'order created (201)');
    const order = created.body.order;
    // Authoritative money: 3.4 + (3.4 + 0.4) = 7.2 subtotal (no tax configured).
    assert(Math.abs(order.subtotal - 7.2) < 0.001, `Plemmo computes authoritative subtotal (got ${order.subtotal})`);
    assert(typeof order.total === 'number' && order.total >= order.subtotal, 'order has an authoritative total');
    assert(Array.isArray(order.items) && order.items.length === 2, 'order persists two lines');

    // Idempotent replay: same key → same order, no duplicate.
    const replay = await auth(request(base).post('/api/orders').set('Idempotency-Key', idem).send(orderBody));
    assert(replay.status === 200, 'idempotent replay returns 200');
    assert(replay.body.order.id === order.id, 'idempotent replay returns the same order (no duplicate)');
    const count = db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number };
    assert(count.n === 1, 'exactly one sale persisted despite retry');

    console.log('✅ Meridian order-commit adapter (Core POS) tests passed');
  } finally {
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
