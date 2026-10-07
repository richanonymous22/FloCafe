/**
 * Plemmo Core — stocktakes and stock valuation.
 *
 * A stocktake is a document with a life cycle: START (a line for every tracked product or variant in
 * scope) → COUNT (typed or scanned, any number of times; the last count of a line wins) → REVIEW (variance
 * per line, in units and at cost) → APPROVE, which posts exactly one ledger adjustment per counted line, or
 * CANCEL, which posts nothing. The ledger (inventory_movements) stays the only place stock changes.
 *
 * Counting is allowed while the shop trades. Each line remembers the ledger balance at the moment it was
 * counted (`expected_at_count`); the adjustment is `counted − expected_at_count`, so a sale rung up between
 * counting and approving is kept, not overwritten. Approval is exactly-once per line (idempotency key), and a
 * correction that would take stock below zero is clamped to zero and flagged on the line.
 *
 * Stock is valued at cost, per product/variant, from the ledger balance (not the legacy stock column).
 */
import { getDatabase, now, withTxn } from '../db';
import { recordAuditEvent } from './audit';
import { InventoryError, adjustStock, getBalance } from './inventory';
import { getCurrentLocationId } from './location';
import { ulid } from './ids';
import { toMinor } from './money';
import { currencyExponent } from './money-integrity';
import { getSettingValue } from '../db';

export interface StocktakeLine {
  id: number; product_id: string; product_variant_id: string | null; name: string; sku: string | null; barcode: string | null;
  unit_cost_minor: number; expected: number; expected_at_count: number | null; counted: number | null;
  variance: number | null; variance_value_minor: number | null; applied_delta: number | null; clamped: boolean; counted_at: string | null;
}
export interface StocktakeSummary {
  lines: number; counted: number; uncounted: number; matching: number; over: number; short: number;
  variance_units: number; variance_value_minor: number; over_value_minor: number; short_value_minor: number;
}
export interface StocktakeRecord {
  id: string; number: number; location_id: string | null; name: string; status: 'counting' | 'approved' | 'cancelled';
  category_ids: string[] | null; uncounted: string | null; created_by: string | null; created_at: string;
  approved_by: string | null; approved_at: string | null; cancelled_at: string | null; note: string | null;
  currency: string; exponent: number;
}

function rec(row: any): StocktakeRecord {
  const currency = (getSettingValue('currency') || 'GBP').toUpperCase();
  return {
    id: row.id, number: row.number, location_id: row.location_id ?? null, name: row.name, status: row.status,
    category_ids: row.category_ids ? JSON.parse(row.category_ids) : null, uncounted: row.uncounted ?? null,
    created_by: row.created_by ?? null, created_at: row.created_at, approved_by: row.approved_by ?? null,
    approved_at: row.approved_at ?? null, cancelled_at: row.cancelled_at ?? null, note: row.note ?? null,
    currency, exponent: currencyExponent(currency),
  };
}

function lineOf(row: any, exp: number): StocktakeLine {
  const counted = row.counted as number | null;
  const base = row.expected_at_count ?? row.expected;
  const variance = counted == null ? null : round3(counted - base);
  return {
    id: row.id, product_id: row.product_id, product_variant_id: row.product_variant_id ?? null, name: row.name, sku: row.sku ?? null, barcode: row.barcode ?? null,
    unit_cost_minor: toMinor(row.unit_cost || 0, exp), expected: row.expected, expected_at_count: row.expected_at_count ?? null, counted,
    variance, variance_value_minor: variance == null ? null : Math.round(variance * toMinor(row.unit_cost || 0, exp)),
    applied_delta: row.applied_delta ?? null, clamped: !!row.clamped, counted_at: row.counted_at ?? null,
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function summarise(lines: StocktakeLine[]): StocktakeSummary {
  const s: StocktakeSummary = { lines: lines.length, counted: 0, uncounted: 0, matching: 0, over: 0, short: 0, variance_units: 0, variance_value_minor: 0, over_value_minor: 0, short_value_minor: 0 };
  for (const l of lines) {
    if (l.counted == null) { s.uncounted++; continue; }
    s.counted++;
    const v = l.variance || 0;
    if (v === 0) s.matching++;
    else if (v > 0) { s.over++; s.over_value_minor += l.variance_value_minor || 0; }
    else { s.short++; s.short_value_minor += l.variance_value_minor || 0; }
    s.variance_units = round3(s.variance_units + v);
    s.variance_value_minor += l.variance_value_minor || 0;
  }
  return s;
}

export interface StartInput { locationId?: string | null; name?: string; categoryIds?: string[] | null; actorUserId?: string | null }

export function startStocktake(input: StartInput): StocktakeRecord {
  const db = getDatabase();
  const loc = input.locationId || getCurrentLocationId();
  return withTxn(() => {
    if (db.prepare("SELECT 1 FROM stocktakes WHERE status = 'counting' AND location_id IS ?").get(loc)) {
      throw new InventoryError('A stocktake is already in progress. Approve or cancel it before starting another.', 409);
    }
    const cats = (input.categoryIds || []).filter((c) => typeof c === 'string' && c);
    const params: any[] = [];
    let where = 'p.track_inventory = 1 AND p.deleted_at IS NULL';
    if (cats.length) { where += ` AND p.category_id IN (${cats.map(() => '?').join(',')})`; params.push(...cats); }
    const products = db.prepare(`SELECT p.id, p.name, p.sku, p.barcode, p.cost FROM products p WHERE ${where} ORDER BY p.name, p.id`).all(...params) as any[];
    if (!products.length) throw new InventoryError('There are no stock-tracked items to count' + (cats.length ? ' in those categories.' : '.'), 400);
    const number = ((db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM stocktakes').get() as { n: number }).n) + 1;
    const id = ulid();
    const at = now();
    const name = (input.name || '').trim() || `Stocktake ${number}`;
    db.prepare(`INSERT INTO stocktakes (id, number, location_id, name, status, category_ids, created_by, created_at) VALUES (?, ?, ?, ?, 'counting', ?, ?, ?)`)
      .run(id, number, loc, name, cats.length ? JSON.stringify(cats) : null, input.actorUserId ?? null, at);
    const ins = db.prepare(`INSERT INTO stocktake_lines (stocktake_id, product_id, product_variant_id, name, sku, barcode, unit_cost, expected) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of products) {
      const variants = db.prepare('SELECT id, name, sku, barcode, cost FROM product_variants WHERE product_id = ? AND is_active = 1 ORDER BY sort_order, name').all(p.id) as any[];
      if (variants.length) {
        for (const v of variants) ins.run(id, p.id, v.id, `${p.name} — ${v.name || 'Variant'}`, v.sku ?? p.sku, v.barcode ?? null, v.cost ?? p.cost ?? 0, getBalance(p.id, v.id, loc) ?? 0);
      } else {
        ins.run(id, p.id, null, p.name, p.sku ?? null, p.barcode ?? null, p.cost ?? 0, getBalance(p.id, null, loc) ?? 0);
      }
    }
    recordAuditEvent({
      type: 'stock.counted', actor: { userId: input.actorUserId ?? null }, entity: { type: 'stocktake', id },
      summary: `Stocktake ${number} started (${products.length} items)`, metadata: { number, phase: 'started', categories: cats },
    });
    return rec(db.prepare('SELECT * FROM stocktakes WHERE id = ?').get(id));
  });
}

function mustGet(id: string): any {
  const row = getDatabase().prepare('SELECT * FROM stocktakes WHERE id = ?').get(id);
  if (!row) throw new InventoryError('Stocktake not found', 404);
  return row;
}
function mustBeCounting(row: any): void {
  if (row.status !== 'counting') throw new InventoryError(`This stocktake is ${row.status}; it can no longer be changed.`, 409);
}

export function getStocktake(id: string): { stocktake: StocktakeRecord; lines: StocktakeLine[]; summary: StocktakeSummary } {
  const row = mustGet(id);
  const r = rec(row);
  const lines = (getDatabase().prepare('SELECT * FROM stocktake_lines WHERE stocktake_id = ? ORDER BY name, id').all(id) as any[]).map((l) => lineOf(l, r.exponent));
  return { stocktake: r, lines, summary: summarise(lines) };
}

export function listStocktakes(limit = 50): Array<StocktakeRecord & { summary: StocktakeSummary }> {
  const rows = getDatabase().prepare('SELECT id FROM stocktakes ORDER BY number DESC LIMIT ?').all(Math.min(200, Math.max(1, limit))) as { id: string }[];
  return rows.map((r) => { const g = getStocktake(r.id); return { ...g.stocktake, summary: g.summary }; });
}

export interface CountInput { productId: string; variantId?: string | null; quantity: number; mode?: 'set' | 'add'; actorUserId?: string | null }

/** Record a count for one line: `set` replaces the counted quantity, `add` adds to it (scan-to-count). */
export function recordCount(stocktakeId: string, input: CountInput): StocktakeLine {
  const db = getDatabase();
  if (!Number.isFinite(input.quantity) || input.quantity < 0) throw new InventoryError('The counted quantity must be zero or more.', 400);
  if (input.mode === 'add' && input.quantity === 0) throw new InventoryError('Nothing to add.', 400);
  return withTxn(() => {
    const row = mustGet(stocktakeId);
    mustBeCounting(row);
    const line = db.prepare('SELECT * FROM stocktake_lines WHERE stocktake_id = ? AND product_id = ? AND COALESCE(product_variant_id, \'\') = COALESCE(?, \'\')')
      .get(stocktakeId, input.productId, input.variantId ?? null) as any;
    if (!line) throw new InventoryError('That item is not part of this stocktake.', 404);
    const counted = input.mode === 'add' ? round3((line.counted ?? 0) + input.quantity) : round3(input.quantity);
    const balance = getBalance(input.productId, input.variantId ?? null, row.location_id) ?? 0;
    db.prepare('UPDATE stocktake_lines SET counted = ?, expected_at_count = ?, counted_by = ?, counted_at = ? WHERE id = ?')
      .run(counted, balance, input.actorUserId ?? null, now(), line.id);
    return lineOf(db.prepare('SELECT * FROM stocktake_lines WHERE id = ?').get(line.id), rec(row).exponent);
  });
}

/** Find the line for a scanned barcode or typed SKU. */
export function findLine(stocktakeId: string, code: string): { productId: string; variantId: string | null; name: string } | null {
  const c = (code || '').trim();
  if (!c) return null;
  const row = getDatabase().prepare('SELECT product_id, product_variant_id, name FROM stocktake_lines WHERE stocktake_id = ? AND (barcode = ? OR sku = ?) ORDER BY product_variant_id IS NULL LIMIT 1').get(stocktakeId, c, c) as any;
  return row ? { productId: row.product_id, variantId: row.product_variant_id ?? null, name: row.name } : null;
}

export interface ApproveInput { actorUserId?: string | null; uncounted?: 'ignore' | 'zero'; note?: string }

/** Post the ledger adjustments and close the stocktake. All lines succeed together or none are posted. */
export function approveStocktake(stocktakeId: string, input: ApproveInput): { stocktake: StocktakeRecord; lines: StocktakeLine[]; summary: StocktakeSummary; adjustments: number } {
  const db = getDatabase();
  const policy = input.uncounted === 'zero' ? 'zero' : 'ignore';
  let adjustments = 0;
  withTxn(() => {
    const row = mustGet(stocktakeId);
    mustBeCounting(row);
    const exp = rec(row).exponent;
    const lines = db.prepare('SELECT * FROM stocktake_lines WHERE stocktake_id = ? ORDER BY id').all(stocktakeId) as any[];
    if (!lines.some((l) => l.counted != null) && policy !== 'zero') throw new InventoryError('Nothing has been counted yet.', 409);
    for (const l of lines) {
      const counted: number | null = l.counted != null ? l.counted : (policy === 'zero' ? 0 : null);
      if (counted == null) continue;
      const current = getBalance(l.product_id, l.product_variant_id, row.location_id) ?? 0;
      // A line counted at approval time (uncounted → zero) is measured against the balance right now.
      const base = l.counted != null ? (l.expected_at_count ?? current) : current;
      let delta = round3(counted - base);
      let clamped = 0;
      if (current + delta < 0) { delta = round3(-current); clamped = 1; }
      let movementId: string | null = null;
      if (delta !== 0) {
        const m = adjustStock({
          productId: l.product_id, variantId: l.product_variant_id, locationId: row.location_id, quantityDelta: delta,
          reason: `Stocktake ${row.number}${input.note ? `: ${input.note}` : ''}`, movementType: 'adjustment',
          actorUserId: input.actorUserId ?? null, idempotencyKey: `stocktake:${stocktakeId}:${l.id}`,
        });
        movementId = m.id; adjustments++;
      }
      db.prepare('UPDATE stocktake_lines SET counted = ?, applied_delta = ?, movement_id = ?, clamped = ? WHERE id = ?').run(counted, delta, movementId, clamped, l.id);
    }
    db.prepare("UPDATE stocktakes SET status = 'approved', approved_by = ?, approved_at = ?, uncounted = ?, note = ? WHERE id = ?")
      .run(input.actorUserId ?? null, now(), policy, input.note ?? null, stocktakeId);
    const after = (db.prepare('SELECT * FROM stocktake_lines WHERE stocktake_id = ?').all(stocktakeId) as any[]).map((l) => lineOf(l, exp));
    const sum = summarise(after);
    recordAuditEvent({
      type: 'stock.counted', actor: { userId: input.actorUserId ?? null }, entity: { type: 'stocktake', id: stocktakeId },
      summary: `Stocktake ${row.number} approved: ${adjustments} adjustments, variance ${sum.variance_units} units (${sum.variance_value_minor} minor units at cost)`,
      metadata: { number: row.number, phase: 'approved', adjustments, uncounted_policy: policy, variance_units: sum.variance_units, variance_value_minor: sum.variance_value_minor },
    });
  });
  return { ...getStocktake(stocktakeId), adjustments };
}

export function cancelStocktake(stocktakeId: string, actorUserId?: string | null): StocktakeRecord {
  const db = getDatabase();
  return withTxn(() => {
    const row = mustGet(stocktakeId);
    mustBeCounting(row);
    db.prepare("UPDATE stocktakes SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(now(), stocktakeId);
    recordAuditEvent({
      type: 'stock.counted', actor: { userId: actorUserId ?? null }, entity: { type: 'stocktake', id: stocktakeId },
      summary: `Stocktake ${row.number} cancelled (nothing was adjusted)`, metadata: { number: row.number, phase: 'cancelled' },
    });
    return rec(db.prepare('SELECT * FROM stocktakes WHERE id = ?').get(stocktakeId));
  });
}

/* ── valuation ─────────────────────────────────────────────────────────── */

export interface ValuationRow { product_id: string; variant_id: string | null; name: string; sku: string | null; category: string; quantity: number; unit_cost_minor: number; value_minor: number }
export interface Valuation { currency: string; exponent: number; location_id: string | null; rows: ValuationRow[]; by_category: Array<{ category: string; quantity: number; value_minor: number }>; total_minor: number; total_units: number; uncosted_items: number }

/** Stock on hand at cost: ledger balance × cost, per tracked product/variant, for one location. */
export function stockValuation(locationId?: string | null): Valuation {
  const db = getDatabase();
  const loc = locationId || getCurrentLocationId();
  const currency = (getSettingValue('currency') || 'GBP').toUpperCase();
  const exp = currencyExponent(currency);
  const products = db.prepare(`
    SELECT p.id, p.name, p.sku, p.cost, p.category_id, COALESCE(c.name, 'Uncategorised') AS category
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.track_inventory = 1 AND p.deleted_at IS NULL ORDER BY category, p.name
  `).all() as any[];
  const rows: ValuationRow[] = [];
  for (const p of products) {
    const variants = db.prepare('SELECT id, name, sku, cost FROM product_variants WHERE product_id = ? AND is_active = 1 ORDER BY sort_order, name').all(p.id) as any[];
    const push = (variantId: string | null, name: string, sku: string | null, cost: number) => {
      const quantity = getBalance(p.id, variantId, loc) ?? 0;
      const unit = toMinor(cost || 0, exp);
      rows.push({ product_id: p.id, variant_id: variantId, name, sku, category: p.category, quantity, unit_cost_minor: unit, value_minor: Math.round(quantity * unit) });
    };
    if (variants.length) for (const v of variants) push(v.id, `${p.name} — ${v.name || 'Variant'}`, v.sku ?? p.sku ?? null, v.cost ?? p.cost ?? 0);
    else push(null, p.name, p.sku ?? null, p.cost ?? 0);
  }
  const cat = new Map<string, { category: string; quantity: number; value_minor: number }>();
  for (const r of rows) {
    const c = cat.get(r.category) || { category: r.category, quantity: 0, value_minor: 0 };
    c.quantity = round3(c.quantity + r.quantity); c.value_minor += r.value_minor; cat.set(r.category, c);
  }
  return {
    currency, exponent: exp, location_id: loc, rows,
    by_category: [...cat.values()].sort((a, b) => b.value_minor - a.value_minor),
    total_minor: rows.reduce((s, r) => s + r.value_minor, 0), total_units: round3(rows.reduce((s, r) => s + r.quantity, 0)),
    uncosted_items: rows.filter((r) => r.unit_cost_minor === 0 && r.quantity > 0).length,
  };
}
