/*
 * Meridian catalogue management — Items, Categories, Option groups (UI → HTTP → backend → DB).
 *
 * The register sells at the till server's prices and VAT, so editing an item must change
 * THE SERVER. Every save is checked against the database; a refusal is shown with the
 * server's own reason and leaves everything as it was; stock changes go through the ledger.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-admin-'));
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
  console.log('Testing Meridian catalogue management (UI → HTTP → backend → DB)...');
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
    db.prepare(`INSERT INTO settings (key, value) VALUES ('country','GB') ON CONFLICT(key) DO UPDATE SET value='GB'`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('taxes_enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('business_type','retail') ON CONFLICT(key) DO UPDATE SET value='retail'`).run();
    const O = await boot('u-own');
    const prodRow = (name: string) => db.prepare(`SELECT * FROM products WHERE name = ? AND deleted_at IS NULL`).get(name) as any;
    const setVal = (id: string, v: string) => { const el = O.doc.getElementById(id) as any; if (!el) throw new Error(`no field #${id}`); el.value = v; };
    const openItem = async (id?: string) => { await waitFor(() => !O.doc.querySelector('.modal'), 4000, 'dialogs closed'); O.clearToasts(); O.click('itEdit', id ? { id } : {}); await waitFor(() => !!O.doc.getElementById('itN'), 6000, 'item form'); };

    console.log('\n1. add an item: it lands on the server with barcode, VAT rate, cost and opening stock');
    await openItem();
    ok(!O.doc.querySelector('[data-act="itEmoji"]') && !O.doc.getElementById('itK'), 'no emoji picker or "show on kiosk" toggle: the server cannot store them, so they are not offered');
    ok(!!O.doc.getElementById('itBar') && !!O.doc.getElementById('itV'), 'the form has a Barcode field and a VAT rate selector');
    ok(Array.from((O.doc.getElementById('itV') as any).options).map((o: any) => o.value).join() === 'standard,reduced,zero,exempt', 'the VAT rates come from the UK pack: standard, reduced, zero, exempt');
    setVal('itN', 'Pen Set'); setVal('itSku', 'PEN-1'); setVal('itBar', '5012345000011'); setVal('itP', '10.50'); setVal('itCo', '4.20'); setVal('itV', 'reduced');
    (O.doc.getElementById('itT') as any).click();
    await waitFor(() => !(O.doc.getElementById('itStockF') as any).hidden, 2000, 'stock fields');
    setVal('itS', '6'); setVal('itL', '2');
    O.click('itSave');
    await waitFor(() => !!prodRow('Pen Set'), 8000, 'product row');
    const pen = prodRow('Pen Set');
    ok(pen.price === 10.5 && pen.cost === 4.2 && pen.barcode === '5012345000011' && pen.sku === 'PEN-1', 'price, cost, SKU and barcode are in the database');
    ok(pen.tax_category_id === 'reduced' && pen.track_inventory === 1 && pen.stock_quantity === 6 && pen.low_stock_threshold === 2, 'VAT rate, stock tracking, opening stock and low-stock level saved');
    await waitFor(() => !O.doc.querySelector('.modal'), 4000, 'form closed');
    await waitFor(() => !!O.M().S.products.find((p: any) => p.id === pen.id), 4000, 'in the register catalogue');
    ok(O.M().S.products.find((p: any) => p.id === pen.id).taxCat === 'reduced', 'Meridian reads the item back from the server (with its VAT rate)');

    console.log('\n2. the register really sells at that price and VAT');
    const order = await O.win.PlemmoOrders.createOrder({ type: 'takeaway', items: [{ pid: pen.id, qty: 1, mods: [] }] }, O.M().S._plemmoAddons);
    const orow = db.prepare(`SELECT total, tax_amount FROM orders WHERE id=?`).get(order.id) as any;
    ok(orow.total === 10.5 && orow.tax_amount === 0.5, 'a sale of the new item is 10.50 including 0.50 VAT (5%)');
    const lk = await O.win.PlemmoTill.lookupBarcode('5012345000011');
    ok(JSON.stringify(lk).includes('Pen Set'), 'scanning its barcode finds it');

    console.log('\n3. edit: price changes on the server, a different stock quantity is a ledger adjustment');
    // the earlier test sale took one unit, so the cached count (6) is a unit behind the ledger (5)
    ok(O.M().S.products.find((p: any) => p.id === pen.id).stock === 6, 'the register\'s cached stock is stale (6) after the sale');
    await openItem(pen.id);
    ok((O.doc.getElementById('itS') as any).value === '5', 'the form shows the LEDGER quantity (5), read from the server when it opened');
    const stockBefore = 5;
    setVal('itP', '12.00'); setVal('itS', String(stockBefore + 4));
    O.click('itSave');
    await waitFor(() => prodRow('Pen Set').price === 12, 8000, 'price updated');
    await waitFor(() => (db.prepare(`SELECT quantity FROM inventory_balances WHERE product_id=?`).get(pen.id) as any)?.quantity === stockBefore + 4, 8000, 'ledger balance');
    const adj = db.prepare(`SELECT movement_type, quantity_delta, reason FROM inventory_movements WHERE product_id=? ORDER BY rowid DESC LIMIT 1`).get(pen.id) as any;
    ok(adj.quantity_delta === 4 && /Edited on the item/.test(adj.reason), 'the extra 4 units are a stock movement with a reason, not a silent overwrite');
    ok(prodRow('Pen Set').barcode === '5012345000011', 'untouched fields (barcode) survive an edit');

    console.log('\n4. a refusal is shown with the server\'s reason and nothing is created');
    await waitFor(() => !O.doc.querySelector('.modal'), 4000, 'closed');
    await openItem();
    setVal('itN', 'Clash Item'); setVal('itBar', '5012345000011'); setVal('itP', '1.00');
    O.click('itSave');
    await waitFor(() => /already uses this barcode/i.test(O.toasts()), 6000, 'barcode refusal');
    ok(!prodRow('Clash Item'), 'no product row was created');
    ok(!!O.doc.getElementById('itN'), 'the form stays open so it can be corrected');
    O.click('closeTop');

    console.log('\n5. availability and delete');
    await waitFor(() => !O.doc.querySelector('.modal'), 4000, 'closed');
    O.M().U.view = 'items'; O.win.eval('renderView()');
    const sw = O.doc.querySelector(`[data-ch="itAvail"][data-id="${pen.id}"]`) as any;
    ok(!!sw, 'the Items list has an availability switch for the item');
    sw.checked = false; sw.dispatchEvent(new O.win.Event('change', { bubbles: true }));
    await waitFor(() => prodRow('Pen Set').is_active === 0, 6000, 'is_active 0');
    ok(O.M().S.products.find((p: any) => p.id === pen.id).available === false, 'and the register shows it as sold out');
    O.click('itDel', { id: pen.id });
    await waitFor(() => !!O.doc.getElementById('cfOk'), 4000, 'confirm');
    O.clickEl('#cfOk');
    await waitFor(() => !prodRow('Pen Set'), 6000, 'soft-deleted');
    ok(!!(db.prepare(`SELECT deleted_at FROM products WHERE id=?`).get(pen.id) as any).deleted_at, 'the product is soft-deleted (history keeps it)');
    await waitFor(() => !O.M().S.products.find((p: any) => p.id === pen.id), 4000, 'gone from the register');

    console.log('\n6. categories');
    await waitFor(() => !O.doc.querySelector('.modal'), 4000, 'closed');
    O.click('catEdit', {});
    await waitFor(() => !!O.doc.getElementById('cN'), 4000, 'category form');
    setVal('cN', 'Stationery');
    O.clickEl('#cGo');
    await waitFor(() => !!db.prepare(`SELECT id FROM categories WHERE name='Stationery' AND deleted_at IS NULL`).get(), 6000, 'category row');
    const cat = db.prepare(`SELECT * FROM categories WHERE name='Stationery'`).get() as any;
    ok(!!cat.color && !!cat.icon, 'the category colour and icon are stored on the server');
    await waitFor(() => !!O.M().S.categories.find((c: any) => c.id === cat.id), 4000, 'in the register');
    await waitFor(() => !O.doc.querySelector('.modal'), 4000, 'closed 2');
    O.click('catEdit', { id: cat.id });
    await waitFor(() => !!O.doc.getElementById('cN'), 4000, 'edit form');
    setVal('cN', 'Stationery & Gifts'); O.clickEl('#cGo');
    await waitFor(() => (db.prepare(`SELECT name FROM categories WHERE id=?`).get(cat.id) as any).name === 'Stationery & Gifts', 6000, 'renamed');
    await waitFor(() => !O.doc.querySelector('.modal'), 4000, 'closed 3');
    O.click('catEdit', { id: cat.id });
    await waitFor(() => !!O.doc.getElementById('cDel'), 4000, 'delete button');
    O.clickEl('#cDel');
    await waitFor(() => !db.prepare(`SELECT id FROM categories WHERE id=? AND deleted_at IS NULL`).get(cat.id), 6000, 'category deleted');

    console.log('\n7. option groups');
    await waitFor(() => !O.doc.querySelector('.modal'), 4000, 'closed 4');
    O.click('modEdit', {});
    await waitFor(() => !!O.doc.getElementById('mgN'), 4000, 'option form');
    setVal('mgN', 'Gift wrap');
    (O.doc.querySelector('.opt-row .on') as any).value = 'Plain';
    (O.doc.querySelector('.opt-row .op') as any).value = '1.50';
    (O.doc.getElementById('mgR') as any).checked = true;
    O.clickEl('#mgGo');
    await waitFor(() => !!db.prepare(`SELECT id FROM addon_groups WHERE name='Gift wrap'`).get(), 6000, 'group row');
    const grp = db.prepare(`SELECT * FROM addon_groups WHERE name='Gift wrap'`).get() as any;
    ok(grp.is_required === 1 && grp.min_selection === 1 && grp.max_selection === 1, '"customer must choose" is stored as min 1 / max 1');
    const adds = db.prepare(`SELECT name, price FROM addons WHERE addon_group_id=? AND is_active=1`).all(grp.id) as any[];
    ok(adds.length === 1 && adds[0].name === 'Plain' && adds[0].price === 1.5, 'the choice and its extra price are stored');
    await waitFor(() => !!O.M().S.modGroups.find((g: any) => g.id === grp.id), 4000, 'in the register');

    console.log('\n8. a cashier cannot change the catalogue — the server refuses, nothing changes');
    O.dom.window.close();
    const C = await boot('u-cash');
    const before = (db.prepare(`SELECT COUNT(*) n FROM products`).get() as any).n;
    C.M().U.view = 'items'; C.win.eval('renderView()');
    await waitFor(() => !C.doc.querySelector('.modal'), 3000, 'none').catch(() => {});
    C.win.eval("editItem()");
    await waitFor(() => !!C.doc.getElementById('itN'), 6000, 'cashier item form');
    (C.doc.getElementById('itN') as any).value = 'Cashier Item'; (C.doc.getElementById('itP') as any).value = '1';
    C.clearToasts(); C.click('itSave');
    await waitFor(() => /not saved/i.test(C.toasts()), 6000, 'refusal');
    ok(/permission/i.test(C.toasts()), 'the toast says the cashier does not have permission');
    ok((db.prepare(`SELECT COUNT(*) n FROM products`).get() as any).n === before, 'no product was created');
    C.dom.window.close();

    console.log(`\n✅ Meridian catalogue management passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* closed */ } }
    for (const s of fakes) { try { await closeServer(s); } catch { /* closed */ } }
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
