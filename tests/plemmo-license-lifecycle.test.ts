/*
 * Plemmo licensing — LIFECYCLE matrix (Gate 3B).
 *
 * The signature/authenticity side is covered by plemmo-license-signature.test.ts
 * (canonical string, valid/tampered/missing/foreign signature, enforcement gate,
 * cloud verifier accept/reject). This suite covers the *lifecycle* state machine
 * and the offline-first cache behaviour that the desktop client relies on:
 *
 *   activation · valid · expired · offline grace · needs-verification ·
 *   revocation · suspension · device limit · location limit ·
 *   offline operation (server unavailable) · reconnection refresh ·
 *   feature-licensing enforcement.
 *
 * It runs against a real database (get/setLicense persist to the settings table),
 * with electron mocked like the other node-side suites. Time-dependent checks use
 * an explicit `atMs` so they are deterministic and never flake around midnight.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-license-'));
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, closeDatabase } = require('../main/db');
const lic = require('../main/core/licensing');
const {
  getLicense, setLicense, clearLicense, activateLicense, refreshLicense,
  effectiveStatus, isLicensed, withinOfflineGrace,
  deviceCountWithinLimit, locationCountWithinLimit,
  isFeatureLicensed, requireFeatureLicensed, LicenseError,
} = lic;

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

// A base "active" license issued at T0, expiring 30 days later, 7-day grace.
function baseLicense(overrides: Record<string, unknown> = {}) {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  return {
    status: 'active', plan: 'standard', organization_uid: 'org-1',
    issued_at: iso(t0), activated_at: iso(t0), expires_at: iso(t0 + 30 * DAY),
    grace_days: 7, device_limit: 3, location_limit: 2, features: ['reports'],
    last_verified_at: iso(t0), signature: null, ...overrides,
  };
}

async function run() {
  console.log('Testing license lifecycle matrix...');
  initDatabase();
  const T0 = Date.parse('2026-01-01T00:00:00Z');
  const within = T0 + 5 * DAY;           // before expiry AND within the 7-day verification grace
  const inGrace = T0 + 32 * DAY;         // expired (>30d) but within +7d grace
  const afterGrace = T0 + 40 * DAY;      // beyond expiry + grace

  try {
    // ── cache round-trip ────────────────────────────────────────────────────
    clearLicense();
    assert.equal(getLicense().status, 'unlicensed', 'no stored license → unlicensed sentinel');
    assert.equal(isLicensed(getLicense(), within), false, 'unlicensed is not operational');

    // ── activation ──────────────────────────────────────────────────────────
    const activated = activateLicense(baseLicense({ status: 'expired', activated_at: null }));
    assert.equal(activated.status, 'active', 'activation forces status active');
    assert.ok(activated.activated_at, 'activation stamps activated_at');
    assert.ok(activated.last_verified_at, 'activation stamps last_verified_at');
    assert.equal(getLicense().status, 'active', 'activated license is persisted');

    // ── valid ───────────────────────────────────────────────────────────────
    setLicense(baseLicense());
    assert.equal(effectiveStatus(getLicense(), within), 'active', 'in-window license is active');
    assert.equal(isLicensed(getLicense(), within), true, 'active license is operational');
    assert.equal(withinOfflineGrace(getLicense(), within), false, 'active license is not on grace');

    // ── expired + offline grace ───────────────────────────────────────────────
    assert.equal(effectiveStatus(getLicense(), inGrace), 'grace', 'expired-but-within-grace → grace');
    assert.equal(isLicensed(getLicense(), inGrace), true, 'grace license still operates');
    assert.equal(withinOfflineGrace(getLicense(), inGrace), true, 'grace is flagged as offline grace');
    assert.equal(effectiveStatus(getLicense(), afterGrace), 'expired', 'beyond expiry+grace → expired');
    assert.equal(isLicensed(getLicense(), afterGrace), false, 'expired license does not operate');

    // ── needs-verification (not expired, but long unverified) ─────────────────
    // Perpetual license (no expiry) whose last verification is older than grace.
    setLicense(baseLicense({ expires_at: null, last_verified_at: iso(T0), grace_days: 7 }));
    assert.equal(effectiveStatus(getLicense(), T0 + 10 * DAY), 'needs_verification', 'stale verification → needs_verification');
    assert.equal(isLicensed(getLicense(), T0 + 10 * DAY), true, 'needs_verification still operates (warned, not stranded)');
    // A perpetual license with grace_days 0 never demands verification.
    setLicense(baseLicense({ expires_at: null, grace_days: 0 }));
    assert.equal(effectiveStatus(getLicense(), T0 + 999 * DAY), 'active', 'grace_days 0 perpetual stays active');

    // ── revocation (never gets grace) ─────────────────────────────────────────
    setLicense(baseLicense({ status: 'revoked' }));
    assert.equal(effectiveStatus(getLicense(), within), 'revoked', 'revoked is revoked even in-window');
    assert.equal(effectiveStatus(getLicense(), inGrace), 'revoked', 'revoked never granted grace');
    assert.equal(isLicensed(getLicense(), within), false, 'revoked does not operate');

    // ── suspension ────────────────────────────────────────────────────────────
    setLicense(baseLicense({ status: 'suspended' }));
    assert.equal(effectiveStatus(getLicense(), within), 'suspended', 'suspended is suspended');
    assert.equal(isLicensed(getLicense(), within), false, 'suspended does not operate');

    // ── device limits ─────────────────────────────────────────────────────────
    const threeDevices = baseLicense({ device_limit: 3 });
    assert.equal(deviceCountWithinLimit(3, threeDevices), true, 'at the device limit is allowed');
    assert.equal(deviceCountWithinLimit(4, threeDevices), false, 'over the device limit is blocked');
    assert.equal(deviceCountWithinLimit(9, baseLicense({ device_limit: null })), true, 'null device_limit = unlimited');

    // ── location limits ───────────────────────────────────────────────────────
    const twoLocations = baseLicense({ location_limit: 2 });
    assert.equal(locationCountWithinLimit(2, twoLocations), true, 'at the location limit is allowed');
    assert.equal(locationCountWithinLimit(3, twoLocations), false, 'over the location limit is blocked');
    assert.equal(locationCountWithinLimit(50, baseLicense({ location_limit: null })), true, 'null location_limit = unlimited');

    // ── feature-licensing enforcement ─────────────────────────────────────────
    setLicense(baseLicense({ status: 'revoked' }));
    assert.equal(isFeatureLicensed('reports', 'org-1', within), false, 'no feature is licensed under a revoked license');
    assert.throws(() => requireFeatureLicensed('reports', 'org-1'), (e: unknown) => e instanceof LicenseError, 'requireFeatureLicensed throws when not licensed');
    setLicense(baseLicense({ features: ['reports'] }));
    assert.equal(isFeatureLicensed('kds', 'org-1', within), false, "a feature outside the license's grant is not licensed");

    // ── offline operation + reconnection (refresh semantics) ──────────────────
    setLicense(baseLicense());
    // Server unavailable: refresh keeps the cached entitlement (offline grace),
    // never strands a paying merchant on a transient network error.
    const offlineVerifier = { verify: async () => { throw new Error('network down'); } };
    const keptCached = await refreshLicense(offlineVerifier, 'org-1');
    assert.equal(keptCached.status, 'active', 'server-unavailable refresh keeps the cached license');
    assert.equal(getLicense().plan, 'standard', 'cached license is unchanged after a failed refresh');
    // Reconnection: a successful verify adopts the fresh payload and stamps
    // last_verified_at so the offline-grace clock resets.
    const freshVerifier = { verify: async () => baseLicense({ plan: 'pro', last_verified_at: null }) };
    const refreshed = await refreshLicense(freshVerifier, 'org-1');
    assert.equal(refreshed.plan, 'pro', 'reconnection adopts the fresh license');
    assert.ok(refreshed.last_verified_at, 'reconnection stamps last_verified_at');
    assert.equal(getLicense().plan, 'pro', 'refreshed license is persisted');

    console.log('✅ License lifecycle matrix tests passed');
  } finally {
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
