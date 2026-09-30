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
import { recordAuditEvent } from './audit';
import { getCurrentLocationId } from './location';
import { recordCashRefundForPayment } from './cash';
import { getOrderItemReturnState } from './inventory';
import { PaymentError, PaymentRecord, RefundRecord, refundPayment } from './payment';

export interface RefundBillItemInput {
  orderItemId: number | string;
  quantity: number;
}

export interface RefundBillInput {
  billId: number | string;
  /** Minor units. Omit to refund everything still refundable on the bill. */
  amountMinor?: number | null;
  reason: string;
  /** Lines physically returned to stock. Omit for a money-only refund. */
  items?: RefundBillItemInput[] | null;
  /** The user who approved the refund (the caller, or the manager whose PIN was entered). */
  approvedByUserId: string;
  /** The authenticated user who asked for it. */
  requestedByUserId: string;
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
  cash_drawer_recorded: boolean;
  loyalty_points_reversed: number;
  wallet_points_returned: number;
  idempotentReplay: boolean;
}

const REFUNDABLE_STATES = ['captured', 'settled', 'refunded'];
// Wallet/cashback points are whole cents of the bill currency (see
// LOYALTY_REDEMPTION_RATE in routes/bills.ts: 1 currency unit = 100 points).
const WALLET_POINTS_PER_MINOR = 1;

function refundableOf(p: PaymentRecord): number {
  return Math.max(0, p.amount_minor - p.refunded_minor);
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

    let amount = input.amountMinor ?? totalRefundable;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new PaymentError('Refund amount must be greater than zero', 400);
    }
    if (amount > totalRefundable) {
      throw new PaymentError(`Refund amount exceeds the unrefunded balance (${totalRefundable} minor units remaining)`, 400);
    }

    // Validate and size the stock return BEFORE any money moves.
    const restockPlan: { orderItemId: number; quantity: number }[] = [];
    for (const item of input.items || []) {
      const orderItemId = Number(item.orderItemId);
      if (!Number.isInteger(orderItemId) || orderItemId <= 0) throw new PaymentError('Invalid order item in refund', 400);
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new PaymentError('Returned quantity must be a positive whole number', 400);
      const line = db.prepare('SELECT id, quantity, order_id FROM order_items WHERE id = ?').get(orderItemId) as
        { id: number; quantity: number; order_id: number } | undefined;
      if (!line || line.order_id !== bill.order_id) throw new PaymentError(`Order item ${orderItemId} is not part of this bill`, 400);
      if (item.quantity > line.quantity) throw new PaymentError(`Returned quantity exceeds the quantity sold for item ${orderItemId}`, 400);
      // Only lines that actually moved tracked stock can return stock, and never
      // more than is still returnable — a repeat restock is silently a no-op
      // rather than a second credit.
      const quantity = Math.min(item.quantity, getOrderItemReturnState(orderItemId).returnable);
      if (quantity > 0) restockPlan.push({ orderItemId, quantity });
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
        refund_ids: refunds.map((r) => r.id), restocked, cash_drawer_recorded: cashDrawerRecorded,
        loyalty_points_reversed: loyaltyPointsReversed, wallet_points_returned: walletPointsReturned,
        fully_refunded: refundableAfter === 0,
      },
    });

    return {
      bill_id: bill.id, amount_minor: amount, currency, refunds, payments: finalPayments,
      fully_refunded: refundableAfter === 0, refundable_remaining_minor: refundableAfter,
      restocked, cash_drawer_recorded: cashDrawerRecorded,
      loyalty_points_reversed: loyaltyPointsReversed, wallet_points_returned: walletPointsReturned,
      idempotentReplay: false,
    };
  });
}
