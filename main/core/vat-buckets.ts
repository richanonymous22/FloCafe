/**
 * Plemmo Core — VAT buckets.
 *
 * A sale's value split by VAT rate, used by the Z report (what was sold at each rate) and by refunds
 * (what each credit note gives back at each rate). Everything is integer minor units.
 *
 *   billBuckets()    one paid bill: gross is the bill total shared across the order's lines in proportion
 *                    to their value (so an order discount and payable rounding are carried through); VAT per
 *                    rate comes from the bill's own tax breakdown; any rounding gap lands on the largest VAT
 *                    line so the buckets add up to the bill's VAT exactly.
 *   refundBuckets()  one refund operation: for returned lines, each line's own rate and VAT (scaled for the
 *                    quantity and any discount); for an amount refund, the bill's buckets in proportion.
 */
import type Database from 'better-sqlite3';
import { toMinor } from './money';

export const GONE_LINE = ['cancelled', 'voided', 'void_adjustment'];

export interface VatBucket { label: string; rate: number; gross: number; vat: number }

export function parseBreakdown(json: unknown): { title: string; rate: number; amount: number }[] {
  if (typeof json !== 'string' || !json) return [];
  try {
    const parsed = JSON.parse(json);
    const flat = Array.isArray(parsed) ? parsed.flat() : [];
    return flat.filter((b) => b && typeof b === 'object').map((b: any) => ({ title: String(b.title ?? b.label ?? 'VAT'), rate: Number(b.rate) || 0, amount: Number(b.amount ?? b.tax_amount) || 0 }));
  } catch { return []; }
}

/** Largest-remainder split of `total` by `weights` (weights may be 0; the total is distributed exactly). */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!weights.length) return [];
  if (sum <= 0) { const out = weights.map(() => 0); out[0] = total; return out; }
  const raw = weights.map((w) => (total * w) / sum);
  const floor = raw.map((r) => Math.floor(r));
  let left = total - floor.reduce((s, f) => s + f, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f);
  for (let k = 0; left > 0 && k < order.length; k++, left--) floor[order[k].i] += 1;
  return floor;
}

const keyOf = (label: string, rate: number) => `${label}|${rate}`;

export function billBuckets(db: Database.Database, bill: any, exp: number): VatBucket[] {
  const items = db.prepare(`SELECT total, tax_breakdown FROM order_items WHERE order_id = ? AND status NOT IN (${GONE_LINE.map(() => '?').join(',')}) ORDER BY id`).all(bill.order_id, ...GONE_LINE) as any[];
  const vatLines = parseBreakdown(bill.tax_breakdown);
  const buckets = new Map<string, VatBucket>();
  const touch = (label: string, rate: number) => {
    const k = keyOf(label, rate);
    if (!buckets.has(k)) buckets.set(k, { label, rate, gross: 0, vat: 0 });
    return buckets.get(k)!;
  };
  const lineKeys: string[] = [];
  for (const it of items) {
    const top = parseBreakdown(it.tax_breakdown)[0];
    const b = top ? touch(top.title, top.rate) : touch('No VAT', 0);
    lineKeys.push(keyOf(b.label, b.rate));
  }
  const billTotal = toMinor(bill.total || 0, exp);
  const shares = allocate(billTotal, items.map((i) => toMinor(i.total || 0, exp)));
  shares.forEach((s, i) => { buckets.get(lineKeys[i])!.gross += s; });
  if (!items.length) touch('No VAT', 0).gross = billTotal;

  let vatSum = 0;
  for (const v of vatLines) {
    const m = toMinor(v.amount, exp);
    touch(v.title, v.rate).vat += m;
    vatSum += m;
  }
  const gap = toMinor(bill.tax_amount || 0, exp) - vatSum;
  if (gap !== 0) {
    const biggest = [...buckets.values()].sort((a, b) => b.vat - a.vat)[0];
    if (biggest) biggest.vat += gap;
  }
  return [...buckets.values()];
}

export interface RefundLineInput { orderItemId: number; quantity: number; amountMinor: number }

export function refundBuckets(db: Database.Database, bill: any, exp: number, op: { amountMinor: number; lines?: RefundLineInput[] }): VatBucket[] {
  const out = new Map<string, VatBucket>();
  const touch = (label: string, rate: number) => {
    const k = keyOf(label, rate);
    if (!out.has(k)) out.set(k, { label, rate, gross: 0, vat: 0 });
    return out.get(k)!;
  };
  let used = 0;
  const lines = (op.lines || []).filter((l) => l.amountMinor > 0);
  if (lines.length) {
    for (const l of lines) {
      const it = db.prepare('SELECT quantity, total, tax_breakdown FROM order_items WHERE id = ?').get(l.orderItemId) as { quantity: number; total: number; tax_breakdown: string } | undefined;
      if (!it || !(it.quantity > 0)) continue;
      const bd = parseBreakdown(it.tax_breakdown);
      const top = bd[0];
      const itemVat = bd.reduce((s, b) => s + toMinor(b.amount, exp), 0);
      const lineValue = (toMinor(it.total || 0, exp) * l.quantity) / it.quantity;
      const ratio = lineValue > 0 ? l.amountMinor / lineValue : 1;
      const vat = Math.min(l.amountMinor, Math.round((itemVat * l.quantity / it.quantity) * ratio));
      const b = top ? touch(top.title, top.rate) : touch('No VAT', 0);
      b.gross += l.amountMinor; b.vat += vat;
      used += l.amountMinor;
    }
  }
  const rest = op.amountMinor - used;
  if (rest > 0) {
    const buckets = billBuckets(db, bill, exp);
    const billTotal = toMinor(bill.total || 0, exp);
    const billVat = toMinor(bill.tax_amount || 0, exp);
    if (billTotal > 0 && buckets.length) {
      const gross = allocate(rest, buckets.map((k) => k.gross));
      const vat = allocate(Math.round((rest * billVat) / billTotal), buckets.map((k) => k.vat));
      buckets.forEach((k, i) => { const b = touch(k.label, k.rate); b.gross += gross[i]; b.vat += vat[i]; });
    } else {
      touch('No VAT', 0).gross += rest;
    }
  }
  return [...out.values()];
}
