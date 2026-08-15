/**
 * Plemmo Cloud — the sync HTTP API (SYNC-B, hardened in SYNC-C).
 *
 * A real Express service exposing the provider-neutral sync protocol for
 * inventory movements only:
 *   POST /sync/v1/upload    — a device uploads a batch of movement events
 *   GET  /sync/v1/pull       — a device pulls movement events it is entitled to
 *   POST /sync/v1/enroll     — PRODUCTION enrollment via a one-time token
 *   POST /sync/v1/dev/enroll — DEV/TEST ONLY device registration (gated)
 *
 * The concrete backend is `CloudStore` (SQLite in dev, Postgres in prod). No
 * provider logic lives in the local client — it speaks only this protocol.
 *
 * Security posture (Part J): every /upload and /pull request is authenticated
 * by device signature; organization and location are resolved from the device
 * registry, never trusted from the payload. Body size is capped; requests are
 * rate-limited per device; auth failures return a COARSE reason to the client
 * (no device-enumeration oracle) while the detailed reason is logged; no CORS
 * headers are emitted (this is a device-to-server API, never browser-origin).
 */

import express, { Express, NextFunction, Request, Response } from 'express';
import { CloudDevice, CloudEntityType, CloudEvent, CloudPullPage, StoreResult } from './store';
import { authenticateDevice, AuthStore, clientAuthReason, DeviceAuthError, SignedRequestFields } from './auth';
import { enrollWithToken, EnrollStore, EnrollmentError } from './enrollment';

/**
 * The store surface the sync server uses. Every method may be sync or async,
 * so ONE server runs unchanged over the sync `SqliteCloudStore` (dev/test) and
 * the async `PostgresCloudStore` (production) — the sync-vs-async seam is fully
 * absorbed here (SYNC-D). Both concrete stores satisfy it structurally.
 */
export interface ServerCloudStore extends AuthStore, EnrollStore {
  registerDevice(device: CloudDevice): void | Promise<void>;
  markDeviceSeen(deviceUid: string, at: string): void | Promise<void>;
  markDeviceSynced(deviceUid: string, at: string): void | Promise<void>;
  storeEvent(event: CloudEvent, receivedAt: string): StoreResult | Promise<StoreResult>;
  pullEvents(organizationUid: string, afterCursor: number, limit: number, excludeDeviceUid?: string): CloudPullPage | Promise<CloudPullPage>;
  logSync(kind: string, detail: { deviceUid?: string | null; organizationUid?: string | null; entityType?: string | null; message?: string }, at: string): void | Promise<void>;
}

const MAX_BATCH = 500;
const BODY_LIMIT = '1mb';
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 240; // per device per minute — generous for batching, curbs storms

interface UploadEvent {
  uid: string;                 // outbox event uid
  device_id: string;
  sequence: number;
  entity_type: string;
  entity_uid: string;          // the business fact uid
  organization_id: string | null;
  location_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

/**
 * The multi-entity registry (SYNC-D, Part M). Each synchronized entity type
 * declares how to validate its payload. Identity (org/location) is ALWAYS
 * resolved from the authenticated device, never trusted from the payload —
 * the registry only decides whether a payload is well-formed for its type.
 */
const ENTITY_REGISTRY: Record<CloudEntityType, (p: Record<string, unknown>) => boolean> = {
  inventory_movement: (p) => typeof p.quantity_delta === 'number' && !!p.product_id && !!p.movement_type,
  audit_event: (p) => !!p.audit_uid && !!p.event_type,
  payment_event: (p) => !!p.payment_event_uid && !!p.payment_uid && !!p.to_state,
};

function isKnownEntity(t: string): t is CloudEntityType {
  return t === 'inventory_movement' || t === 'audit_event' || t === 'payment_event';
}

function signedFields(req: Request): SignedRequestFields {
  return {
    method: req.method,
    pathWithQuery: req.originalUrl,
    rawBody: (req as unknown as { rawBody?: string }).rawBody ?? '',
    deviceUid: req.header('x-plemmo-device') ?? undefined,
    timestamp: req.header('x-plemmo-timestamp') ?? undefined,
    nonce: req.header('x-plemmo-nonce') ?? undefined,
    signatureB64: req.header('x-plemmo-signature') ?? undefined,
  };
}

/** In-memory fixed-window rate limiter. In a multi-instance production
 *  deployment this is replaced by a shared limiter (gateway / Redis); the
 *  interface is the same. */
function createRateLimiter(windowMs: number, max: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return function allow(key: string, nowMs: number): boolean {
    const entry = hits.get(key);
    if (!entry || nowMs >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: nowMs + windowMs });
      return true;
    }
    if (entry.count >= max) return false;
    entry.count += 1;
    return true;
  };
}

export interface CreateCloudServerOptions {
  /** Enables POST /sync/v1/dev/enroll. DEV/TEST ONLY — must be false in production. */
  enableDevEnroll?: boolean;
}

export function createCloudServer(store: ServerCloudStore, options: CreateCloudServerOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({
    limit: BODY_LIMIT,
    verify: (req, _res, buf) => { (req as unknown as { rawBody: string }).rawBody = buf.toString('utf8'); },
  }));

  // A malformed / oversized body throws in the JSON parser — answer 400/413
  // without leaking a stack (Part J — error leakage).
  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'malformed json' });
    return res.status(400).json({ error: 'bad request' });
  });

  const rateLimited = createRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

  /** Authenticates, rate-limits, and stamps last_seen. Returns the device, or
   *  null after having already written the error response. */
  async function authOrReject(req: Request, res: Response): Promise<CloudDevice | null> {
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const rlKey = req.header('x-plemmo-device') ?? req.ip ?? 'anon';
    if (!rateLimited(rlKey, nowMs)) {
      await store.logSync('rate_limited', { deviceUid: req.header('x-plemmo-device'), message: req.path }, nowIso);
      res.status(429).json({ error: 'rate limited' });
      return null;
    }
    try {
      const auth = await authenticateDevice(store, signedFields(req), nowMs);
      await store.markDeviceSeen(auth.device.device_uid, nowIso);
      return auth.device;
    } catch (error) {
      const reason = error instanceof DeviceAuthError ? error.reason : 'error';
      await store.logSync('auth_failure', { deviceUid: req.header('x-plemmo-device'), message: reason }, nowIso);
      const clientReason = error instanceof DeviceAuthError ? clientAuthReason(error.reason) : 'unauthenticated';
      res.status(401).json({ error: 'unauthenticated', reason: clientReason });
      return null;
    }
  }

  // ── DEV/TEST ONLY device enrollment ──────────────────────────────────────
  // Registers a device's PUBLIC key + org/location, trusting the caller.
  // Gated off unless explicitly enabled; MUST NOT be exposed in production —
  // production uses the token flow below.
  if (options.enableDevEnroll) {
    app.post('/sync/v1/dev/enroll', async (req: Request, res: Response) => {
      const { device_uid, organization_uid, location_uid, register_uid, public_key } = req.body ?? {};
      if (!device_uid || !organization_uid || !public_key) {
        return res.status(400).json({ error: 'device_uid, organization_uid and public_key are required' });
      }
      await store.registerDevice({ device_uid, organization_uid, location_uid: location_uid ?? null, register_uid: register_uid ?? null, public_key, status: 'active' });
      res.status(201).json({ enrolled: true, device_uid });
    });
  }

  // ── PRODUCTION enrollment via one-time activation token (Part F) ─────────
  app.post('/sync/v1/enroll', async (req: Request, res: Response) => {
    const { token, device_uid, public_key } = req.body ?? {};
    try {
      const enrolled = await enrollWithToken(store, { token, deviceUid: device_uid, publicKey: public_key });
      await store.logSync('enrolled', { deviceUid: enrolled.device_uid, organizationUid: enrolled.organization_uid }, new Date().toISOString());
      res.status(201).json({ enrolled: true, ...enrolled });
    } catch (error) {
      const reason = error instanceof EnrollmentError ? error.reason : 'error';
      res.status(400).json({ error: 'enrollment_failed', reason });
    }
  });

  app.post('/sync/v1/upload', async (req: Request, res: Response) => {
    const device = await authOrReject(req, res);
    if (!device) return;

    const events: UploadEvent[] = Array.isArray(req.body?.events) ? req.body.events : [];
    if (events.length === 0) return res.json({ accepted: [], duplicate: [], rejected: [] });
    if (events.length > MAX_BATCH) return res.status(413).json({ error: `batch exceeds ${MAX_BATCH} events` });

    const accepted: string[] = [];
    const duplicate: string[] = [];
    const rejected: Array<{ uid: string; reason: string; category: string }> = [];
    const receivedAt = new Date().toISOString();

    for (const ev of events) {
      // PERMANENT rejections: unknown entity type / malformed payload.
      if (!isKnownEntity(ev.entity_type)) {
        rejected.push({ uid: ev.uid, reason: 'unsupported entity_type', category: 'permanent' });
        await store.logSync('rejected', { deviceUid: device.device_uid, organizationUid: device.organization_uid, entityType: ev.entity_type, message: 'unsupported entity_type' }, receivedAt);
        continue;
      }
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      if (!ev.uid || !ev.entity_uid || !ENTITY_REGISTRY[ev.entity_type](p)) {
        rejected.push({ uid: ev.uid, reason: 'malformed event', category: 'permanent' });
        await store.logSync('rejected', { deviceUid: device.device_uid, organizationUid: device.organization_uid, entityType: ev.entity_type, message: 'malformed event' }, receivedAt);
        continue;
      }
      // AUTH/ISOLATION rejections (Part P): the fact must belong to THIS
      // device's organization (resolved server-side), and to the device's
      // location when the device is location-bound. Client-claimed
      // organization_id/location_id/device_id/actor are validated against the
      // device identity, never trusted to override it. Applies to every
      // entity type identically.
      const eventOrg = (p.organization_id as string | null) ?? ev.organization_id ?? null;
      if (eventOrg !== null && eventOrg !== device.organization_uid) {
        rejected.push({ uid: ev.uid, reason: 'organization mismatch', category: 'auth' });
        await store.logSync('rejected', { deviceUid: device.device_uid, organizationUid: device.organization_uid, entityType: ev.entity_type, message: 'organization mismatch' }, receivedAt);
        continue;
      }
      const eventLoc = (p.location_id as string | null) ?? ev.location_id ?? null;
      if (device.location_uid && eventLoc !== null && eventLoc !== device.location_uid) {
        rejected.push({ uid: ev.uid, reason: 'location mismatch', category: 'auth' });
        await store.logSync('rejected', { deviceUid: device.device_uid, organizationUid: device.organization_uid, entityType: ev.entity_type, message: 'location mismatch' }, receivedAt);
        continue;
      }

      const cloudEvent: CloudEvent = {
        event_uid: ev.uid,
        entity_type: ev.entity_type,
        entity_uid: ev.entity_uid,
        organization_uid: device.organization_uid, // authoritative: from the device
        location_uid: eventLoc,
        device_uid: device.device_uid,             // authoritative: from the device
        device_sequence: ev.sequence,
        payload: JSON.stringify(p),
        created_at: String(p.created_at ?? p.occurred_at ?? ev.created_at),
      };
      const result = await store.storeEvent(cloudEvent, receivedAt);
      const logBase = { deviceUid: device.device_uid, organizationUid: device.organization_uid, entityType: ev.entity_type };
      if (result === 'duplicate') { duplicate.push(ev.uid); await store.logSync('duplicate', logBase, receivedAt); }
      else { accepted.push(ev.uid); await store.logSync('accepted', logBase, receivedAt); }
    }

    await store.markDeviceSynced(device.device_uid, receivedAt);
    res.json({ accepted, duplicate, rejected });
  });

  app.get('/sync/v1/pull', async (req: Request, res: Response) => {
    const device = await authOrReject(req, res);
    if (!device) return;
    const cursor = Number(req.query.cursor ?? 0) || 0;
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, MAX_BATCH);

    // Organization isolation (Part J): a device only ever receives its OWN
    // organization's events, and never its own uploads back (a device already
    // has its own movements locally). The cursor advances past excluded own
    // events because pullMovements reports the raw scanned position.
    const page = await store.pullEvents(device.organization_uid, cursor, limit, device.device_uid);
    await store.markDeviceSynced(device.device_uid, new Date().toISOString());
    res.json({
      events: page.events.map((e) => ({
        event_uid: e.event_uid,
        entity_type: e.entity_type,
        entity_uid: e.entity_uid,
        feed_seq: e.feed_seq,
        payload: JSON.parse(e.payload),
      })),
      next_cursor: page.nextCursor,
      has_more: page.hasMore,
    });
  });

  return app;
}
