/**
 * Cloud sync service — runs the sync worker and the licence refresh for an activated device.
 *
 * The worker uploads the local outbox (sales, payments, stock movements, audit) and applies what other
 * devices of the same merchant sent; the licence is re-fetched at start and every 15 minutes. Nothing here
 * blocks the till: with no connection the outbox simply fills and the cached licence (with its offline grace)
 * keeps the shop trading. Started at boot and again right after activation.
 */
import { getDatabase } from '../db';
import { getSyncCloudConfig } from '../core/sync/config';
import { HttpSyncTransport } from '../core/sync/http-transport';
import { SyncWorker } from '../core/sync/worker';
import { resolveDeviceId } from '../core/sync/outbox';
import { refreshNow, isActivated } from '../core/activation';

const LICENSE_REFRESH_MS = 15 * 60_000;

let worker: SyncWorker | null = null;
let licenseTimer: NodeJS.Timeout | null = null;

export function syncServiceRunning(): boolean { return !!worker && worker.running; }

export function startSyncService(): { started: boolean; reason?: string } {
  if (worker) return { started: true };
  const cfg = getSyncCloudConfig();
  if (!cfg.enabled) return { started: false, reason: cfg.disabledReason };
  if (!isActivated() && !process.env.PLEMMO_SYNC_URL) return { started: false, reason: 'device not activated' };
  const transport = new HttpSyncTransport({ baseUrl: cfg.baseUrl });
  const interval = Number(process.env.PLEMMO_SYNC_INTERVAL_MS);
  worker = new SyncWorker({ transport, deviceId: resolveDeviceId(getDatabase()), ...(Number.isFinite(interval) && interval >= 50 ? { baseIntervalMs: interval } : {}) });
  worker.start();
  if (isActivated()) {
    void refreshNow().catch(() => undefined);
    const every = Number(process.env.PLEMMO_LICENSE_REFRESH_MS);
    licenseTimer = setInterval(() => { void refreshNow().catch(() => undefined); }, Number.isFinite(every) && every >= 200 ? every : LICENSE_REFRESH_MS);
    licenseTimer.unref?.();
  }
  return { started: true };
}

export async function stopSyncService(): Promise<void> {
  if (licenseTimer) { clearInterval(licenseTimer); licenseTimer = null; }
  const w = worker; worker = null;
  if (w) await w.stop();
}

export function restartSyncService(): void {
  void stopSyncService().then(() => { startSyncService(); });
}
