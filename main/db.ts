import Database from 'better-sqlite3';
import type { Request, Response, NextFunction } from 'express';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import * as fs from 'fs';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { BUNDLED_COUNTRY_PACKS, bundledPackVersionId } from './tax-packs/bundled';
import { ulid } from './core/ids';

let db: Database.Database;
let dbHealthError: string | null = null;

// Database backup, restore, and wipe operations must not overlap. The lock is
// a FIFO promise chain so a rejected operation cannot strand later work.
let databaseMaintenanceTail: Promise<void> = Promise.resolve();
let databaseMaintenanceActive = false;
let activeDatabaseRequests = 0;
let maintenanceRequestWaiters: (() => void)[] = [];
let maintenanceDrainWaiters: (() => void)[] = [];
const databaseMaintenanceStartListeners = new Set<() => void>();
const databaseMaintenanceEndListeners = new Set<() => void>();

function releaseMaintenanceDrainWaiters(): void {
  if (activeDatabaseRequests !== 0) return;
  const waiters = maintenanceDrainWaiters;
  maintenanceDrainWaiters = [];
  waiters.forEach((resolve) => resolve());
}

function releaseMaintenanceRequestWaiters(): void {
  if (activeDatabaseRequests !== 0 || databaseMaintenanceActive) return;
  const waiters = maintenanceRequestWaiters;
  maintenanceRequestWaiters = [];
  waiters.forEach((resolve) => resolve());
}

export function withDatabaseRequest<T>(operation: () => T | Promise<T>): Promise<T> {
  const run = (): Promise<T> => {
    // Reserve the request synchronously. A maintenance lock scheduled in the
    // same turn must observe this request before it starts replacing the DB.
    activeDatabaseRequests += 1;
    return Promise.resolve().then(operation).finally(() => {
      activeDatabaseRequests = Math.max(0, activeDatabaseRequests - 1);
      releaseMaintenanceDrainWaiters();
      releaseMaintenanceRequestWaiters();
    });
  };
  if (!databaseMaintenanceActive) return run();
  return new Promise<T>((resolve, reject) => {
    maintenanceRequestWaiters.push(() => { run().then(resolve, reject); });
  });
}

export function registerDatabaseMaintenanceStartListener(listener: () => void): () => void {
  databaseMaintenanceStartListeners.add(listener);
  return () => databaseMaintenanceStartListeners.delete(listener);
}

export function registerDatabaseMaintenanceEndListener(listener: () => void): () => void {
  databaseMaintenanceEndListeners.add(listener);
  return () => databaseMaintenanceEndListeners.delete(listener);
}

export function isDatabaseMaintenanceActive(): boolean {
  return databaseMaintenanceActive;
}

const DATABASE_MAINTENANCE_ROUTES = new Set([
  'POST /api/db/import',
  'POST /api/db/backup',
  'GET /api/db/download',
  'POST /api/db-tools/initialize',
]);

function isDatabaseMaintenanceRoute(req: Request): boolean {
  return DATABASE_MAINTENANCE_ROUTES.has(`${req.method} ${req.path}`);
}

export function databaseMaintenanceMiddleware(req: Request, res: Response, next: NextFunction): void {
  // A later request must still be rejected here, before authentication or
  // route middleware can query a database handle that the active operation may
  // close and replace.
  if (databaseMaintenanceActive) {
    res.status(503).json({ error: 'Database maintenance in progress' });
    return;
  }

  // These handlers acquire the FIFO lock themselves. Do not count the lock
  // owner as an active database request: its response cannot finish until the
  // handler returns, so counting it would make the handler wait for itself.
  if (isDatabaseMaintenanceRoute(req)) {
    next();
    return;
  }

  activeDatabaseRequests += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeDatabaseRequests = Math.max(0, activeDatabaseRequests - 1);
    releaseMaintenanceDrainWaiters();
    releaseMaintenanceRequestWaiters();
  };
  res.once('finish', release);
  res.once('close', release);
  next();
}

export function withDatabaseMaintenanceLock<T>(operation: () => T | Promise<T>): Promise<T> {
  const previous = databaseMaintenanceTail;
  let release!: () => void;
  databaseMaintenanceTail = new Promise<void>((resolve) => { release = resolve; });
  return previous.then(async () => {
    databaseMaintenanceActive = true;
    for (const listener of databaseMaintenanceStartListeners) {
      try { listener(); } catch (error) { console.error('[DB] Maintenance listener failed:', error); }
    }
    // Maintenance routes are excluded from activeDatabaseRequests by the
    // middleware above. Any remaining active requests were already in flight
    // before maintenance began and must drain first.
    if (activeDatabaseRequests > 0) {
      await new Promise<void>((resolve) => maintenanceDrainWaiters.push(resolve));
    }
    try {
      return await operation();
    } finally {
      databaseMaintenanceActive = false;
      for (const listener of databaseMaintenanceEndListeners) {
        try { listener(); } catch (error) { console.error('[DB] Maintenance end listener failed:', error); }
      }
      releaseMaintenanceRequestWaiters();
    }
  }).finally(release);
}

const DEFAULT_CLOUD_SERVER_URL = 'https://blue.flopos.com/';

function randomSecret(): string {
  return crypto.randomBytes(32).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function getSettingValue(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function upsertSettings(entries: Record<string, string | undefined | null>): void {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  for (const [key, val] of Object.entries(entries)) {
    if (val !== undefined) stmt.run(key, val ?? '', now());
  }
}

function upsertSetting(key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now());
}

function insertSettingIfMissing(key: string, value: string): void {
  db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, now());
}

export function getDbHealth(): { ok: boolean; error?: string } {
  if (!db) return { ok: false, error: 'Database not initialized' };
  if (dbHealthError) return { ok: false, error: dbHealthError };
  return { ok: true };
}

export function getDbPath(): string {
  const userDataPath = app.isPackaged ? app.getPath('userData') : path.join(__dirname, '../');
  return path.join(userDataPath, 'flo.db');
}

function getBackupDir(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'backups');
}

type ReplacementJournal = {
  phase: 'prepared' | 'committed';
  recoveryPath: string;
  dbPath: string;
  baselineForeignKeyViolations?: string[];
};

function syncFile(filePath: string): void {
  // Windows does not allow fsync on a read-only file handle (it reports
  // EPERM). All callers pass application-owned database, journal, or backup
  // files, so use a writable handle for portable durability flushing.
  const fd = fs.openSync(filePath, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeReplacementJournal(journalPath: string, journal: ReplacementJournal): void {
  const tempPath = `${journalPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(journal), { encoding: 'utf8', mode: 0o600 });
  syncFile(tempPath);
  fs.renameSync(tempPath, journalPath);
  if (!syncDirectory(path.dirname(journalPath)) && process.platform !== 'win32') {
    throw new Error('Could not durably record database replacement journal');
  }
}

function isLiveDatabaseTarget(candidatePath: string, dbPath: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value;
  if (normalize(path.resolve(candidatePath)) === normalize(path.resolve(dbPath))) return true;
  try {
    const candidateStat = fs.statSync(candidatePath);
    const dbStat = fs.statSync(dbPath);
    if (candidateStat.dev === dbStat.dev && candidateStat.ino === dbStat.ino) return true;
  } catch { }
  try {
    const candidateReal = path.join(fs.realpathSync(path.dirname(candidatePath)), path.basename(candidatePath));
    return normalize(candidateReal) === normalize(fs.realpathSync(dbPath));
  } catch {
    return false;
  }
}

function pathEntryExists(filePath: string): boolean {
  try { fs.lstatSync(filePath); return true; } catch { return false; }
}

function syncDirectory(directoryPath: string): boolean {
  try {
    const fd = fs.openSync(directoryPath, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return true;
  } catch {
    // Directory fsync is unavailable on some Windows filesystems.
    return false;
  }
}

function removeReplacementArtifacts(journalPath: string, recoveryPath: string): void {
  for (const filePath of [journalPath, `${journalPath}.tmp`, recoveryPath, `${recoveryPath}-wal`, `${recoveryPath}-shm`]) {
    try { if (pathEntryExists(filePath)) fs.unlinkSync(filePath); } catch { }
  }
  syncDirectory(path.dirname(journalPath));
}

let recoverySchemaReference: Map<string, string[]> | null = null;
let buildingIdealSchema = false;

function getRecoverySchemaReference(): Map<string, string[]> {
  if (recoverySchemaReference) return recoverySchemaReference;
  const idealDb = buildIdealSchemaDb();
  try {
    recoverySchemaReference = new Map(getTables(idealDb).map((table) => [table, getColumns(idealDb, table)]));
    return recoverySchemaReference;
  } finally {
    idealDb.close();
  }
}

function normalizedSchemaDefinitions(dbInstance: Database.Database): Map<string, string> {
  const definitions = dbInstance.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> '_flo_meta'
  `).all() as { type: string; name: string; tbl_name: string; sql: string }[];
  return new Map(definitions.map((row) => [
    `${row.type}:${row.name}`,
    row.sql.replace(/\s+/g, ' ').trim().toLowerCase(),
  ]));
}

function isHealthyDatabaseFile(
  filePath: string,
  allowedForeignKeyViolations: Set<string> | null | undefined = undefined,
  requireMetadata = true,
): boolean {
  try {
    const candidate = new Database(filePath, { readonly: true, fileMustExist: true });
    const integrity = (candidate.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check === 'ok';
    const foreignKeyViolations = getForeignKeyViolationKeys(candidate);
    const foreignKeysClean = allowedForeignKeyViolations === null
      || (allowedForeignKeyViolations
        ? [...foreignKeyViolations].every((key) => allowedForeignKeyViolations.has(key))
        : foreignKeyViolations.size === 0);
    const schemaVersion = Number(candidate.pragma('user_version', { simple: true }));
    let metadata: { value: string } | undefined;
    try {
      metadata = candidate.prepare("SELECT value FROM _flo_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    } catch { }
    const tables = new Set(getTables(candidate));
    const expectedSchema = getRecoverySchemaReference();
    const columnsValid = [...expectedSchema.entries()].every(([table, columns]) => {
      const available = new Set(getColumns(candidate, table));
      return columns.every((column) => available.has(column));
    });
    const supportedVersion = MIGRATIONS[MIGRATIONS.length - 1]?.version || 0;
    const idealDb = buildIdealSchemaDb();
    let definitionsValid = false;
    try {
      const expectedDefinitions = normalizedSchemaDefinitions(idealDb);
      const actualDefinitions = normalizedSchemaDefinitions(candidate);
      definitionsValid = expectedDefinitions.size === actualDefinitions.size
        && [...expectedDefinitions].every(([key, sql]) => actualDefinitions.get(key) === sql);
    } finally {
      idealDb.close();
    }
    candidate.close();
    return integrity && foreignKeysClean && schemaVersion > 0 && schemaVersion <= supportedVersion
      && (!requireMetadata || metadata?.value === String(schemaVersion))
      && tables.size === expectedSchema.size
      && [...expectedSchema.keys()].every((table) => tables.has(table))
      && columnsValid && definitionsValid;
  } catch {
    return false;
  }
}

function removeOlderReplacementJournals(journals: string[], dbPath: string, backupDir: string): void {
  const backupRoot = path.resolve(backupDir);
  for (const journalPath of journals) {
    try {
      const journalStat = fs.lstatSync(journalPath);
      if (journalStat.isSymbolicLink() || !journalStat.isFile()) throw new Error('journal is not a regular file');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Partial<ReplacementJournal>;
      if ((journal.phase !== 'prepared' && journal.phase !== 'committed')
        || typeof journal.recoveryPath !== 'string'
        || journal.dbPath !== dbPath
        || path.dirname(journal.recoveryPath) !== backupRoot
        || `${path.basename(journalPath, '.json')}.db` !== path.basename(journal.recoveryPath)) {
        throw new Error('invalid stale replacement journal');
      }
      removeReplacementArtifacts(journalPath, journal.recoveryPath);
    } catch (error) {
      // The newest journal has already established the recovery decision. Do
      // not let an unrelated stale/corrupt older journal brick every startup;
      // remove only that journal and its same-basename snapshot.
      const fallbackRecovery = path.join(backupRoot, `${path.basename(journalPath, '.json')}.db`);
      removeReplacementArtifacts(journalPath, fallbackRecovery);
      console.warn(`[DB] Removed stale invalid replacement journal: ${journalPath}`);
    }
  }
}

function recoverInterruptedDatabaseReplacement(dbPath: string, backupDir: string): void {
  let journals: string[] = [];
  try {
    journals = fs.readdirSync(backupDir)
      .filter((name) => /^(?:flo-restore|flo-reset)-recovery-.+\.json$/.test(name))
      .map((name) => path.join(backupDir, name))
      .sort((a, b) => fs.lstatSync(b).mtimeMs - fs.lstatSync(a).mtimeMs);
  } catch (error) {
    throw new Error(`Could not inspect database replacement journals: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  for (const journalPath of journals) {
    const fallbackRecovery = path.join(path.resolve(backupDir), `${path.basename(journalPath, '.json')}.db`);
    let journalStat: fs.Stats;
    try { journalStat = fs.lstatSync(journalPath); } catch {
      removeReplacementArtifacts(journalPath, fallbackRecovery);
      continue;
    }
    if (journalStat.isSymbolicLink() || !journalStat.isFile()) {
      removeReplacementArtifacts(journalPath, fallbackRecovery);
      continue;
    }
    let journal: ReplacementJournal;
    try {
      const parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Partial<ReplacementJournal>;
      if ((parsed.phase !== 'prepared' && parsed.phase !== 'committed')
        || typeof parsed.recoveryPath !== 'string'
        || typeof parsed.dbPath !== 'string'
        || !path.isAbsolute(parsed.recoveryPath)
        || !path.isAbsolute(parsed.dbPath)
        || (parsed.baselineForeignKeyViolations !== undefined
          && (!Array.isArray(parsed.baselineForeignKeyViolations)
            || parsed.baselineForeignKeyViolations.some((key) => typeof key !== 'string')))) {
        throw new Error('invalid phase or paths');
      }
      journal = parsed as ReplacementJournal;
    } catch (error) {
      throw new Error(`Interrupted database replacement journal is invalid: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    const recoveryPath = journal.recoveryPath;
    const backupRoot = path.resolve(backupDir);
    const recoveryRoot = path.dirname(recoveryPath);
    const journalBase = path.basename(journalPath, '.json');
    const recoveryNameValid = `${journalBase}.db` === path.basename(recoveryPath);
    if (journal.dbPath !== dbPath || recoveryRoot !== backupRoot || !recoveryNameValid) {
      throw new Error('Interrupted database replacement recovery snapshot could not be validated');
    }
    // Journals written by this version carry the exact legacy FK baseline.
    // Older journals predate that field, so retain their compatibility behavior
    // rather than bricking an installation during an upgrade.
    const allowedForeignKeyViolations = journal.baselineForeignKeyViolations === undefined
      ? null
      : new Set(journal.baselineForeignKeyViolations);
    // Replacement snapshots are copies of the live database, not backup
    // artifacts; the live database intentionally has no _flo_meta table.
    const requireMetadata = false;
    // A committed replacement is already durable in the live path. Finalize
    // its journal before touching the old snapshot; legacy installs may have
    // pre-existing FK violations that are intentionally preserved.
    if (journal.phase === 'committed' && isHealthyDatabaseFile(dbPath, allowedForeignKeyViolations, requireMetadata)) {
      removeReplacementArtifacts(journalPath, recoveryPath);
      removeOlderReplacementJournals(journals.slice(1), dbPath, backupDir);
      console.warn(`[DB] Finalized committed database replacement journal: ${journalPath}`);
      return;
    }
    let recoveryStat: fs.Stats;
    try { recoveryStat = fs.lstatSync(recoveryPath); } catch { throw new Error('Interrupted database replacement snapshot is missing'); }
    const recoverySidecars = pathEntryExists(`${recoveryPath}-wal`) || pathEntryExists(`${recoveryPath}-shm`);
    if (recoveryStat.isSymbolicLink() || !recoveryStat.isFile() || recoverySidecars
      || !isHealthyDatabaseFile(recoveryPath, allowedForeignKeyViolations, requireMetadata)) {
      throw new Error('Interrupted database replacement recovery snapshot could not be validated');
    }
    const failures = removeDatabaseFiles(dbPath);
    if (failures.length > 0) throw new Error(`Could not clear interrupted database replacement: ${failures.join(', ')}`);
    fs.copyFileSync(recoveryPath, dbPath);
    syncFile(dbPath);
    if (!syncDirectory(path.dirname(dbPath)) && process.platform !== 'win32') {
      throw new Error('Could not durably install recovered database');
    }
    removeReplacementArtifacts(journalPath, recoveryPath);
    removeOlderReplacementJournals(journals.slice(1), dbPath, backupDir);
    console.warn(`[DB] Recovered database from interrupted replacement snapshot: ${recoveryPath}`);
    return;
  }
}

export function initDatabase(recoverInterruptedReplacement = true): void {
  const dbPath = getDbPath();
  const backupDir = getBackupDir();

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  if (recoverInterruptedReplacement) recoverInterruptedDatabaseReplacement(dbPath, backupDir);

  console.log(`[DB] Opening database at: ${dbPath}`);
  dbHealthError = null;
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = OFF'); // Off during migrations

  runMigrations();

  db.pragma('foreign_keys = ON');

  runStartupIntegrityCheck();
  repairSequences();
  autoRepairPaymentDetails();
  autoRepairDefaultPrinter();
}

export function ensureCloudIdentity(): { posHash: string; deviceSecret: string } {
  let deviceSecret = getSettingValue('cloud_device_secret');
  if (!deviceSecret) {
    deviceSecret = randomSecret();
    upsertSetting('cloud_device_secret', deviceSecret);
  }

  let posHash = getSettingValue('cloud_pos_hash');
  if (!posHash) {
    posHash = `pos_${sha256Hex(deviceSecret).slice(0, 40)}`;
    upsertSetting('cloud_pos_hash', posHash);
  }

  insertSettingIfMissing('cloud_device_created_at', now());
  return { posHash, deviceSecret };
}

/** Locally-cached RevFlo pairing code (plaintext) — FloAdmin only ever returns it once. */
export function getCachedPairingCode(): { code: string; expiresAt: string } | null {
  const code = getSettingValue('mobile_pairing_code');
  const expiresAt = getSettingValue('mobile_pairing_code_expires_at');
  if (!code || !expiresAt) return null;
  if (new Date(expiresAt).getTime() <= Date.now()) return null;
  return { code, expiresAt };
}

export function setCachedPairingCode(code: string, expiresAt: string): void {
  upsertSetting('mobile_pairing_code', code);
  upsertSetting('mobile_pairing_code_expires_at', expiresAt);
}

/** Random UUID, generated once and persisted — never derived from store/device identity. */
export function ensureTelemetryAnonId(): string {
  let anonId = getSettingValue('telemetry_anon_id');
  if (!anonId) {
    anonId = crypto.randomUUID();
    upsertSetting('telemetry_anon_id', anonId);
  }
  return anonId;
}

/**
 * Anonymous usage telemetry is on by default for new installs and is switched
 * off in Settings > Privacy. First-run setup discloses it rather than asking:
 * a pre-ticked consent box is not valid consent, so we do not present one.
 * Tier 2 store-attributed diagnostics is a separate, explicit opt-in and is
 * never bundled into this stream.
 */
export function isTelemetryEnabled(): boolean {
  return getSettingValue('telemetry_enabled') === 'true';
}

/**
 * Tier 2 store-attributed diagnostics, kept separate from anonymous telemetry.
 * New installs default to enabled; an owner can switch it off in Settings.
 */
export function isDiagnosticsConsentEnabled(): boolean {
  return getSettingValue('diagnostics_consent') !== 'false';
}

/**
 * Kitchen Display System on/off switch (issue #133). Defaults to enabled
 * (missing/anything but the literal 'false') so pre-existing installs that
 * predate this setting keep their current always-on behavior.
 */
export function isKdsEnabled(): boolean {
  return getSettingValue('kds_enabled') !== 'false';
}

/**
 * Server App on/off switch. Defaults to enabled for new and upgraded installs,
 * while still allowing owners to hide the tableside ordering surface entirely.
 */
export function isServerAppEnabled(): boolean {
  return getSettingValue('server_app_enabled') !== 'false';
}

/**
 * KOT ticket printing on/off switch (issue #133) — coarser than
 * `auto_print_kot` (which only gates *automatic* printing on order
 * placement). When this is off, no KOT print command may be sent,
 * automatic or manual. Defaults to enabled, same reasoning as isKdsEnabled.
 */
export function isKotPrintingEnabled(): boolean {
  return getSettingValue('kot_printing_enabled') !== 'false';
}

export function upsertTelemetryLastPing(): void {
  upsertSetting('telemetry_last_ping_at', now());
}

/** Atomic multi-statement mutation. Use for anything touching >1 row or >1 table. */
export function withTxn<T>(fn: () => T): T {
  return db.transaction(fn)();
}

/** Safely append an object to a JSON-array column. Creates the array if missing/invalid. */
export function appendJsonArray(table: string, idColumn: string, idValue: any, column: string, value: any): void {
  // Validate identifiers to prevent SQL injection
  if (!isSafeIdentifier(table) || !isSafeIdentifier(idColumn) || !isSafeIdentifier(column)) {
    throw new Error(`Invalid identifier: table=${table}, idColumn=${idColumn}, column=${column}`);
  }
  const row = db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${idColumn} = ?`).get(idValue) as any;
  let arr: any[] = [];
  if (row && row.v) {
    try {
      const parsed = JSON.parse(row.v);
      arr = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      arr = [];
    }
  }
  arr.push(value);
  db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${idColumn} = ?`).run(JSON.stringify(arr), idValue);
}

/** Runs on every startup. Logs loud warnings but never throws — DB stays available even if dirty. */
function runStartupIntegrityCheck(): void {
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    const bad = integrity.filter((r) => r.integrity_check !== 'ok');
    if (bad.length > 0) {
      const msg = bad.map((r) => r.integrity_check).join('; ');
      console.error('[DB] ⚠ integrity_check reported issues:', msg);
      dbHealthError = `Database integrity error: ${msg}`;
    } else {
      console.log('[DB] integrity_check: ok');
    }

    const fkViolations = db.prepare('PRAGMA foreign_key_check').all() as any[];
    if (fkViolations.length > 0) {
      console.error(`[DB] ⚠ ${fkViolations.length} foreign-key violation(s):`, fkViolations.slice(0, 5));
    } else {
      console.log('[DB] foreign_key_check: clean');
    }
  } catch (err: any) {
    console.error('[DB] Startup integrity check failed:', err.message);
  }
}

/** Re-seeds the sequences table from existing order_number and bill_number data.
 *  Fixes UNIQUE constraint collisions caused by migration v10 dropping and recreating
 *  the sequences table, which reset counters while old numbered rows still existed. */
function repairSequences(): void {
  try {
    const collectSequenceMax = (table: 'orders' | 'bills', numberColumn: string, pattern: RegExp) => {
      const rows = db.prepare(`SELECT ${numberColumn} AS value FROM ${table} WHERE ${numberColumn} IS NOT NULL`).all() as { value: string }[];
      const maxByDate = new Map<string, number>();

      for (const row of rows) {
        const match = String(row.value).match(pattern);
        if (!match) continue;
        const date = match[1];
        const sequence = Number.parseInt(match[2], 10);
        if (!Number.isFinite(sequence)) continue;
        maxByDate.set(date, Math.max(maxByDate.get(date) || 0, sequence));
      }

      return Array.from(maxByDate, ([date, max_val]) => ({ date, max_val }));
    };

    // Extract max sequence per date from order_numbers (format: ORD-YYYYMMDD-NNNN)
    const orderRows = collectSequenceMax('orders', 'order_number', /^ORD-(\d{8})-(\d+)$/);

    for (const row of orderRows) {
      if (!row.date || !row.max_val) continue;
      const existing = db.prepare(`SELECT current_value FROM sequences WHERE name = 'orders' AND date = ?`).get(row.date) as any;
      if (!existing) {
        db.prepare(`INSERT INTO sequences (name, date, current_value) VALUES ('orders', ?, ?)`).run(row.date, row.max_val);
      } else if (existing.current_value < row.max_val) {
        db.prepare(`UPDATE sequences SET current_value = ? WHERE name = 'orders' AND date = ?`).run(row.max_val, row.date);
      }
    }

    // Extract max sequence per date from bill_numbers (format: INV-YYYYMMDD-NNNN)
    const billRows = collectSequenceMax('bills', 'bill_number', /^INV-(\d{8})-(\d+)$/);

    for (const row of billRows) {
      if (!row.date || !row.max_val) continue;
      const existing = db.prepare(`SELECT current_value FROM sequences WHERE name = 'bills' AND date = ?`).get(row.date) as any;
      if (!existing) {
        db.prepare(`INSERT INTO sequences (name, date, current_value) VALUES ('bills', ?, ?)`).run(row.date, row.max_val);
      } else if (existing.current_value < row.max_val) {
        db.prepare(`UPDATE sequences SET current_value = ? WHERE name = 'bills' AND date = ?`).run(row.max_val, row.date);
      }
    }
  } catch (err) {
    console.error('[DB] repairSequences failed:', err);
  }
}

/** Idempotent auto-repair for the pre-fix payment_details corruption: `{A},{A}` → `[A]`.
 *  Only runs when rows are detected as malformed AND the deduped sum matches `paid_amount`. */
function autoRepairPaymentDetails(): void {
  try {
    const rows = db.prepare(`SELECT id, payment_details, paid_amount FROM bills WHERE payment_details IS NOT NULL AND payment_details != ''`).all() as any[];
    const toFix: { id: number; value: string }[] = [];

    for (const row of rows) {
      try { JSON.parse(row.payment_details); continue; } catch { }

      const wrapped = '[' + String(row.payment_details).replace(/\}\s*,\s*\{/g, '},{') + ']';
      let parsed: any[];
      try { parsed = JSON.parse(wrapped); } catch { continue; }
      if (!Array.isArray(parsed)) continue;

      const deduped: any[] = [];
      for (const p of parsed) {
        const prev = deduped[deduped.length - 1];
        if (prev && prev.method === p.method && prev.amount === p.amount && prev.timestamp === p.timestamp) continue;
        deduped.push(p);
      }

      const dedupedSum = deduped.reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const rawSum = parsed.reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const chosen = Math.abs(dedupedSum - row.paid_amount) <= 0.02 ? deduped
        : Math.abs(rawSum - row.paid_amount) <= 0.02 ? parsed : null;
      if (!chosen) continue;

      toFix.push({ id: row.id, value: JSON.stringify(chosen) });
    }

    if (toFix.length === 0) return;

    const stmt = db.prepare(`UPDATE bills SET payment_details = ?, updated_at = datetime('now') WHERE id = ?`);
    const tx = db.transaction((rows: { id: number; value: string }[]) => {
      for (const r of rows) stmt.run(r.value, r.id);
    });
    tx(toFix);
    console.log(`[DB] auto-repaired payment_details on ${toFix.length} bill(s)`);
  } catch (err: any) {
    console.error('[DB] autoRepairPaymentDetails failed:', err.message);
  }
}

/** Keep printer selection deterministic if an older install ended up with multiple defaults. */
function autoRepairDefaultPrinter(): void {
  try {
    const defaults = db.prepare(`
      SELECT id FROM printers
      WHERE is_default = 1
      ORDER BY CASE WHEN id = 'printer-1' AND name = 'Thermal Printer' THEN 1 ELSE 0 END ASC,
               COALESCE(updated_at, created_at, '') DESC,
               COALESCE(created_at, '') DESC,
               name COLLATE NOCASE ASC,
               id ASC
    `).all() as { id: string }[];

    if (defaults.length <= 1) return;

    const keepId = defaults[0].id;
    db.prepare(`
      UPDATE printers
      SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END,
          updated_at = CASE WHEN id = ? THEN updated_at ELSE ? END
      WHERE is_default = 1
    `).run(keepId, keepId, now());

    console.log(`[DB] auto-repaired default printers; kept ${keepId}`);
  } catch (err: any) {
    console.error('[DB] autoRepairDefaultPrinter failed:', err.message);
  }
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null as unknown as Database.Database;
    console.log('[DB] Database closed');
  }
}

export async function createBackupUnlocked(targetPath?: string): Promise<{ path: string; schemaVersion: number }> {
  // Internal callers must already hold withDatabaseMaintenanceLock().
  console.log('[DB] createBackup: Starting...');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const uniqueSuffix = crypto.randomBytes(4).toString('hex');
  const backupDir = getBackupDir();

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  // Always write to a temp path inside userData first. On MAS, the sandbox
  // only grants access to the user-selected file itself — opening the backup
  // DB in WAL mode would try to create .db-wal/.db-shm siblings next to the
  // user-selected file, which the sandbox blocks. Writing to userData first
  // avoids that restriction; we copy the final clean file to targetPath.
  const tempPath = path.join(backupDir, `flo-backup-${timestamp}-${uniqueSuffix}.db`);
  const finalPath = targetPath ? path.resolve(targetPath) : tempPath;
  const stagedTargetPath = finalPath !== tempPath
    ? path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.tmp-${uniqueSuffix}`)
    : null;
  let completed = false;

  const liveDatabasePath = getDbPath();
  if ([liveDatabasePath, `${liveDatabasePath}-wal`, `${liveDatabasePath}-shm`].some((livePath) => isLiveDatabaseTarget(finalPath, livePath))) {
    throw new Error('Backup target cannot be the live database or its SQLite sidecars');
  }
  if (stagedTargetPath && fs.existsSync(finalPath) && fs.lstatSync(finalPath).isSymbolicLink()) {
    throw new Error('Backup target cannot be a symbolic link');
  }

  try {
    console.log('[DB] createBackup: Backing up to temp:', tempPath);
    await db.backup(tempPath);

    let currentVersion = 0;
    let backupDb: Database.Database | undefined;
    try {
      backupDb = new Database(tempPath);
      // Switch to DELETE journal mode: checkpoints WAL and removes
      // .db-wal/.db-shm so the final file is self-contained.
      backupDb.pragma('journal_mode = DELETE');
      backupDb.exec(`
        CREATE TABLE IF NOT EXISTS _flo_meta (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `);

      currentVersion = getCurrentSchemaVersion();
      backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`)
        .run('schema_version', String(currentVersion));
      backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`)
        .run('backup_created_at', new Date().toISOString());
      backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`)
        .run('app_version', app.getVersion());
    } finally {
      backupDb?.close();
    }

    if (stagedTargetPath) {
      fs.copyFileSync(tempPath, stagedTargetPath);
      syncFile(stagedTargetPath);
      if (!syncDirectory(path.dirname(stagedTargetPath)) && process.platform !== 'win32') {
        throw new Error('Could not durably stage backup target');
      }
      try {
        fs.renameSync(stagedTargetPath, finalPath);
      } catch (error) {
        if (process.platform !== 'win32' || !fs.existsSync(finalPath)) throw error;
        fs.unlinkSync(finalPath);
        fs.renameSync(stagedTargetPath, finalPath);
      }
      syncDirectory(path.dirname(finalPath));
      fs.unlinkSync(tempPath);
    }
    for (const sidecar of [`${finalPath}-wal`, `${finalPath}-shm`]) {
      try { if (pathEntryExists(sidecar)) fs.unlinkSync(sidecar); } catch { }
    }
    syncFile(finalPath);
    if (!syncDirectory(path.dirname(finalPath)) && process.platform !== 'win32') {
      throw new Error('Could not durably persist backup file');
    }
    if (finalPath !== tempPath) {
      console.log(`[DB] Backup saved to: ${finalPath} (schema v${currentVersion})`);
    } else {
      console.log(`[DB] Backup created: ${finalPath} (schema v${currentVersion})`);
    }

    completed = true;
    return { path: finalPath, schemaVersion: currentVersion };
  } finally {
    if (!completed) {
      for (const filePath of [tempPath, stagedTargetPath, `${tempPath}-wal`, `${tempPath}-shm`].filter((value): value is string => Boolean(value))) {
        try { if (pathEntryExists(filePath)) fs.unlinkSync(filePath); } catch { }
      }
    }
  }
}

export function createBackup(targetPath?: string): Promise<{ path: string; schemaVersion: number }> {
  return withDatabaseMaintenanceLock(() => createBackupUnlocked(targetPath));
}

function removeDatabaseFiles(dbPath: string): string[] {
  const failures: string[] = [];
  for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (pathEntryExists(filePath)) fs.unlinkSync(filePath);
    } catch (error: any) {
      console.warn(`[DB] Could not remove ${filePath}:`, error);
      failures.push(filePath);
    }
  }
  return failures;
}

/**
 * Creates the safety backup and resets the live database while holding the
 * same maintenance lock used by ordinary backups. On a failed wipe/reopen,
 * restore the safety backup before surfacing the error so callers never see a
 * false success or an intentionally closed database.
 */
export async function resetDatabaseWithBackup(): Promise<{ backupPath: string }> {
  return withDatabaseMaintenanceLock(async () => {
    const { path: backupPath } = await createBackupUnlocked();
    const dbPath = getDbPath();
    const baselineForeignKeyViolations = getForeignKeyViolationKeys(getDatabase());
    const recoveryPath = path.join(getBackupDir(), `flo-reset-recovery-${crypto.randomBytes(8).toString('hex')}.db`);
    const journalPath = recoveryPath.replace(/\.db$/, '.json');
    let replacementCompleted = false;
    let recoveryCompleted = false;

    try {
      fs.copyFileSync(backupPath, recoveryPath);
      syncFile(recoveryPath);
      writeReplacementJournal(journalPath, {
        phase: 'prepared', recoveryPath, dbPath,
        baselineForeignKeyViolations: [...baselineForeignKeyViolations],
      });
      closeDatabase();
      const failures = removeDatabaseFiles(dbPath);
      if (failures.length > 0) {
        throw new Error(`Could not remove database files: ${failures.join(', ')}`);
      }
      initDatabase(false);
      getDatabase().pragma('wal_checkpoint(TRUNCATE)');
      syncFile(dbPath);
      if (!syncDirectory(path.dirname(dbPath)) && process.platform !== 'win32') {
        throw new Error('Could not durably commit reset database');
      }
      writeReplacementJournal(journalPath, {
        phase: 'committed', recoveryPath, dbPath,
        baselineForeignKeyViolations: [...baselineForeignKeyViolations],
      });
      replacementCompleted = true;
      return { backupPath };
    } catch (error: any) {
      // Reopen the pre-wipe snapshot so a partial filesystem failure cannot
      // leave the process serving an empty or closed database.
      try {
        closeDatabase();
        removeDatabaseFiles(dbPath);
        fs.copyFileSync(backupPath, dbPath);
        syncFile(dbPath);
        if (!syncDirectory(path.dirname(dbPath)) && process.platform !== 'win32') {
          throw new Error('Could not durably recover reset database');
        }
        initDatabase(false);
        recoveryCompleted = true;
      } catch (recoveryError: any) {
        throw new Error(
          `Database reset failed: ${error?.message || 'unknown error'}; ` +
          `database recovery also failed: ${recoveryError?.message || 'unknown error'}`,
        );
      }
      throw error;
    } finally {
      if (replacementCompleted || recoveryCompleted) removeReplacementArtifacts(journalPath, recoveryPath);
    }
  });
}

/** Reads the canonical schema_version stamp createBackup() writes into _flo_meta. */
function parseCanonicalSchemaVersion(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readBackupSchemaVersion(fullPath: string): number | null {
  let backupDb: Database.Database | undefined;
  try {
    backupDb = new Database(fullPath, { readonly: true, fileMustExist: true });
    const row = backupDb.prepare(`SELECT value FROM _flo_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    return row ? parseCanonicalSchemaVersion(row.value) : null;
  } catch {
    return null;
  } finally {
    backupDb?.close();
  }
}

/**
 * Lists backups in the managed backups/ directory, newest first. Only
 * backups written by createBackup()/syncBackupBeforeMigration() live here —
 * a backup saved to a user-chosen custom path (via the Export Backup /
 * "choose location" flow) intentionally does not appear here, same as it
 * never has for the existing File > Export Backup menu action. See #120.
 */
export function listBackups(): { fileName: string; path: string; sizeBytes: number; createdAt: string; kind: 'manual' | 'auto'; schemaVersion: number | null }[] {
  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) return [];

  return fs.readdirSync(backupDir)
    .filter((fileName) => fileName.startsWith('flo-backup-') && fileName.endsWith('.db'))
    .filter((fileName) => {
      try { return fs.lstatSync(path.join(backupDir, fileName)).isFile(); } catch { return false; }
    })
    .map((fileName) => {
      const fullPath = path.join(backupDir, fileName);
      const stat = fs.statSync(fullPath);
      return {
        fileName,
        path: fullPath,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
        kind: (fileName.includes('-pre-v') ? 'auto' : 'manual') as 'manual' | 'auto',
        schemaVersion: readBackupSchemaVersion(fullPath),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Deletes one backup from the managed backups/ directory by file name.
 * fileName is validated against the exact naming scheme createBackup() uses
 * and resolved only inside backupDir, so a path-traversal fileName (e.g.
 * `../../flo.db`) can't escape the backups folder or delete the live DB.
 */
export function deleteBackup(fileName: string): void {
  if (!/^flo-backup-[\w.-]+\.db$/.test(fileName)) {
    throw new Error('Invalid backup file name');
  }
  const backupDir = getBackupDir();
  const fullPath = path.join(backupDir, fileName);
  if (path.dirname(fullPath) !== backupDir) {
    throw new Error('Invalid backup file name');
  }
  if (!fs.existsSync(fullPath)) {
    throw new Error('Backup not found');
  }
  fs.unlinkSync(fullPath);
}

function getSchemaDefinitions(dbInstance: Database.Database): Map<string, string> {
  const rows = dbInstance.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
      AND name <> '_flo_meta'
  `).all() as { type: string; name: string; sql: string | null }[];
  return new Map(rows.map((row) => [
    `${row.type}:${row.name}`,
    (row.sql || '').replace(/\s+/g, ' ').trim(),
  ]));
}

function getColumns(dbInstance: Database.Database, tableName: string): string[] {
  try {
    const columns = dbInstance.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
    return columns.map(col => col.name);
  } catch {
    return [];
  }
}

export function getTables(dbInstance: Database.Database): string[] {
  try {
    const tables = dbInstance.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' 
      AND name NOT LIKE 'sqlite_%' AND name <> '_flo_meta'
    `).all() as { name: string }[];
    return tables.map(t => t.name);
  } catch {
    return [];
  }
}

export interface RestoreResult {
  success: boolean;
  mode: 'direct' | 'data_only' | 'full';
  backupSchemaVersion: number;
  currentSchemaVersion: number;
  tablesRestored: number;
  error?: string;
}

function validateDirectBackup(backupPath: string, currentDb: Database.Database, currentVersion: number, baselineForeignKeyViolations: Set<string> = new Set()): string | null {
  let backupDb: Database.Database | undefined;
  try {
    const sourceStat = fs.lstatSync(backupPath);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) return 'Direct restore source must be a regular file';
    if (pathEntryExists(`${backupPath}-wal`) || pathEntryExists(`${backupPath}-shm`)) return 'Direct restore source must not have SQLite sidecars';
    backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    const metaRow = backupDb.prepare(`SELECT value FROM _flo_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    const metadataVersion = metaRow ? parseCanonicalSchemaVersion(metaRow.value) ?? 0 : 0;
    const pragmaVersion = Number(backupDb.pragma('user_version', { simple: true }));
    if (metadataVersion !== currentVersion || pragmaVersion !== currentVersion) {
      return `Direct restore requires matching metadata/header schema v${currentVersion}`;
    }

    const integrity = backupDb.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (integrity.some((row) => row.integrity_check !== 'ok')) {
      return `Backup integrity check failed: ${integrity.map((row) => row.integrity_check).join('; ')}`;
    }
    const backupForeignKeyViolations = getForeignKeyViolationKeys(backupDb);
    const newForeignKeyViolations = [...backupForeignKeyViolations].filter((key) => !baselineForeignKeyViolations.has(key));
    if (newForeignKeyViolations.length > 0) {
      return `Backup contains ${newForeignKeyViolations.length} new foreign-key violation(s)`;
    }

    const currentTables = getTables(currentDb);
    const backupTables = new Set(getTables(backupDb));
    const missingTables = currentTables.filter((tableName) => !backupTables.has(tableName));
    if (missingTables.length > 0) {
      return `Backup is missing required table(s): ${missingTables.join(', ')}`;
    }

    for (const tableName of currentTables) {
      const backupColumns = new Set(getColumns(backupDb, tableName));
      const missingColumns = getColumns(currentDb, tableName).filter((column) => !backupColumns.has(column));
      if (missingColumns.length > 0) {
        return `Backup table ${tableName} is missing required column(s): ${missingColumns.join(', ')}`;
      }
    }

    const currentSchema = getSchemaDefinitions(currentDb);
    const backupSchema = getSchemaDefinitions(backupDb);
    for (const [key, definition] of currentSchema) {
      if (backupSchema.get(key) !== definition) {
        return `Backup schema object ${key} is missing or differs from the current definition`;
      }
    }
    for (const key of backupSchema.keys()) {
      if (!currentSchema.has(key)) {
        return `Backup contains unapproved schema object ${key}`;
      }
    }
    return null;
  } catch (error: any) {
    return `Backup validation failed: ${error?.message || 'unknown error'}`;
  } finally {
    backupDb?.close();
  }
}

type RevocationRow = { token_hash: string; expires_at: number; revoked_at: string };
export type UserStationSecurityState = {
  user_id: string;
  station_id: string;
  is_active: number;
  category_ids: string | null;
};
export type KitchenStationSecurityState = {
  id: string;
  is_active: number;
  category_ids: string | null;
};

export function captureKitchenStationSecurityState(dbInstance: Database.Database): KitchenStationSecurityState[] {
  try {
    return dbInstance.prepare('SELECT id, is_active, category_ids FROM kitchen_stations').all() as KitchenStationSecurityState[];
  } catch {
    return [];
  }
}

export type KdsEnabledSettingState = { present: boolean; value: string | null };
export type RestoreProtectedSettingState = { key: string; present: boolean; value: string | null };
export type RestoreOutboxState = {
  cloud: Record<string, unknown>[];
  support: Record<string, unknown>[];
  diagnostics: Record<string, unknown>[];
};
const RESTORE_PROTECTED_SETTING_KEYS = [
  'jwt_secret', 'cloud_api_key', 'cloud_device_secret', 'cloud_pos_hash',
  'telemetry_enabled', 'diagnostics_consent',
  'mobile_pairing_code', 'mobile_pairing_code_expires_at',
];

export function captureRestoreProtectedSettings(dbInstance: Database.Database): RestoreProtectedSettingState[] {
  const fixedRows = dbInstance.prepare(
    `SELECT key, value FROM settings WHERE key IN (${RESTORE_PROTECTED_SETTING_KEYS.map(() => '?').join(',')})`,
  ).all(...RESTORE_PROTECTED_SETTING_KEYS) as { key: string; value: string | null }[];
  const cloudRows = dbInstance.prepare("SELECT key, value FROM settings WHERE key LIKE 'cloud_%'").all() as { key: string; value: string | null }[];
  const byKey = new Map([...fixedRows, ...cloudRows].map((row) => [row.key, row.value]));
  const keys = [...new Set([...RESTORE_PROTECTED_SETTING_KEYS, ...cloudRows.map((row) => row.key)])];
  const deviceSecret = byKey.get('cloud_device_secret');
  return keys.map((key) => ({
    key,
    // Pairing codes are installation-local, short-lived credentials. Never
    // carry one across a restore, even if the live installation had one.
    // A position hash without its device secret is also unsafe to preserve.
    present: !key.startsWith('mobile_pairing_code')
      && !(key === 'cloud_pos_hash' && !deviceSecret)
      && byKey.has(key),
    value: byKey.get(key) ?? null,
  }));
}

export function mergeRestoreProtectedSettings(dbInstance: Database.Database, states: RestoreProtectedSettingState[]): void {
  const upsert = dbInstance.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  // Cloud identity/configuration is installation-local. Remove every backup
  // cloud key first so a future or backup-only key cannot cross installations.
  dbInstance.prepare("DELETE FROM settings WHERE key LIKE 'cloud_%'").run();
  for (const state of states) {
    if (state.present) upsert.run(state.key, state.value, now());
    else if (!state.key.startsWith('cloud_')) dbInstance.prepare('DELETE FROM settings WHERE key = ?').run(state.key);
  }
  const hasDeviceSecret = states.some((state) => state.key === 'cloud_device_secret' && state.present);
  const hasPosHash = states.some((state) => state.key === 'cloud_pos_hash' && state.present);
  if (!hasDeviceSecret || !hasPosHash) ensureCloudIdentity();
}

export function captureRestoreOutboxState(dbInstance: Database.Database): RestoreOutboxState {
  const pending = (table: string) => dbInstance.prepare(`SELECT * FROM ${table} WHERE status IN ('pending', 'failed', 'sending')`).all() as Record<string, unknown>[];
  return { cloud: pending('cloud_sync_outbox'), support: pending('support_ticket_outbox'), diagnostics: pending('store_diagnostics_outbox') };
}

export function mergeRestoreOutboxState(dbInstance: Database.Database, state: RestoreOutboxState): void {
  dbInstance.exec('DELETE FROM cloud_sync_outbox; DELETE FROM support_ticket_outbox; DELETE FROM store_diagnostics_outbox');
  const cloud = dbInstance.prepare(`INSERT OR REPLACE INTO cloud_sync_outbox
    (id, event_type, entity_type, entity_id, payload, status, attempt_count, next_attempt_at, last_error, delivered_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of state.cloud) cloud.run(row.id, row.event_type, row.entity_type, row.entity_id, row.payload, row.status === 'sending' ? 'failed' : row.status, row.attempt_count || 0, row.next_attempt_at || now(), row.last_error || null, row.delivered_at || null, row.created_at || now(), row.updated_at || now());
  const support = dbInstance.prepare(`INSERT OR REPLACE INTO support_ticket_outbox
    (client_ticket_id, payload, status, support_code, attempt_count, next_attempt_at, last_error, created_at, updated_at, delivered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of state.support) support.run(row.client_ticket_id, row.payload, row.status === 'sending' ? 'failed' : row.status, row.support_code || null, row.attempt_count || 0, row.next_attempt_at || now(), row.last_error || null, row.created_at || now(), row.updated_at || now(), row.delivered_at || null);
  const diagnostics = dbInstance.prepare(`INSERT OR REPLACE INTO store_diagnostics_outbox
    (event_id, payload, status, attempt_count, next_attempt_at, last_error, created_at, updated_at, delivered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of state.diagnostics) diagnostics.run(row.event_id, row.payload, row.status === 'sending' ? 'failed' : row.status, row.attempt_count || 0, row.next_attempt_at || now(), row.last_error || null, row.created_at || now(), row.updated_at || now(), row.delivered_at || null);
}

export function captureKdsEnabledSetting(dbInstance: Database.Database): KdsEnabledSettingState {
  const row = dbInstance.prepare('SELECT value FROM settings WHERE key = ?').get('kds_enabled') as { value: string | null } | undefined;
  // A missing setting has always meant enabled; preserve that effective
  // security posture instead of letting an older backup disable KDS.
  return { present: true, value: row?.value ?? 'true' };
}

export function mergeKdsEnabledSetting(dbInstance: Database.Database, state: KdsEnabledSettingState): void {
  if (!state.present) return;
  dbInstance.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES ('kds_enabled', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(state.value, now());
}

export function captureUserStationSecurityState(dbInstance: Database.Database): UserStationSecurityState[] {
  try {
    return dbInstance.prepare(`
      SELECT su.user_id, su.station_id, ks.is_active, ks.category_ids
      FROM station_users su
      JOIN kitchen_stations ks ON ks.id = su.station_id
    `).all() as UserStationSecurityState[];
  } catch {
    return [];
  }
}

export function mergeUserStationSecurityState(
  dbInstance: Database.Database,
  rows: UserStationSecurityState[],
  userIds: string[],
  preservedStations: KitchenStationSecurityState[] = [],
): void {
  const preservedIds = new Set(userIds);
  const currentStation = dbInstance.prepare('SELECT 1 FROM kitchen_stations WHERE id = ?');
  const missingStations = preservedStations
    .filter((station) => !currentStation.get(station.id))
    .map((station) => station.id);
  if (missingStations.length > 0) {
    throw new Error(`Restore cannot preserve current kitchen station(s): ${missingStations.join(', ')}`);
  }
  const restoreStationSecurity = dbInstance.prepare(
    'UPDATE kitchen_stations SET is_active = ?, category_ids = ?, updated_at = ? WHERE id = ?',
  );
  for (const station of preservedStations) {
    restoreStationSecurity.run(station.is_active, station.category_ids, now(), station.id);
  }
  const stationState = dbInstance.prepare('SELECT is_active, category_ids FROM kitchen_stations WHERE id = ?');
  const invalidStations = rows
    .filter((row) => preservedIds.has(row.user_id))
    .filter((row) => {
      const restored = stationState.get(row.station_id) as { is_active: number; category_ids: string | null } | undefined;
      return !restored
        || restored.is_active !== row.is_active
        || restored.category_ids !== row.category_ids;
    })
    .map((row) => `${row.user_id}:${row.station_id}`);
  if (invalidStations.length > 0) {
    throw new Error(`Restore cannot preserve current station security state(s): ${invalidStations.join(', ')}`);
  }

  const currentUsers = dbInstance.prepare('SELECT id FROM users').all() as { id: string }[];
  for (const user of currentUsers) {
    dbInstance.prepare('DELETE FROM station_users WHERE user_id = ?').run(user.id);
  }
  const insert = dbInstance.prepare('INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, ?)');
  for (const row of rows) {
    if (preservedIds.has(row.user_id)) insert.run(row.user_id, row.station_id, now());
  }
}

export type UserSecurityState = {
  id: string;
  name: string;
  email: string | null;
  password: string;
  pin: string | null;
  pin_hash: string | null;
  role: string;
  category_ids: string | null;
  is_active: number;
  tokens_valid_after: string | null;
  station_assignments_configured: number;
};

export function getUserKdsStationIds(dbInstance: Database.Database, userId: string): string[] | null {
  try {
    return (dbInstance.prepare(`
      SELECT su.station_id
      FROM station_users su
      JOIN kitchen_stations ks ON ks.id = su.station_id
      WHERE su.user_id = ? AND ks.is_active = 1
    `).all(userId) as { station_id: string }[]).map((row) => String(row.station_id));
  } catch {
    return null;
  }
}

export function getKdsStationCategoryIds(dbInstance: Database.Database, stationIds: string[]): string[] | null {
  if (stationIds.length === 0) return [];
  try {
    const placeholders = stationIds.map(() => '?').join(',');
    const rows = dbInstance.prepare(`SELECT category_ids FROM kitchen_stations WHERE is_active = 1 AND id IN (${placeholders})`).all(...stationIds) as { category_ids: string | null }[];
    const categories = new Set<string>();
    for (const row of rows) {
      if (!row.category_ids) continue;
      try {
        const parsed = JSON.parse(row.category_ids);
        if (Array.isArray(parsed)) for (const categoryId of parsed) if (categoryId != null) categories.add(String(categoryId));
      } catch { }
    }
    return [...categories];
  } catch {
    return null;
  }
}

export type KdsStationRoutingScope = {
  tablelessCategoryIds: string[];
  categoryIdsByStation: Record<string, string[] | null>;
  hasUnrestrictedStation: boolean;
};

export function getKdsStationRoutingScope(
  dbInstance: Database.Database,
  stationIds: string[],
  userCategoryIds: string[],
): KdsStationRoutingScope | null {
  if (stationIds.length === 0) return { tablelessCategoryIds: [], categoryIdsByStation: {}, hasUnrestrictedStation: false };
  try {
    const placeholders = stationIds.map(() => '?').join(',');
    const rows = dbInstance.prepare(`
      SELECT id, category_ids FROM kitchen_stations
      WHERE is_active = 1 AND id IN (${placeholders})
    `).all(...stationIds) as { id: string; category_ids: string | null }[];
    const byStation: Record<string, string[] | null> = {};
    const tableless = new Set<string>();
    let hasUnrestrictedStation = false;
    for (const stationId of stationIds) {
      const row = rows.find((candidate) => String(candidate.id) === String(stationId));
      let stationCategories: string[] = [];
      if (row?.category_ids) {
        try {
          const parsed = JSON.parse(row.category_ids);
          if (!Array.isArray(parsed)) return null;
          stationCategories = parsed.filter((id) => id != null).map(String);
        } catch {
          return null;
        }
      }
      const allowed = stationCategories.length > 0
        ? stationCategories.filter((id) => userCategoryIds.length === 0 || userCategoryIds.includes(id))
        : (userCategoryIds.length > 0 ? [...userCategoryIds] : null);
      byStation[String(stationId)] = allowed;
      if (allowed === null) hasUnrestrictedStation = true;
      if (allowed !== null) allowed.forEach((id) => tableless.add(id));
    }
    return { tablelessCategoryIds: [...tableless], categoryIdsByStation: byStation, hasUnrestrictedStation };
  } catch {
    return null;
  }
}

export function getKdsStationRoutingCategoryIds(
  dbInstance: Database.Database,
  stationIds: string[],
  userCategoryIds: string[],
): string[] | null {
  return getKdsStationRoutingScope(dbInstance, stationIds, userCategoryIds)?.tablelessCategoryIds ?? null;
}

export function isKdsStationItemAllowed(
  stationIds: string[],
  stationCategoryIds: string[],
  orderStationId: string | null | undefined,
  itemCategoryId: string | null | undefined,
  orderStationCategoryIds?: string[] | null,
  hasUnrestrictedStation = false,
): boolean {
  if (stationIds.length === 0) return true;
  if (orderStationId) {
    if (!stationIds.includes(String(orderStationId))) return false;
    if (orderStationCategoryIds === undefined) return true;
    if (orderStationCategoryIds === null) return true;
    return !!itemCategoryId && orderStationCategoryIds.includes(String(itemCategoryId));
  }
  return hasUnrestrictedStation || (!!itemCategoryId && stationCategoryIds.includes(String(itemCategoryId)));
}

export function hasUserKdsStationAssignments(dbInstance: Database.Database, userId: string): boolean | null {
  try {
    const row = dbInstance.prepare(`
      SELECT station_assignments_configured,
             EXISTS (SELECT 1 FROM station_users WHERE user_id = ?) AS assigned
      FROM users WHERE id = ?
    `).get(userId, userId) as { station_assignments_configured: number; assigned: number } | undefined;
    if (!row) return null;
    return row.station_assignments_configured === 1 || row.assigned === 1;
  } catch {
    return null;
  }
}

export function captureUserSecurityState(dbInstance: Database.Database): UserSecurityState[] {
  try {
    return dbInstance.prepare('SELECT id, name, email, password, pin, pin_hash, role, category_ids, is_active, tokens_valid_after, station_assignments_configured FROM users').all() as UserSecurityState[];
  } catch {
    return [];
  }
}

export function mergeUserSecurityState(dbInstance: Database.Database, rows: UserSecurityState[]): void {
  for (const row of rows) {
    const restored = dbInstance.prepare('SELECT id, is_active, tokens_valid_after, station_assignments_configured FROM users WHERE id = ?').get(row.id) as UserSecurityState | undefined;
    if (!restored) continue;
    const currentEpoch = row.tokens_valid_after;
    const restoredEpoch = restored.tokens_valid_after;
    const currentParsedTime = currentEpoch ? parseDbTimestamp(currentEpoch).getTime() : Number.NaN;
    const restoredParsedTime = restoredEpoch ? parseDbTimestamp(restoredEpoch).getTime() : Number.NaN;
    const currentTime = Number.isFinite(currentParsedTime) ? currentParsedTime : Number.NEGATIVE_INFINITY;
    const restoredTime = Number.isFinite(restoredParsedTime) ? restoredParsedTime : Number.NEGATIVE_INFINITY;
    const tokensValidAfter = currentTime >= restoredTime ? currentEpoch : restoredEpoch;
    dbInstance.prepare(`
      UPDATE users
      SET name = ?, email = ?, password = ?, pin = ?, pin_hash = ?, role = ?, category_ids = ?,
          is_active = ?, tokens_valid_after = ?, station_assignments_configured = ?
      WHERE id = ?
    `).run(
      row.name, row.email, row.password, row.pin, row.pin_hash, row.role, row.category_ids,
      row.is_active,
      tokensValidAfter,
      row.station_assignments_configured || 0,
      row.id,
    );
  }

  // Accounts introduced only by an older snapshot must not become a new
  // login path without an explicit owner reactivation.
  const preservedIds = new Set(rows.map((row) => row.id));
  const restoredUsers = dbInstance.prepare('SELECT id FROM users').all() as { id: string }[];
  const restoredIds = new Set(restoredUsers.map((user) => user.id));
  const disableRestoredOnly = dbInstance.prepare('UPDATE users SET is_active = 0, tokens_valid_after = ? WHERE id = ?');
  for (const user of restoredUsers) {
    if (!preservedIds.has(user.id)) disableRestoredOnly.run(now(), user.id);
  }

  const insertPreservedUser = dbInstance.prepare(`
    INSERT INTO users (id, name, email, password, pin, pin_hash, role, category_ids, is_active, tokens_valid_after, station_assignments_configured, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    if (restoredIds.has(row.id)) continue;
    const emailConflict = row.email
      ? dbInstance.prepare('SELECT id FROM users WHERE email = ?').get(row.email) as { id: string } | undefined
      : undefined;
    if (emailConflict) dbInstance.prepare('UPDATE users SET email = NULL WHERE id = ?').run(emailConflict.id);
    insertPreservedUser.run(
      row.id, row.name, row.email, row.password, row.pin, row.pin_hash, row.role,
      row.category_ids, row.is_active, row.tokens_valid_after, row.station_assignments_configured || 0, now(), now(),
    );
  }
}

function readRevocations(dbInstance: Database.Database): RevocationRow[] {
  try {
    return dbInstance.prepare('SELECT token_hash, expires_at, revoked_at FROM revoked_tokens').all() as RevocationRow[];
  } catch {
    return [];
  }
}

function mergeRevocations(dbInstance: Database.Database, rows: RevocationRow[]): void {
  if (rows.length === 0) return;
  const merge = dbInstance.prepare(`
    INSERT INTO revoked_tokens (token_hash, expires_at, revoked_at)
    VALUES (?, ?, ?)
    ON CONFLICT(token_hash) DO UPDATE SET
      expires_at = MAX(revoked_tokens.expires_at, excluded.expires_at),
      revoked_at = MIN(revoked_tokens.revoked_at, excluded.revoked_at)
  `);
  for (const row of rows) merge.run(row.token_hash, row.expires_at, row.revoked_at);
}

export function restoreBackup(backupPath: string, forceDirect: boolean = false): RestoreResult {
  console.log('[DB] restoreBackup: Starting restore from:', backupPath);
  try {
    backupPath = materializeRestoreSource(backupPath, getDbPath());
  } catch (error: any) {
    const currentVersion = getCurrentSchemaVersion();
    return {
      success: false,
      mode: forceDirect ? 'direct' : 'data_only',
      backupSchemaVersion: 0,
      currentSchemaVersion: currentVersion,
      tablesRestored: 0,
      error: error?.message || 'Invalid restore source',
    };
  }

  let metadataVersion = 0;
  let metadataStampPresent = false;
  let pragmaVersion = 0;
  let backupDb: Database.Database | undefined;
  try {
    backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    const metaRow = backupDb.prepare(`SELECT value FROM _flo_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    metadataStampPresent = Boolean(metaRow);
    metadataVersion = metaRow ? parseCanonicalSchemaVersion(metaRow.value) ?? 0 : 0;
    pragmaVersion = Number(backupDb.pragma('user_version', { simple: true }));
  } finally {
    backupDb?.close();
  }

  // The SQLite header is authoritative for what initDatabase() will open. A
  // forged/stale _flo_meta stamp must not let forceDirect replace the live DB
  // with a database this build cannot migrate or serve.
  const backupSchemaVersion = Number.isFinite(metadataVersion) && metadataVersion > 0
    ? metadataVersion
    : pragmaVersion;
  const currentDb = getDatabase();
  const currentVersion = getCurrentSchemaVersion();
  // Never let restoring an older snapshot resurrect a token that was revoked
  // after that snapshot was created.
  const preservedRevocations = readRevocations(currentDb);
  const preservedUserSecurity = captureUserSecurityState(currentDb);
  const preservedUserStations = captureUserStationSecurityState(currentDb);
  const preservedStationSecurity = captureKitchenStationSecurityState(currentDb);
  const preservedKdsEnabled = captureKdsEnabledSetting(currentDb);
  const preservedProtectedSettings = captureRestoreProtectedSettings(currentDb);
  const preservedOutboxes = captureRestoreOutboxState(currentDb);

  console.log(`[DB] Backup schema version: ${backupSchemaVersion}, SQLite: ${pragmaVersion}, Current: ${currentVersion}`);

  if (metadataStampPresent && (metadataVersion <= 0 || metadataVersion !== pragmaVersion)) {
    return {
      success: false,
      mode: forceDirect ? 'direct' : 'data_only',
      backupSchemaVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored: 0,
      error: 'Backup schema metadata does not match the SQLite header',
    };
  }

  if (forceDirect && pragmaVersion > currentVersion) {
    return {
      success: false,
      mode: 'direct',
      backupSchemaVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored: 0,
      error: `Direct restore rejected: backup schema v${pragmaVersion} is newer than supported schema v${currentVersion}`,
    };
  }

  if (forceDirect || backupSchemaVersion === currentVersion) {
    const baselineForeignKeyViolations = getForeignKeyViolationKeys(currentDb);
    const validationError = validateDirectBackup(backupPath, currentDb, currentVersion, baselineForeignKeyViolations);
    if (validationError) {
      return {
        success: false,
        mode: 'direct',
        backupSchemaVersion,
        currentSchemaVersion: currentVersion,
        tablesRestored: 0,
        error: validationError,
      };
    }

    console.log('[DB] restoreBackup: Direct restore (same schema version)');
    const dbPath = getDbPath();
    const recoveryPath = path.join(getBackupDir(), `flo-restore-recovery-${crypto.randomBytes(8).toString('hex')}.db`);
    const journalPath = recoveryPath.replace(/\.db$/, '.json');

    let recoveryCopyReady = false;
    let recoveryCompleted = false;
    try {
      // Checkpoint the live WAL before making a synchronous recovery copy.
      currentDb.pragma('wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(dbPath, recoveryPath);
      syncFile(recoveryPath);
      writeReplacementJournal(journalPath, {
        phase: 'prepared', recoveryPath, dbPath,
        baselineForeignKeyViolations: [...baselineForeignKeyViolations],
      });
      recoveryCopyReady = true;
      closeDatabase();
      const removeFailures = removeDatabaseFiles(dbPath);
      if (removeFailures.length > 0) {
        throw new Error(`Could not remove database files: ${removeFailures.join(', ')}`);
      }
      fs.copyFileSync(backupPath, dbPath);
      initDatabase(false);

      const freshDb = getDatabase();
      mergeUserSecurityState(freshDb, preservedUserSecurity);
      mergeUserStationSecurityState(freshDb, preservedUserStations, preservedUserSecurity.map((row) => row.id), preservedStationSecurity);
      mergeKdsEnabledSetting(freshDb, preservedKdsEnabled);
      mergeRestoreProtectedSettings(freshDb, preservedProtectedSettings);
      freshDb.prepare('DELETE FROM kds_pairing_tokens').run();
      mergeRestoreOutboxState(freshDb, preservedOutboxes);
      mergeRevocations(freshDb, preservedRevocations);
      const integrity = freshDb.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
      const newForeignKeyViolations = [...getForeignKeyViolationKeys(freshDb)]
        .filter((key) => !baselineForeignKeyViolations.has(key));
      if (
        integrity.some((row) => row.integrity_check !== 'ok') ||
        newForeignKeyViolations.length > 0
      ) {
        throw new Error('Restored database failed integrity validation');
      }
      freshDb.pragma('wal_checkpoint(TRUNCATE)');
      syncFile(dbPath);
      if (!syncDirectory(path.dirname(dbPath)) && process.platform !== 'win32') {
        throw new Error('Could not durably commit restored database');
      }
      writeReplacementJournal(journalPath, {
        phase: 'committed', recoveryPath, dbPath,
        baselineForeignKeyViolations: [...baselineForeignKeyViolations],
      });
      return {
        success: true,
        mode: 'direct',
        backupSchemaVersion,
        currentSchemaVersion: currentVersion,
        tablesRestored: getTables(freshDb).length,
      };
    } catch (error: any) {
      // A corrupt/incompatible same-version file must not strand the live
      // database. Restore the checkpointed safety copy before rethrowing.
      if (!recoveryCopyReady) throw error;
      try {
        closeDatabase();
        const recoveryRemoveFailures = removeDatabaseFiles(dbPath);
        if (recoveryRemoveFailures.length > 0) {
          throw new Error(`Could not remove database files during recovery: ${recoveryRemoveFailures.join(', ')}`);
        }
        fs.copyFileSync(recoveryPath, dbPath);
        syncFile(dbPath);
        if (!syncDirectory(path.dirname(dbPath)) && process.platform !== 'win32') {
          throw new Error('Could not durably recover direct-restore database');
        }
        initDatabase(false);
        recoveryCompleted = true;
      } catch (recoveryError: any) {
        throw new Error(
          `Direct restore failed: ${error?.message || 'unknown error'}; ` +
          `live database recovery failed: ${recoveryError?.message || 'unknown error'}`,
        );
      }
      throw error;
    } finally {
      if (recoveryCompleted) {
        removeReplacementArtifacts(journalPath, recoveryPath);
      } else if (isHealthyDatabaseFile(dbPath, baselineForeignKeyViolations, false)
        && isHealthyDatabaseFile(recoveryPath, baselineForeignKeyViolations, false)) {
        // A committed journal is finalized here; an uncommitted journal is
        // intentionally retained if recovery itself failed.
        try {
          const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as ReplacementJournal;
          if (journal.phase === 'committed') removeReplacementArtifacts(journalPath, recoveryPath);
        } catch { }
      }
    }
  }

  console.log('[DB] restoreBackup: Data-only restore (schema version mismatch)');
  return dataOnlyRestore(backupPath, backupSchemaVersion, currentVersion, preservedRevocations, preservedUserSecurity, preservedUserStations, preservedStationSecurity, preservedKdsEnabled, preservedProtectedSettings, preservedOutboxes);
}

/** Return stable keys for existing FK violations so legacy dirty data can be preserved without accepting new damage. */
export function getForeignKeyViolationKeys(dbInstance: Database.Database): Set<string> {
  const rows = dbInstance.prepare('PRAGMA foreign_key_check').all() as { table: string; rowid: number | string | null; parent: string; fkid: number }[];
  const keys = new Set<string>();
  for (const row of rows) {
    let identity: unknown = row.rowid;
    try {
      const tableInfo = dbInstance.prepare(`PRAGMA table_info("${row.table.replace(/"/g, '""')}")`).all() as { name: string; pk: number }[];
      const primaryKeys = tableInfo.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
      const columns = primaryKeys.map((column) => `"${column.name.replace(/"/g, '""')}"`);
      const foreignKey = (dbInstance.prepare(`PRAGMA foreign_key_list("${row.table.replace(/"/g, '""')}")`).all() as { id: number; from: string }[])
        .filter((entry) => entry.id === row.fkid)
        .map((entry) => entry.from);
      const selectedColumns = [...new Set([...columns, ...foreignKey.map((column) => `"${column.replace(/"/g, '""')}"`)])];
      if (selectedColumns.length > 0 && row.rowid != null) {
        const values = dbInstance.prepare(`SELECT ${selectedColumns.join(', ')} FROM "${row.table.replace(/"/g, '""')}" WHERE rowid = ?`).get(row.rowid) as Record<string, unknown> | undefined;
        if (values) identity = {
          primary: primaryKeys.map((column) => values[column.name]),
          foreign: foreignKey.map((column) => values[column]),
        };
      }
    } catch { }
    keys.add(JSON.stringify([row.table, identity, row.parent, row.fkid]));
  }
  return keys;
}

/** Return true only if the string is a safe SQL identifier (letters, digits, underscore). */
export function isSafeIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function materializeRestoreSource(sourcePath: string, livePath: string): string {
  const sourceStat = fs.lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new Error('Restore source must be a regular file');
  if (pathEntryExists(`${sourcePath}-wal`) || pathEntryExists(`${sourcePath}-shm`)) throw new Error('Restore source must not have SQLite sidecars');
  if ([livePath, `${livePath}-wal`, `${livePath}-shm`].some((liveTarget) => isLiveDatabaseTarget(sourcePath, liveTarget))) {
    throw new Error('Restore source cannot be the live database or its SQLite sidecars');
  }
  const sourceFd = fs.openSync(sourcePath, fs.constants.O_RDONLY | ((fs.constants as any).O_NOFOLLOW || 0));
  try {
    const openedStat = fs.fstatSync(sourceFd);
    if (openedStat.dev !== sourceStat.dev || openedStat.ino !== sourceStat.ino || openedStat.size !== sourceStat.size) {
      throw new Error('Restore source changed while it was being opened');
    }
    const liveStat = fs.lstatSync(livePath);
    if (openedStat.dev === liveStat.dev && openedStat.ino === liveStat.ino) throw new Error('Restore source cannot be the live database');
    const sourceBytes = fs.readFileSync(sourceFd);
    const finalStat = fs.fstatSync(sourceFd);
    if (finalStat.dev !== openedStat.dev || finalStat.ino !== openedStat.ino || finalStat.size !== openedStat.size || finalStat.mtimeMs !== openedStat.mtimeMs) {
      throw new Error('Restore source changed while it was being read');
    }
    if (pathEntryExists(`${sourcePath}-wal`) || pathEntryExists(`${sourcePath}-shm`)) {
      throw new Error('Restore source acquired SQLite sidecars while it was being read');
    }
    const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-restore-source-'));
    const snapshotPath = path.join(snapshotDir, 'source.db');
    fs.writeFileSync(snapshotPath, sourceBytes, { flag: 'wx', mode: 0o600 });
    setImmediate(() => { try { fs.rmSync(snapshotDir, { recursive: true, force: true }); } catch { } });
    return snapshotPath;
  } finally {
    fs.closeSync(sourceFd);
  }
}

function dataOnlyRestore(
  backupPath: string,
  backupVersion: number,
  currentVersion: number,
  preservedRevocations: RevocationRow[] = [],
  preservedUserSecurity: UserSecurityState[] = [],
  preservedUserStations: UserStationSecurityState[] = [],
  preservedStationSecurity: KitchenStationSecurityState[] = [],
  preservedKdsEnabled: KdsEnabledSettingState = { present: false, value: null },
  preservedProtectedSettings: RestoreProtectedSettingState[] = [],
  preservedOutboxes: RestoreOutboxState = { cloud: [], support: [], diagnostics: [] },
): RestoreResult {
  const livePath = getDbPath();
  if ([livePath, `${livePath}-wal`, `${livePath}-shm`].some((liveTarget) => isLiveDatabaseTarget(backupPath, liveTarget))) {
    return {
      success: false,
      mode: 'data_only',
      backupSchemaVersion: backupVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored: 0,
      error: 'Data-only restore source cannot be the live database or its SQLite sidecars',
    };
  }
  try {
    backupPath = materializeRestoreSource(backupPath, livePath);
  } catch (error: any) {
    return {
      success: false,
      mode: 'data_only',
      backupSchemaVersion: backupVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored: 0,
      error: error?.message || 'Invalid data-only restore source',
    };
  }
  let backupDb: Database.Database | undefined;
  let backupTables: string[] = [];
  const backupColumns = new Map<string, string[]>();
  try {
    backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    backupTables = getTables(backupDb);
    for (const tableName of backupTables) {
      if (isSafeIdentifier(tableName)) backupColumns.set(tableName, getColumns(backupDb, tableName));
    }
  } finally {
    backupDb?.close();
  }

  const currentDb = getDatabase();
  const baselineForeignKeyViolations = getForeignKeyViolationKeys(currentDb);
  const currentTables = getTables(currentDb);
  const commonTables = backupTables.filter((tableName) => currentTables.includes(tableName));
  const previousForeignKeys = Number(currentDb.pragma('foreign_keys', { simple: true })) === 1;
  let attached = false;
  let inTransaction = false;
  let tablesRestored = 0;

  // Existing failed versions of this function could strand this alias on the
  // long-lived connection. Remove it before attempting a fresh restore.
  try {
    const attachedDatabases = currentDb.prepare('PRAGMA database_list').all() as { name: string }[];
    if (attachedDatabases.some((entry) => entry.name === '_restore_src')) {
      currentDb.exec('DETACH DATABASE _restore_src');
    }
  } catch (error: any) {
    return {
      success: false,
      mode: 'data_only',
      backupSchemaVersion: backupVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored: 0,
      error: `Could not clear a previous restore attachment: ${error?.message || 'unknown error'}`,
    };
  }

  try {
    // FK enforcement must be disabled before BEGIN. With it off, deleting a
    // common parent does not cascade-delete current-only child tables that an
    // older backup does not contain. The final check below protects commit.
    currentDb.pragma('foreign_keys = OFF');
    const safeBackupPath = backupPath.replace(/'/g, "''");
    currentDb.exec(`ATTACH DATABASE '${safeBackupPath}' AS _restore_src`);
    attached = true;
    currentDb.exec('BEGIN IMMEDIATE');
    inTransaction = true;

    for (const tableName of commonTables) {
      if (!isSafeIdentifier(tableName)) {
        console.warn(`[DB] dataOnlyRestore: skipping unsafe table: ${JSON.stringify(tableName)}`);
        continue;
      }

      const currentColumns = getColumns(currentDb, tableName);
      const commonColumns = (backupColumns.get(tableName) || [])
        .filter((column) => currentColumns.includes(column))
        .filter((column) => {
          if (isSafeIdentifier(column)) return true;
          console.warn(`[DB] dataOnlyRestore: skipping unsafe column: ${JSON.stringify(column)} in ${tableName}`);
          return false;
        });

      if (commonColumns.length === 0) continue;

      const columnList = commonColumns.join(', ');
      currentDb.exec(`DELETE FROM ${tableName}`);
      currentDb.exec(`INSERT INTO ${tableName} (${columnList}) SELECT ${columnList} FROM _restore_src.${tableName}`);

      tablesRestored++;
      console.log(`[DB] Restored ${tableName}: ${commonColumns.length} columns`);
    }

    mergeUserSecurityState(currentDb, preservedUserSecurity);
    mergeUserStationSecurityState(currentDb, preservedUserStations, preservedUserSecurity.map((row) => row.id), preservedStationSecurity);
    mergeKdsEnabledSetting(currentDb, preservedKdsEnabled);
    mergeRestoreProtectedSettings(currentDb, preservedProtectedSettings);
    currentDb.prepare('DELETE FROM kds_pairing_tokens').run();
    mergeRestoreOutboxState(currentDb, preservedOutboxes);
    mergeRevocations(currentDb, preservedRevocations);
    const newForeignKeyViolations = [...getForeignKeyViolationKeys(currentDb)]
      .filter((key) => !baselineForeignKeyViolations.has(key));
    if (newForeignKeyViolations.length > 0) {
      throw new Error(`Restore would introduce ${newForeignKeyViolations.length} new foreign-key violation(s)`);
    }

    // SQLite does not allow DETACH while a write transaction is active.
    // Commit only after the integrity check, then detach the already-closed
    // source handle immediately so the long-lived connection stays clean.
    currentDb.exec('COMMIT');
    inTransaction = false;
    try {
      currentDb.exec('DETACH DATABASE _restore_src');
      attached = false;
    } catch (detachError: any) {
      // Once committed, a detach failure cannot be rolled back. Reopening the
      // main connection drops every attachment and gives the caller a clean,
      // usable handle instead of reporting a false failure with live data
      // already changed.
      try {
        closeDatabase();
        initDatabase(false);
        attached = false;
      } catch (recoveryError: any) {
        throw new Error(
          `Restore committed but source cleanup failed: ${detachError?.message || 'unknown error'}; ` +
          `database reopen also failed: ${recoveryError?.message || 'unknown error'}`,
        );
      }
    }

    return {
      success: true,
      mode: 'data_only',
      backupSchemaVersion: backupVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored,
    };
  } catch (error: any) {
    let cleanupFailure: unknown = null;
    if (inTransaction) {
      try { currentDb.exec('ROLLBACK'); } catch (rollbackError) { cleanupFailure = rollbackError; }
      inTransaction = false;
    }
    if (attached) {
      try {
        currentDb.exec('DETACH DATABASE _restore_src');
        attached = false;
      } catch (detachError) {
        cleanupFailure = cleanupFailure || detachError;
      }
    }
    if (cleanupFailure) {
      try {
        closeDatabase();
        initDatabase(false);
        attached = false;
      } catch (recoveryError: any) {
        error = new Error(
          `${error?.message || 'Restore failed'}; cleanup failed: ${cleanupFailure instanceof Error ? cleanupFailure.message : 'unknown error'}; ` +
          `database reopen failed: ${recoveryError?.message || 'unknown error'}`,
        );
      }
    }
    console.error('[DB] dataOnlyRestore failed:', error);
    return {
      success: false,
      mode: 'data_only',
      backupSchemaVersion: backupVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored: 0,
      error: error?.message || 'Restore failed',
    };
  } finally {
    if (attached) {
      try { currentDb.exec('DETACH DATABASE _restore_src'); } catch { }
    }
    try {
      getDatabase().pragma(`foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
    } catch { }
  }
}


export function getSchemaVersionFromBackup(backupPath: string): number | null {
  let backupDb: Database.Database | undefined;
  try {
    backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    const metaRow = backupDb.prepare(`SELECT value FROM _flo_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    if (!metaRow) return null;
    const version = Number.parseInt(metaRow.value, 10);
    return Number.isFinite(version) && version >= 0 ? version : null;
  } catch {
    return null;
  } finally {
    backupDb?.close();
  }
}

export function getCurrentSchemaVersion(): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Builds a throwaway in-memory database by running the exact same
 * createSchema()+MIGRATIONS pipeline a real fresh install takes. This is the
 * "ideal" schema reference for the DB health check — deriving it from the
 * live migration pipeline (instead of hand-maintaining a second schema spec)
 * guarantees it can never drift from what main/db.ts actually produces.
 *
 * Temporarily swaps the module-level `db` binding since createSchema()/
 * runMigrations() operate on it directly. Safe because better-sqlite3 is
 * fully synchronous and Node is single-threaded — nothing else can observe
 * the swapped binding as long as this function doesn't yield to the event loop.
 * Caller owns the returned handle and must call .close() on it.
 */
export function buildIdealSchemaDb(): Database.Database {
  const idealDb = new Database(':memory:');
  idealDb.pragma('foreign_keys = OFF'); // Off during migrations
  const previousDb = db;
  db = idealDb;
  try {
    buildingIdealSchema = true;
    runMigrations();
  } finally {
    buildingIdealSchema = false;
    db = previousDb;
  }
  idealDb.pragma('foreign_keys = ON');
  return idealDb;
}

// ─── Migration registry ───────────────────────────────────────────────────────
// Each entry runs exactly once, in order, wrapped in a transaction.
// To add a schema change: append a new entry. Never edit existing entries.

export const MIGRATIONS: { version: number; name: string; up: () => void }[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: () => {
      createSchema();
      seedInstallDefaults();
    },
  },
  {
    version: 2,
    name: 'hash_plaintext_pins',
    up: () => {
      // Migrate from plaintext PINs to hashed PINs.
      // New installs going forward store only pin_hash.
      const userColumns = getColumns(db, 'users');
      if (!userColumns.includes('pin_hash')) {
        db.exec(`ALTER TABLE users ADD COLUMN pin_hash TEXT`);
      }

      if (!userColumns.includes('pin')) return;

      const usersWithPin = db.prepare('SELECT id, pin FROM users WHERE pin IS NOT NULL').all() as { id: string; pin: string }[];
      for (const user of usersWithPin) {
        const pin = String(user.pin || '');
        if (!pin) continue;
        // Already a bcrypt hash?
        if (pin.startsWith('$2')) continue;
        db.prepare('UPDATE users SET pin_hash = ?, pin = NULL WHERE id = ?')
          .run(bcrypt.hashSync(pin, 10), user.id);
      }
    },
  },
  {
    version: 3,
    name: 'cloud_identity_and_outbox',
    up: () => {
      createCloudSyncSchema();
      seedCloudSyncDefaults();
    },
  },
  {
    version: 4,
    name: 'add_notes_limits_settings',
    up: () => {
      insertSettingIfMissing('max_order_notes_length', '200');
      insertSettingIfMissing('max_item_notes_length', '100');
    },
  },
  {
    version: 5,
    name: 'add_print_logs_table',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS print_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bill_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          printed_at TEXT DEFAULT CURRENT_TIMESTAMP,
          print_type TEXT DEFAULT 'receipt',
          FOREIGN KEY (bill_id) REFERENCES bills(id),
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);
    },
  },
  {
    version: 6,
    name: 'add_loyalty_settings',
    up: () => {
      insertSettingIfMissing('loyalty_enabled', 'true');
      insertSettingIfMissing('loyalty_points_per_currency', '1');
      insertSettingIfMissing('loyalty_redemption_rate', '100');
      insertSettingIfMissing('loyalty_max_balance_enabled', '0');
      insertSettingIfMissing('loyalty_max_balance_points', '10000');
      insertSettingIfMissing('loyalty_expiry_enabled', '0');
      insertSettingIfMissing('loyalty_expiry_months', '6');
      insertSettingIfMissing('loyalty_min_redemption', '100');
      insertSettingIfMissing('loyalty_max_redemption_percentage', '50');
    },
  },
  {
    version: 7,
    name: 'add_discount_settings',
    up: () => {
      insertSettingIfMissing('discount_mode', 'percentage');
      insertSettingIfMissing('discount_requires_approval', '0');
      insertSettingIfMissing('discount_max_percentage', '25');
      insertSettingIfMissing('discount_max_amount', '0');
    },
  },
  {
    version: 8,
    name: 'add_loyalty_index',
    up: () => {
      db.exec('CREATE INDEX IF NOT EXISTS idx_loyalty_customer ON loyalty_ledger(customer_id, type)');
    },
  },
  {
    version: 9,
    name: 'add_sequences_table',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sequences (
          name TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          current_value INTEGER NOT NULL DEFAULT 0
        )
      `);
    },
  },
  {
    version: 10,
    name: 'fix_sequences_composite_key',
    up: () => {
      // v9 used `name TEXT PRIMARY KEY` but the code needs (name, date) as a
      // composite key. Drop and recreate with the correct schema.
      db.exec(`DROP TABLE IF EXISTS sequences`);
      db.exec(`
        CREATE TABLE sequences (
          name TEXT NOT NULL,
          date TEXT NOT NULL,
          current_value INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (name, date)
        )
      `);
    },
  },
  {
    version: 11,
    name: 'first_run_setup_uses_welcome_form',
    up: () => {
      // Intentionally no-op. Fresh installs must remain uninitialized so the
      // local welcome form can create the first owner account.
    },
  },
  {
    version: 12,
    name: 'fix_table_integer_ids',
    up: () => {
      // Non-destructive migration: convert integer table IDs to strings.
      // Some tables were created before POST /tables was fixed (Task 1),
      // so they got SQLite rowid integers instead of 'tbl-...' strings.
      db.exec(`UPDATE tables SET id = 'tbl-' || id WHERE typeof(id) = 'integer'`);
    },
  },
  {
    version: 13,
    name: 'fix_null_table_ids',
    up: () => {
      // Fix tables with NULL ids caused by old INSERT without id column.
      // SQLite stored NULL instead of generating an id.
      //
      // Generate string IDs using rowid for existing tables with NULL ids
      db.exec(`UPDATE tables SET id = 'tbl-' || rowid WHERE id IS NULL`);

      // Also catch any integer ids that slipped through v12
      db.exec(`UPDATE tables SET id = 'tbl-' || id WHERE typeof(id) = 'integer'`);
    },
  },
  {
    version: 14,
    name: 'simplify_loyalty_settings',
    up: () => {
      // Loyalty program is now a single on/off switch — earning rate comes from
      // each product's own cb_percent, and redemption uses a fixed in-code rate.
      // Drop the now-unused tuning settings; keep only loyalty_enabled.
      db.exec(`
        DELETE FROM settings WHERE key IN (
          'loyalty_points_per_currency',
          'loyalty_redemption_rate',
          'loyalty_max_balance_enabled',
          'loyalty_max_balance_points',
          'loyalty_expiry_enabled',
          'loyalty_expiry_months',
          'loyalty_min_redemption',
          'loyalty_max_redemption_percentage',
          'loyalty_expiry_days'
        )
      `);
      const customerCols = db.prepare(`PRAGMA table_info(customers)`).all() as { name: string }[];
      if (customerCols.some((c) => c.name === 'loyalty_points')) {
        db.exec(`ALTER TABLE customers DROP COLUMN loyalty_points`);
      }
    },
  },
  {
    version: 15,
    name: 'add_instagram_handle_setting',
    up: () => {
      insertSettingIfMissing('instagram_handle', '');
    },
  },
  {
    version: 16,
    name: 'add_terms_accepted_at_to_users',
    up: () => {
      const userColumns = getColumns(db, 'users');
      if (!userColumns.includes('terms_accepted_at')) {
        db.exec(`ALTER TABLE users ADD COLUMN terms_accepted_at TEXT`);
      }
    },
  },
  {
    version: 17,
    name: 'add_held_orders_table',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS held_orders (
          id TEXT PRIMARY KEY,
          table_id TEXT NOT NULL,
          items TEXT NOT NULL,
          customer_id TEXT,
          guest_count INTEGER DEFAULT 1,
          order_notes TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
  {
    version: 18,
    name: 'fix_null_category_ids',
    up: () => {
      // Same bug as v13's fix_null_table_ids: POST /categories inserted without
      // the id column, and categories.id (TEXT PRIMARY KEY, not a rowid alias)
      // silently accepted NULL. Backfill so these rows become deletable and
      // stop colliding with the "All" filter (which also compares against null).
      db.exec(`UPDATE categories SET id = 'cat-' || rowid WHERE id IS NULL`);
    },
  },
  {
    version: 19,
    name: 'backfill_product_cb_percent_and_tags',
    up: () => {
      // cb_percent/tags were added to createSchema() (CREATE TABLE IF NOT EXISTS)
      // back when v1-v7 -> v8 was still a destructive dropAllTables()+recreate
      // migration. Once migrations became incremental (non-destructive), no
      // ALTER TABLE ever backfilled these columns onto pre-v8 installs that
      // updated straight through — so POST /products 500s with "table products
      // has no column named cb_percent" on any DB that never got the columns.
      const productColumns = getColumns(db, 'products');
      if (!productColumns.includes('cb_percent')) {
        db.exec(`ALTER TABLE products ADD COLUMN cb_percent REAL DEFAULT 0`);
      }
      if (!productColumns.includes('tags')) {
        db.exec(`ALTER TABLE products ADD COLUMN tags TEXT`);
      }
    },
  },
  {
    version: 20,
    name: 'add_tables_is_active',
    up: () => {
      // Tables were hard-deleted, orphaning orders.table_id/held_orders.table_id
      // on any historical order still pointing at them. Add is_active so tables
      // can be deactivated (like products/categories/staff) instead of destroyed.
      const tableColumns = getColumns(db, 'tables');
      if (!tableColumns.includes('is_active')) {
        db.exec(`ALTER TABLE tables ADD COLUMN is_active INTEGER DEFAULT 1`);
      }
    },
  },
  {
    version: 21,
    name: 'clear_legacy_loyalty_expiry',
    up: () => {
      // v14 turned off expiry for new loyalty points, but left expires_at on
      // pre-existing ledger rows untouched. Since wallet balance nets all-time
      // debits against only unexpired credits, a legacy credit hitting its old
      // expiry date silently drops out of the credit sum while the debits that
      // already spent it stay — collapsing the customer's balance. Clearing
      // expires_at retroactively aligns legacy rows with the non-expiry policy.
      db.exec(`UPDATE loyalty_ledger SET expires_at = NULL WHERE expires_at IS NOT NULL`);
    },
  },
  {
    version: 22,
    name: 'add_customers_phone_digits',
    up: () => {
      if (!getColumns(db, 'customers').includes('phone_digits')) {
        db.exec(`
          ALTER TABLE customers ADD COLUMN phone_digits TEXT
            GENERATED ALWAYS AS (
              CASE WHEN phone IS NULL THEN NULL
                   ELSE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '')
              END
            ) VIRTUAL
        `);
      }
    },
  },
  {
    version: 23,
    name: 'normalize_customer_phones',
    up: () => {
      // country_code only exists in createSchema()'s CREATE TABLE, which is
      // a no-op (IF NOT EXISTS) for any install whose customers table
      // predates that column being added — this migration is the first
      // thing to actually read/write it, and was crashing with "no such
      // column: country_code" on every such upgrade (reported on a fresh
      // Windows install of v1.9.7). Guard it here instead of assuming it's
      // there.
      if (!getColumns(db, 'customers').includes('country_code')) {
        db.exec(`ALTER TABLE customers ADD COLUMN country_code TEXT DEFAULT '+91'`);
      }

      const tenantCountryRow = db.prepare("SELECT value FROM settings WHERE key = 'country'").get() as any;
      const tenantCountry = tenantCountryRow?.value || 'IN';
      
      const { parsePhoneE164 } = require('./lib/phone');

      const customers = db.prepare(
        "SELECT id, phone, country_code FROM customers WHERE phone IS NOT NULL AND phone != ''"
      ).all() as any[];

      let normalized = 0, unparseable = 0;

      for (const c of customers) {
        const parsed = parsePhoneE164(c.phone, tenantCountry);
        if (parsed) {
          db.prepare('UPDATE customers SET phone = ?, country_code = ? WHERE id = ?')
            .run(parsed.e164, parsed.countryCode, c.id);
          normalized++;
        } else {
          console.log(`[MIGRATION v23] unparseable: ${c.id} ${c.phone}`);
          unparseable++;
        }
      }
      console.log(`[MIGRATION v23] normalized: ${normalized}, unparseable: ${unparseable}`);

      const dupes = db.prepare(`
        SELECT phone_digits, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
        FROM customers
        WHERE phone_digits IS NOT NULL AND phone_digits != ''
        GROUP BY phone_digits
        HAVING cnt > 1
      `).all() as any[];

      let merged = 0;

      for (const group of dupes) {
        const ids = group.ids.split(',').sort();
        const allRows = db.prepare(
          `SELECT * FROM customers WHERE id IN (${ids.map(() => '?').join(',')})
           ORDER BY created_at ASC, id ASC`
        ).all(...ids) as any[];

        const winner = allRows[0];
        const losers = allRows.slice(1);

        const coalesceFields = ['email', 'address', 'notes', 'country_code'];
        for (const loser of losers) {
          for (const field of coalesceFields) {
            if (!winner[field] && loser[field]) {
              winner[field] = loser[field];
            }
          }
        }

        db.prepare(`
          UPDATE customers SET email = ?, address = ?, notes = ?, country_code = ?, updated_at = ?
          WHERE id = ?
        `).run(winner.email, winner.address, winner.notes, winner.country_code, now(), winner.id);

        const fkTables = ['orders', 'bills', 'held_orders', 'loyalty_ledger'];
        for (const table of fkTables) {
          db.prepare(`UPDATE ${table} SET customer_id = ? WHERE customer_id IN (${losers.map(() => '?').join(',')})`)
            .run(winner.id, ...losers.map((l: any) => l.id));
        }

        const loserIds = losers.map((l: any) => l.id);
        db.prepare(`DELETE FROM customers WHERE id IN (${loserIds.map(() => '?').join(',')})`)
          .run(...loserIds);

        console.log(`[MIGRATION v23] merged ${loserIds.join(',')} → ${winner.id} (phone: ${winner.phone})`);
        merged += losers.length;
      }
      console.log(`[MIGRATION v23] merged ${merged} duplicate customer(s)`);

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone_digits_unique
        ON customers(phone_digits)
        WHERE phone_digits IS NOT NULL AND phone_digits != ''
      `);
      
      const total = db.prepare('SELECT COUNT(*) as cnt FROM customers').get() as { cnt: number };
      const nonE164 = db.prepare(
        "SELECT COUNT(*) as cnt FROM customers WHERE phone IS NOT NULL AND phone != '' AND phone NOT LIKE '+%'"
      ).get() as { cnt: number };
      console.log(`[MIGRATION v23] verification: ${total.cnt} customers, ${nonE164.cnt} still non-E.164`);
      if (nonE164.cnt > 0) {
        console.warn(`[MIGRATION v23] WARNING: ${nonE164.cnt} customers have unparseable phones (preserved as raw)`);
      }
    },
  },
  {
    version: 24,
    name: 'normalize_customer_phones_retry',
    up: () => {
      const tenantCountryRow = db.prepare("SELECT value FROM settings WHERE key = 'country'").get() as any;
      const tenantCountry = tenantCountryRow?.value || 'IN';

      const { parsePhoneE164 } = require('./lib/phone');

      const customers = db.prepare(
        "SELECT id, phone, country_code FROM customers WHERE phone IS NOT NULL AND phone != ''"
      ).all() as any[];

      let normalized = 0, unparseable = 0;

      for (const c of customers) {
        const parsed = parsePhoneE164(c.phone, tenantCountry);
        if (parsed && parsed.e164 !== c.phone) {
          db.prepare('UPDATE customers SET phone = ?, country_code = ? WHERE id = ?')
            .run(parsed.e164, parsed.countryCode, c.id);
          normalized++;
        } else if (!parsed) {
          unparseable++;
        }
      }
      console.log(`[MIGRATION v24] normalized: ${normalized}, unparseable: ${unparseable}`);
    },
  },
  {
    version: 25,
    name: 'add_order_item_addons_table',
    up: () => {
      // Selected addons are snapshotted as JSON on order_items.addons. That
      // works for print/receipt display but makes addon reporting ("addons
      // sold by day/product/station") require JSON parsing instead of
      // indexed SQL, and ambiguous parsed-vs-raw-JSON typing already caused
      // a KOT print failure (see 02a511e). Add a normalized snapshot table
      // and backfill it from existing rows. order_items.addons stays the
      // read-path source of truth for now — this migration only adds the
      // table and starts populating it; see issue #125.
      db.exec(`
        CREATE TABLE IF NOT EXISTS order_item_addons (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_item_id INTEGER NOT NULL,
          addon_id TEXT,
          addon_name TEXT NOT NULL,
          price NUMERIC NOT NULL DEFAULT 0,
          quantity INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE,
          FOREIGN KEY (addon_id) REFERENCES addons(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_order_item_addons_order_item_id ON order_item_addons(order_item_id);
        CREATE INDEX IF NOT EXISTS idx_order_item_addons_addon_id ON order_item_addons(addon_id);
      `);

      const rows = db.prepare(
        `SELECT id, addons, created_at FROM order_items WHERE addons IS NOT NULL AND addons != '' AND addons != 'null'`
      ).all() as { id: number; addons: string; created_at: string }[];

      let backfilled = 0, skipped = 0;
      for (const row of rows) {
        let parsed: any;
        try {
          parsed = JSON.parse(row.addons);
        } catch {
          skipped++;
          continue;
        }
        if (!Array.isArray(parsed) || parsed.length === 0) continue;
        insertOrderItemAddons(db, row.id, parsed, row.created_at || now());
        backfilled++;
      }
      console.log(`[MIGRATION v25] backfilled addons for ${backfilled} order items (${skipped} unparseable, skipped)`);
    },
  },
  {
    version: 26,
    name: 'add_kds_default_view',
    up: () => {
      db.prepare(
        `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('kds_default_view', 'tabs', ?)`
      ).run(now());
    },
  },
  {
    version: 27,
    name: 'add_station_printer_link_and_user_stations',
    up: () => {
      // Links a kitchen station to a printer row instead of duplicating
      // ip/port/name inline, and lets a staff login (or shared counter
      // login) be assigned to one or more stations. See issue #134.
      const stationColumns = getColumns(db, 'kitchen_stations');
      if (!stationColumns.includes('printer_id')) {
        db.exec(`ALTER TABLE kitchen_stations ADD COLUMN printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL`);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS station_users (
          user_id TEXT NOT NULL,
          station_id TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, station_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (station_id) REFERENCES kitchen_stations(id) ON DELETE CASCADE
        );
      `);
    },
  },
  {
    version: 28,
    name: 'seed_telemetry_settings',
    up: () => {
      // Installs that ran first-run setup before telemetry was added (v1.9.4)
      // never had these rows written — loadInstallDefaults() only runs on a
      // fresh DB. INSERT OR IGNORE is safe: fresh installs already have them.
      // All default to off so existing installs stay opted-out.
      const t = now();
      db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('anonymous_data_consent', 'false', ?)`).run(t);
      db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('telemetry_enabled', 'false', ?)`).run(t);
      db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('telemetry_scope', 'usage_stats,country,app_version,platform,session_duration,feature_usage,error_diagnostics', ?)`).run(t);
    },
  },
  {
    version: 29,
    name: 'whatsapp_messaging',
    up: () => {
      createWhatsAppSchema();
      seedWhatsAppDefaults();
    },
  },
  {
    version: 30,
    name: 'drop_order_items_addons_json_column',
    up: () => {
      // order_item_addons (v25) has been the sole write target for selected
      // addons for a while now, and every read path was moved onto it in the
      // same release this migration ships in — order_items.addons is no
      // longer written or read anywhere in the app. This is the cleanup: one
      // more backfill sweep (belt-and-braces — v25 already ran, but this
      // catches anything created between then and the dual-write existing,
      // or any hand-edited row), then drop the column outright rather than
      // leave a dead, unused JSON copy sitting in the schema. See issue #125.
      const columns = getColumns(db, 'order_items');
      if (!columns.includes('addons')) return; // already dropped (idempotent re-run)

      const rows = db.prepare(`
        SELECT id, addons, created_at FROM order_items
        WHERE addons IS NOT NULL AND addons != '' AND addons != 'null'
          AND NOT EXISTS (SELECT 1 FROM order_item_addons WHERE order_item_id = order_items.id)
      `).all() as { id: number; addons: string; created_at: string }[];

      let backfilled = 0;
      const unrecoverable: number[] = [];
      for (const row of rows) {
        let parsed: any;
        try {
          parsed = JSON.parse(row.addons);
        } catch {
          unrecoverable.push(row.id);
          continue;
        }
        if (!Array.isArray(parsed) || parsed.length === 0) continue;
        insertOrderItemAddons(db, row.id, parsed, row.created_at || now());
        backfilled++;
      }
      console.log(`[MIGRATION v30] backfilled ${backfilled} order_item(s) still missing a normalized addons snapshot`);

      if (unrecoverable.length > 0) {
        console.warn(`[MIGRATION v30] ${unrecoverable.length} order_item row(s) have unparseable legacy addons JSON (ids: ${unrecoverable.join(', ')}) and could not be migrated. Leaving the addons column in place so this data isn't lost — please review these rows manually.`);
        return;
      }

      const remaining = (db.prepare(`
        SELECT COUNT(*) as count FROM order_items
        WHERE addons IS NOT NULL AND addons != '' AND addons != 'null'
          AND NOT EXISTS (SELECT 1 FROM order_item_addons WHERE order_item_id = order_items.id)
      `).get() as { count: number }).count;

      if (remaining > 0) {
        console.warn(`[MIGRATION v30] ${remaining} order_item row(s) still lack a normalized addons snapshot after backfill — skipping the column drop this run.`);
        return;
      }

      db.exec('ALTER TABLE order_items DROP COLUMN addons');
      console.log('[MIGRATION v30] Dropped order_items.addons — order_item_addons is now the only place selected addons live.');
    },
  },
  {
    version: 31,
    name: 'add_customers_tag_counts_column',
    up: () => {
      // tag_counts, like country_code (fixed in v23's guard above), only
      // ever existed in createSchema()'s CREATE TABLE — no migration added
      // it for installs whose customers table predates it. Unlike
      // country_code this isn't just a startup-migration crash: it's read
      // and written on every order for a returning customer
      // (routes/orders.ts), so any affected install would crash there
      // instead, mid-use rather than at launch.
      if (!getColumns(db, 'customers').includes('tag_counts')) {
        db.exec(`ALTER TABLE customers ADD COLUMN tag_counts TEXT DEFAULT NULL`);
      }
    },
  },
  {
    version: 32,
    name: 'add_kds_and_kot_printing_toggles',
    up: () => {
      // Independent on/off switches for the Kitchen Display System and for
      // KOT ticket printing (issue #133) — not every business runs both.
      // Default 'true' on both to match the pre-toggle always-on behavior
      // existing installs already have.
      insertSettingIfMissing('kds_enabled', 'true');
      insertSettingIfMissing('kot_printing_enabled', 'true');
    },
  },
  {
    version: 33,
    name: 'add_addon_groups_allow_multiple_quantities',
    up: () => {
      if (!getColumns(db, 'addon_groups').includes('allow_multiple_quantities')) {
        db.exec(`ALTER TABLE addon_groups ADD COLUMN allow_multiple_quantities INTEGER DEFAULT 0`);
      }
    },
  },
  {
    version: 34,
    name: 'add_order_items_voided_at',
    up: () => {
      // Issue #150: voiding an in-progress (preparing/ready) item marks it
      // status='voided' instead of hard-cancelling it, so the kitchen display
      // can show it struck-through for a grace period before it drops off the
      // board. voided_at is that timestamp anchor.
      if (!getColumns(db, 'order_items').includes('voided_at')) {
        db.exec(`ALTER TABLE order_items ADD COLUMN voided_at TEXT DEFAULT NULL`);
      }
    },
  },
  {
    version: 35,
    name: 'add_tax_pack_configuration_tables',
    up: () => {
      createTaxPackSchema();
    },
  },
  {
    version: 36,
    name: 'add_product_and_addon_tax_categories',
    up: () => {
      const productColumns = getColumns(db, 'products');
      if (!productColumns.includes('tax_category_id')) {
        db.exec(`ALTER TABLE products ADD COLUMN tax_category_id TEXT DEFAULT NULL`);
      }
      if (!productColumns.includes('tax_behavior')) {
        db.exec(`ALTER TABLE products ADD COLUMN tax_behavior TEXT DEFAULT 'country_default'`);
      }

      const addonColumns = getColumns(db, 'addons');
      if (!addonColumns.includes('tax_category_id')) {
        db.exec(`ALTER TABLE addons ADD COLUMN tax_category_id TEXT DEFAULT NULL`);
      }
      if (!addonColumns.includes('tax_behavior')) {
        db.exec(`ALTER TABLE addons ADD COLUMN tax_behavior TEXT DEFAULT 'country_default'`);
      }
      if (!addonColumns.includes('inherit_parent_tax_category')) {
        db.exec(`ALTER TABLE addons ADD COLUMN inherit_parent_tax_category INTEGER DEFAULT 1`);
      }
    },
  },
  {
    version: 37,
    name: 'add_transaction_tax_snapshots_and_charge_categories',
    up: () => {
      const orderColumns = getColumns(db, 'orders');
      if (!orderColumns.includes('tax_snapshot')) {
        db.exec(`ALTER TABLE orders ADD COLUMN tax_snapshot TEXT DEFAULT NULL`);
      }
      if (!orderColumns.includes('packaging_tax_category_id')) {
        db.exec(`ALTER TABLE orders ADD COLUMN packaging_tax_category_id TEXT DEFAULT NULL`);
      }
      if (!orderColumns.includes('delivery_tax_category_id')) {
        db.exec(`ALTER TABLE orders ADD COLUMN delivery_tax_category_id TEXT DEFAULT NULL`);
      }
      if (!orderColumns.includes('service_charge_tax_category_id')) {
        db.exec(`ALTER TABLE orders ADD COLUMN service_charge_tax_category_id TEXT DEFAULT NULL`);
      }

      if (!getColumns(db, 'order_items').includes('tax_snapshot')) {
        db.exec(`ALTER TABLE order_items ADD COLUMN tax_snapshot TEXT DEFAULT NULL`);
      }
      if (!getColumns(db, 'bills').includes('tax_snapshot')) {
        db.exec(`ALTER TABLE bills ADD COLUMN tax_snapshot TEXT DEFAULT NULL`);
      }
    },
  },
  {
    version: 38,
    name: 'register_bundled_tax_pack_versions',
    up: () => {
      createTaxPackSchema();
      const insertPack = db.prepare(`
        INSERT INTO country_packs (
          id, publisher, country, jurisdiction, active_version_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          publisher = excluded.publisher,
          country = excluded.country,
          jurisdiction = excluded.jurisdiction,
          active_version_id = COALESCE(country_packs.active_version_id, excluded.active_version_id),
          updated_at = excluded.updated_at
      `);
      const insertVersion = db.prepare(`
        INSERT OR IGNORE INTO country_pack_versions (
          id, pack_id, version, schema_version, manifest_json, pack_json, digest, signature,
          effective_from, effective_to, min_flo_version, published_at, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'active', ?)
      `);
      const insertCategory = db.prepare(`
        INSERT OR IGNORE INTO tax_categories (
          id, pack_version_id, category_id, label, default_behavior, definition_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertRule = db.prepare(`
        INSERT OR IGNORE INTO tax_rules (
          id, pack_version_id, rule_id, label, calculation_type, rate, amount,
          applies_per, base_rule_ids, definition_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const pack of BUNDLED_COUNTRY_PACKS) {
        const versionId = bundledPackVersionId(pack);
        const packJson = JSON.stringify(pack);
        const installedAt = now();
        const alreadyInstalled = db.prepare(
          'SELECT 1 FROM country_pack_versions WHERE id = ?'
        ).get(versionId);

        insertPack.run(
          pack.id, pack.publisher, pack.country, pack.jurisdiction,
          versionId, installedAt, installedAt,
        );
        insertVersion.run(
          versionId,
          pack.id,
          pack.version,
          pack.schemaVersion,
          JSON.stringify({
            id: pack.id,
            publisher: pack.publisher,
            country: pack.country,
            jurisdiction: pack.jurisdiction,
            version: pack.version,
            publishedAt: pack.publishedAt,
          }),
          packJson,
          sha256Hex(packJson),
          pack.effectiveFrom,
          pack.effectiveTo || null,
          pack.minFloVersion,
          pack.publishedAt,
          installedAt,
        );

        for (const category of pack.categories) {
          insertCategory.run(
            `${versionId}:category:${category.id}`,
            versionId,
            category.id,
            category.label,
            category.defaultBehavior || null,
            JSON.stringify(category),
            installedAt,
          );
        }
        for (const rule of pack.rules) {
          insertRule.run(
            `${versionId}:rule:${rule.id}`,
            versionId,
            rule.id,
            rule.label,
            rule.type,
            rule.rate || null,
            rule.amount || null,
            rule.appliesPer || null,
            JSON.stringify(rule.baseRuleIds || []),
            JSON.stringify(rule),
            installedAt,
          );
        }

        if (!alreadyInstalled) {
          db.prepare(`
            INSERT INTO tax_config_audit (
              action, pack_id, pack_version_id, details_json, created_at
            ) VALUES ('install_bundled_pack', ?, ?, ?, ?)
          `).run(
            pack.id,
            versionId,
            JSON.stringify({ source: 'application_bundle', version: pack.version }),
            installedAt,
          );
        }
      }
    },
  },
  {
    version: 39,
    name: 'add_users_tokens_valid_after',
    up: () => {
      // Backs the JWT-revocation-on-credential-change fix (#173): requireAuth
      // rejects any token whose `iat` predates this `tokens_valid_after`, so changing a
      // password/PIN can invalidate every outstanding session for that user
      // without maintaining a per-token blocklist across devices.
      if (!getColumns(db, 'users').includes('tokens_valid_after')) {
        db.exec(`ALTER TABLE users ADD COLUMN tokens_valid_after TEXT DEFAULT NULL`);
      }
    },
  },
  {
    version: 40,
    name: 'v2_cloud_defaults_and_tax_toggle',
    up: () => {
      // Seed-written timestamps use SQLite's format without T. An ISO
      // timestamp means the merchant explicitly changed the setting.
      db.prepare(`
        UPDATE settings
           SET value = '1', updated_at = ?
         WHERE key = 'cloud_sync_enabled'
           AND value = '0'
           AND updated_at NOT LIKE '%T%'
      `).run(now());
      db.prepare(`DELETE FROM settings WHERE key = 'cloud_pending_store_id'`).run();
      insertSettingIfMissing('taxes_enabled', 'false');
    },
  },
  {
    version: 41,
    name: 'support_ticket_outbox',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS support_ticket_outbox (
          client_ticket_id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
          support_code TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          delivered_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_support_ticket_outbox_retry
          ON support_ticket_outbox(status, next_attempt_at, created_at);
      `);
    },
  },
  {
    version: 42,
    name: 'add_global_cashback_percent',
    up: () => {
      insertSettingIfMissing('global_cashback_percent', '0');
      // Existing cb_percent values are deliberately left alone. Under the
      // tri-state, 0 means "earns nothing" and NULL means "inherit the global
      // rate" — and the old schema default was 0, so rewriting 0 to NULL here
      // would silently opt every product a merchant had excluded back into
      // earning the moment they set a global rate. Products created from here
      // on default to NULL; existing ones adopt the global rate only through
      // the explicit bulk action on the products screen.
    },
  },
  {
    version: 43,
    name: 'telemetry_default_on_for_new_installs',
    up: () => {
      // INSERT OR IGNORE, deliberately: an existing merchant's choice must
      // survive, including an earlier opt-out. Only installs that predate the
      // setting entirely pick up the new default here — every build released
      // so far shipped telemetry on, so this changes nothing for the current
      // fleet and simply keeps a fresh row consistent with seedInstallDefaults.
      const t = now();
      db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('telemetry_enabled', 'true', ?)`).run(t);
      db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('anonymous_data_consent', 'true', ?)`).run(t);
      db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('telemetry_scope', 'usage_stats,country,app_version,platform,session_duration,feature_usage,error_diagnostics', ?)`).run(t);
    },
  },
  {
    version: 44,
    name: 'store_diagnostics_outbox',
    up: () => {
      // This setting is migrated to the product default in v47. Keep the
      // original schema migration safe for databases upgrading through v44.
      insertSettingIfMissing('diagnostics_consent', 'true');
      db.exec(`
        CREATE TABLE IF NOT EXISTS store_diagnostics_outbox (
          event_id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          delivered_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_store_diagnostics_outbox_retry
          ON store_diagnostics_outbox(status, next_attempt_at, created_at);
      `);
    },
  },
  {
    // Performance fixes for ~100k+ orders (issue #208) plus timestamp
    // normalization, in one migration because v40 never shipped outside this
    // PR (upstream's v40-v44 landed first; this is v45). Indexes are all
    // `IF NOT EXISTS` so reruns are safe. Range queries
    // (`created_at >= ? AND created_at < ?`) and the composite used by the
    // orders list pagination both depend on the indexes.
    //
    // The normalization: `now()` used to write ISO-8601 (`...T10:00:00.123Z`)
    // while rows inserted via CURRENT_TIMESTAMP defaults carry SQLite's
    // `YYYY-MM-DD HH:MM:SS` form. Mixed formats break string range compares
    // at day boundaries, intra-day ORDER BY, `expires_at > datetime('now')`
    // expiry checks, and JS `new Date(ts)` parsing (the space form is read as
    // machine-local time). Normalize every legacy ISO row to the space form
    // once, so all rows in a column share one sortable, UTC-wall format.
    // Only rows containing 'T' are touched; each column is verified to exist
    // before the UPDATE so odd legacy installs cannot crash the migration.
    version: 45,
    name: 'add_performance_indexes_and_normalize_timestamps',
    up: () => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
        CREATE INDEX IF NOT EXISTS idx_orders_table_id ON orders(table_id);
        CREATE INDEX IF NOT EXISTS idx_orders_type ON orders(type);
        CREATE INDEX IF NOT EXISTS idx_bills_created_at ON bills(created_at);
        CREATE INDEX IF NOT EXISTS idx_bills_paid_status_paid_at ON bills(payment_status, paid_at);
        CREATE INDEX IF NOT EXISTS idx_bills_customer_id ON bills(customer_id);
        CREATE INDEX IF NOT EXISTS idx_print_logs_bill_id ON print_logs(bill_id);
        CREATE INDEX IF NOT EXISTS idx_ledger_bill_id_type ON loyalty_ledger(bill_id, type);
        CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);
        CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers(created_at);
        -- idx_bills_paid_at: payment-method breakdown scans paid_at ranges
        -- (including NULL for still-open bills); a plain single-column index
        -- lets the OR optimization use both branches.
        CREATE INDEX IF NOT EXISTS idx_bills_paid_at ON bills(paid_at);
      `);
      const normalize: [string, string][] = [
        ['orders', 'created_at'], ['orders', 'updated_at'],
        ['orders', 'cooking_started_at'], ['orders', 'ready_at'],
        ['orders', 'served_at'], ['orders', 'completed_at'], ['orders', 'cancelled_at'],
        ['order_items', 'created_at'], ['order_items', 'updated_at'], ['order_items', 'voided_at'],
        ['bills', 'created_at'], ['bills', 'updated_at'], ['bills', 'paid_at'], ['bills', 'printed_at'],
        ['customers', 'created_at'], ['customers', 'updated_at'],
        ['users', 'created_at'], ['users', 'updated_at'],
        ['users', 'terms_accepted_at'], ['users', 'tokens_valid_after'],
        ['loyalty_ledger', 'created_at'], ['loyalty_ledger', 'updated_at'], ['loyalty_ledger', 'expires_at'],
        ['products', 'created_at'], ['products', 'updated_at'],
        ['addons', 'created_at'], ['addons', 'updated_at'],
        ['addon_groups', 'created_at'], ['addon_groups', 'updated_at'],
        ['tables', 'created_at'], ['tables', 'updated_at'],
        ['settings', 'updated_at'],
        ['print_logs', 'printed_at'],
        ['order_item_addons', 'created_at'],
        ['whatsapp_messages', 'queued_at'], ['whatsapp_messages', 'seen_at'],
        ['whatsapp_messages', 'typing_at'], ['whatsapp_messages', 'sent_at'],
        ['whatsapp_messages', 'delivered_at'], ['whatsapp_messages', 'read_at'],
        ['whatsapp_messages', 'failed_at'],
        ['whatsapp_blocklist', 'blocked_at'],
        ['held_orders', 'created_at'], ['held_orders', 'updated_at'],
        ['kds_pairing_tokens', 'expires_at'], ['kds_pairing_tokens', 'created_at'],
        // Outbox tables (created by migrations v3/v41, before this one): rows
        // that failed pre-upgrade carry ISO next_attempt_at, which would sort
        // after space-form `now()` and defer retries by up to a day.
        ['cloud_sync_outbox', 'created_at'], ['cloud_sync_outbox', 'updated_at'], ['cloud_sync_outbox', 'next_attempt_at'],
        ['support_ticket_outbox', 'created_at'], ['support_ticket_outbox', 'updated_at'],
        ['support_ticket_outbox', 'next_attempt_at'], ['support_ticket_outbox', 'delivered_at'],
      ];
      for (const [table, column] of normalize) {
        if (!getColumns(db, table).includes(column)) continue;
        // '2026-08-01T10:00:00.123Z' -> '2026-08-01 10:00:00' (second precision,
        // matching now()/CURRENT_TIMESTAMP). Milliseconds are never relied on.
        db.prepare(
          `UPDATE ${table} SET ${column} = substr(REPLACE(${column}, 'T', ' '), 1, 19) WHERE ${column} LIKE '%T%'`
        ).run();
      }
    },
  },
  {
    version: 46,
    name: 'normalize_cloud_enabled_flags_to_01',
    up: () => {
      // cloud_sync_enabled/cloud_orders_enabled/cloud_reports_enabled/
      // cloud_command_polling_enabled are meant to mirror FloAdmin's own
      // `stores` table and are read as a strict '1' check everywhere in
      // cloud-sync.ts — but both the setup wizard (auth.ts) and the Settings
      // → Cloud route wrote 'true'/'false' instead, so any store that ever
      // completed setup or saved that settings page silently never matched
      // the '1' check: cloud sync, order/report sync, command polling, and
      // RevFlo pairing's auto-registration all quietly stopped working.
      const flags = ['cloud_sync_enabled', 'cloud_orders_enabled', 'cloud_reports_enabled', 'cloud_command_polling_enabled'];
      const toOne = db.prepare(`UPDATE settings SET value = '1' WHERE key = ? AND value = 'true'`);
      const toZero = db.prepare(`UPDATE settings SET value = '0' WHERE key = ? AND value = 'false'`);
      for (const key of flags) {
        toOne.run(key);
        toZero.run(key);
      }
    },
  },
  {
    version: 47,
    name: 'store_diagnostics_enabled_by_default',
    up: () => {
      // New installs already receive the v44/v47 default. Preserve an existing
      // false value because it may represent an owner's explicit opt-out.
      insertSettingIfMissing('diagnostics_consent', 'true');
    },
  },
  {
    version: 48,
    name: 'deactivate_reusable_demo_credentials',
    up: () => {
      // Only the bundled demo identities with the original public password are
      // affected. A merchant who changed one of these passwords keeps the user
      // active and retains their account.
      const changedAt = now();
      const demoUsers = db.prepare(`SELECT id, password FROM users WHERE id IN ('user-demo-manager', 'user-demo-cashier', 'user-demo-chef')`).all() as { id: string; password: string }[];
      const deactivate = db.prepare('UPDATE users SET is_active = 0, tokens_valid_after = ?, updated_at = ? WHERE id = ?');
      for (const user of demoUsers) {
        try {
          if (bcrypt.compareSync('demo12345', user.password)) deactivate.run(changedAt, changedAt, user.id);
        } catch {
          // A corrupt legacy hash must not abort the migration or prevent the
          // rest of the database from opening.
          console.warn(`[DB] Could not inspect demo credential for ${user.id}`);
        }
      }
    },
  },
  {
    version: 49,
    name: 'add_payment_idempotency_records',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS payment_idempotency (
          idempotency_key TEXT PRIMARY KEY,
          bill_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_payment_idempotency_bill ON payment_idempotency(bill_id);
        CREATE TABLE IF NOT EXISTS payment_transaction_refs (
          method TEXT NOT NULL,
          transaction_id TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (method, transaction_id)
        );
        CREATE INDEX IF NOT EXISTS idx_payment_transaction_refs_bill ON payment_transaction_refs(bill_id);
        CREATE TABLE IF NOT EXISTS payment_transaction_ref_conflicts (
          method TEXT NOT NULL,
          transaction_id TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          detected_at TEXT NOT NULL
        );
      `);
      const rows = db.prepare('SELECT id, payment_details FROM bills WHERE payment_details IS NOT NULL').all() as { id: string; payment_details: string }[];
      const insert = db.prepare('INSERT OR IGNORE INTO payment_transaction_refs (method, transaction_id, bill_id, created_at) VALUES (?, ?, ?, ?)');
      const conflictInsert = db.prepare('INSERT INTO payment_transaction_ref_conflicts (method, transaction_id, bill_id, created_at, detected_at) VALUES (?, ?, ?, ?, ?)');
      const seenRefs = new Map<string, { billId: string; createdAt: string }>();
      const detectedAt = now();
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.payment_details);
          const payments = Array.isArray(parsed) ? parsed : [parsed];
          for (const payment of payments) {
            if (payment && typeof payment.method === 'string' && typeof payment.transaction_id === 'string' && payment.transaction_id.trim() !== '') {
              const createdAt = payment.timestamp || detectedAt;
              const key = `${payment.method}\u0000${payment.transaction_id}`;
              const previous = seenRefs.get(key);
              if (previous && previous.billId !== row.id) conflictInsert.run(payment.method, payment.transaction_id, row.id, previous.createdAt, detectedAt);
              else seenRefs.set(key, { billId: row.id, createdAt });
              insert.run(payment.method, payment.transaction_id, row.id, createdAt);
            }
          }
        } catch {
          // Invalid legacy payment JSON is handled at settlement time; it must
          // not prevent idempotency tables from being created.
        }
      }
    },
  },
  {
    version: 50,
    name: 'add_order_idempotency_records',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS order_idempotency (
          idempotency_key TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 51,
    name: 'enforce_global_payment_transaction_refs',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS payment_transaction_ref_conflicts (
          method TEXT NOT NULL,
          transaction_id TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          detected_at TEXT NOT NULL
        );
      `);
      const duplicateRows = db.prepare(`
        SELECT method, transaction_id, bill_id, created_at
        FROM payment_transaction_refs
        WHERE transaction_id IN (
          SELECT transaction_id FROM payment_transaction_refs
          GROUP BY transaction_id HAVING COUNT(*) > 1
        )
      `).all() as { method: string; transaction_id: string; bill_id: string; created_at: string }[];
      const recordConflict = db.prepare(`
        INSERT INTO payment_transaction_ref_conflicts (method, transaction_id, bill_id, created_at, detected_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const detectedAt = now();
      for (const row of duplicateRows) recordConflict.run(row.method, row.transaction_id, row.bill_id, row.created_at, detectedAt);
      db.exec(`
        CREATE TABLE payment_transaction_refs_global (
          transaction_id TEXT PRIMARY KEY,
          method TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      db.exec(`
        INSERT OR IGNORE INTO payment_transaction_refs_global (transaction_id, method, bill_id, created_at)
        SELECT transaction_id, method, bill_id, created_at
        FROM payment_transaction_refs
        ORDER BY created_at, bill_id;
        DROP TABLE payment_transaction_refs;
        ALTER TABLE payment_transaction_refs_global RENAME TO payment_transaction_refs;
        CREATE INDEX idx_payment_transaction_refs_bill ON payment_transaction_refs(bill_id);
      `);
    },
  },
  {
    version: 52,
    name: 'restore_method_scoped_transaction_refs',
    up: () => {
      // v51 temporarily collapsed references by transaction_id. Rebuild from
      // the authoritative payment snapshots as well as the collapsed table so
      // duplicate same-method references are audited rather than discarded.
      const recordConflict = db.prepare(`
        INSERT INTO payment_transaction_ref_conflicts (method, transaction_id, bill_id, created_at, detected_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const detectedAt = now();
      db.exec(`
        CREATE TABLE payment_transaction_refs_method (
          method TEXT NOT NULL,
          transaction_id TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (method, transaction_id)
        );
      `);
      const insertRef = db.prepare(`
        INSERT OR IGNORE INTO payment_transaction_refs_method
          (method, transaction_id, bill_id, created_at)
        VALUES (?, ?, ?, ?)
      `);
      const findRef = db.prepare('SELECT bill_id, created_at FROM payment_transaction_refs_method WHERE method = ? AND transaction_id = ?');
      const addRef = (method: string, transactionId: string, billId: string, createdAt: string) => {
        const existing = findRef.get(method, transactionId) as { bill_id: string; created_at: string } | undefined;
        if (existing && String(existing.bill_id) !== String(billId)) {
          recordConflict.run(method, transactionId, billId, createdAt, detectedAt);
          return;
        }
        insertRef.run(method, transactionId, billId, createdAt);
      };
      const existingRefs = db.prepare('SELECT method, transaction_id, bill_id, created_at FROM payment_transaction_refs').all() as { method: string; transaction_id: string; bill_id: string; created_at: string }[];
      for (const ref of existingRefs) addRef(ref.method, ref.transaction_id, ref.bill_id, ref.created_at);
      const rows = db.prepare('SELECT id, payment_details FROM bills WHERE payment_details IS NOT NULL ORDER BY id').all() as { id: string; payment_details: string }[];
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.payment_details);
          const payments = Array.isArray(parsed) ? parsed : [parsed];
          for (const payment of payments) {
            if (!payment || typeof payment.method !== 'string' || typeof payment.transaction_id !== 'string' || payment.transaction_id.trim() === '') continue;
            addRef(payment.method, payment.transaction_id, String(row.id), payment.timestamp || detectedAt);
          }
        } catch {
          // Invalid legacy JSON remains recoverable by the settlement path.
        }
      }
      db.exec(`
        DROP TABLE payment_transaction_refs;
        ALTER TABLE payment_transaction_refs_method RENAME TO payment_transaction_refs;
        CREATE INDEX idx_payment_transaction_refs_bill ON payment_transaction_refs(bill_id);
      `);
    },
  },
  {
    version: 53,
    name: 'scope_idempotency_records_to_user',
    up: () => {
      db.exec(`
        CREATE TABLE payment_idempotency_scoped (
          user_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (user_id, idempotency_key)
        );
        CREATE TABLE order_idempotency_scoped (
          user_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (user_id, idempotency_key)
        );
      `);
      const paymentRows = db.prepare(`
        SELECT p.idempotency_key, p.bill_id, p.request_hash, p.response_json, p.created_at,
               'legacy' AS user_id
        FROM payment_idempotency p
      `).all() as { idempotency_key: string; bill_id: string; request_hash: string; response_json: string; created_at: string; user_id: string }[];
      const insertPayment = db.prepare(`
        INSERT INTO payment_idempotency_scoped
          (user_id, idempotency_key, bill_id, request_hash, response_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const row of paymentRows) insertPayment.run(row.user_id || 'legacy', row.idempotency_key, row.bill_id, row.request_hash, row.response_json, row.created_at);

      const orderRows = db.prepare('SELECT idempotency_key, request_hash, response_json, created_at FROM order_idempotency').all() as { idempotency_key: string; request_hash: string; response_json: string; created_at: string }[];
      const insertOrder = db.prepare(`
        INSERT INTO order_idempotency_scoped
          (user_id, idempotency_key, request_hash, response_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of orderRows) {
        let userId = 'legacy';
        try {
          const response = JSON.parse(row.response_json);
          if (response?.order?.user_id != null) userId = String(response.order.user_id);
        } catch {
          // Keep the compatibility owner for malformed historical responses.
        }
        insertOrder.run(userId, row.idempotency_key, row.request_hash, row.response_json, row.created_at);
      }
      db.exec(`
        DROP TABLE payment_idempotency;
        ALTER TABLE payment_idempotency_scoped RENAME TO payment_idempotency;
        CREATE INDEX idx_payment_idempotency_bill ON payment_idempotency(bill_id);
        DROP TABLE order_idempotency;
        ALTER TABLE order_idempotency_scoped RENAME TO order_idempotency;
      `);
    },
  },
  {
    version: 54,
    name: 'repair_retry_ownership_and_payment_reference_history',
    up: () => {
      // Repair databases that were opened by an intermediate v53 build before
      // ownership backfilling was added. Keep the compatibility owner only
      // when the historical record has no recoverable owner.
      const paymentRows = db.prepare(`
        SELECT p.idempotency_key,
               CAST(o.user_id AS TEXT) AS user_id
        FROM payment_idempotency p
        JOIN bills b ON b.id = p.bill_id
        JOIN orders o ON o.id = b.order_id
        WHERE p.user_id = 'legacy' AND o.user_id IS NOT NULL
      `).all() as { idempotency_key: string; user_id: string }[];
      const updatePayment = db.prepare(`
        UPDATE payment_idempotency SET user_id = ?
        WHERE user_id = 'legacy' AND idempotency_key = ?
          AND NOT EXISTS (
            SELECT 1 FROM payment_idempotency existing
            WHERE existing.idempotency_key = payment_idempotency.idempotency_key
              AND existing.user_id != 'legacy'
          )
      `);
      for (const row of paymentRows) updatePayment.run(row.user_id, row.idempotency_key);

      const orderRows = db.prepare(`
        SELECT idempotency_key, response_json
        FROM order_idempotency
        WHERE user_id = 'legacy'
      `).all() as { idempotency_key: string; response_json: string }[];
      const updateOrder = db.prepare(`
        UPDATE order_idempotency SET user_id = ?
        WHERE user_id = 'legacy' AND idempotency_key = ?
          AND NOT EXISTS (
            SELECT 1 FROM order_idempotency existing
            WHERE existing.idempotency_key = order_idempotency.idempotency_key
              AND existing.user_id != 'legacy'
          )
      `);
      for (const row of orderRows) {
        try {
          const response = JSON.parse(row.response_json);
          if (response?.order?.user_id != null) updateOrder.run(String(response.order.user_id), row.idempotency_key);
        } catch {
          // Leave malformed historical responses under the compatibility owner.
        }
      }

      // Reconstruct references from every bill snapshot. This repairs v51/v52
      // databases where a global transaction-id table collapsed cross-method
      // rows before method-scoped uniqueness was restored.
      const existingRefs = db.prepare('SELECT method, transaction_id, bill_id, created_at FROM payment_transaction_refs').all() as { method: string; transaction_id: string; bill_id: string; created_at: string }[];
      const rows = db.prepare('SELECT id, payment_details FROM bills WHERE payment_details IS NOT NULL ORDER BY id').all() as { id: string; payment_details: string }[];
      db.exec(`
        CREATE TABLE payment_transaction_refs_repaired (
          method TEXT NOT NULL,
          transaction_id TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (method, transaction_id)
        );
      `);
      const insertRef = db.prepare(`
        INSERT OR IGNORE INTO payment_transaction_refs_repaired
          (method, transaction_id, bill_id, created_at)
        VALUES (?, ?, ?, ?)
      `);
      const findRef = db.prepare('SELECT bill_id FROM payment_transaction_refs_repaired WHERE method = ? AND transaction_id = ?');
      const recordConflict = db.prepare(`
        INSERT INTO payment_transaction_ref_conflicts
          (method, transaction_id, bill_id, created_at, detected_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const detectedAt = now();
      const addRef = (method: string, transactionId: string, billId: string, createdAt: string) => {
        const existing = findRef.get(method, transactionId) as { bill_id: string } | undefined;
        if (existing && String(existing.bill_id) !== String(billId)) {
          recordConflict.run(method, transactionId, billId, createdAt, detectedAt);
          return;
        }
        insertRef.run(method, transactionId, billId, createdAt);
      };
      for (const ref of existingRefs) addRef(ref.method, ref.transaction_id, ref.bill_id, ref.created_at);
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.payment_details);
          const payments = Array.isArray(parsed) ? parsed : [parsed];
          for (const payment of payments) {
            if (!payment || typeof payment.method !== 'string' || typeof payment.transaction_id !== 'string' || payment.transaction_id.trim() === '') continue;
            addRef(payment.method, payment.transaction_id, String(row.id), payment.timestamp || detectedAt);
          }
        } catch {
          // Invalid legacy JSON remains recoverable by the settlement path.
        }
      }
      db.exec(`
        DROP TABLE payment_transaction_refs;
        ALTER TABLE payment_transaction_refs_repaired RENAME TO payment_transaction_refs;
        CREATE INDEX idx_payment_transaction_refs_bill ON payment_transaction_refs(bill_id);
      `);
    },
  },
  {
    version: 55,
    name: 'durable_token_revocations',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS revoked_tokens (
          token_hash TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL,
          revoked_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at
          ON revoked_tokens(expires_at);
      `);
    },
  },
  {
    version: 56,
    name: 'persist_station_assignment_scope',
    up: () => {
      if (!getColumns(db, 'users').includes('station_assignments_configured')) {
        db.exec(`ALTER TABLE users ADD COLUMN station_assignments_configured INTEGER NOT NULL DEFAULT 0`);
      }
      db.exec(`UPDATE users SET station_assignments_configured = 1 WHERE EXISTS (SELECT 1 FROM station_users WHERE station_users.user_id = users.id)`);
    },
  },
  {
    version: 57,
    name: 'rename_gstin_to_generic_tax_registration_number',
    up: () => {
      // "gstin"/"bill_show_gstn" were India-specific names for what is really
      // a generic tax-registration-number field usable by any country's tax
      // pack. Copy each business's existing value forward under the new key;
      // the old row is left in place (harmless) so nothing is lost if a
      // future build still reads it.
      const copyIfPresent = (oldKey: string, newKey: string) => {
        const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(oldKey) as { value: string } | undefined;
        if (existing) {
          db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(newKey, existing.value);
        }
      };
      copyIfPresent('gstin', 'tax_registration_number');
      copyIfPresent('bill_show_gstn', 'bill_show_tax_id');
    },
  },
  {
    version: 58,
    name: 'configurable_manual_payment_methods',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS payment_methods (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_payment_methods_active_sort ON payment_methods(is_active, sort_order, id);
        CREATE TABLE IF NOT EXISTS payment_method_merges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_name TEXT NOT NULL,
          target_name TEXT NOT NULL,
          affected_payments INTEGER NOT NULL DEFAULT 0,
          merged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // UPI is not a default on new installations. Preserve it only for an
      // upgrading store that has actually recorded UPI payments before.
      const legacyUpi = db.prepare(`
        SELECT 1 FROM bills b, json_each(CASE
          WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array' THEN b.payment_details
          WHEN json_valid(b.payment_details) THEN json_array(b.payment_details)
          ELSE '[]' END) je
        WHERE lower(json_extract(je.value, '$.method')) = 'upi' LIMIT 1
      `).get();
      if (legacyUpi) {
        db.prepare(`INSERT OR IGNORE INTO payment_methods (name, is_active, sort_order, created_at, updated_at) VALUES ('UPI', 1, 10, ?, ?)`)
          .run(now(), now());
        const upiId = Number((db.prepare(`SELECT id FROM payment_methods WHERE name = 'UPI' COLLATE NOCASE`).get() as { id: number }).id);
        const rows = db.prepare('SELECT id, payment_details FROM bills WHERE payment_details IS NOT NULL').all() as any[];
        const update = db.prepare('UPDATE bills SET payment_details = ? WHERE id = ?');
        for (const row of rows) {
          let parsed: any;
          try { parsed = JSON.parse(row.payment_details); } catch { continue; }
          const lines = Array.isArray(parsed) ? parsed : [parsed];
          let changed = false;
          for (const line of lines) {
            if (line && String(line.method || '').toLowerCase() === 'upi') {
              line.method = 'UPI';
              line.payment_method_id = upiId;
              changed = true;
            }
          }
          if (changed) update.run(JSON.stringify(Array.isArray(parsed) ? lines : lines[0]), row.id);
        }
      }
    },
  },
  {
    version: 59,
    name: 'split_checks_by_item_quantity',
    up: () => {
      if (!getColumns(db, 'bills').includes('split_group_id')) db.exec('ALTER TABLE bills ADD COLUMN split_group_id TEXT');
      if (!getColumns(db, 'bills').includes('split_label')) db.exec('ALTER TABLE bills ADD COLUMN split_label TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS bill_items (
          bill_id INTEGER NOT NULL,
          order_item_id INTEGER NOT NULL,
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          PRIMARY KEY (bill_id, order_item_id),
          FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
          FOREIGN KEY (order_item_id) REFERENCES order_items(id)
        );
        CREATE INDEX IF NOT EXISTS idx_bill_items_order_item ON bill_items(order_item_id);
        CREATE INDEX IF NOT EXISTS idx_bills_split_group ON bills(split_group_id);
      `);
    },
  },
  {
    version: 60,
    name: 'seed_split_checks_disabled_setting',
    up: () => {
      // Existing stores were already initialized before split checks existed,
      // so the first-run setup default never runs for them. Keep the feature
      // opt-in by inserting the default only when no merchant choice exists.
      db.prepare(`
        INSERT OR IGNORE INTO settings (key, value, updated_at)
        VALUES ('split_checks_enabled', 'false', ?)
      `).run(now());
    },
  },
  {
    version: 61,
    name: 'seed_server_app_enabled_setting',
    up: () => {
      // Match the Server App runtime default for upgraded stores while still
      // preserving any owner choice if the setting was already created.
      db.prepare(`
        INSERT OR IGNORE INTO settings (key, value, updated_at)
        VALUES ('server_app_enabled', 'true', ?)
      `).run(now());
    },
  },
  {
    version: 62,
    name: 'normalize_cloud_last_error',
    up: () => {
      // Older builds persisted upstream error text here. It can contain
      // reflected credentials, so replace all legacy values before exposing
      // settings or exporting the database.
      db.prepare(`
        UPDATE settings
        SET value = 'Cloud service request failed', updated_at = ?
        WHERE key = 'cloud_last_error' AND value <> ''
      `).run(now());
    },
  },
  {
    version: 63,
    name: 'seed_printer_trim_decimals_setting',
    up: () => {
      // Keep receipt amount formatting unchanged for upgraded stores unless
      // the merchant explicitly enables trimmed decimals in printer settings.
      db.prepare(`
        INSERT OR IGNORE INTO settings (key, value, updated_at)
        VALUES ('printer_trim_decimals', 'false', ?)
      `).run(now());
    },
  },
  {
    version: 64,
    name: 'drop_unused_printer_usb_device_path',
    up: () => {
      if (getColumns(db, 'printers').includes('usb_device_path')) {
        db.exec('ALTER TABLE printers DROP COLUMN usb_device_path');
      }
    },
  },
  {
    version: 65,
    name: 'seed_bill_content_visibility_settings',
    up: () => {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
      `);
      const defaults = [
        ['bill_show_name', 'true'],
        ['bill_show_address', 'true'],
        ['bill_show_phone', 'true'],
        ['bill_show_tax_id', 'false'],
        ['bill_show_tax_breakdown', 'true'],
        ['bill_show_customer_name', 'true'],
        ['bill_show_customer_phone', 'true'],
        ['bill_show_table_number', 'true'],
      ];
      for (const [key, value] of defaults) insert.run(key, value, now());
    },
  },
  {
    version: 66,
    name: 'seed_bill_template_settings',
    up: () => {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
      `);
      insert.run('bill_template', 'classic', now());
      insert.run('bill_footer_message', '', now());
    },
  },
  {
    version: 67,
    name: 'plemmo_disconnect_upstream_services',
    up: () => {
      // PLEMMO FORK — Phase 0.
      //
      // Upstream FloCafe ships with cloud coordination, anonymous telemetry
      // and store diagnostics pointed at its own hosted services
      // (blue.flopos.com / telemetry.flopos.com), all enabled by default, and
      // migration v40 actively re-enabled cloud_sync_enabled on upgrade.
      // Under the v2 zero-touch registration flow this means a booting install
      // registers itself — business name, contact, address — with a third
      // party with no human step.
      //
      // Plemmo is a separate commercial product with no relationship to that
      // service, so every outbound channel to it is switched off here. This is
      // non-destructive and fully reversible: no rows are deleted, no schema
      // changes, and an operator can re-enable any of these from Settings.
      // The endpoint constants are left in place on purpose (see
      // docs/PLEMMO_ARCHITECTURE.md § Deferred) — flipping the switches is
      // what makes them inert, and inventing placeholder URLs would only
      // produce confusing connection failures.
      //
      // Consent recorded for a FloCafe endpoint is not consent for a Plemmo
      // one, so previously-granted telemetry/diagnostics consent is cleared
      // rather than carried over.
      const changedAt = now();
      const setFlag = db.prepare(`
        UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND value != ?
      `);
      for (const [key, value] of [
        ['cloud_sync_enabled', '0'],
        ['cloud_orders_enabled', '0'],
        ['cloud_reports_enabled', '0'],
        ['cloud_command_polling_enabled', '0'],
        ['anonymous_data_consent', 'false'],
        ['telemetry_enabled', 'false'],
        ['diagnostics_consent', 'false'],
      ] as const) {
        setFlag.run(value, changedAt, key, value);
      }
      // Ensure the keys exist even on an install that somehow lacks them, so
      // the "off" state is explicit rather than relying on a read fallback.
      const insertIfMissing = db.prepare(`
        INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      `);
      for (const [key, value] of [
        ['cloud_sync_enabled', '0'],
        ['telemetry_enabled', 'false'],
        ['diagnostics_consent', 'false'],
      ] as const) {
        insertIfMissing.run(key, value, changedAt);
      }
    },
  },
  {
    version: 68,
    name: 'plemmo_organization_hierarchy',
    up: () => {
      // PLEMMO CORE — Organization > Location > Register > Device.
      //
      // Purely additive: four new tables and a handful of settings pointers.
      // No existing table, column or row is touched, so this cannot affect a
      // single existing hospitality workflow.
      //
      // Scope decision (docs/PLEMMO_ARCHITECTURE.md § Multi-tenancy): a till's
      // local database holds exactly ONE organization, ONE location and ONE
      // register. It is single-tenant by construction — a shop-floor machine
      // must be physically incapable of holding another merchant's data.
      // These tables exist so that (a) the hierarchy is real and queryable
      // rather than implied by loose `settings` keys, and (b) transactional
      // rows can later be stamped with location/register/device so they
      // self-identify once a sync engine uploads them.
      //
      // Multi-tenancy proper — many organizations in one database — is a CLOUD
      // concern and is deliberately NOT modelled here.
      db.exec(`
        CREATE TABLE IF NOT EXISTS organizations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          country TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS locations (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          name TEXT NOT NULL,
          code TEXT,
          address TEXT,
          phone TEXT,
          timezone TEXT,
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
        );

        CREATE TABLE IF NOT EXISTS registers (
          id TEXT PRIMARY KEY,
          location_id TEXT NOT NULL,
          name TEXT NOT NULL,
          code TEXT,
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (location_id) REFERENCES locations(id)
        );

        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,
          register_id TEXT,
          name TEXT,
          platform TEXT,
          app_version TEXT,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'retired', 'revoked')),
          last_seen_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (register_id) REFERENCES registers(id)
        );

        CREATE INDEX IF NOT EXISTS idx_locations_organization ON locations(organization_id);
        CREATE INDEX IF NOT EXISTS idx_registers_location ON registers(location_id);
        CREATE INDEX IF NOT EXISTS idx_devices_register ON devices(register_id);
      `);

      // Seed the single local hierarchy from whatever the install already
      // knows about itself. Existing installs keep their business name; a
      // brand-new install gets a placeholder that first-run setup overwrites.
      const readSetting = (key: string): string => {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
        return row?.value ?? '';
      };
      const changedAt = now();
      const businessName = readSetting('business_name') || 'My Business';
      const country = readSetting('country') || '';

      const organizationId = ulid();
      const locationId = ulid();
      const registerId = ulid();
      const deviceId = ulid();

      db.prepare(`INSERT INTO organizations (id, name, country, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .run(organizationId, businessName, country || null, changedAt, changedAt);
      db.prepare(`
        INSERT INTO locations (id, organization_id, name, code, address, phone, timezone, is_active, created_at, updated_at)
        VALUES (?, ?, ?, 'MAIN', ?, ?, ?, 1, ?, ?)
      `).run(
        locationId, organizationId, businessName,
        readSetting('business_address') || null,
        readSetting('business_phone') || null,
        readSetting('timezone') || null,
        changedAt, changedAt,
      );
      db.prepare(`INSERT INTO registers (id, location_id, name, code, is_active, created_at, updated_at) VALUES (?, ?, 'Register 1', 'R1', 1, ?, ?)`)
        .run(registerId, locationId, changedAt, changedAt);
      // The device row is this installation's own identity. Pairing,
      // authorization and licence binding will hang off it in a later phase;
      // for now it exists so nothing has to invent one later.
      db.prepare(`INSERT INTO devices (id, register_id, name, platform, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`)
        .run(deviceId, registerId, 'This device', process.platform, changedAt, changedAt);

      // Pointers so "which register am I?" is one cheap settings read rather
      // than a query that has to assume there is exactly one row.
      const setPointer = db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`);
      setPointer.run('plemmo_organization_id', organizationId, changedAt);
      setPointer.run('plemmo_location_id', locationId, changedAt);
      setPointer.run('plemmo_register_id', registerId, changedAt);
      setPointer.run('plemmo_device_id', deviceId, changedAt);
    },
  },
  {
    version: 69,
    name: 'plemmo_distributed_identifiers',
    up: () => {
      // PLEMMO CORE — collision-safe identity for the transactional tables.
      //
      // orders/order_items/bills use INTEGER AUTOINCREMENT keys, which two
      // offline tills would both allocate from 1. Converting the primary keys
      // outright would break every foreign key, join, report and the KDS
      // WebSocket contract in one commit; instead each row gains a ULID `uid`
      // beside its existing key. Existing code keeps using the integer key and
      // is completely unaffected; new distributed code (sync, refunds against
      // a sale created on another till, cloud upload) keys on `uid`.
      //
      // See docs/PLEMMO_ARCHITECTURE.md § Identifiers for why this is the
      // chosen strategy and what the eventual promotion to primary key needs.
      for (const table of ['orders', 'order_items', 'bills'] as const) {
        if (!getColumns(db, table).includes('uid')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN uid TEXT`);
        }
      }

      // Backfill in creation order, seeding each ULID's timestamp from the
      // row's own created_at. That makes the generated identifiers sort in
      // true historical order rather than all clustering at migration time,
      // so a lexicographic sort on uid matches a sort on created_at.
      for (const table of ['orders', 'order_items', 'bills'] as const) {
        const rows = db.prepare(`SELECT id, created_at FROM ${table} WHERE uid IS NULL ORDER BY created_at ASC, id ASC`)
          .all() as { id: number; created_at: string | null }[];
        const update = db.prepare(`UPDATE ${table} SET uid = ? WHERE id = ?`);
        for (const row of rows) {
          const parsed = row.created_at ? Date.parse(String(row.created_at).replace(' ', 'T') + 'Z') : NaN;
          const seed = Number.isFinite(parsed) ? parsed : Date.now();
          update.run(ulid(seed), row.id);
        }
      }

      // Unique, not just indexed: a duplicate uid would silently merge two
      // distinct sales during a future sync, which is the exact failure this
      // column exists to prevent. Partial (WHERE uid IS NOT NULL) so the
      // constraint cannot block an insert path that has not been taught to
      // populate uid yet.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_uid ON orders(uid) WHERE uid IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_uid ON order_items(uid) WHERE uid IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_uid ON bills(uid) WHERE uid IS NOT NULL;
      `);
    },
  },
  {
    version: 70,
    name: 'plemmo_audit_events',
    up: () => {
      // PLEMMO CORE — minimum viable audit trail: who did what, when, where.
      //
      // Deliberately one narrow append-only table rather than an audit
      // framework. A commercial EPOS has to be able to answer "who authorised
      // this refund", "who changed this price", "who opened the drawer" — and
      // the existing codebase only has fragments (tax_config_audit, print_logs,
      // payment_transaction_ref_conflicts) with no common shape.
      //
      // Append-only by convention: nothing in Plemmo should ever UPDATE or
      // DELETE a row here. Retention/rotation is a later decision and is called
      // out in docs/PLEMMO_ARCHITECTURE.md § Deferred.
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY,
          occurred_at TEXT NOT NULL,
          event_type TEXT NOT NULL,
          actor_user_id TEXT,
          actor_role TEXT,
          entity_type TEXT,
          entity_id TEXT,
          organization_id TEXT,
          location_id TEXT,
          register_id TEXT,
          device_id TEXT,
          summary TEXT,
          metadata TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_audit_events_occurred ON audit_events(occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_events_type_occurred ON audit_events(event_type, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_user_id, occurred_at DESC);
      `);
    },
  },
  {
    version: 71,
    name: 'plemmo_payment_persistence',
    up: () => {
      // PLEMMO CORE — payment persistence foundation (main/core/payment.ts).
      //
      // Today a tender is a JSON array inside bills.payment_details, written
      // by applyPaymentBatch() in routes/bills.ts. That is not being replaced
      // in this migration or this milestone — applyPaymentBatch's idempotency
      // handling, transaction-ref uniqueness and cent allocation are exactly
      // the kind of load-bearing logic this project's own development rules
      // say not to touch without a very good reason. See
      // docs/MILESTONE_2_CORE_ENGINE.md § Payment persistence for the full
      // dual-write strategy this migration is the schema half of.
      //
      // Brand-new tables, so — unlike orders/order_items/bills, which keep
      // their integer PK and only grew a bolted-on `uid` column in migration
      // v69 — these use a ULID directly as the primary key. There is no
      // legacy integer key to preserve here.
      db.exec(`
        CREATE TABLE IF NOT EXISTS payments (
          id TEXT PRIMARY KEY,
          bill_id INTEGER NOT NULL,
          order_id INTEGER,
          adapter TEXT NOT NULL,
          method TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'requested'
            CHECK (state IN ('requested', 'authorized', 'captured', 'settled', 'declined', 'cancelled', 'voided', 'refunded', 'failed')),
          amount_minor INTEGER NOT NULL,
          currency TEXT NOT NULL,
          refunded_minor INTEGER NOT NULL DEFAULT 0,
          tendered_minor INTEGER,
          change_minor INTEGER,
          provider_reference TEXT,
          actor_user_id TEXT,
          notes TEXT,
          metadata TEXT,
          requested_at TEXT NOT NULL,
          settled_at TEXT,
          voided_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (bill_id) REFERENCES bills(id),
          FOREIGN KEY (order_id) REFERENCES orders(id)
        );

        CREATE INDEX IF NOT EXISTS idx_payments_bill ON payments(bill_id);
        CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
        CREATE INDEX IF NOT EXISTS idx_payments_state ON payments(state);

        -- Append-only. Nothing in Plemmo should ever UPDATE or DELETE a row here.
        CREATE TABLE IF NOT EXISTS payment_events (
          id TEXT PRIMARY KEY,
          payment_id TEXT NOT NULL,
          from_state TEXT,
          to_state TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          actor_user_id TEXT,
          reason TEXT,
          metadata TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (payment_id) REFERENCES payments(id)
        );

        CREATE INDEX IF NOT EXISTS idx_payment_events_payment ON payment_events(payment_id, occurred_at);

        CREATE TABLE IF NOT EXISTS refunds (
          id TEXT PRIMARY KEY,
          payment_id TEXT NOT NULL,
          bill_id INTEGER NOT NULL,
          amount_minor INTEGER NOT NULL,
          currency TEXT NOT NULL,
          reason TEXT,
          state TEXT NOT NULL DEFAULT 'requested'
            CHECK (state IN ('requested', 'settled', 'failed')),
          actor_user_id TEXT,
          provider_reference TEXT,
          metadata TEXT,
          requested_at TEXT NOT NULL,
          settled_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (payment_id) REFERENCES payments(id),
          FOREIGN KEY (bill_id) REFERENCES bills(id)
        );

        CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_id);
        CREATE INDEX IF NOT EXISTS idx_refunds_bill ON refunds(bill_id);
      `);
    },
  },
  {
    version: 72,
    name: 'plemmo_product_variants',
    up: () => {
      // PLEMMO CORE — retail's Product → ProductVariant foundation
      // (main/core/retail.ts). See docs/MILESTONE_3_VERTICALS_AND_RETAIL.md
      // § Product/Variant schema for the full reasoning.
      //
      // A hospitality product (a menu item) never needs a row here — it is
      // sold directly off `products`, exactly as before this migration. A
      // retail product that needs distinct SKUs/barcodes/prices per option
      // (size, colour, storage) gets one `product_variants` row per option.
      // Nothing about `products` changes shape or meaning; this is purely
      // additive, so every existing product keeps working unmodified.
      //
      // Brand-new table, same reasoning as payments/payment_events/refunds
      // in v71: ULID directly as the primary key, no legacy integer key to
      // preserve.
      db.exec(`
        CREATE TABLE IF NOT EXISTS product_variants (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL,
          name TEXT,
          sku TEXT,
          barcode TEXT,
          price REAL NOT NULL,
          cost REAL DEFAULT 0,
          tax_category_id TEXT,
          is_default INTEGER DEFAULT 0,
          is_active INTEGER DEFAULT 1,
          sort_order INTEGER DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (product_id) REFERENCES products(id)
        );

        CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id);

        -- Safe to enforce as a hard, non-partial-only-for-blanks unique
        -- constraint: this table starts empty, so there is no legacy data to
        -- conflict with. Still partial on non-blank values, because a
        -- variant with no SKU/barcode yet (drafted before the merchant has
        -- printed labels) must not collide with every other blank one.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_sku
          ON product_variants(sku) WHERE sku IS NOT NULL AND sku != '';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_barcode
          ON product_variants(barcode) WHERE barcode IS NOT NULL AND barcode != '';
      `);

      // order_items gains two nullable, additive columns:
      //   product_variant_id — which variant (if any) this line sold, for
      //     historical/reporting accuracy even if the variant is edited later.
      //   unit_cost — a snapshot of the product's cost at sale time, so
      //     gross-margin reporting does not silently drift if a merchant
      //     edits `products.cost` after the fact (B8). Deliberately not
      //     wired into any report in this milestone — see the doc's Known
      //     limitations.
      // Note: `products.sku`/`products.barcode` are deliberately NOT given a
      // uniqueness constraint here. Unlike product_variants, that table has
      // years of real merchant data that may already contain blanks or
      // duplicates; a blind UNIQUE index would risk breaking the upgrade
      // path for an install with dirty data (an explicit STOP CONDITION for
      // this milestone). SKU/barcode uniqueness for bare products is
      // enforced at the application layer instead — see
      // main/core/retail.ts's validation.
      for (const [column, ddl] of [
        ['product_variant_id', 'ALTER TABLE order_items ADD COLUMN product_variant_id TEXT'],
        ['unit_cost', 'ALTER TABLE order_items ADD COLUMN unit_cost REAL'],
      ] as const) {
        if (!getColumns(db, 'order_items').includes(column)) {
          db.exec(ddl);
        }
      }
    },
  },
  {
    version: 73,
    name: 'plemmo_inventory_ledger',
    up: () => {
      // PLEMMO CORE — inventory movement ledger (main/core/inventory.ts). See
      // docs/MILESTONE_4_INVENTORY.md for the full design record.
      //
      // Two brand-new, empty tables — same reasoning as payments/refunds
      // (v71) and product_variants (v72): ULID directly as the primary key,
      // no legacy integer key to preserve. `products.stock_quantity` is NOT
      // touched, dropped, or stopped being written by this migration — it
      // remains the compatibility path for every product that has no
      // variant (i.e. every hospitality product, forever, and any retail
      // product that never grew variants). See § Migration strategy for
      // exactly when the ledger becomes the source of truth instead.
      //
      // `location_id` exists on both tables so a future multi-location
      // milestone can scope inventory without another migration — it is
      // always NULL in this milestone (Part O: design for it, don't build
      // it). The balance table's uniqueness is expressed with COALESCE so a
      // NULL variant/location still participates in exactly one balance row
      // per product, not one row per NULL (SQLite treats NULLs as distinct
      // in a plain UNIQUE index).
      db.exec(`
        CREATE TABLE IF NOT EXISTS inventory_movements (
          id TEXT PRIMARY KEY,
          organization_id TEXT,
          location_id TEXT,
          product_id TEXT NOT NULL,
          product_variant_id TEXT,
          quantity_delta REAL NOT NULL,
          movement_type TEXT NOT NULL
            CHECK (movement_type IN ('sale', 'return', 'adjustment', 'receipt', 'opening')),
          reason TEXT,
          reference_type TEXT,
          reference_id TEXT,
          unit_cost REAL,
          actor_user_id TEXT,
          balance_after REAL NOT NULL,
          metadata TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (product_id) REFERENCES products(id),
          FOREIGN KEY (product_variant_id) REFERENCES product_variants(id),
          FOREIGN KEY (location_id) REFERENCES locations(id)
        );

        CREATE INDEX IF NOT EXISTS idx_inventory_movements_lookup
          ON inventory_movements(product_id, product_variant_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_inventory_movements_reference
          ON inventory_movements(reference_type, reference_id);

        -- The maintained balance half of "maintained balance + immutable
        -- ledger" (Part D) — an O(1) read for the till, updated atomically
        -- alongside every movement insert inside the same transaction.
        CREATE TABLE IF NOT EXISTS inventory_balances (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL,
          product_variant_id TEXT,
          location_id TEXT,
          quantity REAL NOT NULL DEFAULT 0,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (product_id) REFERENCES products(id),
          FOREIGN KEY (product_variant_id) REFERENCES product_variants(id),
          FOREIGN KEY (location_id) REFERENCES locations(id)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_balances_unique
          ON inventory_balances(product_id, COALESCE(product_variant_id, ''), COALESCE(location_id, ''));
      `);

      // Variant-level low-stock threshold, nullable — falls back to the
      // parent product's threshold when unset. Additive; every existing
      // variant (there are none yet on an upgraded install, since
      // product_variants was only introduced in v72) is unaffected.
      if (!getColumns(db, 'product_variants').includes('low_stock_threshold')) {
        db.exec('ALTER TABLE product_variants ADD COLUMN low_stock_threshold REAL');
      }

      // Opening-balance backfill: every product that currently tracks
      // inventory gets one 'opening' movement carrying its existing
      // stock_quantity, plus a matching inventory_balances row. This is what
      // makes the ledger auditable from day one instead of starting with an
      // unexplained number — the exact question Part J's history view exists
      // to answer ("where did this starting quantity come from?").
      //
      // Deterministic and idempotent: keyed by reference_type='opening_stock_migration'
      // + reference_id=product.id, so re-running this migration logic (it
      // never runs twice via the normal MIGRATIONS pipeline, but the
      // create-ideal-schema path in tests rebuilds databases from scratch
      // and this guard keeps that safe too) cannot double-insert.
      const trackedProducts = db.prepare(
        "SELECT id, stock_quantity FROM products WHERE track_inventory = 1 AND deleted_at IS NULL"
      ).all() as { id: string; stock_quantity: number }[];

      const existingOpening = db.prepare(
        "SELECT reference_id FROM inventory_movements WHERE reference_type = 'opening_stock_migration'"
      ).all() as { reference_id: string }[];
      const alreadyMigrated = new Set(existingOpening.map((row) => row.reference_id));

      const insertMovement = db.prepare(`
        INSERT INTO inventory_movements
          (id, product_id, product_variant_id, quantity_delta, movement_type, reason,
           reference_type, reference_id, balance_after, created_at)
        VALUES (?, ?, NULL, ?, 'opening', 'Opening balance migrated from products.stock_quantity', 'opening_stock_migration', ?, ?, ?)
      `);
      const insertBalance = db.prepare(`
        INSERT INTO inventory_balances (id, product_id, product_variant_id, location_id, quantity, updated_at)
        VALUES (?, ?, NULL, NULL, ?, ?)
      `);

      const migrationNow = now();
      for (const product of trackedProducts) {
        if (alreadyMigrated.has(product.id)) continue;
        const quantity = product.stock_quantity || 0;
        insertMovement.run(ulid(), product.id, quantity, product.id, quantity, migrationNow);
        insertBalance.run(ulid(), product.id, quantity, migrationNow);
      }
    },
  },
  {
    version: 74,
    name: 'plemmo_location_aware_inventory',
    up: () => {
      // PLEMMO CORE — location-aware inventory (Milestone 5, Part B). See
      // docs/MILESTONE_5_PURCHASING_LOCATIONS.md § Location model.
      //
      // inventory_balances/inventory_movements already have a `location_id`
      // column (added in v73, always NULL until now — Part O of Milestone 4
      // deliberately designed for this without populating it). This
      // migration does not add a column; it backfills every existing NULL
      // row to this install's one real location, seeded by v68
      // (`plemmo_organization_hierarchy`) and pointed to by the
      // `plemmo_location_id` setting. A fresh install has no inventory rows
      // yet, so this is a no-op there — the first real write already
      // resolves its location (see main/core/location.ts).
      //
      // This backfill is not cosmetic: InventoryService starts resolving a
      // caller's unspecified location to this same real location id from
      // this migration onward. Without backfilling the existing NULL rows
      // first, the very next sale against an already-tracked product would
      // create a *second*, disjoint balance row (real location_id) instead
      // of updating the existing one (NULL location_id) — silently
      // duplicating stock. Backfilling first is what keeps them the same
      // row.
      const locationId = db.prepare("SELECT value FROM settings WHERE key = 'plemmo_location_id'").get() as { value: string } | undefined;
      if (!locationId?.value) return; // no organization hierarchy yet — nothing to backfill against.

      db.prepare('UPDATE inventory_balances SET location_id = ?, updated_at = ? WHERE location_id IS NULL')
        .run(locationId.value, now());
      db.prepare('UPDATE inventory_movements SET location_id = ? WHERE location_id IS NULL')
        .run(locationId.value);
    },
  },
  {
    version: 75,
    name: 'plemmo_purchasing',
    up: () => {
      // PLEMMO CORE — Supplier → PurchaseOrder → Goods Receiving foundation
      // (Milestone 5). Three brand-new, empty tables — same reasoning as
      // every other Plemmo Core table since v71: ULID directly as the
      // primary key, no legacy integer key to preserve. Receiving itself
      // has no separate table: a receipt is an `inventory_movements` row
      // (movement_type = 'receipt', reference_type = 'purchase_order_item')
      // plus an increment of the item's own `quantity_received` — the
      // ledger already IS the receiving history (see
      // docs/MILESTONE_5_PURCHASING_LOCATIONS.md § Receiving architecture).
      db.exec(`
        CREATE TABLE IF NOT EXISTS suppliers (
          id TEXT PRIMARY KEY,
          organization_id TEXT,
          name TEXT NOT NULL,
          business_name TEXT,
          contact_person TEXT,
          phone TEXT,
          email TEXT,
          address TEXT,
          notes TEXT,
          tax_registration_number TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
        );
        CREATE INDEX IF NOT EXISTS idx_suppliers_organization ON suppliers(organization_id);

        CREATE TABLE IF NOT EXISTS purchase_orders (
          id TEXT PRIMARY KEY,
          organization_id TEXT,
          location_id TEXT,
          supplier_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft', 'ordered', 'partially_received', 'received', 'cancelled')),
          reference_number TEXT,
          order_date TEXT,
          expected_date TEXT,
          notes TEXT,
          subtotal REAL NOT NULL DEFAULT 0,
          tax REAL NOT NULL DEFAULT 0,
          total REAL NOT NULL DEFAULT 0,
          created_by TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
          FOREIGN KEY (location_id) REFERENCES locations(id),
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
        );
        CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);
        CREATE INDEX IF NOT EXISTS idx_purchase_orders_location ON purchase_orders(location_id);
        CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);

        CREATE TABLE IF NOT EXISTS purchase_order_items (
          id TEXT PRIMARY KEY,
          purchase_order_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          product_variant_id TEXT,
          quantity_ordered REAL NOT NULL,
          unit_cost REAL NOT NULL,
          tax REAL NOT NULL DEFAULT 0,
          line_total REAL NOT NULL,
          quantity_received REAL NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id),
          FOREIGN KEY (product_id) REFERENCES products(id),
          FOREIGN KEY (product_variant_id) REFERENCES product_variants(id)
        );
        CREATE INDEX IF NOT EXISTS idx_purchase_order_items_po ON purchase_order_items(purchase_order_id);
        CREATE INDEX IF NOT EXISTS idx_purchase_order_items_variant ON purchase_order_items(product_id, product_variant_id);
      `);
    },
  },
  {
    version: 76,
    name: 'plemmo_location_aware_sales_and_payments',
    up: () => {
      // PLEMMO CORE — location/device stamping for sales and payments
      // (Milestone 6, Part D/E). See docs/MILESTONE_6_MULTI_LOCATION.md.
      //
      // Additive columns only. `orders` gets the full chain
      // (organization/location/register/device) because a sale is the
      // transactional event a future sync/report genuinely needs to place
      // physically. `payments` gets only organization_id/location_id —
      // register_id/device_id add no information a payment doesn't already
      // have via its order_id join, so they are deliberately not stamped
      // here (Part E: "add only the minimum required fields").
      for (const [column, ddl] of [
        ['organization_id', 'ALTER TABLE orders ADD COLUMN organization_id TEXT'],
        ['location_id', 'ALTER TABLE orders ADD COLUMN location_id TEXT'],
        ['register_id', 'ALTER TABLE orders ADD COLUMN register_id TEXT'],
        ['device_id', 'ALTER TABLE orders ADD COLUMN device_id TEXT'],
      ] as const) {
        if (!getColumns(db, 'orders').includes(column)) db.exec(ddl);
      }
      for (const [column, ddl] of [
        ['organization_id', 'ALTER TABLE payments ADD COLUMN organization_id TEXT'],
        ['location_id', 'ALTER TABLE payments ADD COLUMN location_id TEXT'],
      ] as const) {
        if (!getColumns(db, 'payments').includes(column)) db.exec(ddl);
      }

      // Backfill every existing row to this install's one real context —
      // safe because, exactly as migration v74 established for inventory,
      // every row that already exists happened at this one location. New
      // rows are stamped going forward by SaleService/PaymentService
      // themselves (main/core/context.ts), not by this migration.
      const organizationId = db.prepare("SELECT value FROM settings WHERE key = 'plemmo_organization_id'").get() as { value: string } | undefined;
      const locationId = db.prepare("SELECT value FROM settings WHERE key = 'plemmo_location_id'").get() as { value: string } | undefined;
      const registerId = db.prepare("SELECT value FROM settings WHERE key = 'plemmo_register_id'").get() as { value: string } | undefined;
      const deviceId = db.prepare("SELECT value FROM settings WHERE key = 'plemmo_device_id'").get() as { value: string } | undefined;
      if (!organizationId?.value) return; // no organization hierarchy yet — nothing to backfill against.

      db.prepare('UPDATE orders SET organization_id = ?, location_id = ?, register_id = ?, device_id = ? WHERE organization_id IS NULL')
        .run(organizationId.value, locationId?.value ?? null, registerId?.value ?? null, deviceId?.value ?? null);
      db.prepare('UPDATE payments SET organization_id = ?, location_id = ? WHERE organization_id IS NULL')
        .run(organizationId.value, locationId?.value ?? null);
    },
  },
  {
    version: 77,
    name: 'plemmo_stock_transfers',
    up: () => {
      // PLEMMO CORE — stock transfers between locations (Milestone 6, Part
      // G). Two brand-new, empty tables, ULID PK per the established
      // pattern. Deliberately simple states — draft → completed/cancelled,
      // no in_transit — since no existing transfer workflow needs one
      // (Part G: "if the existing business model does not require an
      // in_transit workflow... do not overengineer").
      db.exec(`
        CREATE TABLE IF NOT EXISTS stock_transfers (
          id TEXT PRIMARY KEY,
          organization_id TEXT,
          from_location_id TEXT NOT NULL,
          to_location_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed', 'cancelled')),
          reference_number TEXT,
          notes TEXT,
          created_by TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          completed_at TEXT,
          FOREIGN KEY (from_location_id) REFERENCES locations(id),
          FOREIGN KEY (to_location_id) REFERENCES locations(id)
        );
        CREATE INDEX IF NOT EXISTS idx_stock_transfers_from ON stock_transfers(from_location_id);
        CREATE INDEX IF NOT EXISTS idx_stock_transfers_to ON stock_transfers(to_location_id);
        CREATE INDEX IF NOT EXISTS idx_stock_transfers_status ON stock_transfers(status);

        CREATE TABLE IF NOT EXISTS stock_transfer_items (
          id TEXT PRIMARY KEY,
          stock_transfer_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          product_variant_id TEXT,
          quantity REAL NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (stock_transfer_id) REFERENCES stock_transfers(id),
          FOREIGN KEY (product_id) REFERENCES products(id),
          FOREIGN KEY (product_variant_id) REFERENCES product_variants(id)
        );
        CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_transfer ON stock_transfer_items(stock_transfer_id);
      `);

      // inventory_movements.movement_type's CHECK constraint (v73) only
      // covered what Milestone 4 needed (sale/return/adjustment/receipt/
      // opening) — that migration's own comment flagged this exact
      // rebuild as the accepted future cost of adding a movement type
      // later, since SQLite cannot ALTER a CHECK constraint in place.
      // Table-rebuild, same dance already used by migration v53
      // (payment_idempotency/order_idempotency scoping): build the new
      // shape, copy every row across unchanged, drop the old table,
      // rename the new one into place, recreate its indexes.
      db.exec(`
        CREATE TABLE inventory_movements_v2 (
          id TEXT PRIMARY KEY,
          organization_id TEXT,
          location_id TEXT,
          product_id TEXT NOT NULL,
          product_variant_id TEXT,
          quantity_delta REAL NOT NULL,
          movement_type TEXT NOT NULL
            CHECK (movement_type IN ('sale', 'return', 'adjustment', 'receipt', 'opening', 'transfer_out', 'transfer_in')),
          reason TEXT,
          reference_type TEXT,
          reference_id TEXT,
          unit_cost REAL,
          actor_user_id TEXT,
          balance_after REAL NOT NULL,
          metadata TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (product_id) REFERENCES products(id),
          FOREIGN KEY (product_variant_id) REFERENCES product_variants(id),
          FOREIGN KEY (location_id) REFERENCES locations(id)
        );
        INSERT INTO inventory_movements_v2 SELECT * FROM inventory_movements;
        DROP TABLE inventory_movements;
        ALTER TABLE inventory_movements_v2 RENAME TO inventory_movements;
        CREATE INDEX IF NOT EXISTS idx_inventory_movements_lookup ON inventory_movements(product_id, product_variant_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_inventory_movements_reference ON inventory_movements(reference_type, reference_id);
      `);
    },
  },
  {
    version: 78,
    name: 'plemmo_employee_location_scope',
    up: () => {
      // PLEMMO CORE — the minimum structural foundation for location-aware
      // employee access (Milestone 6, Part L). A join table, not a role or
      // permission system: which locations a user may operate at, nothing
      // about what they can do once there (that's still `users.role` +
      // `requireRole()`, unchanged). Not enforced by any route in this
      // milestone — see docs/MILESTONE_6_MULTI_LOCATION.md § Employee
      // location scoping for why ("do not build an entire advanced RBAC
      // system" — this is deliberately the structural piece only, so a
      // future milestone can add the enforcement check without another
      // migration).
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_locations (
          user_id TEXT NOT NULL,
          location_id TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, location_id),
          FOREIGN KEY (user_id) REFERENCES users(id),
          FOREIGN KEY (location_id) REFERENCES locations(id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_locations_location ON user_locations(location_id);
      `);

      // Every existing user is granted access to this install's one real
      // location, so the foundation is populated from day one rather than
      // starting empty (which would read as "nobody has access anywhere").
      const locationId = db.prepare("SELECT value FROM settings WHERE key = 'plemmo_location_id'").get() as { value: string } | undefined;
      if (!locationId?.value) return;
      const users = db.prepare('SELECT id FROM users').all() as { id: string }[];
      const insert = db.prepare('INSERT OR IGNORE INTO user_locations (user_id, location_id, created_at) VALUES (?, ?, ?)');
      const timestamp = now();
      for (const user of users) insert.run(user.id, locationId.value, timestamp);
    },
  },
  {
    version: 79,
    name: 'plemmo_feature_entitlements',
    up: () => {
      // PLEMMO CORE — feature entitlement foundation (Milestone 7, Part D-G).
      // See docs/MILESTONE_7_ACCESS_AND_ENTITLEMENTS.md.
      //
      // `features` is a static catalog — only keys for capabilities that
      // actually exist in the codebase today (Part D: "do not implement
      // every feature listed if it does not yet exist"). `feature_presets`/
      // `feature_preset_items` are predefined collections a merchant can
      // apply as a starting point; `organization_features` is the actual,
      // authoritative per-organization entitlement set the backend checks
      // against — presets and business type are conveniences that write
      // into it, never a permanent restriction (Part E).
      db.exec(`
        CREATE TABLE IF NOT EXISTS features (
          key TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          category TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS feature_presets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS feature_preset_items (
          preset_id TEXT NOT NULL,
          feature_key TEXT NOT NULL,
          PRIMARY KEY (preset_id, feature_key),
          FOREIGN KEY (preset_id) REFERENCES feature_presets(id),
          FOREIGN KEY (feature_key) REFERENCES features(key)
        );

        -- organization_id is not a hard foreign key against organizations(id)
        -- to keep this table usable the same way ahead of any future
        -- multi-organization (cloud) scenario, matching how migration v75
        -- already treats purchase_orders.organization_id as informational.
        CREATE TABLE IF NOT EXISTS organization_features (
          organization_id TEXT NOT NULL,
          feature_key TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          source TEXT NOT NULL DEFAULT 'custom' CHECK (source IN ('preset', 'custom')),
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (organization_id, feature_key),
          FOREIGN KEY (feature_key) REFERENCES features(key)
        );
      `);

      const insertFeature = db.prepare('INSERT OR IGNORE INTO features (key, label, category, created_at) VALUES (?, ?, ?, ?)');
      const featureTimestamp = now();
      const FEATURES: [string, string, string][] = [
        ['core.pos', 'Point of sale', 'core'],
        ['core.customers', 'Customers', 'core'],
        ['core.staff', 'Staff management', 'core'],
        ['hospitality.tables', 'Tables', 'hospitality'],
        ['hospitality.kds', 'Kitchen display', 'hospitality'],
        ['hospitality.kot', 'Kitchen order tickets', 'hospitality'],
        ['hospitality.modifiers', 'Modifiers / add-ons', 'hospitality'],
        ['retail.catalog', 'Product catalogue', 'retail'],
        ['retail.variants', 'Product variants', 'retail'],
        ['retail.barcode', 'Barcode scanning', 'retail'],
        ['retail.inventory', 'Inventory tracking', 'retail'],
        ['retail.purchasing', 'Suppliers & purchase orders', 'retail'],
        ['retail.transfers', 'Stock transfers', 'retail'],
        ['advanced.multi_location', 'Multi-location', 'advanced'],
      ];
      for (const [key, label, category] of FEATURES) insertFeature.run(key, label, category, featureTimestamp);

      const insertPreset = db.prepare('INSERT OR IGNORE INTO feature_presets (id, name, description, created_at) VALUES (?, ?, ?, ?)');
      const insertPresetItem = db.prepare('INSERT OR IGNORE INTO feature_preset_items (preset_id, feature_key) VALUES (?, ?)');
      const PRESETS: { id: string; name: string; description: string; features: string[] }[] = [
        {
          id: 'preset-hospitality', name: 'Hospitality', description: 'Restaurants and cafes',
          features: ['core.pos', 'core.customers', 'core.staff', 'hospitality.tables', 'hospitality.kds', 'hospitality.kot', 'hospitality.modifiers'],
        },
        {
          id: 'preset-retail', name: 'Retail', description: 'Shops and general retail',
          features: ['core.pos', 'core.customers', 'core.staff', 'retail.catalog', 'retail.variants', 'retail.barcode', 'retail.inventory', 'retail.purchasing'],
        },
      ];
      for (const preset of PRESETS) {
        insertPreset.run(preset.id, preset.name, preset.description, featureTimestamp);
        for (const featureKey of preset.features) insertPresetItem.run(preset.id, featureKey);
      }

      // Every existing organization gets every existing feature enabled —
      // the safe default that changes nothing about current behavior for
      // an already-running install (Part H: "do not break current default
      // behavior... unless explicitly needed"). A merchant onboarded after
      // this milestone would go through a real preset-selection flow this
      // milestone does not build (Part K: backend/domain foundation only).
      const organizations = db.prepare('SELECT id FROM organizations').all() as { id: string }[];
      const insertOrgFeature = db.prepare(`
        INSERT OR IGNORE INTO organization_features (organization_id, feature_key, enabled, source, updated_at)
        VALUES (?, ?, 1, 'custom', ?)
      `);
      for (const organization of organizations) {
        for (const [key] of FEATURES) insertOrgFeature.run(organization.id, key, featureTimestamp);
      }
    },
  },
  {
    version: 80,
    name: 'sync_0_payment_foundation',
    up: () => {
      // SYNC-0 Part A — make payments/payment_events the authoritative,
      // COMPLETE payment model. Additive only. See
      // docs/SYNC_0_PAYMENT_MIGRATION.md for the full before/after.
      //
      // (1) Global identity columns (Part A6/B2): a payment/refund can be
      // linked to its bill/order by a collision-safe uid, not just the
      // local integer FK that two devices would both allocate from 1.
      for (const [column, ddl] of [
        ['bill_uid', 'ALTER TABLE payments ADD COLUMN bill_uid TEXT'],
        ['order_uid', 'ALTER TABLE payments ADD COLUMN order_uid TEXT'],
      ] as const) {
        if (!getColumns(db, 'payments').includes(column)) db.exec(ddl);
      }
      for (const [column, ddl] of [
        ['bill_uid', 'ALTER TABLE refunds ADD COLUMN bill_uid TEXT'],
        ['order_uid', 'ALTER TABLE refunds ADD COLUMN order_uid TEXT'],
      ] as const) {
        if (!getColumns(db, 'refunds').includes(column)) db.exec(ddl);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_payments_bill_uid ON payments(bill_uid);
        CREATE INDEX IF NOT EXISTS idx_payments_order_uid ON payments(order_uid);
        CREATE INDEX IF NOT EXISTS idx_refunds_bill_uid ON refunds(bill_uid);
      `);

      // (2) Backfill uids on existing payment/refund rows from the local FKs.
      db.exec(`
        UPDATE payments SET bill_uid = (SELECT uid FROM bills WHERE bills.id = payments.bill_id)
          WHERE bill_uid IS NULL AND bill_id IS NOT NULL;
        UPDATE payments SET order_uid = (SELECT uid FROM orders WHERE orders.id = payments.order_id)
          WHERE order_uid IS NULL AND order_id IS NOT NULL;
        UPDATE refunds SET bill_uid = (SELECT uid FROM bills WHERE bills.id = refunds.bill_id)
          WHERE bill_uid IS NULL AND bill_id IS NOT NULL;
        UPDATE refunds SET order_uid = (SELECT p.order_uid FROM payments p WHERE p.id = refunds.payment_id)
          WHERE order_uid IS NULL;
      `);

      // (3) Backfill legacy bills.payment_details → payments/payment_events.
      // Only bills with ZERO existing payment rows are touched: a bill that
      // already has payments (retail via tender(), or a hospitality bill whose
      // dual-write already ran) is assumed mirrored and left as-is. That makes
      // this idempotent and duplicate-safe (a second run sees the rows it
      // created and skips). Malformed/ambiguous legacy lines are skipped, never
      // guessed (Part A4/K). Two documented fidelity assumptions, both matching
      // how the legacy data was originally created:
      //   - amounts are 2-decimal (Math.round(amount*100)) — the same
      //     unconditional *100 applyPaymentBatch used to produce them;
      //   - currency is this install's current 'currency' setting — bills never
      //     stored a per-row currency, so no truer value is recoverable.
      const currency = ((db.prepare("SELECT value FROM settings WHERE key = 'currency'").get() as { value?: string } | undefined)?.value || 'INR').toUpperCase();
      const billsWithDetails = db.prepare(`
        SELECT b.id AS bill_id, b.uid AS bill_uid, b.order_id AS order_id, b.payment_details AS payment_details,
               b.updated_at AS updated_at, b.created_at AS created_at,
               o.uid AS order_uid, o.organization_id AS organization_id, o.location_id AS location_id
        FROM bills b LEFT JOIN orders o ON o.id = b.order_id
        WHERE b.payment_details IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.bill_id = b.id)
      `).all() as Array<{
        bill_id: number; bill_uid: string | null; order_id: number | null; payment_details: string;
        updated_at: string | null; created_at: string | null;
        order_uid: string | null; organization_id: string | null; location_id: string | null;
      }>;

      const insertPayment = db.prepare(`
        INSERT INTO payments (
          id, bill_id, order_id, bill_uid, order_uid, adapter, method, state,
          amount_minor, currency, refunded_minor, tendered_minor, change_minor,
          provider_reference, actor_user_id, notes, metadata,
          requested_at, settled_at, created_at, updated_at, organization_id, location_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)
      `);
      const insertEvent = db.prepare(`
        INSERT INTO payment_events (id, payment_id, from_state, to_state, occurred_at, actor_user_id, metadata, created_at)
        VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?)
      `);

      let backfilledBills = 0;
      let backfilledLines = 0;
      let skippedLines = 0;
      for (const bill of billsWithDetails) {
        let parsed: unknown;
        try { parsed = JSON.parse(bill.payment_details); } catch { continue; }
        const lines = Array.isArray(parsed) ? parsed : [parsed];
        let anyLine = false;
        for (const raw of lines) {
          const line = raw as Record<string, unknown>;
          const method = typeof line.method === 'string' && line.method.trim() ? line.method.trim() : null;
          const amount = Number(line.amount);
          // Skip anything we cannot faithfully represent: a line with no
          // method, or no positive amount (a zero/negative line is not a
          // captured payment and legacy refunds are not reconstructed here).
          if (!method || !Number.isFinite(amount) || amount <= 0) { skippedLines += 1; continue; }
          const adapter = method === 'cash' ? 'cash' : method === 'wallet' ? 'wallet' : 'manual_card';
          const state = adapter === 'manual_card' ? 'captured' : 'settled';
          const amountMinor = Math.round(amount * 100);
          const tendered = Number(line.tendered_amount);
          const change = Number(line.change_amount);
          const tenderedMinor = adapter === 'cash' && Number.isFinite(tendered) ? Math.round(tendered * 100) : null;
          const changeMinor = adapter === 'cash' && Number.isFinite(change) ? Math.round(change * 100) : null;
          const providerRef = typeof line.transaction_id === 'string' ? line.transaction_id : null;
          const noteText = typeof line.notes === 'string' ? line.notes : null;
          const tsRaw = typeof line.timestamp === 'string' ? line.timestamp : (bill.updated_at || bill.created_at || now());
          const parsedMs = Date.parse(String(tsRaw).replace(' ', 'T') + (String(tsRaw).includes('T') || String(tsRaw).endsWith('Z') ? '' : 'Z'));
          const seedMs = Number.isFinite(parsedMs) ? parsedMs : Date.now();
          const paymentId = ulid(seedMs);
          const at = String(tsRaw);
          const settledAt = state === 'settled' ? at : null;
          insertPayment.run(
            paymentId, bill.bill_id, bill.order_id, bill.bill_uid, bill.order_uid, adapter, method, state,
            amountMinor, currency, tenderedMinor, changeMinor, providerRef, noteText,
            at, settledAt, at, at, bill.organization_id, bill.location_id,
          );
          insertEvent.run(ulid(seedMs), paymentId, state, at, at);
          backfilledLines += 1;
          anyLine = true;
        }
        if (anyLine) backfilledBills += 1;
      }
      if (backfilledBills > 0 || skippedLines > 0) {
        console.log(`[DB] v80 payment backfill: ${backfilledBills} bill(s), ${backfilledLines} line(s) reconstructed, ${skippedLines} line(s) skipped as unrepresentable`);
      }
    },
  },
  {
    version: 81,
    name: 'sync_0_load_bearing_uids',
    up: () => {
      // SYNC-0 Part B — make orders/order_items/bills `uid` truly
      // load-bearing. Migration v69 added the column and backfilled the rows
      // that existed then, but three insert paths were later found creating
      // rows with a NULL uid (a bill via POST /bills/generate, a split-check
      // bill, and a void-adjustment order_item). Those code paths are fixed
      // going forward (SYNC-0 Part B); this migration backfills any NULL uid
      // those paths already produced on an existing install, seeding each
      // ULID from the row's own created_at so it still sorts historically —
      // the same approach v69 used.
      for (const table of ['orders', 'order_items', 'bills'] as const) {
        const rows = db.prepare(`SELECT id, created_at FROM ${table} WHERE uid IS NULL ORDER BY created_at ASC, id ASC`)
          .all() as Array<{ id: number; created_at: string | null }>;
        if (rows.length === 0) continue;
        const update = db.prepare(`UPDATE ${table} SET uid = ? WHERE id = ?`);
        for (const row of rows) {
          const parsed = row.created_at ? Date.parse(String(row.created_at).replace(' ', 'T') + 'Z') : NaN;
          update.run(ulid(Number.isFinite(parsed) ? parsed : Date.now()), row.id);
        }
        console.log(`[DB] v81 uid backfill: ${rows.length} ${table} row(s)`);
      }
      // The partial unique indexes from v69 (idx_*_uid WHERE uid IS NOT NULL)
      // still guard against duplicate uids; nothing to recreate here.
    },
  },
  {
    version: 82,
    name: 'sync_0_child_row_tombstones',
    up: () => {
      // SYNC-0 Part C — replace the two hard DELETEs on sync-relevant child
      // rows (draft PO line removal, draft transfer line removal) with a
      // `deleted_at` tombstone. A hard delete of a row another device may
      // reference cannot be represented as a sync fact; a tombstone can.
      // Additive column only; all active queries are updated in the same
      // change to treat `deleted_at IS NOT NULL` rows as absent, so current
      // draft-editing behavior is unchanged.
      for (const table of ['purchase_order_items', 'stock_transfer_items'] as const) {
        if (!getColumns(db, table).includes('deleted_at')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`);
        }
      }
    },
  },
  {
    version: 83,
    name: 'sync_0_sync_identity_backfill',
    up: () => {
      // SYNC-0 Part D — every record that will eventually cross the sync
      // boundary must be unambiguously attributable to an organization and,
      // where meaningful, a location.
      //
      // inventory_movements.organization_id was never populated by
      // recordMovement (only location_id was). It is now stamped going
      // forward (main/core/inventory.ts) and backfilled here from each
      // movement's own location — a location belongs to exactly one
      // organization, so this is a real derivation, not a guess. Movements
      // with no location fall back to the install's single organization
      // pointer. inventory_balances is deliberately NOT given an
      // organization column: it is a DERIVED projection keyed by
      // (product, variant, location) and is never itself a sync fact — its
      // organization is always resolvable via the location, and adding a
      // column would risk a second, divergent balance key (Part D1).
      db.exec(`
        UPDATE inventory_movements
        SET organization_id = (SELECT l.organization_id FROM locations l WHERE l.id = inventory_movements.location_id)
        WHERE organization_id IS NULL AND location_id IS NOT NULL
      `);
      const orgPointer = (db.prepare("SELECT value FROM settings WHERE key = 'plemmo_organization_id'").get() as { value?: string } | undefined)?.value;
      if (orgPointer) {
        db.exec(`UPDATE inventory_movements SET organization_id = '${orgPointer.replace(/'/g, "''")}' WHERE organization_id IS NULL`);
        // Defensively backfill any purchase order whose organization/location
        // was left unstamped (e.g. created before the org pointer was seeded).
        const locPointer = (db.prepare("SELECT value FROM settings WHERE key = 'plemmo_location_id'").get() as { value?: string } | undefined)?.value ?? null;
        db.prepare('UPDATE purchase_orders SET organization_id = ? WHERE organization_id IS NULL').run(orgPointer);
        if (locPointer) db.prepare('UPDATE purchase_orders SET location_id = ? WHERE location_id IS NULL').run(locPointer);
        db.prepare('UPDATE stock_transfers SET organization_id = ? WHERE organization_id IS NULL').run(orgPointer);
      }
    },
  },
  {
    version: 84,
    name: 'sync_0_device_credentials',
    up: () => {
      // SYNC-0 Part E — domain foundation for device-authenticated sync.
      //
      // Stores only the PUBLIC half of a device's credential plus its
      // lifecycle metadata. The private key is generated on the device and
      // held in OS-protected storage (Windows DPAPI / macOS Keychain) — it is
      // NEVER written to this or any application table. This table does not
      // enroll or authenticate anything yet; it is the schema a future
      // enrollment flow and sync transport will populate. No cloud, no
      // network, no middleware is created here (Part E, Part J).
      db.exec(`
        CREATE TABLE IF NOT EXISTS device_credentials (
          id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          credential_type TEXT NOT NULL DEFAULT 'device_keypair'
            CHECK (credential_type IN ('device_keypair', 'rotatable_bearer')),
          public_key TEXT,
          credential_identifier TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'active', 'rotated', 'revoked')),
          issued_at TEXT,
          expires_at TEXT,
          rotated_at TEXT,
          revoked_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (device_id) REFERENCES devices(id)
        );
        CREATE INDEX IF NOT EXISTS idx_device_credentials_device ON device_credentials(device_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_device_credentials_identifier
          ON device_credentials(credential_identifier) WHERE credential_identifier IS NOT NULL;
      `);
    },
  },
];

function syncBackupBeforeMigration(fromVersion: number, toVersion: number): void {
  if (buildingIdealSchema) return;
  let targetPath = '';
  let completed = false;
  try {
    const dbPath = getDbPath();
    const backupDir = getBackupDir();
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    targetPath = path.join(backupDir, `flo-backup-${timestamp}-pre-v${fromVersion}-to-v${toVersion}.db`);

    if (fs.existsSync(dbPath)) {
      db.pragma('wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(dbPath, targetPath);
    } else {
      // A brand-new install has no source file yet; keep the backup contract
      // by creating an empty SQLite file with migration metadata below.
      fs.writeFileSync(targetPath, '');
    }

    let backupDb: Database.Database | undefined;
    try {
      backupDb = new Database(targetPath);
      backupDb.pragma('journal_mode = DELETE');
      backupDb.exec(`
        CREATE TABLE IF NOT EXISTS _flo_meta (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `);
      // This snapshot predates the migration about to run. Keep both the
      // metadata stamp and SQLite header aligned with that older version so
      // restoring it cannot be misclassified as a current-schema backup.
      backupDb.pragma(`user_version = ${fromVersion}`);
      backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`).run('schema_version', String(fromVersion));
      backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`).run('backup_created_at', new Date().toISOString());
      backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`).run('app_version', app.getVersion());
    } finally {
      backupDb?.close();
    }
    syncFile(targetPath);
    if (!syncDirectory(path.dirname(targetPath)) && process.platform !== 'win32') {
      throw new Error('Could not durably persist pre-migration backup');
    }

    completed = true;
    console.log(`[DB] Auto-backup before migrating v${fromVersion} → v${toVersion} created at ${targetPath}`);
  } catch (err: any) {
    console.error(`[DB] Auto-backup before migration failed:`, err.message);
    throw new Error(`Pre-migration backup failed; refusing to migrate the database: ${err.message}`);
  } finally {
    if (!completed && targetPath) {
      for (const filePath of [targetPath, `${targetPath}-wal`, `${targetPath}-shm`]) {
        try { if (pathEntryExists(filePath)) fs.unlinkSync(filePath); } catch { }
      }
    }
  }
}

export class SchemaVersionMismatchError extends Error {
  constructor(public readonly dbVersion: number, public readonly appVersion: number) {
    super(
      `Database schema (v${dbVersion}) is newer than this app version supports (v${appVersion}). ` +
      `This usually means another device or a previous update already upgraded this database. ` +
      `Please update Flo Cafe to the latest version before continuing.`
    );
    this.name = 'SchemaVersionMismatchError';
  }
}

function runMigrations(): void {
  const current = getCurrentSchemaVersion();
  const target = MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;

  if (current > target) {
    // The database has already been migrated by a newer build than this one
    // (shared/synced DB, or a stale install/shortcut still pointing at this
    // binary). Proceeding would let old queries reference columns a later
    // migration already dropped (e.g. order_items.addons, #133) — fail loudly
    // at startup instead of mid-transaction during business hours.
    throw new SchemaVersionMismatchError(current, target);
  }

  if (current === target) {
    console.log(`[DB] Schema up to date (v${current})`);
    return;
  }

  console.log(`[DB] Schema: v${current} → v${target}`);

  // Back up once, up front, before running the whole pending batch — not just
  // before specific hand-picked versions. An install that's been stuck for a
  // long time (broken auto-update, offline for months, etc.) can jump through
  // a dozen+ migrations in a single run; every one of them deserves the same
  // protection, not just the couple we happened to remember to flag by number.
  //
  // Deliberately unconditional, including current === 0: that's NOT a
  // reliable signal for "nothing to protect" — real old installs can report
  // user_version 0 if they predate this app's version-tracking pragma (see
  // tests/fixtures/upgrade-snapshots/pre-migration-scheme-v1.5.0.db), and
  // those are exactly the installs with the most pending migrations and the
  // most at stake. A brand-new install just backs up an empty/tiny file.
  console.log(`[DB] Triggering auto-backup before migrating v${current} → v${target}...`);
  syncBackupBeforeMigration(current, target);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    console.log(`[DB] Applying migration v${migration.version}: ${migration.name}`);
    db.transaction(() => {
      migration.up();
      db.pragma(`user_version = ${migration.version}`);
    })();
    console.log(`[DB] Migration v${migration.version} complete`);
  }
}

// createSchema() only runs for migration v1, i.e. brand-new installs — for
// any existing install this is a no-op (CREATE TABLE IF NOT EXISTS). If you
// add a column directly to a CREATE TABLE below, existing installs never
// get it unless you also add a guarded ALTER migration for it (see v23/v29
// in MIGRATIONS above for the pattern, and specs/DatabaseMigrations.md).
// tests/upgrade-path.test.ts exists specifically to catch this class of bug.
function createSchema(): void {
  db.exec(`
    -- ── Master data tables ──────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      parent_id TEXT,
      slug TEXT,
      color TEXT,
      icon TEXT,
      deleted_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      category_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL DEFAULT 0,
      cost REAL DEFAULT 0,
      sku TEXT,
      barcode TEXT,
      image_url TEXT,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      track_inventory INTEGER DEFAULT 0,
      stock_quantity REAL DEFAULT 0,
      low_stock_threshold REAL DEFAULT 5,
      tax_type TEXT DEFAULT 'none',
      tax_rate REAL DEFAULT 0,
      tax_category_id TEXT DEFAULT NULL,
      tax_behavior TEXT DEFAULT 'country_default',
      -- Stays DEFAULT 0 so a fresh install and an upgraded one have an
      -- identical products table. SQLite cannot alter a column default without
      -- rebuilding the table, so changing it here would drift every upgraded
      -- install away from the ideal schema and light up schema-health forever.
      -- The tri-state does not depend on the default: every insert path passes
      -- cb_percent explicitly, and NULL is written as NULL.
      cb_percent REAL DEFAULT 0,
      tags TEXT,
      deleted_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );

    CREATE TABLE IF NOT EXISTS addon_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_required INTEGER DEFAULT 0,
      min_selection INTEGER DEFAULT 0,
      max_selection INTEGER DEFAULT 1,
      allow_multiple_quantities INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS addons (
      id TEXT PRIMARY KEY,
      addon_group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      tax_category_id TEXT DEFAULT NULL,
      tax_behavior TEXT DEFAULT 'country_default',
      inherit_parent_tax_category INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (addon_group_id) REFERENCES addon_groups(id)
    );

    CREATE TABLE IF NOT EXISTS addon_group_product (
      product_id TEXT NOT NULL,
      addon_group_id TEXT NOT NULL,
      PRIMARY KEY (product_id, addon_group_id)
    );

    CREATE TABLE IF NOT EXISTS kitchen_stations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      category_ids TEXT,
      printer_id TEXT,
      printer_ip TEXT,
      printer_port INTEGER DEFAULT 9100,
      printer_name TEXT,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS station_users (
      user_id TEXT NOT NULL,
      station_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, station_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (station_id) REFERENCES kitchen_stations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tables (
      id TEXT PRIMARY KEY,
      number TEXT NOT NULL UNIQUE,
      capacity INTEGER DEFAULT 4,
      status TEXT DEFAULT 'available',
      floor TEXT,
      section TEXT,
      position_x REAL,
      position_y REAL,
      kitchen_station_id TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      country_code TEXT DEFAULT '+91',
      address TEXT,
      notes TEXT,
      tag_counts TEXT DEFAULT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Users (authentication + roles) ──────────────────────────────────
    -- Roles: owner, manager, cashier, waiter, chef
    -- KDS is operated by the chef role.

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cashier'
        CHECK (role IN ('owner', 'manager', 'cashier', 'waiter', 'chef')),
      pin TEXT,
      pin_hash TEXT,
      category_ids TEXT,
      is_active INTEGER DEFAULT 1,
      terms_accepted_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Transactional tables ─────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      table_id TEXT,
      customer_id TEXT,
      user_id TEXT,
      type TEXT DEFAULT 'takeaway',
      guest_count INTEGER,
      special_instructions TEXT,
      packaging_charge REAL DEFAULT 0,
      delivery_charge REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      subtotal REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      tax_breakdown TEXT,
      tax_snapshot TEXT DEFAULT NULL,
      packaging_tax_category_id TEXT DEFAULT NULL,
      delivery_tax_category_id TEXT DEFAULT NULL,
      service_charge_tax_category_id TEXT DEFAULT NULL,
      discount_amount REAL DEFAULT 0,
      discount_type TEXT,
      discount_value REAL,
      discount_reason TEXT,
      round_off REAL DEFAULT 0,
      total REAL DEFAULT 0,
      cooking_started_at TEXT,
      ready_at TEXT,
      served_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      cancellation_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      product_sku TEXT,
      unit_price REAL NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      subtotal REAL NOT NULL,
      tax_amount REAL DEFAULT 0,
      tax_breakdown TEXT,
      tax_snapshot TEXT DEFAULT NULL,
      tax_type TEXT,
      discount_amount REAL DEFAULT 0,
      total REAL NOT NULL,
      variant_selection TEXT,
      modifier_selection TEXT,
      addons TEXT,
      special_instructions TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_number TEXT UNIQUE NOT NULL,
      order_id INTEGER NOT NULL,
      customer_id TEXT,
      subtotal REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      tax_breakdown TEXT,
      tax_snapshot TEXT DEFAULT NULL,
      discount_amount REAL DEFAULT 0,
      discount_type TEXT,
      discount_value REAL,
      discount_reason TEXT,
      delivery_charge REAL DEFAULT 0,
      packaging_charge REAL DEFAULT 0,
      round_off REAL DEFAULT 0,
      total REAL DEFAULT 0,
      paid_amount REAL DEFAULT 0,
      balance REAL DEFAULT 0,
      payment_status TEXT DEFAULT 'unpaid',
      payment_details TEXT,
      paid_at TEXT,
      printed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS loyalty_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id TEXT NOT NULL,
      bill_id INTEGER,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Config tables ────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS kds_pairing_tokens (
      id TEXT PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      station_id TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS printers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      connection_type TEXT NOT NULL CHECK (connection_type IN ('network', 'usb', 'webusb')),
      ip_address TEXT,
      port INTEGER DEFAULT 9100,
      is_default INTEGER DEFAULT 0,
      paper_width TEXT DEFAULT '80mm',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS country_packs (
      id TEXT PRIMARY KEY,
      publisher TEXT NOT NULL,
      country TEXT NOT NULL,
      jurisdiction TEXT NOT NULL,
      active_version_id TEXT,
      status TEXT NOT NULL DEFAULT 'installed',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS country_pack_versions (
      id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      version TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      manifest_json TEXT NOT NULL,
      pack_json TEXT NOT NULL,
      digest TEXT,
      signature TEXT,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      min_flo_version TEXT NOT NULL,
      published_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'staged',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_id, version)
    );

    CREATE TABLE IF NOT EXISTS tax_categories (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      label TEXT NOT NULL,
      default_behavior TEXT,
      definition_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_version_id, category_id)
    );

    CREATE TABLE IF NOT EXISTS tax_rules (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      label TEXT NOT NULL,
      calculation_type TEXT NOT NULL,
      rate TEXT,
      amount TEXT,
      applies_per TEXT,
      base_rule_ids TEXT,
      definition_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_version_id, rule_id)
    );

    CREATE TABLE IF NOT EXISTS tax_overrides (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      field_name TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_by_user_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tax_config_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      pack_id TEXT,
      pack_version_id TEXT,
      override_id TEXT,
      actor_user_id TEXT,
      details_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Indexes ──────────────────────────────────────────────────────────

    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_products_active   ON products(is_active);
    CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_created    ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_user       ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_bills_order       ON bills(order_id);
    CREATE INDEX IF NOT EXISTS idx_country_pack_versions_pack ON country_pack_versions(pack_id);
    CREATE INDEX IF NOT EXISTS idx_tax_categories_pack_version ON tax_categories(pack_version_id);
    CREATE INDEX IF NOT EXISTS idx_tax_rules_pack_version ON tax_rules(pack_version_id);
    CREATE INDEX IF NOT EXISTS idx_tax_overrides_pack_version ON tax_overrides(pack_version_id);
  `);
}

function createTaxPackSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS country_packs (
      id TEXT PRIMARY KEY,
      publisher TEXT NOT NULL,
      country TEXT NOT NULL,
      jurisdiction TEXT NOT NULL,
      active_version_id TEXT,
      status TEXT NOT NULL DEFAULT 'installed',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS country_pack_versions (
      id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      version TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      manifest_json TEXT NOT NULL,
      pack_json TEXT NOT NULL,
      digest TEXT,
      signature TEXT,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      min_flo_version TEXT NOT NULL,
      published_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'staged',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_id, version)
    );

    CREATE TABLE IF NOT EXISTS tax_categories (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      label TEXT NOT NULL,
      default_behavior TEXT,
      definition_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_version_id, category_id)
    );

    CREATE TABLE IF NOT EXISTS tax_rules (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      label TEXT NOT NULL,
      calculation_type TEXT NOT NULL,
      rate TEXT,
      amount TEXT,
      applies_per TEXT,
      base_rule_ids TEXT,
      definition_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_version_id, rule_id)
    );

    CREATE TABLE IF NOT EXISTS tax_overrides (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      field_name TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_by_user_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tax_config_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      pack_id TEXT,
      pack_version_id TEXT,
      override_id TEXT,
      actor_user_id TEXT,
      details_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_country_pack_versions_pack ON country_pack_versions(pack_id);
    CREATE INDEX IF NOT EXISTS idx_tax_categories_pack_version ON tax_categories(pack_version_id);
    CREATE INDEX IF NOT EXISTS idx_tax_rules_pack_version ON tax_rules(pack_version_id);
    CREATE INDEX IF NOT EXISTS idx_tax_overrides_pack_version ON tax_overrides(pack_version_id);
  `);
}

function createCloudSyncSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_sync_outbox (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      delivered_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_cloud_sync_outbox_status
      ON cloud_sync_outbox(status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_cloud_sync_outbox_entity
      ON cloud_sync_outbox(entity_type, entity_id);
  `);
}

function createWhatsAppSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id INTEGER REFERENCES bills(id),
      customer_id TEXT REFERENCES customers(id),
      phone_e164 TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
      kind TEXT NOT NULL DEFAULT 'manual_reply'
        CHECK (kind IN ('bill_receipt','manual_reply','auto_followup')),
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','seen','typing','sent','delivered','read','failed')),
      body TEXT NOT NULL,
      external_message_id TEXT,
      error TEXT,
      queued_at TEXT DEFAULT CURRENT_TIMESTAMP,
      seen_at TEXT,
      typing_at TEXT,
      sent_at TEXT,
      delivered_at TEXT,
      read_at TEXT,
      failed_at TEXT,
      created_by_user_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_phone
      ON whatsapp_messages(phone_e164, queued_at DESC);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_status
      ON whatsapp_messages(status, queued_at DESC);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_bill
      ON whatsapp_messages(bill_id);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_inbound_unread
      ON whatsapp_messages(direction, status, queued_at DESC)
      WHERE direction = 'inbound' AND status NOT IN ('read','failed');

    CREATE TABLE IF NOT EXISTS whatsapp_blocklist (
      phone_e164 TEXT PRIMARY KEY,
      reason TEXT,
      blocked_at TEXT DEFAULT CURRENT_TIMESTAMP,
      blocked_by_user_id TEXT
    );
  `);
}

function seedCloudSyncDefaults(): void {
  createCloudSyncSchema();

  const serverUrl = getSettingValue('cloud_server_url');
  if (!serverUrl) upsertSetting('cloud_server_url', DEFAULT_CLOUD_SERVER_URL);

  // PLEMMO FORK: upstream defaulted this on, and the v2 zero-touch flow means
  // cloudSync.start() -> attemptAutoRegister() fires on every boot whenever
  // cloud_sync_enabled === '1' — i.e. a fresh install POSTs its business name,
  // contact details and address to blue.flopos.com before any human opts in.
  // (The old comment here claimed nothing transmits pre-claim; that stopped
  // being true when v2 removed the claim step.) Plemmo must not register
  // merchants with a third party's service, so this now defaults OFF. The
  // cloud_server_url constant is deliberately left pointing at the upstream
  // value rather than replaced with an invented Plemmo URL — the switch above
  // is what makes it inert. See docs/PLEMMO_ARCHITECTURE.md § Deferred.
  insertSettingIfMissing('cloud_sync_enabled', '0');
  insertSettingIfMissing('cloud_orders_enabled', '0');
  insertSettingIfMissing('cloud_reports_enabled', '1');
  insertSettingIfMissing('cloud_command_polling_enabled', '1');
  insertSettingIfMissing('cloud_connected', 'false');
  insertSettingIfMissing('cloud_registration_status', 'unregistered');

  ensureCloudIdentity();
}

function seedWhatsAppDefaults(): void {
  insertSettingIfMissing('whatsapp_enabled', 'false');
  insertSettingIfMissing('whatsapp_activated_by_user_id', '');
  insertSettingIfMissing('whatsapp_activated_at', '');
  insertSettingIfMissing('whatsapp_disclosure_version_acknowledged', '');
  insertSettingIfMissing('whatsapp_connected_phone', '');
  insertSettingIfMissing('whatsapp_disclosure_version', '1');
  // On by default — no one asks Flo to send a paid bill into a group chat.
  // Operators who do want group processing have to opt in explicitly.
  insertSettingIfMissing('whatsapp_filter_groups', 'true');
}

function seedInstallDefaults(): void {
  const insert = (key: string, value: string) =>
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);

  insert('business_name', '');
  insert('business_type', 'restaurant');
  insert('country', 'IN');
  insert('currency', 'INR');
  insert('currency_symbol', '₹');
  insert('timezone', 'Asia/Kolkata');
  insert('address', '');
  insert('phone', '');
  insert('email', '');
  insert('business_address', '');
  insert('business_phone', '');
  insert('instagram_handle', '');
  insert('tax_registered', 'false');
  insert('tax_registration_number', '');
  insert('state_code', '');
  insert('tax_scheme', 'regular');
  insert('taxes_enabled', 'false');
  insert('billing_type', 'postpaid');
  insert('tables_required', 'true');
  insert('service_model', 'finedine');
  insert('setup_profile', '');
  insert('cloud_server_url', DEFAULT_CLOUD_SERVER_URL);
  insert('cloud_connected', 'false');
  // PLEMMO FORK: all third-party coordination defaults off (see
  // seedCloudSyncDefaults above for the reasoning).
  insert('cloud_sync_enabled', '0');
  insert('cloud_orders_enabled', '0');
  insert('cloud_reports_enabled', '0');
  insert('cloud_command_polling_enabled', '0');
  insert('cloud_registration_status', 'unregistered');
  insert('anonymous_data_consent', 'false');
  insert('telemetry_enabled', 'false');
  insert('telemetry_scope', 'usage_stats,country,app_version,platform,session_duration,feature_usage,error_diagnostics');
  insert('diagnostics_consent', 'false');
  insert('kds_enabled', 'true');
  insert('server_app_enabled', 'true');
  insert('kot_printing_enabled', 'true');
  insert('printer_trim_decimals', 'false');
  insert('bill_template', 'classic');
  insert('bill_footer_message', '');
  insert('bill_show_name', 'true');
  insert('bill_show_address', 'true');
  insert('bill_show_phone', 'true');
  insert('bill_show_tax_id', 'false');
  insert('bill_show_tax_breakdown', 'true');
  insert('bill_show_customer_name', 'true');
  insert('bill_show_customer_phone', 'true');
  insert('bill_show_table_number', 'true');
  insert('order_number_prefix', 'ORD');
  insert('order_number_include_date', 'true');
  insert('order_number_reset_daily', 'true');

  seedCloudSyncDefaults();

  console.log('[DB] Install defaults loaded; first-run setup pending');
}

const SHORT_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function generateShortId(table: string, length = 6): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    let id = '';
    for (let i = 0; i < length; i++) id += SHORT_ID_CHARS[Math.floor(Math.random() * SHORT_ID_CHARS.length)];
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) return id;
  }
  throw new Error(`generateShortId: could not find unique id for ${table} after 20 attempts`);
}

/** Atomically get the next sequence value for a given name and date. */
function getNextSequence(name: string, date: string): number {
  return db.transaction(() => {
    // Try to update existing row
    const updated = db.prepare(`
      UPDATE sequences SET current_value = current_value + 1
      WHERE name = ? AND date = ?
    `).run(name, date);

    if (updated.changes === 0) {
      // Row doesn't exist for today, insert it
      try {
        db.prepare(`
          INSERT INTO sequences (name, date, current_value) VALUES (?, ?, 1)
        `).run(name, date);
        return 1;
      } catch {
        // Another concurrent insert won the race, try update again
        const retry = db.prepare(`
          UPDATE sequences SET current_value = current_value + 1
          WHERE name = ? AND date = ?
        `).run(name, date);
        if (retry.changes === 0) {
          throw new Error(`Failed to generate sequence for ${name}`);
        }
      }
    }

    const row = db.prepare('SELECT current_value FROM sequences WHERE name = ? AND date = ?')
      .get(name, date) as any;
    return row?.current_value ?? 0;
  })();
}

/** YYYYMMDD for "now" in the given IANA timezone (falls back to UTC if the zone is invalid). */
export function dateStampInTimezone(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}${get('month')}${get('day')}`;
  } catch {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }
}

export function generateOrderNumber(): string {
  const prefix = getSettingValue('order_number_prefix') ?? 'ORD';
  const includeDate = getSettingValue('order_number_include_date') !== 'false';
  const resetDaily = getSettingValue('order_number_reset_daily') !== 'false';
  const timezone = getSettingValue('timezone') || 'Asia/Kolkata';

  // The sequence "bucket": a per-day counter when the series resets at store
  // midnight, or a single fixed bucket when the series is meant to keep
  // climbing indefinitely.
  const bucket = resetDaily ? dateStampInTimezone(timezone) : 'ALL';
  const next = getNextSequence('orders', bucket);

  const dateSegment = includeDate ? dateStampInTimezone(timezone) : '';
  return [prefix, dateSegment, String(next).padStart(4, '0')].filter(Boolean).join('-');
}

export function generateBillNumber(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const next = getNextSequence('bills', date);
  return `INV-${date}-${String(next).padStart(4, '0')}`;
}

export function now(): string {
  // Match SQLite's CURRENT_TIMESTAMP format (`YYYY-MM-DD HH:MM:SS`, UTC). The
  // legacy `new Date().toISOString()` form (with `T`, `Z`, milliseconds) was
  // mixed into columns whose `CREATE TABLE` defaults use CURRENT_TIMESTAMP, so
  // range and ordering operations on those columns stopped sorting correctly.
  // Migration v45 normalized the legacy ISO rows to this format. #208
  return new Date().toISOString().replace('T', ' ').replace(/\..*$/, '');
}

/**
 * Parse a DB timestamp into a Date. Columns are stored in UTC wall time in
 * `YYYY-MM-DD HH:MM:SS` (space) form — V8's legacy parser treats that form as
 * machine-LOCAL time, so `new Date(ts)` silently shifts by the host's offset
 * on machines outside UTC. ISO rows (`...T10:00:00.123Z`, pre-v40 data) parse
 * as UTC natively. Use this everywhere a stored timestamp is turned into a
 * Date (reports, receipts, KDS clocks, auth token staleness, telemetry).
 */
export function parseDbTimestamp(ts: string | null | undefined): Date {
  if (!ts) return new Date(NaN);
  // Space form: append a Z so V8 parses it as UTC instead of machine-local.
  return /^\d{4}-\d{2}-\d{2} /.test(ts) ? new Date(`${ts.replace(' ', 'T')}Z`) : new Date(ts);
}

/**
 * "Today" as a `YYYY-MM-DD` string in UTC. All daily boundaries are UTC —
 * the tenant timezone setting only drives the insights hour/day bucketing,
 * never which day a row belongs to.
 */
export function utcTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `[start, end)` half-open range strings (UTC wall, `YYYY-MM-DD HH:MM:SS`)
 * for a given `YYYY-MM-DD` date. Use with `WHERE col >= ? AND col < ?`
 * against the UTC timestamp columns (`created_at`, `paid_at`, etc.) so
 * indexes apply instead of `date(col) = date('now')`, which can't. #208
 *
 * Bounds are emitted in the space form so string comparisons line up exactly
 * with stored rows (migration v40 normalized all rows to it).
 */
export function utcDayBounds(date: string): [string, string] {
  const [y, m, d] = date.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  const fmt = (dt: Date) => dt.toISOString().replace('T', ' ').replace(/\..*$/, '');
  return [fmt(start), fmt(end)];
}

/** Verify a user PIN against the stored pin_hash. */
export function verifyPin(storedHash: string | null | undefined, inputPin: string | number): boolean {
  if (!storedHash || !inputPin) return false;
  return bcrypt.compareSync(String(inputPin), storedHash);
}

// Issue #150: a voided in-progress item stays on the KDS board, struck
// through, for this long after voiding — long enough for kitchen staff to
// notice it's been pulled — then drops off like a served item would.
export const KDS_VOIDED_ITEM_VISIBILITY_MS = 15 * 60 * 1000;

/**
 * Whether a voided order item should still appear on a KDS surface. Only
 * ever called for status='voided' rows; every other status is a normal
 * KDS-visibility decision the caller already makes. The synthetic negative
 * `void_adjustment` bill line this same void flow inserts (main/routes/index.ts)
 * is never a kitchen item and callers should exclude it before this check
 * even runs, not route it through here.
 */
export function isVoidedItemKdsVisible(voidedAt: string | null | undefined): boolean {
  if (!voidedAt) return true;
  return Date.now() - parseDbTimestamp(voidedAt).getTime() < KDS_VOIDED_ITEM_VISIBILITY_MS;
}

/** Remove customer/payment/order-financial fields from category-scoped KDS payloads. */
export function projectKdsOrder(order: any, restricted: boolean): any {
  if (!restricted) return order;
  const allowedFields = [
    'id', 'order_number', 'type', 'guest_count',
    'special_instructions', 'status', 'created_at', 'updated_at',
    'table_name', 'table_number', 'floor', 'section',
  ];
  return Object.fromEntries(allowedFields.filter((field) => field in order).map((field) => [field, order[field]]));
}

/** Keep category-scoped KDS lines limited to kitchen-operational fields. */
export function projectKdsItem(item: any, restricted: boolean): any {
  if (!restricted) return item;
  const allowedFields = [
    'id', 'order_id', 'product_id', 'product_name', 'product_sku',
    'quantity', 'status', 'special_instructions', 'created_at', 'updated_at',
    'order_number', 'type', 'table_name', 'order_status', 'order_notes', 'order_time',
  ];
  const projected = Object.fromEntries(allowedFields.filter((field) => field in item).map((field) => [field, item[field]]));
  if (Array.isArray(item.addons)) {
    projected.addons = item.addons.map((addon: any) => {
      const safeAddon: Record<string, any> = {};
      for (const field of ['id', 'name', 'quantity']) {
        if (field in addon) safeAddon[field] = addon[field];
      }
      return safeAddon;
    });
  }
  return projected;
}

/** Avoid exposing printer/network credentials in restricted KDS station metadata. */
export function projectKdsStation(station: any, restricted: boolean, userCategoryIds: string[] = []): any {
  if (!restricted) return station;
  const allowedFields = ['id', 'name', 'description', 'category_ids', 'sort_order', 'is_active'];
  const projected = Object.fromEntries(allowedFields.filter((field) => field in station).map((field) => [field, station[field]]));
  if (typeof projected.category_ids === 'string' && userCategoryIds.length > 0) {
    try {
      const parsed = JSON.parse(projected.category_ids);
      if (Array.isArray(parsed)) projected.category_ids = JSON.stringify(parsed.filter((id) => userCategoryIds.includes(String(id))));
    } catch {
      projected.category_ids = '[]';
    }
  }
  return projected;
}

/**
 * Snapshots an order item's selected addons into the normalized
 * order_item_addons table — the only place selected addons are stored (see
 * issue #125; order_items.addons was dropped in migration v28). Silently
 * skips entries missing a name.
 */
export function insertOrderItemAddons(
  dbInstance: Database.Database,
  orderItemId: number | bigint,
  addons: { id?: string; name?: string; price?: number; quantity?: number }[] | null | undefined,
  createdAt: string
): void {
  if (!addons || !Array.isArray(addons) || addons.length === 0) return;
  const addonExists = dbInstance.prepare('SELECT 1 FROM addons WHERE id = ?');
  const insertAddon = dbInstance.prepare(`
    INSERT INTO order_item_addons (order_item_id, addon_id, addon_name, price, quantity, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const addon of addons) {
    if (!addon || !addon.name) continue;
    // addon_id has an FK to addons(id) — if the catalog addon was since
    // deleted (or the id never matched one, e.g. ad-hoc/legacy data), fall
    // back to NULL rather than let the FK violation abort order creation.
    // addon_name/price are the snapshot of record either way.
    const linkedAddonId = addon.id && addonExists.get(addon.id) ? addon.id : null;
    const qty = Math.max(1, Math.floor(Number(addon.quantity) || 1));
    insertAddon.run(orderItemId, linkedAddonId, addon.name, addon.price || 0, qty, createdAt);
  }
}

/** Parse JSON string fields on order_item rows returned from SQLite.
 *  Stored as JSON.stringify(value) — may be "null", "[...]", "{...}" etc.
 *  Returns actual JS value (array / object / null) so the frontend can map/iterate.
 *  addons is not handled here — see attachEffectiveAddons, which resolves it
 *  from the normalized order_item_addons table instead. */
export function parseItemJson(item: any): any {
  const tryParse = (val: any) => {
    if (typeof val !== 'string') return val;
    try { return JSON.parse(val); } catch { return val; }
  };
  return {
    ...item,
    variant_selection: tryParse(item.variant_selection),
    modifier_selection: tryParse(item.modifier_selection),
    tax_breakdown: tryParse(item.tax_breakdown),
    tax_snapshot: tryParse(item.tax_snapshot),
  };
}

/**
 * Resolves selected addons for a batch of order_items rows from the
 * normalized order_item_addons table — the sole source of truth (see issue
 * #125; order_items.addons was dropped in migration v28). Returns new
 * objects with `addons` set to an array (empty if the item has none); does
 * not mutate the input.
 */
export function attachEffectiveAddons<T extends { id: number }>(
  dbInstance: Database.Database,
  items: T[]
): (T & { addons: { id: string | null; name: string; price: number; quantity: number }[] })[] {
  if (items.length === 0) return items as (T & { addons: { id: string | null; name: string; price: number; quantity: number }[] })[];

  const ids = items.map((item) => item.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = dbInstance.prepare(
    `SELECT * FROM order_item_addons WHERE order_item_id IN (${placeholders}) ORDER BY id`
  ).all(...ids) as { order_item_id: number; addon_id: string | null; addon_name: string; price: number; quantity: number }[];

  const byItem = new Map<number, { id: string | null; name: string; price: number; quantity: number }[]>();
  for (const row of rows) {
    const list = byItem.get(row.order_item_id) || [];
    list.push({ id: row.addon_id, name: row.addon_name, price: row.price, quantity: row.quantity });
    byItem.set(row.order_item_id, list);
  }

  return items.map((item) => ({ ...item, addons: byItem.get(item.id) || [] }));
}

/** Parse JSON text columns on bill/order rows returned from SQLite. */
export function parseRowJson(row: any): any {
  if (!row) return row;
  const tryParse = (val: any) => {
    if (typeof val !== 'string') return val;
    try { return JSON.parse(val); } catch { return val; }
  };

  // tax_breakdown is stored as an array of per-item breakdowns (array of arrays).
  // Aggregate into a flat array of { title, rate, amount } for the frontend.
  let taxBreakdown = tryParse(row.tax_breakdown);
  if (Array.isArray(taxBreakdown) && taxBreakdown.length > 0 && Array.isArray(taxBreakdown[0])) {
    const merged: Record<string, { title: string; rate: number; amount: number }> = {};
    for (const itemBreakdown of taxBreakdown) {
      if (!Array.isArray(itemBreakdown)) continue;
      for (const line of itemBreakdown) {
        const key = `${line.title}_${line.rate}`;
        if (!merged[key]) {
          merged[key] = { title: line.title, rate: line.rate, amount: 0 };
        }
        merged[key].amount += line.amount;
      }
    }
    taxBreakdown = Object.values(merged).map((line) => ({
      ...line,
      amount: Math.round(line.amount * 100) / 100,
    }));
  }

  return {
    ...row,
    tax_breakdown: taxBreakdown,
    tax_snapshot: tryParse(row.tax_snapshot),
    payment_details: tryParse(row.payment_details),
  };
}
