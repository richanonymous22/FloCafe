/**
 * Test: Plemmo Core audit events (main/core/audit.ts)
 *
 * The behaviours that matter: an event records who/what/when/where, it is
 * enrolled in the caller's transaction so it cannot disagree with the thing it
 * describes, and — most importantly — a failure to audit can never break a
 * sale.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/plemmo-audit.test.ts
 */

// ── Electron Mock (must be before any app imports) ───────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plemmo-audit-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, getResults, closeDatabase, assert, assertEqual } = require('./helpers/test-setup');
const { recordAuditEvent, listAuditEvents, listAuditEventsForEntity, resetAuditPlaceCache } = require('../main/core/audit');
const { isUlid } = require('../main/core/ids');
const { withTxn } = require('../main/db');

async function main() {
  console.log('Test: Plemmo Core audit events');
  console.log('='.repeat(50));

  const db = initTestDb();
  resetAuditPlaceCache();

  // ── 1. Who / what / when / where ─────────────────────────────────────────
  console.log('\n1. An event records who, what, when and where');
  const id = recordAuditEvent({
    type: 'sale.refunded',
    actor: { userId: 'user-42', role: 'manager' },
    entity: { type: 'sale', id: 1234 },
    summary: 'Refunded £10.99 — item faulty',
    metadata: { amount_minor: 1099, reason: 'faulty' },
  });
  assert(!!id && isUlid(id), 'recordAuditEvent returns a ULID id');

  const row = db.prepare('SELECT * FROM audit_events WHERE id = ?').get(id) as any;
  assertEqual(row.event_type, 'sale.refunded', 'WHAT: the event type is stored');
  assertEqual(row.actor_user_id, 'user-42', 'WHO: the actor user id is stored');
  assertEqual(row.actor_role, 'manager', 'WHO: the actor role is stored');
  assertEqual(row.entity_type, 'sale', 'the entity type is stored');
  assertEqual(row.entity_id, '1234', 'the entity id is stored as text so integer and ULID keys both fit');
  assert(!!row.occurred_at, 'WHEN: occurred_at is set');
  assertEqual(row.summary, 'Refunded £10.99 — item faulty', 'the human-readable summary survives round-trip');

  // WHERE comes from the v68 settings pointers, with no caller involvement.
  const pointer = (key: string) =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  assertEqual(row.organization_id, pointer('plemmo_organization_id'), 'WHERE: organization is stamped automatically');
  assertEqual(row.location_id, pointer('plemmo_location_id'), 'WHERE: location is stamped automatically');
  assertEqual(row.register_id, pointer('plemmo_register_id'), 'WHERE: register is stamped automatically');
  assertEqual(row.device_id, pointer('plemmo_device_id'), 'WHERE: device is stamped automatically');

  // ── 2. Metadata ──────────────────────────────────────────────────────────
  console.log('\n2. Metadata');
  const events = listAuditEvents({ limit: 10 });
  assert(events.length >= 1, 'listAuditEvents returns the event');
  assertEqual(events[0].metadata.amount_minor, 1099, 'metadata is parsed back into an object');
  assertEqual(events[0].metadata.reason, 'faulty', 'all metadata keys survive');

  const noMeta = recordAuditEvent({ type: 'settings.changed', summary: 'no metadata' });
  const noMetaRow = listAuditEvents({ limit: 1 })[0];
  assert(!!noMeta, 'an event with no metadata still records');
  assertEqual(noMetaRow.metadata, null, 'absent metadata reads back as null, not "undefined"');

  // ── 3. System events ─────────────────────────────────────────────────────
  console.log('\n3. System-initiated events');
  const sysId = recordAuditEvent({ type: 'database.maintenance', summary: 'Automatic backup' });
  const sysRow = db.prepare('SELECT * FROM audit_events WHERE id = ?').get(sysId) as any;
  assertEqual(sysRow.actor_user_id, null, 'a system event has a null actor rather than a fake one');

  // ── 4. Querying ──────────────────────────────────────────────────────────
  console.log('\n4. Querying');
  recordAuditEvent({ type: 'product.price_changed', entity: { type: 'product', id: 'prod-1' }, metadata: { from: 500, to: 550 } });
  recordAuditEvent({ type: 'product.price_changed', entity: { type: 'product', id: 'prod-1' }, metadata: { from: 550, to: 600 } });
  recordAuditEvent({ type: 'product.price_changed', entity: { type: 'product', id: 'prod-2' }, metadata: { from: 100, to: 120 } });

  const byType = listAuditEvents({ eventType: 'product.price_changed', limit: 50 });
  assertEqual(byType.length, 3, 'filtering by event type returns only that type');

  const history = listAuditEventsForEntity('product', 'prod-1');
  assertEqual(history.length, 2, 'entity history returns only that entity\'s events');
  assertEqual(history[0].metadata.from, 500, 'entity history is oldest-first, so it reads as a story');
  assertEqual(history[1].metadata.from, 550, 'the second price change follows the first');

  const capped = listAuditEvents({ limit: 99999 });
  assert(capped.length <= 1000, 'limit is clamped so a caller cannot pull the whole table');

  // ── 5. Ordering ──────────────────────────────────────────────────────────
  console.log('\n5. Ordering');
  const recent = listAuditEvents({ limit: 100 });
  const sortedDesc = recent.slice().sort((a: any, b: any) =>
    (b.occurred_at.localeCompare(a.occurred_at)) || b.id.localeCompare(a.id));
  assert(
    recent.every((e: any, i: number) => e.id === sortedDesc[i].id),
    'listAuditEvents returns newest first, tie-broken by ULID so same-second events stay ordered',
  );

  // ── 6. Transaction enrolment ─────────────────────────────────────────────
  console.log('\n6. Transaction behaviour');
  const before = (db.prepare('SELECT COUNT(*) AS c FROM audit_events').get() as any).c;
  let rolledBack = false;
  try {
    withTxn(() => {
      recordAuditEvent({ type: 'sale.created', entity: { type: 'sale', id: 'rollback-me' }, summary: 'should not survive' });
      throw new Error('simulated business failure');
    });
  } catch {
    rolledBack = true;
  }
  assert(rolledBack, 'the transaction threw as expected');
  const after = (db.prepare('SELECT COUNT(*) AS c FROM audit_events').get() as any).c;
  assertEqual(after, before, 'an audit row written inside a rolled-back transaction is rolled back with it');

  const committed = (() => withTxn(() => recordAuditEvent({
    type: 'sale.created', entity: { type: 'sale', id: 'keep-me' }, summary: 'should survive',
  })))();
  assert(!!db.prepare('SELECT 1 FROM audit_events WHERE id = ?').get(committed),
    'an audit row written inside a committed transaction survives');

  // ── 7. Auditing must never break a sale ──────────────────────────────────
  console.log('\n7. Failure containment');
  db.exec('ALTER TABLE audit_events RENAME TO audit_events_hidden');
  let threw = false;
  let result: string | null = 'sentinel';
  try {
    result = recordAuditEvent({ type: 'sale.created', summary: 'table is missing' });
  } catch {
    threw = true;
  }
  assert(!threw, 'a failing audit write does not throw — a broken audit table must never stop a merchant trading');
  assertEqual(result, null, 'a failed write returns null');
  db.exec('ALTER TABLE audit_events_hidden RENAME TO audit_events');

  closeDatabase();
  const results = getResults();
  console.log(`\n${results.failed === 0 ? '✅' : '❌'} ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
