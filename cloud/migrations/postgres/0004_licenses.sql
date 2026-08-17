-- Plemmo Cloud — production schema, version 4 (PLATFORM-HARDENING: licensing).
--
-- Additive. The server-side license record an org's devices verify against.
-- No secret is stored in any client; the device authenticates and receives
-- ONLY its own org's license. Applied by cloud/migrate.ts.

CREATE TABLE IF NOT EXISTS cloud_licenses (
  organization_uid TEXT PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','expired','suspended','revoked','unlicensed')),
  plan             TEXT NOT NULL DEFAULT 'pilot',
  issued_at        TEXT,
  activated_at     TEXT,
  expires_at       TEXT,
  grace_days       INTEGER NOT NULL DEFAULT 7,
  device_limit     INTEGER,
  location_limit   INTEGER,
  features         TEXT NOT NULL DEFAULT '[]',   -- JSON array of feature keys
  signature        TEXT,
  updated_at       TEXT NOT NULL
);
