/**
 * Plemmo Cloud — PRODUCTION persistence adapter (SYNC-C, Part B/C/K).
 *
 * ## Why Postgres, and why this shape
 *
 * The production backend is **managed PostgreSQL** (see
 * docs/SYNC_C_PRODUCTION_FOUNDATION.md Part B for the full evaluation against
 * VPS-hosted PG, Supabase, and other managed options). It gives us
 * transactional integrity, real per-organization sequences, UNIQUE
 * constraints for idempotency, mature backups/PITR, and headroom well past
 * 3,000 merchants without touching the sync protocol.
 *
 * ## The one honest seam: sync vs async
 *
 * The in-process dev `CloudStore` (SqliteCloudStore) is synchronous because
 * better-sqlite3 is synchronous. A real Postgres driver is asynchronous.
 * Rather than pretend otherwise, the production cloud runs as a STANDALONE
 * async service, and this adapter is async. The wire PROTOCOL and the logical
 * operations are identical to the dev store — same idempotency key, same
 * per-org feed sequence semantics, same org-isolation, same deficit
 * projection — so the local POS client is entirely unaffected by the backend
 * choice, which is the property Part B requires.
 *
 * ## No hard dependency on `pg`
 *
 * This adapter talks to an injected `PgClient` (a 3-line interface). The real
 * driver is loaded lazily by `connectPg()` ONLY when a production DB URL is
 * configured, so `pg` is not required to build, lint, or run the test suite,
 * and the tests never touch a real database or the public internet — they
 * drive this adapter with a fake `PgClient` that records the SQL/transaction
 * structure the production path would execute.
 */

import type {
  CloudDevice, CloudInventoryMovement, CloudPullPage, CloudFeedEvent,
  StoreResult, EnrollmentToken, CloudInventoryDeficit, OrganizationHealth,
} from './store';

/** The minimal async database surface this adapter needs. Both `pg.Pool` and
 *  a pooled client satisfy it; so does a test fake. */
export interface PgClient {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>;
}

/** Runs `fn` inside a single Postgres transaction (BEGIN/COMMIT/ROLLBACK). */
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

/**
 * The async production analogue of `CloudStore`. Method names and semantics
 * mirror the dev store one-for-one; only the return type (Promise) differs.
 */
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

  /**
   * Idempotent store with an ATOMIC per-org feed sequence (Part C). The
   * check-and-insert runs in one transaction; the feed position comes from a
   * per-org row bumped with `UPDATE … RETURNING`, so concurrent transactions
   * serialize on that row and every org's feed_seq is gapless with no
   * duplicates — the Postgres equivalent of the dev store's single-threaded
   * guarantee. The UNIQUE(movement_uid) constraint is the idempotency backstop
   * if two requests race the same fact.
   */
  async storeMovement(m: CloudInventoryMovement, receivedAt: string): Promise<StoreResult> {
    return inTxn(this.pg, async () => {
      const dup = await this.pg.query('SELECT 1 FROM cloud_inventory_movements WHERE movement_uid = $1', [m.movement_uid]);
      if (dup.rowCount > 0) return 'duplicate';
      const seqRes = await this.pg.query<{ next_seq: number }>(
        `INSERT INTO cloud_feed_sequence (organization_uid, next_seq) VALUES ($1, 1)
         ON CONFLICT (organization_uid) DO UPDATE SET next_seq = cloud_feed_sequence.next_seq + 1
         RETURNING next_seq`,
        [m.organization_uid],
      );
      const feedSeq = seqRes.rows[0].next_seq;
      await this.pg.query(
        `INSERT INTO cloud_inventory_movements (
           event_uid, movement_uid, organization_uid, location_uid, device_uid, device_sequence, feed_seq,
           movement_type, product_uid, variant_uid, quantity_delta, unit_cost, reason, reference_type,
           reference_uid, actor_uid, metadata, created_at, received_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [m.event_uid, m.movement_uid, m.organization_uid, m.location_uid, m.device_uid, m.device_sequence, feedSeq,
          m.movement_type, m.product_uid, m.variant_uid, m.quantity_delta, m.unit_cost, m.reason, m.reference_type,
          m.reference_uid, m.actor_uid, m.metadata, m.created_at, receivedAt],
      );
      await this.projectStockAndFlagDeficit(m, receivedAt);
      return 'accepted';
    });
  }

  private async projectStockAndFlagDeficit(m: CloudInventoryMovement, at: string): Promise<void> {
    const loc = m.location_uid ?? '';
    const variant = m.variant_uid ?? '';
    const bal = await this.pg.query<{ balance: number }>(
      `INSERT INTO cloud_inventory_stock (organization_uid, location_uid, product_uid, variant_uid, balance, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (organization_uid, location_uid, product_uid, variant_uid)
       DO UPDATE SET balance = cloud_inventory_stock.balance + EXCLUDED.balance, updated_at = EXCLUDED.updated_at
       RETURNING balance`,
      [m.organization_uid, loc, m.product_uid, variant, m.quantity_delta, at],
    );
    if (bal.rows[0].balance < 0) {
      await this.pg.query(
        `INSERT INTO cloud_inventory_deficits
           (organization_uid, location_uid, product_uid, variant_uid, balance, first_detected_at, last_detected_at, triggering_movement_uid)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7)
         ON CONFLICT (organization_uid, location_uid, product_uid, variant_uid)
         DO UPDATE SET balance = EXCLUDED.balance, last_detected_at = EXCLUDED.last_detected_at, triggering_movement_uid = EXCLUDED.triggering_movement_uid`,
        [m.organization_uid, loc, m.product_uid, variant, bal.rows[0].balance, at, m.movement_uid],
      );
    }
  }

  async pullMovements(organizationUid: string, afterCursor: number, limit: number, excludeDeviceUid?: string): Promise<CloudPullPage> {
    const { rows } = await this.pg.query<CloudFeedEvent>(
      'SELECT * FROM cloud_inventory_movements WHERE organization_uid = $1 AND feed_seq > $2 ORDER BY feed_seq ASC LIMIT $3',
      [organizationUid, afterCursor, limit],
    );
    const hasMore = rows.length === limit;
    const nextCursor = rows.length > 0 ? rows[rows.length - 1].feed_seq : afterCursor;
    const events = excludeDeviceUid ? rows.filter((e) => e.device_uid !== excludeDeviceUid) : rows;
    return { events, nextCursor, hasMore };
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
    // Atomic single-statement consume: only an unconsumed, unexpired token is
    // updated, and the row is returned only if this statement is the one that
    // consumed it — so two racing devices can never both win a token.
    const { rows } = await this.pg.query<EnrollmentToken>(
      `UPDATE cloud_enrollment_tokens SET consumed_at = $2
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at >= $2
       RETURNING *`,
      [tokenHash, nowIso],
    );
    return rows[0] ?? null;
  }

  async listDeficits(organizationUid: string): Promise<CloudInventoryDeficit[]> {
    const { rows } = await this.pg.query<CloudInventoryDeficit>(
      'SELECT * FROM cloud_inventory_deficits WHERE organization_uid = $1 ORDER BY last_detected_at DESC', [organizationUid],
    );
    return rows.map((r) => ({ ...r, location_uid: r.location_uid || null, variant_uid: r.variant_uid || null }));
  }

  async logSync(kind: string, detail: { deviceUid?: string | null; organizationUid?: string | null; message?: string }, at: string): Promise<void> {
    await this.pg.query(
      'INSERT INTO cloud_sync_log (at, device_uid, organization_uid, kind, detail) VALUES ($1,$2,$3,$4,$5)',
      [at, detail.deviceUid ?? null, detail.organizationUid ?? null, kind, detail.message ?? null],
    );
  }

  async organizationHealth(organizationUid: string): Promise<OrganizationHealth> {
    const scalar = async (sql: string) => Number((await this.pg.query<{ c: number }>(sql, [organizationUid])).rows[0]?.c ?? 0);
    const lastReceived = (await this.pg.query<{ m: string | null }>('SELECT MAX(received_at) AS m FROM cloud_inventory_movements WHERE organization_uid = $1', [organizationUid])).rows[0]?.m ?? null;
    return {
      organization_uid: organizationUid,
      devices: await scalar('SELECT COUNT(*) AS c FROM cloud_devices WHERE organization_uid = $1'),
      active_devices: await scalar("SELECT COUNT(*) AS c FROM cloud_devices WHERE organization_uid = $1 AND status = 'active'"),
      movements: await scalar('SELECT COUNT(*) AS c FROM cloud_inventory_movements WHERE organization_uid = $1'),
      deficits: await scalar('SELECT COUNT(*) AS c FROM cloud_inventory_deficits WHERE organization_uid = $1'),
      last_received_at: lastReceived,
    };
  }
}

/**
 * Lazily loads the `pg` driver and returns a `PgClient`-compatible pool. Only
 * called when a production DB URL is configured, so `pg` never needs to be
 * present for dev/test/build. Kept tiny and side-effect-free otherwise.
 */
export async function connectPg(connectionString: string): Promise<PgClient> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pgModule = await import('pg' as string).catch(() => {
    throw new Error("The 'pg' driver is not installed. Add it to the production cloud service before configuring PLEMMO_CLOUD_DB_URL.");
  });
  const Pool = (pgModule as { Pool: new (config: unknown) => PgClient }).Pool;
  return new Pool({ connectionString, max: 10 });
}
