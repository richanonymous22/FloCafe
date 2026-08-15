/**
 * Plemmo Core — download / inbox apply (SYNC-B, Part I/J/K).
 *
 * Pulls inventory-movement events the device is entitled to, persists them
 * durably, and applies them locally. The two transaction boundaries are
 * deliberate and enforce the 9A review's cursor-safety rule:
 *
 *   TXN 1 (atomic):  insert the inbox batch  +  advance the download cursor
 *   TXN 2 (per row): apply the movement      +  mark the inbox row applied
 *
 * The cursor is advanced in the SAME transaction as the inbox insert (Part
 * J) — never separately — so a crash can never leave the cursor ahead of
 * durably-stored events. Apply is a SEPARATE transaction (Part K): a crash
 * after TXN 1 leaves inbox rows `pending`, reapplied on restart, with the
 * cursor already correctly advanced, so nothing is re-pulled and nothing is
 * lost. Idempotent throughout (inbox uid PK; movement uid in apply).
 */

import type Database from 'better-sqlite3';
import { getDatabase, now } from '../../db';
import { SyncPullTransport, SyncEntityType, SyncEventPayload } from './types';
import { applyRemoteEvent } from './remote-apply';

type Db = Database.Database;

export function getDownloadCursor(deviceId: string, db: Db = getDatabase()): number {
  const row = db.prepare('SELECT last_download_cursor FROM sync_state WHERE device_id = ?').get(deviceId) as { last_download_cursor: string | null } | undefined;
  const n = Number(row?.last_download_cursor ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export interface DownloadOutcome {
  pulled: number;
  applied: number;
  skipped: number;
  cursor: number;
}

export async function pullAndApply(
  transport: SyncPullTransport,
  deviceId: string,
  limit = 100,
  db: Db = getDatabase(),
): Promise<DownloadOutcome> {
  const cursor = getDownloadCursor(deviceId, db);
  const result = await transport.pull(cursor, limit);
  if (result.events.length === 0) {
    // The server may have SCANNED past our cursor while returning no events —
    // e.g. the tail of the feed is entirely our own uploads, which the server
    // excludes. Advance the cursor anyway so we never re-scan the same window
    // forever (SYNC-B audit finding A1). No inbox rows to write, so this is a
    // single small write.
    if (result.next_cursor > cursor) {
      db.prepare(`
        INSERT INTO sync_state (device_id, last_download_cursor, last_download_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET last_download_cursor = excluded.last_download_cursor, last_download_at = excluded.last_download_at, updated_at = excluded.updated_at
      `).run(deviceId, String(result.next_cursor), now(), now(), now());
    }
    return { pulled: 0, applied: 0, skipped: 0, cursor: result.next_cursor > cursor ? result.next_cursor : cursor };
  }

  // ── TXN 1: persist inbox batch + advance cursor, atomically (Part J) ──────
  const insertInbox = db.prepare(`
    INSERT OR IGNORE INTO sync_inbox (uid, entity_type, entity_uid, operation, payload, cursor, status, received_at)
    VALUES (?, ?, ?, 'append', ?, ?, 'pending', ?)
  `);
  db.transaction(() => {
    for (const ev of result.events) {
      insertInbox.run(ev.event_uid, ev.entity_type ?? 'inventory_movement', ev.entity_uid, JSON.stringify(ev.payload), String(ev.feed_seq), now());
    }
    // Advance the cursor in the SAME transaction as the inbox insert.
    db.prepare(`
      INSERT INTO sync_state (device_id, last_download_cursor, last_download_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET last_download_cursor = excluded.last_download_cursor, last_download_at = excluded.last_download_at, updated_at = excluded.updated_at
    `).run(deviceId, String(result.next_cursor), now(), now(), now());
  })();

  // ── TXN 2 (per row): apply, separately from the cursor advance (Part K) ───
  let applied = 0;
  let skipped = 0;
  // Per-row apply, dispatched by entity_type. A failure applying ONE event (or
  // one entity type) marks only that inbox row failed and moves on — it never
  // discards or blocks unrelated pending events (Part Q).
  const pending = db.prepare("SELECT uid, entity_type, payload FROM sync_inbox WHERE status = 'pending' ORDER BY received_at ASC").all() as Array<{ uid: string; entity_type: string; payload: string }>;
  for (const row of pending) {
    let payload: SyncEventPayload;
    try { payload = JSON.parse(row.payload); } catch {
      db.prepare("UPDATE sync_inbox SET status = 'failed', last_error = 'malformed payload' WHERE uid = ?").run(row.uid);
      continue;
    }
    try {
      const outcome = db.transaction(() => {
        const r = applyRemoteEvent(db, row.entity_type as SyncEntityType, payload);
        db.prepare("UPDATE sync_inbox SET status = 'applied', applied_at = ? WHERE uid = ?").run(now(), row.uid);
        return r;
      })();
      if (outcome === 'applied') applied += 1; else skipped += 1;
    } catch (error) {
      db.prepare("UPDATE sync_inbox SET status = 'failed', last_error = ? WHERE uid = ?").run((error as Error).message, row.uid);
    }
  }

  return { pulled: result.events.length, applied, skipped, cursor: result.next_cursor };
}
