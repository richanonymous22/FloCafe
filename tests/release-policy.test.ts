/*
 * Release preparation — a release build must carry the licence policy and refuse to build without it.
 * Runs scripts/prepare-release.cjs's validation with a range of environments; no build is performed.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';

const { validate } = require('../scripts/prepare-release.cjs');
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const brand = JSON.parse(fs.readFileSync(path.join(root, 'brand', 'brand.json'), 'utf8'));
let checks = 0;
function ok(cond: boolean, msg: string) { assert.ok(cond, msg); checks++; console.log(`  ✓ ${msg}`); }

const ed = generateKeyPairSync('ed25519');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubPem = ed.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const goodEnv = { PLEMMO_RELEASE_CLOUD_URL: 'https://cloud.example.com', PLEMMO_LICENSE_PUBLIC_KEYS: JSON.stringify({ k1: pubPem }), CSC_LINK: 'x' } as NodeJS.ProcessEnv;
const run = (env: NodeJS.ProcessEnv, platform = 'win', p = pkg) => validate({ env, platform, pkg: p, brand });

console.log('Testing release preparation...');

console.log('\n1. a complete configuration passes and produces the policy');
const good = run(goodEnv);
ok(good.errors.length === 0, 'no errors');
ok(good.policy.requireActivation === true && good.policy.cloudUrl === 'https://cloud.example.com' && Object.keys(good.policy.publicKeys).join() === 'k1', 'the policy requires activation, names the cloud and pins the key');
ok(good.policy.publicKeys.k1.includes('BEGIN PUBLIC KEY'), 'the pinned key is the public key');

console.log('\n2. anything missing or unsafe refuses the build');
ok(run({ ...goodEnv, PLEMMO_RELEASE_CLOUD_URL: '' }).errors.some((e: string) => /CLOUD_URL is not set/.test(e)), 'no cloud address');
ok(run({ ...goodEnv, PLEMMO_RELEASE_CLOUD_URL: 'http://cloud.example.com' }).errors.some((e: string) => /must be https/.test(e)), 'a plain-http cloud address');
ok(run({ ...goodEnv, PLEMMO_RELEASE_CLOUD_URL: 'https://user:pw@cloud.example.com' }).errors.some((e: string) => /credentials/.test(e)), 'credentials in the address');
ok(run({ ...goodEnv, PLEMMO_LICENSE_PUBLIC_KEYS: '' }).errors.some((e: string) => /PUBLIC_KEYS is not set/.test(e)), 'no pinned licence key (a build that accepts any licence)');
ok(run({ ...goodEnv, PLEMMO_LICENSE_PUBLIC_KEYS: '{"k1":"not a key"}' }).errors.some((e: string) => /not a readable public key/.test(e)), 'an unreadable key');
ok(run({ ...goodEnv, PLEMMO_LICENSE_PUBLIC_KEYS: JSON.stringify({ k1: rsa.publicKey.export({ type: 'spki', format: 'pem' }) }) }).errors.some((e: string) => /not an Ed25519/.test(e)), 'a key of the wrong type');
const priv = ed.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
ok(run({ ...goodEnv, PLEMMO_LICENSE_PUBLIC_KEYS: JSON.stringify({ k1: priv }) }).errors.length > 0, 'a PRIVATE key can never be shipped');
const two = run({ ...goodEnv, PLEMMO_LICENSE_PUBLIC_KEYS: JSON.stringify({ k1: pubPem, k2: (generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) as string) }) });
ok(two.errors.length === 0 && Object.keys(two.policy.publicKeys).length === 2, 'two keys can be pinned together (key rotation)');
ok(run({ ...goodEnv, PLEMMO_RELEASE_UPDATE_URL: 'http://feed.example.com' }).errors.some((e: string) => /UPDATE_URL must be https/.test(e)), 'a plain-http update feed');

console.log('\n3. packaging checks');
const withoutPolicy = { ...pkg, build: { ...pkg.build, extraResources: pkg.build.extraResources.filter((r: any) => r.from !== 'build-release') } };
ok(run(goodEnv, 'win', withoutPolicy).errors.some((e: string) => /does not ship build-release/.test(e)), 'a package config that would leave the policy out of the app is refused');
ok(pkg.build.extraResources.some((r: any) => r.from === 'build-release'), 'the real package.json ships build-release/');
ok(run({ ...goodEnv, CSC_LINK: '' }).warnings.some((w: string) => /code-signing/.test(w)), 'an unsigned Windows build is warned about');
const appx = run(goodEnv, 'appx');
ok(appx.errors.some((e: string) => /appx\.identityName/.test(e)) && appx.errors.some((e: string) => /appx\.publisher /.test(e)), 'an AppX build still carrying the upstream Store identity is refused');
ok(run(goodEnv, 'win').errors.length === 0, 'but a Windows installer build is not blocked by the Store identity');
ok(run(goodEnv, 'mac').errors.some((e: string) => /mac\.identity/.test(e)), 'a macOS build with the upstream Apple identity is refused');
const mine = { ...pkg, build: { ...pkg.build, appx: { identityName: 'AcmeLtd.Meridian', publisher: 'CN=ABCD', publisherDisplayName: 'Acme Ltd', displayName: 'Meridian POS' } } };
ok(run(goodEnv, 'appx', mine).errors.length === 0, 'an AppX build with the owner\'s own identity passes');

console.log('\n4. the script itself');
const bad = spawnSync('node', ['scripts/prepare-release.cjs', '--platform', 'win', '--check'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });
ok(bad.status === 1 && /Release build refused/.test(bad.stderr), 'run with no environment it exits 1 and says the build is refused');
const dirty = fs.existsSync(path.join(root, 'build-release', 'license-policy.json'));
const out = spawnSync('node', ['scripts/prepare-release.cjs', '--platform', 'win'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, ...goodEnv } });
ok(out.status === 0 && fs.existsSync(path.join(root, 'build-release', 'license-policy.json')), 'with a good environment it writes build-release/license-policy.json');
const written = JSON.parse(fs.readFileSync(path.join(root, 'build-release', 'license-policy.json'), 'utf8'));
ok(written.requireActivation === true && written.cloudUrl === 'https://cloud.example.com', 'the written policy is what the app reads');
// the app reads exactly this file format
process.env.PLEMMO_LICENSE_POLICY_FILE = path.join(root, 'build-release', 'license-policy.json');
const { getLicensePolicy, getPinnedKeys, resetLicensePolicyCache } = require('../main/core/license-policy');
resetLicensePolicyCache();
ok(getLicensePolicy().requireActivation === true && getPinnedKeys().has('k1'), 'the application loads that file: activation required and the key pinned');
if (!dirty) fs.rmSync(path.join(root, 'build-release', 'license-policy.json'));
console.log(`\n✅ Release preparation passed (${checks} checks)`);
