/**
 * Loyalty tiers — derived from authoritative lifetime spend against
 * configurable thresholds (Meridian integration). Tiers are computed
 * server-side and never asserted by the client.
 */
import { getSettingValue } from '../db';

export type LoyaltyTier = 'bronze' | 'silver' | 'gold';

export interface TierConfig { silver: number; gold: number }

export function getTierConfig(): TierConfig {
  const silver = Number(getSettingValue('loyalty_tier_silver_spend'));
  const gold = Number(getSettingValue('loyalty_tier_gold_spend'));
  return {
    silver: Number.isFinite(silver) && silver > 0 ? silver : 120,
    gold: Number.isFinite(gold) && gold > 0 ? gold : 300,
  };
}

/** Bronze by default, Silver/Gold once lifetime spend crosses each threshold. */
export function tierForSpend(spend: number, config?: TierConfig): LoyaltyTier {
  const c = config || getTierConfig();
  const s = Number(spend) || 0;
  if (s >= c.gold) return 'gold';
  if (s >= c.silver) return 'silver';
  return 'bronze';
}
