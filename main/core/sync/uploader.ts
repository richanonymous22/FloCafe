/**
 * Plemmo Core — sync uploader (SYNC-A).
 *
 * The explicit upload flow a future background worker will call. There is NO
 * background loop in SYNC-A (Part J) — `uploadPendingBatch` is an explicit
 * function, driven by tests here and by a future worker later. It is
 * transport-agnostic: the `SyncTransport` it takes is a mock in tests and
 * will be a real HTTP client later, with no change to this function.
 *
 * The flow, and where durability sits:
 *   1. recover any events stuck `uploading` from a previous crash → `pending`
 *   2. read the next pending batch in sequence order
 *   3. mark them `uploading` (durable, so a crash mid-upload is recoverable)
 *   4. hand them to the transport
 *   5. on success: mark acked uids `acked`, permanently-rejected uids `failed`
 *   6. on transport error (transient): roll the batch back to `pending` and
 *      record the failure on sync_state for retry on the next call
 */

import type Database from 'better-sqlite3';
import { getDatabase } from '../../db';
import { SyncTransport, SyncUploadResult } from './types';
import {
  nextPendingBatch, markUploading, markAcked, markFailed,
  recoverStalledUploads, recordSyncFailure,
} from './outbox';

type Db = Database.Database;

export interface UploadOutcome {
  attempted: number;
  acked: number;
  failed: number;
  transportError?: string;
}

export async function uploadPendingBatch(
  transport: SyncTransport,
  deviceId: string,
  limit = 100,
  db: Db = getDatabase(),
): Promise<UploadOutcome> {
  recoverStalledUploads(db);

  const batch = nextPendingBatch(deviceId, limit, db);
  if (batch.length === 0) return { attempted: 0, acked: 0, failed: 0 };

  const uids = batch.map((e) => e.uid);
  markUploading(uids, db);

  let result: SyncUploadResult;
  try {
    result = await transport.upload(batch);
  } catch (error) {
    // Transient failure: nothing was confirmed, so return the whole batch to
    // pending for a later retry, and record the failure for observability.
    // No event is lost; no business data is touched.
    db.prepare("UPDATE sync_outbox SET status = 'pending' WHERE uid IN (" + uids.map(() => '?').join(',') + ")").run(...uids);
    recordSyncFailure(deviceId, (error as Error).message, db);
    return { attempted: batch.length, acked: 0, failed: 0, transportError: (error as Error).message };
  }

  const ackedSet = new Set(result.acked);
  const rejected = result.rejected ?? [];
  const rejectedSet = new Set(rejected.map((r) => r.uid));

  markAcked(result.acked, db);
  for (const r of rejected) markFailed([r.uid], r.reason, db);

  // Any event neither acked nor rejected by the transport is treated as
  // still pending (a partial/ambiguous response) — returned to pending so it
  // is retried, never silently dropped.
  const unresolved = uids.filter((uid) => !ackedSet.has(uid) && !rejectedSet.has(uid));
  if (unresolved.length > 0) {
    db.prepare("UPDATE sync_outbox SET status = 'pending' WHERE uid IN (" + unresolved.map(() => '?').join(',') + ")").run(...unresolved);
  }

  return { attempted: batch.length, acked: result.acked.length, failed: rejected.length };
}
