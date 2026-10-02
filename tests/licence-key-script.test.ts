/*
 * The licence key generator: writes a usable key pair OUTSIDE the repository, owner-only, never overwrites, and the
 * result is accepted by the real signing and verification code.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPublicKey, createPrivateKey, sign, verify } from 'node:crypto';

let passed = 0;
function ok(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); passed++; console.log(`  ✓ ${msg}`); }
const script = path.join(__dirname, '..', 'scripts', 'generate-licence-key.cjs');
const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

console.log('Testing the licence key generator...');
const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flo-keys-')), 'secrets');
ok(run([]).status === 2, 'it asks where to put the files');
ok(run(['--out', path.join(__dirname, '..', 'secrets-here')]).status === 2, 'it refuses to write inside the repository');
ok(run(['--out', dir, '--id', 'bad id!']).status === 2, 'it refuses a key id with odd characters');
const r = run(['--out', dir, '--id', 'k7']);
ok(r.status === 0 && !/PRIVATE KEY|BEGIN/.test(r.stdout), 'it creates the files and prints no key');
const files = fs.readdirSync(dir).sort();
ok(files.join() === 'host-env.txt,licence-signing-key.private.pem,licence-signing-key.public.pem,release-env.txt', 'four files are written');
ok(process.platform === 'win32' || files.every((f) => (fs.statSync(path.join(dir, f)).mode & 0o077) === 0), 'each is readable by the owner only');
const priv = fs.readFileSync(path.join(dir, 'licence-signing-key.private.pem'), 'utf8');
const pub = fs.readFileSync(path.join(dir, 'licence-signing-key.public.pem'), 'utf8');
const sig = sign(null, Buffer.from('licence'), createPrivateKey(priv));
ok(verify(null, Buffer.from('licence'), createPublicKey(pub), sig), 'the key pair is a working Ed25519 pair');
const rel = fs.readFileSync(path.join(dir, 'release-env.txt'), 'utf8');
const host = fs.readFileSync(path.join(dir, 'host-env.txt'), 'utf8');
ok(!/PRIVATE/.test(rel) && /PUBLIC KEY/.test(rel) && /"k7"/.test(rel), 'the release file holds only the public key, under the chosen id');
ok(/PLEMMO_LICENSE_SIGNING_KEY=-----BEGIN PRIVATE KEY-----/.test(host) && /PLEMMO_LICENSE_SIGNING_KEY_ID=k7/.test(host) && /PLEMMO_CLOUD_ADMIN_TOKEN=[A-Za-z0-9_-]{40,}/.test(host), 'the host file holds the private key, its id and a long random operator token');
// The release preparation accepts exactly what was generated.
const { validate } = require('../scripts/prepare-release.cjs');
const pkg = require('../package.json');
const env = { PLEMMO_RELEASE_CLOUD_URL: 'https://cloud.example.test', PLEMMO_LICENSE_PUBLIC_KEYS: rel.match(/PLEMMO_LICENSE_PUBLIC_KEYS=(.*)/)![1] };
const v = validate({ env, platform: 'win', pkg, brand: null });
ok(v.errors.length === 0 && Object.keys(v.policy.publicKeys).join() === 'k7', 'the release build accepts the generated public key');
const again = run(['--out', dir]);
ok(again.status === 2 && /Not overwriting/.test(again.stderr), 'running it again never overwrites an existing key');
console.log(`\n✅ Licence key generator passed (${passed} checks)`);
