-- Plemmo Cloud — production schema, version 6 (shared rate limiting).
--
-- Additive. A fixed-window counter per key, shared by every instance of the service, so a limit means the
-- same thing whether one container or five is running. Stale windows are pruned opportunistically.

CREATE TABLE IF NOT EXISTS cloud_rate_limits (
  key          TEXT PRIMARY KEY,
  window_start BIGINT NOT NULL,
  hits         INTEGER NOT NULL
);
