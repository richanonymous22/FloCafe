/**
 * Plemmo Core — audit events.
 *
 * The minimum reusable answer to: WHO did WHAT, WHEN, WHERE.
 *
 * A commercial EPOS has to be able to answer questions after the fact —
 * "who authorised this refund", "who changed this price", "who was on the
 * till when the drawer opened". The inherited codebase has fragments of this
 * (tax_config_audit, print_logs, payment_transaction_ref_conflicts) but no
 * common shape, so there is nowhere to look for a general answer.
 *
 * ## Scope
 *
 * Deliberately small. This is a write path plus a couple of reads, not an
 * audit framework — no subscribers, no rule engine, no retention policy.
 * Those are later decisions and are listed in docs/PLEMMO_ARCHITECTURE.md.
 *
 * ## Rules
 *
 *   - Append-only. Nothing in Plemmo may UPDATE or DELETE an audit row.
 *   - Never throws into a business transaction. An audit write failing must
 *     never be the reason a merchant cannot take a payment; failures are
 *     logged and swallowed. This is a deliberate trade: for a till, refusing
 *     the sale is worse than losing one audit row.
 *   - No secrets, card data, or full customer records in `metadata`. Record
 *     identifiers and the changed values, not payloads.
 *
 * ## Transactions
 *
 * `recordAuditEvent` uses the caller's current connection, so calling it
 * inside a `withTxn()` block enrols the audit row in that same transaction —
 * the event commits if and only if the thing it describes commits. That is
 * usually what you want for financial events (a refund and its audit row
 * should not be able to disagree).
 */

import { getDatabase, now } from '../db';
import { ulid } from './ids';
import { getOrganizationContext, getLocationContext, getRegisterContext, getDeviceContext, resetContextCache } from './context';
import { appendAuditEventOutbox } from './sync/audit-events';

/**
 * Dotted `entity.action` names. Kept as a plain string union rather than an
 * enum so adding one is a one-line change, while typos still fail the build.
 * Extend as each capability lands — do not invent names at call sites.
 */
export type AuditEventType =
  // Sales and money
  | 'sale.created'
  | 'sale.items_added'
  | 'sale.voided'
  | 'sale.refunded'
  | 'sale.discount_applied'
  | 'payment.recorded'
  | 'payment.voided'
  // Catalogue
  | 'product.created'
  | 'product.updated'
  | 'product.deleted'
  | 'product.price_changed'
  // Stock
  | 'stock.adjusted'
  | 'stock.received'
  | 'stock.counted'
  // People and access
  | 'employee.created'
  | 'employee.updated'
  | 'employee.deactivated'
  | 'permission.changed'
  // Cash handling
  | 'cash_session.opened'
  | 'cash_session.closed'
  | 'cash.movement'
  // Device and platform
  | 'device.registered'
  | 'device.revoked'
  | 'settings.changed'
  | 'database.maintenance'
  // Sync conflict reconciliation (SYNC-F, Part L)
  | 'sync.conflict_acknowledged'
  | 'sync.conflict_resolved'
  | 'sync.conflict_dismissed'
  | 'sync.reconciliation_recorded';

export interface AuditActor {
  /** The authenticated user id. Null only for system-initiated events. */
  userId?: string | null;
  role?: string | null;
}

export interface AuditEventInput {
  type: AuditEventType;
  actor?: AuditActor | null;
  /** What the event is about, e.g. { type: 'sale', id: '<ulid>' }. */
  entity?: { type: string; id: string | number } | null;
  /** One short human-readable line, for an operator reading a log. */
  summary?: string;
  /** Structured detail. Identifiers and changed values only — never payloads or secrets. */
  metadata?: Record<string, unknown> | null;
  /** Defaults to now(). Pass only when back-dating a known event time. */
  occurredAt?: string;
}

/**
 * Resolve WHERE this event happened. Delegates to main/core/context.ts
 * (Milestone 6) — the one place that resolves and caches the
 * organization/location/register/device pointers written by migration v68 —
 * rather than keeping a second, parallel cache of the same four ids.
 */
function resolvePlace() {
  return {
    organizationId: getOrganizationContext()?.id ?? null,
    locationId: getLocationContext()?.id ?? null,
    registerId: getRegisterContext()?.id ?? null,
    deviceId: getDeviceContext()?.id ?? null,
  };
}

/** Drop the cached pointers. For tests, and for any future re-pairing flow. */
export function resetAuditPlaceCache(): void {
  resetContextCache();
}

/**
 * Append an audit event.
 *
 * Returns the new event's id, or null if the write failed (see the
 * never-throws rule above). Callers should not branch on the result — it is
 * returned for tests and for correlating related events.
 */
export function recordAuditEvent(input: AuditEventInput): string | null {
  try {
    const db = getDatabase();
    const place = resolvePlace();
    const id = ulid();
    db.prepare(`
      INSERT INTO audit_events (
        id, occurred_at, event_type, actor_user_id, actor_role,
        entity_type, entity_id,
        organization_id, location_id, register_id, device_id,
        summary, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.occurredAt || now(),
      input.type,
      input.actor?.userId ?? null,
      input.actor?.role ?? null,
      input.entity?.type ?? null,
      input.entity?.id === undefined || input.entity?.id === null ? null : String(input.entity.id),
      place.organizationId,
      place.locationId,
      place.registerId,
      place.deviceId,
      input.summary ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now(),
    );
    // SYNC-D Part K — enqueue the audit event for sync, in this same
    // connection/transaction. Best-effort: appendAuditEventOutbox never throws,
    // so sync can never break auditing.
    appendAuditEventOutbox(db, {
      id,
      occurred_at: input.occurredAt || now(),
      event_type: input.type,
      actor_user_id: input.actor?.userId ?? null,
      actor_role: input.actor?.role ?? null,
      entity_type: input.entity?.type ?? null,
      entity_id: input.entity?.id === undefined || input.entity?.id === null ? null : String(input.entity.id),
      organization_id: place.organizationId,
      location_id: place.locationId,
      register_id: place.registerId,
      device_id: place.deviceId,
      summary: input.summary ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    });
    return id;
  } catch (err) {
    // Never let auditing break the sale. See the rules above.
    console.error('[Audit] failed to record event', input.type, (err as Error).message);
    return null;
  }
}

export interface AuditEventRow {
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
  metadata: Record<string, unknown> | null;
  created_at: string;
}

function parseRow(row: any): AuditEventRow {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata); } catch { metadata = null; }
  }
  return { ...row, metadata };
}

/** Most recent events first. `limit` is clamped so a caller cannot pull the whole table. */
export function listAuditEvents(options: { limit?: number; eventType?: string } = {}): AuditEventRow[] {
  const db = getDatabase();
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 1000);
  const rows = options.eventType
    ? db.prepare('SELECT * FROM audit_events WHERE event_type = ? ORDER BY occurred_at DESC, id DESC LIMIT ?').all(options.eventType, limit)
    : db.prepare('SELECT * FROM audit_events ORDER BY occurred_at DESC, id DESC LIMIT ?').all(limit);
  return (rows as any[]).map(parseRow);
}

/** Every event recorded against one entity, oldest first — the history of a single sale/product. */
export function listAuditEventsForEntity(entityType: string, entityId: string | number, limit = 200): AuditEventRow[] {
  const capped = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const rows = getDatabase().prepare(
    'SELECT * FROM audit_events WHERE entity_type = ? AND entity_id = ? ORDER BY occurred_at ASC, id ASC LIMIT ?',
  ).all(entityType, String(entityId), capped);
  return (rows as any[]).map(parseRow);
}
