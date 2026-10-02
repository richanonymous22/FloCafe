/*
 * Meridian stock tools — stocktake, stock value, stock import and the live stock history (UI → HTTP → backend → DB).
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
  console.log('Testing Meridian stock tools (UI → HTTP → backend → DB)...');
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
    const text = () => { const ms = Array.from(O.doc.querySelectorAll('.modal')); return (ms.length ? (ms[ms.length - 1] as any).textContent : '') || ''; };

    const view = () => (O.doc.getElementById('view').textContent || '').replace(/\s+/g, ' ');
    const tab = async (t: string) => { O.click('itTab', { t }); await sleep(120); };
    O.win.eval("go('items')");
    await waitFor(() => /Items & stock/.test(view()), 6000, 'Items screen');
    ok(/Stocktake/.test(view()) && /Stock value/.test(view()) && /Import stock/.test(view()), 'a connected till offers Stocktake, Stock value and Import stock');

    console.log('\n1. start a stocktake');
    await tab('take');
    await waitFor(() => /Start a stocktake/.test(view()), 6000, 'start panel');
    (O.doc.getElementById('stName') as any).value = 'Month end';
    O.click('stStart');
    await waitFor(() => /Month end/.test(view()) && /Bagel/.test(view()), 6000, 'counting screen');
    const st = db.prepare(`SELECT * FROM stocktakes`).get() as any;
    ok(st && st.status === 'counting' && st.name === 'Month end', 'the stocktake is in the database, counting');
    ok(/0 of 1 counted/.test(view()), 'it says 0 of 1 counted (the untracked Tea is not stock)');
    ok(!/Expected/.test(view()), 'the count is blind: expected quantities are hidden while counting');

    console.log('\n2. count by scanning and typing');
    const scan = async (code: string) => {
      (O.doc.getElementById('stCode') as any).value = code;
      O.doc.getElementById('stScanForm')!.dispatchEvent(new O.win.Event('submit', { bubbles: true, cancelable: true }));
    };
    await scan('5012345678900');
    await waitFor(() => /Bagel: 1 counted/.test(view()), 6000, 'scan result');
    ok((db.prepare(`SELECT counted FROM stocktake_lines`).get() as any).counted === 1, 'a scan of the Bagel barcode counted one (saved on the server)');
    O.clearToasts();
    await scan('NOT-A-CODE');
    await waitFor(() => /Nothing in this stocktake has the code/.test(O.toasts()), 6000, 'unknown code toast');
    ok((db.prepare(`SELECT counted FROM stocktake_lines`).get() as any).counted === 1, 'an unknown barcode is refused with a clear message and counts nothing');
    const input = O.doc.querySelector('input[data-ch="stSet"]') as any;
    input.value = '8';
    input.dispatchEvent(new O.win.Event('change', { bubbles: true }));
    await waitFor(() => (db.prepare(`SELECT counted FROM stocktake_lines`).get() as any).counted === 8, 6000, 'typed count saved');
    ok((db.prepare(`SELECT counted FROM stocktake_lines`).get() as any).counted === 8, 'typing 8 replaces the count (saved on the server)');
    O.click('stReveal');
    await waitFor(() => /Expected/.test(view()) && /Difference/.test(view()), 4000, 'review');
    ok(/-2/.test(view()) || /−2/.test(view()), 'Review variances shows the difference: 2 short of the 10 in stock');

    console.log('\n3. approve');
    O.click('stApprove');
    await waitFor(() => !!O.doc.getElementById('cfOk'), 4000, 'confirm');
    O.clickEl('#cfOk');
    await waitFor(() => /approved/.test(view()), 8000, 'approved');
    ok(stock() === 8, 'the ledger now says 8 Bagels');
    ok((db.prepare(`SELECT COUNT(*) n FROM inventory_movements WHERE reason LIKE 'Stocktake 1%'`).get() as any).n === 1, 'one ledger adjustment, with the stocktake as its reason');
    ok(O.M().S.products.find((p: any) => p.id === 'p-bagel').stock === 8, 'the register shows the new stock too');

    console.log('\n4. stock value');
    await tab('value');
    await waitFor(() => /Stock at cost/.test(view()), 6000, 'value');
    ok(/Stock at cost\s*£8\.00/.test(view()) && /8 units on hand/.test(view()), 'stock at cost is £8.00 (8 × £1.00)');
    const downloads: any[] = [];
    O.win.offerDownload = (name: string, data: string) => { downloads.push({ name, data }); };
    O.click('stValueCsv');
    await waitFor(() => downloads.length === 1, 6000, 'valuation csv');
    ok(/^SKU,Item,Category,Quantity,Unit cost,Value/.test(downloads[0].data) && /Bagel,Food,8,1\.00,8\.00/.test(downloads[0].data), 'the stock value CSV is the server\'s file');

    console.log('\n5. import');
    await tab('import');
    const ta = O.doc.getElementById('impText') as any;
    ta.value = 'barcode,quantity\n5012345678900,12\nNOPE,1';
    ta.dispatchEvent(new O.win.Event('input', { bubbles: true }));
    O.click('impCheck');
    await waitFor(() => /No item has this SKU or barcode/.test(view()), 6000, 'check result');
    ok(/1 to change, 0 unchanged, 1 with a problem/.test(view()), 'the check reports 1 valid row and 1 problem');
    ok((O.doc.querySelector('[data-act="impApply"]') as any).disabled === true, 'a file with a problem cannot be applied');
    const ta2 = O.doc.getElementById('impText') as any;
    ta2.value = 'barcode,quantity\n5012345678900,12';
    ta2.dispatchEvent(new O.win.Event('input', { bubbles: true }));
    O.click('impCheck');
    await waitFor(() => /1 to change, 0 unchanged, 0 with a problem/.test(view()), 6000, 'clean check');
    ok(stock() === 8, 'checking changed no stock');
    O.click('impApply');
    await waitFor(() => !!O.doc.getElementById('cfOk'), 4000, 'confirm import');
    O.clickEl('#cfOk');
    await waitFor(() => /Imported: 1 stock change/.test(view()), 8000, 'applied');
    ok(stock() === 12, 'the import set the Bagel stock to 12');

    console.log('\n6. stock history is the ledger');
    await tab('log');
    await waitFor(() => /Stocktake 1/.test(view()) && /Import/.test(view()), 6000, 'history');
    ok(/Stocktake 1/.test(view()) && /Import/.test(view()), 'the history lists the stocktake correction and the import, from the ledger');
    O.dom.window.close();

    console.log('\n7. staff without permission');
    const C = await boot('u-cash');
    C.win.eval("go('items'); U.items.tab='take'; renderView()");
    await sleep(300);
    ok(C.win.eval('U.view') === 'pos', 'a cashier is kept on the register: the Items & stock screen is not open to them');
    ok((await http(C.tok(), 'POST', '/stocktakes', {})).status === 403 && (await http(C.tok(), 'POST', '/inventory/import', { csv: 'sku,quantity\nx,1', mode: 'set' })).status === 403, 'and the server refuses a cashier\'s stocktake and import even if asked directly');
    C.dom.window.close();

    console.log(`\n✅ Meridian stock tools passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* closed */ } }
    for (const s of fakes) { try { await closeServer(s); } catch { /* closed */ } }
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
