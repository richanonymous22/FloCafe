/*
 * Meridian variants at the till (UI → HTTP → backend → DB).
 *
 * A product with sizes is sold as one of them: the cashier picks (or scans) an option, each has its own
 * price and stock, and the order, bill and ledger carry the chosen variant.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-var-'));
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
  console.log('Testing Meridian variants (UI → HTTP → backend → DB)...');
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

    db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, barcode, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
                VALUES ('p-shirt','cat','Shirt',15,5,'SH',NULL,1,3,1,0,0,?,?)`).run(now(), now());
    const addVariant = (id: string, name: string, price: number, barcode: string) =>
      db.prepare(`INSERT INTO product_variants (id, product_id, name, sku, barcode, price, cost, is_default, is_active, sort_order, created_at, updated_at) VALUES (?, 'p-shirt', ?, ?, ?, ?, 5, 0, 1, 1, ?, ?)`).run(id, name, 'SH-' + name[0], barcode, price, now(), now());
    addVariant('v-s', 'Small', 15, 'SHS'); addVariant('v-m', 'Medium', 17, 'SHM');
    const { adjustStock, getBalance } = require('../main/core/inventory');
    adjustStock({ productId: 'p-shirt', variantId: 'v-s', quantityDelta: 2, reason: 'Opening', movementType: 'receipt' });
    adjustStock({ productId: 'p-shirt', variantId: 'v-m', quantityDelta: 5, reason: 'Opening', movementType: 'receipt' });
    await O.win.eval('PlemmoCatalogue.load(S)');
    const shirt = O.M().S.products.find((p: any) => p.id === 'p-shirt');
    const view = () => (O.doc.getElementById('view').textContent || '').replace(/\s+/g, ' ');
    const modalText = () => { const ms = Array.from(O.doc.querySelectorAll('.modal')); return (ms.length ? (ms[ms.length - 1] as any).textContent : '') || ''; };

    console.log('\n1. the catalogue carries the options');
    ok(shirt.variants.length === 2 && shirt.variants.find((v: any) => v.id === 'v-m').price === 17 && shirt.variants.find((v: any) => v.id === 'v-s').stock === 2, 'the till knows the Shirt has Small (£15, 2 left) and Medium (£17, 5 left)');
    O.win.eval("go('pos')");
    await waitFor(() => !!O.doc.querySelector('.tile[data-id="p-shirt"]'), 6000, 'tile');
    ok(/from £15\.00/.test((O.doc.querySelector('.tile[data-id="p-shirt"]') as any).textContent), 'the tile says "from £15.00"');

    console.log('\n2. picking an option');
    O.click('add', { id: 'p-shirt' });
    await waitFor(() => /Choose an option/.test(modalText()), 4000, 'picker');
    ok(/Small/.test(modalText()) && /Medium/.test(modalText()) && /£17\.00/.test(modalText()) && /2 left/.test(modalText()), 'the picker lists each option with its price and stock');
    (O.doc.querySelector('.modal [data-vid="v-m"]') as any).click();
    await waitFor(() => O.M().U.cart.items.length === 1, 4000, 'line added');
    const line = O.M().U.cart.items[0];
    ok(line.vid === 'v-m' && line.price === 17 && /Shirt \(Medium\)/.test(line.name), 'the cart line is Shirt (Medium) at £17.00');

    console.log('\n3. scanning an option');
    await O.win.eval("handleScan('SHS')");
    ok(O.M().U.cart.items.length === 2 && O.M().U.cart.items[1].vid === 'v-s', 'scanning the Small barcode adds Shirt (Small) directly');
    await O.win.eval("handleScan('SHS')");
    await O.win.eval("handleScan('SHS')");
    ok(O.M().U.cart.items[1].qty === 2, 'a third Small is refused: only 2 in stock');

    console.log('\n4. the sale carries the variants');
    const order = await O.win.eval('PlemmoOrders.createOrder(U.cart, S._plemmoAddons)');
    const items = db.prepare(`SELECT product_variant_id v, product_name n, unit_price p, quantity q FROM order_items WHERE order_id = ? ORDER BY id`).all(order.id) as any[];
    ok(items.length === 2 && items[0].v === 'v-m' && items[0].n === 'Shirt — Medium' && items[0].p === 17 && items[1].v === 'v-s' && items[1].q === 2 && items[1].p === 15, 'order lines name the variant, with its own price (Medium £17.00; Small £15.00 × 2)');
    const gen = await O.win.PlemmoAPI.post('/bills/generate', { order_id: order.id }, { idempotent: true });
    await O.win.PlemmoPayments.paySplit(gen.bill.id, [{ method: 'cash', amount: Number(gen.bill.total) }]);
    ok(Number(gen.bill.total) === 47, 'the bill is £47.00 (17 + 2 × 15)');
    ok(getBalance('p-shirt', 'v-m') === 4 && getBalance('p-shirt', 'v-s') === 0, 'each variant\'s own stock went down (Medium 5 → 4, Small 2 → 0)');
    await O.win.eval('PlemmoCatalogue.load(S)');
    O.win.eval("U.cart={items:[],type:'takeaway'};renderView()");
    O.click('add', { id: 'p-shirt' });
    await waitFor(() => /Choose an option/.test(modalText()), 4000, 'picker 2');
    const lastModal = Array.from(O.doc.querySelectorAll('.modal')).pop() as any;
    ok(lastModal.querySelector('[data-vid="v-s"]').disabled === true && /out of stock/.test(modalText()), 'Small now shows out of stock and cannot be picked');
    O.win.eval("closeAll()");

    console.log('\n5. setting up options on the Items screen');
    O.win.eval("go('items')");
    await waitFor(() => /Items & stock/.test(view()), 6000, 'Items');
    ok(/across 2 options/.test(view()), 'the Shirt row shows its stock across its 2 options, not a meaningless item figure');
    O.click('varEdit', { id: 'p-bagel' });
    await waitFor(() => !!O.doc.getElementById('vadd'), 6000, 'options editor');
    const nv = () => O.doc.getElementById('vnew') as any;
    const lastEditor = () => Array.from(O.doc.querySelectorAll('.modal')).pop() as any;
    const set = (cls: string, v: string) => { (lastEditor().querySelector('#vnew .' + cls) as any).value = v; };
    set('vn', 'Large'); set('vp', '5'); set('vs', 'BGL-L'); set('vb', 'BGLL'); set('vq', '3');
    (lastEditor().querySelector('#vadd') as any).click();
    await waitFor(() => !!db.prepare(`SELECT 1 FROM product_variants WHERE name = 'Large'`).get(), 6000, 'variant created');
    const lv = db.prepare(`SELECT * FROM product_variants WHERE name = 'Large'`).get() as any;
    ok(lv.price === 5 && lv.barcode === 'BGLL' && lv.product_id === 'p-bagel', 'the new option is saved on the server with its price and barcode');
    ok(getBalance('p-bagel', lv.id) === 3, 'its opening stock (3) went through the stock ledger');
    ok(O.M().S.products.find((p: any) => p.id === 'p-bagel').variants.length === 1, 'the till picked the new option up without a restart');
    O.dom.window.close();

    console.log(`\n✅ Meridian variants passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* closed */ } }
    for (const s of fakes) { try { await closeServer(s); } catch { /* closed */ } }
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
