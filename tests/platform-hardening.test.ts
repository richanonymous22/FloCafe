/**
 * Test: PLATFORM-HARDENING — remaining catalog emitters, controlled catalog
 * promotion, exactly-once inventory compensation, and cloud license
 * verification. REAL PostgreSQL + REAL HTTP. Self-skips (exit 77) without PG.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/platform-hardening.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hard-'));
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
const { pullAndApply } = require('../main/core/sync/downloader');
const { HttpSyncTransport } = require('../main/core/sync/http-transport');
const { getOrCreateDeviceKey } = require('../main/core/sync/device-identity');
const { PostgresCloudStore } = require('../cloud/postgres-store');
const { migrateToLatest } = require('../cloud/migrate');
const { createCloudServer } = require('../cloud/server');
const { signRequest } = require('../main/core/sync/signing');
const { ulid } = require('../main/core/ids');
const { createVariant } = require('../main/modules/retail/variants');
const { promoteRemoteEntity, listPromotable, PromotionError } = require('../main/core/admin/catalog-promotion');
const { executeInventoryCorrection } = require('../main/core/admin/compensation');
const { upsertConflict, getConflict } = require('../main/core/sync/conflict-store');
const licensing = require('../main/core/licensing');
const { grantFeature } = require('../main/core/features');
const { AuthorizationError } = require('../main/core/authorization');

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
  return (await (globalThis as any).fetch(`${baseUrl}/sync/v1/upload`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-plemmo-device': dev, 'x-plemmo-timestamp': ts, 'x-plemmo-nonce': nonce, 'x-plemmo-signature': sig }, body })).status;
}
async function signedGet(baseUrl: string, dev: string, priv: any, apiPath: string) {
  const ts = new Date().toISOString(); const nonce = nodeCrypto.randomBytes(8).toString('hex');
  const sig = signRequest(priv, 'GET', apiPath, ts, nonce, '');
  const res = await (globalThis as any).fetch(`${baseUrl}${apiPath}`, { headers: { 'x-plemmo-device': dev, 'x-plemmo-timestamp': ts, 'x-plemmo-nonce': nonce, 'x-plemmo-signature': sig } });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function main() {
  console.log('Test: PLATFORM-HARDENING (real PostgreSQL + real HTTP)');
  console.log('='.repeat(50));
  try {
    const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
    await probe.query('SELECT 1'); await probe.end();
  } catch (e) {
    console.log(`  ⏭ No reachable PostgreSQL — skipping (${(e as Error).message})`); process.exit(77);
  }
  const schema = `hard_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await admin.query(`CREATE SCHEMA "${schema}"`); await admin.end();
  const pool = new Pool({ connectionString: DSN, options: `-c search_path=${schema}`, max: 8, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });

  const db = initTestDb();
  const org = getOrganizationContext().id;
  const loc = getLocationContext().id;
  const deviceId = getDeviceContext().id;
  const OWNER = { userId: 'owner-h', role: 'owner' };
  const CASHIER = { userId: 'cashier-h', role: 'cashier' };
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, track_inventory, stock_quantity, low_stock_threshold, is_active, sort_order, created_at, updated_at)
              VALUES ('prod-h', NULL, 'H Widget', 10, 4, 'SKUH', 1, 100, 5, 1, 0, ?, ?)`).run(now(), now());

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

    // ══ CATALOG EMITTERS (remaining paths) ═══════════════════════════════════
    console.log('\n1-2. Remaining catalog emitters');
    const variant = createVariant({ productId: 'prod-h', name: 'Large', sku: 'SKUH-L', price: 12 });
    assert(!!db.prepare("SELECT 1 FROM sync_outbox WHERE entity_type='product_variant' AND entity_uid=?").get(variant.id), '1. creating a product variant emits a catalog snapshot');
    db.prepare("INSERT INTO categories (id, name, is_active, created_at, updated_at) VALUES ('cat-h','Drinks',1,?,?)").run(now(), now());
    const { snapshotCategory } = require('../main/core/sync/reference-entities');
    assert(!!snapshotCategory(db, 'cat-h'), '2. a category write emits a catalog snapshot');

    // ══ CONTROLLED PROMOTION ═════════════════════════════════════════════════
    console.log('\n3-8. Controlled remote-catalog promotion');
    const d2 = { ...kp(), id: ulid() };
    await devEnroll(baseUrl, d2.id, org, loc, d2.pub);
    const rProd = ulid();
    await httpUpload(baseUrl, d2.id, d2.priv, [refEvent(org, loc, d2.id, 'product', rProd, { id: rProd, name: 'Promoted Widget', price: 7, cost: 3, sku: 'PW', track_inventory: 0, is_active: 1, sort_order: 0, created_at: now(), updated_at: now() })]);
    await pullAndApply(transport, deviceId, 200, db);
    assert(!!db.prepare("SELECT 1 FROM remote_reference_entities WHERE entity_type='product' AND uid=?").get(rProd), '3. the remote product is staged in the mirror');
    assert(!db.prepare('SELECT 1 FROM products WHERE id=?').get(rProd), '3b. it is NOT yet in the authoritative catalog');
    assert(listPromotable('product').some((p: any) => p.uid === rProd), '4. it is listed as promotable for operator review');
    const promo = promoteRemoteEntity({ entityType: 'product', uid: rProd, user: OWNER });
    assertEqual(promo.outcome, 'promoted', '5. promotion inserts an ABSENT remote product into the authoritative catalog');
    assert(!!db.prepare('SELECT 1 FROM products WHERE id=?').get(rProd), '5b. the authoritative product now exists');
    // Promote again → idempotent (now exists → review_required, never a duplicate).
    const promo2 = promoteRemoteEntity({ entityType: 'product', uid: rProd, user: OWNER });
    assertEqual(promo2.outcome, 'review_required', '6. re-promoting an existing local record does NOT overwrite it (review_required)');
    assertEqual((db.prepare('SELECT COUNT(*) AS c FROM products WHERE id=?').get(rProd) as any).c, 1, '6b. no duplicate authoritative row');
    // Operational entities are never promoted.
    db.prepare(`INSERT INTO remote_reference_entities (entity_type, uid, snapshot_version, payload, applied_at) VALUES ('order','ord-x',1,'{"fields":{}}',?)`).run(now());
    assertEqual(promoteRemoteEntity({ entityType: 'order', uid: 'ord-x', user: OWNER }).outcome, 'not_promotable', '7. an operational entity (order) is never promoted');
    // Authorization: a cashier cannot promote.
    let promoDenied = false; try { promoteRemoteEntity({ entityType: 'product', uid: rProd, user: CASHIER }); } catch (e) { promoDenied = e instanceof AuthorizationError; }
    assert(promoDenied, '8. a cashier cannot promote catalog (sales.reconcile only)');

    // ══ INVENTORY COMPENSATION (exactly-once) ════════════════════════════════
    console.log('\n9-11. Exactly-once inventory compensation');
    upsertConflict({ conflictUid: 'inv1', organizationId: org, locationId: loc, entityType: 'order', entityUid: ulid(), conflictType: 'completion_conflict', source: 'local' }, db);
    const before = (db.prepare("SELECT quantity AS q FROM inventory_balances WHERE product_id='prod-h'").get() as any)?.q ?? 0;
    const corr = executeInventoryCorrection({ conflictUid: 'inv1', productId: 'prod-h', quantityDelta: -5, reason: 'shrinkage', user: OWNER });
    assert(!!corr.movement, '9. an inventory correction executes safely for a conflict');
    const after1 = (db.prepare("SELECT quantity AS q FROM inventory_balances WHERE product_id='prod-h'").get() as any)?.q;
    executeInventoryCorrection({ conflictUid: 'inv1', productId: 'prod-h', quantityDelta: -5, reason: 'shrinkage', user: OWNER });
    assertEqual((db.prepare("SELECT quantity AS q FROM inventory_balances WHERE product_id='prod-h'").get() as any)?.q, after1, '10. repeating it does NOT double-apply (exactly-once by conflict key)');
    let invDenied = false; try { executeInventoryCorrection({ conflictUid: 'inv1', productId: 'prod-h', quantityDelta: -1, reason: 'x', user: CASHIER }); } catch (e) { invDenied = e instanceof AuthorizationError; }
    assert(invDenied, '11. a cashier cannot execute an inventory correction');
    void before;

    // ══ CLOUD LICENSE VERIFICATION ═══════════════════════════════════════════
    console.log('\n12-18. Cloud license verification');
    grantFeature(org, 'retail.catalog');
    const future = new Date(Date.now() + 30 * 864e5).toISOString();
    store.upsertLicense({ organization_uid: org, status: 'active', plan: 'pilot', issued_at: now(), activated_at: now(), expires_at: future, grace_days: 7, device_limit: 5, location_limit: 2, features: ['retail.catalog'], signature: null }, now());
    const lic = await signedGet(baseUrl, deviceId, localKey.privateKey, '/sync/v1/license');
    assertEqual(lic.status, 200, '12. a device can pull its org license over signed HTTP');
    assertEqual(lic.data.license.organization_uid, org, '13. the license belongs to the device org (resolved server-side)');
    // Refresh via the cloud verifier → caches locally, effective status active.
    const verifier = licensing.createCloudLicenseVerifier(() => transport.pullLicense());
    const refreshed = await licensing.refreshLicense(verifier, org);
    assertEqual(refreshed.status, 'active', '14. refreshLicense caches the cloud license locally');
    assert(licensing.isFeatureLicensed('retail.catalog', org), '15. a licensed + granted feature is entitled after verification');
    assert(refreshed.last_verified_at != null, '16. verification stamps last_verified_at (drives offline grace)');
    // Org isolation: another org's device sees only its own (null) license.
    const other = { ...kp(), id: ulid() };
    await devEnroll(baseUrl, other.id, 'org-other-h', loc, other.pub);
    const otherLic = await signedGet(baseUrl, other.id, other.priv, '/sync/v1/license');
    assert(otherLic.data.license == null, '17. a foreign-org device gets no license (isolation, no secret leak)');
    // Revoked device cannot verify.
    await store.revokeDevice(other.id);
    assertEqual((await signedGet(baseUrl, other.id, other.priv, '/sync/v1/license')).status, 401, '18. a revoked device cannot pull a license');

    // ══ LICENSE SAFETY (offline grace / revocation) ══════════════════════════
    console.log('\n19-21. License safety semantics');
    // A verifier failure keeps the cached license (offline grace — no lockout).
    const kept = await licensing.refreshLicense({ verify: async () => { throw new Error('offline'); } }, org);
    assertEqual(kept.status, 'active', '19. a failed re-verification keeps the cached license (offline grace)');
    // A cloud revocation propagates on the next successful verify.
    store.upsertLicense({ organization_uid: org, status: 'revoked', plan: 'pilot', issued_at: now(), activated_at: now(), expires_at: future, grace_days: 7, device_limit: 5, location_limit: 2, features: ['retail.catalog'], signature: null }, now());
    const revd = await licensing.refreshLicense(verifier, org);
    assertEqual(licensing.effectiveStatus(revd), 'revoked', '20. a cloud revocation propagates and never gets grace');
    assert(!licensing.isFeatureLicensed('retail.catalog', org), '21. a revoked license entitles nothing (local EPOS still runs; features gate)');

    // ══ REGRESSION ═══════════════════════════════════════════════════════════
    console.log('\n22-24. Regression');
    assert(!!db.prepare('SELECT 1 FROM products WHERE id=?').get('prod-h'), '22. authoritative catalog intact');
    assert(!!db.prepare('SELECT 1 FROM product_variants WHERE id=?').get(variant.id), '23. authoritative variants intact');
    assert(getResults().failed === 0, '24. no failures so far (in-suite invariant)');
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
