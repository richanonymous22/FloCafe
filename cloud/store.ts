/**
 * Plemmo Cloud — provider-neutral persistence boundary (SYNC-B).
 *
 * `CloudStore` is the interface the sync API depends on. `SqliteCloudStore`
 * is the DEVELOPMENT implementation (a separate SQLite database, distinct
 * from the POS's local DB). The storage engine sits entirely behind this
 * interface, so the final production backend — Postgres, Supabase, a custom
 * API, whatever — is a drop-in replacement with NO change to the sync
 * protocol or the local client. The final production infrastructure is
 * deliberately undecided in SYNC-B (see docs/SYNC_B_CLOUD_TRANSPORT.md
 * Part A.5 / Part V).
 *
 * This module contains no HTTP and no auth — it is pure persistence.
 */

import Database from 'better-sqlite3';

export interface CloudDevice {
  device_uid: string;
  organization_uid: string;
  location_uid: string | null;
  public_key: string;
  status: 'active' | 'revoked';
}

/** The inventory-movement business fact as the cloud stores it. */
export interface CloudInventoryMovement {
  event_uid: string;
  movement_uid: string;
  organization_uid: string;
  location_uid: string | null;
  device_uid: string;
  device_sequence: number;
  movement_type: string;
  product_uid: string;
  variant_uid: string | null;
  quantity_delta: number;
  unit_cost: number | null;
  reason: string | null;
  reference_type: string | null;
  reference_uid: string | null;
  actor_uid: string | null;
  metadata: string | null;
  created_at: string;
}

/** One event returned by a pull, with its cloud feed position. */
export interface CloudFeedEvent extends CloudInventoryMovement {
  feed_seq: number;
  received_at: string;
}

export type StoreResult = 'accepted' | 'duplicate';

export interface CloudStore {
  getDevice(deviceUid: string): CloudDevice | null;
  registerDevice(device: CloudDevice): void;
  revokeDevice(deviceUid: string): void;

  /** Idempotent by movement_uid: a repeat returns 'duplicate' without creating a second fact. */
  storeMovement(movement: CloudInventoryMovement, receivedAt: string): StoreResult;

  /** Events for an organization with feed_seq > cursor, ascending, excluding one device's own events. */
  pullMovements(organizationUid: string, afterCursor: number, limit: number, excludeDeviceUid?: string): CloudFeedEvent[];

  seenNonce(deviceUid: string, nonce: string): boolean;
  recordNonce(deviceUid: string, nonce: string, at: string): void;

  logSync(kind: string, detail: { deviceUid?: string | null; organizationUid?: string | null; message?: string }, at: string): void;
  observability(): { accepted: number; duplicate: number; rejected: number; authFailure: number };

  close(): void;
}

export class SqliteCloudStore implements CloudStore {
  private db: Database.Database;

  constructor(filename = ':memory:') {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_devices (
        device_uid       TEXT PRIMARY KEY,
        organization_uid TEXT NOT NULL,
        location_uid     TEXT,
        public_key       TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
        created_at       TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cloud_inventory_movements (
        event_uid        TEXT PRIMARY KEY,
        movement_uid     TEXT NOT NULL UNIQUE,
        organization_uid TEXT NOT NULL,
        location_uid     TEXT,
        device_uid       TEXT NOT NULL,
        device_sequence  INTEGER NOT NULL,
        feed_seq         INTEGER NOT NULL,
        movement_type    TEXT NOT NULL,
        product_uid      TEXT NOT NULL,
        variant_uid      TEXT,
        quantity_delta   REAL NOT NULL,
        unit_cost        REAL,
        reason           TEXT,
        reference_type   TEXT,
        reference_uid    TEXT,
        actor_uid        TEXT,
        metadata         TEXT,
        created_at       TEXT NOT NULL,
        received_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_mov_feed ON cloud_inventory_movements(organization_uid, feed_seq);
      CREATE TABLE IF NOT EXISTS cloud_feed_sequence (
        organization_uid TEXT PRIMARY KEY,
        next_seq         INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS cloud_nonces (
        device_uid TEXT NOT NULL,
        nonce      TEXT NOT NULL,
        seen_at    TEXT NOT NULL,
        PRIMARY KEY (device_uid, nonce)
      );
      CREATE TABLE IF NOT EXISTS cloud_sync_log (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        at               TEXT NOT NULL,
        device_uid       TEXT,
        organization_uid TEXT,
        kind             TEXT NOT NULL,
        detail           TEXT
      );
    `);
  }

  getDevice(deviceUid: string): CloudDevice | null {
    return (this.db.prepare('SELECT * FROM cloud_devices WHERE device_uid = ?').get(deviceUid) as CloudDevice | undefined) ?? null;
  }

  registerDevice(device: CloudDevice): void {
    this.db.prepare(`
      INSERT INTO cloud_devices (device_uid, organization_uid, location_uid, public_key, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_uid) DO UPDATE SET organization_uid = excluded.organization_uid,
        location_uid = excluded.location_uid, public_key = excluded.public_key, status = excluded.status
    `).run(device.device_uid, device.organization_uid, device.location_uid, device.public_key, device.status, new Date().toISOString());
  }

  revokeDevice(deviceUid: string): void {
    this.db.prepare("UPDATE cloud_devices SET status = 'revoked' WHERE device_uid = ?").run(deviceUid);
  }

  storeMovement(m: CloudInventoryMovement, receivedAt: string): StoreResult {
    const txn = this.db.transaction((): StoreResult => {
      const existing = this.db.prepare('SELECT 1 FROM cloud_inventory_movements WHERE movement_uid = ?').get(m.movement_uid);
      if (existing) return 'duplicate';
      // Allocate the per-organization feed cursor position (Part M): the
      // cloud feed cursor is distinct from the device's own upload sequence.
      this.db.prepare(`
        INSERT INTO cloud_feed_sequence (organization_uid, next_seq) VALUES (?, 1)
        ON CONFLICT(organization_uid) DO UPDATE SET next_seq = next_seq + 1
      `).run(m.organization_uid);
      const feedSeq = (this.db.prepare('SELECT next_seq FROM cloud_feed_sequence WHERE organization_uid = ?').get(m.organization_uid) as { next_seq: number }).next_seq;
      this.db.prepare(`
        INSERT INTO cloud_inventory_movements (
          event_uid, movement_uid, organization_uid, location_uid, device_uid, device_sequence, feed_seq,
          movement_type, product_uid, variant_uid, quantity_delta, unit_cost, reason, reference_type,
          reference_uid, actor_uid, metadata, created_at, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        m.event_uid, m.movement_uid, m.organization_uid, m.location_uid, m.device_uid, m.device_sequence, feedSeq,
        m.movement_type, m.product_uid, m.variant_uid, m.quantity_delta, m.unit_cost, m.reason, m.reference_type,
        m.reference_uid, m.actor_uid, m.metadata, m.created_at, receivedAt,
      );
      return 'accepted';
    });
    return txn();
  }

  pullMovements(organizationUid: string, afterCursor: number, limit: number, excludeDeviceUid?: string): CloudFeedEvent[] {
    const params: unknown[] = [organizationUid, afterCursor];
    let sql = 'SELECT * FROM cloud_inventory_movements WHERE organization_uid = ? AND feed_seq > ?';
    if (excludeDeviceUid) { sql += ' AND device_uid != ?'; params.push(excludeDeviceUid); }
    sql += ' ORDER BY feed_seq ASC LIMIT ?';
    params.push(limit);
    return this.db.prepare(sql).all(...params) as CloudFeedEvent[];
  }

  seenNonce(deviceUid: string, nonce: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM cloud_nonces WHERE device_uid = ? AND nonce = ?').get(deviceUid, nonce);
  }

  recordNonce(deviceUid: string, nonce: string, at: string): void {
    this.db.prepare('INSERT OR IGNORE INTO cloud_nonces (device_uid, nonce, seen_at) VALUES (?, ?, ?)').run(deviceUid, nonce, at);
  }

  logSync(kind: string, detail: { deviceUid?: string | null; organizationUid?: string | null; message?: string }, at: string): void {
    this.db.prepare('INSERT INTO cloud_sync_log (at, device_uid, organization_uid, kind, detail) VALUES (?, ?, ?, ?, ?)')
      .run(at, detail.deviceUid ?? null, detail.organizationUid ?? null, kind, detail.message ?? null);
  }

  observability(): { accepted: number; duplicate: number; rejected: number; authFailure: number } {
    const count = (kind: string) => (this.db.prepare('SELECT COUNT(*) AS c FROM cloud_sync_log WHERE kind = ?').get(kind) as { c: number }).c;
    return { accepted: count('accepted'), duplicate: count('duplicate'), rejected: count('rejected'), authFailure: count('auth_failure') };
  }

  close(): void {
    this.db.close();
  }
}
