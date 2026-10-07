/*
 * Till refund + void — backend integration (real Express server, real SQLite).
 *
 * Covers the production path Meridian now uses:
 *   POST /api/bills/:id/refund     (refund service → refundPayment → ledger/drawer/loyalty/audit)
 *   PATCH /api/orders/:id/status   (cancel an UNPAID order; a paid one must be refunded instead)
 *
 * Asserts the original sale/payment rows are preserved, money is never
 * refunded twice, permissions hold, and the audit trail is written.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-till-refund-'));
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
  console.log('Testing till refund + void (backend integration)...');
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

    // ── 1. Full cash refund by a manager, with stock return ────────────────
    console.log('\n1. successful refund (manager, cash, restock)');
    const s1 = await sell([{ product_id: 'p-track', quantity: 2 }], [{ method: 'cash', amount: 'ALL' }], 'c1');
    ok(stockOf() === 8, 'sale took 2 from the ledger (10 → 8)');
    const creditBefore = (db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM loyalty_ledger WHERE bill_id=? AND type='credit'`).get(s1.billId) as any).t;
    ok(creditBefore > 0, `cashback was earned on the sale (${creditBefore})`);
    const drawerBefore = (await drawerExpected()).session.expected_minor;
    const items1 = s1.orderItems.map((i: any) => ({ order_item_id: i.id, quantity: i.quantity }));
    const r1 = await refund(T.mgr, s1.billId, { reason: 'Customer changed mind', items: items1 }, 'rf-1');
    ok(r1.status === 200, `manager refund accepted (${r1.status} ${r1.body.error || ''})`);
    ok(r1.body.fully_refunded === true && r1.body.refundable_remaining_minor === 0, 'fully refunded, nothing left');
    ok(r1.body.amount_minor === Math.round(s1.total * 100), 'refunded the full sale amount in minor units');
    ok(stockOf() === 10, 'stock returned through the ledger (8 → 10)');
    ok(r1.body.restocked.length === 1 && r1.body.restocked[0].quantity === 2, 'response reports what was restocked');
    const refundRow = db.prepare(`SELECT * FROM refunds WHERE bill_id=?`).all(s1.billId) as any[];
    ok(refundRow.length === 1 && refundRow[0].actor_user_id === 'u-mgr', 'one immutable refund row, attributed to the approver');
    const pay1 = db.prepare(`SELECT * FROM payments WHERE bill_id=?`).get(s1.billId) as any;
    ok(pay1.amount_minor === Math.round(s1.total * 100) && pay1.refunded_minor === pay1.amount_minor && pay1.state === 'refunded',
      'original payment preserved (amount unchanged) and marked refunded');
    const billRow = db.prepare(`SELECT payment_status, total FROM bills WHERE id=?`).get(s1.billId) as any;
    ok(billRow.payment_status === 'paid' && Number(billRow.total) === s1.total, 'original bill is not rewritten');
    const drawerAfter = (await drawerExpected()).session.expected_minor;
    ok(drawerBefore - drawerAfter === Math.round(s1.total * 100), 'cash left the drawer (refund movement)');
    const mv = db.prepare(`SELECT type, amount_minor FROM cash_movements WHERE session_id=? AND type='refund'`).all(sessionId) as any[];
    ok(mv.length === 1 && mv[0].amount_minor === -Math.round(s1.total * 100), 'a signed refund movement was recorded');
    const debit = (db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM loyalty_ledger WHERE bill_id=? AND type='debit'`).get(s1.billId) as any).t;
    ok(debit === creditBefore, 'all earned cashback was reversed on a full refund');
    const audit = db.prepare(`SELECT * FROM audit_events WHERE event_type IN ('bill.refunded','sale.refunded') AND entity_id IN (?, ?)`).all(String(s1.billId), String(pay1.id)) as any[];
    ok(audit.some((a) => a.event_type === 'bill.refunded'), 'bill.refunded audit event written');
    ok(audit.some((a) => a.event_type === 'sale.refunded'), 'payment-level sale.refunded audit event written');
    const meta = JSON.parse(audit.find((a) => a.event_type === 'bill.refunded').metadata);
    ok(meta.requested_by === 'u-mgr' && meta.approved_by === 'u-mgr' && meta.reason === 'Customer changed mind', 'audit records requester, approver and reason');

    // ── 2. Duplicate refund: idempotent replay + balance guard ─────────────
    console.log('\n2. duplicate refund / idempotency');
    const replay = await refund(T.mgr, s1.billId, { reason: 'Customer changed mind', items: items1 }, 'rf-1');
    ok(replay.status === 200 && replay.body.idempotentReplay === true, 'same Idempotency-Key replays the stored result');
    ok((db.prepare(`SELECT COUNT(*) n FROM refunds WHERE bill_id=?`).all(s1.billId)[0] as any).n === 1, 'replay created no second refund');
    ok(stockOf() === 10, 'replay did not restock twice');
    const reuse = await refund(T.mgr, s1.billId, { reason: 'Different reason' }, 'rf-1');
    ok(reuse.status === 409, 'reusing a key for a different request is refused (409)');
    const again = await refund(T.mgr, s1.billId, { reason: 'Again, new key' }, 'rf-1b');
    ok(again.status === 400 && /Nothing left to refund/.test(again.body.error), 'a second refund with a new key is refused — already refunded');
    ok(stockOf() === 10 && (db.prepare(`SELECT COUNT(*) n FROM refunds WHERE bill_id=?`).all(s1.billId)[0] as any).n === 1, 'nothing changed');

    // ── 3. Partial refunds, over-refund, invalid input ─────────────────────
    console.log('\n3. partial refund, over-refund and invalid requests');
    const s3 = await sell([{ product_id: 'p-free', quantity: 5 }], [{ method: 'cash', amount: 'ALL' }], 'c1'); // £10.00
    const half = await refund(T.mgr, s3.billId, { amount: 4, reason: 'One wrong' }, 'rf-3a');
    ok(half.status === 200 && half.body.amount_minor === 400 && half.body.fully_refunded === false, 'partial refund of 4.00 accepted');
    ok(half.body.refundable_remaining_minor === 600, '6.00 still refundable');
    const pp = db.prepare(`SELECT state, refunded_minor FROM payments WHERE bill_id=?`).get(s3.billId) as any;
    ok(pp.refunded_minor === 400 && pp.state !== 'refunded', 'payment shows a partial refund, not a full one');
    const over = await refund(T.mgr, s3.billId, { amount: 6.01, reason: 'Too much' }, 'rf-3b');
    ok(over.status === 400 && /exceeds/.test(over.body.error), 'refund above the remaining balance is refused');
    const rest = await refund(T.mgr, s3.billId, { amount: 6, reason: 'Rest' }, 'rf-3c');
    ok(rest.status === 200 && rest.body.fully_refunded === true, 'the exact remainder completes the refund');
    const after = await refund(T.mgr, s3.billId, { amount: 0.01, reason: 'Penny' }, 'rf-3d');
    ok(after.status === 400, 'refund after the bill is already fully refunded is refused');
    const s3b = await sell([{ product_id: 'p-free', quantity: 1 }], [{ method: 'cash', amount: 'ALL' }]);
    for (const [label, body] of [
      ['no reason', { amount: 1 }],
      ['zero amount', { amount: 0, reason: 'x' }],
      ['negative amount', { amount: -3, reason: 'x' }],
      ['non-numeric amount', { amount: 'abc', reason: 'x' }],
      ['item not on this bill', { reason: 'x', items: [{ order_item_id: 999999, quantity: 1 }] }],
      ['bad quantity', { reason: 'x', items: [{ order_item_id: s3b.orderItems[0].id, quantity: 0 }] }],
      ['quantity above sold', { reason: 'x', items: [{ order_item_id: s3b.orderItems[0].id, quantity: 9 }] }],
    ] as [string, any][]) {
      const bad = await refund(T.mgr, s3b.billId, body);
      ok(bad.status === 400, `invalid refund rejected (${label}) → ${bad.status}`);
    }
    ok((await refund(T.mgr, 999999, { reason: 'x' })).status === 404, 'unknown bill → 404');
    ok((db.prepare(`SELECT COUNT(*) n FROM refunds WHERE bill_id=?`).all(s3b.billId)[0] as any).n === 0, 'rejected requests recorded nothing');
    // A refund on an unpaid bill has nothing to refund.
    const o4 = await as(T.own)(request(base).post('/api/orders')).send({ type: 'takeaway', items: [{ product_id: 'p-free', quantity: 1 }] });
    const gen4 = await as(T.own)(request(base).post('/api/bills/generate')).send({ order_id: o4.body.order.id });
    const unpaid = await refund(T.mgr, gen4.body.bill.id, { reason: 'x' });
    ok(unpaid.status === 400 && /Nothing left to refund/.test(unpaid.body.error), 'an unpaid bill cannot be refunded');

    // ── 4. Authorization ───────────────────────────────────────────────────
    console.log('\n4. authorization');
    resetApprovalRateLimits();
    const s4 = await sell([{ product_id: 'p-free', quantity: 2 }], [{ method: 'cash', amount: 'ALL' }]);
    const noAuth = await request(base).post(`/api/bills/${s4.billId}/refund`).send({ reason: 'x' });
    ok(noAuth.status === 401, 'unauthenticated refund → 401');
    const waiter = await refund(T.wait, s4.billId, { reason: 'x', override_pin: '2222' });
    ok(waiter.status === 403, 'a waiter cannot refund even with a manager PIN (role gate)');
    const cashNoPin = await refund(T.cash, s4.billId, { reason: 'x' });
    ok(cashNoPin.status === 403 && cashNoPin.body.requiresApproval === true, 'a cashier without a PIN is told approval is required');
    const cashBadPin = await refund(T.cash, s4.billId, { reason: 'x', override_pin: '9999' });
    ok(cashBadPin.status === 403 && /Invalid manager PIN/.test(cashBadPin.body.error), 'a wrong PIN is refused');
    const cashOwnPin = await refund(T.cash, s4.billId, { reason: 'x', override_pin: '3333' });
    ok(cashOwnPin.status === 403, "a cashier's own PIN is not a manager approval");
    ok((db.prepare(`SELECT COUNT(*) n FROM refunds WHERE bill_id=?`).all(s4.billId)[0] as any).n === 0, 'no refund was recorded by any refused attempt');
    const cashOk = await refund(T.cash, s4.billId, { reason: 'Approved at till', override_pin: '2222', amount: 1 }, 'rf-4');
    ok(cashOk.status === 200, 'a cashier with a manager PIN can refund');
    const rowA = db.prepare(`SELECT actor_user_id FROM refunds WHERE bill_id=?`).get(s4.billId) as any;
    ok(rowA.actor_user_id === 'u-mgr', 'the refund is attributed to the approving manager, not the cashier');
    const auditA = db.prepare(`SELECT metadata FROM audit_events WHERE event_type='bill.refunded' AND entity_id=?`).get(String(s4.billId)) as any;
    const mA = JSON.parse(auditA.metadata);
    ok(mA.requested_by === 'u-cash' && mA.approved_by === 'u-mgr', 'audit keeps both who asked and who approved');
    // PIN brute force is rate limited.
    resetApprovalRateLimits();
    let limited = 0;
    for (let i = 0; i < 7; i++) {
      const r = await refund(T.cash, s4.billId, { reason: 'x', override_pin: `900${i}` });
      if (r.status === 429) limited++;
    }
    ok(limited >= 1, 'repeated wrong PINs are rate limited (429)');
    resetApprovalRateLimits();

    // ── 5. Split tender: refund goes newest-first, wallet/cash effects ─────
    console.log('\n5. split tender');
    const s5 = await sell([{ product_id: 'p-free', quantity: 5 }], [{ method: 'cash', amount: 6 }, { method: 'card', amount: 4 }]); // £10.00
    const r5 = await refund(T.mgr, s5.billId, { amount: 5, reason: 'Split refund' }, 'rf-5');
    ok(r5.status === 200 && r5.body.refunds.length >= 1, 'split-tender refund accepted');
    const pays = db.prepare(`SELECT method, amount_minor, refunded_minor FROM payments WHERE bill_id=? ORDER BY requested_at`).all(s5.billId) as any[];
    ok(pays.reduce((s, p) => s + p.refunded_minor, 0) === 500, 'exactly 5.00 was refunded across the tenders');
    ok(pays.every((p) => p.amount_minor > 0), 'original tender amounts are untouched');

    // ── 6. Reads ───────────────────────────────────────────────────────────
    console.log('\n6. reads expose refund state');
    const hist = await as(T.mgr)(request(base).get(`/api/bills/${s5.billId}/refunds`));
    ok(hist.status === 200 && hist.body.refunded_minor === 500 && hist.body.refundable_minor === 500, 'GET /bills/:id/refunds reports refunded/refundable');
    const billRead = await as(T.mgr)(request(base).get(`/api/bills/${s5.billId}`));
    const details = billRead.body.bill.payment_details as any[];
    ok(details.every((d) => typeof d.payment_id === 'string') && details.some((d) => d.refunded_amount > 0), 'bill payment_details carry payment_id + refunded_amount');

    // ── 7. Void / cancel ───────────────────────────────────────────────────
    console.log('\n7. void (cancel an unpaid order)');
    const stockBefore = stockOf();
    const vo = await as(T.own)(request(base).post('/api/orders').set('Idempotency-Key', 'void-1')).send({ type: 'dine_in', items: [{ product_id: 'p-track', quantity: 3 }] });
    ok(vo.status === 201 && stockOf() === stockBefore - 3, 'unpaid order took 3 from stock');
    const cancel = await as(T.cash)(request(base).patch(`/api/orders/${vo.body.order.id}/status`)).send({ status: 'cancelled', reason: 'Guest left' });
    ok(cancel.status === 200 && cancel.body.order.status === 'cancelled', 'unpaid order cancelled');
    ok(stockOf() === stockBefore, 'stock went back through the ledger');
    ok((db.prepare(`SELECT stock_quantity q FROM products WHERE id='p-track'`).get() as any).q === stockBefore, 'legacy stock_quantity stays in step with the ledger');
    const ret = db.prepare(`SELECT COUNT(*) n FROM inventory_movements WHERE movement_type='return' AND reference_type='order_cancel' AND reference_id=?`).get(String(vo.body.order.id)) as any;
    ok(ret.n === 1, 'one ledger return movement recorded for the cancellation');
    const order = db.prepare(`SELECT status, cancellation_reason FROM orders WHERE id=?`).get(vo.body.order.id) as any;
    ok(order.status === 'cancelled' && order.cancellation_reason === 'Guest left', 'order row keeps its history (status + reason), not deleted');
    ok((db.prepare(`SELECT COUNT(*) n FROM order_items WHERE order_id=?`).get(vo.body.order.id) as any).n === 1, 'order lines are preserved');
    const voidAudit = db.prepare(`SELECT metadata FROM audit_events WHERE event_type='sale.voided' AND entity_id=?`).get(String(vo.body.order.id)) as any;
    ok(!!voidAudit && JSON.parse(voidAudit.metadata).reason === 'Guest left', 'sale.voided audit event written with the reason');
    const cancelAgain = await as(T.cash)(request(base).patch(`/api/orders/${vo.body.order.id}/status`)).send({ status: 'cancelled' });
    ok(stockOf() === stockBefore, 'cancelling twice does not restock twice');
    void cancelAgain;
    // A paid order is not cancelled — it must be refunded.
    const paidCancel = await as(T.mgr)(request(base).patch(`/api/orders/${s3b.orderId}/status`)).send({ status: 'cancelled' });
    ok(paidCancel.status === 409 && paidCancel.body.code === 'order_has_payments', 'an order with a payment cannot be cancelled (409, use refund)');
    ok((db.prepare(`SELECT status FROM orders WHERE id=?`).get(s3b.orderId) as any).status !== 'cancelled', 'the paid order was left alone');

    console.log(`\n✅ Till refund + void backend tests passed (${passed} checks)`);
  } finally {
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
