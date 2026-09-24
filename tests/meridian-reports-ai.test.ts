/*
 * Reports / Digital Receipts / AI phase — verification.
 *
 *   1. Reports API returns authoritative figures.
 *   2. Digital receipt is assembled authoritatively from the bill (incl. tip);
 *      a delivery request is recorded (auditable), not silently "sent".
 *   3. AI assistant is advisory: answers from the authoritative snapshot,
 *      permission-gated, audited, and makes NO mutations.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-rai-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';
import { localAnswer, buildSnapshot } from '../main/core/ai';

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
const now = () => new Date().toISOString();

async function run() {
  console.log('Testing Reports / Digital Receipts / AI...');

  initDatabase();
  const db = getDatabase();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('currency','GBP') ON CONFLICT(key) DO UPDATE SET value='GBP'`).run();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('business_name','Test Cafe') ON CONFLICT(key) DO UPDATE SET value='Test Cafe'`).run();
  const bcrypt = require('bcryptjs');
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active) VALUES ('u-own','Owner','own@rai.local',?, 'owner',1)`).run(bcrypt.hashSync('OwnerPass123!', 10));
  // Cashier lacks reports.view by default → AI should be forbidden for them.
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active) VALUES ('u-cash','Cash','cash@rai.local',?, 'cashier',1)`).run(bcrypt.hashSync('CashPass123!', 10));
  db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES ('cat','C',1,1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p-latte','cat','Latte',10,1,1,1,1,3,5,?,?)`).run(now(), now()); // stock 3 < threshold 5 → low

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  const login = async (e: string, p: string) => (await request(base).post('/api/auth/login').send({ email: e, password: p })).body.access_token;
  try {
    const owner = await login('own@rai.local', 'OwnerPass123!');
    const cashier = await login('cash@rai.local', 'CashPass123!');
    const own = (r: any) => r.set('Authorization', `Bearer ${owner}`);
    const cash = (r: any) => r.set('Authorization', `Bearer ${cashier}`);

    // A paid order with a cash tip → drives reports + receipt + snapshot.
    const order = (await own(request(base).post('/api/orders')).set('Idempotency-Key', 'o1')
      .send({ type: 'takeaway', items: [{ product_id: 'p-latte', quantity: 2 }] })).body.order;
    const bill = (await own(request(base).post('/api/bills/generate')).send({ order_id: order.id })).body.bill
      || (await own(request(base).get(`/api/bills/order/${order.id}`))).body.bill;
    await own(request(base).post(`/api/bills/${bill.id}/payment`)).set('Idempotency-Key', 'pay1')
      .send({ method: 'cash', amount: 20, tip: 3, tendered: 25 });

    // 1. Reports authoritative.
    const summary = await own(request(base).get('/api/reports/summary'));
    assert(summary.status === 200, 'reports summary responds');

    // 2. Digital receipt authoritative (incl. tip) + delivery recorded.
    const rec = await own(request(base).get(`/api/bills/${bill.id}/receipt`));
    assert(rec.status === 200, 'digital receipt responds');
    const receipt = rec.body.receipt;
    assert(receipt.items.length === 1 && receipt.items[0].quantity === 2, 'receipt lists the authoritative items');
    assert(Math.abs(receipt.total - 20) < 0.01 && Math.abs(receipt.tip - 3) < 0.01, `receipt carries authoritative total + tip (got total ${receipt.total}, tip ${receipt.tip})`);
    assert(typeof receipt.text === 'string' && receipt.text.includes('Test Cafe'), 'receipt renders text');
    const deliver = await own(request(base).post(`/api/bills/${bill.id}/receipt/deliver`)).send({ channel: 'email', destination: 'a@x.com' });
    assert(deliver.status === 201 && deliver.body.delivery.status === 'recorded', 'delivery request recorded');
    const logged = db.prepare(`SELECT * FROM receipt_deliveries WHERE bill_id = ?`).get(bill.id) as any;
    assert(logged && logged.channel === 'email' && logged.destination === 'a@x.com', 'delivery persisted to the log');

    // 3. AI advisory: authoritative, permission-gated, audited, no mutation.
    assert((await cash(request(base).post('/api/ai/ask')).send({ question: 'sales today?' })).status === 403, 'cashier without reports.view is forbidden from AI');
    const ordersBefore = (db.prepare(`SELECT COUNT(*) AS n FROM orders`).get() as any).n;
    const auditBefore = (db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE event_type='ai.query'`).get() as any).n;

    const salesAns = await own(request(base).post('/api/ai/ask')).send({ question: 'How much in sales today?' });
    assert(salesAns.status === 200 && salesAns.body.source === 'local', 'AI answers locally (no API key)');
    assert(/20\.00/.test(salesAns.body.answer) && /order/i.test(salesAns.body.answer), `AI answer uses authoritative figures (got: ${salesAns.body.answer})`);

    const lowAns = await own(request(base).post('/api/ai/ask')).send({ question: 'what is running low?' });
    assert(/Latte/.test(lowAns.body.answer), 'AI reports the authoritative low-stock item');

    const ordersAfter = (db.prepare(`SELECT COUNT(*) AS n FROM orders`).get() as any).n;
    const auditAfter = (db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE event_type='ai.query'`).get() as any).n;
    assert(ordersAfter === ordersBefore, 'AI made no mutations (order count unchanged)');
    assert(auditAfter >= auditBefore + 2, 'each AI query is audited');

    // Pure snapshot + localAnswer sanity.
    const snap = buildSnapshot();
    assert(snap.today.orders >= 1 && /order/i.test(localAnswer('orders today', snap)), 'buildSnapshot + localAnswer authoritative');

    console.log('✅ Reports / Digital Receipts / AI tests passed');
  } finally {
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
