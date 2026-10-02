/*
 * Meridian trading reports — the server's X and Z on screen (UI → HTTP → backend → DB).
 *
 * "End of day" shows the till server's X report; closing the day creates a numbered, sealed Z that
 * cannot be run again; past Z reports are read back from the server. Staff without report
 * permission cannot read or close them.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-trade-'));
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
  console.log('Testing Meridian trading reports (UI → HTTP → backend → DB)...');
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
    await sellCash('p-bagel', 2); // 8.00
    await sellCash('p-tea', 1);   // 2.00
    const text = () => { const ms = Array.from(O.doc.querySelectorAll('.modal')); return (ms.length ? (ms[ms.length - 1] as any).textContent : '') || ''; };

    console.log('\n1. End of day shows the server\'s X report');
    O.click('eod');
    await waitFor(() => /X REPORT/.test(text()), 6000, 'X report');
    ok(/Sales\s*2/.test(text()) && /Gross sales\s*£10\.00/.test(text()), 'two sales, gross £10.00 — read from the till server');
    ok(/VAT 20%/.test(text()) && /VAT collected£1\.66/.test(text()), 'VAT by rate is the sum of what each receipt charged: £1.33 + £0.33 = £1.66 (rounded per sale, as on the receipts)');
    ok(/Not closed\. This is a read-only look/.test(text()), 'it says it is only a look');
    ok(!!O.doc.querySelector('[data-act="zClose"]'), 'an owner is offered "Close the day"');
    ok(/1\. Count and close the cash drawer/.test(text()) && /2\. Close the day/.test(text()) && /3\. Back up the database/.test(text()), 'the end-of-day checklist lists drawer, Z and backup in order');
    ok(!!O.doc.querySelector('[data-act="backup"]'), 'an owner is offered "Back up now"');

    console.log('\n2. closing the day makes a numbered, sealed Z');
    O.click('zClose');
    await waitFor(() => !!O.doc.getElementById('cfOk'), 4000, 'confirm');
    ok(Array.from(O.doc.querySelectorAll('.modal')).some((m: any) => /permanent record and cannot be changed or run again/.test(m.textContent || '')), 'the confirmation says it is permanent');
    O.clickEl('#cfOk');
    await waitFor(() => /Z REPORT 0001/.test(text()), 8000, 'Z report');
    const zrow = db.prepare(`SELECT * FROM z_reports`).get() as any;
    ok(zrow && zrow.number === 1 && JSON.parse(zrow.snapshot_json).sales.gross_minor === 1000, 'Z 1 is in the database with gross 10.00');
    ok(/Closed .* UTC · [0-9a-f]{12}/.test(text()), 'the screen shows when it was closed and the first characters of its seal');
    ok(/All totals agree/.test(text()), 'and that every cross-check passed');
    ok(!!O.doc.querySelector('.modal [data-act="backup"]') && /Back up the database before you leave/.test(O.toasts()), 'after the Z the owner is prompted to back up');

    console.log('\n3. it cannot be run again');
    await waitFor(() => !O.doc.querySelector('#cfOk'), 3000, 'dialog gone').catch(() => {});
    O.win.eval('closeAll()');
    await sleep(300);
    O.click('eod');
    await waitFor(() => /X REPORT/.test(text()), 6000, 'new X');
    ok(/Sales\s*0/.test(text()), 'the new period starts empty');
    O.click('zClose');
    await waitFor(() => !!O.doc.getElementById('cfOk'), 4000, 'confirm 2');
    O.clearToasts(); O.clickEl('#cfOk');
    await waitFor(() => /Nothing has happened since the last Z/.test(O.toasts()), 6000, 'refusal');
    ok((db.prepare(`SELECT COUNT(*) n FROM z_reports`).get() as any).n === 1, 'no second Z was created');

    console.log('\n4. past Z reports come back from the server');
    O.click('zList');
    await waitFor(() => /Z0001/.test(text()), 6000, 'history');
    O.click('zOpen', { id: zrow.id });
    await waitFor(() => /Z REPORT 0001/.test(text()) && /seal checked/.test(text()), 6000, 'stored Z');
    ok(/Gross sales\s*£10\.00/.test(text()), 'the stored Z shows exactly the closed figures');
    O.dom.window.close();

    console.log('\n5. staff without permission cannot read or close reports');
    const C = await boot('u-cash');
    C.clearToasts();
    C.click('eod');
    await waitFor(() => /could not be read/.test(C.toasts()), 6000, 'refusal');
    ok(/permission/.test(C.toasts()), 'a cashier is told they do not have permission');
    ok(!C.doc.querySelector('[data-act="zClose"]'), 'and is never offered "Close the day"');
    C.dom.window.close();

    console.log(`\n✅ Meridian trading reports passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* closed */ } }
    for (const s of fakes) { try { await closeServer(s); } catch { /* closed */ } }
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
