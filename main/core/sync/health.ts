/**
 * Plemmo Core — local sync health (SYNC-C, Part G).
 *
 * A read-only snapshot of the device's sync state, derived from durable data
 * (`sync_state` + live `sync_outbox`/`sync_inbox` counts) plus the worker's
 * in-process liveness. This is the internal API a future Admin surface / a
 * status indicator consumes — it builds no UI itself.
 *
 * Everything here is a pure read; it never triggers a sync or mutates state.
 */

import type Database from 'better-sqlite3';
import { getDatabase } from '../../db';
import { getSyncCloudConfig } from './config';

type Db = Database.Database;

export interface SyncHealth {
  environment: string;
  enabled: boolean;
  /** true after a successful sync, false after a failure, null before any attempt. */
  online: boolean | null;
  lastUploadAt: string | null;
  lastDownloadAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  pending: number;
  uploading: number;
  failed: number;
  inboxPending: number;
  inboxFailed: number;
  /** Duration of the worker's most recent tick, if it has run this session. */
  lastSyncDurationMs: number | null;
}

/** The worker publishes its last tick here so health can report liveness
 *  without a schema change; durable cross-process health can be layered on
 *  later (documented). */
export const workerLiveness: { lastTickAt: string | null; lastDurationMs: number | null } = {
  lastTickAt: null,
  lastDurationMs: null,
};

export function getSyncHealth(deviceId: string, db: Db = getDatabase(), env: NodeJS.ProcessEnv = process.env): SyncHealth {
  const cfg = getSyncCloudConfig(env);
  const state = db.prepare('SELECT * FROM sync_state WHERE device_id = ?').get(deviceId) as
    | { last_upload_at: string | null; last_download_at: string | null; last_error_at: string | null; last_error: string | null; failure_count: number }
    | undefined;

  const countOutbox = (status: string) => (db.prepare('SELECT COUNT(*) AS c FROM sync_outbox WHERE status = ?').get(status) as { c: number }).c;
  const countInbox = (status: string) => (db.prepare('SELECT COUNT(*) AS c FROM sync_inbox WHERE status = ?').get(status) as { c: number }).c;

  const failures = state?.failure_count ?? 0;
  const hadAttempt = !!(state && (state.last_upload_at || state.last_download_at || state.last_error_at));
  const online = !hadAttempt ? null : failures === 0;

  return {
    environment: cfg.environment,
    enabled: cfg.enabled,
    online,
    lastUploadAt: state?.last_upload_at ?? null,
    lastDownloadAt: state?.last_download_at ?? null,
    lastErrorAt: state?.last_error_at ?? null,
    lastError: state?.last_error ?? null,
    consecutiveFailures: failures,
    pending: countOutbox('pending'),
    uploading: countOutbox('uploading'),
    failed: countOutbox('failed'),
    inboxPending: countInbox('pending'),
    inboxFailed: countInbox('failed'),
    lastSyncDurationMs: workerLiveness.lastDurationMs,
  };
}
