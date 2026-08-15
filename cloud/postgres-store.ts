/**
 * Plemmo Cloud — PRODUCTION persistence adapter (SYNC-C, multi-entity SYNC-D).
 *
 * The async production analogue of `CloudStore`, run against a REAL PostgreSQL
 * server. Method names and semantics mirror `SqliteCloudStore` one-for-one;
 * only the return type (Promise) differs, so the sync PROTOCOL and the local
 * client are unaffected by the backend choice.
 *
 * ## Multi-entity generic feed
 * A single `cloud_events` table holds inventory_movement / audit_event /
 * payment_event facts, idempotent by (entity_type, entity_uid), ordered by ONE
 * per-organization `feed_seq` allocated with `UPSERT … RETURNING` so
 * concurrent transactions serialize on the org row (Part C — proven against
 * real Postgres in tests/sync-d-production.test.ts).
 *
 * `pg` is loaded lazily by `connectPg()` only when a production DB URL is set.
 */

import type {
  CloudDevice, CloudEvent, CloudPullPage, CloudFeedItem,
  StoreResult, EnrollmentToken, CloudInventoryDeficit, OrganizationHealth,
  DeficitStatus, CloudInventoryMovement, CloudFeedEvent,
} from './store';

export interface PgClient {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>;
}

async function inTxn<T>(pg: PgClient, fn: () => Promise<T>): Promise<T> {
  await pg.query('BEGIN');
  try {
    const result = await fn();
    await pg.query('COMMIT');
    return result;
  } catch (error) {
    await pg.query('ROLLBACK');
    throw error;
  }
}

interface InventoryFields { product_uid: string; variant_uid: string | null; location_uid: string | null; quantity_delta: number; movement_uid: string; }

export class PostgresCloudStore {
  constructor(private pg: PgClient) {}

  async getDevice(deviceUid: string): Promise<CloudDevice | null> {
    const { rows } = await this.pg.query<CloudDevice>('SELECT * FROM cloud_devices WHERE device_uid = $1', [deviceUid]);
    return rows[0] ?? null;
  }

  async registerDevice(device: CloudDevice): Promise<void> {
    await this.pg.query(
      `INSERT INTO cloud_devices (device_uid, organization_uid, location_uid, register_uid, public_key, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (device_uid) DO UPDATE SET organization_uid = EXCLUDED.organization_uid,
         location_uid = EXCLUDED.location_uid, register_uid = EXCLUDED.register_uid,
         public_key = EXCLUDED.public_key, status = EXCLUDED.status, revoked_at = NULL`,
      [device.device_uid, device.organization_uid, device.location_uid ?? null, device.register_uid ?? null, device.public_key, device.status],
    );
  }

  async revokeDevice(deviceUid: string): Promise<void> {
    await this.pg.query("UPDATE cloud_devices SET status = 'revoked', revoked_at = now() WHERE device_uid = $1", [deviceUid]);
  }
  async rotateDevice(deviceUid: string, newPublicKey: string): Promise<void> {
    await this.pg.query('UPDATE cloud_devices SET public_key = $2, rotated_at = now() WHERE device_uid = $1', [deviceUid, newPublicKey]);
  }
  async markDeviceSeen(deviceUid: string): Promise<void> {
    await this.pg.query('UPDATE cloud_devices SET last_seen_at = now() WHERE device_uid = $1', [deviceUid]);
  }
  async markDeviceSynced(deviceUid: string): Promise<void> {
    await this.pg.query('UPDATE cloud_devices SET last_sync_at = now() WHERE device_uid = $1', [deviceUid]);
  }

  async storeEvent(evt: CloudEvent, receivedAt: string): Promise<StoreResult> {
    return inTxn(this.pg, async () => {
      const dup = await this.pg.query('SELECT 1 FROM cloud_events WHERE entity_type = $1 AND entity_uid = $2', [evt.entity_type, evt.entity_uid]);
      if (dup.rowCount > 0) return 'duplicate';
      const seqRes = await this.pg.query<{ next_seq: number }>(
        `INSERT INTO cloud_feed_sequence (organization_uid, next_seq) VALUES ($1, 1)
         ON CONFLICT (organization_uid) DO UPDATE SET next_seq = cloud_feed_sequence.next_seq + 1
         RETURNING next_seq`,
        [evt.organization_uid],
      );
      const feedSeq = seqRes.rows[0].next_seq;
      await this.pg.query(
        `INSERT INTO cloud_events (event_uid, entity_type, entity_uid, organization_uid, location_uid, device_uid, device_sequence, feed_seq, payload, created_at, received_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [evt.event_uid, evt.entity_type, evt.entity_uid, evt.organization_uid, evt.location_uid, evt.device_uid, evt.device_sequence, feedSeq, evt.payload, evt.created_at, receivedAt],
      );
      if (evt.entity_type === 'inventory_movement') {
        const f = this.inventoryFields(evt);
        if (f) await this.projectStockAndFlagDeficit(evt.organization_uid, f, receivedAt);
      }
      return 'accepted';
    });
  }

  private inventoryFields(evt: CloudEvent): InventoryFields | null {
    try {
      const p = JSON.parse(evt.payload) as Record<string, unknown>;
      const product = (p.product_id ?? p.product_uid) as string | undefined;
      if (!product || typeof p.quantity_delta !== 'number') return null;
      return { product_uid: String(product), variant_uid: (p.product_variant_id ?? p.variant_uid ?? null) as string | null, location_uid: evt.location_uid, quantity_delta: p.quantity_delta, movement_uid: evt.entity_uid };
    } catch { return null; }
  }

  private async projectStockAndFlagDeficit(orgUid: string, f: InventoryFields, at: string): Promise<void> {
    const loc = f.location_uid ?? '';
    const variant = f.variant_uid ?? '';
    const bal = await this.pg.query<{ balance: number }>(
      `INSERT INTO cloud_inventory_stock (organization_uid, location_uid, product_uid, variant_uid, balance, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (organization_uid, location_uid, product_uid, variant_uid)
       DO UPDATE SET balance = cloud_inventory_stock.balance + EXCLUDED.balance, updated_at = EXCLUDED.updated_at
       RETURNING balance`,
      [orgUid, loc, f.product_uid, variant, f.quantity_delta, at],
    );
    if (Number(bal.rows[0].balance) < 0) {
      await this.pg.query(
        `INSERT INTO cloud_inventory_deficits
           (organization_uid, location_uid, product_uid, variant_uid, balance, status, first_detected_at, last_detected_at, triggering_movement_uid)
         VALUES ($1,$2,$3,$4,$5,'open',$6,$6,$7)
         ON CONFLICT (organization_uid, location_uid, product_uid, variant_uid)
         DO UPDATE SET balance = EXCLUDED.balance, last_detected_at = EXCLUDED.last_detected_at, triggering_movement_uid = EXCLUDED.triggering_movement_uid,
           status = CASE WHEN cloud_inventory_deficits.status = 'resolved' THEN 'open' ELSE cloud_inventory_deficits.status END`,
        [orgUid, loc, f.product_uid, variant, bal.rows[0].balance, at, f.movement_uid],
      );
    }
  }

  async pullEvents(organizationUid: string, afterCursor: number, limit: number, excludeDeviceUid?: string): Promise<CloudPullPage> {
    const { rows } = await this.pg.query<CloudFeedItem>(
      'SELECT * FROM cloud_events WHERE organization_uid = $1 AND feed_seq > $2 ORDER BY feed_seq ASC LIMIT $3',
      [organizationUid, afterCursor, limit],
    );
    // pg returns BIGINT as a string — coerce feed_seq/device_sequence to number
    // so the contract matches the SQLite store exactly.
    const coerced = rows.map((e) => ({ ...e, feed_seq: Number(e.feed_seq), device_sequence: Number(e.device_sequence) }));
    const hasMore = coerced.length === limit;
    const nextCursor = coerced.length > 0 ? coerced[coerced.length - 1].feed_seq : afterCursor;
    const events = excludeDeviceUid ? coerced.filter((e) => e.device_uid !== excludeDeviceUid) : coerced;
    return { events, nextCursor, hasMore };
  }

  // ── Backward-compatible inventory wrappers ────────────────────────────────
  async storeMovement(m: CloudInventoryMovement, receivedAt: string): Promise<StoreResult> {
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

  async pullMovements(organizationUid: string, afterCursor: number, limit: number, excludeDeviceUid?: string): Promise<{ events: CloudFeedEvent[]; nextCursor: number; hasMore: boolean }> {
    const page = await this.pullEvents(organizationUid, afterCursor, limit, excludeDeviceUid);
    const events = page.events.filter((e) => e.entity_type === 'inventory_movement').map((e) => {
      const p = JSON.parse(e.payload) as Record<string, unknown>;
      return {
        event_uid: e.event_uid, movement_uid: e.entity_uid, organization_uid: e.organization_uid, location_uid: e.location_uid,
        device_uid: e.device_uid, device_sequence: Number(e.device_sequence), feed_seq: Number(e.feed_seq), received_at: e.received_at,
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

  async seenNonce(deviceUid: string, nonce: string): Promise<boolean> {
    const { rowCount } = await this.pg.query('SELECT 1 FROM cloud_nonces WHERE device_uid = $1 AND nonce = $2', [deviceUid, nonce]);
    return rowCount > 0;
  }
  async recordNonce(deviceUid: string, nonce: string, at: string): Promise<void> {
    await this.pg.query('INSERT INTO cloud_nonces (device_uid, nonce, seen_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [deviceUid, nonce, at]);
  }
  async pruneNonces(olderThanIso: string): Promise<number> {
    const { rowCount } = await this.pg.query('DELETE FROM cloud_nonces WHERE seen_at < $1', [olderThanIso]);
    return rowCount;
  }

  async createEnrollmentToken(token: EnrollmentToken): Promise<void> {
    await this.pg.query(
      `INSERT INTO cloud_enrollment_tokens (token_hash, organization_uid, location_uid, register_uid, expires_at, consumed_at, created_at)
       VALUES ($1,$2,$3,$4,$5, NULL, now())`,
      [token.token_hash, token.organization_uid, token.location_uid ?? null, token.register_uid ?? null, token.expires_at],
    );
  }
  async consumeEnrollmentToken(tokenHash: string, nowIso: string): Promise<EnrollmentToken | null> {
    const { rows } = await this.pg.query<EnrollmentToken>(
      `UPDATE cloud_enrollment_tokens SET consumed_at = $2
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at >= $2 RETURNING *`,
      [tokenHash, nowIso],
    );
    return rows[0] ?? null;
  }

  async listDeficits(organizationUid: string): Promise<CloudInventoryDeficit[]> {
    const { rows } = await this.pg.query<CloudInventoryDeficit>('SELECT * FROM cloud_inventory_deficits WHERE organization_uid = $1 ORDER BY last_detected_at DESC', [organizationUid]);
    return rows.map((r) => ({ ...r, location_uid: r.location_uid || null, variant_uid: r.variant_uid || null }));
  }
  async setDeficitStatus(organizationUid: string, locationUid: string | null, productUid: string, variantUid: string | null, status: DeficitStatus, at: string): Promise<boolean> {
    const { rowCount } = await this.pg.query(
      `UPDATE cloud_inventory_deficits SET status = $5, last_detected_at = $6
       WHERE organization_uid = $1 AND location_uid = $2 AND product_uid = $3 AND variant_uid = $4`,
      [organizationUid, locationUid ?? '', productUid, variantUid ?? '', status, at],
    );
    return rowCount > 0;
  }

  async logSync(kind: string, detail: { deviceUid?: string | null; organizationUid?: string | null; entityType?: string | null; message?: string }, at: string): Promise<void> {
    await this.pg.query(
      'INSERT INTO cloud_sync_log (at, device_uid, organization_uid, entity_type, kind, detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [at, detail.deviceUid ?? null, detail.organizationUid ?? null, detail.entityType ?? null, kind, detail.message ?? null],
    );
  }

  async organizationHealth(organizationUid: string): Promise<OrganizationHealth> {
    const scalar = async (sql: string) => Number((await this.pg.query<{ c: number }>(sql, [organizationUid])).rows[0]?.c ?? 0);
    const lastReceived = (await this.pg.query<{ m: string | null }>('SELECT MAX(received_at) AS m FROM cloud_events WHERE organization_uid = $1', [organizationUid])).rows[0]?.m ?? null;
    const byRows = (await this.pg.query<{ entity_type: string; c: number }>('SELECT entity_type, COUNT(*) AS c FROM cloud_events WHERE organization_uid = $1 GROUP BY entity_type', [organizationUid])).rows;
    const byEntity: Record<string, number> = {};
    for (const r of byRows) byEntity[r.entity_type] = Number(r.c);
    return {
      organization_uid: organizationUid,
      devices: await scalar('SELECT COUNT(*) AS c FROM cloud_devices WHERE organization_uid = $1'),
      active_devices: await scalar("SELECT COUNT(*) AS c FROM cloud_devices WHERE organization_uid = $1 AND status = 'active'"),
      events: await scalar('SELECT COUNT(*) AS c FROM cloud_events WHERE organization_uid = $1'),
      deficits: await scalar('SELECT COUNT(*) AS c FROM cloud_inventory_deficits WHERE organization_uid = $1'),
      open_deficits: await scalar("SELECT COUNT(*) AS c FROM cloud_inventory_deficits WHERE organization_uid = $1 AND status = 'open'"),
      last_received_at: lastReceived,
      by_entity: byEntity,
    };
  }
}

/**
 * Lazily loads the `pg` driver and returns a `PgClient`-compatible pool. Only
 * called when a production DB URL is configured, so `pg` is not needed to
 * build, lint, or run the default test suite.
 */
export async function connectPg(connectionString: string): Promise<PgClient> {
  const pgModule = await import('pg' as string).catch(() => {
    throw new Error("The 'pg' driver is not installed. Add it before configuring PLEMMO_CLOUD_DB_URL.");
  });
  const Pool = (pgModule as { Pool: new (config: unknown) => PgClient }).Pool;
  return new Pool({ connectionString, max: 10 });
}
