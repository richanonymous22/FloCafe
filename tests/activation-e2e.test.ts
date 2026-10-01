/*
 * Activation, licence gate and sync — a real cloud and a real till, over HTTP, end to end.
 *
 *   operator creates a plan and a merchant on the cloud → issues an activation code → the till activates
 *   with it (enrols, caches the signed licence, starts sync) → sells, and the sale reaches the cloud →
 *   the operator suspends the merchant → the till is blocked at its next licence check (reading still
 *   works) → reactivated → sells again.
 * Plus the abuse cases: refused and replayed codes, an edited cached licence, a wound-back clock, a licence
 * signed by a key the build does not trust (and key rotation), and a device removed from the account.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-activation-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const keyA = generateKeyPairSync('ed25519');
const keyB = generateKeyPairSync('ed25519');
const pem = (k: any, type: 'spki' | 'pkcs8') => (type === 'spki' ? k.publicKey : k.privateKey).export({ type, format: 'pem' }) as string;
const policyFile = path.join(testDir, 'license-policy.json');
const writePolicy = (keys: Record<string, string>) => fs.writeFileSync(policyFile, JSON.stringify({ requireActivation: true, publicKeys: keys }));
process.env.PLEMMO_LICENSE_POLICY_FILE = policyFile;
writePolicy({ k1: pem(keyA, 'spki') });
process.env.PLEMMO_LICENSE_SIGNING_KEY = pem(keyA, 'pkcs8');
process.env.PLEMMO_LICENSE_SIGNING_KEY_ID = 'k1';
process.env.PLEMMO_CLOUD_ADMIN_TOKEN = 'op-token-activation-e2e';
process.env.PLEMMO_SYNC_ENV = 'development';
process.env.PLEMMO_SYNC_INTERVAL_MS = '200';

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase, getSettingValue } from '../main/db';
import { stopSyncService } from '../main/services/sync-service';
import { resetLicensePolicyCache } from '../main/core/license-policy';
const { SqliteCloudStore } = require('../cloud/store');
const { createCloudServer } = require('../cloud/server');

let passed = 0;
function ok(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); passed++; console.log(`  ✓ ${msg}`); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 8000, label = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error(`Timed out waiting for ${label}`);
}
const now = () => new Date().toISOString();

async function run() {
  console.log('Testing activation, licence gate and sync end to end...');
  // ── the cloud ────────────────────────────────────────────────────────────
  const cloudStore = new SqliteCloudStore();
  const cloudApp = createCloudServer(cloudStore);
  const cloudServer: http.Server = await new Promise((r) => { const s = http.createServer(cloudApp).listen(0, '127.0.0.1', () => r(s)); });
  const cloudUrl = `http://127.0.0.1:${(cloudServer.address() as any).port}`;
  process.env.PLEMMO_CLOUD_PUBLIC_URL = cloudUrl;
  const op = { Authorization: `Bearer ${process.env.PLEMMO_CLOUD_ADMIN_TOKEN}` };
  const cloud = (method: 'get' | 'post' | 'put', p: string, body?: any) => { const r = (request(cloudServer) as any)[method](p).set(op); return body === undefined ? r : r.send(body); };

  // ── the till ─────────────────────────────────────────────────────────────
  initDatabase();
  const db = getDatabase();
  const bcrypt = require('bcryptjs');
  const pw = bcrypt.hashSync('Passw0rd!x', 10);
  for (const [id, role] of [['u-own', 'owner'], ['u-cash', 'cashier']]) {
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active) VALUES (?,?,?,?,?,1)`).run(id, id, `${id}@till.local`, pw, role);
  }
  const { grantLocationAccess } = require('../main/core/employee-access');
  const { getCurrentLocationId } = require('../main/core/location');
  grantLocationAccess('u-cash', getCurrentLocationId());
  db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES ('c','Shop',1,1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p1','c','Widget',5,2,'W1',1,1,0,0,0,?,?)`).run(now(), now());
  await startServer();
  const till = `http://127.0.0.1:${getServerPort()}`;
  const login = async (id: string) => (await request(till).post('/api/auth/login').send({ email: `${id}@till.local`, password: 'Passw0rd!x' })).body.access_token as string;
  const T = { own: await login('u-own'), cash: await login('u-cash') };
  const as = (t: string, method: 'get' | 'post', p: string, body?: any) => { const r = (request(till) as any)[method](p).set('Authorization', `Bearer ${t}`); return body === undefined ? r : r.send(body); };
  let seq = 0;
  const sell = () => as(T.own, 'post', '/api/orders', { type: 'takeaway', items: [{ product_id: 'p1', quantity: 1 }] }).set('Idempotency-Key', `sale-${++seq}-${Date.now()}`);

  try {
    console.log('\n1. a build that requires activation will not trade until activated');
    const blocked = await sell();
    ok(blocked.status === 402 && blocked.body.code === 'license_blocked' && blocked.body.license_status === 'unactivated', 'a sale is refused (402) with "not activated"');
    ok(/activation code/.test(blocked.body.error), 'and the message tells the owner what to do');
    ok((await as(T.own, 'get', '/api/products')).status === 200 && (await as(T.own, 'get', '/api/reports/x')).status === 200, 'reading products and reports still works');
    const st0 = (await as(T.cash, 'get', '/api/activation/status')).body;
    ok(st0.activated === false && st0.requires_activation === true && st0.trading_allowed === false && st0.license === null, 'the status says: not activated, activation required, trading blocked');

    console.log('\n2. the operator sets up a merchant');
    await cloud('put', '/admin/v1/plans/retail', { name: 'Retail', features: ['core.pos', 'retail.catalog'], device_limit: 2, location_limit: 1, grace_days: 7, term_days: 365 });
    const merchant = (await cloud('post', '/admin/v1/merchants', { name: 'Corner Shop', plan_id: 'retail' })).body.merchant;
    const issued = await cloud('post', `/admin/v1/merchants/${merchant.merchant_code}/activation-tokens`, {});
    const code: string = issued.body.activation_code;
    ok(code.includes('~') && code.endsWith(issued.body.token), 'the activation code carries the cloud address and the one-time token');

    console.log('\n3. activating');
    // A sale rung up before activation (the till had been trading in its own right) must survive it.
    const { createSale } = require('../main/core/sale');
    const before = createSale({ channel: 'takeaway', lines: [{ product_id: 'p1', quantity: 2 }], cashierUserId: 'u-own' });
    const localOrg = (db.prepare('SELECT organization_id FROM orders WHERE id = ?').get(before.sale.id) as any).organization_id;
    const ordersBefore = (db.prepare('SELECT COUNT(*) n FROM orders').get() as any).n;
    ok(!!localOrg && !localOrg.startsWith('org_'), 'before activation the till\'s records carry its own local organisation id');
    ok((await as(T.cash, 'post', '/api/activation', { code })).status === 403, 'a cashier cannot activate');
    const garbage = await as(T.own, 'post', '/api/activation', { code: 'hello' });
    ok(garbage.status === 400 && garbage.body.code === 'bad_code', 'garbage is refused as not an activation code');
    const insecure = Buffer.from('http://example.com').toString('base64url') + '~' + issued.body.token;
    const refusedHttp = await as(T.own, 'post', '/api/activation', { code: insecure });
    ok(refusedHttp.status === 400 && refusedHttp.body.code === 'insecure_cloud_url', 'a code pointing at a plain-http public address is refused');
    const wrongToken = Buffer.from(cloudUrl).toString('base64url') + '~plemmo_act_' + 'x'.repeat(32);
    const bad = await as(T.own, 'post', '/api/activation', { code: wrongToken });
    ok(bad.status === 400 && bad.body.code === 'invalid_token' && getSettingValue('cloud_sync_url') === null, 'an unknown token is refused and nothing is saved');
    const act = await as(T.own, 'post', '/api/activation', { code });
    ok(act.status === 201 && act.body.activated && act.body.license_status === 'active' && act.body.plan === 'retail', 'the owner activates: licence active on the retail plan');
    ok(act.body.organization_uid === merchant.organization_uid, 'the till joined the merchant\'s organisation, taken from the token');
    ok((await cloudStore.organizationHealth(merchant.organization_uid)).active_devices === 1, 'the cloud now knows one active device');
    const moved = db.prepare('SELECT organization_id, total FROM orders WHERE id = ?').get(before.sale.id) as any;
    ok(moved.organization_id === merchant.organization_uid && Number(moved.total) === 10 && (db.prepare('SELECT COUNT(*) n FROM orders').get() as any).n === ordersBefore, 'the earlier sale moved to the merchant\'s organisation, intact, and nothing was lost');
    const orgTables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).filter((t) => (db.prepare(`PRAGMA table_info(${t.name})`).all() as any[]).some((c) => c.name === 'organization_id')).map((t) => t.name).sort();
    ok(JSON.stringify(orgTables) === JSON.stringify([...require('../main/core/activation').ORGANIZATION_COLUMN_TABLES].sort()), 'the list of tables moved at activation is exactly the tables that carry an organisation id');
    ok((db.prepare("SELECT COUNT(*) n FROM organizations WHERE id = ?").get(merchant.organization_uid) as any).n === 1 && (db.prepare('SELECT COUNT(*) n FROM locations WHERE organization_id = ?').get(merchant.organization_uid) as any).n >= 1, 'the organisation and its locations follow');
    const st1 = (await as(T.cash, 'get', '/api/activation/status')).body;
    ok(st1.activated && st1.trading_allowed && st1.license.status === 'active' && st1.license.features.includes('retail.catalog') && st1.cloud_host.startsWith('127.0.0.1'), 'the status shows the licence, features and cloud host');
    ok((await as(T.own, 'post', '/api/activation', { code })).status === 409, 'activating again is refused (already activated)');
    const replay = await request(cloudServer).post('/sync/v1/enroll').send({ token: issued.body.token, device_uid: 'other-device', public_key: 'k' });
    ok(replay.status === 400, 'the activation token cannot be replayed by another device');

    console.log('\n4. selling works and reaches the cloud');
    const first = await sell();
    ok(first.status === 201, 'a sale is accepted once activated');
    await until(async () => (await cloudStore.organizationHealth(merchant.organization_uid)).events >= 4, 10000, 'the sales to reach the cloud');
    ok((await cloudStore.organizationHealth(merchant.organization_uid)).events > 0, 'the sale arrived at the cloud through the sync worker');
    ok((await as(T.own, 'get', '/api/activation/status')).body.sync.enabled === true, 'the till reports sync as enabled');

    console.log('\n5. suspending the merchant blocks trading, not reading');
    await cloud('post', `/admin/v1/merchants/${merchant.merchant_code}/suspend`, { reason: 'test' });
    const stillOk = await sell();
    ok(stillOk.status === 201, 'until the till next checks its licence it keeps trading (offline-safe)');
    const ref = await as(T.own, 'post', '/api/activation/refresh', {});
    ok(ref.status === 200 && ref.body.status.license.status === 'suspended', 'a licence refresh picks the suspension up');
    const susp = await sell();
    ok(susp.status === 402 && susp.body.license_status === 'suspended' && /suspended/.test(susp.body.error), 'a sale is now refused: the account is suspended');
    ok((await as(T.own, 'post', '/api/bills/generate', { order_id: 1 })).status === 402 && (await as(T.own, 'post', '/api/bills/1/payments', { payments: [] })).status === 402, 'billing and payment are blocked too');
    ok((await as(T.own, 'get', '/api/reports/x')).status === 200 && (await as(T.own, 'get', '/api/orders')).status === 200, 'but records and reports remain readable');
    await cloud('post', `/admin/v1/merchants/${merchant.merchant_code}/reactivate`);
    ok((await as(T.own, 'post', '/api/activation/refresh', {})).status === 200 && (await sell()).status === 201, 'reactivated and refreshed: selling resumes');

    console.log('\n6. an edited cached licence is not believed');
    const real = getSettingValue('plemmo_license')!;
    const doctored = { ...JSON.parse(real), expires_at: '2099-01-01T00:00:00.000Z', plan: 'enterprise' };
    db.prepare("UPDATE settings SET value = ? WHERE key = 'plemmo_license'").run(JSON.stringify(doctored));
    const forged = await sell();
    ok(forged.status === 402 && forged.body.license_status === 'unlicensed', 'a licence edited in the database no longer verifies: trading is blocked');
    db.prepare("UPDATE settings SET value = ? WHERE key = 'plemmo_license'").run(real);
    ok((await sell()).status === 201, 'putting the genuine licence back restores trading');

    console.log('\n7. winding the clock back does not buy time');
    await cloud('post', `/admin/v1/merchants/${merchant.merchant_code}/renew`, { term_days: 1 }); // still far in the future
    const lic = await cloudStore.getLicense(merchant.organization_uid);
    await cloudStore.upsertLicense({ ...lic, expires_at: new Date(Date.now() + 3_600_000).toISOString(), grace_days: 0, signature: null }, now());
    ok((await as(T.own, 'post', '/api/activation/refresh', {})).status === 200 && (await sell()).status === 201, 'a licence expiring in an hour trades normally');
    db.prepare("INSERT INTO settings (key, value) VALUES ('license_clock_high_water', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(new Date(Date.now() + 2 * 3_600_000).toISOString());
    const rolled = await sell();
    ok(rolled.status === 402 && rolled.body.license_status === 'expired', 'a device that has already seen a later time treats the licence as expired, whatever the system clock says');
    db.prepare("DELETE FROM settings WHERE key = 'license_clock_high_water'").run();
    await cloudStore.upsertLicense({ ...lic, signature: null }, now());
    await as(T.own, 'post', '/api/activation/refresh', {});
    ok((await sell()).status === 201, 'with the real clock and a renewed licence, trading resumes');

    console.log('\n8. licences signed by keys the build does not trust');
    process.env.PLEMMO_LICENSE_SIGNING_KEY = pem(keyB, 'pkcs8'); process.env.PLEMMO_LICENSE_SIGNING_KEY_ID = 'k2';
    const untrusted = await as(T.own, 'post', '/api/activation/refresh', {});
    ok(untrusted.status === 502 && untrusted.body.code === 'license_signature_invalid', 'a licence signed with an unknown key is refused');
    ok((await sell()).status === 201, 'and the saved genuine licence keeps the shop trading');
    writePolicy({ k1: pem(keyA, 'spki'), k2: pem(keyB, 'spki') }); resetLicensePolicyCache();
    const rotated = await as(T.own, 'post', '/api/activation/refresh', {});
    ok(rotated.status === 200 && rotated.body.status.license.status === 'active', 'once the new key is pinned beside the old one (rotation) it is accepted');
    writePolicy({ k1: pem(keyA, 'spki') }); resetLicensePolicyCache();
    ok((await sell()).status === 402, 'if the build later drops that key, a licence it signed stops verifying');
    process.env.PLEMMO_LICENSE_SIGNING_KEY = pem(keyA, 'pkcs8'); process.env.PLEMMO_LICENSE_SIGNING_KEY_ID = 'k1';
    await as(T.own, 'post', '/api/activation/refresh', {});
    ok((await sell()).status === 201, 'back on the trusted key everything works again');

    console.log('\n9. a device removed from the account');
    const deviceId = (await as(T.own, 'get', '/api/activation/status')).body.device_id;
    await cloudStore.revokeDevice(deviceId);
    ok((await sell()).status === 201, 'offline or before its next check, the till keeps trading');
    const gone = await as(T.own, 'post', '/api/activation/refresh', {});
    ok(gone.status === 502 && gone.body.code === 'device_revoked', 'the next licence check learns the cloud no longer accepts this device');
    const goneSale = await sell();
    ok(goneSale.status === 402 && goneSale.body.license_status === 'device_revoked', 'trading stops, with a clear message');
    ok((await as(T.own, 'get', '/api/reports/x')).status === 200, 'records stay readable');

    console.log(`\n✅ Activation, licence gate and sync passed (${passed} checks)`);
  } finally {
    await stopSyncService();
    stopServer();
    cloudServer.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
run().catch((err) => { console.error(err); process.exit(1); });
