/**
 * Plemmo Core — device private-key storage (SYNC-C, Part E).
 *
 * The device's Ed25519 PRIVATE key must live in OS-protected storage in
 * production, and never in a database table, plaintext JSON, ordinary repo
 * file, localStorage, or any frontend bundle. This module is the storage
 * seam; `device-identity.ts` uses it and knows nothing about where the bytes
 * physically rest.
 *
 * ## Two implementations, clearly separated
 *
 *   - `SafeStorageKeyStore` — PRODUCTION. Encrypts the key at rest with
 *     Electron `safeStorage`, which is backed by the OS keychain:
 *     **Windows DPAPI**, macOS Keychain, and libsecret on Linux. This is the
 *     same OS-backed mechanism the repo already uses for the master PIN and
 *     Google Drive tokens (main/services/master-pin.ts, google-drive.ts).
 *     Only the OS-encrypted ciphertext is written to disk.
 *   - `FileKeyStore` — DEVELOPMENT/TEST. A `0600` PEM file beside the DB.
 *     Never used when `PLEMMO_SYNC_ENV=production`.
 *
 * The signing path is identical for both; only where the key rests differs,
 * so swapping the store touches only this file. Rotation / revocation /
 * replacement are supported by `save()` (overwrite) and `clear()` (delete).
 */

import * as fs from 'fs';

export interface KeyStore {
  readonly kind: 'safe-storage' | 'file';
  exists(): boolean;
  /** The private key PEM, or null if none is stored. */
  load(): string | null;
  save(privateKeyPem: string): void;
  /** Removes the stored key (credential revocation / device replacement). */
  clear(): void;
}

/** DEV/TEST: a plaintext PEM file with owner-only permissions. */
export class FileKeyStore implements KeyStore {
  readonly kind = 'file' as const;
  constructor(private filePath: string) {}
  exists(): boolean { return fs.existsSync(this.filePath); }
  load(): string | null { return this.exists() ? fs.readFileSync(this.filePath, 'utf8') : null; }
  save(pem: string): void { fs.writeFileSync(this.filePath, pem, { mode: 0o600 }); }
  clear(): void { if (this.exists()) fs.unlinkSync(this.filePath); }
}

/** Minimal shape of Electron's safeStorage (so this file is testable without Electron). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** PRODUCTION: OS-encrypted key (DPAPI on Windows) written as ciphertext. */
export class SafeStorageKeyStore implements KeyStore {
  readonly kind = 'safe-storage' as const;
  constructor(private filePath: string, private safe: SafeStorageLike) {}
  exists(): boolean { return fs.existsSync(this.filePath); }
  load(): string | null {
    if (!this.exists()) return null;
    return this.safe.decryptString(fs.readFileSync(this.filePath));
  }
  save(pem: string): void {
    fs.writeFileSync(this.filePath, this.safe.encryptString(pem), { mode: 0o600 });
  }
  clear(): void { if (this.exists()) fs.unlinkSync(this.filePath); }
}

/**
 * Returns Electron's safeStorage if it is present AND encryption is actually
 * available on this machine, otherwise null. Guarded so it never throws in a
 * test harness whose Electron mock omits safeStorage.
 */
export function tryGetSafeStorage(): SafeStorageLike | null {
  try {
    // Lazy, guarded require: the test harness mocks 'electron' without safeStorage.
    const electron = require('electron') as { safeStorage?: SafeStorageLike };
    const safe = electron.safeStorage;
    if (safe && typeof safe.isEncryptionAvailable === 'function' && safe.isEncryptionAvailable()) return safe;
    return null;
  } catch {
    return null;
  }
}

export type SyncEnvironment = 'development' | 'staging' | 'production';

export interface CreateKeyStoreOptions {
  /** Plaintext PEM path (dev) — the ciphertext file uses this path + '.enc'. */
  filePath: string;
  environment: SyncEnvironment;
  /** Injectable for tests. Defaults to Electron safeStorage when available. */
  safeStorage?: SafeStorageLike | null;
}

/**
 * Selects the key store for the current environment. In PRODUCTION an
 * OS-backed store is REQUIRED: if safeStorage is unavailable the call fails
 * closed rather than silently writing a plaintext key (Part E). In
 * development/staging it prefers safeStorage when present and falls back to a
 * file so the dev/test path is never broken.
 */
export function createKeyStore(options: CreateKeyStoreOptions): KeyStore {
  const safe = options.safeStorage === undefined ? tryGetSafeStorage() : options.safeStorage;
  if (options.environment === 'production') {
    if (!safe) {
      throw new Error('Secure OS key storage (safeStorage / DPAPI) is unavailable; refusing to store the device key in plaintext in production.');
    }
    return new SafeStorageKeyStore(`${options.filePath}.enc`, safe);
  }
  if (safe) return new SafeStorageKeyStore(`${options.filePath}.enc`, safe);
  return new FileKeyStore(options.filePath);
}
