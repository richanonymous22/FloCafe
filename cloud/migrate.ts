/**
 * Plemmo Cloud — production migration runner (SYNC-D, Part B/K).
 *
 * Applies the forward-only SQL migrations in cloud/migrations/postgres/ to a
 * real PostgreSQL database, tracking applied versions in
 * `cloud_schema_version`. Runs ONLY as part of the standalone cloud service /
 * deploy step — the desktop app never calls this and never executes cloud DDL.
 *
 * Each migration file is `NNNN_name.sql`; the leading number is its version.
 * Each is applied inside its own transaction, then recorded — so a failure
 * rolls the whole file back and leaves the version unrecorded (safe to retry).
 * Deployment ordering is expand/contract: run pending migrations BEFORE
 * rolling out server code that depends on them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PgClient } from './postgres-store';

export const MIGRATIONS_DIR = path.join(__dirname, 'migrations', 'postgres');

export interface MigrationFile { version: number; name: string; file: string; sql: string; }

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((f) => {
      const version = parseInt(f.split('_')[0], 10);
      return { version, name: f.replace(/\.sql$/, ''), file: path.join(dir, f), sql: fs.readFileSync(path.join(dir, f), 'utf8') };
    })
    .sort((a, b) => a.version - b.version);
}

export interface MigrateResult { applied: number[]; alreadyApplied: number[]; currentVersion: number; }

/** Applies all pending migrations. Idempotent — re-running applies nothing new. */
export async function migrateToLatest(pg: PgClient, dir = MIGRATIONS_DIR): Promise<MigrateResult> {
  await pg.query(`CREATE TABLE IF NOT EXISTS cloud_schema_version (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const appliedRows = (await pg.query<{ version: number }>('SELECT version FROM cloud_schema_version')).rows;
  const applied = new Set(appliedRows.map((r) => Number(r.version)));

  const result: MigrateResult = { applied: [], alreadyApplied: [...applied].sort((a, b) => a - b), currentVersion: 0 };
  for (const m of loadMigrations(dir)) {
    if (applied.has(m.version)) continue;
    await pg.query('BEGIN');
    try {
      await pg.query(m.sql);
      await pg.query('INSERT INTO cloud_schema_version (version) VALUES ($1)', [m.version]);
      await pg.query('COMMIT');
      result.applied.push(m.version);
    } catch (error) {
      await pg.query('ROLLBACK');
      throw new Error(`cloud migration ${m.name} failed: ${(error as Error).message}`);
    }
  }
  result.currentVersion = (await pg.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) AS v FROM cloud_schema_version')).rows[0].v;
  return result;
}
