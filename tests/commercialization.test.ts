/**
 * Test: COMMERCIALIZATION — catalog/customer/supplier/operations sync,
 * production health, safe compensation, and licensing. REAL PostgreSQL + REAL
 * HTTP. Self-skips (exit 77) without PostgreSQL.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/commercialization.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-'));
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
const { uploadPendingBatch } = require('../main/core/sync/uploader');
const { pullAndApply } = require('../main/core/sync/downloader');
const { countOutboxByStatus } = require('../main/core/sync/outbox');
const { HttpSyncTransport } = require('../main/core/sync/http-transport');
const { getOrCreateDeviceKey } = require('../main/core/sync/device-identity');
const { PostgresCloudStore } = require('../cloud/postgres-store');
const { migrateToLatest } = require('../cloud/migrate');
const { createCloudServer, PLEMMO_PROTOCOL_VERSION } = require('../cloud/server');
const { signRequest } = require('../main/core/sync/signing');
const { ulid } = require('../main/core/ids');
const { snapshotProduct, snapshotCustomer, snapshotSupplier } = require('../main/core/sync/reference-entities');
const { createSupplier } = require('../main/modules/purchasing/suppliers');
const licensing = require('../main/core/licensing');
const { executeCompensation, executeInventoryCorrection } = require('../main/core/admin/compensation');
const { upsertConflict, getConflict } = require('../main/core/sync/conflict-store');
const { grantFeature } = require('../main/core/features');

function kp() {
  const k = nodeCrypto.generateKeyPairSync('ed25519');
  return { priv: nodeCrypto.createPrivateKey(k.privateKey.export({ type: 'pkcs8', format: 'pem' })), pub: k.publicKey.export({ type: 'spki', format: 'pem' }) };
}
function refEvent(org: string, loc: string, dev: string, entityType: string, uid: string, fields: any, version = 1) {
  return { uid: ulid(), device_id: dev, sequence: 1, entity_type: entityType, entity_uid: uid, organization_id: org, location_id: loc,
    payload: { schema_version: 1, entity_type: entityType, entity_uid: uid, organization_id: org, location_id: loc, snapshot_version: version, updated_at: now(), fields }, created_at: now() };
}
async function devEnroll(baseUrl: string, dev: string, org: string, loc: string, pub: string) {
  return (await (globalThis as any).fetch(`${baseUrl}/sync/v1/dev/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_uid: dev, organization_uid: org, location_uid: loc, public_key: pub }) })).status;
}
async function httpUpload(baseUrl: string, dev: string, priv: any, events: any[]) {
  const body = JSON.stringify({ events });
  const ts = new Date().toISOString(); const nonce = nodeCrypto.randomBytes(16).toString('hex');
  const sig = signRequest(priv, 'POST', '/sync/v1/upload', ts, nonce, body);
  const res = await (globalThis as any).fetch(`${baseUrl}/sync/v1/upload`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-plemmo-device': dev, 'x-plemmo-timestamp': ts, 'x-plemmo-nonce': nonce, 'x-plemmo-signature': sig }, body });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function main() {
  console.log('Test: COMMERCIALIZATION (real PostgreSQL + real HTTP)');
  console.log('='.repeat(50));
  try {
    const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
    await probe.query('SELECT 1'); await probe.end();
  } catch (e) {
    console.log(`  ⏭ No reachable PostgreSQL — skipping (${(e as Error).message})`); process.exit(77);
  }
  const schema = `comm_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await admin.query(`CREATE SCHEMA "${schema}"`); await admin.end();
  const pool = new Pool({ connectionString: DSN, options: `-c search_path=${schema}`, max: 8, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });

  const db = initTestDb();
  const org = getOrganizationContext().id;
  const loc = getLocationContext().id;
  const deviceId = getDeviceContext().id;
  const OWNER = { userId: 'owner-c', role: 'owner' };
  const CASHIER = { userId: 'cashier-c', role: 'cashier' };
  db.prepare(`INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES ('owner-c','Owner','o@t','x','owner',1,?,?)`).run(now(), now());

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

    // ══ PRODUCTION ═══════════════════════════════════════════════════════════
    console.log('\n1-4. Production health / readiness / protocol');
    const health = await (globalThis as any).fetch(`${baseUrl}/health`);
    assertEqual(health.status, 200, '1. /health returns 200 (liveness, no auth)');
    assertEqual((await health.json()).protocol, PLEMMO_PROTOCOL_VERSION, '1b. health reports the protocol version');
    const ready = await (globalThis as any).fetch(`${baseUrl}/ready`);
    assertEqual(ready.status, 200, '2. /ready returns 200 when the datastore is reachable');
    assertEqual(health.headers.get('x-plemmo-protocol'), PLEMMO_PROTOCOL_VERSION, '3. every response carries X-Plemmo-Protocol');
    assert(!!PLEMMO_PROTOCOL_VERSION, '4. protocol version constant exists');

    // ══ CATALOG SYNC ═════════════════════════════════════════════════════════
    console.log('\n5-9. Catalog sync (product) — emit, upload, cloud, mirror apply');
    db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, track_inventory, stock_quantity, low_stock_threshold, is_active, sort_order, created_at, updated_at)
                VALUES ('prod-c', NULL, 'C Widget', 10, 4, 'SKUC', 1, 100, 5, 1, 0, ?, ?)`).run(now(), now());
    const ev = snapshotProduct(db, 'prod-c');
    assert(!!ev, '5. a product write emits a catalog snapshot');
    const up = await uploadPendingBatch(transport, deviceId, 200, db);
    assert(up.acked >= 1, '6. the product snapshot uploads and is acked');
    assertEqual(countOutboxByStatus('pending', db), 0, '6b. nothing left pending');
    const cloudKinds = new Set((await pool.query(`SELECT DISTINCT entity_type FROM cloud_events WHERE organization_uid=$1`, [org])).rows.map((r: any) => r.entity_type));
    assert(cloudKinds.has('product'), '7. the product persisted in the cloud feed');
    // A second device publishes a product → local pulls into the mirror.
    const d2 = { ...kp(), id: ulid() };
    await devEnroll(baseUrl, d2.id, org, loc, d2.pub);
    const rProd = ulid();
    await httpUpload(baseUrl, d2.id, d2.priv, [refEvent(org, loc, d2.id, 'product', rProd, { id: rProd, name: 'Remote Widget', price: 5, is_active: 1 })]);
    const outboxBefore = (db.prepare('SELECT COUNT(*) AS c FROM sync_outbox').get() as any).c;
    const dl = await pullAndApply(transport, deviceId, 200, db);
    assert(dl.applied >= 1, '8. the remote product applied into the mirror');
    assert(!!db.prepare("SELECT 1 FROM remote_reference_entities WHERE entity_type='product' AND uid=?").get(rProd), '8b. it landed in remote_reference_entities');
    assert(!db.prepare('SELECT 1 FROM products WHERE id=?').get(rProd), '9. a remote product NEVER entered the authoritative catalog (mirror-only, no duplicate)');
    assertEqual((db.prepare('SELECT COUNT(*) AS c FROM sync_outbox').get() as any).c, outboxBefore, '9b. remote apply produced NO new outbox event (loop prevention)');

    // ══ CUSTOMER + SUPPLIER SYNC ═════════════════════════════════════════════
    console.log('\n10-13. Customer + supplier sync');
    db.prepare(`INSERT INTO customers (id, name, phone, is_active, created_at, updated_at) VALUES ('cust-c','Alice','+10000000000',1,?,?)`).run(now(), now());
    assert(!!snapshotCustomer(db, 'cust-c'), '10. a customer write emits a snapshot');
    const sup = createSupplier({ name: 'Acme Supplies' });
    assert(!!db.prepare("SELECT 1 FROM sync_outbox WHERE entity_type='supplier' AND entity_uid=?").get(sup.id), '11. createSupplier emits a supplier snapshot');
    await uploadPendingBatch(transport, deviceId, 200, db);
    const rCust = ulid();
    await httpUpload(baseUrl, d2.id, d2.priv, [refEvent(org, loc, d2.id, 'customer', rCust, { id: rCust, name: 'Bob', phone: '+2' })]);
    await pullAndApply(transport, deviceId, 200, db);
    assert(!!db.prepare("SELECT 1 FROM remote_reference_entities WHERE entity_type='customer' AND uid=?").get(rCust), '12. a remote customer applied into the mirror (no duplicate of a local customer)');
    // Idempotency: re-pull applies nothing new; a higher version advances.
    const dl2 = await pullAndApply(transport, deviceId, 200, db);
    assertEqual(dl2.applied, 0, '13. re-pull is idempotent (ULID identity)');

    // ══ OPERATIONS SYNC (PO / transfer as versioned snapshots) ═══════════════
    console.log('\n14-16. Operations sync + version advance');
    const rPo = ulid();
    await httpUpload(baseUrl, d2.id, d2.priv, [refEvent(org, loc, d2.id, 'purchase_order', rPo, { id: rPo, status: 'ordered' }, 1)]);
    await pullAndApply(transport, deviceId, 200, db);
    assertEqual((db.prepare("SELECT snapshot_version AS v FROM remote_reference_entities WHERE entity_type='purchase_order' AND uid=?").get(rPo) as any).v, 1, '14. a remote PO snapshot applied at v1');
    await httpUpload(baseUrl, d2.id, d2.priv, [refEvent(org, loc, d2.id, 'purchase_order', rPo, { id: rPo, status: 'received' }, 3)]);
    await pullAndApply(transport, deviceId, 200, db);
    const poMirror = db.prepare("SELECT snapshot_version AS v, payload FROM remote_reference_entities WHERE entity_type='purchase_order' AND uid=?").get(rPo) as any;
    assertEqual(poMirror.v, 3, '15. a higher-version PO snapshot advances the mirror (state-transition aware)');
    // Stale (lower version) is ignored.
    await httpUpload(baseUrl, d2.id, d2.priv, [refEvent(org, loc, d2.id, 'purchase_order', rPo, { id: rPo, status: 'draft' }, 2)]);
    await pullAndApply(transport, deviceId, 200, db);
    assertEqual((db.prepare("SELECT snapshot_version AS v FROM remote_reference_entities WHERE entity_type='purchase_order' AND uid=?").get(rPo) as any).v, 3, '16. a stale (lower-version) snapshot is ignored');

    // ══ SECURITY ═════════════════════════════════════════════════════════════
    console.log('\n17-19. Security (reference entities honor the same isolation)');
    const atk = { ...kp(), id: ulid() };
    await devEnroll(baseUrl, atk.id, 'org-other-c', loc, atk.pub);
    const spoof = await httpUpload(baseUrl, atk.id, atk.priv, [refEvent(org, loc, atk.id, 'product', ulid(), { id: 'x', name: 'spoof' })]);
    assertEqual(spoof.data.rejected[0].reason, 'organization mismatch', '17. a product claiming another org is rejected');
    await store.revokeDevice(atk.id);
    const revoked = await httpUpload(baseUrl, atk.id, atk.priv, [refEvent('org-other-c', loc, atk.id, 'product', ulid(), { id: 'y', name: 'z' })]);
    assertEqual(revoked.status, 401, '18. a revoked device cannot sync catalog');
    const tampered = await (globalThis as any).fetch(`${baseUrl}/sync/v1/pull?cursor=0`, { headers: { 'x-plemmo-device': deviceId, 'x-plemmo-timestamp': new Date().toISOString(), 'x-plemmo-nonce': 'n', 'x-plemmo-signature': 'AAAA' } });
    assertEqual(tampered.status, 401, '19. a tampered request is rejected');

    // ══ COMPENSATION (safe refund + inventory manual) ════════════════════════
    console.log('\n20-24. Safe compensation execution');
    // A settled payment + a payment_conflict to compensate.
    const payId = ulid(); const billUid = ulid();
    const orderRun = db.prepare(`INSERT INTO orders (uid, order_number, organization_id, location_id, type, status, total, created_at, updated_at)
                VALUES (?, 'O-COMP', ?, ?, 'takeaway', 'completed', 10, ?, ?)`).run(ulid(), org, loc, now(), now());
    const billRun = db.prepare(`INSERT INTO bills (bill_number, uid, order_id, subtotal, tax_amount, total, paid_amount, balance, payment_status, created_at, updated_at)
                VALUES (?, ?, ?, 10, 0, 10, 10, 0, 'paid', ?, ?)`).run('B-' + billUid.slice(-4), billUid, orderRun.lastInsertRowid, now(), now());
    const billId = billRun.lastInsertRowid;
    db.prepare(`INSERT INTO payments (id, bill_id, order_id, bill_uid, order_uid, adapter, method, state, amount_minor, currency, refunded_minor, tendered_minor, change_minor, provider_reference, actor_user_id, notes, metadata, requested_at, settled_at, created_at, updated_at, organization_id, location_id)
                VALUES (?, ?, NULL, ?, NULL, 'manual_card', 'card', 'settled', 1000, 'GBP', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)`)
      .run(payId, billId, billUid, now(), now(), now(), now(), org, loc);
    upsertConflict({ conflictUid: 'comp1', organizationId: org, locationId: loc, entityType: 'bill', entityUid: billUid, conflictType: 'payment_conflict', source: 'local' }, db);
    const comp = executeCompensation({ conflictUid: 'comp1', action: 'refund', paymentId: payId, amountMinor: 400, user: OWNER });
    assert(!!comp.result, '20. a safe refund compensation executed through the audited primitive');
    assertEqual((db.prepare('SELECT refunded_minor AS r FROM payments WHERE id=?').get(payId) as any).r, 400, '21. the refund was applied exactly once');
    assertEqual((getConflict('comp1') as any).status, 'resolved', '22. the conflict was linked + resolved via compensation');
    // Exactly-once: repeat the same compensation → idempotent, no double refund.
    executeCompensation({ conflictUid: 'comp1', action: 'refund', paymentId: payId, amountMinor: 400, user: OWNER });
    assertEqual((db.prepare('SELECT refunded_minor AS r FROM payments WHERE id=?').get(payId) as any).r, 400, '23. repeating the compensation did NOT double-refund (exactly-once)');
    const invc = executeInventoryCorrection({ conflictUid: 'comp1', productId: 'prod-c', quantityDelta: -2, reason: 'shrinkage', user: OWNER });
    assert(!!invc.movement, '24. inventory correction executes safely (now automated, exactly-once)');
    const invBal1 = (db.prepare("SELECT quantity AS q FROM inventory_balances WHERE product_id='prod-c'").get() as any)?.q;
    executeInventoryCorrection({ conflictUid: 'comp1', productId: 'prod-c', quantityDelta: -2, reason: 'shrinkage', user: OWNER });
    assertEqual((db.prepare("SELECT quantity AS q FROM inventory_balances WHERE product_id='prod-c'").get() as any)?.q, invBal1, '24b. repeating the inventory correction did NOT double-apply (exactly-once)');
    // A cashier cannot compensate.
    let denied = false; try { executeCompensation({ conflictUid: 'comp1', action: 'void', paymentId: payId, user: CASHIER }); } catch { denied = true; }
    assert(denied, '24b. a cashier cannot execute compensation (sales.reconcile only)');

    // ══ LICENSING ════════════════════════════════════════════════════════════
    console.log('\n25-31. Licensing foundation');
    licensing.clearLicense();
    assertEqual(licensing.effectiveStatus(), 'unlicensed', '25. no license → unlicensed');
    grantFeature(org, 'retail.catalog');
    const future = new Date(Date.now() + 30 * 864e5).toISOString();
    licensing.activateLicense({ status: 'active', plan: 'pilot', organization_uid: org, issued_at: now(), activated_at: now(), expires_at: future, grace_days: 7, device_limit: 3, location_limit: 2, features: ['retail.catalog'], last_verified_at: now(), signature: null });
    assertEqual(licensing.effectiveStatus(), 'active', '26. an activated, unexpired license is active');
    assert(licensing.isFeatureLicensed('retail.catalog', org), '27. a granted + licensed feature is entitled');
    assert(!licensing.isFeatureLicensed('retail.barcode', org), '27b. a feature outside the license is not entitled');
    // Expiry within grace vs beyond grace.
    const expired = new Date(Date.now() - 2 * 864e5).toISOString();
    const lic = licensing.getLicense(); lic.expires_at = expired; licensing.setLicense(lic);
    assertEqual(licensing.effectiveStatus(lic, Date.now()), 'grace', '28. just-expired within grace_days → grace (offline grace, not a lockout)');
    assertEqual(licensing.effectiveStatus(lic, Date.now() + 10 * 864e5), 'expired', '29. beyond the grace window → expired');
    assert(licensing.withinOfflineGrace(lic, Date.now()), '30. offline-grace is reported while within it');
    const revokedLic = licensing.getLicense(); revokedLic.status = 'revoked'; licensing.setLicense(revokedLic);
    assertEqual(licensing.effectiveStatus(revokedLic, Date.now()), 'revoked', '31. a revoked license never gets grace');
    assert(!licensing.isFeatureLicensed('retail.catalog', org), '31b. a revoked license entitles nothing');
    const refreshed = await licensing.refreshLicense({ verify: async () => { throw new Error('offline'); } }, org);
    assert(!!refreshed, '31c. a failed verification keeps the cached license (never strands a merchant)');

    // ══ REGRESSION ═══════════════════════════════════════════════════════════
    console.log('\n32-36. Regression');
    assert(!!db.prepare('SELECT 1 FROM products WHERE id=?').get('prod-c'), '32. authoritative catalog intact');
    assert(!!db.prepare('SELECT 1 FROM customers WHERE id=?').get('cust-c'), '33. authoritative customers intact');
    assert(!!db.prepare('SELECT 1 FROM suppliers WHERE id=?').get(sup.id), '34. authoritative suppliers intact');
    const kinds = new Set((await pool.query(`SELECT DISTINCT entity_type FROM cloud_events WHERE organization_uid=$1`, [org])).rows.map((r: any) => r.entity_type));
    assert(kinds.has('product') && kinds.has('customer') && kinds.has('supplier'), '35. product + customer + supplier all synced through one feed');
    assert(getResults().failed === 0, '36. no failures so far (in-suite invariant)');
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
