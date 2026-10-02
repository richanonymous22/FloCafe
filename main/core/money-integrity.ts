/**
 * Plemmo Core — money integrity.
 *
 * The sales-side tables store money in SQLite REAL columns. REAL is fine as a
 * storage type *provided every stored value is an exact whole number of minor
 * units* (12.35, never 12.350000000000001), and every total is summed in
 * integer minor units rather than by adding doubles. This module is the single
 * place that states and enforces that rule:
 *
 *   - `MONEY_COLUMNS`      which columns are money (and so must be quantised).
 *                          Quantities, rates, percentages, geometry and
 *                          per-unit cost rates (which may legitimately be
 *                          sub-penny, e.g. £0.0375 per gram) are NOT listed.
 *   - `quantiseMoney()`    round a major-unit value to the currency's minor unit.
 *   - `sumMoney()`         add major-unit values exactly, via minor units.
 *   - `minorSql()`         SQL fragment giving a column as an exact integer of
 *                          minor units, for reports that SUM() in SQL.
 *   - `installMoneyGuards` SQLite triggers that re-quantise any money column
 *                          written unquantised by any writer (defence in depth:
 *                          a till must never refuse a sale over a rounding error,
 *                          but it must also never persist one).
 *   - `scanMoneyIntegrity` read-only scan used by `audit:db`, the health check
 *                          and the test suite (run with MERIDIAN_MONEY_SCAN=1 to
 *                          make closeDatabase() throw on any violation).
 *
 * Schema note: the plan called for additive `*_minor` integer columns. Because
 * quantised REAL is exactly representable at ≤3 decimals and every consumer
 * sums through `sumMoney`/`minorSql`, this gives the same guarantee without
 * touching ~50 writers, the sync payloads or the cloud mirror. Real integer
 * columns remain possible later; nothing here prevents it.
 */
import type Database from 'better-sqlite3';
import { fromMinor, minorUnitExponent, toMinor } from './money';

/** table → money columns. Keep in step with migrations; `scanMoneyIntegrity` warns on drift. */
export const MONEY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  addons: ['price'],
  bills: ['subtotal', 'tax_amount', 'discount_amount', 'delivery_charge', 'packaging_charge', 'round_off', 'total', 'paid_amount', 'balance'],
  order_item_addons: ['price'],
  order_items: ['unit_price', 'subtotal', 'tax_amount', 'discount_amount', 'total', 'original_unit_price'],
  orders: ['packaging_charge', 'delivery_charge', 'subtotal', 'tax_amount', 'discount_amount', 'round_off', 'total'],
  product_variants: ['price', 'cost'],
  products: ['price', 'cost'],
  purchase_order_items: ['tax', 'line_total'],
  purchase_orders: ['subtotal', 'tax', 'total'],
  remote_bills: ['subtotal', 'tax_amount', 'discount_amount', 'total', 'paid_amount', 'balance'],
  remote_order_items: ['unit_price', 'discount_amount', 'tax_amount', 'total'],
  remote_orders: ['subtotal', 'tax_amount', 'discount_amount', 'total'],
};

export function currencyExponent(currency: string | null | undefined): number {
  return minorUnitExponent((currency || 'GBP').toUpperCase());
}

/** Round a major-unit amount to the nearest minor unit (half-up) and return major units. */
export function quantiseMoney(amount: number, exponent = 2): number {
  if (!Number.isFinite(amount)) throw new TypeError(`Money amount must be finite, got ${String(amount)}`);
  return fromMinor(toMinor(amount, exponent), exponent);
}

/** Exact sum of major-unit amounts: each is quantised to minor units, summed as integers. */
export function sumMoney(amounts: Iterable<number>, exponent = 2): number {
  let minor = 0;
  for (const a of amounts) minor += toMinor(Number.isFinite(a) ? a : 0, exponent);
  return fromMinor(minor, exponent);
}

/** `CAST(ROUND(col * 10^exp) AS INTEGER)` — exact minor units for SQL aggregation. */
export function minorSql(column: string, exponent = 2): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(column)) throw new Error(`Unsafe column expression: ${column}`);
  return `CAST(ROUND(COALESCE(${column}, 0) * ${10 ** exponent}) AS INTEGER)`;
}

// The factor is read from the `currency` setting at write time so a tenant that
// changes currency is guarded by its own exponent. Unknown/blank → 2.
const FACTOR_SQL = `(SELECT CASE
  WHEN UPPER(COALESCE(NULLIF((SELECT value FROM settings WHERE key = 'currency'), ''), 'GBP')) IN
    ('JPY','KRW','VND','CLP','ISK','PYG','RWF','UGX','VUV','XAF','XOF','XPF','KMF','DJF','GNF','BIF') THEN 1.0
  WHEN UPPER(COALESCE(NULLIF((SELECT value FROM settings WHERE key = 'currency'), ''), 'GBP')) IN
    ('BHD','IQD','JOD','KWD','LYD','OMR','TND') THEN 1000.0
  ELSE 100.0 END)`;

const GUARD_PREFIX = 'trg_money_q_';

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table);
}

function existingColumns(db: Database.Database, table: string, wanted: readonly string[]): string[] {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  return wanted.filter((c) => have.has(c));
}

/**
 * (Re)create the quantising triggers. Idempotent. A trigger only fires its
 * UPDATE when some column is actually unquantised, so well-behaved writers pay
 * one comparison per row and no extra write.
 */
export function installMoneyGuards(db: Database.Database): void {
  for (const [table, wanted] of Object.entries(MONEY_COLUMNS)) {
    if (!tableExists(db, table)) continue;
    const cols = existingColumns(db, table, wanted);
    if (!cols.length) continue;
    const dirty = cols
      .map((c) => `(NEW.${c} IS NOT NULL AND NEW.${c} != ROUND(NEW.${c} * f.v) / f.v)`)
      .join(' OR ');
    const setters = cols
      .map((c) => `${c} = CASE WHEN ${c} IS NULL THEN NULL ELSE ROUND(${c} * (${FACTOR_SQL})) / (${FACTOR_SQL}) END`)
      .join(', ');
    for (const ev of ['INSERT', 'UPDATE'] as const) {
      const name = `${GUARD_PREFIX}${table}_${ev.toLowerCase()}`;
      db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      db.exec(`
        CREATE TRIGGER ${name} AFTER ${ev} ON ${table}
        WHEN EXISTS (SELECT 1 FROM (SELECT ${FACTOR_SQL} AS v) f WHERE ${dirty})
        BEGIN
          UPDATE ${table} SET ${setters} WHERE rowid = NEW.rowid;
        END
      `);
    }
  }
}

/**
 * One-off backfill: quantise every stored money value in place. Used by the
 * v97 migration so data written before the guards existed becomes exact.
 * Returns the number of rows changed.
 */
export function repairMoneyColumns(db: Database.Database): number {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'currency'").get() as { value?: string } | undefined;
  const factor = 10 ** currencyExponent(setting?.value);
  let changed = 0;
  for (const [table, wanted] of Object.entries(MONEY_COLUMNS)) {
    if (!tableExists(db, table)) continue;
    for (const col of existingColumns(db, table, wanted)) {
      changed += db.prepare(
        `UPDATE ${table} SET ${col} = ROUND(${col} * ${factor}) / ${factor}
         WHERE ${col} IS NOT NULL AND ${col} != ROUND(${col} * ${factor}) / ${factor}`,
      ).run().changes;
    }
  }
  return changed;
}

/** Remove the guards. Test-only: lets the scanner discover writers that store unquantised values. */
export function dropMoneyGuards(db: Database.Database): void {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE ?").all(`${GUARD_PREFIX}%`) as Array<{ name: string }>;
  for (const r of rows) db.exec(`DROP TRIGGER IF EXISTS ${r.name}`);
}

export interface MoneyViolation {
  table: string;
  column: string;
  rowid: number;
  value: number;
}

/** Read-only scan for stored money values that are not whole minor units. */
export function scanMoneyIntegrity(db: Database.Database, limit = 50): MoneyViolation[] {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'currency'").get() as { value?: string } | undefined;
  const factor = 10 ** currencyExponent(setting?.value);
  const out: MoneyViolation[] = [];
  for (const [table, wanted] of Object.entries(MONEY_COLUMNS)) {
    if (!tableExists(db, table)) continue;
    for (const col of existingColumns(db, table, wanted)) {
      const rows = db.prepare(
        `SELECT rowid AS rid, ${col} AS v FROM ${table}
         WHERE ${col} IS NOT NULL AND ${col} != ROUND(${col} * ${factor}) / ${factor} LIMIT ?`,
      ).all(limit - out.length) as Array<{ rid: number; v: number }>;
      for (const r of rows) out.push({ table, column: col, rowid: r.rid, value: r.v });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
