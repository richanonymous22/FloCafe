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
import { CloudConflict, CloudDevice, CloudEntityType, CloudEvent, CloudInventoryDeficit, CloudPullPage, ConflictResolutionInput, OrganizationHealth, StoreResult } from './store';
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
  // Conflict resolution (SYNC-F).
  listConflicts(organizationUid: string): CloudConflict[] | Promise<CloudConflict[]>;
  getConflict(conflictUid: string): CloudConflict | null | Promise<CloudConflict | null>;
  recordConflictResolution(input: ConflictResolutionInput, at: string): void | Promise<void>;
  // Operator read models (SYNC-G).
  organizationHealth(organizationUid: string): OrganizationHealth | Promise<OrganizationHealth>;
  listDeficits(organizationUid: string): CloudInventoryDeficit[] | Promise<CloudInventoryDeficit[]>;
}

/**
 * Server-side financial-safety re-validation (SYNC-F Part C, defense in depth).
 * The device already enforced role authorization + the full legality matrix
 * before reporting; the cloud independently refuses a blind `accept_remote`
 * overwrite of the two intrinsically financial conflict types, so a
 * compromised or buggy client can never launder a completed-sale overwrite
 * through the cloud. The cloud does not know local lifecycle, so this is a
 * coarse but strict guard, not the full matrix.
 */
const CLOUD_BLIND_OVERWRITE_BANNED = new Set(['payment_conflict', 'completion_conflict']);
function cloudResolutionAllowed(conflictType: string, strategy: string | null | undefined): boolean {
  if (strategy === 'accept_remote' && CLOUD_BLIND_OVERWRITE_BANNED.has(conflictType)) return false;
  return true;
}

/** Sync wire-protocol version (COMMERCIALIZATION Part H — protocol versioning).
 *  Bumped only on a breaking protocol change; surfaced on every response so a
 *  client can detect an incompatible server. */
export const PLEMMO_PROTOCOL_VERSION = '1';

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
// A reference/operational entity snapshot is well-formed when it carries its
// ULID identity + a fields object (COMMERCIALIZATION). Identity (org/location)
// is still resolved server-side from the device, never trusted from here.
const referenceValidator = (p: Record<string, unknown>) => !!p.entity_uid && typeof p.fields === 'object' && p.fields !== null;
const ENTITY_REGISTRY: Record<CloudEntityType, (p: Record<string, unknown>) => boolean> = {
  inventory_movement: (p) => typeof p.quantity_delta === 'number' && !!p.product_id && !!p.movement_type,
  audit_event: (p) => !!p.audit_uid && !!p.event_type,
  payment_event: (p) => !!p.payment_event_uid && !!p.payment_uid && !!p.to_state,
  order: (p) => !!p.order_uid && typeof p.status === 'string',
  order_item: (p) => !!p.order_item_uid && !!p.order_uid && !!p.product_id,
  bill: (p) => !!p.bill_uid,
  product: referenceValidator,
  category: referenceValidator,
  product_variant: referenceValidator,
  addon_group: referenceValidator,
  addon: referenceValidator,
  customer: referenceValidator,
  supplier: referenceValidator,
  purchase_order: referenceValidator,
  purchase_order_item: referenceValidator,
  stock_transfer: referenceValidator,
  stock_transfer_item: referenceValidator,
};

function isKnownEntity(t: string): t is CloudEntityType {
  return t in ENTITY_REGISTRY;
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

  // Stamp the protocol version on every response (COMMERCIALIZATION Part H).
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Plemmo-Protocol', PLEMMO_PROTOCOL_VERSION);
    next();
  });

  // ── Production operations: health + readiness (Part A/H) ──────────────────
  // Liveness: the process is up. No auth, no DB — safe for a load balancer.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', protocol: PLEMMO_PROTOCOL_VERSION });
  });
  // Readiness: the datastore is reachable. A trivial round-trip (returns null)
  // works identically over the SQLite dev store and the async Postgres store.
  app.get('/ready', async (_req: Request, res: Response) => {
    try {
      await store.getConflict('__ready_probe__');
      res.json({ status: 'ready', protocol: PLEMMO_PROTOCOL_VERSION });
    } catch (error) {
      res.status(503).json({ status: 'unavailable', error: (error as Error).message });
    }
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

  // ── SYNC-F: pull cross-device conflicts for this device's organization ────
  // Organization isolation (Part M/P): the org is resolved from the device,
  // never the query — a device only ever sees its own org's conflicts.
  app.get('/sync/v1/conflicts', async (req: Request, res: Response) => {
    const device = await authOrReject(req, res);
    if (!device) return;
    const conflicts = await store.listConflicts(device.organization_uid);
    res.json({ conflicts });
  });

  // ── SYNC-F: record a device-reported conflict resolution ─────────────────
  app.post('/sync/v1/conflicts/resolve', async (req: Request, res: Response) => {
    const device = await authOrReject(req, res);
    if (!device) return;
    const at = new Date().toISOString();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const conflictUid = typeof body.conflict_uid === 'string' ? body.conflict_uid : '';
    const status = body.status as string;
    const strategy = (body.strategy as string | null) ?? null;
    if (!conflictUid || !['acknowledged', 'resolved', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'conflict_uid and a valid status are required' });
    }
    const conflict = await store.getConflict(conflictUid);
    // Organization isolation: never resolve another org's conflict.
    if (!conflict || conflict.organization_uid !== device.organization_uid) {
      await store.logSync('rejected', { deviceUid: device.device_uid, organizationUid: device.organization_uid, message: 'conflict not found for org' }, at);
      return res.status(404).json({ error: 'conflict not found' });
    }
    // Defense-in-depth financial safety (Part C).
    if (!cloudResolutionAllowed(conflict.conflict_type, strategy)) {
      await store.logSync('rejected', { deviceUid: device.device_uid, organizationUid: device.organization_uid, message: 'illegal financial resolution' }, at);
      return res.status(422).json({ error: 'illegal_resolution', reason: `strategy '${strategy}' cannot overwrite a ${conflict.conflict_type}` });
    }
    await store.recordConflictResolution({
      conflict_uid: conflictUid,
      status: status as 'acknowledged' | 'resolved' | 'dismissed',
      strategy,
      resolution_notes: (body.resolution_notes as string | null) ?? null,
      compensation_reference: (body.compensation_reference as string | null) ?? null,
      actor_user_id: (body.actor_user_id as string | null) ?? null,
      device_uid: device.device_uid,
      resolved_at: (body.resolved_at as string | null) ?? null,
    }, at);
    await store.logSync('conflict_resolved', { deviceUid: device.device_uid, organizationUid: device.organization_uid, message: status }, at);
    res.json({ recorded: true });
  });

  // ── SYNC-G: operator sync/device health (organization-scoped) ────────────
  app.get('/sync/v1/health', async (req: Request, res: Response) => {
    const device = await authOrReject(req, res);
    if (!device) return;
    res.json({ health: await store.organizationHealth(device.organization_uid) });
  });

  // ── SYNC-G: operator inventory deficits (organization-scoped) ────────────
  app.get('/sync/v1/deficits', async (req: Request, res: Response) => {
    const device = await authOrReject(req, res);
    if (!device) return;
    res.json({ deficits: await store.listDeficits(device.organization_uid) });
  });

  return app;
}
