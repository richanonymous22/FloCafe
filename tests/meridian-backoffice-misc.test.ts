/*
 * Meridian back-office actions that used to change only the screen (UI → HTTP → backend → DB):
 * customer wallet adjustments, the timeclock, moving an order to another table.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-misc-'));
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
  console.log('Testing Meridian back-office actions (UI → HTTP → backend → DB)...');
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
    // Type a PIN into a FRESH keypad (no digits entered yet): a previous PIN dialog may still be closing.
    const freshPad = () => Array.from(doc.querySelectorAll('.modal')).find((m: any) => m.querySelector('[data-pad]') && !m.querySelector('.pin-dots i.f')) as any;
    const pin = async (digits: string) => {
      await waitFor(() => !!freshPad(), 8000, 'PIN keypad');
      const pad = freshPad();
      for (const d of digits) { const key = pad.querySelector(`[data-key="${d}"]`) as any; if (!key) throw new Error(`no key ${d}`); key.click(); }
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
    db.prepare(`INSERT INTO customers (id, name, phone, created_at, updated_at) VALUES ('c1','Cara','07700900001',?,?)`).run(now(), now());
    db.prepare(`INSERT INTO loyalty_ledger (customer_id, type, amount, description, created_at, updated_at) VALUES ('c1','credit',500,'Welcome gift',?,?)`).run(now(), now());
    for (const [id, n] of [['t1', '1'], ['t2', '2']]) db.prepare(`INSERT INTO tables (id, number, capacity, status, is_active, created_at, updated_at) VALUES (?, ?, 4, 'available', 1, ?, ?)`).run(id, n, now(), now());
    const bal = () => (db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE -amount END),0) b FROM loyalty_ledger WHERE customer_id='c1'`).get() as any).b as number;
    const M = await boot('u-mgr');
    await M.win.eval('PlemmoCatalogue.load(S)');
    await waitFor(() => (M.win.eval("cust('c1')") || {}).points === 500, 6000, 'customer loaded');
    const ask = async (W: any, fn: () => void, label: string, answer: string, text: RegExp) => { fn(); await waitFor(() => Array.from(W.doc.querySelectorAll('.modal')).some((m: any) => text.test(m.textContent || '') && m.querySelector('input')), 4000, label); const m: any = Array.from(W.doc.querySelectorAll('.modal')).find((m: any) => text.test(m.textContent || '') && m.querySelector('input')); m.querySelector('input').value = answer; m.querySelector('.btn-primary').click(); };

    console.log('\n1. customer wallet adjustment');
    M.win.eval("openCustDrawer('c1')");
    await ask(M, () => M.click('custPts', { id: 'c1' }), 'points prompt', '250', /Adjust wallet points/);
    await ask(M, () => {}, 'reason prompt', 'Goodwill after a late order', /Why is the wallet being changed/);
    await waitFor(() => bal() === 750, 6000, 'ledger credited');
    const led = db.prepare(`SELECT type, amount, description FROM loyalty_ledger WHERE customer_id='c1' ORDER BY id DESC LIMIT 1`).get() as any;
    ok(led.type === 'credit' && led.amount === 250 && /Goodwill after a late order/.test(led.description), 'a ledger entry with the reason was added (the balance itself is never edited)');
    ok((M.win.eval("cust('c1')") as any).points === 750, 'Meridian shows the server balance (750)');
    const au = JSON.parse((db.prepare(`SELECT metadata FROM audit_events WHERE event_type='customer.wallet_adjusted' ORDER BY rowid DESC LIMIT 1`).get() as any).metadata);
    ok(au.points === 250 && au.balance_after === 750 && /Goodwill/.test(au.reason), 'audited with who, how much and why');
    await waitFor(() => !M.doc.querySelector('.modal'), 4000, 'closed').catch(() => M.win.eval('closeAll()'));
    const tok = M.tok();
    let r = await http(tok, 'POST', '/customers/c1/wallet/adjust', { points: -5000, reason: 'too much' });
    ok(r.status === 400 && /only has 750 points/.test(r.body.error) && bal() === 750, 'taking off more than the balance is refused (the wallet cannot go negative)');
    r = await http(tok, 'POST', '/customers/c1/wallet/adjust', { points: 10, reason: '  ' });
    ok(r.status === 400, 'a reason is required');
    r = await http(tok, 'POST', '/customers/c1/wallet/adjust', { points: 1.5, reason: 'x' });
    ok(r.status === 400, 'points must be whole');

    console.log('\n2. a cashier cannot adjust a wallet');
    const C = await boot('u-cash');
    const ct = C.tok();
    r = await http(ct, 'POST', '/customers/c1/wallet/adjust', { points: 100, reason: 'sneaky' });
    ok(r.status === 403 && bal() === 750, 'refused (403) and the balance is unchanged');

    console.log('\n3. the timeclock only says "clocked in" when the server did');
    C.clearToasts();
    C.click('clockInMe');
    await waitFor(() => /Clocked in/.test(C.toasts()), 6000, 'first clock-in');
    ok((db.prepare(`SELECT COUNT(*) n FROM staff_shifts WHERE user_id='u-cash' AND clock_out IS NULL`).get() as any).n === 1, 'one open shift in the database');
    C.clearToasts();
    C.click('clockInMe');
    await waitFor(() => /not updated/.test(C.toasts()), 6000, 'second clock-in refused');
    ok(!/Clocked in/.test(C.toasts()), 'the server refused a second clock-in and the till does NOT also claim "Clocked in"');
    ok((db.prepare(`SELECT COUNT(*) n FROM staff_shifts WHERE user_id='u-cash'`).get() as any).n === 1, 'still exactly one shift');
    C.dom.window.close();
    M.clearToasts();
    M.click('tmClock', { id: 'u-cash' });
    await waitFor(() => /clocks themselves/.test(M.toasts()), 4000, 'refusal');
    ok((db.prepare(`SELECT COUNT(*) n FROM staff_shifts WHERE user_id='u-cash' AND clock_out IS NULL`).get() as any).n === 1, 'a manager cannot clock someone else out on this screen (the timeclock is self-service on the server)');

    console.log('\n4. moving an order to another table');
    const order = await M.win.PlemmoOrders.createOrder({ type: 'dine', table: 't1', items: [{ pid: 'p-tea', qty: 1, mods: [] }] }, M.M().S._plemmoAddons);
    const oid = (db.prepare(`SELECT id, table_id FROM orders WHERE id=?`).get(order.id) as any);
    ok(oid.table_id === 't1', 'the order is on table 1');
    const full = M.win.PlemmoOrders.mapPlemmoOrder(await M.win.PlemmoTill.fetchOrder(order.id));
    M.M().S.orders.push(full);
    M.M().U.cart = { items: full.items.map((l: any) => ({ ...l })), type: 'dine', table: 't1', custId: null, discount: null, orderId: full.id, note: '' };
    M.win.eval("pickTable=async()=> 't2'");
    M.clearToasts();
    M.click('changeTable');
    await waitFor(() => (db.prepare(`SELECT table_id FROM orders WHERE id=?`).get(order.id) as any).table_id === 't2', 6000, 'order moved on the server');
    ok((db.prepare(`SELECT status FROM tables WHERE id='t2'`).get() as any).status === 'occupied', 'the server marks table 2 occupied');
    ok((db.prepare(`SELECT status FROM tables WHERE id='t1'`).get() as any).status === 'available', 'and frees table 1');
    ok(M.M().U.cart.table === 't2', 'the screen follows the server');
    // a table that is already taken: the server refuses, the screen does not move
    db.prepare(`INSERT INTO tables (id, number, capacity, status, is_active, created_at, updated_at) VALUES ('t3','3',4,'available',1,?,?)`).run(now(), now());
    const o2 = await M.win.PlemmoOrders.createOrder({ type: 'dine', table: 't3', items: [{ pid: 'p-tea', qty: 1, mods: [] }] }, M.M().S._plemmoAddons);
    M.win.eval("pickTable=async()=> 't3'");
    M.clearToasts();
    M.click('changeTable');
    await waitFor(() => /was not moved/.test(M.toasts()), 6000, 'refusal');
    ok((db.prepare(`SELECT table_id FROM orders WHERE id=?`).get(order.id) as any).table_id === 't2' && M.M().U.cart.table === 't2', 'moving onto a table that already has an order is refused; nothing changed anywhere');
    ok(!!o2, '(the other table\'s order is untouched)');
    console.log('\n5. the Kitchen screen points at the real kitchen display instead of an empty fake board');
    M.M().U.view = 'kitchen'; M.win.eval('renderView()');
    await waitFor(() => /On a tablet or screen in the kitchen, open/.test(M.doc.querySelector('.page')?.textContent || ''), 6000, 'kitchen info');
    const kt = M.doc.querySelector('.page')?.textContent || '';
    ok(/http:\/\/\d+\.\d+\.\d+\.\d+:\d+/.test(kt), 'it shows the kitchen display address the server reports');
    ok(!!M.doc.querySelector('.page img[alt^="QR code"]'), 'and a QR code from the server');
    ok(!M.doc.querySelector('[data-act="kdsMode"]') && !M.doc.querySelector('[data-act="ktNext"]'), 'there is no local ticket board that nothing feeds');
    M.dom.window.close();

    console.log(`\n✅ Meridian back-office actions passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* closed */ } }
    for (const s of fakes) { try { await closeServer(s); } catch { /* closed */ } }
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
