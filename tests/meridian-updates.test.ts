/*
 * Meridian Settings → Updates (UI → HTTP → backend → DB).
 *
 * The owner sees what is ready, what blocks installing it (an open sale), chooses how updates happen, and
 * installs with a verified backup; the history shows the install.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-upd-'));
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
import * as um from '../main/services/update-manager';
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
  console.log('Testing Meridian updates screen (UI → HTTP → backend → DB)...');
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
    let installs = 0;
    um.detachUpdater(); um.attachUpdater({ checkForUpdates: async () => { um.noteUpdaterEvent('not-available'); }, quitAndInstall: () => { installs++; } }, '3.1.0');
    um.noteUpdaterEvent('downloaded', { version: '3.2.0' });
    const view = () => (O.doc.getElementById('view').textContent || '').replace(/\s+/g, ' ');
    const { createSale } = require('../main/core/sale');
    db.prepare(`INSERT INTO settings (key, value) VALUES ('update_mode','ask') ON CONFLICT(key) DO UPDATE SET value='ask'`).run();

    console.log('\n1. the owner sees what is ready');
    O.win.eval("go('settings'); A.setTab({t:'updates'})");
    await waitFor(() => /Version 3\.2\.0 is ready to install/.test(view()), 8000, 'updates tab');
    ok(/This till is running 3\.1\.0/.test(view()), 'the screen shows the running version and the one that is ready');
    ok(!!O.doc.querySelector('[data-act="updInstall"]') && !(O.doc.querySelector('[data-act="updInstall"]') as any).disabled, 'with nothing happening, "Install now" is available');

    console.log('\n2. an open sale blocks it, and the screen says why');
    createSale({ channel: 'takeaway', lines: [{ product_id: 'p-bagel', quantity: 1 }], cashierUserId: 'u-own' });
    O.click('updCheck');
    await waitFor(() => /Not right now: 1 order was opened or changed in the last ten minutes/.test(view()), 6000, 'blocked message');
    ok((O.doc.querySelector('[data-act="updInstall"]') as any).disabled === true, '"Install now" is switched off while a sale is open');
    db.prepare("UPDATE orders SET status = 'completed'").run();

    console.log('\n3. choosing how updates happen');
    const sel = () => O.doc.querySelector('select[data-ch="updMode"]') as any;
    sel().value = 'quiet_hours'; sel().dispatchEvent(new O.win.Event('change', { bubbles: true }));
    await waitFor(() => /Quiet window/.test(view()), 6000, 'quiet window');
    ok(um.getUpdateSettings().mode === 'quiet_hours' && /only when nothing is open/.test(view()), 'quiet hours is saved on the server and explained');
    const start = O.doc.querySelector('select[data-k="window_start_hour"]') as any;
    start.value = '1'; start.dispatchEvent(new O.win.Event('change', { bubbles: true }));
    await waitFor(() => um.getUpdateSettings().window_start_hour === 1, 6000, 'hour saved');
    ok(um.getUpdateSettings().window_start_hour === 1, 'the quiet window can be moved');
    sel().value = 'ask'; sel().dispatchEvent(new O.win.Event('change', { bubbles: true }));
    await waitFor(() => !/Quiet window/.test(view()), 6000, 'back to ask');
    const later = O.doc.querySelector('select[data-ch="updDefer"]') as any;
    later.value = '240'; later.dispatchEvent(new O.win.Event('change', { bubbles: true }));
    await waitFor(() => /Reminder paused/.test(view()), 6000, 'deferred');
    ok(!!um.getUpdateSettings().deferred_until, '"remind me later" is saved and shown');

    console.log('\n4. installing');
    O.click('updInstall');
    await waitFor(() => !!O.doc.getElementById('cfOk'), 4000, 'confirm');
    O.clickEl('#cfOk');
    await waitFor(() => installs === 1, 10000, 'install');
    ok(installs === 1, 'the restart was requested after the confirmation');
    await waitFor(() => /Installing/.test(view()), 6000, 'history row');
    const hist = um.getUpdateHistory()[0];
    ok(hist.status === 'installing' && hist.to === '3.2.0' && !!hist.backup && fs.existsSync(hist.backup), 'the history shows the install with its backup file on disk');
    O.dom.window.close();

    console.log(`\n✅ Meridian updates screen passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* closed */ } }
    for (const s of fakes) { try { await closeServer(s); } catch { /* closed */ } }
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
