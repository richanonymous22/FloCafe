/**
 * Plemmo Core — sync types (SYNC-A).
 *
 * The typed shapes the local sync foundation deals in. Deliberately
 * Express-independent and free of any cloud/provider concept — a future
 * real HTTP transport implements the same `SyncTransport` interface the
 * mock does, and nothing else in this layer changes.
 *
 * ## Two distinct identities (Part H)
 *
 *   - `entity_uid` — the BUSINESS FACT's identity, e.g. an
 *     `inventory_movements.id` (a ULID). Immutable, assigned when the
 *     business row is written. The local idempotency key: a given business
 *     fact produces at most one outbox event (enforced by a unique index).
 *   - `uid` (on the outbox/inbox row) — the SYNC EVENT's own identity, a
 *     separate ULID. This is what a future cloud will dedupe uploads on.
 *
 * They are kept distinct because they answer different questions ("which
 * business fact is this" vs "which transmission attempt/record is this").
 */

/**
 * The synchronized entity types (SYNC-D — multi-entity). All three are
 * append-only business FACTS, which is why they are safe to synchronize with
 * the same outbox/feed mechanism and no conflict engine: two devices never
 * "edit" the same fact, they only ever append new ones.
 */
export type SyncEntityType = 'inventory_movement' | 'audit_event' | 'payment_event';
export type SyncOperation = 'create' | 'update' | 'append';
export type OutboxStatus = 'pending' | 'uploading' | 'acked' | 'failed';

/**
 * The typed event payload for an inventory movement (Part F). Represents the
 * business FACT — enough for a future cloud to apply it without executing
 * any local SQL. Deliberately excludes: `balance_after` (a DERIVED
 * projection, never an authoritative sync fact), `products.stock_quantity`
 * (a compatibility mirror), local integer row ids (movements are ULID-keyed,
 * so there are none), and any device-local setting.
 */
export interface InventoryMovementEventPayload {
  schema_version: 1;
  movement_uid: string;
  organization_id: string | null;
  location_id: string | null;
  product_id: string;
  product_variant_id: string | null;
  quantity_delta: number;
  movement_type: string;
  reason: string | null;
  reference_type: string | null;
  reference_id: string | null;
  unit_cost: number | null;
  actor_user_id: string | null;
  /** Opaque business metadata already carried on the movement (e.g. a return's sold-line link). Not derived, not device-local. */
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/**
 * The typed payload for an `audit_event` (SYNC-D, Part K). The authoritative
 * sync identity is `audit_events.id` (a ULID). Audit events are immutable and
 * append-only — the lowest-risk second entity to prove the generalized seam.
 */
export interface AuditEventPayload {
  schema_version: 1;
  audit_uid: string;
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
}

/**
 * The typed payload for a `payment_event` (SYNC-D, Part L). The authoritative
 * sync identity is `payment_events.id`; `payment_uid` links it to the
 * authoritative `payments` row (Payment Cutover). Deliberately NOT synced:
 * `bills.payment_details`, `paid_amount`, `balance`, derived `payment_status`
 * — those remain local projections/compatibility representations.
 */
export interface PaymentEventPayload {
  schema_version: 1;
  payment_event_uid: string;
  payment_uid: string;
  from_state: string | null;
  to_state: string;
  occurred_at: string;
  order_uid: string | null;
  bill_uid: string | null;
  organization_id: string | null;
  location_id: string | null;
  actor_user_id: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
}

/** Any synchronized entity payload. */
export type SyncEventPayload = InventoryMovementEventPayload | AuditEventPayload | PaymentEventPayload;

/** The wire shape of one outbox event handed to a transport for upload. */
export interface OutboxEventDTO {
  uid: string;
  device_id: string;
  sequence: number;
  entity_type: SyncEntityType;
  entity_uid: string;
  operation: SyncOperation;
  organization_id: string | null;
  location_id: string | null;
  payload: SyncEventPayload;
  created_at: string;
}

export interface SyncUploadResult {
  /** Outbox event uids the cloud accepted (or replayed as already-seen). */
  acked: string[];
  /** Outbox event uids the cloud permanently rejected, with a reason. */
  rejected?: Array<{ uid: string; reason: string }>;
}

/**
 * The transport seam a future real HTTP client will implement. In SYNC-A
 * only a test/mock implementation exists; no real cloud is built. `upload`
 * may be synchronous or return a promise, so the same interface fits both a
 * mock and a real `fetch`-based client.
 */
export interface SyncTransport {
  upload(events: OutboxEventDTO[]): SyncUploadResult | Promise<SyncUploadResult>;
}

/** One event returned by a pull, in the same payload shape the outbox produced. */
export interface PulledEvent {
  event_uid: string;
  entity_type: SyncEntityType;
  entity_uid: string;
  feed_seq: number;
  payload: SyncEventPayload;
}

export interface PullResult {
  events: PulledEvent[];
  next_cursor: number;
  has_more: boolean;
}

/** The download half of the transport (SYNC-B). Kept separate from upload so a
 *  mock can implement one without the other. */
export interface SyncPullTransport {
  pull(cursor: number, limit?: number): Promise<PullResult>;
}

/** A transient transport error (network/timeout/5xx/auth) — the batch stays retryable. */
export class SyncTransportError extends Error {
  constructor(message: string, public category: 'transient' | 'auth' = 'transient') {
    super(message);
    this.name = 'SyncTransportError';
  }
}
