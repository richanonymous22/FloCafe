/**
 * Offers — automatic promotions applied by the till server.
 *
 * An offer is data (see migration v104): multi-buy ("3 for £5"), buy-X-get-Y-free, percent off, amount off, or a fixed
 * price, limited to everything / a category / chosen products, to a date range, days of the week and a time of day,
 * to customers (any / a customer is attached / loyalty tiers) and to a location.
 *
 * How it reaches the money: the engine works out the total saving for an order and records it as the order's
 * discount (`discount_source = 'offer'`). Tax, the bill, loyalty cashback, refunds and the X/Z reports already
 * understand an order discount, so they agree with offers without any change. The rules that keep this safe:
 *
 *   - A discount a person applied always wins: while an order has one, offers do nothing for that order.
 *   - Nothing changes once money has been taken on the order's bill.
 *   - Lines with a price override, and fractional quantities, are left out; each unit takes part in one offer.
 *   - Offers are applied in priority order (highest first), then by the larger saving, then oldest first.
 *   - All arithmetic is integer minor units; a saving never exceeds the price of the units it applies to.
 *
 * `refreshOffers()` is idempotent and is called wherever an order's lines change: when a sale is created, when items
 * are added or removed, and when its bill is generated.
 */
import { getDatabase, getSettingValue, now } from '../db';
import { DEFAULT_COUNTRY, DEFAULT_TIMEZONE } from './defaults';
import { ulid } from './ids';
import { fromMinor, toMinor } from './money';
import { currencyExponent, quantiseMoney, sumMoney } from './money-integrity';
import { getCurrentLocationId } from './location';
import { getOrganizationContext } from './context';
import { getTierConfig, tierForSpend } from './loyalty';
import { calculateConfiguredChargeTaxes, combineItemAndChargeTaxes, getActiveCountryPack } from '../services/tax';
import { applyPayableRounding } from '../services/tax-engine';
import { appendOrderSnapshot, appendBillSnapshot } from './sync/sales-events';

export type OfferKind = 'percent_off' | 'amount_off' | 'fixed_price' | 'multi_buy_price' | 'buy_get_free';
export const OFFER_KINDS: readonly OfferKind[] = ['percent_off', 'amount_off', 'fixed_price', 'multi_buy_price', 'buy_get_free'];

export class OfferError extends Error {
  constructor(message: string, readonly statusCode: number = 400) {
    super(message);
    this.name = 'OfferError';
  }
}

export interface OfferRow {
  id: string;
  name: string;
  kind: OfferKind;
  scope: 'all' | 'category' | 'products';
  category_id: string | null;
  product_ids: string[];
  percent: number | null;
  amount_minor: number | null;
  price_minor: number | null;
  buy_qty: number | null;
  get_qty: number | null;
  bundle_qty: number | null;
  starts_at: string | null;
  ends_at: string | null;
  days_of_week: number[] | null;
  time_from: string | null;
  time_to: string | null;
  customer_rule: 'any' | 'member' | 'tier';
  tiers: string[];
  location_id: string | null;
  priority: number;
  is_active: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string' || !value) return [];
  try { const v = JSON.parse(value); return Array.isArray(v) ? v : []; } catch { return []; }
}

function hydrate(r: any): OfferRow {
  return {
    ...r,
    product_ids: parseJsonArray<string>(r.product_ids),
    days_of_week: r.days_of_week ? parseJsonArray<number>(r.days_of_week) : null,
    tiers: parseJsonArray<string>(r.tiers),
  } as OfferRow;
}

// ─── Validation and storage ──────────────────────────────────────────────────────────────

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface OfferInput {
  name?: unknown; kind?: unknown; scope?: unknown; category_id?: unknown; product_ids?: unknown;
  percent?: unknown; amount?: unknown; price?: unknown; buy_qty?: unknown; get_qty?: unknown; bundle_qty?: unknown;
  starts_at?: unknown; ends_at?: unknown; days_of_week?: unknown; time_from?: unknown; time_to?: unknown;
  customer_rule?: unknown; tiers?: unknown; location_id?: unknown; priority?: unknown;
}

function money(value: unknown, label: string): number {
  const exponent = currencyExponent(getSettingValue('currency'));
  let minor: number;
  const text = String(value ?? '').trim();
  if (!new RegExp(`^\\d+(\\.\\d{1,${exponent}})?$`).test(text)) throw new OfferError(`${label} must be an amount with at most ${exponent} decimal places`);
  try { minor = toMinor(text, exponent); } catch { throw new OfferError(`${label} must be an amount with at most ${exponent} decimal places`); }
  if (!Number.isSafeInteger(minor) || minor <= 0 || minor > 100_000_000_00) throw new OfferError(`${label} must be greater than zero`);
  return minor;
}
function whole(value: unknown, label: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new OfferError(`${label} must be a whole number from ${min} to ${max}`);
  return n;
}
function dateTime(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const t = Date.parse(String(value));
  if (!Number.isFinite(t)) throw new OfferError(`${label} is not a valid date and time`);
  return new Date(t).toISOString();
}

/** Check an offer from the till and turn it into the columns we store. Throws OfferError (400) with a plain reason. */
export function normaliseOfferInput(b: OfferInput): Omit<OfferRow, 'id' | 'is_active' | 'archived_at' | 'created_at' | 'updated_at'> {
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 80) throw new OfferError('Give the offer a name (80 characters at most)');
  const kind = b.kind as OfferKind;
  if (!OFFER_KINDS.includes(kind)) throw new OfferError(`kind must be one of: ${OFFER_KINDS.join(', ')}`);
  const scope = (b.scope ?? 'all') as OfferRow['scope'];
  if (!['all', 'category', 'products'].includes(scope)) throw new OfferError('scope must be all, category or products');
  const db = getDatabase();
  let categoryId: string | null = null; let productIds: string[] = [];
  if (scope === 'category') {
    categoryId = typeof b.category_id === 'string' ? b.category_id : '';
    if (!categoryId || !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) throw new OfferError('Choose a category that exists');
  }
  if (scope === 'products') {
    if (!Array.isArray(b.product_ids) || !b.product_ids.length || b.product_ids.length > 200) throw new OfferError('Choose between 1 and 200 products');
    productIds = [...new Set(b.product_ids.map(String))];
    for (const id of productIds) if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) throw new OfferError('One of the chosen products does not exist');
  }
  const out: any = {
    name, kind, scope, category_id: categoryId, product_ids: productIds, percent: null, amount_minor: null, price_minor: null,
    buy_qty: null, get_qty: null, bundle_qty: null,
  };
  if (kind === 'percent_off') {
    const p = Number(b.percent);
    if (!Number.isFinite(p) || p <= 0 || p > 100) throw new OfferError('Percent off must be more than 0 and at most 100');
    out.percent = Math.round(p * 100) / 100;
  } else if (kind === 'amount_off') out.amount_minor = money(b.amount, 'The amount off');
  else if (kind === 'fixed_price') out.price_minor = money(b.price, 'The price');
  else if (kind === 'multi_buy_price') { out.bundle_qty = whole(b.bundle_qty, 'The number of items in the bundle', 2, 50); out.price_minor = money(b.price, 'The bundle price'); }
  else { out.buy_qty = whole(b.buy_qty, 'Items to buy', 1, 50); out.get_qty = whole(b.get_qty, 'Items free', 1, 50); }
  const startsAt = dateTime(b.starts_at, 'The start'); const endsAt = dateTime(b.ends_at, 'The end');
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) throw new OfferError('The end must be after the start');
  out.starts_at = startsAt; out.ends_at = endsAt;
  if (b.days_of_week === undefined || b.days_of_week === null || (Array.isArray(b.days_of_week) && b.days_of_week.length === 0)) out.days_of_week = null;
  else {
    if (!Array.isArray(b.days_of_week)) throw new OfferError('days_of_week must be a list of days (0 = Sunday to 6 = Saturday)');
    const days = [...new Set(b.days_of_week.map(Number))];
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new OfferError('days_of_week must be whole numbers from 0 (Sunday) to 6 (Saturday)');
    out.days_of_week = days.sort();
  }
  const tf = b.time_from === undefined || b.time_from === null || b.time_from === '' ? null : String(b.time_from);
  const tt = b.time_to === undefined || b.time_to === null || b.time_to === '' ? null : String(b.time_to);
  if ((tf && !TIME_RE.test(tf)) || (tt && !TIME_RE.test(tt))) throw new OfferError('Times must look like 09:30');
  if ((tf === null) !== (tt === null)) throw new OfferError('Give both a start and an end time, or neither');
  out.time_from = tf; out.time_to = tt;
  const rule = (b.customer_rule ?? 'any') as OfferRow['customer_rule'];
  if (!['any', 'member', 'tier'].includes(rule)) throw new OfferError('customer_rule must be any, member or tier');
  out.customer_rule = rule;
  out.tiers = [];
  if (rule === 'tier') {
    if (!Array.isArray(b.tiers) || !b.tiers.length) throw new OfferError('Choose at least one loyalty tier');
    out.tiers = [...new Set(b.tiers.map(String))];
    if (out.tiers.some((t: string) => !['bronze', 'silver', 'gold'].includes(t))) throw new OfferError('Tiers are bronze, silver and gold');
  }
  let loc: string | null = null;
  if (b.location_id !== undefined && b.location_id !== null && b.location_id !== '') {
    loc = String(b.location_id);
    if (!db.prepare('SELECT 1 FROM locations WHERE id = ?').get(loc)) throw new OfferError('That location does not exist');
  }
  out.location_id = loc;
  out.priority = b.priority === undefined || b.priority === null || b.priority === '' ? 0 : whole(b.priority, 'Priority', -100, 100);
  return out;
}

const COLS = ['name', 'kind', 'scope', 'category_id', 'product_ids', 'percent', 'amount_minor', 'price_minor', 'buy_qty', 'get_qty', 'bundle_qty', 'starts_at', 'ends_at', 'days_of_week', 'time_from', 'time_to', 'customer_rule', 'tiers', 'location_id', 'priority'] as const;
const dbValue = (row: any, col: string) => (['product_ids', 'tiers'].includes(col) ? JSON.stringify(row[col] || []) : col === 'days_of_week' ? (row[col] ? JSON.stringify(row[col]) : null) : row[col]);

export function listOffers(opts: { includeArchived?: boolean } = {}): OfferRow[] {
  const rows = getDatabase().prepare(`SELECT * FROM offers ${opts.includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY priority DESC, created_at ASC`).all();
  return rows.map(hydrate);
}
export function getOffer(id: string): OfferRow | null {
  const r = getDatabase().prepare('SELECT * FROM offers WHERE id = ?').get(id);
  return r ? hydrate(r) : null;
}
export function createOffer(input: OfferInput, userId: string | null): OfferRow {
  const n = normaliseOfferInput(input);
  const id = ulid(); const t = now();
  getDatabase().prepare(`INSERT INTO offers (id, ${COLS.join(', ')}, is_active, created_by, created_at, updated_at, organization_id) VALUES (?, ${COLS.map(() => '?').join(', ')}, 1, ?, ?, ?, ?)`)
    .run(id, ...COLS.map((c) => dbValue(n, c)), userId, t, t, getOrganizationContext()?.id ?? null);
  return getOffer(id)!;
}
export function updateOffer(id: string, input: OfferInput): OfferRow {
  const existing = getOffer(id);
  if (!existing || existing.archived_at) throw new OfferError('Offer not found', 404);
  const n = normaliseOfferInput(input);
  getDatabase().prepare(`UPDATE offers SET ${COLS.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...COLS.map((c) => dbValue(n, c)), now(), id);
  return getOffer(id)!;
}
export function setOfferActive(id: string, active: boolean): OfferRow {
  const existing = getOffer(id);
  if (!existing || existing.archived_at) throw new OfferError('Offer not found', 404);
  getDatabase().prepare('UPDATE offers SET is_active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, now(), id);
  return getOffer(id)!;
}
/** An offer that has been used is never deleted: it is archived so past orders keep their record. */
export function archiveOffer(id: string): void {
  if (!getOffer(id)) throw new OfferError('Offer not found', 404);
  getDatabase().prepare('UPDATE offers SET archived_at = ?, is_active = 0, updated_at = ? WHERE id = ?').run(now(), now(), id);
}

// ─── The engine (pure) ──────────────────────────────────────────────────────────────

export interface EvalLine { key: string | number; productId: string; categoryId: string | null; unitMinor: number; quantity: number }
export interface EvalContext { at: Date; timezone: string; locationId: string | null; customer: { tier: string } | null }
export interface OfferApplication { offerId: string; name: string; savingsMinor: number; units: number }
export interface EvalResult { savingsMinor: number; applications: OfferApplication[]; lineSavings: Map<string | number, number> }

function localParts(at: Date, timezone: string): { day: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: DEFAULT_TIMEZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Is the offer on, at this moment, for this customer and place? (Not whether any items match.) */
export function offerIsLive(o: OfferRow, ctx: EvalContext): boolean {
  if (!o.is_active || o.archived_at) return false;
  const t = ctx.at.getTime();
  if (o.starts_at && t < Date.parse(o.starts_at)) return false;
  if (o.ends_at && t >= Date.parse(o.ends_at)) return false;
  if (o.location_id && o.location_id !== ctx.locationId) return false;
  const { day, minutes } = localParts(ctx.at, ctx.timezone);
  if (o.days_of_week && o.days_of_week.length && !o.days_of_week.includes(day)) return false;
  if (o.time_from && o.time_to) {
    const [fh, fm] = o.time_from.split(':').map(Number); const [th, tm] = o.time_to.split(':').map(Number);
    const from = fh * 60 + fm; const to = th * 60 + tm;
    const inside = from <= to ? (minutes >= from && minutes < to) : (minutes >= from || minutes < to); // an overnight window wraps midnight
    if (!inside) return false;
  }
  if (o.customer_rule === 'member' && !ctx.customer) return false;
  if (o.customer_rule === 'tier' && (!ctx.customer || !o.tiers.includes(ctx.customer.tier))) return false;
  return true;
}

interface Unit { price: number; productId: string; lineKey: string | number; used: boolean }

function matches(o: OfferRow, u: { productId: string; categoryId: string | null }): boolean {
  if (o.scope === 'all') return true;
  if (o.scope === 'category') return !!u.categoryId && u.categoryId === o.category_id;
  return o.product_ids.includes(u.productId);
}

/** What one offer would save on the units still available, and which units it would use. Does not mark anything. */
function tryOffer(o: OfferRow, units: (Unit & { categoryId: string | null })[]): { savings: number; picks: { unit: Unit; saving: number }[] } {
  const eligible = units.filter((u) => !u.used && u.price > 0 && matches(o, u)).sort((a, b) => b.price - a.price);
  const picks: { unit: Unit; saving: number }[] = [];
  const add = (unit: Unit, saving: number) => { if (saving > 0) picks.push({ unit, saving: Math.min(saving, unit.price) }); };
  if (o.kind === 'percent_off') for (const u of eligible) add(u, Math.round((u.price * (o.percent || 0)) / 100));
  else if (o.kind === 'amount_off') for (const u of eligible) add(u, o.amount_minor || 0);
  else if (o.kind === 'fixed_price') for (const u of eligible) add(u, u.price - (o.price_minor || 0));
  else if (o.kind === 'multi_buy_price') {
    const n = o.bundle_qty || 0;
    for (let i = 0; n > 1 && i + n <= eligible.length; i += n) {
      const group = eligible.slice(i, i + n);
      const total = group.reduce((s, u) => s + u.price, 0);
      const saving = total - (o.price_minor || 0);
      if (saving <= 0) continue;
      // Share the group's saving over its units in proportion to price (largest remainder), so each line is exact.
      let left = saving;
      group.forEach((u, idx) => { const part = idx === group.length - 1 ? left : Math.floor((saving * u.price) / total); left -= idx === group.length - 1 ? 0 : part; add(u, part); });
    }
  } else {
    const size = (o.buy_qty || 0) + (o.get_qty || 0);
    for (let i = 0; size > 1 && i + size <= eligible.length; i += size) {
      const group = eligible.slice(i, i + size);               // dearest first
      for (const u of group.slice(o.buy_qty || 0)) add(u, u.price); // the cheapest get_qty are free
    }
  }
  return { savings: picks.reduce((s, p) => s + p.saving, 0), picks };
}

export function evaluateOffers(lines: EvalLine[], offers: OfferRow[], ctx: EvalContext): EvalResult {
  const units: (Unit & { categoryId: string | null })[] = [];
  for (const l of lines) {
    if (!(l.unitMinor > 0)) continue;
    const n = Math.floor(l.quantity);
    for (let i = 0; i < n; i++) units.push({ price: l.unitMinor, productId: l.productId, categoryId: l.categoryId, lineKey: l.key, used: false });
  }
  const live = offers.filter((o) => offerIsLive(o, ctx));
  // Highest priority first; among equals the offer that saves most on its own; then the oldest.
  const alone = new Map(live.map((o) => [o.id, tryOffer(o, units).savings]));
  live.sort((a, b) => b.priority - a.priority || (alone.get(b.id)! - alone.get(a.id)!) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const applications: OfferApplication[] = []; const lineSavings = new Map<string | number, number>();
  for (const o of live) {
    const { savings, picks } = tryOffer(o, units);
    if (savings <= 0) continue;
    for (const p of picks) { p.unit.used = true; lineSavings.set(p.unit.lineKey, (lineSavings.get(p.unit.lineKey) || 0) + p.saving); }
    applications.push({ offerId: o.id, name: o.name, savingsMinor: savings, units: picks.length });
  }
  return { savingsMinor: applications.reduce((s, a) => s + a.savingsMinor, 0), applications, lineSavings };
}

// ─── Applying to an order ─────────────────────────────────────────────────────────────

function tenant() {
  return {
    country: getSettingValue('country') || DEFAULT_COUNTRY,
    business_type: getSettingValue('business_type') || 'restaurant',
    state_code: getSettingValue('state_code') || '',
    taxes_enabled: getSettingValue('taxes_enabled') === 'true',
  };
}

function context(customerId: string | null | undefined, excludeOrderId?: number | string): EvalContext {
  const db = getDatabase();
  let customer: { tier: string } | null = null;
  if (customerId && db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customerId)) {
    // The same lifetime spend the customer list uses for the tier shown on screen, leaving out the order being priced
    // so its own total cannot move the customer between tiers while it is being worked out.
    const spent = db.prepare("SELECT COALESCE(SUM(total), 0) AS s FROM orders WHERE customer_id = ? AND status != 'cancelled' AND id != ?").get(customerId, excludeOrderId ?? -1) as { s: number };
    customer = { tier: tierForSpend(Number(spent.s) || 0, getTierConfig()) };
  }
  return { at: new Date(), timezone: getSettingValue('timezone') || DEFAULT_TIMEZONE, locationId: getCurrentLocationId(), customer };
}

function orderLines(orderId: number | string, exponent: number): EvalLine[] {
  const rows = getDatabase().prepare(`
    SELECT oi.id, oi.product_id, oi.unit_price, oi.quantity, oi.original_unit_price, p.category_id
    FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ? AND oi.status NOT IN ('cancelled', 'voided', 'void_adjustment')
  `).all(orderId) as any[];
  return rows
    .filter((r) => r.original_unit_price === null || r.original_unit_price === undefined) // a manager's price override is left alone
    .map((r) => ({ key: r.id, productId: String(r.product_id), categoryId: r.category_id ?? null, unitMinor: toMinor(Number(r.unit_price) || 0, exponent), quantity: Number(r.quantity) || 0 }));
}

/** What offers would save on a basket that is not an order yet (the till's live preview). */
export function previewOffers(items: { product_id: string; variant_id?: string | null; quantity: number }[], customerId: string | null): { savings_minor: number; applications: OfferApplication[] } {
  const db = getDatabase();
  const exponent = currencyExponent(getSettingValue('currency'));
  const lines: EvalLine[] = [];
  items.slice(0, 200).forEach((it, i) => {
    const p = db.prepare('SELECT id, price, category_id FROM products WHERE id = ?').get(it.product_id) as any;
    if (!p) return;
    let price = Number(p.price);
    if (it.variant_id) { const v = db.prepare('SELECT price FROM product_variants WHERE id = ? AND product_id = ? AND is_active = 1').get(it.variant_id, it.product_id) as any; if (v) price = Number(v.price); }
    lines.push({ key: i, productId: String(p.id), categoryId: p.category_id ?? null, unitMinor: toMinor(price || 0, exponent), quantity: Number(it.quantity) || 0 });
  });
  const r = evaluateOffers(lines, listOffers(), context(customerId));
  return { savings_minor: r.savingsMinor, applications: r.applications };
}

/**
 * Bring an order's offer discount up to date with its current lines. Safe to call at any time and any number of
 * times; does nothing when a person's discount is on the order, money has been taken, or the order is closed.
 */
export function refreshOffers(orderId: number | string): { changed: boolean; savingsMinor: number } {
  const db = getDatabase();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
  if (!order || ['completed', 'cancelled'].includes(order.status)) return { changed: false, savingsMinor: 0 };
  const paid = db.prepare('SELECT 1 FROM bills WHERE order_id = ? AND COALESCE(paid_amount, 0) > 0').get(orderId);
  if (paid) return { changed: false, savingsMinor: 0 };
  const currentSource = order.discount_source === 'offer';
  if ((order.discount_amount || 0) > 0 && !currentSource) return { changed: false, savingsMinor: 0 }; // a person's discount wins

  const exponent = currencyExponent(getSettingValue('currency'));
  // A discount a person put on a single line is a person's discount too: offers step aside (and come off if present).
  const lineDiscounted = !!db.prepare("SELECT 1 FROM order_items WHERE order_id = ? AND status != 'cancelled' AND COALESCE(discount_amount, 0) > 0").get(orderId);
  const result = evaluateOffers(lineDiscounted ? [] : orderLines(orderId, exponent), listOffers(), context(order.customer_id, orderId));
  const before = currentSource ? toMinor(order.discount_amount || 0, exponent) : 0;

  // The subtotal can never be discounted below zero.
  const activeItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status != 'cancelled'").all(orderId) as any[];
  let subtotal = 0;
  for (const i of activeItems) subtotal = sumMoney([subtotal, i.subtotal || 0], exponent);
  const savingsMinor = Math.min(result.savingsMinor, toMinor(subtotal, exponent));

  // If the cap trimmed the saving, take the difference off the last applications so the rows add up to the discount.
  let over = result.savingsMinor - savingsMinor;
  const apps = result.applications.map((a) => ({ ...a }));
  for (let i = apps.length - 1; i >= 0 && over > 0; i--) { const cut = Math.min(over, apps[i].savingsMinor); apps[i].savingsMinor -= cut; over -= cut; }
  const wanted = savingsMinor > 0 ? apps.filter((a) => a.savingsMinor > 0) : [];
  const stored = (db.prepare('SELECT offer_id, savings_minor FROM order_offers WHERE order_id = ? ORDER BY id').all(orderId) as any[]).map((r) => [r.offer_id, r.savings_minor]);
  if (before === savingsMinor && JSON.stringify(wanted.map((a) => [a.offerId, a.savingsMinor])) === JSON.stringify(stored)) return { changed: false, savingsMinor };

  const discountAmount = fromMinor(savingsMinor, exponent);
  const reason = savingsMinor > 0 ? `Offer: ${result.applications.map((a) => a.name).join(', ')}`.slice(0, 200) : null;

  let totalTax = 0; let exclusiveTax = 0;
  const breakdowns: any[] = []; const snapshots: (string | null)[] = [];
  for (const item of activeItems) {
    totalTax = sumMoney([totalTax, item.tax_amount || 0], exponent);
    if (item.tax_type !== 'inclusive') exclusiveTax = sumMoney([exclusiveTax, item.tax_amount || 0], exponent);
    if (item.tax_breakdown) { try { const b = JSON.parse(item.tax_breakdown); if (Array.isArray(b)) breakdowns.push(b); } catch { /* skip a malformed legacy breakdown */ } }
    snapshots.push(item.tax_snapshot || null);
  }
  let itemTax = totalTax; let itemExclusive = exclusiveTax; let ratio = 1;
  if (discountAmount > 0 && subtotal > 0) {
    ratio = Math.max(0, sumMoney([subtotal, -discountAmount], exponent)) / subtotal;
    itemTax = quantiseMoney(totalTax * ratio, exponent);
    itemExclusive = quantiseMoney(exclusiveTax * ratio, exponent);
  }
  const customer = order.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id) as any : null;
  const t = tenant();
  const charges = calculateConfiguredChargeTaxes(t, { ...order, service_charge: 0 }, customer);
  const rollup = combineItemAndChargeTaxes({ itemTaxAmount: itemTax, itemExclusiveTaxAmount: itemExclusive, itemBreakdowns: breakdowns, itemSnapshots: snapshots, itemTaxRatio: ratio, chargeTaxes: charges });
  const discounted = Math.max(0, sumMoney([subtotal, -discountAmount], exponent));
  const total = sumMoney([discounted, rollup.exclusiveTaxAmount, order.packaging_charge || 0, order.delivery_charge || 0], exponent);
  const type = savingsMinor > 0 ? 'amount' : null; const value = savingsMinor > 0 ? discountAmount : null; const source = savingsMinor > 0 ? 'offer' : null;

  db.prepare(`UPDATE orders SET subtotal = ?, discount_amount = ?, discount_type = ?, discount_value = ?, discount_reason = ?, discount_source = ?,
      tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, total = ?, round_off = 0, updated_at = ? WHERE id = ?`)
    .run(subtotal, discountAmount, type, value, reason, source, rollup.taxAmount, JSON.stringify(rollup.breakdowns), rollup.snapshotJson, total, now(), orderId);

  const bill = db.prepare("SELECT * FROM bills WHERE order_id = ? AND payment_status != 'paid'").get(orderId) as any;
  if (bill && !bill.split_group_id) {
    const pack = getActiveCountryPack(t.country);
    const { total: billTotal, adjustment } = applyPayableRounding(total, pack);
    const balance = Math.max(0, sumMoney([billTotal, -(bill.paid_amount || 0)], exponent));
    db.prepare(`UPDATE bills SET subtotal = ?, discount_amount = ?, discount_type = ?, discount_value = ?, discount_reason = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?,
        total = ?, balance = ?, round_off = ?, updated_at = ? WHERE id = ?`)
      .run(subtotal, discountAmount, type, value, reason, rollup.taxAmount, JSON.stringify(rollup.breakdowns), rollup.snapshotJson, billTotal, balance, adjustment, now(), bill.id);
  }

  db.prepare('DELETE FROM order_offers WHERE order_id = ?').run(orderId);
  const ins = db.prepare('INSERT INTO order_offers (order_id, offer_id, offer_name, savings_minor, units, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const a of wanted) ins.run(orderId, a.offerId, a.name, a.savingsMinor, a.units, now());
  appendOrderSnapshot(db, Number(orderId));
  if (bill) appendBillSnapshot(db, bill.id);
  return { changed: true, savingsMinor };
}

/** Savings per offer for orders whose bills were paid in a period (a plain report). */
export function offerUsage(fromIso: string, toIso: string): { offer_id: string; name: string; orders: number; units: number; savings_minor: number }[] {
  return getDatabase().prepare(`
    SELECT oo.offer_id, oo.offer_name AS name, COUNT(DISTINCT oo.order_id) AS orders, SUM(oo.units) AS units, SUM(oo.savings_minor) AS savings_minor
    FROM order_offers oo JOIN bills b ON b.order_id = oo.order_id
    WHERE b.payment_status = 'paid' AND b.paid_at >= ? AND b.paid_at <= ?
    GROUP BY oo.offer_id, oo.offer_name ORDER BY savings_minor DESC
  `).all(fromIso, toIso) as any[];
}
