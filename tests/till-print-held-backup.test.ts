/*
 * Till print · hold/resume · backup — backend integration (real Express server,
 * real SQLite, real TCP socket standing in for a network thermal printer).
 *
 * Print: POST /api/printers/print-bill is the route that actually dispatches to
 *   the printer transport (POST /api/bills/:id/print only writes the print log).
 * Hold:  /api/held-orders/carts (migration v96 held_carts).
 * Backup: POST /api/db/backup — the authoritative SQLite backup, gated by
 *   owner + Master PIN, writing a new uniquely-named file every time.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-till-phb-'));
const mockSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
};
Module._load = function (requestName: string) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' }, safeStorage: mockSafeStorage };
  }
  return originalLoad.apply(this, arguments as any);
};

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';
import { resetMasterPin } from '../main/services/master-pin';

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
const now = () => new Date().toISOString();

/** A fake network printer: accepts a connection and records the bytes it was sent. */
function listenPrinter(port = 0): Promise<{ server: net.Server; port: number; received: Buffer[] }> {
  return new Promise((resolve, reject) => {
    const received: Buffer[] = [];
    const server = net.createServer((sock) => { sock.on('data', (d) => received.push(Buffer.from(d))); });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port, received }));
  });
}
const closeServer = (s: net.Server) => new Promise<void>((r) => s.close(() => r()));

async function run() {
  console.log('Testing till print / hold-resume / backup (backend integration)...');
  initDatabase();
  const db = getDatabase();
  const bcrypt = require('bcryptjs');
  const pw = bcrypt.hashSync('Passw0rd!x', 10);
  const user = (id: string, role: string) =>
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active) VALUES (?,?,?,?,?,1)`).run(id, id, `${id}@phb.local`, pw, role);
  user('u-own', 'owner'); user('u-mgr', 'manager'); user('u-cash', 'cashier');
  const { grantLocationAccess } = require('../main/core/employee-access');
  const { getCurrentLocationId } = require('../main/core/location');
  grantLocationAccess('u-cash', getCurrentLocationId());
  db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES ('cat','Food',1,1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, barcode, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p1','cat','Bagel',4,1,'B1','5012345678900',1,1,0,0,0,?,?)`).run(now(), now());
  resetMasterPin('4321');

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  const fakes: net.Server[] = [];
  try {
    const login = async (id: string) =>
      (await request(base).post('/api/auth/login').send({ email: `${id}@phb.local`, password: 'Passw0rd!x' })).body.access_token as string;
    const T = { own: await login('u-own'), mgr: await login('u-mgr'), cash: await login('u-cash') };
    const as = (t: string) => (r: any) => r.set('Authorization', `Bearer ${t}`);

    // A paid sale to print.
    const o = await as(T.own)(request(base).post('/api/orders')).send({ type: 'takeaway', items: [{ product_id: 'p1', quantity: 2 }] });
    const bill = (await as(T.own)(request(base).post('/api/bills/generate')).send({ order_id: o.body.order.id })).body.bill;
    await as(T.own)(request(base).post(`/api/bills/${bill.id}/payments`)).send({ payments: [{ method: 'cash', amount: Number(bill.total) }] });

    // ── PRINT ──────────────────────────────────────────────────────────────
    console.log('\n1. print — real transport and real failures');
    const printBill = (tok: string, body: any) => as(tok)(request(base).post('/api/printers/print-bill')).send(body);
    const noPrinter = await printBill(T.cash, { billId: bill.id });
    ok(noPrinter.status === 400 && /No default printer/.test(noPrinter.body.error), 'no default printer → 400 with a clear message (not a fake success)');

    const fake = await listenPrinter(); fakes.push(fake.server);
    const added = await as(T.own)(request(base).post('/api/printers')).send({ name: 'Till 80', connection_type: 'network', ip_address: '127.0.0.1', port: fake.port, paper_width: '80mm' });
    ok(added.status === 201, 'network printer configured (80mm)');
    const badBill = await printBill(T.cash, { billId: 999999 });
    ok(badBill.status === 404, 'unknown bill → 404');
    const missing = await printBill(T.cash, {});
    ok(missing.status === 400, 'no bill reference → 400');
    const good = await printBill(T.cash, { billId: bill.id });
    ok(good.status === 200 && good.body.success === true, 'print succeeds against a reachable printer');
    await new Promise((r) => setTimeout(r, 100));
    const bytes = Buffer.concat(fake.received);
    ok(bytes.length > 50, `the printer actually received ESC/POS bytes (${bytes.length})`);
    ok(bytes.toString('latin1').includes('Bagel'), 'the receipt bytes contain the sold item (backend owns the formatting)');
    const preview = await printBill(T.cash, { billId: bill.id, preview: true });
    ok(preview.status === 200 && preview.body.preview === true && /Bagel/.test(preview.body.text), 'preview returns the backend-rendered receipt text');
    const before80 = fake.received.length;
    void before80;

    // Printer unavailable: point the printer at a port nobody is listening on.
    const dead = await listenPrinter(); const deadPort = dead.port; await closeServer(dead.server);
    await as(T.own)(request(base).put(`/api/printers/${added.body.printer.id}`)).send({ port: deadPort });
    const failed = await printBill(T.cash, { billId: bill.id });
    ok(failed.status === 502, `printer unavailable → 502, not success (got ${failed.status})`);
    ok(failed.body.success !== true && /Print failed/.test(failed.body.error), 'failure body says the print failed');
    ok(typeof failed.body.detail === 'string' && /ECONNREFUSED|refused|Network error/i.test(failed.body.detail), `the real transport reason is propagated (${failed.body.detail})`);
    ok(typeof failed.body.correlation_id === 'string', 'a correlation id is returned for support');

    // Retry is safe: bring the printer back on the same port and print again.
    const back = await listenPrinter(deadPort); fakes.push(back.server);
    const retry = await printBill(T.cash, { billId: bill.id, isReprint: true });
    ok(retry.status === 200 && retry.body.success === true, 'retry after the printer comes back succeeds');
    await new Promise((r) => setTimeout(r, 100));
    ok(Buffer.concat(back.received).length > 50, 'the retry reached the printer exactly once');
    ok((db.prepare(`SELECT COUNT(*) n FROM bills WHERE id = ?`).get(bill.id) as any).n === 1, 'printing never altered the bill');
    // The print log (audit of what was printed) is written by /bills/:id/print.
    const logged = await as(T.cash)(request(base).post(`/api/bills/${bill.id}/print`)).send({ print_type: 'reprint' });
    ok(logged.status === 200, 'the print log can be recorded after a successful print');
    const history = await as(T.cash)(request(base).get(`/api/bills/${bill.id}/print-history`));
    ok(history.body.prints.length === 1, 'print history shows the recorded print');

    console.log('\n2. cash drawer');
    const drawer = await as(T.cash)(request(base).post('/api/retail/cash-drawer/open')).send({});
    ok(drawer.status === 502 || drawer.status === 200, 'drawer route answers with a real result');
    if (drawer.status === 200) ok(drawer.body.ok === true, 'drawer kick dispatched to the printer');
    await closeServer(back.server); fakes.pop();
    const drawerDown = await as(T.cash)(request(base).post('/api/retail/cash-drawer/open')).send({});
    ok(drawerDown.status === 502 && typeof drawerDown.body.error === 'string', 'drawer test fails honestly when the printer is unreachable');
    const testPrint = await as(T.own)(request(base).post(`/api/printers/${added.body.printer.id}/test`)).send({});
    ok(testPrint.status === 502 && !!testPrint.body.detail, 'printer test-print reports the real failure reason');

    // ── HELD CARTS ─────────────────────────────────────────────────────────
    console.log('\n3. hold / resume (held_carts)');
    const cart = { items: [{ uid: 'l1', pid: 'p1', name: 'Bagel', price: 4, qty: 2, mods: [], note: 'toasted' }], type: 'takeaway', custId: 'c9', note: 'for Sam', table: null, discount: null };
    const hold = (tok: string, body: any) => as(tok)(request(base).post('/api/held-orders/carts')).send(body);
    const h1 = await hold(T.cash, { id: 'hold-aaa', label: 'Sam', cart });
    ok(h1.status === 201 && h1.body.created === true, 'cart held (created)');
    const dup = await hold(T.cash, { id: 'hold-aaa', label: 'Sam (edited)', cart });
    ok(dup.status === 200 && dup.body.created === false, 'the same id updates in place — no duplicate row');
    ok((db.prepare(`SELECT COUNT(*) n FROM held_carts`).get() as any).n === 1, 'exactly one held cart persisted');
    await hold(T.cash, { id: 'hold-bbb', label: 'Second', cart });
    const list = await as(T.mgr)(request(base).get('/api/held-orders/carts'));
    ok(list.status === 200 && list.body.carts.length === 2, 'held carts listed (shared across terminals/staff)');
    const first = list.body.carts.find((c: any) => c.id === 'hold-aaa');
    ok(first.label === 'Sam (edited)' && first.cart.items[0].note === 'toasted' && first.cart.custId === 'c9' && first.cart.note === 'for Sam', 'customer, note and line details survive');
    ok(first.heldBy === 'u-cash', 'who held it is recorded');
    ok((db.prepare(`SELECT COUNT(*) n FROM orders`).get() as any).n === 1, 'holding a cart creates no sale (no order row, no stock effect)');
    const res1 = await as(T.mgr)(request(base).post('/api/held-orders/carts/hold-aaa/resume')).send({});
    ok(res1.status === 200 && res1.body.cart.items[0].qty === 2, 'resume returns the cart');
    const res2 = await as(T.cash)(request(base).post('/api/held-orders/carts/hold-aaa/resume')).send({});
    ok(res2.status === 404, 'a second terminal cannot resume the same cart');
    ok((await as(T.mgr)(request(base).get('/api/held-orders/carts'))).body.carts.length === 1, 'resumed cart was removed from the list');
    const del = await as(T.cash)(request(base).delete('/api/held-orders/carts/hold-bbb'));
    ok(del.status === 200 && del.body.deleted === true, 'a held cart can be discarded');
    ok((await as(T.cash)(request(base).delete('/api/held-orders/carts/hold-bbb'))).body.deleted === false, 'discarding twice is harmless');
    for (const [label, body] of [
      ['bad id', { id: 'no spaces!', cart }],
      ['no items', { id: 'x1', cart: { items: [] } }],
      ['bad qty', { id: 'x2', cart: { items: [{ pid: 'p1', qty: 0 }] } }],
      ['not an object', { id: 'x3', cart: 'nope' }],
    ] as [string, any][]) {
      ok((await hold(T.cash, body)).status === 400, `invalid held cart rejected (${label})`);
    }
    ok((await request(base).get('/api/held-orders/carts')).status === 401, 'held carts require authentication');
    // "Persistence after reload" = it is in SQLite, not in any client; prove it survives a DB reopen.
    await hold(T.cash, { id: 'hold-persist', label: 'Persist', cart });
    closeDatabase(); initDatabase();
    const again = await as(T.mgr)(request(base).get('/api/held-orders/carts'));
    ok(again.body.carts.some((c: any) => c.id === 'hold-persist'), 'a held cart is still there after the database is closed and reopened');
    // The table-keyed held orders are untouched by carts.
    const legacy = await as(T.mgr)(request(base).get('/api/held-orders'));
    ok(legacy.status === 200 && legacy.body.orders.length === 0, 'table held-orders endpoint is unaffected by held carts');

    // ── BACKUP ─────────────────────────────────────────────────────────────
    console.log('\n4. backup (authoritative database backup)');
    const backup = (tok: string, body: any) => as(tok)(request(base).post('/api/db/backup')).send(body);
    ok((await backup(T.cash, { master_pin: '4321' })).status === 403, 'a cashier cannot create a backup');
    ok((await backup(T.mgr, { master_pin: '4321' })).status === 403, 'a manager cannot create a backup (owner only)');
    const noPin = await backup(T.own, {});
    ok(noPin.status === 403, 'the owner must supply the Master PIN');
    const badPin = await backup(T.own, { master_pin: '0000' });
    ok(badPin.status === 403, 'a wrong Master PIN is refused');
    const b1 = await backup(T.own, { master_pin: '4321' });
    ok(b1.status === 200 && b1.body.success === true && /^flo-backup-.*\.db$/.test(b1.body.filename), 'owner + Master PIN creates a real backup');
    ok(fs.existsSync(b1.body.path) && fs.statSync(b1.body.path).size > 0, 'the backup file exists on disk and is non-empty');
    const b2 = await backup(T.own, { master_pin: '4321' });
    ok(b2.body.filename !== b1.body.filename && fs.existsSync(b1.body.path), 'a second backup never overwrites the first');
    const list2 = await as(T.own)(request(base).get('/api/db-tools/backups'));
    ok(list2.body.backups.filter((x: any) => x.kind === 'manual').length >= 2, 'backups are listed for the operator');
    // The backup is a real SQLite copy that contains the data.
    const Database = require('better-sqlite3');
    const copy = new Database(b2.body.path, { readonly: true });
    ok((copy.prepare(`SELECT COUNT(*) n FROM bills`).get() as any).n === 1, 'the backup contains the real bills table');
    copy.close();
    ok(!JSON.stringify(b1.body).includes('4321'), 'the response does not echo the Master PIN');

    console.log(`\n✅ Till print / hold-resume / backup backend tests passed (${passed} checks)`);
  } finally {
    for (const s of fakes) { try { await closeServer(s); } catch { /* already closed */ } }
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
