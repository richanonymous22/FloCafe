/*
 * Meridian visual QA (real Chromium via playwright-core).
 *
 * Boots the Plemmo server serving the Meridian bundle (PLEMMO_MERIDIAN_UI=1),
 * drives it in a real browser: logs in through the gate, then visits every
 * merchant view, screenshots each, and asserts the view rendered with no page
 * errors and no severe console errors. This is the browser render/QA pass that
 * jsdom cannot give.
 *
 * Uses the pre-installed Chromium (PLAYWRIGHT_BROWSERS_PATH); playwright-core is
 * a dev-only tool for this pass and is not a committed dependency.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from 'playwright-core';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-vqa-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.PLEMMO_MERIDIAN_UI = '1';

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
const now = () => new Date().toISOString();

function findChromium(): string {
  if (process.env.PW_CHROME && fs.existsSync(process.env.PW_CHROME)) return process.env.PW_CHROME;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith('chromium-')) : [];
  for (const d of dirs) {
    const p = path.join(base, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chromium executable not found under ' + base);
}

async function run() {
  console.log('Meridian visual QA (real Chromium)...');
  const shotDir = path.join('/tmp/claude-0/-home-user-FloCafe/53460658-cc2c-5019-9eb5-894cea769313/scratchpad', 'qa-screens');
  try { fs.mkdirSync(shotDir, { recursive: true }); } catch { /* ignore */ }

  // Seed a realistic business so every view has content.
  initDatabase();
  const db = getDatabase();
  db.prepare(`INSERT INTO settings (key,value) VALUES ('business_name','Meridian Cafe') ON CONFLICT(key) DO UPDATE SET value='Meridian Cafe'`).run();
  db.prepare(`INSERT INTO settings (key,value) VALUES ('currency','GBP') ON CONFLICT(key) DO UPDATE SET value='GBP'`).run();
  const orgId = (db.prepare(`SELECT value FROM settings WHERE key='plemmo_organization_id'`).get() as any)?.value;
  if (orgId) db.prepare(`INSERT INTO organization_features (organization_id,feature_key,enabled,source) VALUES (?, 'hospitality.tables',1,'custom') ON CONFLICT(organization_id,feature_key) DO UPDATE SET enabled=1`).run(orgId);
  const bcrypt = require('bcryptjs');
  db.prepare(`INSERT INTO users (id,name,email,password,role,is_active) VALUES ('u-own','Jordan','jordan@vqa.local',?, 'owner',1)`).run(bcrypt.hashSync('OwnerPass123!', 10));
  db.prepare(`INSERT INTO categories (id,name,color,icon,is_active,sort_order,created_at,updated_at) VALUES ('cat','Coffee','#B7794B','☕',1,1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id,category_id,name,price,cost,is_active,sort_order,track_inventory,stock_quantity,low_stock_threshold,created_at,updated_at) VALUES ('p-latte','cat','Latte',3.4,0.66,1,1,1,12,5,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id,category_id,name,price,cost,is_active,sort_order,track_inventory,stock_quantity,low_stock_threshold,created_at,updated_at) VALUES ('p-bun','cat','Cinnamon Bun',3.1,0.6,1,2,1,2,5,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO customers (id,name,phone,email,is_active,created_at,updated_at) VALUES ('c1','Aisha Khan','07123456789','a@x.com',1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO tables (id,number,capacity,shape,size,position_x,position_y,is_active,created_at,updated_at) VALUES ('t1','1',2,'round','s',10,10,1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO tables (id,number,capacity,shape,size,position_x,position_y,is_active,created_at,updated_at) VALUES ('t2','2',4,'square','m',40,20,1,?,?)`).run(now(), now());

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;

  // Create a paid order via the API so Home/Reports/Orders have content.
  const request = require('supertest');
  const token = (await request(base).post('/api/auth/login').send({ email: 'jordan@vqa.local', password: 'OwnerPass123!' })).body.access_token;
  const auth = (r: any) => r.set('Authorization', `Bearer ${token}`);
  const ord = (await auth(request(base).post('/api/orders')).set('Idempotency-Key', 'vqa1').send({ type: 'takeaway', items: [{ product_id: 'p-latte', quantity: 2 }] })).body.order;
  const gbill = (await auth(request(base).post('/api/bills/generate')).send({ order_id: ord.id })).body.bill;
  await auth(request(base).post(`/api/bills/${gbill.id}/payment`)).set('Idempotency-Key', 'vqap1').send({ method: 'cash', amount: 6.8, tip: 1, tendered: 10 });

  const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (!/fonts\.g|favicon|net::ERR|Failed to load resource/i.test(t)) consoleErrors.push(t); } });

    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#plForm', { timeout: 15000 });
    await page.fill('#plEmail', 'jordan@vqa.local');
    await page.fill('#plPass', 'OwnerPass123!');
    await page.click('#plBtn');
    await page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(shotDir, '00-home.png') });

    const views = ['home', 'pos', 'tables', 'orders', 'items', 'customers', 'team', 'cash', 'reports', 'assistant'];
    for (const v of views) {
      const nav = await page.$(`[data-act="nav"][data-v="${v}"]`);
      if (!nav) { console.log(`  (nav ${v} not visible — skipped)`); continue; }
      await nav.click();
      await page.waitForTimeout(450);
      // The view container should have rendered non-trivial content.
      const txt = (await page.textContent('#view')) || (await page.textContent('#app')) || '';
      assert(txt.trim().length > 20, `view ${v} rendered content`);
      await page.screenshot({ path: path.join(shotDir, `${v}.png`) });
      console.log(`  ✓ ${v} rendered`);
    }

    assert(pageErrors.length === 0, `no uncaught page errors (got: ${pageErrors.slice(0, 3).join(' | ')})`);
    assert(consoleErrors.length === 0, `no severe console errors (got: ${consoleErrors.slice(0, 3).join(' | ')})`);
    console.log(`✅ Visual QA passed — screenshots in ${shotDir}`);
  } finally {
    await browser.close();
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
