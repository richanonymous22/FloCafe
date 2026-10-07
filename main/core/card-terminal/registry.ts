/**
 * Which card provider this till uses. The choice is the `card_provider` setting ('none' by default).
 * The simulator is only offered outside release builds, in a PILOT installer (license-policy.json), or when
 * `PLEMMO_ALLOW_CARD_SIMULATOR=1` is set (used by demos and the test suite), so a merchant can never take "payments" through a test double.
 */
import { app } from 'electron';
import { getSettingValue } from '../../db';
import { getLicensePolicy } from '../license-policy';
import { createSimulatorProvider } from './simulator';
import { CardProvider } from './types';

const factories = new Map<string, () => CardProvider>();
const instances = new Map<string, CardProvider>();

export function registerCardProvider(id: string, factory: () => CardProvider): void {
  factories.set(id, factory);
  instances.delete(id);
}

export function simulatorAllowed(): boolean {
  if (process.env.PLEMMO_ALLOW_CARD_SIMULATOR === '1') return true;
  if (getLicensePolicy().allowCardSimulator) return true; // a pilot installer
  try { return !app.isPackaged; } catch { return process.env.NODE_ENV !== 'production'; }
}

registerCardProvider('simulator', () => createSimulatorProvider({ delayMs: Number(process.env.PLEMMO_CARD_SIMULATOR_DELAY_MS ?? 1500) }));

export function availableProviderIds(): string[] {
  return [...factories.keys()].filter((id) => id !== 'simulator' || simulatorAllowed());
}

export function activeProviderId(): string {
  const chosen = (getSettingValue('card_provider') || 'none').trim();
  return availableProviderIds().includes(chosen) ? chosen : 'none';
}

/** The provider in use, or null when cards are taken on a separate terminal and recorded by hand. */
export function getCardProvider(): CardProvider | null {
  const id = activeProviderId();
  if (id === 'none') return null;
  let inst = instances.get(id);
  if (!inst) { inst = factories.get(id)!(); instances.set(id, inst); }
  return inst;
}

export function resetCardProviders(): void { instances.clear(); }
