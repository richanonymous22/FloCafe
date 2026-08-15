/**
 * Plemmo Cloud — provider-neutral persistence boundary
 * (SYNC-B, hardened SYNC-C, generalized to multi-entity in SYNC-D).
 *
 * `CloudStore` is the interface the sync API depends on. Two implementations
 * ship:
 *   - `SqliteCloudStore` — the DEVELOPMENT/TEST implementation (a separate
 *     SQLite database). Production-shaped: atomic per-org feed sequencing,
 *     nonce TTL pruning, a stock projection that flags cross-till deficits,
 *     device lifecycle, enrollment tokens.
 *   - `PostgresCloudStore` — the PRODUCTION adapter (cloud/postgres-store.ts),
 *     behind the SAME interface, run against a REAL PostgreSQL server.
 *
 * ## Multi-entity feed (SYNC-D, Part K/M/N)
 *
 * A single generic `cloud_events` table is the per-organization feed. It
 * carries `inventory_movement`, `audit_event`, and `payment_event` facts, each
 * idempotent by (entity_type, entity_uid), ordered by ONE per-organization
 * `feed_seq` that spans all entity types (deliberate — see Part N: a single
 * ordered feed per org gives the client one cursor and one deterministic
 * order; there is NO global all-tenant sequence). Inventory movements
 * additionally drive the cross-till deficit projection.
 *
 * `storeMovement`/`pullMovements` remain as thin inventory-typed wrappers over
 * the generic `storeEvent`/`pullEvents` so earlier suites are unaffected.
 */

import Database from 'better-sqlite3';

export type DeviceStatus = 'active' | 'revoked';
export type CloudEntityType =
  | 'inventory_movement' | 'audit_event' | 'payment_event'
  | 'order' | 'order_item' | 'bill';

/** Mutable sales entities: many snapshot events per entity_uid (SYNC-E). */
export const MUTABLE_CLOUD_ENTITIES: ReadonlySet<string> = new Set(['order', 'order_item', 'bill']);

export interface CloudConflict {
  conflict_uid: string;
  organization_uid: string;
  location_uid: string | null;
  entity_type: string;
  entity_uid: string;
  local_event_uid: string | null;
  remote_event_uid: string | null;
  local_device_uid: string | null;
  remote_device_uid: string | null;
  conflict_type: string;
  detected_at: string;
  status: 'open' | 'acknowledged' | 'resolved';
  resolution: string | null;
}

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

/** A generic synchronized event as the cloud stores it. */
export interface CloudEvent {
  event_uid: string;
  entity_type: CloudEntityType;
  entity_uid: string;
  organization_uid: string;
  location_uid: string | null;
  device_uid: string;
  device_sequence: number;
  payload: string; // JSON text — the typed business fact
  created_at: string;
}

/** One event returned by a pull, with its cloud feed position. */
export interface CloudFeedItem extends CloudEvent {
  feed_seq: number;
  received_at: string;
}

export interface CloudPullPage {
  events: CloudFeedItem[];
  nextCursor: number;
  hasMore: boolean;
}

// ── Backward-compatible inventory-movement shapes (SYNC-B/C) ────────────────
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
export interface CloudFeedEvent extends CloudInventoryMovement {
  feed_seq: number;
  received_at: string;
}

export type StoreResult = 'accepted' | 'duplicate';
export type DeficitStatus = 'open' | 'acknowledged' | 'resolved';

export interface CloudInventoryDeficit {
  organization_uid: string;
  location_uid: string | null;
  product_uid: string;
  variant_uid: string | null;
  balance: number;
  status: DeficitStatus;
  first_detected_at: string;
  last_detected_at: string;
  triggering_movement_uid: string;
}

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
  events: number;
  deficits: number;
  open_deficits: number;
  last_received_at: string | null;
  by_entity: Record<string, number>;
}

export interface CloudStore {
  getDevice(deviceUid: string): CloudDevice | null;
  registerDevice(device: CloudDevice): void;
  revokeDevice(deviceUid: string): void;
  rotateDevice(deviceUid: string, newPublicKey: string, at: string): void;
  markDeviceSeen(deviceUid: string, at: string): void;
  markDeviceSynced(deviceUid: string, at: string): void;

  /** Generic multi-entity store; idempotent by (entity_type, entity_uid). */
  storeEvent(event: CloudEvent, receivedAt: string): StoreResult;
  /** Generic multi-entity pull; one per-org feed across all entity types. */
  pullEvents(organizationUid: string, afterCursor: number, limit: number, excludeDeviceUid?: string): CloudPullPage;

  // Backward-compatible inventory wrappers (SYNC-B/C).
  storeMovement(movement: CloudInventoryMovement, receivedAt: string): StoreResult;
  pullMovements(organizationUid: string, afterCursor: number, limit: number, excludeDeviceUid?: string): { events: CloudFeedEvent[]; nextCursor: number; hasMore: boolean };

  seenNonce(deviceUid: string, nonce: string): boolean;
  recordNonce(deviceUid: string, nonce: string, at: string): void;
  pruneNonces(olderThanIso: string): number;

  createEnrollmentToken(token: EnrollmentToken): void;
  consumeEnrollmentToken(tokenHash: string, nowIso: string): EnrollmentToken | null;

  listDeficits(organizationUid: string): CloudInventoryDeficit[];
  setDeficitStatus(organizationUid: string, locationUid: string | null, productUid: string, variantUid: string | null, status: DeficitStatus, at: string): boolean;

  // ── Sales conflict + version projection (SYNC-E) ──────────────────────────
  listConflicts(organizationUid: string): CloudConflict[];
  getEntityVersion(organizationUid: string, entityType: string, entityUid: string): { current_event_uid: string; current_device_uid: string; snapshot_version: number } | null;

  logSync(kind: string, detail: { deviceUid?: string | null; organizationUid?: string | null; entityType?: string | null; message?: string }, at: string): void;
  observability(): { accepted: number; duplicate: number; rejected: number; authFailure: number };
  observabilityByEntity(): Record<string, { accepted: number; duplicate: number; rejected: number }>;
  organizationHealth(organizationUid: string): OrganizationHealth;

  close(): void;
}

interface InventoryProjectionFields {
  product_uid: string;
  variant_uid: string | null;
  location_uid: string | null;
  quantity_delta: number;
  movement_uid: string;
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
        device_uid TEXT PRIMARY KEY, organization_uid TEXT NOT NULL, location_uid TEXT, register_uid TEXT,
        public_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
        created_at TEXT NOT NULL, revoked_at TEXT, rotated_at TEXT, superseded_by TEXT, last_seen_at TEXT, last_sync_at TEXT
      );
      CREATE TABLE IF NOT EXISTS cloud_events (
        event_uid        TEXT PRIMARY KEY,
        entity_type      TEXT NOT NULL,
        entity_uid       TEXT NOT NULL,
        organization_uid TEXT NOT NULL,
        location_uid     TEXT,
        device_uid       TEXT NOT NULL,
        device_sequence  INTEGER NOT NULL,
        feed_seq         INTEGER NOT NULL,
        payload          TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        received_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_events_feed ON cloud_events(organization_uid, feed_seq);
      CREATE INDEX IF NOT EXISTS idx_cloud_events_device ON cloud_events(device_uid);
      -- Append-only entities keep one event per fact (idempotency backstop);
      -- MUTABLE sales entities (order/order_item/bill) may have many snapshot
      -- events per entity_uid, so the uniqueness is scoped away from them.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_events_entity_uid
        ON cloud_events(entity_type, entity_uid)
        WHERE entity_type IN ('inventory_movement', 'audit_event', 'payment_event');
      -- Current-version projection for mutable entities.
      CREATE TABLE IF NOT EXISTS cloud_entity_versions (
        organization_uid   TEXT NOT NULL,
        entity_type        TEXT NOT NULL,
        entity_uid         TEXT NOT NULL,
        current_event_uid  TEXT NOT NULL,
        current_device_uid TEXT NOT NULL,
        snapshot_version   INTEGER NOT NULL DEFAULT 0,
        updated_at         TEXT NOT NULL,
        PRIMARY KEY (organization_uid, entity_type, entity_uid)
      );
      -- Detected cross-device conflicts on mutable entities (never auto-resolved).
      CREATE TABLE IF NOT EXISTS cloud_conflicts (
        conflict_uid     TEXT PRIMARY KEY,
        organization_uid TEXT NOT NULL,
        location_uid     TEXT,
        entity_type      TEXT NOT NULL,
        entity_uid       TEXT NOT NULL,
        local_event_uid  TEXT,
        remote_event_uid TEXT,
        local_device_uid TEXT,
        remote_device_uid TEXT,
        conflict_type    TEXT NOT NULL,
        detected_at      TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
        resolution       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_conflicts_entity ON cloud_conflicts(organization_uid, entity_type, entity_uid);
      CREATE TABLE IF NOT EXISTS cloud_feed_sequence (organization_uid TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cloud_nonces (device_uid TEXT NOT NULL, nonce TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (device_uid, nonce));
      CREATE INDEX IF NOT EXISTS idx_cloud_nonces_seen ON cloud_nonces(seen_at);
      CREATE TABLE IF NOT EXISTS cloud_enrollment_tokens (
        token_hash TEXT PRIMARY KEY, organization_uid TEXT NOT NULL, location_uid TEXT, register_uid TEXT,
        expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cloud_inventory_stock (
        organization_uid TEXT NOT NULL, location_uid TEXT NOT NULL DEFAULT '', product_uid TEXT NOT NULL,
        variant_uid TEXT NOT NULL DEFAULT '', balance REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
        PRIMARY KEY (organization_uid, location_uid, product_uid, variant_uid)
      );
      CREATE TABLE IF NOT EXISTS cloud_inventory_deficits (
        organization_uid TEXT NOT NULL, location_uid TEXT NOT NULL DEFAULT '', product_uid TEXT NOT NULL,
        variant_uid TEXT NOT NULL DEFAULT '', balance REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
        first_detected_at TEXT NOT NULL, last_detected_at TEXT NOT NULL, triggering_movement_uid TEXT NOT NULL,
        PRIMARY KEY (organization_uid, location_uid, product_uid, variant_uid)
      );
      CREATE TABLE IF NOT EXISTS cloud_sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, device_uid TEXT, organization_uid TEXT,
        entity_type TEXT, kind TEXT NOT NULL, detail TEXT
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
      ON CONFLICT(device_uid) DO UPDATE SET organization_uid = excluded.organization_uid, location_uid = excluded.location_uid,
        register_uid = excluded.register_uid, public_key = excluded.public_key, status = excluded.status, revoked_at = NULL
    `).run(device.device_uid, device.organization_uid, device.location_uid ?? null, device.register_uid ?? null,
      device.public_key, device.status, device.created_at ?? new Date().toISOString());
  }

  revokeDevice(deviceUid: string): void {
    this.db.prepare("UPDATE cloud_devices SET status = 'revoked', revoked_at = ? WHERE device_uid = ?").run(new Date().toISOString(), deviceUid);
  }
  rotateDevice(deviceUid: string, newPublicKey: string, at: string): void {
    this.db.prepare('UPDATE cloud_devices SET public_key = ?, rotated_at = ? WHERE device_uid = ?').run(newPublicKey, at, deviceUid);
  }
  markDeviceSeen(deviceUid: string, at: string): void {
    this.db.prepare('UPDATE cloud_devices SET last_seen_at = ? WHERE device_uid = ?').run(at, deviceUid);
  }
  markDeviceSynced(deviceUid: string, at: string): void {
    this.db.prepare('UPDATE cloud_devices SET last_sync_at = ? WHERE device_uid = ?').run(at, deviceUid);
  }

  storeEvent(evt: CloudEvent, receivedAt: string): StoreResult {
    const mutable = MUTABLE_CLOUD_ENTITIES.has(evt.entity_type);
    const txn = this.db.transaction((): StoreResult => {
      // Idempotency: append-only entities dedup by (entity_type, entity_uid) —
      // one fact, one event. Mutable sales entities dedup by event_uid — each
      // snapshot is a distinct event, and the SAME snapshot re-uploaded (lost
      // ACK) is the duplicate (SYNC-E).
      const existing = mutable
        ? this.db.prepare('SELECT 1 FROM cloud_events WHERE event_uid = ?').get(evt.event_uid)
        : this.db.prepare('SELECT 1 FROM cloud_events WHERE entity_type = ? AND entity_uid = ?').get(evt.entity_type, evt.entity_uid);
      if (existing) return 'duplicate';
      // Atomic per-org feed sequence spanning all entity types (Part C/N).
      this.db.prepare(`
        INSERT INTO cloud_feed_sequence (organization_uid, next_seq) VALUES (?, 1)
        ON CONFLICT(organization_uid) DO UPDATE SET next_seq = next_seq + 1
      `).run(evt.organization_uid);
      const feedSeq = (this.db.prepare('SELECT next_seq FROM cloud_feed_sequence WHERE organization_uid = ?').get(evt.organization_uid) as { next_seq: number }).next_seq;
      this.db.prepare(`
        INSERT INTO cloud_events (event_uid, entity_type, entity_uid, organization_uid, location_uid, device_uid, device_sequence, feed_seq, payload, created_at, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(evt.event_uid, evt.entity_type, evt.entity_uid, evt.organization_uid, evt.location_uid, evt.device_uid, evt.device_sequence, feedSeq, evt.payload, evt.created_at, receivedAt);
      if (evt.entity_type === 'inventory_movement') {
        const fields = this.inventoryFieldsFromPayload(evt);
        if (fields) this.projectStockAndFlagDeficit(evt.organization_uid, fields, receivedAt);
      }
      if (mutable) this.projectVersionAndFlagConflict(evt, receivedAt);
      return 'accepted';
    });
    return txn();
  }

  /**
   * Part I/R — maintain the current-version projection for a mutable entity
   * and record a conflict when a DIFFERENT device produces a snapshot of the
   * same entity. This is CONSERVATIVE by design: it flags any cross-device
   * divergence for later review, preserves every snapshot event, and never
   * auto-resolves a financial conflict or deletes history. The current pointer
   * moves to the higher snapshot_version (deterministic), but that is only a
   * read-model hint — the conflict record is the durable truth.
   */
  private projectVersionAndFlagConflict(evt: CloudEvent, at: string): void {
    let snapshotVersion = 0;
    try { snapshotVersion = Number((JSON.parse(evt.payload) as { snapshot_version?: number }).snapshot_version ?? 0); } catch { snapshotVersion = 0; }
    const current = this.db.prepare('SELECT current_event_uid, current_device_uid, snapshot_version FROM cloud_entity_versions WHERE organization_uid = ? AND entity_type = ? AND entity_uid = ?')
      .get(evt.organization_uid, evt.entity_type, evt.entity_uid) as { current_event_uid: string; current_device_uid: string; snapshot_version: number } | undefined;
    if (current && current.current_device_uid !== evt.device_uid) {
      // Two devices touched the same entity — record it (never silently merge).
      const conflictUid = `cf_${evt.event_uid}`;
      this.db.prepare(`
        INSERT OR IGNORE INTO cloud_conflicts (conflict_uid, organization_uid, location_uid, entity_type, entity_uid,
          local_event_uid, remote_event_uid, local_device_uid, remote_device_uid, conflict_type, detected_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'concurrent_update', ?, 'open')
      `).run(conflictUid, evt.organization_uid, evt.location_uid, evt.entity_type, evt.entity_uid,
        current.current_event_uid, evt.event_uid, current.current_device_uid, evt.device_uid, at);
      this.logSync('conflict', { organizationUid: evt.organization_uid, entityType: evt.entity_type, deviceUid: evt.device_uid }, at);
    }
    const winsPointer = !current || snapshotVersion >= current.snapshot_version;
    if (winsPointer) {
      this.db.prepare(`
        INSERT INTO cloud_entity_versions (organization_uid, entity_type, entity_uid, current_event_uid, current_device_uid, snapshot_version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(organization_uid, entity_type, entity_uid) DO UPDATE SET current_event_uid = excluded.current_event_uid,
          current_device_uid = excluded.current_device_uid, snapshot_version = excluded.snapshot_version, updated_at = excluded.updated_at
      `).run(evt.organization_uid, evt.entity_type, evt.entity_uid, evt.event_uid, evt.device_uid, snapshotVersion, at);
    }
  }

  private inventoryFieldsFromPayload(evt: CloudEvent): InventoryProjectionFields | null {
    try {
      const p = JSON.parse(evt.payload) as Record<string, unknown>;
      const product = (p.product_id ?? p.product_uid) as string | undefined;
      if (!product || typeof p.quantity_delta !== 'number') return null;
      return {
        product_uid: String(product),
        variant_uid: (p.product_variant_id ?? p.variant_uid ?? null) as string | null,
        location_uid: evt.location_uid,
        quantity_delta: p.quantity_delta,
        movement_uid: evt.entity_uid,
      };
    } catch { return null; }
  }

  private projectStockAndFlagDeficit(orgUid: string, f: InventoryProjectionFields, at: string): void {
    const loc = f.location_uid ?? '';
    const variant = f.variant_uid ?? '';
    this.db.prepare(`
      INSERT INTO cloud_inventory_stock (organization_uid, location_uid, product_uid, variant_uid, balance, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_uid, location_uid, product_uid, variant_uid)
      DO UPDATE SET balance = balance + excluded.balance, updated_at = excluded.updated_at
    `).run(orgUid, loc, f.product_uid, variant, f.quantity_delta, at);
    const balance = (this.db.prepare(
      'SELECT balance FROM cloud_inventory_stock WHERE organization_uid = ? AND location_uid = ? AND product_uid = ? AND variant_uid = ?',
    ).get(orgUid, loc, f.product_uid, variant) as { balance: number }).balance;
    if (balance < 0) {
      this.db.prepare(`
        INSERT INTO cloud_inventory_deficits
          (organization_uid, location_uid, product_uid, variant_uid, balance, status, first_detected_at, last_detected_at, triggering_movement_uid)
        VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)
        ON CONFLICT(organization_uid, location_uid, product_uid, variant_uid)
        DO UPDATE SET balance = excluded.balance, last_detected_at = excluded.last_detected_at,
          triggering_movement_uid = excluded.triggering_movement_uid,
          status = CASE WHEN cloud_inventory_deficits.status = 'resolved' THEN 'open' ELSE cloud_inventory_deficits.status END
      `).run(orgUid, loc, f.product_uid, variant, balance, at, at, f.movement_uid);
    }
  }

  pullEvents(organizationUid: string, afterCursor: number, limit: number, excludeDeviceUid?: string): CloudPullPage {
    const raw = this.db.prepare(
      'SELECT * FROM cloud_events WHERE organization_uid = ? AND feed_seq > ? ORDER BY feed_seq ASC LIMIT ?',
    ).all(organizationUid, afterCursor, limit) as CloudFeedItem[];
    const hasMore = raw.length === limit;
    const nextCursor = raw.length > 0 ? raw[raw.length - 1].feed_seq : afterCursor;
    const events = excludeDeviceUid ? raw.filter((e) => e.device_uid !== excludeDeviceUid) : raw;
    return { events, nextCursor, hasMore };
  }

  // ── Backward-compatible inventory wrappers ────────────────────────────────
  storeMovement(m: CloudInventoryMovement, receivedAt: string): StoreResult {
    const payload = JSON.stringify({
      schema_version: 1, movement_uid: m.movement_uid, organization_id: m.organization_uid, location_id: m.location_uid,
      product_id: m.product_uid, product_variant_id: m.variant_uid, quantity_delta: m.quantity_delta, movement_type: m.movement_type,
      reason: m.reason, reference_type: m.reference_type, reference_id: m.reference_uid, unit_cost: m.unit_cost,
      actor_user_id: m.actor_uid, metadata: m.metadata ? JSON.parse(m.metadata) : null, created_at: m.created_at,
    });
    return this.storeEvent({
      event_uid: m.event_uid, entity_type: 'inventory_movement', entity_uid: m.movement_uid, organization_uid: m.organization_uid,
      location_uid: m.location_uid, device_uid: m.device_uid, device_sequence: m.device_sequence, payload, created_at: m.created_at,
    }, receivedAt);
  }

  pullMovements(organizationUid: string, afterCursor: number, limit: number, excludeDeviceUid?: string): { events: CloudFeedEvent[]; nextCursor: number; hasMore: boolean } {
    const page = this.pullEvents(organizationUid, afterCursor, limit, excludeDeviceUid);
    const events = page.events.filter((e) => e.entity_type === 'inventory_movement').map((e) => {
      const p = JSON.parse(e.payload) as Record<string, unknown>;
      return {
        event_uid: e.event_uid, movement_uid: e.entity_uid, organization_uid: e.organization_uid, location_uid: e.location_uid,
        device_uid: e.device_uid, device_sequence: e.device_sequence, feed_seq: e.feed_seq, received_at: e.received_at,
        movement_type: String(p.movement_type ?? ''), product_uid: String(p.product_id ?? p.product_uid ?? ''),
        variant_uid: (p.product_variant_id ?? null) as string | null, quantity_delta: Number(p.quantity_delta ?? 0),
        unit_cost: (p.unit_cost ?? null) as number | null, reason: (p.reason ?? null) as string | null,
        reference_type: (p.reference_type ?? null) as string | null, reference_uid: (p.reference_id ?? null) as string | null,
        actor_uid: (p.actor_user_id ?? null) as string | null, metadata: p.metadata != null ? JSON.stringify(p.metadata) : null,
        created_at: e.created_at,
      } as CloudFeedEvent;
    });
    return { events, nextCursor: page.nextCursor, hasMore: page.hasMore };
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
      if (!row || row.consumed_at || row.expires_at < nowIso) return null;
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
  setDeficitStatus(organizationUid: string, locationUid: string | null, productUid: string, variantUid: string | null, status: DeficitStatus, at: string): boolean {
    const res = this.db.prepare(`
      UPDATE cloud_inventory_deficits SET status = ?, last_detected_at = ?
      WHERE organization_uid = ? AND location_uid = ? AND product_uid = ? AND variant_uid = ?
    `).run(status, at, organizationUid, locationUid ?? '', productUid, variantUid ?? '');
    return res.changes > 0;
  }

  listConflicts(organizationUid: string): CloudConflict[] {
    return this.db.prepare('SELECT * FROM cloud_conflicts WHERE organization_uid = ? ORDER BY detected_at DESC').all(organizationUid) as CloudConflict[];
  }
  getEntityVersion(organizationUid: string, entityType: string, entityUid: string): { current_event_uid: string; current_device_uid: string; snapshot_version: number } | null {
    return (this.db.prepare('SELECT current_event_uid, current_device_uid, snapshot_version FROM cloud_entity_versions WHERE organization_uid = ? AND entity_type = ? AND entity_uid = ?')
      .get(organizationUid, entityType, entityUid) as { current_event_uid: string; current_device_uid: string; snapshot_version: number } | undefined) ?? null;
  }

  logSync(kind: string, detail: { deviceUid?: string | null; organizationUid?: string | null; entityType?: string | null; message?: string }, at: string): void {
    this.db.prepare('INSERT INTO cloud_sync_log (at, device_uid, organization_uid, entity_type, kind, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(at, detail.deviceUid ?? null, detail.organizationUid ?? null, detail.entityType ?? null, kind, detail.message ?? null);
  }
  observability(): { accepted: number; duplicate: number; rejected: number; authFailure: number } {
    const count = (kind: string) => (this.db.prepare('SELECT COUNT(*) AS c FROM cloud_sync_log WHERE kind = ?').get(kind) as { c: number }).c;
    return { accepted: count('accepted'), duplicate: count('duplicate'), rejected: count('rejected'), authFailure: count('auth_failure') };
  }
  observabilityByEntity(): Record<string, { accepted: number; duplicate: number; rejected: number }> {
    const rows = this.db.prepare("SELECT entity_type, kind, COUNT(*) AS c FROM cloud_sync_log WHERE kind IN ('accepted','duplicate','rejected') AND entity_type IS NOT NULL GROUP BY entity_type, kind").all() as Array<{ entity_type: string; kind: string; c: number }>;
    const out: Record<string, { accepted: number; duplicate: number; rejected: number }> = {};
    for (const r of rows) {
      out[r.entity_type] = out[r.entity_type] ?? { accepted: 0, duplicate: 0, rejected: 0 };
      (out[r.entity_type] as Record<string, number>)[r.kind] = r.c;
    }
    return out;
  }
  organizationHealth(organizationUid: string): OrganizationHealth {
    const one = (sql: string) => (this.db.prepare(sql).get(organizationUid) as { c: number }).c;
    const lastReceived = (this.db.prepare('SELECT MAX(received_at) AS m FROM cloud_events WHERE organization_uid = ?').get(organizationUid) as { m: string | null }).m;
    const byEntity: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT entity_type, COUNT(*) AS c FROM cloud_events WHERE organization_uid = ? GROUP BY entity_type').all(organizationUid) as Array<{ entity_type: string; c: number }>) byEntity[r.entity_type] = r.c;
    return {
      organization_uid: organizationUid,
      devices: one('SELECT COUNT(*) AS c FROM cloud_devices WHERE organization_uid = ?'),
      active_devices: one("SELECT COUNT(*) AS c FROM cloud_devices WHERE organization_uid = ? AND status = 'active'"),
      events: one('SELECT COUNT(*) AS c FROM cloud_events WHERE organization_uid = ?'),
      deficits: one('SELECT COUNT(*) AS c FROM cloud_inventory_deficits WHERE organization_uid = ?'),
      open_deficits: one("SELECT COUNT(*) AS c FROM cloud_inventory_deficits WHERE organization_uid = ? AND status = 'open'"),
      last_received_at: lastReceived,
      by_entity: byEntity,
    };
  }

  close(): void { this.db.close(); }
}
