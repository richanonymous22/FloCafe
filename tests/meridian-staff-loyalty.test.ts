/*
 * Kiosk / Loyalty / Staff phase — verification.
 *
 *   1. Sandbox unit-tests the staff/loyalty adapter mappers.
 *   2. Contract test: staff timeclock (clock-in, one-open-shift guard,
 *      clock-out, timesheet + worked-hours, authz) and server-derived loyalty
 *      tiers (bronze/silver/gold from authoritative spend).
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-staff-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const sandbox: any = { window: { PlemmoAPI: {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'frontend-meridian', 'src', '03h-plemmo-staff.js'), 'utf8'), sandbox);
const Staff = sandbox.window.PlemmoStaff;
const Loyalty = sandbox.window.PlemmoLoyalty;

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';
import { tierForSpend } from '../main/core/loyalty';

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
const now = () => new Date().toISOString();

async function run() {
  console.log('Testing Kiosk / Loyalty / Staff...');

  // 1. Pure mappers.
  const s = Staff.mapStaff({ id: 'u1', name: 'Priya', role: 'manager', email: 'p@x.com', is_active: 1 });
  assert(s.id === 'u1' && s.role === 'manager' && s.active === true && s.position === 'Manager', 'mapStaff maps fields');
  assert(Loyalty.tierMeta({ tier: 'gold' }).label === 'Gold' && Loyalty.tierMeta({}).key === 'bronze', 'tierMeta defaults to bronze');
  // Pure tier logic (explicit thresholds 120/300).
  const cfg = { silver: 120, gold: 300 };
  assert(tierForSpend(50, cfg) === 'bronze' && tierForSpend(120, cfg) === 'silver' && tierForSpend(500, cfg) === 'gold', 'tierForSpend thresholds');

  // 2. Contract test.
  initDatabase();
  const db = getDatabase();
  const bcrypt = require('bcryptjs');
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active) VALUES ('u-own','Owner','own@st.local',?, 'owner',1)`).run(bcrypt.hashSync('OwnerPass123!', 10));
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active) VALUES ('u-cash','Cash','cash@st.local',?, 'cashier',1)`).run(bcrypt.hashSync('CashPass123!', 10));
  // Customers at different lifetime spends for tier checks.
  db.prepare(`INSERT INTO customers (id, name, is_active, created_at, updated_at) VALUES ('c-b','Bronze Bob',1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO customers (id, name, is_active, created_at, updated_at) VALUES ('c-g','Gold Grace',1,?,?)`).run(now(), now());
  // A £500 product so a single order gives Grace a Gold lifetime spend.
  db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES ('cat','C',1,1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p-big','cat','Hamper',500,100,1,1,0,0,0,?,?)`).run(now(), now());

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  const login = async (e: string, p: string) => (await request(base).post('/api/auth/login').send({ email: e, password: p })).body.access_token;
  try {
    const owner = await login('own@st.local', 'OwnerPass123!');
    const cashier = await login('cash@st.local', 'CashPass123!');
    const own = (r: any) => r.set('Authorization', `Bearer ${owner}`);
    const cash = (r: any) => r.set('Authorization', `Bearer ${cashier}`);

    // Timeclock: cashier clocks self in, cannot clock in twice, clocks out.
    assert((await cash(request(base).get('/api/shifts/me'))).body.shift === null, 'no open shift initially');
    const inRes = await cash(request(base).post('/api/shifts/clock-in')).send({});
    assert(inRes.status === 201 && !inRes.body.shift.clock_out, 'clock-in opens a shift');
    const dup = await cash(request(base).post('/api/shifts/clock-in')).send({});
    assert(dup.status === 409, 'second clock-in rejected (one open shift per user)');
    const me = await cash(request(base).get('/api/shifts/me'));
    assert(me.body.shift && !me.body.shift.clock_out, 'my open shift is visible');
    const outRes = await cash(request(base).post('/api/shifts/clock-out')).send({});
    assert(outRes.status === 200 && !!outRes.body.shift.clock_out, 'clock-out closes the shift');
    assert((await cash(request(base).post('/api/shifts/clock-out')).send({})).status === 409, 'clock-out with no open shift rejected');

    // Timesheet (manager+): cashier cannot list all; owner can.
    assert((await cash(request(base).get('/api/shifts'))).status === 403, 'cashier cannot read the full timesheet');
    const sheet = await own(request(base).get('/api/shifts?user_id=u-cash'));
    assert(sheet.status === 200 && sheet.body.shifts.length >= 1, 'owner reads the timesheet');

    // Loyalty tiers derived from authoritative spend.
    // total_spent = SUM(orders.total) — create a real £500 order for Grace.
    const ord = await own(request(base).post('/api/orders')).set('Idempotency-Key', 'gk-1')
      .send({ type: 'takeaway', customer_id: 'c-g', items: [{ product_id: 'p-big', quantity: 1 }] });
    assert(ord.status === 201 && Math.abs(ord.body.order.total - 500) < 1, 'seed order for Grace totals ~500');
    const list = (await own(request(base).get('/api/customers?per_page=500'))).body.data;
    const grace = list.find((c: any) => c.id === 'c-g');
    const bob = list.find((c: any) => c.id === 'c-b');
    assert(grace && grace.tier === 'gold', `high spender is gold (got ${grace && grace.tier})`);
    assert(bob && bob.tier === 'bronze', 'no-spend customer is bronze');

    console.log('✅ Kiosk / Loyalty / Staff tests passed');
  } finally {
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
