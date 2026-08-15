/**
 * Plemmo Core — conflict synchronization (SYNC-F, Part P).
 *
 * Cross-device conflict OWNERSHIP is split deliberately (documented in
 * docs/SYNC_F_CONFLICT_RECONCILIATION.md):
 *
 *   - DETECTION of cross-device conflicts is the cloud's job — it is the only
 *     vantage point that sees two devices. The cloud is the source of truth
 *     for detection and cross-device status.
 *   - RESOLUTION is a LOCAL operation — only the local session knows the
 *     user's ROLE (so authorization can be enforced) and holds the
 *     authoritative record it must protect.
 *
 * This module is the bridge: `pullConflicts` mirrors the cloud's conflicts
 * into the local `sales_conflicts` table (same `conflict_uid` — ONE logical
 * conflict, not two systems), and `reportResolution` pushes a locally-decided
 * outcome back so other devices converge. Neither ever mutates an
 * authoritative sales record.
 */

import type Database from 'better-sqlite3';
import { getDatabase } from '../../db';
import { HttpSyncTransport, ConflictResolutionReport } from './http-transport';
import { upsertConflict } from './conflict-store';
import { isConflictType } from './conflict-model';

type Db = Database.Database;

export interface PullConflictsOutcome {
  pulled: number;
  stored: number;
}

/**
 * Pulls the cloud's conflicts for this device's org and mirrors any not yet
 * present locally into `sales_conflicts` (idempotent by conflict_uid). A
 * conflict already resolved locally is left untouched — the pull never
 * reopens it.
 */
export async function pullConflicts(transport: HttpSyncTransport, db: Db = getDatabase()): Promise<PullConflictsOutcome> {
  const conflicts = await transport.pullConflicts();
  let stored = 0;
  const txn = db.transaction(() => {
    for (const c of conflicts) {
      const conflictType = isConflictType(c.conflict_type) ? c.conflict_type : 'concurrent_update';
      const before = db.prepare('SELECT 1 FROM sales_conflicts WHERE conflict_uid = ?').get(c.conflict_uid);
      upsertConflict({
        conflictUid: c.conflict_uid,
        organizationId: c.organization_uid,
        locationId: c.location_uid,
        entityType: c.entity_type,
        entityUid: c.entity_uid,
        conflictType,
        source: 'cloud',
        localEventUid: c.local_event_uid,
        remoteEventUid: c.remote_event_uid,
        localDeviceUid: c.local_device_uid,
        remoteDeviceUid: c.remote_device_uid,
        detectedAt: c.detected_at,
      }, db);
      if (!before) stored += 1;
    }
  });
  txn();
  return { pulled: conflicts.length, stored };
}

/** Pushes a locally-decided resolution to the cloud so other devices converge. */
export async function reportResolution(transport: HttpSyncTransport, report: ConflictResolutionReport): Promise<{ ok: boolean; reason?: string }> {
  return transport.reportResolution(report);
}
