/**
 * Plemmo Core — licensing foundation (COMMERCIALIZATION, Part I).
 *
 * Answers the one question the software must be able to answer:
 * "Is this merchant / till / device authorized to use this feature?"
 *
 * It is a FOUNDATION, not a billing system. Billing / subscriptions / payment
 * collection remain entirely separate. Licensing sits ABOVE the existing
 * feature-entitlement system (`main/core/features.ts`): a feature is licensed
 * only when the license is effective AND the org's entitlement grants it — so
 * the two compose, they don't duplicate.
 *
 * ## Model (as the spec asks it to be architected)
 *
 *   Organization → Locations → Registers/Tills → Devices → License/entitlement
 *
 * The license is a signed entitlement cached locally (a `settings` row — no
 * migration) so the POS keeps working OFFLINE. Server-side verification
 * refreshes it; when the server is unreachable an OFFLINE GRACE window keeps a
 * valid-but-unverified license effective, after which it lapses to
 * `needs_verification` (still not an instant lockout — the merchant is warned,
 * not stranded mid-service). A `revoked` license is never granted grace.
 *
 * Cryptographic signature verification of the license payload is stubbed
 * behind `LicenseVerifier` — the real server-issued signature check is an
 * external dependency (the cloud license service, not yet deployed); the local
 * cache + effective-status logic here are complete and testable.
 */

import { getDatabase, getSettingValue, now } from '../db';
import { isEnabled } from './features';

const LICENSE_KEY = 'plemmo_license';

export type LicenseStatus = 'active' | 'expired' | 'suspended' | 'revoked' | 'unlicensed';
export type EffectiveStatus = LicenseStatus | 'grace' | 'needs_verification';

export interface License {
  status: LicenseStatus;
  plan: string;
  organization_uid: string | null;
  issued_at: string | null;
  activated_at: string | null;
  expires_at: string | null;      // ISO; null = perpetual
  grace_days: number;             // offline grace after expiry / since last verification
  device_limit: number | null;    // null = unlimited
  location_limit: number | null;
  features: string[];             // entitlement keys this license grants
  last_verified_at: string | null;
  signature: string | null;       // server-issued; verified by LicenseVerifier (external)
}

const UNLICENSED: License = {
  status: 'unlicensed', plan: 'none', organization_uid: null, issued_at: null, activated_at: null,
  expires_at: null, grace_days: 0, device_limit: 0, location_limit: 0, features: [],
  last_verified_at: null, signature: null,
};

function parseIso(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? t : null;
}

/** The locally cached license (offline-usable). Returns an `unlicensed` sentinel when none is stored. */
export function getLicense(): License {
  const raw = getSettingValue(LICENSE_KEY);
  if (!raw) return { ...UNLICENSED };
  try { return { ...UNLICENSED, ...(JSON.parse(raw) as Partial<License>) }; } catch { return { ...UNLICENSED }; }
}

/** Persists the cached license (from activation or a server verification refresh). */
export function setLicense(license: License): void {
  getDatabase().prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(LICENSE_KEY, JSON.stringify(license), now());
}

export function clearLicense(): void {
  getDatabase().prepare('DELETE FROM settings WHERE key = ?').run(LICENSE_KEY);
}

/**
 * The EFFECTIVE status right now, folding in expiry + offline grace:
 *   - revoked / suspended: as stored (revoked never gets grace).
 *   - unlicensed: unlicensed.
 *   - not expired: active.
 *   - expired but within grace (expiry + grace_days): 'grace'.
 *   - stale verification (last_verified_at older than grace_days) while active:
 *     'needs_verification' (still effective, but the merchant should reconnect).
 *   - otherwise: 'expired'.
 */
export function effectiveStatus(license: License = getLicense(), atMs: number = Date.now()): EffectiveStatus {
  if (license.status === 'revoked') return 'revoked';
  if (license.status === 'suspended') return 'suspended';
  if (license.status === 'unlicensed') return 'unlicensed';

  const graceMs = Math.max(0, license.grace_days) * 24 * 60 * 60 * 1000;
  const expiresMs = parseIso(license.expires_at);
  if (expiresMs != null && atMs > expiresMs) {
    return atMs <= expiresMs + graceMs ? 'grace' : 'expired';
  }
  // Not expired — but a long time offline (no verification) is a soft warning.
  const verifiedMs = parseIso(license.last_verified_at);
  if (verifiedMs != null && graceMs > 0 && atMs > verifiedMs + graceMs) return 'needs_verification';
  return 'active';
}

/** True when the license is effective enough to operate (active / grace / needs_verification). */
export function isLicensed(license: License = getLicense(), atMs: number = Date.now()): boolean {
  const s = effectiveStatus(license, atMs);
  return s === 'active' || s === 'grace' || s === 'needs_verification';
}

/** Whether a still-valid-but-unverified license is running on offline grace. */
export function withinOfflineGrace(license: License = getLicense(), atMs: number = Date.now()): boolean {
  const s = effectiveStatus(license, atMs);
  return s === 'grace' || s === 'needs_verification';
}

/**
 * The commercial authorization question. A feature is entitled when the
 * license is effective AND grants the feature AND the org's own entitlement set
 * enables it (the two layers compose). `organizationId` defaults to the
 * license's org.
 */
export function isFeatureLicensed(featureKey: string, organizationId?: string, atMs: number = Date.now()): boolean {
  const license = getLicense();
  if (!isLicensed(license, atMs)) return false;
  if (license.features.length > 0 && !license.features.includes(featureKey)) return false;
  const orgId = organizationId ?? license.organization_uid;
  if (!orgId) return license.features.includes(featureKey);
  return isEnabled(orgId, featureKey);
}

export function deviceCountWithinLimit(activeDevices: number, license: License = getLicense()): boolean {
  return license.device_limit == null || activeDevices <= license.device_limit;
}
export function locationCountWithinLimit(activeLocations: number, license: License = getLicense()): boolean {
  return license.location_limit == null || activeLocations <= license.location_limit;
}

export class LicenseError extends Error {
  statusCode = 403;
  constructor(message: string) { super(message); this.name = 'LicenseError'; }
}

/** Throws unless the feature is licensed — the enforcement entry point for gated paths. */
export function requireFeatureLicensed(featureKey: string, organizationId?: string): void {
  if (!isFeatureLicensed(featureKey, organizationId)) {
    throw new LicenseError(`Feature '${featureKey}' is not licensed for this organization`);
  }
}

/**
 * Server-side verification seam (external dependency: the cloud license
 * service). A real implementation calls the cloud, checks the signature, and
 * returns the fresh license. Kept as an interface so the offline cache + the
 * effective-status logic above are fully testable without the service.
 */
export interface LicenseVerifier {
  verify(organizationUid: string): Promise<License>;
}

/**
 * Refreshes the cached license from the server, stamping `last_verified_at`.
 * On a verifier error the CACHED license is kept (offline grace) — a transient
 * network failure never strands a paying merchant.
 */
export async function refreshLicense(verifier: LicenseVerifier, organizationUid: string): Promise<License> {
  try {
    const fresh = await verifier.verify(organizationUid);
    const verified: License = { ...fresh, last_verified_at: now() };
    setLicense(verified);
    return verified;
  } catch {
    return getLicense(); // keep the cached entitlement — offline grace applies
  }
}

/** Activates a license locally from a server-issued payload (activation flow). */
export function activateLicense(license: License): License {
  const activated: License = { ...license, status: 'active', activated_at: license.activated_at ?? now(), last_verified_at: now() };
  setLicense(activated);
  return activated;
}

/**
 * A `LicenseVerifier` backed by the cloud license endpoint
 * (`GET /sync/v1/license`, PLATFORM-HARDENING). The org is resolved server-side
 * from the authenticated device, so no secret is embedded in the client. A
 * missing/unlicensed cloud record yields an `unlicensed` license; a network
 * failure throws (so `refreshLicense` keeps the cached entitlement — offline
 * grace). The real signed-payload check would be added here when the cloud
 * license service signs its responses.
 */
export function createCloudLicenseVerifier(pullLicense: () => Promise<Record<string, unknown> | null>): LicenseVerifier {
  return {
    async verify(_organizationUid: string): Promise<License> {
      const raw = await pullLicense();
      if (!raw) return { ...UNLICENSED };
      return {
        ...UNLICENSED,
        status: (raw.status as License['status']) ?? 'unlicensed',
        plan: String(raw.plan ?? 'none'),
        organization_uid: (raw.organization_uid as string) ?? null,
        issued_at: (raw.issued_at as string) ?? null,
        activated_at: (raw.activated_at as string) ?? null,
        expires_at: (raw.expires_at as string) ?? null,
        grace_days: Number(raw.grace_days ?? 0),
        device_limit: raw.device_limit == null ? null : Number(raw.device_limit),
        location_limit: raw.location_limit == null ? null : Number(raw.location_limit),
        features: Array.isArray(raw.features) ? (raw.features as string[]) : [],
        signature: (raw.signature as string) ?? null,
      };
    },
  };
}
