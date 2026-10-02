/**
 * Plemmo Core — trading reports (X and Z).
 *
 * A trading PERIOD is (previous Z's end, this report's end]: everything after the last Z up to now (before the
 * first Z, everything from the first recorded activity). Timestamps have one-second resolution, so the end is
 * INCLUSIVE and a Z waits out the current second before it commits: an event can never fall in two periods or
 * in neither. An X report is a read-only look at the open period. A Z report
 * closes it: the figures are computed once, stored as an immutable, sequentially numbered snapshot
 * (database triggers refuse any UPDATE/DELETE of a Z row), and the next period starts exactly where
 * this one ended, so nothing is ever counted twice or dropped.
 *
 * Everything is derived from the authoritative ledgers and is in integer minor units:
 *
 *   sales        bills that became fully paid in the period (bills.paid_at)
 *   tenders      payments on those bills (payments.amount_minor / tip_minor) by method
 *   refunds      refund rows created in the period (credit notes), by the tender they went back to
 *   VAT          per rate: gross / net / VAT, from the bill's own tax breakdown; refunds carry their
 *                proportional VAT so the period shows VAT net of credit notes
 *   voids        orders cancelled in the period, lines removed after sending (audit), price changes
 *   cash         drawer movements in the period + float / counted / variance of sessions
 *
 * Each report also carries `checks`: the cross-totals that must agree (tenders = bills, VAT lines =
 * bill VAT, cash tenders = drawer sales). A Z that fails a check is still stored — it is a true
 * record of what happened — but the failure is visible on the report and in the response.
 */
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { getDatabase, getSettingValue, now, withTxn } from '../db';
import { recordAuditEvent } from './audit';
import { ulid } from './ids';
import { toMinor } from './money';
import { currencyExponent } from './money-integrity';
import { GONE_LINE, billBuckets, refundBuckets, type VatBucket } from './vat-buckets';

export class ReportError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  constructor(message: string, statusCode = 400, code?: string) {
    super(message);
    this.name = 'ReportError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface TenderLine { method: string; payments: number; taken_minor: number; tips_minor: number; refunded_minor: number; net_minor: number; unverified_card_minor?: number }
export interface VatLine { label: string; rate_percent: number; gross_minor: number; net_minor: number; vat_minor: number; refund_gross_minor: number; refund_vat_minor: number }
export interface CashSection {
  opening_float_minor: number; sales_minor: number; refunds_minor: number; tips_minor: number; pay_in_minor: number;
  pay_out_minor: number; drops_minor: number; float_adjust_minor: number; no_sales: number;
  sessions_opened: number; sessions_closed: number; counted_minor: number | null; expected_minor_at_close: number | null; variance_minor: number | null;
}
export interface TradingSnapshot {
  schema: 1;
  kind: 'X' | 'Z';
  location_id: string | null;
  currency: string;
  exponent: number;
  period_start: string;
  period_end: string;
  transactions: { count: number; items_sold: number; average_minor: number };
  sales: { gross_minor: number; refunds_minor: number; net_minor: number };
  tenders: TenderLine[];
  vat: VatLine[];
  vat_total: { vat_minor: number; refund_vat_minor: number; net_vat_minor: number };
  discounts: { count: number; amount_minor: number };
  refunds: { count: number; amount_minor: number };
  voids: { orders: number; orders_value_minor: number; lines_removed: number; price_overrides: number };
  cash: CashSection;
  checks: { tenders_equal_bills: boolean; vat_equals_bills: boolean; gross_by_rate_equals_bills: boolean; cash_tenders_equal_drawer: boolean; open_cash_session: boolean };
}

export interface ZReportRecord {
  id: string;
  number: number;
  location_id: string | null;
  period_start: string;
  period_end: string;
  currency: string;
  generated_by: string | null;
  generated_at: string;
  digest: string;
  snapshot: TradingSnapshot;
}

function locKey(locationId: string | null): string { return locationId ?? ''; }

/**
 * Where the open period begins. `after` is the exclusive lower bound used in queries (the last Z's end, or
 * the empty string before the first Z); `display` is the time shown on the report.
 */
export function currentPeriodStart(db: Database.Database, locationId: string | null, fallback: string): { after: string; display: string } {
  const last = db.prepare('SELECT period_end FROM z_reports WHERE location_key = ? ORDER BY number DESC LIMIT 1').get(locKey(locationId)) as { period_end: string } | undefined;
  if (last) return { after: last.period_end, display: last.period_end };
  const first = db.prepare(`
    SELECT MIN(t) AS t FROM (
      SELECT MIN(b.paid_at) AS t FROM bills b JOIN orders o ON o.id = b.order_id WHERE b.paid_at IS NOT NULL AND o.location_id IS @loc
      UNION ALL SELECT MIN(r.requested_at) FROM refunds r JOIN bills b ON b.id = r.bill_id JOIN orders o ON o.id = b.order_id WHERE o.location_id IS @loc
      UNION ALL SELECT MIN(m.created_at) FROM cash_movements m JOIN cash_sessions s ON s.id = m.session_id WHERE s.location_id IS @loc
      UNION ALL SELECT MIN(s.opened_at) FROM cash_sessions s WHERE s.location_id IS @loc
    )
  `).get({ loc: locationId }) as { t: string | null };
  return { after: '', display: first?.t || fallback };
}

export function buildTradingSnapshot(kind: 'X' | 'Z', locationId: string | null, after: string, display: string, to: string): TradingSnapshot {
  const db = getDatabase();
  const currency = (getSettingValue('currency') || 'GBP').toUpperCase();
  const exp = currencyExponent(currency);
  const loc = locationId;

  const bills = db.prepare(`
    SELECT b.* FROM bills b JOIN orders o ON o.id = b.order_id
    WHERE b.payment_status = 'paid' AND b.paid_at > @after AND b.paid_at <= @to AND o.location_id IS @loc
    ORDER BY b.paid_at, b.id
  `).all({ after, to, loc }) as any[];

  let grossMinor = 0, discountMinor = 0, discountCount = 0, itemsSold = 0, billVatMinor = 0;
  const vat = new Map<string, VatLine>();
  const vatOf = (label: string, rate: number): VatLine => {
    const k = `${label}|${rate}`;
    if (!vat.has(k)) vat.set(k, { label, rate_percent: rate, gross_minor: 0, net_minor: 0, vat_minor: 0, refund_gross_minor: 0, refund_vat_minor: 0 });
    return vat.get(k)!;
  };
  const billBucketCache = new Map<number, VatBucket[]>();
  for (const b of bills) {
    const buckets = billBuckets(db, b, exp);
    billBucketCache.set(b.id, buckets);
    grossMinor += toMinor(b.total || 0, exp);
    billVatMinor += toMinor(b.tax_amount || 0, exp);
    const d = toMinor(b.discount_amount || 0, exp);
    if (d > 0) { discountMinor += d; discountCount += 1; }
    for (const k of buckets) { const line = vatOf(k.label, k.rate); line.gross_minor += k.gross; line.vat_minor += k.vat; }
    itemsSold += (db.prepare(`SELECT COALESCE(SUM(quantity),0) AS q FROM order_items WHERE order_id = ? AND status NOT IN (${GONE_LINE.map(() => '?').join(',')})`).get(b.order_id, ...GONE_LINE) as { q: number }).q;
  }

  // Tenders on those bills.
  const tenderMap = new Map<string, TenderLine>();
  const tenderOf = (m: string): TenderLine => {
    if (!tenderMap.has(m)) tenderMap.set(m, { method: m, payments: 0, taken_minor: 0, tips_minor: 0, refunded_minor: 0, net_minor: 0, unverified_card_minor: 0 });
    return tenderMap.get(m)!;
  };
  let tenderTotal = 0;
  if (bills.length) {
    const ids = bills.map((b) => b.id);
    const pays = db.prepare(`SELECT method, adapter, amount_minor, tip_minor FROM payments WHERE bill_id IN (${ids.map(() => '?').join(',')}) AND state IN ('captured','settled','refunded')`).all(...ids) as any[];
    for (const p of pays) {
      const t = tenderOf(p.method);
      t.payments += 1; t.taken_minor += p.amount_minor; t.tips_minor += p.tip_minor || 0;
      if (p.adapter === 'manual_card') t.unverified_card_minor = (t.unverified_card_minor || 0) + p.amount_minor;
      tenderTotal += p.amount_minor;
    }
  }

  // Refunds (credit notes) created in the period, with their share of VAT.
  const refunds = db.prepare(`
    SELECT r.id, r.amount_minor, r.bill_id, r.metadata, p.method FROM refunds r
    JOIN payments p ON p.id = r.payment_id JOIN bills b ON b.id = r.bill_id JOIN orders o ON o.id = b.order_id
    WHERE r.state != 'failed' AND r.requested_at > @after AND r.requested_at <= @to AND o.location_id IS @loc
    ORDER BY r.requested_at, r.id
  `).all({ after, to, loc }) as any[];
  let refundMinor = 0;
  for (const r of refunds) {
    tenderOf(r.method).refunded_minor += r.amount_minor;
    refundMinor += r.amount_minor;
    // The VAT recorded with the refund when it was made; older refunds fall back to the bill's mix.
    let recorded: { label: string; rate: number; gross_minor: number; vat_minor: number }[] | null = null;
    try { const m = r.metadata ? JSON.parse(r.metadata) : null; if (m && Array.isArray(m.vat)) recorded = m.vat; } catch { /* use the fallback */ }
    if (recorded) {
      for (const k of recorded) { const line = vatOf(k.label, k.rate); line.refund_gross_minor += k.gross_minor; line.refund_vat_minor += k.vat_minor; }
    } else {
      const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(r.bill_id) as any;
      for (const k of refundBuckets(db, bill, exp, { amountMinor: r.amount_minor })) { const line = vatOf(k.label, k.rate); line.refund_gross_minor += k.gross; line.refund_vat_minor += k.vat; }
    }
  }
  for (const t of tenderMap.values()) t.net_minor = t.taken_minor - t.refunded_minor;
  for (const line of vat.values()) line.net_minor = line.gross_minor - line.vat_minor;

  // Voids and overrides.
  const voidedOrders = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS v FROM orders WHERE status = 'cancelled' AND cancelled_at > @after AND cancelled_at <= @to AND location_id IS @loc`).get({ after, to, loc }) as { n: number; v: number };
  const audit = (type: string) => (db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE event_type = ? AND occurred_at > ? AND occurred_at <= ? AND (location_id IS ? OR location_id IS NULL)').get(type, after, to, loc) as { n: number }).n;

  // Cash drawer.
  const mv = db.prepare(`
    SELECT m.type, COUNT(*) AS n, COALESCE(SUM(m.amount_minor),0) AS s FROM cash_movements m JOIN cash_sessions s ON s.id = m.session_id
    WHERE s.location_id IS @loc AND m.created_at > @after AND m.created_at <= @to GROUP BY m.type
  `).all({ after, to, loc }) as { type: string; n: number; s: number }[];
  const sum = (t: string) => mv.find((x) => x.type === t)?.s ?? 0;
  const opened = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(opening_float_minor),0) AS f FROM cash_sessions WHERE location_id IS @loc AND opened_at > @after AND opened_at <= @to`).get({ after, to, loc }) as { n: number; f: number };
  const closed = db.prepare(`SELECT COUNT(*) AS n, SUM(counted_minor) AS c, SUM(expected_minor) AS e, SUM(variance_minor) AS v FROM cash_sessions WHERE location_id IS @loc AND status = 'closed' AND closed_at > @after AND closed_at <= @to`).get({ after, to, loc }) as any;
  const openNow = !!db.prepare(`SELECT 1 FROM cash_sessions WHERE location_id IS @loc AND status = 'open'`).get({ loc });
  const cash: CashSection = {
    opening_float_minor: opened.f, sales_minor: sum('sale'), refunds_minor: -sum('refund'), tips_minor: sum('tip'), pay_in_minor: sum('pay_in'),
    pay_out_minor: -sum('pay_out'), drops_minor: -sum('drop'), float_adjust_minor: sum('float_adjust'), no_sales: mv.find((x) => x.type === 'no_sale')?.n ?? 0,
    sessions_opened: opened.n, sessions_closed: closed.n,
    counted_minor: closed.n ? (closed.c ?? 0) : null, expected_minor_at_close: closed.n ? (closed.e ?? 0) : null, variance_minor: closed.n ? (closed.v ?? 0) : null,
  };

  const tenders = [...tenderMap.values()].sort((a, b) => a.method.localeCompare(b.method));
  const vatLines = [...vat.values()].sort((a, b) => b.rate_percent - a.rate_percent || a.label.localeCompare(b.label));
  const vatMinor = vatLines.reduce((s, l) => s + l.vat_minor, 0);
  const refundVatMinor = vatLines.reduce((s, l) => s + l.refund_vat_minor, 0);
  const cashTaken = tenders.find((t) => t.method === 'cash')?.taken_minor ?? 0;

  return {
    schema: 1, kind, location_id: locationId, currency, exponent: exp, period_start: display, period_end: to,
    transactions: { count: bills.length, items_sold: itemsSold, average_minor: bills.length ? Math.round(grossMinor / bills.length) : 0 },
    sales: { gross_minor: grossMinor, refunds_minor: refundMinor, net_minor: grossMinor - refundMinor },
    tenders, vat: vatLines,
    vat_total: { vat_minor: vatMinor, refund_vat_minor: refundVatMinor, net_vat_minor: vatMinor - refundVatMinor },
    discounts: { count: discountCount, amount_minor: discountMinor },
    refunds: { count: refunds.length, amount_minor: refundMinor },
    voids: { orders: voidedOrders.n, orders_value_minor: toMinor(voidedOrders.v || 0, exp), lines_removed: audit('sale.item_voided'), price_overrides: audit('sale.price_overridden') },
    cash,
    checks: {
      tenders_equal_bills: tenderTotal === grossMinor,
      vat_equals_bills: vatMinor === billVatMinor,
      gross_by_rate_equals_bills: vatLines.reduce((s, l) => s + l.gross_minor, 0) === grossMinor,
      cash_tenders_equal_drawer: cash.sessions_opened + cash.sessions_closed === 0 && cash.sales_minor === 0 ? true : cash.sales_minor === cashTaken,
      open_cash_session: openNow,
    },
  };
}

/** The open period, read-only. */
export function buildXReport(locationId: string | null): TradingSnapshot {
  const db = getDatabase();
  const to = now();
  const start = currentPeriodStart(db, locationId, to);
  return buildTradingSnapshot('X', locationId, start.after, start.display, to);
}

function hasActivity(s: TradingSnapshot): boolean {
  return s.transactions.count > 0 || s.refunds.count > 0 || s.voids.orders > 0 || s.voids.lines_removed > 0
    || s.cash.sessions_opened > 0 || s.cash.sessions_closed > 0 || s.cash.sales_minor !== 0 || s.cash.pay_in_minor !== 0 || s.cash.pay_out_minor !== 0 || s.cash.drops_minor !== 0;
}

function toRecord(row: any): ZReportRecord {
  return {
    id: row.id, number: row.number, location_id: row.location_id ?? null, period_start: row.period_start, period_end: row.period_end,
    currency: row.currency, generated_by: row.generated_by ?? null, generated_at: row.generated_at, digest: row.digest,
    snapshot: JSON.parse(row.snapshot_json) as TradingSnapshot,
  };
}

export interface GenerateZInput { locationId: string | null; actorUserId: string | null; allowEmpty?: boolean }

/**
 * Close the trading period: compute, store and return the Z report. Refused while a cash drawer session
 * is open (the cash figures would be provisional) and when nothing has happened since the last Z (so a
 * double tap cannot create a second, empty Z) unless `allowEmpty`.
 */
export function generateZReport(input: GenerateZInput): ZReportRecord {
  const db = getDatabase();
  return withTxn(() => {
    const loc = input.locationId;
    if (db.prepare(`SELECT 1 FROM cash_sessions WHERE location_id IS ? AND status = 'open'`).get(loc)) {
      throw new ReportError('Close the cash drawer before running the Z report: the cash figures are not final while it is open.', 409, 'cash_session_open');
    }
    const to = now();
    const start = currentPeriodStart(db, loc, to);
    const from = start.display;
    const snapshot = buildTradingSnapshot('Z', loc, start.after, start.display, to);
    if (!input.allowEmpty && !hasActivity(snapshot)) {
      throw new ReportError('Nothing has happened since the last Z report.', 409, 'nothing_to_report');
    }
    const last = db.prepare('SELECT COALESCE(MAX(number), 0) AS n FROM z_reports WHERE location_key = ?').get(locKey(loc)) as { n: number };
    const number = last.n + 1;
    const json = JSON.stringify(snapshot);
    const digest = createHash('sha256').update(json).digest('hex');
    const id = ulid();
    const at = now();
    db.prepare(`
      INSERT INTO z_reports (id, location_key, location_id, number, period_start, period_end, currency, generated_by, generated_at, snapshot_json, digest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, locKey(loc), loc, number, from, to, snapshot.currency, input.actorUserId, at, json, digest);
    recordAuditEvent({
      type: 'report.z_generated',
      actor: { userId: input.actorUserId },
      entity: { type: 'z_report', id },
      summary: `Z report ${number} generated: ${snapshot.transactions.count} sales, gross ${snapshot.sales.gross_minor}, net ${snapshot.sales.net_minor} (minor units)`,
      metadata: { number, period_start: from, period_end: to, gross_minor: snapshot.sales.gross_minor, net_minor: snapshot.sales.net_minor, digest, checks: snapshot.checks },
    });
    // The period end is inclusive and the clock has one-second resolution: wait out this second before the
    // report is committed, so a sale made right after it is stamped later than the period end.
    waitPastSecond(to);
    return toRecord(db.prepare('SELECT * FROM z_reports WHERE id = ?').get(id));
  });
}

function waitPastSecond(stamp: string): void {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 25 && now() <= stamp; i++) Atomics.wait(sleeper, 0, 0, 50);
}

export function listZReports(locationId: string | null, limit = 60): Array<Record<string, unknown>> {
  const rows = getDatabase().prepare('SELECT * FROM z_reports WHERE location_key = ? ORDER BY number DESC LIMIT ?').all(locKey(locationId), Math.min(500, Math.max(1, limit))) as any[];
  return rows.map((r) => {
    const rec = toRecord(r);
    return {
      id: rec.id, number: rec.number, period_start: rec.period_start, period_end: rec.period_end, currency: rec.currency, exponent: rec.snapshot.exponent, generated_at: rec.generated_at,
      generated_by: rec.generated_by, gross_minor: rec.snapshot.sales.gross_minor, net_minor: rec.snapshot.sales.net_minor, transactions: rec.snapshot.transactions.count,
      refunds_minor: rec.snapshot.sales.refunds_minor, ok: Object.entries(rec.snapshot.checks).every(([k, v]) => k === 'open_cash_session' || v === true),
    };
  });
}

export function getZReport(id: string): ZReportRecord | null {
  const row = getDatabase().prepare('SELECT * FROM z_reports WHERE id = ?').get(id);
  return row ? toRecord(row) : null;
}

/** Re-hash a stored Z and compare with its digest (tamper evidence). */
export function verifyZReport(id: string): { ok: boolean; reason?: string } {
  const row = getDatabase().prepare('SELECT snapshot_json, digest FROM z_reports WHERE id = ?').get(id) as { snapshot_json: string; digest: string } | undefined;
  if (!row) return { ok: false, reason: 'not found' };
  return createHash('sha256').update(row.snapshot_json).digest('hex') === row.digest ? { ok: true } : { ok: false, reason: 'digest mismatch' };
}


/** A CSV cell that cannot be read as a spreadsheet formula and is quoted when needed. */
function csvCell(value: string | number): string {
  let v = String(value);
  if (/^[=+\-@\t\r]/.test(v) && typeof value === 'string') v = "'" + v;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * The report as CSV for an accountant: one row per figure with its section, label, the exact amount in
 * major units and in minor units. `number` is the Z number (omit for an X report).
 */
export function tradingReportToCsv(r: TradingSnapshot, number?: number): string {
  const e = r.exponent;
  const major = (m: number) => (m / Math.pow(10, e)).toFixed(e);
  const rows: Array<[string, string, string | number, number | string]> = [];
  const add = (section: string, label: string, minor: number) => rows.push([section, label, major(minor), minor]);
  const cnt = (section: string, label: string, n: number) => rows.push([section, label, n, '']);
  rows.push(['Report', r.kind === 'Z' ? `Z ${String(number ?? 0).padStart(4, '0')}` : 'X', '', '']);
  rows.push(['Report', 'Period start (UTC)', r.period_start, '']);
  rows.push(['Report', 'Period end (UTC)', r.period_end, '']);
  rows.push(['Report', 'Currency', r.currency, '']);
  cnt('Sales', 'Sales', r.transactions.count); cnt('Sales', 'Items sold', r.transactions.items_sold);
  add('Sales', 'Average sale', r.transactions.average_minor); add('Sales', 'Gross sales', r.sales.gross_minor);
  add('Sales', 'Refunds', r.sales.refunds_minor); add('Sales', 'Net sales', r.sales.net_minor);
  add('Discounts', 'Discounts given', r.discounts.amount_minor);
  for (const t of r.tenders) {
    add('Tenders', `${t.method} taken`, t.taken_minor); add('Tenders', `${t.method} refunded`, t.refunded_minor);
    add('Tenders', `${t.method} net`, t.net_minor); add('Tenders', `${t.method} tips`, t.tips_minor);
    if (t.unverified_card_minor) add('Tenders', `${t.method} not confirmed by a card provider`, t.unverified_card_minor);
  }
  for (const v of r.vat) {
    rows.push(['VAT', `${v.label} rate %`, v.rate_percent, '']);
    add('VAT', `${v.label} gross`, v.gross_minor); add('VAT', `${v.label} net`, v.net_minor); add('VAT', `${v.label} VAT`, v.vat_minor);
    add('VAT', `${v.label} credit note gross`, v.refund_gross_minor); add('VAT', `${v.label} credit note VAT`, v.refund_vat_minor);
  }
  add('VAT', 'VAT collected', r.vat_total.vat_minor); add('VAT', 'VAT credit notes', r.vat_total.refund_vat_minor); add('VAT', 'VAT due', r.vat_total.net_vat_minor);
  cnt('Other', 'Voided orders', r.voids.orders); add('Other', 'Voided orders value', r.voids.orders_value_minor);
  cnt('Other', 'Items removed after sending', r.voids.lines_removed); cnt('Other', 'Price changes', r.voids.price_overrides);
  add('Cash', 'Opening float', r.cash.opening_float_minor); add('Cash', 'Cash sales', r.cash.sales_minor); add('Cash', 'Cash refunds', r.cash.refunds_minor);
  add('Cash', 'Paid in', r.cash.pay_in_minor); add('Cash', 'Paid out', r.cash.pay_out_minor); add('Cash', 'Drops', r.cash.drops_minor);
  if (r.cash.counted_minor != null) { add('Cash', 'Expected at close', r.cash.expected_minor_at_close ?? 0); add('Cash', 'Counted', r.cash.counted_minor); add('Cash', 'Difference', r.cash.variance_minor ?? 0); }
  for (const [k, v] of Object.entries(r.checks)) rows.push(['Checks', k, String(v), '']);
  return ['Section,Label,Amount,Minor units', ...rows.map((row) => row.map(csvCell).join(','))].join('\r\n') + '\r\n';
}
