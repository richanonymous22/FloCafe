/**
 * Plemmo Core — local sales-conflict store (SYNC-F).
 *
 * The device-side durable store for `sales_conflicts` and
 * `sales_reconciliation_actions` (migration v89). It is deliberately a thin,
 * transactional data layer — all policy (legality, authorization, financial
 * safety) lives in conflict-resolution.ts, all detection lives in
 * remote-apply.ts / conflict-sync.ts. Every write joins the caller's
 * transaction when one is passed.
 *
 * A conflict's `conflict_uid` is the SHARED identity with the cloud's
 * cloud_conflicts row: upserting a pulled cloud conflict and recording a
 * locally-detected one both key on it, so there is exactly ONE logical
 * conflict per (entity, divergence), never a competing local/cloud pair.
 */

import type Database from 'better-sqlite3';
import { getDatabase, now } from '../../db';
import { ulid } from '../ids';
import { ConflictType, ConflictStatus } from './conflict-model';

type Db = Database.Database;

export interface SalesConflictRow {
  conflict_uid: string;
  organization_id: string | null;
  location_id: string | null;
  entity_type: string;
  entity_uid: string;
  conflict_type: string;
  source: string;
  local_event_uid: string | null;
  remote_event_uid: string | null;
  local_device_uid: string | null;
  remote_device_uid: string | null;
  local_snapshot_version: number | null;
  remote_snapshot_version: number | null;
  status: ConflictStatus;
  detected_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolution_strategy: string | null;
  resolution_actor: string | null;
  resolved_at: string | null;
  resolution_notes: string | null;
  compensation_reference: string | null;
  resulting_state: string | null;
  updated_at: string;
}

export interface UpsertConflictInput {
  conflictUid: string;
  organizationId?: string | null;
  locationId?: string | null;
  entityType: string;
  entityUid: string;
  conflictType: ConflictType;
  source?: 'cloud' | 'local';
  localEventUid?: string | null;
  remoteEventUid?: string | null;
  localDeviceUid?: string | null;
  remoteDeviceUid?: string | null;
  localSnapshotVersion?: number | null;
  remoteSnapshotVersion?: number | null;
  detectedAt?: string;
}

/**
 * Inserts a conflict, or leaves an EXISTING one untouched (idempotent by
 * conflict_uid — a conflict pulled twice, or detected locally then pulled,
 * must not reopen or duplicate). Returns the stored row. Conflict records are
 * themselves idempotent (Part H).
 */
export function upsertConflict(input: UpsertConflictInput, db: Db = getDatabase()): SalesConflictRow {
  const existing = db.prepare('SELECT * FROM sales_conflicts WHERE conflict_uid = ?').get(input.conflictUid) as SalesConflictRow | undefined;
  if (existing) return existing;
  const at = input.detectedAt ?? now();
  db.prepare(`
    INSERT INTO sales_conflicts (conflict_uid, organization_id, location_id, entity_type, entity_uid, conflict_type, source,
      local_event_uid, remote_event_uid, local_device_uid, remote_device_uid, local_snapshot_version, remote_snapshot_version,
      status, detected_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(
    input.conflictUid, input.organizationId ?? null, input.locationId ?? null, input.entityType, input.entityUid,
    input.conflictType, input.source ?? 'cloud', input.localEventUid ?? null, input.remoteEventUid ?? null,
    input.localDeviceUid ?? null, input.remoteDeviceUid ?? null, input.localSnapshotVersion ?? null,
    input.remoteSnapshotVersion ?? null, at, at,
  );
  return db.prepare('SELECT * FROM sales_conflicts WHERE conflict_uid = ?').get(input.conflictUid) as SalesConflictRow;
}

export function getConflict(conflictUid: string, db: Db = getDatabase()): SalesConflictRow | null {
  return (db.prepare('SELECT * FROM sales_conflicts WHERE conflict_uid = ?').get(conflictUid) as SalesConflictRow | undefined) ?? null;
}

export interface ListConflictsFilter {
  organizationId?: string | null;
  status?: ConflictStatus;
  entityType?: string;
  entityUid?: string;
  limit?: number;
}

export function listConflicts(filter: ListConflictsFilter = {}, db: Db = getDatabase()): SalesConflictRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.organizationId) { clauses.push('organization_id = ?'); params.push(filter.organizationId); }
  if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
  if (filter.entityType) { clauses.push('entity_type = ?'); params.push(filter.entityType); }
  if (filter.entityUid) { clauses.push('entity_uid = ?'); params.push(filter.entityUid); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(Number(filter.limit ?? 200), 1), 1000);
  return db.prepare(`SELECT * FROM sales_conflicts ${where} ORDER BY detected_at DESC LIMIT ?`).all(...params, limit) as SalesConflictRow[];
}

/** Persists a status transition + resolution outcome fields. Caller has already validated the transition. */
export function updateConflictState(
  conflictUid: string,
  patch: Partial<Pick<SalesConflictRow,
    'status' | 'acknowledged_at' | 'acknowledged_by' | 'resolution_strategy' | 'resolution_actor'
    | 'resolved_at' | 'resolution_notes' | 'compensation_reference' | 'resulting_state'>>,
  db: Db = getDatabase(),
): void {
  const fields = Object.keys(patch);
  if (fields.length === 0) return;
  const set = fields.map((f) => `${f} = ?`).join(', ');
  const values = fields.map((f) => (patch as Record<string, unknown>)[f]);
  db.prepare(`UPDATE sales_conflicts SET ${set}, updated_at = ? WHERE conflict_uid = ?`).run(...values, now(), conflictUid);
}

export interface ReconciliationActionRow {
  id: string;
  conflict_uid: string | null;
  organization_id: string | null;
  location_id: string | null;
  entity_type: string | null;
  entity_uid: string | null;
  action_type: string;
  strategy: string | null;
  actor_user_id: string | null;
  actor_role: string | null;
  notes: string | null;
  reference: string | null;
  created_at: string;
}

export interface RecordActionInput {
  conflictUid?: string | null;
  organizationId?: string | null;
  locationId?: string | null;
  entityType?: string | null;
  entityUid?: string | null;
  actionType: 'acknowledge' | 'resolve' | 'dismiss' | 'compensation' | 'note' | 'reconciliation';
  strategy?: string | null;
  actorUserId?: string | null;
  actorRole?: string | null;
  notes?: string | null;
  reference?: string | null;
}

/** Appends a durable reconciliation-action record (never pruned — the conflict's audit trail). */
export function recordReconciliationAction(input: RecordActionInput, db: Db = getDatabase()): ReconciliationActionRow {
  const id = ulid();
  db.prepare(`
    INSERT INTO sales_reconciliation_actions (id, conflict_uid, organization_id, location_id, entity_type, entity_uid,
      action_type, strategy, actor_user_id, actor_role, notes, reference, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.conflictUid ?? null, input.organizationId ?? null, input.locationId ?? null,
    input.entityType ?? null, input.entityUid ?? null, input.actionType, input.strategy ?? null,
    input.actorUserId ?? null, input.actorRole ?? null, input.notes ?? null, input.reference ?? null, now(),
  );
  return db.prepare('SELECT * FROM sales_reconciliation_actions WHERE id = ?').get(id) as ReconciliationActionRow;
}

export function listActions(conflictUid: string, db: Db = getDatabase()): ReconciliationActionRow[] {
  return db.prepare('SELECT * FROM sales_reconciliation_actions WHERE conflict_uid = ? ORDER BY created_at ASC').all(conflictUid) as ReconciliationActionRow[];
}

export function listActionsForEntity(entityType: string, entityUid: string, db: Db = getDatabase()): ReconciliationActionRow[] {
  return db.prepare('SELECT * FROM sales_reconciliation_actions WHERE entity_type = ? AND entity_uid = ? ORDER BY created_at ASC').all(entityType, entityUid) as ReconciliationActionRow[];
}
