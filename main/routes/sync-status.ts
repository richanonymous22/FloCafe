/**
 * GET /api/sync/status — lightweight, ANY-authenticated-role connection/sync
 * status (UI-0, Plemmo redesign). Every staff role operating the till needs
 * to see whether the device is online/offline/syncing without guessing
 * ("Offline-first must remain a first-class UX state" — design brief).
 *
 * This is deliberately NOT the SYNC-G admin sync-health surface
 * (/api/admin/sync-health, gated to owner/manager — org-wide conflict/deficit
 * counts are a reconciliation concern, not a cashier concern). It exposes
 * only this device's own local connectivity signal from the existing
 * getSyncHealth() — no new sync semantics, no new backend capability.
 */
import { Router, Request, Response } from 'express';
import { getSyncHealth } from '../core/sync/health';
import { getDeviceContext } from '../core/context';
import { getLicense, effectiveStatus } from '../core/licensing';

const router = Router();

router.get('/status', (_req: Request, res: Response) => {
  const deviceId = getDeviceContext()?.id ?? 'local-device';
  const h = getSyncHealth(deviceId);
  const license = getLicense();
  res.json({
    enabled: h.enabled,
    online: h.online,
    pending: h.pending + h.uploading,
    failed: h.failed + h.inboxFailed,
    lastUploadAt: h.lastUploadAt,
    lastDownloadAt: h.lastDownloadAt,
    consecutiveFailures: h.consecutiveFailures,
    // Minimal license signal — every role needs to know if the app itself is
    // blocked/in grace; feature entitlements and full record stay admin-only.
    license: { status: effectiveStatus(license), plan: license.plan },
  });
});

export default router;
