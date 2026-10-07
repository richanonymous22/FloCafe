/*
 * Plemmo Cloud — backup and rehearsed restore, against a real PostgreSQL (needs PLEMMO_CLOUD_DB_URL, a role that
 * can create databases, and the pg_dump/pg_restore/psql tools; otherwise it skips).
 *
 * A backup is only as good as a restore you have tried: this takes a real backup of a real migrated database
 * holding a plan, merchants and a licence, restores it into a scratch database and checks it against the
 * manifest, then proves the rehearsal FAILS when the manifest disagrees or the file is damaged, and cleans up.
 */
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dsn = process.env.PLEMMO_CLOUD_DB_URL;
let checks = 0;
function ok(cond: boolean, msg: string) { assert.ok(cond, msg); checks++; console.log(`  ✓ ${msg}`); }
const sh = (cmd: string, args: string[], env: Record<string, string> = {}) => spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } });

async function main() {
  console.log('Testing Plemmo Cloud backup and restore rehearsal...');
  if (!dsn) { console.log('  ⏭ no PLEMMO_CLOUD_DB_URL — skipping'); return; }
  if (sh('pg_dump', ['--version']).status !== 0 || sh('psql', ['--version']).status !== 0) { console.log('  ⏭ pg_dump/psql not installed — skipping'); return; }
  const { Pool } = require('pg');
  const { PostgresCloudStore } = require('../cloud/postgres-store');
  const { migrateToLatest } = require('../cloud/migrate');
  const { parsePlan, licenceFromPlan, generateMerchantCode, organizationUidFor } = require('../cloud/commercial');

  const base = new URL(dsn);
  const dbName = `plemmo_bk_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const urlFor = (db: string) => { const u = new URL(base.toString()); u.pathname = '/' + db; u.search = ''; return u.toString(); };
  const admin = new Pool({ connectionString: urlFor('postgres') });
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const pool = new Pool({ connectionString: urlFor(dbName), max: 3 });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'plemmo-bk-'));
  try {
    await migrateToLatest(pool);
    const store = new PostgresCloudStore(pool);
    const at = new Date().toISOString();
    const plan = parsePlan('starter', { name: 'Starter', features: ['core.pos'], device_limit: 2 }).plan;
    await store.upsertPlan(plan, at);
    for (const n of ['A', 'B', 'C']) {
      const m = { merchant_code: generateMerchantCode(), name: 'Shop ' + n, contact_email: null, organization_uid: organizationUidFor(), plan_id: 'starter', status: 'active', notes: null, created_at: at, updated_at: at };
      await store.createMerchant(m);
      await store.upsertLicense(licenceFromPlan(plan, m.organization_uid, at), at);
    }

    console.log('\n1. a backup is taken and described');
    const b = sh('bash', ['cloud/ops/backup.sh', out], { PLEMMO_CLOUD_DB_URL: urlFor(dbName) });
    ok(b.status === 0, 'backup.sh succeeds');
    const dump = b.stdout.trim().split('\n').pop() as string;
    const manifest = JSON.parse(fs.readFileSync(dump + '.manifest.json', 'utf8'));
    ok(fs.existsSync(dump) && fs.statSync(dump).size > 1000, 'a dump file is written');
    ok(manifest.schema_version >= 6 && manifest.counts.cloud_merchants === 3 && manifest.counts.cloud_licenses === 3 && manifest.counts.cloud_plans === 1, 'the manifest records the schema version and every table\'s row count');
    ok(!fs.readFileSync(dump + '.manifest.json', 'utf8').includes('postgres://') && !b.stdout.includes('postgres://') && !b.stderr.includes(base.password || '\u0000'), 'neither the manifest nor the log contains the database URL or password');

    console.log('\n2. the restore is rehearsed and checked');
    const env = { RESTORE_ADMIN_URL: urlFor('postgres') };
    const r = sh('bash', ['cloud/ops/restore-rehearsal.sh', dump], env);
    ok(r.status === 0 && /OK: restored schema v\d+ and \d+ tables match/.test(r.stdout), 'the rehearsal restores into a scratch database and every table matches the backup');
    const left = await admin.query("SELECT COUNT(*)::int AS n FROM pg_database WHERE datname LIKE 'plemmo_restore_check%'");
    ok(left.rows[0].n === 0, 'the scratch database is dropped afterwards');

    console.log('\n3. the rehearsal fails when it should');
    const mpath = dump + '.manifest.json';
    fs.writeFileSync(mpath, JSON.stringify({ ...manifest, counts: { ...manifest.counts, cloud_merchants: 4 } }));
    const bad = sh('bash', ['cloud/ops/restore-rehearsal.sh', dump], env);
    ok(bad.status === 1 && /cloud_merchants: restored 3 rows, backup had 4/.test(bad.stderr), 'a row-count mismatch is reported by table and fails the run');
    fs.writeFileSync(mpath, JSON.stringify({ ...manifest, schema_version: manifest.schema_version + 1 }));
    ok(sh('bash', ['cloud/ops/restore-rehearsal.sh', dump], env).status === 1, 'a schema-version mismatch fails the run');
    fs.writeFileSync(mpath, JSON.stringify(manifest));
    fs.appendFileSync(dump, 'x');
    const dmg = sh('bash', ['cloud/ops/restore-rehearsal.sh', dump], env);
    ok(dmg.status === 1 && /checksum/.test(dmg.stderr), 'a damaged or altered backup file is refused by its checksum');
    fs.rmSync(mpath);
    ok(sh('bash', ['cloud/ops/restore-rehearsal.sh', dump], env).status === 2, 'a backup without its manifest is refused');
    const left2 = await admin.query("SELECT COUNT(*)::int AS n FROM pg_database WHERE datname LIKE 'plemmo_restore_check%'");
    ok(left2.rows[0].n === 0, 'and no failed rehearsal leaves a scratch database behind');
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
    fs.rmSync(out, { recursive: true, force: true });
  }
  console.log(`\n✅ Plemmo Cloud backup and restore rehearsal passed (${checks} checks)`);
}
main().catch((err) => { console.error(err); process.exit(1); });
