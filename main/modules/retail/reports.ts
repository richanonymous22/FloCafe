/**
 * Minimal retail reporting (Milestone 3, Part B9). Enough to prove the
 * retail flow works end to end — not the analytics system. Every query is
 * scoped to `orders.type = 'in_store'` so it never mixes retail and
 * hospitality numbers.
 */

import { getDatabase } from '../../db';

export interface RetailDailySummary {
  date: string;
  transactionCount: number;
  grossSales: number;
  taxCollected: number;
  cash: number;
  manualCard: number;
  topProducts: { productId: string; productName: string; quantity: number; revenue: number }[];
}

export function getRetailDailySummary(date: string): RetailDailySummary {
  const db = getDatabase();
  const start = `${date} 00:00:00`;
  const end = `${date} 23:59:59`;

  const totals = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as gross, COALESCE(SUM(tax_amount), 0) as tax
    FROM orders WHERE type = 'in_store' AND created_at >= ? AND created_at <= ?
  `).get(start, end) as { count: number; gross: number; tax: number };

  const byAdapter = db.prepare(`
    SELECT p.adapter as adapter, COALESCE(SUM(p.amount_minor), 0) as amount_minor
    FROM payments p
    JOIN orders o ON o.id = p.order_id
    WHERE o.type = 'in_store' AND p.created_at >= ? AND p.created_at <= ?
      AND p.state IN ('captured', 'settled')
    GROUP BY p.adapter
  `).all(start, end) as { adapter: string; amount_minor: number }[];

  const cashMinor = byAdapter.find((row) => row.adapter === 'cash')?.amount_minor || 0;
  const cardMinor = byAdapter.find((row) => row.adapter === 'manual_card')?.amount_minor || 0;

  const topProducts = db.prepare(`
    SELECT oi.product_id as productId, oi.product_name as productName,
      SUM(oi.quantity) as quantity, COALESCE(SUM(oi.subtotal), 0) as revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.type = 'in_store' AND o.created_at >= ? AND o.created_at <= ?
    GROUP BY oi.product_id, oi.product_name
    ORDER BY quantity DESC
    LIMIT 10
  `).all(start, end) as { productId: string; productName: string; quantity: number; revenue: number }[];

  return {
    date,
    transactionCount: totals.count,
    grossSales: totals.gross,
    taxCollected: totals.tax,
    cash: cashMinor / 100,
    manualCard: cardMinor / 100,
    topProducts,
  };
}
