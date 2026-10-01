/**
 * Licence policy — what a build of the application insists on, fixed at packaging time.
 *
 * `license-policy.json` is written next to the application by the release build and is not part of the
 * source tree (so development and tests run with no policy):
 *
 *   {
 *     "requireActivation": true,                       // trading needs an activated, licensed device
 *     "publicKeys": { "k1": "-----BEGIN PUBLIC KEY…" }, // licence-signing keys this build trusts (rotation: list old + new)
 *     "cloudUrl": "https://…"                          // where activation codes without a URL connect
 *   }
 *
 * With `publicKeys` present, a licence is only accepted if it carries a valid signature from one of these
 * keys; an unknown key id is refused. `PLEMMO_LICENSE_POLICY_FILE` points at another file (test builds);
 * `PLEMMO_LICENSE_PUBLIC_KEY` (single key, id "env") still works for managed installs without a policy file.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createPublicKey, KeyObject } from 'crypto';

export interface LicensePolicy {
  requireActivation: boolean;
  publicKeys: Record<string, string>;
  cloudUrl: string;
}

const NONE: LicensePolicy = { requireActivation: false, publicKeys: {}, cloudUrl: '' };

function candidatePaths(): string[] {
  const paths: string[] = [];
  if (process.env.PLEMMO_LICENSE_POLICY_FILE) paths.push(process.env.PLEMMO_LICENSE_POLICY_FILE);
  const resources = (process as any).resourcesPath as string | undefined;
  if (resources) paths.push(path.join(resources, 'license-policy.json'));
  return paths;
}

let cached: LicensePolicy | null = null;
let cachedKeys: Map<string, KeyObject> | null = null;

export function getLicensePolicy(): LicensePolicy {
  if (cached) return cached;
  for (const p of candidatePaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<LicensePolicy>;
      cached = {
        requireActivation: raw.requireActivation === true,
        publicKeys: raw.publicKeys && typeof raw.publicKeys === 'object' ? raw.publicKeys : {},
        cloudUrl: typeof raw.cloudUrl === 'string' ? raw.cloudUrl.trim().replace(/\/+$/, '') : '',
      };
      return cached;
    } catch (e) {
      console.warn('[LicensePolicy] could not read', p, (e as Error).message);
    }
  }
  cached = { ...NONE };
  return cached;
}

let envMemo: { pem: string; key: KeyObject | null } | null = null;

/** Every licence-signing public key this build trusts, by key id. */
export function getPinnedKeys(): Map<string, KeyObject> {
  if (!cachedKeys) {
    cachedKeys = new Map();
    for (const [id, pem] of Object.entries(getLicensePolicy().publicKeys)) {
      try { cachedKeys.set(id, createPublicKey(pem.includes('-----') ? pem.replace(/\\n/g, '\n') : pem)); } catch { /* an unusable key is simply not trusted */ }
    }
  }
  const keys = new Map(cachedKeys);
  const env = process.env.PLEMMO_LICENSE_PUBLIC_KEY;
  if (env && env.trim()) {
    if (!envMemo || envMemo.pem !== env) {
      let key: KeyObject | null = null;
      try { key = createPublicKey(env.includes('-----') ? env.replace(/\\n/g, '\n') : env); } catch { key = null; }
      envMemo = { pem: env, key };
    }
    if (envMemo.key) keys.set('env', envMemo.key);
  }
  return keys;
}

export function resetLicensePolicyCache(): void { cached = null; cachedKeys = null; envMemo = null; }
