/**
 * Plemmo Core — local device sync identity (SYNC-B).
 *
 * Manages this device's Ed25519 keypair for signing sync requests.
 *
 * ## Key storage (dev vs production)
 *
 * The PRIVATE key is written to a file in the app data directory, with
 * owner-only permissions, and is NEVER stored in any database table (SYNC-0
 * Part O). **This file-based storage is the DEVELOPMENT/TEST mechanism.** In
 * production the private key belongs in OS-protected storage (Windows DPAPI /
 * macOS Keychain), which is a device-enrollment concern out of scope for
 * SYNC-B — see docs/SYNC_B_CLOUD_TRANSPORT.md Part E. The PUBLIC key is
 * recorded in `device_credentials` (SYNC-0) and registered with the cloud.
 *
 * The signing path is identical in dev and production; only where the private
 * key is stored differs, so swapping the store later touches only this file.
 */

import * as fs from 'fs';
import * as path from 'path';
import { generateKeyPairSync, createPrivateKey, createPublicKey, KeyObject } from 'crypto';
import { getDbPath } from '../../db';
import { getDeviceContext } from '../context';
import { recordDeviceCredential, getActiveDeviceCredential } from '../device-credentials';

function keyFilePath(): string {
  // Beside the local database (dev/test). Clearly a dev artifact.
  return path.join(path.dirname(getDbPath()), 'plemmo-sync-device-key.pem');
}

export interface DeviceKeyMaterial {
  privateKey: KeyObject;
  publicKeyPem: string;
  deviceId: string;
}

/**
 * Returns this device's key material, generating and persisting a keypair on
 * first use. Idempotent — subsequent calls load the same key. Also records
 * the public key in `device_credentials` so the local registry knows it.
 */
export function getOrCreateDeviceKey(): DeviceKeyMaterial {
  const deviceId = getDeviceContext()?.id ?? 'local-device';
  const file = keyFilePath();

  let privateKeyPem: string;
  if (fs.existsSync(file)) {
    privateKeyPem = fs.readFileSync(file, 'utf8');
  } else {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    fs.writeFileSync(file, privateKeyPem, { mode: 0o600 });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    // Record the public key locally (SYNC-0 device_credentials). Never the private key.
    recordDeviceCredential({ deviceId, credentialType: 'device_keypair', publicKey: publicKeyPem });
  }

  const privateKey = createPrivateKey(privateKeyPem);
  // Derive the public key PEM from the stored private key (avoids a second file).
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) as string;
  return { privateKey, publicKeyPem, deviceId };
}

/** The public key PEM this device presents at enrollment (dev) or via the real flow (prod). */
export function getDevicePublicKeyPem(): string {
  const active = getActiveDeviceCredential(getDeviceContext()?.id ?? 'local-device');
  if (active?.public_key) return active.public_key;
  return getOrCreateDeviceKey().publicKeyPem;
}
