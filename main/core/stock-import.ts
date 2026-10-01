/**
 * Plemmo Core — stock import from CSV.
 *
 * Columns: `sku` and/or `barcode` (to find the item; a variant's own barcode/SKU is matched first),
 * `quantity`, optional `reason`. Two modes:
 *   set  the file says what is on the shelf; the adjustment is `quantity − current`. Re-importing the same
 *        file changes nothing (every row is then "unchanged").
 *   add  the file says what arrived; the adjustment is `+quantity`. Exactly-once per (import id, row): a
 *        repeated import with the same id applies nothing a second time.
 * A dry run reports every row (found item, current → new, or the reason it cannot be imported) and posts
 * nothing. An import with ANY invalid row is refused whole: stock is only changed by a file that is entirely
 * valid, so a typo can never leave a half-applied import.
 */
import { getDatabase, withTxn } from '../db';
import { recordAuditEvent } from './audit';
import { InventoryError, adjustStock, getBalance } from './inventory';
import { getCurrentLocationId } from './location';

export interface ImportRow {
  row: number; code: string; product_id: string | null; variant_id: string | null; name: string | null;
  current: number | null; quantity: number | null; delta: number | null; new_quantity: number | null;
  status: 'ok' | 'unchanged' | 'error'; error?: string; reason?: string;
}
export interface ImportReport { mode: 'set' | 'add'; dry_run: boolean; applied: boolean; rows: ImportRow[]; ok: number; unchanged: number; errors: number; adjustments: number }

const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

export function runStockImport(
  records: Record<string, string>[],
  opts: { mode: 'set' | 'add'; dryRun: boolean; importId?: string; reason?: string; actorUserId?: string | null; locationId?: string | null },
): ImportReport {
  const db = getDatabase();
  const loc = opts.locationId || getCurrentLocationId();
  if (!records.length) throw new InventoryError('The file has no data rows.', 400);
  const first = records[0];
  if (!('quantity' in first) || !('sku' in first || 'barcode' in first)) throw new InventoryError('The file needs a "quantity" column and a "sku" or "barcode" column.', 400);
  if (!opts.dryRun && !(opts.importId && /^[A-Za-z0-9._:-]{4,64}$/.test(opts.importId))) throw new InventoryError('An import_id (4–64 letters, digits, . _ : -) is required to apply an import.', 400);

  const seen = new Set<string>();
  const rows: ImportRow[] = records.map((rec, i) => {
    const rowNo = i + 2;
    const code = (rec.barcode || rec.sku || '').trim();
    const base: ImportRow = { row: rowNo, code, product_id: null, variant_id: null, name: null, current: null, quantity: null, delta: null, new_quantity: null, status: 'error', reason: rec.reason || undefined };
    if (!code) return { ...base, error: 'No SKU or barcode on this row.' };
    const qtyText = (rec.quantity ?? '').trim();
    if (!NUMBER.test(qtyText)) return { ...base, error: `"${qtyText}" is not a number.` };
    const qty = Number(qtyText);
    if (opts.mode === 'set' && qty < 0) return { ...base, quantity: qty, error: 'A counted quantity cannot be negative.' };
    if (opts.mode === 'add' && qty === 0) return { ...base, quantity: qty, error: 'Nothing to add.' };
    if (seen.has(code)) return { ...base, quantity: qty, error: 'This item appears more than once in the file.' };
    seen.add(code);
    const byVariant = db.prepare('SELECT v.id AS vid, v.name AS vname, p.id, p.name, p.track_inventory FROM product_variants v JOIN products p ON p.id = v.product_id WHERE (v.barcode = ? OR v.sku = ?) AND v.is_active = 1 AND p.deleted_at IS NULL LIMIT 1').get(code, code) as any;
    const p = byVariant || db.prepare('SELECT id, name, track_inventory FROM products WHERE (barcode = ? OR sku = ?) AND deleted_at IS NULL LIMIT 1').get(code, code) as any;
    if (!p) return { ...base, quantity: qty, error: 'No item has this SKU or barcode.' };
    const name = byVariant ? `${p.name} — ${p.vname || 'Variant'}` : p.name;
    if (!p.track_inventory) return { ...base, quantity: qty, product_id: p.id, name, error: 'Stock tracking is switched off for this item.' };
    const variantId = byVariant ? byVariant.vid : null;
    const current = getBalance(p.id, variantId, loc) ?? 0;
    const target = opts.mode === 'set' ? qty : current + qty;
    const delta = Math.round((target - current) * 1000) / 1000;
    if (target < 0) return { ...base, quantity: qty, product_id: p.id, variant_id: variantId, name, current, error: `This would take stock below zero (now ${current}).` };
    return { ...base, quantity: qty, product_id: p.id, variant_id: variantId, name, current, delta, new_quantity: target, status: delta === 0 ? 'unchanged' : 'ok' };
  });

  const errors = rows.filter((r) => r.status === 'error').length;
  const report: ImportReport = { mode: opts.mode, dry_run: opts.dryRun, applied: false, rows, ok: rows.filter((r) => r.status === 'ok').length, unchanged: rows.filter((r) => r.status === 'unchanged').length, errors, adjustments: 0 };
  if (opts.dryRun || errors > 0) return report;

  withTxn(() => {
    for (const r of rows) {
      if (r.status !== 'ok' || !r.delta) continue;
      adjustStock({
        productId: r.product_id!, variantId: r.variant_id, locationId: loc, quantityDelta: r.delta,
        reason: `Import${r.reason ? `: ${r.reason}` : (opts.reason ? `: ${opts.reason}` : '')}`, movementType: opts.mode === 'add' ? 'receipt' : 'adjustment',
        actorUserId: opts.actorUserId ?? null, idempotencyKey: `import:${opts.importId}:${r.row}`,
      });
      report.adjustments++;
    }
    recordAuditEvent({
      type: 'stock.adjusted', actor: { userId: opts.actorUserId ?? null }, entity: { type: 'stock_import', id: String(opts.importId) },
      summary: `Stock import (${opts.mode}) applied: ${report.adjustments} adjustments, ${report.unchanged} unchanged`,
      metadata: { import_id: opts.importId, mode: opts.mode, adjustments: report.adjustments, unchanged: report.unchanged },
    });
  });
  report.applied = true;
  return report;
}
