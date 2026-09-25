/**
 * Test: Plemmo Core distributed identifiers (main/core/ids.ts) and the
 * migration that attaches them to the transactional tables.
 *
 * The property that matters is the one that cannot be tested by inspection:
 * two tills, trading with no network between them, must never mint the same
 * identifier for two different sales. Everything else here supports that.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/plemmo-identifiers.test.ts
 */

// ── Electron Mock (must be before any app imports) ───────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plemmo-ids-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, getResults, closeDatabase, assert, assertEqual } = require('./helpers/test-setup');
const { ulid, isUlid, ulidTime, ULID_LENGTH, __resetUlidStateForTests } = require('../main/core/ids');

async function main() {
  console.log('Test: Plemmo Core distributed identifiers');
  console.log('='.repeat(50));

  // ── 1. Format ────────────────────────────────────────────────────────────
  console.log('\n1. ULID format');
  const id = ulid();
  assertEqual(id.length, ULID_LENGTH, 'a ULID is 26 characters');
  assert(isUlid(id), 'a generated ULID validates');
  assert(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id), 'uses Crockford base32 (no I, L, O or U)');
  assert(!isUlid(''), 'empty string is not a ULID');
  assert(!isUlid('not-a-ulid'), 'arbitrary text is not a ULID');
  assert(!isUlid(id.toLowerCase()), 'lowercase is rejected — canonical form is upper');
  assert(!isUlid(id + 'X'), 'a 27-character string is rejected');
  assert(!isUlid(null), 'null is not a ULID');

  // ── 2. Uniqueness — the whole point ──────────────────────────────────────
  console.log('\n2. Uniqueness');
  const many = new Set<string>();
  for (let i = 0; i < 100_000; i++) many.add(ulid());
  assertEqual(many.size, 100_000, '100,000 IDs generated in a tight loop are all distinct');

  // Simulate two tills generating concurrently with no coordination. This is
  // the scenario integer AUTOINCREMENT gets wrong: both would start at 1.
  __resetUlidStateForTests();
  const tillA: string[] = [];
  for (let i = 0; i < 5000; i++) tillA.push(ulid());
  __resetUlidStateForTests();
  const tillB: string[] = [];
  for (let i = 0; i < 5000; i++) tillB.push(ulid());
  const overlap = tillA.filter((x) => tillB.includes(x));
  assertEqual(overlap.length, 0, 'two independent (offline) generators produce no colliding IDs');

  // ── 3. Time ordering ─────────────────────────────────────────────────────
  console.log('\n3. Time ordering');
  __resetUlidStateForTests();
  const sequential: string[] = [];
  for (let i = 0; i < 1000; i++) sequential.push(ulid());
  const sorted = sequential.slice().sort();
  assert(
    sequential.every((v, i) => v === sorted[i]),
    'IDs minted in sequence sort lexicographically in that same order (monotonic within a millisecond)',
  );

  __resetUlidStateForTests();
  const early = ulid(1_000_000_000_000);
  const late = ulid(2_000_000_000_000);
  assert(early < late, 'an earlier timestamp sorts before a later one');
  assertEqual(ulidTime(early), 1_000_000_000_000, 'the creation time is recoverable from the ID');
  assertEqual(ulidTime(late), 2_000_000_000_000, 'the creation time is recoverable from the ID (later)');

  // A till whose clock steps backwards (NTP correction) must not re-issue IDs
  // that could collide with ones already handed out.
  __resetUlidStateForTests();
  const beforeJump = ulid(1_700_000_000_000);
  const afterJump = ulid(1_699_999_999_000);
  assert(afterJump > beforeJump, 'a backwards clock step still yields a strictly increasing ID');
  assert(isUlid(afterJump), 'the ID produced after a backwards clock step is still well-formed');

  let threw = false;
  try { ulidTime('nope'); } catch { threw = true; }
  assert(threw, 'ulidTime rejects a non-ULID');

  // ── 4. Migration: the hierarchy tables ───────────────────────────────────
  console.log('\n4. Migration v68 — organization hierarchy');
  const db = initTestDb();

  for (const table of ['organizations', 'locations', 'registers', 'devices']) {
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table);
    assert(!!row, `${table} table exists on a fresh install`);
  }

  const org = db.prepare('SELECT * FROM organizations').all() as any[];
  assertEqual(org.length, 1, 'exactly one organization is seeded (the local DB is single-tenant)');
  assert(isUlid(org[0].id), 'the organization id is a ULID');

  const loc = db.prepare('SELECT * FROM locations').all() as any[];
  assertEqual(loc.length, 1, 'exactly one location is seeded');
  assert(isUlid(loc[0].id), 'the location id is a ULID');
  assertEqual(loc[0].organization_id, org[0].id, 'the location belongs to the organization');

  const reg = db.prepare('SELECT * FROM registers').all() as any[];
  assertEqual(reg.length, 1, 'exactly one register is seeded');
  assertEqual(reg[0].location_id, loc[0].id, 'the register belongs to the location');

  const dev = db.prepare('SELECT * FROM devices').all() as any[];
  assertEqual(dev.length, 1, 'exactly one device is seeded');
  assertEqual(dev[0].register_id, reg[0].id, 'the device belongs to the register');
  assertEqual(dev[0].status, 'active', 'the seeded device is active');

  const pointer = (key: string) =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  assertEqual(pointer('plemmo_organization_id'), org[0].id, 'settings pointer resolves the organization');
  assertEqual(pointer('plemmo_location_id'), loc[0].id, 'settings pointer resolves the location');
  assertEqual(pointer('plemmo_register_id'), reg[0].id, 'settings pointer resolves the register');
  assertEqual(pointer('plemmo_device_id'), dev[0].id, 'settings pointer resolves the device');

  // Referential integrity of the chain must actually hold.
  const fkViolations = db.prepare('PRAGMA foreign_key_check').all() as any[];
  assertEqual(fkViolations.length, 0, 'the org > location > register > device chain has no FK violations');

  // ── 5. Migration: uid columns ────────────────────────────────────────────
  console.log('\n5. Migration v69 — uid columns on transactional tables');
  for (const table of ['orders', 'order_items', 'bills']) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
    assert(cols.includes('uid'), `${table}.uid column exists`);
    assert(cols.includes('id'), `${table}.id (the original integer key) is untouched`);
  }

  // The unique index must actually reject a duplicate — this is the constraint
  // that stops a future sync silently merging two different sales.
  db.prepare(`INSERT INTO orders (order_number, type, status, uid, created_at, updated_at)
              VALUES ('T-UID-1', 'takeaway', 'pending', ?, ?, ?)`).run(ulid(), '2026-01-01 10:00:00', '2026-01-01 10:00:00');
  const dupUid = (db.prepare("SELECT uid FROM orders WHERE order_number = 'T-UID-1'").get() as any).uid;
  let uniqueEnforced = false;
  try {
    db.prepare(`INSERT INTO orders (order_number, type, status, uid, created_at, updated_at)
                VALUES ('T-UID-2', 'takeaway', 'pending', ?, ?, ?)`).run(dupUid, '2026-01-01 10:00:01', '2026-01-01 10:00:01');
  } catch {
    uniqueEnforced = true;
  }
  assert(uniqueEnforced, 'a duplicate uid is rejected by the unique index');

  // The index is partial, so rows that predate uid-aware inserts still work.
  let nullsAllowed = true;
  try {
    db.prepare(`INSERT INTO orders (order_number, type, status, created_at, updated_at)
                VALUES ('T-UID-3', 'takeaway', 'pending', ?, ?)`).run('2026-01-01 10:00:02', '2026-01-01 10:00:02');
    db.prepare(`INSERT INTO orders (order_number, type, status, created_at, updated_at)
                VALUES ('T-UID-4', 'takeaway', 'pending', ?, ?)`).run('2026-01-01 10:00:03', '2026-01-01 10:00:03');
  } catch {
    nullsAllowed = false;
  }
  assert(nullsAllowed, 'multiple NULL uids are allowed — the unique index is partial, so legacy insert paths still work');

  // ── 6. Migration: audit_events ───────────────────────────────────────────
  console.log('\n6. Migration v70 — audit events');
  const auditTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_events'").get();
  assert(!!auditTable, 'audit_events table exists');
  const auditCols = (db.prepare('PRAGMA table_info(audit_events)').all() as any[]).map((c) => c.name);
  for (const col of ['id', 'occurred_at', 'event_type', 'actor_user_id', 'entity_type', 'entity_id', 'location_id', 'register_id', 'device_id', 'metadata']) {
    assert(auditCols.includes(col), `audit_events.${col} exists`);
  }

  closeDatabase();
  const results = getResults();
  console.log(`\n${results.failed === 0 ? '✅' : '❌'} ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
