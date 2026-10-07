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
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-cterm-'));
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
  console.log('Testing Meridian card terminal flow (UI → HTTP → backend → DB)...');
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
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, barcode, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p-odd5','cat','Declined lunch',10.05,1,'O5','5000000000055',1,3,0,0,0,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, barcode, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p-odd6','cat','Slow lunch',10.06,1,'O6','5000000000062',1,4,0,0,0,?,?)`).run(now(), now());
  process.env.PLEMMO_ALLOW_CARD_SIMULATOR = '1';
  process.env.PLEMMO_CARD_SIMULATOR_DELAY_MS = '0';
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
    const O = await boot('u-own');
    const cart = () => C.M().U.cart;
    const payRows = () => db.prepare(`SELECT p.* FROM payments p ORDER BY p.rowid`).all() as any[];
    const attempts = () => db.prepare(`SELECT * FROM card_attempts ORDER BY rowid`).all() as any[];
    const text = () => (C.win.eval("PAY&&PAY.L&&PAY.L.el?PAY.L.el.textContent:''") as string) || '';
    const openPay = async (pid: string, qty = 1) => {
      for (let i = 0; i < qty; i++) C.click('add', { id: pid });
      C.click('charge');
      await waitFor(() => !!C.doc.querySelector('[data-act="payCard"]'), 5000, 'pay modal with card pane');
    };

    console.log('\n1. no provider: the manual path is labelled unverified');
    await openPay('p-tea');
    ok(/unverified/i.test(text()) && !C.doc.querySelector('[data-act="payCardManual"]'), 'without a provider the pane says unverified and offers no terminal');
    C.click('payCancel'); await waitFor(() => !C.doc.querySelector('#payBody'), 4000, 'pay modal closed');
    await sleep(300); C.win.eval('U.cart=newCart();refreshPos()'); await sleep(100);

    console.log('\n2. owner turns the simulated terminal on in Settings');
    O.click('nav', { v: 'settings' }); await waitFor(() => O.M().U.view === 'settings', 3000, 'settings');
    O.click('setTab', { t: 'cards' });
    await waitFor(() => /Card provider/.test(O.doc.querySelector('.set-sec')!.textContent || ''), 5000, 'cards tab');
    ok(/separate terminal/.test(O.doc.querySelector('.set-sec')!.textContent || ''), 'the tab explains cards are recorded by hand with no provider');
    const sel = O.doc.querySelector('select[data-ch="cardProvider"]') as any;
    ok(!!sel && Array.from(sel.options).some((o: any) => o.value === 'simulator'), 'the simulator is offered (this is not a release build)');
    await O.win.eval("CH.cardProvider('simulator')");
    await waitFor(() => (db.prepare("SELECT value FROM settings WHERE key='card_provider'").get() as any)?.value === 'simulator', 4000, 'setting saved');
    await waitFor(() => /Simulated terminal 1: online/.test(O.doc.querySelector('.set-sec')!.textContent || ''), 5000, 'terminal listed');
    ok(/no real card is ever charged/i.test(O.doc.querySelector('.set-sec')!.textContent || ''), 'the tab says the simulator never charges a real card');
    ok(/Nothing needs checking/.test(O.doc.querySelector('.set-sec')!.textContent || ''), 'reconciliation is empty');

    console.log('\n3. approved on the terminal, with a tip');
    const before = payRows().length;
    await openPay('p-tea', 2);
    ok(/sent to the card terminal/.test(text()) && /simulated terminal/i.test(text()), 'the pane says the amount goes to the terminal and that it is simulated');
    ok(!!C.doc.querySelector('[data-act="payCardManual"]'), 'a manual fallback is still offered, clearly separate');
    C.click('payTip', { p: '10' });
    await waitFor(() => /4\.40/.test(text()), 3000, 'tip total');
    C.click('payCard');
    await waitFor(() => attempts().length >= 1, 5000, 'attempt created');
    ok(attempts().length >= 1, 'an attempt was created on the server');
    await waitFor(() => payRows().length === before + 1, 12000, 'payment row after approval');
    await waitFor(() => cart().items.length === 0, 8000, 'sale finished');
    const p1 = payRows()[before];
    ok(p1.adapter === 'card_terminal' && p1.state === 'captured', 'recorded as a provider-verified card payment');
    ok(p1.amount_minor === 400 && p1.tip_minor === 40, 'amount 4.00 and tip 0.40 were charged as one terminal payment');
    ok(JSON.parse(p1.metadata).verified === true && JSON.parse(p1.metadata).card_last4 === '4242', 'verified, with the last four digits only');
    ok(attempts()[attempts().length - 1].state === 'consumed', 'the approval was used exactly once');
    await waitFor(() => !!C.doc.querySelector('.rc-modal'), 4000, 'receipt');
    ok(/····4242/.test(C.doc.querySelector('.rc-modal')!.textContent || '') && /simulated/.test(C.doc.querySelector('.rc-modal')!.textContent || ''), 'the receipt shows the card ending and says simulated');
    C.click('closeTop'); await sleep(300);

    console.log('\n4. declined: nothing is recorded and the cashier can retry or choose another way');
    const before4 = payRows().length;
    await openPay('p-odd5');
    C.click('payCard');
    await waitFor(() => /declined/i.test(text()), 12000, 'declined message');
    ok(/No payment taken/.test(text()) && !!C.doc.querySelector('[data-act="payCardRetry"]') && !!C.doc.querySelector('[data-act="payCardBack"]'), 'the pane says no payment was taken and offers retry or another way');
    ok(payRows().length === before4 && cart().items.length === 1, 'no payment recorded; the cart is kept');
    C.click('payCardBack');
    await waitFor(() => !!C.doc.querySelector('[data-act="payCard"]'), 3000, 'back at the card pane');
    ok(attempts().some((a: any) => a.state === 'declined'), 'the declined attempt is on record');

    console.log('\n5. cancelling a payment the customer has not started');
    C.click('payCancel'); await waitFor(() => !C.doc.querySelector('#payBody'), 4000, 'closed');
    await sleep(300); C.win.eval('U.cart=newCart();refreshPos()'); await sleep(100);
    await openPay('p-odd6');
    C.click('payCard');
    await waitFor(() => /Waiting for the customer/.test(text()), 12000, 'waiting for the customer');
    ok(!!C.doc.querySelector('[data-act="payCardCancel"]'), 'a cancel button is offered while waiting');
    C.click('payCardCancel');
    await waitFor(() => attempts().some((a: any) => a.state === 'cancelled'), 6000, 'attempt cancelled on the server');
    ok(payRows().length === before4, 'cancelling recorded nothing');
    ok(!!C.doc.querySelector('[data-act="payCard"]'), 'the till is back at the card pane');

    console.log('\n6. the terminal is down: record by hand, clearly unverified');
    C.click('payCancel'); await waitFor(() => !C.doc.querySelector('#payBody'), 4000, 'closed');
    await sleep(300); C.win.eval('U.cart=newCart();refreshPos()'); await sleep(100);
    const before6 = payRows().length;
    await openPay('p-tea');
    C.click('payCardManual');
    await waitFor(() => !!C.doc.getElementById('payRef'), 3000, 'manual confirm');
    ok(/Enter this amount on your card terminal/.test(text()), 'the manual path asks staff to use their own terminal');
    (C.doc.getElementById('payRef') as any).value = 'RCPT-9001';
    C.click('payCardOk');
    await waitFor(() => payRows().length === before6 + 1, 8000, 'manual payment row');
    ok(payRows()[before6].adapter === 'manual_card' && payRows()[before6].state === 'captured', 'recorded as manual_card (unverified), never as a verified card payment');
    await waitFor(() => cart().items.length === 0, 6000, 'sale finished');
    C.click('closeTop'); await sleep(200);

    console.log('\n7. switching the provider off returns to unverified manual cards');
    await O.win.eval("CH.cardProvider('none')");
    await waitFor(() => /separate terminal/.test(O.doc.querySelector('.set-sec')!.textContent || ''), 5000, 'tab updated');
    ok((db.prepare("SELECT value FROM settings WHERE key='card_provider'").get() as any)?.value === 'none', 'provider is none again');

    console.log(`\n✅ Meridian card terminal passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* ignore */ } }
    for (const f of fakes) await closeServer(f);
    await stopServer();
    closeDatabase();
  }
}
run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
