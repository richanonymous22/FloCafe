#!/usr/bin/env node
/*
 * SYNC-D Part G — Windows secure key-storage validation.
 *
 * MUST be run on the ACTUAL target machine, inside Electron, so it exercises
 * the REAL OS keychain (Windows DPAPI via Electron safeStorage), not a fake.
 * It is NOT part of the automated Node test suite because that suite runs
 * headless on Linux where DPAPI does not exist.
 *
 *   HOW TO RUN (on a Windows machine with the app installed / a dev checkout):
 *     npx electron scripts/validate-windows-key-storage.cjs
 *
 * It validates, against real safeStorage:
 *   1. OS-backed encryption is available (DPAPI on Windows).
 *   2. A generated Ed25519 private key is stored as OS CIPHERTEXT.
 *   3. The on-disk bytes are NOT the plaintext PEM.
 *   4. The key round-trips (decrypts) after a simulated restart (fresh read).
 *   5. Signing with the restored key verifies.
 *   6. Rotation replaces the stored key.
 *   7. Revocation (clear) removes it.
 *   8. Production selection FAILS CLOSED when safeStorage is unavailable.
 *
 * Exit code 0 = all checks passed; 1 = a check failed; 2 = not run under
 * Electron / safeStorage missing (reported honestly, never a false pass).
 */

'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

let app, safeStorage;
try { ({ app, safeStorage } = require('electron')); } catch { /* not under electron */ }

function fail(msg) { console.error('  ✗ ' + msg); process.exitCode = 1; }
function ok(msg) { console.log('  ✓ ' + msg); }

async function run() {
  console.log('SYNC-D Windows key-storage validation (real safeStorage)');
  console.log('platform:', process.platform, ' electron:', !!app);

  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
    console.error('NOT RUN: safeStorage is unavailable — run this under Electron on the target OS.');
    console.error('  npx electron scripts/validate-windows-key-storage.cjs');
    process.exit(2);
  }
  if (app && !app.isReady()) { await app.whenReady(); }

  if (!safeStorage.isEncryptionAvailable()) {
    console.error('NOT RUN: OS-backed encryption is not available on this machine.');
    process.exit(2);
  }
  ok('OS-backed encryption (DPAPI/Keychain) is available');

  // Load the compiled key-store (run `npm run build` first) or the TS via ts-node.
  let SafeStorageKeyStore, createKeyStore;
  try {
    ({ SafeStorageKeyStore, createKeyStore } = require(path.join(__dirname, '..', 'dist', 'core', 'sync', 'key-store')));
  } catch (e) {
    console.error('Could not load dist/core/sync/key-store.js — run `npm run build` first. ' + e.message);
    process.exit(2);
  }

  const file = path.join(os.tmpdir(), `plemmo-key-validate-${Date.now()}.pem`);
  const store = new SafeStorageKeyStore(file + '.enc', safeStorage);

  // 2-3. store as ciphertext, not plaintext
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  store.save(pem);
  const onDisk = fs.readFileSync(file + '.enc');
  if (onDisk.includes(Buffer.from('PRIVATE KEY'))) fail('on-disk bytes contain plaintext PEM'); else ok('private key stored as OS ciphertext, not plaintext');

  // 4. round-trip after a fresh read (simulated restart)
  const store2 = new SafeStorageKeyStore(file + '.enc', safeStorage);
  const loaded = store2.load();
  if (loaded !== pem) fail('key did not round-trip after restart'); else ok('key round-trips after a simulated restart');

  // 5. signing with restored key verifies
  const restored = crypto.createPrivateKey(loaded);
  const pub = crypto.createPublicKey(restored);
  const msg = Buffer.from('sync-d-validate');
  const sig = crypto.sign(null, msg, restored);
  if (!crypto.verify(null, msg, pub, sig)) fail('signature did not verify with the restored key'); else ok('signing with the restored key verifies');

  // 6. rotation
  const { privateKey: pk2 } = crypto.generateKeyPairSync('ed25519');
  const pem2 = pk2.export({ type: 'pkcs8', format: 'pem' });
  store.save(pem2);
  if (store.load() !== pem2) fail('rotation did not replace the stored key'); else ok('rotation replaces the stored key');

  // 7. revocation
  store.clear();
  if (store.exists()) fail('clear() did not remove the key'); else ok('revocation (clear) removes the key');

  // 8. production fails closed without safeStorage
  try {
    createKeyStore({ filePath: file, environment: 'production', safeStorage: null });
    fail('production did NOT fail closed without OS storage');
  } catch { ok('production fails closed when OS storage is unavailable'); }

  try { fs.unlinkSync(file + '.enc'); } catch { /* already gone */ }
  console.log(process.exitCode ? '\nRESULT: FAILED' : '\nRESULT: PASSED (validated against real safeStorage)');
  if (app) app.quit();
}

run().catch((e) => { console.error(e); process.exit(1); });
