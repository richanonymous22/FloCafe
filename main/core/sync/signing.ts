/**
 * Client-side request signing (SYNC-B). MUST stay byte-for-byte identical to
 * `cloud/signing.ts` — the two live in separate build roots (main/ vs cloud/)
 * so neither imports the other; the canonical format is intentionally tiny
 * and stable. If one changes, change both.
 */

import { createHash, sign as edSign, KeyObject } from 'crypto';

export function canonicalRequest(method: string, pathWithQuery: string, timestamp: string, nonce: string, body: string): string {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  return [method.toUpperCase(), pathWithQuery, timestamp, nonce, bodyHash].join('\n');
}

export function signRequest(privateKey: KeyObject, method: string, pathWithQuery: string, timestamp: string, nonce: string, body: string): string {
  const canonical = canonicalRequest(method, pathWithQuery, timestamp, nonce, body);
  return edSign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');
}
