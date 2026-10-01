/**
 * Inventory HTTP surface (Milestone 4). Thin route handlers only — all
 * business logic lives in main/core/inventory.ts. Vertical-neutral: nothing
 * here is retail- or hospitality-specific, since inventory is a Core
 * capability either vertical can use (Part C).
 */

import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requireRole } from '../middleware/security';
import { requirePermission } from '../middleware/authorize';
import { getBalance, getMovementHistory, adjustStock, listLowStock } from '../core/inventory';
import { getCurrentLocationId } from '../core/location';
import { stockValuation } from '../core/stocktake';
import { runStockImport } from '../core/stock-import';
import { CsvImportError, parseCSV, toObjects } from './menu-csv';

const router = Router();

function statusFor(error: any): number {
  return typeof error?.statusCode === 'number' ? error.statusCode : 500;
}

router.get('/balance', requirePermission('inventory.view'), (req: Request, res: Response) => {
  const productId = String(req.query.product_id || '');
  if (!productId) {
    return res.status(400).json({ error: 'product_id is required' });
  }
  const variantId = req.query.variant_id ? String(req.query.variant_id) : null;
  res.json({ balance: getBalance(productId, variantId) });
});

router.get('/history', requirePermission('inventory.view'), (req: Request, res: Response) => {
  const productId = String(req.query.product_id || '');
  if (!productId) {
    return res.status(400).json({ error: 'product_id is required' });
  }
  const variantId = req.query.variant_id ? String(req.query.variant_id) : null;
  const limit = req.query.limit ? Math.min(500, Math.max(1, Number(req.query.limit))) : 100;
  res.json({ movements: getMovementHistory(productId, variantId, limit) });
});

router.get('/low-stock', requireRole('owner', 'manager'), (_req: Request, res: Response) => {
  res.json({ items: listLowStock() });
});

router.post('/adjust', requirePermission('inventory.adjust', {
  locationId: (req) => (req.body || {}).location_id || getCurrentLocationId(),
}),
  (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const user = (req as any).user;
    const movement = adjustStock({
      productId: body.product_id,
      variantId: body.variant_id ?? null,
      locationId: body.location_id ?? null,
      quantityDelta: body.quantity_delta,
      reason: body.reason,
      movementType: body.movement_type,
      actorUserId: user?.userId,
    });
    res.status(201).json({ movement });
  } catch (error: any) {
    const status = statusFor(error);
    if (status >= 500) console.error('[Inventory] adjust failed:', error);
    res.status(status).json({ error: error?.message || 'Internal server error' });
  }
});

// The stock ledger as a feed: newest first, with item and person names. Filter by product, type or date.
router.get('/movements', requirePermission('inventory.view'), (req: Request, res: Response) => {
  const db = getDatabase();
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const where: string[] = ['(m.location_id IS ? OR m.location_id IS NULL)'];
  const params: any[] = [getCurrentLocationId()];
  if (req.query.product_id) { where.push('m.product_id = ?'); params.push(String(req.query.product_id)); }
  if (req.query.type) { where.push('m.movement_type = ?'); params.push(String(req.query.type)); }
  if (req.query.from) { where.push('m.created_at > ?'); params.push(String(req.query.from)); }
  if (req.query.to) { where.push('m.created_at <= ?'); params.push(String(req.query.to)); }
  const rows = db.prepare(`
    SELECT m.id, m.created_at, m.product_id, m.product_variant_id, m.quantity_delta, m.movement_type, m.reason, m.reference_type, m.balance_after,
           p.name AS product_name, v.name AS variant_name, u.name AS actor_name
    FROM inventory_movements m
    LEFT JOIN products p ON p.id = m.product_id LEFT JOIN product_variants v ON v.id = m.product_variant_id LEFT JOIN users u ON u.id = m.actor_user_id
    WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?
  `).all(...params, limit);
  res.json({ movements: rows });
});

const money = (minor: number, exp: number) => (minor / Math.pow(10, exp)).toFixed(exp);
const cell = (v: string | number): string => { let t = String(v); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

// Stock on hand at cost (ledger balance × cost), by item and by category.
router.get('/valuation', requirePermission('inventory.view'), (_req: Request, res: Response) => {
  res.json({ valuation: stockValuation() });
});
router.get('/valuation/csv', requirePermission('inventory.view'), (_req: Request, res: Response) => {
  const v = stockValuation();
  const lines = [['SKU', 'Item', 'Category', 'Quantity', 'Unit cost', 'Value'], ...v.rows.map((r) => [r.sku || '', r.name, r.category, r.quantity, money(r.unit_cost_minor, v.exponent), money(r.value_minor, v.exponent)]), ['', 'Total', '', v.total_units, '', money(v.total_minor, v.exponent)]];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="stock-valuation.csv"');
  res.send(lines.map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n');
});

// Stock import from CSV: { csv, mode: 'set'|'add', dry_run?, import_id?, reason? }. Any invalid row refuses the whole file.
router.post('/import', requirePermission('inventory.adjust', { locationId: () => getCurrentLocationId() }), (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (typeof b.csv !== 'string' || !b.csv) return res.status(400).json({ error: 'No CSV data provided' });
    const report = runStockImport(toObjects(parseCSV(b.csv)), {
      mode: b.mode === 'add' ? 'add' : 'set', dryRun: b.dry_run !== false, importId: typeof b.import_id === 'string' ? b.import_id : undefined,
      reason: typeof b.reason === 'string' ? b.reason.slice(0, 100) : undefined, actorUserId: (req as any).user?.userId,
    });
    if (!report.dry_run && report.errors > 0) return res.status(422).json({ error: `Nothing was imported: ${report.errors} row${report.errors === 1 ? ' has' : 's have'} a problem.`, report });
    res.json({ report });
  } catch (error: any) {
    const status = error instanceof CsvImportError ? 400 : statusFor(error);
    if (status >= 500) console.error('[Inventory] import failed:', error);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : error.message });
  }
});

export const inventoryRoutes = router;
