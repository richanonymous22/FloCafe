/**
 * Test: Plemmo Core InventoryService (main/core/inventory.ts) and its
 * integration with SaleService/PaymentService (Milestone 4).
 *
 * Drives Core directly against a real database — no HTTP layer — the same
 * style as tests/plemmo-sale-service.test.ts and the unit half of
 * tests/plemmo-payment-service.test.ts. Covers Part S items 2-14 and 17 of
 * the milestone spec; items 1 (opening stock migration) and 15 (legacy
 * upgrade) are covered by tests/upgrade-path.test.ts (a real legacy fixture
 * is required to exercise that backfill meaningfully), 16 (fresh database)
 * is implicit in every test here running against a freshly initialized DB,
 * and 18 (retail regression) is covered by tests/plemmo-retail.test.ts.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/plemmo-inventory.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plemmo-inventory-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, getResults, closeDatabase, assert, assertEqual, now,
} = require('./helpers/test-setup');
const { createSale, addSaleItems } = require('../main/core/sale');
const { tender, refundPayment } = require('../main/core/payment');
const {
  getBalance, getMovementHistory, adjustStock, listLowStock, recordReturn, InventoryError,
} = require('../main/core/inventory');
const { generateBillForOrder } = require('../main/routes/bills');
const { registerHospitalityHooks } = require('../main/modules/hospitality/hooks');
const { ulid } = require('../main/core/ids');

const USER_ID = 'owner-inv-001';

function seedProduct(db: any, id: string, name: string, price: number, opts: { trackInventory?: boolean; stock?: number; cost?: number } = {}) {
  db.prepare(`
    INSERT INTO products (id, category_id, name, price, cost, track_inventory, stock_quantity, low_stock_threshold, is_active, sort_order, created_at, updated_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
  `).run(id, name, price, opts.cost ?? 0, opts.trackInventory ? 1 : 0, opts.stock ?? 0, 5, now(), now());
}

function seedVariant(db: any, productId: string, name: string, price: number, cost = 0): string {
  const id = ulid();
  db.prepare(`
    INSERT INTO product_variants (id, product_id, name, price, cost, is_default, is_active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, 1, 0, ?, ?)
  `).run(id, productId, name, price, cost, now(), now());
  return id;
}

function main() {
  console.log('Test: Plemmo Core InventoryService');
  console.log('='.repeat(50));

  const db = initTestDb();
  registerHospitalityHooks();

  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
              VALUES (?, 'Owner', 'owner-inv@test.local', 'x', 'owner', 1, ?, ?)`).run(USER_ID, now(), now());

  seedProduct(db, 'prod-inv-a', 'Tracked Widget', 10, { trackInventory: true, stock: 20, cost: 4 });
  seedProduct(db, 'prod-inv-untracked', 'Untracked Snack', 3, { trackInventory: false, stock: 0 });
  const variantA = seedVariant(db, 'prod-inv-a', 'Variant A', 12, 5);
  const variantB = seedVariant(db, 'prod-inv-a', 'Variant B', 15, 6);

  console.log('\n2-3-4. Sale decrements stock, creates a movement, updates the balance');
  const sale1 = createSale({
    channel: 'takeaway', cashierUserId: USER_ID, tableId: null,
    lines: [{ product_id: 'prod-inv-a', quantity: 3 }],
  });
  assertEqual(getBalance('prod-inv-a'), 17, 'the bare product balance decremented by the sold quantity');
  const productRow = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get('prod-inv-a');
  assertEqual(productRow.stock_quantity, 17, 'the legacy stock_quantity compatibility column stays in sync for a variant-less product');
  const saleItemId = String(sale1.lines[0].id);
  const movements1 = getMovementHistory('prod-inv-a', null);
  assertEqual(movements1.length, 1, 'exactly one movement was created for this sale');
  assertEqual(movements1[0].movement_type, 'sale', 'typed as a sale movement');
  assertEqual(movements1[0].quantity_delta, -3, 'the delta is negative, matching the quantity sold');
  assertEqual(movements1[0].reference_type, 'order_item', 'tied to the order_item reference type');
  assertEqual(movements1[0].reference_id, saleItemId, 'tied to the exact order_item row that sold');
  assertEqual(movements1[0].balance_after, 17, 'the movement records the resulting balance');

  console.log('\n5. Variant A does not affect Variant B');
  assertEqual(getBalance('prod-inv-a', variantA), null, 'a freshly created variant has no balance row yet — no legacy scalar to inherit from');
  let variantSaleRejected = false;
  try {
    createSale({
      channel: 'takeaway', cashierUserId: USER_ID, tableId: null,
      lines: [{ product_id: 'prod-inv-a', variant_id: variantA, quantity: 2 }],
    });
  } catch (e: any) {
    variantSaleRejected = /Insufficient stock/.test(e.message);
  }
  assert(variantSaleRejected, 'a variant with no stock seeded yet cannot be sold — the same negative-stock prevention as a bare product');
  assertEqual(getBalance('prod-inv-a', variantB), null, 'variant B has no balance row at all — completely untouched by variant A\'s rejected sale');
  assertEqual(getBalance('prod-inv-a'), 17, 'the bare-product balance (no variant) is also untouched by a variant sale attempt');

  // Give variant A and B independent, disjoint stock, then prove isolation with a real decrement each.
  adjustStock({ productId: 'prod-inv-a', variantId: variantA, quantityDelta: 10, reason: 'seed A' });
  adjustStock({ productId: 'prod-inv-a', variantId: variantB, quantityDelta: 10, reason: 'seed B' });
  createSale({
    channel: 'takeaway', cashierUserId: USER_ID, tableId: null,
    lines: [{ product_id: 'prod-inv-a', variant_id: variantA, quantity: 4 }],
  });
  assertEqual(getBalance('prod-inv-a', variantA), 6, 'variant A: 10 (seeded) - 4 sold = 6');
  assertEqual(getBalance('prod-inv-a', variantB), 10, 'variant B is completely unaffected by variant A\'s sale');

  console.log('\n6-7. Refund increments stock; partial refund');
  const sale2 = createSale({
    channel: 'takeaway', cashierUserId: USER_ID, tableId: null,
    lines: [{ product_id: 'prod-inv-a', variant_id: variantB, quantity: 5 }],
  });
  assertEqual(getBalance('prod-inv-a', variantB), 5, 'variant B: 10 - 5 sold = 5');
  const bill2 = generateBillForOrder(sale2.sale.id).bill;
  const tenderResult = tender({
    billId: bill2.id, orderId: sale2.sale.id,
    tender: { adapter: 'cash', method: 'cash', amountMinor: Math.round(bill2.total * 100), currency: 'INR' },
    actorUserId: USER_ID,
  });
  const sale2ItemId = String(sale2.lines[0].id);
  const refund1 = refundPayment({
    paymentId: tenderResult.payment.id,
    amountMinor: Math.round((bill2.total / 5) * 3 * 100),
    reason: 'Customer returned 3 units',
    actorUserId: USER_ID,
    items: [{ orderItemId: sale2ItemId, quantity: 3 }],
  });
  assertEqual(getBalance('prod-inv-a', variantB), 8, 'a partial refund (3 of 5) credits exactly 3 units back');
  const returnMovements = getMovementHistory('prod-inv-a', variantB).filter((m: any) => m.movement_type === 'return');
  assertEqual(returnMovements.length, 1, 'one return movement was recorded');
  assertEqual(returnMovements[0].quantity_delta, 3, 'the return movement carries the returned quantity');
  assertEqual(returnMovements[0].reference_type, 'payment_refund', 'tied to the refund as its reference');
  assertEqual(returnMovements[0].reference_id, refund1.refund.id, 'tied to the exact refund row');

  console.log('\n8. Over-refund rejected — cannot return more than was sold on that line');
  // Exercised directly against InventoryService.recordReturn() rather than
  // through refundPayment(): a second money-refund of the same size would
  // already be rejected by refundPayment's own financial refundable-balance
  // check (payment.ts, unrelated to inventory) before ever reaching this
  // one — this isolates the inventory-specific quantity cap from that.
  let overRefundRejected = false;
  try {
    recordReturn({
      productId: 'prod-inv-a', variantId: variantB, quantity: 3,
      saleReferenceId: sale2ItemId, referenceType: 'manual_test', referenceId: 'test-2',
      actorUserId: USER_ID,
    });
  } catch (e: any) {
    overRefundRejected = /exceeds the remaining returnable quantity/.test(e.message);
  }
  assert(overRefundRejected, 'returning 3 more (6 total against a line that sold 5) is rejected');
  assertEqual(getBalance('prod-inv-a', variantB), 8, 'the rejected over-refund left the balance unchanged');

  console.log('\n9. Stock adjustment');
  const adjustment = adjustStock({ productId: 'prod-inv-a', variantId: variantA, quantityDelta: -1, reason: 'Damaged in storage' });
  assertEqual(adjustment.movement_type, 'adjustment', 'recorded as an adjustment movement');
  assertEqual(adjustment.reason, 'Damaged in storage', 'the reason is stored');
  assertEqual(getBalance('prod-inv-a', variantA), 5, 'variant A: 6 - 1 damaged = 5');
  let missingReasonRejected = false;
  try {
    adjustStock({ productId: 'prod-inv-a', variantId: variantA, quantityDelta: 5, reason: '' });
  } catch (e: any) {
    missingReasonRejected = e instanceof InventoryError;
  }
  assert(missingReasonRejected, 'an adjustment with no reason is rejected — "stock = X" never happens unexplained');

  console.log('\n10. Negative stock behavior');
  let saleRejected = false;
  try {
    createSale({
      channel: 'takeaway', cashierUserId: USER_ID, tableId: null,
      lines: [{ product_id: 'prod-inv-a', variant_id: variantA, quantity: 999 }],
    });
  } catch (e: any) {
    saleRejected = /Insufficient stock/.test(e.message);
  }
  assert(saleRejected, 'a sale that would take tracked stock negative is prevented, exactly as before this milestone');
  let adjustmentRejected = false;
  try {
    adjustStock({ productId: 'prod-inv-a', variantId: variantA, quantityDelta: -999, reason: 'test' });
  } catch (e: any) {
    adjustmentRejected = /would take stock negative/.test(e.message);
  }
  assert(adjustmentRejected, 'a manual adjustment that would take stock negative is also prevented');

  console.log('\n11. Low-stock threshold');
  seedProduct(db, 'prod-inv-low', 'Nearly Out', 5, { trackInventory: true, stock: 2 });
  db.prepare("UPDATE products SET low_stock_threshold = 5 WHERE id = 'prod-inv-low'").run();
  const lowStock = listLowStock();
  const lowRow = lowStock.find((row: any) => row.productId === 'prod-inv-low');
  assert(!!lowRow, 'a product below its threshold is surfaced by listLowStock()');
  assertEqual(lowRow.quantity, 2, 'the row reports the current quantity');
  assertEqual(lowRow.threshold, 5, 'the row reports the threshold it is being compared against');
  const notLowRow = lowStock.find((row: any) => row.productId === 'prod-inv-a' && !row.variantId);
  assert(!notLowRow, 'the bare product prod-inv-a (17 units, well above its default threshold) is not flagged');

  console.log('\n12. Movement history is ordered newest-first');
  const history = getMovementHistory('prod-inv-a', variantA, 50);
  assert(history.length >= 2, 'multiple movements exist for variant A');
  for (let i = 1; i < history.length; i++) {
    assert(history[i - 1].created_at >= history[i].created_at, 'each row is not older than the one before it');
  }

  console.log('\n13. Unit-cost snapshot');
  const sale3 = createSale({
    channel: 'takeaway', cashierUserId: USER_ID, tableId: null,
    lines: [{ product_id: 'prod-inv-a', variant_id: variantB, quantity: 1 }],
  });
  const orderItemRow = db.prepare('SELECT unit_cost FROM order_items WHERE id = ?').get(sale3.lines[0].id);
  assertEqual(orderItemRow.unit_cost, 6, 'the order_item snapshots the variant\'s cost at sale time');
  const saleMovement = getMovementHistory('prod-inv-a', variantB).find((m: any) => m.reference_id === String(sale3.lines[0].id));
  assertEqual(saleMovement.unit_cost, 6, 'the inventory movement carries the same unit cost snapshot');

  console.log('\n14. Transaction rollback: a multi-line sale where the second line fails leaves nothing behind');
  const beforeItemCount = db.prepare('SELECT COUNT(*) as c FROM order_items').get().c;
  const beforeMovementCount = db.prepare('SELECT COUNT(*) as c FROM inventory_movements').get().c;
  let rolledBack = false;
  try {
    createSale({
      channel: 'takeaway', cashierUserId: USER_ID, tableId: null,
      lines: [
        { product_id: 'prod-inv-a', quantity: 1 },
        { product_id: 'prod-inv-a', variant_id: variantA, quantity: 999 },
      ],
    });
  } catch (e: any) {
    rolledBack = /Insufficient stock/.test(e.message);
  }
  assert(rolledBack, 'the sale as a whole threw');
  assertEqual(db.prepare('SELECT COUNT(*) as c FROM order_items').get().c, beforeItemCount, 'no order_item survives — not even the first, successfully-checked line');
  assertEqual(db.prepare('SELECT COUNT(*) as c FROM inventory_movements').get().c, beforeMovementCount, 'no inventory movement survives either — the sale and its stock effect commit or fail as one unit');

  console.log('\n17. Hospitality regression: a tracked dine-in product still decrements correctly');
  db.prepare("INSERT INTO tables (id, number, capacity, status, created_at, updated_at) VALUES ('table-inv-1', 1, 4, 'available', ?, ?)").run(now(), now());
  seedProduct(db, 'prod-inv-hosp', 'Dine-in Special', 8, { trackInventory: true, stock: 10 });
  const dineInSale = createSale({
    channel: 'dine_in', cashierUserId: USER_ID, tableId: 'table-inv-1',
    lines: [{ product_id: 'prod-inv-hosp', quantity: 2 }],
  });
  assertEqual(getBalance('prod-inv-hosp'), 8, 'a dine-in sale still decrements tracked stock via the same shared engine');
  const tableAfter = db.prepare("SELECT status FROM tables WHERE id = 'table-inv-1'").get();
  assertEqual(tableAfter.status, 'occupied', 'table occupation (the hospitality hook) still fires — unaffected by the inventory refactor');
  assert(!!dineInSale.sale, 'the dine-in sale itself succeeded');

  closeDatabase();

  const { passed, failed } = getResults();
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
