/**
 * Plemmo Core — apply remote inventory movements (SYNC-B, Part K/L).
 *
 * A movement pulled from the cloud is a synchronized FACT that already
 * happened on another device. Applying it locally must:
 *
 *   1. NOT re-run the local sale/adjust logic — it is not a new local
 *      operation, just a fact to record. So it does NOT go through
 *      `recordMovement()`, which would append a new outbox event and send
 *      the same fact back to the cloud — an infinite loop. This is the core
 *      loop-prevention mechanism (Part L): the remote-apply path has no
 *      outbox append at all.
 *   2. Be idempotent by `movement_uid` — re-pulling or re-applying the same
 *      fact must not double-count.
 *   3. Not touch `products.stock_quantity` (a local compatibility mirror,
 *      not a sync primitive).
 *   4. Carry an explicit origin marker (`metadata.sync_origin = 'remote'`)
 *      so a remote-sourced movement is distinguishable from a local one.
 */

import type Database from 'better-sqlite3';
import { now } from '../../db';
import {
  InventoryMovementEventPayload, AuditEventPayload, PaymentEventPayload,
  OrderEventPayload, OrderItemEventPayload, BillEventPayload,
  ReferenceEntityPayload, SyncEntityType, SyncEventPayload, isReferenceEntity,
} from './types';
import { recordPending, resolvePendingForParent } from './pending-relationships';
import { upsertConflict } from './conflict-store';
import { orderLifecycle, billLifecycle } from './conflict-model';

type Db = Database.Database;

export type RemoteApplyResult = 'applied' | 'skipped';

/**
 * SYNC-F Part I — a remote child snapshot (order_item / bill) whose parent
 * order is present neither in the mirror nor in the authoritative table is
 * recorded as a durable pending relationship. The child is still applied into
 * its mirror (no data loss); this only makes the missing link observable and
 * recoverable when the parent later arrives.
 */
function notePendingParentIfMissing(db: Db, childType: string, childUid: string, orderUid: string | null | undefined, orgId: string | null, locId: string | null): void {
  if (!orderUid) return;
  const inMirror = db.prepare('SELECT 1 FROM remote_orders WHERE uid = ?').get(orderUid);
  const inLocal = db.prepare('SELECT 1 FROM orders WHERE uid = ?').get(orderUid);
  if (inMirror || inLocal) return;
  recordPending({ childType, childUid, parentType: 'order', parentUid: orderUid, organizationId: orgId, locationId: locId }, db);
}

/**
 * SYNC-F Part C — a remote snapshot arriving for an entity this device holds
 * as its OWN authoritative record in a COMPLETED lifecycle state is a
 * completion conflict: another device edited a sale this till already
 * finalized. It is recorded (idempotently, source 'local') so an operator can
 * reconcile it. The authoritative record is NEVER touched — the remote value
 * still lands only in the mirror. Deterministic conflict_uid = one local
 * completion conflict per entity.
 */
function detectCompletionConflict(db: Db, entityType: 'order' | 'bill', entityUid: string, completed: boolean, orgId: string | null, locId: string | null, remoteDeviceUid: string | null, remoteVersion: number): void {
  if (!completed) return;
  upsertConflict({
    conflictUid: `cf_local_${entityType}_${entityUid}`,
    organizationId: orgId, locationId: locId, entityType, entityUid,
    conflictType: 'completion_conflict', source: 'local',
    remoteDeviceUid, remoteSnapshotVersion: remoteVersion,
  }, db);
}

/**
 * Dispatches a remote event to the correct per-entity apply function
 * (SYNC-D/E, Part M/Q). Every path is idempotent and NONE appends an outbox
 * event — the shared loop-prevention guarantee across all entity types.
 *
 * The MUTABLE sales entities (order/order_item/bill) are applied ONLY into
 * FK-free MIRROR tables (remote_orders/remote_order_items/remote_bills), never
 * the authoritative orders/order_items/bills. A locally completed sale can
 * therefore never be mutated or undone by sync, and no local checkout,
 * payment, or inventory logic is ever invoked (SYNC-E Part Q). The mirrors keep
 * the highest snapshot_version seen (a local read-model / durable staging);
 * the cloud remains the authority for cross-device conflict.
 */
export function applyRemoteEvent(db: Db, entityType: SyncEntityType, payload: SyncEventPayload): RemoteApplyResult {
  switch (entityType) {
    case 'inventory_movement': return applyRemoteInventoryMovement(db, payload as InventoryMovementEventPayload);
    case 'audit_event': return applyRemoteAuditEvent(db, payload as AuditEventPayload);
    case 'payment_event': return applyRemotePaymentEvent(db, payload as PaymentEventPayload);
    case 'order': return applyRemoteOrder(db, payload as OrderEventPayload);
    case 'order_item': return applyRemoteOrderItem(db, payload as OrderItemEventPayload);
    case 'bill': return applyRemoteBill(db, payload as BillEventPayload);
    default:
      if (isReferenceEntity(entityType)) return applyRemoteReferenceEntity(db, entityType, payload as ReferenceEntityPayload);
      throw new Error(`unknown remote entity type: ${entityType}`);
  }
}

/**
 * Applies a remote reference/operational snapshot into the generic
 * `remote_reference_entities` MIRROR (COMMERCIALIZATION). Idempotent by
 * (entity_type, uid), keeps the highest snapshot_version, never touches the
 * authoritative catalog/customer/supplier tables, and never re-emits (loop
 * prevention). Because identity is a stable ULID, re-applying the same record
 * is a no-op and can never duplicate a local record.
 */
export function applyRemoteReferenceEntity(db: Db, entityType: SyncEntityType, p: ReferenceEntityPayload): RemoteApplyResult {
  const existing = db.prepare('SELECT snapshot_version AS v FROM remote_reference_entities WHERE entity_type = ? AND uid = ?')
    .get(entityType, p.entity_uid) as { v: number } | undefined;
  if (existing && existing.v >= p.snapshot_version) return 'skipped';
  db.prepare(`
    INSERT INTO remote_reference_entities (entity_type, uid, organization_id, location_id, snapshot_version, payload, sync_origin, updated_at, applied_at)
    VALUES (?, ?, ?, ?, ?, ?, 'remote', ?, ?)
    ON CONFLICT(entity_type, uid) DO UPDATE SET organization_id=excluded.organization_id, location_id=excluded.location_id,
      snapshot_version=excluded.snapshot_version, payload=excluded.payload, updated_at=excluded.updated_at, applied_at=excluded.applied_at
  `).run(entityType, p.entity_uid, p.organization_id, p.location_id, p.snapshot_version, JSON.stringify(p), p.updated_at, now());
  // Deliberately NO appendOutboxEvent(...) — loop prevention.
  return 'applied';
}

/** True if a newer-or-equal snapshot of this mirror row is already stored. */
function mirrorIsStale(db: Db, table: string, uid: string, incomingVersion: number): boolean {
  const row = db.prepare(`SELECT snapshot_version AS v FROM ${table} WHERE uid = ?`).get(uid) as { v: number } | undefined;
  return !!row && row.v >= incomingVersion;
}

export function applyRemoteOrder(db: Db, p: OrderEventPayload): RemoteApplyResult {
  // A remote edit landing on this till's OWN completed sale is a completion
  // conflict (flag, never mutate the authoritative order).
  const localAuth = db.prepare('SELECT status FROM orders WHERE uid = ?').get(p.order_uid) as { status: string | null } | undefined;
  if (localAuth) detectCompletionConflict(db, 'order', p.order_uid, orderLifecycle(localAuth.status) === 'completed', p.organization_id, p.location_id, p.device_id ?? null, p.snapshot_version);
  // The parent has now arrived — recover any children that were staged waiting on it.
  resolvePendingForParent(p.order_uid, db);
  if (mirrorIsStale(db, 'remote_orders', p.order_uid, p.snapshot_version)) return 'skipped';
  db.prepare(`
    INSERT INTO remote_orders (uid, order_number, organization_id, location_id, device_id, actor_user_id, channel, status,
      customer_id, table_id, subtotal, tax_amount, discount_amount, total, snapshot_version, order_created_at, order_updated_at, payload, sync_origin, applied_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'remote', ?)
    ON CONFLICT(uid) DO UPDATE SET order_number=excluded.order_number, status=excluded.status, customer_id=excluded.customer_id,
      table_id=excluded.table_id, subtotal=excluded.subtotal, tax_amount=excluded.tax_amount, discount_amount=excluded.discount_amount,
      total=excluded.total, snapshot_version=excluded.snapshot_version, order_updated_at=excluded.order_updated_at, payload=excluded.payload, applied_at=excluded.applied_at
  `).run(p.order_uid, p.order_number, p.organization_id, p.location_id, p.device_id, p.actor_user_id, p.channel, p.status,
    p.customer_id, p.table_id, p.subtotal, p.tax_amount, p.discount_amount, p.total, p.snapshot_version, p.created_at, p.updated_at, JSON.stringify(p), now());
  return 'applied';
}

export function applyRemoteOrderItem(db: Db, p: OrderItemEventPayload): RemoteApplyResult {
  notePendingParentIfMissing(db, 'order_item', p.order_item_uid, p.order_uid, p.organization_id, p.location_id);
  if (mirrorIsStale(db, 'remote_order_items', p.order_item_uid, p.snapshot_version)) return 'skipped';
  db.prepare(`
    INSERT INTO remote_order_items (uid, order_uid, organization_id, location_id, product_id, product_variant_id, product_name,
      product_sku, quantity, unit_price, unit_cost, discount_amount, tax_amount, total, status, snapshot_version, payload, sync_origin, applied_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'remote', ?)
    ON CONFLICT(uid) DO UPDATE SET order_uid=excluded.order_uid, quantity=excluded.quantity, unit_price=excluded.unit_price,
      discount_amount=excluded.discount_amount, tax_amount=excluded.tax_amount, total=excluded.total, status=excluded.status,
      snapshot_version=excluded.snapshot_version, payload=excluded.payload, applied_at=excluded.applied_at
  `).run(p.order_item_uid, p.order_uid, p.organization_id, p.location_id, p.product_id, p.product_variant_id, p.product_name,
    p.product_sku, p.quantity, p.unit_price, p.unit_cost, p.discount_amount, p.tax_amount, p.total, p.status, p.snapshot_version, JSON.stringify(p), now());
  return 'applied';
}

export function applyRemoteBill(db: Db, p: BillEventPayload): RemoteApplyResult {
  notePendingParentIfMissing(db, 'bill', p.bill_uid, p.order_uid, p.organization_id, p.location_id);
  const localBill = db.prepare('SELECT payment_status FROM bills WHERE uid = ?').get(p.bill_uid) as { payment_status: string | null } | undefined;
  if (localBill) detectCompletionConflict(db, 'bill', p.bill_uid, billLifecycle(localBill.payment_status) === 'completed', p.organization_id, p.location_id, null, p.snapshot_version);
  if (mirrorIsStale(db, 'remote_bills', p.bill_uid, p.snapshot_version)) return 'skipped';
  db.prepare(`
    INSERT INTO remote_bills (uid, bill_number, order_uid, organization_id, location_id, customer_id, subtotal, tax_amount,
      discount_amount, total, paid_amount, balance, payment_status, split_group_id, snapshot_version, bill_created_at, bill_updated_at, payload, sync_origin, applied_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'remote', ?)
    ON CONFLICT(uid) DO UPDATE SET bill_number=excluded.bill_number, order_uid=excluded.order_uid, subtotal=excluded.subtotal,
      tax_amount=excluded.tax_amount, discount_amount=excluded.discount_amount, total=excluded.total, paid_amount=excluded.paid_amount,
      balance=excluded.balance, payment_status=excluded.payment_status, split_group_id=excluded.split_group_id,
      snapshot_version=excluded.snapshot_version, bill_updated_at=excluded.bill_updated_at, payload=excluded.payload, applied_at=excluded.applied_at
  `).run(p.bill_uid, p.bill_number, p.order_uid, p.organization_id, p.location_id, p.customer_id, p.subtotal, p.tax_amount,
    p.discount_amount, p.total, p.paid_amount, p.balance, p.payment_status, p.split_group_id, p.snapshot_version, p.created_at, p.updated_at, JSON.stringify(p), now());
  return 'applied';
}

/**
 * Applies a remote AUDIT event into the local `audit_events` table via a RAW
 * insert — never through `recordAuditEvent`, which would re-enqueue it to the
 * outbox (the loop). Idempotent by the audit event's own id; marks it
 * remote-origin in metadata.
 */
export function applyRemoteAuditEvent(db: Db, payload: AuditEventPayload): RemoteApplyResult {
  if (db.prepare('SELECT 1 FROM audit_events WHERE id = ?').get(payload.audit_uid)) return 'skipped';
  const metadata = { ...(payload.metadata ?? {}), sync_origin: 'remote' };
  db.prepare(`
    INSERT INTO audit_events (id, occurred_at, event_type, actor_user_id, actor_role, entity_type, entity_id,
      organization_id, location_id, register_id, device_id, summary, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.audit_uid, payload.occurred_at, payload.event_type, payload.actor_user_id, payload.actor_role,
    payload.entity_type, payload.entity_id, payload.organization_id, payload.location_id, payload.register_id,
    payload.device_id, payload.summary, JSON.stringify(metadata), now(),
  );
  // Deliberately NO appendOutboxEvent(...) — loop prevention.
  return 'applied';
}

/**
 * Applies a remote PAYMENT event into the FK-free `remote_payment_events`
 * mirror (the authoritative `payment_events` FKs to a local `payments` row
 * that does not exist for another device's payment). Idempotent by the
 * payment event's own id; preserves the `payment_uid` linkage.
 */
export function applyRemotePaymentEvent(db: Db, payload: PaymentEventPayload): RemoteApplyResult {
  if (db.prepare('SELECT 1 FROM remote_payment_events WHERE id = ?').get(payload.payment_event_uid)) return 'skipped';
  db.prepare(`
    INSERT INTO remote_payment_events (id, payment_uid, from_state, to_state, occurred_at, order_uid, bill_uid,
      organization_id, location_id, actor_user_id, reason, metadata, sync_origin, applied_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'remote', ?)
  `).run(
    payload.payment_event_uid, payload.payment_uid, payload.from_state, payload.to_state, payload.occurred_at,
    payload.order_uid, payload.bill_uid, payload.organization_id, payload.location_id, payload.actor_user_id,
    payload.reason, payload.metadata ? JSON.stringify(payload.metadata) : null, now(),
  );
  // Deliberately NO appendOutboxEvent(...) — loop prevention.
  return 'applied';
}

export function applyRemoteInventoryMovement(db: Db, payload: InventoryMovementEventPayload): RemoteApplyResult {
  // Idempotency (Part D/K): the movement's own uid IS the business fact
  // identity. If we already hold this fact, applying again is a no-op.
  const exists = db.prepare('SELECT 1 FROM inventory_movements WHERE id = ?').get(payload.movement_uid);
  if (exists) return 'skipped';

  const variantId = payload.product_variant_id || null;
  const locationId = payload.location_id || null;

  // Balance projection: add the delta to the local balance for this
  // (product, variant, location). Seeded at 0 for a remote fact — the local
  // stock_quantity mirror is not the right seed for another device's fact,
  // and full cross-device balance reconciliation is future work (documented).
  const existingBalance = db.prepare(`
    SELECT id, quantity FROM inventory_balances
    WHERE product_id = ? AND COALESCE(product_variant_id, '') = COALESCE(?, '') AND COALESCE(location_id, '') = COALESCE(?, '')
  `).get(payload.product_id, variantId, locationId) as { id: string; quantity: number } | undefined;
  const balanceAfter = (existingBalance ? existingBalance.quantity : 0) + payload.quantity_delta;
  if (existingBalance) {
    db.prepare('UPDATE inventory_balances SET quantity = ?, updated_at = ? WHERE id = ?').run(balanceAfter, now(), existingBalance.id);
  } else {
    db.prepare(`INSERT INTO inventory_balances (id, product_id, product_variant_id, location_id, quantity, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`${payload.movement_uid}-bal`, payload.product_id, variantId, locationId, balanceAfter, now());
  }

  const metadata = { ...(payload.metadata ?? {}), sync_origin: 'remote' };
  db.prepare(`
    INSERT INTO inventory_movements
      (id, organization_id, product_id, product_variant_id, location_id, quantity_delta, movement_type, reason,
       reference_type, reference_id, unit_cost, actor_user_id, balance_after, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.movement_uid, payload.organization_id, payload.product_id, variantId, locationId,
    payload.quantity_delta, payload.movement_type, payload.reason,
    payload.reference_type, payload.reference_id, payload.unit_cost, payload.actor_user_id,
    balanceAfter, JSON.stringify(metadata), payload.created_at,
  );
  // Deliberately NO appendOutboxEvent(...) here — that is the loop prevention.
  return 'applied';
}
