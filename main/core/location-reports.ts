/**
 * Basic location-scoped reports (Milestone 6, Part M). Enough to see how
 * sales/inventory/purchases/transfers break down by location — not an
 * analytics system.
 */

import { getDatabase } from '../db';

export function salesByLocation(): { locationId: string | null; locationName: string; orderCount: number; totalValue: number }[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT o.location_id as locationId, COALESCE(l.name, 'Unassigned') as locationName,
      COUNT(o.id) as orderCount, COALESCE(SUM(o.total), 0) as totalValue
    FROM orders o
    LEFT JOIN locations l ON l.id = o.location_id
    WHERE o.status != 'cancelled'
    GROUP BY o.location_id, l.name
    ORDER BY totalValue DESC
  `).all() as any[];
}

export function inventoryByLocation(): { locationId: string | null; locationName: string; skuCount: number; totalQuantity: number }[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT b.location_id as locationId, COALESCE(l.name, 'Unassigned') as locationName,
      COUNT(*) as skuCount, COALESCE(SUM(b.quantity), 0) as totalQuantity
    FROM inventory_balances b
    LEFT JOIN locations l ON l.id = b.location_id
    GROUP BY b.location_id, l.name
    ORDER BY locationName ASC
  `).all() as any[];
}

export function purchasesByLocation(): { locationId: string | null; locationName: string; orderCount: number; totalValue: number }[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT po.location_id as locationId, COALESCE(l.name, 'Unassigned') as locationName,
      COUNT(po.id) as orderCount, COALESCE(SUM(po.total), 0) as totalValue
    FROM purchase_orders po
    LEFT JOIN locations l ON l.id = po.location_id
    WHERE po.status != 'cancelled'
    GROUP BY po.location_id, l.name
    ORDER BY totalValue DESC
  `).all() as any[];
}

export function transfersReport(limit = 50): any[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT t.*, fl.name as from_location_name, tl.name as to_location_name,
      (SELECT COALESCE(SUM(quantity), 0) FROM stock_transfer_items WHERE stock_transfer_id = t.id AND deleted_at IS NULL) as total_quantity
    FROM stock_transfers t
    JOIN locations fl ON fl.id = t.from_location_id
    JOIN locations tl ON tl.id = t.to_location_id
    ORDER BY t.created_at DESC
    LIMIT ?
  `).all(limit) as any[];
}

export function stockAdjustmentsByLocation(limit = 50): any[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT m.id, m.created_at, m.quantity_delta, m.reason, m.product_id, p.name as product_name,
      m.location_id, COALESCE(l.name, 'Unassigned') as location_name
    FROM inventory_movements m
    LEFT JOIN products p ON p.id = m.product_id
    LEFT JOIN locations l ON l.id = m.location_id
    WHERE m.movement_type = 'adjustment'
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(limit) as any[];
}
