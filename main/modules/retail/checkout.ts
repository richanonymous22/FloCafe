/**
 * Retail checkout (Milestone 3, Part B5).
 *
 *     Barcode/Search → Product/Variant → Cart → SaleService → Bill →
 *     PaymentService → Receipt
 *
 * This is a thin orchestration over three already-tested Core/near-Core
 * entry points, run as three sequential top-level transactions — exactly
 * the sequence the existing hospitality UI already drives across three HTTP
 * requests (`POST /orders`, `POST /bills/generate`, `POST /bills/:id/payment`).
 * Nothing here is a new kind of transaction; this just does the same three
 * commits in one server-side call instead of three client round-trips.
 *
 * Deliberately uses `channel: 'in_store'` and never sets `tableId`, so the
 * hospitality hook registered in main/modules/hospitality/hooks.ts finds
 * nothing to occupy and does nothing — this checkout has no hospitality
 * concept anywhere in its call path. See
 * docs/MILESTONE_3_VERTICALS_AND_RETAIL.md § Retail checkout.
 */

import { createSale, SaleLineInput } from '../../core/sale';
import { generateBillForOrder } from '../../routes/bills';
import { tender, PaymentAdapterId } from '../../core/payment';
import { minorUnitExponent, toMinor } from '../../core/money';
import { getDatabase, now, getSettingValue } from '../../db';
import { RetailError } from './variants';

export interface RetailCheckoutTender {
  adapter: PaymentAdapterId;
  method: string;
  tenderedMinor?: number;
  providerReference?: string | null;
  notes?: string | null;
}

export interface RetailCheckoutInput {
  lines: SaleLineInput[];
  cashierUserId: string;
  customerId?: string | number | null;
  tender: RetailCheckoutTender;
  idempotency?: { key: string; requestHash: string } | null;
}

export interface RetailCheckoutResult {
  sale: any;
  lines: any[];
  bill: any;
  payment: any;
}

/**
 * Marks the bill paid from a `tender()` result. `tender()` itself
 * deliberately does not touch `bills.paid_amount`/`payment_status` (see
 * main/core/payment.ts's module docstring and
 * docs/MILESTONE_2_CORE_ENGINE.md § 5.3) — that reconciliation is bespoke to
 * `applyPaymentBatch` and was not reimplemented there. Retail checkout is a
 * brand-new path with no legacy behaviour to preserve, so it does this
 * reconciliation itself rather than inheriting the gap: it is the first
 * caller of `tender()` in production, and it owns the resulting bill's
 * bookkeeping.
 */
function markBillPaidFromPayment(billId: number, amountMinor: number, exponent: number): any {
  const db = getDatabase();
  const amount = amountMinor / Math.pow(10, exponent);
  db.prepare(`
    UPDATE bills SET paid_amount = paid_amount + ?, balance = MAX(0, balance - ?),
      payment_status = CASE WHEN MAX(0, balance - ?) <= 0 THEN 'paid' ELSE 'partial' END,
      updated_at = ?
    WHERE id = ?
  `).run(amount, amount, amount, now(), billId);
  return db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
}

export function checkout(input: RetailCheckoutInput): RetailCheckoutResult {
  if (!input.lines || input.lines.length === 0) {
    throw new RetailError('At least one item is required');
  }
  if (!input.tender || !input.tender.adapter) {
    throw new RetailError('A tender is required');
  }

  const saleResult = createSale({
    channel: 'in_store',
    lines: input.lines,
    cashierUserId: input.cashierUserId,
    customerId: input.customerId ?? null,
    tableId: null,
    idempotency: input.idempotency ? { ...input.idempotency, userId: input.cashierUserId } : null,
  });

  const { bill } = generateBillForOrder(saleResult.sale.id);

  // Same fallback main/core/payment.ts's dual-write already uses, so one
  // install never sees two different default currencies across its two
  // payment paths.
  const currency = (getSettingValue('currency') || 'INR').toUpperCase();
  const exponent = minorUnitExponent(currency);
  const amountMinor = toMinor(bill.balance ?? bill.total, exponent);

  const tenderResult = tender({
    billId: bill.id,
    orderId: saleResult.sale.id,
    tender: {
      adapter: input.tender.adapter,
      method: input.tender.method,
      amountMinor,
      currency,
      tenderedMinor: input.tender.tenderedMinor,
      providerReference: input.tender.providerReference,
      notes: input.tender.notes,
    },
    actorUserId: input.cashierUserId,
  });

  const paidBill = tenderResult.idempotentReplay
    ? bill
    : markBillPaidFromPayment(bill.id, amountMinor, exponent);

  return {
    sale: saleResult.sale,
    lines: saleResult.lines,
    bill: paidBill,
    payment: tenderResult.payment,
  };
}
