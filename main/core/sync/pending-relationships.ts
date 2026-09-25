/**
 * Plemmo Core — durable missing-parent relationships (SYNC-F, Part I).
 *
 * SYNC-E already STAGES a child that arrives before its parent (it lands in
 * its FK-free mirror regardless of parent presence, so no event is ever
 * dropped). SYNC-F makes the RELATIONSHIP itself durable and observable:
 *
 *   child arrives first → recordPending(...) writes a 'pending' row
 *   parent arrives      → resolvePendingForParent(parentUid) flips it 'resolved'
 *
 * Recovery is EVENT-DRIVEN, not polled: nothing loops waiting for a parent —
 * the pending row simply records the gap, and the next apply of the parent
 * clears it. A reconciliation sweep can later mark rows that never recovered
 * within a retention window as 'permanently_invalid' (a clear, bounded reason
 * — no infinite polling). Every state keeps the child data (already in the
 * mirror), so 'permanently_invalid' still never discards anything.
 */

import type Database from 'better-sqlite3';
import { getDatabase, now } from '../../db';
import { ulid } from '../ids';

type Db = Database.Database;

export type PendingStatus = 'pending' | 'resolved' | 'permanently_invalid';

export interface PendingRelationshipRow {
  id: string;
  child_type: string;
  child_uid: string;
  parent_type: string;
  parent_uid: string;
  organization_id: string | null;
  location_id: string | null;
  status: PendingStatus;
  reason: string | null;
  attempts: number;
  detected_at: string;
  resolved_at: string | null;
  updated_at: string;
}

export interface RecordPendingInput {
  childType: string;
  childUid: string;
  parentType: string;
  parentUid: string;
  organizationId?: string | null;
  locationId?: string | null;
  reason?: string | null;
}

/**
 * Records (or bumps the attempt count of) a pending child→parent relationship.
 * Idempotent by (child_type, child_uid): a re-pulled orphan updates the same
 * row rather than duplicating. A row already 'resolved' is left resolved.
 */
export function recordPending(input: RecordPendingInput, db: Db = getDatabase()): PendingRelationshipRow {
  const existing = db.prepare('SELECT * FROM sales_pending_relationships WHERE child_type = ? AND child_uid = ?')
    .get(input.childType, input.childUid) as PendingRelationshipRow | undefined;
  if (existing) {
    if (existing.status === 'pending') {
      db.prepare('UPDATE sales_pending_relationships SET attempts = attempts + 1, updated_at = ? WHERE id = ?').run(now(), existing.id);
    }
    return db.prepare('SELECT * FROM sales_pending_relationships WHERE id = ?').get(existing.id) as PendingRelationshipRow;
  }
  const id = ulid();
  const at = now();
  db.prepare(`
    INSERT INTO sales_pending_relationships (id, child_type, child_uid, parent_type, parent_uid, organization_id, location_id,
      status, reason, attempts, detected_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?)
  `).run(id, input.childType, input.childUid, input.parentType, input.parentUid,
    input.organizationId ?? null, input.locationId ?? null, input.reason ?? 'parent not yet applied', at, at);
  return db.prepare('SELECT * FROM sales_pending_relationships WHERE id = ?').get(id) as PendingRelationshipRow;
}

/** Marks every pending child of this parent 'resolved'. Returns the count recovered. */
export function resolvePendingForParent(parentUid: string, db: Db = getDatabase()): number {
  return db.prepare(
    "UPDATE sales_pending_relationships SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE parent_uid = ? AND status = 'pending'",
  ).run(now(), now(), parentUid).changes;
}

export function listPending(status: PendingStatus | 'all' = 'pending', db: Db = getDatabase()): PendingRelationshipRow[] {
  if (status === 'all') return db.prepare('SELECT * FROM sales_pending_relationships ORDER BY detected_at DESC').all() as PendingRelationshipRow[];
  return db.prepare('SELECT * FROM sales_pending_relationships WHERE status = ? ORDER BY detected_at DESC').all(status) as PendingRelationshipRow[];
}

export function getPendingForChild(childType: string, childUid: string, db: Db = getDatabase()): PendingRelationshipRow | null {
  return (db.prepare('SELECT * FROM sales_pending_relationships WHERE child_type = ? AND child_uid = ?').get(childType, childUid) as PendingRelationshipRow | undefined) ?? null;
}

/**
 * Reconciliation sweep (Part I): mark still-'pending' rows older than
 * `olderThanIso` as 'permanently_invalid', with a clear reason. This is the
 * ONLY path to permanent invalidity — it is bounded and explicit, never an
 * open-ended retry loop. The child data stays in its mirror; only the
 * relationship's recoverability is closed out.
 */
export function markStalePendingInvalid(olderThanIso: string, db: Db = getDatabase()): number {
  return db.prepare(
    `UPDATE sales_pending_relationships SET status = 'permanently_invalid',
       reason = 'parent did not arrive within retention window', updated_at = ?
     WHERE status = 'pending' AND detected_at < ?`,
  ).run(now(), olderThanIso).changes;
}
