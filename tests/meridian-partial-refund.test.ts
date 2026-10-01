/*
 * Meridian partial refund screen (UI → HTTP → backend → DB).
 *
 * "Choose items": the cashier sets how many of each line come back; the amount
 * shown is the server's per-unit value (what the customer actually paid), and the
 * refund, the stock return and the per-line tracking all happen on the backend.
 * A later "whole order" refund returns only what has not already come back.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mer-prefund-'));
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
  console.log('Testing Meridian partial refund (UI → HTTP → backend → DB)...');
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
    const M = await boot('u-mgr');
    const stock = () => (db.prepare(`SELECT quantity FROM inventory_balances WHERE product_id='p-bagel'`).get() as any)?.quantity as number;
    const sell = async (lines: Array<{ pid: string; qty: number }>) => {
      const order = await M.win.PlemmoOrders.createOrder({ type: 'takeaway', items: lines.map((l) => ({ pid: l.pid, qty: l.qty, mods: [] })) }, M.M().S._plemmoAddons);
      const gen = await M.win.PlemmoAPI.post('/bills/generate', { order_id: order.id }, { idempotent: true });
      await M.win.PlemmoPayments.paySplit(gen.bill.id, [{ method: 'cash', amount: Number(gen.bill.total) }]);
      const hist = await M.win.PlemmoOrders.history({ fromDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10) });
      const S = M.M().S; S.orders.length = 0; S.orders.push(...hist);
      return { orderId: order.id as number, billId: gen.bill.id as number, local: hist.find((o: any) => o.plemmoOrderId === order.id) };
    };
    const openRefund = async (o: any) => {
      await waitFor(() => !M.doc.querySelector('.modal'), 4000, 'dialogs closed');
      M.clearToasts();
      M.click('refund', { id: o.id });
      await waitFor(() => !!M.doc.getElementById('rfGo'), 6000, 'refund dialog');
    };
    const dlg = () => (M.doc.getElementById('rfBody').textContent || '');
    const refunds = (billId: number) => db.prepare(`SELECT amount_minor FROM refunds WHERE bill_id=? ORDER BY rowid`).all(billId) as any[];

    const s0 = stock() ?? 10;
    const s = await sell([{ pid: 'p-bagel', qty: 3 }, { pid: 'p-tea', qty: 1 }]); // 12.00 + 2.00 = 14.00
    ok(stock() === s0 - 3, 'sold 3 bagels + 1 tea (14.00)');

    console.log('\n1. choose items: 1 bagel');
    await openRefund(s.local);
    ok(!!M.doc.querySelector('[data-act="rfMode"][data-m="items"]'), 'the dialog offers Whole order / Choose items');
    ok(/14\.00/.test(dlg()), 'whole-order mode shows everything refundable (14.00)');
    M.click('rfMode', { m: 'items' });
    await waitFor(() => !!M.doc.querySelector('[data-act="rfQty"]'), 3000, 'item rows');
    ok(/Bagel/.test(dlg()) && /Tea/.test(dlg()) && /4\.00 each/.test(dlg()), 'each line shows its quantity and per-unit value from the server');
    ok((M.doc.getElementById('rfGo') as any).disabled === true, 'nothing chosen: the Refund button is disabled');
    const bagelId = (M.doc.querySelector('[data-act="rfQty"][data-d="1"]') as any).getAttribute('data-id');
    M.click('rfQty', { id: bagelId, d: '1' });
    await waitFor(() => /1 \/ 3/.test(dlg()), 3000, 'qty 1');
    ok(/Refund[\s\S]*4\.00/.test(dlg()) && (M.doc.getElementById('rfGo') as any).textContent.includes('4.00'), 'the amount follows the choice: 4.00');
    M.clickEl('#rfGo');
    await waitFor(() => refunds(s.billId).length === 1, 8000, 'refund row');
    ok(refunds(s.billId)[0].amount_minor === 400, 'the backend refunded exactly 4.00');
    ok(stock() === s0 - 2, 'one bagel went back to stock');
    await waitFor(() => (M.M().S.orders.find((o: any) => o.id === s.local.id).refundedAmt) === 4, 6000, 'Meridian reads the partial refund back');
    ok(M.M().S.orders.find((o: any) => o.id === s.local.id).status === 'paid', 'the order is still paid (partially refunded), not marked refunded');
    ok(/Refunded .*4\.00/.test(M.toasts()), 'the toast says how much was refunded');

    console.log('\n2. the next refund knows 1 bagel is already back');
    await openRefund(s.local);
    M.click('rfMode', { m: 'items' });
    await waitFor(() => /1 already returned/.test(dlg()), 3000, 'already returned note');
    ok(/0 \/ 2/.test(dlg()), 'the bagel line now offers at most 2');

    console.log('\n3. money-only (damaged): no restock');
    M.click('rfQty', { id: bagelId, d: '1' });
    await waitFor(() => /1 \/ 2/.test(dlg()), 3000, 'qty');
    (M.doc.getElementById('rfS') as any).click();
    M.clickEl('#rfGo');
    await waitFor(() => refunds(s.billId).length === 2, 8000, 'second refund');
    ok(stock() === s0 - 2, 'stock unchanged when "put back in stock" is off');

    console.log('\n4. whole order refunds only what is left');
    await openRefund(s.local);
    ok(/6\.00|10\.00/.test(dlg()) && /Everything still refundable \(\D*6\.00\)/.test(dlg()), 'whole-order mode now offers the remaining 6.00 (14.00 - 4.00 - 4.00)');
    M.clickEl('#rfGo');
    await waitFor(() => refunds(s.billId).length === 3, 8000, 'third refund');
    ok(refunds(s.billId).reduce((a: number, r: any) => a + r.amount_minor, 0) === 1400, 'the three refunds add up to exactly the 14.00 paid');
    await waitFor(() => M.M().S.orders.find((o: any) => o.id === s.local.id).status === 'refunded', 6000, 'Meridian shows refunded');
    ok(stock() === s0 - 2 + 1, 'the last bagel (the only unreturned, restockable one) went back; the damaged one did not (net -1)');
    ok(db.prepare(`SELECT COALESCE(SUM(quantity),0) q FROM refund_lines WHERE bill_id=?`).get(s.billId).q === 4, 'all 4 units are tracked as returned across the three refunds');
    M.dom.window.close();

    console.log(`\n✅ Meridian partial refund passed (${checks} checks)`);
  } finally {
    for (const d of doms) { try { d.window.close(); } catch { /* closed */ } }
    for (const s of fakes) { try { await closeServer(s); } catch { /* closed */ } }
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
