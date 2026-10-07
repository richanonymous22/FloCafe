/**
 * Trading gate — selling needs a licence that is in force.
 *
 * Applies to the routes that create or extend a sale and take payment. It never touches reading data, reports,
 * Z reports, refunds, voids, backups or settings: a merchant whose licence lapsed must still be able to see
 * and export their records and put right what was rung up.
 *
 *   - A licence is cached on this device (it was activated): it must be effective (active, in its offline
 *     grace after expiry, or active-but-unverified). Suspended, revoked, expired-past-grace, or a cached
 *     licence that no longer verifies, block trading.
 *   - No licence on this device: trading is blocked only when this build REQUIRES activation (the release
 *     builds do; development and test builds do not).
 */
import { Request, Response, NextFunction } from 'express';
import { effectiveStatus, getLicense, hasStoredLicense, touchLicenseClock } from '../core/licensing';
import { getLicensePolicy } from '../core/license-policy';
import { getSettingValue } from '../db';

export interface TradingGate { ok: boolean; status: string; message?: string }

export function tradingGate(): TradingGate {
  touchLicenseClock();
  if (!hasStoredLicense()) {
    return getLicensePolicy().requireActivation
      ? { ok: false, status: 'unactivated', message: 'This till has not been activated yet. Ask the account owner for an activation code (Settings → Licence).' }
      : { ok: true, status: 'unmanaged' };
  }
  if (getSettingValue('cloud_device_revoked')) {
    return { ok: false, status: 'device_revoked', message: 'This device has been removed from the account, so sales are paused. Contact the account owner or support.' };
  }
  const status = effectiveStatus(getLicense());
  if (status === 'active' || status === 'grace' || status === 'needs_verification') return { ok: true, status };
  const message: Record<string, string> = {
    suspended: 'This account is suspended, so sales are paused. Your records are safe and can still be viewed. Contact support to restore it.',
    revoked: 'This account has been closed. Your records can still be viewed and exported. Contact support.',
    expired: 'The licence has expired. Renew it to take sales again. Your records can still be viewed.',
    unlicensed: 'The licence on this till could not be verified. Connect to the internet and refresh it, or contact support.',
  };
  return { ok: false, status, message: message[status] || 'This till is not licensed.' };
}

export function requireTradingLicence(_req: Request, res: Response, next: NextFunction): void {
  const gate = tradingGate();
  if (gate.ok) { next(); return; }
  res.status(402).json({ error: gate.message, code: 'license_blocked', license_status: gate.status });
}
