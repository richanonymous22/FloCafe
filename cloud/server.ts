/**
 * Plemmo Cloud — the sync HTTP API (SYNC-B).
 *
 * A real Express service exposing the provider-neutral sync protocol for
 * inventory movements only:
 *   POST /sync/v1/upload   — a device uploads a batch of movement events
 *   GET  /sync/v1/pull      — a device pulls movement events it is entitled to
 *   POST /sync/v1/dev/enroll — DEV/TEST ONLY device registration (see below)
 *
 * The concrete backend is `CloudStore` (SQLite in dev). No Supabase/Vercel/
 * Postgres logic lives in the local client — it speaks only this protocol.
 *
 * Security posture (Part F/R): every /upload and /pull request is
 * authenticated by device signature; organization and location are resolved
 * from the device registry, never trusted from the payload. Body size is
 * capped; rejected/auth-failed attempts are logged.
 */

import express, { Express, Request, Response } from 'express';
import { CloudStore, CloudInventoryMovement } from './store';
import { authenticateDevice, DeviceAuthError, SignedRequestFields } from './auth';

const MAX_BATCH = 500;
const BODY_LIMIT = '1mb';

interface UploadEvent {
  uid: string;                 // outbox event uid
  device_id: string;
  sequence: number;
  entity_type: string;
  entity_uid: string;          // the movement uid (business fact)
  organization_id: string | null;
  location_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
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

export interface CreateCloudServerOptions {
  /** Enables POST /sync/v1/dev/enroll. DEV/TEST ONLY — must be false in production. */
  enableDevEnroll?: boolean;
}

export function createCloudServer(store: CloudStore, options: CreateCloudServerOptions = {}): Express {
  const app = express();
  app.use(express.json({
    limit: BODY_LIMIT,
    verify: (req, _res, buf) => { (req as unknown as { rawBody: string }).rawBody = buf.toString('utf8'); },
  }));

  // ── DEV/TEST ONLY device enrollment ──────────────────────────────────────
  // Registers a device's PUBLIC key + org/location. In production this is
  // replaced by the real merchant/admin enrollment flow (out of scope here);
  // this endpoint is gated off unless explicitly enabled and must never be
  // exposed in a production deployment.
  if (options.enableDevEnroll) {
    app.post('/sync/v1/dev/enroll', (req: Request, res: Response) => {
      const { device_uid, organization_uid, location_uid, public_key } = req.body ?? {};
      if (!device_uid || !organization_uid || !public_key) {
        return res.status(400).json({ error: 'device_uid, organization_uid and public_key are required' });
      }
      store.registerDevice({ device_uid, organization_uid, location_uid: location_uid ?? null, public_key, status: 'active' });
      res.status(201).json({ enrolled: true, device_uid });
    });
  }

  app.post('/sync/v1/upload', (req: Request, res: Response) => {
    let auth;
    try {
      auth = authenticateDevice(store, signedFields(req));
    } catch (error) {
      const reason = error instanceof DeviceAuthError ? error.reason : 'error';
      store.logSync('auth_failure', { deviceUid: req.header('x-plemmo-device'), message: reason }, new Date().toISOString());
      return res.status(401).json({ error: 'unauthenticated', reason });
    }
    const device = auth.device;

    const events: UploadEvent[] = Array.isArray(req.body?.events) ? req.body.events : [];
    if (events.length === 0) return res.json({ accepted: [], duplicate: [], rejected: [] });
    if (events.length > MAX_BATCH) return res.status(413).json({ error: `batch exceeds ${MAX_BATCH} events` });

    const accepted: string[] = [];
    const duplicate: string[] = [];
    const rejected: Array<{ uid: string; reason: string; category: string }> = [];
    const receivedAt = new Date().toISOString();

    for (const ev of events) {
      // PERMANENT rejections: malformed / wrong entity / not this device's fact.
      if (ev.entity_type !== 'inventory_movement') {
        rejected.push({ uid: ev.uid, reason: 'unsupported entity_type', category: 'permanent' });
        continue;
      }
      const p = ev.payload as Record<string, unknown>;
      if (!ev.uid || !ev.entity_uid || !p || typeof p.quantity_delta !== 'number' || !p.product_id || !p.movement_type) {
        rejected.push({ uid: ev.uid, reason: 'malformed event', category: 'permanent' });
        continue;
      }
      // AUTH/ISOLATION rejections (Part F): the fact must belong to THIS
      // device's organization (resolved server-side), and to the device's
      // location when the device is location-bound. Client-claimed
      // organization_id/location_id are validated against the device
      // identity, never trusted to override it.
      const eventOrg = (p.organization_id as string | null) ?? ev.organization_id ?? null;
      if (eventOrg !== null && eventOrg !== device.organization_uid) {
        rejected.push({ uid: ev.uid, reason: 'organization mismatch', category: 'auth' });
        store.logSync('rejected', { deviceUid: device.device_uid, organizationUid: device.organization_uid, message: 'organization mismatch' }, receivedAt);
        continue;
      }
      const eventLoc = (p.location_id as string | null) ?? ev.location_id ?? null;
      if (device.location_uid && eventLoc !== null && eventLoc !== device.location_uid) {
        rejected.push({ uid: ev.uid, reason: 'location mismatch', category: 'auth' });
        store.logSync('rejected', { deviceUid: device.device_uid, organizationUid: device.organization_uid, message: 'location mismatch' }, receivedAt);
        continue;
      }

      const movement: CloudInventoryMovement = {
        event_uid: ev.uid,
        movement_uid: ev.entity_uid,
        organization_uid: device.organization_uid, // authoritative: from the device, not the payload
        location_uid: eventLoc,
        device_uid: device.device_uid,
        device_sequence: ev.sequence,
        movement_type: String(p.movement_type),
        product_uid: String(p.product_id),
        variant_uid: (p.product_variant_id as string | null) ?? null,
        quantity_delta: p.quantity_delta as number,
        unit_cost: (p.unit_cost as number | null) ?? null,
        reason: (p.reason as string | null) ?? null,
        reference_type: (p.reference_type as string | null) ?? null,
        reference_uid: (p.reference_id as string | null) ?? null,
        actor_uid: (p.actor_user_id as string | null) ?? null,
        metadata: p.metadata != null ? JSON.stringify(p.metadata) : null,
        created_at: String(p.created_at ?? ev.created_at),
      };
      const result = store.storeMovement(movement, receivedAt);
      if (result === 'duplicate') { duplicate.push(ev.uid); store.logSync('duplicate', { deviceUid: device.device_uid, organizationUid: device.organization_uid }, receivedAt); }
      else { accepted.push(ev.uid); store.logSync('accepted', { deviceUid: device.device_uid, organizationUid: device.organization_uid }, receivedAt); }
    }

    res.json({ accepted, duplicate, rejected });
  });

  app.get('/sync/v1/pull', (req: Request, res: Response) => {
    let auth;
    try {
      auth = authenticateDevice(store, signedFields(req));
    } catch (error) {
      const reason = error instanceof DeviceAuthError ? error.reason : 'error';
      store.logSync('auth_failure', { deviceUid: req.header('x-plemmo-device'), message: reason }, new Date().toISOString());
      return res.status(401).json({ error: 'unauthenticated', reason });
    }
    const device = auth.device;
    const cursor = Number(req.query.cursor ?? 0) || 0;
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, MAX_BATCH);

    // Organization isolation (Part F/I): a device only ever receives its OWN
    // organization's events, and never its own uploads back (SYNC-B
    // simplification — a device already has its own movements locally).
    const events = store.pullMovements(device.organization_uid, cursor, limit, device.device_uid);
    const nextCursor = events.length > 0 ? events[events.length - 1].feed_seq : cursor;
    res.json({
      events: events.map((e) => ({
        event_uid: e.event_uid,
        entity_uid: e.movement_uid,
        feed_seq: e.feed_seq,
        payload: {
          schema_version: 1,
          movement_uid: e.movement_uid,
          organization_id: e.organization_uid,
          location_id: e.location_uid,
          product_id: e.product_uid,
          product_variant_id: e.variant_uid,
          quantity_delta: e.quantity_delta,
          movement_type: e.movement_type,
          reason: e.reason,
          reference_type: e.reference_type,
          reference_id: e.reference_uid,
          unit_cost: e.unit_cost,
          actor_user_id: e.actor_uid,
          metadata: e.metadata ? JSON.parse(e.metadata) : null,
          created_at: e.created_at,
        },
      })),
      next_cursor: nextCursor,
      has_more: events.length === limit,
    });
  });

  return app;
}
