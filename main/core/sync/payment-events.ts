/**
 * Plemmo Core — payment-event sync (SYNC-D, Part L).
 *
 * Synchronizes `payment_events` — the authoritative payment state-transition
 * log from the Payment Cutover — NOT `bills.payment_details` / `paid_amount` /
 * `balance` / derived `payment_status`, which stay local
 * projections/compatibility representations. The sync identity is
 * `payment_events.id`; `payment_uid` links the event to its authoritative
 * `payments` row.
 *
 * Org/location/bill/order context is read from the linked `payments` row, so
 * a `payment_events` row (which has no org column) still carries the identity
 * the cloud needs. The cloud re-derives org from the authenticated device
 * regardless, so this is convenience, never authority.
 *
 * Emission is BEST-EFFORT and joins the caller's transaction — it never
 * changes payment business behaviour.
 */

import type Database from 'better-sqlite3';
import { appendOutboxEvent, OutboxRow } from './outbox';
import { PaymentEventPayload } from './types';

type Db = Database.Database;

interface PaymentEventRowLike {
  id: string;
  payment_id: string;
  from_state: string | null;
  to_state: string;
  occurred_at: string;
  actor_user_id: string | null;
  reason: string | null;
  metadata: string | null;
}

interface PaymentContext {
  organization_id: string | null;
  location_id: string | null;
  bill_uid: string | null;
  order_uid: string | null;
}

function readPaymentContext(db: Db, paymentId: string): PaymentContext {
  const row = db.prepare('SELECT organization_id, location_id, bill_uid, order_uid FROM payments WHERE id = ?').get(paymentId) as
    | { organization_id: string | null; location_id: string | null; bill_uid: string | null; order_uid: string | null }
    | undefined;
  return {
    organization_id: row?.organization_id ?? null,
    location_id: row?.location_id ?? null,
    bill_uid: row?.bill_uid ?? null,
    order_uid: row?.order_uid ?? null,
  };
}

export function buildPaymentEventPayload(row: PaymentEventRowLike, ctx: PaymentContext): PaymentEventPayload {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata); } catch { metadata = null; }
  }
  return {
    schema_version: 1,
    payment_event_uid: row.id,
    payment_uid: row.payment_id,
    from_state: row.from_state,
    to_state: row.to_state,
    occurred_at: row.occurred_at,
    order_uid: ctx.order_uid,
    bill_uid: ctx.bill_uid,
    organization_id: ctx.organization_id,
    location_id: ctx.location_id,
    actor_user_id: row.actor_user_id,
    reason: row.reason,
    metadata,
  };
}

/**
 * Enqueues the sync event for a just-written `payment_events` row (identified
 * by id), in the caller's transaction. Never throws.
 */
export function appendPaymentEventOutbox(db: Db, paymentEventId: string): OutboxRow | null {
  try {
    const row = db.prepare('SELECT id, payment_id, from_state, to_state, occurred_at, actor_user_id, reason, metadata FROM payment_events WHERE id = ?')
      .get(paymentEventId) as PaymentEventRowLike | undefined;
    if (!row) return null;
    const ctx = readPaymentContext(db, row.payment_id);
    return appendOutboxEvent({
      db,
      entityType: 'payment_event',
      entityUid: row.id,
      operation: 'append',
      organizationId: ctx.organization_id,
      locationId: ctx.location_id,
      payload: buildPaymentEventPayload(row, ctx),
    });
  } catch (err) {
    console.error('[Sync] failed to enqueue payment event', paymentEventId, (err as Error).message);
    return null;
  }
}
