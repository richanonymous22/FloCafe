/**
 * Plemmo Core — RefundService (till refund composition).
 *
 * `refundPayment()` (core/payment.ts) is the authoritative money operation: it
 * writes an immutable `refunds` row, advances the payment, optionally returns
 * stock through the inventory ledger, and audits. It works on ONE payment. A
 * till refunds a BILL, which can be paid by several tenders, and a refund has
 * effects beyond the payment row (cash leaving the drawer, a wallet tender
 * going back to the wallet, cashback earned on the sale being taken back).
 *
 * This module composes those without re-implementing any of them:
 *
 *     refundBill()
 *       ├─ refundPayment()          one per tender touched (newest first)
 *       ├─ recordCashRefundForPayment()   cash tenders → drawer movement
 *       ├─ wallet credit            wallet tenders → loyalty_ledger credit
 *       ├─ cashback clawback        proportional debit of the earned credit
 *       └─ bill.refunded audit      who asked, who approved, what moved
 *
 * The original sale, bill and payments are never rewritten: a refund only ever
 * ADDS rows (refunds, payment_events, inventory movements, cash movements,
 * ledger entries). `payments.refunded_minor`/`state` advance as they always
 * did.
 *
 * Everything runs in one transaction; any failure rolls the whole refund back.
 */
import { getDatabase, now, withTxn } from '../db';
import { minorUnitExponent, toMinor } from './money';
import { allocate, refundBuckets } from './vat-buckets';
import { recordAuditEvent } from './audit';
import { getCurrentLocationId } from './location';
import { recordCashRefundForPayment } from './cash';
import { getOrderItemReturnState } from './inventory';
import { PaymentError, PaymentRecord, RefundRecord, refundPayment } from './payment';

export interface RefundBillItemInput {
  orderItemId: number | string;
  /** Units of this line coming back. */
  quantity: number;
  /** Put the units back in stock (default true). Money-only returns (damaged goods) pass false. */
  restock?: boolean;
}

export interface RefundBillInput {
  billId: number | string;
  /** Minor units. Omit to refund everything still refundable on the bill. */
  amountMinor?: number | null;
  reason: string;
  /** Lines coming back. Omit for a money-only refund. */
  items?: RefundBillItemInput[] | null;
  /**
   * Size the refund from `items` (their share of what the customer actually paid, after any
   * discount) instead of `amountMinor`. Not available on split checks.
   */
  amountFromItems?: boolean;
  /** The user who approved the refund (the caller, or the manager whose PIN was entered). */
  approvedByUserId: string;
  /** The authenticated user who asked for it. */
  requestedByUserId: string;
  /** Work out which tenders would be touched and stop, writing nothing (used to refund cards at the provider first). */
  dryRun?: boolean;
  /** Provider refunds already made, by payment id. Required for every card_terminal tender the refund touches. */
  providerRefunds?: Record<string, string>;
}

export interface RefundAllocation {
  payment_id: string;
  adapter: string;
  amount_minor: number;
  already_refunded_minor: number;
  currency: string;
}

export interface RefundBillResult {
  bill_id: number;
  amount_minor: number;
  currency: string;
  refunds: RefundRecord[];
  payments: PaymentRecord[];
  fully_refunded: boolean;
  refundable_remaining_minor: number;
  restocked: { order_item_id: number; quantity: number }[];
  lines: { order_item_id: number; quantity: number; amount_minor: number; restocked: boolean }[];
  cash_drawer_recorded: boolean;
  loyalty_points_reversed: number;
  wallet_points_returned: number;
  idempotentReplay: boolean;
  /** Which tenders the money goes back to, in order. */
  allocations?: RefundAllocation[];
}

const REFUNDABLE_STATES = ['captured', 'settled', 'refunded'];
// Wallet/cashback points are whole cents of the bill currency (see
// LOYALTY_REDEMPTION_RATE in routes/bills.ts: 1 currency unit = 100 points).
const WALLET_POINTS_PER_MINOR = 1;

function refundableOf(p: PaymentRecord): number {
  return Math.max(0, p.amount_minor - p.refunded_minor);
}

const GONE_LINE_STATUSES = ['cancelled', 'voided', 'void_adjustment'];

export interface RefundableLine {
  order_item_id: number;
  name: string;
  quantity: number;
  refunded_quantity: number;
  refundable_quantity: number;
  /** What one returned unit is worth: its share of the bill total, after discount, tax and rounding. */
  unit_refund_minor: number;
}

/**
 * The lines of a bill's order with how many units have already come back, and what a returned
 * unit refunds. A line's value is its share of the amount the customer actually paid
 * (`bills.total`), so an order-level discount or payable rounding is carried through.
 */
export function listRefundableLines(billId: number | string): RefundableLine[] {
  const db = getDatabase();
  const bill = db.prepare('SELECT id, order_id, total FROM bills WHERE id = ?').get(billId) as { id: number; order_id: number; total: number } | undefined;
  if (!bill) return [];
  const exponent = minorUnitExponent((db.prepare("SELECT value FROM settings WHERE key = 'currency'").get() as { value?: string } | undefined)?.value);
  const lines = (db.prepare(
    `SELECT id, product_name, quantity, total FROM order_items WHERE order_id = ? AND status NOT IN (${GONE_LINE_STATUSES.map(() => '?').join(',')}) ORDER BY id`,
  ).all(bill.order_id, ...GONE_LINE_STATUSES)) as { id: number; product_name: string; quantity: number; total: number }[];
  const billMinor = toMinor(bill.total || 0, exponent);
  const sumMinor = lines.reduce((s, l) => s + toMinor(l.total || 0, exponent), 0);
  const returned = new Map<number, number>();
  for (const r of db.prepare('SELECT order_item_id, SUM(quantity) AS q FROM refund_lines WHERE bill_id = ? GROUP BY order_item_id').all(bill.id) as { order_item_id: number; q: number }[]) {
    returned.set(r.order_item_id, r.q);
  }
  return lines.map((l) => {
    const got = returned.get(l.id) || 0;
    const qty = Number(l.quantity) || 0;
    const unit = sumMinor > 0 && qty > 0 ? Math.round((billMinor * toMinor(l.total || 0, exponent)) / (qty * sumMinor)) : 0;
    return { order_item_id: l.id, name: l.product_name, quantity: qty, refunded_quantity: got, refundable_quantity: Math.max(0, qty - got), unit_refund_minor: unit };
  });
}

export function listBillPayments(billId: number | string): PaymentRecord[] {
  return getDatabase().prepare(
    `SELECT * FROM payments WHERE bill_id = ? ORDER BY requested_at DESC, created_at DESC, id DESC`,
  ).all(billId) as PaymentRecord[];
}

export function refundBill(input: RefundBillInput): RefundBillResult {
  const db = getDatabase();
  const reason = String(input.reason || '').trim();
  if (!reason) throw new PaymentError('A refund reason is required', 400);
  if (reason.length > 200) throw new PaymentError('Refund reason must be 200 characters or fewer', 400);

  return withTxn(() => {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(input.billId) as
      { id: number; order_id: number; customer_id: string | null; bill_number: string } | undefined;
    if (!bill) throw new PaymentError('Bill not found', 404);

    const payments = listBillPayments(bill.id).filter((p) => REFUNDABLE_STATES.includes(p.state));
    const totalRefundable = payments.reduce((sum, p) => sum + refundableOf(p), 0);
    if (totalRefundable <= 0) throw new PaymentError('Nothing left to refund on this bill', 400);

    // Lines coming back: validated against what was sold and what already came back.
    const refundable = listRefundableLines(bill.id);
    const lineOf = new Map(refundable.map((l) => [l.order_item_id, l]));
    const wanted: { orderItemId: number; quantity: number; restock: boolean }[] = [];
    for (const item of input.items || []) {
      const orderItemId = Number(item.orderItemId);
      if (!Number.isInteger(orderItemId) || orderItemId <= 0) throw new PaymentError('Invalid order item in refund', 400);
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new PaymentError('Returned quantity must be a positive whole number', 400);
      const line = lineOf.get(orderItemId);
      if (!line) throw new PaymentError(`Order item ${orderItemId} is not part of this bill`, 400);
      if (item.quantity > line.refundable_quantity) {
        throw new PaymentError(`Only ${line.refundable_quantity} of ${line.name} can still be returned`, 400);
      }
      if (wanted.some((w) => w.orderItemId === orderItemId)) throw new PaymentError(`Order item ${orderItemId} appears twice in the refund`, 400);
      wanted.push({ orderItemId, quantity: item.quantity, restock: item.restock !== false });
    }

    let amount: number;
    const lineAmounts = new Map<number, number>();
    if (input.amountFromItems) {
      if (!wanted.length) throw new PaymentError('Choose at least one item to refund', 400);
      if (db.prepare('SELECT 1 FROM bills WHERE order_id = ? AND split_group_id IS NOT NULL LIMIT 1').get(bill.order_id)) {
        throw new PaymentError('Item refunds are not available on a split check. Refund an amount instead.', 400);
      }
      amount = 0;
      for (const w of wanted) {
        const share = lineOf.get(w.orderItemId)!.unit_refund_minor * w.quantity;
        lineAmounts.set(w.orderItemId, share);
        amount += share;
      }
      // Returning every remaining unit of every line refunds exactly what is left
      // (per-unit rounding can otherwise strand a minor unit on the bill).
      const allBack = refundable.every((l) => l.refundable_quantity === 0 || (wanted.find((w) => w.orderItemId === l.order_item_id)?.quantity === l.refundable_quantity));
      if (allBack && Math.abs(totalRefundable - amount) <= refundable.length) amount = totalRefundable;
      if (amount > totalRefundable) amount = totalRefundable;
    } else {
      amount = input.amountMinor ?? totalRefundable;
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new PaymentError('Refund amount must be greater than zero', 400);
    }
    if (amount > totalRefundable) {
      throw new PaymentError(`Refund amount exceeds the unrefunded balance (${totalRefundable} minor units remaining)`, 400);
    }

    // Size the stock return BEFORE any money moves. Only lines that actually moved
    // tracked stock can return stock, and never more than is still returnable — a
    // repeat restock is silently a no-op rather than a second credit.
    const restockPlan: { orderItemId: number; quantity: number }[] = [];
    for (const w of wanted) {
      if (!w.restock) continue;
      const quantity = Math.min(w.quantity, getOrderItemReturnState(w.orderItemId).returnable);
      if (quantity > 0) restockPlan.push({ orderItemId: w.orderItemId, quantity });
    }

    const allocations: RefundAllocation[] = [];
    {
      let left = amount;
      for (const payment of payments) {
        if (left <= 0) break;
        const take = Math.min(refundableOf(payment), left);
        if (take <= 0) continue;
        allocations.push({ payment_id: payment.id, adapter: payment.adapter, amount_minor: take, already_refunded_minor: payment.refunded_minor, currency: payment.currency });
        left -= take;
      }
    }
    if (input.dryRun) {
      return {
        bill_id: bill.id, amount_minor: amount, currency: payments[0]?.currency || 'GBP', refunds: [], payments, fully_refunded: false,
        refundable_remaining_minor: totalRefundable - amount, restocked: [], lines: [], cash_drawer_recorded: false,
        loyalty_points_reversed: 0, wallet_points_returned: 0, idempotentReplay: false, allocations,
      } as RefundBillResult;
    }
    for (const a of allocations) {
      if (a.adapter === 'card_terminal' && !input.providerRefunds?.[a.payment_id]) {
        throw new PaymentError('A card payment can only be refunded through the card provider.', 409);
      }
    }

    const refunds: RefundRecord[] = [];
    const restocked: { order_item_id: number; quantity: number }[] = [];
    let cashRefundMinor = 0;
    let walletRefundMinor = 0;
    let remaining = amount;
    let firstRefund = true;
    for (const payment of payments) {
      if (remaining <= 0) break;
      const take = Math.min(refundableOf(payment), remaining);
      if (take <= 0) continue;
      const result = refundPayment({
        paymentId: payment.id,
        amountMinor: take,
        reason,
        actorUserId: input.approvedByUserId,
        providerReference: input.providerRefunds?.[payment.id] ?? null,
        // Stock is returned once, against the first tender touched.
        items: firstRefund && restockPlan.length
          ? restockPlan.map((r) => ({ orderItemId: r.orderItemId, quantity: r.quantity }))
          : null,
      });
      if (firstRefund) restockPlan.forEach((r) => restocked.push({ order_item_id: r.orderItemId, quantity: r.quantity }));
      firstRefund = false;
      refunds.push(result.refund);
      remaining -= take;
      if (payment.method === 'cash') cashRefundMinor += take;
      if (payment.method === 'wallet') walletRefundMinor += take;
    }

    // The refund's VAT, recorded with each refund row so the Z report can show VAT net of credit notes
    // without guessing: returned lines carry their own rate and VAT; an amount refund is spread over the
    // bill's rates in proportion. The operation is split across the tender rows by amount.
    {
      const fullBill = db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id) as any;
      const exp = minorUnitExponent((db.prepare("SELECT value FROM settings WHERE key = 'currency'").get() as { value?: string } | undefined)?.value);
      const buckets = refundBuckets(db, fullBill, exp, {
        amountMinor: amount,
        lines: wanted.map((w) => ({ orderItemId: w.orderItemId, quantity: w.quantity, amountMinor: lineAmounts.get(w.orderItemId) ?? 0 })),
      });
      const weights = refunds.map((r) => r.amount_minor);
      const perRow: { label: string; rate: number; gross_minor: number; vat_minor: number }[][] = refunds.map(() => []);
      for (const k of buckets) {
        const g = allocate(k.gross, weights);
        const v = allocate(k.vat, weights);
        refunds.forEach((_, i) => { if (g[i] || v[i]) perRow[i].push({ label: k.label, rate: k.rate, gross_minor: g[i], vat_minor: v[i] }); });
      }
      const setMeta = db.prepare('UPDATE refunds SET metadata = ? WHERE id = ?');
      refunds.forEach((r, i) => setMeta.run(JSON.stringify({ vat: perRow[i] }), r.id));
    }

    const recordedLines: RefundBillResult['lines'] = [];
    if (wanted.length && refunds.length) {
      const insert = db.prepare('INSERT INTO refund_lines (refund_id, bill_id, order_item_id, quantity, amount_minor, restocked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const w of wanted) {
        const stocked = restocked.find((r) => r.order_item_id === w.orderItemId)?.quantity ?? 0;
        const lineAmount = lineAmounts.get(w.orderItemId) ?? 0;
        insert.run(refunds[0].id, bill.id, w.orderItemId, w.quantity, lineAmount, stocked > 0 ? 1 : 0, now());
        recordedLines.push({ order_item_id: w.orderItemId, quantity: w.quantity, amount_minor: lineAmount, restocked: stocked > 0 });
      }
    }

    const location = getCurrentLocationId();
    const cashDrawerRecorded = cashRefundMinor > 0
      ? recordCashRefundForPayment({ locationId: location, amountMinor: cashRefundMinor, actorUserId: input.approvedByUserId, reference: String(bill.id), reason })
      : false;

    // Wallet tenders go back to the wallet; cashback earned on the sale is taken
    // back in proportion to how much of the sale has now been refunded.
    const changedAt = now();
    let walletPointsReturned = 0;
    let loyaltyPointsReversed = 0;
    if (bill.customer_id) {
      if (walletRefundMinor > 0) {
        walletPointsReturned = walletRefundMinor * WALLET_POINTS_PER_MINOR;
        db.prepare(`INSERT INTO loyalty_ledger (customer_id, bill_id, type, amount, description, created_at, updated_at) VALUES (?, ?, 'credit', ?, ?, ?, ?)`)
          .run(bill.customer_id, bill.id, walletPointsReturned, `Refund to wallet for bill ${bill.bill_number}`, changedAt, changedAt);
      }
      const after = listBillPayments(bill.id).filter((p) => REFUNDABLE_STATES.includes(p.state));
      const paidMinor = after.reduce((s, p) => s + p.amount_minor, 0);
      const refundedMinor = after.reduce((s, p) => s + p.refunded_minor, 0);
      const earned = (db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM loyalty_ledger WHERE bill_id = ? AND type = 'credit' AND description LIKE 'Cashback%'`).get(bill.id) as { total: number }).total;
      const reversedAlready = (db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM loyalty_ledger WHERE bill_id = ? AND type = 'debit' AND description LIKE 'Cashback reversal%'`).get(bill.id) as { total: number }).total;
      if (earned > 0 && paidMinor > 0) {
        const target = Math.min(earned, Math.floor((earned * refundedMinor) / paidMinor));
        const delta = target - reversedAlready;
        if (delta > 0) {
          db.prepare(`INSERT INTO loyalty_ledger (customer_id, bill_id, type, amount, description, created_at, updated_at) VALUES (?, ?, 'debit', ?, ?, ?, ?)`)
            .run(bill.customer_id, bill.id, delta, `Cashback reversal for refund on bill ${bill.bill_number}`, changedAt, changedAt);
          loyaltyPointsReversed = delta;
        }
      }
    }

    const finalPayments = listBillPayments(bill.id);
    const refundableAfter = finalPayments.filter((p) => REFUNDABLE_STATES.includes(p.state)).reduce((s, p) => s + refundableOf(p), 0);
    const currency = finalPayments[0]?.currency || 'GBP';

    recordAuditEvent({
      type: 'bill.refunded',
      actor: { userId: input.approvedByUserId },
      entity: { type: 'bill', id: bill.id },
      summary: `Refund of ${amount} ${currency} minor units on bill ${bill.bill_number}: ${reason}`,
      metadata: {
        bill_id: bill.id, order_id: bill.order_id, amount_minor: amount, reason,
        requested_by: input.requestedByUserId, approved_by: input.approvedByUserId,
        refund_ids: refunds.map((r) => r.id), restocked, lines: recordedLines, amount_from_items: !!input.amountFromItems, cash_drawer_recorded: cashDrawerRecorded,
        loyalty_points_reversed: loyaltyPointsReversed, wallet_points_returned: walletPointsReturned,
        fully_refunded: refundableAfter === 0,
      },
    });

    return {
      bill_id: bill.id, amount_minor: amount, currency, refunds, payments: finalPayments,
      fully_refunded: refundableAfter === 0, refundable_remaining_minor: refundableAfter,
      restocked, lines: recordedLines, cash_drawer_recorded: cashDrawerRecorded,
      loyalty_points_reversed: loyaltyPointsReversed, wallet_points_returned: walletPointsReturned,
      idempotentReplay: false, allocations,
    };
  });
}
