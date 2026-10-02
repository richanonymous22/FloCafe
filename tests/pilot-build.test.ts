/*
 * The pilot installer: a build for one trusted tester. No licence is enforced, the simulated card terminal is
 * available, the till says it is a pilot, and an ordinary release build still refuses to be made without keys.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-pilot-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
delete process.env.PLEMMO_ALLOW_CARD_SIMULATOR;
let passed = 0;
function ok(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); passed++; console.log(`  ✓ ${msg}`); }

const root = path.join(__dirname, '..');
const prepare = path.join(root, 'scripts', 'prepare-release.cjs');
const runPrepare = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [prepare, ...args], { encoding: 'utf8', env: { ...process.env, PLEMMO_RELEASE_CLOUD_URL: '', PLEMMO_LICENSE_PUBLIC_KEYS: '', ...env } });

async function main() {
  console.log('Testing the pilot installer...');
  console.log('\n1. building it');
  const normal = runPrepare(['--platform', 'win', '--check']);
  ok(normal.status === 1 && /PLEMMO_LICENSE_PUBLIC_KEYS is not set/.test(normal.stderr), 'an ordinary release build still refuses to be made without a cloud address and licence keys');
  const pilot = runPrepare(['--platform', 'win', '--pilot', '--check']);
  ok(pilot.status === 0 && /PILOT BUILD/.test(pilot.stderr), 'a pilot build needs neither, and warns that it is for a trusted tester only');
  const viaEnv = runPrepare(['--platform', 'win', '--check'], { PLEMMO_RELEASE_PILOT: '1' });
  ok(viaEnv.status === 0, 'PLEMMO_RELEASE_PILOT=1 does the same (for the build workflow)');
  const policyPath = path.join(testDir, 'license-policy.json');
  const w = spawnSync(process.execPath, ['-e', `const {validate}=require(${JSON.stringify(prepare)});const pkg=require(${JSON.stringify(path.join(root, 'package.json'))});const r=validate({env:{},platform:'win',pkg,brand:null,pilot:true});require('fs').writeFileSync(${JSON.stringify(policyPath)},JSON.stringify(r.policy));`], { encoding: 'utf8' });
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  ok(w.status === 0 && policy.pilot === true && policy.requireActivation === false && policy.allowCardSimulator === true && Object.keys(policy.publicKeys).length === 0, 'the pilot policy: pilot, no activation required, simulator allowed, no keys');
  const ordinary = spawnSync(process.execPath, ['-e', `const {validate}=require(${JSON.stringify(prepare)});const pkg=require(${JSON.stringify(path.join(root, 'package.json'))});const r=validate({env:{},platform:'win',pkg,brand:null});console.log(r.errors.length);`], { encoding: 'utf8' });
  ok(Number(ordinary.stdout.trim()) >= 2, 'the ordinary policy still reports its missing settings');

  console.log('\n2. running with the pilot policy');
  process.env.PLEMMO_LICENSE_POLICY_FILE = policyPath;
  const { startServer, stopServer, getServerPort } = require('../main/server');
  const { initDatabase, closeDatabase, getDatabase } = require('../main/db');
  const { availableProviderIds, simulatorAllowed } = require('../main/core/card-terminal/registry');
  initDatabase();
  const db = getDatabase();
  const bcrypt = require('bcryptjs');
  db.prepare(`INSERT INTO users (id, name, email, password, role, pin_hash, is_active) VALUES ('u-own','Owner','own@till.local',?,'owner',NULL,1)`).run(bcrypt.hashSync('Passw0rd!x', 10));
  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  try {
    const tok = (await request(base).post('/api/auth/login').send({ email: 'own@till.local', password: 'Passw0rd!x' })).body.access_token as string;
    const as = (r: any) => r.set('Authorization', `Bearer ${tok}`);
    const st = (await as(request(base).get('/api/activation/status'))).body;
    ok(st.pilot === true && st.requires_activation === false && st.trading_allowed === true, 'the till reports itself as a pilot and trades without activation');
    ok(simulatorAllowed() === true && availableProviderIds().includes('simulator'), 'the simulated card terminal is available in a packaged pilot build');
    ok((await as(request(base).put('/api/card/config')).send({ provider: 'simulator' })).status === 200, 'the owner can switch it on');
    ok((await as(request(base).get('/api/card/config'))).body.simulated === true, 'and it is labelled simulated');
  } finally { await stopServer(); closeDatabase(); }
  console.log(`\n✅ Pilot installer passed (${passed} checks)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
