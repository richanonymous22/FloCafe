-- Plemmo Cloud — production schema, version 2 (SYNC-E: sales).
--
-- Additive. Relaxes cloud_events idempotency for MUTABLE sales entities and
-- adds the version projection + conflict log. Applied by cloud/migrate.ts.

-- The v1 table constraint UNIQUE(entity_type, entity_uid) enforced one event
-- per fact — correct for append-only entities, wrong for mutable sales
-- snapshots (order/order_item/bill emit many events per entity_uid). Replace
-- it with a PARTIAL unique index scoped to the append-only entity types.
ALTER TABLE cloud_events DROP CONSTRAINT IF EXISTS cloud_events_entity_type_entity_uid_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_events_entity_uid
  ON cloud_events(entity_type, entity_uid)
  WHERE entity_type IN ('inventory_movement', 'audit_event', 'payment_event');

-- Current-version projection for mutable entities (read-model hint).
CREATE TABLE IF NOT EXISTS cloud_entity_versions (
  organization_uid   TEXT NOT NULL,
  entity_type        TEXT NOT NULL,
  entity_uid         TEXT NOT NULL,
  current_event_uid  TEXT NOT NULL,
  current_device_uid TEXT NOT NULL,
  snapshot_version   BIGINT NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_uid, entity_type, entity_uid)
);

-- Detected cross-device conflicts on mutable entities. Never auto-resolved;
-- the original snapshots are always preserved in cloud_events.
CREATE TABLE IF NOT EXISTS cloud_conflicts (
  conflict_uid      TEXT PRIMARY KEY,
  organization_uid  TEXT NOT NULL,
  location_uid      TEXT,
  entity_type       TEXT NOT NULL,
  entity_uid        TEXT NOT NULL,
  local_event_uid   TEXT,
  remote_event_uid  TEXT,
  local_device_uid  TEXT,
  remote_device_uid TEXT,
  conflict_type     TEXT NOT NULL,
  detected_at       TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  resolution        TEXT
);
CREATE INDEX IF NOT EXISTS idx_cloud_conflicts_entity ON cloud_conflicts(organization_uid, entity_type, entity_uid);
