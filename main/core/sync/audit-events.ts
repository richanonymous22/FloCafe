/**
 * Plemmo Core — audit-event sync (SYNC-D, Part K).
 *
 * Builds the typed outbox event for an `audit_events` row and appends it to
 * the outbox inside the caller's transaction. Audit events are immutable,
 * append-only facts — the second synchronized entity, chosen as the
 * lowest-risk way to exercise the generalized multi-entity seam.
 *
 * Emission is BEST-EFFORT: `recordAuditEvent` must never throw (auditing must
 * never break a sale), so a failure to enqueue the sync event is logged and
 * swallowed. The audit row still exists locally; only its cloud propagation is
 * deferred, which is acceptable for a local-first log.
 */

import type Database from 'better-sqlite3';
import { appendOutboxEvent, OutboxRow } from './outbox';
import { AuditEventPayload } from './types';

type Db = Database.Database;

interface AuditRowLike {
  id: string;
  occurred_at: string;
  event_type: string;
  actor_user_id: string | null;
  actor_role: string | null;
  entity_type: string | null;
  entity_id: string | null;
  organization_id: string | null;
  location_id: string | null;
  register_id: string | null;
  device_id: string | null;
  summary: string | null;
  metadata: string | null;
}

export function buildAuditEventPayload(row: AuditRowLike): AuditEventPayload {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata); } catch { metadata = null; }
  }
  return {
    schema_version: 1,
    audit_uid: row.id,
    occurred_at: row.occurred_at,
    event_type: row.event_type,
    actor_user_id: row.actor_user_id,
    actor_role: row.actor_role,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    organization_id: row.organization_id,
    location_id: row.location_id,
    register_id: row.register_id,
    device_id: row.device_id,
    summary: row.summary,
    metadata,
  };
}

/**
 * Enqueues the sync event for a just-written audit row, in the caller's
 * transaction. Never throws — returns null on any failure.
 */
export function appendAuditEventOutbox(db: Db, row: AuditRowLike): OutboxRow | null {
  try {
    return appendOutboxEvent({
      db,
      entityType: 'audit_event',
      entityUid: row.id,
      operation: 'append',
      organizationId: row.organization_id,
      locationId: row.location_id,
      payload: buildAuditEventPayload(row),
    });
  } catch (err) {
    console.error('[Sync] failed to enqueue audit event', row.id, (err as Error).message);
    return null;
  }
}
