/**
 * Plemmo Cloud/Client — request signing (SYNC-B).
 *
 * The canonical string a device signs and the cloud verifies. Kept
 * dependency-free (node crypto only) so the identical logic can live on both
 * the cloud (`cloud/`) and the local client (`main/core/sync/`) without
 * either importing the other's tree. If this format changes, BOTH copies
 * must change together — it is intentionally tiny and stable.
 *
 * Algorithm: Ed25519 (the same primitive the repo already uses for tax-pack
 * signing). The device holds the private key (OS-protected in production; a
 * local file in dev — never in any database, per SYNC-0 Part O). The cloud
 * holds only the public key.
 */

import { createHash, sign as edSign, verify as edVerify, KeyObject } from 'crypto';

export interface SignatureParts {
  deviceUid: string;
  timestamp: string;
  nonce: string;
  signatureB64: string;
}

/** Deterministic string bound to method, path (incl. query), time, nonce, and body. */
export function canonicalRequest(method: string, pathWithQuery: string, timestamp: string, nonce: string, body: string): string {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  return [method.toUpperCase(), pathWithQuery, timestamp, nonce, bodyHash].join('\n');
}

export function signRequest(privateKey: KeyObject, method: string, pathWithQuery: string, timestamp: string, nonce: string, body: string): string {
  const canonical = canonicalRequest(method, pathWithQuery, timestamp, nonce, body);
  return edSign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');
}

export function verifyRequest(publicKey: KeyObject, method: string, pathWithQuery: string, timestamp: string, nonce: string, body: string, signatureB64: string): boolean {
  try {
    const canonical = canonicalRequest(method, pathWithQuery, timestamp, nonce, body);
    return edVerify(null, Buffer.from(canonical, 'utf8'), publicKey, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}
