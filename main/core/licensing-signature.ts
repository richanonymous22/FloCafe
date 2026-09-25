/**
 * Plemmo Core — license payload signature verification (COMMERCIALIZATION, B2).
 *
 * Closes the license-authenticity gap: the client must not trust a license
 * payload just because it arrived over HTTPS. The cloud license service signs
 * the payload's authenticated fields with an Ed25519 private key; the client
 * verifies the signature against a PINNED public key shipped with the app.
 *
 * The canonical string is deliberately tiny and stable, and is DUPLICATED —
 * not imported — on the cloud side (`cloud/license-signing.ts`), exactly as the
 * request-signing canonical string is (`cloud/signing.ts` ↔
 * `main/core/sync/signing.ts`). If this format changes, BOTH copies change
 * together.
 *
 * Key handling:
 *   - The public key is read from `PLEMMO_LICENSE_PUBLIC_KEY` (SPKI PEM; a
 *     single-line value with literal "\n" is accepted). In a packaged build
 *     this env is baked in / provided by the launcher, so it is effectively
 *     pinned. No private key ever exists on the client.
 *   - When NO public key is configured (local dev, tests, unmanaged installs),
 *     verification is SKIPPED and the payload passes through unchanged — this
 *     preserves the offline-first dev flow. Managed/commercial builds set the
 *     env, which turns the gate on.
 */

import { createPublicKey, verify as edVerify, KeyObject } from 'crypto';

/** The subset of license fields covered by the signature (authenticated fields). */
export interface SignableLicense {
  status: string;
  plan: string;
  organization_uid: string | null;
  issued_at: string | null;
  activated_at: string | null;
  expires_at: string | null;
  grace_days: number;
  device_limit: number | null;
  location_limit: number | null;
  features: string[];
}

/**
 * Deterministic string bound to every authenticated license field. `null` for a
 * limit is the meaningful "unlimited" value and is encoded distinctly from 0.
 * Features are sorted so ordering never changes the signature.
 */
export function canonicalLicense(l: SignableLicense): string {
  const limit = (n: number | null): string => (n == null ? 'null' : String(n));
  const features = Array.isArray(l.features) ? [...l.features].sort() : [];
  return [
    l.status,
    l.plan,
    l.organization_uid ?? '',
    l.issued_at ?? '',
    l.activated_at ?? '',
    l.expires_at ?? '',
    String(l.grace_days),
    limit(l.device_limit),
    limit(l.location_limit),
    features.join(','),
  ].join('\n');
}

/** Reads the pinned license public key from the environment, or null if unset. */
export function getLicensePublicKey(): KeyObject | null {
  const pem = process.env.PLEMMO_LICENSE_PUBLIC_KEY;
  if (!pem || !pem.trim()) return null;
  try {
    // Accept a single-line env value that uses literal "\n" for newlines.
    return createPublicKey(pem.includes('-----') ? pem.replace(/\\n/g, '\n') : pem);
  } catch {
    return null;
  }
}

/**
 * Verifies a license payload's signature against the given public key.
 * Returns false on any error (malformed key, bad base64, wrong signature).
 */
export function verifyLicenseSignature(publicKey: KeyObject, l: SignableLicense, signatureB64: string | null): boolean {
  if (!signatureB64) return false;
  try {
    return edVerify(null, Buffer.from(canonicalLicense(l), 'utf8'), publicKey, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Whether license-signature enforcement is active in this build (i.e. a public
 * key is pinned). When false, callers pass payloads through unverified.
 */
export function licenseSignatureEnforced(): boolean {
  return getLicensePublicKey() != null;
}
