/*
 * Plemmo Cloud — operations: shared rate limiting, the client-version policy, request logs and proxy trust.
 * Runs on the SQLite store and, when PLEMMO_CLOUD_DB_URL is set (CI's postgres-sync job), on PostgreSQL.
 */
import * as assert from 'node:assert/strict';

const request = require('supertest');
const { SqliteCloudStore } = require('../cloud/store');
const { createCloudServer } = require('../cloud/server');

const TOKEN = 'test-operator-token-ops';
let checks = 0;
function ok(cond: boolean, msg: string) { assert.ok(cond, msg); checks++; console.log(`  ✓ ${msg}`); }

async function suite(store: any, label: string) {
  console.log(`\nTesting Plemmo Cloud operations on ${label}...`);
  process.env.PLEMMO_CLOUD_ADMIN_TOKEN = TOKEN;
  const auth = { Authorization: `Bearer ${TOKEN}` };

  console.log('\n1. the rate limit is shared by every instance');
  // The limit is a fixed one-minute window: start the burst early in a window so it cannot straddle two.
  if (Date.now() % 60_000 > 45_000) await new Promise((r) => setTimeout(r, 60_000 - (Date.now() % 60_000) + 100));
  const a = createCloudServer(store); const b = createCloudServer(store); // two "containers", one database
  let allowed = 0; let limited = 0;
  for (let i = 0; i < 130; i++) {
    const r = await request(i % 2 ? a : b).get('/admin/v1/plans').set(auth);
    if (r.status === 200) allowed++; else if (r.status === 429) limited++;
  }
  ok(allowed === 120 && limited === 10, `120 operator calls are allowed per minute across both instances, the rest refused (${allowed} allowed, ${limited} refused)`);
  ok((await request(a).get('/admin/v1/plans').set(auth)).status === 429, 'instance A refuses what instance B counted');
  ok((await request(a).get('/health')).status === 200, 'health checks are never rate limited');
  const t = Math.floor(Date.now() / 1000) * 1000 + 100; // 100 ms into a window, so the three hits cannot straddle two
  ok(await store.rateLimitHit('k-window', 1000, 2, t) && await store.rateLimitHit('k-window', 1000, 2, t + 10) && !(await store.rateLimitHit('k-window', 1000, 2, t + 20)), 'a window allows exactly its limit');
  ok(await store.rateLimitHit('k-window', 1000, 2, t + 2500), 'and a new window starts clean');
  let enrolled429 = 0;
  for (let i = 0; i < 25; i++) if ((await request(a).post('/sync/v1/enroll').send({ token: 'plemmo_act_' + 'z'.repeat(30), device_uid: 'd' + i, public_key: 'k' })).status === 429) enrolled429++;
  ok(enrolled429 >= 5, 'activation attempts are limited too (guessing tokens is throttled)');

  console.log('\n2. client version policy');
  const fresh = createCloudServer(store);
  ok((await request(fresh).get('/sync/v1/health').set({ 'x-plemmo-protocol': '1' })).status === 401, 'a current client reaches the normal checks (and is simply unauthenticated here)');
  process.env.PLEMMO_MIN_CLIENT_PROTOCOL = '2';
  const old = await request(fresh).get('/sync/v1/health').set({ 'x-plemmo-protocol': '1' });
  ok(old.status === 426 && old.body.error === 'client_upgrade_required' && old.body.min_protocol === 2, 'once the minimum is raised, an older client is told to update (426), not served');
  ok((await request(fresh).get('/sync/v1/health')).status === 426, 'a client that sends no version counts as protocol 1');
  ok((await request(fresh).get('/health')).status === 200, 'health stays available to everyone');
  delete process.env.PLEMMO_MIN_CLIENT_PROTOCOL;

  console.log('\n3. structured request logs');
  const lines: any[] = [];
  const logged = createCloudServer(store, { requestLog: (l: Record<string, unknown>) => lines.push(l) });
  const r = await request(logged).post('/sync/v1/enroll').set({ 'x-plemmo-device': 'dev-log' }).send({ token: 'plemmo_act_SECRET-VALUE-1234567890', device_uid: 'dev-log', public_key: 'PUBKEY' });
  await new Promise((res) => setTimeout(res, 30));
  const line = lines.find((l) => l.path === '/sync/v1/enroll');
  ok(!!line && line.method === 'POST' && typeof line.status === 'number' && typeof line.ms === 'number' && /^req_[0-9a-f]{12}$/.test(line.id), 'each request logs method, path, status, duration and a request id');
  ok(r.headers['x-request-id'] === line.id, 'the same request id is returned to the caller');
  ok(!JSON.stringify(lines).includes('SECRET-VALUE') && !JSON.stringify(lines).includes('PUBKEY'), 'tokens and keys never appear in the log');
  ok(line.device === 'dev-log', 'the device id is logged for correlation');

  console.log('\n4. behind a proxy the real client address is used');
  process.env.PLEMMO_TRUST_PROXY_HOPS = '1';
  const proxied = createCloudServer(store);
  const r1 = await request(proxied).get('/admin/v1/plans').set(auth).set('X-Forwarded-For', '203.0.113.7');
  ok(r1.status === 200, 'a client address taken from X-Forwarded-For has its own allowance');
  delete process.env.PLEMMO_TRUST_PROXY_HOPS;
}

async function main() {
  const sqlite = new SqliteCloudStore();
  await suite(sqlite, 'SQLite');
  const dsn = process.env.PLEMMO_CLOUD_DB_URL;
  if (dsn) {
    const { Pool } = require('pg');
    const { PostgresCloudStore } = require('../cloud/postgres-store');
    const { migrateToLatest } = require('../cloud/migrate');
    const schema = `ops_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const admin = new Pool({ connectionString: dsn }); await admin.query(`CREATE SCHEMA "${schema}"`); await admin.end();
    const pool = new Pool({ connectionString: dsn, options: `-c search_path=${schema}`, max: 4 });
    try { await migrateToLatest(pool); await suite(new PostgresCloudStore(pool), 'PostgreSQL'); }
    finally { await pool.end(); const a2 = new Pool({ connectionString: dsn }); await a2.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await a2.end(); }
  } else console.log('\n  ⏭ PostgreSQL part not run (set PLEMMO_CLOUD_DB_URL to run it)');
  console.log(`\n✅ Plemmo Cloud operations passed (${checks} checks)`);
}
main().catch((err) => { console.error(err); process.exit(1); });
