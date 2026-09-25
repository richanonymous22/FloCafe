/**
 * Plemmo Cloud — backend selection (SYNC-C, Part B/I).
 *
 * Chooses the persistence backend from configuration, so the cloud SERVICE
 * (not the desktop client) can run SQLite in dev/test and managed Postgres in
 * production with no code change to the sync API. The desktop client never
 * imports this — it only ever speaks the HTTP protocol.
 *
 * Safe defaults (Part I): with no `PLEMMO_CLOUD_DB_URL` the dev SQLite backend
 * is selected. A production Postgres backend is only ever selected when a DB
 * URL is explicitly configured, so a misconfigured dev run can never
 * accidentally point at production storage.
 */

import { SqliteCloudStore } from './store';
import { PostgresCloudStore, connectPg, PgClient } from './postgres-store';

export type CloudBackendKind = 'sqlite' | 'postgres';

export interface CloudBackendConfig {
  kind: CloudBackendKind;
  connectionString?: string;
  sqliteFile?: string;
}

/** Resolves which backend to use from the environment. */
export function resolveCloudBackend(env: NodeJS.ProcessEnv = process.env): CloudBackendConfig {
  const url = (env.PLEMMO_CLOUD_DB_URL || '').trim();
  if (url) return { kind: 'postgres', connectionString: url };
  return { kind: 'sqlite', sqliteFile: (env.PLEMMO_CLOUD_SQLITE_FILE || ':memory:').trim() };
}

/** Builds the dev/test SQLite store. */
export function createSqliteCloudStore(config: CloudBackendConfig = { kind: 'sqlite' }): SqliteCloudStore {
  return new SqliteCloudStore(config.sqliteFile ?? ':memory:');
}

/** Builds the production Postgres store from a live connection. */
export async function createPostgresCloudStore(connectionString: string): Promise<PostgresCloudStore> {
  const client: PgClient = await connectPg(connectionString);
  return new PostgresCloudStore(client);
}
