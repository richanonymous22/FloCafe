/**
 * Test: Plemmo purchasing (Suppliers, Purchase Orders, Receiving) — Milestone 5.
 *
 * Drives the Core/module functions directly against a real database — no
 * HTTP layer — the same style as tests/plemmo-inventory.test.ts. Covers
 * Part O items 1-25. Items 26-29 (retail checkout/inventory, hospitality,
 * payment regression) are covered by tests/plemmo-retail.test.ts,
 * tests/plemmo-inventory.test.ts, and the rest of the suite; item 30 (full
 * suite) is `npm test` itself.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/plemmo-purchasing.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plemmo-purchasing-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, getResults, closeDatabase, assert, assertEqual, now,
} = require('./helpers/test-setup');
const {
  createSupplier, updateSupplier, listSuppliers, SupplierError,
} = require('../main/modules/purchasing/suppliers');
const {
  createPurchaseOrder, addItem, updateItem, markOrdered, cancelPurchaseOrder,
  getPurchaseOrder, PurchaseOrderError,
} = require('../main/modules/purchasing/purchase-orders');
const { receiveGoods } = require('../main/modules/purchasing/receiving');
const { getBalance, getMovementHistory } = require('../main/core/inventory');
const { getCurrentLocationId } = require('../main/core/location');

const USER_ID = 'owner-purch-001';

function seedProduct(db: any, id: string, name: string, price: number, trackInventory = true) {
  db.prepare(`
    INSERT INTO products (id, category_id, name, price, cost, track_inventory, stock_quantity, low_stock_threshold, is_active, sort_order, created_at, updated_at)
    VALUES (?, NULL, ?, ?, 0, ?, 0, 5, 1, 0, ?, ?)
  `).run(id, name, price, trackInventory ? 1 : 0, now(), now());
}

function main() {
  console.log('Test: Plemmo purchasing (Suppliers / Purchase Orders / Receiving)');
  console.log('='.repeat(50));

  const db = initTestDb();
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
              VALUES (?, 'Owner', 'owner-purch@test.local', 'x', 'owner', 1, ?, ?)`).run(USER_ID, now(), now());

  seedProduct(db, 'prod-purch-a', 'Purchasable Widget', 20);
  seedProduct(db, 'prod-purch-b', 'Another Widget', 10);

  // ── SUPPLIERS ──────────────────────────────────────────────────────────
  console.log('\n1. Create supplier');
  const supplier = createSupplier({ name: 'Acme Supplies', phone: '555-0100', email: 'sales@acme.test' });
  assert(!!supplier.id, 'a supplier is created with an id');
  assertEqual(supplier.name, 'Acme Supplies', 'the name is stored');
  assertEqual(supplier.is_active, 1, 'a new supplier is active by default');

  console.log('\n2. Edit supplier');
  const updated = updateSupplier(supplier.id, { phone: '555-0199' });
  assertEqual(updated.phone, '555-0199', 'the phone number is updated');
  assertEqual(updated.name, 'Acme Supplies', 'unedited fields are preserved');

  console.log('\n3. Duplicate handling — two suppliers may share a name');
  const supplier2 = createSupplier({ name: 'Acme Supplies', phone: '555-0200' });
  assert(supplier2.id !== supplier.id, 'a second supplier with the same name gets its own identity, not rejected or merged');

  console.log('\n4. Search');
  const searchResults = listSuppliers({ search: 'Acme' });
  assert(searchResults.length >= 2, 'search finds both Acme suppliers');
  const emptySearch = listSuppliers({ search: 'Nonexistent Corp' });
  assertEqual(emptySearch.length, 0, 'a non-matching search returns nothing');

  let blankNameRejected = false;
  try {
    createSupplier({ name: '' });
  } catch (e: any) {
    blankNameRejected = e instanceof SupplierError;
  }
  assert(blankNameRejected, 'a blank supplier name is rejected');

  // ── PURCHASE ORDERS ────────────────────────────────────────────────────
  console.log('\n5. Create PO');
  const po = createPurchaseOrder({ supplierId: supplier.id, referenceNumber: 'PO-1001', createdBy: USER_ID });
  assertEqual(po.status, 'draft', 'a new PO starts in draft');
  assertEqual(po.total, 0, 'an empty PO totals zero');

  console.log('\n6. Add item');
  const item1 = addItem(po.id, { productId: 'prod-purch-a', quantityOrdered: 100, unitCost: 5 });
  assertEqual(item1.quantity_ordered, 100, 'the ordered quantity is stored');
  assertEqual(item1.line_total, 500, 'the line total is quantity * unit_cost');
  const poAfterItem = getPurchaseOrder(po.id);
  assertEqual(poAfterItem.total, 500, 'the PO total reflects its one item');

  console.log('\n7. Update quantity');
  const item1Updated = updateItem(po.id, item1.id, { quantityOrdered: 120 });
  assertEqual(item1Updated.quantity_ordered, 120, 'the quantity is updated');
  assertEqual(item1Updated.line_total, 600, 'the line total recalculates');
  const poAfterUpdate = getPurchaseOrder(po.id);
  assertEqual(poAfterUpdate.total, 600, 'the PO total recalculates too');
  // Revert to 100 for the receiving scenarios below.
  updateItem(po.id, item1.id, { quantityOrdered: 100 });
  addItem(po.id, { productId: 'prod-purch-b', quantityOrdered: 20, unitCost: 3 });

  console.log('\n8. Mark ordered');
  const ordered = markOrdered(po.id);
  assertEqual(ordered.status, 'ordered', 'the PO moves to ordered');
  let addAfterOrderedRejected = false;
  try {
    addItem(po.id, { productId: 'prod-purch-a', quantityOrdered: 1, unitCost: 1 });
  } catch (e: any) {
    addAfterOrderedRejected = e instanceof PurchaseOrderError;
  }
  assert(addAfterOrderedRejected, 'items cannot be added once a PO is no longer draft');

  console.log('\n9. Cancel');
  const poToCancel = createPurchaseOrder({ supplierId: supplier.id });
  addItem(poToCancel.id, { productId: 'prod-purch-a', quantityOrdered: 5, unitCost: 5 });
  markOrdered(poToCancel.id);
  const cancelled = cancelPurchaseOrder(poToCancel.id);
  assertEqual(cancelled.status, 'cancelled', 'the PO is cancelled');
  let cancelAgainRejected = false;
  try {
    cancelPurchaseOrder(poToCancel.id);
  } catch (e: any) {
    cancelAgainRejected = e instanceof PurchaseOrderError;
  }
  assert(cancelAgainRejected, 'an already-cancelled PO cannot be cancelled again');

  console.log('\n10. Invalid operations');
  let emptyPoOrderedRejected = false;
  try {
    markOrdered(createPurchaseOrder({ supplierId: supplier.id }).id);
  } catch (e: any) {
    emptyPoOrderedRejected = /at least one item/.test(e.message);
  }
  assert(emptyPoOrderedRejected, 'a PO with no items cannot be marked ordered');
  let unknownSupplierRejected = false;
  try {
    createPurchaseOrder({ supplierId: 'no-such-supplier' });
  } catch (e: any) {
    unknownSupplierRejected = e instanceof PurchaseOrderError;
  }
  assert(unknownSupplierRejected, 'creating a PO against an unknown supplier is rejected');

  // ── RECEIVING ──────────────────────────────────────────────────────────
  console.log('\n11-12-13. Partial receiving, then full receiving, remaining quantity');
  const itemA = getPurchaseOrder(po.id).items.find((i: any) => i.product_id === 'prod-purch-a');
  const receive1 = receiveGoods({ purchaseOrderId: po.id, items: [{ itemId: itemA.id, quantity: 60 }], actorUserId: USER_ID });
  assertEqual(receive1.purchaseOrder.status, 'partially_received', 'the PO becomes partially received');
  assertEqual(getBalance('prod-purch-a'), 60, 'inventory reflects the 60 units received');
  const itemAAfterFirst = getPurchaseOrder(po.id).items.find((i: any) => i.id === itemA.id);
  assertEqual(itemAAfterFirst.quantity_received, 60, 'quantity_received is tracked');
  assertEqual(itemAAfterFirst.quantity_ordered - itemAAfterFirst.quantity_received, 40, 'remaining is ordered - received');

  console.log('\n14. Multiple receipts — remaining 40 more, plus the second product');
  const itemB = getPurchaseOrder(po.id).items.find((i: any) => i.product_id === 'prod-purch-b');
  const receive2 = receiveGoods({
    purchaseOrderId: po.id,
    items: [{ itemId: itemA.id, quantity: 40 }, { itemId: itemB.id, quantity: 20 }],
    actorUserId: USER_ID,
  });
  assertEqual(receive2.purchaseOrder.status, 'received', 'once every item is fully received, the PO is received');
  assertEqual(getBalance('prod-purch-a'), 100, 'product A: fully received (60 + 40 = 100)');
  assertEqual(getBalance('prod-purch-b'), 20, 'product B: fully received in one shot');

  console.log('\n15. A completed PO cannot receive again');
  let receiveAfterCompleteRejected = false;
  try {
    receiveGoods({ purchaseOrderId: po.id, items: [{ itemId: itemA.id, quantity: 1 }], actorUserId: USER_ID });
  } catch (e: any) {
    receiveAfterCompleteRejected = /cannot receive goods/.test(e.message);
  }
  assert(receiveAfterCompleteRejected, 'a fully received PO rejects further receiving');

  console.log('\n16. Invalid quantity — cannot over-receive');
  const po2 = createPurchaseOrder({ supplierId: supplier.id });
  const item2 = addItem(po2.id, { productId: 'prod-purch-a', quantityOrdered: 10, unitCost: 5 });
  markOrdered(po2.id);
  let overReceiveRejected = false;
  try {
    receiveGoods({ purchaseOrderId: po2.id, items: [{ itemId: item2.id, quantity: 11 }], actorUserId: USER_ID });
  } catch (e: any) {
    overReceiveRejected = /only 10 remain outstanding/.test(e.message);
  }
  assert(overReceiveRejected, 'receiving more than ordered is rejected');
  let zeroQuantityRejected = false;
  try {
    receiveGoods({ purchaseOrderId: po2.id, items: [{ itemId: item2.id, quantity: 0 }], actorUserId: USER_ID });
  } catch (e: any) {
    zeroQuantityRejected = /positive number/.test(e.message);
  }
  assert(zeroQuantityRejected, 'receiving a zero quantity is rejected');

  console.log('\n17-18-19. Inventory movement created, balance updated, unit cost recorded');
  const balanceBeforeFinalReceive = getBalance('prod-purch-a');
  const receive3 = receiveGoods({ purchaseOrderId: po2.id, items: [{ itemId: item2.id, quantity: 10, unitCost: 5.5 }], actorUserId: USER_ID });
  assertEqual(receive3.movements.length, 1, 'one movement was created for this receipt');
  assertEqual(receive3.movements[0].movement_type, 'receipt', 'typed as a receipt movement');
  assertEqual(receive3.movements[0].quantity_delta, 10, 'the delta matches the received quantity');
  assertEqual(receive3.movements[0].unit_cost, 5.5, 'the actual receipt cost (5.5) is recorded, not the PO\'s expected cost (5)');
  assertEqual(receive3.movements[0].reference_type, 'purchase_order_item', 'tied to the purchase_order_item reference type');
  assertEqual(receive3.movements[0].reference_id, item2.id, 'tied to the exact item received');
  assertEqual(getBalance('prod-purch-a'), balanceBeforeFinalReceive + 10, 'the balance increases by the received quantity');
  const historyEntry = getMovementHistory('prod-purch-a').find((m: any) => m.id === receive3.movements[0].id);
  assert(!!historyEntry, 'the receipt appears in the product\'s movement history');

  // ── LOCATION ───────────────────────────────────────────────────────────
  console.log('\n20-21-22. Location awareness');
  const currentLocationId = getCurrentLocationId();
  assert(!!currentLocationId, 'this install has a resolvable current location');
  assertEqual(historyEntry.location_id, currentLocationId, 'inventory belongs to the current location');
  const poWithLocation = getPurchaseOrder(po2.id);
  assertEqual(poWithLocation.location_id, currentLocationId, 'the purchase order belongs to the current location');
  assertEqual(receive3.movements[0].location_id, currentLocationId, 'receiving stamped the movement with the correct location');

  // ── TRANSACTIONS ───────────────────────────────────────────────────────
  console.log('\n23-24. Receiving rollback — no partial inventory update');
  const po3 = createPurchaseOrder({ supplierId: supplier.id });
  const item3a = addItem(po3.id, { productId: 'prod-purch-a', quantityOrdered: 5, unitCost: 5 });
  const item3b = addItem(po3.id, { productId: 'prod-purch-b', quantityOrdered: 5, unitCost: 5 });
  markOrdered(po3.id);
  const balanceABefore = getBalance('prod-purch-a');
  const balanceBBefore = getBalance('prod-purch-b');
  const movementCountBefore = db.prepare('SELECT COUNT(*) as c FROM inventory_movements').get().c;
  let rolledBack = false;
  try {
    // Second line asks for more than ordered — the whole receive call must fail atomically.
    receiveGoods({
      purchaseOrderId: po3.id,
      items: [{ itemId: item3a.id, quantity: 5 }, { itemId: item3b.id, quantity: 999 }],
      actorUserId: USER_ID,
    });
  } catch (e: any) {
    rolledBack = /remain outstanding/.test(e.message);
  }
  assert(rolledBack, 'the receive call as a whole threw');
  assertEqual(getBalance('prod-purch-a'), balanceABefore, 'product A\'s balance is unchanged — not even the first, valid line applied');
  assertEqual(getBalance('prod-purch-b'), balanceBBefore, 'product B\'s balance is unchanged');
  assertEqual(db.prepare('SELECT COUNT(*) as c FROM inventory_movements').get().c, movementCountBefore, 'no inventory movement survives the rolled-back receive');
  const po3AfterFailure = getPurchaseOrder(po3.id);
  assertEqual(po3AfterFailure.items.find((i: any) => i.id === item3a.id).quantity_received, 0, 'quantity_received is not partially updated either');

  console.log('\n25. Idempotent receiving');
  const po4 = createPurchaseOrder({ supplierId: supplier.id });
  const item4 = addItem(po4.id, { productId: 'prod-purch-a', quantityOrdered: 10, unitCost: 5 });
  markOrdered(po4.id);
  const idempotency = { key: 'receive-key-1', requestHash: 'hash-1', userId: USER_ID };
  const firstReceive = receiveGoods({ purchaseOrderId: po4.id, items: [{ itemId: item4.id, quantity: 10 }], actorUserId: USER_ID, idempotency });
  assertEqual(firstReceive.idempotentReplay, false, 'the first call is not a replay');
  const balanceAfterFirst = getBalance('prod-purch-a');
  const replay = receiveGoods({ purchaseOrderId: po4.id, items: [{ itemId: item4.id, quantity: 10 }], actorUserId: USER_ID, idempotency });
  assertEqual(replay.idempotentReplay, true, 'the same key replays instead of receiving again');
  assertEqual(getBalance('prod-purch-a'), balanceAfterFirst, 'a retried receive request does not double the stock');

  closeDatabase();

  const { passed, failed } = getResults();
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
