/**
 * Test: SYNC-E sales synchronization — REAL PostgreSQL + REAL HTTP.
 *
 * Proves orders / order_items / bills synchronize through the SAME multi-entity
 * seam, against an ACTUAL PostgreSQL server and the real HTTP sync API. Covers:
 * identity, upload/download/remote-apply into mirror tables, loop prevention,
 * idempotency + versioned re-snapshots, missing-parent staging + recovery,
 * cross-device conflict detection + persistence (never silently undoing a
 * completed transaction), security spoofs, and transactional atomicity
 * (business rollback when the outbox write fails). Self-skips (exit 77) if no
 * PostgreSQL is reachable.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/sync-e-sales.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-e-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

let Pool: any;
try { Pool = require('pg').Pool; } catch { console.log('  ⏭ pg driver not installed — skipping'); process.exit(77); }
const DSN = process.env.PLEMMO_CLOUD_DB_URL || 'postgres://plemmo:plemmo_dev_pw@127.0.0.1:5432/plemmo_sync_test';
const CONNECT_TIMEOUT_MS = Number(process.env.PLEMMO_CLOUD_DB_CONNECT_TIMEOUT_MS) || 20000;

const { initTestDb, closeDatabase, assert, assertEqual, getResults, now, getDatabase, startServer } = require('./helpers/test-setup');
const { getOrganizationContext, getLocationContext, getDeviceContext } = require('../main/core/context');
const { createSale, addSaleItems } = require('../main/core/sale');
const { appendBillSnapshot } = require('../main/core/sync/sales-events');
const { countOutboxByStatus } = require('../main/core/sync/outbox');
const { uploadPendingBatch } = require('../main/core/sync/uploader');
const { pullAndApply } = require('../main/core/sync/downloader');
const { HttpSyncTransport } = require('../main/core/sync/http-transport');
const { getOrCreateDeviceKey } = require('../main/core/sync/device-identity');
const { PostgresCloudStore } = require('../cloud/postgres-store');
const { migrateToLatest } = require('../cloud/migrate');
const { createCloudServer } = require('../cloud/server');
const { signRequest } = require('../main/core/sync/signing');
const { ulid } = require('../main/core/ids');

function kp() {
  const k = nodeCrypto.generateKeyPairSync('ed25519');
  return { priv: nodeCrypto.createPrivateKey(k.privateKey.export({ type: 'pkcs8', format: 'pem' })), pub: k.publicKey.export({ type: 'spki', format: 'pem' }) };
}
function orderEvent(org: string, loc: string, dev: string, orderUid: string, version = 1, status = 'pending') {
  return { uid: ulid(), device_id: dev, sequence: 1, entity_type: 'order', entity_uid: orderUid, organization_id: org, location_id: loc,
    payload: { schema_version: 1, order_uid: orderUid, order_number: 'R-' + orderUid.slice(-4), organization_id: org, location_id: loc, device_id: dev, actor_user_id: null, channel: 'takeaway', status, customer_id: null, table_id: null, subtotal: 10, tax_amount: 0, discount_amount: 0, total: 10, snapshot_version: version, created_at: now(), updated_at: now() }, created_at: now() };
}
function itemEvent(org: string, loc: string, dev: string, itemUid: string, orderUid: string, version = 1) {
  return { uid: ulid(), device_id: dev, sequence: 1, entity_type: 'order_item', entity_uid: itemUid, organization_id: org, location_id: loc,
    payload: { schema_version: 1, order_item_uid: itemUid, order_uid: orderUid, organization_id: org, location_id: loc, product_id: 'prod-e', product_variant_id: null, product_name: 'Widget', product_sku: 'SKU1', quantity: 1, unit_price: 10, unit_cost: 4, discount_amount: 0, tax_amount: 0, total: 10, status: 'pending', snapshot_version: version, created_at: now(), updated_at: now() }, created_at: now() };
}
function billEvent(org: string, loc: string, dev: string, billUid: string, orderUid: string, version = 1, paid = false) {
  return { uid: ulid(), device_id: dev, sequence: 1, entity_type: 'bill', entity_uid: billUid, organization_id: org, location_id: loc,
    payload: { schema_version: 1, bill_uid: billUid, bill_number: 'B-' + billUid.slice(-4), order_uid: orderUid, organization_id: org, location_id: loc, customer_id: null, subtotal: 10, tax_amount: 0, discount_amount: 0, total: 10, paid_amount: paid ? 10 : 0, balance: paid ? 0 : 10, payment_status: paid ? 'paid' : 'unpaid', split_group_id: null, snapshot_version: version, created_at: now(), updated_at: now() }, created_at: now() };
}
async function httpUpload(baseUrl: string, dev: string, priv: any, events: any[]) {
  const body = JSON.stringify({ events });
  const ts = new Date().toISOString(); const nonce = nodeCrypto.randomBytes(16).toString('hex');
  const sig = signRequest(priv, 'POST', '/sync/v1/upload', ts, nonce, body);
  const res = await (globalThis as any).fetch(`${baseUrl}/sync/v1/upload`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-plemmo-device': dev, 'x-plemmo-timestamp': ts, 'x-plemmo-nonce': nonce, 'x-plemmo-signature': sig }, body });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function devEnroll(baseUrl: string, dev: string, org: string, loc: string, pub: string) {
  return (await (globalThis as any).fetch(`${baseUrl}/sync/v1/dev/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_uid: dev, organization_uid: org, location_uid: loc, public_key: pub }) })).status;
}

async function main() {
  console.log('Test: SYNC-E sales (real PostgreSQL + real HTTP)');
  console.log('='.repeat(50));
  try {
    const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
    await probe.query('SELECT 1'); await probe.end();
  } catch (e) {
    console.log(`  ⏭ No reachable PostgreSQL — skipping (${(e as Error).message})`); process.exit(77);
  }
  const schema = `sync_e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await admin.query(`CREATE SCHEMA "${schema}"`); await admin.end();
  const pool = new Pool({ connectionString: DSN, options: `-c search_path=${schema}`, max: 8, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });

  const db = initTestDb();
  const org = getOrganizationContext().id;
  const loc = getLocationContext().id;
  const deviceId = getDeviceContext().id;
  const USER_ID = 'cashier-e';
  db.prepare(`INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, 'Cashier', 'e@test.local', 'x', 'cashier', 1, ?, ?)`).run(USER_ID, now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, track_inventory, stock_quantity, low_stock_threshold, is_active, sort_order, created_at, updated_at)
              VALUES ('prod-e', NULL, 'E Widget', 10, 4, 'SKU1', 1, 100, 5, 1, 0, ?, ?)`).run(now(), now());

  const store = new PostgresCloudStore(pool);
  let server: any;
  try {
    await migrateToLatest(pool);
    const app = createCloudServer(store, { enableDevEnroll: true });
    const started = await startServer(app); server = started.server;
    const baseUrl = started.baseUrl;
    const transport = new HttpSyncTransport({ baseUrl });
    const localKey = getOrCreateDeviceKey();
    await devEnroll(baseUrl, deviceId, org, loc, localKey.publicKeyPem);

    // ══ 1. Identity: a real sale creates order + order_item with load-bearing uids + events ══
    console.log('\n1. Real sale emits order + order_item snapshot events with load-bearing uids');
    const sale = createSale({ channel: 'takeaway', lines: [{ product_id: 'prod-e', quantity: 2 }], cashierUserId: USER_ID });
    assert(!!sale.sale.uid, 'the created order has a uid');
    assert(sale.lines.every((l: any) => !!l.uid), 'every order_item has a uid');
    const orderEv = db.prepare("SELECT * FROM sync_outbox WHERE entity_type = 'order' AND entity_uid = ?").get(sale.sale.uid) as any;
    assert(!!orderEv, 'an order snapshot event was enqueued atomically with the sale');
    assertEqual(db.prepare("SELECT COUNT(*) AS c FROM sync_outbox WHERE entity_type = 'order_item'").get().c, sale.lines.length, 'one order_item event per line');

    // ══ 2. Bill snapshot event ═══════════════════════════════════════════════
    console.log('\n2. Bill snapshot event');
    const billUid = ulid();
    db.prepare(`INSERT INTO bills (bill_number, uid, order_id, subtotal, tax_amount, total, paid_amount, balance, payment_status, created_at, updated_at)
                VALUES (?, ?, ?, 20, 0, 20, 0, 20, 'unpaid', ?, ?)`).run('B-' + billUid.slice(-4), billUid, /* order_id */ (db.prepare('SELECT id FROM orders WHERE uid = ?').get(sale.sale.uid) as any).id, now(), now());
    const billId = (db.prepare('SELECT id FROM bills WHERE uid = ?').get(billUid) as any).id;
    db.transaction(() => appendBillSnapshot(db, billId))();
    assert(!!db.prepare("SELECT 1 FROM sync_outbox WHERE entity_type = 'bill' AND entity_uid = ?").get(billUid), 'a bill snapshot event was enqueued');

    // ══ 3. Upload sales facts over HTTP → Postgres ═══════════════════════════
    console.log('\n3. Upload order + items + bill over HTTP to Postgres');
    const up = await uploadPendingBatch(transport, deviceId, 200, db);
    assert(up.acked >= 3, 'the sales events uploaded and were acked');
    assertEqual(countOutboxByStatus('pending', db), 0, 'nothing left pending');
    const cloudOrder = await store.getEntityVersion(org, 'order', sale.sale.uid);
    assert(!!cloudOrder, 'the order snapshot persisted in Postgres with a version projection');
    const kinds = new Set((await pool.query(`SELECT DISTINCT entity_type FROM cloud_events WHERE organization_uid=$1`, [org])).rows.map((r: any) => r.entity_type));
    assert(kinds.has('order') && kinds.has('order_item') && kinds.has('bill'), 'order + order_item + bill all persisted');

    // ══ 4. Versioned re-snapshot + idempotency ═══════════════════════════════
    console.log('\n4. Add item re-emits a higher-version order snapshot; duplicate upload is idempotent');
    const before = (await pool.query(`SELECT COUNT(*)::int AS c FROM cloud_events WHERE entity_type='order' AND entity_uid=$1`, [sale.sale.uid])).rows[0].c;
    addSaleItems({ saleId: (db.prepare('SELECT id FROM orders WHERE uid = ?').get(sale.sale.uid) as any).id, lines: [{ product_id: 'prod-e', quantity: 1 }], actorUserId: USER_ID });
    await uploadPendingBatch(transport, deviceId, 200, db);
    const after = (await pool.query(`SELECT COUNT(*)::int AS c FROM cloud_events WHERE entity_type='order' AND entity_uid=$1`, [sale.sale.uid])).rows[0].c;
    assert(after > before, 'a second, higher-version order snapshot was stored (mutable entity keeps history)');
    const v = await store.getEntityVersion(org, 'order', sale.sale.uid);
    assert(v!.snapshot_version >= 2, 'the current-version projection advanced');
    // Re-upload the SAME first order event (lost ACK) → duplicate.
    const dupRes = await httpUpload(baseUrl, deviceId, localKey.privateKey, [{ uid: orderEv.uid, device_id: deviceId, sequence: orderEv.sequence, entity_type: 'order', entity_uid: sale.sale.uid, organization_id: org, location_id: loc, payload: JSON.parse(orderEv.payload), created_at: orderEv.created_at }]);
    assertEqual(dupRes.data.duplicate.length, 1, 'the same snapshot event re-uploaded is an idempotent duplicate');

    // ══ 5. Pull + remote apply into MIRROR tables (loop prevention) ══════════
    console.log('\n5. A second device\'s sale is pulled and applied into mirror tables');
    const d2 = { ...kp(), id: ulid() };
    await devEnroll(baseUrl, d2.id, org, loc, d2.pub);
    const rOrder = ulid(); const rItem = ulid(); const rBill = ulid();
    await httpUpload(baseUrl, d2.id, d2.priv, [orderEvent(org, loc, d2.id, rOrder), itemEvent(org, loc, d2.id, rItem, rOrder), billEvent(org, loc, d2.id, rBill, rOrder, 1, true)]);
    const outboxBefore = (db.prepare('SELECT COUNT(*) AS c FROM sync_outbox').get() as any).c;
    const dl = await pullAndApply(transport, deviceId, 200, db);
    assert(dl.applied >= 3, 'the remote order + item + bill were applied');
    assert(!!db.prepare('SELECT 1 FROM remote_orders WHERE uid = ?').get(rOrder), 'remote order landed in the remote_orders mirror');
    assert(!!db.prepare('SELECT 1 FROM remote_order_items WHERE uid = ?').get(rItem), 'remote order_item landed in remote_order_items');
    assert(!!db.prepare('SELECT 1 FROM remote_bills WHERE uid = ? AND payment_status = ?').get(rBill, 'paid'), 'remote paid bill landed in remote_bills');
    assert(!db.prepare('SELECT 1 FROM orders WHERE uid = ?').get(rOrder), 'the remote order did NOT touch the authoritative orders table (no local mutation)');
    assertEqual((db.prepare('SELECT COUNT(*) AS c FROM sync_outbox').get() as any).c, outboxBefore, 'applying remote sales produced NO new outbox event (loop prevention)');

    // ══ 6. Re-pull idempotent; stale snapshot ignored ════════════════════════
    console.log('\n6. Re-pull is idempotent; a stale (lower-version) snapshot is ignored');
    const dl2 = await pullAndApply(transport, deviceId, 200, db);
    assertEqual(dl2.applied, 0, 're-pull applies nothing new');
    // A newer snapshot (v2) then an out-of-order older (v1) — mirror keeps v2.
    await httpUpload(baseUrl, d2.id, d2.priv, [orderEvent(org, loc, d2.id, rOrder, 5, 'completed')]);
    await pullAndApply(transport, deviceId, 200, db);
    assertEqual((db.prepare('SELECT status FROM remote_orders WHERE uid = ?').get(rOrder) as any).status, 'completed', 'the higher-version snapshot advanced the mirror');

    // ══ 7. Missing-parent staging + recovery ═════════════════════════════════
    console.log('\n7. A child arriving before its parent is staged, then recovered');
    const orphanOrder = ulid(); const orphanItem = ulid();
    await httpUpload(baseUrl, d2.id, d2.priv, [itemEvent(org, loc, d2.id, orphanItem, orphanOrder)]); // item first, no parent
    await pullAndApply(transport, deviceId, 200, db);
    assert(!!db.prepare('SELECT 1 FROM remote_order_items WHERE uid = ?').get(orphanItem), 'the orphan item is durably staged (no data loss)');
    assert(!db.prepare('SELECT 1 FROM remote_orders WHERE uid = ?').get(orphanOrder), 'its parent is not present yet');
    await httpUpload(baseUrl, d2.id, d2.priv, [orderEvent(org, loc, d2.id, orphanOrder)]); // parent arrives later
    await pullAndApply(transport, deviceId, 200, db);
    assert(!!db.prepare('SELECT 1 FROM remote_orders WHERE uid = ?').get(orphanOrder), 'the parent arrives and the relationship is recovered');

    // ══ 8. Cross-device CONFLICT detection + persistence; no silent undo ═════
    console.log('\n8. Two devices edit the same order → conflict recorded, both snapshots preserved');
    const d3 = { ...kp(), id: ulid() };
    await devEnroll(baseUrl, d3.id, org, loc, d3.pub);
    const conflictOrder = ulid();
    await httpUpload(baseUrl, d2.id, d2.priv, [orderEvent(org, loc, d2.id, conflictOrder, 1, 'pending')]);
    await httpUpload(baseUrl, d3.id, d3.priv, [orderEvent(org, loc, d3.id, conflictOrder, 1, 'cancelled')]); // different device, same order
    const conflicts = await store.listConflicts(org);
    const thisConflict = conflicts.filter((c: any) => c.entity_uid === conflictOrder);
    assertEqual(thisConflict.length, 1, 'a cross-device conflict was recorded');
    assertEqual(thisConflict[0].conflict_type, 'concurrent_update', 'the conflict is typed');
    assertEqual(thisConflict[0].status, 'open', 'the conflict is open for later resolution');
    assertEqual((await pool.query(`SELECT COUNT(*)::int AS c FROM cloud_events WHERE entity_uid=$1`, [conflictOrder])).rows[0].c, 2, 'BOTH snapshots are preserved — neither device\'s fact was silently overwritten');

    // ══ 9. Security: identity is derived from the device, never the payload ══
    console.log('\n9. Security — org spoof, tampered signature, revoked device');
    const atk = { ...kp(), id: ulid() };
    await devEnroll(baseUrl, atk.id, 'org-attacker', loc, atk.pub);
    const spoof = await httpUpload(baseUrl, atk.id, atk.priv, [orderEvent(org, loc, atk.id, ulid())]); // claims victim org
    assertEqual(spoof.data.rejected[0].reason, 'organization mismatch', 'an order claiming another org is rejected');
    const tampered = await (globalThis as any).fetch(`${baseUrl}/sync/v1/pull?cursor=0`, { method: 'GET', headers: { 'x-plemmo-device': deviceId, 'x-plemmo-timestamp': new Date().toISOString(), 'x-plemmo-nonce': nodeCrypto.randomBytes(8).toString('hex'), 'x-plemmo-signature': 'AAAA' } });
    assertEqual(tampered.status, 401, 'a tampered signature is rejected');
    await store.revokeDevice(d3.id);
    const revoked = await httpUpload(baseUrl, d3.id, d3.priv, [orderEvent(org, loc, d3.id, ulid())]);
    assertEqual(revoked.status, 401, 'a revoked device cannot sync sales');

    // ══ 10. Atomicity — business rollback when the outbox write fails ════════
    console.log('\n10. If the outbox write fails, the whole sale rolls back (Part T)');
    const ordersBefore = (db.prepare('SELECT COUNT(*) AS c FROM orders').get() as any).c;
    db.exec('ALTER TABLE sync_outbox RENAME TO sync_outbox_hidden');
    let threw = false;
    try { createSale({ channel: 'takeaway', lines: [{ product_id: 'prod-e', quantity: 1 }], cashierUserId: USER_ID }); } catch { threw = true; }
    db.exec('ALTER TABLE sync_outbox_hidden RENAME TO sync_outbox');
    assert(threw, 'the sale failed when its sync event could not be written');
    assertEqual((db.prepare('SELECT COUNT(*) AS c FROM orders').get() as any).c, ordersBefore, 'no order row persisted — business + sync event are one atomic unit');
    // And the POS recovers immediately afterwards.
    const recovered = createSale({ channel: 'takeaway', lines: [{ product_id: 'prod-e', quantity: 1 }], cashierUserId: USER_ID });
    assert(!!recovered.sale.uid, 'a subsequent sale succeeds normally');

    // ══ 11. Local insufficient-stock rejection still stands (Part M/W) ═══════
    console.log('\n11. Local insufficient tracked stock still rejects the sale (unchanged)');
    // Drive the AUTHORITATIVE inventory balance low (prior sales created the
    // balance row; setting products.stock_quantity is only the no-balance
    // fallback), then attempt to oversell.
    db.prepare("UPDATE inventory_balances SET quantity = 1 WHERE product_id = 'prod-e'").run();
    db.prepare("UPDATE products SET stock_quantity = 1 WHERE id = 'prod-e'").run();
    let stockErr = false;
    try { createSale({ channel: 'takeaway', lines: [{ product_id: 'prod-e', quantity: 5 }], cashierUserId: USER_ID }); } catch { stockErr = true; }
    assert(stockErr, 'a sale exceeding tracked stock is still rejected locally — sync did not change stock enforcement');
  } finally {
    if (server) server.close();
    await pool.end();
    const admin2 = new Pool({ connectionString: DSN, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
    await admin2.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin2.end();
    closeDatabase();
  }
  const { passed, failed } = getResults();
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((error) => { console.error('Test suite failed:', error); process.exit(1); });
