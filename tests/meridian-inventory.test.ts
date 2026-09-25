/*
 * Inventory / Purchasing phase — Meridian integration verification.
 *
 *   1. Sandbox unit-tests the inventory adapter's pure mapping (Meridian's
 *      receive/waste/count → the single Plemmo ledger request).
 *   2. Contract test: exercises /api/inventory/adjust for all three modes and
 *      asserts the authoritative single ledger — balance, history, low-stock,
 *      products.stock_quantity kept in sync (NO second ledger), negative guard.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-inv-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

// Load the real adapter in a sandbox for the pure-mapping assertions.
const calls: any[] = [];
const sandbox: any = { window: { PlemmoAPI: {
  get: (p: string) => { calls.push({ m: 'GET', p }); return Promise.resolve({}); },
  post: (p: string, body: any, opts: any) => { calls.push({ m: 'POST', p, body, opts }); return Promise.resolve({ movement: { balance_after: 42 } }); },
} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'frontend-meridian', 'src', '03f-plemmo-inventory.js'), 'utf8'), sandbox);
const Inv = sandbox.window.PlemmoInventory;

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
const now = () => new Date().toISOString();

async function run() {
  console.log('Testing Inventory / Purchasing (Meridian integration)...');

  // 1. Pure mapping.
  assert(Inv.buildAdjustBody('receive', 'p1', 12).quantity_delta === 12, 'receive → +12 delta');
  assert(Inv.buildAdjustBody('receive', 'p1', 12).movement_type === 'receipt', 'receive → receipt');
  assert(Inv.buildAdjustBody('waste', 'p1', 3).quantity_delta === -3, 'waste → -3 delta');
  const countBody = Inv.buildAdjustBody('count', 'p1', 8, 20);
  assert(countBody.quantity_delta === -12 && countBody.movement_type === 'adjustment', 'count → delta = counted - current');
  assert(Inv.buildAdjustBody('count', 'p1', 20, 20) === null, 'count with no change is a no-op');
  const S: any = { products: [{ id: 'p1', stock: 5 }] };
  Inv.applyBalance(S, 'p1', 99);
  assert(S.products[0].stock === 99, 'applyBalance updates local stock from authoritative balance');

  // 2. Contract test against the single Plemmo ledger.
  initDatabase();
  const db = getDatabase();
  db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES ('cat','C',1,1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p-bean','cat','Beans',5,2,1,1,1,10,5,?,?)`).run(now(), now());
  const bcrypt = require('bcryptjs');
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active) VALUES ('u-own','Owner','own@inv.local',?, 'owner',1)`).run(bcrypt.hashSync('OwnerPass123!', 10));

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  try {
    const token = (await request(base).post('/api/auth/login').send({ email: 'own@inv.local', password: 'OwnerPass123!' })).body.access_token;
    const auth = (r: any) => r.set('Authorization', `Bearer ${token}`);
    const stockQty = () => (db.prepare(`SELECT stock_quantity FROM products WHERE id='p-bean'`).get() as any).stock_quantity;

    // receive +20 → 30
    let r = await auth(request(base).post('/api/inventory/adjust')).send(Inv.buildAdjustBody('receive', 'p-bean', 20));
    assert(r.status === 201 && r.body.movement.balance_after === 30, `receive → balance 30 (got ${r.body.movement && r.body.movement.balance_after})`);
    assert(stockQty() === 30, 'products.stock_quantity synced to 30 (single ledger, no drift)');

    // waste -5 → 25
    r = await auth(request(base).post('/api/inventory/adjust')).send(Inv.buildAdjustBody('waste', 'p-bean', 5, null, 'Damaged'));
    assert(r.body.movement.balance_after === 25, 'waste → balance 25');

    // count to 18 (delta -7) → 18
    r = await auth(request(base).post('/api/inventory/adjust')).send(Inv.buildAdjustBody('count', 'p-bean', 18, 25));
    assert(r.body.movement.balance_after === 18 && stockQty() === 18, 'count → balance 18 + synced');

    // balance + history + low-stock
    const bal = await auth(request(base).get('/api/inventory/balance?product_id=p-bean'));
    assert(bal.body.balance === 18, 'GET balance is authoritative (18)');
    const hist = await auth(request(base).get('/api/inventory/history?product_id=p-bean'));
    assert(Array.isArray(hist.body.movements) && hist.body.movements.length === 3, 'history has exactly 3 movements (one ledger)');
    // Drive below threshold (5): waste 14 → 4 → appears in low-stock
    await auth(request(base).post('/api/inventory/adjust')).send(Inv.buildAdjustBody('waste', 'p-bean', 14));
    const low = await auth(request(base).get('/api/inventory/low-stock'));
    assert(low.body.items.some((i: any) => i.productId === 'p-bean'), 'low-stock lists the depleted product');

    // Negative-stock guard: cannot waste more than on hand.
    const bad = await auth(request(base).post('/api/inventory/adjust')).send(Inv.buildAdjustBody('waste', 'p-bean', 999));
    assert(bad.status >= 400 && bad.status < 500, 'over-waste rejected (no negative stock)');

    console.log('✅ Inventory / Purchasing (Meridian integration) tests passed');
  } finally {
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
