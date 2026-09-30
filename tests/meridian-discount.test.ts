/*
 * Meridian discounts — backend authority (UI → HTTP → backend → DB).
 *
 * A discount chosen at the till is applied by the BACKEND before any money is
 * taken: it enforces who may discount (owner/manager, or a manager PIN) and the
 * configured maximums, recomputes tax and the bill, audits requester and
 * approver, and the pay screen then charges the backend's total. An abandoned
 * checkout voids the order it created so stock is never left reserved.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-disc-'));
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
  console.log('Testing Meridian discounts (UI → HTTP → backend → DB)...');
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
    const cardPay = async (W: any, ref?: string) => {
      W.click('payCard');
      await waitFor(() => !!W.doc.getElementById('payRef'), 4000, 'card confirm stage');
      if (ref) (W.doc.getElementById('payRef') as any).value = ref;
      W.click('payCardOk');
    };
    const openPay = async (W: any) => {
      W.clearToasts();
      W.click('charge');
      await waitFor(() => !!W.doc.querySelector('[data-act="payCard"]') || /could not be prepared|not approved/i.test(W.toasts()), 8000, 'pay screen or refusal');
    };
    const applyDiscount = (W: any, v: string, reason = 'Regular') => {
      W.click('discount');
      W.click('dscPick', { v, r: reason });
      W.click('applyDisc');
    };
    const lastOrder = () => db.prepare(`SELECT * FROM orders ORDER BY id DESC LIMIT 1`).get() as any;
    const audit = (id: number) => db.prepare(`SELECT metadata FROM audit_events WHERE event_type='sale.discount_applied' AND entity_id=? ORDER BY rowid DESC LIMIT 1`).get(String(id)) as any;

    console.log('\n1. owner applies 10% — the backend applies it and the till charges the backend total');
    const O = await boot('u-own');
    O.click('add', { id: 'p-tea' }); O.click('add', { id: 'p-tea' }); // 2 x 2.00
    applyDiscount(O, '10');
    await waitFor(() => !!O.M().U.cart.discount, 3000, 'discount on cart');
    ok(db.prepare(`SELECT COUNT(*) n FROM orders`).get().n === 0, 'nothing is sent to the backend just by choosing a discount');
    await openPay(O);
    const o1 = lastOrder();
    ok(o1.discount_amount === 0.4 && o1.discount_type === 'percentage' && o1.discount_value === 10 && o1.total === 3.6, 'backend order: 10% off 4.00 = 0.40 discount, total 3.60');
    ok(/3\.60/.test(O.doc.getElementById('payBody').textContent || ''), 'the pay screen shows the backend total 3.60');
    const bill1 = db.prepare(`SELECT * FROM bills WHERE order_id=?`).get(o1.id) as any;
    ok(bill1.total === 3.6 && bill1.discount_amount === 0.4, 'the backend bill carries the discount (3.60)');
    await cardPay(O, 'D-1');
    await waitFor(() => (db.prepare(`SELECT payment_status FROM bills WHERE id=?`).get(bill1.id) as any).payment_status === 'paid', 8000, 'bill paid');
    const pay1 = db.prepare(`SELECT amount_minor FROM payments WHERE bill_id=?`).get(bill1.id) as any;
    ok(pay1.amount_minor === 360, 'the card payment is exactly the discounted 3.60 and the bill is fully paid');
    const a1 = JSON.parse(audit(o1.id).metadata);
    ok(a1.requested_by === 'u-own' && a1.approved_by === 'u-own' && a1.discount_amount === 0.4, 'audited: owner requested and approved');
    await waitFor(() => O.M().U.cart.items.length === 0, 6000, 'cart cleared');

    console.log('\n2. cashier + manager PIN');
    const C = await boot('u-cash');
    resetApprovalRateLimits();
    C.click('add', { id: 'p-tea' }); C.click('add', { id: 'p-tea' });
    applyDiscount(C, '10');
    await C.pin('2222');
    await waitFor(() => !!C.M().U.cart.discount, 3000, 'cashier discount on cart');
    await openPay(C);
    const o2 = lastOrder();
    ok(o2.id !== o1.id && o2.discount_amount === 0.4 && o2.total === 3.6, 'backend applied the cashier\'s discount');
    const a2 = JSON.parse(audit(o2.id).metadata);
    ok(a2.requested_by === 'u-cash' && a2.approved_by === 'u-mgr', 'audited: cashier requested, manager approved (the server resolved the approver from the PIN)');
    await cardPay(C, 'D-2');
    await waitFor(() => C.M().U.cart.items.length === 0, 8000, 'cashier sale finished');

    console.log('\n3. cashier + WRONG PIN — refused, the order is voided, stock returns');
    resetApprovalRateLimits();
    C.click('add', { id: 'p-bagel' });
    applyDiscount(C, '10');
    await C.pin('9999');
    await waitFor(() => !!C.M().U.cart.discount, 3000, 'discount requested');
    C.clearToasts();
    C.win.eval("window.__pc=0;(function(){const o=pinCollect;pinCollect=function(a){window.__pc++;return o(a);};})()");
    C.click('charge');
    // the backend refuses the PIN collected earlier, so the till asks again (at most twice more)
    for (let i = 0; i < 12 && !/not approved|could not be prepared/i.test(C.toasts()); i++) {
      await sleep(400);
      if (C.doc.querySelector('.modal [data-pad]')) { await C.pin('9998'); await sleep(300); }
    }
    await waitFor(() => /not approved|could not be prepared/i.test(C.toasts()), 6000, 'refusal toast');
    ok(C.win.eval('window.__pc') === 2, 'the till asked for a manager PIN at most twice more, then gave up (no endless prompt loop)');
    const o3 = lastOrder();
    ok(o3.status === 'cancelled' && !o3.discount_amount, 'no discount was applied and the order that was created is cancelled');
    ok((db.prepare(`SELECT COUNT(*) n FROM payments p JOIN bills b ON b.id=p.bill_id WHERE b.order_id=?`).get(o3.id) as any).n === 0, 'nothing was charged');
    const mv = db.prepare(`SELECT movement_type t, quantity_delta d FROM inventory_movements WHERE product_id='p-bagel' ORDER BY rowid`).all() as any[];
    ok((db.prepare(`SELECT quantity FROM inventory_balances WHERE product_id='p-bagel'`).get() as any).quantity === 10 && mv.length === 2 && mv[0].t === 'sale' && mv[1].t === 'return', 'stock is back at 10 through the ledger (sale then return)');
    ok(C.M().U.cart.items.length === 1 && !!C.M().U.cart.discount, 'the cart and discount are kept so the cashier can try again');
    C.click('rmDisc');
    C.click('lineDel', { id: C.M().U.cart.items[0].uid });
    C.win.eval('U.cart=newCart()');

    console.log('\n4. over the configured maximum — the backend refuses with its reason');
    resetApprovalRateLimits();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('discount_mode','percentage') ON CONFLICT(key) DO UPDATE SET value='percentage'`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('discount_max_percentage','25') ON CONFLICT(key) DO UPDATE SET value='25'`).run();
    O.click('add', { id: 'p-tea' });
    applyDiscount(O, '50', 'Staff');
    await waitFor(() => !!O.M().U.cart.discount, 3000, 'discount on cart');
    O.clearToasts();
    O.click('charge');
    await waitFor(() => /maximum percentage/i.test(O.toasts()), 8000, 'max percentage toast');
    const o4 = lastOrder();
    ok(o4.status === 'cancelled' && !o4.discount_amount, 'the over-limit discount was refused and the order voided');
    ok(O.M().U.cart.items.length === 1, 'cart kept');
    O.click('rmDisc');

    console.log('\n5. abandoned checkout voids the order it created');
    const beforeN = (db.prepare(`SELECT COUNT(*) n FROM orders`).get() as any).n;
    await openPay(O);
    const o5 = lastOrder();
    ok((db.prepare(`SELECT COUNT(*) n FROM orders`).get() as any).n === beforeN + 1 && o5.status !== 'cancelled', 'charging created an open order on the backend');
    O.click('payCancel');
    await waitFor(() => (lastOrder() as any).status === 'cancelled', 6000, 'order voided');
    ok(O.M().U.cart.items.length === 1, 'the cart is still there after cancelling payment');
    console.log('\n6. who may discount, straight at the API');
    resetApprovalRateLimits();
    const mkOrder = async () => (await http(C.tok(), 'POST', '/orders', { type: 'takeaway', items: [{ product_id: 'p-tea', quantity: 1 }] })).body.order.id as number;
    const mgrTok = (await (await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'u-mgr@mt.local', password: 'Passw0rd!x' }) })).json()).access_token;
    const d10 = { discount_type: 'percentage', discount_value: 10, discount_reason: 'Regular' };
    let oid = await mkOrder();
    let r = await http(C.tok(), 'PATCH', `/orders/${oid}/discount`, d10);
    ok(r.status === 403 && r.body.requiresApproval === true, 'a cashier without a PIN is refused and told approval is required');
    r = await http(C.tok(), 'PATCH', `/orders/${oid}/discount`, { ...d10, override_pin: '0000' });
    ok(r.status === 403, 'a cashier with a wrong PIN is refused');
    r = await http(C.tok(), 'PATCH', `/orders/${oid}/discount`, { ...d10, override_pin: '2222' });
    ok(r.status === 200 && r.body.order.discount_amount === 0.2, 'a cashier with the manager PIN succeeds (10% of 2.00 = 0.20)');
    r = await http(C.tok(), 'PATCH', `/orders/${oid}/discount`, { discount_type: 'amount', discount_value: 0 });
    ok(r.status === 200 && r.body.order.discount_amount === 0, 'removing a discount needs no approval');
    oid = await mkOrder();
    r = await http(mgrTok, 'PATCH', `/orders/${oid}/discount`, d10);
    ok(r.status === 200, 'a manager may discount without a PIN');
    db.prepare(`INSERT INTO settings (key, value) VALUES ('discount_requires_approval','true') ON CONFLICT(key) DO UPDATE SET value='true'`).run();
    oid = await mkOrder();
    r = await http(mgrTok, 'PATCH', `/orders/${oid}/discount`, d10);
    ok(r.status === 403 && r.body.requiresApproval === true, 'with "discounts require approval" on, even a manager needs a PIN');
    r = await http(mgrTok, 'PATCH', `/orders/${oid}/discount`, { ...d10, override_pin: '1111' });
    ok(r.status === 200, 'the owner PIN approves it');
    const last = JSON.parse((db.prepare(`SELECT metadata FROM audit_events WHERE event_type='sale.discount_applied' ORDER BY rowid DESC LIMIT 1`).get() as any).metadata);
    ok(last.requested_by === 'u-mgr' && last.approved_by === 'u-own', 'audited: manager requested, owner approved');
    O.dom.window.close(); C.dom.window.close();

    console.log(`\n✅ Meridian discounts passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* closed */ } }
    for (const s of fakes) { try { await closeServer(s); } catch { /* closed */ } }
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
