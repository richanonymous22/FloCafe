/**
 * Plemmo Cloud — provider-neutral persistence boundary (SYNC-B, hardened in SYNC-C).
 *
 * `CloudStore` is the interface the sync API depends on. Two implementations
 * ship:
 *   - `SqliteCloudStore` — the DEVELOPMENT/TEST implementation (a separate
 *     SQLite database, distinct from the POS's local DB). Production-shaped:
 *     atomic per-org feed sequencing, nonce TTL pruning, a stock projection
 *     that flags cross-till deficits, device lifecycle, enrollment tokens.
 *   - `PostgresCloudStore` — the PRODUCTION adapter (see cloud/postgres-store.ts),
 *     behind the SAME interface so the sync protocol and the local client are
 *     untouched by the backend choice.
 *
 * The storage engine sits entirely behind this interface. This module
 * contains no HTTP and no auth — it is pure persistence.
 */

import Database from 'better-sqlite3';

export type DeviceStatus = 'active' | 'revoked';

export interface CloudDevice {
  device_uid: string;
  organization_uid: string;
  location_uid: string | null;
  register_uid: string | null;
  public_key: string;
  status: DeviceStatus;
  created_at?: string;
  revoked_at?: string | null;
  rotated_at?: string | null;
  superseded_by?: string | null;
  last_seen_at?: string | null;
  last_sync_at?: string | null;
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

/**
 * A page of pulled events. `nextCursor` is the highest feed position the
 * server SCANNED (not merely the highest returned) so the client's cursor
 * always advances past its own excluded events — otherwise a device whose
 * uploads are the tail of the feed would re-scan the same window forever
 * (SYNC-B audit finding A1).
 */
export interface CloudPullPage {
  events: CloudFeedEvent[];
  nextCursor: number;
  hasMore: boolean;
}

export type StoreResult = 'accepted' | 'duplicate';

/** A detected cross-till inventory deficit — a fact, never a reversal (Part H). */
export interface CloudInventoryDeficit {
  organization_uid: string;
  location_uid: string | null;
  product_uid: string;
  variant_uid: string | null;
  balance: number;
  first_detected_at: string;
  last_detected_at: string;
  triggering_movement_uid: string;
}

/** A one-time device activation token (Part D — production enrollment). */
export interface EnrollmentToken {
  token_hash: string;
  organization_uid: string;
  location_uid: string | null;
  register_uid: string | null;
  expires_at: string;
  consumed_at: string | null;
}

export interface OrganizationHealth {
  organization_uid: string;
  devices: number;
  active_devices: number;
  movements: number;
  deficits: number;
  last_received_at: string | null;
}

export interface CloudStore {
  getDevice(deviceUid: string): CloudDevice | null;
  registerDevice(device: CloudDevice): void;
  revokeDevice(deviceUid: string): void;
  /** Records a device rotation: the old credential is superseded by a new device row's key. */
  rotateDevice(deviceUid: string, newPublicKey: string, at: string): void;
  /** Stamps last_seen_at on every authenticated request (observability, Part G). */
  markDeviceSeen(deviceUid: string, at: string): void;
  /** Stamps last_sync_at on a successful upload/pull (observability, Part G). */
  markDeviceSynced(deviceUid: string, at: string): void;

  /** Idempotent by movement_uid: a repeat returns 'duplicate' without creating a second fact. */
  storeMovement(movement: CloudInventoryMovement, receivedAt: string): StoreResult;

  /** A page of events for an organization with feed_seq > cursor, ascending, excluding one device's own events. */
  pullMovements(organizationUid: string, afterCursor: number, limit: number, excludeDeviceUid?: string): CloudPullPage;

  seenNonce(deviceUid: string, nonce: string): boolean;
  recordNonce(deviceUid: string, nonce: string, at: string): void;
  /** Prunes nonces older than the replay window; returns rows removed. */
  pruneNonces(olderThanIso: string): number;

  // ── Device enrollment (Part D) ────────────────────────────────────────────
  createEnrollmentToken(token: EnrollmentToken): void;
  /** Atomically consumes a valid, unexpired, unconsumed token; returns it or null. */
  consumeEnrollmentToken(tokenHash: string, nowIso: string): EnrollmentToken | null;

  // ── Inventory reconciliation (Part H) ─────────────────────────────────────
  listDeficits(organizationUid: string): CloudInventoryDeficit[];

  // ── Observability (Part G) ────────────────────────────────────────────────
  logSync(kind: string, detail: { deviceUid?: string | null; organizationUid?: string | null; message?: string }, at: string): void;
  observability(): { accepted: number; duplicate: number; rejected: number; authFailure: number };
  organizationHealth(organizationUid: string): OrganizationHealth;

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
        register_uid     TEXT,
        public_key       TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
        created_at       TEXT NOT NULL,
        revoked_at       TEXT,
        rotated_at       TEXT,
        superseded_by    TEXT,
        last_seen_at     TEXT,
        last_sync_at     TEXT
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
      CREATE INDEX IF NOT EXISTS idx_cloud_mov_device ON cloud_inventory_movements(device_uid);
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
      CREATE INDEX IF NOT EXISTS idx_cloud_nonces_seen ON cloud_nonces(seen_at);
      CREATE TABLE IF NOT EXISTS cloud_enrollment_tokens (
        token_hash       TEXT PRIMARY KEY,
        organization_uid TEXT NOT NULL,
        location_uid     TEXT,
        register_uid     TEXT,
        expires_at       TEXT NOT NULL,
        consumed_at      TEXT,
        created_at       TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cloud_inventory_stock (
        organization_uid TEXT NOT NULL,
        location_uid     TEXT NOT NULL DEFAULT '',
        product_uid      TEXT NOT NULL,
        variant_uid      TEXT NOT NULL DEFAULT '',
        balance          REAL NOT NULL DEFAULT 0,
        updated_at       TEXT NOT NULL,
        PRIMARY KEY (organization_uid, location_uid, product_uid, variant_uid)
      );
      CREATE TABLE IF NOT EXISTS cloud_inventory_deficits (
        organization_uid        TEXT NOT NULL,
        location_uid            TEXT NOT NULL DEFAULT '',
        product_uid             TEXT NOT NULL,
        variant_uid             TEXT NOT NULL DEFAULT '',
        balance                 REAL NOT NULL,
        first_detected_at       TEXT NOT NULL,
        last_detected_at        TEXT NOT NULL,
        triggering_movement_uid TEXT NOT NULL,
        PRIMARY KEY (organization_uid, location_uid, product_uid, variant_uid)
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
      INSERT INTO cloud_devices (device_uid, organization_uid, location_uid, register_uid, public_key, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_uid) DO UPDATE SET organization_uid = excluded.organization_uid,
        location_uid = excluded.location_uid, register_uid = excluded.register_uid,
        public_key = excluded.public_key, status = excluded.status, revoked_at = NULL
    `).run(
      device.device_uid, device.organization_uid, device.location_uid ?? null, device.register_uid ?? null,
      device.public_key, device.status, device.created_at ?? new Date().toISOString(),
    );
  }

  revokeDevice(deviceUid: string): void {
    this.db.prepare("UPDATE cloud_devices SET status = 'revoked', revoked_at = ? WHERE device_uid = ?")
      .run(new Date().toISOString(), deviceUid);
  }

  rotateDevice(deviceUid: string, newPublicKey: string, at: string): void {
    // Rotation-in-place: the same device_uid keeps a stable identity, its
    // public key is replaced, and the rotation is stamped for audit. A
    // full device REPLACEMENT (new device_uid) is a revoke + fresh enroll.
    this.db.prepare('UPDATE cloud_devices SET public_key = ?, rotated_at = ? WHERE device_uid = ?')
      .run(newPublicKey, at, deviceUid);
  }

  markDeviceSeen(deviceUid: string, at: string): void {
    this.db.prepare('UPDATE cloud_devices SET last_seen_at = ? WHERE device_uid = ?').run(at, deviceUid);
  }

  markDeviceSynced(deviceUid: string, at: string): void {
    this.db.prepare('UPDATE cloud_devices SET last_sync_at = ? WHERE device_uid = ?').run(at, deviceUid);
  }

  storeMovement(m: CloudInventoryMovement, receivedAt: string): StoreResult {
    const txn = this.db.transaction((): StoreResult => {
      const existing = this.db.prepare('SELECT 1 FROM cloud_inventory_movements WHERE movement_uid = ?').get(m.movement_uid);
      if (existing) return 'duplicate';
      // Allocate the per-organization feed cursor position atomically (Part C).
      // better-sqlite3 is synchronous and single-threaded, so this
      // read-modify-write inside the transaction cannot interleave with
      // another request — every org's feed_seq is a gapless 1,2,3,… with no
      // duplicates. The production adapter reproduces this atomicity with a
      // Postgres sequence / SELECT … FOR UPDATE (see cloud/postgres-store.ts).
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
      this.projectStockAndFlagDeficit(m, receivedAt);
      return 'accepted';
    });
    return txn();
  }

  /**
   * Part H — cross-till deficit detection. The cloud maintains a per
   * (org, location, product, variant) balance projection by summing the
   * movement deltas it has received. When two independently-offline tills
   * both sold from the same stale stock, their deltas drive this projection
   * negative. That is recorded as a DEFICIT fact — the original movements are
   * never touched and no sale is reversed. Runs inside storeMovement's
   * transaction so the projection can never diverge from the stored fact.
   */
  private projectStockAndFlagDeficit(m: CloudInventoryMovement, at: string): void {
    const loc = m.location_uid ?? '';
    const variant = m.variant_uid ?? '';
    this.db.prepare(`
      INSERT INTO cloud_inventory_stock (organization_uid, location_uid, product_uid, variant_uid, balance, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_uid, location_uid, product_uid, variant_uid)
      DO UPDATE SET balance = balance + excluded.balance, updated_at = excluded.updated_at
    `).run(m.organization_uid, loc, m.product_uid, variant, m.quantity_delta, at);
    const balance = (this.db.prepare(
      'SELECT balance FROM cloud_inventory_stock WHERE organization_uid = ? AND location_uid = ? AND product_uid = ? AND variant_uid = ?',
    ).get(m.organization_uid, loc, m.product_uid, variant) as { balance: number }).balance;
    if (balance < 0) {
      this.db.prepare(`
        INSERT INTO cloud_inventory_deficits
          (organization_uid, location_uid, product_uid, variant_uid, balance, first_detected_at, last_detected_at, triggering_movement_uid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(organization_uid, location_uid, product_uid, variant_uid)
        DO UPDATE SET balance = excluded.balance, last_detected_at = excluded.last_detected_at, triggering_movement_uid = excluded.triggering_movement_uid
      `).run(m.organization_uid, loc, m.product_uid, variant, balance, at, at, m.movement_uid);
    }
  }

  pullMovements(organizationUid: string, afterCursor: number, limit: number, excludeDeviceUid?: string): CloudPullPage {
    // Scan the raw feed window (ALL devices) so the cursor advances past the
    // caller's own excluded events; filter own-device out of the returned
    // events only (audit finding A1).
    const raw = this.db.prepare(
      'SELECT * FROM cloud_inventory_movements WHERE organization_uid = ? AND feed_seq > ? ORDER BY feed_seq ASC LIMIT ?',
    ).all(organizationUid, afterCursor, limit) as CloudFeedEvent[];
    const hasMore = raw.length === limit;
    const nextCursor = raw.length > 0 ? raw[raw.length - 1].feed_seq : afterCursor;
    const events = excludeDeviceUid ? raw.filter((e) => e.device_uid !== excludeDeviceUid) : raw;
    return { events, nextCursor, hasMore };
  }

  seenNonce(deviceUid: string, nonce: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM cloud_nonces WHERE device_uid = ? AND nonce = ?').get(deviceUid, nonce);
  }

  recordNonce(deviceUid: string, nonce: string, at: string): void {
    this.db.prepare('INSERT OR IGNORE INTO cloud_nonces (device_uid, nonce, seen_at) VALUES (?, ?, ?)').run(deviceUid, nonce, at);
  }

  pruneNonces(olderThanIso: string): number {
    return this.db.prepare('DELETE FROM cloud_nonces WHERE seen_at < ?').run(olderThanIso).changes;
  }

  createEnrollmentToken(token: EnrollmentToken): void {
    this.db.prepare(`
      INSERT INTO cloud_enrollment_tokens (token_hash, organization_uid, location_uid, register_uid, expires_at, consumed_at, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `).run(token.token_hash, token.organization_uid, token.location_uid ?? null, token.register_uid ?? null, token.expires_at, new Date().toISOString());
  }

  consumeEnrollmentToken(tokenHash: string, nowIso: string): EnrollmentToken | null {
    const txn = this.db.transaction((): EnrollmentToken | null => {
      const row = this.db.prepare('SELECT * FROM cloud_enrollment_tokens WHERE token_hash = ?').get(tokenHash) as EnrollmentToken | undefined;
      if (!row) return null;
      if (row.consumed_at) return null;
      if (row.expires_at < nowIso) return null;
      this.db.prepare('UPDATE cloud_enrollment_tokens SET consumed_at = ? WHERE token_hash = ?').run(nowIso, tokenHash);
      return { ...row, consumed_at: nowIso };
    });
    return txn();
  }

  listDeficits(organizationUid: string): CloudInventoryDeficit[] {
    return this.db.prepare('SELECT * FROM cloud_inventory_deficits WHERE organization_uid = ? ORDER BY last_detected_at DESC')
      .all(organizationUid).map((r) => {
        const row = r as CloudInventoryDeficit & { location_uid: string; variant_uid: string };
        return { ...row, location_uid: row.location_uid || null, variant_uid: row.variant_uid || null };
      });
  }

  logSync(kind: string, detail: { deviceUid?: string | null; organizationUid?: string | null; message?: string }, at: string): void {
    this.db.prepare('INSERT INTO cloud_sync_log (at, device_uid, organization_uid, kind, detail) VALUES (?, ?, ?, ?, ?)')
      .run(at, detail.deviceUid ?? null, detail.organizationUid ?? null, kind, detail.message ?? null);
  }

  observability(): { accepted: number; duplicate: number; rejected: number; authFailure: number } {
    const count = (kind: string) => (this.db.prepare('SELECT COUNT(*) AS c FROM cloud_sync_log WHERE kind = ?').get(kind) as { c: number }).c;
    return { accepted: count('accepted'), duplicate: count('duplicate'), rejected: count('rejected'), authFailure: count('auth_failure') };
  }

  organizationHealth(organizationUid: string): OrganizationHealth {
    const one = (sql: string) => (this.db.prepare(sql).get(organizationUid) as { c: number }).c;
    const lastReceived = (this.db.prepare('SELECT MAX(received_at) AS m FROM cloud_inventory_movements WHERE organization_uid = ?').get(organizationUid) as { m: string | null }).m;
    return {
      organization_uid: organizationUid,
      devices: one('SELECT COUNT(*) AS c FROM cloud_devices WHERE organization_uid = ?'),
      active_devices: one("SELECT COUNT(*) AS c FROM cloud_devices WHERE organization_uid = ? AND status = 'active'"),
      movements: one('SELECT COUNT(*) AS c FROM cloud_inventory_movements WHERE organization_uid = ?'),
      deficits: one('SELECT COUNT(*) AS c FROM cloud_inventory_deficits WHERE organization_uid = ?'),
      last_received_at: lastReceived,
    };
  }

  close(): void {
    this.db.close();
  }
}
