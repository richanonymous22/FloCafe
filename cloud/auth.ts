/**
 * Plemmo Cloud — device authentication (SYNC-B).
 *
 * Every sync request is authenticated by an Ed25519 signature over a
 * canonical string (cloud/signing.ts). The cloud resolves the device's
 * organization and location from its OWN registry — NEVER from the request
 * payload — so a device can only ever act as itself. A payload claiming a
 * different organization_id has no effect on who the cloud believes the
 * caller is (Part E / Part F).
 *
 * Replay protection: a timestamp freshness window plus a per-device nonce
 * that cannot be reused.
 */

import { createPublicKey } from 'crypto';
import { CloudStore, CloudDevice } from './store';
import { verifyRequest } from './signing';

const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

export type AuthFailureReason =
  | 'missing_headers' | 'unknown_device' | 'revoked_device'
  | 'stale_timestamp' | 'replayed_nonce' | 'bad_signature';

/**
 * The reason exposed to the CLIENT (Part J — error leakage). Deliberately
 * coarse: 'unauthenticated' covers unknown-device / bad-signature / missing
 * headers so the API is not a device-enumeration oracle. 'stale_timestamp'
 * (resync your clock) and 'revoked_device' (re-enroll) are actionable, so
 * they survive; 'replayed_nonce' maps to unauthenticated. The DETAILED reason
 * is kept server-side for the sync log.
 */
export function clientAuthReason(reason: AuthFailureReason): 'unauthenticated' | 'stale_timestamp' | 'revoked_device' {
  if (reason === 'stale_timestamp') return 'stale_timestamp';
  if (reason === 'revoked_device') return 'revoked_device';
  return 'unauthenticated';
}

export class DeviceAuthError extends Error {
  constructor(public reason: AuthFailureReason) {
    super(`device authentication failed: ${reason}`);
    this.name = 'DeviceAuthError';
  }
}

export interface AuthenticatedDevice {
  device: CloudDevice;
}

export interface SignedRequestFields {
  method: string;
  pathWithQuery: string;
  rawBody: string;
  deviceUid?: string;
  timestamp?: string;
  nonce?: string;
  signatureB64?: string;
}

/**
 * Authenticates a signed request. Throws `DeviceAuthError` on any failure —
 * the caller maps that to a 401/403 and logs an auth failure. Records the
 * nonce on success so it cannot be replayed.
 */
export function authenticateDevice(store: CloudStore, req: SignedRequestFields, nowMs = Date.now()): AuthenticatedDevice {
  if (!req.deviceUid || !req.timestamp || !req.nonce || !req.signatureB64) {
    throw new DeviceAuthError('missing_headers');
  }
  const device = store.getDevice(req.deviceUid);
  if (!device) throw new DeviceAuthError('unknown_device');
  if (device.status !== 'active') throw new DeviceAuthError('revoked_device');

  const ts = Date.parse(req.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > TIMESTAMP_WINDOW_MS) {
    throw new DeviceAuthError('stale_timestamp');
  }
  // Keep the replay table bounded: any nonce older than the freshness window
  // can never be replayed successfully (its timestamp is already stale), so
  // it is safe to prune (Part J — nonce store must not grow unbounded).
  store.pruneNonces(new Date(nowMs - TIMESTAMP_WINDOW_MS).toISOString());
  if (store.seenNonce(req.deviceUid, req.nonce)) throw new DeviceAuthError('replayed_nonce');

  let publicKey;
  try { publicKey = createPublicKey(device.public_key); } catch { throw new DeviceAuthError('bad_signature'); }
  const ok = verifyRequest(publicKey, req.method, req.pathWithQuery, req.timestamp, req.nonce, req.rawBody, req.signatureB64);
  if (!ok) throw new DeviceAuthError('bad_signature');

  store.recordNonce(req.deviceUid, req.nonce, new Date(nowMs).toISOString());
  return { device };
}
