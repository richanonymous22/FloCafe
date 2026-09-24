/*
 * Offline / Sync phase — status surface verification.
 *
 * /api/sync/status is a READ-ONLY view over Plemmo's existing sync engine +
 * licence state (no second protocol). Verifies the derived UI state Meridian's
 * pill consumes: online (unlicensed desktop), licence-grace, licence-blocked,
 * plus authorization.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-sync-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase, now } from '../main/db';

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
const iso = (ms: number) => new Date(ms).toISOString();

function setLicense(db: any, lic: any) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('plemmo_license', ?, ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(lic), now());
}

async function run() {
  console.log('Testing Offline / Sync status surface...');
  initDatabase();
  const db = getDatabase();
  const bcrypt = require('bcryptjs');
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active) VALUES ('u-own','Owner','own@sync.local',?, 'owner',1)`).run(bcrypt.hashSync('OwnerPass123!', 10));
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active) VALUES ('u-cash','Cash','cash@sync.local',?, 'cashier',1)`).run(bcrypt.hashSync('CashPass123!', 10));

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  const login = async (e: string, p: string) => (await request(base).post('/api/auth/login').send({ email: e, password: p })).body.access_token;
  try {
    const owner = await login('own@sync.local', 'OwnerPass123!');
    const cashier = await login('cash@sync.local', 'CashPass123!');
    const own = (r: any) => r.set('Authorization', `Bearer ${owner}`);

    // Auth required.
    assert((await request(base).get('/api/sync/status')).status === 401, 'status requires auth');

    // Fresh desktop (unlicensed) → online, sync object present.
    let res = await own(request(base).get('/api/sync/status'));
    assert(res.status === 200, 'status responds 200');
    assert(res.body.state === 'online', `unlicensed desktop reads online (got ${res.body.state})`);
    assert(res.body.license.status === 'unlicensed', 'licence status is unlicensed');
    assert(res.body.sync && typeof res.body.sync.pending === 'number' && !!res.body.device_id, 'exposes sync engine state + device id');

    // Expired licence, no grace → blocked.
    setLicense(db, { status: 'active', plan: 'pro', grace_days: 0, expires_at: iso(Date.now() - 86400000) });
    res = await own(request(base).get('/api/sync/status'));
    assert(res.body.state === 'license_blocked' && res.body.license.status === 'expired', `expired+no-grace → license_blocked (got ${res.body.state}/${res.body.license.status})`);

    // Expired but within grace → grace.
    setLicense(db, { status: 'active', plan: 'pro', grace_days: 30, expires_at: iso(Date.now() - 86400000) });
    res = await own(request(base).get('/api/sync/status'));
    assert(res.body.state === 'license_grace' && res.body.license.within_grace === true, `expired-within-grace → license_grace (got ${res.body.state})`);

    // Active licence → online again.
    setLicense(db, { status: 'active', plan: 'pro', grace_days: 30, expires_at: iso(Date.now() + 30 * 86400000), last_verified_at: now() });
    res = await own(request(base).get('/api/sync/status'));
    assert(res.body.state === 'online' && res.body.license.status === 'active', 'valid licence → online');

    // Cashier may read status (UX signal).
    assert((await request(base).get('/api/sync/status').set('Authorization', `Bearer ${cashier}`)).status === 200, 'cashier can read status');

    console.log('✅ Offline / Sync status tests passed');
  } finally {
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
