/**
 * Card-terminal provider contract.
 *
 * A provider is the one place that knows how to talk to a payment company. Everything above it (the attempt
 * ledger, the till, refunds, reconciliation) is provider-neutral, so adding a real provider means writing one
 * file that implements `CardProvider` and registering it - nothing else changes.
 *
 * Rules every provider must follow:
 *  - `startSale` and `refund` take an idempotency key and must be safe to repeat with the same key.
 *  - `getStatus` is the only way an attempt becomes `approved`. A till never marks a card as paid itself.
 *  - Never put a full card number, CVV or track data in any field; only scheme and last four digits.
 */

export type CardAttemptState = 'pending' | 'approved' | 'declined' | 'cancelled' | 'timed_out' | 'failed' | 'consumed';

export interface CardTerminalInfo {
  id: string;
  label: string;
  online: boolean;
}

export interface StartSaleInput {
  /** Our attempt id; the provider echoes it back so a result can always be traced to an attempt. */
  attemptId: string;
  amountMinor: number;
  tipMinor: number;
  currency: string;
  terminalId: string | null;
  idempotencyKey: string;
}

export interface StartSaleResult {
  /** The provider's own id for the transaction, used for status checks, cancels and refunds. */
  providerReference: string;
}

export interface CardOutcome {
  state: 'pending' | 'approved' | 'declined' | 'cancelled' | 'timed_out' | 'failed';
  providerReference?: string;
  authCode?: string;
  scheme?: string;
  last4?: string;
  /** A short message the cashier can act on. Never contains card data. */
  message?: string;
}

export interface ProviderRefundInput {
  providerReference: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
}

export interface ProviderRefundResult {
  refundReference: string;
}

export class CardProviderError extends Error {
  constructor(message: string, readonly kind: 'offline' | 'rejected' | 'unknown' = 'unknown') {
    super(message);
    this.name = 'CardProviderError';
  }
}

export interface CardProvider {
  id: string;
  label: string;
  /** True for a built-in test double. The till shows this to the cashier and receipts say so. */
  simulated: boolean;
  listTerminals(): Promise<CardTerminalInfo[]>;
  startSale(input: StartSaleInput): Promise<StartSaleResult>;
  getStatus(providerReference: string): Promise<CardOutcome>;
  cancel(providerReference: string): Promise<CardOutcome>;
  refund(input: ProviderRefundInput): Promise<ProviderRefundResult>;
}
