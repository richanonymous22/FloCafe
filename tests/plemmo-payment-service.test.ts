/**
 * Test: Plemmo Core PaymentService (main/core/payment.ts)
 *
 * Two halves:
 *
 *   1. Unit tests of the standalone entry points — tender(), voidPayment(),
 *      refundPayment() and the adapters — none of which are wired to any live
 *      route in this milestone. These are what a future retail checkout (or a
 *      later migration of the bills.ts payment routes) will call.
 *
 *   2. An HTTP-level integration test proving the additive dual-write actually
 *      fires from the real, unmodified POST /bills/:id/payment(s) endpoints —
 *      that a cash payment through the legacy path produces a matching
 *      `payments` row with state 'settled', and a card payment produces one
 *      with state 'captured', not 'settled' (the whole point of this file).
 *
 * Usage: node tests/run-electron-node-test.cjs tests/plemmo-payment-service.test.ts
 */

// ── Electron Mock (must be before any app imports) ───────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plemmo-payment-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct,
  api, assert, assertEqual,
  getResults, closeDatabase, now,
} = require('./helpers/test-setup');

const {
  tender, voidPayment, refundPayment, getPaymentAdapter,
  CashAdapter, WalletAdapter, ManualCardAdapter,
  PaymentError, getPayment, listPaymentsForBill, listPaymentEvents, listRefundsForPayment,
} = require('../main/core/payment');
const { isUlid } = require('../main/core/ids');
const { listAuditEventsForEntity, resetAuditPlaceCache } = require('../main/core/audit');
const { withTxn } = require('../main/db');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');

async function main() {
  console.log('Test: Plemmo Core PaymentService');
  console.log('='.repeat(50));

  const db = initTestDb();
  resetAuditPlaceCache();
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES ('u-payer','Cashier','payer@t.local','x','cashier',1,?,?)`).run(now(), now());

  let fixtureCounter = 0;
  function uniqueSuffix(): string { return String(++fixtureCounter).padStart(6, '0'); }
  function makeBill(total: number): { billId: number; orderId: number } {
    const orderResult = db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at) VALUES (?, 'takeaway', 'pending', ?, ?, ?, ?)`)
      .run(`ORD-${uniqueSuffix()}`, total, total, now(), now());
    const orderId = Number(orderResult.lastInsertRowid);
    const billResult = db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, total, balance, payment_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'unpaid', ?, ?)`)
      .run(`BILL-${uniqueSuffix()}`, orderId, total, total, total, now(), now());
    return { billId: Number(billResult.lastInsertRowid), orderId };
  }

  // ── 1. Adapters ──────────────────────────────────────────────────────────
  console.log('\n1. Adapters');
  assertEqual(CashAdapter.id, 'cash', 'CashAdapter identifies itself');
  assertEqual(WalletAdapter.id, 'wallet', 'WalletAdapter identifies itself');
  assertEqual(ManualCardAdapter.id, 'manual_card', 'ManualCardAdapter identifies itself');

  const cashResult = CashAdapter.capture({ adapter: 'cash', method: 'cash', amountMinor: 500, currency: 'GBP' });
  assertEqual(cashResult.state, 'settled', 'cash settles immediately — no external party to wait on');

  const walletResult = WalletAdapter.capture({ adapter: 'wallet', method: 'wallet', amountMinor: 200, currency: 'GBP' });
  assertEqual(walletResult.state, 'settled', 'an internal wallet debit settles immediately — fully in-process');

  const cardResult = ManualCardAdapter.capture({ adapter: 'manual_card', method: 'card', amountMinor: 1000, currency: 'GBP', providerReference: 'TERM-123' });
  assertEqual(cardResult.state, 'captured', '"recorded" must not automatically mean "definitely settled" — a manual card entry lands on captured, not settled');
  assertEqual(cardResult.providerReference, 'TERM-123', 'the terminal reference is carried through');

  assertEqual(getPaymentAdapter('cash').id, 'cash', 'getPaymentAdapter resolves by id');
  let unknownAdapterErr: any = null;
  try { getPaymentAdapter('teya' as any); } catch (e) { unknownAdapterErr = e; }
  assert(!!unknownAdapterErr, 'an unregistered adapter id throws — no real provider adapters exist yet');

  // ── 2. tender(): cash ────────────────────────────────────────────────────
  console.log('\n2. tender(): cash');
  const { billId: cashBillId, orderId: cashOrderId } = makeBill(5.0);
  const cashTender = tender({
    billId: cashBillId, orderId: cashOrderId,
    tender: { adapter: 'cash', method: 'cash', amountMinor: 500, currency: 'GBP', tenderedMinor: 1000 },
    actorUserId: 'u-payer',
  });
  assertEqual(cashTender.idempotentReplay, false, 'a fresh tender is not a replay');
  assert(isUlid(cashTender.payment.id), 'the payment receives a ULID id — a brand-new table, so ULID is the primary key directly');
  assertEqual(cashTender.payment.state, 'settled', 'cash settles immediately');
  assertEqual(cashTender.payment.amount_minor, 500, 'the amount is stored in minor units');
  assertEqual(cashTender.payment.currency, 'GBP', 'the currency is stored');
  assertEqual(cashTender.payment.change_minor, 500, 'change is tendered minus amount: 1000 - 500 = 500');
  assertEqual(cashTender.payment.refunded_minor, 0, 'a fresh payment has no refund against it');
  assert(!!cashTender.payment.settled_at, 'settled_at is stamped for a settled payment');

  const cashEvents = listPaymentEvents(cashTender.payment.id);
  assertEqual(cashEvents.length, 1, 'one state-transition event is recorded for a payment that settles on capture');
  assertEqual(cashEvents[0].from_state, null, 'the first event has no prior state');
  assertEqual(cashEvents[0].to_state, 'settled', 'the event records the transition into settled');

  const cashAudit = listAuditEventsForEntity('payment', cashTender.payment.id);
  assertEqual(cashAudit.length, 1, 'a payment.recorded audit event is written');
  assertEqual(cashAudit[0].event_type, 'payment.recorded', 'the audit event has the right type');
  assertEqual(cashAudit[0].actor_user_id, 'u-payer', 'the audit event attributes the cashier');

  // ── 3. tender(): manual card ─────────────────────────────────────────────
  console.log('\n3. tender(): manual card');
  const { billId: cardBillId, orderId: cardOrderId } = makeBill(10.0);
  const cardTender = tender({
    billId: cardBillId, orderId: cardOrderId,
    tender: { adapter: 'manual_card', method: 'card', amountMinor: 1000, currency: 'GBP', providerReference: 'REF-99' },
    actorUserId: 'u-payer',
  });
  assertEqual(cardTender.payment.state, 'captured', 'a manual card tender lands on captured, never settled');
  assertEqual(cardTender.payment.settled_at, null, 'settled_at stays null for a captured (not settled) payment');
  assertEqual(cardTender.payment.provider_reference, 'REF-99', 'the provider reference is stored');

  // ── 4. tender(): rejection cases ─────────────────────────────────────────
  console.log('\n4. tender(): rejection cases');
  const { billId: rejectBillId } = makeBill(5.0);
  const rejectsTender = (input: any, expectedStatus: number | undefined, label: string) => {
    let err: any = null;
    try { tender(input); } catch (e) { err = e; }
    assert(!!err, `${label} throws`);
    assert(err instanceof PaymentError, `${label} throws a PaymentError`);
    assertEqual(err.statusCode, expectedStatus, `${label} carries the expected status`);
  };
  rejectsTender({ billId: rejectBillId, tender: { adapter: 'cash', method: 'cash', amountMinor: 0, currency: 'GBP' } }, 400, 'a zero amount');
  rejectsTender({ billId: rejectBillId, tender: { adapter: 'cash', method: 'cash', amountMinor: -100, currency: 'GBP' } }, 400, 'a negative amount');
  rejectsTender({ billId: rejectBillId, tender: { adapter: 'cash', method: 'cash', amountMinor: 1.5, currency: 'GBP' } }, 400, 'a non-integer amount');
  rejectsTender({ billId: rejectBillId, tender: { adapter: 'cash', method: 'cash', amountMinor: 500, currency: '' } }, 400, 'a missing currency');
  rejectsTender({ billId: 9999999, tender: { adapter: 'cash', method: 'cash', amountMinor: 500, currency: 'GBP' } }, 404, 'a nonexistent bill');

  const { billId: paidBillId } = makeBill(5.0);
  db.prepare(`UPDATE bills SET payment_status = 'paid' WHERE id = ?`).run(paidBillId);
  rejectsTender({ billId: paidBillId, tender: { adapter: 'cash', method: 'cash', amountMinor: 500, currency: 'GBP' } }, 400, 'a bill that is already paid');

  // ── 5. tender(): rollback ────────────────────────────────────────────────
  console.log('\n5. tender(): rollback');
  const paymentsBefore = (db.prepare('SELECT COUNT(*) AS c FROM payments').get() as any).c;
  let rollbackErr: any = null;
  try {
    withTxn(() => {
      tender({ billId: rejectBillId, tender: { adapter: 'cash', method: 'cash', amountMinor: 500, currency: 'GBP' } });
      throw new Error('simulated failure after a successful tender');
    });
  } catch (e) { rollbackErr = e; }
  assert(!!rollbackErr, 'the outer transaction failed as expected');
  assertEqual((db.prepare('SELECT COUNT(*) AS c FROM payments').get() as any).c, paymentsBefore,
    'a payment written inside a transaction that is later rolled back does not survive');

  // ── 6. tender(): idempotency ─────────────────────────────────────────────
  console.log('\n6. tender(): idempotency (reuses the existing payment_idempotency table)');
  const { billId: idemBillId } = makeBill(5.0);
  const tenderIdem = { key: 'tender-key-1', requestHash: 'hash-1', userId: 'u-payer' };
  const firstTender = tender({ billId: idemBillId, tender: { adapter: 'cash', method: 'cash', amountMinor: 500, currency: 'GBP' }, idempotency: tenderIdem });
  assertEqual(firstTender.idempotentReplay, false, 'the first call tenders');
  const replayTender = tender({ billId: idemBillId, tender: { adapter: 'cash', method: 'cash', amountMinor: 500, currency: 'GBP' }, idempotency: tenderIdem });
  assertEqual(replayTender.idempotentReplay, true, 'the same key replays instead of tendering again');
  assertEqual(replayTender.payment.id, firstTender.payment.id, 'the replay returns the original payment');
  assertEqual(listPaymentsForBill(idemBillId).length, 1, 'a replay does not insert a second payment row');
  let conflictErr: any = null;
  try {
    tender({ billId: idemBillId, tender: { adapter: 'cash', method: 'cash', amountMinor: 999, currency: 'GBP' }, idempotency: { ...tenderIdem, requestHash: 'different' } });
  } catch (e) { conflictErr = e; }
  assert(!!conflictErr, 'reusing a key with a different request throws');
  assertEqual(conflictErr.statusCode, 409, 'a key reused for a different request is a 409');

  // ── 7. voidPayment() ─────────────────────────────────────────────────────
  console.log('\n7. voidPayment()');
  const { billId: voidBillId, orderId: voidOrderId } = makeBill(10.0);
  const toVoid = tender({ billId: voidBillId, orderId: voidOrderId, tender: { adapter: 'manual_card', method: 'card', amountMinor: 1000, currency: 'GBP' } });
  assertEqual(toVoid.payment.state, 'captured', 'a manual card payment starts captured, which is voidable');
  const voided = voidPayment({ paymentId: toVoid.payment.id, reason: 'cashier error', actorUserId: 'u-payer' });
  assertEqual(voided.idempotentReplay, false, 'a fresh void is not a replay');
  assertEqual(voided.payment.state, 'voided', 'the payment moves to voided');
  assert(!!voided.payment.voided_at, 'voided_at is stamped');
  const voidEvents = listPaymentEvents(toVoid.payment.id);
  assertEqual(voidEvents[voidEvents.length - 1].to_state, 'voided', 'a payment_events row records the void transition');
  const voidAudit = listAuditEventsForEntity('payment', toVoid.payment.id);
  assert(voidAudit.some((e: any) => e.event_type === 'payment.voided'), 'a payment.voided audit event is written');

  let voidSettledErr: any = null;
  try { voidPayment({ paymentId: cashTender.payment.id }); } catch (e) { voidSettledErr = e; }
  assert(!!voidSettledErr, 'voiding a settled (cash) payment is refused');
  assertEqual(voidSettledErr.statusCode, 400, 'voiding a settled payment is a 400 — refund it instead');

  let voidAlreadyVoidedErr: any = null;
  try { voidPayment({ paymentId: toVoid.payment.id }); } catch (e) { voidAlreadyVoidedErr = e; }
  assert(!!voidAlreadyVoidedErr, 'voiding an already-voided payment is refused');

  // ── 8. refundPayment() ───────────────────────────────────────────────────
  console.log('\n8. refundPayment()');
  const { billId: refundBillId, orderId: refundOrderId } = makeBill(10.0);
  const toRefund = tender({ billId: refundBillId, orderId: refundOrderId, tender: { adapter: 'cash', method: 'cash', amountMinor: 1000, currency: 'GBP' } });
  assertEqual(toRefund.payment.state, 'settled', 'a cash payment settles, which is refundable');

  const partialRefund = refundPayment({ paymentId: toRefund.payment.id, amountMinor: 400, reason: 'item returned', actorUserId: 'u-payer' });
  assertEqual(partialRefund.idempotentReplay, false, 'a fresh refund is not a replay');
  assert(isUlid(partialRefund.refund.id), 'the refund receives a ULID id');
  assertEqual(partialRefund.refund.amount_minor, 400, 'the refund amount is stored');
  assertEqual(partialRefund.refund.state, 'settled', 'a refund settles immediately in this foundation (no provider integration yet)');
  assertEqual(partialRefund.payment.refunded_minor, 400, 'the payment tracks the running refunded total');
  assertEqual(partialRefund.payment.state, 'settled', 'a partial refund does not change the payment state');

  const fullRefund = refundPayment({ paymentId: toRefund.payment.id, amountMinor: 600, actorUserId: 'u-payer' });
  assertEqual(fullRefund.payment.refunded_minor, 1000, 'the second refund brings the running total to the full amount');
  assertEqual(fullRefund.payment.state, 'refunded', 'once fully refunded, the payment state moves to refunded');

  const refundHistory = listRefundsForPayment(toRefund.payment.id);
  assertEqual(refundHistory.length, 2, 'both refunds are recorded, oldest first');
  const refundAudit = listAuditEventsForEntity('payment', toRefund.payment.id);
  assertEqual(refundAudit.filter((e: any) => e.event_type === 'sale.refunded').length, 2, 'a sale.refunded audit event is written for each refund');

  let overRefundErr: any = null;
  try { refundPayment({ paymentId: toRefund.payment.id, amountMinor: 1 }); } catch (e) { overRefundErr = e; }
  assert(!!overRefundErr, 'refunding beyond the unrefunded balance is refused');
  assertEqual(overRefundErr.statusCode, 400, 'over-refunding is a 400');

  let refundVoidedErr: any = null;
  try { refundPayment({ paymentId: toVoid.payment.id, amountMinor: 100 }); } catch (e) { refundVoidedErr = e; }
  assert(!!refundVoidedErr, 'refunding a voided payment is refused — there is nothing to give back');

  // ── 9. refundPayment(): does not touch inventory ─────────────────────────
  console.log('\n9. refundPayment(): stays inside the payment boundary');
  db.prepare(`INSERT INTO categories (id, name, created_at, updated_at) VALUES ('cat-r','Cat',?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, sku, is_active, track_inventory, stock_quantity, created_at, updated_at) VALUES ('prod-r','cat-r','Widget',5,'SKU-R',1,1,10,?,?)`).run(now(), now());
  const stockBefore = (db.prepare("SELECT stock_quantity AS q FROM products WHERE id = 'prod-r'").get() as any).q;
  const { billId: invBillId } = makeBill(5.0);
  const invPayment = tender({ billId: invBillId, tender: { adapter: 'cash', method: 'cash', amountMinor: 500, currency: 'GBP' } });
  refundPayment({ paymentId: invPayment.payment.id, amountMinor: 500 });
  const stockAfter = (db.prepare("SELECT stock_quantity AS q FROM products WHERE id = 'prod-r'").get() as any).q;
  assertEqual(stockAfter, stockBefore, 'refundPayment does not touch products.stock_quantity — that boundary is deliberately left for a later InventoryService/RefundService milestone');

  // ── 10. Queries ───────────────────────────────────────────────────────────
  console.log('\n10. Queries');
  assert(getPayment(toRefund.payment.id) !== null, 'getPayment finds an existing payment');
  assert(getPayment('does-not-exist') === null, 'getPayment returns null, not throw, for an unknown id');
  assertEqual(listPaymentsForBill(cashBillId).length, 1, 'listPaymentsForBill returns the payments for a bill');

  // ── 11. Service boundary ─────────────────────────────────────────────────
  console.log('\n11. Service boundary');
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'core', 'payment.ts'), 'utf8');
  assert(!/from ['"]express['"]/.test(source), 'PaymentService does not import Express');
  assert(!/\breq\.|\bres\.status\(/.test(source), 'PaymentService never touches a Request or Response');
  assert(!/from ['"]react/.test(source) && !source.includes('@/'), 'PaymentService has no frontend imports');
  assert(new PaymentError('x', 400) instanceof Error, 'PaymentError is a real Error subclass');

  closeDatabase();

  // ══════════════════════════════════════════════════════════════════════
  // Part 2: HTTP-level — the dual-write actually fires from the real,
  // unmodified legacy payment routes.
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n\nHTTP integration: dual-write from the legacy payment routes');
  console.log('='.repeat(50));

  const db2 = initTestDb();
  const { authHeader } = seedOwnerUser(db2);
  seedCategory(db2, 'cat-dw', 'Dual-write');
  seedProduct(db2, 'prod-dw', 'cat-dw', 'Sandwich', 500);

  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n12. Cash payment through POST /bills/:id/payment produces a settled payments row');
    const order1 = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-dw', quantity: 1 }] }, headers: authHeader,
    });
    assertEqual(order1.status, 201, 'order created via the real HTTP route');
    const bill1 = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: order1.data.order.id }, headers: authHeader });
    assertEqual(bill1.status, 201, 'bill generated');
    const pay1 = await api(baseUrl, `/api/bills/${bill1.data.bill.id}/payment`, { method: 'POST', body: { method: 'cash', amount: bill1.data.bill.total }, headers: authHeader });
    assertEqual(pay1.status, 200, 'the legacy payment route succeeds, completely unmodified in its own logic');
    assertEqual(pay1.data.bill.payment_status, 'paid', 'the bill is paid — this is the existing, unchanged behaviour');

    const dbPayments = listPaymentsForBill(bill1.data.bill.id);
    assertEqual(dbPayments.length, 1, 'the dual-write produced exactly one payments row for one cash tender');
    assertEqual(dbPayments[0].adapter, 'cash', 'the dual-write correctly mapped method "cash" to the cash adapter');
    assertEqual(dbPayments[0].state, 'settled', 'a cash payment through the legacy route is recorded as settled in the new model too');
    const expectedMinor = Math.round(Number(bill1.data.bill.total) * 100);
    assertEqual(dbPayments[0].amount_minor, expectedMinor, 'the dual-write mirrors the exact amount the legacy path computed');

    console.log('\n13. Card payment through the legacy route lands on captured, not settled');
    const order2 = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-dw', quantity: 2 }] }, headers: authHeader,
    });
    const bill2 = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: order2.data.order.id }, headers: authHeader });
    const pay2 = await api(baseUrl, `/api/bills/${bill2.data.bill.id}/payment`, { method: 'POST', body: { method: 'card', amount: bill2.data.bill.total, transaction_id: 'CARD-REF-1' }, headers: authHeader });
    assertEqual(pay2.status, 200, 'the card payment succeeds through the unmodified legacy route');
    const cardDbPayments = listPaymentsForBill(bill2.data.bill.id);
    assertEqual(cardDbPayments.length, 1, 'one dual-written row for the card tender');
    assertEqual(cardDbPayments[0].adapter, 'manual_card', 'a non-cash, non-wallet method maps to the manual card adapter');
    assertEqual(cardDbPayments[0].state, 'captured', 'a real-world "recorded" card payment through the legacy path is honestly represented as captured, not settled — the whole point of this module');
    assertEqual(cardDbPayments[0].provider_reference, 'CARD-REF-1', 'the transaction_id the merchant typed in is carried through as the provider reference');

    console.log('\n14. Split payment produces one dual-written row per tender line');
    const order3 = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-dw', quantity: 4 }] }, headers: authHeader,
    });
    const bill3 = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: order3.data.order.id }, headers: authHeader });
    const total3 = Number(bill3.data.bill.total);
    const cashPart = Math.floor(total3 * 100 / 2) / 100;
    const cardPart = Number((total3 - cashPart).toFixed(2));
    const pay3 = await api(baseUrl, `/api/bills/${bill3.data.bill.id}/payments`, {
      method: 'POST',
      body: { payments: [{ method: 'cash', amount: cashPart }, { method: 'card', amount: cardPart, transaction_id: 'CARD-REF-2' }] },
      headers: authHeader,
    });
    assertEqual(pay3.status, 200, 'the split payment succeeds through the unmodified legacy route');
    const splitDbPayments = listPaymentsForBill(bill3.data.bill.id);
    assertEqual(splitDbPayments.length, 2, 'two payment lines produce two dual-written payments rows');
    assert(splitDbPayments.some((p: any) => p.adapter === 'cash' && p.state === 'settled'), 'the cash line is settled');
    assert(splitDbPayments.some((p: any) => p.adapter === 'manual_card' && p.state === 'captured'), 'the card line is captured');

    console.log('\n15. A retried request (same Idempotency-Key) does not duplicate dual-written payments');
    const order4 = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-dw', quantity: 1 }] }, headers: authHeader,
    });
    const bill4 = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: order4.data.order.id }, headers: authHeader });
    const idemHeaders = { ...authHeader, 'Idempotency-Key': 'http-retry-key-1' };
    const firstAttempt = await api(baseUrl, `/api/bills/${bill4.data.bill.id}/payment`, { method: 'POST', body: { method: 'cash', amount: bill4.data.bill.total }, headers: idemHeaders });
    assertEqual(firstAttempt.status, 200, 'the first attempt succeeds');
    const retryAttempt = await api(baseUrl, `/api/bills/${bill4.data.bill.id}/payment`, { method: 'POST', body: { method: 'cash', amount: bill4.data.bill.total }, headers: idemHeaders });
    assertEqual(retryAttempt.status, 200, 'the retried attempt also succeeds (replay)');
    assertEqual(listPaymentsForBill(bill4.data.bill.id).length, 1,
      'the dual-write inherits idempotency from applyPaymentBatch\'s own replay path — a network retry does not produce a duplicate row');

    console.log('\n16. SYNC-0: the dual-write is now authoritative — a payment either lands in BOTH models or NEITHER');
    // SYNC-0 (Part A3) deliberately REVERSES the pre-SYNC behavior this test
    // used to assert. Before SYNC-0 the dual-write swallowed all errors, so a
    // payment could commit to bills.payment_details while its payment_event
    // was silently lost — the Milestone 9A review's biggest sync blocker. The
    // authoritative model must never be silently incomplete: if the payments
    // table cannot record the payment, the ENTIRE payment (including the
    // legacy payment_details write) rolls back. Proven end-to-end by renaming
    // the table out from under the hook and confirming the payment fails
    // atomically and the bill stays unpaid.
    db2.exec('ALTER TABLE payments RENAME TO payments_hidden_for_test');
    const order5 = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-dw', quantity: 1 }] }, headers: authHeader,
    });
    const bill5 = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: order5.data.order.id }, headers: authHeader });
    const pay5 = await api(baseUrl, `/api/bills/${bill5.data.bill.id}/payment`, { method: 'POST', body: { method: 'cash', amount: bill5.data.bill.total }, headers: authHeader });
    assertEqual(pay5.status, 500, 'the payment now FAILS when the authoritative payments model is unavailable — silent data loss is not allowed (SYNC-0 Part A3)');
    const bill5After = db2.prepare('SELECT payment_status, payment_details FROM bills WHERE id = ?').get(Number(bill5.data.bill.id)) as { payment_status: string; payment_details: string | null };
    assertEqual(bill5After.payment_status, 'unpaid', 'the bill remains unpaid — the legacy payment_details write rolled back atomically with the failed authoritative write');
    assertEqual(bill5After.payment_details, null, 'no partial payment_details survives the rollback');
    db2.exec('ALTER TABLE payments_hidden_for_test RENAME TO payments');

    console.log('\n17. Retail compatibility: the full Core chain works with no table and no hospitality import');
    // Part 13's contract: Product -> Cart -> SaleService -> addItems -> bill
    // -> PaymentService -> receipt, with no table required, no kitchen
    // required, and no hospitality import anywhere in the chain. SaleService
    // and PaymentService are exercised here exactly as a future retail
    // checkout would call them; bill generation still goes through the
    // existing (unmigrated) route, which is fine — it is infrastructure this
    // milestone deliberately does not touch, and it requires no table either.
    const retailOrder = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-dw', quantity: 3 }] }, headers: authHeader,
    });
    assertEqual(retailOrder.status, 201, 'a counter sale is created with no table_id in the request at all');
    assertEqual(retailOrder.data.order.table_id, null, 'the created sale has no table — this is the retail shape, not a hospitality one');
    const retailBill = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: retailOrder.data.order.id }, headers: authHeader });
    assertEqual(retailBill.status, 201, 'a bill can be generated for a tableless sale');

    // PaymentService.tender() called directly — not through any HTTP route —
    // exactly as a from-scratch retail payment flow would call it.
    const retailTender = tender({
      billId: retailBill.data.bill.id,
      orderId: retailOrder.data.order.id,
      tender: { adapter: 'cash', method: 'cash', amountMinor: Math.round(Number(retailBill.data.bill.total) * 100), currency: 'GBP' },
      actorUserId: 'u-payer',
    });
    assertEqual(retailTender.payment.state, 'settled', 'PaymentService.tender() settles a cash payment standalone, with no route involved');
    assertEqual(retailTender.payment.order_id, retailOrder.data.order.id, 'the payment correctly links back to the sale SaleService created');
    assertEqual(retailTender.payment.bill_id, retailBill.data.bill.id, 'the payment correctly links to the generated bill');

    const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'core', 'payment.ts'), 'utf8');
    // Narrow to hospitality-specific identifiers, not the English word
    // "tables" — the file legitimately talks about *database* tables.
    assert(!/table_id|kitchen_station|dine_in|guest_count/i.test(source),
      'PaymentService references no hospitality-specific identifier (table_id, kitchen_station, dine_in, guest_count) — it has no hospitality concept in it at all');
  } finally {
    server.close();
  }

  closeDatabase();

  const results = getResults();
  console.log(`\n${results.failed === 0 ? '✅' : '❌'} ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
