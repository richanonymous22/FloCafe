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

import { hashToken } from './enrollment';
import { CloudMerchant, MerchantStatus, generateMerchantCode, licenceFromPlan, normaliseMerchantCode, organizationUidFor, parsePlan } from './commercial';
import express, { Express, NextFunction, Request, Response } from 'express';
import { CloudConflict, CloudDevice, CloudEntityType, CloudEvent, CloudInventoryDeficit, CloudLicense, CloudPullPage, ConflictResolutionInput, OrganizationHealth, StoreResult } from './store';
import { authenticateDevice, AuthStore, clientAuthReason, DeviceAuthError, SignedRequestFields } from './auth';
import { getLicenseSigningKey, signLicense } from './license-signing';
import { enrollWithToken, issueEnrollmentToken, EnrollStore, EnrollmentError } from './enrollment';
import { isAdminApiEnabled, bearerToken, operatorTokenMatches } from './admin-auth';

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
  getLicense(organizationUid: string): CloudLicense | null | Promise<CloudLicense | null>;
  upsertLicense(license: CloudLicense, at: string): void | Promise<void>;
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
      // The licence decides whether another device may join: refuse BEFORE the token is consumed, so a
      // suspended merchant or a full plan does not burn a good activation token.
      const claim = typeof token === 'string' ? await store.peekEnrollmentToken(hashToken(token), new Date().toISOString()) : null;
      if (claim) {
        const lic = await store.getLicense(claim.organization_uid);
        if (lic && (lic.status === 'suspended' || lic.status === 'revoked')) return res.status(403).json({ error: 'enrollment_refused', reason: 'license_not_active' });
        if (lic && lic.device_limit != null && (await store.organizationHealth(claim.organization_uid)).active_devices >= lic.device_limit) {
          return res.status(403).json({ error: 'enrollment_refused', reason: 'device_limit_reached', device_limit: lic.device_limit });
        }
      }
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

  // ── PLATFORM-HARDENING: license verification (organization-scoped) ───────
  // A device authenticates and receives ONLY its own org's license. No secret
  // is ever sent to the client; the license is verifiable server state.
  app.get('/sync/v1/license', async (req: Request, res: Response) => {
    const device = await authOrReject(req, res);
    if (!device) return;
    const license = await store.getLicense(device.organization_uid);
    // B2: sign the payload's authenticated fields so the client can verify
    // authenticity against its pinned public key. When no signing key is
    // configured (dev), the payload is served unsigned.
    if (license) {
      const signingKey = getLicenseSigningKey();
      if (signingKey) {
        res.json({ license: { ...license, signature: signLicense(signingKey, license) } });
        return;
      }
    }
    res.json({ license });
  });

  // ── Operator (admin) API — the backend contract FloAdmin calls ───────────
  // Provisioning, license issuance/lifecycle and operational read models for
  // the SEPARATE FloAdmin console. There is NO admin UI here. Every route is
  // gated by the shared operator bearer token (PLEMMO_CLOUD_ADMIN_TOKEN); when
  // it is unset the whole surface is closed (503), never open by default.
  const LICENSE_STATUSES = new Set<CloudLicense['status']>(['active', 'expired', 'suspended', 'revoked', 'unlicensed']);

  /** Rate-limits + authenticates an operator request. Returns true when the
   *  caller may proceed, or false after having written the error response. */
  async function requireOperator(req: Request, res: Response): Promise<boolean> {
    const nowIso = new Date().toISOString();
    const rlKey = `admin:${req.ip ?? 'anon'}`;
    if (!rateLimited(rlKey, Date.now())) {
      res.status(429).json({ error: 'rate limited' });
      return false;
    }
    if (!isAdminApiEnabled()) {
      // Not configured → the admin API does not exist for this deployment.
      res.status(503).json({ error: 'admin_api_disabled' });
      return false;
    }
    if (!operatorTokenMatches(bearerToken(req.header('authorization')))) {
      await store.logSync('admin_auth_failure', { message: req.path }, nowIso);
      res.status(401).json({ error: 'unauthenticated' });
      return false;
    }
    return true;
  }

  // Issue or replace an organization's license (idempotent upsert by org).
  // The stored payload is UNSIGNED; GET /sync/v1/license signs it per-request
  // against the pinned key, so there is exactly one signing seam.
  app.post('/admin/v1/licenses', async (req: Request, res: Response) => {
    if (!(await requireOperator(req, res))) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!b.organization_uid || typeof b.organization_uid !== 'string') {
      return res.status(400).json({ error: 'organization_uid is required' });
    }
    const status = (b.status as CloudLicense['status']) ?? 'active';
    if (!LICENSE_STATUSES.has(status)) return res.status(400).json({ error: 'invalid status' });
    const nowIso = new Date().toISOString();
    const license: CloudLicense = {
      organization_uid: b.organization_uid,
      status,
      plan: typeof b.plan === 'string' ? b.plan : 'none',
      issued_at: typeof b.issued_at === 'string' ? b.issued_at : nowIso,
      activated_at: typeof b.activated_at === 'string' ? b.activated_at : (status === 'active' ? nowIso : null),
      expires_at: typeof b.expires_at === 'string' ? b.expires_at : null,
      grace_days: Number.isFinite(Number(b.grace_days)) ? Number(b.grace_days) : 0,
      device_limit: b.device_limit == null ? null : Number(b.device_limit),
      location_limit: b.location_limit == null ? null : Number(b.location_limit),
      features: Array.isArray(b.features) ? (b.features as unknown[]).map(String) : [],
      signature: null,
    };
    await store.upsertLicense(license, nowIso);
    await store.logSync('license_issued', { organizationUid: license.organization_uid, message: status }, nowIso);
    res.status(200).json({ license });
  });

  // Read an organization's current (stored, unsigned) license.
  app.get('/admin/v1/licenses/:org', async (req: Request, res: Response) => {
    if (!(await requireOperator(req, res))) return;
    const license = await store.getLicense(req.params.org);
    if (!license) return res.status(404).json({ error: 'not_found' });
    res.json({ license });
  });

  // Transition an organization's license status
  // (activate/suspend/revoke/expire/reactivate). Reactivating stamps
  // activated_at if it was never set. Requires an existing license.
  app.post('/admin/v1/licenses/:org/status', async (req: Request, res: Response) => {
    if (!(await requireOperator(req, res))) return;
    const status = (req.body ?? {}).status as CloudLicense['status'];
    if (!LICENSE_STATUSES.has(status)) return res.status(400).json({ error: 'invalid status' });
    const existing = await store.getLicense(req.params.org);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    const nowIso = new Date().toISOString();
    const updated: CloudLicense = {
      ...existing,
      status,
      activated_at: status === 'active' ? (existing.activated_at ?? nowIso) : existing.activated_at,
      signature: null,
    };
    await store.upsertLicense(updated, nowIso);
    await store.logSync('license_status_changed', { organizationUid: req.params.org, message: status }, nowIso);
    res.json({ license: updated });
  });

  // Issue a one-time device activation token scoped to an org/location/register.
  // The PLAINTEXT token is returned ONCE; only its hash is stored. A device
  // redeems it at POST /sync/v1/enroll — org/location/register bind from the
  // token, never from anything the device claims.
  app.post('/admin/v1/enrollment-tokens', async (req: Request, res: Response) => {
    if (!(await requireOperator(req, res))) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!b.organization_uid || typeof b.organization_uid !== 'string') {
      return res.status(400).json({ error: 'organization_uid is required' });
    }
    const ttlMs = Number.isFinite(Number(b.ttl_seconds)) && Number(b.ttl_seconds) > 0
      ? Number(b.ttl_seconds) * 1000 : undefined;
    const { token } = await issueEnrollmentToken(store, {
      organizationUid: b.organization_uid,
      locationUid: typeof b.location_uid === 'string' ? b.location_uid : null,
      registerUid: typeof b.register_uid === 'string' ? b.register_uid : null,
      ttlMs,
    });
    await store.logSync('activation_token_issued', { organizationUid: b.organization_uid }, new Date().toISOString());
    res.status(201).json({ token, organization_uid: b.organization_uid });
  });

  // Operational health for an organization (device counts, last sync, deficits)
  // — the read model behind FloAdmin's business/terminal status views.
  app.get('/admin/v1/organizations/:org/health', async (req: Request, res: Response) => {
    if (!(await requireOperator(req, res))) return;
    const health = await store.organizationHealth(req.params.org);
    res.json(health);
  });

  // ── Commercial layer: plans and merchants (operator API) ─────────────────
  // A plan is data; a merchant is a customer with a human-readable code. Creating a merchant creates its
  // organisation and issues a licence derived from the plan, so "new merchant" is one call. Every change is
  // audited in the sync log.
  const merchantView = async (m: CloudMerchant) => ({ merchant: m, license: await store.getLicense(m.organization_uid) });
  async function loadMerchant(req: Request, res: Response): Promise<CloudMerchant | null> {
    const code = normaliseMerchantCode(String(req.params.code));
    if (!code) { res.status(400).json({ error: 'invalid_merchant_code' }); return null; }
    const m = await store.getMerchant(code);
    if (!m) { res.status(404).json({ error: 'not_found' }); return null; }
    return m;
  }

  app.get('/admin/v1/plans', async (req: Request, res: Response) => {
    if (!(await requireOperator(req, res))) return;
    res.json({ plans: await store.listPlans() });
  });

  app.put('/admin/v1/plans/:id', async (req: Request, res: Response) => {
    if (!(await requireOperator(req, res))) return;
    const { plan, error } = parsePlan(String(req.params.id), (req.body ?? {}) as Record<string, unknown>);
    if (!plan) return res.status(400).json({ error });
    const nowIso = new Date().toISOString();
    await store.upsertPlan(plan, nowIso);
    await store.logSync('plan_saved', { message: plan.plan_id }, nowIso);
    res.json({ plan });
  });

  app.post('/admin/v1/merchants', async (req: Request, res: Response) => {
    if (!(await requireOperator(req, res))) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 120) return res.status(400).json({ error: 'name is required (120 characters at most)' });
    const email = typeof b.contact_email === 'string' && b.contact_email.trim() ? b.contact_email.trim().slice(0, 200) : null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'contact_email is not a valid address' });
    const plan = typeof b.plan_id === 'string' ? await store.getPlan(b.plan_id) : null;
    if (!plan || !plan.is_active) return res.status(400).json({ error: 'plan_id must name an active plan' });
    const termDays = b.term_days == null ? undefined : Number(b.term_days);
    if (termDays !== undefined && (!Number.isInteger(termDays) || termDays < 1 || termDays > 3650)) return res.status(400).json({ error: 'term_days must be a whole number of days' });
    const nowIso = new Date().toISOString();
    const merchant: CloudMerchant = {
      merchant_code: generateMerchantCode(), name, contact_email: email, organization_uid: organizationUidFor(), plan_id: plan.plan_id,
      status: 'active', notes: typeof b.notes === 'string' ? b.notes.slice(0, 500) : null, created_at: nowIso, updated_at: nowIso,
    };
    await store.createMerchant(merchant);
    await store.upsertLicense(licenceFromPlan(plan, merchant.organization_uid, nowIso, { termDays }), nowIso);
    await store.logSync('merchant_created', { organizationUid: merchant.organization_uid, message: `${merchant.merchant_code} ${plan.plan_id}` }, nowIso);
    res.status(201).json(await merchantView(merchant));
  });

  app.get('/admin/v1/merchants', async (req: Request, res: Response) => {
    if (!(await requireOperator(req, res))) return;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    const merchants = await store.listMerchants(q || undefined);
    res.json({ merchants: await Promise.all(merchants.map(async (m) => ({ ...m, license_status: (await store.getLicense(m.organization_uid))?.status ?? null }))) });
  });

  app.get('/admin/v1/merchants/:code', async (req: Request, res: Response) => {
    if (!(await requireOperator(req, res))) return;
    const m = await loadMerchant(req, res); if (!m) return;
    res.json({ ...(await merchantView(m)), health: await store.organizationHealth(m.organization_uid) });
  });

  app.put('/admin/v1/merchants/:code', async (req: Request, res: Response) => {
    if (!(await requireOperator(req, res))) return;
    const m = await loadMerchant(req, res); if (!m) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const fields: Partial<CloudMerchant> = {};
    if (typeof b.name === 'string') { const n = b.name.trim(); if (!n || n.length > 120) return res.status(400).json({ error: 'name must be 1–120 characters' }); fields.name = n; }
    if (typeof b.contact_email === 'string') { const e = b.contact_email.trim(); if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return res.status(400).json({ error: 'contact_email is not a valid address' }); fields.contact_email = e || null; }
    if (typeof b.notes === 'string') fields.notes = b.notes.slice(0, 500);
    const nowIso = new Date().toISOString();
    const updated = await store.updateMerchant(m.merchant_code, fields, nowIso);
    await store.logSync('merchant_updated', { organizationUid: m.organization_uid, message: m.merchant_code }, nowIso);
    res.json(await merchantView(updated as CloudMerchant));
  });

  // suspend / reactivate / close move the merchant AND its licence together.
  const transitions: Record<string, { from: MerchantStatus[]; to: MerchantStatus; licence: CloudLicense['status'] }> = {
    suspend: { from: ['active'], to: 'suspended', licence: 'suspended' },
    reactivate: { from: ['suspended'], to: 'active', licence: 'active' },
    close: { from: ['active', 'suspended'], to: 'closed', licence: 'revoked' },
  };
  for (const [action, t] of Object.entries(transitions)) {
    app.post(`/admin/v1/merchants/:code/${action}`, async (req: Request, res: Response) => {
      if (!(await requireOperator(req, res))) return;
      const m = await loadMerchant(req, res); if (!m) return;
      if (!t.from.includes(m.status)) return res.status(409).json({ error: `a ${m.status} merchant cannot be ${action === 'close' ? 'closed' : action + 'd'}`, status: m.status });
      const nowIso = new Date().toISOString();
      const lic = await store.getLicense(m.organization_uid);
      if (lic) await store.upsertLicense({ ...lic, status: t.licence, activated_at: t.licence === 'active' ? (lic.activated_at ?? nowIso) : lic.activated_at, signature: null }, nowIso);
      const updated = await store.updateMerchant(m.merchant_code, { status: t.to }, nowIso);
      const reason = typeof (req.body ?? {}).reason === 'string' ? String(req.body.reason).slice(0, 200) : '';
      await store.logSync(`merchant_${action}`, { organizationUid: m.organization_uid, message: `${m.merchant_code}${reason ? ' ' + reason : ''}` }, nowIso);
      res.json(await merchantView(updated as CloudMerchant));
    });
  }

  // Change plan: the licence is re-derived from the new plan; status, activation and expiry carry over.
  app.post('/admin/v1/merchants/:code/plan', async (req: Request, res: Response) => {
    if (!(await requireOperator(req, res))) return;
    const m = await loadMerchant(req, res); if (!m) return;
    if (m.status === 'closed') return res.status(409).json({ error: 'a closed merchant cannot change plan' });
    const plan = typeof (req.body ?? {}).plan_id === 'string' ? await store.getPlan(req.body.plan_id) : null;
    if (!plan || !plan.is_active) return res.status(400).json({ error: 'plan_id must name an active plan' });
    const nowIso = new Date().toISOString();
    const lic = await store.getLicense(m.organization_uid);
    const next = licenceFromPlan(plan, m.organization_uid, lic?.issued_at ?? nowIso, { status: lic?.status ?? 'active', activatedAt: lic?.activated_at ?? nowIso });
    next.expires_at = lic?.expires_at ?? next.expires_at;
    await store.upsertLicense(next, nowIso);
    const updated = await store.updateMerchant(m.merchant_code, { plan_id: plan.plan_id }, nowIso);
    await store.logSync('merchant_plan_changed', { organizationUid: m.organization_uid, message: `${m.merchant_code} ${m.plan_id}->${plan.plan_id}` }, nowIso);
    res.json(await merchantView(updated as CloudMerchant));
  });

  // Renew: extend from the later of now and the current expiry, so renewing early never loses paid time.
  app.post('/admin/v1/merchants/:code/renew', async (req: Request, res: Response) => {
    if (!(await requireOperator(req, res))) return;
    const m = await loadMerchant(req, res); if (!m) return;
    const days = Number((req.body ?? {}).term_days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) return res.status(400).json({ error: 'term_days must be a whole number of days' });
    const lic = await store.getLicense(m.organization_uid);
    if (!lic || m.status === 'closed') return res.status(409).json({ error: 'nothing to renew' });
    const nowIso = new Date().toISOString();
    const base = Math.max(Date.now(), lic.expires_at ? Date.parse(lic.expires_at) : 0);
    const status = lic.status === 'expired' ? 'active' : lic.status;
    await store.upsertLicense({ ...lic, status, expires_at: new Date(base + days * 86_400_000).toISOString(), signature: null }, nowIso);
    await store.logSync('merchant_renewed', { organizationUid: m.organization_uid, message: `${m.merchant_code} +${days}d` }, nowIso);
    res.json(await merchantView(m));
  });

  app.post('/admin/v1/merchants/:code/activation-tokens', async (req: Request, res: Response) => {
    if (!(await requireOperator(req, res))) return;
    const m = await loadMerchant(req, res); if (!m) return;
    if (m.status !== 'active') return res.status(409).json({ error: `a ${m.status} merchant cannot enrol devices` });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ttlMs = Number.isFinite(Number(b.ttl_seconds)) && Number(b.ttl_seconds) > 0 ? Number(b.ttl_seconds) * 1000 : undefined;
    const { token } = await issueEnrollmentToken(store, {
      organizationUid: m.organization_uid, locationUid: typeof b.location_uid === 'string' ? b.location_uid : null,
      registerUid: typeof b.register_uid === 'string' ? b.register_uid : null, ttlMs,
    });
    await store.logSync('activation_token_issued', { organizationUid: m.organization_uid, message: m.merchant_code }, new Date().toISOString());
    res.status(201).json({ token, merchant_code: m.merchant_code });
  });

  return app;
}
