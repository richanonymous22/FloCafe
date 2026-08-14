/**
 * Basic purchasing reports (Milestone 5, Part L). Enough to see what's
 * been ordered and received — not an accounting/profit analytics system.
 */

import { getDatabase } from '../../db';

export function purchasesBySupplier(): { supplierId: string; supplierName: string; orderCount: number; totalValue: number }[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT s.id as supplierId, s.name as supplierName, COUNT(po.id) as orderCount, COALESCE(SUM(po.total), 0) as totalValue
    FROM suppliers s
    JOIN purchase_orders po ON po.supplier_id = s.id AND po.status != 'cancelled'
    GROUP BY s.id, s.name
    ORDER BY totalValue DESC
  `).all() as any[];
}

export function outstandingPurchaseOrders(): any[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT po.*, s.name as supplier_name,
      (SELECT COALESCE(SUM(quantity_ordered - quantity_received), 0) FROM purchase_order_items WHERE purchase_order_id = po.id AND deleted_at IS NULL) as remaining_quantity
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.status IN ('ordered', 'partially_received')
    ORDER BY po.expected_date ASC, po.created_at ASC
  `).all() as any[];
}

export function recentGoodsReceived(limit = 50): any[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT m.id, m.created_at, m.quantity_delta, m.unit_cost, m.product_id, m.product_variant_id,
      p.name as product_name, po.id as purchase_order_id, po.reference_number, s.name as supplier_name
    FROM inventory_movements m
    JOIN purchase_order_items poi ON poi.id = m.reference_id AND m.reference_type = 'purchase_order_item'
    JOIN purchase_orders po ON po.id = poi.purchase_order_id
    JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN products p ON p.id = m.product_id
    WHERE m.movement_type = 'receipt'
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(limit) as any[];
}

export function stockReceivedByDate(fromDate: string, toDate: string): { date: string; quantity: number; value: number }[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT substr(created_at, 1, 10) as date, SUM(quantity_delta) as quantity, SUM(quantity_delta * COALESCE(unit_cost, 0)) as value
    FROM inventory_movements
    WHERE movement_type = 'receipt' AND created_at >= ? AND created_at <= ?
    GROUP BY date
    ORDER BY date ASC
  `).all(`${fromDate} 00:00:00`, `${toDate} 23:59:59`) as any[];
}
