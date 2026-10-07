/**
 * A card terminal simulator for development, tests and demonstrations. It is clearly labelled as simulated
 * everywhere it appears and is never offered in a release build (see `registry.ts`).
 *
 * The outcome is chosen by the pence part of the amount, like most provider test environments:
 *   .00-.04 and .08-.99  approved after `delayMs`
 *   .05                  declined (insufficient funds)
 *   .06                  never answers (the attempt times out)
 *   .07                  terminal offline (the sale cannot be started)
 * Refunds fail when the amount ends in .13.
 */
import { createHash } from 'crypto';
import { CardOutcome, CardProvider, CardProviderError, CardTerminalInfo, ProviderRefundInput, ProviderRefundResult, StartSaleInput, StartSaleResult } from './types';

interface SimSale { amountMinor: number; startedAt: number; cancelled: boolean; last4: string; }

export interface SimulatorOptions {
  delayMs?: number;
  now?: () => number;
}

export function createSimulatorProvider(options: SimulatorOptions = {}): CardProvider {
  const delayMs = options.delayMs ?? 1500;
  const clock = options.now ?? Date.now;
  const sales = new Map<string, SimSale>();
  const byKey = new Map<string, string>();
  const refunds = new Map<string, string>();

  const pence = (minor: number) => Math.abs(minor) % 100;

  return {
    id: 'simulator',
    label: 'Simulated card terminal',
    simulated: true,
    async listTerminals(): Promise<CardTerminalInfo[]> {
      return [{ id: 'sim-1', label: 'Simulated terminal 1', online: true }];
    },
    async startSale(input: StartSaleInput): Promise<StartSaleResult> {
      const known = byKey.get(input.idempotencyKey);
      if (known) return { providerReference: known };
      if (pence(input.amountMinor) === 7) throw new CardProviderError('The simulated terminal is offline.', 'offline');
      const ref = `sim_${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 16)}`;
      sales.set(ref, { amountMinor: input.amountMinor, startedAt: clock(), cancelled: false, last4: '4242' });
      byKey.set(input.idempotencyKey, ref);
      return { providerReference: ref };
    },
    async getStatus(providerReference: string): Promise<CardOutcome> {
      const sale = sales.get(providerReference);
      if (!sale) return { state: 'failed', providerReference, message: 'The terminal does not know this payment.' };
      if (sale.cancelled) return { state: 'cancelled', providerReference, message: 'Cancelled on the till.' };
      const p = pence(sale.amountMinor);
      if (p === 6) return { state: 'pending', providerReference, message: 'Waiting for the customer.' };
      if (clock() - sale.startedAt < delayMs) return { state: 'pending', providerReference, message: 'Customer is presenting their card.' };
      if (p === 5) return { state: 'declined', providerReference, message: 'Declined: insufficient funds.' };
      return { state: 'approved', providerReference, authCode: `S${providerReference.slice(-5).toUpperCase()}`, scheme: 'VISA', last4: sale.last4, message: 'Approved (simulated).' };
    },
    async cancel(providerReference: string): Promise<CardOutcome> {
      const sale = sales.get(providerReference);
      if (!sale) return { state: 'failed', providerReference, message: 'The terminal does not know this payment.' };
      const outcome = await this.getStatus(providerReference);
      // Once the customer has been approved or declined a cancel cannot undo it.
      if (outcome.state !== 'pending') return outcome;
      sale.cancelled = true;
      return { state: 'cancelled', providerReference, message: 'Cancelled on the till.' };
    },
    async refund(input: ProviderRefundInput): Promise<ProviderRefundResult> {
      const known = refunds.get(input.idempotencyKey);
      if (known) return { refundReference: known };
      if (pence(input.amountMinor) === 13) throw new CardProviderError('The simulated provider rejected this refund.', 'rejected');
      const ref = `simrf_${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 16)}`;
      refunds.set(input.idempotencyKey, ref);
      return { refundReference: ref };
    },
  };
}
