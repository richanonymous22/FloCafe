/*
 * Meridian licence screens (UI → HTTP → backend → DB → cloud).
 *
 * A till that must be activated shows why it cannot trade and takes the owner\'s activation code; once activated it
 * shows its licence; a suspended account pauses sales with a clear message, records stay viewable, and
 * reactivating opens sales again.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-lic-'));
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


const { generateKeyPairSync } = require('node:crypto');
const nodeHttp = require('node:http');
const request = require('supertest');
const lkey = generateKeyPairSync('ed25519');
fs.writeFileSync(path.join(testDir, 'license-policy.json'), JSON.stringify({ requireActivation: true, publicKeys: { k1: lkey.publicKey.export({ type: 'spki', format: 'pem' }) } }));
process.env.PLEMMO_LICENSE_POLICY_FILE = path.join(testDir, 'license-policy.json');
process.env.PLEMMO_LICENSE_SIGNING_KEY = lkey.privateKey.export({ type: 'pkcs8', format: 'pem' });
process.env.PLEMMO_CLOUD_ADMIN_TOKEN = 'op-token-meridian-licence';
process.env.PLEMMO_SYNC_ENV = 'development';
process.env.PLEMMO_SYNC_INTERVAL_MS = '300';
const { SqliteCloudStore } = require('../cloud/store');
const { createCloudServer } = require('../cloud/server');
import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase, listBackups } from '../main/db';
import { stopSyncService } from '../main/services/sync-service';
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
  console.log('Testing Meridian licence screens (UI → HTTP → backend → DB)...');
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
  let cloudServerRef: any = null;
  const stock = () => require('../main/core/inventory').getBalance('p-bagel') as number;

  try {
    const setting = (k: string, v: string) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
    setting('country', 'GB'); setting('taxes_enabled', 'true'); setting('business_type', 'retail');
    db.prepare(`UPDATE products SET tax_category_id = 'standard', tax_behavior = 'country_default' WHERE id IN ('p-bagel','p-tea')`).run();
    const O = await boot('u-own');
    await O.win.eval('PlemmoCatalogue.load(S)');
    const text = () => { const ms = Array.from(O.doc.querySelectorAll('.modal')); return (ms.length ? (ms[ms.length - 1] as any).textContent : '') || ''; };

    const cloudServer: any = await new Promise((r) => { const s = nodeHttp.createServer(createCloudServer(new SqliteCloudStore())).listen(0, '127.0.0.1', () => r(s)); });
    cloudServerRef = cloudServer;
    const cloudUrl = `http://127.0.0.1:${cloudServer.address().port}`;
    process.env.PLEMMO_CLOUD_PUBLIC_URL = cloudUrl;
    const op = { Authorization: `Bearer ${process.env.PLEMMO_CLOUD_ADMIN_TOKEN}` };
    const cloud = (m: 'get' | 'post' | 'put', p: string, b?: any) => { const r = (request(cloudServer) as any)[m](p).set(op); return b === undefined ? r : r.send(b); };

    const view = () => (O.doc.getElementById('view').textContent || '').replace(/\s+/g, ' ');
    const gate = () => O.doc.getElementById('licence-gate') as any;
    const gateText = () => (gate() && !gate().hidden ? (gate().textContent || '').replace(/\s+/g, ' ') : '');

    console.log('\n1. an unactivated till says so and asks for the code');
    await waitFor(() => /Activate this till/.test(gateText()), 8000, 'activation gate');
    ok(/has not been activated/.test(gateText()) && !!O.doc.getElementById('licCode'), 'the owner is asked for an activation code (no sales until then)');
    ok(/View records only/.test(gateText()), 'and can still choose to view records');

    console.log('\n2. activating with the code');
    await cloud('put', '/admin/v1/plans/retail', { name: 'Retail', features: ['core.pos', 'retail.catalog'], device_limit: 2, location_limit: 1, grace_days: 7, term_days: 365 });
    const merchant = (await cloud('post', '/admin/v1/merchants', { name: 'Corner Shop', plan_id: 'retail' })).body.merchant;
    const code = (await cloud('post', `/admin/v1/merchants/${merchant.merchant_code}/activation-tokens`, {})).body.activation_code;
    (O.doc.getElementById('licCode') as any).value = 'nonsense';
    O.click('licActivate');
    await waitFor(() => /does not look like an activation code/.test(gateText()), 6000, 'bad code message');
    ok(/does not look like an activation code/.test((O.doc.getElementById('licErr') as any).textContent), 'a wrong code is refused with a plain message, and the gate stays');
    (O.doc.getElementById('licCode') as any).value = code;
    O.click('licActivate');
    await waitFor(() => gateText() === '', 10000, 'gate to close');
    ok(gateText() === '', 'activation succeeded: the gate closes');
    O.win.eval("go('settings'); U.set.tab='licence'; renderView(); licenceCheck()");
    await waitFor(() => /Plan: retail/.test(view()), 8000, 'licence tab');
    ok(/Trading.*Sales are open/.test(view()) && /Includes core\.pos, retail\.catalog/.test(view()) && /Connected to 127\.0\.0\.1/.test(view()), 'Settings → Licence shows the plan, its features and the cloud account');
    const order = await O.win.PlemmoOrders.createOrder({ type: 'takeaway', items: [{ pid: 'p-bagel', qty: 1, mods: [] }] }, O.M().S._plemmoAddons);
    ok(!!order.id, 'the till can sell');

    console.log('\n3. a suspended account pauses sales');
    await cloud('post', `/admin/v1/merchants/${merchant.merchant_code}/suspend`, { reason: 'test' });
    O.click('licRefresh');
    await waitFor(() => /Sales are paused/.test(gateText()), 8000, 'paused screen');
    ok(/suspended/.test(gateText()), 'the screen says the account is suspended');
    O.click('licDismiss');
    await waitFor(() => gateText() === '', 3000, 'dismissed');
    ok(gateText() === '', '"View records only" lets staff look at records');
    let refused: any = null;
    try { await O.win.PlemmoOrders.createOrder({ type: 'takeaway', items: [{ pid: 'p-bagel', qty: 1, mods: [] }] }, O.M().S._plemmoAddons); } catch (e) { refused = e; }
    ok(!!refused && refused.status === 402 && /suspended/.test(refused.data.error), 'a sale attempt is refused by the server with the reason');
    await waitFor(() => /Sales are paused/.test(gateText()), 6000, 'gate re-opens on a refused sale');
    ok(/Sales are paused/.test(gateText()), 'and the paused screen comes back by itself');

    console.log('\n4. reactivating opens sales again');
    await cloud('post', `/admin/v1/merchants/${merchant.merchant_code}/reactivate`);
    O.click('licRefresh');
    await waitFor(() => gateText() === '', 8000, 'gate closed');
    const again = await O.win.PlemmoOrders.createOrder({ type: 'takeaway', items: [{ pid: 'p-bagel', qty: 1, mods: [] }] }, O.M().S._plemmoAddons);
    ok(gateText() === '' && !!again.id, 'sales resume');
    O.dom.window.close();

    console.log(`\n✅ Meridian licence screens passed (${checks} checks)`);
  } finally {
    try { cloudServerRef?.close(); } catch { /* closed */ }
    for (const d of doms) { try { d.window.close(); } catch { /* closed */ } }
    for (const s of fakes) { try { await closeServer(s); } catch { /* closed */ } }
    await stopSyncService();
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
