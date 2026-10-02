/*
 * Meridian team — stocktake, stock value, stock import and the live stock history (UI → HTTP → backend → DB).
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
  console.log('Testing Meridian team (UI → HTTP → backend → DB)...');
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
    const O = await boot('u-own');
    const view = () => (O.doc.getElementById('view').textContent || '').replace(/\s+/g, ' ');
    const fill = (D: any, id: string, v: string) => { const el = D.doc.getElementById(id); if (!el) throw new Error('no field ' + id); el.value = v; el.dispatchEvent(new D.win.Event('input', { bubbles: true })); el.dispatchEvent(new D.win.Event('change', { bubbles: true })); };
    O.win.eval("go('team')");
    await waitFor(() => /Add a team member/.test(view()), 6000, 'team screen');

    console.log('\n1. the owner adds a supervisor');
    O.click('tmEdit', {});
    await waitFor(() => !!O.doc.getElementById('tGo'), 4000, 'editor');
    const roleOpts = Array.from((O.doc.getElementById('tR') as any).options).map((o: any) => o.value);
    ok(['manager', 'supervisor', 'cashier', 'waiter', 'chef'].every((r) => roleOpts.includes(r)), 'the owner is offered manager, supervisor, cashier, waiter and chef');
    ok(!O.doc.getElementById('eRate') && !O.doc.getElementById('eP'), 'no job title or hourly rate (the server does not store them)');
    fill(O, 'tN', 'Sam Supervisor'); fill(O, 'tE', 'sam@till.local'); fill(O, 'tP', 'Passw0rd!x'); (O.doc.getElementById('tR') as any).value = 'supervisor'; (O.doc.getElementById('tR') as any).dispatchEvent(new O.win.Event('change'));
    ok(!(O.doc.getElementById('tPinF') as any).hidden, 'a supervisor gets a PIN field');
    fill(O, 'tPin', '5555');
    O.clickEl('#tGo');
    await waitFor(() => !!db.prepare("SELECT 1 FROM users WHERE email = 'sam@till.local'").get(), 6000, 'account created');
    const sam = db.prepare("SELECT role, is_supervisor, pin_hash FROM users WHERE email = 'sam@till.local'").get() as any;
    ok(sam.role === 'cashier' && sam.is_supervisor === 1 && !!sam.pin_hash, 'the SERVER has the account: role cashier, supervisor, with a PIN');
    await waitFor(() => /Sam Supervisor/.test(view()), 4000, 'team refreshed');
    ok(/Supervisor/.test(view()), 'the team screen shows them as a Supervisor');
    const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'sam@till.local', password: 'Passw0rd!x' }) });
    ok(login.status === 200 && (await login.json()).user.supervisor === true, 'they can really sign in, and the till knows they are a supervisor');

    console.log('\n2. the server\'s refusals are shown, nothing is faked');
    await waitFor(() => O.doc.querySelectorAll('.modal').length === 0, 4000, 'editor closed');
    O.click('tmEdit', {}); await waitFor(() => !!O.doc.getElementById('tGo'), 4000, 'editor 2');
    fill(O, 'tN', 'Weak Pass'); fill(O, 'tE', 'weak@till.local'); fill(O, 'tP', 'password');
    O.clearToasts(); O.clickEl('#tGo');
    await waitFor(() => /Password must be/.test(O.toasts()), 5000, 'weak password refused');
    ok(!db.prepare("SELECT 1 FROM users WHERE email = 'weak@till.local'").get() && !!O.doc.getElementById('tGo'), 'a weak password is refused by the server, nothing is created, and the form stays open to fix');
    fill(O, 'tP', 'Passw0rd!x'); fill(O, 'tE', 'sam@till.local'); O.clearToasts(); O.clickEl('#tGo');
    await waitFor(() => /already in use/i.test(O.toasts()), 5000, 'duplicate email refused');
    ok(true, 'a duplicate email is refused with the server\'s reason');
    O.click('closeTop');

    console.log('\n3. editing and switching someone off');
    await waitFor(() => O.doc.querySelectorAll('.modal').length === 0, 4000, 'closed');
    const samId = (db.prepare("SELECT id FROM users WHERE email = 'sam@till.local'").get() as any).id;
    O.click('tmEdit', { id: samId }); await waitFor(() => !!O.doc.getElementById('tGo'), 4000, 'edit editor');
    ok((O.doc.getElementById('tR') as any).value === 'supervisor', 'the editor shows the current role: supervisor');
    (O.doc.getElementById('tR') as any).value = 'cashier'; (O.doc.getElementById('tR') as any).dispatchEvent(new O.win.Event('change'));
    O.clickEl('#tGo');
    await waitFor(() => (db.prepare("SELECT is_supervisor FROM users WHERE id = ?").get(samId) as any).is_supervisor === 0, 6000, 'demoted');
    ok((db.prepare("SELECT pin_hash FROM users WHERE id = ?").get(samId) as any).pin_hash === null, 'removing the supervisor role also removes their PIN on the server');
    await waitFor(() => O.doc.querySelectorAll('.modal').length === 0, 4000, 'closed 2');
    O.click('tmEdit', { id: samId }); await waitFor(() => !!O.doc.getElementById('tA'), 4000, 'active toggle');
    const act = O.doc.getElementById('tA') as any; act.checked = false; act.dispatchEvent(new O.win.Event('change', { bubbles: true }));
    O.clickEl('#tGo');
    await waitFor(() => (db.prepare("SELECT is_active FROM users WHERE id = ?").get(samId) as any).is_active === 0, 6000, 'deactivated');
    ok(true, 'switching "Active" off deactivates the account on the server');

    console.log('\n4. a manager has fewer choices');
    const M = await boot('u-mgr');
    M.win.eval("go('team')"); await waitFor(() => /Add a team member/.test((M.doc.getElementById('view').textContent || '')), 6000, 'manager team');
    M.click('tmEdit', {}); await waitFor(() => !!M.doc.getElementById('tGo'), 4000, 'manager editor');
    const mOpts = Array.from((M.doc.getElementById('tR') as any).options).map((o: any) => o.value);
    ok(!mOpts.includes('manager') && !mOpts.includes('supervisor') && mOpts.includes('cashier'), 'a manager can add cashiers, waiters and chefs, not managers or supervisors');
    M.click('closeTop'); await waitFor(() => M.doc.querySelectorAll('.modal').length === 0, 4000, 'closed 3');
    M.clearToasts(); M.click('tmEdit', { id: 'u-own' });
    await waitFor(() => /Only an owner/.test(M.toasts()), 3000, 'refusal');
    ok(true, 'a manager cannot open an owner\'s account');

    console.log(`\n✅ Meridian team passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* ignore */ } }
    for (const f of fakes) await closeServer(f);
    await stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
