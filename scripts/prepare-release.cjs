#!/usr/bin/env node
/**
 * Release preparation — run before every release build (the release:* scripts do).
 *
 *   node scripts/prepare-release.cjs --platform win|mac|linux|appx|mas [--check]
 *
 * A release build must carry the commercial settings the source tree deliberately does not: the licence
 * policy (activation required, the licence-signing PUBLIC keys it trusts, the cloud address). This script
 * writes build-release/license-policy.json from the environment — which electron-builder then ships next to
 * the app — and REFUSES to continue when anything a paying merchant depends on is missing or wrong.
 *
 *   PLEMMO_RELEASE_CLOUD_URL        https address of the cloud tills connect to
 *   PLEMMO_LICENSE_PUBLIC_KEYS      JSON object  { "k1": "-----BEGIN PUBLIC KEY-----…" }  (list old AND new keys
 *                                   while a key is being rotated)
 *   PLEMMO_RELEASE_UPDATE_URL       optional: base URL of a generic update feed (otherwise GitHub releases)
 *
 * `--pilot` (or PLEMMO_RELEASE_PILOT=1) builds a PILOT installer for one trusted tester: no cloud address or licence
 * keys are needed, activation is not required (the till trades on its own), and the simulated card terminal is
 * allowed. It is clearly marked as a pilot in the till. Never give a pilot build to a paying merchant.
 *
 * `--check` validates without writing. Exit code 1 on any error.
 */
const fs = require('fs');
const path = require('path');
const { createPublicKey } = require('crypto');

const ROOT = path.join(__dirname, '..');
const KNOWN_UPSTREAM = /codify|flocafe|flopos|BKDY677XJA|34AFD24D/i;

function validate({ env = process.env, platform, pkg, brand, pilot = false }) {
  const errors = [];
  const warnings = [];
  pilot = pilot || env.PLEMMO_RELEASE_PILOT === '1';

  // ── licence policy ──────────────────────────────────────────────────────
  const cloudUrl = String(env.PLEMMO_RELEASE_CLOUD_URL || '').trim().replace(/\/+$/, '');
  if (!cloudUrl && pilot) { /* a pilot build runs without a cloud */ }
  else if (!cloudUrl) errors.push('PLEMMO_RELEASE_CLOUD_URL is not set (the https address tills connect to).');
  else {
    try { const u = new URL(cloudUrl); if (u.protocol !== 'https:') errors.push('PLEMMO_RELEASE_CLOUD_URL must be https.'); if (u.username || u.password) errors.push('PLEMMO_RELEASE_CLOUD_URL must not contain credentials.'); }
    catch { errors.push('PLEMMO_RELEASE_CLOUD_URL is not a valid URL.'); }
  }
  let keys = {};
  try { keys = JSON.parse(env.PLEMMO_LICENSE_PUBLIC_KEYS || ''); } catch { /* reported below */ }
  const ids = Object.keys(keys && typeof keys === 'object' ? keys : {});
  if (!ids.length && !pilot) errors.push('PLEMMO_LICENSE_PUBLIC_KEYS is not set (a JSON object of key id → public key PEM). A build without pinned keys would accept any licence.');
  for (const id of ids) {
    try {
      const k = createPublicKey(String(keys[id]).replace(/\\n/g, '\n'));
      if (k.asymmetricKeyType !== 'ed25519') errors.push(`licence key "${id}" is not an Ed25519 public key.`);
    } catch { errors.push(`licence key "${id}" is not a readable public key.`); }
    if (/PRIVATE/.test(String(keys[id]))) errors.push(`licence key "${id}" contains a PRIVATE key. Only public keys may be shipped.`);
  }
  if (env.PLEMMO_RELEASE_UPDATE_URL) {
    try { if (new URL(env.PLEMMO_RELEASE_UPDATE_URL).protocol !== 'https:') errors.push('PLEMMO_RELEASE_UPDATE_URL must be https.'); } catch { errors.push('PLEMMO_RELEASE_UPDATE_URL is not a valid URL.'); }
  }

  // ── packaging identity ──────────────────────────────────────────────────
  const b = (pkg && pkg.build) || {};
  const resources = (b.extraResources || []).map((r) => `${r.from}->${r.to}`);
  if (!resources.some((r) => /^build-release->/.test(r))) errors.push('package.json build.extraResources does not ship build-release/ (the licence policy would be left out).');
  if (!resources.some((r) => /^brand->brand$/.test(r))) errors.push('package.json build.extraResources does not ship brand/.');
  if (!b.publish || !b.publish.provider) errors.push('package.json build.publish is not configured (updates need a feed).');
  else if (b.publish.provider === 'github' && KNOWN_UPSTREAM.test(`${b.publish.owner}/${b.publish.repo}`) && !env.PLEMMO_RELEASE_UPDATE_URL) {
    warnings.push(`updates are published to GitHub ${b.publish.owner}/${b.publish.repo}. Make sure that is the repository the product will be released from.`);
  }
  if (brand && b.productName && brand.productName !== b.productName) warnings.push(`the installer is named "${b.productName}" but the application's brand is "${brand.productName}" (build.productName is set when the final name is chosen).`);
  if (!pkg.version || !/^\d+\.\d+\.\d+$/.test(pkg.version)) errors.push('package.json version must be X.Y.Z.');

  const check = (label, value, hint) => { if (value && KNOWN_UPSTREAM.test(String(value))) errors.push(`${label} still names the upstream project's identity ("${value}"). ${hint}`); };
  if (platform === 'appx') {
    const a = b.appx || {};
    check('appx.identityName', a.identityName, 'Set the Microsoft Partner Center values for the product owner.');
    check('appx.publisher', a.publisher, 'Set the Microsoft Partner Center publisher.');
    check('appx.publisherDisplayName', a.publisherDisplayName, 'Set the publisher display name.');
    check('appx.displayName', a.displayName, 'Set the store display name.');
  }
  if (platform === 'mac' || platform === 'mas') {
    check('mac.identity', (b.mac || {}).identity, 'Set the Apple Developer ID for the product owner.');
    if (platform === 'mas') check('mas.identity', (b.mas || {}).identity, 'Set the Apple distribution identity.');
  }
  if (platform === 'win') {
    if (!env.CSC_LINK && !env.WIN_CSC_LINK) warnings.push('no code-signing certificate configured (CSC_LINK): Windows will show an "unknown publisher" warning on install. Buy and configure one before public release.');
  }

  if (pilot) {
    warnings.push('PILOT BUILD: no licence is enforced and the simulated card terminal is available. Give it only to a trusted tester, never to a paying merchant.');
    const pilotPolicy = { requireActivation: false, publicKeys: ids.reduce((o, id) => ({ ...o, [id]: String(keys[id]).replace(/\\n/g, '\n') }), {}), cloudUrl, pilot: true, allowCardSimulator: true };
    return { errors, warnings, policy: pilotPolicy };
  }
  const policy = { requireActivation: true, publicKeys: ids.reduce((o, id) => ({ ...o, [id]: String(keys[id]).replace(/\\n/g, '\n') }), {}), cloudUrl };
  return { errors, warnings, policy };
}

function main() {
  const args = process.argv.slice(2);
  const platform = (args[args.indexOf('--platform') + 1] || '').toLowerCase();
  const checkOnly = args.includes('--check');
  const pilot = args.includes('--pilot') || process.env.PLEMMO_RELEASE_PILOT === '1';
  if (!['win', 'mac', 'linux', 'appx', 'mas'].includes(platform)) { console.error('usage: prepare-release.cjs --platform win|mac|linux|appx|mas [--pilot] [--check]'); process.exit(2); }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  let brand = null;
  try { brand = JSON.parse(fs.readFileSync(path.join(ROOT, 'brand', 'brand.json'), 'utf8')); } catch { /* reported by the brand test */ }
  const { errors, warnings, policy } = validate({ platform, pkg, brand, pilot });
  for (const w of warnings) console.warn('⚠ ' + w);
  if (errors.length) { for (const e of errors) console.error('✗ ' + e); console.error(`\nRelease build refused: ${errors.length} problem${errors.length === 1 ? '' : 's'}.`); process.exit(1); }
  if (!checkOnly) {
    const dir = path.join(ROOT, 'build-release');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'license-policy.json'), JSON.stringify(policy, null, 2) + '\n');
    console.log(policy.pilot ? '✓ wrote build-release/license-policy.json (PILOT: no activation required, simulated card terminal allowed)' : '✓ wrote build-release/license-policy.json (activation required, ' + Object.keys(policy.publicKeys).length + ' licence key(s) pinned)');
  } else console.log('✓ release configuration is valid');
}

if (require.main === module) main();
module.exports = { validate };
