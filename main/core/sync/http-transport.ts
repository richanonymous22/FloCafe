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

  /**
   * Pulls the cross-device conflicts the cloud has detected for this device's
   * organization (SYNC-F). The org is resolved server-side from the device —
   * a device only ever sees its own org's conflicts.
   */
  async pullConflicts(): Promise<CloudConflictDTO[]> {
    const res = await this.signedFetch('GET', '/sync/v1/conflicts', '');
    const data = await res.json() as { conflicts?: CloudConflictDTO[] };
    return data.conflicts ?? [];
  }

  /**
   * Reports a locally-decided conflict resolution back to the cloud so other
   * devices converge (SYNC-F). The cloud re-validates the financial-safety
   * rule server-side (defense in depth) and records the resolution as durable
   * append-only history. Returns whether the cloud accepted it.
   */
  async reportResolution(input: ConflictResolutionReport): Promise<{ ok: boolean; reason?: string }> {
    const body = JSON.stringify(input);
    const res = await this.signedFetch('POST', '/sync/v1/conflicts/resolve', body);
    if (res.status === 422) {
      const data = await res.json().catch(() => ({})) as { reason?: string };
      return { ok: false, reason: data.reason ?? 'rejected' };
    }
    const data = await res.json().catch(() => ({})) as { recorded?: boolean };
    return { ok: !!data.recorded };
  }
}

/** A conflict as the cloud reports it to a device (SYNC-F). */
export interface CloudConflictDTO {
  conflict_uid: string;
  organization_uid: string;
  location_uid: string | null;
  entity_type: string;
  entity_uid: string;
  local_event_uid: string | null;
  remote_event_uid: string | null;
  local_device_uid: string | null;
  remote_device_uid: string | null;
  conflict_type: string;
  detected_at: string;
  status: string;
  resolution: string | null;
}

export interface ConflictResolutionReport {
  conflict_uid: string;
  status: 'acknowledged' | 'resolved' | 'dismissed';
  strategy?: string | null;
  resolution_notes?: string | null;
  compensation_reference?: string | null;
  actor_user_id?: string | null;
  resolved_at?: string | null;
}
