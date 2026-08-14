/**
 * Plemmo Core — real HTTP sync transport (SYNC-B).
 *
 * The production-shaped `SyncTransport` (upload) + `SyncPullTransport`
 * (download) that talks to the Plemmo Sync API over HTTP(S). A drop-in for
 * SYNC-A's mock: `uploadPendingBatch` and the downloader take this
 * unchanged. Contains ONLY the sync protocol — no knowledge of what backs
 * the cloud (Part B, provider-neutral).
 *
 * Every request is Ed25519-signed with this device's private key
 * (device-identity.ts); the cloud resolves organization/location from the
 * device registry, never from the payload.
 */

import { randomBytes } from 'crypto';
import {
  OutboxEventDTO, SyncUploadResult, SyncTransport, SyncPullTransport, PullResult, SyncTransportError,
} from './types';
import { signRequest } from './signing';
import { getOrCreateDeviceKey } from './device-identity';

export interface HttpSyncTransportOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class HttpSyncTransport implements SyncTransport, SyncPullTransport {
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(options: HttpSyncTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async signedFetch(method: string, pathWithQuery: string, body: string): Promise<Response> {
    const { privateKey, deviceId } = getOrCreateDeviceKey();
    const timestamp = new Date().toISOString();
    const nonce = randomBytes(16).toString('hex');
    const signature = signRequest(privateKey, method, pathWithQuery, timestamp, nonce, body);
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + pathWithQuery, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-plemmo-device': deviceId,
          'x-plemmo-timestamp': timestamp,
          'x-plemmo-nonce': nonce,
          'x-plemmo-signature': signature,
        },
        body: method === 'GET' ? undefined : body,
      });
    } catch (error) {
      // Network unreachable / DNS / connection reset — transient (Part O).
      throw new SyncTransportError(`network error: ${(error as Error).message}`, 'transient');
    }
    if (res.status === 401 || res.status === 403) {
      throw new SyncTransportError(`auth failure (${res.status})`, 'auth');
    }
    if (res.status >= 500) {
      throw new SyncTransportError(`server error (${res.status})`, 'transient');
    }
    return res;
  }

  async upload(events: OutboxEventDTO[]): Promise<SyncUploadResult> {
    const body = JSON.stringify({ events });
    const res = await this.signedFetch('POST', '/sync/v1/upload', body);
    if (res.status === 413) throw new SyncTransportError('batch too large (413)', 'transient');
    const data = await res.json() as { accepted?: string[]; duplicate?: string[]; rejected?: Array<{ uid: string; reason: string }> };
    // A duplicate is an idempotent SUCCESS — the cloud already has the fact,
    // so the local event is safe to ack (Part D/N). Only true rejections fail.
    const acked = [...(data.accepted ?? []), ...(data.duplicate ?? [])];
    return { acked, rejected: data.rejected ?? [] };
  }

  async pull(cursor: number, limit = 100): Promise<PullResult> {
    const res = await this.signedFetch('GET', `/sync/v1/pull?cursor=${encodeURIComponent(String(cursor))}&limit=${limit}`, '');
    const data = await res.json() as PullResult;
    return { events: data.events ?? [], next_cursor: data.next_cursor ?? cursor, has_more: !!data.has_more };
  }
}
