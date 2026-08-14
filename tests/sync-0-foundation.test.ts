/**
 * Test: SYNC-0 foundation repairs (no sync engine — foundation only).
 *
 * Covers the SYNC-0 success criteria that are exercisable without the real
 * cloud: authoritative+complete payments, load-bearing uids, payment/refund
 * global references, child-row tombstones, inventory organization identity,
 * and the device-credential domain foundation. The legacy payment_details
 * backfill (test items 1/8/10) and historical uid completeness (item 15) are
 * proven in tests/upgrade-path.test.ts against the real v1.5.0 fixture.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/sync-0-foundation.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-0-foundation-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, closeDatabase, assert, assertEqual, getResults, now,
  createApp, startServer, seedOwnerUser, seedCategory, seedProduct, api,
} = require('./helpers/test-setup');
const { registerHospitalityHooks } = require('../main/modules/hospitality/hooks');
const { adjustStock, getBalance } = require('../main/core/inventory');
const { refundPayment } = require('../main/core/payment');
const { createTransfer, addTransferItem, removeTransferItem, getTransfer, completeTransfer } = require('../main/core/transfers');
const { createPurchaseOrder, addItem, removeItem, getPurchaseOrder, markOrdered } = require('../main/modules/purchasing/purchase-orders');
const { recordDeviceCredential, getActiveDeviceCredential, listDeviceCredentials, revokeDeviceCredential } = require('../main/core/device-credentials');
const { getOrganizationContext, getLocationContext } = require('../main/core/context');
const { ulid } = require('../main/core/ids');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { retailRoutes } = require('../main/routes/retail');
const { supplierRoutes } = require('../main/routes/suppliers');

function paymentsForBill(db: any, billId: number | string): any[] {
  return db.prepare('SELECT * FROM payments WHERE bill_id = ? ORDER BY created_at ASC').all(billId) as any[];
}

async function main() {
  console.log('Test: SYNC-0 foundation');
  console.log('='.repeat(50));

  const db = initTestDb();
  registerHospitalityHooks();
  const organization = getOrganizationContext();
  const location = getLocationContext();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-s0', 'SYNC-0 Test');
  seedProduct(db, 'prod-s0', 'cat-s0', 'S0 Widget', 10);
  seedProduct(db, 'prod-s0-tracked', 'cat-s0', 'S0 Tracked', 10, { track_inventory: true, stock_quantity: 100 });

  const app = createApp({
    '/api/orders': orderRoutes, '/api/bills': billRoutes,
    '/api/retail': retailRoutes, '/api/suppliers': supplierRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    // ══ PAYMENTS ═════════════════════════════════════════════════════════
    console.log('\n2-5. Hospitality payment flows into the authoritative model (payments + payment_events)');
    const order1 = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-s0', quantity: 2 }] }, headers: authHeader });
    assertEqual(order1.status, 201, 'hospitality order created');
    const bill1 = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: order1.data.order.id }, headers: authHeader });
    const pay1 = await api(baseUrl, `/api/bills/${bill1.data.bill.id}/payment`, { method: 'POST', body: { method: 'cash', amount: bill1.data.bill.total }, headers: authHeader });
    assertEqual(pay1.status, 200, 'hospitality cash payment succeeds');
    const hospPayments = paymentsForBill(db, bill1.data.bill.id);
    assertEqual(hospPayments.length, 1, 'the hospitality payment created exactly one authoritative payments row');
    assertEqual(hospPayments[0].adapter, 'cash', 'cash payment maps to the cash adapter');
    assertEqual(hospPayments[0].state, 'settled', 'cash settles immediately');
    const hospEvents = db.prepare('SELECT * FROM payment_events WHERE payment_id = ?').all(hospPayments[0].id) as any[];
    assertEqual(hospEvents.length, 1, 'a payment_event exists for the hospitality payment');
    assert(!!hospPayments[0].bill_uid, 'the hospitality payment carries a global bill_uid');
    assert(!!hospPayments[0].order_uid, 'the hospitality payment carries a global order_uid');
    assertEqual(hospPayments[0].organization_id, organization.id, 'the payment is stamped with the organization');

    console.log('\n3. Retail payment flows into the SAME authoritative model');
    const retail1 = await api(baseUrl, '/api/retail/checkout', {
      method: 'POST', body: { lines: [{ product_id: 'prod-s0', quantity: 1 }], tender: { adapter: 'cash', method: 'cash' } }, headers: authHeader,
    });
    assertEqual(retail1.status, 201, 'retail checkout succeeds');
    const retailBillId = retail1.data.bill?.id ?? retail1.data.bill_id ?? retail1.data.payment?.bill_id;
    const retailPayments = paymentsForBill(db, retailBillId);
    assertEqual(retailPayments.length, 1, 'the retail payment also created an authoritative payments row (same model, no split)');
    const retailEvents = db.prepare('SELECT * FROM payment_events WHERE payment_id = ?').all(retailPayments[0].id) as any[];
    assert(retailEvents.length >= 1, 'a payment_event exists for the retail payment');
    assert(!!retailPayments[0].bill_uid, 'the retail payment carries a global bill_uid');

    console.log('\n6. A payment either lands in both models or neither (atomic rollback)');
    // Proven end-to-end in plemmo-payment-service.test.ts §16. Here we assert
    // the invariant directly: for every bill marked paid, an authoritative
    // payment row exists — there is no "paid bill with no payment row".
    const paidBills = db.prepare("SELECT id FROM bills WHERE payment_status = 'paid'").all() as Array<{ id: number }>;
    for (const b of paidBills) {
      assert(paymentsForBill(db, b.id).length >= 1, `paid bill ${b.id} has at least one authoritative payment row — no silent gap`);
    }

    console.log('\n7. Payment history remains queryable through the new model');
    const allPayments = db.prepare('SELECT COUNT(*) AS c FROM payments').get() as { c: number };
    assert(allPayments.c >= 2, 'both the hospitality and retail payments are present in payments');

    console.log('\n9. A refund references the payment/bill/order by global uid');
    const refundResult = refundPayment({ paymentId: hospPayments[0].id, amountMinor: 500, reason: 'test refund' });
    const refundRow = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundResult.refund.id) as any;
    assertEqual(refundRow.payment_id, hospPayments[0].id, 'the refund references the payment (payment_id is already a ULID)');
    assertEqual(refundRow.bill_uid, hospPayments[0].bill_uid, 'the refund carries the same global bill_uid as its payment');
    assertEqual(refundRow.order_uid, hospPayments[0].order_uid, 'the refund carries the same global order_uid as its payment');

    // ══ UIDS ═════════════════════════════════════════════════════════════
    console.log('\n11-13. New order/order_item/bill rows always receive a uid');
    const orderRow = db.prepare('SELECT uid FROM orders WHERE id = ?').get(order1.data.order.id) as { uid: string | null };
    assert(!!orderRow.uid, 'a newly created order has a uid');
    const itemRow = db.prepare('SELECT uid FROM order_items WHERE order_id = ?').get(order1.data.order.id) as { uid: string | null };
    assert(!!itemRow.uid, 'a newly created order_item has a uid');
    const billRow = db.prepare('SELECT uid FROM bills WHERE id = ?').get(bill1.data.bill.id) as { uid: string | null };
    assert(!!billRow.uid, 'a newly created bill has a uid (POST /bills/generate path)');
    // Split-check bill path also stamps a uid.
    const splitBillsWithoutUid = db.prepare('SELECT COUNT(*) AS c FROM bills WHERE uid IS NULL').get() as { c: number };
    assertEqual(splitBillsWithoutUid.c, 0, 'no bill anywhere is missing a uid');
    const itemsWithoutUid = db.prepare('SELECT COUNT(*) AS c FROM order_items WHERE uid IS NULL').get() as { c: number };
    assertEqual(itemsWithoutUid.c, 0, 'no order_item anywhere is missing a uid');

    console.log('\n14. A payment resolves back to its order/bill by uid');
    const resolved = db.prepare(`
      SELECT p.id, o.uid AS o_uid, b.uid AS b_uid
      FROM payments p JOIN orders o ON o.uid = p.order_uid JOIN bills b ON b.uid = p.bill_uid
      WHERE p.id = ?
    `).get(hospPayments[0].id) as { o_uid: string; b_uid: string } | undefined;
    assert(!!resolved, 'the payment joins cleanly to its order and bill via the global uids');

    console.log('\n16. Duplicate uids are prevented');
    let dupRejected = false;
    try {
      db.prepare('INSERT INTO orders (order_number, uid, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('DUP-TEST', orderRow.uid, 'takeaway', now(), now());
    } catch { dupRejected = true; }
    assert(dupRejected, 'the partial unique index on orders.uid rejects a duplicate uid');

    // ══ TOMBSTONES ═══════════════════════════════════════════════════════
    console.log('\n17,19. Purchase-order line removal is a tombstone, absent from active queries');
    const supplier = await api(baseUrl, '/api/suppliers', { method: 'POST', body: { name: 'S0 Supplier' }, headers: authHeader });
    const po = createPurchaseOrder({ supplierId: supplier.data.supplier.id });
    const poItem = addItem(po.id, { productId: 'prod-s0', quantityOrdered: 5, unitCost: 3 });
    addItem(po.id, { productId: 'prod-s0-tracked', quantityOrdered: 2, unitCost: 4 });
    removeItem(po.id, poItem.id);
    const tombstoned = db.prepare('SELECT deleted_at FROM purchase_order_items WHERE id = ?').get(poItem.id) as { deleted_at: string | null };
    assert(!!tombstoned.deleted_at, 'the removed PO item is tombstoned (deleted_at set), not hard-deleted');
    const poView = getPurchaseOrder(po.id);
    assertEqual(poView.items.length, 1, 'the active PO view excludes the tombstoned line');
    assert(poView.items.every((i: any) => i.id !== poItem.id), 'the tombstoned line is not in the active listing');
    // markOrdered counts only active items; still has one, so it succeeds.
    const ordered = markOrdered(po.id);
    assertEqual(ordered.status, 'ordered', 'markOrdered counts only active items and succeeds with the one remaining');

    console.log('\n18,19. Transfer line removal is a tombstone, absent from active queries');
    const locB = ulid();
    db.prepare(`INSERT INTO locations (id, organization_id, name, code, is_active, created_at, updated_at) VALUES (?, ?, 'S0 Loc B', 'S0B', 1, ?, ?)`)
      .run(locB, organization.id, now(), now());
    const transfer = createTransfer({ fromLocationId: location.id, toLocationId: locB });
    const tItem = addTransferItem(transfer.id, { productId: 'prod-s0-tracked', quantity: 3 });
    addTransferItem(transfer.id, { productId: 'prod-s0-tracked', quantity: 1 });
    removeTransferItem(transfer.id, tItem.id);
    const tTomb = db.prepare('SELECT deleted_at FROM stock_transfer_items WHERE id = ?').get(tItem.id) as { deleted_at: string | null };
    assert(!!tTomb.deleted_at, 'the removed transfer item is tombstoned, not hard-deleted');
    const tView = getTransfer(transfer.id);
    assertEqual(tView.items.length, 1, 'the active transfer view excludes the tombstoned line');

    // ══ INVENTORY IDENTITY ═══════════════════════════════════════════════
    console.log('\n21,22. Inventory movements are stamped with an organization');
    adjustStock({ productId: 'prod-s0-tracked', quantityDelta: 5, reason: 'S0 restock', movementType: 'adjustment' });
    const movements = db.prepare("SELECT * FROM inventory_movements WHERE product_id = 'prod-s0-tracked' ORDER BY created_at DESC").all() as any[];
    assert(movements.length > 0, 'an inventory movement was recorded');
    assert(movements.every((m: any) => m.organization_id === organization.id), 'every inventory movement carries the organization id (Part D)');
    assert(movements.every((m: any) => m.location_id === location.id), 'every inventory movement carries a location id');

    console.log('\n23. No duplicate inventory balances after many operations');
    const dupBalances = db.prepare(`
      SELECT product_id, COALESCE(product_variant_id, '') AS v, COALESCE(location_id, '') AS l, COUNT(*) AS c
      FROM inventory_balances GROUP BY product_id, v, l HAVING c > 1
    `).all() as any[];
    assertEqual(dupBalances.length, 0, 'the (product, variant, location) balance key is still unique — no divergent duplicate balance');

    // ══ DEVICE CREDENTIALS ═══════════════════════════════════════════════
    console.log('\n24-26. Device credential foundation');
    const deviceRow = db.prepare('SELECT id FROM devices LIMIT 1').get() as { id: string } | undefined;
    const deviceId = deviceRow?.id ?? (() => { const id = ulid(); db.prepare("INSERT INTO devices (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)").run(id, now(), now()); return id; })();
    const cred = recordDeviceCredential({ deviceId, credentialType: 'device_keypair', publicKey: 'PUBLIC-KEY-MATERIAL-ONLY' });
    assertEqual(cred.status, 'active', 'a recorded credential is active');
    assertEqual(cred.public_key, 'PUBLIC-KEY-MATERIAL-ONLY', 'the public key is persisted');
    const active = getActiveDeviceCredential(deviceId);
    assertEqual(active?.id, cred.id, 'the active credential is retrievable');
    // Rotation: a second active credential rotates the first out.
    const cred2 = recordDeviceCredential({ deviceId, credentialType: 'device_keypair', publicKey: 'ROTATED-KEY' });
    assertEqual(getActiveDeviceCredential(deviceId)?.id, cred2.id, 'recording a new credential rotates in as the active one');
    assertEqual(db.prepare('SELECT status FROM device_credentials WHERE id = ?').get(cred.id).status, 'rotated', 'the previous credential is marked rotated');
    // Revocation.
    revokeDeviceCredential(cred2.id);
    assertEqual(db.prepare('SELECT status FROM device_credentials WHERE id = ?').get(cred2.id).status, 'revoked', 'a credential can be revoked');
    assertEqual(getActiveDeviceCredential(deviceId), null, 'a revoked device has no active credential');
    assertEqual(listDeviceCredentials(deviceId).length, 2, 'both credentials are retained for audit');
    // No private key column exists anywhere in the table.
    const cols = db.prepare("PRAGMA table_info(device_credentials)").all() as Array<{ name: string }>;
    const hasPrivate = cols.some((c) => /private|secret|priv_key|private_key/i.test(c.name));
    assert(!hasPrivate, 'device_credentials has NO column that could hold a private key (Part E)');
  } finally {
    server.close();
  }

  closeDatabase();
  const { passed, failed } = getResults();
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error('Test suite failed:', error); process.exit(1); });
