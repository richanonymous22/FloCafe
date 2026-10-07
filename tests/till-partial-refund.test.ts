/*
 * Partial refunds by item — backend integration (real Express server, real SQLite).
 *
 * A refund can be sized from the lines coming back: their share of what the customer
 * actually paid (after any order discount), capped by what was sold and what has already
 * come back, tracked per line in refund_lines. Money-only returns skip the stock return.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-till-partial-'));
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
  console.log('Testing partial refunds (backend integration)...');
  initDatabase();
  const db = getDatabase();
  const bcrypt = require('bcryptjs');
  const pw = bcrypt.hashSync('Passw0rd!x', 10);
  const user = (id: string, role: string, pin: string | null) =>
    db.prepare(`INSERT INTO users (id, name, email, password, role, pin_hash, is_active) VALUES (?,?,?,?,?,?,1)`)
      .run(id, id, `${id}@till.local`, pw, role, pin ? bcrypt.hashSync(pin, 10) : null);
  user('u-own', 'owner', '1111');
  user('u-mgr', 'manager', '2222');
  user('u-cash', 'cashier', '3333');
  user('u-wait', 'waiter', '4444');

  db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES ('cat','Food',1,1,?,?)`).run(now(), now());
  // Tracked product with stock 10 (ledger seeds from stock_quantity), plus an untracked one.
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p-track','cat','Bagel',4,1,'B1',1,1,1,10,0,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p-free','cat','Tea',2,0.3,'T1',1,2,0,0,0,?,?)`).run(now(), now());
  db.prepare(`UPDATE products SET cb_percent = 50 WHERE id = 'p-track'`).run();
  db.prepare(`INSERT INTO customers (id, name, phone, created_at, updated_at) VALUES ('c1','Cara','07700900001',?,?)`).run(now(), now());
  db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('global_cashback_percent','50',?)`).run(now());
  db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('loyalty_enabled','true',?)`).run(now());

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  try {
    const login = async (id: string) =>
      (await request(base).post('/api/auth/login').send({ email: `${id}@till.local`, password: 'Passw0rd!x' })).body.access_token as string;
    const T = { own: await login('u-own'), mgr: await login('u-mgr'), cash: await login('u-cash'), wait: await login('u-wait') };
    const as = (t: string) => (r: any) => r.set('Authorization', `Bearer ${t}`);

    // Open a drawer so cash refunds have somewhere to land.
    const open = await as(T.own)(request(base).post('/api/cash/session/open')).send({ opening_float_minor: 10000 });
    ok(open.status === 201, 'cash session opened');
    const sessionId = open.body.session.id as string;
    const drawerExpected = async () => (await as(T.own)(request(base).get('/api/cash/session'))).body;

    let seq = 0;
    async function sell(items: { product_id: string; quantity: number }[], payments: any[], customer?: string) {
      const o = await as(T.own)(request(base).post('/api/orders').set('Idempotency-Key', `sell-${++seq}`))
        .send({ type: 'takeaway', items, customer_id: customer });
      ok(o.status === 201, `sale created (${o.status})`);
      const orderId = o.body.order.id as number;
      const gen = await as(T.own)(request(base).post('/api/bills/generate')).send({ order_id: orderId });
      const bill = gen.body.bill;
      const total = Number(bill.total);
      const lines = payments.map((p) => ({ ...p, amount: p.amount === 'ALL' ? total : p.amount }));
      const paid = await as(T.own)(request(base).post(`/api/bills/${bill.id}/payments`).set('Idempotency-Key', `pay-${seq}`)).send({ payments: lines, customer_id: customer });
      ok(paid.status === 200, `bill paid (${paid.status}: ${paid.body.error || ''})`);
      return { orderId, billId: bill.id as number, total, orderItems: o.body.order.items as any[] };
    }
    const refund = (tok: string, billId: number, body: any, key?: string) => {
      let r = request(base).post(`/api/bills/${billId}/refund`);
      if (key) r = r.set('Idempotency-Key', key);
      return as(tok)(r).send(body);
    };
    const stockOf = () => (db.prepare(`SELECT quantity FROM inventory_balances WHERE product_id='p-track'`).get() as any)?.quantity as number;

    const linesOf = async (billId: number) => (await as(T.mgr)(request(base).get(`/api/bills/${billId}/refunds`))).body;

    console.log('\n1. return 1 of 3 (tracked stock, no discount)');
    const s1 = await sell([{ product_id: 'p-track', quantity: 3 }, { product_id: 'p-free', quantity: 1 }], [{ method: 'cash', amount: 'ALL' }]);
    ok(s1.total === 14, 'sale: 3 x 4.00 + 1 x 2.00 = 14.00');
    const g1 = await linesOf(s1.billId);
    const bagelLine = g1.items.find((l: any) => l.name === 'Bagel');
    const teaLine = g1.items.find((l: any) => l.name === 'Tea');
    ok(bagelLine.refundable_quantity === 3 && bagelLine.unit_refund_minor === 400 && teaLine.unit_refund_minor === 200, 'the refund screen data: refundable quantities and per-unit value (4.00 / 2.00)');
    const r1 = await refund(T.mgr, s1.billId, { reason: 'One bagel was stale', amount_from_items: true, items: [{ order_item_id: bagelLine.order_item_id, quantity: 1 }] });
    ok(r1.status === 200 && r1.body.amount_minor === 400, 'refund is the value of the returned item: 4.00');
    ok(r1.body.fully_refunded === false && r1.body.refundable_remaining_minor === 1000, '10.00 is still refundable');
    ok(stockOf() === 10 - 3 + 1, 'one bagel went back to stock (7 -> 8)');
    ok(r1.body.lines.length === 1 && r1.body.lines[0].quantity === 1 && r1.body.lines[0].restocked === true, 'the response lists the returned line');
    const g1b = await linesOf(s1.billId);
    ok(g1b.items.find((l: any) => l.name === 'Bagel').refundable_quantity === 2 && g1b.items.find((l: any) => l.name === 'Bagel').refunded_quantity === 1, 'the line now shows 1 returned, 2 refundable');
    ok((db.prepare(`SELECT payment_status FROM bills WHERE id=?`).get(s1.billId) as any).payment_status === 'paid', 'the original bill is untouched');

    console.log('\n2. caps: cannot return more than is left');
    const over = await refund(T.mgr, s1.billId, { reason: 'x', amount_from_items: true, items: [{ order_item_id: bagelLine.order_item_id, quantity: 3 }] });
    ok(over.status === 400 && /Only 2 of Bagel/.test(over.body.error), 'returning 3 when 2 are left is refused with the reason');
    const dup = await refund(T.mgr, s1.billId, { reason: 'x', amount_from_items: true, items: [{ order_item_id: bagelLine.order_item_id, quantity: 1 }, { order_item_id: bagelLine.order_item_id, quantity: 1 }] });
    ok(dup.status === 400, 'the same line twice in one request is refused');
    const none = await refund(T.mgr, s1.billId, { reason: 'x', amount_from_items: true });
    ok(none.status === 400, 'item mode with no items is refused');
    ok(stockOf() === 8, 'refused attempts changed nothing');

    console.log('\n3. money-only return (damaged goods): no restock');
    const r3 = await refund(T.mgr, s1.billId, { reason: 'Damaged', amount_from_items: true, items: [{ order_item_id: bagelLine.order_item_id, quantity: 1, restock: false }] });
    ok(r3.status === 200 && r3.body.amount_minor === 400 && r3.body.restocked.length === 0 && r3.body.lines[0].restocked === false, 'refunded 4.00, nothing restocked');
    ok(stockOf() === 8, 'stock unchanged for a money-only return');
    ok((await linesOf(s1.billId)).items.find((l: any) => l.name === 'Bagel').refundable_quantity === 1, 'the line still tracks the unit as returned');

    console.log('\n4. an order discount is shared into the refund');
    const o = await as(T.own)(request(base).post('/api/orders').set('Idempotency-Key', 'disc-1')).send({ type: 'takeaway', items: [{ product_id: 'p-free', quantity: 5 }] });
    const dOrder = o.body.order.id as number;
    const disc = await as(T.own)(request(base).patch(`/api/orders/${dOrder}/discount`)).send({ discount_type: 'percentage', discount_value: 10, discount_reason: 'x' });
    ok(disc.status === 200, '10% discount applied (10.00 -> 9.00)');
    const gen = await as(T.own)(request(base).post('/api/bills/generate')).send({ order_id: dOrder });
    ok(Number(gen.body.bill.total) === 9, 'bill total 9.00');
    await as(T.own)(request(base).post(`/api/bills/${gen.body.bill.id}/payments`).set('Idempotency-Key', 'pay-d')).send({ payments: [{ method: 'cash', amount: 9 }] });
    const gd = await linesOf(gen.body.bill.id);
    ok(gd.items[0].unit_refund_minor === 180, 'each 2.00 tea refunds 1.80 (its share after the discount)');
    const rd = await refund(T.mgr, gen.body.bill.id, { reason: 'Returned 2', amount_from_items: true, items: [{ order_item_id: gd.items[0].order_item_id, quantity: 2 }] });
    ok(rd.status === 200 && rd.body.amount_minor === 360, 'returning 2 teas refunds 3.60, not 4.00');
    const rest = await refund(T.mgr, gen.body.bill.id, { reason: 'Rest', amount_from_items: true, items: [{ order_item_id: gd.items[0].order_item_id, quantity: 3 }] });
    ok(rest.status === 200 && rest.body.fully_refunded === true && rest.body.refundable_remaining_minor === 0, 'returning the last 3 refunds exactly what is left: fully refunded to the penny');

    console.log('\n5. permissions and idempotency still hold');
    const s5 = await sell([{ product_id: 'p-free', quantity: 2 }], [{ method: 'cash', amount: 'ALL' }]);
    const g5 = await linesOf(s5.billId);
    const body5 = { reason: 'Cashier return', amount_from_items: true, items: [{ order_item_id: g5.items[0].order_item_id, quantity: 1 }] };
    const noPin = await refund(T.cash, s5.billId, body5);
    ok(noPin.status === 403 && noPin.body.requiresApproval === true, 'a cashier without a PIN is refused');
    resetApprovalRateLimits();
    const withPin = await refund(T.cash, s5.billId, { ...body5, override_pin: '2222' }, 'idem-5');
    ok(withPin.status === 200 && withPin.body.amount_minor === 200, 'a cashier with the manager PIN succeeds (2.00)');
    const replay = await refund(T.cash, s5.billId, { ...body5, override_pin: '2222' }, 'idem-5');
    ok(replay.status === 200 && replay.body.idempotentReplay === true && (await linesOf(s5.billId)).items[0].refunded_quantity === 1, 'a retry with the same key replays and does not return a second unit');
    const mixed = await refund(T.cash, s5.billId, { reason: 'Cashier return', amount: 1, override_pin: '2222' }, 'idem-5');
    ok(mixed.status === 409, 'the same key with a different request is rejected');
    const audit = JSON.parse((db.prepare(`SELECT metadata FROM audit_events WHERE event_type='bill.refunded' AND entity_id=? ORDER BY rowid DESC LIMIT 1`).get(String(s5.billId)) as any).metadata);
    ok(audit.amount_from_items === true && audit.lines[0].quantity === 1 && audit.approved_by === 'u-mgr', 'audited with the returned lines and the approver');

    console.log(`\n✅ Partial refunds passed (${passed} checks)`);
  } finally {
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
