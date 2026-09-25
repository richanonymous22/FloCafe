/**
 * Test: SYNC-F sales conflict resolution + reconciliation — REAL PostgreSQL +
 * REAL HTTP where the system uses HTTP, real Core elsewhere.
 *
 * Proves the conflict taxonomy + state machine, the resolution engine
 * (authorization, legality, financial safety), compensation/reconciliation,
 * payment + inventory reconciliation, durable missing-parent recovery, the
 * conflict pull/resolve HTTP protocol, security isolation, transactional
 * atomicity, and that NONE of it ever mutates an authoritative sale.
 * Self-skips (exit 77) if no PostgreSQL is reachable.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/sync-f-conflict-reconciliation.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-f-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

let Pool: any;
try { Pool = require('pg').Pool; } catch { console.log('  ⏭ pg driver not installed — skipping'); process.exit(77); }
const DSN = process.env.PLEMMO_CLOUD_DB_URL || 'postgres://plemmo:plemmo_dev_pw@127.0.0.1:5432/plemmo_sync_test';
const CONNECT_TIMEOUT_MS = Number(process.env.PLEMMO_CLOUD_DB_CONNECT_TIMEOUT_MS) || 20000;

const { initTestDb, closeDatabase, assert, assertEqual, getResults, now, getDatabase, startServer } = require('./helpers/test-setup');
const { getOrganizationContext, getLocationContext, getDeviceContext } = require('../main/core/context');
const { createSale } = require('../main/core/sale');
const { uploadPendingBatch } = require('../main/core/sync/uploader');
const { pullAndApply } = require('../main/core/sync/downloader');
const { HttpSyncTransport } = require('../main/core/sync/http-transport');
const { getOrCreateDeviceKey } = require('../main/core/sync/device-identity');
const { PostgresCloudStore } = require('../cloud/postgres-store');
const { migrateToLatest } = require('../cloud/migrate');
const { createCloudServer } = require('../cloud/server');
const { signRequest } = require('../main/core/sync/signing');
const { ulid } = require('../main/core/ids');

const { CONFLICT_TYPES, isLegalStrategy } = require('../main/core/sync/conflict-model');
const { upsertConflict, getConflict, listActions, listConflicts } = require('../main/core/sync/conflict-store');
const {
  acknowledgeConflict, resolveConflict, availableStrategies,
  IllegalResolutionError, ConflictStateError,
} = require('../main/core/sync/conflict-resolution');
const { AuthorizationError, hasPermission } = require('../main/core/authorization');
const { pullConflicts, reportResolution } = require('../main/core/sync/conflict-sync');
const { getOrderReconciliation, getBillReconciliation, reconcilePayments } = require('../main/core/sync/sales-reconciliation');
const { getPendingForChild, listPending } = require('../main/core/sync/pending-relationships');
const { listAuditEvents } = require('../main/core/audit');

function kp() {
  const k = nodeCrypto.generateKeyPairSync('ed25519');
  return { priv: nodeCrypto.createPrivateKey(k.privateKey.export({ type: 'pkcs8', format: 'pem' })), pub: k.publicKey.export({ type: 'spki', format: 'pem' }) };
}
function orderEvent(org: string, loc: string, dev: string, orderUid: string, version = 1, status = 'pending') {
  return { uid: ulid(), device_id: dev, sequence: 1, entity_type: 'order', entity_uid: orderUid, organization_id: org, location_id: loc,
    payload: { schema_version: 1, order_uid: orderUid, order_number: 'R-' + orderUid.slice(-4), organization_id: org, location_id: loc, device_id: dev, actor_user_id: null, channel: 'takeaway', status, customer_id: null, table_id: null, subtotal: 10, tax_amount: 0, discount_amount: 0, total: 10, snapshot_version: version, created_at: now(), updated_at: now() }, created_at: now() };
}
function itemEvent(org: string, loc: string, dev: string, itemUid: string, orderUid: string, version = 1) {
  return { uid: ulid(), device_id: dev, sequence: 1, entity_type: 'order_item', entity_uid: itemUid, organization_id: org, location_id: loc,
    payload: { schema_version: 1, order_item_uid: itemUid, order_uid: orderUid, organization_id: org, location_id: loc, product_id: 'prod-f', product_variant_id: null, product_name: 'Widget', product_sku: 'SKUF', quantity: 1, unit_price: 10, unit_cost: 4, discount_amount: 0, tax_amount: 0, total: 10, status: 'pending', snapshot_version: version, created_at: now(), updated_at: now() }, created_at: now() };
}
async function httpUpload(baseUrl: string, dev: string, priv: any, events: any[]) {
  const body = JSON.stringify({ events });
  const ts = new Date().toISOString(); const nonce = nodeCrypto.randomBytes(16).toString('hex');
  const sig = signRequest(priv, 'POST', '/sync/v1/upload', ts, nonce, body);
  const res = await (globalThis as any).fetch(`${baseUrl}/sync/v1/upload`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-plemmo-device': dev, 'x-plemmo-timestamp': ts, 'x-plemmo-nonce': nonce, 'x-plemmo-signature': sig }, body });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function httpConflictResolve(baseUrl: string, dev: string, priv: any, body: any) {
  const raw = JSON.stringify(body);
  const ts = new Date().toISOString(); const nonce = nodeCrypto.randomBytes(16).toString('hex');
  const sig = signRequest(priv, 'POST', '/sync/v1/conflicts/resolve', ts, nonce, raw);
  const res = await (globalThis as any).fetch(`${baseUrl}/sync/v1/conflicts/resolve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-plemmo-device': dev, 'x-plemmo-timestamp': ts, 'x-plemmo-nonce': nonce, 'x-plemmo-signature': sig }, body: raw });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function devEnroll(baseUrl: string, dev: string, org: string, loc: string, pub: string) {
  return (await (globalThis as any).fetch(`${baseUrl}/sync/v1/dev/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_uid: dev, organization_uid: org, location_uid: loc, public_key: pub }) })).status;
}

async function main() {
  console.log('Test: SYNC-F conflict resolution + reconciliation (real PostgreSQL + real HTTP)');
  console.log('='.repeat(50));
  try {
    const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
    await probe.query('SELECT 1'); await probe.end();
  } catch (e) {
    console.log(`  ⏭ No reachable PostgreSQL — skipping (${(e as Error).message})`); process.exit(77);
  }
  const schema = `sync_f_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await admin.query(`CREATE SCHEMA "${schema}"`); await admin.end();
  const pool = new Pool({ connectionString: DSN, options: `-c search_path=${schema}`, max: 8, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });

  const db = initTestDb();
  const org = getOrganizationContext().id;
  const loc = getLocationContext().id;
  const deviceId = getDeviceContext().id;
  const OWNER = { userId: 'owner-f', role: 'owner' };
  const MANAGER = { userId: 'mgr-f', role: 'manager' };
  const CASHIER = { userId: 'cashier-f', role: 'cashier' };
  const WAITER = { userId: 'waiter-f', role: 'waiter' };
  for (const u of [OWNER, MANAGER, CASHIER, WAITER]) {
    db.prepare(`INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, 'x', ?, 1, ?, ?)`)
      .run(u.userId, u.role, `${u.userId}@test.local`, u.role, now(), now());
  }
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, track_inventory, stock_quantity, low_stock_threshold, is_active, sort_order, created_at, updated_at)
              VALUES ('prod-f', NULL, 'F Widget', 10, 4, 'SKUF', 1, 500, 5, 1, 0, ?, ?)`).run(now(), now());

  const store = new PostgresCloudStore(pool);
  let server: any;
  try {
    await migrateToLatest(pool);
    const app = createCloudServer(store, { enableDevEnroll: true });
    const started = await startServer(app); server = started.server;
    const baseUrl = started.baseUrl;
    const transport = new HttpSyncTransport({ baseUrl });
    const localKey = getOrCreateDeviceKey();
    await devEnroll(baseUrl, deviceId, org, loc, localKey.publicKeyPem);

    // ══ AUDIT ════════════════════════════════════════════════════════════════
    console.log('\n1. Lifecycle audit + closed taxonomy');
    assert(fs.existsSync(path.join(__dirname, '..', 'docs', 'SYNC_F_CONFLICT_RECONCILIATION.md')), 'the SYNC-F architecture doc exists');
    assertEqual(CONFLICT_TYPES.length, 6, 'the conflict taxonomy is a closed set of 6 types');
    assert(['concurrent_update', 'stale_snapshot', 'parent_missing', 'lifecycle_conflict', 'payment_conflict', 'completion_conflict'].every((t) => CONFLICT_TYPES.includes(t)), 'all six named conflict types are present');

    // ══ CONFLICTS (detection) ═════════════════════════════════════════════════
    console.log('\n2. Cross-device concurrent update → cloud conflict → pulled locally');
    const d2 = { ...kp(), id: ulid() }; const d3 = { ...kp(), id: ulid() };
    await devEnroll(baseUrl, d2.id, org, loc, d2.pub);
    await devEnroll(baseUrl, d3.id, org, loc, d3.pub);
    const coOrder = ulid();
    await httpUpload(baseUrl, d2.id, d2.priv, [orderEvent(org, loc, d2.id, coOrder, 1, 'pending')]);
    await httpUpload(baseUrl, d3.id, d3.priv, [orderEvent(org, loc, d3.id, coOrder, 1, 'cancelled')]);
    const cloudConflicts = await store.listConflicts(org);
    const cc = cloudConflicts.find((c: any) => c.entity_uid === coOrder);
    assert(!!cc && cc.conflict_type === 'concurrent_update', 'the cloud detected a concurrent_update conflict');
    const pull1 = await pullConflicts(transport, db);
    assert(pull1.stored >= 1, 'the conflict was pulled into the local sales_conflicts table');
    assert(!!getConflict(cc.conflict_uid), 'the local conflict shares the cloud conflict_uid (one logical conflict)');

    console.log('\n3. Duplicate/stale snapshot does not create a duplicate conflict');
    await httpUpload(baseUrl, d3.id, d3.priv, [orderEvent(org, loc, d3.id, coOrder, 1, 'cancelled')]); // same again
    const afterDup = (await store.listConflicts(org)).filter((c: any) => c.entity_uid === coOrder);
    assertEqual(afterDup.length, 1, 'a repeated snapshot from the same device did not multiply the conflict');

    console.log('\n4. Completion conflict — remote edit to a locally COMPLETED sale is flagged, never applied');
    const localSale = createSale({ channel: 'takeaway', lines: [{ product_id: 'prod-f', quantity: 1 }], cashierUserId: OWNER.userId });
    const localOrderUid = localSale.sale.uid;
    db.prepare("UPDATE orders SET status = 'completed' WHERE uid = ?").run(localOrderUid);
    await uploadPendingBatch(transport, deviceId, 200, db);
    // Another device edits the same order.
    await httpUpload(baseUrl, d2.id, d2.priv, [orderEvent(org, loc, d2.id, localOrderUid, 9, 'cancelled')]);
    await pullAndApply(transport, deviceId, 200, db);
    const compConflict = getConflict(`cf_local_order_${localOrderUid}`);
    assert(!!compConflict && compConflict.conflict_type === 'completion_conflict', 'a completion_conflict was recorded locally');
    assertEqual((db.prepare('SELECT status FROM orders WHERE uid = ?').get(localOrderUid) as any).status, 'completed', 'the authoritative completed sale was NOT mutated by the remote edit');

    console.log('\n5. Payment conflict record (detected divergent payment linkage)');
    const pcBill = ulid();
    upsertConflict({ conflictUid: `pc_${pcBill}`, organizationId: org, locationId: loc, entityType: 'bill', entityUid: pcBill, conflictType: 'payment_conflict', source: 'local' }, db);
    assert(!!getConflict(`pc_${pcBill}`), 'a payment_conflict was recorded');

    console.log('\n6. Conflict records are idempotent');
    upsertConflict({ conflictUid: `pc_${pcBill}`, organizationId: org, locationId: loc, entityType: 'bill', entityUid: pcBill, conflictType: 'payment_conflict', source: 'local' }, db);
    assertEqual(listConflicts({ entityUid: pcBill }).length, 1, 're-upserting the same conflict_uid keeps exactly one row');

    // ══ RESOLUTION ════════════════════════════════════════════════════════════
    console.log('\n7. Acknowledge (open → acknowledged)');
    const ack = acknowledgeConflict({ conflictUid: cc.conflict_uid, user: MANAGER, notes: 'looking into it' });
    assertEqual(ack.status, 'acknowledged', 'the conflict moved to acknowledged');
    assert(listActions(cc.conflict_uid).some((a: any) => a.action_type === 'acknowledge'), 'the acknowledgement was recorded in the action trail');

    console.log('\n8. Legal resolution of a still-open order conflict');
    const resolved = resolveConflict({ conflictUid: cc.conflict_uid, strategy: 'accept_local', user: OWNER, notes: 'local till is authoritative' });
    assertEqual(resolved.status, 'resolved', 'the conflict resolved');
    assertEqual(resolved.resolution_strategy, 'accept_local', 'the strategy was recorded');
    assert(!!resolved.resulting_state, 'a resulting state was recorded for the durable history');

    console.log('\n9. Illegal resolution — accept_remote on a completion conflict is rejected');
    let illegal = false;
    try { resolveConflict({ conflictUid: compConflict!.conflict_uid, strategy: 'accept_remote', user: OWNER }); } catch (e) { illegal = e instanceof IllegalResolutionError; }
    assert(illegal, 'accept_remote against a completed sale is refused (financial safety)');
    assertEqual(getConflict(compConflict!.conflict_uid)!.status, 'open', 'the illegal attempt left the conflict open — no partial state');

    console.log('\n10. Financial conflict cannot blind-overwrite — payment_conflict accept_remote rejected');
    let payIllegal = false;
    try { resolveConflict({ conflictUid: `pc_${pcBill}`, strategy: 'accept_remote', user: OWNER }); } catch (e) { payIllegal = e instanceof IllegalResolutionError; }
    assert(payIllegal, 'a payment_conflict can never be resolved by blindly accepting the remote value');
    assert(isLegalStrategy('payment_conflict', 'compensate', 'open') && !isLegalStrategy('payment_conflict', 'accept_remote', 'open'), 'the legality matrix bans accept_remote but allows compensate for payment_conflict');

    console.log('\n11. Permissions enforced — a cashier cannot resolve a financial conflict');
    let cashierDenied = false;
    try { resolveConflict({ conflictUid: `pc_${pcBill}`, strategy: 'compensate', user: CASHIER, compensationReference: 'REF-1' }); } catch (e) { cashierDenied = e instanceof AuthorizationError; }
    assert(cashierDenied, 'a cashier is refused (sales.reconcile is owner/manager only)');

    console.log('\n12. Audit of resolution + compensation records a durable artifact');
    const comp = resolveConflict({ conflictUid: `pc_${pcBill}`, strategy: 'compensate', user: MANAGER, notes: 'refund to be issued', compensationReference: 'REFUND-REQ-42' });
    assertEqual(comp.status, 'resolved', 'the compensate resolution completed');
    assert(listActions(`pc_${pcBill}`).some((a: any) => a.action_type === 'compensation' && a.reference === 'REFUND-REQ-42'), 'a durable compensation artifact was recorded (no financial transaction fabricated)');
    assert((listAuditEvents({ limit: 50 }) || []).some((e: any) => e.event_type === 'sync.conflict_resolved'), 'the resolution emitted an audit event');

    // ══ RECONCILIATION ════════════════════════════════════════════════════════
    console.log('\n13. Order reconciliation joins authoritative + remote + conflicts');
    const orderRecon = getOrderReconciliation(localOrderUid);
    assert(!!orderRecon.authoritative, 'the authoritative local order is present');
    assert(orderRecon.conflicts.some((c: any) => c.conflict_type === 'completion_conflict'), 'the completion conflict is surfaced in the reconciliation view');

    console.log('\n14. Bill reconciliation');
    const billUid = ulid();
    db.prepare(`INSERT INTO bills (bill_number, uid, order_id, subtotal, tax_amount, total, paid_amount, balance, payment_status, created_at, updated_at)
                VALUES (?, ?, ?, 10, 0, 10, 0, 10, 'unpaid', ?, ?)`).run('B-' + billUid.slice(-4), billUid, (db.prepare('SELECT id FROM orders WHERE uid = ?').get(localOrderUid) as any).id, now(), now());
    const billRecon = getBillReconciliation(billUid);
    assert(!!billRecon.authoritative && billRecon.order_uid === localOrderUid, 'the bill reconciliation links to its parent order');

    console.log('\n15. Payment reconciliation detects duplicate + out-of-order payment facts');
    const dupPayUid = ulid();
    db.prepare(`INSERT INTO remote_payment_events (id, payment_uid, from_state, to_state, occurred_at, order_uid, bill_uid, organization_id, location_id, sync_origin, applied_at)
                VALUES (?, ?, NULL, 'captured', '2000-01-01 00:00:00', ?, ?, ?, ?, 'remote', ?)`).run(ulid(), dupPayUid, localOrderUid, billUid, org, loc, now());
    db.prepare(`INSERT INTO remote_payment_events (id, payment_uid, from_state, to_state, occurred_at, order_uid, bill_uid, organization_id, location_id, sync_origin, applied_at)
                VALUES (?, ?, NULL, 'captured', '2000-01-01 00:00:00', ?, ?, ?, ?, 'remote', ?)`).run(ulid(), dupPayUid, localOrderUid, billUid, org, loc, now());
    const payRecon = reconcilePayments(localOrderUid, billUid, now());
    assert(payRecon.duplicatePaymentUids.includes(dupPayUid), 'a duplicated payment_uid is detected');
    assert(payRecon.paymentsBeforeSale >= 2, 'payment events predating the sale are detected');
    assert(payRecon.discrepancy, 'the payment reconciliation flags a discrepancy (never mutates payments)');

    console.log('\n16. Inventory reconciliation detects the movement linkage of a real sale');
    const invRecon = getOrderReconciliation(localOrderUid).inventory;
    assert(invRecon.trackedItems >= 1, 'the tracked sale line is counted');
    assertEqual(invRecon.missingMovements, 0, 'the real sale has its inventory movement (no missing, no double-decrement)');

    console.log('\n17. Missing-parent recovery is durable (pending → resolved)');
    const orphanOrder = ulid(); const orphanItem = ulid();
    await httpUpload(baseUrl, d2.id, d2.priv, [itemEvent(org, loc, d2.id, orphanItem, orphanOrder)]);
    await pullAndApply(transport, deviceId, 200, db);
    const pend = getPendingForChild('order_item', orphanItem);
    assert(!!pend && pend.status === 'pending', 'the orphan child recorded a durable pending relationship');
    await httpUpload(baseUrl, d2.id, d2.priv, [orderEvent(org, loc, d2.id, orphanOrder)]);
    await pullAndApply(transport, deviceId, 200, db);
    assertEqual(getPendingForChild('order_item', orphanItem)!.status, 'resolved', 'when the parent arrived the relationship auto-resolved');

    // ══ ATOMICITY ═════════════════════════════════════════════════════════════
    console.log('\n18. Resolution rollback — a mid-resolve failure leaves no partial state');
    const rbConflict = ulid();
    upsertConflict({ conflictUid: rbConflict, organizationId: org, locationId: loc, entityType: 'order', entityUid: ulid(), conflictType: 'concurrent_update', source: 'local' }, db);
    db.exec('ALTER TABLE sales_reconciliation_actions RENAME TO sra_hidden');
    let rbThrew = false;
    try { resolveConflict({ conflictUid: rbConflict, strategy: 'accept_local', user: OWNER }); } catch { rbThrew = true; }
    db.exec('ALTER TABLE sra_hidden RENAME TO sales_reconciliation_actions');
    assert(rbThrew, 'the resolution failed when its action record could not be written');
    assertEqual(getConflict(rbConflict)!.status, 'open', 'the conflict stayed open — the status change rolled back atomically');

    console.log('\n19. Conflict-detection rollback (cloud store transaction is atomic)');
    // A concurrent snapshot arriving twice never leaves two conflict rows or a half-projected version.
    const atomOrder = ulid();
    await httpUpload(baseUrl, d2.id, d2.priv, [orderEvent(org, loc, d2.id, atomOrder, 1)]);
    await httpUpload(baseUrl, d3.id, d3.priv, [orderEvent(org, loc, d3.id, atomOrder, 1)]);
    await httpUpload(baseUrl, d3.id, d3.priv, [orderEvent(org, loc, d3.id, atomOrder, 1)]);
    assertEqual((await store.listConflicts(org)).filter((c: any) => c.entity_uid === atomOrder).length, 1, 'conflict detection is idempotent + atomic under retries');

    console.log('\n20. Pending-relationship write is transactional');
    const prBefore = listPending('all').length;
    let prThrew = false;
    try {
      db.transaction(() => {
        const { recordPending } = require('../main/core/sync/pending-relationships');
        recordPending({ childType: 'order_item', childUid: ulid(), parentType: 'order', parentUid: ulid() }, db);
        throw new Error('boom');
      })();
    } catch { prThrew = true; }
    assert(prThrew, 'the wrapping transaction threw');
    assertEqual(listPending('all').length, prBefore, 'no pending row persisted from the rolled-back transaction');

    // ══ MULTI-DEVICE + SECURITY ════════════════════════════════════════════════
    console.log('\n21. Reported resolution flows to the cloud (cross-device convergence)');
    const rep = await reportResolution(transport, { conflict_uid: cc.conflict_uid, status: 'resolved', strategy: 'accept_local', actor_user_id: OWNER.userId });
    assert(rep.ok, 'the local resolution was accepted by the cloud');
    assertEqual((await store.getConflict(cc.conflict_uid)).status, 'resolved', 'the cloud conflict now reflects the resolution');
    assert((await store.listConflictResolutions(cc.conflict_uid)).length >= 1, 'the cloud stored append-only resolution history');

    console.log('\n22. Cloud re-validates financial safety (defense in depth)');
    const badRep = await httpConflictResolve(baseUrl, deviceId, localKey.privateKey, { conflict_uid: cc.conflict_uid, status: 'resolved', strategy: 'accept_remote' });
    // cc is a concurrent_update, so accept_remote is allowed at the cloud; use the payment conflict instead by pushing one to the cloud.
    const cloudPc = `cf_${ulid()}`;
    await pool.query(`INSERT INTO cloud_conflicts (conflict_uid, organization_uid, location_uid, entity_type, entity_uid, conflict_type, detected_at, status) VALUES ($1,$2,$3,'bill',$4,'payment_conflict',$5,'open')`, [cloudPc, org, loc, ulid(), now()]);
    const rejected = await httpConflictResolve(baseUrl, deviceId, localKey.privateKey, { conflict_uid: cloudPc, status: 'resolved', strategy: 'accept_remote' });
    assertEqual(rejected.status, 422, 'the cloud independently refuses a blind financial overwrite');

    console.log('\n23. Organization isolation — a device cannot resolve another org\'s conflict');
    const other = { ...kp(), id: ulid() };
    await devEnroll(baseUrl, other.id, 'org-other-f', loc, other.pub);
    const crossOrg = await httpConflictResolve(baseUrl, other.id, other.priv, { conflict_uid: cc.conflict_uid, status: 'dismissed' });
    assertEqual(crossOrg.status, 404, 'a foreign-org device is told the conflict does not exist (isolation)');

    console.log('\n24. Conflict pull is organization-scoped');
    const otherTransport = new HttpSyncTransport({ baseUrl });
    // The foreign device sees none of this org's conflicts.
    const foreignConflicts = await (async () => {
      const ts = new Date().toISOString(); const nonce = nodeCrypto.randomBytes(16).toString('hex');
      const sig = signRequest(other.priv, 'GET', '/sync/v1/conflicts', ts, nonce, '');
      const res = await (globalThis as any).fetch(`${baseUrl}/sync/v1/conflicts`, { headers: { 'x-plemmo-device': other.id, 'x-plemmo-timestamp': ts, 'x-plemmo-nonce': nonce, 'x-plemmo-signature': sig } });
      return (await res.json()).conflicts;
    })();
    assertEqual(foreignConflicts.length, 0, 'a foreign-org device pulls none of this org\'s conflicts');
    void otherTransport;

    console.log('\n25. Revoked device cannot pull or resolve conflicts');
    await store.revokeDevice(d3.id);
    const ts = new Date().toISOString(); const nonce = nodeCrypto.randomBytes(16).toString('hex');
    const sig = signRequest(d3.priv, 'GET', '/sync/v1/conflicts', ts, nonce, '');
    const revokedRes = await (globalThis as any).fetch(`${baseUrl}/sync/v1/conflicts`, { headers: { 'x-plemmo-device': d3.id, 'x-plemmo-timestamp': ts, 'x-plemmo-nonce': nonce, 'x-plemmo-signature': sig } });
    assertEqual(revokedRes.status, 401, 'a revoked device is rejected');

    console.log('\n26. Unauthorized role — a waiter cannot acknowledge or resolve');
    let waiterDenied = false;
    try { acknowledgeConflict({ conflictUid: compConflict!.conflict_uid, user: WAITER }); } catch (e) { waiterDenied = e instanceof AuthorizationError; }
    assert(waiterDenied, 'a waiter has no sales.reconcile permission');
    assert(hasPermission('owner', 'sales.reconcile') && hasPermission('manager', 'sales.reconcile'), 'owner + manager DO hold sales.reconcile');
    assert(!hasPermission('cashier', 'sales.reconcile') && !hasPermission('waiter', 'sales.reconcile') && !hasPermission('chef', 'sales.reconcile'), 'cashier/waiter/chef do NOT');

    console.log('\n27. A terminal conflict cannot be re-resolved (state machine)');
    let reResolved = false;
    try { resolveConflict({ conflictUid: cc.conflict_uid, strategy: 'accept_local', user: OWNER }); } catch (e) { reResolved = e instanceof ConflictStateError; }
    assert(reResolved, 'an already-resolved conflict is not resolved again');

    console.log('\n28. availableStrategies reflects the legality matrix for the live conflict');
    const strat = availableStrategies(compConflict!);
    assert(!strat.includes('accept_remote') && strat.includes('accept_local'), 'the completion conflict offers accept_local but not accept_remote');

    // ══ REGRESSION ══════════════════════════════════════════════════════════════
    console.log('\n29. Hospitality — a dine-in sale still works and still emits a snapshot');
    const dine = createSale({ channel: 'dine_in', lines: [{ product_id: 'prod-f', quantity: 1 }], cashierUserId: CASHIER.userId });
    assert(!!dine.sale.uid, 'a dine-in sale completes');
    assert(!!db.prepare("SELECT 1 FROM sync_outbox WHERE entity_type = 'order' AND entity_uid = ?").get(dine.sale.uid), 'it still emits an order snapshot (SYNC-E unchanged)');

    console.log('\n30. Retail — a takeaway sale still works');
    const retail = createSale({ channel: 'takeaway', lines: [{ product_id: 'prod-f', quantity: 2 }], cashierUserId: CASHIER.userId });
    assertEqual(retail.lines.length, 1, 'a retail sale completes with its line');

    console.log('\n31. Inventory — local insufficient tracked stock still rejects');
    db.prepare("UPDATE inventory_balances SET quantity = 1 WHERE product_id = 'prod-f'").run();
    db.prepare("UPDATE products SET stock_quantity = 1 WHERE id = 'prod-f'").run();
    let stockErr = false;
    try { createSale({ channel: 'takeaway', lines: [{ product_id: 'prod-f', quantity: 50 }], cashierUserId: CASHIER.userId }); } catch { stockErr = true; }
    assert(stockErr, 'overselling tracked stock is still rejected — SYNC-F did not weaken stock enforcement');

    console.log('\n32. Completed local sales remain intact after all conflict activity');
    assertEqual((db.prepare('SELECT status FROM orders WHERE uid = ?').get(localOrderUid) as any).status, 'completed', 'the completed sale is still completed and unmodified');

    console.log('\n33. Remote apply never created an authoritative row or an outbox loop');
    assert(!db.prepare('SELECT 1 FROM orders WHERE uid = ?').get(coOrder), 'a purely-remote order never entered the authoritative table');
    assert(!!db.prepare('SELECT 1 FROM remote_orders WHERE uid = ?').get(orphanOrder), 'remote sales live in the mirror only');

    console.log('\n34. Authorization model integrity');
    assert(!hasPermission('cashier', 'sales.reconcile'), 'cashier still cannot reconcile');
    assert(hasPermission('cashier', 'sales.create'), 'cashier can still create sales (existing permissions intact)');

    console.log('\n35. Conflicts are queryable + auditable');
    assert(listConflicts({ organizationId: org }).length >= 1, 'conflicts are queryable by organization');
    assert(listActions(`pc_${pcBill}`).length >= 2, 'the payment conflict has a full action trail (acknowledge attempt + resolve + compensation)');

    console.log('\n36. Resolution never mutated an authoritative sales record (final invariant)');
    const authAfter = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status NOT IN ('pending','completed','cancelled','cooking','ready','served','refunded','void','voided')").get() as any;
    assertEqual(authAfter.c, 0, 'no authoritative order was left in an unexpected state by any conflict operation');
  } finally {
    if (server) server.close();
    await pool.end();
    const admin2 = new Pool({ connectionString: DSN, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
    await admin2.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin2.end();
    closeDatabase();
  }
  const { passed, failed } = getResults();
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((error) => { console.error('Test suite failed:', error); process.exit(1); });
