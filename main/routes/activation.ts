/**
 * Activation and licence status for this terminal.
 *   GET  /api/activation/status    anyone signed in: activated?, licence, cloud host, device id
 *   POST /api/activation           owner: { code } — join the merchant's cloud account
 *   POST /api/activation/refresh   owner or manager: fetch the licence now
 */
import { Router, Request, Response } from 'express';
import expressRateLimit from 'express-rate-limit';
import { requireRole } from '../middleware/security';
import { getSettingValue } from '../db';
import { activateDevice, ActivationError, isActivated, refreshNow } from '../core/activation';
import { effectiveStatus, getLicense, hasStoredLicense, withinOfflineGrace } from '../core/licensing';
import { getLicensePolicy } from '../core/license-policy';
import { getSyncHealth } from '../core/sync/health';
import { resolveDeviceId } from '../core/sync/outbox';
import { getDatabase } from '../db';
import { tradingGate } from '../middleware/license-gate';

const router = Router();
router.use(expressRateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Wait a minute and try again.' } }));

function statusBody() {
  const lic = getLicense();
  const db = getDatabase();
  const device = resolveDeviceId(db);
  const sync = getSyncHealth(device, db);
  const url = getSettingValue('cloud_sync_url');
  const gate = tradingGate();
  return {
    activated: isActivated(),
    requires_activation: getLicensePolicy().requireActivation,
    trading_allowed: gate.ok,
    trading_blocked_reason: gate.ok ? null : gate.message,
    device_id: device,
    cloud_host: url ? new URL(url).host : null,
    organization_uid: getSettingValue('cloud_organization_uid'),
    activated_at: getSettingValue('cloud_activated_at'),
    license: hasStoredLicense() ? {
      status: effectiveStatus(lic), stored_status: lic.status, plan: lic.plan, expires_at: lic.expires_at, grace_days: lic.grace_days,
      device_limit: lic.device_limit, location_limit: lic.location_limit, features: lic.features, last_verified_at: lic.last_verified_at,
      within_grace: withinOfflineGrace(lic),
    } : null,
    sync: { enabled: sync.enabled, online: sync.online, pending: sync.pending, last_upload_at: sync.lastUploadAt, last_error: sync.lastError },
  };
}

router.get('/status', requireRole('owner', 'manager', 'cashier', 'chef', 'waiter'), (_req: Request, res: Response) => {
  try { res.json(statusBody()); } catch (e: any) { console.error('[Activation] status failed:', e); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const code = String((req.body || {}).code || '');
    const result = await activateDevice({ code, actorUserId: (req as any).user?.userId ?? null });
    res.status(201).json({ activated: true, ...result, status: statusBody() });
  } catch (e: any) {
    if (e instanceof ActivationError) { res.status(e.statusCode).json({ error: e.message, code: e.code }); return; }
    console.error('[Activation] failed:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/refresh', requireRole('owner', 'manager'), async (_req: Request, res: Response) => {
  try {
    if (!isActivated()) { res.status(409).json({ error: 'This device is not activated.', code: 'not_activated' }); return; }
    const r = await refreshNow();
    res.status(r.fetched ? 200 : 502).json({ refreshed: r.fetched, error: r.fetched ? undefined : (r.error === 'license_signature_invalid' ? 'The licence from the cloud could not be verified.' : 'Could not reach the cloud. The saved licence is still being used.'), code: r.error, status: statusBody() });
  } catch (e: any) { console.error('[Activation] refresh failed:', e); res.status(500).json({ error: 'Internal server error' }); }
});

export const activationRoutes = router;
