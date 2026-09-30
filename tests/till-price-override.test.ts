/*
 * Price override — backend integration (real Express server, real SQLite).
 *
 * A line may be sold at a non-catalogue price only when the caller holds
 * `sales.price_override` (owner/manager) or supplies a valid manager PIN. The
 * catalogue price is preserved on the line, the master product price is never
 * touched, the approver is recorded, and the sale total/bill use the price the
 * sale actually ran at.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-till-price-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';
import { resetApprovalRateLimits } from '../main/core/approval';

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
const now = () => new Date().toISOString();

async function run() {
  console.log('Testing price override (backend integration)...');
  initDatabase();
  const db = getDatabase();
  const bcrypt = require('bcryptjs');
  const pw = bcrypt.hashSync('Passw0rd!x', 10);
  const user = (id: string, role: string, pin: string) =>
    db.prepare(`INSERT INTO users (id, name, email, password, role, pin_hash, is_active) VALUES (?,?,?,?,?,?,1)`)
      .run(id, id, `${id}@po.local`, pw, role, bcrypt.hashSync(pin, 10));
  user('u-own', 'owner', '1111');
  user('u-mgr', 'manager', '2222');
  user('u-cash', 'cashier', '3333');
  user('u-wait', 'waiter', '4444');
  // Cashiers/waiters need an explicit location grant to sell (owners/managers do not).
  const { grantLocationAccess } = require('../main/core/employee-access');
  const { getCurrentLocationId } = require('../main/core/location');
  grantLocationAccess('u-cash', getCurrentLocationId());
  grantLocationAccess('u-wait', getCurrentLocationId());
  db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES ('cat','Food',1,1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p1','cat','Bagel',4,1,'B1',1,1,0,0,0,?,?)`).run(now(), now());

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  try {
    const login = async (id: string) =>
      (await request(base).post('/api/auth/login').send({ email: `${id}@po.local`, password: 'Passw0rd!x' })).body.access_token as string;
    const T = { own: await login('u-own'), mgr: await login('u-mgr'), cash: await login('u-cash'), wait: await login('u-wait') };
    const as = (t: string) => (r: any) => r.set('Authorization', `Bearer ${t}`);
    const order = (tok: string, items: any[], extra: any = {}, key?: string) => {
      let r = request(base).post('/api/orders');
      if (key) r = r.set('Idempotency-Key', key);
      return as(tok)(r).send({ type: 'takeaway', items, ...extra });
    };
    const orderCount = () => (db.prepare(`SELECT COUNT(*) n FROM orders`).get() as any).n;
    const priceOf = () => (db.prepare(`SELECT price FROM products WHERE id='p1'`).get() as any).price;

    console.log('\n1. owner override (self-authorised)');
    const a = await order(T.own, [{ product_id: 'p1', quantity: 2, price_override: { unit_price: 3, reason: 'Damaged box' } }], {}, 'po-1');
    ok(a.status === 201, `owner override accepted (${a.status} ${a.body.error || ''})`);
    const line = a.body.order.items[0];
    ok(Number(line.unit_price) === 3 && Number(line.subtotal) === 6, 'the line was sold at 3.00 (subtotal 6.00)');
    ok(Number(line.original_unit_price) === 4, 'the catalogue price 4.00 is preserved on the line');
    ok(line.price_override_reason === 'Damaged box' && line.price_override_by === 'u-own', 'reason and approver are recorded on the line');
    ok(Number(a.body.order.total) === 6, 'order total uses the price the sale ran at');
    ok(priceOf() === 4, 'the master product price was never mutated');
    const bill = (await as(T.own)(request(base).post('/api/bills/generate')).send({ order_id: a.body.order.id })).body.bill;
    ok(Number(bill.total) === 6, 'the bill total matches the overridden sale');
    const audit = db.prepare(`SELECT * FROM audit_events WHERE event_type='sale.price_overridden'`).all() as any[];
    ok(audit.length === 1, 'one sale.price_overridden audit event');
    const m = JSON.parse(audit[0].metadata);
    ok(m.original_unit_price === 4 && m.unit_price === 3 && m.approved_by === 'u-own' && m.requested_by === 'u-own' && m.reason === 'Damaged box', 'audit holds original price, new price, reason, requester and approver');
    const replay = await order(T.own, [{ product_id: 'p1', quantity: 2, price_override: { unit_price: 3, reason: 'Damaged box' } }], {}, 'po-1');
    ok(replay.status === 200 && replay.body.order.id === a.body.order.id, 'idempotent replay returns the same sale');
    ok((db.prepare(`SELECT COUNT(*) n FROM audit_events WHERE event_type='sale.price_overridden'`).get() as any).n === 1, 'replay wrote no second audit event');

    console.log('\n2. cashier cannot bypass the control');
    resetApprovalRateLimits();
    const before = orderCount();
    const noPin = await order(T.cash, [{ product_id: 'p1', quantity: 1, price_override: { unit_price: 1, reason: 'mate' } }]);
    ok(noPin.status === 403 && noPin.body.requiresApproval === true, 'cashier without a PIN → 403 requiresApproval');
    const wrong = await order(T.cash, [{ product_id: 'p1', quantity: 1, price_override: { unit_price: 1, reason: 'mate' } }], { override_pin: '9999' });
    ok(wrong.status === 403 && /Invalid manager PIN/.test(wrong.body.error), 'wrong PIN refused');
    const own = await order(T.cash, [{ product_id: 'p1', quantity: 1, price_override: { unit_price: 1, reason: 'mate' } }], { override_pin: '3333' });
    ok(own.status === 403, "the cashier's own PIN is not approval");
    const forged = await order(T.cash, [{ product_id: 'p1', quantity: 1, price_override: { unit_price: 1, reason: 'mate' }, price_override_by: 'u-mgr' }], { priceOverrideApprovedBy: 'u-mgr', approved_by: 'u-mgr' });
    ok(forged.status === 403, 'client-supplied approver fields are ignored');
    const waiterTry = await order(T.wait, [{ product_id: 'p1', quantity: 1, price_override: { unit_price: 1, reason: 'mate' } }]);
    ok(waiterTry.status === 403, 'a waiter cannot override either');
    ok(orderCount() === before, 'no sale was created by any refused attempt');

    console.log('\n3. cashier with a manager PIN');
    resetApprovalRateLimits();
    const withPin = await order(T.cash, [{ product_id: 'p1', quantity: 1, price_override: { unit_price: '2.50', reason: 'Price match' } }], { override_pin: '2222' });
    ok(withPin.status === 201, `manager PIN approves the override (${withPin.status})`);
    const l2 = withPin.body.order.items[0];
    ok(Number(l2.unit_price) === 2.5 && l2.price_override_by === 'u-mgr' && Number(l2.original_unit_price) === 4, 'sold at 2.50; manager recorded as approver; original kept');
    const m2 = JSON.parse((db.prepare(`SELECT metadata FROM audit_events WHERE event_type='sale.price_overridden' ORDER BY rowid DESC LIMIT 1`).get() as any).metadata);
    ok(m2.requested_by === 'u-cash' && m2.approved_by === 'u-mgr', 'audit records the cashier who asked and the manager who approved');

    console.log('\n4. validation');
    const badCases: [string, any][] = [
      ['no reason', { unit_price: 1, reason: '' }],
      ['negative price', { unit_price: -1, reason: 'x' }],
      ['non-numeric price', { unit_price: 'abc', reason: 'x' }],
      ['absurd price', { unit_price: 99999999999, reason: 'x' }],
      ['reason too long', { unit_price: 1, reason: 'x'.repeat(201) }],
    ];
    for (const [label, po] of badCases) {
      const r = await order(T.own, [{ product_id: 'p1', quantity: 1, price_override: po }]);
      ok(r.status === 400, `invalid override rejected (${label}) → ${r.status}`);
    }
    const same = await order(T.own, [{ product_id: 'p1', quantity: 1, price_override: { unit_price: 4, reason: 'same' } }]);
    ok(same.status === 201 && same.body.order.items[0].original_unit_price === null, 'overriding to the catalogue price records no override');
    const free = await order(T.own, [{ product_id: 'p1', quantity: 1, price_override: { unit_price: 0, reason: 'Comp' } }]);
    ok(free.status === 201 && Number(free.body.order.total) === 0, 'a zero price (comp) is allowed and audited');
    const plain = await order(T.cash, [{ product_id: 'p1', quantity: 1 }]);
    ok(plain.status === 201 && Number(plain.body.order.items[0].unit_price) === 4, 'an ordinary sale by a cashier is unaffected');
    ok(plain.body.order.items[0].original_unit_price === null, 'a normal line has no override data');

    console.log('\n5. add items to an open order');
    const open = await order(T.own, [{ product_id: 'p1', quantity: 1 }], { type: 'dine_in' });
    const addNo = await as(T.cash)(request(base).post(`/api/orders/${open.body.order.id}/items`)).send({ items: [{ product_id: 'p1', quantity: 1, price_override: { unit_price: 1, reason: 'x' } }] });
    ok(addNo.status === 403, 'adding an overridden line needs approval too');
    resetApprovalRateLimits();
    const addYes = await as(T.cash)(request(base).post(`/api/orders/${open.body.order.id}/items`)).send({ override_pin: '1111', items: [{ product_id: 'p1', quantity: 1, price_override: { unit_price: 1, reason: 'Loyal customer' } }] });
    ok(addYes.status === 200, 'with an owner PIN the line is added');
    const rows = db.prepare(`SELECT unit_price, original_unit_price, price_override_by FROM order_items WHERE order_id=? ORDER BY id`).all(open.body.order.id) as any[];
    ok(rows.length === 2 && rows[1].unit_price === 1 && rows[1].original_unit_price === 4 && rows[1].price_override_by === 'u-own', 'the added line carries the override; the earlier line is untouched');
    ok(Number(addYes.body.order.total) === 5, 'order total re-derived from the overridden line (4 + 1)');

    console.log(`\n✅ Price override backend tests passed (${passed} checks)`);
  } finally {
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
