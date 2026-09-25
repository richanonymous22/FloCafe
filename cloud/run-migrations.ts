/**
 * Plemmo Cloud — production migration entrypoint (SYNC-D, Part U).
 *
 * The command the deploy step runs to bring a production PostgreSQL database
 * to the latest cloud schema BEFORE new server code is rolled out
 * (expand/contract). Connects via PLEMMO_CLOUD_DB_URL, applies pending
 * migrations, prints the result, and exits non-zero on failure.
 *
 *   PLEMMO_CLOUD_DB_URL=postgres://user:pass@host:5432/plemmo npx ts-node cloud/run-migrations.ts
 *   # or, after `npm run build:cloud`:  node dist-cloud/run-migrations.js
 */

import { connectPg } from './postgres-store';
import { migrateToLatest } from './migrate';

async function main(): Promise<void> {
  const url = (process.env.PLEMMO_CLOUD_DB_URL || '').trim();
  if (!url) {
    console.error('PLEMMO_CLOUD_DB_URL is not set. Refusing to run migrations against an unknown database.');
    process.exit(2);
  }
  const pg = await connectPg(url);
  try {
    const result = await migrateToLatest(pg);
    console.log(`[cloud-migrate] applied: [${result.applied.join(', ')}], now at version ${result.currentVersion}`);
  } finally {
    const maybeEnd = (pg as unknown as { end?: () => Promise<void> }).end;
    if (typeof maybeEnd === 'function') await maybeEnd.call(pg);
  }
}

main().catch((error) => { console.error('[cloud-migrate] failed:', (error as Error).message); process.exit(1); });
