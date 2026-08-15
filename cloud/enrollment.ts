/**
 * Plemmo Cloud — device enrollment (SYNC-C, Part D).
 *
 * Two clearly-separated enrollment paths, and the domain chain behind them:
 *
 *     Organization → Location → Register → Device → Credential
 *
 * ## DEVELOPMENT enrollment (`POST /sync/v1/dev/enroll`, in server.ts)
 * A device posts its own org/location and public key. Trusts the caller.
 * Gated OFF unless `enableDevEnroll` is set; MUST NOT be exposed in prod.
 *
 * ## PRODUCTION enrollment (`enrollWithToken`, wired to `POST /sync/v1/enroll`)
 * An operator issues a one-time ACTIVATION TOKEN out of band (a future Admin
 * action — no UI is built here), scoped to a specific organization / location
 * / register. The device presents that token plus its freshly-generated
 * PUBLIC key. The cloud verifies the token is real, unexpired, and unused,
 * consumes it atomically, and binds a device whose org/location/register come
 * from the TOKEN — never from anything the device claims. The device's
 * private key never leaves the device; only its public key is registered.
 *
 * The token is only ever stored HASHED (sha256), so a leaked database does
 * not yield usable activation secrets.
 */

import { createHash, randomBytes } from 'crypto';
import { CloudStore, EnrollmentToken } from './store';

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface IssueTokenInput {
  organizationUid: string;
  locationUid?: string | null;
  registerUid?: string | null;
  ttlMs?: number;
}

/**
 * Issues a one-time activation token for a device slot. Returns the PLAINTEXT
 * token (shown once to the operator); only its hash is persisted. In
 * production this is called by an authenticated admin action, not by a device.
 */
export function issueEnrollmentToken(store: CloudStore, input: IssueTokenInput, nowMs = Date.now()): { token: string } {
  const token = `plemmo_act_${randomBytes(24).toString('base64url')}`;
  const ttl = input.ttlMs ?? 24 * 60 * 60 * 1000; // 24h default
  const record: EnrollmentToken = {
    token_hash: hashToken(token),
    organization_uid: input.organizationUid,
    location_uid: input.locationUid ?? null,
    register_uid: input.registerUid ?? null,
    expires_at: new Date(nowMs + ttl).toISOString(),
    consumed_at: null,
  };
  store.createEnrollmentToken(record);
  return { token };
}

export type EnrollmentErrorReason = 'missing_fields' | 'invalid_token' | 'device_exists';

export class EnrollmentError extends Error {
  constructor(public reason: EnrollmentErrorReason) {
    super(`enrollment failed: ${reason}`);
    this.name = 'EnrollmentError';
  }
}

export interface EnrollWithTokenInput {
  token: string;
  deviceUid: string;
  publicKey: string;
}

export interface EnrolledDevice {
  device_uid: string;
  organization_uid: string;
  location_uid: string | null;
  register_uid: string | null;
}

/**
 * Production enrollment: consume a valid token and register the device with
 * org/location/register taken from the token. Idempotent-safe against token
 * reuse (a consumed/expired token is rejected). Throws `EnrollmentError`.
 */
export function enrollWithToken(store: CloudStore, input: EnrollWithTokenInput, nowMs = Date.now()): EnrolledDevice {
  if (!input.token || !input.deviceUid || !input.publicKey) throw new EnrollmentError('missing_fields');

  // Re-enrolling an already-registered, still-active device is not allowed via
  // a fresh token — that path is credential ROTATION, not enrollment.
  const existing = store.getDevice(input.deviceUid);
  if (existing && existing.status === 'active') throw new EnrollmentError('device_exists');

  const claim = store.consumeEnrollmentToken(hashToken(input.token), new Date(nowMs).toISOString());
  if (!claim) throw new EnrollmentError('invalid_token');

  store.registerDevice({
    device_uid: input.deviceUid,
    organization_uid: claim.organization_uid,
    location_uid: claim.location_uid,
    register_uid: claim.register_uid,
    public_key: input.publicKey,
    status: 'active',
    created_at: new Date(nowMs).toISOString(),
  });
  return {
    device_uid: input.deviceUid,
    organization_uid: claim.organization_uid,
    location_uid: claim.location_uid,
    register_uid: claim.register_uid,
  };
}
