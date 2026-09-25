/**
 * AI assistant service (Meridian integration).
 *
 * ADVISORY ONLY. The assistant answers questions over an AUTHORITATIVE business
 * snapshot built from the real database — it never mutates data and never
 * bypasses authorization or tenancy. Every query is audited.
 *
 * Two answer sources:
 *   - `local`: a deterministic rule engine over the authoritative snapshot.
 *     Always available, offline, and the source of truth for the numbers.
 *   - `anthropic`: an optional enhancement that phrases the answer via the
 *     Claude API when ANTHROPIC_API_KEY is configured. It is given the same
 *     authoritative snapshot as grounding and can only produce text — it has
 *     no tools and cannot act. Falls back to `local` on any error.
 */
import { getDatabase, now, getSettingValue, utcDayBounds } from '../db';
import { recordAuditEvent } from './audit';
import { listLowStock } from './inventory';
import { getOpenCashSession, expectedCashMinor } from './cash';
import { getCurrentLocationId } from './location';

export interface AiSnapshot {
  business: string;
  currency: string;
  today: { orders: number; revenue: number };
  topProducts: Array<{ name: string; qty: number; revenue: number }>;
  lowStock: Array<{ name: string; quantity: number; threshold: number }>;
  staffOnShift: number;
  cash: { open: boolean; expected_minor?: number };
  generatedAt: string;
}

/** Build the authoritative snapshot. Read-only; uses committed data only. */
export function buildSnapshot(): AiSnapshot {
  const db = getDatabase();
  // Match the storage format of created_at (YYYY-MM-DD HH:MM:SS, UTC).
  const [start] = utcDayBounds(new Date().toISOString().slice(0, 10));
  const currency = getSettingValue('currency') || 'INR';
  const business = getSettingValue('business_name') || 'Store';

  const today = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue FROM orders WHERE created_at >= ?`).get(start) as { orders: number; revenue: number };

  const topProducts = db.prepare(`
    SELECT oi.product_name AS name, SUM(oi.quantity) AS qty, SUM(oi.total) AS revenue
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.created_at >= ? GROUP BY oi.product_name ORDER BY qty DESC LIMIT 5
  `).all(start) as Array<{ name: string; qty: number; revenue: number }>;

  const low = listLowStock().map((l) => ({ name: l.productName, quantity: l.quantity, threshold: l.threshold }));

  const onShift = db.prepare(`SELECT COUNT(*) AS n FROM staff_shifts WHERE clock_out IS NULL`).get() as { n: number };

  const session = getOpenCashSession(getCurrentLocationId());
  const cash = session ? { open: true, expected_minor: expectedCashMinor(session.id) } : { open: false };

  return {
    business, currency,
    today: { orders: today.orders || 0, revenue: today.revenue || 0 },
    topProducts, lowStock: low, staffOnShift: onShift.n || 0, cash,
    generatedAt: now(),
  };
}

function fmtMoney(n: number, currency: string): string {
  const sym: Record<string, string> = { GBP: '£', USD: '$', EUR: '€', INR: '₹' };
  return (sym[currency] || '') + (Number(n) || 0).toFixed(2);
}

/** Deterministic advisory answer over the authoritative snapshot. */
export function localAnswer(question: string, snap: AiSnapshot): string {
  const q = (question || '').toLowerCase();
  const c = snap.currency;
  if (/low stock|running low|reorder|out of stock/.test(q)) {
    if (!snap.lowStock.length) return 'Nothing is running low right now — stock levels look healthy.';
    return `${snap.lowStock.length} item(s) are low: ` + snap.lowStock.slice(0, 8).map((l) => `${l.name} (${l.quantity} left, warn at ${l.threshold})`).join(', ') + '.';
  }
  if (/best|top|popular|selling/.test(q)) {
    if (!snap.topProducts.length) return 'No sales yet today, so there is nothing to rank.';
    return 'Top sellers today:\n' + snap.topProducts.map((p, i) => `${i + 1}. ${p.name} — ${p.qty} sold, ${fmtMoney(p.revenue, c)}`).join('\n');
  }
  if (/cash|drawer|till/.test(q)) {
    if (!snap.cash.open) return 'No cash drawer session is open right now.';
    return `The drawer is open. Expected cash: ${fmtMoney((snap.cash.expected_minor || 0) / 100, c)}.`;
  }
  if (/staff|shift|clocked|working/.test(q)) {
    return `${snap.staffOnShift} staff member(s) are currently clocked in.`;
  }
  if (/sales|revenue|takings|today|how much|how many orders/.test(q)) {
    return `Today: ${snap.today.orders} order(s) for ${fmtMoney(snap.today.revenue, c)} at ${snap.business}.`;
  }
  // Default: a concise authoritative summary.
  return `Today at ${snap.business}: ${snap.today.orders} order(s), ${fmtMoney(snap.today.revenue, c)} in sales, ${snap.staffOnShift} on shift`
    + (snap.lowStock.length ? `, ${snap.lowStock.length} item(s) low on stock` : '') + '.';
}

/** Optional Claude API phrasing, grounded in the authoritative snapshot. */
async function anthropicAnswer(question: string, snap: AiSnapshot): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || typeof fetch !== 'function') return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 1024,
        system: 'You are an advisory POS assistant. Answer ONLY from the authoritative JSON snapshot provided. Never invent figures. You cannot take actions; you only advise. Be concise, use the given currency.',
        messages: [{ role: 'user', content: `Snapshot:\n${JSON.stringify(snap)}\n\nQuestion: ${question}` }],
      }),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const text = Array.isArray(data.content) ? data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim() : '';
    return text || null;
  } catch { return null; }
}

export interface AskResult { answer: string; source: 'local' | 'anthropic'; snapshot: AiSnapshot }

/** Advisory entry point. Audited; never mutates. */
export async function ask(question: string, ctx: { userId?: string | null }): Promise<AskResult> {
  const snapshot = buildSnapshot();
  let answer = localAnswer(question, snapshot);
  let source: 'local' | 'anthropic' = 'local';
  const remote = await anthropicAnswer(question, snapshot);
  if (remote) { answer = remote; source = 'anthropic'; }

  recordAuditEvent({
    type: 'ai.query', actor: { userId: ctx.userId ?? null }, entity: { type: 'ai', id: now() },
    summary: `AI advisory query (${source})`, metadata: { source, question_length: (question || '').length },
  });
  return { answer, source, snapshot };
}
