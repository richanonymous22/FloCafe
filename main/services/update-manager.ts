/**
 * Update manager — installs a downloaded update only when it is safe to restart the till.
 *
 * Downloading is automatic and harmless. INSTALLING restarts the application, so it is gated:
 *
 *   never while a sale is in flight   a payment being taken or taken in the last two minutes, or an order
 *                                     opened or changed in the last ten minutes that is not finished
 *   never without a safety copy       the database is backed up and the copy checked before the restart
 *   always on the record              start, version and result are kept (and audited), and on the next start
 *                                     the new version checks the database before it says "ok"
 *
 * Modes: "ask" (default — nothing installs until someone presses Install, and the screen shows what blocks
 * it), "quiet_hours" (installs by itself inside the shop's quiet window, staggered per till so a shop's tills
 * never restart together, and only when NOTHING is open), "manual" (never prompts or installs on its own).
 * "Remind me later" defers prompts and automatic installs.
 *
 * Rolling back: every install keeps its pre-update backup (named in the history). To go back, restore that
 * backup with the database tools and install the previous version's installer; the history says which backup.
 */
import { createBackup, getDatabase, getSettingValue, now } from '../db';
import { recordAuditEvent } from '../core/audit';
import { DEFAULT_TIMEZONE } from '../core/defaults';
import { resolveDeviceId } from '../core/sync/outbox';

export interface UpdaterPort { checkForUpdates(): Promise<unknown>; quitAndInstall(): void }
export type UpdateMode = 'ask' | 'quiet_hours' | 'manual';
export interface UpdateSettings { mode: UpdateMode; window_start_hour: number; window_end_hour: number; deferred_until: string | null }
export interface UpdateHistoryEntry { at: string; from: string; to: string; backup: string | null; automatic: boolean; status: 'installing' | 'ok' | 'failed'; note?: string }
export interface UpdateState { current: string; available: string | null; downloaded: string | null; checking: boolean; last_checked_at: string | null; last_error: string | null }

export class UpdateError extends Error {
  constructor(message: string, readonly statusCode = 409, readonly code = 'update_blocked', readonly reasons: string[] = []) { super(message); this.name = 'UpdateError'; }
}

let port: UpdaterPort | null = null;
const state: UpdateState = { current: '0.0.0', available: null, downloaded: null, checking: false, last_checked_at: null, last_error: null };
let installing = false;

export function attachUpdater(p: UpdaterPort, currentVersion: string): void { port = p; state.current = currentVersion; }
export function detachUpdater(): void { port = null; installing = false; Object.assign(state, { available: null, downloaded: null, checking: false, last_checked_at: null, last_error: null }); }

/** Fed by the updater's events (main/index.ts wires them). */
export function noteUpdaterEvent(kind: 'checking' | 'available' | 'not-available' | 'downloaded' | 'error', info?: { version?: string; message?: string }): void {
  if (kind === 'checking') { state.checking = true; return; }
  state.checking = false; state.last_checked_at = now();
  if (kind === 'available') { state.available = info?.version ?? null; state.last_error = null; }
  else if (kind === 'downloaded') { state.available = info?.version ?? state.available; state.downloaded = info?.version ?? null; state.last_error = null; }
  else if (kind === 'not-available') { state.available = null; state.last_error = null; }
  else state.last_error = info?.message ?? 'The update check failed';
}

export function getUpdateState(): UpdateState { return { ...state }; }

/* ── settings ───────────────────────────────────────────────────────────── */

function setSetting(key: string, value: string | null): void {
  const db = getDatabase();
  if (value === null) { db.prepare('DELETE FROM settings WHERE key = ?').run(key); return; }
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, now());
}
const hour = (v: string | null, dflt: number) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 23 ? n : dflt; };

export function getUpdateSettings(): UpdateSettings {
  const mode = getSettingValue('update_mode');
  return {
    mode: mode === 'quiet_hours' || mode === 'manual' ? mode : 'ask',
    window_start_hour: hour(getSettingValue('update_window_start'), 3),
    window_end_hour: hour(getSettingValue('update_window_end'), 5),
    deferred_until: getSettingValue('update_deferred_until'),
  };
}

export function setUpdateSettings(patch: Partial<Pick<UpdateSettings, 'mode' | 'window_start_hour' | 'window_end_hour'>>): UpdateSettings {
  if (patch.mode !== undefined) {
    if (!['ask', 'quiet_hours', 'manual'].includes(patch.mode)) throw new UpdateError('mode must be ask, quiet_hours or manual', 400, 'bad_mode');
    setSetting('update_mode', patch.mode);
  }
  for (const [k, key] of [['window_start_hour', 'update_window_start'], ['window_end_hour', 'update_window_end']] as const) {
    const v = patch[k];
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < 0 || v > 23) throw new UpdateError(`${k} must be a whole hour from 0 to 23`, 400, 'bad_hour');
    setSetting(key, String(v));
  }
  return getUpdateSettings();
}

/** "Remind me later": no prompt and no automatic install until then. Minutes, capped at a week. */
export function deferUpdate(minutes: number, nowMs = Date.now()): UpdateSettings {
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 7 * 24 * 60) throw new UpdateError('defer for between 1 minute and 7 days', 400, 'bad_defer');
  setSetting('update_deferred_until', new Date(nowMs + minutes * 60_000).toISOString());
  return getUpdateSettings();
}

/* ── is it safe to restart? ─────────────────────────────────────────────── */

const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/** Plain-language reasons the till must not restart right now (empty = safe). `strict` also counts every unfinished order. */
export function installBlockers(opts: { strict?: boolean; nowMs?: number } = {}): string[] {
  const t = opts.nowMs ?? Date.now();
  const db = getDatabase();
  const reasons: string[] = [];
  const inFlight = (db.prepare("SELECT COUNT(*) AS n FROM payments WHERE state IN ('requested', 'authorized') AND requested_at >= ?").get(new Date(t - 30 * 60_000).toISOString()) as { n: number }).n;
  if (inFlight > 0) reasons.push(`${inFlight} payment${inFlight === 1 ? ' is' : 's are'} still being taken`);
  const justTaken = (db.prepare("SELECT COUNT(*) AS n FROM payments WHERE requested_at >= ? AND requested_at <= ?").get(new Date(t - 2 * 60_000).toISOString(), new Date(t + 60_000).toISOString()) as { n: number }).n;
  if (justTaken > 0 && inFlight === 0) reasons.push('a payment was taken in the last two minutes');
  const since = opts.strict ? '1970-01-01 00:00:00' : sqlTime(t - 10 * 60_000);
  const open = (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status NOT IN ('completed', 'cancelled') AND COALESCE(updated_at, created_at) >= ?").get(since) as { n: number }).n;
  if (open > 0) reasons.push(opts.strict ? `${open} order${open === 1 ? ' is' : 's are'} still open` : `${open} order${open === 1 ? ' was' : 's were'} opened or changed in the last ten minutes and not finished`);
  return reasons;
}

export function canInstallNow(nowMs = Date.now()): { allowed: boolean; reasons: string[] } {
  if (!state.downloaded) return { allowed: false, reasons: [state.available ? 'the update is still downloading' : 'there is no update to install'] };
  if (installing) return { allowed: false, reasons: ['an update is already being installed'] };
  const reasons = installBlockers({ nowMs });
  return { allowed: reasons.length === 0, reasons };
}

/* ── installing ─────────────────────────────────────────────────────────── */

function history(): UpdateHistoryEntry[] {
  try { const h = JSON.parse(getSettingValue('update_history') || '[]'); return Array.isArray(h) ? h : []; } catch { return []; }
}
function saveHistory(h: UpdateHistoryEntry[]): void { setSetting('update_history', JSON.stringify(h.slice(-20))); }
export function getUpdateHistory(): UpdateHistoryEntry[] { return history().slice().reverse(); }

function verifyBackup(file: string): void {
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const copy = new Database(file, { readonly: true });
  try {
    const r = copy.pragma('integrity_check', { simple: true });
    if (r !== 'ok') throw new Error(`the backup failed its integrity check (${String(r)})`);
  } finally { copy.close(); }
}

export async function installNow(opts: { actorUserId?: string | null; automatic?: boolean; nowMs?: number } = {}): Promise<{ to: string; backup: string }> {
  const can = canInstallNow(opts.nowMs);
  if (!can.allowed) throw new UpdateError(`The update cannot be installed right now: ${can.reasons.join('; ')}.`, 409, 'update_blocked', can.reasons);
  if (!port) throw new UpdateError('Updates are not available in this build.', 409, 'no_updater');
  installing = true;
  try {
    let backup: string;
    try {
      backup = (await createBackup()).path;
      verifyBackup(backup);
    } catch (e) {
      throw new UpdateError(`The update was not installed because the safety backup could not be made: ${(e as Error).message}`, 500, 'backup_failed');
    }
    const to = state.downloaded as string;
    const entry: UpdateHistoryEntry = { at: now(), from: state.current, to, backup, automatic: !!opts.automatic, status: 'installing' };
    saveHistory([...history(), entry]);
    recordAuditEvent({ type: 'system.update_started', actor: { userId: opts.actorUserId ?? null }, entity: { type: 'application', id: to }, summary: `Update ${state.current} → ${to} started${opts.automatic ? ' (automatic, quiet hours)' : ''}`, metadata: { from: state.current, to, backup, automatic: !!opts.automatic } });
    port.quitAndInstall();
    return { to, backup };
  } catch (e) {
    installing = false;
    throw e;
  }
}

/**
 * On every start: if the last history entry was an install in progress, say how it ended. The new version must
 * be running AND the database must pass its integrity and foreign-key checks to be "ok".
 */
export function finalizeUpdateOnBoot(currentVersion: string): UpdateHistoryEntry | null {
  const h = history();
  const last = h[h.length - 1];
  if (!last || last.status !== 'installing') return null;
  const db = getDatabase();
  let status: UpdateHistoryEntry['status'] = 'ok';
  let note: string | undefined;
  if (currentVersion !== last.to) { status = 'failed'; note = `the installer did not complete (still on ${currentVersion})`; }
  else {
    const integrity = db.pragma('integrity_check', { simple: true });
    const fk = db.pragma('foreign_key_check') as unknown[];
    if (integrity !== 'ok' || fk.length > 0) { status = 'failed'; note = `the database check after the update failed (${integrity !== 'ok' ? String(integrity) : fk.length + ' foreign-key problems'}); restore ${last.backup} and reinstall ${last.from}`; }
  }
  last.status = status; if (note) last.note = note;
  saveHistory(h);
  recordAuditEvent({ type: status === 'ok' ? 'system.update_verified' : 'system.update_failed', actor: { userId: null }, entity: { type: 'application', id: last.to }, summary: `Update ${last.from} → ${last.to}: ${status}${note ? ' — ' + note : ''}`, metadata: { ...last } });
  return last;
}

/* ── quiet hours ────────────────────────────────────────────────────────── */

/** Minutes this till waits after the window opens, derived from its id, so a shop's tills never restart together. */
export function staggerMinutes(deviceId: string): number {
  let h = 0;
  for (const ch of deviceId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 45;
}

function localMinutes(nowMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(nowMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return get('hour') * 60 + get('minute');
}

export function inQuietWindow(settings: UpdateSettings, deviceId: string, nowMs = Date.now()): boolean {
  let tz = getSettingValue('timezone') || DEFAULT_TIMEZONE;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); } catch { tz = DEFAULT_TIMEZONE; }
  const m = localMinutes(nowMs, tz);
  const start = settings.window_start_hour * 60 + staggerMinutes(deviceId);
  const end = settings.window_end_hour * 60;
  return start <= end ? m >= start && m < end : m >= start || m < end;
}

/** One scheduler tick. Installs only in quiet_hours mode, inside the window, not deferred, with NOTHING open. */
export async function autoInstallTick(nowMs = Date.now()): Promise<boolean> {
  const s = getUpdateSettings();
  if (s.mode !== 'quiet_hours' || !state.downloaded || installing) return false;
  if (s.deferred_until && Date.parse(s.deferred_until) > nowMs) return false;
  if (!inQuietWindow(s, resolveDeviceId(getDatabase()), nowMs)) return false;
  if (installBlockers({ strict: true, nowMs }).length > 0) return false;
  try { await installNow({ automatic: true, nowMs }); return true; } catch { return false; }
}

let timer: NodeJS.Timeout | null = null;
export function startUpdateScheduler(): void {
  if (timer) return;
  timer = setInterval(() => { void autoInstallTick().catch(() => undefined); }, 60_000);
  timer.unref?.();
}
export function stopUpdateScheduler(): void { if (timer) { clearInterval(timer); timer = null; } }

export function updateStatusBody(nowMs = Date.now()) {
  const s = getUpdateSettings();
  const can = canInstallNow(nowMs);
  return {
    ...state, settings: s, can_install_now: can.allowed, blockers: can.allowed ? [] : can.reasons,
    deferred: !!(s.deferred_until && Date.parse(s.deferred_until) > nowMs), history: getUpdateHistory(),
    store_managed: false,
  };
}

export async function checkNow(): Promise<void> {
  if (!port) throw new UpdateError('Updates are not available in this build.', 409, 'no_updater');
  noteUpdaterEvent('checking');
  try { await port.checkForUpdates(); } catch (e) { noteUpdaterEvent('error', { message: (e as Error).message }); }
}
