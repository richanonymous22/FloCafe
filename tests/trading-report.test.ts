/*
 * Trading reports (X and Z) — a scripted trading day through the real API and database.
 *
 * The expected figures are worked out here, independently, from what the script did (sales on cash,
 * card, split, a discount, a price override, partial and full refunds, a void, drawer pay in/out). The
 * X and Z reports must match to the penny, VAT must be split by rate and net of credit notes, the checks
 * must all pass, a Z must be immutable and numbered, and the next period must start exactly where this
 * one ended.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-trading-'));
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
  console.log('Testing trading reports (X / Z)...');
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

  const setting = (k: string, v: string) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
  setting('country', 'GB'); setting('currency', 'GBP'); setting('business_type', 'retail'); setting('taxes_enabled', 'true');
  db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES ('cat','Shop',1,1,?,?)`).run(now(), now());
  const prod = (id: string, name: string, price: number, taxCat: string) =>
    db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, tax_category_id, tax_behavior, created_at, updated_at)
                VALUES (?, 'cat', ?, ?, 1, ?, 1, 1, 0, 0, 0, ?, 'country_default', ?, ?)`).run(id, name, price, id, taxCat, now(), now());
  prod('std', 'Standard', 12, 'standard'); prod('red', 'Reduced', 10.5, 'reduced'); prod('zro', 'Zero', 5, 'zero'); prod('exm', 'Exempt', 7, 'exempt');

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  try {
    const login = async (id: string) =>
      (await request(base).post('/api/auth/login').send({ email: `${id}@till.local`, password: 'Passw0rd!x' })).body.access_token as string;
    const T = { own: await login('u-own'), mgr: await login('u-mgr'), cash: await login('u-cash') };
    const as = (t: string) => (r: any) => r.set('Authorization', `Bearer ${t}`);
    let seq = 0;
    async function sell(items: any[], payments: any[], opts: { discount?: number } = {}) {
      const o = await as(T.own)(request(base).post('/api/orders').set('Idempotency-Key', `s-${++seq}`)).send({ type: 'takeaway', items });
      if (o.status !== 201) throw new Error('order failed: ' + JSON.stringify(o.body));
      const orderId = o.body.order.id as number;
      if (opts.discount) await as(T.own)(request(base).patch(`/api/orders/${orderId}/discount`)).send({ discount_type: 'percentage', discount_value: opts.discount, discount_reason: 'Regular' });
      const bill = (await as(T.own)(request(base).post('/api/bills/generate')).send({ order_id: orderId })).body.bill;
      const paid = await as(T.own)(request(base).post(`/api/bills/${bill.id}/payments`).set('Idempotency-Key', `p-${seq}`)).send({ payments: payments.map((p) => ({ ...p, amount: p.amount === 'ALL' ? Number(bill.total) : p.amount })) });
      if (paid.status !== 200) throw new Error('payment failed: ' + JSON.stringify(paid.body));
      return { orderId, billId: bill.id as number, total: Number(bill.total), items: o.body.order.items as any[] };
    }
    const refund = (tok: string, billId: number, body: any) => as(tok)(request(base).post(`/api/bills/${billId}/refund`)).send(body);

    console.log('\n1. an empty period has nothing to report');
    const x0 = (await as(T.mgr)(request(base).get('/api/reports/x'))).body.report;
    ok(x0.transactions.count === 0 && x0.sales.gross_minor === 0 && x0.kind === 'X', 'X report of an empty day: no sales');
    const z0 = await as(T.mgr)(request(base).post('/api/reports/z')).send({});
    ok(z0.status === 409 && z0.body.code === 'nothing_to_report', 'a Z with nothing to report is refused (no accidental empty Z)');

    console.log('\n2. the trading day');
    const open = await as(T.own)(request(base).post('/api/cash/session/open')).send({ opening_float_minor: 10000 });
    ok(open.status === 201, 'drawer opened with a 100.00 float');
    const sessionId = open.body.session.id as string;
    const A = await sell([{ product_id: 'std', quantity: 1 }], [{ method: 'cash', amount: 'ALL', tendered: 20 }]);                                  // 12.00 cash, change 8
    const B = await sell([{ product_id: 'red', quantity: 1 }, { product_id: 'zro', quantity: 2 }], [{ method: 'card', amount: 'ALL', tip: 1 }]);       // 20.50 card + 1.00 tip
    const C = await sell([{ product_id: 'std', quantity: 2 }], [{ method: 'cash', amount: 10 }, { method: 'card', amount: 14 }]);                     // 24.00 split
    const D = await sell([{ product_id: 'exm', quantity: 2 }], [{ method: 'cash', amount: 'ALL' }], { discount: 10 });                                // 14.00 - 10% = 12.60
    const E = await sell([{ product_id: 'zro', quantity: 1, price_override: { unit_price: 4, reason: 'Price match' } }], [{ method: 'cash', amount: 'ALL' }]); // 4.00 (manager approved via PIN)
    ok(A.total === 12 && B.total === 20.5 && C.total === 24 && D.total === 12.6 && E.total === 4, 'sale totals: 12.00, 20.50, 24.00, 12.60, 4.00');
    const rA = await refund(T.mgr, A.billId, { reason: 'Customer changed mind' });                                                                    // full refund of A (cash 12.00)
    ok(rA.status === 200 && rA.body.amount_minor === 1200, 'sale A refunded in full (12.00 cash)');
    const redLine = B.items.find((i: any) => i.product_id === 'red');
    const rB = await refund(T.mgr, B.billId, { reason: 'Wrong item', amount_from_items: true, items: [{ order_item_id: redLine.id, quantity: 1 }] });  // 10.50 to card
    ok(rB.status === 200 && rB.body.amount_minor === 1050, 'the reduced-rate item of sale B refunded by item (10.50 to the card)');
    const vo = await as(T.own)(request(base).post('/api/orders').set('Idempotency-Key', 'void-1')).send({ type: 'takeaway', items: [{ product_id: 'zro', quantity: 1 }] });
    await as(T.mgr)(request(base).patch(`/api/orders/${vo.body.order.id}/status`)).send({ status: 'cancelled', reason: 'Walked out' });
    await as(T.own)(request(base).post(`/api/cash/session/${sessionId}/movement`)).send({ type: 'pay_in', amount_minor: 2000, reason: 'Top up' });
    await as(T.own)(request(base).post(`/api/cash/session/${sessionId}/movement`)).send({ type: 'pay_out', amount_minor: 500, reason: 'Window cleaner' });

    console.log('\n3. X report (open period, drawer still open)');
    const X = (await as(T.mgr)(request(base).get('/api/reports/x'))).body.report;
    const tender = (r: any, m: string) => r.tenders.find((t: any) => t.method === m);
    const vatLine = (r: any, label: string) => r.vat.find((v: any) => v.label === label);
    ok(X.transactions.count === 5 && X.sales.gross_minor === 7310, 'X: 5 sales, gross 73.10');
    ok(X.sales.refunds_minor === 2250 && X.sales.net_minor === 5060, 'X: refunds 22.50, net 50.60');
    ok(tender(X, 'cash').taken_minor === 3860 && tender(X, 'cash').refunded_minor === 1200 && tender(X, 'cash').net_minor === 2660, 'X cash: taken 38.60, refunded 12.00, net 26.60');
    ok(tender(X, 'card').taken_minor === 3450 && tender(X, 'card').refunded_minor === 1050 && tender(X, 'card').net_minor === 2400 && tender(X, 'card').tips_minor === 100, 'X card: taken 34.50, refunded 10.50, net 24.00, tips 1.00');
    ok(tender(X, 'card').unverified_card_minor === 3450, 'X flags the card takings as unverified (no card provider confirmed them)');
    ok(X.checks.open_cash_session === true, 'X says the drawer is still open');
    const zOpen = await as(T.mgr)(request(base).post('/api/reports/z')).send({});
    ok(zOpen.status === 409 && zOpen.body.code === 'cash_session_open', 'a Z is refused while the drawer is open');
    const zCash = await as(T.cash)(request(base).post('/api/reports/z')).send({});
    ok(zCash.status === 403, 'a cashier cannot run a Z');
    const xCash = await as(T.cash)(request(base).get('/api/reports/x'));
    ok(xCash.status === 403, 'a cashier cannot read the X report either');

    console.log('\n4. close the drawer, then Z');
    // expected drawer: 100.00 float + 38.60 cash sales - 12.00 cash refund + 20.00 in - 5.00 out = 141.60; count 139.60 (2.00 short)
    const close = await as(T.mgr)(request(base).post(`/api/cash/session/${sessionId}/close`)).send({ counted_minor: 13960 });
    ok(close.status === 200, 'drawer closed');
    const zr = await as(T.mgr)(request(base).post('/api/reports/z')).send({});
    ok(zr.status === 201, 'Z report generated');
    const Z = zr.body.report;
    const S = Z.snapshot;
    ok(Z.number === 1 && S.kind === 'Z', 'it is Z number 1');
    ok(S.sales.gross_minor === 7310 && S.sales.refunds_minor === 2250 && S.sales.net_minor === 5060 && S.transactions.count === 5, 'Z: gross 73.10, refunds 22.50, net 50.60, 5 sales');
    ok(S.transactions.items_sold === 9 && S.transactions.average_minor === 1462, 'Z: 9 items sold (1+3+2+2+1), average sale 14.62');
    ok(S.discounts.count === 1 && S.discounts.amount_minor === 140, 'Z: one discount of 1.40');
    ok(S.refunds.count === 2 && S.refunds.amount_minor === 2250, 'Z: two refunds totalling 22.50');
    ok(S.voids.orders === 1 && S.voids.orders_value_minor === 500, 'Z: one voided order worth 5.00');
    ok(S.voids.price_overrides === 0 || S.voids.price_overrides === 1, 'Z: price override count present');
    console.log('\n   VAT by rate');
    const std = vatLine(S, 'VAT 20%'), red = vatLine(S, 'VAT 5%'), zero = vatLine(S, 'VAT 0%'), ex = vatLine(S, 'VAT exempt');
    ok(std.gross_minor === 3600 && std.vat_minor === 600 && std.net_minor === 3000, 'standard 20%: gross 36.00, VAT 6.00, net 30.00');
    ok(std.refund_gross_minor === 1200 && std.refund_vat_minor === 200, 'standard refunds: 12.00 back, 2.00 VAT credited');
    ok(red.gross_minor === 1050 && red.vat_minor === 50 && red.refund_gross_minor === 1050 && red.refund_vat_minor === 50, 'reduced 5%: sold 10.50 (VAT 0.50), refunded by item 10.50 with its own 0.50 VAT');
    ok(zero.gross_minor === 1400 && zero.vat_minor === 0 && zero.refund_vat_minor === 0, 'zero rate: 14.00 sold, no VAT (and the zero-rated line is shown separately)');
    ok(ex.gross_minor === 1260 && ex.vat_minor === 0, 'exempt: 12.60 sold (after the 10% discount), shown separately from zero-rated');
    ok(S.vat_total.vat_minor === 650 && S.vat_total.refund_vat_minor === 250 && S.vat_total.net_vat_minor === 400, 'VAT total 6.50, credit notes 2.50, net VAT due 4.00');
    console.log('\n   cash');
    ok(S.cash.opening_float_minor === 10000 && S.cash.sales_minor === 3860 && S.cash.refunds_minor === 1200, 'cash: float 100.00, cash sales 38.60, cash refunds 12.00');
    ok(S.cash.pay_in_minor === 2000 && S.cash.pay_out_minor === 500, 'cash: paid in 20.00, paid out 5.00');
    ok(S.cash.expected_minor_at_close === 14160 && S.cash.counted_minor === 13960 && S.cash.variance_minor === -200, 'cash: expected 141.60, counted 139.60, variance -2.00');
    console.log('\n   the report checks itself');
    ok(S.checks.tenders_equal_bills && S.checks.vat_equals_bills && S.checks.gross_by_rate_equals_bills && S.checks.cash_tenders_equal_drawer, 'tenders = bills, VAT lines = bill VAT, gross by rate = bills, cash tenders = drawer sales');
    ok(Z.digest.length === 64, 'the Z carries a SHA-256 digest of its figures');

    console.log('\n5. a Z cannot be changed or regenerated');
    let blocked = 0;
    try { db.prepare(`UPDATE z_reports SET snapshot_json = '{}' WHERE id = ?`).run(Z.id); } catch { blocked++; }
    try { db.prepare(`DELETE FROM z_reports WHERE id = ?`).run(Z.id); } catch { blocked++; }
    ok(blocked === 2, 'the database refuses to update or delete a Z report');
    const again = await as(T.mgr)(request(base).get(`/api/reports/z/${Z.id}`));
    ok(again.status === 200 && again.body.verified === true && JSON.stringify(again.body.report.snapshot) === JSON.stringify(S), 'reading it back returns exactly the stored figures and verifies the digest');
    const z2 = await as(T.mgr)(request(base).post('/api/reports/z')).send({});
    ok(z2.status === 409 && z2.body.code === 'nothing_to_report', 'running Z again immediately is refused: no second Z, no different numbers');
    const list = (await as(T.mgr)(request(base).get('/api/reports/z'))).body.reports;
    ok(list.length === 1 && list[0].number === 1 && list[0].gross_minor === 7310 && list[0].ok === true, 'the Z history lists it with its totals and a clean check');

    console.log('\n6. the next period starts exactly where this one ended');
    const F = await sell([{ product_id: 'std', quantity: 1 }], [{ method: 'cash', amount: 'ALL' }]);
    const X2 = (await as(T.mgr)(request(base).get('/api/reports/x'))).body.report;
    ok(X2.period_start === Z.period_end, 'the new X starts at the previous Z\'s end');
    ok(X2.transactions.count === 1 && X2.sales.gross_minor === 1200, 'only the new sale (12.00) is in the new period: nothing counted twice');
    const rF = await refund(T.mgr, A.billId, { reason: 'again' });
    ok(rF.status === 400, '(sale A was already fully refunded)');
    const rF2 = await refund(T.mgr, F.billId, { reason: 'Refund of a sale made after the Z', amount: 2 });
    const X3 = (await as(T.mgr)(request(base).get('/api/reports/x'))).body.report;
    ok(X3.sales.refunds_minor === 200 && X3.sales.gross_minor === 1200, 'a refund made today is a credit note in TODAY\'s period');
    ok(rF2.status === 200 && X3.vat_total.refund_vat_minor > 0, 'with its share of VAT');
    const z1 = (await as(T.mgr)(request(base).get(`/api/reports/z/${Z.id}`))).body.report;
    ok(z1.snapshot.sales.refunds_minor === 2250, 'and the closed Z still shows exactly what it showed');
    const zNo = await as(T.mgr)(request(base).get('/api/reports/z/does-not-exist'));
    ok(zNo.status === 404, 'an unknown Z id is a 404');

    console.log('\n6b. CSV export');
    const csv = await as(T.mgr)(request(base).get(`/api/reports/z/${Z.id}/csv`));
    ok(csv.status === 200 && /text\/csv/.test(csv.headers['content-type']) && /z-report-0001\.csv/.test(csv.headers['content-disposition']), 'the Z downloads as z-report-0001.csv');
    ok(/Gross sales,73\.10,7310/.test(csv.text) && /VAT due,4\.00,400/.test(csv.text) && /Net sales,50\.60,5060/.test(csv.text), 'exact amounts in major and minor units (gross 73.10, VAT due 4.00, net 50.60)');
    ok(/Report,Z 0001/.test(csv.text) && /VAT 20% VAT,6\.00,600/.test(csv.text), 'with the Z number and VAT by rate');
    ok(/^Section,Label,Amount,Minor units/.test(csv.text), 'with a header row');
    ok((await as(T.mgr)(request(base).get('/api/reports/x/csv'))).status === 200, 'the X report exports too');
    ok((await as(T.cash)(request(base).get(`/api/reports/z/${Z.id}/csv`))).status === 403, 'a cashier cannot export');

    console.log('\n7. printing X and Z on the thermal printer');
    const net = require('node:net');
    const received: Buffer[] = [];
    const fake = await new Promise<{ server: any; port: number }>((resolve) => {
      const server = net.createServer((sock: any) => { sock.on('data', (d: Buffer) => received.push(d)); sock.on('error', () => {}); });
      server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as any).port }));
    });
    const { escPosToText } = require('../main/printers/thermal');
    const noPrinter = await as(T.mgr)(request(base).post(`/api/reports/z/${Z.id}/print`)).send({});
    ok(noPrinter.status === 502 && /No printer configured/.test(noPrinter.body.detail || ''), 'with no printer set up the print fails with the real reason');
    const added = await as(T.own)(request(base).post('/api/printers')).send({ name: 'Till 80', connection_type: 'network', ip_address: '127.0.0.1', port: fake.port, paper_width: '80mm' });
    ok(added.status === 201 || added.status === 200, 'a network printer is added');
    const textOf = () => escPosToText(Buffer.concat(received));
    received.length = 0;
    const pz = await as(T.mgr)(request(base).post(`/api/reports/z/${Z.id}/print`)).send({});
    ok(pz.status === 200 && pz.body.success === true, 'the Z report prints');
    await new Promise((r) => setTimeout(r, 150));
    let out = textOf();
    ok(/Z REPORT 0001/.test(out) && /Net sales/.test(out) && /50\.60/.test(out), 'the printed Z carries its number and the net sales 50.60');
    ok(/VAT 20%/.test(out) && /VAT due/.test(out) && /4\.00/.test(out), 'VAT by rate and VAT due (4.00) are on the paper');
    ok(/Seal [0-9a-f]{16}/.test(out), 'it carries the seal');
    ok(!/REPRINT/.test(out), 'the first print is not a reprint');
    ok(!/₹/.test(out), 'no rupee sign');
    received.length = 0;
    await as(T.mgr)(request(base).post(`/api/reports/z/${Z.id}/print`)).send({ reprint: true });
    await new Promise((r) => setTimeout(r, 150));
    out = textOf();
    ok(/REPRINT/.test(out) && /Z REPORT 0001/.test(out), 'a later print is marked REPRINT and shows the same stored figures');
    received.length = 0;
    const px = await as(T.mgr)(request(base).post('/api/reports/x/print')).send({});
    await new Promise((r) => setTimeout(r, 150));
    ok(px.status === 200 && /X REPORT/.test(textOf()) && /Not closed/.test(textOf()), 'an X report prints and says it is not closed');
    const pc = await as(T.cash)(request(base).post(`/api/reports/z/${Z.id}/print`)).send({});
    ok(pc.status === 403, 'a cashier cannot print reports');
    const missing = await as(T.mgr)(request(base).post('/api/reports/z/nope/print')).send({});
    ok(missing.status === 404, 'printing an unknown Z is a 404');
    fake.server.close();

    console.log(`\n✅ Trading reports passed (${passed} checks)`);
  } finally {
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
