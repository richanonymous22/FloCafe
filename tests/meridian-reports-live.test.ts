/*
 * Meridian Reports screen — the server's period report on screen (UI → HTTP → backend → DB).
 *
 * A connected till shows the server's numbers after refunds (never figures worked out in the browser),
 * offers the same CSVs the API serves, and tells a member of staff without permission so.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-replive-'));
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
  console.log('Testing Meridian Reports screen (UI → HTTP → backend → DB)...');
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
    const sellCash = async (pid: string, qty: number) => {
      const order = await O.win.PlemmoOrders.createOrder({ type: 'takeaway', items: [{ pid, qty, mods: [] }] }, O.M().S._plemmoAddons);
      const gen = await O.win.PlemmoAPI.post('/bills/generate', { order_id: order.id }, { idempotent: true });
      await O.win.PlemmoPayments.paySplit(gen.bill.id, [{ method: 'cash', amount: Number(gen.bill.total) }]);
      return gen.bill;
    };
    const text = () => { const ms = Array.from(O.doc.querySelectorAll('.modal')); return (ms.length ? (ms[ms.length - 1] as any).textContent : '') || ''; };

    console.log('\n1. the Reports screen shows the server\'s figures after refunds');
    await sellCash('p-bagel', 2);              // 8.00
    const tea = await sellCash('p-tea', 1);    // 2.00, then refunded in full
    const rf = await http(O.tok(), 'POST', `/bills/${tea.id}/refund`, { reason: 'Wrong order' });
    ok(rf.status === 200, 'the tea sale is refunded through the API');
    const view = () => (O.doc.getElementById('view').textContent || '').replace(/\s+/g, ' ');
    O.win.eval("go('reports')");
    await waitFor(() => /Takings after refunds/.test(view()), 8000, 'Reports screen');
    ok(/Takings after refunds\S*£8\.00/.test(view()), 'takings after refunds are £8.00 (£10.00 sold less the £2.00 refund)');
    ok(/£10\.00 sold, £2\.00 refunded/.test(view()), 'the sub-line states the sold and refunded amounts');
    ok(/Sales\S{0,4}2\d* items|SalesNew2/.test(view()) && /3 items sold/.test(view()), 'two sales, three items');
    ok(/Bagel/.test(view()) && /Tea/.test(view()), 'both products are listed');
    const teaRow = Array.from(O.doc.querySelectorAll('#view tbody tr')).find((r: any) => /Tea/.test(r.textContent || '') && /Food/.test(r.textContent || '')) as any;
    ok(!!teaRow && /£0\.00/.test(teaRow.textContent), 'the refunded product shows £0.00 net sales, not its original price');
    ok(/VAT 20%/.test(view()), 'VAT is shown per rate');
    ok(!/Busiest times/.test(view()), 'no browser-side heatmap on a connected till');

    console.log('\n2. every section has a working CSV');
    const downloads: Array<{ name: string; data: string }> = [];
    O.win.offerDownload = (name: string, data: string) => { downloads.push({ name, data }); };
    for (const s of ['products', 'categories', 'staff', 'vat']) {
      O.click('repCsv', { s });
      await waitFor(() => downloads.some((d) => d.name.startsWith(s + '-')), 6000, `${s} CSV`);
    }
    const prodCsv = downloads.find((d) => d.name.startsWith('products-'))!;
    ok(prodCsv.data.split('\r\n')[0].startsWith('Product,Category,Units sold'), 'the products CSV is the server\'s file');
    ok(/Bagel,Food,2,0,8\.00,1\.33,6\.67,0\.00,6\.67,2\.00,4.67,70\r\n/.test(prodCsv.data), 'Bagel row is exact: 2 sold, gross 8.00, VAT 1.33, net 6.67, profit 4.67');
    ok(/Tea,Food,1,1,2\.00,0\.33,1\.67,2\.00,0\.00,/.test(prodCsv.data), 'Tea row shows the return: 1 sold, 1 returned, net after refunds 0.00');
    O.click('repTab', { t: 'refunds' });
    await waitFor(() => /Wrong order/.test(view()), 4000, 'refund list');
    ok(/Refunds \(1\)/.test(view()) && /£2\.00/.test(view()), 'the Refunds tab lists the refund with its reason');

    console.log('\n3. changing the range asks the server again');
    O.click('repRange', { r: 'yesterday' });
    await waitFor(() => /Yesterday/.test(view()) && /Takings after refunds\S*£0\.00/.test(view()), 8000, 'yesterday');
    ok(/No sales in this period/.test(view()), 'yesterday had no sales');
    O.dom.window.close();

    console.log('\n4. staff without permission are told so');
    const C = await boot('u-cash');
    C.win.eval("U.view='reports'; renderView()");
    await waitFor(() => /Reports unavailable/.test(C.doc.getElementById('view').textContent || ''), 8000, 'refusal');
    ok(/permission/.test(C.doc.getElementById('view').textContent || ''), 'a cashier is told they do not have permission');
    C.dom.window.close();

    console.log(`\n✅ Meridian Reports screen passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* closed */ } }
    for (const s of fakes) { try { await closeServer(s); } catch { /* closed */ } }
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
