/**
 * Plemmo Core — sales snapshot sync (SYNC-E).
 *
 * Emits mutable-snapshot outbox events for orders / order_items / bills at
 * well-defined LIFECYCLE points (create, item add/void, terminal transition,
 * bill create, bill paid) — NOT on every field write. Each emitter reads the
 * just-written authoritative row and builds a clean business-fact snapshot.
 *
 * Design constraints honoured:
 *   - Runs inside the caller's transaction (atomic with the business write).
 *   - ATOMIC, not best-effort (unlike the audit/payment emitters): a real
 *     outbox write failure PROPAGATES so the whole sale transaction rolls back
 *     — a financial record and its sync fact must never disagree (SYNC-E Part
 *     T). The outbox insert is a local write into a table guaranteed to exist,
 *     so this never breaks a healthy checkout. A benign "not yet keyable" row
 *     (no uid / no parent uid) returns null without throwing.
 *   - order_items and bills have no org/location columns of their own — those
 *     are derived from the parent order, which is authoritative for them.
 *   - Uses the mutable-snapshot outbox path, so a record edited repeatedly
 *     emits a fresh versioned snapshot each time.
 */

import type Database from 'better-sqlite3';
import { appendSnapshotOutboxEvent, OutboxRow } from './outbox';
import { OrderEventPayload, OrderItemEventPayload, BillEventPayload } from './types';

type Db = Database.Database;

interface OrderRow {
  id: number; uid: string | null; order_number: string | null; organization_id: string | null; location_id: string | null;
  device_id: string | null; user_id: string | null; type: string | null; status: string | null; customer_id: string | null;
  table_id: string | null; subtotal: number | null; tax_amount: number | null; discount_amount: number | null; total: number | null;
  created_at: string | null; updated_at: string | null;
}

export function appendOrderSnapshot(db: Db, orderId: number | bigint | string): OutboxRow | null {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow | undefined;
  if (!o || !o.uid) return null; // uid is load-bearing; if absent, skip rather than emit an unkeyable fact
  return appendSnapshotOutboxEvent({
    db, entityType: 'order', entityUid: o.uid, organizationId: o.organization_id, locationId: o.location_id,
    buildPayload: (snapshot_version): OrderEventPayload => ({
      schema_version: 1, order_uid: o.uid as string, order_number: o.order_number, organization_id: o.organization_id,
      location_id: o.location_id, device_id: o.device_id, actor_user_id: o.user_id, channel: o.type,
      status: o.status ?? 'pending', customer_id: o.customer_id, table_id: o.table_id,
      subtotal: o.subtotal ?? 0, tax_amount: o.tax_amount ?? 0, discount_amount: o.discount_amount ?? 0, total: o.total ?? 0,
      snapshot_version, created_at: o.created_at ?? '', updated_at: o.updated_at ?? '',
    }),
  });
}

interface ItemRow {
  id: number; uid: string | null; order_id: number; product_id: string; product_variant_id: string | null; product_name: string | null;
  product_sku: string | null; quantity: number | null; unit_price: number | null; unit_cost: number | null; discount_amount: number | null;
  tax_amount: number | null; total: number | null; status: string | null; created_at: string | null; updated_at: string | null;
}

export function appendOrderItemSnapshot(db: Db, itemId: number | bigint | string): OutboxRow | null {
  const it = db.prepare('SELECT * FROM order_items WHERE id = ?').get(itemId) as ItemRow | undefined;
  if (!it || !it.uid) return null;
  const parent = db.prepare('SELECT uid, organization_id, location_id FROM orders WHERE id = ?').get(it.order_id) as
    | { uid: string | null; organization_id: string | null; location_id: string | null } | undefined;
  if (!parent || !parent.uid) return null; // a child with no keyable parent is not a coherent sync fact
  return appendSnapshotOutboxEvent({
    db, entityType: 'order_item', entityUid: it.uid, organizationId: parent.organization_id, locationId: parent.location_id,
    buildPayload: (snapshot_version): OrderItemEventPayload => ({
      schema_version: 1, order_item_uid: it.uid as string, order_uid: parent.uid as string,
      organization_id: parent.organization_id, location_id: parent.location_id, product_id: it.product_id,
      product_variant_id: it.product_variant_id, product_name: it.product_name, product_sku: it.product_sku,
      quantity: it.quantity ?? 0, unit_price: it.unit_price ?? 0, unit_cost: it.unit_cost ?? null,
      discount_amount: it.discount_amount ?? 0, tax_amount: it.tax_amount ?? 0, total: it.total ?? 0,
      status: it.status ?? 'pending', snapshot_version, created_at: it.created_at ?? '', updated_at: it.updated_at ?? '',
    }),
  });
}

interface BillRow {
  id: number; uid: string | null; bill_number: string | null; order_id: number; customer_id: string | null;
  subtotal: number | null; tax_amount: number | null; discount_amount: number | null; total: number | null;
  paid_amount: number | null; balance: number | null; payment_status: string | null; split_group_id: string | null;
  created_at: string | null; updated_at: string | null;
}

export function appendBillSnapshot(db: Db, billId: number | bigint | string): OutboxRow | null {
  const b = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as BillRow | undefined;
  if (!b || !b.uid) return null;
  const parent = db.prepare('SELECT uid, organization_id, location_id FROM orders WHERE id = ?').get(b.order_id) as
    | { uid: string | null; organization_id: string | null; location_id: string | null } | undefined;
  return appendSnapshotOutboxEvent({
    db, entityType: 'bill', entityUid: b.uid, organizationId: parent?.organization_id ?? null, locationId: parent?.location_id ?? null,
    buildPayload: (snapshot_version): BillEventPayload => ({
      schema_version: 1, bill_uid: b.uid as string, bill_number: b.bill_number, order_uid: parent?.uid ?? null,
      organization_id: parent?.organization_id ?? null, location_id: parent?.location_id ?? null, customer_id: b.customer_id,
      subtotal: b.subtotal ?? 0, tax_amount: b.tax_amount ?? 0, discount_amount: b.discount_amount ?? 0, total: b.total ?? 0,
      paid_amount: b.paid_amount ?? 0, balance: b.balance ?? 0, payment_status: b.payment_status ?? 'unpaid',
      split_group_id: b.split_group_id ?? null, snapshot_version, created_at: b.created_at ?? '', updated_at: b.updated_at ?? '',
    }),
  });
}
