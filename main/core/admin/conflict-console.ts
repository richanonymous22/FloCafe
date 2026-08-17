/**
 * Plemmo Admin — conflict queue + detail read model (SYNC-G, Part D/E/F/G).
 *
 * The operator-facing view over `sales_conflicts`. The QUEUE is a paginated,
 * filterable, sortable list carrying financial significance and enough summary
 * for triage. The DETAIL composes a UI-ready comparison: the LOCAL side
 * (authoritative order/bill + items + payment + inventory state), the REMOTE
 * side (mirror snapshot), snapshot version HISTORY, AUDIT events, prior
 * ACTIONS, the legal `availableStrategies`, and a `manual_action_required`
 * flag for compensation-only conflicts.
 *
 * Read-only. Resolution goes through the SYNC-F engine unchanged; this module
 * never mutates a sale or invents a strategy.
 */

import type Database from 'better-sqlite3';
import { getDatabase } from '../../db';
import { listConflicts, listActions, getConflict, SalesConflictRow } from '../sync/conflict-store';
import { availableStrategies, resolveEntityLifecycle } from '../sync/conflict-resolution';
import { getOrderReconciliation, getBillReconciliation, getOrderHistory, getBillHistory, reconcilePayments, reconcileInventory } from '../sync/sales-reconciliation';
import { listAuditEventsForEntity } from '../../core/audit';
import { ConflictStatus } from '../sync/conflict-model';

const FINANCIAL_TYPES = new Set(['payment_conflict', 'completion_conflict']);

export interface ConflictQueueFilter {
  organizationId: string;
  status?: ConflictStatus;
  conflictType?: string;
  locationId?: string;
  significance?: 'high' | 'normal';
  sort?: 'newest' | 'oldest';
  limit?: number;
  offset?: number;
}

export interface ConflictQueueRow {
  conflict_uid: string;
  conflict_type: string;
  entity_type: string;
  entity_uid: string;
  location_id: string | null;
  status: string;
  local_device_uid: string | null;
  remote_device_uid: string | null;
  local_snapshot_version: number | null;
  remote_snapshot_version: number | null;
  detected_at: string;
  financial_significance: 'high' | 'normal';
}

export interface ConflictQueuePage {
  items: ConflictQueueRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

function significance(c: SalesConflictRow, db: Database.Database): 'high' | 'normal' {
  if (FINANCIAL_TYPES.has(c.conflict_type)) return 'high';
  return resolveEntityLifecycle(c.entity_type, c.entity_uid, db) === 'completed' ? 'high' : 'normal';
}

export function conflictQueue(filter: ConflictQueueFilter, db: Database.Database = getDatabase()): ConflictQueuePage {
  const limit = Math.min(Math.max(Number(filter.limit ?? 25), 1), 200);
  const offset = Math.max(Number(filter.offset ?? 0), 0);
  // Pull the (already org-scoped) filtered set, annotate, then filter by
  // significance in memory (it depends on the live lifecycle) and page.
  const all = listConflicts({ organizationId: filter.organizationId, status: filter.status, limit: 1000 }, db)
    .filter((c) => (!filter.conflictType || c.conflict_type === filter.conflictType))
    .filter((c) => (!filter.locationId || c.location_id === filter.locationId));
  const annotated: ConflictQueueRow[] = all.map((c) => ({
    conflict_uid: c.conflict_uid, conflict_type: c.conflict_type, entity_type: c.entity_type, entity_uid: c.entity_uid,
    location_id: c.location_id, status: c.status, local_device_uid: c.local_device_uid, remote_device_uid: c.remote_device_uid,
    local_snapshot_version: c.local_snapshot_version, remote_snapshot_version: c.remote_snapshot_version,
    detected_at: c.detected_at, financial_significance: significance(c, db),
  })).filter((r) => (!filter.significance || r.financial_significance === filter.significance));
  annotated.sort((a, b) => (filter.sort === 'oldest' ? a.detected_at.localeCompare(b.detected_at) : b.detected_at.localeCompare(a.detected_at)));
  const total = annotated.length;
  const items = annotated.slice(offset, offset + limit);
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

/** Does this conflict need an out-of-engine (manual) financial action? */
export function manualActionRequired(conflict: SalesConflictRow, strategies: string[]): { required: boolean; reason: string | null } {
  if (FINANCIAL_TYPES.has(conflict.conflict_type)) {
    return { required: true, reason: `A ${conflict.conflict_type} cannot be auto-resolved by overwriting; it needs an explicit compensation decision (refund/void is a manual business action, not automated here).` };
  }
  const nonDismiss = strategies.filter((s) => s !== 'dismiss');
  if (nonDismiss.length === 1 && nonDismiss[0] === 'compensate') {
    return { required: true, reason: 'The only non-dismiss resolution is compensation — record an explicit operator decision.' };
  }
  return { required: false, reason: null };
}

export function conflictDetail(conflictUid: string, db: Database.Database = getDatabase()) {
  const conflict = getConflict(conflictUid, db);
  if (!conflict) return null;
  const strategies = availableStrategies(conflict, db);
  const manual = manualActionRequired(conflict, strategies);

  // LOCAL + REMOTE sides + history depend on the entity type.
  let local: unknown = null;
  let remote: unknown = null;
  let history: unknown = null;
  let payment: unknown = null;
  let inventory: unknown = null;

  if (conflict.entity_type === 'order' || conflict.entity_type === 'order_item') {
    const orderUid = conflict.entity_type === 'order'
      ? conflict.entity_uid
      : (db.prepare('SELECT order_uid FROM remote_order_items WHERE uid = ?').get(conflict.entity_uid) as { order_uid?: string } | undefined)?.order_uid ?? conflict.entity_uid;
    const recon = getOrderReconciliation(orderUid, db);
    local = recon.authoritative;
    remote = recon.remoteSnapshot;
    payment = recon.payment;
    inventory = recon.inventory;
    history = getOrderHistory(orderUid, db);
  } else if (conflict.entity_type === 'bill') {
    const recon = getBillReconciliation(conflict.entity_uid, db);
    local = recon.authoritative;
    remote = recon.remoteSnapshot;
    payment = recon.payment;
    history = getBillHistory(conflict.entity_uid, db);
    // Bill inventory is via its parent order, if local.
    const orderUid = recon.order_uid;
    inventory = orderUid ? reconcileInventory(orderUid, db) : null;
    void reconcilePayments; // payment already computed by the reconciliation view
  }

  return {
    conflict,
    availableStrategies: strategies,
    manual_action_required: manual.required,
    manual_action_reason: manual.reason,
    local,
    remote,
    payment,
    inventory,
    history,
    audit: listAuditEventsForEntity(conflict.entity_type, conflict.entity_uid, 100),
    actions: listActions(conflictUid, db),
  };
}
