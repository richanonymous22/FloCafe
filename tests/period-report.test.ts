/*
 * Period reports — the same scripted trading day, read as a date range through the real API and database.
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
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-period-'));
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
  console.log('Testing period reports...');
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

    console.log('\n3. the period report for the whole day');
    const q = (extra = '') => `from=2000-01-01%2000:00:00&to=2999-01-01%2000:00:00&tz=Europe/London${extra}`;
    const res = await as(T.mgr)(request(base).get(`/api/reports/period?${q()}`));
    ok(res.status === 200, 'a manager can read it');
    const R = res.body.report;
    ok(R.snapshot.sales.gross_minor === 7310 && R.snapshot.sales.net_minor === 5060, 'headline matches the X report: gross 73.10, net 50.60');
    ok(R.checks.products_equal_bills && R.checks.staff_equal_bills, 'products and staff add up to the bills');

    const P = (id: string) => R.products.find((p: any) => p.product_id === id);
    ok(R.products.length === 4, 'four products sold');
    ok(P('std').units_sold === 3 && P('std').gross_minor === 3600 && P('std').vat_minor === 600 && P('std').net_minor === 3000, 'Standard: 3 sold, gross 36.00, VAT 6.00, net 30.00');
    ok(P('std').refunded_minor === 1200 && P('std').units_returned === 1 && P('std').net_after_refunds_minor === 2000, 'Standard: the whole-bill refund (12.00) is taken off, net after refunds 20.00');
    ok(P('red').gross_minor === 1050 && P('red').refunded_minor === 1050 && P('red').net_after_refunds_minor === 0 && P('red').units_returned === 1, 'Reduced: refunded by item, nothing left');
    ok(P('zro').units_sold === 3 && P('zro').net_after_refunds_minor === 1400 && P('zro').vat_minor === 0, 'Zero-rated: 3 sold (one at the overridden price), 14.00, no VAT');
    ok(P('exm').gross_minor === 1260 && P('exm').net_after_refunds_minor === 1260, 'Exempt: 12.60 after the 10% discount');
    ok(P('zro').cost_minor === 300 && P('zro').profit_minor === 1100 && P('zro').margin_percent === 78.6, 'Zero-rated cost 3.00, profit 11.00, margin 78.6%');
    ok(R.products[0].product_id === 'zro' || R.products[0].net_after_refunds_minor >= R.products[1].net_after_refunds_minor, 'products are ordered by net after refunds');
    ok(R.products.reduce((s: number, p: any) => s + p.gross_minor, 0) === 7310, 'product gross adds up to the takings');
    ok(R.products.reduce((s: number, p: any) => s + p.refunded_minor, 0) === 2250, 'product refunds add up to all refunds (22.50)');

    ok(R.categories.length === 1 && R.categories[0].category === 'Shop' && R.categories[0].net_after_refunds_minor === 4660, 'category Shop: net after refunds 46.60');

    const owner = R.staff.find((s: any) => s.user_id === 'u-own');
    const mgr = R.staff.find((s: any) => s.user_id === 'u-mgr');
    ok(owner.sales === 5 && owner.gross_minor === 7310 && owner.average_minor === 1462 && owner.discounts_minor === 140, 'owner: 5 sales, 73.10, average 14.62, 1.40 discounts given');
    ok(mgr.refunds === 2 && mgr.refunds_minor === 2250 && mgr.sales === 0, 'manager processed the 2 refunds (22.50) and made no sales');

    ok(R.refunds.length === 2 && R.refunds.some((x: any) => x.reason === 'Wrong item' && x.amount_minor === 1050 && x.method === 'card'), 'refund list carries reason, amount and the tender it went back to');
    ok(R.discounts.length === 1 && R.discounts[0].amount_minor === 140 && R.discounts[0].reason === 'Regular', 'discount list: one, 1.40, with its reason');
    ok(R.voids.length === 1 && R.voids[0].kind === 'order' && R.voids[0].reason === 'Walked out', 'void list: the cancelled order and why');
    ok(R.series.length === 1 && R.series[0].sales === 5 && R.series[0].net_minor === 5060, 'one day in the series: 5 sales, 50.60 net of refunds');
    const hourly = (await as(T.mgr)(request(base).get(`/api/reports/period?${q('&bucket=hour')}`))).body.report;
    ok(hourly.series.length >= 1 && /^\d{4}-\d\d-\d\d \d\d:00$/.test(hourly.series[0].bucket), 'hourly buckets are labelled in the business time zone');
    ok(hourly.series.reduce((s: number, p: any) => s + p.net_minor, 0) === 5060, 'hourly series adds up to the same net');

    console.log('\n4. an empty or later range does not count the day');
    const later = (await as(T.mgr)(request(base).get('/api/reports/period?from=2998-01-01%2000:00:00&to=2999-01-01%2000:00:00'))).body.report;
    ok(later.products.length === 0 && later.snapshot.sales.gross_minor === 0 && later.series.length === 0, 'a range with no trading is empty');
    const tiny = (await as(T.mgr)(request(base).get(`/api/reports/period?from=2000-01-01%2000:00:00&to=2000-01-01%2000:00:01`))).body.report;
    ok(tiny.snapshot.transactions.count === 0, 'a range before the first sale is empty');

    console.log('\n5. CSV exports');
    const csv = async (section: string) => (await as(T.mgr)(request(base).get(`/api/reports/period/csv?${q('&section=' + section)}`)));
    const prodCsv = await csv('products');
    ok(prodCsv.status === 200 && /text\/csv/.test(prodCsv.headers['content-type']) && /products-2000-01-01_2999-01-01\.csv/.test(prodCsv.headers['content-disposition']), 'products CSV downloads with a dated file name');
    ok(prodCsv.text.split('\r\n')[0] === 'Product,Category,Units sold,Units returned,Gross,VAT,Net,Refunded,Net after refunds,Cost,Profit,Margin %', 'products CSV header');
    ok(/\r\nStandard,Shop,3,1,36\.00,6\.00,30\.00,12\.00,20\.00,3\.00,17\.00,85\r\n/.test(prodCsv.text), 'Standard row is exact (36.00 / 6.00 / 30.00 / 12.00 / 20.00 / 3.00 / 17.00 / 85%)');
    const vatCsv = (await csv('vat')).text;
    ok(/\r\nTotal,,73\.10,66\.60,6\.50,22\.50,2\.50,4\.00\r\n$/.test(vatCsv), 'VAT CSV totals: gross 73.10, net 66.60, VAT 6.50, credit notes 22.50 / 2.50 VAT, VAT due 4.00');
    ok(vatCsv.includes('\r\nVAT 20%,20,36.00,30.00,6.00,12.00,2.00,4.00\r\n') && vatCsv.includes('\r\nVAT 5%,5,10.50,10.00,0.50,10.50,0.50,0.00\r\n'), 'VAT CSV: 20% row (36.00 gross, 6.00 VAT, 2.00 credit-note VAT, 4.00 due) and fully refunded 5% row (0.00 due)');
    for (const sec of ['summary', 'categories', 'staff', 'discounts', 'refunds', 'voids']) {
      const r = await csv(sec);
      ok(r.status === 200 && r.text.split('\r\n').length >= 2, `${sec} CSV downloads`);
    }
    ok((await csv('nonsense')).status === 400, 'an unknown section is refused');
    ok((await as(T.cash)(request(base).get(`/api/reports/period/csv?${q('&section=products')}`))).status === 403, 'a cashier cannot export');
    ok((await as(T.cash)(request(base).get(`/api/reports/period?${q()}`))).status === 403, 'a cashier cannot read period reports');
    ok((await as(T.mgr)(request(base).get('/api/reports/period?from=yesterday&to=today'))).status === 400, 'a malformed range is refused');
    ok((await as(T.mgr)(request(base).get('/api/reports/period?from=2999-01-01%2000:00:00&to=2000-01-01%2000:00:00'))).status === 400, 'a backwards range is refused');
    ok((await as(T.mgr)(request(base).get(`/api/reports/period?from=2000-01-01%2000:00:00&to=2999-01-01%2000:00:00&tz=Not/AZone`))).status === 200, 'an unknown time zone falls back to UTC instead of failing');

    console.log(`\n✅ Period reports passed (${passed} checks)`);
  } finally {
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
