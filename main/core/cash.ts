/**
 * Cash drawer sessions, movements and denomination counting.
 *
 * Plemmo is authoritative for the cash drawer (Meridian integration). A session
 * opens with a float (optionally counted by denomination), accrues signed
 * movements (cash sales, tips, pay-ins/pay-outs, drops, no-sale opens, refunds),
 * and closes with a counted total that is reconciled against the expected total
 * to produce a variance.
 *
 * Money is in integer minor units throughout, matching main/core/money.ts and
 * the payments table. Idempotency reuses the shared `payment_idempotency` table
 * (the same "don't invent a second mechanism" rule the payment core follows).
 */
import { getDatabase, withTxn, now } from '../db';
import { ulid } from './ids';
import { recordAuditEvent } from './audit';

export type CashMovementType =
  | 'sale' | 'refund' | 'tip' | 'pay_in' | 'pay_out' | 'drop' | 'no_sale' | 'float_adjust';

/** Sign each movement type applies to the drawer balance. */
const MOVEMENT_SIGN: Record<CashMovementType, number> = {
  sale: 1, tip: 1, pay_in: 1, refund: -1, pay_out: -1, drop: -1, no_sale: 0, float_adjust: 1,
};

export class CashError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'CashError';
    this.statusCode = statusCode;
  }
}

export interface CashIdempotency {
  key: string;
  requestHash: string;
  userId: string;
}

export interface DenominationCount { [minorValue: string]: number }

export interface CashSessionRecord {
  id: string;
  location_id: string | null;
  currency: string;
  status: 'open' | 'closed';
  opening_float_minor: number;
  opening_counts: string | null;
  opened_by: string | null;
  opened_at: string;
  closing_counts: string | null;
  counted_minor: number | null;
  expected_minor: number | null;
  variance_minor: number | null;
  closed_by: string | null;
  closed_at: string | null;
  notes: string | null;
  [k: string]: unknown;
}

export interface CashMovementRecord {
  id: string;
  session_id: string;
  type: CashMovementType;
  amount_minor: number;
  currency: string;
  reason: string | null;
  reference: string | null;
  actor_user_id: string | null;
  created_at: string;
}

/** Sum a denomination map (minorValue → quantity) into total minor units. */
export function denominationTotal(counts: DenominationCount | null | undefined): number {
  if (!counts || typeof counts !== 'object') return 0;
  let total = 0;
  for (const key of Object.keys(counts)) {
    const value = Number(key);
    const qty = Number(counts[key]);
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(qty) || qty < 0) {
      throw new CashError('Denomination counts must be non-negative whole numbers');
    }
    total += Math.round(value) * qty;
  }
  return total;
}

// ── Idempotency (shared payment_idempotency table) ──────────────────────────
function checkIdempotency<T>(db: ReturnType<typeof getDatabase>, idem: CashIdempotency): { found: true; response: T } | { found: false } {
  const prior = db.prepare(
    `SELECT request_hash, response_json FROM payment_idempotency WHERE user_id = ? AND idempotency_key = ?`
  ).get(idem.userId, idem.key) as { request_hash: string; response_json: string } | undefined;
  if (!prior) return { found: false };
  if (prior.request_hash !== idem.requestHash) {
    throw new CashError('Idempotency-Key was already used for a different request', 409);
  }
  try { return { found: true, response: JSON.parse(prior.response_json) as T }; }
  catch { throw new CashError('Stored cash response is invalid', 500); }
}
function storeIdempotency(db: ReturnType<typeof getDatabase>, idem: CashIdempotency, scope: string, response: unknown): void {
  db.prepare(
    `INSERT INTO payment_idempotency (user_id, idempotency_key, bill_id, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(idem.userId, idem.key, scope, idem.requestHash, JSON.stringify(response), now());
}

// ── Reads ───────────────────────────────────────────────────────────────────
export function getOpenCashSession(locationId: string | null): CashSessionRecord | null {
  const db = getDatabase();
  const row = locationId == null
    ? db.prepare(`SELECT * FROM cash_sessions WHERE status = 'open' AND location_id IS NULL`).get()
    : db.prepare(`SELECT * FROM cash_sessions WHERE status = 'open' AND location_id = ?`).get(locationId);
  return (row as CashSessionRecord) || null;
}

export function getCashSession(id: string): CashSessionRecord | null {
  const db = getDatabase();
  return (db.prepare(`SELECT * FROM cash_sessions WHERE id = ?`).get(id) as CashSessionRecord) || null;
}

export function listCashMovements(sessionId: string): CashMovementRecord[] {
  const db = getDatabase();
  return db.prepare(`SELECT * FROM cash_movements WHERE session_id = ? ORDER BY created_at, id`).all(sessionId) as CashMovementRecord[];
}

/** Expected drawer cash = opening float + sum of signed movements. */
export function expectedCashMinor(sessionId: string): number {
  const db = getDatabase();
  const session = getCashSession(sessionId);
  if (!session) throw new CashError('Cash session not found', 404);
  const sum = db.prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS s FROM cash_movements WHERE session_id = ?`).get(sessionId) as { s: number };
  return (session.opening_float_minor || 0) + (sum.s || 0);
}

export function listCashSessions(opts: { locationId?: string | null; limit?: number } = {}): CashSessionRecord[] {
  const db = getDatabase();
  const limit = Math.min(Math.max(1, opts.limit || 50), 500);
  if (opts.locationId !== undefined) {
    return db.prepare(`SELECT * FROM cash_sessions WHERE location_id IS ? ORDER BY opened_at DESC LIMIT ?`).all(opts.locationId, limit) as CashSessionRecord[];
  }
  return db.prepare(`SELECT * FROM cash_sessions ORDER BY opened_at DESC LIMIT ?`).all(limit) as CashSessionRecord[];
}

// ── Open ──────────────────────────────────────────────────────────────────
export interface OpenCashSessionInput {
  locationId?: string | null;
  currency: string;
  userId?: string | null;
  openingFloatMinor?: number;
  openingCounts?: DenominationCount | null;
  notes?: string | null;
  idempotency?: CashIdempotency | null;
}

export function openCashSession(input: OpenCashSessionInput): CashSessionRecord {
  if (!input.currency) throw new CashError('Currency is required to open a cash session');
  const locationId = input.locationId ?? null;
  const float = input.openingCounts ? denominationTotal(input.openingCounts) : Math.round(input.openingFloatMinor || 0);
  if (!Number.isInteger(float) || float < 0) throw new CashError('Opening float must be a non-negative whole number of minor units');

  return withTxn(() => {
    const db = getDatabase();
    if (input.idempotency) {
      const prior = checkIdempotency<CashSessionRecord>(db, input.idempotency);
      if (prior.found) return prior.response;
    }
    if (getOpenCashSession(locationId)) {
      throw new CashError('A cash session is already open for this location. Close it before opening another.', 409);
    }
    const id = ulid();
    const ts = now();
    try {
      db.prepare(`
        INSERT INTO cash_sessions (id, location_id, currency, status, opening_float_minor, opening_counts, opened_by, opened_at, notes, created_at, updated_at)
        VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)
      `).run(id, locationId, input.currency, float,
        input.openingCounts ? JSON.stringify(input.openingCounts) : null,
        input.userId ?? null, ts, input.notes ?? null, ts, ts);
    } catch (e: any) {
      // Unique partial index race → another open session exists.
      if (/UNIQUE|constraint/i.test(String(e?.message))) {
        throw new CashError('A cash session is already open for this location.', 409);
      }
      throw e;
    }
    recordAuditEvent({
      type: 'cash_session.opened',
      actor: { userId: input.userId ?? null },
      entity: { type: 'cash_session', id },
      summary: `Cash session opened with float ${float} ${input.currency} minor units`,
      metadata: { location_id: locationId, opening_float_minor: float, currency: input.currency },
    });
    const session = getCashSession(id)!;
    if (input.idempotency) storeIdempotency(db, input.idempotency, id, session);
    return session;
  });
}

// ── Movement ────────────────────────────────────────────────────────────────
export interface RecordCashMovementInput {
  sessionId: string;
  type: CashMovementType;
  /** Magnitude in minor units (>=0). Sign is derived from `type`, except
   *  `float_adjust`, which accepts a signed value. `no_sale` must be 0. */
  amountMinor: number;
  reason?: string | null;
  reference?: string | null;
  actorUserId?: string | null;
  idempotency?: CashIdempotency | null;
}

export interface CashMovementResult {
  movement: CashMovementRecord;
  expectedMinor: number;
}

export function recordCashMovement(input: RecordCashMovementInput): CashMovementResult {
  const sign = MOVEMENT_SIGN[input.type];
  if (sign === undefined) throw new CashError(`Unknown cash movement type '${input.type}'`);
  const magnitude = Math.round(input.amountMinor || 0);
  if (!Number.isInteger(magnitude)) throw new CashError('Movement amount must be a whole number of minor units');
  if (input.type === 'no_sale' && magnitude !== 0) throw new CashError('A no-sale movement must have a zero amount');
  if (input.type !== 'no_sale' && input.type !== 'float_adjust' && magnitude <= 0) {
    throw new CashError('Movement amount must be a positive number of minor units');
  }
  const amount = input.type === 'float_adjust' ? magnitude : sign * Math.abs(magnitude);

  return withTxn(() => {
    const db = getDatabase();
    if (input.idempotency) {
      const prior = checkIdempotency<CashMovementResult>(db, input.idempotency);
      if (prior.found) return prior.response;
    }
    const session = getCashSession(input.sessionId);
    if (!session) throw new CashError('Cash session not found', 404);
    if (session.status !== 'open') throw new CashError('Cannot record a movement on a closed cash session', 409);

    const id = ulid();
    const ts = now();
    db.prepare(`
      INSERT INTO cash_movements (id, session_id, type, amount_minor, currency, reason, reference, actor_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.sessionId, input.type, amount, session.currency, input.reason ?? null, input.reference ?? null, input.actorUserId ?? null, ts);

    recordAuditEvent({
      type: 'cash.movement',
      actor: { userId: input.actorUserId ?? null },
      entity: { type: 'cash_movement', id },
      summary: `${input.type} of ${amount} ${session.currency} minor units on cash session ${input.sessionId}`,
      metadata: { session_id: input.sessionId, type: input.type, amount_minor: amount },
    });

    const result: CashMovementResult = { movement: getMovement(id)!, expectedMinor: expectedCashMinor(input.sessionId) };
    if (input.idempotency) storeIdempotency(db, input.idempotency, input.sessionId, result);
    return result;
  });
}

function getMovement(id: string): CashMovementRecord | null {
  return (getDatabase().prepare(`SELECT * FROM cash_movements WHERE id = ?`).get(id) as CashMovementRecord) || null;
}

/**
 * Record the drawer impact of a captured payment. Called from the payment path
 * so the drawer stays authoritative without the frontend being the source.
 * Only cash payments move the drawer; a cash tip moves it too. Card/other
 * adapters are a no-op. Best-effort: never blocks a payment.
 */
export function recordCashSaleForPayment(args: {
  locationId: string | null; adapter: string; amountMinor: number; tipMinor?: number;
  actorUserId?: string | null; reference?: string | null;
}): void {
  if (args.adapter !== 'cash') return;
  const session = getOpenCashSession(args.locationId);
  if (!session) return; // No open drawer — nothing to reconcile against.
  const db = getDatabase();
  const insert = db.prepare(`
    INSERT INTO cash_movements (id, session_id, type, amount_minor, currency, reason, reference, actor_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  if (args.amountMinor > 0) {
    insert.run(ulid(), session.id, 'sale', Math.round(args.amountMinor), session.currency, null, args.reference ?? null, args.actorUserId ?? null, now());
  }
  if (args.tipMinor && args.tipMinor > 0) {
    insert.run(ulid(), session.id, 'tip', Math.round(args.tipMinor), session.currency, null, args.reference ?? null, args.actorUserId ?? null, now());
  }
}

// ── Close ───────────────────────────────────────────────────────────────────
export interface CloseCashSessionInput {
  sessionId: string;
  countedMinor?: number;
  closingCounts?: DenominationCount | null;
  closedBy?: string | null;
  notes?: string | null;
  idempotency?: CashIdempotency | null;
}

export interface CloseCashSessionResult {
  session: CashSessionRecord;
  expectedMinor: number;
  countedMinor: number;
  varianceMinor: number;
}

export function closeCashSession(input: CloseCashSessionInput): CloseCashSessionResult {
  return withTxn(() => {
    const db = getDatabase();
    if (input.idempotency) {
      const prior = checkIdempotency<CloseCashSessionResult>(db, input.idempotency);
      if (prior.found) return prior.response;
    }
    const session = getCashSession(input.sessionId);
    if (!session) throw new CashError('Cash session not found', 404);
    if (session.status !== 'open') throw new CashError('Cash session is already closed', 409);

    const counted = input.closingCounts ? denominationTotal(input.closingCounts)
      : (input.countedMinor != null ? Math.round(input.countedMinor) : null);
    if (counted == null) throw new CashError('A counted amount or denomination counts are required to close a session');
    if (!Number.isInteger(counted) || counted < 0) throw new CashError('Counted amount must be a non-negative whole number of minor units');

    const expected = expectedCashMinor(input.sessionId);
    const variance = counted - expected;
    const ts = now();
    db.prepare(`
      UPDATE cash_sessions SET status = 'closed', closing_counts = ?, counted_minor = ?, expected_minor = ?, variance_minor = ?,
        closed_by = ?, closed_at = ?, notes = COALESCE(?, notes), updated_at = ? WHERE id = ?
    `).run(input.closingCounts ? JSON.stringify(input.closingCounts) : null, counted, expected, variance,
      input.closedBy ?? null, ts, input.notes ?? null, ts, input.sessionId);

    recordAuditEvent({
      type: 'cash_session.closed',
      actor: { userId: input.closedBy ?? null },
      entity: { type: 'cash_session', id: input.sessionId },
      summary: `Cash session closed. Expected ${expected}, counted ${counted}, variance ${variance} ${session.currency} minor units`,
      metadata: { session_id: input.sessionId, expected_minor: expected, counted_minor: counted, variance_minor: variance },
    });

    const result: CloseCashSessionResult = { session: getCashSession(input.sessionId)!, expectedMinor: expected, countedMinor: counted, varianceMinor: variance };
    if (input.idempotency) storeIdempotency(db, input.idempotency, input.sessionId, result);
    return result;
  });
}
