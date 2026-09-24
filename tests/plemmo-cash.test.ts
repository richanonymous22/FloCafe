/*
 * Payments + Cash phase — backend verification.
 *
 * Covers the new authoritative capabilities added for the Meridian integration:
 *   - tips/gratuity persisted on payments (via the bills payment route)
 *   - cash drawer sessions: open (float / denomination), movements
 *     (pay-in/pay-out/no-sale/drop), cash sales auto-recorded from payments,
 *     close with expected-vs-counted variance
 *   - denomination counting, idempotency, authorization, and financial edges.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cash-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';
import { denominationTotal } from '../main/core/cash';

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
const now = () => new Date().toISOString();

async function run() {
  console.log('Testing Payments + Cash (tips, drawer sessions, denomination)...');

  // Pure unit: denomination totals.
  assert(denominationTotal({ '500': 3, '100': 10, '5': 4 }) === 3 * 500 + 10 * 100 + 4 * 5, 'denominationTotal sums value*qty');
  assert(denominationTotal({}) === 0 && denominationTotal(null) === 0, 'denominationTotal handles empty/null');

  initDatabase();
  const db = getDatabase();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('currency', 'GBP') ON CONFLICT(key) DO UPDATE SET value='GBP'`).run();
  const bcrypt = require('bcryptjs');
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active) VALUES ('u-own','Owner','own@cash.local',?, 'owner',1)`).run(bcrypt.hashSync('OwnerPass123!', 10));
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active) VALUES ('u-cash','Cash','cash@cash.local',?, 'cashier',1)`).run(bcrypt.hashSync('CashPass123!', 10));
  // Minimal catalogue + an order/bill to pay.
  db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES ('cat','Coffee',1,1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p-latte','cat','Latte',10,1,1,1,0,0,0,?,?)`).run(now(), now());

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  const login = async (email: string, pw: string) => (await request(base).post('/api/auth/login').send({ email, password: pw })).body.access_token;
  try {
    const owner = await login('own@cash.local', 'OwnerPass123!');
    const cashier = await login('cash@cash.local', 'CashPass123!');
    const A = (t: string) => (r: any) => r.set('Authorization', `Bearer ${t}`);
    const own = A(owner); const cash = A(cashier);

    // --- Authorization: no token → 401 ---
    assert((await request(base).get('/api/cash/session')).status === 401, 'cash session requires auth');

    // --- Open a drawer with a denomination count (£150.00 float) ---
    const openRes = await own(request(base).post('/api/cash/session/open'))
      .set('Idempotency-Key', 'open-1')
      .send({ opening_counts: { '5000': 2, '2000': 2, '1000': 1 } }); // 2*50 + 2*20 + 1*10 = £150
    assert(openRes.status === 201, 'open session 201');
    const session = openRes.body.session;
    assert(session.opening_float_minor === 15000, `float from denomination count (got ${session.opening_float_minor})`);
    assert(session.status === 'open', 'session open');

    // Idempotent open replay → same session, and a second real open is rejected.
    const openReplay = await own(request(base).post('/api/cash/session/open')).set('Idempotency-Key', 'open-1').send({ opening_counts: { '5000': 2, '2000': 2, '1000': 1 } });
    assert(openReplay.body.session.id === session.id, 'idempotent open replay returns same session');
    const openDup = await own(request(base).post('/api/cash/session/open')).send({ opening_float_minor: 100 });
    assert(openDup.status === 409, 'second open session rejected (409)');

    // --- Movements: pay-in £20, pay-out £5, no-sale ---
    assert((await cash(request(base).post(`/api/cash/session/${session.id}/movement`)).send({ type: 'pay_in', amount_minor: 2000, reason: 'change fund' })).status === 201, 'pay_in ok');
    assert((await cash(request(base).post(`/api/cash/session/${session.id}/movement`)).send({ type: 'pay_out', amount_minor: 500, reason: 'milk' })).status === 201, 'pay_out ok');
    assert((await cash(request(base).post(`/api/cash/session/${session.id}/movement`)).send({ type: 'no_sale', amount_minor: 0 })).status === 201, 'no_sale ok');
    // Invalid: no_sale with amount, negative amount.
    assert((await cash(request(base).post(`/api/cash/session/${session.id}/movement`)).send({ type: 'no_sale', amount_minor: 100 })).status === 400, 'no_sale with amount rejected');
    assert((await cash(request(base).post(`/api/cash/session/${session.id}/movement`)).send({ type: 'pay_in', amount_minor: -5 })).status === 400, 'negative movement rejected');

    // --- A cash sale with a tip flows into the drawer + persists tip ---
    const order = (await own(request(base).post('/api/orders')).set('Idempotency-Key', 'ord-1')
      .send({ type: 'takeaway', items: [{ product_id: 'p-latte', quantity: 1 }] })).body.order;
    const bill = (await own(request(base).post('/api/bills/generate')).send({ order_id: order.id })).body.bill
      || (await own(request(base).get(`/api/bills/order/${order.id}`))).body.bill;
    assert(!!bill, 'bill generated for order');
    const payRes = await own(request(base).post(`/api/bills/${bill.id}/payment`)).set('Idempotency-Key', 'pay-1')
      .send({ method: 'cash', amount: 10, tip: 2, tendered: 15 });
    assert(payRes.status === 200, 'cash payment accepted');
    const paidPayment = db.prepare(`SELECT tip_minor, amount_minor, method FROM payments WHERE method='cash' ORDER BY created_at DESC LIMIT 1`).get() as any;
    assert(paidPayment && paidPayment.tip_minor === 200, `tip persisted on payment (got ${paidPayment && paidPayment.tip_minor})`);

    // Drawer expected now = 15000 float + 2000 pay_in - 500 pay_out + 1000 sale + 200 tip = 17700
    const sessAfter = (await own(request(base).get(`/api/cash/session/${session.id}`))).body.session;
    assert(sessAfter.live_expected_minor === 17700, `expected reflects float+movements+cash sale+tip (got ${sessAfter.live_expected_minor})`);

    // --- Close with a count that is £2.00 short → variance -200 ---
    const closeRes = await own(request(base).post(`/api/cash/session/${session.id}/close`)).set('Idempotency-Key', 'close-1')
      .send({ counted_minor: 17500 });
    assert(closeRes.status === 200, 'close 200');
    assert(closeRes.body.expectedMinor === 17700 && closeRes.body.countedMinor === 17500 && closeRes.body.varianceMinor === -200,
      `variance computed (${JSON.stringify({ e: closeRes.body.expectedMinor, c: closeRes.body.countedMinor, v: closeRes.body.varianceMinor })})`);

    // Movement on a closed session is rejected; a fresh open is now allowed.
    assert((await cash(request(base).post(`/api/cash/session/${session.id}/movement`)).send({ type: 'pay_in', amount_minor: 100 })).status === 409, 'movement on closed session rejected');
    assert((await own(request(base).post('/api/cash/session/open')).send({ opening_float_minor: 5000 })).status === 201, 'can open a new session after close');

    // Cashier cannot close (manager+ only).
    const open2 = getDatabase().prepare(`SELECT id FROM cash_sessions WHERE status='open'`).get() as any;
    assert((await cash(request(base).post(`/api/cash/session/${open2.id}/close`)).send({ counted_minor: 5000 })).status === 403, 'cashier cannot close a session');

    console.log('✅ Payments + Cash tests passed');
  } finally {
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
