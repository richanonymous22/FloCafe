/**
 * Plemmo Admin — operator sync / device health read model (SYNC-G, Part L).
 *
 * Merchant-focused, not an infrastructure dashboard. Combines the LOCAL sync
 * state (backlog, failed events, this device's last upload/download) with the
 * organization's cloud health (device count, last received, per-entity counts,
 * open deficits) and the local open-conflict count. No secrets are exposed.
 *
 * The cloud half is passed in (fetched over the org-scoped `GET /sync/v1/health`
 * endpoint) so this module stays synchronous and testable; when it is absent
 * (offline) the local half is still returned with `cloud: null`.
 */

import type Database from 'better-sqlite3';
import { getDatabase } from '../../db';
import { getSyncHealth } from '../sync/health';
import { getDeviceContext } from '../context';

export interface OperatorSyncHealth {
  local: {
    environment: string;
    enabled: boolean;
    online: boolean | null;
    lastUploadAt: string | null;
    lastDownloadAt: string | null;
    lastError: string | null;
    consecutiveFailures: number;
    backlog: number;      // pending + uploading outbox
    failed: number;       // failed outbox + inbox
    inboxPending: number;
  };
  cloud: Record<string, unknown> | null;
  openConflicts: number;
  openDeficits: number | null;
  thisDevice: string | null;
}

export function operatorSyncHealth(cloudHealth: Record<string, unknown> | null, db: Database.Database = getDatabase()): OperatorSyncHealth {
  const deviceId = getDeviceContext()?.id ?? 'local-device';
  const h = getSyncHealth(deviceId, db);
  const openConflicts = (db.prepare("SELECT COUNT(*) AS c FROM sales_conflicts WHERE status IN ('open','acknowledged','resolving')").get() as { c: number }).c;
  const openDeficits = cloudHealth && typeof cloudHealth.open_deficits === 'number' ? (cloudHealth.open_deficits as number) : null;
  return {
    local: {
      environment: h.environment, enabled: h.enabled, online: h.online,
      lastUploadAt: h.lastUploadAt, lastDownloadAt: h.lastDownloadAt, lastError: h.lastError,
      consecutiveFailures: h.consecutiveFailures,
      backlog: h.pending + h.uploading, failed: h.failed + h.inboxFailed, inboxPending: h.inboxPending,
    },
    cloud: cloudHealth,
    openConflicts,
    openDeficits,
    thisDevice: deviceId,
  };
}

/** Device-level health for the operator — this device's local state + the
 *  organization's device summary from the cloud (per-device cloud detail is
 *  future work; the merchant view shows counts + this till's own status). */
export function deviceHealth(cloudHealth: Record<string, unknown> | null, db: Database.Database = getDatabase()): { thisDevice: string | null; local: OperatorSyncHealth['local']; organizationDevices: number | null; activeDevices: number | null; lastReceivedAt: string | null } {
  const base = operatorSyncHealth(cloudHealth, db);
  return {
    thisDevice: base.thisDevice,
    local: base.local,
    organizationDevices: cloudHealth && typeof cloudHealth.devices === 'number' ? (cloudHealth.devices as number) : null,
    activeDevices: cloudHealth && typeof cloudHealth.active_devices === 'number' ? (cloudHealth.active_devices as number) : null,
    lastReceivedAt: cloudHealth && typeof cloudHealth.last_received_at === 'string' ? (cloudHealth.last_received_at as string) : null,
  };
}
