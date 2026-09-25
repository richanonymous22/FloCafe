/**
 * Plemmo Cloud — license payload signing (COMMERCIALIZATION, B2).
 *
 * The cloud license service signs the authenticated fields of a license so the
 * client can verify authenticity against a pinned public key (see
 * `main/core/licensing-signature.ts`). The canonical string is DUPLICATED here
 * rather than imported — the same convention as request signing
 * (`cloud/signing.ts` ↔ `main/core/sync/signing.ts`). If the format changes,
 * BOTH copies change together.
 *
 * The private key is read from `PLEMMO_LICENSE_SIGNING_KEY` (Ed25519 PKCS8 PEM;
 * a single-line value using literal "\n" is accepted). When it is unset, signing
 * is skipped and the endpoint serves unsigned payloads (dev / unmanaged), which
 * the client then passes through only because it has no pinned public key.
 */

import { createPrivateKey, sign as edSign, KeyObject } from 'crypto';

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

/** Deterministic string over every authenticated field — must match the client. */
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

/** Reads the license signing private key from the environment, or null if unset. */
export function getLicenseSigningKey(): KeyObject | null {
  const pem = process.env.PLEMMO_LICENSE_SIGNING_KEY;
  if (!pem || !pem.trim()) return null;
  try {
    return createPrivateKey(pem.includes('-----') ? pem.replace(/\\n/g, '\n') : pem);
  } catch {
    return null;
  }
}

/** Ed25519 base64 signature over the canonical license. */
export function signLicense(privateKey: KeyObject, l: SignableLicense): string {
  return edSign(null, Buffer.from(canonicalLicense(l), 'utf8'), privateKey).toString('base64');
}
