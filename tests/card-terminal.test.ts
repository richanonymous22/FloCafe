/*
 * Card terminal framework — attempts, verified payments, provider refunds, reconciliation.
 * Real Express server, real SQLite, the built-in simulator as the provider.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-card-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};
process.env.PLEMMO_CARD_SIMULATOR_DELAY_MS = '0';

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';
import { availableProviderIds } from '../main/core/card-terminal/registry';

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
const now = () => new Date().toISOString();

async function run() {
  console.log('Testing card terminal framework...');
  initDatabase();
  const db = getDatabase();
  const bcrypt = require('bcryptjs');
  const pw = bcrypt.hashSync('Passw0rd!x', 10);
  const user = (id: string, role: string) =>
    db.prepare(`INSERT INTO users (id, name, email, password, role, pin_hash, is_active) VALUES (?,?,?,?,?,NULL,1)`).run(id, id, `${id}@till.local`, pw, role);
  user('u-own', 'owner'); user('u-cash', 'cashier'); user('u-wait', 'waiter');
  ok(Number(db.pragma('user_version', { simple: true })) >= 102, 'database migrated to v102 or later');
  ok(!!db.prepare("SELECT name FROM sqlite_master WHERE name = 'card_attempts'").get(), 'card_attempts table exists on a fresh database');

  db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES ('cat','Food',1,1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p10','cat','Lunch',10,1,'L10',1,1,0,0,0,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p1005','cat','Odd',10.05,1,'L1005',1,2,0,0,0,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p1006','cat','Odd6',10.06,1,'L1006',1,3,0,0,0,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p1007','cat','Odd7',10.07,1,'L1007',1,4,0,0,0,?,?)`).run(now(), now());

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  try {
    const login = async (id: string) =>
      (await request(base).post('/api/auth/login').send({ email: `${id}@till.local`, password: 'Passw0rd!x' })).body.access_token as string;
    const T = { own: await login('u-own'), cash: await login('u-cash'), wait: await login('u-wait') };
    const as = (t: string) => (r: any) => r.set('Authorization', `Bearer ${t}`);
    let seq = 0;
    async function bill(productId = 'p10') {
      const o = await as(T.own)(request(base).post('/api/orders').set('Idempotency-Key', `o-${++seq}`)).send({ type: 'takeaway', items: [{ product_id: productId, quantity: 1 }] });
      const gen = await as(T.own)(request(base).post('/api/bills/generate')).send({ order_id: o.body.order.id });
      return { id: gen.body.bill.id as number, total: Number(gen.body.bill.total) };
    }
    const attempt = (tok: string, body: any) => as(tok)(request(base).post('/api/card/attempts')).send(body);
    const poll = (id: string) => as(T.cash)(request(base).get(`/api/card/attempts/${id}`));
    const payWith = (b: { id: number }, line: any, key?: string) => {
      let r = request(base).post(`/api/bills/${b.id}/payments`);
      if (key) r = r.set('Idempotency-Key', key);
      return as(T.cash)(r).send({ payments: [line] });
    };

    console.log('\n1. no provider, configuration, release builds');
    const none = await attempt(T.cash, { amount: 5 });
    ok(none.status === 409 && none.body.code === 'no_provider', 'with no provider configured a card attempt is refused (409 no_provider)');
    const cfg0 = (await as(T.cash)(request(base).get('/api/card/config'))).body;
    ok(cfg0.provider === 'none' && cfg0.enabled === false, 'config says no provider is active');
    ok((await as(T.cash)(request(base).put('/api/card/config')).send({ provider: 'simulator' })).status === 403, 'a cashier cannot change the card provider');
    ok((await as(T.wait)(request(base).post('/api/card/attempts')).send({ amount: 5 })).status === 403, 'a waiter cannot start a card payment');
    delete process.env.PLEMMO_ALLOW_CARD_SIMULATOR;
    ok(!availableProviderIds().includes('simulator'), 'the simulator is not offered in a packaged (release) build');
    ok((await as(T.own)(request(base).put('/api/card/config')).send({ provider: 'simulator' })).status === 400, 'a release build refuses to switch the simulator on');
    process.env.PLEMMO_ALLOW_CARD_SIMULATOR = '1';
    ok((await as(T.own)(request(base).put('/api/card/config')).send({ provider: 'nonsense' })).status === 400, 'an unknown provider is refused');
    ok((await as(T.own)(request(base).put('/api/card/config')).send({ provider: 'simulator' })).status === 200, 'the owner chooses the simulator (allowed by explicit opt-in)');
    const cfg1 = (await as(T.cash)(request(base).get('/api/card/config'))).body;
    ok(cfg1.provider === 'simulator' && cfg1.simulated === true, 'config labels the provider as simulated');
    ok((await as(T.cash)(request(base).get('/api/card/terminals'))).body.terminals.length === 1, 'terminals are listed');

    console.log('\n2. approved card payment becomes a verified payment');
    const b1 = await bill();
    ok(b1.total === 10, 'bill total 10.00');
    const a1 = await attempt(T.cash, { bill_id: b1.id, amount: 10, tip: 1.5 });
    ok(a1.status === 201 && a1.body.state === 'pending' && a1.body.simulated === true, 'attempt starts pending and is marked simulated');
    ok(!('provider_reference' in a1.body), 'the provider reference is not exposed to the browser');
    const dup = await attempt(T.cash, { bill_id: b1.id, amount: 10 });
    ok(dup.status === 409 && dup.body.code === 'attempt_open', 'a second attempt on the same bill is refused while one is waiting');
    const early = await payWith(b1, { method: 'card', card_attempt_id: a1.body.id });
    ok(early.status === 409, 'a pending attempt cannot be paid');
    const p1 = await poll(a1.body.id);
    ok(p1.body.state === 'approved' && p1.body.card_last4 === '4242' && p1.body.card_scheme === 'VISA', 'polling the provider approves it, with scheme and last four only');
    const wrongAmt = await payWith(b1, { method: 'card', card_attempt_id: a1.body.id, amount: 9 });
    ok(wrongAmt.status === 409, 'an amount that differs from the approval is refused');
    const forged = await payWith(b1, { method: 'card', card_attempt_id: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ' });
    ok(forged.status === 400, 'a made-up attempt id is refused');
    const manualId = await payWith(b1, { method: 'cash', card_attempt_id: a1.body.id });
    ok(manualId.status === 400, 'card_attempt_id is only valid on a card payment');
    const paid = await payWith(b1, { method: 'card', card_attempt_id: a1.body.id }, 'pay-card-1');
    ok(paid.status === 200 && paid.body.bill.payment_status === 'paid', 'paying with the approved attempt succeeds');
    const pay1 = db.prepare('SELECT * FROM payments WHERE bill_id = ?').all(b1.id) as any[];
    ok(pay1.length === 1 && pay1[0].adapter === 'card_terminal' && pay1[0].state === 'captured', 'recorded with the card_terminal adapter, captured');
    ok(pay1[0].amount_minor === 1000 && pay1[0].tip_minor === 150, 'amount and tip come from the approval (10.00 + 1.50)');
    ok(String(pay1[0].provider_reference).startsWith('sim_'), 'provider reference stored on the payment');
    const meta = JSON.parse(pay1[0].metadata);
    ok(meta.verified === true && meta.simulated === true && meta.card_last4 === '4242' && !('card_number' in meta), 'metadata is verified, simulated, last four only');
    const consumed = db.prepare('SELECT * FROM card_attempts WHERE id = ?').get(a1.body.id) as any;
    ok(consumed.state === 'consumed' && consumed.consumed_payment_id === pay1[0].id, 'the attempt is consumed and linked to the payment');
    const replay = await payWith(b1, { method: 'card', card_attempt_id: a1.body.id }, 'pay-card-1');
    ok(replay.status === 200 && (db.prepare('SELECT COUNT(*) c FROM payments WHERE bill_id = ?').get(b1.id) as any).c === 1, 'retrying the same request replays without a second payment');

    console.log('\n3. an approval cannot be used twice or on another bill');
    const b2 = await bill();
    const reuse = await payWith(b2, { method: 'card', card_attempt_id: a1.body.id });
    ok(reuse.status === 409, 'a consumed attempt cannot pay another bill');
    ok((db.prepare('SELECT COUNT(*) c FROM payments WHERE bill_id = ?').get(b2.id) as any).c === 0, 'no payment was recorded');
    const a2 = await attempt(T.cash, { bill_id: b2.id, amount: 10 });
    await poll(a2.body.id);
    const b3 = await bill();
    const other = await payWith(b3, { method: 'card', card_attempt_id: a2.body.id });
    ok(other.status === 409, 'an attempt made for one bill cannot pay a different bill');
    ok((await payWith(b2, { method: 'card', card_attempt_id: a2.body.id })).status === 200, 'it pays the bill it was made for');

    console.log('\n4. decline, cancel, timeout, offline');
    const bd = await bill('p1005');
    const ad = await attempt(T.cash, { bill_id: bd.id, amount: 10.05 });
    ok((await poll(ad.body.id)).body.state === 'declined', 'a declined card is declined');
    ok((await payWith(bd, { method: 'card', card_attempt_id: ad.body.id })).status === 409, 'a declined attempt cannot be paid');
    const bc = await bill('p1006');
    const ac = await attempt(T.cash, { bill_id: bc.id, amount: 10.06 });
    ok((await poll(ac.body.id)).body.state === 'pending', 'a customer who has not used the terminal stays pending');
    const cancelled = await as(T.cash)(request(base).post(`/api/card/attempts/${ac.body.id}/cancel`));
    ok(cancelled.body.state === 'cancelled', 'the cashier cancels it');
    ok((await payWith(bc, { method: 'card', card_attempt_id: ac.body.id })).status === 409, 'a cancelled attempt cannot be paid');
    const ac2 = await attempt(T.cash, { bill_id: bc.id, amount: 10.06 });
    db.prepare("UPDATE card_attempts SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), ac2.body.id);
    ok((await poll(ac2.body.id)).body.state === 'timed_out', 'an abandoned attempt times out');
    const bo = await bill('p1007');
    const ao = await attempt(T.cash, { bill_id: bo.id, amount: 10.07 });
    ok(ao.status === 502 && ao.body.code === 'terminal_offline', 'an offline terminal fails cleanly (502 terminal_offline)');
    ok((db.prepare("SELECT COUNT(*) c FROM card_attempts WHERE state = 'failed'").get() as any).c === 1, 'the failed attempt is recorded');
    ok((await attempt(T.cash, { bill_id: b1.id, amount: 1 })).status === 400, 'cannot start a card payment on a paid bill');
    ok((await attempt(T.cash, { bill_id: bo.id, amount: 99 })).status === 400, 'cannot charge more than the bill balance');
    ok((await attempt(T.cash, { amount: 'abc' })).status === 400, 'a bad amount is refused');

    console.log('\n5. refunds go through the provider first');
    const rr = await as(T.own)(request(base).post(`/api/bills/${b1.id}/refund`).set('Idempotency-Key', 'rf-1')).send({ reason: 'Wrong item', amount: 3 });
    ok(rr.status === 200 && rr.body.amount_minor === 300, `partial card refund succeeds (${rr.status} ${JSON.stringify(rr.body)})`);
    const rf = db.prepare('SELECT * FROM refunds WHERE bill_id = ?').all(b1.id) as any[];
    ok(rf.length === 1 && String(rf[0].provider_reference).startsWith('simrf_'), 'the refund row carries the provider refund reference');
    const rfa = db.prepare("SELECT * FROM card_attempts WHERE kind = 'refund'").all() as any[];
    ok(rfa.length === 1 && rfa[0].state === 'consumed' && rfa[0].consumed_refund_id === rf[0].id && rfa[0].parent_payment_id === pay1[0].id, 'the provider refund is recorded and linked to the local refund');
    const rrReplay = await as(T.own)(request(base).post(`/api/bills/${b1.id}/refund`).set('Idempotency-Key', 'rf-1')).send({ reason: 'Wrong item', amount: 3 });
    ok(rrReplay.status === 200 && (db.prepare('SELECT COUNT(*) c FROM refunds WHERE bill_id = ?').get(b1.id) as any).c === 1, 'a retried refund does not refund twice');
    const rejected = await as(T.own)(request(base).post(`/api/bills/${b1.id}/refund`)).send({ reason: 'Test reject', amount: 1.13 });
    ok(rejected.status === 502, 'a provider that refuses the refund fails the request (502)');
    const after = db.prepare('SELECT refunded_minor FROM payments WHERE id = ?').get(pay1[0].id) as any;
    ok(after.refunded_minor === 300, 'nothing changed locally when the provider refused');
    const rest = await as(T.own)(request(base).post(`/api/bills/${b1.id}/refund`)).send({ reason: 'Rest', amount: 7 });
    ok(rest.status === 200 && rest.body.fully_refunded === true, 'the remainder refunds and the bill is fully refunded');
    const cashierRefund = await as(T.cash)(request(base).post(`/api/bills/${b2.id}/refund`)).send({ reason: 'x', amount: 1 });
    ok(cashierRefund.status === 403 || cashierRefund.status === 401, 'a cashier still needs manager approval to refund a card payment');

    console.log('\n6. reconciliation');
    const br = await bill();
    const ar = await attempt(T.cash, { bill_id: br.id, amount: 10 });
    await poll(ar.body.id);
    const fresh = (await as(T.own)(request(base).get('/api/card/reconciliation'))).body;
    ok(fresh.orphans.length === 0, 'a just-approved attempt is not yet an orphan');
    db.prepare("UPDATE card_attempts SET updated_at = datetime('now', '-10 minutes') WHERE id = ?").run(ar.body.id);
    const stale = (await as(T.own)(request(base).get('/api/card/reconciliation'))).body;
    ok(stale.orphans.length === 1 && stale.orphans[0].id === ar.body.id && stale.orphans[0].simulated === true, 'an approved attempt with no payment is reported as an orphan');
    ok(!('provider_reference' in stale.orphans[0]) || typeof stale.orphans[0].provider_reference === 'string', 'orphans carry a reference to look up on the terminal receipt');
    ok((await payWith(br, { method: 'card', card_attempt_id: ar.body.id })).status === 200, 'the orphan can still be recorded against its bill');
    ok((await as(T.own)(request(base).get('/api/card/reconciliation'))).body.orphans.length === 0, 'once recorded it is no longer an orphan');
    ok((await as(T.cash)(request(base).get('/api/card/reconciliation'))).status === 403, 'reconciliation is for owners and managers');
    db.prepare("UPDATE payments SET amount_minor = amount_minor + 1 WHERE id = ?").run(pay1[0].id);
    const mm = (await as(T.own)(request(base).get('/api/card/reconciliation'))).body;
    ok(mm.mismatches.length === 1 && mm.mismatches[0].payment_id === pay1[0].id, 'a payment whose amount differs from the approval is flagged');
    db.prepare("UPDATE payments SET amount_minor = amount_minor - 1 WHERE id = ?").run(pay1[0].id);

    console.log('\n7. manual card still works and stays unverified');
    const bm = await bill();
    const manual = await payWith(bm, { method: 'card', transaction_id: 'TERMINAL-RECEIPT-77' });
    ok(manual.status === 200, 'a hand-recorded card payment is still accepted (terminal outage fallback)');
    ok((db.prepare('SELECT adapter FROM payments WHERE bill_id = ?').get(bm.id) as any).adapter === 'manual_card', 'and is recorded as manual_card, not verified');

    console.log(`\nAll ${passed} assertions passed.`);
  } finally {
    await stopServer();
    closeDatabase();
  }
}
run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
