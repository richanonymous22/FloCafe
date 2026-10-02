/*
 * Meridian loyalty wallet (UI → HTTP → backend → DB).
 *
 * The cashback wallet is the server's. Meridian offers it as a payment method
 * (never as a locally calculated "points discount"), the server checks the balance
 * and debits the ledger, cashback earned on the sale is reported from the server,
 * and a refused wallet payment is taken back out so another tender can be chosen.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-wallet-'));
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
  console.log('Testing Meridian wallet (UI → HTTP → backend → DB)...');
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
    db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('loyalty_enabled','true',?)`).run(now());
    db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('global_cashback_percent','10',?)`).run(now());
    db.prepare(`UPDATE products SET cb_percent = 10 WHERE id = 'p-bagel'`).run(); // 10% cashback on bagels
    const ledger = (type: string) => (db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM loyalty_ledger WHERE customer_id='c1' AND type=?`).get(type) as any).t as number;
    db.prepare(`INSERT INTO loyalty_ledger (customer_id, type, amount, description, created_at, updated_at) VALUES ('c1','credit',500,'Welcome gift',?,?)`).run(now(), now());
    const balance = () => ledger('credit') - ledger('debit');

    const C = await boot('u-own');
    await C.win.eval("PlemmoCatalogue.load(S)");
    await waitFor(() => (C.win.eval("cust('c1')") || {}).points === 500, 6000, 'customer wallet loaded (500 points)');
    const cart = () => C.M().U.cart;
    const addCust = () => C.click('attachCust', { id: 'c1' });
    const openPay = async () => { C.clearToasts(); C.click('charge'); await waitFor(() => !!C.doc.querySelector('[data-act="payMethod"]'), 8000, 'pay screen'); };

    console.log('\n1. no locally-calculated points discount while connected');
    C.click('add', { id: 'p-tea' }); C.click('add', { id: 'p-tea' }); // 4.00
    addCust();
    await waitFor(() => cart().custId === 'c1', 3000, 'customer attached');
    ok(!C.doc.querySelector('[data-act="redeem"]'), 'the "Use points" discount button is not offered (points are spent as a wallet payment)');

    console.log('\n2. pay the whole sale from the wallet');
    await openPay();
    ok(!!C.doc.querySelector('[data-act="payMethod"][data-m="wallet"]'), 'a Wallet method is offered because the customer has a balance');
    ok(!/earns .* points/i.test([...C.doc.querySelectorAll('#payBody')].pop()!.textContent || ''), 'no made-up "earns N points" estimate on the pay screen');
    C.click('payMethod', { m: 'wallet' });
    await waitFor(() => !!C.doc.querySelector('[data-act="payWallet"]'), 3000, 'wallet pane');
    ok(/5\.00/.test([...C.doc.querySelectorAll('#payBody')].pop()!.textContent || '') && /Use .*4\.00 from the wallet/.test([...C.doc.querySelectorAll('#payBody')].pop()!.textContent || ''), 'shows the 5.00 balance and offers to use 4.00');
    C.click('payWallet');
    await waitFor(() => (db.prepare(`SELECT COUNT(*) n FROM payments WHERE method='wallet'`).get() as any).n === 1, 8000, 'wallet payment row');
    await waitFor(() => cart().items.length === 0, 6000, 'sale finished');
    const wp = db.prepare(`SELECT adapter, amount_minor, state FROM payments WHERE method='wallet'`).get() as any;
    ok(wp.adapter === 'wallet' && wp.amount_minor === 400 && wp.state === 'settled', 'stored as a settled wallet payment of 4.00');
    ok(ledger('debit') === 400, 'the server debited 400 points from the ledger');
    ok(((C.win.eval("cust('c1')") as any).points) === 100 + 0 || ((C.win.eval("cust('c1')") as any).points) === 100, 'Meridian shows the server balance after the sale (100 points left)');
    const o = C.M().S.orders[C.M().S.orders.length - 1];
    ok(o.payments.length === 1 && o.payments[0].m === 'wallet', 'the order is mapped with a wallet tender, not mislabelled as card');

    C.win.eval('closeAll()'); // the first sale's receipt
    await waitFor(() => C.doc.querySelectorAll('.modal').length === 0, 4000, 'earlier dialogs gone');
    console.log('\n3. wallet + card split, cashback reported by the server');
    C.click('add', { id: 'p-bagel' }); C.click('add', { id: 'p-bagel' }); C.click('add', { id: 'p-bagel' }); // 12.00
    addCust();
    await waitFor(() => cart().custId === 'c1', 3000, 'customer attached 2');
    await openPay();
    C.click('payMethod', { m: 'wallet' });
    await waitFor(() => !!C.doc.querySelector('[data-act="payWallet"]'), 3000, 'wallet pane 2');
    ok(/Use .*1\.00 from the wallet/.test([...C.doc.querySelectorAll('#payBody')].pop()!.textContent || ''), 'only the remaining 1.00 balance is offered');
    C.click('payWallet');
    await waitFor(() => /Left to pay/.test([...C.doc.querySelectorAll('#payBody')].pop()!.textContent || '') && /11\.00/.test([...C.doc.querySelectorAll('#payBody')].pop()!.textContent || ''), 4000, 'remaining 11.00');
    C.click('payMethod', { m: 'card' });
    await waitFor(() => !!C.doc.querySelector('[data-act="payCard"]'), 3000, 'card pane');
    C.click('payCard');
    await waitFor(() => !!C.doc.getElementById('payRef'), 3000, 'confirm');
    C.click('payCardOk');
    await waitFor(() => cart().items.length === 0, 8000, 'split sale finished');
    const pays = db.prepare(`SELECT method, amount_minor FROM payments ORDER BY rowid DESC LIMIT 2`).all() as any[];
    ok(pays.some((p) => p.method === 'wallet' && p.amount_minor === 100) && pays.some((p) => p.method === 'card' && p.amount_minor === 1100), 'wallet 1.00 + card 11.00');
    ok(ledger('credit') > 500, 'cashback was credited by the server on the sale');
    const receiptText = () => Array.from(C.doc.querySelectorAll('.modal')).map((m: any) => m.textContent || '').find((t: string) => /Bagel/.test(t)) || '';
    await waitFor(() => /\+\d+ points/.test(receiptText()), 6000, 'receipt for the split sale');
    const rc = receiptText().match(/\+(\d+) points, balance (\d+)/);
    ok(!!rc && Number(rc[1]) === ledger('credit') - 500 && Number(rc[2]) === balance(), 'the receipt shows the cashback and balance the SERVER reports');
    ok(/Loyalty wallet/.test(receiptText()), 'the receipt labels the wallet tender');
    C.clickEl('.modal [data-act="closeTop"], .modal .btn');

    console.log('\n4. the server refuses a wallet payment the balance cannot cover');
    await waitFor(() => !C.doc.querySelector('.modal'), 4000, 'dialogs closed').catch(() => C.win.eval('closeAll()'));
    db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('global_cashback_percent','0',?)`).run(now());
    db.prepare(`INSERT INTO loyalty_ledger (customer_id, type, amount, description, created_at, updated_at) VALUES ('c1','credit',300,'Top up',?,?)`).run(now(), now());
    C.click('add', { id: 'p-tea' });
    addCust();
    await waitFor(() => cart().custId === 'c1', 3000, 'customer attached 3');
    await openPay();
    C.click('payMethod', { m: 'wallet' });
    await waitFor(() => !!C.doc.querySelector('[data-act="payWallet"]'), 3000, 'wallet pane 3');
    // somebody else spends the balance after this screen read it
    db.prepare(`INSERT INTO loyalty_ledger (customer_id, type, amount, description, created_at, updated_at) VALUES ('c1','debit',?,'Spent elsewhere',?,?)`).run(balance(), now(), now());
    const before = (db.prepare(`SELECT COUNT(*) n FROM payments`).get() as any).n;
    C.clearToasts();
    C.click('payWallet');
    await waitFor(() => /wallet payment was refused/i.test(C.toasts()), 8000, 'refusal toast');
    ok(/Insufficient wallet balance/i.test(C.toasts()), 'the server\'s reason is shown');
    ok((db.prepare(`SELECT COUNT(*) n FROM payments`).get() as any).n === before, 'no payment was recorded');
    await waitFor(() => !/Payment taken/.test([...C.doc.querySelectorAll('#payBody')].pop()!.textContent || ''), 4000, 'not stuck on Save the sale');
    ok(!!C.doc.querySelector('[data-act="payMethod"]'), 'the cashier is back at the choice of tenders (the wallet line was removed)');
    C.dom.window.close();

    console.log(`\n✅ Meridian wallet passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* closed */ } }
    for (const s of fakes) { try { await closeServer(s); } catch { /* closed */ } }
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
