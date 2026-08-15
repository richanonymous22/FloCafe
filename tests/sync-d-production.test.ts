/**
 * Test: SYNC-D production — REAL PostgreSQL + REAL HTTP + multi-entity sync.
 *
 * This suite proves behaviour against an ACTUAL PostgreSQL server (not a fake
 * PgClient), and runs the real Ed25519-authenticated HTTP sync API against
 * that Postgres backend. It self-skips (exit 77) if no PostgreSQL is reachable,
 * so it is green in CI without Postgres while running for real where Postgres
 * exists.
 *
 * Proves: migration runner + rollback, concurrent per-org feed sequencing with
 * real parallel connections (no gap/dup/lost), independent org sequences,
 * idempotent duplicate race → one fact, transaction rollback leaves no partial,
 * per-org isolation, multi-entity persistence + deterministic ordering, the
 * inventory deficit workflow (open→acknowledged→resolved), and — over real
 * HTTP against Postgres — device enrollment, inventory/audit/payment
 * upload+pull+idempotency+loop-prevention, security spoofs, and the background
 * worker draining all three entity types.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/sync-d-production.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-d-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

let Pool: any;
try { Pool = require('pg').Pool; } catch { console.log('  ⏭ pg driver not installed — skipping real-Postgres suite'); process.exit(77); }

const DSN = process.env.PLEMMO_CLOUD_DB_URL || 'postgres://plemmo:plemmo_dev_pw@127.0.0.1:5432/plemmo_sync_test';

const { initTestDb, closeDatabase, assert, assertEqual, getResults, now, getDatabase, startServer } = require('./helpers/test-setup');
const { adjustStock } = require('../main/core/inventory');
const { recordAuditEvent } = require('../main/core/audit');
const { getOrganizationContext, getLocationContext, getDeviceContext } = require('../main/core/context');
const { countOutboxByStatus, appendOutboxEvent } = require('../main/core/sync/outbox');
const { HttpSyncTransport } = require('../main/core/sync/http-transport');
const { getOrCreateDeviceKey } = require('../main/core/sync/device-identity');
const { SyncWorker } = require('../main/core/sync/worker');
const { PostgresCloudStore } = require('../cloud/postgres-store');
const { migrateToLatest, loadMigrations } = require('../cloud/migrate');
const { createCloudServer } = require('../cloud/server');
const { issueEnrollmentToken } = require('../cloud/enrollment');
const { signRequest } = require('../main/core/sync/signing');
const { ulid } = require('../main/core/ids');

function kp() {
  const k = nodeCrypto.generateKeyPairSync('ed25519');
  return { priv: nodeCrypto.createPrivateKey(k.privateKey.export({ type: 'pkcs8', format: 'pem' })), pub: k.publicKey.export({ type: 'spki', format: 'pem' }) };
}
function invEvent(org: string, loc: string | null, dev: string, delta: number, type = 'adjustment', product = 'prod-d') {
  const uid = ulid();
  return { event_uid: ulid(), entity_type: 'inventory_movement', entity_uid: uid, organization_uid: org, location_uid: loc, device_uid: dev, device_sequence: 1,
    payload: JSON.stringify({ schema_version: 1, movement_uid: uid, product_id: product, quantity_delta: delta, movement_type: type, created_at: now() }), created_at: now() };
}
function genericEvent(entity_type: string, org: string, loc: string | null, dev: string, payload: any) {
  const uid = ulid();
  return { event_uid: ulid(), entity_type, entity_uid: uid, organization_uid: org, location_uid: loc, device_uid: dev, device_sequence: 1, payload: JSON.stringify({ ...payload, uid }), created_at: now() };
}
async function httpUpload(baseUrl: string, dev: string, priv: any, events: any[]) {
  const body = JSON.stringify({ events });
  const ts = new Date().toISOString(); const nonce = nodeCrypto.randomBytes(16).toString('hex');
  const sig = signRequest(priv, 'POST', '/sync/v1/upload', ts, nonce, body);
  const res = await (globalThis as any).fetch(`${baseUrl}/sync/v1/upload`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-plemmo-device': dev, 'x-plemmo-timestamp': ts, 'x-plemmo-nonce': nonce, 'x-plemmo-signature': sig }, body });
  return { status: res.status, data: await res.json().catch(() => null), ts, nonce };
}

async function main() {
  console.log('Test: SYNC-D production (real PostgreSQL + real HTTP)');
  console.log('='.repeat(50));

  // ── Connectivity check → skip cleanly if no Postgres ──────────────────────
  try {
    const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
    await probe.query('SELECT 1');
    await probe.end();
  } catch (e) {
    console.log(`  ⏭ No reachable PostgreSQL at ${DSN.replace(/:[^:@/]*@/, ':***@')} — skipping (${(e as Error).message})`);
    process.exit(77);
  }

  const schema = `sync_d_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Pool({ connectionString: DSN });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const pool = new Pool({ connectionString: DSN, options: `-c search_path=${schema}`, max: 8 });

  const db = initTestDb();
  const organization = getOrganizationContext();
  const location = getLocationContext();
  const deviceId = getDeviceContext().id;
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, track_inventory, stock_quantity, low_stock_threshold, is_active, sort_order, created_at, updated_at)
              VALUES ('prod-d', NULL, 'D Widget', 10, 0, 1, 100, 5, 1, 0, ?, ?)`).run(now(), now());

  const store = new PostgresCloudStore(pool);
  let server: any;
  try {
    // ══ 1. Migration runner against REAL Postgres ════════════════════════════
    console.log('\n1. Migration runner creates the schema on real Postgres');
    const files = loadMigrations();
    assert(files.length >= 1, 'migration files are discovered on disk');
    const m1 = await migrateToLatest(pool);
    assert(m1.applied.includes(1), 'migration 0001 was applied');
    assertEqual(m1.currentVersion, files[files.length - 1].version, 'schema is at the latest version');
    const m2 = await migrateToLatest(pool);
    assertEqual(m2.applied.length, 0, 're-running the migrator applies nothing (idempotent)');

    // ══ 2. Real schema objects: table, unique constraint, indexes ════════════
    console.log('\n2. Real schema: table + unique idempotency constraint + indexes');
    const tbl = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='cloud_events'`, [schema]);
    assertEqual(tbl.rowCount, 1, 'cloud_events table exists');
    const uniq = await pool.query(`SELECT 1 FROM pg_indexes WHERE schemaname=$1 AND tablename='cloud_events' AND indexdef ILIKE '%UNIQUE%(entity_type, entity_uid)%'`, [schema]);
    assert(uniq.rowCount >= 1, 'UNIQUE(entity_type, entity_uid) idempotency constraint exists');

    // ══ 3. Transaction rollback leaves no partial row ════════════════════════
    console.log('\n3. Real transaction rollback leaves no partial data');
    await pool.query('BEGIN');
    await pool.query(`INSERT INTO cloud_events (event_uid, entity_type, entity_uid, organization_uid, location_uid, device_uid, device_sequence, feed_seq, payload, created_at, received_at) VALUES ('rb1','inventory_movement','rbx','org-rb',NULL,'d',1,1,'{}',now(),now())`);
    await pool.query('ROLLBACK');
    const rb = await pool.query(`SELECT COUNT(*)::int AS c FROM cloud_events WHERE event_uid='rb1'`);
    assertEqual(rb.rows[0].c, 0, 'the rolled-back insert left no row');

    // ══ 4. CONCURRENT 5-device upload → gapless per-org feed sequence ════════
    console.log('\n4. Five devices upload CONCURRENTLY against real Postgres — gapless 1..5');
    for (let iter = 0; iter < 3; iter++) {
      const orgA = `org-A-${iter}`;
      const devs = Array.from({ length: 5 }, (_, i) => ({ ...kp(), id: `A${iter}-d${i}` }));
      for (const d of devs) await store.registerDevice({ device_uid: d.id, organization_uid: orgA, location_uid: 'loc', register_uid: null, public_key: d.pub, status: 'active' });
      // True concurrency: real parallel connections from the pool.
      const results = await Promise.all(devs.map((d) => store.storeEvent(invEvent(orgA, 'loc', d.id, 1), now())));
      assert(results.every((r) => r === 'accepted'), 'all five concurrent uploads were accepted');
      const feed = (await store.pullEvents(orgA, 0, 100)).events.map((e: any) => e.feed_seq).sort((a: number, b: number) => a - b);
      assertEqual(JSON.stringify(feed), JSON.stringify([1, 2, 3, 4, 5]), `iter ${iter}: feed sequence is gapless 1..5, no dup/gap/lost`);
      assertEqual(new Set(feed).size, 5, `iter ${iter}: every event has a distinct feed_seq`);
    }

    // ══ 5. Independent organization sequence ═════════════════════════════════
    console.log('\n5. A different organization has an independent sequence');
    const bDev = { ...kp(), id: 'B-d0' };
    await store.registerDevice({ device_uid: bDev.id, organization_uid: 'org-B', location_uid: 'loc', register_uid: null, public_key: bDev.pub, status: 'active' });
    await store.storeEvent(invEvent('org-B', 'loc', bDev.id, 1), now());
    assertEqual((await store.pullEvents('org-B', 0, 100)).events[0].feed_seq, 1, "org B's sequence starts at 1, independent of org A");

    // ══ 6. Idempotent duplicate RACE → exactly one business fact ═════════════
    console.log('\n6. Concurrent duplicate upload results in exactly one fact');
    const rDev = { ...kp(), id: 'race-d' };
    await store.registerDevice({ device_uid: rDev.id, organization_uid: 'org-race', location_uid: 'loc', register_uid: null, public_key: rDev.pub, status: 'active' });
    const shared = invEvent('org-race', 'loc', rDev.id, 1);
    const raceResults = await Promise.allSettled(Array.from({ length: 6 }, () => store.storeEvent({ ...shared, event_uid: ulid() }, now())));
    const accepted = raceResults.filter((r) => r.status === 'fulfilled' && (r as any).value === 'accepted').length;
    const rows = await pool.query(`SELECT COUNT(*)::int AS c FROM cloud_events WHERE entity_uid=$1`, [shared.entity_uid]);
    assertEqual(rows.rows[0].c, 1, 'exactly ONE business fact exists after a 6-way duplicate race');
    assertEqual(accepted, 1, 'exactly one upload reports accepted; the rest dedupe or roll back — no partial');

    // ══ 7. Multi-entity persistence + deterministic per-org ordering ═════════
    console.log('\n7. inventory + audit + payment share ONE ordered per-org feed');
    const orgC = 'org-multi';
    const c1 = { ...kp(), id: 'C-d1' }; const c2 = { ...kp(), id: 'C-d2' };
    for (const d of [c1, c2]) await store.registerDevice({ device_uid: d.id, organization_uid: orgC, location_uid: 'loc', register_uid: null, public_key: d.pub, status: 'active' });
    await store.storeEvent(invEvent(orgC, 'loc', c1.id, 3), now());
    await store.storeEvent(genericEvent('audit_event', orgC, 'loc', c2.id, { schema_version: 1, event_type: 'test.audit', occurred_at: now() }), now());
    await store.storeEvent(genericEvent('payment_event', orgC, 'loc', c1.id, { schema_version: 1, payment_uid: 'pay-1', to_state: 'captured', occurred_at: now() }), now());
    const feedC = (await store.pullEvents(orgC, 0, 100)).events;
    assertEqual(feedC.map((e: any) => e.feed_seq).join(','), '1,2,3', 'all three entity types share one gapless per-org feed');
    assertEqual(feedC.map((e: any) => e.entity_type).join(','), 'inventory_movement,audit_event,payment_event', 'events are returned in deterministic feed order with correct entity types');

    // ══ 8. Per-organization isolation ════════════════════════════════════════
    console.log('\n8. Organization isolation on pull');
    assertEqual((await store.pullEvents('org-B', 0, 100)).events.every((e: any) => e.organization_uid === 'org-B'), true, 'a pull for org B returns only org B events');
    assertEqual((await store.pullEvents(orgC, 0, 100)).events.some((e: any) => e.organization_uid !== orgC), false, 'no cross-organization leakage');

    // ══ 9. Inventory deficit workflow (open → acknowledged → resolved) ═══════
    console.log('\n9. Cross-till deficit detected on real Postgres, with status workflow');
    const orgD = 'org-deficit'; const dA = { ...kp(), id: 'D-a' }; const dB = { ...kp(), id: 'D-b' };
    for (const d of [dA, dB]) await store.registerDevice({ device_uid: d.id, organization_uid: orgD, location_uid: 'loc', register_uid: null, public_key: d.pub, status: 'active' });
    await store.storeEvent(invEvent(orgD, 'loc', dA.id, 5, 'adjustment'), now());
    await store.storeEvent(invEvent(orgD, 'loc', dA.id, -5, 'sale'), now());
    await store.storeEvent(invEvent(orgD, 'loc', dB.id, -5, 'sale'), now());
    let defs = await store.listDeficits(orgD);
    assertEqual(defs.length, 1, 'a single deficit is recorded');
    assertEqual(defs[0].balance, -5, 'the global deficit is -5');
    assertEqual(defs[0].status, 'open', 'a new deficit starts open');
    assertEqual((await store.pullEvents(orgD, 0, 100)).events.length, 3, 'all three movements preserved — no sale reversed');
    await store.setDeficitStatus(orgD, 'loc', 'prod-d', null, 'acknowledged', now());
    assertEqual((await store.listDeficits(orgD))[0].status, 'acknowledged', 'a deficit can be acknowledged');
    await store.setDeficitStatus(orgD, 'loc', 'prod-d', null, 'resolved', now());
    assertEqual((await store.listDeficits(orgD))[0].status, 'resolved', 'a deficit can be resolved');

    // ══ 10-14. REAL HTTP against REAL Postgres (async server) ════════════════
    console.log('\n10. The real HTTP sync API runs against Postgres (async server)');
    const app = createCloudServer(store, { enableDevEnroll: true });
    const started = await startServer(app);
    server = started.server;
    const baseUrl = started.baseUrl;
    const transport = new HttpSyncTransport({ baseUrl });
    const localKey = getOrCreateDeviceKey();
    // Production enrollment via token, over HTTP, persisted in Postgres.
    const { token } = await issueEnrollmentToken(store, { organizationUid: organization.id, locationUid: location.id, registerUid: 'reg-http' });
    const enr = await (globalThis as any).fetch(`${baseUrl}/sync/v1/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, device_uid: deviceId, public_key: localKey.publicKeyPem }) });
    assertEqual(enr.status, 201, 'token enrollment over HTTP persisted the device in Postgres');
    const enrolledLog = await pool.query(`SELECT COUNT(*)::int AS c FROM cloud_sync_log WHERE kind='enrolled' AND device_uid=$1`, [deviceId]);
    assert(enrolledLog.rows[0].c >= 1, 'enrollment is recorded as an auditable cloud event');

    console.log('\n11. Inventory + audit + payment upload over HTTP → Postgres');
    adjustStock({ productId: 'prod-d', quantityDelta: 4, reason: 'd-http', movementType: 'adjustment' });
    recordAuditEvent({ type: 'test.http.audit', summary: 'sync-d audit' });
    // Enqueue a payment_event sync fact directly (the appendPaymentEventOutbox
    // helper reads the payments/bills context, which requires the full local
    // payment flow — exercised by the payment integration suites; here we only
    // need the payment_event to travel the sync path end-to-end).
    const peUid = ulid(); const payUid = ulid();
    db.transaction(() => appendOutboxEvent({
      db, entityType: 'payment_event', entityUid: peUid, operation: 'append',
      organizationId: organization.id, locationId: location.id,
      payload: { schema_version: 1, payment_event_uid: peUid, payment_uid: payUid, from_state: null, to_state: 'captured',
        occurred_at: now(), order_uid: null, bill_uid: 'bill-uid-1', organization_id: organization.id, location_id: location.id, actor_user_id: null, reason: null, metadata: null },
    }))();
    const worker = new SyncWorker({ transport, deviceId, db, baseIntervalMs: 50, maxIntervalMs: 400 });
    const tick = await worker.tick();
    assert(tick.ok, 'the worker tick against Postgres succeeded');
    assertEqual(countOutboxByStatus('pending', db), 0, 'the worker drained inventory + audit + payment in one pass');
    const byEntity = await pool.query(`SELECT entity_type, COUNT(*)::int AS c FROM cloud_events WHERE organization_uid=$1 GROUP BY entity_type`, [organization.id]);
    const kinds = new Set(byEntity.rows.map((r: any) => r.entity_type));
    assert(kinds.has('inventory_movement') && kinds.has('audit_event') && kinds.has('payment_event'), 'all three entity types persisted in Postgres via the worker');

    console.log('\n12. Pull + apply from Postgres (multi-entity), with loop prevention');
    const other = { ...kp(), id: ulid() };
    await store.registerDevice({ device_uid: other.id, organization_uid: organization.id, location_uid: location.id, register_uid: null, public_key: other.pub, status: 'active' });
    const remoteAuditUid = ulid();
    await httpUpload(baseUrl, other.id, other.priv, [{ uid: ulid(), device_id: other.id, sequence: 1, entity_type: 'audit_event', entity_uid: remoteAuditUid,
      organization_id: organization.id, location_id: location.id,
      payload: { schema_version: 1, audit_uid: remoteAuditUid, event_type: 'remote.audit', occurred_at: now(), organization_id: organization.id, location_id: location.id }, created_at: now() }]);
    const outboxBefore = (db.prepare('SELECT COUNT(*) AS c FROM sync_outbox').get() as any).c;
    const dl = await worker.tick();
    assert(dl.applied >= 1, 'the remote audit event was pulled and applied locally');
    assert(!!db.prepare('SELECT 1 FROM audit_events WHERE id = ?').get(remoteAuditUid), 'the remote audit event materialized in local audit_events');
    assertEqual((db.prepare('SELECT COUNT(*) AS c FROM sync_outbox').get() as any).c, outboxBefore, 'applying a remote event produced NO new outbox event (loop prevention)');

    console.log('\n13. Security against the Postgres-backed API');
    // Org spoof: an attacker device in another org claims the victim org.
    const atk = { ...kp(), id: ulid() };
    await store.registerDevice({ device_uid: atk.id, organization_uid: 'org-attacker', location_uid: null, register_uid: null, public_key: atk.pub, status: 'active' });
    const spoof = await httpUpload(baseUrl, atk.id, atk.priv, [{ uid: ulid(), device_id: atk.id, sequence: 1, entity_type: 'inventory_movement', entity_uid: ulid(),
      organization_id: organization.id, location_id: location.id, payload: { schema_version: 1, organization_id: organization.id, product_id: 'prod-d', quantity_delta: 99, movement_type: 'adjustment', created_at: now() }, created_at: now() }]);
    assertEqual(spoof.data.rejected[0].reason, 'organization mismatch', 'org spoof is rejected by server-side identity');
    // Tampered signature.
    const tsig = await (globalThis as any).fetch(`${baseUrl}/sync/v1/pull?cursor=0`, { method: 'GET', headers: { 'x-plemmo-device': deviceId, 'x-plemmo-timestamp': new Date().toISOString(), 'x-plemmo-nonce': nodeCrypto.randomBytes(8).toString('hex'), 'x-plemmo-signature': 'AAAA' } });
    assertEqual(tsig.status, 401, 'a tampered signature is rejected');
    // Replay.
    const one = await httpUpload(baseUrl, other.id, other.priv, []);
    void one;
    const body = JSON.stringify({ events: [] });
    const rts = new Date().toISOString(); const rn = nodeCrypto.randomBytes(16).toString('hex');
    const rs = signRequest(other.priv, 'POST', '/sync/v1/upload', rts, rn, body);
    const h = { 'content-type': 'application/json', 'x-plemmo-device': other.id, 'x-plemmo-timestamp': rts, 'x-plemmo-nonce': rn, 'x-plemmo-signature': rs };
    const first = await (globalThis as any).fetch(`${baseUrl}/sync/v1/upload`, { method: 'POST', headers: h, body });
    const replay = await (globalThis as any).fetch(`${baseUrl}/sync/v1/upload`, { method: 'POST', headers: h, body });
    assertEqual(first.status, 200, 'first signed request ok');
    assertEqual(replay.status, 401, 'an exact replay is rejected (nonce reuse) — verified against Postgres nonce store');
    // Revoked device.
    await store.revokeDevice(other.id);
    const revoked = await httpUpload(baseUrl, other.id, other.priv, []);
    assertEqual(revoked.status, 401, 'a revoked device cannot sync');

    console.log('\n14. Cloud observability by entity type (Postgres)');
    const obsRows = await pool.query(`SELECT entity_type, kind, COUNT(*)::int AS c FROM cloud_sync_log WHERE organization_uid=$1 AND kind='accepted' GROUP BY entity_type, kind`, [organization.id]);
    assert(obsRows.rows.length >= 1, 'per-entity accepted metrics are recorded in the cloud sync log');
  } finally {
    if (server) server.close();
    await pool.end();
    const admin2 = new Pool({ connectionString: DSN });
    await admin2.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin2.end();
    closeDatabase();
  }

  const { passed, failed } = getResults();
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error('Test suite failed:', error); process.exit(1); });
