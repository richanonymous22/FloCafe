/**
 * Plemmo Core — sales reconciliation service (SYNC-F, Part G/J/K).
 *
 * Read-only domain APIs that answer, for a given order or bill: what is the
 * authoritative LOCAL record, what REMOTE snapshots exist (mirrors), what
 * versions exist, what conflicts exist, what payments and inventory movements
 * are linked, and what reconciliation actions have been taken. It NEVER
 * mutates anything — reconciliation surfaces discrepancies as data; deciding
 * what to do about them is the resolution engine's job (and even that never
 * rewrites authoritative history).
 *
 * Payment reconciliation (Part J) and inventory reconciliation (Part K) are
 * detection-only: they flag missing / duplicate / out-of-order facts, they do
 * not create or mutate payments or inventory movements (no double-decrement,
 * no fabricated payment).
 */

import type Database from 'better-sqlite3';
import { getDatabase } from '../../db';
import { listConflicts, listActionsForEntity, SalesConflictRow, ReconciliationActionRow } from './conflict-store';
import { getPendingForChild, PendingRelationshipRow } from './pending-relationships';

interface OrderRow { id: number; uid: string; status: string | null; total: number | null; organization_id: string | null; location_id: string | null; created_at: string | null; }

export interface PaymentReconciliation {
  linkedPayments: number;
  authoritativePayments: number;
  remotePaymentEvents: number;
  duplicatePaymentUids: string[];
  paymentsBeforeSale: number;
  discrepancy: boolean;
  notes: string[];
}

export interface InventoryReconciliation {
  trackedItems: number;
  expectedMovements: number;
  actualMovements: number;
  missingMovements: number;
  duplicateReferences: string[];
  discrepancy: boolean;
  notes: string[];
}

export interface OrderReconciliation {
  entity_type: 'order';
  entity_uid: string;
  authoritative: Record<string, unknown> | null;
  remoteSnapshot: Record<string, unknown> | null;
  authoritativeItems: number;
  remoteItems: number;
  linkedBills: string[];
  conflicts: SalesConflictRow[];
  openConflicts: number;
  actions: ReconciliationActionRow[];
  payment: PaymentReconciliation;
  inventory: InventoryReconciliation;
  status: 'clean' | 'conflicts_open' | 'discrepancy';
}

export interface BillReconciliation {
  entity_type: 'bill';
  entity_uid: string;
  authoritative: Record<string, unknown> | null;
  remoteSnapshot: Record<string, unknown> | null;
  order_uid: string | null;
  conflicts: SalesConflictRow[];
  openConflicts: number;
  actions: ReconciliationActionRow[];
  payment: PaymentReconciliation;
  pendingRelationship: PendingRelationshipRow | null;
  status: 'clean' | 'conflicts_open' | 'discrepancy';
}

/** Payment reconciliation for an order/bill (Part J) — detection only. */
export function reconcilePayments(orderUid: string | null, billUid: string | null, saleCreatedAt: string | null, db: Database.Database = getDatabase()): PaymentReconciliation {
  const notes: string[] = [];
  // The authoritative payment's OWN id is its sync identity (payment_uid) —
  // there is no separate payment_uid column on `payments`.
  const authoritative = billUid
    ? db.prepare('SELECT id AS payment_uid, created_at AS occurred_at FROM payments WHERE bill_uid = ?').all(billUid) as Array<{ payment_uid: string; occurred_at?: string }>
    : db.prepare('SELECT id AS payment_uid, created_at AS occurred_at FROM payments WHERE order_uid = ?').all(orderUid) as Array<{ payment_uid: string; occurred_at?: string }>;
  const remote = billUid
    ? db.prepare('SELECT payment_uid, occurred_at FROM remote_payment_events WHERE bill_uid = ?').all(billUid) as Array<{ payment_uid: string; occurred_at: string }>
    : db.prepare('SELECT payment_uid, occurred_at FROM remote_payment_events WHERE order_uid = ?').all(orderUid) as Array<{ payment_uid: string; occurred_at: string }>;

  // Duplicate payment linkage: the same payment_uid appearing more than once
  // across the authoritative + remote payment facts.
  const seen = new Map<string, number>();
  for (const p of authoritative) if (p.payment_uid) seen.set(p.payment_uid, (seen.get(p.payment_uid) ?? 0) + 1);
  for (const r of remote) seen.set(r.payment_uid, (seen.get(r.payment_uid) ?? 0) + 1);
  const duplicatePaymentUids = [...seen.entries()].filter(([, c]) => c > 1).map(([uid]) => uid);
  if (duplicatePaymentUids.length) notes.push(`${duplicatePaymentUids.length} payment_uid(s) linked more than once`);

  // Payments recorded before the sale existed (out-of-order arrival).
  let paymentsBeforeSale = 0;
  if (saleCreatedAt) {
    for (const r of remote) if (r.occurred_at && r.occurred_at < saleCreatedAt) paymentsBeforeSale += 1;
  }
  if (paymentsBeforeSale) notes.push(`${paymentsBeforeSale} payment event(s) predate the sale`);

  const discrepancy = duplicatePaymentUids.length > 0 || paymentsBeforeSale > 0;
  return {
    linkedPayments: authoritative.length + remote.length,
    authoritativePayments: authoritative.length,
    remotePaymentEvents: remote.length,
    duplicatePaymentUids,
    paymentsBeforeSale,
    discrepancy,
    notes,
  };
}

/** Inventory reconciliation for an order (Part K) — detection only, never decrements. */
export function reconcileInventory(orderUid: string, db: Database.Database = getDatabase()): InventoryReconciliation {
  const notes: string[] = [];
  const order = db.prepare('SELECT id FROM orders WHERE uid = ?').get(orderUid) as { id: number } | undefined;
  if (!order) {
    return { trackedItems: 0, expectedMovements: 0, actualMovements: 0, missingMovements: 0, duplicateReferences: [], discrepancy: false, notes: ['order is not local — inventory reconciliation applies to authoritative local sales only'] };
  }
  const items = db.prepare(`
    SELECT oi.id, oi.product_id, COALESCE(p.track_inventory, 0) AS track_inventory
    FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `).all(order.id) as Array<{ id: number; product_id: string; track_inventory: number }>;
  const tracked = items.filter((i) => i.track_inventory);
  const expectedMovements = tracked.length;

  let actualMovements = 0;
  let missingMovements = 0;
  const refCounts = new Map<string, number>();
  for (const it of tracked) {
    const rows = db.prepare("SELECT id FROM inventory_movements WHERE reference_type = 'order_item' AND reference_id = ?").all(String(it.id)) as Array<{ id: string }>;
    actualMovements += rows.length;
    if (rows.length === 0) missingMovements += 1;
    if (rows.length > 1) refCounts.set(String(it.id), rows.length);
  }
  const duplicateReferences = [...refCounts.keys()];
  if (missingMovements) notes.push(`${missingMovements} tracked item(s) have no inventory movement`);
  if (duplicateReferences.length) notes.push(`${duplicateReferences.length} item(s) have duplicate inventory movements`);

  return {
    trackedItems: tracked.length,
    expectedMovements,
    actualMovements,
    missingMovements,
    duplicateReferences,
    discrepancy: missingMovements > 0 || duplicateReferences.length > 0,
    notes,
  };
}

export function getOrderReconciliation(orderUid: string, db: Database.Database = getDatabase()): OrderReconciliation {
  const auth = db.prepare('SELECT * FROM orders WHERE uid = ?').get(orderUid) as OrderRow | undefined;
  const mirror = db.prepare('SELECT * FROM remote_orders WHERE uid = ?').get(orderUid) as Record<string, unknown> | undefined;
  const authItems = auth ? (db.prepare('SELECT COUNT(*) AS c FROM order_items WHERE order_id = ?').get(auth.id) as { c: number }).c : 0;
  const remoteItems = (db.prepare('SELECT COUNT(*) AS c FROM remote_order_items WHERE order_uid = ?').get(orderUid) as { c: number }).c;
  const authBills = auth ? (db.prepare('SELECT uid FROM bills WHERE order_id = ?').all(auth.id) as Array<{ uid: string }>).map((b) => b.uid) : [];
  const remoteBills = (db.prepare('SELECT uid FROM remote_bills WHERE order_uid = ?').all(orderUid) as Array<{ uid: string }>).map((b) => b.uid);
  const linkedBills = [...new Set([...authBills, ...remoteBills].filter(Boolean))];

  const conflicts = listConflicts({ entityType: 'order', entityUid: orderUid }, db);
  const openConflicts = conflicts.filter((c) => c.status === 'open' || c.status === 'acknowledged' || c.status === 'resolving').length;
  const actions = listActionsForEntity('order', orderUid, db);
  const payment = reconcilePayments(orderUid, null, auth?.created_at ?? null, db);
  const inventory = reconcileInventory(orderUid, db);

  return {
    entity_type: 'order', entity_uid: orderUid,
    authoritative: auth ? (auth as unknown as Record<string, unknown>) : null,
    remoteSnapshot: mirror ?? null,
    authoritativeItems: authItems, remoteItems,
    linkedBills, conflicts, openConflicts, actions, payment, inventory,
    status: openConflicts > 0 ? 'conflicts_open' : (payment.discrepancy || inventory.discrepancy ? 'discrepancy' : 'clean'),
  };
}

export function getBillReconciliation(billUid: string, db: Database.Database = getDatabase()): BillReconciliation {
  const auth = db.prepare('SELECT b.*, o.uid AS order_uid, o.created_at AS order_created_at FROM bills b LEFT JOIN orders o ON o.id = b.order_id WHERE b.uid = ?').get(billUid) as (Record<string, unknown> & { order_uid?: string; order_created_at?: string }) | undefined;
  const mirror = db.prepare('SELECT * FROM remote_bills WHERE uid = ?').get(billUid) as (Record<string, unknown> & { order_uid?: string }) | undefined;
  const orderUid = (auth?.order_uid ?? mirror?.order_uid ?? null) as string | null;

  const conflicts = listConflicts({ entityType: 'bill', entityUid: billUid }, db);
  const openConflicts = conflicts.filter((c) => c.status === 'open' || c.status === 'acknowledged' || c.status === 'resolving').length;
  const actions = listActionsForEntity('bill', billUid, db);
  const payment = reconcilePayments(orderUid, billUid, (auth?.order_created_at as string | undefined) ?? null, db);
  const pendingRelationship = getPendingForChild('bill', billUid, db);

  return {
    entity_type: 'bill', entity_uid: billUid,
    authoritative: auth ? (auth as Record<string, unknown>) : null,
    remoteSnapshot: mirror ?? null,
    order_uid: orderUid,
    conflicts, openConflicts, actions, payment, pendingRelationship,
    status: openConflicts > 0 ? 'conflicts_open' : (payment.discrepancy ? 'discrepancy' : 'clean'),
  };
}

/** Snapshot history for an order = every snapshot event this device emitted for it + the current mirror version. */
export function getOrderHistory(orderUid: string, db: Database.Database = getDatabase()): { emitted: Array<Record<string, unknown>>; mirrorVersion: number | null } {
  const emitted = (db.prepare("SELECT uid, sequence, operation, payload, created_at FROM sync_outbox WHERE entity_type = 'order' AND entity_uid = ? ORDER BY sequence ASC").all(orderUid) as Array<{ uid: string; sequence: number; operation: string; payload: string; created_at: string }>)
    .map((r) => ({ event_uid: r.uid, sequence: r.sequence, operation: r.operation, created_at: r.created_at, snapshot_version: safeVersion(r.payload) }));
  const mirror = db.prepare('SELECT snapshot_version FROM remote_orders WHERE uid = ?').get(orderUid) as { snapshot_version: number } | undefined;
  return { emitted, mirrorVersion: mirror?.snapshot_version ?? null };
}

export function getBillHistory(billUid: string, db: Database.Database = getDatabase()): { emitted: Array<Record<string, unknown>>; mirrorVersion: number | null } {
  const emitted = (db.prepare("SELECT uid, sequence, operation, payload, created_at FROM sync_outbox WHERE entity_type = 'bill' AND entity_uid = ? ORDER BY sequence ASC").all(billUid) as Array<{ uid: string; sequence: number; operation: string; payload: string; created_at: string }>)
    .map((r) => ({ event_uid: r.uid, sequence: r.sequence, operation: r.operation, created_at: r.created_at, snapshot_version: safeVersion(r.payload) }));
  const mirror = db.prepare('SELECT snapshot_version FROM remote_bills WHERE uid = ?').get(billUid) as { snapshot_version: number } | undefined;
  return { emitted, mirrorVersion: mirror?.snapshot_version ?? null };
}

function safeVersion(payload: string): number | null {
  try { return Number((JSON.parse(payload) as { snapshot_version?: number }).snapshot_version ?? null); } catch { return null; }
}
