/*
 * Meridian suppliers and purchase orders (UI → HTTP → backend → DB).
 *
 * A supplier is created, a purchase order is built, ordered and received; receiving adds the goods to the
 * stock ledger and marks the order received.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-po-'));
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
  console.log('Testing Meridian purchasing (UI → HTTP → backend → DB)...');
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
  const stock = () => require('../main/core/inventory').getBalance('p-bagel') as number;

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

    console.log('\n1. suppliers');
    await tab('sup');
    await waitFor(() => /No suppliers yet/.test(view()), 6000, 'empty suppliers');
    O.click('supEdit');
    await waitFor(() => !!O.doc.getElementById('spSave'), 4000, 'supplier form');
    (O.doc.getElementById('spName') as any).value = 'Acme Wholesale';
    (O.doc.getElementById('spPhone') as any).value = '01234 567890';
    O.clickEl('#spSave');
    await waitFor(() => /Acme Wholesale/.test(view()), 6000, 'supplier listed');
    const sup = db.prepare(`SELECT * FROM suppliers`).get() as any;
    ok(sup && sup.name === 'Acme Wholesale' && sup.phone === '01234 567890', 'the supplier is saved on the server');

    console.log('\n2. build a purchase order');
    await tab('po');
    await waitFor(() => /No purchase orders yet/.test(view()), 6000, 'empty POs');
    O.click('poNew');
    await waitFor(() => !!O.doc.getElementById('poGo'), 4000, 'PO form');
    (O.doc.getElementById('poRef') as any).value = 'PO-1001';
    O.clickEl('#poGo');
    await waitFor(() => /PO-1001/.test(view()) && /Draft/.test(view()), 6000, 'PO detail');
    ok((db.prepare(`SELECT status FROM purchase_orders`).get() as any).status === 'draft', 'a draft purchase order exists on the server');
    O.click('poAddItem');
    await waitFor(() => !!O.doc.getElementById('piGo'), 4000, 'item form');
    (O.doc.getElementById('piQ') as any).value = '5';
    (O.doc.getElementById('piC') as any).value = '1.5';
    O.clickEl('#piGo');
    await waitFor(() => /Bagel/.test(view()) && /£7\.50/.test(view()), 6000, 'item added');
    const po = db.prepare(`SELECT * FROM purchase_orders`).get() as any;
    ok(po.total === 7.5, 'the order total is £7.50 (5 × £1.50)');
    ok(/Mark as ordered/.test(view()) && !/Receive goods/.test(view()), 'a draft offers "Mark as ordered", not receiving');

    console.log('\n3. order and receive');
    O.click('poOrder');
    await waitFor(() => !!O.doc.getElementById('cfOk'), 4000, 'confirm');
    O.clickEl('#cfOk');
    await waitFor(() => /Receive goods/.test(view()), 6000, 'ordered');
    ok((db.prepare(`SELECT status FROM purchase_orders`).get() as any).status === 'ordered', 'the order is marked ordered');
    ok(stock() === 10, 'ordering changes no stock');
    O.click('poReceive');
    await waitFor(() => !!O.doc.getElementById('rcGo'), 4000, 'receive form');
    (O.doc.querySelector('[data-q]') as any).value = '3';
    O.clickEl('#rcGo');
    await waitFor(() => /Part received/.test(view()), 8000, 'part received');
    ok(stock() === 13, 'receiving 3 of 5 adds 3 to the stock ledger (10 → 13)');
    ok((db.prepare(`SELECT status FROM purchase_orders`).get() as any).status === 'partially_received', 'the order is part received');
    O.click('poReceive');
    await waitFor(() => !!O.doc.getElementById('rcGo'), 4000, 'receive form 2');
    await sleep(300);
    const qs = O.doc.querySelectorAll('[data-q]');
    ok(qs.length === 1 && (qs[0] as any).value === '2', 'the form offers the 2 still outstanding');
    O.clickEl('#rcGo');
    await waitFor(() => /Received/.test(view()) && !/Receive goods/.test(view()), 8000, 'received');
    ok(stock() === 15, 'receiving the rest brings stock to 15');
    ok((db.prepare(`SELECT status FROM purchase_orders`).get() as any).status === 'received', 'the order is received');
    ok((db.prepare(`SELECT COUNT(*) n FROM inventory_movements WHERE movement_type='receipt' AND reference_type='purchase_order_item'`).get() as any).n === 2, 'two receipt movements are in the ledger');
    O.dom.window.close();

    console.log(`\n✅ Meridian purchasing passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* closed */ } }
    for (const s of fakes) { try { await closeServer(s); } catch { /* closed */ } }
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
