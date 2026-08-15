-- Plemmo Cloud — production schema, version 3 (SYNC-F: conflict resolution).
--
-- Additive. Extends cloud_conflicts with the resolution/state fields and adds
-- the append-only cloud_conflict_resolutions history table. No existing data
-- is touched; no destructive change. Applied by cloud/migrate.ts.

-- Allow the 'dismissed' terminal state alongside the existing statuses.
ALTER TABLE cloud_conflicts DROP CONSTRAINT IF EXISTS cloud_conflicts_status_check;
ALTER TABLE cloud_conflicts ADD CONSTRAINT cloud_conflicts_status_check
  CHECK (status IN ('open','acknowledged','resolved','dismissed'));

-- Resolution outcome fields (nullable — a conflict is 'open' with none set).
ALTER TABLE cloud_conflicts ADD COLUMN IF NOT EXISTS resolution_strategy    TEXT;
ALTER TABLE cloud_conflicts ADD COLUMN IF NOT EXISTS resolution_actor       TEXT;
ALTER TABLE cloud_conflicts ADD COLUMN IF NOT EXISTS resolved_at            TEXT;
ALTER TABLE cloud_conflicts ADD COLUMN IF NOT EXISTS resolution_notes       TEXT;
ALTER TABLE cloud_conflicts ADD COLUMN IF NOT EXISTS compensation_reference TEXT;
ALTER TABLE cloud_conflicts ADD COLUMN IF NOT EXISTS acknowledged_at        TEXT;

-- Append-only resolution history — the cloud never destroys a conflict's
-- trail. Each device-reported resolution is one row here (who / when / how /
-- compensation reference), even as cloud_conflicts holds the current summary.
CREATE TABLE IF NOT EXISTS cloud_conflict_resolutions (
  id                     TEXT PRIMARY KEY,
  conflict_uid           TEXT NOT NULL,
  organization_uid       TEXT NOT NULL,
  status                 TEXT NOT NULL,
  strategy               TEXT,
  resolution_notes       TEXT,
  compensation_reference TEXT,
  actor_user_id          TEXT,
  device_uid             TEXT NOT NULL,
  recorded_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cloud_conflict_resolutions ON cloud_conflict_resolutions(conflict_uid, recorded_at);
