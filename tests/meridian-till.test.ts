/*
 * Meridian till wiring — full-path verification: MERIDIAN UI (jsdom, the real
 * built bundle) → HTTP → Express → services → SQLite.
 *
 * Every assertion about an operation is made against the DATABASE or the real
 * network transport, not against the UI object: refund, void, receipt print,
 * hold/resume (incl. reload), backup, the Devices panel, barcode scanning and
 * price override. A pure frontend mock would not satisfy any of these.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-till-'));
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
import { initDatabase, closeDatabase, getDatabase, listBackups } from '../main/db';
import { resetMasterPin } from '../main/services/master-pin';
import { resetApprovalRateLimits } from '../main/core/approval';

let checks = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
  checks++;
  console.log(`  ✓ ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 6000, label = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (fn()) return; } catch { /* keep polling */ } await sleep(40); }
  throw new Error(`Timed out waiting for ${label}`);
}
const now = () => new Date().toISOString();

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
  console.log('Testing Meridian till wiring (UI → HTTP → backend → DB)...');
  initDatabase();
  const db = getDatabase();
  const bcrypt = require('bcryptjs');
  const pw = bcrypt.hashSync('Passw0rd!x', 10);
  const user = (id: string, role: string, pin: string | null) =>
    db.prepare(`INSERT INTO users (id, name, email, password, role, pin_hash, is_active) VALUES (?,?,?,?,?,?,1)`)
      .run(id, id, `${id}@mt.local`, pw, role, pin ? bcrypt.hashSync(pin, 10) : null);
  user('u-own', 'owner', '1111'); user('u-mgr', 'manager', '2222'); user('u-cash', 'cashier', '3333');
  const { grantLocationAccess } = require('../main/core/employee-access');
  const { getCurrentLocationId } = require('../main/core/location');
  grantLocationAccess('u-cash', getCurrentLocationId());
  db.prepare(`INSERT INTO settings (key, value) VALUES ('business_name','Till Cafe') ON CONFLICT(key) DO UPDATE SET value='Till Cafe'`).run();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('currency','GBP') ON CONFLICT(key) DO UPDATE SET value='GBP'`).run();
  db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES ('cat','Food',1,1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, barcode, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p-bagel','cat','Bagel',4,1,'BGL','5012345678900',1,1,1,10,0,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, barcode, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p-tea','cat','Tea',2,0.3,'TEA','5000000000017',1,2,0,0,0,?,?)`).run(now(), now());
  resetMasterPin('4321');

  await startServer();
  const origin = `http://127.0.0.1:${getServerPort()}`;
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend-meridian', 'dist', 'meridian-pos.html'), 'utf8');
  const doms: JSDOM[] = [];
  const fakes: net.Server[] = [];

  async function boot(id: string) {
    const dom = new JSDOM(html, {
      url: origin + '/', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(window: any) {
        window.fetch = (input: any, init?: any) => fetch(input, init);
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      },
    });
    doms.push(dom);
    const win: any = dom.window;
    await waitFor(() => !!win.document.getElementById('plForm'), 8000, 'login form');
    win.document.getElementById('plEmail').value = `${id}@mt.local`;
    win.document.getElementById('plPass').value = 'Passw0rd!x';
    win.document.getElementById('plForm').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => { const a = win.document.getElementById('app'); return !!a && !a.hidden && !!(win.__meridian && win.__meridian.S && win.__meridian.S.products.length); }, 10000, 'app ready');
    await sleep(150);
    const doc = win.document;
    const M = () => win.__meridian;
    const click = (act: string, data: Record<string, string> = {}) => {
      const b = doc.createElement('button');
      b.setAttribute('data-act', act);
      for (const [k, v] of Object.entries(data)) b.setAttribute('data-' + k, v);
      doc.body.appendChild(b); b.click(); b.remove();
    };
    const clickEl = (sel: string) => { const el = doc.querySelector(sel); if (!el) throw new Error(`no element ${sel}`); (el as any).click(); };
    const toasts = () => (doc.getElementById('toasts').textContent || '');
    const clearToasts = () => { doc.getElementById('toasts').innerHTML = ''; };
    const pin = async (digits: string) => {
      await waitFor(() => !!doc.querySelector('.modal [data-pad]'), 4000, 'PIN keypad');
      for (const d of digits) clickEl(`.modal [data-key="${d}"]`);
    };
    const api = (p: string, o?: any) => win.PlemmoAPI.request(p, o);
    return { dom, win, doc, M, click, clickEl, toasts, clearToasts, pin, api, tok: () => win.PlemmoAPI.getToken() as string };
  }
  const http = async (tok: string, method: string, p: string, body?: any) => {
    const r = await fetch(origin + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const stock = () => (db.prepare(`SELECT quantity FROM inventory_balances WHERE product_id='p-bagel'`).get() as any)?.quantity as number;

  try {
    // ════════ 0. scan detector unit behaviour (terminators, timing) ════════
    {
      console.log('\n0. scan detector');
      const d = await boot('u-cash');
      const Scan = d.win.PlemmoScan;
      const det = Scan.create({ maxGap: 50, minLen: 4 });
      let t = 1000; const feed = (keys: string[], gap: number, value = '') => { let r: any = { scan: null }; for (const k of keys) { t += gap; r = det.key({ key: k, ts: t, value }); } return r; };
      ok(feed([...'5012345678900', 'Enter'], 5).scan === '5012345678900', 'Enter-terminated rapid run is one scan');
      ok(feed([...'4006381333931', 'Tab'], 5).scan === '4006381333931', 'Tab-terminated rapid run is one scan');
      ok(feed([...'abcdef', 'Enter'], 120).scan === null, 'slow typing + Enter is NOT a scan (manual search stays manual)');
      ok(feed([...'123', 'Enter'], 5).scan === null, 'a run shorter than the minimum is not a scan');
      ok(feed([...'55555555', ' '], 5).scan === null, 'no terminator → no scan');
      det.reset(); const r3 = feed([...'77777777'], 5, 'ba'); const r4 = det.key({ key: 'Enter', ts: t + 5, value: 'ba77777777' });
      ok(r3.scan === null && r4.scan === '77777777' && r4.restore === 'ba', 'the text that was in the search box before the scan is restored');
      feed([...'8888'], 5); det.key({ key: 'Backspace', ts: t + 5, value: '' });
      ok(det.key({ key: 'Enter', ts: t + 10, value: '' }).scan === null, 'an editing key cancels the run');
      const a = feed([...'1111111', 'Enter'], 4).scan, b = feed([...'2222222', 'Enter'], 4).scan;
      ok(a === '1111111' && b === '2222222', 'back-to-back scans are separate');
    }

    // ════════ 1. refund ════════
    console.log('\n1. refund (cashier + manager PIN)');
    const C = await boot('u-cash');
    ok(C.M().S.employees.find((e: any) => e.id === 'u-cash').role === 'staff', 'the cashier is a Meridian "staff" user (cannot refund alone)');
    const sell = async (qty: number, pid = 'p-bagel') => {
      const order = await C.win.PlemmoOrders.createOrder({ type: 'takeaway', items: [{ pid, qty, mods: [] }] }, C.M().S._plemmoAddons);
      const gen = await C.win.PlemmoAPI.post('/bills/generate', { order_id: order.id }, { idempotent: true });
      const total = Number(gen.bill.total);
      await C.win.PlemmoPayments.paySplit(gen.bill.id, [{ method: 'cash', amount: total }]);
      const hist = await C.win.PlemmoOrders.history({ fromDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10) });
      const S = C.M().S; S.orders.length = 0; S.orders.push(...hist);
      return { orderId: order.id as number, billId: gen.bill.id as number, total, local: hist.find((o: any) => o.plemmoOrderId === order.id) };
    };
    const s1 = await sell(2);
    ok(stock() === 8 && s1.local.status === 'paid' && s1.local.plemmoBillIds.includes(s1.billId), 'sale is in the backend and mapped into Meridian as paid, with its bill id');

    // wrong manager PIN: backend refuses, nothing changes anywhere
    resetApprovalRateLimits(); C.clearToasts();
    C.click('refund', { id: s1.local.id });
    await C.pin('9999');
    await waitFor(() => !!C.doc.getElementById('rfGo'), 4000, 'refund modal');
    C.clickEl('#rfGo');
    await waitFor(() => /wasn.t accepted/.test(C.toasts()), 6000, 'PIN-refused toast');
    ok(s1.local.status === 'paid' || C.M().S.orders.find((o: any) => o.id === s1.local.id).status === 'paid', 'a refused refund does not flip the order to refunded in Meridian');
    ok((db.prepare(`SELECT COUNT(*) n FROM refunds WHERE bill_id=?`).get(s1.billId) as any).n === 0, 'a refused refund wrote nothing to the database');
    ok(stock() === 8, 'stock unchanged after a refused refund');

    // correct manager PIN: real refund
    resetApprovalRateLimits(); C.clearToasts();
    C.click('refund', { id: s1.local.id });
    await C.pin('2222');
    await waitFor(() => !!C.doc.getElementById('rfGo'), 4000, 'refund modal');
    C.clickEl('#rfGo');
    await waitFor(() => (db.prepare(`SELECT COUNT(*) n FROM refunds WHERE bill_id=?`).get(s1.billId) as any).n === 1, 6000, 'refund row');
    await waitFor(() => C.M().S.orders.find((o: any) => o.id === s1.local.id).status === 'refunded', 6000, 'Meridian shows refunded');
    const rf = db.prepare(`SELECT * FROM refunds WHERE bill_id=?`).get(s1.billId) as any;
    ok(rf.actor_user_id === 'u-mgr' && rf.amount_minor === Math.round(s1.total * 100), 'refund row is attributed to the approving manager for the full amount');
    const pay = db.prepare(`SELECT * FROM payments WHERE bill_id=?`).get(s1.billId) as any;
    ok(pay.amount_minor === rf.amount_minor && pay.state === 'refunded', 'the ORIGINAL payment row is intact and marked refunded');
    ok(stock() === 10, 'stock came back through the ledger (restock was ticked)');
    ok(/refunded/.test(C.toasts()), 'success is announced only after the backend confirmed');
    const auditRow = db.prepare(`SELECT metadata FROM audit_events WHERE event_type='bill.refunded' AND entity_id=?`).get(String(s1.billId)) as any;
    const am = JSON.parse(auditRow.metadata);
    ok(am.requested_by === 'u-cash' && am.approved_by === 'u-mgr', 'audit: requested by the cashier, approved by the manager');
    // refunded orders offer no second refund
    C.click('refund', { id: s1.local.id }); await sleep(300);
    ok(!C.doc.querySelector('.modal [data-pad]') && (db.prepare(`SELECT COUNT(*) n FROM refunds WHERE bill_id=?`).get(s1.billId) as any).n === 1, 'a refunded order cannot be refunded again');

    // a STALE view: the server already refunded it elsewhere → the till says so and corrects itself
    const s2 = await sell(1);
    const mgrTok = (await (await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'u-mgr@mt.local', password: 'Passw0rd!x' }) })).json()).access_token;
    ok((await http(mgrTok, 'POST', `/bills/${s2.billId}/refund`, { reason: 'Refunded at another till' })).status === 200, 'another till refunded the sale');
    ok(C.M().S.orders.find((o: any) => o.id === s2.local.id).status === 'paid', 'this till still believes it is paid (stale)');
    resetApprovalRateLimits(); C.clearToasts();
    C.click('refund', { id: s2.local.id }); await C.pin('2222');
    await waitFor(() => !!C.doc.getElementById('rfGo'), 4000, 'refund modal (stale)');
    C.clickEl('#rfGo');
    await waitFor(() => /not refunded/.test(C.toasts()), 6000, 'failure toast');
    ok(/Nothing left to refund/.test(C.toasts()), 'the backend reason is shown, not a fake success');
    await waitFor(() => C.M().S.orders.find((o: any) => o.id === s2.local.id).status === 'refunded', 6000, 'cache corrected from the backend');
    ok((db.prepare(`SELECT COUNT(*) n FROM refunds WHERE bill_id=?`).get(s2.billId) as any).n === 1, 'no second refund was created');

    // ════════ 2. void ════════
    console.log('\n2. void (cancel an unpaid order)');
    const mkOpen = async (qty: number) => {
      const order = await C.win.PlemmoOrders.createOrder({ type: 'takeaway', items: [{ pid: 'p-bagel', qty, mods: [] }] }, C.M().S._plemmoAddons);
      const S = C.M().S;
      const o = { id: 'ov' + order.id, no: order.order_number, plemmoOrderId: order.id, ts: Date.now(), opened: Date.now(), empId: 'u-cash', source: 'pos', type: 'takeaway', table: null, custId: null,
        items: [{ pid: 'p-bagel', name: 'Bagel', price: 4, cost: 1, qty, mods: [], note: '', sent: true, uid: 'lv' + order.id }], subtotal: qty * 4, tax: 0, discAmt: 0, total: qty * 4, tip: 0, payments: [], status: 'open', pts: 0, discount: null };
      S.orders.push(o);
      C.M().U.cart = { items: o.items.map((l: any) => ({ ...l })), type: 'takeaway', table: null, custId: null, discount: null, orderId: o.id, note: '' };
      return { order, o };
    };
    const before = stock();
    const v1 = await mkOpen(3);
    ok(stock() === before - 3, 'an unpaid order took 3 from stock');
    // a line with no backend item id can't be removed on the server, so the screen refuses rather than pretending
    // (real lines carry their backend id — see tests/meridian-item-void.test.ts)
    C.clearToasts(); C.click('lineDel', { id: C.M().U.cart.items[0].uid });
    await waitFor(() => /can.t be removed from this screen/.test(C.toasts()), 3000, 'item-void refusal');
    C.click('lineQty', { id: C.M().U.cart.items[0].uid, d: '-1' }); await sleep(200);
    ok(C.M().U.cart.items.length === 1 && C.M().U.cart.items[0].qty === 3 && stock() === before - 3, 'a sent item on a backend order cannot be removed or reduced locally (no screen-only void)');
    // put the order "in progress" so the backend itself demands a manager PIN
    db.prepare(`UPDATE order_items SET status='preparing' WHERE order_id=?`).run(v1.order.id);
    resetApprovalRateLimits(); C.clearToasts();
    C.click('voidOpen'); await C.pin('9999');
    await waitFor(() => !!C.doc.getElementById('cfOk'), 4000, 'confirm');
    C.clickEl('#cfOk');
    await waitFor(() => /was not voided/.test(C.toasts()), 6000, 'void refused toast');
    ok((db.prepare(`SELECT status FROM orders WHERE id=?`).get(v1.order.id) as any).status !== 'cancelled', 'wrong PIN: the backend order is NOT cancelled');
    ok(v1.o.status === 'open' && stock() === before - 3, 'wrong PIN: Meridian still shows it open and stock is unchanged');
    resetApprovalRateLimits(); C.clearToasts();
    C.click('voidOpen'); await C.pin('2222');
    await waitFor(() => !!C.doc.getElementById('cfOk'), 4000, 'confirm');
    C.clickEl('#cfOk');
    await waitFor(() => (db.prepare(`SELECT status FROM orders WHERE id=?`).get(v1.order.id) as any).status === 'cancelled', 6000, 'order cancelled in DB');
    await waitFor(() => v1.o.status === 'void', 6000, 'Meridian shows void after re-reading the order');
    ok(stock() === before, 'stock went back through the ledger');
    ok((db.prepare(`SELECT COUNT(*) n FROM order_items WHERE order_id=?`).get(v1.order.id) as any).n === 1, 'the order and its lines are kept (history preserved)');
    ok(!!db.prepare(`SELECT 1 FROM audit_events WHERE event_type='sale.voided' AND entity_id=?`).get(String(v1.order.id)), 'a sale.voided audit event exists');
    ok(C.M().U.cart.items.length === 0, 'the cart was cleared only after the backend confirmed');
    // a PAID order cannot be voided — the backend says refund instead
    const paid = await sell(1);
    C.M().U.cart = { items: [], type: 'takeaway', table: null, custId: null, discount: null, orderId: paid.local.id, note: '' };
    paid.local.status = 'open'; // simulate a stale "open" view of an order that has in fact been paid
    C.clearToasts();
    C.click('voidOpen'); await C.pin('2222');
    await waitFor(() => !!C.doc.getElementById('cfOk'), 4000, 'confirm');
    C.clickEl('#cfOk');
    await waitFor(() => /Refund it instead/.test(C.toasts()), 6000, 'refund-instead toast');
    ok((db.prepare(`SELECT status FROM orders WHERE id=?`).get(paid.orderId) as any).status !== 'cancelled', 'the paid order was not cancelled');

    // ════════ 3. print ════════
    console.log('\n3. receipt printing');
    const ownerTok = (await (await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'u-own@mt.local', password: 'Passw0rd!x' }) })).json()).access_token;
    const s3 = await sell(2);
    C.clearToasts();
    C.click('printRc', { id: s3.local.id });
    await waitFor(() => /Couldn.t print/.test(C.toasts()), 6000, 'no-printer failure');
    ok(/No default printer/.test(C.toasts()) && !/sent to the printer/.test(C.toasts()), 'no printer configured → a real failure message, never "sent to the printer"');
    ok((db.prepare(`SELECT COUNT(*) n FROM print_logs`).get() as any).n === 0, 'a failed print is not logged as printed');
    const fake = await listenPrinter(); fakes.push(fake.server);
    const added = await http(ownerTok, 'POST', '/printers', { name: 'Till 80', connection_type: 'network', ip_address: '127.0.0.1', port: fake.port, paper_width: '80mm' });
    ok(added.status === 201, 'printer configured through the API');
    C.clearToasts();
    C.click('printRc', { id: s3.local.id });
    await waitFor(() => /sent to the printer/.test(C.toasts()), 6000, 'print success');
    await sleep(120);
    const bytes1 = Buffer.concat(fake.received);
    ok(bytes1.length > 50 && bytes1.toString('latin1').includes('Bagel'), `the printer transport really received the receipt (${bytes1.length} bytes)`);
    ok((db.prepare(`SELECT COUNT(*) n FROM print_logs WHERE bill_id=?`).get(s3.billId) as any).n === 1, 'the print was logged once');
    // printer goes away → honest failure
    const port = fake.port; await closeServer(fake.server); fakes.pop();
    C.clearToasts();
    C.click('printRc', { id: s3.local.id });
    await waitFor(() => /Couldn.t print/.test(C.toasts()), 6000, 'unreachable failure');
    ok(/ECONNREFUSED|refused|Network error/i.test(C.toasts()) && !/sent to the printer/.test(C.toasts()), 'printer unavailable → the real reason is shown and no success message appears');
    ok((db.prepare(`SELECT COUNT(*) n FROM print_logs WHERE bill_id=?`).get(s3.billId) as any).n === 1, 'the failed attempt was not logged as a print');
    // retry is safe
    const back = await listenPrinter(port); fakes.push(back.server);
    C.clearToasts();
    C.click('printRc', { id: s3.local.id });
    await waitFor(() => /sent to the printer/.test(C.toasts()), 6000, 'retry success');
    await sleep(120);
    ok(Buffer.concat(back.received).length > 50, 'the retry reached the printer');
    const logs = db.prepare(`SELECT print_type FROM print_logs WHERE bill_id=? ORDER BY id`).all(s3.billId) as any[];
    ok(logs.length === 2 && logs[0].print_type === 'receipt' && logs[1].print_type === 'reprint', 'the second print is recorded as a reprint');
    ok((db.prepare(`SELECT COUNT(*) n FROM bills WHERE id=?`).get(s3.billId) as any).n === 1, 'printing never changed the bill');
    // a sale that never reached the server cannot be "printed"
    C.M().S.orders.push({ id: 'local1', no: 9001, items: [], status: 'paid', payments: [], total: 1, subtotal: 1, tax: 0, tip: 0, ts: Date.now() });
    C.clearToasts(); C.click('printRc', { id: 'local1' });
    await waitFor(() => /hasn.t reached the till server/.test(C.toasts()), 3000, 'local-only print message');
    ok(true, 'a local-only sale is told it cannot be printed (no fake success)');

    // ════════ 4. hold / resume ════════
    console.log('\n4. hold / resume');
    C.click('nav', { v: 'pos' }); await waitFor(() => C.M().U.view === 'pos', 3000, 'pos view');
    const addTile = (pid: string) => C.click('add', { id: pid });
    addTile('p-bagel'); addTile('p-bagel'); addTile('p-tea');
    ok(C.M().U.cart.items.length === 2 && C.M().U.cart.items[0].qty === 2, 'two lines in the cart');
    C.M().U.cart.note = 'for Sam';
    C.click('hold'); C.click('hold'); // a double tap
    await waitFor(() => (db.prepare(`SELECT COUNT(*) n FROM held_carts`).get() as any).n >= 1, 6000, 'held cart row');
    await sleep(400);
    ok((db.prepare(`SELECT COUNT(*) n FROM held_carts`).get() as any).n === 1, 'a double tap held the cart exactly once (duplicate protection)');
    ok(C.M().U.cart.items.length === 0 && C.M().S.held.length === 1, 'the cart was cleared only after the backend stored it; the strip shows it');
    ok((db.prepare(`SELECT COUNT(*) n FROM orders WHERE id > ?`).get(s3.orderId) as any).n === 0, 'holding created no sale');
    // RELOAD: a brand-new browser session sees the held cart because it lives in the database
    C.dom.window.close();
    const C2 = await boot('u-cash');
    ok(C2.M().S.held.length === 1 && C2.M().S.held[0].cart.note === 'for Sam', 'after a full reload the held cart is back (loaded from the backend) with its details');
    const heldId = C2.M().S.held[0].id;
    C2.click('resume', { id: heldId });
    await waitFor(() => C2.M().U.cart.items.length === 2, 6000, 'cart restored');
    ok(C2.M().U.cart.items[0].qty === 2 && C2.M().U.cart.note === 'for Sam' && C2.M().U.cart.items[1].pid === 'p-tea', 'the resumed cart has its lines, quantities and note');
    ok((db.prepare(`SELECT COUNT(*) n FROM held_carts`).get() as any).n === 0 && C2.M().S.held.length === 0, 'resuming removed it from the backend and the strip');
    // another till cannot resume a cart that was already taken
    await http(ownerTok, 'POST', '/held-orders/carts', { id: 'h_other', label: 'Other', cart: { items: [{ pid: 'p-tea', qty: 1 }] } });
    await C2.win.eval('refreshHeld()'); await sleep(200);
    ok(C2.M().S.held.some((h: any) => h.id === 'h_other'), 'a cart held on another till appears here');
    await http(ownerTok, 'POST', '/held-orders/carts/h_other/resume', {});
    C2.clearToasts(); C2.click('resume', { id: 'h_other' });
    await waitFor(() => /already picked up/.test(C2.toasts()), 6000, 'already-taken toast');
    ok(true, 'resuming a cart another till already took is refused with a clear message');
    C2.dom.window.close();

    // ════════ 5. price override ════════
    console.log('\n5. price override (cashier + manager PIN)');
    const P = await boot('u-cash');
    const cart = () => P.M().U.cart;
    P.click('add', { id: 'p-tea' }); P.click('add', { id: 'p-tea' });
    ok(cart().items.length === 1 && cart().items[0].qty === 2, 'two Teas in the cart');
    P.click('lineSel', { id: cart().items[0].uid });
    ok(!!P.doc.querySelector('[data-act="linePrice"]'), 'the line offers a Price action');
    resetApprovalRateLimits();
    P.click('linePrice', { id: cart().items[0].uid }); await P.pin('2222');
    await waitFor(() => !!P.doc.getElementById('lpP'), 4000, 'price modal');
    (P.doc.getElementById('lpP') as any).value = '1.50';
    (P.doc.getElementById('lpR') as any).value = 'Price match';
    P.clickEl('#lpGo');
    await waitFor(() => cart().items[0].override, 3000, 'override applied');
    ok(cart().items[0].price === 1.5 && cart().items[0].listPrice === 2, 'the cart line shows 1.50 and remembers the catalogue price 2.00');
    ok((db.prepare(`SELECT price FROM products WHERE id='p-tea'`).get() as any).price === 2, 'the master product price is untouched');
    const ordersBefore = (db.prepare(`SELECT COUNT(*) n FROM orders`).get() as any).n;
    P.click('sendKitchen');
    await waitFor(() => (db.prepare(`SELECT COUNT(*) n FROM orders`).get() as any).n === ordersBefore + 1, 6000, 'order created');
    await waitFor(() => cart().items.length === 0, 4000, 'cart cleared after the backend accepted the order');
    const row = db.prepare(`SELECT oi.unit_price, oi.original_unit_price, oi.price_override_reason, oi.price_override_by, o.total FROM order_items oi JOIN orders o ON o.id=oi.order_id ORDER BY oi.id DESC LIMIT 1`).get() as any;
    ok(row.unit_price === 1.5 && row.original_unit_price === 2 && row.price_override_reason === 'Price match' && row.price_override_by === 'u-mgr', 'the BACKEND recorded 1.50, the original 2.00, the reason and the approving manager');
    ok(row.total === 3, 'the sale total is computed by the backend from the overridden price (2 × 1.50)');
    const pa = db.prepare(`SELECT metadata FROM audit_events WHERE event_type='sale.price_overridden' ORDER BY rowid DESC LIMIT 1`).get() as any;
    ok(JSON.parse(pa.metadata).requested_by === 'u-cash' && JSON.parse(pa.metadata).approved_by === 'u-mgr', 'audited: requested by the cashier, approved by the manager');
    // a wrong PIN is refused by the backend and the order is NOT silently saved locally
    P.click('add', { id: 'p-tea' });
    P.click('lineSel', { id: cart().items[0].uid });
    resetApprovalRateLimits();
    P.click('linePrice', { id: cart().items[0].uid }); await P.pin('9999');
    await waitFor(() => !!P.doc.getElementById('lpP'), 4000, 'price modal 2');
    (P.doc.getElementById('lpP') as any).value = '0.10';
    P.clickEl('#lpGo');
    await waitFor(() => cart().items[0].override, 3000, 'override requested');
    const n2 = (db.prepare(`SELECT COUNT(*) n FROM orders`).get() as any).n;
    P.clearToasts(); P.click('sendKitchen');
    await waitFor(() => /PIN|approval|manager/i.test(P.toasts()), 6000, 'refusal toast');
    ok((db.prepare(`SELECT COUNT(*) n FROM orders`).get() as any).n === n2, 'a refused override created no order on the backend');
    ok(cart().items.length === 1 && !P.M().S.orders.some((o: any) => o.no && !o.plemmoOrderId && o.status === 'open' && o.total === 0.1), 'and the cart was kept — no local-only order with the refused price');
    P.dom.window.close();

    // ════════ 6. barcode scanning ════════
    console.log('\n6. barcode scanning');
    const B = await boot('u-cash');
    let lookups = 0; const realLookup = B.win.PlemmoTill.lookupBarcode;
    B.win.PlemmoTill.lookupBarcode = (c: string) => { lookups++; return realLookup(c); };
    const box = B.doc.getElementById('posQ') as any;
    const press = (target: any, key: string) => {
      const ev = new B.win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
      if (!ev.defaultPrevented && key.length === 1 && target.tagName === 'INPUT') { target.value += key; target.dispatchEvent(new B.win.Event('input', { bubbles: true })); }
      return ev;
    };
    const scan = (code: string, term = 'Enter', target: any = box) => { for (const ch of code) press(target, ch); return press(target, term); };
    const qtyOf = (pid: string) => B.M().U.cart.items.filter((l: any) => l.pid === pid).reduce((s: number, l: any) => s + l.qty, 0);

    const e1 = scan('5012345678900');
    ok(e1.defaultPrevented, 'the scan terminator is consumed (no stray Enter)');
    await waitFor(() => qtyOf('p-bagel') === 1, 4000, 'scanned item in cart');
    ok(lookups === 1 && box.value === '', 'one scan → exactly one backend lookup; the search box is left clean');
    scan('5012345678900', 'Tab');
    await waitFor(() => qtyOf('p-bagel') === 2, 4000, 'Tab-terminated scan');
    ok(lookups === 2, 'a Tab-terminated scan works the same');
    // rapid back-to-back scans: none lost, none doubled, order kept
    scan('5000000000017'); scan('5012345678900'); scan('5000000000017'); scan('5000000000017');
    await waitFor(() => qtyOf('p-tea') === 3 && qtyOf('p-bagel') === 3, 6000, 'rapid scans resolved');
    ok(lookups === 6 && qtyOf('p-tea') === 3 && qtyOf('p-bagel') === 3, 'four rapid scans → four lookups → exactly the right quantities (tea 3, bagel 3)');
    // not found
    B.clearToasts(); scan('0000000000000');
    await waitFor(() => /No item matches barcode 0000000000000/.test(B.toasts()), 4000, 'not-found toast');
    ok(qtyOf('p-bagel') === 3 && qtyOf('p-tea') === 3, 'an unknown barcode adds nothing and says so clearly');
    // scanning while text is in the box restores the text
    box.value = 'ba'; box.dispatchEvent(new B.win.Event('input', { bubbles: true }));
    scan('5000000000017');
    await waitFor(() => qtyOf('p-tea') === 4, 4000, 'scan with text in box');
    ok(box.value === 'ba' && B.M().U.pos.q === 'ba', 'typed search text survives a scan (scan characters are removed from the box)');
    // manual typing is untouched
    const lookupsBefore = lookups; box.value = ''; B.M().U.pos.q = '';
    for (const ch of 'bagel') { press(box, ch); await sleep(80); }
    ok(box.value === 'bagel' && lookups === lookupsBefore, 'slow manual typing is plain search text — no barcode lookup fired');
    ok(B.doc.getElementById('posGrid').textContent.includes('Bagel') && !B.doc.getElementById('posGrid').textContent.includes('Tea'), 'manual search still filters the menu');
    press(box, 'Enter'); await sleep(200);
    ok(lookups === lookupsBefore, 'Enter after manual typing behaves as before (no scan lookup)');
    ok(B.M().U.lastScan && B.M().U.lastScan.ok === true, 'the scanner status remembers the last scan');
    B.dom.window.close();

    // ════════ 7. devices ════════
    console.log('\n7. devices panel');
    const O = await boot('u-own');
    db.prepare(`DELETE FROM printers`).run();
    O.click('nav', { v: 'settings' }); await waitFor(() => O.M().U.view === 'settings', 3000, 'settings');
    O.click('setTab', { t: 'devices' });
    await waitFor(() => /No printer is set up/.test(O.doc.querySelector('.set-sec').textContent), 6000, 'devices loaded');
    let panel = () => O.doc.querySelector('.set-sec').textContent as string;
    ok(/Receipt printer/.test(panel()) && /No printer is set up/.test(panel()), 'no printer → "Not configured", not "Connected"');
    ok(!/Connected|battery|82%/.test(panel()), 'no hard-coded connection states or battery levels remain');
    ok(/Card reader/.test(panel()) && /Not integrated/.test(panel()), 'the card reader is reported as not integrated (never connected)');
    ok(/Cash drawer/.test(panel()) && /needs a printer first/.test(panel()), 'the cash drawer is not claimed without a printer');
    const fake2 = await listenPrinter(); fakes.push(fake2.server);
    O.click('devAddNet');
    await waitFor(() => !!O.doc.getElementById('dpN'), 3000, 'add-printer modal');
    (O.doc.getElementById('dpN') as any).value = 'Front Till';
    (O.doc.getElementById('dpI') as any).value = '127.0.0.1';
    (O.doc.getElementById('dpP') as any).value = String(fake2.port);
    O.clickEl('#dpGo');
    await waitFor(() => (db.prepare(`SELECT COUNT(*) n FROM printers`).get() as any).n === 1, 6000, 'printer row');
    await waitFor(() => /Front Till/.test(panel()) && /Configured/.test(panel()), 6000, 'printer shown as configured');
    ok(!/Test successful/.test(panel()), 'a configured printer is NOT claimed to work until a test has run');
    O.click('devAct', { a: 'test-printer', id: (db.prepare(`SELECT id FROM printers`).get() as any).id });
    await waitFor(() => /Test successful/.test(panel()), 6000, 'test successful');
    await sleep(100);
    ok(Buffer.concat(fake2.received).length > 20, 'the test page really reached the printer');
    O.click('devAct', { a: 'open-drawer', id: '' });
    await waitFor(() => /open pulse delivered/.test(panel()), 6000, 'drawer test');
    const port2 = fake2.port; await closeServer(fake2.server); fakes.pop();
    O.click('devAct', { a: 'test-printer', id: (db.prepare(`SELECT id FROM printers`).get() as any).id });
    await waitFor(() => /Test failed/.test(panel()), 6000, 'test failed');
    ok(/ECONNREFUSED|refused|Network error/i.test(panel()), 'a failed test shows the real reason');
    void port2;

    // ════════ 8. backup ════════
    console.log('\n8. backup');
    O.click('setTab', { t: 'data' });
    await waitFor(() => /Back up the database/.test(panel()), 3000, 'data tab');
    ok(!/JSON file/.test(panel()) && !/Reset to the demo/.test(panel()), 'the misleading client-state JSON "backup" and the demo-reset are gone on a signed-in till');
    const manualBefore = listBackups().filter((b: any) => b.kind === 'manual').length;
    O.clearToasts(); O.click('backup');
    await waitFor(() => !!O.doc.getElementById('pbIn'), 4000, 'Master PIN prompt');
    (O.doc.getElementById('pbIn') as any).value = '0000'; O.clickEl('#pbOk');
    await waitFor(() => /Backup failed/.test(O.toasts()), 6000, 'backup refused');
    ok(/Invalid Master PIN/.test(O.toasts()) && !/Backup saved/.test(O.toasts()), 'a wrong Master PIN is surfaced as a failure, not a success');
    ok(listBackups().filter((b: any) => b.kind === 'manual').length === manualBefore, 'no backup file was created');
    await waitFor(() => !O.doc.getElementById('pbIn'), 4000, 'first prompt closed');
    O.clearToasts(); O.click('backup');
    await waitFor(() => !!O.doc.getElementById('pbIn'), 4000, 'Master PIN prompt 2');
    (O.doc.getElementById('pbIn') as any).value = '4321'; O.clickEl('#pbOk');
    await waitFor(() => /Backup saved: flo-backup-/.test(O.toasts()), 8000, 'backup saved');
    const after = listBackups().filter((b: any) => b.kind === 'manual');
    ok(after.length === manualBefore + 1 && after[0].sizeBytes > 0, 'a real backup file now exists on disk');
    ok(!/4321/.test(O.toasts()) && !/[\\/]/.test((O.toasts().match(/flo-backup-[^ ]*/) || [''])[0]), 'the toast shows only the file name — no Master PIN, no filesystem path');
    const Database = require('better-sqlite3');
    const copy = new Database(after[0].path, { readonly: true });
    ok((copy.prepare(`SELECT COUNT(*) n FROM orders`).get() as any).n > 0, 'the backup is a real copy of the database (it contains the orders)');
    copy.close();
    // a cashier's Data tab cannot back up
    const C3 = await boot('u-cash');
    C3.M().U.view = 'settings'; C3.M().U.set.tab = 'data';
    C3.win.eval('renderView()');
    ok(/Only the owner can do this/.test(C3.doc.querySelector('.set-sec').textContent) && !!C3.doc.querySelector('[data-act="backup"][disabled]'), 'a cashier sees the backup disabled with an explanation');
    C3.dom.window.close();
    O.dom.window.close();

    console.log(`\n✅ Meridian till wiring (UI → HTTP → backend → DB) passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* closed */ } }
    for (const s of fakes) { try { await closeServer(s); } catch { /* closed */ } }
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
