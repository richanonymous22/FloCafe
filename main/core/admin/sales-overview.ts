/**
 * Plemmo Admin — sales overview read model (SYNC-G, Part C).
 *
 * Purpose-built, paginated, filterable operator view over local sales. It does
 * NOT dump raw rows: each row is a compact sale summary (identity, channel,
 * status, totals, bill payment state, conflict presence). Detail + history
 * compose the SYNC-F reconciliation service. Deterministic offset pagination
 * ordered by (created_at DESC, id DESC). Always organization-scoped — a caller
 * only ever sees its own organization's sales.
 */

import type Database from 'better-sqlite3';
import { getDatabase } from '../../db';
import {
  getOrderReconciliation, getBillReconciliation, getOrderHistory, getBillHistory,
} from '../sync/sales-reconciliation';

export interface SalesFilter {
  organizationId: string;
  q?: string;
  from?: string;
  to?: string;
  locationId?: string;
  status?: string;
  paymentStatus?: string;
  conflictStatus?: 'any' | 'with_conflicts';
  limit?: number;
  offset?: number;
}

export interface SaleSummary {
  order_uid: string;
  order_number: string | null;
  channel: string | null;
  status: string | null;
  location_id: string | null;
  total: number | null;
  created_at: string | null;
  bill_uids: string[];
  payment_status: string | null;
  open_conflicts: number;
}

export interface SalesPage {
  items: SaleSummary[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

function clampLimit(n: number | undefined): number { return Math.min(Math.max(Number(n ?? 25), 1), 200); }

export function listSales(filter: SalesFilter, db: Database.Database = getDatabase()): SalesPage {
  const limit = clampLimit(filter.limit);
  const offset = Math.max(Number(filter.offset ?? 0), 0);
  const where: string[] = ['o.organization_id = ?'];
  const params: unknown[] = [filter.organizationId];
  if (filter.locationId) { where.push('o.location_id = ?'); params.push(filter.locationId); }
  if (filter.status) { where.push('o.status = ?'); params.push(filter.status); }
  if (filter.from) { where.push('o.created_at >= ?'); params.push(filter.from); }
  if (filter.to) { where.push('o.created_at <= ?'); params.push(filter.to); }
  if (filter.q) {
    where.push('(o.order_number LIKE ? OR o.uid = ? OR EXISTS (SELECT 1 FROM bills b2 WHERE b2.order_id = o.id AND (b2.bill_number LIKE ? OR b2.uid = ?)))');
    params.push(`%${filter.q}%`, filter.q, `%${filter.q}%`, filter.q);
  }
  if (filter.paymentStatus) {
    where.push('EXISTS (SELECT 1 FROM bills b3 WHERE b3.order_id = o.id AND b3.payment_status = ?)');
    params.push(filter.paymentStatus);
  }
  if (filter.conflictStatus === 'with_conflicts') {
    where.push("EXISTS (SELECT 1 FROM sales_conflicts sc WHERE sc.entity_uid = o.uid AND sc.status IN ('open','acknowledged','resolving'))");
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM orders o ${whereSql}`).get(...params) as { c: number }).c;

  const rows = db.prepare(`
    SELECT o.id, o.uid AS order_uid, o.order_number, o.type AS channel, o.status, o.location_id, o.total, o.created_at
    FROM orders o ${whereSql}
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Array<{ id: number; order_uid: string; order_number: string | null; channel: string | null; status: string | null; location_id: string | null; total: number | null; created_at: string | null }>;

  const items: SaleSummary[] = rows.map((r) => {
    const bills = db.prepare('SELECT uid, payment_status FROM bills WHERE order_id = ? ORDER BY id ASC').all(r.id) as Array<{ uid: string; payment_status: string | null }>;
    const openConflicts = (db.prepare("SELECT COUNT(*) AS c FROM sales_conflicts WHERE entity_uid = ? AND status IN ('open','acknowledged','resolving')").get(r.order_uid) as { c: number }).c;
    return {
      order_uid: r.order_uid, order_number: r.order_number, channel: r.channel, status: r.status,
      location_id: r.location_id, total: r.total, created_at: r.created_at,
      bill_uids: bills.map((b) => b.uid), payment_status: bills.length ? (bills[bills.length - 1].payment_status ?? null) : null,
      open_conflicts: openConflicts,
    };
  });

  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

/** Full order detail = SYNC-F reconciliation view + snapshot history. */
export function orderDetail(orderUid: string, db: Database.Database = getDatabase()) {
  return { reconciliation: getOrderReconciliation(orderUid, db), history: getOrderHistory(orderUid, db) };
}

/** Full bill detail = SYNC-F reconciliation view + snapshot history. */
export function billDetail(billUid: string, db: Database.Database = getDatabase()) {
  return { reconciliation: getBillReconciliation(billUid, db), history: getBillHistory(billUid, db) };
}
