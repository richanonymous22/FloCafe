/**
 * Plemmo Cloud — production server entrypoint (COMMERCIALIZATION, Part A).
 *
 * Boots the sync API for a real deployment: resolves the backend from the
 * environment (managed PostgreSQL via PLEMMO_CLOUD_DB_URL), wires the SAME
 * `createCloudServer` used in dev/test, and listens on PORT. Dev enrollment is
 * OFF unless PLEMMO_SYNC_ENABLE_DEV_ENROLL is explicitly true — it must never
 * be enabled in production. Migrations are NOT run here; the deploy step runs
 * `cloud/run-migrations.ts` first (expand/contract).
 *
 *   PLEMMO_CLOUD_DB_URL=postgres://… PORT=8080 node dist-cloud/serve.js
 *
 * Graceful shutdown on SIGTERM/SIGINT so a rolling deploy drains cleanly.
 */

import { createCloudServer } from './server';
import { createPostgresCloudStore, createSqliteCloudStore } from './factory';
import { resolveCloudBackend } from './factory';

async function main(): Promise<void> {
  const backend = resolveCloudBackend();
  const port = Number(process.env.PORT || 8080);
  const enableDevEnroll = String(process.env.PLEMMO_SYNC_ENABLE_DEV_ENROLL || '').toLowerCase() === 'true';

  if (backend.kind !== 'postgres') {
    console.error('[cloud] refusing to start: production requires PLEMMO_CLOUD_DB_URL (managed PostgreSQL). '
      + 'Set it, or run the dev/test harness for the SQLite backend.');
    process.exit(2);
  }
  if (enableDevEnroll) {
    console.warn('[cloud] WARNING: dev enrollment is ENABLED. This must be false in production.');
  }

  const store = await createPostgresCloudStore(backend.connectionString as string);
  const app = createCloudServer(store, { enableDevEnroll });
  const server = app.listen(port, () => console.log(`[cloud] Plemmo sync API listening on :${port}`));

  const shutdown = (signal: string) => {
    console.log(`[cloud] ${signal} — draining…`);
    server.close(() => { console.log('[cloud] closed'); process.exit(0); });
    // Force-exit if connections don't drain in time.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Keep a reference so the sqlite dev import isn't tree-shaken from type-only use.
  void createSqliteCloudStore;
}

main().catch((error) => { console.error('[cloud] failed to start:', error); process.exit(1); });
