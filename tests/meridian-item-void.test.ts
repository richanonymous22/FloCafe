/*
 * Meridian item void — backend authority (UI → HTTP → backend → DB).
 *
 * Removing a line the kitchen already has is done on the till server: the
 * backend checks approval (owner/manager, or a manager PIN for anyone else),
 * returns stock for an item not yet started, keeps an in-progress item on the
 * bill as a void (no restock), recomputes the bill and audits it. The cart is
 * re-read from the server — the screen never just drops the line.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-ivoid-'));
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
  console.log('Testing Meridian item void (UI → HTTP → backend → DB)...');
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
    const C = await boot('u-cash');
    const cart = () => C.M().U.cart;
    const stock = () => (db.prepare(`SELECT quantity FROM inventory_balances WHERE product_id='p-bagel'`).get() as any)?.quantity as number;
    const mv = (itemId: number) => db.prepare(`SELECT movement_type t, quantity_delta d, reference_type r FROM inventory_movements WHERE product_id='p-bagel' AND (reference_id = ? OR json_extract(metadata,'$.soldOrderItemId') = ?) ORDER BY rowid`).all(String(itemId), String(itemId)) as any[];
    const openOrder = async (lines: Array<{ pid: string; qty: number }>) => {
      const order = await C.win.PlemmoOrders.createOrder({ type: 'takeaway', items: lines.map((l) => ({ pid: l.pid, qty: l.qty, mods: [] })) }, C.M().S._plemmoAddons);
      const full = await C.win.PlemmoTill.fetchOrder(order.id);
      const m = C.win.PlemmoOrders.mapPlemmoOrder(full);
      const S = C.M().S; S.orders.push(m);
      C.M().U.cart = { items: m.items.map((l: any) => ({ ...l })), type: 'takeaway', table: null, custId: null, discount: null, orderId: m.id, note: '' };
      return { id: order.id as number, m };
    };

    console.log('\n1. cashier + manager PIN removes a not-yet-started item: stock returns through the ledger');
    const s0 = stock() ?? 10;
    const a = await openOrder([{ pid: 'p-bagel', qty: 2 }, { pid: 'p-tea', qty: 1 }]);
    ok(a.m.items.length === 2 && a.m.items.every((l: any) => l.itemId != null), 'the order maps both lines with their backend ids');
    const bagel = a.m.items.find((l: any) => l.pid === 'p-bagel');
    ok(stock() === s0 - 2, 'the order took 2 bagels');
    resetApprovalRateLimits(); C.clearToasts();
    await waitFor(() => C.doc.querySelectorAll('.modal').length === 0, 6000, 'earlier dialogs gone');
    C.click('lineDel', { id: bagel.uid });
    await C.pin('9999');
    await waitFor(() => !!C.doc.getElementById('cfOk'), 4000, 'confirm');
    C.clickEl('#cfOk');
    await waitFor(() => /was not removed/.test(C.toasts()), 6000, 'wrong-PIN refusal');
    ok((db.prepare(`SELECT status FROM order_items WHERE id=?`).get(bagel.itemId) as any).status === 'pending' && stock() === s0 - 2, 'wrong PIN: the line is still on the order and stock is unchanged');
    ok(cart().items.length === 2, 'wrong PIN: the cart still shows both lines');
    await waitFor(() => C.doc.querySelectorAll('.modal').length === 0, 6000, 'earlier dialogs gone'); // a fading confirm must not be clicked again
    resetApprovalRateLimits(); C.clearToasts();
    C.click('lineDel', { id: bagel.uid });
    await C.pin('2222');
    await waitFor(() => !!C.doc.getElementById('cfOk'), 4000, 'confirm 2');
    C.clickEl('#cfOk');
    await waitFor(() => (db.prepare(`SELECT status FROM order_items WHERE id=?`).get(bagel.itemId) as any).status === 'cancelled', 6000, 'line cancelled');
    await waitFor(() => cart().items.length === 1, 4000, 'cart re-read');
    ok(cart().items[0].pid === 'p-tea', 'the cart was rebuilt from the server: only the tea remains');
    ok(stock() === s0, 'stock is back (2 bagels returned)');
    const m1 = mv(bagel.itemId);
    ok(m1.length === 2 && m1[0].t === 'sale' && m1[1].t === 'return' && m1[1].r === 'item_cancel', 'ledger shows the sale then a return caused by item_cancel');
    const ord = db.prepare(`SELECT subtotal, total FROM orders WHERE id=?`).get(a.id) as any;
    ok(ord.subtotal === 2 && ord.total === 2, 'the order total dropped to the tea only (2.00)');
    const au = JSON.parse((db.prepare(`SELECT metadata FROM audit_events WHERE event_type='sale.item_voided' AND entity_id=?`).get(String(bagel.itemId)) as any).metadata);
    ok(au.requested_by === 'u-cash' && au.approved_by === 'u-mgr' && au.in_progress === false, 'audited: cashier requested, manager approved, not in progress');

    console.log('\n2. in-progress item: voided, kept on the bill, NOT restocked');
    const b = await openOrder([{ pid: 'p-bagel', qty: 1 }, { pid: 'p-tea', qty: 1 }]);
    const bb = b.m.items.find((l: any) => l.pid === 'p-bagel');
    const s1 = stock();
    db.prepare(`UPDATE order_items SET status='preparing' WHERE id=?`).run(bb.itemId);
    resetApprovalRateLimits(); C.clearToasts();
    await waitFor(() => C.doc.querySelectorAll('.modal').length === 0, 6000, 'earlier dialogs gone');
    C.click('lineDel', { id: bb.uid });
    await C.pin('2222');
    await waitFor(() => !!C.doc.getElementById('cfOk'), 4000, 'confirm 3');
    C.clickEl('#cfOk');
    await waitFor(() => (db.prepare(`SELECT status FROM order_items WHERE id=?`).get(bb.itemId) as any).status === 'voided', 6000, 'line voided');
    await waitFor(() => cart().items.length === 1, 4000, 'cart re-read 2');
    ok(stock() === s1, 'the food was made: stock is NOT returned');
    ok((db.prepare(`SELECT COUNT(*) n FROM order_items WHERE order_id=? AND status='void_adjustment'`).get(b.id) as any).n === 1, 'the bill keeps a negative void line (history preserved)');
    ok((db.prepare(`SELECT total FROM orders WHERE id=?`).get(b.id) as any).total === 2, 'the order total nets to the tea only');
    ok(C.win.PlemmoOrders.mapPlemmoOrder(await C.win.PlemmoTill.fetchOrder(b.id)).items.length === 1, 'reports/history do not count the voided lines as sold items');

    console.log('\n3. removing the last line voids the order');
    const c = await openOrder([{ pid: 'p-bagel', qty: 1 }]);
    const cl = c.m.items[0];
    const s2 = stock();
    resetApprovalRateLimits(); C.clearToasts();
    await waitFor(() => C.doc.querySelectorAll('.modal').length === 0, 6000, 'earlier dialogs gone');
    C.click('lineDel', { id: cl.uid });
    await C.pin('2222');
    await waitFor(() => !!C.doc.getElementById('cfOk'), 4000, 'confirm 4');
    C.clickEl('#cfOk');
    await waitFor(() => (db.prepare(`SELECT status FROM orders WHERE id=?`).get(c.id) as any).status === 'cancelled', 6000, 'order cancelled');
    await waitFor(() => /no items left/i.test(C.toasts()), 4000, 'voided toast');
    ok(stock() === s2 + 1, 'stock returned exactly once (no double restock when the order auto-cancels)');
    ok(cart().items.length === 0, 'the cart was cleared');

    console.log('\n4. reducing a sent line of 2 is refused with guidance');
    const d = await openOrder([{ pid: 'p-tea', qty: 2 }]);
    C.clearToasts();
    C.click('lineQty', { id: d.m.items[0].uid, d: '-1' });
    await waitFor(() => /remove the line and add/i.test(C.toasts()), 3000, 'guidance toast');
    ok(cart().items[0].qty === 2 && (db.prepare(`SELECT quantity FROM order_items WHERE id=?`).get(d.m.items[0].itemId) as any).quantity === 2, 'nothing changed anywhere');

    console.log('\n5. API: cashier without a PIN, an already-removed item');
    const tok = C.tok();
    const e = await openOrder([{ pid: 'p-tea', qty: 1 }]);
    const item = e.m.items[0].itemId;
    resetApprovalRateLimits();
    let r = await http(tok, 'PATCH', `/orders/${e.id}/items/${item}/cancel`, {});
    ok(r.status === 403 && r.body.requiresApproval === true, 'a cashier with no PIN is refused and told approval is required');
    r = await http(tok, 'PATCH', `/orders/${e.id}/items/${item}/cancel`, { override_pin: '2222', reason: 'Customer changed their mind' });
    ok(r.status === 200, 'with the manager PIN it succeeds');
    r = await http(tok, 'PATCH', `/orders/${e.id}/items/${item}/cancel`, { override_pin: '2222' });
    ok(r.status === 409, 'removing the same item twice is refused (409)');
    C.dom.window.close();

    console.log(`\n✅ Meridian item void passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* closed */ } }
    for (const s of fakes) { try { await closeServer(s); } catch { /* closed */ } }
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
