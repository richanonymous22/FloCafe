/*
 * Offers: the pure engine (every kind, scope and condition), then the till server end to end - offers become the
 * order's discount, so VAT, the bill, payment, refunds and the X report all agree with them; a person's discount
 * wins; paid orders are never touched.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-offers-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';
import { evaluateOffers, offerIsLive, OfferRow, EvalContext, EvalLine } from '../main/core/offers';

let passed = 0;
function ok(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); passed++; console.log(`  ✓ ${msg}`); }
const now = () => new Date().toISOString();

const offer = (o: Partial<OfferRow> & { kind: OfferRow['kind'] }): OfferRow => ({
  id: 'o' + Math.random().toString(36).slice(2, 8), name: o.kind, scope: 'all', category_id: null, product_ids: [], percent: null, amount_minor: null, price_minor: null,
  buy_qty: null, get_qty: null, bundle_qty: null, starts_at: null, ends_at: null, days_of_week: null, time_from: null, time_to: null, customer_rule: 'any', tiers: [],
  location_id: null, priority: 0, is_active: 1, archived_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...o,
} as OfferRow);
const ctx = (over: Partial<EvalContext> = {}): EvalContext => ({ at: new Date('2026-03-04T12:00:00Z'), timezone: 'Europe/London', locationId: null, customer: null, ...over }); // a Wednesday
const line = (key: string, productId: string, unitMinor: number, quantity: number, categoryId: string | null = null): EvalLine => ({ key, productId, categoryId, unitMinor, quantity });

function engineTests() {
  console.log('\n1. the engine');
  let r = evaluateOffers([line('a', 'p', 400, 2)], [offer({ kind: 'percent_off', percent: 10 })], ctx());
  ok(r.savingsMinor === 80, '10% off two £4.00 items saves 80p');
  r = evaluateOffers([line('a', 'p', 105, 1)], [offer({ kind: 'percent_off', percent: 10 })], ctx());
  ok(r.savingsMinor === 11, 'rounding is half-up per unit (10.5p becomes 11p)');
  r = evaluateOffers([line('a', 'p', 30, 2), line('b', 'q', 400, 1)], [offer({ kind: 'amount_off', amount_minor: 50 })], ctx());
  ok(r.savingsMinor === 30 + 30 + 50 && r.lineSavings.get('a') === 60, '50p off each unit never takes more than the unit costs');
  r = evaluateOffers([line('a', 'p', 300, 2), line('b', 'q', 150, 1)], [offer({ kind: 'fixed_price', price_minor: 200 })], ctx());
  ok(r.savingsMinor === 200 && !r.lineSavings.has('b'), 'a fixed price of £2.00 only helps items that cost more');
  r = evaluateOffers([line('a', 'p', 250, 3)], [offer({ kind: 'multi_buy_price', bundle_qty: 3, price_minor: 500 })], ctx());
  ok(r.savingsMinor === 250, '3 for £5.00 on three £2.50 items saves £2.50');
  r = evaluateOffers([line('a', 'p', 250, 4)], [offer({ kind: 'multi_buy_price', bundle_qty: 3, price_minor: 500 })], ctx());
  ok(r.savingsMinor === 250 && r.applications[0].units === 3, 'a fourth item is not part of the bundle');
  r = evaluateOffers([line('a', 'p', 250, 2)], [offer({ kind: 'multi_buy_price', bundle_qty: 3, price_minor: 500 })], ctx());
  ok(r.savingsMinor === 0, 'two items make no bundle');
  r = evaluateOffers([line('a', 'p', 300, 1), line('b', 'q', 200, 1), line('c', 'r', 100, 1)], [offer({ kind: 'multi_buy_price', bundle_qty: 3, price_minor: 500 })], ctx());
  const sum = [...r.lineSavings.values()].reduce((a, b) => a + b, 0);
  ok(r.savingsMinor === 100 && sum === 100, 'a mixed bundle (£3+£2+£1 for £5) saves £1 and the lines add up to exactly that');
  r = evaluateOffers([line('a', 'p', 400, 1), line('b', 'q', 300, 1), line('c', 'r', 200, 1)], [offer({ kind: 'buy_get_free', buy_qty: 2, get_qty: 1 })], ctx());
  ok(r.savingsMinor === 200 && r.lineSavings.get('c') === 200, 'buy 2 get 1 free: the cheapest of three is free');
  r = evaluateOffers([line('a', 'p', 400, 5)], [offer({ kind: 'buy_get_free', buy_qty: 2, get_qty: 1 })], ctx());
  ok(r.savingsMinor === 400, 'five items make one group of three, the other two pay');
  r = evaluateOffers([line('a', 'p', 400, 6)], [offer({ kind: 'buy_get_free', buy_qty: 2, get_qty: 1 })], ctx());
  ok(r.savingsMinor === 800, 'six items make two groups');
  r = evaluateOffers([line('a', 'p', 400, 1.5), line('b', 'q', 0, 3)], [offer({ kind: 'percent_off', percent: 50 })], ctx());
  ok(r.savingsMinor === 200, 'a fractional quantity counts its whole units only, and free items are ignored');

  console.log('\n2. scope');
  r = evaluateOffers([line('a', 'p1', 400, 1, 'cat1'), line('b', 'p2', 400, 1, 'cat2')], [offer({ kind: 'percent_off', percent: 50, scope: 'category', category_id: 'cat1' })], ctx());
  ok(r.savingsMinor === 200 && r.lineSavings.has('a') && !r.lineSavings.has('b'), 'a category offer touches only that category');
  r = evaluateOffers([line('a', 'p1', 400, 1), line('b', 'p2', 400, 1)], [offer({ kind: 'percent_off', percent: 50, scope: 'products', product_ids: ['p2'] })], ctx());
  ok(r.savingsMinor === 200 && r.lineSavings.has('b'), 'a product offer touches only the chosen products');

  console.log('\n3. when an offer is live');
  const o = (p: Partial<OfferRow>) => offer({ kind: 'percent_off', percent: 10, ...p });
  ok(offerIsLive(o({}), ctx()), 'a plain offer is live');
  ok(!offerIsLive(o({ is_active: 0 }), ctx()) && !offerIsLive(o({ archived_at: '2026-01-02T00:00:00Z' }), ctx()), 'switched off or removed is not live');
  ok(!offerIsLive(o({ starts_at: '2026-03-05T00:00:00Z' }), ctx()) && offerIsLive(o({ starts_at: '2026-03-04T00:00:00Z' }), ctx()), 'it waits for its start');
  ok(!offerIsLive(o({ ends_at: '2026-03-04T12:00:00Z' }), ctx()) && offerIsLive(o({ ends_at: '2026-03-04T12:00:01Z' }), ctx()), 'and ends exactly at its end');
  ok(offerIsLive(o({ days_of_week: [3] }), ctx()) && !offerIsLive(o({ days_of_week: [0, 6] }), ctx()), 'days of the week (Wednesday is 3)');
  ok(offerIsLive(o({ time_from: '11:00', time_to: '14:00' }), ctx()) && !offerIsLive(o({ time_from: '15:00', time_to: '17:00' }), ctx()), 'a time of day window');
  ok(offerIsLive(o({ time_from: '22:00', time_to: '02:00' }), ctx({ at: new Date('2026-03-04T23:30:00Z') })) && !offerIsLive(o({ time_from: '22:00', time_to: '02:00' }), ctx()), 'an overnight window wraps midnight');
  ok(offerIsLive(o({ time_from: '12:00', time_to: '13:00' }), ctx({ at: new Date('2026-07-01T11:30:00Z') })), 'times are the shop\'s clock, not UTC (11:30 UTC in British summer is 12:30)');
  ok(!offerIsLive(o({ location_id: 'L2' }), ctx({ locationId: 'L1' })) && offerIsLive(o({ location_id: 'L1' }), ctx({ locationId: 'L1' })), 'a location offer applies at that location only');
  ok(!offerIsLive(o({ customer_rule: 'member' }), ctx()) && offerIsLive(o({ customer_rule: 'member' }), ctx({ customer: { tier: 'bronze' } })), 'a members-only offer needs a customer');
  ok(offerIsLive(o({ customer_rule: 'tier', tiers: ['gold'] }), ctx({ customer: { tier: 'gold' } })) && !offerIsLive(o({ customer_rule: 'tier', tiers: ['gold'] }), ctx({ customer: { tier: 'silver' } })), 'a tier offer needs that tier');

  console.log('\n4. several offers');
  r = evaluateOffers([line('a', 'p', 400, 2)], [offer({ kind: 'percent_off', percent: 10 }), offer({ kind: 'percent_off', percent: 50 })], ctx());
  ok(r.applications.length === 1 && r.savingsMinor === 400, 'an item takes part in one offer: the one that saves most wins');
  const lowPriorityBigSaving = offer({ kind: 'percent_off', percent: 50, priority: 0, name: 'big' });
  const highPriority = offer({ kind: 'percent_off', percent: 10, priority: 5, name: 'chosen' });
  r = evaluateOffers([line('a', 'p', 400, 1)], [lowPriorityBigSaving, highPriority], ctx());
  ok(r.applications[0].name === 'chosen' && r.savingsMinor === 40, 'a higher priority goes first even if another would save more');
  r = evaluateOffers([line('a', 'p1', 400, 2, 'c1'), line('b', 'p2', 100, 1, 'c2')], [offer({ kind: 'percent_off', percent: 50, scope: 'category', category_id: 'c1', name: 'cat' }), offer({ kind: 'percent_off', percent: 10, name: 'all' })], ctx());
  ok(r.applications.length === 2 && r.savingsMinor === 400 + 10, 'offers on different items both apply');
}

async function main() {
  console.log('Testing offers...');
  engineTests();

  initDatabase();
  const db = getDatabase();
  const bcrypt = require('bcryptjs');
  const pw = bcrypt.hashSync('Passw0rd!x', 10);
  const user = (id: string, role: string) => db.prepare(`INSERT INTO users (id, name, email, password, role, pin_hash, is_active) VALUES (?,?,?,?,?,NULL,1)`).run(id, id, `${id}@till.local`, pw, role);
  user('u-own', 'owner'); user('u-mgr', 'manager'); user('u-cash', 'cashier');
  const { grantLocationAccess } = require('../main/core/employee-access');
  const { getCurrentLocationId } = require('../main/core/location');
  grantLocationAccess('u-cash', getCurrentLocationId());
  const setting = (k: string, v: string) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
  setting('country', 'GB'); setting('currency', 'GBP'); setting('business_type', 'retail'); setting('taxes_enabled', 'true');
  ok(Number(db.pragma('user_version', { simple: true })) >= 104, 'database migrated to v104 or later');
  db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES ('cat','Shop',1,1,?,?)`).run(now(), now());
  const prod = (id: string, price: number, taxCat: string, track = 0) =>
    db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, tax_category_id, tax_behavior, created_at, updated_at)
                VALUES (?, 'cat', ?, ?, 1, ?, 1, 1, ?, ?, 0, ?, 'country_default', ?, ?)`).run(id, id, price, id, track, track ? 100 : 0, taxCat, now(), now());
  prod('cake', 4, 'standard', 1); prod('bread', 1.5, 'zero');
  db.prepare(`INSERT INTO customers (id, name, phone, created_at, updated_at) VALUES ('gold1','Goldie','07700900011',?,?)`).run(now(), now());
  db.prepare(`INSERT INTO customers (id, name, phone, created_at, updated_at) VALUES ('new1','Newbie','07700900012',?,?)`).run(now(), now());
  // Goldie has spent 1,000 with the shop before (the same lifetime spend the customer list turns into a tier).
  db.prepare(`INSERT INTO orders (order_number, type, status, customer_id, total, created_at, updated_at) VALUES ('OLD-1','takeaway','completed','gold1',1000,?,?)`).run(now(), now());

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  try {
    const tok = async (id: string) => (await request(base).post('/api/auth/login').send({ email: `${id}@till.local`, password: 'Passw0rd!x' })).body.access_token as string;
    const T = { own: await tok('u-own'), mgr: await tok('u-mgr'), cash: await tok('u-cash') };
    const api = (t: string, method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: any, key?: string) => {
      let r = (request(base) as any)[method](url).set('Authorization', `Bearer ${t}`);
      if (key) r = r.set('Idempotency-Key', key);
      return body === undefined ? r : r.send(body);
    };

    console.log('\n5. creating offers');
    const three = { name: '3 for 2 on cake', kind: 'buy_get_free', buy_qty: 2, get_qty: 1, scope: 'products', product_ids: ['cake'] };
    ok((await api(T.cash, 'post', '/api/offers', three)).status === 403, 'a cashier cannot create an offer');
    const bad = async (body: any) => (await api(T.mgr, 'post', '/api/offers', { ...three, ...body })).status;
    ok(await bad({ name: '' }) === 400 && await bad({ kind: 'nonsense' }) === 400, 'a name and a known kind are required');
    ok(await bad({ kind: 'percent_off', percent: 0 }) === 400 && await bad({ kind: 'percent_off', percent: 101 }) === 400, 'percent must be above 0 and at most 100');
    ok(await bad({ kind: 'multi_buy_price', bundle_qty: 1, price: 5 }) === 400 && await bad({ kind: 'multi_buy_price', bundle_qty: 3, price: 0 }) === 400, 'a bundle needs 2 or more items and a price');
    ok(await bad({ kind: 'amount_off', amount: '1.234' }) === 400, 'an amount has at most two decimals');
    ok(await bad({ starts_at: '2026-03-02T00:00:00Z', ends_at: '2026-03-01T00:00:00Z' }) === 400, 'the end must be after the start');
    ok(await bad({ time_from: '9:30', time_to: '11:00' }) === 400 && await bad({ time_from: '09:30' }) === 400, 'times look like 09:30 and come in pairs');
    ok(await bad({ product_ids: ['ghost'] }) === 400 && await bad({ scope: 'category', category_id: 'ghost' }) === 400, 'products and categories must exist');
    ok(await bad({ customer_rule: 'tier', tiers: ['platinum'] }) === 400 && await bad({ days_of_week: [7] }) === 400, 'tiers and weekdays are checked');
    const created = await api(T.mgr, 'post', '/api/offers', three);
    ok(created.status === 201 && created.body.offer.name === '3 for 2 on cake' && created.body.offer.product_ids[0] === 'cake', 'a manager creates "3 for 2"');
    const offerId = created.body.offer.id as string;
    ok((await api(T.cash, 'get', '/api/offers')).body.offers.length === 1, 'a cashier can read the list');

    console.log('\n6. a sale gets the offer, and everything agrees with it');
    let seq = 0;
    const order = (items: any[], extra: any = {}) => api(T.own, 'post', '/api/orders', { type: 'takeaway', items, ...extra }, `o-${++seq}`);
    const o1 = await order([{ product_id: 'cake', quantity: 3 }]);
    const ord1 = o1.body.order;
    ok(ord1.subtotal === 12 && ord1.discount_amount === 4 && ord1.total === 8, 'three cakes at £4.00 cost £8.00: one free');
    ok(ord1.discount_source === 'offer' && /3 for 2 on cake/.test(ord1.discount_reason), 'the order says the discount is an offer, and which');
    ok(Math.abs(ord1.tax_amount - 1.33) < 0.011, 'VAT is worked out on what the customer pays (£1.33 on £8.00 at 20% inclusive)');
    const oo = db.prepare('SELECT * FROM order_offers WHERE order_id = ?').all(ord1.id) as any[];
    ok(oo.length === 1 && oo[0].savings_minor === 400 && oo[0].units === 1, 'the saving is recorded against the offer');
    const add = await api(T.own, 'post', `/api/orders/${ord1.id}/items`, { items: [{ product_id: 'cake', quantity: 3 }] }, `a-${++seq}`);
    const afterAdd = (db.prepare('SELECT * FROM orders WHERE id = ?').get(ord1.id) as any);
    ok(add.status === 200 && afterAdd.discount_amount === 8 && afterAdd.total === 16, 'adding three more cakes brings the saving to £8.00');
    const items = db.prepare("SELECT id FROM order_items WHERE order_id = ? ORDER BY id").all(ord1.id) as any[];
    const rm = await api(T.own, 'patch', `/api/orders/${ord1.id}/items/${items[0].id}/cancel`, {});
    const afterRm = (db.prepare('SELECT * FROM orders WHERE id = ?').get(ord1.id) as any);
    ok(rm.status === 200 && afterRm.discount_amount === 4 && afterRm.total === 8, 'removing the first line leaves three cakes: one free again');
    ok((db.prepare('SELECT SUM(savings_minor) s FROM order_offers WHERE order_id = ?').get(ord1.id) as any).s === 400, 'and the record follows');

    console.log('\n7. a person\'s discount wins');
    const manual = await api(T.own, 'patch', `/api/orders/${ord1.id}/discount`, { discount_type: 'percentage', discount_value: 10, discount_reason: 'Regular' });
    const afterManual = db.prepare('SELECT * FROM orders WHERE id = ?').get(ord1.id) as any;
    ok(manual.status === 200 && afterManual.discount_source === null && afterManual.discount_type === 'percentage' && /Regular/.test(afterManual.discount_reason), 'a manual discount replaces the offer');
    ok((db.prepare('SELECT COUNT(*) c FROM order_offers WHERE order_id = ?').get(ord1.id) as any).c === 0, 'no offer is recorded while it stands');
    await api(T.own, 'post', `/api/orders/${ord1.id}/items`, { items: [{ product_id: 'cake', quantity: 1 }] }, `a-${++seq}`);
    ok((db.prepare('SELECT discount_source s FROM orders WHERE id = ?').get(ord1.id) as any).s === null, 'adding items does not bring the offer back over it');
    await api(T.own, 'patch', `/api/orders/${ord1.id}/discount`, { discount_type: 'percentage', discount_value: 0 });
    const afterRemove = db.prepare('SELECT * FROM orders WHERE id = ?').get(ord1.id) as any;
    ok(afterRemove.discount_source === 'offer' && afterRemove.discount_amount === 4, 'removing the manual discount lets the offer apply again (4 cakes: one free)');

    console.log('\n8. the bill, payment, report and refund');
    const bill = (await api(T.own, 'post', '/api/bills/generate', { order_id: ord1.id })).body.bill;
    ok(bill.discount_amount === 4 && bill.total === 12, 'the bill carries the offer: £12.00 for four cakes');
    const paid = await api(T.own, 'post', `/api/bills/${bill.id}/payments`, { payments: [{ method: 'cash', amount: 12 }] }, `p-${seq}`);
    ok(paid.status === 200 && paid.body.bill.payment_status === 'paid', 'it is paid in full at the discounted price');
    ok((await api(T.own, 'post', `/api/orders/${ord1.id}/items`, { items: [{ product_id: 'cake', quantity: 1 }] }, `a-${++seq}`)).status >= 400 || (db.prepare('SELECT total FROM orders WHERE id = ?').get(ord1.id) as any).total === 12, 'a paid order is never changed afterwards');
    const unchangedAfterPaid = db.prepare('SELECT discount_amount, total FROM orders WHERE id = ?').get(ord1.id) as any;
    ok(unchangedAfterPaid.discount_amount === 4 && unchangedAfterPaid.total === 12, 'its discount and total are exactly as paid');
    const x = (await api(T.mgr, 'get', '/api/reports/x')).body.report;
    ok(x.sales.gross_minor === 1200 && x.discounts.amount_minor === 400, 'the X report shows £12.00 taken and £4.00 of discounts');
    ok(x.checks.tenders_equal_bills && x.checks.vat_equals_bills && x.checks.gross_by_rate_equals_bills, 'and its own consistency checks pass');
    const usage = (await api(T.mgr, 'get', '/api/offers/usage')).body.usage;
    ok(usage.length === 1 && usage[0].savings_minor === 400 && usage[0].orders === 1, 'the offer report says £4.00 saved on one order');
    const refund = await api(T.own, 'post', `/api/bills/${bill.id}/refund`, { reason: 'Returned', amount_from_items: false, amount: 4 }, `r-${seq}`);
    ok(refund.status === 200 && refund.body.amount_minor === 400, 'a part refund works on a bill that had an offer');
    const lines = (await api(T.mgr, 'get', `/api/bills/${bill.id}/refunds`)).body.items;
    ok(lines.every((l: any) => l.unit_refund_minor === 300), 'item refunds value each cake at what was actually paid (£3.00: £12.00 over four)');

    console.log('\n9. conditions at the till');
    await api(T.mgr, 'post', `/api/offers/${offerId}/active`, { active: false });
    const o2 = (await order([{ product_id: 'cake', quantity: 3 }])).body.order;
    ok(o2.discount_amount === 0 && o2.total === 12, 'a switched-off offer does nothing');
    await api(T.mgr, 'post', `/api/offers/${offerId}/active`, { active: true });
    const wrongDay = (new Date().getDay() + 3) % 7;
    await api(T.mgr, 'put', `/api/offers/${offerId}`, { ...three, days_of_week: [wrongDay] });
    ok((await order([{ product_id: 'cake', quantity: 3 }])).body.order.discount_amount === 0, 'an offer for another day does nothing today');
    await api(T.mgr, 'put', `/api/offers/${offerId}`, { ...three });
    const gold = await api(T.mgr, 'post', '/api/offers', { name: 'Gold 20% off bread', kind: 'percent_off', percent: 20, scope: 'products', product_ids: ['bread'], customer_rule: 'tier', tiers: ['gold'] });
    ok(gold.status === 201, 'a gold-members offer is created');
    ok((await order([{ product_id: 'bread', quantity: 2 }], { customer_id: 'new1' })).body.order.discount_amount === 0, 'a new customer does not get it');
    const goldOrder = (await order([{ product_id: 'bread', quantity: 2 }], { customer_id: 'gold1' })).body.order;
    ok(Math.abs(goldOrder.discount_amount - 0.6) < 0.001, 'a gold customer gets 20% off two £1.50 loaves (60p)');

    console.log('\n10. left alone');
    const override = await api(T.own, 'post', '/api/orders', { type: 'takeaway', items: [{ product_id: 'cake', quantity: 3, price_override: { unit_price: 3, reason: 'Price match' } }] }, `o-${++seq}`);
    ok(override.status === 201 && override.body.order.discount_amount === 0 && override.body.order.total === 9, 'a price-overridden line is not discounted again');
    const prev = await api(T.cash, 'post', '/api/offers/preview', { items: [{ product_id: 'cake', quantity: 3 }, { product_id: 'bread', quantity: 1 }] });
    ok(prev.status === 200 && prev.body.savings_minor === 400 && prev.body.applications[0].name === '3 for 2 on cake', 'the preview tells the till what an offer would save on a basket');
    ok((await api(T.cash, 'post', '/api/offers/preview', { items: 'x' })).status === 400, 'a bad preview request is refused');
    ok((await api(T.mgr, 'delete', `/api/offers/${gold.body.offer.id}`)).status === 204 && (await api(T.mgr, 'get', '/api/offers')).body.offers.length === 1, 'a removed offer leaves the list');
    ok(!!db.prepare('SELECT 1 FROM offers WHERE id = ? AND archived_at IS NOT NULL').get(gold.body.offer.id), 'but is kept (archived), so past orders keep their record');
    ok((await api(T.cash, 'delete', `/api/offers/${offerId}`)).status === 403, 'a cashier cannot remove an offer');
  } finally { await stopServer(); closeDatabase(); }
  console.log(`\n✅ Offers passed (${passed} checks)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
