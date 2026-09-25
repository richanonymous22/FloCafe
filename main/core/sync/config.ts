/**
 * Plemmo Core — sync cloud configuration (SYNC-B, extended SYNC-C Part I).
 *
 * The cloud endpoint and environment are read from the environment, never
 * hardcoded to a production URL. Three environments are supported —
 * development, staging, production — selected by `PLEMMO_SYNC_ENV`.
 *
 * Safety guards (Part I):
 *   - Safe default: with no `PLEMMO_SYNC_URL`, sync is DISABLED. The POS is
 *     local-first and never depends on the cloud being reachable.
 *   - A production endpoint (`https://…`) cannot be used while
 *     `PLEMMO_SYNC_ENV` is development — the config reports disabled + a
 *     reason, so a dev build cannot accidentally talk to production.
 *   - No secret is read here or ever placed in a frontend bundle — only the
 *     base URL and the environment name.
 */

export type SyncEnvironment = 'development' | 'staging' | 'production';

export interface SyncCloudConfig {
  baseUrl: string;
  environment: SyncEnvironment;
  enabled: boolean;
  /** When disabled despite a URL being set, why (for logs / diagnostics). */
  disabledReason?: string;
}

export function getSyncEnvironment(env: NodeJS.ProcessEnv = process.env): SyncEnvironment {
  const raw = (env.PLEMMO_SYNC_ENV || '').trim().toLowerCase();
  if (raw === 'production' || raw === 'staging') return raw;
  return 'development';
}

function looksLikeProductionUrl(url: string): boolean {
  if (!/^https:\/\//i.test(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    // localhost / loopback / .local are never "production".
    return !(host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local'));
  } catch {
    return false;
  }
}

export function getSyncCloudConfig(env: NodeJS.ProcessEnv = process.env): SyncCloudConfig {
  const baseUrl = (env.PLEMMO_SYNC_URL || '').trim().replace(/\/+$/, '');
  const environment = getSyncEnvironment(env);

  if (baseUrl.length === 0) {
    return { baseUrl: '', environment, enabled: false, disabledReason: 'no PLEMMO_SYNC_URL configured' };
  }
  // Guard: a real production endpoint must not be reachable from a dev build.
  if (environment === 'development' && looksLikeProductionUrl(baseUrl)) {
    return { baseUrl, environment, enabled: false, disabledReason: 'refusing a production-looking https endpoint while PLEMMO_SYNC_ENV=development' };
  }
  // Guard: production must use TLS.
  if (environment === 'production' && !/^https:\/\//i.test(baseUrl)) {
    return { baseUrl, environment, enabled: false, disabledReason: 'production requires an https:// endpoint' };
  }
  return { baseUrl, environment, enabled: true };
}
