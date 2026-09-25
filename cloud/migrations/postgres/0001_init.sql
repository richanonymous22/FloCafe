-- Plemmo Cloud — production schema, version 1 (SYNC-C, generalized SYNC-D).
--
-- Cloud schema is INDEPENDENT of the local SQLite schema. Applied ONLY by the
-- standalone cloud service's migration runner (cloud/migrate.ts), never by the
-- desktop app. Forward-only, additive. The runner owns the
-- cloud_schema_version bookkeeping table and records this file's number.
--
-- Rollback: additive DDL is data-preserving; a paired down-migration is added
-- only when required. Backups: managed automated backups + PITR.

-- Device registry: the source of truth for device identity. Org/location/
-- register are resolved from HERE, never from a payload.
CREATE TABLE IF NOT EXISTS cloud_devices (
  device_uid        TEXT PRIMARY KEY,
  organization_uid  TEXT NOT NULL,
  location_uid      TEXT,
  register_uid      TEXT,
  public_key        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at        TIMESTAMPTZ,
  rotated_at        TIMESTAMPTZ,
  superseded_by     TEXT,
  last_seen_at      TIMESTAMPTZ,
  last_sync_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cloud_devices_org ON cloud_devices(organization_uid);

-- Per-organization feed cursor allocator. Concurrent uploads serialize on the
-- org row via UPSERT ... RETURNING, giving a gapless per-org sequence spanning
-- all entity types with no global bottleneck (Part C/N).
CREATE TABLE IF NOT EXISTS cloud_feed_sequence (
  organization_uid  TEXT PRIMARY KEY,
  next_seq          BIGINT NOT NULL DEFAULT 0
);

-- The generic multi-entity feed (Part K/M/N): inventory_movement, audit_event,
-- payment_event. (entity_type, entity_uid) is the idempotency key.
CREATE TABLE IF NOT EXISTS cloud_events (
  event_uid         TEXT PRIMARY KEY,
  entity_type       TEXT NOT NULL,
  entity_uid        TEXT NOT NULL,
  organization_uid  TEXT NOT NULL,
  location_uid      TEXT,
  device_uid        TEXT NOT NULL,
  device_sequence   BIGINT NOT NULL,
  feed_seq          BIGINT NOT NULL,
  -- payload is TEXT (JSON string), NOT JSONB, so it round-trips identically to
  -- the SQLite dev store: CloudEvent.payload is always a JSON string the server
  -- JSON.parses. A future migration can switch to JSONB with a read-time
  -- stringify if cloud-side JSON querying is wanted.
  payload           TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL,
  UNIQUE (entity_type, entity_uid)
);
CREATE INDEX IF NOT EXISTS idx_cloud_events_feed ON cloud_events(organization_uid, feed_seq);
CREATE INDEX IF NOT EXISTS idx_cloud_events_device ON cloud_events(device_uid);
CREATE INDEX IF NOT EXISTS idx_cloud_events_entity ON cloud_events(organization_uid, entity_type);

-- Replay protection. Pruned to the freshness window on every auth (Part P).
CREATE TABLE IF NOT EXISTS cloud_nonces (
  device_uid  TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  seen_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (device_uid, nonce)
);
CREATE INDEX IF NOT EXISTS idx_cloud_nonces_seen ON cloud_nonces(seen_at);

-- One-time device activation tokens (production enrollment, Part F). HASHED.
CREATE TABLE IF NOT EXISTS cloud_enrollment_tokens (
  token_hash        TEXT PRIMARY KEY,
  organization_uid  TEXT NOT NULL,
  location_uid      TEXT,
  register_uid      TEXT,
  expires_at        TIMESTAMPTZ NOT NULL,
  consumed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cross-till inventory projection + detected deficits (Part J). The cloud sums
-- movement deltas; a negative balance is recorded as a deficit fact with a
-- lifecycle status. Movements are NEVER mutated and sales are NEVER reversed.
CREATE TABLE IF NOT EXISTS cloud_inventory_stock (
  organization_uid  TEXT NOT NULL,
  location_uid      TEXT NOT NULL DEFAULT '',
  product_uid       TEXT NOT NULL,
  variant_uid       TEXT NOT NULL DEFAULT '',
  balance           DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_uid, location_uid, product_uid, variant_uid)
);
CREATE TABLE IF NOT EXISTS cloud_inventory_deficits (
  organization_uid        TEXT NOT NULL,
  location_uid            TEXT NOT NULL DEFAULT '',
  product_uid             TEXT NOT NULL,
  variant_uid             TEXT NOT NULL DEFAULT '',
  balance                 DOUBLE PRECISION NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  first_detected_at       TIMESTAMPTZ NOT NULL,
  last_detected_at        TIMESTAMPTZ NOT NULL,
  triggering_movement_uid TEXT NOT NULL,
  PRIMARY KEY (organization_uid, location_uid, product_uid, variant_uid)
);

-- Observability log (Part R), carrying entity_type for per-entity metrics.
CREATE TABLE IF NOT EXISTS cloud_sync_log (
  id                BIGSERIAL PRIMARY KEY,
  at                TIMESTAMPTZ NOT NULL,
  device_uid        TEXT,
  organization_uid  TEXT,
  entity_type       TEXT,
  kind              TEXT NOT NULL,
  detail            TEXT
);
CREATE INDEX IF NOT EXISTS idx_cloud_sync_log_org ON cloud_sync_log(organization_uid, at);
CREATE INDEX IF NOT EXISTS idx_cloud_sync_log_entity ON cloud_sync_log(entity_type, kind);
