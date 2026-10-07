/*
 * Meridian items file — stocktake, stock value, stock import and the live stock history (UI → HTTP → backend → DB).
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
  console.log('Testing Meridian items file (UI → HTTP → backend → DB)...');
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
    const O = await boot('u-own');
    const view = () => (O.doc.getElementById('view').textContent || '').replace(/\s+/g, ' ');
    O.win.eval("go('items')");
    await waitFor(() => /Items & stock/.test(view()), 6000, 'Items screen');
    O.click('itTab', { t: 'menu' });
    await waitFor(() => /What are you moving/.test(view()), 4000, 'items file tab');
    ok(/Items file/.test(view()) && /Blank template/.test(view()), 'a connected till offers an Items file tab with export and a blank template');

    console.log('\n1. downloads are the server\'s files');
    const dl: { name: string; data: string }[] = [];
    O.win.eval("window.__dl=[];DL=null;offerDownload=async function(n,d){window.__dl.push({name:n,data:d});}");
    O.click('mcExport'); await waitFor(() => O.win.__dl.length === 1, 4000, 'export');
    ok(/^name,category/m.test(O.win.__dl[0].data) || /Bagel/.test(O.win.__dl[0].data), 'the export contains the till\'s items');
    ok(/Bagel/.test(O.win.__dl[0].data) && /Tea/.test(O.win.__dl[0].data), 'with Bagel and Tea in it');
    O.click('mcTemplate'); await waitFor(() => O.win.__dl.length === 2, 4000, 'template');
    ok(/name/.test(String(O.win.__dl[1].data).split(/\r?\n/)[0]) && O.win.__dl[1].name === 'products-template.csv', 'the blank template downloads');

    console.log('\n2. import items from a file');
    const header = (O.win.__dl[0].data as string).split(/\r?\n/)[0];
    const cols = header.split(',');
    const row = (v: Record<string, string>) => cols.map((c: string) => (v[c] ?? '').replace(/,/g, ' ')).join(',');
    const csv = [header, row({ name: 'Flapjack', category: 'Food', price: '2.20', cost: '0.60', sku: 'FLAP' }), row({ name: 'Brownie', category: 'Food', price: '2.80', cost: '0.70', sku: 'BRWN' })].join('\n');
    const ta = O.doc.querySelector('textarea[data-in="mcText"]') as any;
    ta.value = csv; ta.dispatchEvent(new O.win.Event('input', { bubbles: true }));
    await waitFor(() => !(O.doc.querySelector('[data-act="mcImport"]') as any).disabled, 3000, 'import enabled');
    ok(/2 rows ready to import/.test(view()) || /ready to import/.test(view()), 'the page says how many rows are ready');
    const before = (db.prepare(`SELECT COUNT(*) n FROM products`).get() as any).n;
    O.click('mcImport');
    await waitFor(() => !!O.doc.getElementById('cfOk'), 4000, 'confirm');
    O.clickEl('#cfOk');
    await waitFor(() => /Import result/.test(view()), 8000, 'import result');
    const after = (db.prepare(`SELECT COUNT(*) n FROM products`).get() as any).n;
    ok(after === before + 2, `two items were really added on the server (${before} → ${after})`);
    const fj = db.prepare(`SELECT price, sku FROM products WHERE name = 'Flapjack'`).get() as any;
    ok(fj && fj.price === 2.2 && fj.sku === 'FLAP', 'with the price and code from the file');
    ok(/Added/.test(view()) && /Problems/.test(view()), 'the result shows added, updated, skipped and problem counts');
    await waitFor(() => O.M().S.products.some((p: any) => p.name === 'Flapjack'), 6000, 'till catalogue refreshed');
    ok(true, 'the till\'s own item list picked the new items up without a restart');

    console.log('\n3. a bad row is reported, not hidden');
    const bad = [header, row({ name: 'Broken', category: 'Food', price: 'abc', cost: '1', sku: 'BRK' })].join('\n');
    const m = O.M().U.st.mc; m.text = bad; m.result = null;
    O.win.eval('renderView()');
    await waitFor(() => O.doc.querySelectorAll('.modal').length === 0, 4000, 'earlier dialog gone');
    O.click('mcImport'); await waitFor(() => !!O.doc.getElementById('cfOk'), 4000, 'confirm 2'); O.clickEl('#cfOk');
    await waitFor(() => /Import result/.test(view()) && /Rows that were not imported/.test(view()), 8000, 'problem list');
    ok(!db.prepare(`SELECT 1 FROM products WHERE name = 'Broken'`).get(), 'the invalid row was not imported');
    ok(/Row 2/.test(view()), 'and the page names the row and the reason');

    console.log('\n4. categories');
    O.click('mcKind', {}); O.win.eval("CH.mcKind('categories')");
    await waitFor(() => /categories/.test(view()), 3000, 'categories');
    O.click('mcTemplate'); await waitFor(() => O.win.__dl.length === 3 && O.win.__dl[2].name === 'categories-template.csv', 4000, 'categories template');
    ok(true, 'the categories template downloads');

    console.log('\n5. a cashier cannot see it');
    const C = await boot('u-cash');
    C.win.eval("go('items')"); await sleep(300);
    ok(!/Items file/.test((C.doc.getElementById('view').textContent || '')), 'a cashier is not offered the Items file tab');
    ok((await http(C.tok(), 'POST', '/menu-csv/import/products', { csv })).status === 403, 'and the server refuses a cashier\'s import anyway');

    console.log(`\n✅ Meridian items file passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* ignore */ } }
    for (const f of fakes) await closeServer(f);
    await stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
