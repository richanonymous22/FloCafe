/**
 * The card attempt ledger. Provider-neutral: it records every request to a card provider and decides when an
 * attempt may be turned into a payment.
 *
 * Money rules enforced here:
 *  - Only a provider answer moves an attempt to `approved`. Nothing the browser sends can.
 *  - An approved attempt becomes a payment at most once (`consumeApprovedAttempt` + `markAttemptConsumed`, both
 *    synchronous so they run inside the payment transaction).
 *  - If the till loses contact after the provider approved, the attempt stays `approved` and unconsumed, and
 *    `listOrphanAttempts()` reports it for the reconciliation screen instead of the money vanishing.
 */
import { getDatabase, getSettingValue, now } from '../../db';
import { DEFAULT_CURRENCY } from '../defaults';
import { ulid } from '../ids';
import { recordAuditEvent } from '../audit';
import { getLocationContext, getOrganizationContext } from '../context';
import { getCardProvider } from './registry';
import { CardAttemptState, CardOutcome, CardProvider, CardProviderError } from './types';

export class CardError extends Error {
  constructor(message: string, readonly statusCode: number = 400, readonly code?: string) {
    super(message);
    this.name = 'CardError';
  }
}

export interface CardAttemptRow {
  id: string;
  kind: 'sale' | 'refund';
  provider: string;
  simulated: number;
  terminal_id: string | null;
  bill_id: number | null;
  amount_minor: number;
  tip_minor: number;
  currency: string;
  state: CardAttemptState;
  provider_reference: string | null;
  auth_code: string | null;
  card_scheme: string | null;
  card_last4: string | null;
  message: string | null;
  parent_payment_id: string | null;
  consumed_payment_id: string | null;
  consumed_refund_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/** How long a customer has to use the terminal before the attempt is abandoned. */
export const ATTEMPT_TTL_MS = 3 * 60 * 1000;
/** An approved sale with no payment after this long is reported as an orphan. */
export const ORPHAN_AFTER_MS = 2 * 60 * 1000;

const FINAL: CardAttemptState[] = ['approved', 'declined', 'cancelled', 'timed_out', 'failed', 'consumed'];

function db() { return getDatabase(); }
export function getAttempt(id: string): CardAttemptRow | null {
  return (db().prepare('SELECT * FROM card_attempts WHERE id = ?').get(id) as CardAttemptRow | undefined) ?? null;
}
function requireProvider(): CardProvider {
  const provider = getCardProvider();
  if (!provider) throw new CardError('No card terminal is connected. Choose a card provider in Settings, or record the card by hand.', 409, 'no_provider');
  return provider;
}
function setState(id: string, state: CardAttemptState, outcome?: CardOutcome): void {
  db().prepare(`UPDATE card_attempts SET state = ?, provider_reference = COALESCE(?, provider_reference), auth_code = COALESCE(?, auth_code),
      card_scheme = COALESCE(?, card_scheme), card_last4 = COALESCE(?, card_last4), message = COALESCE(?, message), updated_at = ? WHERE id = ? AND state = 'pending'`)
    .run(state, outcome?.providerReference ?? null, outcome?.authCode ?? null, outcome?.scheme ?? null, outcome?.last4 ?? null, outcome?.message ?? null, now(), id);
}

export function publicAttempt(a: CardAttemptRow) {
  return {
    id: a.id, kind: a.kind, state: a.state, bill_id: a.bill_id, amount_minor: a.amount_minor, tip_minor: a.tip_minor, currency: a.currency,
    provider: a.provider, simulated: !!a.simulated, terminal_id: a.terminal_id, card_scheme: a.card_scheme, card_last4: a.card_last4,
    auth_code: a.auth_code, message: a.message, expires_at: a.expires_at, created_at: a.created_at,
  };
}

export async function listTerminals() {
  return requireProvider().listTerminals();
}

export interface StartSaleArgs { billId?: number | null; amountMinor: number; tipMinor?: number; terminalId?: string | null; userId?: string | null; }

export async function startCardSale(args: StartSaleArgs): Promise<CardAttemptRow> {
  const provider = requireProvider();
  const tip = Math.max(0, Math.round(args.tipMinor ?? 0));
  if (!Number.isInteger(args.amountMinor) || args.amountMinor <= 0) throw new CardError('Card amount must be greater than zero', 400);
  const currency = (getSettingValue('currency') || DEFAULT_CURRENCY).toUpperCase();
  if (args.billId != null) {
    const bill = db().prepare('SELECT id, total, paid_amount, payment_status FROM bills WHERE id = ?').get(args.billId) as any;
    if (!bill) throw new CardError('Bill not found', 404);
    if (bill.payment_status === 'paid') throw new CardError('Bill is already paid', 400);
    const remaining = Math.max(0, Math.round((Number(bill.total) - Number(bill.paid_amount || 0)) * 100));
    if (args.amountMinor > remaining) throw new CardError('Card amount exceeds the bill balance', 400);
    const waiting = db().prepare("SELECT expires_at FROM card_attempts WHERE kind = 'sale' AND bill_id = ? AND state = 'pending'").all(args.billId) as { expires_at: string }[];
    if (waiting.some((w) => new Date(w.expires_at).getTime() > Date.now())) throw new CardError('A card payment for this bill is already waiting on the terminal. Cancel it first.', 409, 'attempt_open');
  }
  const id = ulid();
  const created = now();
  const expires = new Date(Date.now() + ATTEMPT_TTL_MS).toISOString();
  db().prepare(`INSERT INTO card_attempts (id, kind, provider, simulated, terminal_id, bill_id, amount_minor, tip_minor, currency, state, created_by, created_at, updated_at, expires_at, organization_id, location_id)
    VALUES (?, 'sale', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`)
    .run(id, provider.id, provider.simulated ? 1 : 0, args.terminalId ?? null, args.billId ?? null, args.amountMinor, tip, currency, args.userId ?? null, created, created, expires,
      getOrganizationContext()?.id ?? null, getLocationContext()?.id ?? null);
  try {
    const started = await provider.startSale({ attemptId: id, amountMinor: args.amountMinor, tipMinor: tip, currency, terminalId: args.terminalId ?? null, idempotencyKey: id });
    db().prepare('UPDATE card_attempts SET provider_reference = ?, updated_at = ? WHERE id = ?').run(started.providerReference, now(), id);
  } catch (error) {
    const offline = error instanceof CardProviderError && error.kind === 'offline';
    setState(id, 'failed', { state: 'failed', message: error instanceof Error ? error.message : 'The card terminal could not be reached.' });
    if (!offline) console.error('[Card] startSale failed:', error);
    throw new CardError(offline ? (error as Error).message : 'The card terminal could not be started. Nothing was charged.', 502, offline ? 'terminal_offline' : 'provider_error');
  }
  recordAuditEvent({ type: 'card.attempt_started', actor: { userId: args.userId ?? null }, entity: { type: 'card_attempt', id }, summary: `Card payment of ${args.amountMinor} ${currency} minor units sent to the terminal`, metadata: { amount_minor: args.amountMinor, tip_minor: tip, provider: provider.id, bill_id: args.billId ?? null } });
  return getAttempt(id)!;
}

/** Ask the provider where an attempt is. Safe to call repeatedly; final states are never changed. */
export async function refreshAttempt(id: string): Promise<CardAttemptRow> {
  const a = getAttempt(id);
  if (!a) throw new CardError('Card attempt not found', 404);
  if (a.state !== 'pending' || !a.provider_reference) return a;
  const provider = requireProvider();
  let outcome: CardOutcome;
  try {
    outcome = await provider.getStatus(a.provider_reference);
  } catch (error) {
    // Cannot reach the provider: stay pending (the cashier may retry or cancel) unless the attempt has expired.
    if (new Date(a.expires_at).getTime() > Date.now()) return a;
    outcome = { state: 'pending' };
  }
  if (outcome.state === 'pending' && new Date(a.expires_at).getTime() <= Date.now()) {
    // Abandoned. Try to cancel at the terminal; if the customer paid in the meantime we keep that approval.
    try { outcome = await provider.cancel(a.provider_reference); } catch { outcome = { state: 'pending' }; }
    if (outcome.state === 'pending' || outcome.state === 'cancelled') outcome = { state: 'timed_out', message: 'The customer did not use the terminal in time.' };
  }
  if (outcome.state !== 'pending') {
    setState(id, outcome.state, outcome);
    const after = getAttempt(id)!;
    if (after.state === 'approved') {
      recordAuditEvent({ type: 'card.attempt_approved', actor: { userId: a.created_by }, entity: { type: 'card_attempt', id }, summary: `Card payment approved by ${a.provider}`, metadata: { amount_minor: a.amount_minor, provider: a.provider, scheme: after.card_scheme, last4: after.card_last4 } });
    }
    return after;
  }
  return getAttempt(id)!;
}

export async function cancelAttempt(id: string, userId?: string | null): Promise<CardAttemptRow> {
  const a = getAttempt(id);
  if (!a) throw new CardError('Card attempt not found', 404);
  if (a.state !== 'pending') return a;
  if (a.provider_reference) {
    let outcome: CardOutcome;
    try { outcome = await requireProvider().cancel(a.provider_reference); }
    catch { throw new CardError('The terminal could not be reached to cancel. Cancel on the terminal itself, then check again.', 502, 'cancel_failed'); }
    setState(id, outcome.state === 'pending' ? 'cancelled' : outcome.state, outcome);
  } else {
    setState(id, 'cancelled', { state: 'cancelled' });
  }
  const after = getAttempt(id)!;
  recordAuditEvent({ type: 'card.attempt_cancelled', actor: { userId: userId ?? null }, entity: { type: 'card_attempt', id }, summary: `Card payment ${after.state === 'cancelled' ? 'cancelled' : `ended as ${after.state}`} by the cashier`, metadata: { state: after.state } });
  return after;
}

// ─── Used inside the payment transaction (synchronous) ──────────────────────────────

export interface ConsumeExpectation { billId: number | string; amountMinor?: number | null; }

/** Validates an approved attempt for a payment line. Throws a 4xx CardError when it cannot be used. */
export function consumeApprovedAttempt(id: string, expect: ConsumeExpectation): CardAttemptRow {
  const a = getAttempt(id);
  if (!a || a.kind !== 'sale') throw new CardError('Unknown card payment. Take the card payment again.', 400, 'attempt_unknown');
  if (a.state === 'consumed') throw new CardError('This card payment has already been used.', 409, 'attempt_used');
  if (a.state !== 'approved') throw new CardError(`This card payment is not approved (${a.state}).`, 409, 'attempt_not_approved');
  if (a.bill_id != null && String(a.bill_id) !== String(expect.billId)) throw new CardError('This card payment belongs to a different bill.', 409, 'attempt_other_bill');
  if (expect.amountMinor != null && expect.amountMinor !== a.amount_minor) throw new CardError('The amount does not match what the customer approved on the terminal.', 409, 'attempt_amount');
  return a;
}

export function markAttemptConsumed(id: string, paymentId: string): void {
  const r = db().prepare("UPDATE card_attempts SET state = 'consumed', consumed_payment_id = ?, bill_id = COALESCE(bill_id, (SELECT bill_id FROM payments WHERE id = ?)), updated_at = ? WHERE id = ? AND state = 'approved'")
    .run(paymentId, paymentId, now(), id);
  if (r.changes !== 1) throw new CardError('This card payment has already been used.', 409, 'attempt_used');
}

// ─── Provider refunds ─────────────────────────────────────────────────────────────

export function attemptForPayment(paymentId: string): CardAttemptRow | null {
  return (db().prepare("SELECT * FROM card_attempts WHERE kind = 'sale' AND consumed_payment_id = ?").get(paymentId) as CardAttemptRow | undefined) ?? null;
}

/**
 * Sends a refund to the provider and records it. Idempotent: the key is derived from the payment and how much
 * of it has already been refunded, so repeating the call after a failure never refunds the customer twice.
 */
export async function refundOnProvider(args: { paymentId: string; amountMinor: number; alreadyRefundedMinor: number; currency: string; userId?: string | null }): Promise<{ refundReference: string; attemptId: string }> {
  const sale = attemptForPayment(args.paymentId);
  if (!sale || !sale.provider_reference) throw new CardError('This card payment has no provider record to refund against.', 409, 'no_provider_record');
  const provider = requireProvider();
  if (provider.id !== sale.provider) throw new CardError(`This card was taken through ${sale.provider}; switch back to that provider to refund it.`, 409, 'provider_mismatch');
  const key = `refund:${args.paymentId}:${args.alreadyRefundedMinor}:${args.amountMinor}`;
  let ref: string;
  try {
    ref = (await provider.refund({ providerReference: sale.provider_reference, amountMinor: args.amountMinor, currency: args.currency, idempotencyKey: key })).refundReference;
  } catch (error) {
    const rejected = error instanceof CardProviderError && error.kind === 'rejected';
    if (!rejected) console.error('[Card] provider refund failed:', error);
    throw new CardError(rejected ? (error as Error).message : 'The card provider could not be reached. Nothing was refunded.', 502, 'provider_refund_failed');
  }
  const existing = db().prepare("SELECT id FROM card_attempts WHERE kind = 'refund' AND provider = ? AND provider_reference = ?").get(provider.id, ref) as { id: string } | undefined;
  if (existing) return { refundReference: ref, attemptId: existing.id };
  const id = ulid(); const t = now();
  db().prepare(`INSERT INTO card_attempts (id, kind, provider, simulated, bill_id, amount_minor, tip_minor, currency, state, provider_reference, parent_payment_id, created_by, created_at, updated_at, expires_at, organization_id, location_id)
    VALUES (?, 'refund', ?, ?, ?, ?, 0, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, provider.id, provider.simulated ? 1 : 0, sale.bill_id, args.amountMinor, args.currency, ref, args.paymentId, args.userId ?? null, t, t, t,
      getOrganizationContext()?.id ?? null, getLocationContext()?.id ?? null);
  return { refundReference: ref, attemptId: id };
}

export function markRefundConsumed(providerReference: string, refundId: string): void {
  db().prepare("UPDATE card_attempts SET state = 'consumed', consumed_refund_id = ?, updated_at = ? WHERE kind = 'refund' AND provider_reference = ? AND state = 'approved'")
    .run(refundId, now(), providerReference);
}

// ─── Reconciliation ─────────────────────────────────────────────────────────────────

export interface OrphanAttempt { id: string; kind: 'sale' | 'refund'; amount_minor: number; currency: string; provider: string; simulated: boolean; provider_reference: string | null; bill_id: number | null; created_at: string; reason: string; }

/** Approved by the provider but never turned into a payment/refund: money moved, the till has no record. */
export function listOrphanAttempts(): OrphanAttempt[] {
  const rows = db().prepare("SELECT * FROM card_attempts WHERE state = 'approved' AND updated_at <= datetime('now', ?) ORDER BY created_at").all(`-${Math.round(ORPHAN_AFTER_MS / 1000)} seconds`) as CardAttemptRow[];
  return rows.map((a) => ({
    id: a.id, kind: a.kind, amount_minor: a.amount_minor, currency: a.currency, provider: a.provider, simulated: !!a.simulated,
    provider_reference: a.provider_reference, bill_id: a.bill_id, created_at: a.created_at,
    reason: a.kind === 'sale'
      ? 'The customer was charged on the terminal but no payment was recorded on the till. Check the terminal receipt, then record the payment or refund the customer.'
      : 'The provider refunded the customer but the till has no matching refund. Record the refund on the bill.',
  }));
}

/** Payments taken through a provider whose attempt is missing, or whose amount disagrees with the attempt. */
export function listCardMismatches(): { payment_id: string; bill_id: number; amount_minor: number; reason: string }[] {
  const out: { payment_id: string; bill_id: number; amount_minor: number; reason: string }[] = [];
  const rows = db().prepare("SELECT id, bill_id, amount_minor FROM payments WHERE adapter = 'card_terminal'").all() as { id: string; bill_id: number; amount_minor: number }[];
  for (const p of rows) {
    const a = attemptForPayment(p.id);
    if (!a) out.push({ payment_id: p.id, bill_id: p.bill_id, amount_minor: p.amount_minor, reason: 'No provider approval is on record for this card payment.' });
    else if (a.amount_minor !== p.amount_minor) out.push({ payment_id: p.id, bill_id: p.bill_id, amount_minor: p.amount_minor, reason: 'The payment amount differs from what the terminal approved.' });
  }
  return out;
}
