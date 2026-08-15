/**
 * Plemmo Core — PaymentService.
 *
 * The abstraction and persistence layer for tenders. There are NO real
 * payment-provider integrations here — this module exists so the core sale
 * engine has a genuine seam to hang them off later, and so a payment has an
 * identity and a lifecycle instead of being a line in a JSON array.
 *
 *     SaleService
 *          ↓
 *     PaymentService        ← this file: state machine + persistence
 *          ↓
 *     PaymentAdapter        ← capture logic, one per tender kind
 *          ├── CashAdapter        (built here — settles immediately, locally)
 *          ├── WalletAdapter      (built here — internal loyalty debit, settles immediately)
 *          ├── ManualCardAdapter  (built here — cashier attestation, unverified)
 *          ├── TeyaAdapter        (later)
 *          ├── WorldpayAdapter    (later)
 *          ├── SumUpAdapter       (later)
 *          ├── Shift4Adapter      (later)
 *          └── ElavonAdapter      (later)
 *
 * The core sale engine must never know provider-specific details — it calls
 * `tender()` with an adapter id and a normalized request; everything else is
 * this module's problem.
 *
 * ## The one architectural rule this file exists to enforce
 *
 * "Recorded in the POS database" must NOT automatically mean "the external
 * card payment is definitely settled." Cash and an internal wallet debit can
 * settle immediately — there is no external party to wait on. A manually
 * entered card payment cannot: the cashier is attesting that a terminal
 * accepted it, and until a real provider integration confirms that
 * independently, that attestation is `captured`, not `settled`. See
 * `ManualCardAdapter` below.
 *
 * ## Relationship to the legacy payment path
 *
 * `main/routes/bills.ts`'s `applyPaymentBatch()` is the current, and for this
 * milestone the ONLY, way a real payment gets applied to a bill. It is
 * genuinely complex — idempotency, transaction-ref uniqueness, integer-cent
 * allocation across split tenders, wallet balance checks, cashback — and this
 * milestone's own rules say not to rewrite it. So it is not rewritten.
 *
 * Instead, `applyPaymentBatch()` gained ONE additive call —
 * `recordAppliedPaymentLine()` at the bottom of this file — right after it
 * has already decided each tender's final allocated amount and updated the
 * bill. That call persists the same outcome into the new `payments` /
 * `payment_events` tables: a dual write, not a replacement. It:
 *
 *   - inherits idempotency for free. Both of applyPaymentBatch's own replay
 *     paths (the idempotency-key check and the transaction-id-match check)
 *     return before this call is ever reached, so a genuine retry can never
 *     produce a duplicate `payments` row.
 *   - is authoritative and atomic as of SYNC-0. It originally swallowed all
 *     errors (best-effort), which made `payments`/`payment_events` an
 *     unreliable mirror — the Milestone 9A review's biggest sync blocker.
 *     It now runs inside `applyPaymentBatch`'s transaction and is allowed to
 *     throw, so a payment either lands in BOTH the legacy and new models or
 *     in NEITHER. See `recordAppliedPaymentLine`'s own docstring.
 *   - mirrors the legacy 2-decimal-currency assumption it is fed, on
 *     purpose. `applyPaymentBatch` computes amounts as integer *cents*
 *     unconditionally (`main/routes/bills.ts`'s `paymentAmountCents()`,
 *     `* 100` regardless of the tenant's actual currency exponent). That is
 *     a real latent bug for JPY/KWD-style currencies, and it is EXACTLY the
 *     class of bug `main/core/money.ts` exists to fix — but fixing it means
 *     changing `applyPaymentBatch`, which this milestone does not do. The
 *     dual-write stores what the legacy path actually computed, bug and all,
 *     so the new table is a truthful mirror of the old one. `tender()`
 *     below, the standalone entry point new code should use, is currency-
 *     exponent-correct from day one.
 *
 * `tender()` itself is a complete, tested, standalone entry point — the one
 * described in Part 13 as what a future retail checkout will call — but it
 * is deliberately NOT wired into any live HTTP route in this milestone.
 * Wiring it into `POST /bills/:id/payment(s)` would mean replacing
 * `applyPaymentBatch`'s validation and allocation logic, which is exactly
 * the rewrite this milestone avoids.
 */

import { getDatabase, getSettingValue, now, withTxn } from '../db';
import { recordAuditEvent } from './audit';
import { ulid } from './ids';
import { recordReturn as recordInventoryReturn } from './inventory';
import { getOrganizationContext, getLocationContext } from './context';
import { appendPaymentEventOutbox } from './sync/payment-events';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The full eventual lifecycle a payment or refund can move through. Not
 * every state is reachable yet — only the built-in adapters below decide
 * which ones are — but the type models the whole space a real provider
 * integration will need, so adding one later is not a type change.
 */
export type PaymentState =
  | 'requested'
  | 'authorized'
  | 'captured'
  | 'settled'
  | 'declined'
  | 'cancelled'
  | 'voided'
  | 'refunded'
  | 'failed';

/** Which capture logic handled a tender. Extend when a real provider adapter is built. */
export type PaymentAdapterId = 'cash' | 'wallet' | 'manual_card';

/** A failure the caller can map to a response. Mirrors SaleError in sale.ts. */
export class PaymentError extends Error {
  readonly statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'PaymentError';
    this.statusCode = statusCode;
  }
}

export interface TenderRequest {
  adapter: PaymentAdapterId;
  /** Human-facing label, e.g. 'cash', 'card', or a configured custom payment method name. */
  method: string;
  /** Already an integer number of minor units — see main/core/money.ts. Compute it before calling tender(). */
  amountMinor: number;
  currency: string;
  /** Cash only. */
  tenderedMinor?: number;
  /** An external reference — a card transaction id, a terminal receipt number. */
  providerReference?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PaymentAdapterResult {
  state: PaymentState;
  providerReference?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PaymentAdapter {
  id: PaymentAdapterId;
  /**
   * Attempt to capture funds for this tender. Adapters that settle
   * immediately with no external party (cash, an internal wallet debit)
   * return `settled`. Adapters that depend on an unverified external claim
   * return `captured`. A real provider adapter will be asynchronous and can
   * also return `declined`/`failed` — nothing here does yet.
   */
  capture(tender: TenderRequest): PaymentAdapterResult;
}

/** The persisted payment. Mirrors the `payments` row. */
export interface PaymentRecord {
  id: string;
  bill_id: number;
  order_id: number | null;
  adapter: PaymentAdapterId;
  method: string;
  state: PaymentState;
  amount_minor: number;
  currency: string;
  refunded_minor: number;
  tendered_minor: number | null;
  change_minor: number | null;
  provider_reference: string | null;
  actor_user_id: string | null;
  requested_at: string;
  settled_at: string | null;
  voided_at: string | null;
  [column: string]: unknown;
}

/** The persisted refund. Mirrors the `refunds` row. */
export interface RefundRecord {
  id: string;
  payment_id: string;
  bill_id: number;
  amount_minor: number;
  currency: string;
  reason: string | null;
  state: 'requested' | 'settled' | 'failed';
  requested_at: string;
  settled_at: string | null;
  [column: string]: unknown;
}

/**
 * Transport-level replay protection, identical shape to SaleIdempotency in
 * sale.ts. Reuses the existing `payment_idempotency` table rather than
 * inventing a second mechanism — see the idempotency section below.
 */
export interface PaymentIdempotency {
  key: string;
  requestHash: string;
  userId: string;
}

// ─── Adapters ─────────────────────────────────────────────────────────────────

/**
 * Cash settles immediately and locally. There is no external party to wait
 * on — the money is in the drawer the moment it's counted.
 */
export const CashAdapter: PaymentAdapter = {
  id: 'cash',
  capture(tender) {
    return { state: 'settled', providerReference: tender.providerReference ?? null };
  },
};

/**
 * An internal loyalty-wallet debit. Like cash, this is fully in-process —
 * the balance check and the debit both happen inside Plemmo's own database,
 * so there is nothing to wait on and no uncertainty to represent.
 */
export const WalletAdapter: PaymentAdapter = {
  id: 'wallet',
  capture(tender) {
    return { state: 'settled', providerReference: tender.providerReference ?? null };
  },
};

/**
 * The cashier is attesting that an external card terminal accepted this
 * payment. Plemmo has NOT independently verified that with a provider, so
 * this lands on `captured`, not `settled` — see the module docstring for why
 * that distinction is the whole point of this file. A real provider adapter
 * (Teya, Worldpay, ...) will call back with an authoritative `settled` (or
 * `declined`/`failed`) once integrated; until then, this is as far as the
 * truth can honestly be pushed.
 */
export const ManualCardAdapter: PaymentAdapter = {
  id: 'manual_card',
  capture(tender) {
    return { state: 'captured', providerReference: tender.providerReference ?? null };
  },
};

const ADAPTERS: Record<PaymentAdapterId, PaymentAdapter> = {
  cash: CashAdapter,
  wallet: WalletAdapter,
  manual_card: ManualCardAdapter,
};

export function getPaymentAdapter(id: PaymentAdapterId): PaymentAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) throw new PaymentError(`Unknown payment adapter: ${id}`, 400);
  return adapter;
}

// ─── Idempotency (reuses the existing payment_idempotency table) ──────────────

interface StoredIdempotentResponse<T> {
  found: true;
  response: T;
}
interface NoStoredResponse {
  found: false;
}

/**
 * Reuses `payment_idempotency` exactly as `applyPaymentBatch()` does — same
 * table, same (user_id, idempotency_key) scoping, same replay-vs-conflict
 * rule. This is the "use existing idempotency tables/logic rather than
 * inventing a second mechanism" instruction taken literally: the table's
 * shape (user, key -> bill, hash, response) has nothing bill-payment-specific
 * about it, so `tender()`, `voidPayment()` and `refundPayment()` all share it.
 */
function checkIdempotency<T>(
  db: ReturnType<typeof getDatabase>,
  idempotency: PaymentIdempotency,
): StoredIdempotentResponse<T> | NoStoredResponse {
  const prior = db.prepare(`
    SELECT bill_id, request_hash, response_json
    FROM payment_idempotency
    WHERE user_id = ? AND idempotency_key = ?
  `).get(idempotency.userId, idempotency.key) as { bill_id: string; request_hash: string; response_json: string } | undefined;
  if (!prior) return { found: false };
  if (prior.request_hash !== idempotency.requestHash) {
    throw new PaymentError('Idempotency-Key was already used for a different request', 409);
  }
  try {
    return { found: true, response: JSON.parse(prior.response_json) as T };
  } catch {
    throw new PaymentError('Stored payment response is invalid', 500);
  }
}

function storeIdempotentResponse(
  db: ReturnType<typeof getDatabase>,
  idempotency: PaymentIdempotency,
  billId: number | string,
  response: unknown,
): void {
  db.prepare(`
    INSERT INTO payment_idempotency (user_id, idempotency_key, bill_id, request_hash, response_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(idempotency.userId, idempotency.key, String(billId), idempotency.requestHash, JSON.stringify(response), now());
}

// ─── Persistence ────────────────────────────────────────────────────────────

interface PersistPaymentInput {
  db: ReturnType<typeof getDatabase>;
  billId: number | string;
  orderId?: number | string | null;
  tender: TenderRequest;
  result: PaymentAdapterResult;
  actorUserId?: string | null;
}

/**
 * Resolves the global (ULID) identities of a bill and order from their local
 * integer keys. `orders`/`bills` carry a `uid` beside the integer PK (v69);
 * every current insert path populates it (SYNC-0 Part B), and any legacy row
 * that predates that is backfilled by migration, so a lookup here should
 * always find one — but this returns `null` rather than throwing if it does
 * not, so a payment is never blocked by a missing uid it can be given later.
 */
function resolveBillOrderUids(
  db: ReturnType<typeof getDatabase>,
  billId: number | string | null,
  orderId: number | string | null,
): { billUid: string | null; orderUid: string | null } {
  const billUid = billId != null
    ? (db.prepare('SELECT uid FROM bills WHERE id = ?').get(billId) as { uid: string | null } | undefined)?.uid ?? null
    : null;
  const orderUid = orderId != null
    ? (db.prepare('SELECT uid FROM orders WHERE id = ?').get(orderId) as { uid: string | null } | undefined)?.uid ?? null
    : null;
  return { billUid, orderUid };
}

/**
 * Insert a payment row and its first state-transition event. Low-level and
 * unexported — every write goes through `tender()` (new call sites) or
 * `recordAppliedPaymentLine()` (the legacy dual-write), which both add the
 * audit event and, for `tender()`, the idempotency record. Must run inside
 * the caller's transaction.
 */
function persistPayment(input: PersistPaymentInput): PaymentRecord {
  const { db, tender: t, result } = input;
  const id = ulid();
  const requestedAt = now();
  const settledAt = result.state === 'settled' ? requestedAt : null;
  // SYNC-0 (Part A6/B2): stamp the payment with the *global* identities of
  // its bill and order, resolved from the integer foreign keys. The integer
  // FKs stay for local joins; the uids are what a future sync engine keys
  // on, since integer PKs collide across devices.
  const { billUid, orderUid } = resolveBillOrderUids(db, input.billId, input.orderId ?? null);

  db.prepare(`
    INSERT INTO payments (
      id, bill_id, order_id, bill_uid, order_uid, adapter, method, state,
      amount_minor, currency, refunded_minor, tendered_minor, change_minor,
      provider_reference, actor_user_id, notes, metadata,
      requested_at, settled_at, created_at, updated_at, organization_id, location_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.billId, input.orderId ?? null, billUid, orderUid, t.adapter, t.method, result.state,
    t.amountMinor, t.currency, t.tenderedMinor ?? null,
    t.tenderedMinor !== undefined ? Math.max(0, t.tenderedMinor - t.amountMinor) : null,
    result.providerReference ?? null, input.actorUserId ?? null, t.notes ?? null,
    t.metadata || result.metadata ? JSON.stringify({ ...t.metadata, ...result.metadata }) : null,
    requestedAt, settledAt, requestedAt, requestedAt,
    getOrganizationContext()?.id ?? null, getLocationContext()?.id ?? null,
  );

  const peId = ulid();
  db.prepare(`
    INSERT INTO payment_events (id, payment_id, from_state, to_state, occurred_at, actor_user_id, metadata, created_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
  `).run(peId, id, result.state, requestedAt, input.actorUserId ?? null, null, requestedAt);
  appendPaymentEventOutbox(db, peId); // SYNC-D Part L — enqueue for sync (best-effort)

  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as PaymentRecord;
}

// ─── tender() — the standalone entry point ─────────────────────────────────

export interface TenderInput {
  billId: number | string;
  orderId?: number | string | null;
  tender: TenderRequest;
  actorUserId?: string | null;
  idempotency?: PaymentIdempotency | null;
}

export interface TenderResult {
  payment: PaymentRecord;
  idempotentReplay: boolean;
}

/**
 * Capture a tender and persist it. This is the entry point new code should
 * use — a future retail checkout, or a later migration of the bills.ts
 * payment routes — but it is NOT called from anywhere in this milestone; see
 * the module docstring for why. It does no allocation, no split-tender
 * handling, and no wallet-balance checking — a single tender for a single
 * amount, which is what an adapter-based flow naturally is. `applyPaymentBatch`
 * remains the only path that knows how to split one payment request across
 * several tender lines.
 */
export function tender(input: TenderInput): TenderResult {
  const db = getDatabase();
  if (!input.tender || typeof input.tender.amountMinor !== 'number' || !Number.isInteger(input.tender.amountMinor) || input.tender.amountMinor <= 0) {
    throw new PaymentError('Tender amount must be a positive integer number of minor units', 400);
  }
  if (!input.tender.currency) {
    throw new PaymentError('Tender currency is required', 400);
  }

  return withTxn(() => {
    if (input.idempotency) {
      const prior = checkIdempotency<TenderResult>(db, input.idempotency);
      if (prior.found) return { ...prior.response, idempotentReplay: true };
    }

    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(input.billId) as any;
    if (!bill) throw new PaymentError('Bill not found', 404);
    if (bill.payment_status === 'paid') throw new PaymentError('Bill is already paid', 400);

    const adapter = getPaymentAdapter(input.tender.adapter);
    const result = adapter.capture(input.tender);

    const payment = persistPayment({
      db, billId: input.billId, orderId: input.orderId ?? bill.order_id ?? null,
      tender: input.tender, result, actorUserId: input.actorUserId,
    });

    recordAuditEvent({
      type: 'payment.recorded',
      actor: { userId: input.actorUserId ?? null },
      entity: { type: 'payment', id: payment.id },
      summary: `${input.tender.adapter} tender of ${input.tender.amountMinor} ${input.tender.currency} minor units recorded (${result.state})`,
      metadata: {
        bill_id: Number(input.billId),
        adapter: input.tender.adapter,
        method: input.tender.method,
        amount_minor: input.tender.amountMinor,
        currency: input.tender.currency,
        state: result.state,
      },
    });

    const response: TenderResult = { payment, idempotentReplay: false };
    if (input.idempotency) {
      storeIdempotentResponse(db, input.idempotency, input.billId, response);
    }
    return response;
  });
}

// ─── voidPayment() ──────────────────────────────────────────────────────────

export interface VoidPaymentInput {
  paymentId: string;
  reason?: string | null;
  actorUserId?: string | null;
  idempotency?: PaymentIdempotency | null;
}

export interface VoidPaymentResult {
  payment: PaymentRecord;
  idempotentReplay: boolean;
}

/**
 * Void a payment that has not yet settled. Cash and wallet payments settle
 * the instant they're captured, so there is nothing physically meaningful
 * left to "void" — money already in the drawer is refunded, not voided. Only
 * a `requested` or `captured` payment (in practice, today, a manual card
 * entry the cashier wants to undo before it's treated as final) can be
 * voided.
 */
export function voidPayment(input: VoidPaymentInput): VoidPaymentResult {
  const db = getDatabase();
  return withTxn(() => {
    if (input.idempotency) {
      const prior = checkIdempotency<VoidPaymentResult>(db, input.idempotency);
      if (prior.found) return { ...prior.response, idempotentReplay: true };
    }

    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(input.paymentId) as PaymentRecord | undefined;
    if (!payment) throw new PaymentError('Payment not found', 404);
    if (!['requested', 'captured'].includes(payment.state)) {
      throw new PaymentError(`Cannot void a payment in state '${payment.state}' — settled payments must be refunded instead`, 400);
    }
    if (payment.refunded_minor > 0) {
      throw new PaymentError('Cannot void a payment that already has a refund recorded against it', 400);
    }

    const changedAt = now();
    db.prepare(`UPDATE payments SET state = 'voided', voided_at = ?, updated_at = ? WHERE id = ?`)
      .run(changedAt, changedAt, input.paymentId);
    const voidPeId = ulid();
    db.prepare(`
      INSERT INTO payment_events (id, payment_id, from_state, to_state, occurred_at, actor_user_id, reason, created_at)
      VALUES (?, ?, ?, 'voided', ?, ?, ?, ?)
    `).run(voidPeId, input.paymentId, payment.state, changedAt, input.actorUserId ?? null, input.reason ?? null, changedAt);
    appendPaymentEventOutbox(db, voidPeId); // SYNC-D Part L

    recordAuditEvent({
      type: 'payment.voided',
      actor: { userId: input.actorUserId ?? null },
      entity: { type: 'payment', id: input.paymentId },
      summary: `Payment ${input.paymentId} voided${input.reason ? `: ${input.reason}` : ''}`,
      metadata: { bill_id: payment.bill_id, from_state: payment.state, reason: input.reason ?? null },
    });

    const updated = db.prepare('SELECT * FROM payments WHERE id = ?').get(input.paymentId) as PaymentRecord;
    const response: VoidPaymentResult = { payment: updated, idempotentReplay: false };
    if (input.idempotency) {
      storeIdempotentResponse(db, input.idempotency, payment.bill_id, response);
    }
    return response;
  });
}

// ─── refundPayment() ────────────────────────────────────────────────────────

export interface RefundPaymentItemInput {
  /** An `order_items.id` — the specific line the returned quantity is credited against. */
  orderItemId: number | string;
  quantity: number;
}

export interface RefundPaymentInput {
  paymentId: string;
  /** Already an integer number of minor units. Must not exceed the amount still unrefunded. */
  amountMinor: number;
  reason?: string | null;
  actorUserId?: string | null;
  idempotency?: PaymentIdempotency | null;
  /**
   * Milestone 4: optional per-line quantities being returned. Omit for a
   * money-only refund with no stock effect — the exact behavior this
   * function always had before this milestone. When provided, each line's
   * quantity is credited back to inventory via
   * `InventoryService.recordReturn()`, which itself caps the total ever
   * returned against one order_item at the quantity that line actually
   * sold — see main/core/inventory.ts and
   * docs/MILESTONE_4_INVENTORY.md § Refund integration.
   */
  items?: RefundPaymentItemInput[] | null;
}

export interface RefundPaymentResult {
  refund: RefundRecord;
  payment: PaymentRecord;
  idempotentReplay: boolean;
}

/**
 * Refund all or part of a settled or captured payment.
 *
 * This is the CORE foundation the Milestone 2 doc's Part 8 asked for so a
 * later, dedicated RefundService can compose cleanly with InventoryService:
 * `RefundService -> InventoryService -> InventoryMovement`. As of Milestone
 * 4, a caller that knows which lines/quantities are being returned can pass
 * `items` and get that stock effect atomically with the financial refund;
 * a caller that doesn't (or a pure money adjustment with no matching stock
 * movement) omits it and nothing about inventory changes — same as before
 * this milestone.
 */
export function refundPayment(input: RefundPaymentInput): RefundPaymentResult {
  const db = getDatabase();
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new PaymentError('Refund amount must be a positive integer number of minor units', 400);
  }

  return withTxn(() => {
    if (input.idempotency) {
      const prior = checkIdempotency<RefundPaymentResult>(db, input.idempotency);
      if (prior.found) return { ...prior.response, idempotentReplay: true };
    }

    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(input.paymentId) as PaymentRecord | undefined;
    if (!payment) throw new PaymentError('Payment not found', 404);
    if (!['captured', 'settled', 'refunded'].includes(payment.state)) {
      throw new PaymentError(`Cannot refund a payment in state '${payment.state}'`, 400);
    }
    const refundable = payment.amount_minor - payment.refunded_minor;
    if (input.amountMinor > refundable) {
      throw new PaymentError(`Refund amount exceeds the unrefunded balance (${refundable} minor units remaining)`, 400);
    }

    const changedAt = now();
    const refundId = ulid();
    // SYNC-0 (Part A6/B2): a refund carries the global identities of the
    // payment (payment_id is already a ULID), bill, and order it reverses.
    // `payment.bill_uid`/`order_uid` were stamped when the payment was
    // persisted (or backfilled), so prefer them; fall back to a live lookup
    // for any payment row that predates the stamping.
    const refundBillUid = (payment as { bill_uid?: string | null }).bill_uid
      ?? resolveBillOrderUids(db, payment.bill_id, payment.order_id ?? null).billUid;
    const refundOrderUid = (payment as { order_uid?: string | null }).order_uid
      ?? resolveBillOrderUids(db, payment.bill_id, payment.order_id ?? null).orderUid;
    db.prepare(`
      INSERT INTO refunds (id, payment_id, bill_id, bill_uid, order_uid, amount_minor, currency, reason, state, actor_user_id, requested_at, settled_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?, ?, ?, ?, ?)
    `).run(refundId, input.paymentId, payment.bill_id, refundBillUid, refundOrderUid, input.amountMinor, payment.currency, input.reason ?? null, input.actorUserId ?? null, changedAt, changedAt, changedAt, changedAt);

    if (input.items && input.items.length > 0) {
      for (const item of input.items) {
        const orderItem = db.prepare('SELECT product_id, product_variant_id FROM order_items WHERE id = ?')
          .get(item.orderItemId) as { product_id: string; product_variant_id: string | null } | undefined;
        if (!orderItem) {
          throw new PaymentError(`Order item ${item.orderItemId} not found`, 404);
        }
        recordInventoryReturn({
          productId: orderItem.product_id,
          variantId: orderItem.product_variant_id,
          quantity: item.quantity,
          reason: input.reason,
          saleReferenceId: String(item.orderItemId),
          referenceType: 'payment_refund',
          referenceId: refundId,
          actorUserId: input.actorUserId,
        });
      }
    }

    const newRefundedMinor = payment.refunded_minor + input.amountMinor;
    const fullyRefunded = newRefundedMinor >= payment.amount_minor;
    const newState: PaymentState = fullyRefunded ? 'refunded' : payment.state;
    db.prepare(`UPDATE payments SET refunded_minor = ?, state = ?, updated_at = ? WHERE id = ?`)
      .run(newRefundedMinor, newState, changedAt, input.paymentId);

    if (newState !== payment.state) {
      const refundPeId = ulid();
      db.prepare(`
        INSERT INTO payment_events (id, payment_id, from_state, to_state, occurred_at, actor_user_id, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(refundPeId, input.paymentId, payment.state, newState, changedAt, input.actorUserId ?? null, input.reason ?? null, changedAt);
      appendPaymentEventOutbox(db, refundPeId); // SYNC-D Part L
    }

    recordAuditEvent({
      type: 'sale.refunded',
      actor: { userId: input.actorUserId ?? null },
      entity: { type: 'payment', id: input.paymentId },
      summary: `Refund of ${input.amountMinor} ${payment.currency} minor units recorded against payment ${input.paymentId}${input.reason ? `: ${input.reason}` : ''}`,
      metadata: {
        bill_id: payment.bill_id, refund_id: refundId, amount_minor: input.amountMinor,
        fully_refunded: fullyRefunded, reason: input.reason ?? null,
      },
    });

    const updatedPayment = db.prepare('SELECT * FROM payments WHERE id = ?').get(input.paymentId) as PaymentRecord;
    const refund = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId) as RefundRecord;
    const response: RefundPaymentResult = { refund, payment: updatedPayment, idempotentReplay: false };
    if (input.idempotency) {
      storeIdempotentResponse(db, input.idempotency, payment.bill_id, response);
    }
    return response;
  });
}

// ─── Queries ────────────────────────────────────────────────────────────────

export function getPayment(paymentId: string): PaymentRecord | null {
  const row = getDatabase().prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as PaymentRecord | undefined;
  return row ?? null;
}

export function listPaymentsForBill(billId: number | string): PaymentRecord[] {
  return getDatabase().prepare('SELECT * FROM payments WHERE bill_id = ? ORDER BY requested_at ASC').all(billId) as PaymentRecord[];
}

export function listPaymentEvents(paymentId: string): { id: string; from_state: string | null; to_state: string; occurred_at: string }[] {
  return getDatabase().prepare('SELECT * FROM payment_events WHERE payment_id = ? ORDER BY occurred_at ASC').all(paymentId) as any[];
}

export function listRefundsForPayment(paymentId: string): RefundRecord[] {
  return getDatabase().prepare('SELECT * FROM refunds WHERE payment_id = ? ORDER BY requested_at ASC').all(paymentId) as RefundRecord[];
}

// ─── Legacy dual-write ──────────────────────────────────────────────────────

export interface AppliedPaymentLine {
  method: string;
  paymentMethodId?: number | null;
  /** Integer cents as computed by applyPaymentBatch's own paymentAmountCents(). See the module docstring re: the 2-decimal assumption this inherits. */
  amountCents: number;
  tenderedCents?: number | null;
  changeCents?: number | null;
  transactionId?: string | null;
  notes?: string | null;
}

export interface RecordAppliedPaymentLineInput {
  billId: number | string;
  orderId: number | string | null;
  line: AppliedPaymentLine;
  actorUserId?: string | null;
}

/**
 * The dual-write hook called from `applyPaymentBatch()` in routes/bills.ts,
 * once per tender line it has just applied to a bill — see the module
 * docstring for the full reasoning. Must run inside the same transaction as
 * the legacy `bills.payment_details` write it mirrors.
 *
 * ## SYNC-0 change: this is now authoritative, not best-effort.
 *
 * Before SYNC-0 this function swallowed every error so a bug here could not
 * turn a successful cash payment into a failed HTTP request. That made
 * `payments`/`payment_events` an unreliable mirror — a payment could commit
 * to `payment_details` while its `payment_event` was silently lost, which
 * the Milestone 9A review identified as the single biggest sync blocker.
 *
 * It now runs inside `applyPaymentBatch`'s transaction and is allowed to
 * throw: if the authoritative payment model cannot record a payment, the
 * *entire* payment (including the `payment_details` write) rolls back, so a
 * merchant is never told a payment succeeded while the record of it is
 * incomplete. This is safe because the three local adapters
 * (cash/wallet/manual_card) are pure and `persistPayment` only touches the
 * local database inside the already-open transaction — it cannot fail on
 * valid input, and if it somehow does, failing loudly is correct.
 */
export function recordAppliedPaymentLine(input: RecordAppliedPaymentLineInput): void {
  const db = getDatabase();
  const currency = (getSettingValue('currency') || 'INR').toUpperCase();
  const adapter: PaymentAdapterId = input.line.method === 'cash' ? 'cash'
    : input.line.method === 'wallet' ? 'wallet'
    : 'manual_card';

  const tenderRequest: TenderRequest = {
    adapter,
    method: input.line.method,
    amountMinor: input.line.amountCents,
    currency,
    tenderedMinor: input.line.tenderedCents ?? undefined,
    providerReference: input.line.transactionId ?? null,
    notes: input.line.notes ?? null,
    metadata: input.line.paymentMethodId != null ? { payment_method_id: input.line.paymentMethodId } : null,
  };

  const result = getPaymentAdapter(adapter).capture(tenderRequest);
  const payment = persistPayment({
    db, billId: input.billId, orderId: input.orderId, tender: tenderRequest, result,
    actorUserId: input.actorUserId,
  });

  recordAuditEvent({
    type: 'payment.recorded',
    actor: { userId: input.actorUserId ?? null },
    entity: { type: 'payment', id: payment.id },
    summary: `${adapter} tender applied to bill ${input.billId} (${result.state})`,
    metadata: { bill_id: Number(input.billId), adapter, method: input.line.method, amount_minor: input.line.amountCents, currency, state: result.state },
  });
}
