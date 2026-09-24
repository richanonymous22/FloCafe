/*
 * Meridian → Plemmo integration — Phase 1 (Foundation) verification.
 *
 * Verifies:
 *   1. When PLEMMO_MERIDIAN_UI is set, the embedded Express server serves the
 *      built Meridian bundle as the merchant UI (root + SPA fallback routes).
 *   2. The Plemmo API remains authoritative and protected under Meridian
 *      serving (health open; a protected route 401s without a token).
 *   3. The real authentication flow works end to end: login → access_token →
 *      /auth/me returns the user + tenant (session context source).
 *   4. Safe fallback: with the flag off, the Meridian bundle is NOT served.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-meridian-'));

Module._load = function (requestName: string, parent: unknown, isMain: boolean) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

// Ensure the Meridian bundle exists before the server tries to serve it.
const bundle = path.join(__dirname, '..', 'frontend-meridian', 'dist', 'meridian-pos.html');
if (!fs.existsSync(bundle)) {
  execFileSync('bash', [path.join(__dirname, '..', 'frontend-meridian', 'build.sh')], { stdio: 'inherit' });
}

process.env.PLEMMO_MERIDIAN_UI = '1';

import { startServer, stopServer, getServerPort, isMeridianUiEnabled } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function run() {
  console.log('Testing Meridian foundation (Phase 1)...');
  assert(isMeridianUiEnabled() === true, 'PLEMMO_MERIDIAN_UI flag is read as enabled');

  initDatabase();
  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  try {
    // 1. Root serves the Meridian bundle.
    const root = await request(base).get('/');
    assert(root.status === 200, 'root responds 200');
    assert(/Meridian/.test(root.text), 'root serves the Meridian bundle');
    assert(/PlemmoAPI/.test(root.text), 'Meridian bundle includes the Plemmo API client');
    assert(/plemmo-auth/.test(root.text), 'Meridian bundle includes the Plemmo auth gate');

    // 1b. SPA fallback: a clean app route also returns the Meridian bundle.
    const pos = await request(base).get('/pos');
    assert(pos.status === 200 && /Meridian/.test(pos.text), 'clean route falls back to Meridian bundle');

    // 2. API remains authoritative + protected.
    const health = await request(base).get('/api/health');
    assert(health.status === 200 && health.body.status === 'ok', 'API health is ok under Meridian serving');
    const protectedRes = await request(base).get('/api/products');
    assert(protectedRes.status === 401, 'protected API route 401s without a token');

    // 3. Real authentication flow.
    const db = getDatabase();
    const bcrypt = require('bcryptjs');
    const hashed = bcrypt.hashSync('OwnerPass123!', 10);
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active)
                VALUES ('user-owner-mer', 'Owner', 'owner@meridian.local', ?, 'owner', 1)`).run(hashed);

    const login = await request(base).post('/api/auth/login')
      .send({ email: 'owner@meridian.local', password: 'OwnerPass123!' });
    assert(login.status === 200, 'login succeeds');
    const token = login.body.access_token;
    assert(!!token, 'login returns an access_token');
    assert(Array.isArray(login.body.tenants) && login.body.tenants.length === 1, 'login returns a tenant');

    const me = await request(base).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    assert(me.status === 200, '/auth/me succeeds with token');
    assert(me.body.user && me.body.user.email === 'owner@meridian.local', '/auth/me returns the user');
    assert(Array.isArray(me.body.tenants) && !!me.body.tenants[0].business_name, '/auth/me returns tenant context');

    const badLogin = await request(base).post('/api/auth/login')
      .send({ email: 'owner@meridian.local', password: 'wrong' });
    assert(badLogin.status === 401, 'bad credentials are rejected');
  } finally {
    stopServer();
  }

  // 4. Safe fallback: explicit opt-out → Meridian bundle is NOT served
  // (Meridian is now the default; PLEMMO_MERIDIAN_UI=0 falls back to Next.js).
  process.env.PLEMMO_MERIDIAN_UI = '0';
  assert(isMeridianUiEnabled() === false, 'flag reads as disabled when explicitly off');
  await startServer();
  const base2 = `http://127.0.0.1:${getServerPort()}`;
  try {
    const root2 = await request(base2).get('/');
    assert(!/PlemmoAPI/.test(root2.text), 'Meridian bundle is not served when the flag is off');
  } finally {
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('✅ Meridian foundation (Phase 1) tests passed');
}

run().catch((err) => { console.error(err); process.exit(1); });
