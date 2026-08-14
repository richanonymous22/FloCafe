/**
 * Plemmo Core — sync cloud configuration (SYNC-B).
 *
 * The cloud endpoint is read from the environment, never hardcoded to a
 * production URL (Part Q). Development can target a local mock server,
 * staging, or production purely by setting `PLEMMO_SYNC_URL`, with no
 * application-code change. No secret is read here or ever placed in a
 * frontend bundle — only the base URL.
 */

export interface SyncCloudConfig {
  baseUrl: string;
  enabled: boolean;
}

export function getSyncCloudConfig(env: NodeJS.ProcessEnv = process.env): SyncCloudConfig {
  const baseUrl = (env.PLEMMO_SYNC_URL || '').trim();
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    // Sync is off unless a cloud URL is explicitly configured — the POS is
    // local-first and never depends on the cloud being reachable.
    enabled: baseUrl.length > 0,
  };
}
