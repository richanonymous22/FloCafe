#!/usr/bin/env node
/*
 * Generate the licence-signing key pair and the operator token, on YOUR computer.
 *
 *   node scripts/generate-licence-key.cjs --out ~/plemmo-secrets [--id k1]
 *
 * Writes into the folder you name (which must be OUTSIDE this repository):
 *   licence-signing-key.private.pem   PRIVATE key. Goes into the cloud host's secret store as
 *                                     PLEMMO_LICENSE_SIGNING_KEY. Never commit it, email it or paste it into a chat.
 *   licence-signing-key.public.pem    PUBLIC key. Safe to share. Goes into the release build.
 *   release-env.txt                   the lines to set for a release build (public key + key id).
 *   host-env.txt                      the lines to set on the cloud host (PRIVATE key + token): treat as a secret.
 *
 * Files are created with owner-only permissions. Nothing is printed except where the files are.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { generateKeyPairSync, randomBytes } = require('crypto');

function parse(argv) {
  const o = { id: 'k1', out: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') o.out = argv[++i] || '';
    else if (argv[i] === '--id') o.id = argv[++i] || '';
  }
  return o;
}

function run(argv = process.argv.slice(2)) {
  const { id, out } = parse(argv);
  if (!out) { console.error('Say where to put the files: --out <folder outside this repository>'); return 2; }
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) { console.error('The key id may use letters, digits, - and _ (32 characters at most).'); return 2; }
  const dir = path.resolve(out.replace(/^~(?=$|\/|\\)/, os.homedir()));
  const repo = path.resolve(__dirname, '..');
  if (dir === repo || dir.startsWith(repo + path.sep)) { console.error('Refusing to write secrets inside the repository. Choose a folder elsewhere (for example ~/plemmo-secrets).'); return 2; }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = ['licence-signing-key.private.pem', 'licence-signing-key.public.pem', 'release-env.txt', 'host-env.txt'];
  const existing = files.filter((f) => fs.existsSync(path.join(dir, f)));
  if (existing.length) { console.error(`Not overwriting existing files in ${dir}: ${existing.join(', ')}. Move them first (an old key may still be in use).`); return 2; }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const token = randomBytes(32).toString('base64url');
  const oneLine = (pem) => pem.trim().replace(/\r?\n/g, '\\n');
  const write = (name, text) => fs.writeFileSync(path.join(dir, name), text, { mode: 0o600 });
  write('licence-signing-key.private.pem', privatePem);
  write('licence-signing-key.public.pem', publicPem);
  write('release-env.txt', [
    '# Set these when you build a release installer (GitHub: Settings > Secrets and variables > Actions).',
    `PLEMMO_LICENSE_PUBLIC_KEYS={"${id}":"${oneLine(publicPem)}"}`,
    'PLEMMO_RELEASE_CLOUD_URL=https://<the address of your cloud>',
    '',
  ].join('\n'));
  write('host-env.txt', [
    '# SECRET. Set these on the cloud host only (its secret or environment settings). Do not share this file.',
    `PLEMMO_LICENSE_SIGNING_KEY_ID=${id}`,
    `PLEMMO_LICENSE_SIGNING_KEY=${oneLine(privatePem)}`,
    `PLEMMO_CLOUD_ADMIN_TOKEN=${token}`,
    '',
  ].join('\n'));
  console.log(`Created 4 files in ${dir}`);
  console.log('  host-env.txt and the .private.pem are SECRET: keep them off the internet, out of email and out of this repository.');
  console.log('  release-env.txt holds only public values.');
  return 0;
}

if (require.main === module) process.exit(run());
module.exports = { run };
