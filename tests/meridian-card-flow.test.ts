/*
 * Meridian card payment — honest flow (UI → HTTP → backend → DB).
 *
 * The till is not connected to a card terminal, so it must not pretend to be:
 * staff take the amount on their own terminal and confirm the result. The
 * backend stores it as an UNVERIFIED manual card payment (state "captured"),
 * with the terminal reference when one is given. A declined/cancelled card
 * records nothing. The same terminal reference cannot be reused on another sale.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-card-'));
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
  console.log('Testing Meridian card flow (UI → HTTP → backend → DB)...');
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
    const payRows = () => db.prepare(`SELECT p.* FROM payments p ORDER BY p.rowid`).all() as any[];
    const openPay = async (qty: number) => {
      for (let i = 0; i < qty; i++) C.click('add', { id: 'p-tea' });
      C.click('charge');
      await waitFor(() => !!C.doc.querySelector('[data-act="payCard"]'), 4000, 'pay modal with card pane');
    };

    console.log('\n1. the reader is not faked');
    await openPay(2);
    const text = () => (C.doc.getElementById('payBody').textContent || '');
    ok(!/Visa ending|battery|Connected/i.test(text()), 'no fake "Visa ending", "battery" or "Connected" claims on the card pane');
    ok(/not talk to the terminal|unverified/i.test(text()), 'the pane says the payment is recorded as unverified');

    console.log('\n2. declined / cancelled records nothing');
    const before = payRows().length;
    C.click('payCard');
    await waitFor(() => !!C.doc.querySelector('[data-act="payCardOk"]'), 3000, 'confirm stage');
    ok(!!C.doc.getElementById('payRef') && !!C.doc.querySelector('[data-act="payCardNo"]'), 'the confirm stage asks for the result and an optional terminal reference');
    ok((C.doc.querySelector('[data-act="payCancel"]') as any).disabled === true, 'the pay modal cannot be cancelled while the terminal is mid-payment');
    C.clearToasts();
    C.click('payCardNo');
    await waitFor(() => /not taken/i.test(C.toasts()), 3000, 'declined toast');
    ok(payRows().length === before && cart().items.length === 1, 'nothing recorded, cart kept');
    ok(!!C.doc.querySelector('[data-act="payCard"]'), 'the till is ready to try again');

    console.log('\n3. approved records an unverified card payment with the reference');
    C.click('payCard');
    await waitFor(() => !!C.doc.getElementById('payRef'), 3000, 'confirm stage 2');
    (C.doc.getElementById('payRef') as any).value = 'AUTH-004217';
    C.click('payCardOk');
    await waitFor(() => payRows().length === before + 1, 8000, 'payment row');
    await waitFor(() => cart().items.length === 0, 6000, 'sale finished');
    const p1 = payRows()[before];
    ok(p1.adapter === 'manual_card' && p1.method === 'card', 'stored through the manual card adapter');
    ok(p1.state === 'captured', 'state is "captured" (unverified by any provider), not "settled"');
    ok(p1.provider_reference === 'AUTH-004217' && p1.amount_minor === 400, 'terminal reference and amount (2 x 2.00) stored');

    console.log('\n4. a reused terminal reference is refused; the retry reuses the same order');
    const ordersBefore = (db.prepare(`SELECT COUNT(*) n FROM orders`).get() as any).n;
    await openPay(1);
    C.click('payCard');
    await waitFor(() => !!C.doc.getElementById('payRef'), 3000, 'confirm stage 3');
    (C.doc.getElementById('payRef') as any).value = 'AUTH-004217';
    C.clearToasts();
    C.click('payCardOk');
    await waitFor(() => /already used/i.test(C.toasts()), 8000, 'duplicate reference toast');
    ok(payRows().length === before + 1, 'no second payment row was created');
    ok(cart().items.length === 1, 'the cart is kept so the cashier can correct the reference');
    const ordersAfterFail = (db.prepare(`SELECT COUNT(*) n FROM orders`).get() as any).n;
    ok(ordersAfterFail === ordersBefore + 1, 'the failed save created exactly one order (its payment is what failed)');
    await waitFor(() => !!C.doc.querySelector('[data-act="payRetry"]'), 4000, 'retry pane');
    ok(!/£0\.00 by card/.test(text()) && /Nothing more is charged/.test(text()), 'the modal offers "Save the sale", not a £0.00 card charge');
    (C.doc.getElementById('payRef2') as any).value = 'AUTH-777';
    C.click('payRetry');
    await waitFor(() => payRows().length === before + 2, 8000, 'retry payment row');
    await waitFor(() => cart().items.length === 0, 6000, 'sale finished after retry');
    ok((db.prepare(`SELECT COUNT(*) n FROM orders`).get() as any).n === ordersBefore + 1, 'the retry reused the same order: still exactly one order for this sale');
    const p2 = payRows()[before + 1];
    ok(p2.provider_reference === 'AUTH-777' && p2.state === 'captured', 'the corrected reference was saved, still unverified');

    console.log('\n5. approved without a reference is allowed');
    await openPay(1);
    C.click('payCard');
    await waitFor(() => !!C.doc.getElementById('payRef'), 3000, 'confirm stage 4');
    C.click('payCardOk');
    await waitFor(() => payRows().length === before + 3, 8000, 'third payment row');
    const p3 = payRows()[before + 2];
    ok(p3.adapter === 'manual_card' && p3.state === 'captured' && !p3.provider_reference, 'recorded as unverified with no reference');
    console.log('\n6. kiosk places an order and asks the customer to pay at the counter (no fake approval)');
    const K = await boot('u-own');
    K.win.eval("openKiosk()");
    K.win.eval("kAdd(prod('p-tea'),[],2)");
    const kOrdersBefore = (db.prepare(`SELECT COUNT(*) n FROM orders`).get() as any).n;
    const kPaysBefore = payRows().length;
    const kBillsBefore = (db.prepare(`SELECT COUNT(*) n FROM bills`).get() as any).n;
    K.win.eval("A.kReview()");
    const kText = () => (K.doc.getElementById('kiosk').textContent || '');
    ok(/Place order/.test(kText()) && !/Tap, insert or swipe|card reader/i.test(kText()), 'the review screen says "Place order", not "Pay" with a card reader');
    K.click('kPay');
    await waitFor(() => /pay at the counter/i.test(kText()), 8000, 'kiosk done screen');
    ok(!/Approved|Printing your receipt/i.test(kText()), 'no "Approved" and no "Printing your receipt" claim');
    ok((db.prepare(`SELECT COUNT(*) n FROM orders`).get() as any).n === kOrdersBefore + 1, 'a real order was created on the backend');
    ok(payRows().length === kPaysBefore && (db.prepare(`SELECT COUNT(*) n FROM bills`).get() as any).n === kBillsBefore, 'no bill and no payment were recorded — nothing was charged');
    const ko = db.prepare(`SELECT status, total FROM orders ORDER BY id DESC LIMIT 1`).get() as any;
    ok(ko.total === 4 && ko.status !== 'completed' && ko.status !== 'paid', 'the order is open for the counter to collect (total 4.00)');
    K.dom.window.close();
    C.dom.window.close();

    console.log(`\n✅ Meridian card flow passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* closed */ } }
    for (const s of fakes) { try { await closeServer(s); } catch { /* closed */ } }
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
