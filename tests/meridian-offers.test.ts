/*
 * Meridian offers — stocktake, stock value, stock import and the live stock history (UI → HTTP → backend → DB).
 *
 * Everything on these screens is the server\'s: a stocktake is counted by typing and scanning, reviewed and
 * approved into ledger adjustments; stock value is the ledger times cost; an import is checked, then applied.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-stock-'));
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
  console.log('Testing Meridian offers (UI → HTTP → backend → DB)...');
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
    const setting = (k: string, v: string) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
    setting('country', 'GB'); setting('taxes_enabled', 'true'); setting('business_type', 'retail');
    db.prepare(`UPDATE products SET tax_category_id = 'standard', tax_behavior = 'country_default' WHERE id IN ('p-bagel','p-tea')`).run();
    const O = await boot('u-own');
    await O.win.eval('PlemmoCatalogue.load(S)');
    const view = () => (O.doc.getElementById('view').textContent || '').replace(/\s+/g, ' ');
    const field = (id: string, v: string) => { const el = O.doc.getElementById(id) as any; if (!el) throw new Error('no field ' + id); el.value = v; el.dispatchEvent(new O.win.Event('input', { bubbles: true })); el.dispatchEvent(new O.win.Event('change', { bubbles: true })); };
    const cartText = () => (O.doc.getElementById('cart')?.textContent || '').replace(/\s+/g, ' ');

    console.log('\n1. setting up an offer in the till');
    O.win.eval("go('items')");
    await waitFor(() => /Items & stock/.test(view()), 6000, 'Items screen');
    ok(!!Array.from(O.doc.querySelectorAll('[data-act="itTab"]')).find((b: any) => b.dataset.t === 'offers'), 'an owner is offered an Offers tab');
    O.click('itTab', { t: 'offers' });
    await waitFor(() => /No offers yet/.test(view()), 5000, 'empty offers list');
    O.click('ofEdit', {});
    await waitFor(() => !!O.doc.getElementById('ofGo'), 4000, 'offer form');
    field('ofN', 'Bagels: buy 2 get 1 free'); field('ofK', 'buy_get_free');
    await waitFor(() => !!O.doc.getElementById('ofV2'), 3000, 'buy / free fields');
    field('ofV1', '2'); field('ofV2', '1'); field('ofS', 'products');
    const sel = O.doc.getElementById('ofP') as any; Array.from(sel.options).forEach((o: any) => { o.selected = o.value === 'p-bagel'; });
    O.clickEl('#ofGo');
    await waitFor(() => !!db.prepare("SELECT 1 FROM offers WHERE name = 'Bagels: buy 2 get 1 free'").get(), 6000, 'offer saved');
    const saved = db.prepare("SELECT * FROM offers WHERE name = 'Bagels: buy 2 get 1 free'").get() as any;
    ok(saved.kind === 'buy_get_free' && saved.buy_qty === 2 && saved.get_qty === 1 && JSON.parse(saved.product_ids)[0] === 'p-bagel', 'the SERVER has the offer with the values typed');
    await waitFor(() => /Buy 2, get 1 free/.test(view()) && /Bagel/.test(view()), 5000, 'listed');
    ok(/Always/.test(view()) && /On/.test(view()), 'it is listed as always on');
    await waitFor(() => O.doc.querySelectorAll('.modal').length === 0, 4000, 'first form closed');
    O.click('ofEdit', {}); await waitFor(() => !!O.doc.getElementById('ofGo'), 4000, 'form 2');
    field('ofN', ''); O.clickEl('#ofGo');
    await waitFor(() => !(O.doc.getElementById('ofErr') as any).hidden, 4000, 'refusal shown');
    ok(/name/i.test(O.doc.getElementById('ofErr')!.textContent || ''), 'the server\'s refusal is shown in the form (a name is needed)');
    O.click('closeTop'); await waitFor(() => O.doc.querySelectorAll('.modal').length === 0, 4000, 'closed');

    console.log('\n2. the register shows the saving, the till charges it');
    O.click('nav', { v: 'pos' }); await waitFor(() => O.M().U.view === 'pos', 3000, 'pos');
    for (let i = 0; i < 3; i++) O.click('add', { id: 'p-bagel' });
    await waitFor(() => /Offer: Bagels/.test(cartText()), 5000, 'offer line in the cart');
    ok(/−£4\.00|−£4/.test(cartText()) && /£8\.00/.test(cartText()), 'three bagels: £12.00 less £4.00 for the offer, total £8.00');
    ok(!/Remove/.test((O.doc.querySelector('.tot-row.disc') as any).textContent), 'an offer cannot be removed like a manual discount');
    O.click('charge');
    await waitFor(() => !!O.doc.querySelector('[data-act="payCard"]'), 6000, 'pay modal');
    ok(/8\.00/.test((O.win.eval("PAY.L.el.textContent") as string)), 'the pay screen charges the server\'s £8.00');
    O.click('payMethod', { m: 'cash' }); await waitFor(() => !!O.doc.querySelector('[data-act="payCash"]'), 3000, 'cash pane');
    O.click('payCash');
    await waitFor(() => !!db.prepare("SELECT 1 FROM bills WHERE payment_status = 'paid'").get(), 8000, 'paid');
    const ord = db.prepare("SELECT o.* FROM orders o JOIN bills b ON b.order_id = o.id WHERE b.payment_status = 'paid' ORDER BY o.id DESC").get() as any;
    ok(ord.discount_source === 'offer' && ord.discount_amount === 4 && ord.total === 8, 'the sale on the server: offer discount £4.00, total £8.00');
    await waitFor(() => !!O.doc.querySelector('.rc-modal'), 5000, 'receipt');
    ok(/Offer: Bagels/.test(O.doc.querySelector('.rc-modal')!.textContent || '') && /8\.00/.test(O.doc.querySelector('.rc-modal')!.textContent || ''), 'the receipt names the offer and shows £8.00');
    O.click('closeTop'); await waitFor(() => O.doc.querySelectorAll('.modal').length === 0, 4000, 'receipt closed');

    console.log('\n3. a manual discount replaces it; switching off stops it');
    for (let i = 0; i < 3; i++) O.click('add', { id: 'p-bagel' });
    await waitFor(() => /Offer: Bagels/.test(cartText()), 5000, 'offer again');
    O.win.eval("U.cart.discount={kind:'pct',value:10,reason:'Regular'};refreshPos()");
    await waitFor(() => !/Offer: Bagels/.test(cartText()) && /Regular/.test(cartText()), 3000, 'manual discount shown instead');
    ok(true, 'with a manual discount on the cart the offer line goes away');
    O.win.eval("U.cart.discount=null;refreshPos()");
    O.click('nav', { v: 'items' }); await waitFor(() => O.M().U.view === 'items', 3000, 'items');
    O.click('itTab', { t: 'offers' }); await waitFor(() => /Switch off/.test(view()), 5000, 'offers list');
    O.click('ofToggle', { id: saved.id });
    await waitFor(() => (db.prepare('SELECT is_active FROM offers WHERE id = ?').get(saved.id) as any).is_active === 0, 5000, 'switched off');
    await waitFor(() => /Switch on/.test(view()), 4000, 'list updated');
    O.click('nav', { v: 'pos' }); await waitFor(() => O.M().U.view === 'pos', 3000, 'pos 2');
    O.win.eval('U.cartOffer=null;refreshPos()'); await sleep(900);
    ok(!/Offer: Bagels/.test(cartText()), 'a switched-off offer no longer shows on the register');

    console.log('\n4. a cashier cannot set offers up');
    const C = await boot('u-cash');
    C.win.eval("go('items')"); await sleep(300);
    ok(!Array.from(C.doc.querySelectorAll('[data-act="itTab"]')).find((b: any) => b.dataset.t === 'offers'), 'a cashier is not offered the Offers tab');

    console.log(`\n✅ Meridian offers passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* ignore */ } }
    for (const f of fakes) await closeServer(f);
    await stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
