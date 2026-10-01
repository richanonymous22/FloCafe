-- Plemmo Cloud — production schema, version 5 (COMMERCIAL LAYER: plans and merchants).
--
-- Additive. Plans are data an operator edits; a merchant is a customer with a human-readable code and the
-- organisation_uid the sync engine knows it by. Licences (cloud_licenses) are derived from a plan.

CREATE TABLE IF NOT EXISTS cloud_plans (
  plan_id        TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  features       TEXT NOT NULL DEFAULT '[]',   -- JSON array of feature keys
  device_limit   INTEGER,
  location_limit INTEGER,
  grace_days     INTEGER NOT NULL DEFAULT 7,
  term_days      INTEGER,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_merchants (
  merchant_code    TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  contact_email    TEXT,
  organization_uid TEXT NOT NULL UNIQUE,
  plan_id          TEXT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  notes            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cloud_merchants_name ON cloud_merchants(name);
