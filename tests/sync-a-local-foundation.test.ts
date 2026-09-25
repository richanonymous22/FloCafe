/**
 * Test: SYNC-A local sync foundation.
 *
 * Proves the local synchronization mechanism against real SQLite: inventory
 * movements produce an outbox event atomically, the event carries a typed
 * payload + device identity + a deterministic per-device sequence, a mock
 * transport can upload/ack/replay, retry and crash-restart recovery work,
 * and the inbox/sync_state foundations are durable. NO real cloud, NO
 * network, NO background worker.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/sync-a-local-foundation.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-a-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, closeDatabase, assert, assertEqual, getResults, now, getDatabase,
} = require('./helpers/test-setup');
const { adjustStock, getBalance } = require('../main/core/inventory');
const { getOrganizationContext, getLocationContext, getDeviceContext } = require('../main/core/context');
const {
  appendOutboxEvent, nextPendingBatch, countOutboxByStatus, getSyncState, resolveDeviceId, recoverStalledUploads,
} = require('../main/core/sync/outbox');
const { uploadPendingBatch } = require('../main/core/sync/uploader');
const { ulid } = require('../main/core/ids');

interface MockEvent { uid: string; entity_uid: string; payload: any }

// Mock cloud transport — test-only. Records every uid it has seen so a
// replayed upload is acknowledged again without duplicating (idempotent),
// and can be told to fail transiently N times before succeeding.
function makeMockCloud() {
  const received = new Map<string, MockEvent>();
  let failuresRemaining = 0;
  let rejectUid: string | null = null;
  return {
    seenCount: () => received.size,
    hasSeen: (uid: string) => received.has(uid),
    failNext: (n: number) => { failuresRemaining = n; },
    rejectEvent: (uid: string) => { rejectUid = uid; },
    transport: {
      async upload(events: any[]) {
        if (failuresRemaining > 0) { failuresRemaining -= 1; throw new Error('simulated transient network failure'); }
        const acked: string[] = [];
        const rejected: Array<{ uid: string; reason: string }> = [];
        for (const e of events) {
          if (rejectUid && e.uid === rejectUid) { rejected.push({ uid: e.uid, reason: 'simulated permanent rejection' }); continue; }
          received.set(e.uid, { uid: e.uid, entity_uid: e.entity_uid, payload: e.payload }); // idempotent replay: re-set is harmless
          acked.push(e.uid);
        }
        return { acked, rejected };
      },
    },
  };
}

async function main() {
  console.log('Test: SYNC-A local foundation');
  console.log('='.repeat(50));

  const db = initTestDb();
  const organization = getOrganizationContext();
  const location = getLocationContext();
  const device = getDeviceContext();
  const deviceId = device.id;
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, track_inventory, stock_quantity, low_stock_threshold, is_active, sort_order, created_at, updated_at)
              VALUES ('prod-sa', NULL, 'SA Widget', 10, 0, 1, 100, 5, 1, 0, ?, ?)`).run(now(), now());

  // ══ 1-6. A movement produces a correct outbox event ═══════════════════
  console.log('\n1-6. An inventory movement produces a correct outbox event');
  const movement = adjustStock({ productId: 'prod-sa', quantityDelta: 5, reason: 'SA restock', movementType: 'adjustment' });
  assertEqual(getBalance('prod-sa'), 105, 'inventory balance still updates (movement succeeded)');
  const events = nextPendingBatch(deviceId, 100, db);
  assertEqual(events.length, 1, 'exactly one outbox event was created for the movement');
  const event = events[0];
  assertEqual(event.entity_type, 'inventory_movement', 'the event is typed inventory_movement');
  assertEqual(event.entity_uid, movement.id, 'the event references the movement by its business uid');
  assert(!!event.uid && event.uid !== movement.id, 'the event has its own uid, distinct from the business fact uid (Part H)');
  assertEqual(event.device_id, deviceId, 'the event carries this device identity');
  assert(typeof event.sequence === 'number' && event.sequence >= 1, 'the event has a per-device sequence');
  // Payload correctness (Part F).
  assertEqual(event.payload.schema_version, 1, 'the payload is versioned');
  assertEqual(event.payload.movement_uid, movement.id, 'payload movement_uid matches');
  assertEqual(event.payload.quantity_delta, 5, 'payload carries the quantity delta');
  assertEqual(event.payload.movement_type, 'adjustment', 'payload carries the movement type');
  assertEqual(event.payload.organization_id, organization.id, 'payload carries the organization');
  assertEqual(event.payload.location_id, location.id, 'payload carries the location');
  assertEqual(event.payload.balance_after, undefined, 'payload does NOT include the derived balance_after (Part F)');
  assertEqual(event.payload.stock_quantity, undefined, 'payload does NOT include products.stock_quantity (Part F)');

  // ══ 7-9. Atomicity ════════════════════════════════════════════════════
  console.log('\n7-9. The movement and its outbox event are atomic');
  const outboxBefore = countOutboxByStatus('pending', db);
  const movementCountBefore = (db.prepare('SELECT COUNT(*) AS c FROM inventory_movements').get() as any).c;
  // Force the whole business transaction to roll back AFTER a movement +
  // outbox event were written inside it, and confirm NEITHER survives.
  let rolledBack = false;
  try {
    db.transaction(() => {
      adjustStock({ productId: 'prod-sa', quantityDelta: 3, reason: 'SA rollback test', movementType: 'adjustment' });
      throw new Error('force rollback');
    })();
  } catch { rolledBack = true; }
  assert(rolledBack, 'the transaction threw as expected');
  assertEqual((db.prepare('SELECT COUNT(*) AS c FROM inventory_movements').get() as any).c, movementCountBefore, 'the movement did not survive the rollback');
  assertEqual(countOutboxByStatus('pending', db), outboxBefore, 'the outbox event did not survive the rollback either — movement + event are one atomic unit');

  // A failure inside the outbox append must roll the inventory movement back
  // too. Simulate by temporarily breaking the sync_outbox table.
  console.log('  (an outbox-append failure rolls the inventory movement back)');
  db.exec('ALTER TABLE sync_outbox RENAME TO sync_outbox_hidden');
  let outboxFailureRolledBack = false;
  const balanceBeforeFail = getBalance('prod-sa');
  try {
    adjustStock({ productId: 'prod-sa', quantityDelta: 7, reason: 'SA outbox-fail test', movementType: 'adjustment' });
  } catch { outboxFailureRolledBack = true; }
  db.exec('ALTER TABLE sync_outbox_hidden RENAME TO sync_outbox');
  assert(outboxFailureRolledBack, 'a movement whose outbox append fails throws');
  assertEqual(getBalance('prod-sa'), balanceBeforeFail, 'the inventory movement rolled back when its outbox append failed — no movement without its sync event');

  // ══ 10-12. Sequence + idempotency ═════════════════════════════════════
  console.log('\n10-12. Sequence determinism, per-device independence, idempotency');
  const seqStart = getSyncState(deviceId, db).device_sequence;
  const m1 = adjustStock({ productId: 'prod-sa', quantityDelta: 1, reason: 'seq1', movementType: 'adjustment' });
  const m2 = adjustStock({ productId: 'prod-sa', quantityDelta: 1, reason: 'seq2', movementType: 'adjustment' });
  const e1 = db.prepare('SELECT sequence FROM sync_outbox WHERE entity_uid = ?').get(m1.id) as any;
  const e2 = db.prepare('SELECT sequence FROM sync_outbox WHERE entity_uid = ?').get(m2.id) as any;
  assertEqual(e2.sequence, e1.sequence + 1, 'two consecutive movements get consecutive, increasing sequences');
  assert(e1.sequence > seqStart, 'sequence advanced monotonically from the prior state');

  // Independent device: a different device_id has its own independent
  // sequence counter and pending queue, starting at 1. (Real installs are
  // one-device-per-DB, so this is normally guaranteed by separate DBs; here
  // we prove the mechanism is genuinely per-device-keyed in one DB.)
  const otherDeviceId = ulid();
  db.prepare('INSERT OR IGNORE INTO sync_state (device_id, device_sequence, created_at, updated_at) VALUES (?, 0, ?, ?)').run(otherDeviceId, now(), now());
  db.prepare(`INSERT INTO sync_outbox (uid, device_id, sequence, entity_type, entity_uid, operation, payload, status, attempt_count, created_at)
              VALUES (?, ?, 1, 'inventory_movement', 'other-dev-evt', 'create', '{}', 'pending', 0, ?)`).run(ulid(), otherDeviceId, now());
  const otherPending = nextPendingBatch(otherDeviceId, 100, db);
  assertEqual(otherPending.length, 1, 'the other device has its own independent pending queue');
  assertEqual(otherPending[0].sequence, 1, "the other device's sequence is independent (starts at 1)");
  // Remove the synthetic other-device rows so the remaining single-device
  // assertions (which use global outbox counts, correct for a real
  // one-device install) are not skewed by this artificial second device.
  db.prepare('DELETE FROM sync_outbox WHERE device_id = ?').run(otherDeviceId);
  db.prepare('DELETE FROM sync_state WHERE device_id = ?').run(otherDeviceId);

  // Idempotency: appending an event for the SAME business fact twice does not
  // create a second event or burn a sequence.
  const seqBeforeDup = getSyncState(deviceId, db).device_sequence;
  const first = db.transaction(() => appendOutboxEvent({ db, entityType: 'inventory_movement', entityUid: m1.id, payload: { schema_version: 1, movement_uid: m1.id } }))();
  assertEqual(first.entity_uid, m1.id, 'appending for an already-synced movement returns the existing event');
  const eventCountForM1 = (db.prepare("SELECT COUNT(*) AS c FROM sync_outbox WHERE entity_uid = ?").get(m1.id) as any).c;
  assertEqual(eventCountForM1, 1, 'no duplicate outbox event was created for the same business fact (Part H)');
  assertEqual(getSyncState(deviceId, db).device_sequence, seqBeforeDup, 'the idempotent re-append did not burn a sequence number');

  // ══ 13-16. Mock upload / ack / retry ══════════════════════════════════
  console.log('\n13-16. Mock upload, ACK, and retry');
  const cloud = makeMockCloud();
  const pendingBeforeUpload = countOutboxByStatus('pending', db);
  assert(pendingBeforeUpload > 0, 'there are pending events to upload');

  const outcome = await uploadPendingBatch(cloud.transport, deviceId, 100, db);
  assertEqual(outcome.acked, pendingBeforeUpload, 'the mock cloud acked every uploaded event');
  assertEqual(countOutboxByStatus('pending', db), 0, 'no events remain pending after a successful upload');
  assertEqual(countOutboxByStatus('acked', db), pendingBeforeUpload, 'uploaded events are marked acked');
  assert(getSyncState(deviceId, db).last_uploaded_sequence >= e2.sequence, 'sync_state advanced its last-uploaded high-water mark');

  // Retry does not duplicate: a second upload finds nothing pending.
  const secondOutcome = await uploadPendingBatch(cloud.transport, deviceId, 100, db);
  assertEqual(secondOutcome.attempted, 0, 'a second upload has nothing to send — acked events are not re-uploaded');

  // A transient failure returns events to pending; the next upload succeeds.
  const m3 = adjustStock({ productId: 'prod-sa', quantityDelta: 1, reason: 'retry-test', movementType: 'adjustment' });
  cloud.failNext(1);
  const failedOutcome = await uploadPendingBatch(cloud.transport, deviceId, 100, db);
  assert(!!failedOutcome.transportError, 'the transient failure is reported');
  assertEqual(countOutboxByStatus('pending', db), 1, 'the event returned to pending after the transient failure (not lost)');
  assertEqual(countOutboxByStatus('uploading', db), 0, 'no event is left stuck uploading');
  assert(getSyncState(deviceId, db).failure_count >= 1, 'the failure is recorded on sync_state');
  const retryOutcome = await uploadPendingBatch(cloud.transport, deviceId, 100, db);
  assertEqual(retryOutcome.acked, 1, 'the retry succeeds and acks the event');
  const m3Event = db.prepare('SELECT status, attempt_count FROM sync_outbox WHERE entity_uid = ?').get(m3.id) as any;
  assertEqual(m3Event.status, 'acked', 'the retried event is now acked');
  assert(m3Event.attempt_count >= 2, 'the attempt count reflects the retry');

  // Permanent rejection.
  console.log('  (permanent rejection)');
  const m4 = adjustStock({ productId: 'prod-sa', quantityDelta: 1, reason: 'reject-test', movementType: 'adjustment' });
  const m4Uid = (db.prepare('SELECT uid FROM sync_outbox WHERE entity_uid = ?').get(m4.id) as any).uid;
  cloud.rejectEvent(m4Uid);
  await uploadPendingBatch(cloud.transport, deviceId, 100, db);
  assertEqual((db.prepare('SELECT status FROM sync_outbox WHERE uid = ?').get(m4Uid) as any).status, 'failed', 'a permanently rejected event is marked failed, not retried forever');

  // ══ 17. Crash / restart recovery ══════════════════════════════════════
  console.log('\n17. Crash / restart recovery');
  const m5 = adjustStock({ productId: 'prod-sa', quantityDelta: 1, reason: 'crash-test', movementType: 'adjustment' });
  const m5Uid = (db.prepare('SELECT uid FROM sync_outbox WHERE entity_uid = ?').get(m5.id) as any).uid;
  // Simulate a crash mid-upload: the event was marked uploading but never acked.
  db.prepare("UPDATE sync_outbox SET status = 'uploading' WHERE uid = ?").run(m5Uid);
  const recovered = recoverStalledUploads(db);
  assert(recovered >= 1, 'crash recovery reset the stalled uploading event');
  assertEqual((db.prepare('SELECT status FROM sync_outbox WHERE uid = ?').get(m5Uid) as any).status, 'pending', 'the stalled event is back to pending for retry — no event lost to a crash');
  const recoverOutcome = await uploadPendingBatch(cloud.transport, deviceId, 100, db);
  assertEqual(recoverOutcome.acked, 1, 'the recovered event uploads successfully after restart');

  // ══ 18-19. Inbox + sync_state durability ══════════════════════════════
  console.log('\n18-19. Inbox foundation and sync_state persistence');
  const inboxUid = ulid();
  db.prepare(`INSERT INTO sync_inbox (uid, entity_type, entity_uid, operation, payload, cursor, status, received_at)
              VALUES (?, 'inventory_movement', 'remote-movement-1', 'create', '{"schema_version":1}', 'cursor-abc', 'pending', ?)`).run(inboxUid, now());
  const inboxRow = db.prepare('SELECT * FROM sync_inbox WHERE uid = ?').get(inboxUid) as any;
  assertEqual(inboxRow.status, 'pending', 'an inbox row persists with pending status (crash-recoverable foundation)');
  assertEqual(inboxRow.cursor, 'cursor-abc', 'the inbox row records the download cursor it arrived under');

  const state = getSyncState(deviceId, db);
  assert(!!state, 'sync_state persists for this device');
  assert(typeof state.device_sequence === 'number', 'sync_state tracks the device sequence');
  assert(typeof state.last_uploaded_sequence === 'number', 'sync_state tracks the last uploaded sequence');
  assertEqual(state.protocol_version, '1', 'sync_state records a protocol version');

  // Device identity is resolved server-side, never client-supplied (Part O).
  assertEqual(resolveDeviceId(db), deviceId, 'device identity resolves from device context, not any client input');
  // No credential/secret is present in the outbox payload (Part O).
  const anyPayload = JSON.stringify(nextPendingBatch(deviceId, 100, db)) + JSON.stringify(events);
  assert(!/private|secret|token|credential|password/i.test(anyPayload), 'no credential/secret/token appears in any outbox payload (Part O)');

  closeDatabase();
  const { passed, failed } = getResults();
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error('Test suite failed:', error); process.exit(1); });
