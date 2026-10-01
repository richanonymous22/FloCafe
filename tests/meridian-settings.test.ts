/*
 * Meridian settings — shared with every till vs this till only (UI → HTTP → backend → DB).
 *
 * Business details, VAT registration, tipping, kitchen display, loyalty cashback and receipt text
 * are the BUSINESS's: they are saved on the till server, only change on screen once the server
 * accepts them, and a second till that signs in later sees them. Screen lock, theme and kiosk
 * wording are this till's own and never touch the server.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-settings-'));
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
  console.log('Testing Meridian settings (UI → HTTP → backend → DB)...');
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
    db.prepare(`INSERT INTO settings (key, value) VALUES ('business_type','retail') ON CONFLICT(key) DO UPDATE SET value='retail'`).run();
    const dbs = (k: string) => (db.prepare(`SELECT value FROM settings WHERE key=?`).get(k) as any)?.value as string | undefined;
    const O = await boot('u-own');
    const goSettings = async (W: any, tab: string) => { W.M().U.view = 'settings'; W.M().U.set.tab = tab; W.win.eval('renderView()'); await waitFor(() => !!W.doc.querySelector('.set-sec'), 3000, 'settings ' + tab); };
    const field = (W: any, k: string) => W.doc.querySelector(`[data-k="${k}"]`) as any;
    const change = (el: any, v?: string) => { if (v !== undefined) el.value = v; el.dispatchEvent(new (el.ownerDocument.defaultView as any).Event('change', { bubbles: true })); };
    const toggle = (el: any) => { el.checked = !el.checked; change(el); };

    console.log('\n1. business details are saved on the server');
    await goSettings(O, 'business');
    ok(!field(O, 'openHour'), 'the "opens at / closes at" fields are not offered (the server has nowhere to keep them)');
    change(field(O, 'name'), 'Corner Shop Ltd');
    await waitFor(() => dbs('business_name') === 'Corner Shop Ltd', 6000, 'business_name');
    change(field(O, 'address'), '1 High Street, Leeds LS1 1AA');
    await waitFor(() => dbs('business_address') === '1 High Street, Leeds LS1 1AA', 6000, 'business_address');
    change(field(O, 'phone'), '0113 496 0000');
    await waitFor(() => dbs('business_phone') === '0113 496 0000', 6000, 'business_phone');
    change(field(O, 'vatNo'), 'GB123456789');
    await waitFor(() => dbs('tax_registration_number') === 'GB123456789', 6000, 'vat number');
    ok(O.M().S.settings.name === 'Corner Shop Ltd', 'the screen shows the new name only after the server accepted it');

    console.log('\n2. VAT registration switches the UK tax pack on; a sale then carries VAT');
    await goSettings(O, 'tax');
    ok(/set when the business was set up/.test(O.doc.querySelector('.set-sec').textContent || ''), 'currency is shown read-only (changing it would re-price history)');
    ok(!field(O, 'taxRate'), 'the made-up flat "Rate (%)" box is gone (VAT comes from each item\'s rate)');
    ok(dbs('taxes_enabled') !== 'true', 'VAT is off to begin with');
    toggle(field(O, 'vatRegistered'));
    await waitFor(() => dbs('taxes_enabled') === 'true' && dbs('tax_registered') === 'true', 8000, 'vat on');
    ok(O.M().S.settings.vatRegistered === true, 'the screen shows VAT registered');
    ok(!!(db.prepare(`SELECT 1 FROM country_packs WHERE id='meridian-gb-vat' AND status='active'`).get()), 'the bundled UK pack is active (no download needed)');
    const cat = db.prepare(`SELECT id FROM categories LIMIT 1`).get() as any;
    db.prepare(`INSERT INTO products (id, category_id, name, price, sku, is_active, track_inventory, stock_quantity, tax_category_id, tax_behavior, created_at, updated_at) VALUES ('p-vat','${cat.id}','Standard Thing',12,'SV',1,0,0,'standard','country_default',?,?)`).run(now(), now());
    await O.win.eval('PlemmoCatalogue.load(S)');
    const ord = await O.win.PlemmoOrders.createOrder({ type: 'takeaway', items: [{ pid: 'p-vat', qty: 1, mods: [] }] }, O.M().S._plemmoAddons);
    ok((db.prepare(`SELECT tax_amount FROM orders WHERE id=?`).get(ord.id) as any).tax_amount === 2, 'a 12.00 sale now includes 2.00 VAT');
    O.clearToasts();
    O.click('add', { id: 'p-vat' });
    ok(O.win.eval('cartTotals().tax') === 2, 'the cart preview agrees: 2.00 VAT on 12.00');
    toggle(field(O, 'vatRegistered'));
    await waitFor(() => dbs('taxes_enabled') === 'false', 8000, 'vat off');
    ok(O.win.eval('cartTotals().tax') === 0, 'and with VAT off the preview shows none');
    const ord2 = await O.win.PlemmoOrders.createOrder({ type: 'takeaway', items: [{ pid: 'p-vat', qty: 1, mods: [] }] }, O.M().S._plemmoAddons);
    ok((db.prepare(`SELECT tax_amount FROM orders WHERE id=?`).get(ord2.id) as any).tax_amount === 0, 'a sale with VAT off carries no VAT');
    O.win.eval('U.cart=newCart()');

    console.log('\n3. features, receipt text and loyalty are shared');
    await goSettings(O, 'features');
    toggle(field(O, 'tipping'));
    await waitFor(() => dbs('tipping_enabled') === 'true', 6000, 'tipping');
    toggle(field(O, 'kitchen'));
    await waitFor(() => dbs('kds_enabled') === 'false', 6000, 'kds off');
    change(field(O, 'defaultFloat'), '75');
    await waitFor(() => dbs('default_cash_float') === '75', 6000, 'float');
    await goSettings(O, 'tax');
    change(field(O, 'receiptFooter'), 'Thanks for shopping local');
    await waitFor(() => dbs('bill_footer_message') === 'Thanks for shopping local', 6000, 'footer');
    await goSettings(O, 'loyalty');
    ok(!field(O, 'loyalty.earn') && !field(O, 'loyalty.redeemVal'), 'the made-up "points per £ / reward value" controls are gone');
    const loyaltyWas = dbs('loyalty_enabled') === 'true';
    toggle(field(O, 'loyalty.on'));
    await waitFor(() => (dbs('loyalty_enabled') === 'true') === !loyaltyWas, 6000, 'loyalty flipped');
    const loyaltyNow = !loyaltyWas;
    change(field(O, 'loyalty.cashback'), '5');
    await waitFor(() => dbs('global_cashback_percent') === '5', 6000, 'cashback');

    console.log('\n4. this-till-only settings never touch the server');
    await goSettings(O, 'features');
    const beforeKeys = (db.prepare(`SELECT COUNT(*) n FROM settings`).get() as any).n;
    const kioskBefore = O.M().S.settings.kioskEnabled;
    change(field(O, 'autoLock'), '30');
    toggle(field(O, 'kioskEnabled'));
    await sleep(500);
    ok(O.M().S.settings.autoLock === 30 && O.M().S.settings.kioskEnabled === !kioskBefore, 'saved on this till');
    ok((db.prepare(`SELECT COUNT(*) n FROM settings`).get() as any).n === beforeKeys && dbs('autoLock') === undefined && dbs('kioskEnabled') === undefined, 'nothing was written to the server');
    ok(/this till only/i.test(O.doc.querySelector('.set-sec').textContent || ''), 'the screen says those are "this till only"');

    console.log('\n5. a second till sees the shared settings (server truth), not this till\'s local copy');
    const O2 = await boot('u-own');
    const st = O2.M().S.settings;
    ok(st.name === 'Corner Shop Ltd' && st.address === '1 High Street, Leeds LS1 1AA' && st.vatNo === 'GB123456789', 'business name, address and VAT number');
    ok(st.tipping === true && st.kitchen === false && st.defaultFloat === 75 && st.receiptFooter === 'Thanks for shopping local', 'tipping, kitchen display, float and receipt text');
    ok(st.loyalty.on === loyaltyNow && st.loyalty.cashback === 5 && st.vatRegistered === false, 'loyalty cashback and VAT registration');
    ok(st.autoLock !== 30, 'the first till\'s "this till only" lock timer did not travel');
    O2.dom.window.close();

    console.log('\n6. a refused change reverts the control and says why');
    O.dom.window.close();
    const C = await boot('u-cash');
    await goSettings(C, 'features');
    const tip = field(C, 'tipping');
    const wasOn = dbs('tipping_enabled');
    C.clearToasts();
    toggle(tip);
    await waitFor(() => /Not saved/.test(C.toasts()), 6000, 'refusal toast');
    ok(/permission/i.test(C.toasts()), 'a cashier is told they do not have permission');
    ok(dbs('tipping_enabled') === wasOn && field(C, 'tipping').checked === (wasOn === 'true'), 'the server value and the switch are unchanged');
    C.dom.window.close();

    console.log(`\n✅ Meridian settings passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* closed */ } }
    for (const s of fakes) { try { await closeServer(s); } catch { /* closed */ } }
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
