/**
 * Sync / licence status (Meridian integration).
 *
 * A read-only view of Plemmo's EXISTING offline/sync engine and licence state —
 * it starts no work and defines no new protocol. The Meridian status pill polls
 * this to show online / offline / syncing / sync-failed / licence-grace /
 * licence-blocked. Broadly readable (any signed-in operator) since it is UX.
 */
import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/security';
import { getDatabase } from '../db';
import { resolveDeviceId } from '../core/sync/outbox';
import { getSyncHealth } from '../core/sync/health';
import { getLicense, effectiveStatus, withinOfflineGrace } from '../core/licensing';

const router = Router();

// Reaching this endpoint means the local API is up; the derived state describes
// cloud sync + licence. The client treats a failed request as "offline".
function deriveState(sync: ReturnType<typeof getSyncHealth>, licenceStatus: string): string {
  if (licenceStatus === 'expired' || licenceStatus === 'suspended' || licenceStatus === 'revoked') return 'license_blocked';
  if (sync.enabled && sync.consecutiveFailures > 0) return 'sync_failed';
  if (sync.enabled && (sync.pending > 0 || sync.uploading > 0)) return 'syncing';
  if (licenceStatus === 'grace' || licenceStatus === 'needs_verification') return 'license_grace';
  return 'online';
}

router.get('/status', requireRole('owner', 'manager', 'cashier', 'chef', 'waiter'), (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const deviceId = resolveDeviceId(db);
    const sync = getSyncHealth(deviceId, db);
    const licence = getLicense();
    const licenceStatus = effectiveStatus(licence);
    res.json({
      device_id: deviceId,
      state: deriveState(sync, licenceStatus),
      sync: {
        enabled: sync.enabled,
        online: sync.online,
        pending: sync.pending,
        uploading: sync.uploading,
        failed: sync.failed,
        inbox_pending: sync.inboxPending,
        consecutive_failures: sync.consecutiveFailures,
        last_upload_at: sync.lastUploadAt,
        last_error: sync.lastError,
      },
      license: {
        status: licenceStatus,
        plan: licence.plan,
        expires_at: licence.expires_at,
        grace_days: licence.grace_days,
        within_grace: withinOfflineGrace(licence),
      },
    });
  } catch (error: any) {
    console.error('[Sync] status failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as syncStatusRoutes };
export default router;
