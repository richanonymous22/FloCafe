/**
 * Plemmo Core — period reports.
 *
 * Any date range (not only the Z period), answered from the authoritative ledgers in integer minor
 * units and NET OF REFUNDS: a sale that was later returned never inflates a product, category, staff or
 * VAT figure. The headline numbers are the same snapshot the X/Z report uses (so VAT, tenders, discounts
 * and cash always agree between the two screens); this module adds the breakdowns an owner or accountant
 * asks for:
 *
 *   products / categories   units, gross, VAT, net, cost, profit and margin, after returned lines
 *   staff                   sales, discounts given, refunds processed, items removed
 *   discounts / refunds / voids   the individual events, with who did it and why
 *   series                  net sales by hour or day, bucketed in the business's time zone
 *   vat                     per rate (from the snapshot)
 *
 * A bill belongs to the range in which it became fully paid; a refund or return to the range in which it
 * was made — the same rule as the Z report, so the two never disagree about which day a figure belongs to.
 */
import { getDatabase, getSettingValue } from '../db';
import { allocate, GONE_LINE, parseBreakdown } from './vat-buckets';
import { buildTradingSnapshot, ReportError, type TradingSnapshot } from './trading-report';
import { currencyExponent } from './money-integrity';
import { toMinor } from './money';

export interface ProductRow {
  product_id: string; name: string; category_id: string | null; category: string;
  units_sold: number; units_returned: number; gross_minor: number; vat_minor: number; net_minor: number;
  refunded_minor: number; net_after_refunds_minor: number; cost_minor: number; profit_minor: number; margin_percent: number | null;
}
export interface CategoryRow { category_id: string | null; category: string; units: number; gross_minor: number; net_minor: number; net_after_refunds_minor: number; cost_minor: number; profit_minor: number }
export interface StaffRow { user_id: string | null; name: string; sales: number; gross_minor: number; average_minor: number; discounts_minor: number; refunds: number; refunds_minor: number; lines_removed: number }
export interface DiscountRow { at: string; order_number: string | null; amount_minor: number; description: string; staff: string; approved_by: string | null; reason: string | null }
export interface RefundRow { at: string; bill_number: string; amount_minor: number; method: string; reason: string | null; staff: string }
export interface VoidRow { at: string; kind: 'order' | 'line'; reference: string | null; description: string; amount_minor: number | null; staff: string; reason: string | null }
export interface SeriesPoint { bucket: string; sales: number; net_minor: number }

export interface PeriodReport {
  from: string; to: string; tz: string; bucket: 'hour' | 'day';
  snapshot: TradingSnapshot;
  products: ProductRow[]; categories: CategoryRow[]; staff: StaffRow[];
  discounts: DiscountRow[]; refunds: RefundRow[]; voids: VoidRow[]; series: SeriesPoint[];
  checks: { products_equal_bills: boolean; staff_equal_bills: boolean };
}

const DATE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** `from` is EXCLUSIVE and `to` INCLUSIVE, as for the Z report. Both are UTC `YYYY-MM-DD HH:MM:SS`. */
export function assertRange(from: string, to: string): void {
  if (!DATE.test(from) || !DATE.test(to)) throw new ReportError('from and to must be UTC timestamps like 2026-01-31 23:59:59', 400, 'bad_range');
  if (from >= to) throw new ReportError('The end of the range must be after its start.', 400, 'bad_range');
}

function validZone(tz: string): string {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz; } catch { return 'UTC'; }
}

function bucketKey(utc: string, tz: string, bucket: 'hour' | 'day'): string {
  const d = new Date(utc.replace(' ', 'T') + 'Z');
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).reduce<Record<string, string>>((m, x) => { m[x.type] = x.value; return m; }, {});
  return bucket === 'hour' ? `${p.year}-${p.month}-${p.day} ${p.hour}:00` : `${p.year}-${p.month}-${p.day}`;
}

export function buildPeriodReport(locationId: string | null, from: string, to: string, opts: { tz?: string; bucket?: 'hour' | 'day' } = {}): PeriodReport {
  assertRange(from, to);
  const db = getDatabase();
  const currency = (getSettingValue('currency') || 'GBP').toUpperCase();
  const exp = currencyExponent(currency);
  const tz = validZone(opts.tz || getSettingValue('timezone') || 'UTC');
  const bucket = opts.bucket || 'day';
  const loc = locationId;
  const snapshot = buildTradingSnapshot('X', loc, from, from, to);

  const name = new Map<string, string>();
  for (const u of db.prepare('SELECT id, name FROM users').all() as { id: string; name: string }[]) name.set(u.id, u.name);
  const who = (id: string | null | undefined) => (id ? name.get(id) || 'Unknown' : 'System');

  const bills = db.prepare(`
    SELECT b.id, b.order_id, b.total, b.discount_amount, b.paid_at, o.user_id
    FROM bills b JOIN orders o ON o.id = b.order_id
    WHERE b.payment_status = 'paid' AND b.paid_at > @from AND b.paid_at <= @to AND o.location_id IS @loc
    ORDER BY b.paid_at, b.id
  `).all({ from, to, loc }) as any[];

  // ── products and categories: each bill's total shared over its live lines, so a bill discount and any
  // payable rounding are carried through and the lines add up to the bill exactly.
  const prod = new Map<string, ProductRow>();
  const lineKey = new Map<number, string>(); // order_item_id -> product key
  const lineShare = new Map<number, { gross: number; net: number }>();
  const cat = new Map<string, string>();
  for (const c of db.prepare('SELECT id, name FROM categories').all() as { id: string; name: string }[]) cat.set(c.id, c.name);
  const goneSql = GONE_LINE.map(() => '?').join(',');
  let productGross = 0;
  for (const b of bills) {
    const lines = db.prepare(`
      SELECT oi.id, oi.product_id, oi.product_name, oi.quantity, oi.total, oi.tax_amount, oi.tax_breakdown, oi.unit_cost, p.category_id, p.cost AS product_cost
      FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ? AND oi.status NOT IN (${goneSql}) ORDER BY oi.id
    `).all(b.order_id, ...GONE_LINE) as any[];
    if (!lines.length) continue;
    const shares = allocate(toMinor(b.total || 0, exp), lines.map((l) => toMinor(l.total || 0, exp)));
    lines.forEach((l, i) => {
      const lineVat = parseBreakdown(l.tax_breakdown).reduce((s, x) => s + toMinor(x.amount, exp), 0) || toMinor(l.tax_amount || 0, exp);
      const gross = shares[i];
      const vat = Math.min(gross, lineVat);
      const key = String(l.product_id);
      let row = prod.get(key);
      if (!row) {
        row = { product_id: key, name: l.product_name, category_id: l.category_id ?? null, category: l.category_id ? (cat.get(l.category_id) || 'Uncategorised') : 'Uncategorised',
          units_sold: 0, units_returned: 0, gross_minor: 0, vat_minor: 0, net_minor: 0, refunded_minor: 0, net_after_refunds_minor: 0, cost_minor: 0, profit_minor: 0, margin_percent: null };
        prod.set(key, row);
      }
      const unitCost = l.unit_cost != null ? l.unit_cost : (l.product_cost || 0);
      row.units_sold += l.quantity; row.gross_minor += gross; row.vat_minor += vat; row.net_minor += gross - vat;
      row.cost_minor += Math.round(toMinor(unitCost, exp) * l.quantity);
      productGross += gross;
      lineKey.set(l.id, key);
      lineShare.set(l.id, { gross, net: gross - vat });
    });
  }

  const refundRows = db.prepare(`
    SELECT r.id, r.bill_id, r.requested_at, r.amount_minor, r.reason, r.actor_user_id, b.bill_number, p.method
    FROM refunds r JOIN payments p ON p.id = r.payment_id JOIN bills b ON b.id = r.bill_id JOIN orders o ON o.id = b.order_id
    WHERE r.state != 'failed' AND r.requested_at > @from AND r.requested_at <= @to AND o.location_id IS @loc
    ORDER BY r.requested_at, r.id
  `).all({ from, to, loc }) as any[];

  // Returns made in the range, taken off whichever product they were sold as (even if the sale was earlier).
  const returned = db.prepare(`
    SELECT rl.order_item_id, rl.quantity, rl.amount_minor, oi.product_id, oi.product_name, oi.total AS line_total, oi.quantity AS line_qty, oi.tax_breakdown, oi.unit_cost, p.category_id, p.cost AS product_cost
    FROM refund_lines rl JOIN refunds r ON r.id = rl.refund_id JOIN order_items oi ON oi.id = rl.order_item_id
    JOIN bills b ON b.id = rl.bill_id JOIN orders o ON o.id = b.order_id LEFT JOIN products p ON p.id = oi.product_id
    WHERE r.state != 'failed' AND r.requested_at > @from AND r.requested_at <= @to AND o.location_id IS @loc
  `).all({ from, to, loc }) as any[];
  for (const r of returned) {
    const key = String(r.product_id);
    let row = prod.get(key);
    if (!row) {
      row = { product_id: key, name: r.product_name, category_id: r.category_id ?? null, category: r.category_id ? (cat.get(r.category_id) || 'Uncategorised') : 'Uncategorised',
        units_sold: 0, units_returned: 0, gross_minor: 0, vat_minor: 0, net_minor: 0, refunded_minor: 0, net_after_refunds_minor: 0, cost_minor: 0, profit_minor: 0, margin_percent: null };
      prod.set(key, row);
    }
    row.units_returned += r.quantity; row.refunded_minor += r.amount_minor;
    const unitCost = r.unit_cost != null ? r.unit_cost : (r.product_cost || 0);
    // Cost comes back only for stock that went back on the shelf; a returned, written-off item still cost money.
    const restocked = (db.prepare('SELECT restocked FROM refund_lines WHERE order_item_id = ? ORDER BY id DESC LIMIT 1').get(r.order_item_id) as { restocked: number } | undefined)?.restocked;
    if (restocked) row.cost_minor -= Math.round(toMinor(unitCost, exp) * r.quantity);
  }
  // A refund that named no lines (a whole-bill or amount refund) is shared over the bill's lines by value, so the
  // product and category figures are net of EVERY refund and agree with the VAT and tender sections.
  for (const rf of refundRows) {
    const named = (db.prepare('SELECT COALESCE(SUM(amount_minor),0) AS a FROM refund_lines WHERE refund_id = ?').get(rf.id) as { a: number }).a;
    const rest = rf.amount_minor - named;
    if (rest <= 0) continue;
    const bill = db.prepare('SELECT id, order_id, total FROM bills WHERE id = ?').get(rf.bill_id) as { id: number; order_id: number; total: number };
    const lines = db.prepare(`SELECT oi.id, oi.product_id, oi.product_name, oi.quantity, oi.total, p.category_id FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? AND oi.status NOT IN (${goneSql}) ORDER BY oi.id`).all(bill.order_id, ...GONE_LINE) as any[];
    if (!lines.length) continue;
    const whole = rest >= toMinor(bill.total || 0, exp) && named === 0;
    allocate(rest, lines.map((l) => toMinor(l.total || 0, exp))).forEach((part, i) => {
      const l = lines[i];
      let row = prod.get(String(l.product_id));
      if (!row) {
        row = { product_id: String(l.product_id), name: l.product_name, category_id: l.category_id ?? null, category: l.category_id ? (cat.get(l.category_id) || 'Uncategorised') : 'Uncategorised',
          units_sold: 0, units_returned: 0, gross_minor: 0, vat_minor: 0, net_minor: 0, refunded_minor: 0, net_after_refunds_minor: 0, cost_minor: 0, profit_minor: 0, margin_percent: null };
        prod.set(row.product_id, row);
      }
      row.refunded_minor += part;
      if (whole) row.units_returned += lines[i].quantity;
    });
  }
  // The refunded amount is VAT-inclusive; take the same VAT share off the net figure.
  for (const row of prod.values()) {
    const vatRatio = row.gross_minor > 0 ? row.vat_minor / row.gross_minor : 0;
    const refundedNet = Math.round(row.refunded_minor * (1 - vatRatio));
    row.net_after_refunds_minor = row.net_minor - refundedNet;
    row.profit_minor = row.net_after_refunds_minor - row.cost_minor;
    row.margin_percent = row.net_after_refunds_minor > 0 ? Math.round((row.profit_minor / row.net_after_refunds_minor) * 1000) / 10 : null;
  }
  const products = [...prod.values()].sort((a, b) => b.net_after_refunds_minor - a.net_after_refunds_minor || a.name.localeCompare(b.name));

  const catMap = new Map<string, CategoryRow>();
  for (const p of products) {
    const k = p.category_id ?? '';
    let c = catMap.get(k);
    if (!c) { c = { category_id: p.category_id, category: p.category, units: 0, gross_minor: 0, net_minor: 0, net_after_refunds_minor: 0, cost_minor: 0, profit_minor: 0 }; catMap.set(k, c); }
    c.units += p.units_sold - p.units_returned; c.gross_minor += p.gross_minor; c.net_minor += p.net_minor;
    c.net_after_refunds_minor += p.net_after_refunds_minor; c.cost_minor += p.cost_minor; c.profit_minor += p.profit_minor;
  }
  const categories = [...catMap.values()].sort((a, b) => b.net_after_refunds_minor - a.net_after_refunds_minor);

  // ── staff
  const staffMap = new Map<string, StaffRow>();
  const staffOf = (id: string | null): StaffRow => {
    const k = id ?? '';
    if (!staffMap.has(k)) staffMap.set(k, { user_id: id, name: who(id), sales: 0, gross_minor: 0, average_minor: 0, discounts_minor: 0, refunds: 0, refunds_minor: 0, lines_removed: 0 });
    return staffMap.get(k)!;
  };
  let staffGross = 0;
  for (const b of bills) {
    const s = staffOf(b.user_id ?? null);
    const gross = toMinor(b.total || 0, exp);
    s.sales += 1; s.gross_minor += gross; staffGross += gross;
    s.discounts_minor += toMinor(b.discount_amount || 0, exp);
  }
  const refunds: RefundRow[] = refundRows.map((r) => ({ at: r.requested_at, bill_number: r.bill_number, amount_minor: r.amount_minor, method: r.method, reason: r.reason ?? null, staff: who(r.actor_user_id) }));
  for (const r of refundRows) { const s = staffOf(r.actor_user_id ?? null); s.refunds += 1; s.refunds_minor += r.amount_minor; }

  const events = (type: string) => db.prepare(`
    SELECT occurred_at, actor_user_id, summary, metadata FROM audit_events
    WHERE event_type = ? AND occurred_at > ? AND occurred_at <= ? AND (location_id IS ? OR location_id IS NULL) ORDER BY occurred_at, id
  `).all(type, from, to, loc) as any[];
  const meta = (m: string | null): any => { try { return m ? JSON.parse(m) : {}; } catch { return {}; } };

  const discounts: DiscountRow[] = events('sale.discount_applied').map((e) => {
    const m = meta(e.metadata);
    return { at: e.occurred_at, order_number: m.order_id != null ? String(m.order_id) : null, amount_minor: toMinor(Number(m.discount_amount) || 0, exp), description: e.summary || '',
      staff: who(m.requested_by || e.actor_user_id), approved_by: m.approved_by ? who(m.approved_by) : null, reason: m.reason ?? null };
  }).filter((d) => d.amount_minor > 0);

  const voids: VoidRow[] = [];
  for (const o of db.prepare(`SELECT order_number, total, cancelled_at, cancellation_reason, user_id FROM orders WHERE status = 'cancelled' AND cancelled_at > ? AND cancelled_at <= ? AND location_id IS ? ORDER BY cancelled_at`).all(from, to, loc) as any[]) {
    voids.push({ at: o.cancelled_at, kind: 'order', reference: o.order_number ?? null, description: `Order ${o.order_number ?? ''} cancelled`.trim(), amount_minor: toMinor(o.total || 0, exp), staff: who(o.user_id), reason: o.cancellation_reason ?? null });
  }
  for (const e of events('sale.item_voided')) {
    const m = meta(e.metadata);
    voids.push({ at: e.occurred_at, kind: 'line', reference: m.order_id != null ? String(m.order_id) : null, description: e.summary || 'Item removed', amount_minor: null, staff: who(m.requested_by || e.actor_user_id), reason: m.reason ?? null });
    staffOf(m.requested_by || e.actor_user_id || null).lines_removed += 1;
  }
  voids.sort((a, b) => a.at.localeCompare(b.at));

  const staff = [...staffMap.values()].map((s) => ({ ...s, average_minor: s.sales ? Math.round(s.gross_minor / s.sales) : 0 })).sort((a, b) => b.gross_minor - a.gross_minor);

  // ── series, net of refunds made in each bucket
  const ser = new Map<string, SeriesPoint>();
  const point = (k: string) => { if (!ser.has(k)) ser.set(k, { bucket: k, sales: 0, net_minor: 0 }); return ser.get(k)!; };
  for (const b of bills) { const p = point(bucketKey(b.paid_at, tz, bucket)); p.sales += 1; p.net_minor += toMinor(b.total || 0, exp); }
  for (const r of refundRows) point(bucketKey(r.requested_at, tz, bucket)).net_minor -= r.amount_minor;
  const series = [...ser.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));

  return {
    from, to, tz, bucket, snapshot, products, categories, staff, discounts, refunds, voids, series,
    checks: { products_equal_bills: productGross === snapshot.sales.gross_minor, staff_equal_bills: staffGross === snapshot.sales.gross_minor },
  };
}

export type PeriodSection = 'summary' | 'vat' | 'products' | 'categories' | 'staff' | 'discounts' | 'refunds' | 'voids';
export const PERIOD_SECTIONS: readonly PeriodSection[] = ['summary', 'vat', 'products', 'categories', 'staff', 'discounts', 'refunds', 'voids'];

function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return '';
  let v = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** One section of the period report as CSV: amounts in major units and, where useful, minor units. */
export function periodSectionToCsv(r: PeriodReport, section: PeriodSection): string {
  const e = r.snapshot.exponent;
  const m = (minor: number) => (minor / Math.pow(10, e)).toFixed(e);
  let head: string[]; let rows: Array<Array<string | number | null>>;
  switch (section) {
    case 'products':
      head = ['Product', 'Category', 'Units sold', 'Units returned', 'Gross', 'VAT', 'Net', 'Refunded', 'Net after refunds', 'Cost', 'Profit', 'Margin %'];
      rows = r.products.map((p) => [p.name, p.category, p.units_sold, p.units_returned, m(p.gross_minor), m(p.vat_minor), m(p.net_minor), m(p.refunded_minor), m(p.net_after_refunds_minor), m(p.cost_minor), m(p.profit_minor), p.margin_percent]);
      break;
    case 'categories':
      head = ['Category', 'Units', 'Gross', 'Net', 'Net after refunds', 'Cost', 'Profit'];
      rows = r.categories.map((c) => [c.category, c.units, m(c.gross_minor), m(c.net_minor), m(c.net_after_refunds_minor), m(c.cost_minor), m(c.profit_minor)]);
      break;
    case 'staff':
      head = ['Staff', 'Sales', 'Gross', 'Average sale', 'Discounts given', 'Refunds', 'Refunded', 'Items removed'];
      rows = r.staff.map((s) => [s.name, s.sales, m(s.gross_minor), m(s.average_minor), m(s.discounts_minor), s.refunds, m(s.refunds_minor), s.lines_removed]);
      break;
    case 'discounts':
      head = ['Time (UTC)', 'Order', 'Discount', 'Given by', 'Approved by', 'Reason'];
      rows = r.discounts.map((d) => [d.at, d.order_number, m(d.amount_minor), d.staff, d.approved_by, d.reason]);
      break;
    case 'refunds':
      head = ['Time (UTC)', 'Bill', 'Refunded', 'Returned to', 'By', 'Reason'];
      rows = r.refunds.map((x) => [x.at, x.bill_number, m(x.amount_minor), x.method, x.staff, x.reason]);
      break;
    case 'voids':
      head = ['Time (UTC)', 'Type', 'Order', 'What', 'Value', 'By', 'Reason'];
      rows = r.voids.map((v) => [v.at, v.kind === 'order' ? 'Order cancelled' : 'Item removed', v.reference, v.description, v.amount_minor == null ? '' : m(v.amount_minor), v.staff, v.reason]);
      break;
    case 'vat':
      head = ['Rate', 'Rate %', 'Gross', 'Net', 'VAT', 'Credit note gross', 'Credit note VAT', 'VAT due'];
      rows = r.snapshot.vat.map((v) => [v.label, v.rate_percent, m(v.gross_minor), m(v.net_minor), m(v.vat_minor), m(v.refund_gross_minor), m(v.refund_vat_minor), m(v.vat_minor - v.refund_vat_minor)]);
      rows.push(['Total', '', m(r.snapshot.vat.reduce((s, v) => s + v.gross_minor, 0)), m(r.snapshot.vat.reduce((s, v) => s + v.net_minor, 0)), m(r.snapshot.vat_total.vat_minor), m(r.snapshot.vat.reduce((s, v) => s + v.refund_gross_minor, 0)), m(r.snapshot.vat_total.refund_vat_minor), m(r.snapshot.vat_total.net_vat_minor)]);
      break;
    default:
      head = ['Date', 'Sales', 'Net sales (after refunds)'];
      rows = r.series.map((s) => [s.bucket, s.sales, m(s.net_minor)]);
  }
  return [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
