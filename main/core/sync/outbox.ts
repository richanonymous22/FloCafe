/**
 * Plemmo Core — sync outbox (SYNC-A).
 *
 * The local, durable record of business facts waiting to be uploaded. This
 * module owns:
 *   - appending an outbox event atomically with the business write that
 *     produced it (`appendOutboxEvent` — called from inside the caller's
 *     already-open transaction, never opening its own);
 *   - allocating this device's monotonic per-device sequence (Part G);
 *   - reading the next pending batch in order, and marking events
 *     uploading / acked / failed (the state a future worker drives).
 *
 * Express-independent. `db` is always passed in so every write joins the
 * caller's transaction — the central atomicity guarantee of SYNC-A.
 */

import type Database from 'better-sqlite3';
import { getDatabase, now } from '../../db';
import { ulid } from '../ids';
import { getDeviceContext } from '../context';
import { OutboxEventDTO, OutboxStatus, SyncEntityType, SyncOperation } from './types';

type Db = Database.Database;

/**
 * Resolves this device's identity SERVER-SIDE from device context (Part O) —
 * never from anything a client supplied. Falls back to the raw device
 * pointer, and finally to a sentinel only on a degenerate install with no
 * device row at all (which a seeded Plemmo install never is), so appending a
 * sync event can never crash a business transaction for lack of a device id.
 */
export function resolveDeviceId(db: ReturnType<typeof getDatabase>): string {
  const fromContext = getDeviceContext()?.id;
  if (fromContext) return fromContext;
  const fromPointer = (db.prepare("SELECT value FROM settings WHERE key = 'plemmo_device_id'").get() as { value?: string } | undefined)?.value;
  return fromPointer || 'local-device';
}

/**
 * Allocates the next monotonic sequence for a device, creating its
 * `sync_state` row on first use. Runs inside the caller's transaction and,
 * because better-sqlite3 is synchronous and single-threaded, needs no lock:
 * the read-modify-write cannot interleave. The counter never goes backward,
 * so pruning acked outbox rows later can never reissue a sequence.
 */
function allocateSequence(db: ReturnType<typeof getDatabase>, deviceId: string): number {
  db.prepare(`
    INSERT INTO sync_state (device_id, device_sequence, created_at, updated_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET device_sequence = device_sequence + 1, updated_at = excluded.updated_at
  `).run(deviceId, now(), now());
  const row = db.prepare('SELECT device_sequence FROM sync_state WHERE device_id = ?').get(deviceId) as { device_sequence: number };
  return row.device_sequence;
}

export interface AppendOutboxEventInput {
  db: ReturnType<typeof getDatabase>;
  entityType: SyncEntityType;
  entityUid: string;
  operation?: SyncOperation;
  organizationId?: string | null;
  locationId?: string | null;
  payload: unknown;
}

export interface OutboxRow {
  uid: string;
  device_id: string;
  sequence: number;
  entity_type: string;
  entity_uid: string;
  operation: string;
  payload: string;
  organization_id: string | null;
  location_id: string | null;
  status: OutboxStatus;
  attempt_count: number;
  last_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  acked_at: string | null;
}

/**
 * Appends one outbox event for a business fact. Idempotent by
 * `(entity_type, entity_uid)` (Part H): if an event for this business fact
 * already exists, the existing row is returned and NO new sequence is
 * allocated (so a retry cannot leave a gap in the sequence). Returns the
 * outbox row.
 */
export function appendOutboxEvent(input: AppendOutboxEventInput): OutboxRow {
  const { db } = input;
  const operation = input.operation ?? 'create';

  const existing = db.prepare('SELECT * FROM sync_outbox WHERE entity_type = ? AND entity_uid = ?')
    .get(input.entityType, input.entityUid) as OutboxRow | undefined;
  if (existing) return existing;

  const deviceId = resolveDeviceId(db);
  const sequence = allocateSequence(db, deviceId);
  const uid = ulid();
  const createdAt = now();

  db.prepare(`
    INSERT INTO sync_outbox
      (uid, device_id, sequence, entity_type, entity_uid, operation, payload, organization_id, location_id, status, attempt_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
  `).run(
    uid, deviceId, sequence, input.entityType, input.entityUid, operation,
    JSON.stringify(input.payload), input.organizationId ?? null, input.locationId ?? null, createdAt,
  );

  return db.prepare('SELECT * FROM sync_outbox WHERE uid = ?').get(uid) as OutboxRow;
}

export interface AppendSnapshotInput {
  db: ReturnType<typeof getDatabase>;
  entityType: SyncEntityType;
  entityUid: string;
  organizationId?: string | null;
  locationId?: string | null;
  /** Builds the payload given the allocated monotonic snapshot version. */
  buildPayload: (snapshotVersion: number) => unknown;
}

/**
 * Appends a MUTABLE-entity snapshot event (SYNC-E). Unlike `appendOutboxEvent`,
 * this NEVER dedupes by (entity_type, entity_uid): a mutable business record
 * (order/order_item/bill) emits a fresh snapshot event — with its own event
 * uid and a monotonically increasing `snapshot_version` — every time it
 * changes. Runs inside the caller's transaction, so the snapshot commits or
 * rolls back atomically with the business write. The relaxed outbox unique
 * index (migration v88) permits several events per mutable entity_uid.
 */
export function appendSnapshotOutboxEvent(input: AppendSnapshotInput): OutboxRow {
  const { db } = input;
  const deviceId = resolveDeviceId(db);
  const sequence = allocateSequence(db, deviceId);
  const prior = (db.prepare('SELECT COUNT(*) AS c FROM sync_outbox WHERE entity_type = ? AND entity_uid = ?')
    .get(input.entityType, input.entityUid) as { c: number }).c;
  const snapshotVersion = prior + 1;
  const uid = ulid();
  const createdAt = now();
  db.prepare(`
    INSERT INTO sync_outbox
      (uid, device_id, sequence, entity_type, entity_uid, operation, payload, organization_id, location_id, status, attempt_count, created_at)
    VALUES (?, ?, ?, ?, ?, 'update', ?, ?, ?, 'pending', 0, ?)
  `).run(
    uid, deviceId, sequence, input.entityType, input.entityUid,
    JSON.stringify(input.buildPayload(snapshotVersion)), input.organizationId ?? null, input.locationId ?? null, createdAt,
  );
  return db.prepare('SELECT * FROM sync_outbox WHERE uid = ?').get(uid) as OutboxRow;
}

function toDTO(row: OutboxRow): OutboxEventDTO {
  return {
    uid: row.uid,
    device_id: row.device_id,
    sequence: row.sequence,
    entity_type: row.entity_type as SyncEntityType,
    entity_uid: row.entity_uid,
    operation: row.operation as SyncOperation,
    organization_id: row.organization_id,
    location_id: row.location_id,
    payload: JSON.parse(row.payload),
    created_at: row.created_at,
  };
}

/**
 * The next N pending events for a device, in sequence order — the exact
 * query a future sync worker asks (Part N), served by the
 * (device_id, status, sequence) index.
 */
export function nextPendingBatch(deviceId: string, limit = 100, db: Db = getDatabase()): OutboxEventDTO[] {
  const rows = db.prepare(`
    SELECT * FROM sync_outbox WHERE device_id = ? AND status = 'pending'
    ORDER BY sequence ASC LIMIT ?
  `).all(deviceId, limit) as OutboxRow[];
  return rows.map(toDTO);
}

export function countOutboxByStatus(status: OutboxStatus, db: Db = getDatabase()): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM sync_outbox WHERE status = ?').get(status) as { c: number }).c;
}

/** Marks a batch of events as in-flight, bumping attempt bookkeeping. */
export function markUploading(uids: string[], db: Db = getDatabase()): void {
  if (uids.length === 0) return;
  const stmt = db.prepare("UPDATE sync_outbox SET status = 'uploading', attempt_count = attempt_count + 1, last_attempt_at = ? WHERE uid = ?");
  const at = now();
  const txn = db.transaction((ids: string[]) => { for (const id of ids) stmt.run(at, id); });
  txn(uids);
}

/** Marks events acknowledged by the (mock) cloud and advances this device's last-uploaded high-water mark. */
export function markAcked(uids: string[], db: Db = getDatabase()): void {
  if (uids.length === 0) return;
  const at = now();
  const stmt = db.prepare("UPDATE sync_outbox SET status = 'acked', acked_at = ?, last_error = NULL WHERE uid = ?");
  db.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(at, id);
    // Advance last_uploaded_sequence per device to the highest acked sequence.
    const devices = db.prepare(`SELECT DISTINCT device_id FROM sync_outbox WHERE uid IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ device_id: string }>;
    for (const { device_id } of devices) {
      const high = (db.prepare("SELECT COALESCE(MAX(sequence), 0) AS m FROM sync_outbox WHERE device_id = ? AND status = 'acked'").get(device_id) as { m: number }).m;
      db.prepare('UPDATE sync_state SET last_uploaded_sequence = ?, last_upload_at = ?, failure_count = 0, updated_at = ? WHERE device_id = ?')
        .run(high, at, at, device_id);
    }
  })(uids);
}

/** Marks events failed (a permanent rejection or an exhausted retry) with a reason. */
export function markFailed(uids: string[], reason: string, db: Db = getDatabase()): void {
  if (uids.length === 0) return;
  const at = now();
  const stmt = db.prepare("UPDATE sync_outbox SET status = 'failed', last_error = ?, last_attempt_at = ? WHERE uid = ?");
  db.transaction((ids: string[]) => { for (const id of ids) stmt.run(reason, at, id); })(uids);
}

/**
 * Crash recovery: reset any event stuck in `uploading` (the process died
 * mid-upload before an ack or failure was recorded) back to `pending`, so it
 * is retried. Safe because SYNC-A has no concurrent uploader — uploads run
 * only through explicit `uploadPendingBatch` calls, one at a time.
 */
export function recoverStalledUploads(db: Db = getDatabase()): number {
  const result = db.prepare("UPDATE sync_outbox SET status = 'pending' WHERE status = 'uploading'").run();
  return result.changes;
}

export function getSyncState(deviceId: string, db: Db = getDatabase()): Record<string, unknown> | null {
  return (db.prepare('SELECT * FROM sync_state WHERE device_id = ?').get(deviceId) as Record<string, unknown> | undefined) ?? null;
}

export function recordSyncFailure(deviceId: string, error: string, db: Db = getDatabase()): void {
  const at = now();
  db.prepare(`
    INSERT INTO sync_state (device_id, failure_count, last_error, last_error_at, created_at, updated_at)
    VALUES (?, 1, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET failure_count = failure_count + 1, last_error = excluded.last_error, last_error_at = excluded.last_error_at, updated_at = excluded.updated_at
  `).run(deviceId, error, at, at, at);
}
