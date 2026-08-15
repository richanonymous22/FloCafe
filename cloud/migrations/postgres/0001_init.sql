-- Plemmo Cloud — production schema, version 0001 (SYNC-C, Part K).
--
-- Cloud schema is INDEPENDENT of the local SQLite schema — this is not a
-- translation of any local migration. It is applied by the standalone cloud
-- service's migration runner (see cloud/migrate.ts), never by the desktop
-- app. Forward-only, additive; each file bumps schema_version. Deployment
-- ordering: run pending migrations BEFORE rolling out server code that
-- depends on them (expand/contract).
--
-- Rollback: additive DDL is reversible by a paired down-migration when one is
-- required; data-preserving. Backups: managed Postgres automated
-- backups + point-in-time recovery (see docs Part K).

CREATE TABLE IF NOT EXISTS cloud_schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Device registry: the source of truth for who a device is. Organization /
-- location / register identity is resolved from HERE, never from a payload.
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
-- org's row via UPDATE ... RETURNING, giving a gapless per-org sequence with
-- no global bottleneck (Part C).
CREATE TABLE IF NOT EXISTS cloud_feed_sequence (
  organization_uid  TEXT PRIMARY KEY,
  next_seq          BIGINT NOT NULL DEFAULT 0
);

-- The inventory-movement business fact. movement_uid is the idempotency key.
CREATE TABLE IF NOT EXISTS cloud_inventory_movements (
  event_uid         TEXT PRIMARY KEY,
  movement_uid      TEXT NOT NULL UNIQUE,
  organization_uid  TEXT NOT NULL,
  location_uid      TEXT,
  device_uid        TEXT NOT NULL,
  device_sequence   BIGINT NOT NULL,
  feed_seq          BIGINT NOT NULL,
  movement_type     TEXT NOT NULL,
  product_uid       TEXT NOT NULL,
  variant_uid       TEXT,
  quantity_delta    DOUBLE PRECISION NOT NULL,
  unit_cost         DOUBLE PRECISION,
  reason            TEXT,
  reference_type    TEXT,
  reference_uid     TEXT,
  actor_uid         TEXT,
  metadata          JSONB,
  created_at        TIMESTAMPTZ NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL
);
-- The core pull query: (org, feed_seq) range scan, ascending.
CREATE INDEX IF NOT EXISTS idx_cloud_mov_feed ON cloud_inventory_movements(organization_uid, feed_seq);
CREATE INDEX IF NOT EXISTS idx_cloud_mov_device ON cloud_inventory_movements(device_uid);

-- Replay protection. Pruned to the freshness window on every auth (Part J).
CREATE TABLE IF NOT EXISTS cloud_nonces (
  device_uid  TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  seen_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (device_uid, nonce)
);
CREATE INDEX IF NOT EXISTS idx_cloud_nonces_seen ON cloud_nonces(seen_at);

-- One-time device activation tokens (production enrollment, Part D). Stored
-- HASHED only.
CREATE TABLE IF NOT EXISTS cloud_enrollment_tokens (
  token_hash        TEXT PRIMARY KEY,
  organization_uid  TEXT NOT NULL,
  location_uid      TEXT,
  register_uid      TEXT,
  expires_at        TIMESTAMPTZ NOT NULL,
  consumed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cross-till inventory projection + detected deficits (Part H). The cloud
-- sums movement deltas; a negative balance is recorded as a deficit fact.
-- Movements are NEVER mutated and sales are NEVER reversed.
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
  first_detected_at       TIMESTAMPTZ NOT NULL,
  last_detected_at        TIMESTAMPTZ NOT NULL,
  triggering_movement_uid TEXT NOT NULL,
  PRIMARY KEY (organization_uid, location_uid, product_uid, variant_uid)
);

-- Observability log (Part G).
CREATE TABLE IF NOT EXISTS cloud_sync_log (
  id                BIGSERIAL PRIMARY KEY,
  at                TIMESTAMPTZ NOT NULL,
  device_uid        TEXT,
  organization_uid  TEXT,
  kind              TEXT NOT NULL,
  detail            TEXT
);
CREATE INDEX IF NOT EXISTS idx_cloud_sync_log_org ON cloud_sync_log(organization_uid, at);

INSERT INTO cloud_schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;
