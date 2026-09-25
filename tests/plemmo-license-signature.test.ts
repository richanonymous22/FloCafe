/**
 * COMMERCIALIZATION B2 — license payload signature verification.
 *
 * Proves the client rejects a tampered or unsigned license payload once a
 * public key is pinned, that a validly-signed payload verifies, and that the
 * cloud signer and client verifier agree on the canonical string (no drift).
 * Pure crypto — no database — so it runs under ts-node.
 */
import * as assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import {
  canonicalLicense as clientCanonical,
  verifyLicenseSignature,
  getLicensePublicKey,
  licenseSignatureEnforced,
  type SignableLicense,
} from '../main/core/licensing-signature';
import {
  canonicalLicense as cloudCanonical,
  signLicense,
  getLicenseSigningKey,
} from '../cloud/license-signing';
import { createCloudLicenseVerifier, LicenseSignatureError } from '../main/core/licensing';

async function run() {
  console.log('Testing license payload signature (B2)...');

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  const license: SignableLicense = {
    status: 'active',
    plan: 'pro',
    organization_uid: 'org-123',
    issued_at: '2026-01-01T00:00:00Z',
    activated_at: '2026-01-02T00:00:00Z',
    expires_at: '2027-01-01T00:00:00Z',
    grace_days: 7,
    device_limit: 5,
    location_limit: null,
    features: ['reports', 'kds', 'loyalty'],
  };

  // 1. Cloud and client compute an identical canonical string (no drift).
  assert.equal(cloudCanonical(license), clientCanonical(license), 'canonical strings must match across cloud/client');

  // 2. Feature ordering does not change the signature.
  const reordered: SignableLicense = { ...license, features: ['loyalty', 'reports', 'kds'] };
  assert.equal(clientCanonical(license), clientCanonical(reordered), 'feature order must not affect canonical');

  // 3. Sign on the cloud, verify on the client → true.
  const sig = signLicense(privateKey, license);
  assert.ok(verifyLicenseSignature(publicKey, license, sig), 'valid signature must verify');

  // 4. Tampering any authenticated field breaks verification.
  assert.ok(!verifyLicenseSignature(publicKey, { ...license, device_limit: 9999 }, sig), 'tampered device_limit must fail');
  assert.ok(!verifyLicenseSignature(publicKey, { ...license, status: 'active', expires_at: '2099-01-01T00:00:00Z' }, sig), 'tampered expiry must fail');
  assert.ok(!verifyLicenseSignature(publicKey, { ...license, features: [...license.features, 'admin'] }, sig), 'tampered features must fail');

  // 5. Missing signature and a foreign key both fail.
  assert.ok(!verifyLicenseSignature(publicKey, license, null), 'missing signature must fail');
  const foreign = generateKeyPairSync('ed25519');
  assert.ok(!verifyLicenseSignature(foreign.publicKey, license, sig), 'signature from another key must fail');

  // 6. Env-driven key loaders (single-line PEM with literal \n accepted).
  const prevPub = process.env.PLEMMO_LICENSE_PUBLIC_KEY;
  const prevPriv = process.env.PLEMMO_LICENSE_SIGNING_KEY;
  try {
    assert.equal(getLicensePublicKey(), null, 'no key configured → null');
    assert.equal(licenseSignatureEnforced(), false, 'enforcement off when unset');

    process.env.PLEMMO_LICENSE_PUBLIC_KEY = publicPem.replace(/\n/g, '\\n');
    process.env.PLEMMO_LICENSE_SIGNING_KEY = privatePem.replace(/\n/g, '\\n');
    assert.ok(getLicensePublicKey() != null, 'single-line PEM public key loads');
    assert.ok(getLicenseSigningKey() != null, 'single-line PEM signing key loads');
    assert.ok(licenseSignatureEnforced(), 'enforcement on when key set');

    // 7. createCloudLicenseVerifier enforces the signature when a key is pinned.
    const rawSigned = { ...license, signature: sig } as unknown as Record<string, unknown>;
    const rawTampered = { ...license, device_limit: 9999, signature: sig } as unknown as Record<string, unknown>;

    const okVerifier = createCloudLicenseVerifier(async () => rawSigned);
    const verified = await okVerifier.verify('org-123');
    assert.equal(verified.status, 'active', 'validly-signed payload is accepted');
    assert.equal(verified.device_limit, 5, 'accepted payload carries its fields');

    const badVerifier = createCloudLicenseVerifier(async () => rawTampered);
    await assert.rejects(() => badVerifier.verify('org-123'), LicenseSignatureError, 'tampered payload must be rejected');

    // Null cloud record is always fine (unlicensed), no signature needed.
    const emptyVerifier = createCloudLicenseVerifier(async () => null);
    assert.equal((await emptyVerifier.verify('org-123')).status, 'unlicensed', 'null record → unlicensed');

    // 8. With no pinned key, a tampered/unsigned payload passes through (dev).
    process.env.PLEMMO_LICENSE_PUBLIC_KEY = '';
    const devVerifier = createCloudLicenseVerifier(async () => rawTampered);
    assert.equal((await devVerifier.verify('org-123')).status, 'active', 'no key → pass-through (dev)');

    console.log('✅ License signature (B2) tests passed');
  } finally {
    if (prevPub === undefined) delete process.env.PLEMMO_LICENSE_PUBLIC_KEY; else process.env.PLEMMO_LICENSE_PUBLIC_KEY = prevPub;
    if (prevPriv === undefined) delete process.env.PLEMMO_LICENSE_SIGNING_KEY; else process.env.PLEMMO_LICENSE_SIGNING_KEY = prevPriv;
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
