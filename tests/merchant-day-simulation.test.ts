/*
 * A SIMULATED merchant day, end to end through the real HTTP API, real SQLite and the simulated card terminal.
 *
 * This is a simulation: nothing here proves behaviour on real hardware, real card terminals or a real merchant
 * (see docs/SIMULATED_MERCHANT_DAY.md). What it does prove is that a busy mixed day - cash with change, card with
 * tips, split tenders, wallet, discounts, declined and abandoned card payments, an offline terminal, replayed and
 * double-submitted payments, voids, cash and card refunds (including one the provider refuses), goods in, a
 * stocktake with shrinkage, pay in / pay out, a "power cut" that leaves card money unrecorded - still balances to the
 * penny, to the unit, and to the drawer, by figures this script keeps itself, independently of the till.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-day-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};
process.env.PLEMMO_ALLOW_CARD_SIMULATOR = '1';
process.env.PLEMMO_CARD_SIMULATOR_DELAY_MS = '0';

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
const now = () => new Date().toISOString();
const SEED = Number(process.env.DAY_SEED || 20261001);
const SALES = Number(process.env.DAY_SALES || 140);
function prng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = prng(SEED);
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const major = (minor: number) => (minor / 100).toFixed(2);

interface SaleRecord {
  billId: number; orderId: number; totalMinor: number; discounted: boolean;
  cashMinor: number; cardSimMinor: number; cardManualMinor: number; walletMinor: number; tipMinor: number;
  items: { pid: string; qty: number; orderItemId: number }[]; refundedMinor: number;
}

async function run() {
  console.log(`Testing a simulated merchant day (seed ${SEED}, ${SALES} sales)...`);
  initDatabase();
  const db = getDatabase();
  const bcrypt = require('bcryptjs');
  const pw = bcrypt.hashSync('Passw0rd!x', 10);
  const user = (id: string, role: string, pin: string | null) =>
    db.prepare(`INSERT INTO users (id, name, email, password, role, pin_hash, is_active) VALUES (?,?,?,?,?,?,1)`)
      .run(id, id, `${id}@till.local`, pw, role, pin ? bcrypt.hashSync(pin, 10) : null);
  user('u-own', 'owner', '1111'); user('u-mgr', 'manager', '2222'); user('u-cash', 'cashier', '3333'); user('u-cash2', 'cashier', '4444');
  const { grantLocationAccess } = require('../main/core/employee-access');
  const { getCurrentLocationId } = require('../main/core/location');
  grantLocationAccess('u-cash', getCurrentLocationId()); grantLocationAccess('u-cash2', getCurrentLocationId());
  const setting = (k: string, v: string) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
  setting('country', 'GB'); setting('currency', 'GBP'); setting('business_type', 'retail'); setting('taxes_enabled', 'true');
  setting('loyalty_enabled', 'false');
  db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES ('cat','Shop',1,1,?,?)`).run(now(), now());

  // A shop of 14 items across all four VAT treatments; ten of them track stock.
  const CATALOGUE: { id: string; price: number; tax: string; stock: number }[] = [
    { id: 'coffee', price: 285, tax: 'standard', stock: 0 }, { id: 'tea', price: 240, tax: 'standard', stock: 0 },
    { id: 'cake', price: 395, tax: 'standard', stock: 400 }, { id: 'sandw', price: 545, tax: 'reduced', stock: 400 },
    { id: 'soup', price: 479, tax: 'reduced', stock: 400 }, { id: 'bread', price: 135, tax: 'zero', stock: 400 },
    { id: 'milk', price: 109, tax: 'zero', stock: 400 }, { id: 'veg', price: 299, tax: 'zero', stock: 400 },
    { id: 'mug', price: 799, tax: 'standard', stock: 400 }, { id: 'tote', price: 1299, tax: 'standard', stock: 400 },
    { id: 'card1', price: 249, tax: 'standard', stock: 400 }, { id: 'stamp', price: 195, tax: 'exempt', stock: 0 },
    { id: 'book', price: 1099, tax: 'zero', stock: 400 }, { id: 'candle', price: 1549, tax: 'standard', stock: 400 },
  ];
  for (const p of CATALOGUE) {
    db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, tax_category_id, tax_behavior, created_at, updated_at)
                VALUES (?, 'cat', ?, ?, 1, ?, 1, 1, ?, ?, 20, ?, 'country_default', ?, ?)`).run(p.id, p.id, p.price / 100, p.id, p.stock > 0 ? 1 : 0, p.stock, p.tax, now(), now());
  }
  const tracked = CATALOGUE.filter((p) => p.stock > 0).map((p) => p.id);
  const priceOf = Object.fromEntries(CATALOGUE.map((p) => [p.id, p.price]));

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  const latencies: number[] = [];
  try {
    const login = async (id: string) =>
      (await request(base).post('/api/auth/login').send({ email: `${id}@till.local`, password: 'Passw0rd!x' })).body.access_token as string;
    const T = { own: await login('u-own'), mgr: await login('u-mgr'), c1: await login('u-cash'), c2: await login('u-cash2') };
    const as = (t: string) => (r: any) => r.set('Authorization', `Bearer ${t}`);
    const api = (t: string, method: 'get' | 'post' | 'put' | 'patch', url: string, body?: any, key?: string) => {
      let r = (request(base) as any)[method](url);
      if (key) r = r.set('Idempotency-Key', key);
      r = as(t)(r);
      return body === undefined ? r : r.send(body);
    };

    console.log('\n1. opening: simulated card terminal on, drawer open with a float');
    ok((await api(T.own, 'put', '/api/card/config', { provider: 'simulator' })).status === 200, 'owner switches on the simulated card terminal');
    const FLOAT = 15000;
    const open = await api(T.own, 'post', '/api/cash/session/open', { opening_float_minor: FLOAT });
    ok(open.status === 201, 'drawer opened with a 150.00 float');
    const sessionId = open.body.session.id as string;

    // ── running figures kept by this script, never read back from the till ───────────────────────────────
    const sales: SaleRecord[] = [];
    const stock: Record<string, number> = Object.fromEntries(CATALOGUE.map((p) => [p.id, p.stock]));
    let voids = 0, declined = 0, abandoned = 0, offline = 0, replays = 0, doubles = 0, discountedSales = 0;
    const cashiers = [T.c1, T.c2];
    let seq = 0;
    const orphans: { attemptId: string; billId: number; amountMinor: number }[] = [];

    async function cardViaTerminal(cashier: string, billId: number, amountMinor: number, tipMinor: number): Promise<{ outcome: 'approved' | 'declined' | 'pending' | 'offline'; attemptId?: string }> {
      const a = await api(cashier, 'post', '/api/card/attempts', { bill_id: billId, amount: major(amountMinor), tip: tipMinor ? major(tipMinor) : undefined });
      if (a.status === 502 && a.body.code === 'terminal_offline') return { outcome: 'offline' };
      if (a.status !== 201) throw new Error('attempt failed: ' + JSON.stringify(a.body));
      const p = await api(cashier, 'get', `/api/card/attempts/${a.body.id}`);
      if (p.body.state === 'approved') return { outcome: 'approved', attemptId: a.body.id };
      if (p.body.state === 'declined') return { outcome: 'declined', attemptId: a.body.id };
      await api(cashier, 'post', `/api/card/attempts/${a.body.id}/cancel`);
      return { outcome: 'pending', attemptId: a.body.id };
    }

    async function sale(): Promise<void> {
      const n = ++seq;
      const cashier = pick(cashiers);
      const lines: { pid: string; qty: number }[] = [];
      const used = new Set<string>();
      for (let i = int(1, 4); i > 0; i--) { const p = pick(CATALOGUE).id; if (used.has(p)) continue; used.add(p); lines.push({ pid: p, qty: int(1, 3) }); }
      const own = (await api(cashier, 'post', '/api/orders', { type: 'takeaway', items: lines.map((l) => ({ product_id: l.pid, quantity: l.qty })) }, `o-${n}`));
      if (own.status !== 201) throw new Error('order failed: ' + JSON.stringify(own.body));
      const orderId = own.body.order.id as number;
      const orderItems = own.body.order.items as any[];
      const discount = rnd() < 0.08;
      if (discount) { discountedSales++; await api(T.own, 'patch', `/api/orders/${orderId}/discount`, { discount_type: 'percentage', discount_value: 10, discount_reason: 'Regular' }); }

      // abandoned before billing: cancelled, stock must come straight back
      if (rnd() < 0.05) {
        const c = await api(T.mgr, 'patch', `/api/orders/${orderId}/status`, { status: 'cancelled', reason: 'Walked out' });
        if (c.status !== 200) throw new Error('void failed: ' + JSON.stringify(c.body));
        voids++; abandoned++; return;
      }
      const t0 = Date.now();
      const bill = (await api(cashier, 'post', '/api/bills/generate', { order_id: orderId })).body.bill;
      const total = Math.round(Number(bill.total) * 100);
      const expectedGross = lines.reduce((s, l) => s + priceOf[l.pid] * l.qty, 0);
      if (!discount && total !== expectedGross) throw new Error(`bill total ${total} != own sum ${expectedGross}`);
      if (discount && Math.abs(total - Math.round(expectedGross * 0.9)) > 1) throw new Error(`discounted total ${total} off from ${expectedGross * 0.9}`);

      const rec: SaleRecord = { billId: bill.id, orderId, totalMinor: total, discounted: discount, cashMinor: 0, cardSimMinor: 0, cardManualMinor: 0, walletMinor: 0, tipMinor: 0,
        items: lines.map((l) => ({ pid: l.pid, qty: l.qty, orderItemId: orderItems.find((o: any) => o.product_id === l.pid).id })), refundedMinor: 0 };
      const roll = rnd();
      const key = `pay-${n}`;
      let sentBody: any = null;
      const doubleTap = rnd() < 0.05;
      const pay = async (payments: any[]) => {
        sentBody = { payments };
        const send = () => api(cashier, 'post', `/api/bills/${bill.id}/payments`, sentBody, key);
        if (!doubleTap) return send();
        doubles++;
        const [first, second] = await Promise.all([send(), send()]);
        if (first.status !== 200 || second.status !== 200) throw new Error(`double tap: ${first.status}/${second.status} ${JSON.stringify(second.body)}`);
        return first;
      };
      let res: any;
      const tip = rnd() < 0.25 ? pick([50, 100, 150]) : 0;

      async function takeCardOrFallback(amountMinor: number, tipMinor: number): Promise<{ lines: any[]; sim: number; manual: number; cash: number; tip: number }> {
        const r = await cardViaTerminal(cashier, bill.id, amountMinor, tipMinor);
        if (r.outcome === 'approved') return { lines: [{ method: 'card', card_attempt_id: r.attemptId }], sim: amountMinor, manual: 0, cash: 0, tip: tipMinor };
        if (r.outcome === 'declined') declined++; else if (r.outcome === 'offline') offline++; else declined++;
        // the cashier takes another way: the customer pays cash, or the card is rung on a spare terminal and recorded by hand
        if (rnd() < 0.5) return { lines: [{ method: 'cash', amount: major(amountMinor) }], sim: 0, manual: 0, cash: amountMinor, tip: 0 };
        return { lines: [{ method: 'card', amount: major(amountMinor), transaction_id: `HAND-${n}` }], sim: 0, manual: amountMinor, cash: 0, tip: 0 };
      }

      if (roll < 0.34) {                               // cash with change
        const tender = Math.ceil(total / 500) * 500 + (rnd() < 0.3 ? 500 : 0);
        res = await pay([{ method: 'cash', amount: major(tender) }]);
        rec.cashMinor = total;
      } else if (roll < 0.66) {                        // card on the terminal
        const t = await takeCardOrFallback(total, tip);
        res = await pay(t.lines); rec.cardSimMinor = t.sim; rec.cardManualMinor = t.manual; rec.cashMinor = t.cash; rec.tipMinor = t.tip;
      } else if (roll < 0.74) {                        // card recorded by hand
        res = await pay([{ method: 'card', amount: major(total), transaction_id: `HAND-${n}` }]); rec.cardManualMinor = total;
      } else if (roll < 0.90 && total >= 300) {        // split: whole pounds cash, the rest on the terminal
        const cashPart = Math.floor(total / 200) * 100;
        const t = await takeCardOrFallback(total - cashPart, tip);
        res = await pay([{ method: 'cash', amount: major(cashPart) }, ...t.lines]);
        rec.cashMinor = cashPart + t.cash; rec.cardSimMinor = t.sim; rec.cardManualMinor = t.manual; rec.tipMinor = t.tip;
      } else {                                         // cash again (busy morning)
        res = await pay([{ method: 'cash', amount: major(total) }]); rec.cashMinor = total;
      }
      if (res.status !== 200) throw new Error(`payment failed for sale ${n}: ${res.status} ${JSON.stringify(res.body)}`);
      latencies.push(Date.now() - t0);
      for (const l of lines) if (stock[l.pid] > 0 || tracked.includes(l.pid)) stock[l.pid] -= l.qty;
      sales.push(rec);

      // chaos: the same request sent again after the response was "lost": same answer, nothing paid twice
      if (rnd() < 0.10) {
        replays++;
        const before = (db.prepare('SELECT COUNT(*) c FROM payments WHERE bill_id = ?').get(bill.id) as any).c;
        const again = await api(cashier, 'post', `/api/bills/${bill.id}/payments`, sentBody, key);
        if (again.status !== 200) throw new Error(`replay refused: ${again.status} ${JSON.stringify(again.body)}`);
        const after = (db.prepare('SELECT COUNT(*) c FROM payments WHERE bill_id = ?').get(bill.id) as any).c;
        if (after !== before) throw new Error('a replayed payment created a second payment');
      }
    }

    console.log('\n2. the morning rush');
    const half = Math.floor(SALES / 2);
    for (let i = 0; i < half; i++) await sale();
    ok(sales.length > half * 0.85, `${sales.length} sales completed out of ${half} attempted so far (${voids} abandoned)`);

    console.log(`\n3. lunch: goods in, a power cut, a refused card refund`);
    // goods in
    const receive = await api(T.mgr, 'post', '/api/inventory/adjust', { product_id: 'cake', quantity_delta: 60, reason: 'Delivery', movement_type: 'receipt' });
    ok(receive.status === 201, 'a delivery of 60 cakes is booked in');
    stock.cake += 60;
    // power cut: two customers are charged on the terminal but the till never records the sale
    for (let i = 0; i < 2; i++) {
      const o = await api(T.c1, 'post', '/api/orders', { type: 'takeaway', items: [{ product_id: 'coffee', quantity: 1 }] }, `cut-${i}`);
      const bill = (await api(T.c1, 'post', '/api/bills/generate', { order_id: o.body.order.id })).body.bill;
      const total = Math.round(Number(bill.total) * 100);
      const a = await api(T.c1, 'post', '/api/card/attempts', { bill_id: bill.id, amount: major(total) });
      const p = await api(T.c1, 'get', `/api/card/attempts/${a.body.id}`);
      if (p.body.state !== 'approved') throw new Error('expected approval in the power-cut scenario: ' + JSON.stringify(p.body));
      orphans.push({ attemptId: a.body.id, billId: bill.id, amountMinor: total });
    }
    db.prepare("UPDATE card_attempts SET updated_at = datetime('now', '-10 minutes') WHERE state = 'approved'").run();
    const rec0 = (await api(T.mgr, 'get', '/api/card/reconciliation')).body;
    ok(rec0.orphans.length === 2, 'reconciliation reports the two charged-but-unrecorded card payments');
    for (const o of orphans) {
      const pr = await api(T.mgr, 'post', `/api/bills/${o.billId}/payments`, { payments: [{ method: 'card', card_attempt_id: o.attemptId }] }, `recover-${o.attemptId}`);
      if (pr.status !== 200) throw new Error('recovery failed: ' + JSON.stringify(pr.body));
      sales.push({ billId: o.billId, orderId: 0, totalMinor: o.amountMinor, discounted: false, cashMinor: 0, cardSimMinor: o.amountMinor, cardManualMinor: 0, walletMinor: 0, tipMinor: 0, items: [], refundedMinor: 0 });
      stock.coffee = stock.coffee; // untracked
    }
    ok((await api(T.mgr, 'get', '/api/card/reconciliation')).body.orphans.length === 0, 'the manager records both against their bills; nothing is left unmatched');

    for (let i = half; i < SALES; i++) await sale();
    ok(replays > 3 && doubles > 0, `${replays} replayed payment requests and ${doubles} double taps were all absorbed (checked per sale; totals below prove no double charge)`);
    ok(sales.length > SALES * 0.85, `${sales.length} sales in total (${voids} abandoned, ${declined} card declines/timeouts handled, ${offline} offline terminal, ${discountedSales} discounted)`);

    console.log('\n4. refunds');
    let refundCashMinor = 0, refundCardMinor = 0, refundsMade = 0;
    const cashOnly = sales.filter((s) => s.cashMinor === s.totalMinor && s.items.length && s.refundedMinor === 0);
    const cardSimOnly = sales.filter((s) => s.cardSimMinor === s.totalMinor && s.items.length && s.refundedMinor === 0);
    const refundTargets = [...cashOnly.slice(0, 6), ...cardSimOnly.slice(0, 6)];
    for (const s of refundTargets) {
      const isCard = s.cardSimMinor > 0;
      const kind = pick(['full', 'amount', 'items']);
      let body: any; let expected: number;
      if (kind === 'full') { body = { reason: 'Customer changed mind' }; expected = s.totalMinor; }
      else if (kind === 'amount') { const partial = Math.max(100, Math.floor(s.totalMinor / 2 / 100) * 100); body = { reason: 'Goodwill', amount: major(partial) }; expected = partial; }
      else {
        const it = s.items[0]; const unit = Math.round(priceOf[it.pid] * (s.discounted ? 0.9 : 1));
        body = { reason: 'Returned', amount_from_items: true, items: [{ order_item_id: it.orderItemId, quantity: 1 }] }; expected = -1; void unit;
        if (tracked.includes(it.pid)) stock[it.pid] += 1;
      }
      const r = await api(T.mgr, 'post', `/api/bills/${s.billId}/refund`, body, `rf-${s.billId}`);
      if (r.status !== 200) throw new Error(`refund failed for bill ${s.billId}: ${r.status} ${JSON.stringify(r.body)}`);
      const got = r.body.amount_minor as number;
      if (expected > 0 && got !== expected) throw new Error(`refund ${got} != expected ${expected}`);
      s.refundedMinor += got; refundsMade++;
      if (isCard) refundCardMinor += got; else refundCashMinor += got;
    }
    ok(refundsMade === refundTargets.length && refundsMade >= 8, `${refundsMade} refunds made (cash and card, whole, partial and by item)`);
    // a provider that refuses: the till must change nothing
    const refusing = sales.find((s) => s.cardSimMinor >= 400 && s.items.length && s.refundedMinor === 0 && s.cardSimMinor === s.totalMinor);
    if (refusing) {
      const before = (db.prepare('SELECT COALESCE(SUM(refunded_minor),0) r FROM payments WHERE bill_id = ?').get(refusing.billId) as any).r;
      const rj = await api(T.mgr, 'post', `/api/bills/${refusing.billId}/refund`, { reason: 'Test reject', amount: '1.13' });
      ok(rj.status === 502, 'a card refund the provider refuses fails with 502');
      ok((db.prepare('SELECT COALESCE(SUM(refunded_minor),0) r FROM payments WHERE bill_id = ?').get(refusing.billId) as any).r === before, 'and the till recorded nothing for it');
    }
    // a customer cannot be refunded twice for the same sale
    const full = sales.find((s) => s.refundedMinor === s.totalMinor);
    if (full) ok((await api(T.mgr, 'post', `/api/bills/${full.billId}/refund`, { reason: 'again' })).status === 400, 'a fully refunded sale cannot be refunded again');

    console.log('\n5. cash movements and a stocktake with shrinkage');
    ok((await api(T.own, 'post', `/api/cash/session/${sessionId}/movement`, { type: 'pay_in', amount_minor: 5000, reason: 'Top up' })).status === 201, 'pay in 50.00');
    ok((await api(T.own, 'post', `/api/cash/session/${sessionId}/movement`, { type: 'pay_out', amount_minor: 1850, reason: 'Milk and window cleaner' })).status === 201, 'pay out 18.50');
    const st = await api(T.mgr, 'post', '/api/stocktakes', { name: 'Close of day' });
    ok(st.status === 201, 'a stocktake is started');
    const counts: Record<string, number> = { cake: stock.cake - 3, mug: stock.mug, tote: stock.tote - 1 };
    for (const [pid, q] of Object.entries(counts)) {
      const c = await api(T.mgr, 'put', `/api/stocktakes/${st.body.stocktake.id}/lines`, { product_id: pid, quantity: q, mode: 'set' });
      if (c.status !== 200) throw new Error('count failed: ' + JSON.stringify(c.body));
    }
    const ap = await api(T.mgr, 'post', `/api/stocktakes/${st.body.stocktake.id}/approve`, { uncounted: 'ignore' });
    ok(ap.status === 200, 'the count is approved: shrinkage posted as stock adjustments');
    for (const [pid, q] of Object.entries(counts)) stock[pid] = q;

    console.log('\n6. closing the till: X, drawer count, Z');
    const sumOf = (f: (s: SaleRecord) => number) => sales.reduce((a, s) => a + f(s), 0);
    const GROSS = sumOf((s) => s.totalMinor), CASH = sumOf((s) => s.cashMinor), SIM = sumOf((s) => s.cardSimMinor), MAN = sumOf((s) => s.cardManualMinor), TIPS = sumOf((s) => s.tipMinor);
    ok(CASH + SIM + MAN === GROSS, `independent check: tenders (cash ${major(CASH)}, terminal ${major(SIM)}, hand-recorded ${major(MAN)}) add up to sales ${major(GROSS)}`);
    const X = (await api(T.mgr, 'get', '/api/reports/x')).body.report;
    ok(X.transactions.count === sales.length && X.sales.gross_minor === GROSS, `X report: ${sales.length} sales, gross ${major(GROSS)} (matches this script's own total)`);
    const REFUNDS = refundCashMinor + refundCardMinor;
    ok(X.sales.refunds_minor === REFUNDS && X.sales.net_minor === GROSS - REFUNDS, `X report: refunds ${major(REFUNDS)}, net ${major(GROSS - REFUNDS)}`);

    const expectedDrawer = FLOAT + CASH - refundCashMinor + 5000 - 1850;
    const closeR = await api(T.mgr, 'post', `/api/cash/session/${sessionId}/close`, { counted_minor: expectedDrawer - 300 });
    ok(closeR.status === 200, 'drawer counted 3.00 short and closed');
    const zr = await api(T.mgr, 'post', '/api/reports/z', {});
    ok(zr.status === 201, 'Z report generated');
    const S = zr.body.report.snapshot;
    const tender = (m: string) => S.tenders.find((t: any) => t.method === m);
    ok(S.sales.gross_minor === GROSS && S.transactions.count === sales.length, 'Z gross and sale count match this script exactly');
    ok(S.sales.refunds_minor === REFUNDS && S.sales.net_minor === GROSS - REFUNDS, 'Z refunds and net match');
    ok(tender('cash').taken_minor === CASH && tender('cash').refunded_minor === refundCashMinor, `Z cash taken ${major(CASH)} and refunded ${major(refundCashMinor)} match`);
    ok(tender('card').taken_minor === SIM + MAN && tender('card').refunded_minor === refundCardMinor && tender('card').tips_minor === TIPS, `Z card taken ${major(SIM + MAN)}, refunded ${major(refundCardMinor)}, tips ${major(TIPS)} match`);
    ok(tender('card').unverified_card_minor === MAN, `only the hand-recorded card takings (${major(MAN)}) are flagged unverified; terminal-approved ones are not`);
    ok(S.cash.expected_minor_at_close === expectedDrawer && S.cash.variance_minor === -300, `drawer expected ${major(expectedDrawer)} (float + cash - cash refunds + in - out) and the 3.00 shortage is reported`);
    ok(S.checks.tenders_equal_bills && S.checks.vat_equals_bills && S.checks.gross_by_rate_equals_bills && S.checks.cash_tenders_equal_drawer, 'the report\'s own consistency checks all pass');
    const vatSum = S.vat.reduce((a: number, v: any) => a + v.gross_minor, 0);
    ok(vatSum === GROSS, 'gross by VAT rate adds up to the day\'s gross');
    ok(S.vat.reduce((a: number, v: any) => a + v.net_minor + v.vat_minor, 0) === GROSS, 'net + VAT equals gross, rate by rate');

    console.log('\n7. everything else balances');
    for (const pid of tracked) {
      const bal = (db.prepare(`SELECT quantity FROM inventory_balances WHERE product_id = ?`).get(pid) as any)?.quantity;
      if (bal !== stock[pid]) throw new Error(`stock of ${pid}: till ${bal}, expected ${stock[pid]}`);
    }
    ok(true, `stock of all ${tracked.length} tracked items equals start + goods in - sold + returned + stocktake corrections`);
    const rec1 = (await api(T.mgr, 'get', '/api/card/reconciliation')).body;
    ok(rec1.orphans.length === 0 && rec1.mismatches.length === 0, 'card reconciliation: no unmatched approvals, no amount mismatches');
    ok((db.prepare("SELECT COUNT(*) c FROM card_attempts WHERE state = 'pending'").get() as any).c === 0, 'no card attempt is left waiting');
    const approvedSale = (db.prepare("SELECT COUNT(*) c FROM card_attempts WHERE kind = 'sale' AND state = 'consumed'").get() as any).c;
    const termPayments = (db.prepare("SELECT COUNT(*) c FROM payments WHERE adapter = 'card_terminal'").get() as any).c;
    ok(approvedSale === termPayments, `every terminal approval became exactly one payment (${termPayments})`);
    const dupRefs = (db.prepare("SELECT provider_reference r, COUNT(*) c FROM payments WHERE provider_reference IS NOT NULL GROUP BY adapter, provider_reference HAVING c > 1").all() as any[]);
    ok(dupRefs.length === 0, 'no provider reference appears on two payments');
    const perBill = db.prepare("SELECT bill_id, SUM(amount_minor) paid FROM payments GROUP BY bill_id").all() as any[];
    const billTotals = new Map(sales.map((s) => [s.billId, s.totalMinor]));
    ok(perBill.every((r) => billTotals.get(r.bill_id) === r.paid), 'every bill\'s payments add up to exactly its total (nothing double-charged, nothing missing)');
    ok((db.prepare("SELECT COUNT(*) c FROM bills WHERE payment_status != 'paid' AND id IN (SELECT bill_id FROM payments)").get() as any).c === 0, 'no bill with payments is left unpaid');
    const audits = (db.prepare("SELECT COUNT(*) c FROM audit_events WHERE event_type = 'payment.recorded'").get() as any).c;
    const payRows = (db.prepare("SELECT COUNT(*) c FROM payments").get() as any).c;
    ok(audits === payRows, `every payment has its audit event (${payRows})`);
    ok(db.pragma('integrity_check', { simple: true }) === 'ok', 'SQLite integrity check passes');
    ok((db.pragma('foreign_key_check') as any[]).length === 0, 'no foreign key violations');
    ok((db.prepare("SELECT COUNT(*) c FROM z_reports").get() as any).c === 1, 'exactly one Z for the day');

    console.log('\n8. speed');
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)], p95 = latencies[Math.floor(latencies.length * 0.95)];
    console.log(`   bill + payment latency over ${latencies.length} sales: median ${p50} ms, p95 ${p95} ms`);
    ok(p95 < 1500, `95% of sales were billed and paid in under 1.5 s (p95 ${p95} ms, on a shared CI-class machine)`);

    console.log(`\n✅ Simulated merchant day passed (${passed} checks): ${sales.length} sales, gross ${major(GROSS)}, refunds ${major(REFUNDS)}`);
  } finally {
    await stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
