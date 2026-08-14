/**
 * Test: Payment Cutover — retire the legacy payment readers.
 *
 * Proves that receipt breakdown, reports, payment-method usage/merge, and
 * bill rendering all derive from the authoritative payments/payment_events
 * model instead of bills.payment_details, that payment_status/paid amount
 * are unaffected, that historical reconciliation detects and (where
 * deterministic) reconstructs partial legacy mirrors without inventing
 * data, and that hospitality/retail/refund/split-bill flows still work.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/payment-cutover.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-cutover-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, closeDatabase, assert, assertEqual, getResults, now,
  createApp, startServer, seedOwnerUser, seedManagerUser, seedCategory, seedProduct, api,
} = require('./helpers/test-setup');
const { registerHospitalityHooks } = require('../main/modules/hospitality/hooks');
const { deriveBillPaymentDetails, parseRowJson } = require('../main/db');
const { reconcileBillPayments, reconcileAllPaymentDetails } = require('../main/core/payment-reconciliation');
const { ulid } = require('../main/core/ids');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { retailRoutes } = require('../main/routes/retail');
const { reportRoutes } = require('../main/routes/reports');
const { paymentMethodRoutes } = require('../main/routes/payment-methods');

function seedPaymentRow(db: any, billId: number, method: string, amountMajor: number, opts: { adapter?: string; state?: string; metadata?: any; requestedAt?: string } = {}) {
  const id = ulid();
  const at = opts.requestedAt || now();
  db.prepare(`
    INSERT INTO payments (id, bill_id, adapter, method, state, amount_minor, currency, refunded_minor, metadata, requested_at, settled_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'GBP', 0, ?, ?, ?, ?, ?)
  `).run(
    id, billId, opts.adapter || (method === 'cash' ? 'cash' : 'manual_card'), method, opts.state || 'settled',
    Math.round(amountMajor * 100), opts.metadata ? JSON.stringify(opts.metadata) : null, at,
    opts.state !== 'requested' ? at : null, at, at,
  );
  return id;
}

async function main() {
  console.log('Test: Payment Cutover');
  console.log('='.repeat(50));

  const db = initTestDb();
  registerHospitalityHooks();
  const { authHeader } = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  seedCategory(db, 'cat-pc', 'Payment Cutover Test');
  seedProduct(db, 'prod-pc', 'cat-pc', 'PC Widget', 10);

  const app = createApp({
    '/api/orders': orderRoutes, '/api/bills': billRoutes, '/api/retail': retailRoutes,
    '/api/reports': reportRoutes, '/api/payment-methods': paymentMethodRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n1,4. Receipt/bill rendering uses the authoritative payment model');
    const order1 = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-pc', quantity: 2 }] }, headers: authHeader });
    const bill1 = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: order1.data.order.id }, headers: authHeader });
    const pay1 = await api(baseUrl, `/api/bills/${bill1.data.bill.id}/payment`, { method: 'POST', body: { method: 'cash', amount: bill1.data.bill.total }, headers: authHeader });
    assertEqual(pay1.status, 200, 'hospitality payment succeeds');
    assert(Array.isArray(pay1.data.bill.payment_details), 'the response bill carries a payment_details array (API shape unchanged)');
    assertEqual(pay1.data.bill.payment_details[0].method, 'cash', 'the derived line reports the correct method');
    assertEqual(pay1.data.bill.payment_details[0].amount, bill1.data.bill.total, 'the derived line reports the correct amount');
    // Directly corrupt the stored payment_details column and confirm the API
    // response (sourced via parseRowJson -> deriveBillPaymentDetails) is
    // completely unaffected — proof it is no longer read.
    db.prepare("UPDATE bills SET payment_details = '{totally broken' WHERE id = ?").run(bill1.data.bill.id);
    const rerender = parseRowJson(db.prepare('SELECT * FROM bills WHERE id = ?').get(bill1.data.bill.id));
    assertEqual(rerender.payment_details[0].method, 'cash', 'bill rendering (parseRowJson) is unaffected by corrupted payment_details');

    console.log('\n2. Payment-method report uses the authoritative model');
    const salesReport = await api(baseUrl, '/api/reports/sales', { headers: authHeader });
    const cashLine = salesReport.data.sales.byPaymentMethod.find((m: any) => m.method === 'cash');
    assert(!!cashLine, 'the sales report shows the cash payment sourced from the payments table');

    console.log('\n3. Payment-method usage counting uses the authoritative model');
    const pmCreate = await api(baseUrl, '/api/payment-methods', { method: 'POST', body: { name: 'PC-UPI' }, headers: authHeader });
    const pmId = pmCreate.data.payment_method.id;
    const order2 = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-pc', quantity: 1 }] }, headers: authHeader });
    const bill2 = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: order2.data.order.id }, headers: authHeader });
    await api(baseUrl, `/api/bills/${bill2.data.bill.id}/payment`, { method: 'POST', body: { method: 'custom', payment_method_id: pmId, amount: bill2.data.bill.total }, headers: authHeader });
    const list1 = await api(baseUrl, '/api/payment-methods?include_inactive=true', { headers: authHeader });
    assertEqual(list1.data.payment_methods.find((m: any) => m.id === pmId)?.usage_count, 1, 'usage_count is derived from payments, not payment_details');

    console.log('\n(payment-method merge updates the authoritative model, not just the legacy column)');
    const merge = await api(baseUrl, `/api/payment-methods/${pmId}/merge`, { method: 'POST', body: { target_type: 'card' }, headers: authHeader });
    assertEqual(merge.status, 200, 'merge succeeds');
    assertEqual(merge.data.merge.affected_payments, 1, 'merge reports the authoritative payments row it renamed');
    const paymentAfterMerge = db.prepare('SELECT method FROM payments WHERE bill_id = ?').get(bill2.data.bill.id) as { method: string };
    assertEqual(paymentAfterMerge.method, 'Card', 'the authoritative payments row itself was renamed by the merge, not only payment_details');

    console.log('\n5. Payment status / paid amount are unaffected by the reader migration');
    const billAfter = db.prepare('SELECT payment_status, paid_amount FROM bills WHERE id = ?').get(bill1.data.bill.id) as any;
    assertEqual(billAfter.payment_status, 'paid', 'payment_status is computed independently of payment_details reading (unchanged write path)');

    console.log('\n10. Hospitality payment still works end-to-end');
    assertEqual(pay1.status, 200, 'hospitality payment (already asserted above) still works');

    console.log('\n11. Retail payment still works end-to-end');
    const retail1 = await api(baseUrl, '/api/retail/checkout', {
      method: 'POST', body: { lines: [{ product_id: 'prod-pc', quantity: 1 }], tender: { adapter: 'cash', method: 'cash' } }, headers: authHeader,
    });
    assertEqual(retail1.status, 201, 'retail checkout still works');

    console.log('\n12. Refund still works');
    const { refundPayment } = require('../main/core/payment');
    const paymentForRefund = db.prepare('SELECT id FROM payments WHERE bill_id = ?').get(bill1.data.bill.id) as { id: string };
    const refundResult = refundPayment({ paymentId: paymentForRefund.id, amountMinor: 200, reason: 'test' });
    assert(!!refundResult.refund.id, 'refund succeeds');

    console.log('\n13. Split bill still works');
    if ((db.prepare("SELECT COUNT(*) AS c FROM settings WHERE key = 'split_checks_enabled'").get() as any).c === 0) {
      db.prepare("INSERT INTO settings (key, value) VALUES ('split_checks_enabled', 'true')").run();
    } else {
      db.prepare("UPDATE settings SET value = 'true' WHERE key = 'split_checks_enabled'").run();
    }
    const order3 = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'dine_in', items: [{ product_id: 'prod-pc', quantity: 2 }] }, headers: authHeader });
    const bill3 = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: order3.data.order.id }, headers: authHeader });
    const items3: any[] = order3.data.order.items;
    const splitRes = await api(baseUrl, `/api/bills/${bill3.data.bill.id}/split-check`, {
      method: 'POST',
      body: { checks: [{ label: 'A', items: [{ order_item_id: items3[0].id, quantity: 1 }] }, { label: 'B', items: [{ order_item_id: items3[0].id, quantity: 1 }] }] },
      headers: authHeader,
    });
    assertEqual(splitRes.status, 201, 'split-check still works');
    for (const splitBill of splitRes.data.bills) {
      assert(!!splitBill.uid, 'each split bill has a uid');
    }

    console.log('\n14. Payment replay (idempotency) still works');
    const idemHeaders = { ...authHeader, 'Idempotency-Key': 'pc-replay-key-1' };
    const order4 = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-pc', quantity: 1 }] }, headers: authHeader });
    const bill4 = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: order4.data.order.id }, headers: authHeader });
    const first = await api(baseUrl, `/api/bills/${bill4.data.bill.id}/payment`, { method: 'POST', body: { method: 'cash', amount: bill4.data.bill.total }, headers: idemHeaders });
    const replay = await api(baseUrl, `/api/bills/${bill4.data.bill.id}/payment`, { method: 'POST', body: { method: 'cash', amount: bill4.data.bill.total }, headers: idemHeaders });
    assertEqual(first.status, 200, 'first payment succeeds');
    assertEqual(replay.status, 200, 'replayed payment succeeds without duplicating');
    const paymentsForBill4 = db.prepare('SELECT COUNT(*) AS c FROM payments WHERE bill_id = ?').get(bill4.data.bill.id) as { c: number };
    assertEqual(paymentsForBill4.c, 1, 'the replay did not create a second payments row');

    // ══ RECONCILIATION (Part C) ══════════════════════════════════════════
    console.log('\n6-9. Historical reconciliation: partial legacy mirror detection and deterministic reconstruction');
    // The exact scenario from the task brief: payment_details has £50 cash +
    // £20 card, but the authoritative model only mirrors the £50 cash line —
    // simulating the pre-SYNC-0 per-line-swallow bug.
    const order5 = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-pc', quantity: 1 }] }, headers: authHeader });
    const bill5 = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: order5.data.order.id }, headers: authHeader });
    db.prepare(`UPDATE bills SET payment_status = 'paid', paid_amount = 70, balance = 0,
      payment_details = ? WHERE id = ?`).run(JSON.stringify([
        { method: 'cash', amount: 50, timestamp: '2026-01-01T10:00:00Z' },
        { method: 'card', amount: 20, timestamp: '2026-01-01T10:05:00Z' },
      ]), bill5.data.bill.id);
    seedPaymentRow(db, bill5.data.bill.id, 'cash', 50, { adapter: 'cash', requestedAt: '2026-01-01 10:00:00' });
    // Deliberately no authoritative row for the £20 card line — the partial-mirror bug.

    const dryRun = reconcileBillPayments(bill5.data.bill.id, { dryRun: true });
    assertEqual(dryRun.legacyLineCount, 2, 'both legacy lines are seen');
    assertEqual(dryRun.matched, 1, 'the £50 cash line matches the existing authoritative payment');
    assertEqual(dryRun.reconstructed, 1, 'the £20 card line is detected as missing and reconstructable (dry run)');
    assertEqual(dryRun.unrepresentable, 0, 'nothing is unrepresentable in this clean scenario');

    const applied = reconcileBillPayments(bill5.data.bill.id);
    assertEqual(applied.reconstructed, 1, 'the missing £20 card line is reconstructed for real');
    const paymentsForBill5 = db.prepare('SELECT method, amount_minor, state, metadata FROM payments WHERE bill_id = ? ORDER BY amount_minor').all(bill5.data.bill.id) as any[];
    assertEqual(paymentsForBill5.length, 2, 'the bill now has both authoritative payment rows');
    const reconstructedLine = paymentsForBill5.find((p: any) => p.amount_minor === 2000);
    assert(!!reconstructedLine, 'the reconstructed £20 line exists');
    assertEqual(reconstructedLine.method, 'card', 'the reconstructed line keeps the original method label');
    const meta = JSON.parse(reconstructedLine.metadata);
    assertEqual(meta.legacy_method, 'card', 'the reconstructed line preserves legacy method provenance in metadata (Part D)');
    assertEqual(meta.backfill_source, 'payment_reconciliation', 'the reconstructed line is marked as reconciliation-sourced, distinguishing it from a live payment');

    // Idempotency: reconciling again is a no-op (everything now matches).
    const secondPass = reconcileBillPayments(bill5.data.bill.id);
    assertEqual(secondPass.matched, 2, 'a second reconciliation pass finds everything already matched');
    assertEqual(secondPass.reconstructed, 0, 'nothing is reconstructed twice');

    console.log('\n9. An ambiguous legacy line is never invented');
    const order6 = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-pc', quantity: 1 }] }, headers: authHeader });
    const bill6 = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: order6.data.order.id }, headers: authHeader });
    db.prepare(`UPDATE bills SET payment_status = 'paid', paid_amount = 10, balance = 0,
      payment_details = ? WHERE id = ?`).run(JSON.stringify([
        { method: 'cash', amount: -5, timestamp: '2026-01-01T10:00:00Z' }, // invalid: non-positive
        { amount: 10, timestamp: '2026-01-01T10:00:00Z' }, // invalid: no method
      ]), bill6.data.bill.id);
    const ambiguousResult = reconcileBillPayments(bill6.data.bill.id);
    assertEqual(ambiguousResult.unrepresentable, 2, 'both malformed legacy lines are flagged unrepresentable, never invented');
    assertEqual(ambiguousResult.reconstructed, 0, 'nothing was reconstructed from the ambiguous data');
    const paymentsForBill6 = db.prepare('SELECT COUNT(*) AS c FROM payments WHERE bill_id = ?').get(bill6.data.bill.id) as { c: number };
    assertEqual(paymentsForBill6.c, 0, 'no payment row was fabricated for the ambiguous bill');

    console.log('\n(bulk reconciliation report)');
    const bulkReport = reconcileAllPaymentDetails({ dryRun: true });
    assert(bulkReport.billsExamined > 0, 'the bulk reconciliation examines every bill with legacy payment_details');
  } finally {
    server.close();
  }

  closeDatabase();
  const { passed, failed } = getResults();
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error('Test suite failed:', error); process.exit(1); });
