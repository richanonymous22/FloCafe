/**
 * Plemmo Core — payment reconciliation (Payment Cutover, Part C).
 *
 * The SYNC-0 backfill (migration v80) only reconstructed `payments`/
 * `payment_events` for bills with ZERO existing payment rows. That is safe
 * for the common case (a bill whose dual-write never ran at all) but not
 * for a PARTIAL mirror: before SYNC-0 fixed `recordAppliedPaymentLine` to
 * be atomic, it swallowed errors *per line* inside `applyPaymentBatch`'s
 * loop — so a bill with a two-line split payment could have had its first
 * line mirrored successfully and its second silently dropped, leaving a
 * bill with ≥1 payment row that v80's "skip if any payment exists" guard
 * would never touch. This module finds and fixes exactly that gap.
 *
 * For every bill that still has legacy `payment_details`, it compares the
 * legacy lines against the authoritative `payments` rows and classifies
 * each legacy line as:
 *
 *   - matched:       an authoritative payment already represents it
 *   - reconstructed: no authoritative payment represents it, but the line
 *                     carries enough information (a valid method and a
 *                     positive, finite amount) to create one deterministically
 *   - unrepresentable: no authoritative payment represents it, and the line
 *                     itself is too ambiguous/malformed to reconstruct
 *                     (Part C: "DO NOT invent data")
 *
 * Matching is by (method, amount) — for a line carrying a transaction_id,
 * matched more specifically against an authoritative row with the same
 * `provider_reference`. Matched authoritative rows are consumed so a
 * second identical legacy line cannot double-match the same payment.
 */

import { getDatabase, now } from '../db';
import { ulid } from './ids';

export type PaymentReconciliationLineStatus = 'matched' | 'reconstructed' | 'unrepresentable';

export interface PaymentReconciliationLineResult {
  legacyLine: unknown;
  status: PaymentReconciliationLineStatus;
  paymentId?: string;
  reason?: string;
}

export interface PaymentReconciliationBillResult {
  billId: number;
  billUid: string | null;
  legacyLineCount: number;
  matched: number;
  reconstructed: number;
  unrepresentable: number;
  lines: PaymentReconciliationLineResult[];
}

interface AuthoritativePaymentRow {
  id: string;
  method: string;
  amount_minor: number;
  provider_reference: string | null;
}

function parseLegacyLines(paymentDetails: string): unknown[] {
  let parsed: unknown;
  try { parsed = JSON.parse(paymentDetails); } catch { return []; }
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Reconciles a single bill's legacy payment_details against its
 * authoritative payments. `dryRun: true` classifies without writing
 * anything — used by the audit report and by tests that only want to
 * assert detection, not mutate the database.
 */
export function reconcileBillPayments(
  billId: number,
  options: { dryRun?: boolean } = {},
): PaymentReconciliationBillResult | null {
  const db = getDatabase();
  const bill = db.prepare(`
    SELECT b.id, b.uid, b.order_id, b.payment_details,
           o.uid AS order_uid, o.organization_id, o.location_id
    FROM bills b LEFT JOIN orders o ON o.id = b.order_id
    WHERE b.id = ?
  `).get(billId) as {
    id: number; uid: string | null; order_id: number | null; payment_details: string | null;
    order_uid: string | null; organization_id: string | null; location_id: string | null;
  } | undefined;
  if (!bill || !bill.payment_details) return null;

  const legacyLines = parseLegacyLines(bill.payment_details);
  const authoritative = db.prepare(
    'SELECT id, method, amount_minor, provider_reference FROM payments WHERE bill_id = ? ORDER BY requested_at ASC, created_at ASC',
  ).all(billId) as AuthoritativePaymentRow[];
  const consumed = new Set<string>();
  const currency = ((db.prepare("SELECT value FROM settings WHERE key = 'currency'").get() as { value?: string } | undefined)?.value || 'INR').toUpperCase();

  const insertPayment = db.prepare(`
    INSERT INTO payments (
      id, bill_id, order_id, bill_uid, order_uid, adapter, method, state,
      amount_minor, currency, refunded_minor, tendered_minor, change_minor,
      provider_reference, actor_user_id, notes, metadata,
      requested_at, settled_at, created_at, updated_at, organization_id, location_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // 21 placeholders total (refunded_minor=0 and actor_user_id=NULL are the
  // two literals in the VALUES clause above, not placeholders): id, bill_id,
  // order_id, bill_uid, order_uid, adapter, method, state, amount_minor,
  // currency, tendered_minor, change_minor, provider_reference, notes,
  // metadata, requested_at, settled_at, created_at, updated_at,
  // organization_id, location_id — matched exactly by insertPayment.run()'s
  // argument list below.
  const insertEvent = db.prepare(`
    INSERT INTO payment_events (id, payment_id, from_state, to_state, occurred_at, actor_user_id, metadata, created_at)
    VALUES (?, ?, NULL, ?, ?, NULL, ?, ?)
  `);

  const lineResults: PaymentReconciliationLineResult[] = [];
  let matched = 0;
  let reconstructed = 0;
  let unrepresentable = 0;

  for (const raw of legacyLines) {
    const line = raw as Record<string, unknown>;
    const method = typeof line.method === 'string' && line.method.trim() ? line.method.trim() : null;
    const amount = Number(line.amount);
    const amountMinor = Number.isFinite(amount) ? Math.round(amount * 100) : NaN;
    const transactionId = typeof line.transaction_id === 'string' ? line.transaction_id : null;

    // 1. Try to find an already-mirrored authoritative row for this line.
    let match: AuthoritativePaymentRow | undefined;
    if (transactionId) {
      match = authoritative.find((p) => !consumed.has(p.id) && p.provider_reference === transactionId);
    }
    if (!match && method && Number.isFinite(amountMinor)) {
      match = authoritative.find((p) => !consumed.has(p.id) && p.method === method && p.amount_minor === amountMinor);
    }
    if (match) {
      consumed.add(match.id);
      matched += 1;
      lineResults.push({ legacyLine: raw, status: 'matched', paymentId: match.id });
      continue;
    }

    // 2. No authoritative row represents this line. Reconstruct only when the
    //    line carries enough information to do so deterministically — the
    //    exact criteria migration v80 already uses, so a bill that goes
    //    through both v80 and this pass is reconstructed identically either
    //    way (Part C: never invent data for what v80 would also have skipped).
    if (!method || !Number.isFinite(amount) || amount <= 0) {
      unrepresentable += 1;
      lineResults.push({ legacyLine: raw, status: 'unrepresentable', reason: !method ? 'missing or invalid method' : 'missing or non-positive amount' });
      continue;
    }

    if (options.dryRun) {
      reconstructed += 1;
      lineResults.push({ legacyLine: raw, status: 'reconstructed', reason: 'dry run — not written' });
      continue;
    }

    const adapter = method === 'cash' ? 'cash' : method === 'wallet' ? 'wallet' : 'manual_card';
    const state = adapter === 'manual_card' ? 'captured' : 'settled';
    const tendered = Number(line.tendered_amount);
    const change = Number(line.change_amount);
    const tenderedMinor = adapter === 'cash' && Number.isFinite(tendered) ? Math.round(tendered * 100) : null;
    const changeMinor = adapter === 'cash' && Number.isFinite(change) ? Math.round(change * 100) : null;
    const providerRef = transactionId;
    const tsRaw = typeof line.timestamp === 'string' ? line.timestamp : now();
    const parsedMs = Date.parse(String(tsRaw).replace(' ', 'T') + (String(tsRaw).includes('T') || String(tsRaw).endsWith('Z') ? '' : 'Z'));
    const seedMs = Number.isFinite(parsedMs) ? parsedMs : Date.now();
    const paymentId = ulid(seedMs);
    const at = String(tsRaw);
    const settledAt = state === 'settled' ? at : null;
    // Part D: preserve the original legacy method label as explicit
    // provenance metadata, distinguishing a reconciliation-reconstructed
    // payment from one created live, and recording exactly what label the
    // merchant originally recorded even if `method` itself is already the
    // raw label (e.g. a custom method name that also maps onto manual_card).
    const metadata = JSON.stringify({ legacy_method: method, backfill_source: 'payment_reconciliation' });
    const notes = typeof line.notes === 'string' ? line.notes : null;
    insertPayment.run(
      paymentId, bill.id, bill.order_id, bill.uid, bill.order_uid, adapter, method, state,
      amountMinor, currency, tenderedMinor, changeMinor, providerRef, notes, metadata,
      at, settledAt, at, at, bill.organization_id, bill.location_id,
    );
    insertEvent.run(ulid(seedMs), paymentId, state, at, metadata, at);
    reconstructed += 1;
    lineResults.push({ legacyLine: raw, status: 'reconstructed', paymentId });
  }

  return {
    billId: bill.id,
    billUid: bill.uid,
    legacyLineCount: legacyLines.length,
    matched,
    reconstructed,
    unrepresentable,
    lines: lineResults,
  };
}

export interface PaymentReconciliationReport {
  billsExamined: number;
  billsWithDiscrepancy: number;
  totalMatched: number;
  totalReconstructed: number;
  totalUnrepresentable: number;
  bills: PaymentReconciliationBillResult[];
}

/**
 * Reconciles every bill that still has legacy payment_details. Idempotent —
 * a bill fully matched on a previous run stays fully matched (nothing left
 * to reconstruct), so running this repeatedly is safe. Bills v80 already
 * fully backfilled are naturally a no-op pass here (every legacy line
 * matches the payment v80 created for it), which doubles as a consistency
 * check on v80's own output.
 */
export function reconcileAllPaymentDetails(options: { dryRun?: boolean } = {}): PaymentReconciliationReport {
  const db = getDatabase();
  const billIds = (db.prepare("SELECT id FROM bills WHERE payment_details IS NOT NULL AND payment_details != ''").all() as Array<{ id: number }>).map((r) => r.id);

  const bills: PaymentReconciliationBillResult[] = [];
  let totalMatched = 0;
  let totalReconstructed = 0;
  let totalUnrepresentable = 0;
  let billsWithDiscrepancy = 0;

  for (const billId of billIds) {
    const result = reconcileBillPayments(billId, options);
    if (!result) continue;
    bills.push(result);
    totalMatched += result.matched;
    totalReconstructed += result.reconstructed;
    totalUnrepresentable += result.unrepresentable;
    if (result.reconstructed > 0 || result.unrepresentable > 0) billsWithDiscrepancy += 1;
  }

  return {
    billsExamined: bills.length,
    billsWithDiscrepancy,
    totalMatched,
    totalReconstructed,
    totalUnrepresentable,
    bills,
  };
}
