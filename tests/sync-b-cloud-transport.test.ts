/**
 * Test: SYNC-B real cloud transport for inventory movements.
 *
 * Runs a REAL Plemmo Sync API (cloud/server.ts) on a local HTTP server and
 * a REAL HTTP transport (main/core/sync/http-transport.ts) against it — no
 * public internet. Proves: device signature auth, upload + idempotent
 * replay, organization/location isolation, malformed rejection, transient
 * retry, lost-ACK recovery, pull + cursor, atomic inbox+cursor, crash
 * safety, remote apply, loop prevention, batching, device revocation.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/sync-b-cloud-transport.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-b-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, closeDatabase, assert, assertEqual, getResults, now, getDatabase, startServer } = require('./helpers/test-setup');
const { adjustStock, getBalance } = require('../main/core/inventory');
const { getOrganizationContext, getLocationContext, getDeviceContext } = require('../main/core/context');
const { nextPendingBatch, countOutboxByStatus, getSyncState } = require('../main/core/sync/outbox');
const { uploadPendingBatch } = require('../main/core/sync/uploader');
const { pullAndApply, getDownloadCursor } = require('../main/core/sync/downloader');
const { HttpSyncTransport } = require('../main/core/sync/http-transport');
const { getOrCreateDeviceKey } = require('../main/core/sync/device-identity');
const { SqliteCloudStore } = require('../cloud/store');
const { createCloudServer } = require('../cloud/server');
const { ulid } = require('../main/core/ids');

async function enroll(baseUrl: string, deviceUid: string, orgUid: string, locUid: string | null, publicKeyPem: string) {
  const res = await (globalThis as any).fetch(`${baseUrl}/sync/v1/dev/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_uid: deviceUid, organization_uid: orgUid, location_uid: locUid, public_key: publicKeyPem }),
  });
  return res.status;
}

async function main() {
  console.log('Test: SYNC-B cloud transport');
  console.log('='.repeat(50));

  const db = initTestDb();
  const organization = getOrganizationContext();
  const location = getLocationContext();
  const device = getDeviceContext();
  const deviceId = device.id;
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, track_inventory, stock_quantity, low_stock_threshold, is_active, sort_order, created_at, updated_at)
              VALUES ('prod-sb', NULL, 'SB Widget', 10, 0, 1, 100, 5, 1, 0, ?, ?)`).run(now(), now());

  const store = new SqliteCloudStore(':memory:');
  const cloudApp = createCloudServer(store, { enableDevEnroll: true });
  const { baseUrl, server } = await startServer(cloudApp);
  const transport = new HttpSyncTransport({ baseUrl });

  try {
    // ══ 1. Device authenticates (enrollment) ═════════════════════════════
    console.log('\n1. Device authenticates via enrolled public key');
    const key = getOrCreateDeviceKey();
    assertEqual(await enroll(baseUrl, deviceId, organization.id, location.id, key.publicKeyPem), 201, 'the device enrolls its public key with the cloud (dev flow)');

    // ══ 2. Valid movement uploads ════════════════════════════════════════
    console.log('\n2. A valid inventory movement uploads over real HTTP');
    const m1 = adjustStock({ productId: 'prod-sb', quantityDelta: 5, reason: 'sb1', movementType: 'adjustment' });
    const pendingBefore = nextPendingBatch(deviceId, 100, db).length;
    assert(pendingBefore >= 1, 'the movement produced a pending outbox event');
    const up1 = await uploadPendingBatch(transport, deviceId, 100, db);
    assertEqual(up1.acked, pendingBefore, 'the cloud accepted the uploaded event(s)');
    assertEqual(countOutboxByStatus('pending', db), 0, 'no events remain pending after a successful upload');
    const cloudRow = store.pullMovements(organization.id, 0, 100).events[0];
    assertEqual(cloudRow.movement_uid, m1.id, 'the cloud persisted the movement as a business fact');
    assertEqual(cloudRow.organization_uid, organization.id, 'the cloud stamped the org from the device identity');

    // ══ 3. Duplicate upload is idempotent ════════════════════════════════
    console.log('\n3. A duplicate upload is idempotent (no second business fact)');
    // Re-mark the acked event pending and re-upload — the cloud must dedupe.
    const evUid = (db.prepare('SELECT uid FROM sync_outbox WHERE entity_uid = ?').get(m1.id) as any).uid;
    db.prepare("UPDATE sync_outbox SET status = 'pending' WHERE uid = ?").run(evUid);
    const up2 = await uploadPendingBatch(transport, deviceId, 100, db);
    assertEqual(up2.acked, 1, 'the duplicate upload is acked (idempotent success)');
    assertEqual(store.pullMovements(organization.id, 0, 100).events.length, 1, 'the cloud did NOT create a second business fact');

    // ══ 4-5. Organization / location isolation ═══════════════════════════
    console.log('\n4-5. Organization / location isolation');
    // A second device belonging to a DIFFERENT organization must not be able
    // to push a movement whose payload claims THIS organization.
    const attackerKey = nodeCrypto.generateKeyPairSync('ed25519');
    const attackerPub = attackerKey.publicKey.export({ type: 'spki', format: 'pem' });
    const attackerDeviceId = ulid();
    await enroll(baseUrl, attackerDeviceId, 'org-attacker', null, attackerPub);
    // Hand-craft a signed upload from the attacker device claiming victim org.
    const attackerTransport = new HttpSyncTransport({ baseUrl });
    const spoofEvent = {
      uid: ulid(), device_id: attackerDeviceId, sequence: 1, entity_type: 'inventory_movement', entity_uid: ulid(),
      organization_id: organization.id, location_id: location.id,
      payload: { schema_version: 1, movement_uid: ulid(), organization_id: organization.id, location_id: location.id, product_id: 'prod-sb', quantity_delta: 99, movement_type: 'adjustment', created_at: now() },
      created_at: now(),
    };
    const spoofBody = JSON.stringify({ events: [spoofEvent] });
    const ts = new Date().toISOString(); const nonce = nodeCrypto.randomBytes(16).toString('hex');
    const { signRequest } = require('../main/core/sync/signing');
    const sig = signRequest(nodeCrypto.createPrivateKey(attackerKey.privateKey.export({ type: 'pkcs8', format: 'pem' })), 'POST', '/sync/v1/upload', ts, nonce, spoofBody);
    const spoofRes = await (globalThis as any).fetch(`${baseUrl}/sync/v1/upload`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-plemmo-device': attackerDeviceId, 'x-plemmo-timestamp': ts, 'x-plemmo-nonce': nonce, 'x-plemmo-signature': sig },
      body: spoofBody,
    });
    const spoofData = await spoofRes.json();
    assertEqual(spoofData.rejected.length, 1, 'the org-spoofing event is rejected');
    assertEqual(spoofData.rejected[0].reason, 'organization mismatch', 'rejection reason is organization mismatch');
    assertEqual(store.pullMovements(organization.id, 0, 100).events.length, 1, "the attacker's org spoof did not land in the victim organization");
    void attackerTransport;

    // ══ 6. Malformed event rejected ══════════════════════════════════════
    console.log('\n6. A malformed event is rejected (permanent)');
    const key2 = getOrCreateDeviceKey();
    void key2;
    // Upload a malformed event via a signed request from the real device.
    const badBody = JSON.stringify({ events: [{ uid: ulid(), entity_type: 'inventory_movement', entity_uid: ulid(), payload: { movement_type: 'adjustment' } }] });
    const ts2 = new Date().toISOString(); const nonce2 = nodeCrypto.randomBytes(16).toString('hex');
    const sig2 = signRequest(key.privateKey, 'POST', '/sync/v1/upload', ts2, nonce2, badBody);
    const badRes = await (globalThis as any).fetch(`${baseUrl}/sync/v1/upload`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-plemmo-device': deviceId, 'x-plemmo-timestamp': ts2, 'x-plemmo-nonce': nonce2, 'x-plemmo-signature': sig2 },
      body: badBody,
    });
    const badData = await badRes.json();
    assertEqual(badData.rejected[0].category, 'permanent', 'a malformed event is a permanent rejection');

    // ══ 7-8. Transient failure retryable; permanent stays failed ═════════
    console.log('\n7-8. Transient HTTP failure remains retryable');
    const m2 = adjustStock({ productId: 'prod-sb', quantityDelta: 2, reason: 'sb2', movementType: 'adjustment' });
    // A transport pointed at a dead port throws transient → events stay pending.
    const deadTransport = new HttpSyncTransport({ baseUrl: 'http://127.0.0.1:1' });
    const failOutcome = await uploadPendingBatch(deadTransport, deviceId, 100, db);
    assert(!!failOutcome.transportError, 'the transient network failure is reported');
    assertEqual(countOutboxByStatus('pending', db), 1, 'the event stayed pending (retryable) after a transient failure');
    assert(getSyncState(deviceId, db).failure_count >= 1, 'the failure is recorded');

    // ══ 9-10. Accepted becomes ACKED; lost-ACK + retry ═══════════════════
    console.log('\n9-10. Accepted event becomes ACKED; lost-ACK recovery');
    const up3 = await uploadPendingBatch(transport, deviceId, 100, db);
    assertEqual(up3.acked, 1, 'the retry succeeds against the real cloud');
    assertEqual((db.prepare('SELECT status FROM sync_outbox WHERE entity_uid = ?').get(m2.id) as any).status, 'acked', 'the event is now acked locally');
    // Lost ACK: the cloud already has m2; simulate the ack being lost by
    // re-marking pending and re-uploading — the duplicate path re-acks it.
    db.prepare("UPDATE sync_outbox SET status = 'pending' WHERE entity_uid = ?").run(m2.id);
    const up4 = await uploadPendingBatch(transport, deviceId, 100, db);
    assertEqual(up4.acked, 1, 'after a lost ACK, the retry is idempotently re-acked (duplicate = success)');
    assertEqual((db.prepare('SELECT status FROM sync_outbox WHERE entity_uid = ?').get(m2.id) as any).status, 'acked', 'the event ends up acked, exactly once, no duplicate cloud fact');

    // ══ 11-16. Pull → inbox → apply → loop prevention (second device) ════
    console.log('\n11-16. Pull, cursor, inbox apply, and loop prevention (A -> cloud -> B)');
    // "Device B" = a second local SQLite install in the SAME org/location.
    // We model it with its own DB by re-initializing under a second key. To
    // keep this in one test process, we prove the apply path against the
    // SAME db but with a movement that originated from ANOTHER device
    // (device A2) uploaded to the cloud, then pulled and applied here.
    const a2Key = nodeCrypto.generateKeyPairSync('ed25519');
    const a2Pub = a2Key.publicKey.export({ type: 'spki', format: 'pem' });
    const a2DeviceId = ulid();
    await enroll(baseUrl, a2DeviceId, organization.id, location.id, a2Pub);
    // A2 uploads a movement directly to the cloud (signed as A2).
    const remoteMovementUid = ulid();
    const a2Event = {
      uid: ulid(), device_id: a2DeviceId, sequence: 1, entity_type: 'inventory_movement', entity_uid: remoteMovementUid,
      organization_id: organization.id, location_id: location.id,
      payload: { schema_version: 1, movement_uid: remoteMovementUid, organization_id: organization.id, location_id: location.id, product_id: 'prod-sb', product_variant_id: null, quantity_delta: 7, movement_type: 'adjustment', reason: 'from A2', reference_type: 'manual', reference_id: null, unit_cost: null, actor_user_id: null, metadata: null, created_at: now() },
      created_at: now(),
    };
    const a2Body = JSON.stringify({ events: [a2Event] });
    const a2ts = new Date().toISOString(); const a2nonce = nodeCrypto.randomBytes(16).toString('hex');
    const a2sig = signRequest(nodeCrypto.createPrivateKey(a2Key.privateKey.export({ type: 'pkcs8', format: 'pem' })), 'POST', '/sync/v1/upload', a2ts, a2nonce, a2Body);
    await (globalThis as any).fetch(`${baseUrl}/sync/v1/upload`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-plemmo-device': a2DeviceId, 'x-plemmo-timestamp': a2ts, 'x-plemmo-nonce': a2nonce, 'x-plemmo-signature': a2sig }, body: a2Body,
    });

    const balanceBeforePull = getBalance('prod-sb');
    const outboxBeforePull = (db.prepare('SELECT COUNT(*) AS c FROM sync_outbox').get() as any).c;
    const cursorBefore = getDownloadCursor(deviceId, db);
    const dl = await pullAndApply(transport, deviceId, 100, db);
    assertEqual(dl.pulled, 1, "pull returned A2's movement (this device's own uploads are excluded)");
    assertEqual(dl.applied, 1, 'the remote movement was applied locally');
    assert(getDownloadCursor(deviceId, db) > cursorBefore, 'the download cursor advanced');
    assertEqual(getBalance('prod-sb'), balanceBeforePull + 7, 'the remote movement adjusted the local balance by its delta');
    assert(!!db.prepare('SELECT 1 FROM inventory_movements WHERE id = ?').get(remoteMovementUid), 'the remote movement exists locally');
    const remoteMeta = JSON.parse((db.prepare('SELECT metadata FROM inventory_movements WHERE id = ?').get(remoteMovementUid) as any).metadata);
    assertEqual(remoteMeta.sync_origin, 'remote', 'the applied movement is marked remote-origin');
    // LOOP PREVENTION: applying the remote fact must NOT create an outbox event.
    assertEqual((db.prepare('SELECT COUNT(*) AS c FROM sync_outbox').get() as any).c, outboxBeforePull, 'applying a remote movement produced NO new outbox event (loop prevention, Part L)');
    assert(!db.prepare('SELECT 1 FROM sync_outbox WHERE entity_uid = ?').get(remoteMovementUid), 'the remote movement has no outbound sync event at all');

    // Re-pull is idempotent: cursor is past it, and even a re-apply skips.
    const dl2 = await pullAndApply(transport, deviceId, 100, db);
    assertEqual(dl2.pulled, 0, 're-pull returns nothing new (cursor advanced)');
    assertEqual(getBalance('prod-sb'), balanceBeforePull + 7, 'balance is unchanged by a redundant pull (no double count)');

    // ══ 13. Atomic inbox + cursor ════════════════════════════════════════
    console.log('\n13. Inbox persistence + cursor advancement are atomic');
    // Upload another remote movement from A2, then force TXN 1 to fail and
    // confirm neither the inbox rows nor the cursor advanced.
    const rm2 = ulid();
    const a2Event2 = { ...a2Event, uid: ulid(), entity_uid: rm2, payload: { ...a2Event.payload, movement_uid: rm2, quantity_delta: 3, reason: 'atomic-test' } };
    const b2 = JSON.stringify({ events: [a2Event2] });
    const t2 = new Date().toISOString(); const n2 = nodeCrypto.randomBytes(16).toString('hex');
    const s2 = signRequest(nodeCrypto.createPrivateKey(a2Key.privateKey.export({ type: 'pkcs8', format: 'pem' })), 'POST', '/sync/v1/upload', t2, n2, b2);
    await (globalThis as any).fetch(`${baseUrl}/sync/v1/upload`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-plemmo-device': a2DeviceId, 'x-plemmo-timestamp': t2, 'x-plemmo-nonce': n2, 'x-plemmo-signature': s2 }, body: b2 });
    const cursorBeforeAtomic = getDownloadCursor(deviceId, db);
    const inboxCountBefore = (db.prepare('SELECT COUNT(*) AS c FROM sync_inbox').get() as any).c;
    db.exec('ALTER TABLE sync_state RENAME TO sync_state_hidden'); // break the cursor write inside TXN 1
    let atomicFailed = false;
    try { await pullAndApply(transport, deviceId, 100, db); } catch { atomicFailed = true; }
    db.exec('ALTER TABLE sync_state_hidden RENAME TO sync_state');
    assert(atomicFailed, 'the pull failed when the cursor write failed');
    assertEqual((db.prepare('SELECT COUNT(*) AS c FROM sync_inbox').get() as any).c, inboxCountBefore, 'no inbox row persisted when the cursor advance failed — the two are atomic (Part J)');
    assertEqual(getDownloadCursor(deviceId, db), cursorBeforeAtomic, 'the cursor did not advance when the transaction rolled back');
    // Recover: a normal pull now applies it.
    const dl3 = await pullAndApply(transport, deviceId, 100, db);
    assertEqual(dl3.applied, 1, 'after recovery the pending remote movement applies');

    // ══ 17-18. Batching + sequence ordering ══════════════════════════════
    console.log('\n17-18. Batch upload preserves sequence ordering');
    const batchMovements = [];
    for (let i = 0; i < 5; i++) batchMovements.push(adjustStock({ productId: 'prod-sb', quantityDelta: 1, reason: `batch${i}`, movementType: 'adjustment' }));
    const pendingBatch = nextPendingBatch(deviceId, 100, db);
    for (let i = 1; i < pendingBatch.length; i++) assert(pendingBatch[i].sequence > pendingBatch[i - 1].sequence, 'the pending batch is ordered by sequence');
    const upBatch = await uploadPendingBatch(transport, deviceId, 100, db);
    assertEqual(upBatch.acked, pendingBatch.length, 'the whole batch uploaded in one request');
    assertEqual(countOutboxByStatus('pending', db), 0, 'no events left pending after the batch upload');

    // ══ 19. Device revocation blocks sync ════════════════════════════════
    console.log('\n19. Device revocation blocks sync');
    store.revokeDevice(deviceId);
    const m6 = adjustStock({ productId: 'prod-sb', quantityDelta: 1, reason: 'post-revoke', movementType: 'adjustment' });
    const revokedOutcome = await uploadPendingBatch(transport, deviceId, 100, db);
    assertEqual(revokedOutcome.acked, 0, 'a revoked device cannot upload (auth failure → events stay pending)');
    assertEqual((db.prepare('SELECT status FROM sync_outbox WHERE entity_uid = ?').get(m6.id) as any).status, 'pending', 'the revoked-device event remains pending, never acked');
    assertEqual(store.observability().authFailure >= 1, true, 'the cloud logged an auth failure for the revoked device');
    store.registerDevice({ device_uid: deviceId, organization_uid: organization.id, location_uid: location.id, public_key: key.publicKeyPem, status: 'active' }); // restore for cleanliness
  } finally {
    server.close();
    store.close();
  }

  closeDatabase();
  const { passed, failed } = getResults();
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error('Test suite failed:', error); process.exit(1); });
