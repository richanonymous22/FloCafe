/**
 * Test: Plemmo multi-location (device context, location-aware sales/
 * payments/inventory/purchasing, stock transfers, employee scope) —
 * Milestone 6.
 *
 * Drives Core/module functions directly against a real database — no HTTP
 * layer. Since Part K explicitly says not to build a location-switching UI
 * in this milestone, "Location A vs Location B" isolation is proven either
 * by passing an explicit locationId to functions that accept one
 * (InventoryService, PurchaseOrderService, TransferService all do), or —
 * for SaleService/PaymentService, which always stamp the *current* device
 * context — by pointing the settings pointer at a different location
 * between calls and resetting the context cache. That is a legitimate way
 * to prove the underlying isolation guarantee without building a switcher.
 *
 * Covers Part O items 1-15. Items 16-17 (hospitality/retail regression)
 * are covered by tests/plemmo-inventory.test.ts and
 * tests/plemmo-retail.test.ts; item 18 (full suite) is `npm test` itself.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/plemmo-multi-location.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plemmo-multi-location-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, getResults, closeDatabase, assert, assertEqual, now,
} = require('./helpers/test-setup');
const { createSale } = require('../main/core/sale');
const { tender } = require('../main/core/payment');
const { generateBillForOrder } = require('../main/routes/bills');
const { getBalance, adjustStock } = require('../main/core/inventory');
const { createPurchaseOrder, addItem, markOrdered } = require('../main/modules/purchasing/purchase-orders');
const { receiveGoods } = require('../main/modules/purchasing/receiving');
const {
  createTransfer, addTransferItem, completeTransfer, cancelTransfer, TransferError,
} = require('../main/core/transfers');
const {
  getOrganizationContext, getLocationContext, getRegisterContext, getDeviceContext, resetContextCache,
} = require('../main/core/context');
const { grantLocationAccess, revokeLocationAccess, listUserLocations, userHasLocationAccess } = require('../main/core/employee-access');
const { registerHospitalityHooks } = require('../main/modules/hospitality/hooks');
const { ulid } = require('../main/core/ids');

const USER_ID = 'owner-ml-001';

function seedProduct(db: any, id: string, name: string, price: number) {
  db.prepare(`
    INSERT INTO products (id, category_id, name, price, cost, track_inventory, stock_quantity, low_stock_threshold, is_active, sort_order, created_at, updated_at)
    VALUES (?, NULL, ?, ?, 0, 1, 0, 5, 1, 0, ?, ?)
  `).run(id, name, price, now(), now());
}

function setLocationPointer(db: any, locationId: string) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('plemmo_location_id', ?, ?)").run(locationId, now());
  resetContextCache();
}

function main() {
  console.log('Test: Plemmo multi-location');
  console.log('='.repeat(50));

  const db = initTestDb();
  registerHospitalityHooks();
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
              VALUES (?, 'Owner', 'owner-ml@test.local', 'x', 'owner', 1, ?, ?)`).run(USER_ID, now(), now());

  seedProduct(db, 'prod-ml-a', 'Multi-location Widget', 10);
  const variantId = ulid();
  db.prepare(`INSERT INTO product_variants (id, product_id, name, price, cost, is_default, is_active, sort_order, created_at, updated_at)
              VALUES (?, 'prod-ml-a', 'Blue', 12, 5, 0, 1, 0, ?, ?)`).run(variantId, now(), now());

  // ── 1. Organization → Location → Register → Device relationship ────────
  console.log('\n1. Organization → Location → Register → Device relationship');
  const organization = getOrganizationContext();
  const locationA = getLocationContext();
  const register = getRegisterContext();
  const device = getDeviceContext();
  assert(!!organization && !!locationA && !!register && !!device, 'the full chain resolves for a freshly initialized install');
  assertEqual(locationA.organizationId, organization.id, 'the location belongs to the organization');
  assertEqual(register.locationId, locationA.id, 'the register belongs to the location');
  assertEqual(device.registerId, register.id, 'the device belongs to the register');

  // A second, real location for isolation tests below.
  const locationBId = ulid();
  db.prepare(`INSERT INTO locations (id, organization_id, name, code, is_active, created_at, updated_at)
              VALUES (?, ?, 'Location B', 'LOC-B', 1, ?, ?)`).run(locationBId, organization.id, now(), now());

  // ── 2-3. Sale/payment stamped with the correct location ─────────────────
  console.log('\n2-3. Sale and payment are stamped with the current device\'s location');
  adjustStock({ productId: 'prod-ml-a', locationId: locationA.id, quantityDelta: 5, reason: 'initial seed for §2-3' });
  const saleA = createSale({ channel: 'takeaway', cashierUserId: USER_ID, tableId: null, lines: [{ product_id: 'prod-ml-a', quantity: 1 }] });
  assertEqual(saleA.sale.location_id, locationA.id, 'the sale is stamped with the current location');
  assertEqual(saleA.sale.organization_id, organization.id, 'the sale is stamped with the current organization');
  const billA = generateBillForOrder(saleA.sale.id).bill;
  const paymentA = tender({ billId: billA.id, orderId: saleA.sale.id, tender: { adapter: 'cash', method: 'cash', amountMinor: Math.round(billA.total * 100), currency: 'INR' }, actorUserId: USER_ID });
  assertEqual(paymentA.payment.location_id, locationA.id, 'the payment is stamped with the current location');
  assertEqual(paymentA.payment.organization_id, organization.id, 'the payment is stamped with the current organization');

  // ── 6. Sale at Location A does not affect Location B ────────────────────
  console.log('\n6. A sale at Location A does not affect Location B\'s stock');
  adjustStock({ productId: 'prod-ml-a', locationId: locationA.id, quantityDelta: 20, reason: 'seed A' });
  adjustStock({ productId: 'prod-ml-a', locationId: locationBId, quantityDelta: 20, reason: 'seed B' });
  const aBeforeSale = getBalance('prod-ml-a', null, locationA.id);
  const bBeforeSaleAtA = getBalance('prod-ml-a', null, locationBId);
  createSale({ channel: 'takeaway', cashierUserId: USER_ID, tableId: null, lines: [{ product_id: 'prod-ml-a', quantity: 5 }] });
  assertEqual(getBalance('prod-ml-a', null, locationA.id), aBeforeSale - 5, 'Location A decremented by the sale made while pointed at A');
  assertEqual(getBalance('prod-ml-a', null, locationBId), bBeforeSaleAtA, 'Location B is completely untouched');

  console.log('\n(switching the device context to Location B to prove the reverse)');
  setLocationPointer(db, locationBId);
  const aBeforeSaleAtB = getBalance('prod-ml-a', null, locationA.id);
  const bBeforeSale = getBalance('prod-ml-a', null, locationBId);
  const saleB = createSale({ channel: 'takeaway', cashierUserId: USER_ID, tableId: null, lines: [{ product_id: 'prod-ml-a', quantity: 3 }] });
  assertEqual(saleB.sale.location_id, locationBId, 'a sale made while pointed at Location B is stamped with Location B');
  assertEqual(getBalance('prod-ml-a', null, locationBId), bBeforeSale - 3, 'Location B decremented by its own sale');
  assertEqual(getBalance('prod-ml-a', null, locationA.id), aBeforeSaleAtB, 'Location A is unaffected by a sale made at Location B');
  setLocationPointer(db, locationA.id); // restore for the rest of the suite

  // ── 4-7. Purchase belongs to the correct location, isolated from the other ──
  console.log('\n4-7. Purchases are location-aware and isolated');
  const supplierId = ulid();
  db.prepare(`INSERT INTO suppliers (id, organization_id, name, is_active, created_at, updated_at) VALUES (?, ?, 'ML Supplier', 1, ?, ?)`)
    .run(supplierId, organization.id, now(), now());
  const poA = createPurchaseOrder({ supplierId, locationId: locationA.id, createdBy: USER_ID });
  assertEqual(poA.location_id, locationA.id, 'a purchase order created for Location A is stamped with Location A');
  const poAItem = addItem(poA.id, { productId: 'prod-ml-a', quantityOrdered: 10, unitCost: 5 });
  markOrdered(poA.id);
  const balanceABeforeReceive = getBalance('prod-ml-a', null, locationA.id);
  const balanceBBeforeReceive = getBalance('prod-ml-a', null, locationBId);
  receiveGoods({ purchaseOrderId: poA.id, items: [{ itemId: poAItem.id, quantity: 10 }], actorUserId: USER_ID });
  assertEqual(getBalance('prod-ml-a', null, locationA.id), balanceABeforeReceive + 10, 'receiving against a Location-A purchase order increases Location A\'s stock');
  assertEqual(getBalance('prod-ml-a', null, locationBId), balanceBBeforeReceive, 'Location B\'s stock is untouched by a Location-A purchase');

  // ── 8. Adjustment at Location A does not affect Location B ─────────────
  console.log('\n8. An adjustment at Location A does not affect Location B');
  const bBalanceBeforeAdjustment = getBalance('prod-ml-a', null, locationBId);
  adjustStock({ productId: 'prod-ml-a', locationId: locationA.id, quantityDelta: -2, reason: 'Damaged at A' });
  assertEqual(getBalance('prod-ml-a', null, locationBId), bBalanceBeforeAdjustment, 'Location B is untouched by an adjustment made at Location A');

  // ── 9-13. Stock transfers ────────────────────────────────────────────────
  console.log('\n9. Transfer A → B');
  const balanceABeforeTransfer = getBalance('prod-ml-a', null, locationA.id);
  const balanceBBeforeTransfer = getBalance('prod-ml-a', null, locationBId);
  const transfer = createTransfer({ fromLocationId: locationA.id, toLocationId: locationBId, createdBy: USER_ID });
  assertEqual(transfer.status, 'draft', 'a new transfer starts in draft');
  const transferItem = addTransferItem(transfer.id, { productId: 'prod-ml-a', quantity: 6 });
  const completed = completeTransfer(transfer.id, USER_ID);
  assertEqual(completed.status, 'completed', 'the transfer completes');
  assertEqual(getBalance('prod-ml-a', null, locationA.id), balanceABeforeTransfer - 6, 'the source location is decremented');
  assertEqual(getBalance('prod-ml-a', null, locationBId), balanceBBeforeTransfer + 6, 'the destination location is incremented by the same amount');

  console.log('\n10. Transfer cannot exceed source stock');
  const transfer2 = createTransfer({ fromLocationId: locationA.id, toLocationId: locationBId, createdBy: USER_ID });
  const hugeQty = getBalance('prod-ml-a', null, locationA.id) + 1000;
  addTransferItem(transfer2.id, { productId: 'prod-ml-a', quantity: hugeQty });
  let overTransferRejected = false;
  try {
    completeTransfer(transfer2.id, USER_ID);
  } catch (e: any) {
    overTransferRejected = /Insufficient stock at the source location/.test(e.message);
  }
  assert(overTransferRejected, 'completing a transfer that exceeds source stock is rejected');

  console.log('\n11. Transfer cannot be same-location');
  let sameLocationRejected = false;
  try {
    createTransfer({ fromLocationId: locationA.id, toLocationId: locationA.id, createdBy: USER_ID });
  } catch (e: any) {
    sameLocationRejected = e instanceof TransferError;
  }
  assert(sameLocationRejected, 'a transfer with identical source and destination is rejected');

  console.log('\n12. Transfer is atomic');
  const transfer3 = createTransfer({ fromLocationId: locationA.id, toLocationId: locationBId, createdBy: USER_ID });
  addTransferItem(transfer3.id, { productId: 'prod-ml-a', quantity: 2 });
  addTransferItem(transfer3.id, { productId: 'prod-ml-a', quantity: 999999 }); // second line will fail
  const balanceABeforeAtomicTest = getBalance('prod-ml-a', null, locationA.id);
  const balanceBBeforeAtomicTest = getBalance('prod-ml-a', null, locationBId);
  const movementCountBefore = db.prepare('SELECT COUNT(*) as c FROM inventory_movements').get().c;
  let transferRolledBack = false;
  try {
    completeTransfer(transfer3.id, USER_ID);
  } catch (e: any) {
    transferRolledBack = true;
  }
  assert(transferRolledBack, 'the transfer completion as a whole threw');
  assertEqual(getBalance('prod-ml-a', null, locationA.id), balanceABeforeAtomicTest, 'Location A is unchanged — not even the first, valid line applied');
  assertEqual(getBalance('prod-ml-a', null, locationBId), balanceBBeforeAtomicTest, 'Location B is unchanged either');
  assertEqual(db.prepare('SELECT COUNT(*) as c FROM inventory_movements').get().c, movementCountBefore, 'no movement survives the rolled-back transfer');
  const transfer3AfterFailure = db.prepare("SELECT status FROM stock_transfers WHERE id = ?").get(transfer3.id);
  assertEqual(transfer3AfterFailure.status, 'draft', 'the transfer itself is still draft, not partially completed');
  cancelTransfer(transfer3.id);

  console.log('\n13. Transfer movement references are correct');
  const transferMovements = db.prepare("SELECT * FROM inventory_movements WHERE reference_type = 'stock_transfer' AND reference_id = ?").all(transfer.id);
  assertEqual(transferMovements.length, 2, 'exactly one transfer_out and one transfer_in movement were recorded for the completed transfer');
  const outMovement = transferMovements.find((m: any) => m.movement_type === 'transfer_out');
  const inMovement = transferMovements.find((m: any) => m.movement_type === 'transfer_in');
  assert(!!outMovement && !!inMovement, 'both a transfer_out and a transfer_in movement exist');
  assertEqual(outMovement.location_id, locationA.id, 'the transfer_out movement is at the source location');
  assertEqual(inMovement.location_id, locationBId, 'the transfer_in movement is at the destination location');
  assertEqual(outMovement.quantity_delta, -6, 'the out movement is negative');
  assertEqual(inMovement.quantity_delta, 6, 'the in movement is positive, matching the transferred quantity');

  // ── 14. Variant stock remains isolated across locations ─────────────────
  console.log('\n14. Variant stock remains isolated across locations, even during a transfer');
  adjustStock({ productId: 'prod-ml-a', variantId, locationId: locationA.id, quantityDelta: 15, reason: 'seed variant A' });
  const variantTransfer = createTransfer({ fromLocationId: locationA.id, toLocationId: locationBId, createdBy: USER_ID });
  addTransferItem(variantTransfer.id, { productId: 'prod-ml-a', variantId, quantity: 4 });
  completeTransfer(variantTransfer.id, USER_ID);
  assertEqual(getBalance('prod-ml-a', variantId, locationA.id), 11, 'the variant\'s Location-A balance decremented');
  assertEqual(getBalance('prod-ml-a', variantId, locationBId), 4, 'the variant\'s Location-B balance incremented');
  assertEqual(getBalance('prod-ml-a', null, locationA.id), balanceABeforeTransfer - 6, 'the bare product\'s balance is untouched by the variant transfer');

  // ── 15. Employee location authorization foundation ─────────────────────
  console.log('\n15. Employee location authorization foundation');
  // This test's user was created after initTestDb() ran, so migration
  // v78's backfill (which only grants access to users that already existed
  // at migration time) never saw it — grant explicitly here, the same
  // access a pre-existing user would have received automatically.
  grantLocationAccess(USER_ID, locationA.id);
  assert(userHasLocationAccess(USER_ID, locationA.id), 'the user has access to the seeded location once granted');
  assert(!userHasLocationAccess(USER_ID, locationBId), 'the user has no access to Location B until explicitly granted');
  grantLocationAccess(USER_ID, locationBId);
  assert(userHasLocationAccess(USER_ID, locationBId), 'access to Location B is granted');
  const userLocations = listUserLocations(USER_ID);
  assertEqual(userLocations.length, 2, 'the user now has two granted locations');
  revokeLocationAccess(USER_ID, locationBId);
  assert(!userHasLocationAccess(USER_ID, locationBId), 'access to Location B is revoked');

  closeDatabase();

  const { passed, failed } = getResults();
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
