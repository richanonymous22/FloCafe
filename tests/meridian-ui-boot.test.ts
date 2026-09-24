/*
 * Meridian UI wiring — real browser-env verification (jsdom).
 *
 * Boots the actual built Meridian bundle in a DOM against a running Plemmo
 * server and drives the REAL login gate: fills the form, submits, and asserts a
 * real JWT session is established, the gate is dismissed, and session context is
 * loaded from Plemmo. Then exercises the browser-side AI client end to end.
 *
 * This proves the vendored frontend boots in a browser environment and that its
 * Plemmo auth + API wiring works through the actual DOM, not just via supertest.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-ui-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 5000, label = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (fn()) return; } catch { /* keep polling */ } await sleep(50); }
  throw new Error(`Timed out waiting for ${label}`);
}

async function run() {
  console.log('Testing Meridian UI boot + login gate (jsdom)...');

  initDatabase();
  const db = getDatabase();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('business_name','Meridian Cafe') ON CONFLICT(key) DO UPDATE SET value='Meridian Cafe'`).run();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('currency','GBP') ON CONFLICT(key) DO UPDATE SET value='GBP'`).run();
  const bcrypt = require('bcryptjs');
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active) VALUES ('u-own','Jordan','jordan@ui.local',?, 'owner',1)`).run(bcrypt.hashSync('OwnerPass123!', 10));
  db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES ('cat','Coffee',1,1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p-latte','cat','Latte',3.4,0.66,1,1,0,0,0,?,?)`).run(now(), now());

  await startServer();
  const port = getServerPort();
  const origin = `http://127.0.0.1:${port}`;
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend-meridian', 'dist', 'meridian-pos.html'), 'utf8');

  let dom: JSDOM | null = null;
  try {
    dom = new JSDOM(html, {
      url: origin + '/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window: any) {
        // jsdom has no fetch — bridge to Node's. Meridian derives its API base
        // from window.location.origin, which we set to the live server above.
        window.fetch = (input: any, init?: any) => fetch(input, init);
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      },
    });
    const win: any = dom.window;

    // 1. Boot renders the real Plemmo login gate.
    await waitFor(() => { const g = win.document.getElementById('plemmo-auth'); return !!g && !g.hidden && !!win.document.getElementById('plForm'); }, 8000, 'login gate');
    assert(!!win.document.getElementById('plEmail'), 'login form has an email field');
    assert(!win.PlemmoAPI.isAuthenticated(), 'not authenticated before login');

    // 2. Fill and submit the real form.
    win.document.getElementById('plEmail').value = 'jordan@ui.local';
    win.document.getElementById('plPass').value = 'OwnerPass123!';
    win.document.getElementById('plForm').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));

    // 3. Real JWT session established, gate dismissed, context loaded.
    await waitFor(() => win.PlemmoAPI.isAuthenticated(), 8000, 'authentication');
    await waitFor(() => { const g = win.document.getElementById('plemmo-auth'); return !!g && g.hidden; }, 5000, 'gate dismissed');
    assert(!!win.PlemmoAPI.getToken(), 'a JWT token is stored');
    const user = win.PlemmoAPI.currentUser();
    assert(user && user.email === 'jordan@ui.local', 'session user is the real Plemmo user');
    await waitFor(() => !!(win.PlemmoSession && win.PlemmoSession.ctx && win.PlemmoSession.ctx.business), 5000, 'session context');
    assert(win.PlemmoSession.ctx.business.name === 'Meridian Cafe', 'business context loaded from Plemmo');

    // 3b. The app boots into the main view on authoritative Plemmo data — not
    // Meridian's local onboarding — signed in as the real user.
    await waitFor(() => { const a = win.document.getElementById('app'); return !!a && !a.hidden; }, 8000, 'app view');
    assert(win.document.getElementById('onboard').hidden, 'local onboarding is skipped for a Plemmo session');
    await waitFor(() => !!(win.__meridian && win.__meridian.S && Array.isArray(win.__meridian.S.products)), 5000, 'state built');
    const mS = win.__meridian.S; const mU = win.__meridian.U;
    assert(mU.user === 'u-own', 'signed in as the real Plemmo user');
    assert(mS.settings.name === 'Meridian Cafe', 'business settings come from the Plemmo tenant');
    assert(mS.products.some((p: any) => p.name === 'Latte'), 'catalogue is hydrated from Plemmo (Latte present)');
    assert(mS.employees.some((e: any) => e.id === 'u-own'), 'the signed-in user is on the team');

    // 4. Browser-side AI client answers from authoritative data (advisory).
    const ai = await win.PlemmoAI.ask('how many orders today?');
    assert(ai && typeof ai.answer === 'string' && ai.source === 'local', 'AI client returns an advisory answer');
    assert(/Meridian Cafe/.test(ai.answer) || /order/i.test(ai.answer), 'AI answer is grounded in the authoritative snapshot');

    // 5. The status pill reflects a real session (not hidden).
    await waitFor(() => { const p = win.document.getElementById('plemmo-status'); return !!p && !p.hidden; }, 5000, 'status pill');

    // 6. Checkout commit path (exactly what finishSalePlemmo runs) via the real
    // browser-side adapters against the live server: order → bill → payment+tip.
    const ordersBefore = (db.prepare(`SELECT COUNT(*) AS n FROM orders`).get() as any).n;
    const order = await win.PlemmoOrders.createOrder({ type: 'takeaway', items: [{ pid: 'p-latte', qty: 2, mods: [] }] }, win.__meridian.S._plemmoAddons);
    assert(Math.abs(order.subtotal - 6.8) < 0.01, `Plemmo computes the authoritative subtotal (got ${order.subtotal})`);
    const gen = await win.PlemmoAPI.post('/bills/generate', { order_id: order.id }, { idempotent: true });
    const bill = gen.bill || (await win.PlemmoAPI.get('/bills/order/' + order.id)).bill;
    assert(!!bill, 'a bill is generated for the order');
    await win.PlemmoPayments.paySplit(bill.id, [{ method: 'cash', amount: 6.8, tip: 1, tendered: 10 }]);

    const ordersAfter = (db.prepare(`SELECT COUNT(*) AS n FROM orders`).get() as any).n;
    assert(ordersAfter === ordersBefore + 1, 'exactly one authoritative order was created');
    const paidBill = db.prepare(`SELECT payment_status, balance FROM bills WHERE id = ?`).get(bill.id) as any;
    assert(paidBill.payment_status === 'paid' && paidBill.balance <= 0.001, 'the bill is settled authoritatively');
    const tip = db.prepare(`SELECT COALESCE(SUM(tip_minor),0) AS t FROM payments WHERE bill_id = ?`).get(bill.id) as any;
    assert(tip.t === 100, `the £1 tip is persisted authoritatively (got ${tip.t})`);

    // 7. Stock adjust path (what the items handler runs): adjust via the browser
    // adapter and apply the authoritative balance back into local state.
    const recv = await win.PlemmoInventory.receive('p-latte', 15, 'Delivery');
    assert(recv.movement && recv.movement.balance_after === 15, `stock receive returns authoritative balance (got ${recv.movement && recv.movement.balance_after})`);
    win.PlemmoInventory.applyBalance(win.__meridian.S, 'p-latte', recv.movement.balance_after);
    assert((win.__meridian.S.products.find((p: any) => p.id === 'p-latte') || {}).stock === 15, 'local stock reflects the authoritative balance');
    const ledger = db.prepare(`SELECT COUNT(*) AS n FROM inventory_movements WHERE product_id = 'p-latte'`).get() as any;
    assert(ledger.n >= 1, 'the adjustment is in the single Plemmo ledger');

    // 8. Digital-receipt request recorded authoritatively (what emailRc runs).
    const deliver = await win.PlemmoReceipts.deliver(bill.id, 'email', 'guest@x.com');
    assert(deliver.delivery && deliver.delivery.status === 'recorded' && !!deliver.receipt, 'receipt delivery recorded with payload');

    console.log('✅ Meridian UI boot + login gate (jsdom) tests passed');
  } finally {
    if (dom) dom.window.close();
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
