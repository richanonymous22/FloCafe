/**
 * Plemmo Core — device credential foundation (SYNC-0, Part E).
 *
 * The domain-side representation of a device's authentication credential for
 * future device-authenticated sync. It stores ONLY the public half of a
 * credential (a device-generated public key, or an opaque credential
 * identifier for a rotatable bearer) plus lifecycle metadata.
 *
 * ## What this is NOT
 *
 *   - It does not generate, hold, or persist any private key. The private
 *     key is generated on the device and kept in OS-protected storage
 *     (Windows DPAPI / macOS Keychain) — never in the database. Nothing in
 *     this module writes a private key, and `device_credentials` has no
 *     column that could hold one.
 *   - It does not enroll a device, talk to any cloud, verify a signature, or
 *     gate a request. Those belong to a later milestone (device enrollment
 *     and the sync transport). This module is the local schema/domain seam
 *     those will build on, and nothing more.
 *
 * See docs/SYNC_0_FOUNDATION.md § Device credential foundation and
 * docs/MILESTONE_9A_SYNC_REVIEW.md § Review Issue 4 (rotatable bearer now,
 * asymmetric later) for the authentication model this prepares for.
 */

import { getDatabase, now } from '../db';
import { ulid } from './ids';

export type DeviceCredentialType = 'device_keypair' | 'rotatable_bearer';
export type DeviceCredentialStatus = 'pending' | 'active' | 'rotated' | 'revoked';

export interface DeviceCredential {
  id: string;
  device_id: string;
  credential_type: DeviceCredentialType;
  public_key: string | null;
  credential_identifier: string | null;
  status: DeviceCredentialStatus;
  issued_at: string | null;
  expires_at: string | null;
  rotated_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecordDeviceCredentialInput {
  deviceId: string;
  credentialType?: DeviceCredentialType;
  /** The device's PUBLIC key. Never a private key — see the module docstring. */
  publicKey?: string | null;
  /** An opaque identifier for the credential (e.g. a bearer token id), if applicable. */
  credentialIdentifier?: string | null;
  expiresAt?: string | null;
  /** Whether the credential is immediately usable (`active`) or awaits enrollment (`pending`). */
  active?: boolean;
}

/**
 * Records a new credential for a device. Returns the stored row. Marks any
 * previously-active credential for the same device as `rotated`, so a device
 * has at most one active credential at a time (rotation, not accumulation).
 */
export function recordDeviceCredential(input: RecordDeviceCredentialInput): DeviceCredential {
  const db = getDatabase();
  const timestamp = now();
  const id = ulid();
  const active = input.active !== false;
  // Rotate out any current active credential for this device first.
  if (active) {
    db.prepare("UPDATE device_credentials SET status = 'rotated', rotated_at = ?, updated_at = ? WHERE device_id = ? AND status = 'active'")
      .run(timestamp, timestamp, input.deviceId);
  }
  db.prepare(`
    INSERT INTO device_credentials
      (id, device_id, credential_type, public_key, credential_identifier, status, issued_at, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.deviceId, input.credentialType || 'device_keypair',
    input.publicKey ?? null, input.credentialIdentifier ?? null,
    active ? 'active' : 'pending', active ? timestamp : null, input.expiresAt ?? null,
    timestamp, timestamp,
  );
  return getDeviceCredential(id)!;
}

export function getDeviceCredential(id: string): DeviceCredential | null {
  const db = getDatabase();
  return (db.prepare('SELECT * FROM device_credentials WHERE id = ?').get(id) as DeviceCredential | undefined) ?? null;
}

/** The device's current active credential, if any. */
export function getActiveDeviceCredential(deviceId: string): DeviceCredential | null {
  const db = getDatabase();
  return (db.prepare("SELECT * FROM device_credentials WHERE device_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(deviceId) as DeviceCredential | undefined) ?? null;
}

export function listDeviceCredentials(deviceId: string): DeviceCredential[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM device_credentials WHERE device_id = ? ORDER BY created_at DESC').all(deviceId) as DeviceCredential[];
}

/** Revokes a credential (e.g. a lost/replaced device). Idempotent. */
export function revokeDeviceCredential(id: string): DeviceCredential | null {
  const db = getDatabase();
  const timestamp = now();
  db.prepare("UPDATE device_credentials SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND status != 'revoked'")
    .run(timestamp, timestamp, id);
  return getDeviceCredential(id);
}
