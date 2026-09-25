/**
 * Plemmo Core — local device sync identity (SYNC-B, hardened SYNC-C Part E).
 *
 * Manages this device's Ed25519 keypair for signing sync requests.
 *
 * ## Key storage
 *
 * The PRIVATE key is held by a `KeyStore` (key-store.ts): OS-encrypted via
 * Electron safeStorage (Windows DPAPI / macOS Keychain / libsecret) in
 * production, a `0600` PEM file in dev/test. It is NEVER written to any
 * database table (SYNC-0 Part O). The PUBLIC key is recorded in
 * `device_credentials` (SYNC-0) and registered with the cloud.
 *
 * The signing path is identical regardless of where the key rests, so the
 * environment only changes the store, not the protocol.
 */

import * as path from 'path';
import { generateKeyPairSync, createPrivateKey, createPublicKey, KeyObject } from 'crypto';
import { getDbPath } from '../../db';
import { getDeviceContext } from '../context';
import { recordDeviceCredential, getActiveDeviceCredential, revokeDeviceCredential } from '../device-credentials';
import { createKeyStore, KeyStore } from './key-store';
import { getSyncEnvironment } from './config';

function keyBasePath(): string {
  // Beside the local database. In dev this is the plaintext PEM; in production
  // the store appends '.enc' and writes OS-encrypted ciphertext.
  return path.join(path.dirname(getDbPath()), 'plemmo-sync-device-key.pem');
}

function keyStore(): KeyStore {
  return createKeyStore({ filePath: keyBasePath(), environment: getSyncEnvironment() });
}

function deviceId(): string {
  return getDeviceContext()?.id ?? 'local-device';
}

export interface DeviceKeyMaterial {
  privateKey: KeyObject;
  publicKeyPem: string;
  deviceId: string;
}

function materialFromPem(privateKeyPem: string): DeviceKeyMaterial {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) as string;
  return { privateKey, publicKeyPem, deviceId: deviceId() };
}

function generateAndStore(store: KeyStore): DeviceKeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  store.save(privateKeyPem);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  // Record the PUBLIC key locally (SYNC-0 device_credentials). Never the private key.
  recordDeviceCredential({ deviceId: deviceId(), credentialType: 'device_keypair', publicKey: publicKeyPem });
  return { privateKey: createPrivateKey(privateKeyPem), publicKeyPem, deviceId: deviceId() };
}

/**
 * Returns this device's key material, generating and persisting a keypair on
 * first use. Idempotent — subsequent calls load the same key.
 */
export function getOrCreateDeviceKey(): DeviceKeyMaterial {
  const store = keyStore();
  const existing = store.load();
  if (existing) return materialFromPem(existing);
  return generateAndStore(store);
}

/**
 * Rotates the device credential (Part E): generates a fresh keypair, replaces
 * the stored private key, and records the new PUBLIC key — which marks the
 * previous local credential `rotated`. The caller then re-registers the new
 * public key with the cloud (dev enroll or `rotateDevice`). The device_uid is
 * unchanged; this is rotation, not replacement.
 */
export function rotateDeviceKey(): DeviceKeyMaterial {
  return generateAndStore(keyStore());
}

/**
 * Revokes this device's credential locally (Part E): removes the stored
 * private key and marks the active local credential `revoked`. Used for device
 * replacement / decommissioning. The cloud-side revoke is a separate call.
 */
export function revokeDeviceKey(): void {
  keyStore().clear();
  const active = getActiveDeviceCredential(deviceId());
  if (active) revokeDeviceCredential(active.id);
}

/** The public key PEM this device presents at enrollment (dev) or via the real flow (prod). */
export function getDevicePublicKeyPem(): string {
  const active = getActiveDeviceCredential(deviceId());
  if (active?.public_key) return active.public_key;
  return getOrCreateDeviceKey().publicKeyPem;
}
