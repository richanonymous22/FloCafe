/**
 * Staff shifts / timeclock (Meridian integration). Authoritative clock in/out
 * records: at most one open shift per user, with worked-hours reporting.
 * Audited; safe on multi-device via the one-open-shift-per-user index.
 */
import { getDatabase, withTxn, now } from '../db';
import { ulid } from './ids';
import { recordAuditEvent } from './audit';

export class ShiftError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) { super(message); this.name = 'ShiftError'; this.statusCode = statusCode; }
}

export interface ShiftRecord {
  id: string;
  user_id: string;
  location_id: string | null;
  clock_in: string;
  clock_out: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export function getOpenShift(userId: string): ShiftRecord | null {
  return (getDatabase().prepare(`SELECT * FROM staff_shifts WHERE user_id = ? AND clock_out IS NULL`).get(userId) as ShiftRecord) || null;
}

export function isOnShift(userId: string): boolean { return !!getOpenShift(userId); }

export function clockIn(input: { userId: string; locationId?: string | null; note?: string | null }): ShiftRecord {
  if (!input.userId) throw new ShiftError('userId is required');
  return withTxn(() => {
    const db = getDatabase();
    if (getOpenShift(input.userId)) throw new ShiftError('You are already clocked in', 409);
    const id = ulid();
    const ts = now();
    try {
      db.prepare(`INSERT INTO staff_shifts (id, user_id, location_id, clock_in, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.userId, input.locationId ?? null, ts, input.note ?? null, ts, ts);
    } catch (e: any) {
      if (/UNIQUE|constraint/i.test(String(e?.message))) throw new ShiftError('You are already clocked in', 409);
      throw e;
    }
    recordAuditEvent({ type: 'employee.updated', actor: { userId: input.userId }, entity: { type: 'staff_shift', id },
      summary: `Clocked in`, metadata: { user_id: input.userId, shift_id: id } });
    return getShift(id)!;
  });
}

export function clockOut(input: { userId: string; note?: string | null }): ShiftRecord {
  return withTxn(() => {
    const db = getDatabase();
    const open = getOpenShift(input.userId);
    if (!open) throw new ShiftError('You are not clocked in', 409);
    const ts = now();
    db.prepare(`UPDATE staff_shifts SET clock_out = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?`)
      .run(ts, input.note ?? null, ts, open.id);
    recordAuditEvent({ type: 'employee.updated', actor: { userId: input.userId }, entity: { type: 'staff_shift', id: open.id },
      summary: `Clocked out`, metadata: { user_id: input.userId, shift_id: open.id } });
    return getShift(open.id)!;
  });
}

export function getShift(id: string): ShiftRecord | null {
  return (getDatabase().prepare(`SELECT * FROM staff_shifts WHERE id = ?`).get(id) as ShiftRecord) || null;
}

export function listShifts(opts: { userId?: string; from?: string; to?: string; limit?: number } = {}): ShiftRecord[] {
  const db = getDatabase();
  const clauses: string[] = [];
  const params: any[] = [];
  if (opts.userId) { clauses.push('user_id = ?'); params.push(opts.userId); }
  if (opts.from) { clauses.push('clock_in >= ?'); params.push(opts.from); }
  if (opts.to) { clauses.push('clock_in <= ?'); params.push(opts.to); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(1, opts.limit || 200), 1000);
  return db.prepare(`SELECT * FROM staff_shifts ${where} ORDER BY clock_in DESC LIMIT ?`).all(...params, limit) as ShiftRecord[];
}

/** Total worked hours for a user in a window (open shifts counted up to now). */
export function hoursWorked(userId: string, fromIso: string, toIso: string): number {
  const shifts = listShifts({ userId, limit: 1000 }).filter((s) => s.clock_in <= toIso && (s.clock_out || now()) >= fromIso);
  const from = Date.parse(fromIso), to = Date.parse(toIso);
  let ms = 0;
  for (const s of shifts) {
    const start = Math.max(from, Date.parse(s.clock_in));
    const end = Math.min(to, Date.parse(s.clock_out || now()));
    if (end > start) ms += end - start;
  }
  return ms / 3_600_000;
}
