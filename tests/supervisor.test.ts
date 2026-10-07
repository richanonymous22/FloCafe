/*
 * Supervisor: a cashier who may approve refunds, voids, discounts and price changes - by their own login or by PIN -
 * and nothing more. Additive migration (a flag on users); the role stays 'cashier'.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-supervisor-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';
import { resetApprovalRateLimits } from '../main/core/approval';
import { hasPermission } from '../main/core/authorization';

let passed = 0;
function ok(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); passed++; console.log(`  ✓ ${msg}`); }
const now = () => new Date().toISOString();

async function run() {
  console.log('Testing the supervisor role...');
  initDatabase();
  const db = getDatabase();
  const bcrypt = require('bcryptjs');
  const pw = bcrypt.hashSync('Passw0rd!x', 10);
  const user = (id: string, role: string, pin: string | null) =>
    db.prepare(`INSERT INTO users (id, name, email, password, role, pin_hash, is_active) VALUES (?,?,?,?,?,?,1)`)
      .run(id, id, `${id}@till.local`, pw, role, pin ? bcrypt.hashSync(pin, 10) : null);
  user('u-own', 'owner', '1111'); user('u-mgr', 'manager', '2222'); user('u-cash', 'cashier', null); user('u-wait', 'waiter', null);
  const { grantLocationAccess } = require('../main/core/employee-access');
  const { getCurrentLocationId } = require('../main/core/location');
  grantLocationAccess('u-cash', getCurrentLocationId());
  ok(Number(db.pragma('user_version', { simple: true })) >= 103, 'database migrated to v103 or later');
  ok((db.prepare("SELECT COUNT(*) c FROM users WHERE is_supervisor != 0").get() as any).c === 0, 'every existing account starts as not a supervisor');
  db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES ('cat','Shop',1,1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
              VALUES ('p1','cat','Widget',10,1,'W1',1,1,0,0,0,?,?)`).run(now(), now());

  ok(hasPermission('cashier', 'sales.refund') === false && hasPermission('cashier', 'sales.refund', true) === true, 'a supervisor flag grants refund approval to a cashier');
  ok(hasPermission('waiter', 'sales.refund', true) === false && hasPermission('chef', 'sales.void', true) === false, 'the flag means nothing on any other role');
  ok(!hasPermission('cashier', 'reports.z', true) && !hasPermission('cashier', 'employees.manage', true) && !hasPermission('cashier', 'inventory.adjust', true) && !hasPermission('cashier', 'sales.reconcile', true) && !hasPermission('cashier', 'reports.view', true), 'and nothing beyond the four sales approvals (no reports, stock, staff or reconciliation)');

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  try {
    const login = async (email: string) => (await request(base).post('/api/auth/login').send({ email, password: 'Passw0rd!x' })).body;
    const tok = async (id: string) => (await login(`${id}@till.local`)).access_token as string;
    const as = (t: string) => (r: any) => r.set('Authorization', `Bearer ${t}`);
    const T = { own: await tok('u-own'), mgr: await tok('u-mgr'), cash: await tok('u-cash') };

    console.log('\n1. who can create a supervisor');
    const mk = (t: string, body: any) => as(t)(request(base).post('/api/staff')).send({ password: 'Passw0rd!x', ...body });
    ok((await mk(T.mgr, { name: 'Sam', email: 'sam@till.local', role: 'cashier', supervisor: true, pin: '5555' })).status === 403, 'a manager cannot make a supervisor (owners only)');
    ok((await mk(T.own, { name: 'W', email: 'w2@till.local', role: 'waiter', supervisor: true })).status === 400, 'only a cashier can be a supervisor');
    ok((await mk(T.own, { name: 'C', email: 'c2@till.local', role: 'cashier', pin: '5555' })).status === 400, 'an ordinary cashier still cannot hold a PIN');
    ok((await mk(T.own, { name: 'S', email: 's@till.local', role: 'cashier', supervisor: 'yes' })).status === 400, 'supervisor must be true or false');
    const created = await mk(T.own, { name: 'Sam', email: 'sam@till.local', role: 'cashier', supervisor: true, pin: '5555' });
    ok(created.status === 201 && created.body.staff.role === 'cashier' && created.body.staff.is_supervisor === 1 && created.body.staff.has_pin === 1, 'the owner creates a supervisor: role cashier, flagged, with a PIN');
    const samId = created.body.staff.id as string;
    grantLocationAccess(samId, getCurrentLocationId());
    const samLogin = await login('sam@till.local');
    ok(samLogin.user.supervisor === true && samLogin.user.role === 'cashier', 'the sign-in response says the supervisor is a supervisor, still role cashier');
    const S = samLogin.access_token as string;

    let seq = 0;
    async function sellCash(t = T.own) {
      const o = await as(t)(request(base).post('/api/orders').set('Idempotency-Key', `s-${++seq}`)).send({ type: 'takeaway', items: [{ product_id: 'p1', quantity: 2 }] });
      const bill = (await as(t)(request(base).post('/api/bills/generate')).send({ order_id: o.body.order.id })).body.bill;
      const paid = await as(t)(request(base).post(`/api/bills/${bill.id}/payments`).set('Idempotency-Key', `p-${seq}`)).send({ payments: [{ method: 'cash', amount: Number(bill.total) }] });
      if (paid.status !== 200) throw new Error('payment failed ' + JSON.stringify(paid.body));
      return { orderId: o.body.order.id as number, billId: bill.id as number };
    }
    const refund = (t: string, billId: number, body: any) => as(t)(request(base).post(`/api/bills/${billId}/refund`)).send(body);

    console.log('\n2. approving a refund');
    const b1 = await sellCash(); const b2 = await sellCash(); const b3 = await sellCash();
    resetApprovalRateLimits();
    const noPin = await refund(T.cash, b1.billId, { reason: 'x', amount: 1 });
    ok(noPin.status === 403 && noPin.body.requiresApproval === true, 'an ordinary cashier needs approval to refund');
    const viaPin = await refund(T.cash, b1.billId, { reason: 'Faulty', amount: 1, override_pin: '5555' });
    ok(viaPin.status === 200, 'the supervisor\'s PIN approves a cashier\'s refund');
    const rf = db.prepare('SELECT actor_user_id FROM refunds WHERE bill_id = ?').get(b1.billId) as any;
    ok(rf.actor_user_id === samId, 'the supervisor is recorded as the approver');
    const own = await refund(S, b2.billId, { reason: 'Faulty', amount: 1 });
    ok(own.status === 200, 'a supervisor signed in refunds without a PIN');
    ok((await refund(T.cash, b3.billId, { reason: 'x', amount: 1, override_pin: '9999' })).status === 403, 'a wrong PIN is still refused');

    console.log('\n3. what a supervisor still cannot do');
    const denied = async (method: 'get' | 'post' | 'put', url: string, body?: any) => {
      let r = (request(base) as any)[method](url).set('Authorization', `Bearer ${S}`);
      if (body) r = r.send(body);
      return (await r).status;
    };
    ok(await denied('post', '/api/reports/z', {}) === 403, 'cannot run a Z report');
    ok(await denied('get', '/api/reports/x') === 403, 'cannot read the X report');
    ok(await denied('post', '/api/staff', { name: 'n', email: 'n@till.local', password: 'Passw0rd!x', role: 'cashier' }) === 403, 'cannot manage staff');
    ok(await denied('post', '/api/inventory/adjust', { product_id: 'p1', quantity_delta: 1, reason: 'x', movement_type: 'adjustment' }) === 403, 'cannot adjust stock');
    ok(await denied('put', '/api/card/config', { provider: 'none' }) === 403, 'cannot change the card provider');
    ok(await denied('post', '/api/stocktakes', {}) === 403, 'cannot run a stocktake');

    console.log('\n4. discounts and voids by PIN');
    db.prepare(`INSERT INTO settings (key, value) VALUES ('discount_requires_approval','true') ON CONFLICT(key) DO UPDATE SET value='true'`).run();
    const o = await as(T.cash)(request(base).post('/api/orders').set('Idempotency-Key', 'disc-1')).send({ type: 'takeaway', items: [{ product_id: 'p1', quantity: 1 }] });
    resetApprovalRateLimits();
    const noApproval = await as(T.cash)(request(base).patch(`/api/orders/${o.body.order.id}/discount`)).send({ discount_type: 'percentage', discount_value: 10, discount_reason: 'Regular' });
    ok(noApproval.status === 403 && noApproval.body.requiresApproval === true, 'a discount needs approval');
    const withSup = await as(T.cash)(request(base).patch(`/api/orders/${o.body.order.id}/discount`)).send({ discount_type: 'percentage', discount_value: 10, discount_reason: 'Regular', override_pin: '5555' });
    ok(withSup.status === 200, 'the supervisor\'s PIN approves a discount');

    console.log('\n5. taking it away');
    const demote = await as(T.own)(request(base).put(`/api/staff/${samId}`)).send({ supervisor: false });
    ok(demote.status === 200 && demote.body.staff.is_supervisor === 0 && demote.body.staff.has_pin === 0, 'the owner removes the flag: the PIN goes with it');
    resetApprovalRateLimits();
    const b4 = await sellCash();
    ok((await refund(T.cash, b4.billId, { reason: 'x', amount: 1, override_pin: '5555' })).status === 403, 'the old PIN no longer approves anything');
    ok((await refund(S, b4.billId, { reason: 'x', amount: 1 })).status === 401 || (await refund(S, b4.billId, { reason: 'x', amount: 1 })).status === 403, 'and the old session no longer approves refunds');
    const again = await as(T.own)(request(base).put(`/api/staff/${samId}`)).send({ supervisor: true, pin: '5555' });
    ok(again.status === 200 && again.body.staff.is_supervisor === 1, 'the owner can make them a supervisor again');
    const toWaiter = await as(T.own)(request(base).put(`/api/staff/${samId}`)).send({ role: 'waiter' });
    ok(toWaiter.status === 200 && toWaiter.body.staff.is_supervisor === 0 && toWaiter.body.staff.has_pin === 0, 'moving them to another role drops the flag and the PIN');
    await as(T.own)(request(base).put(`/api/staff/${samId}`)).send({ role: 'cashier' });
    ok((await as(T.mgr)(request(base).put(`/api/staff/${samId}`)).send({ supervisor: true })).status === 403, 'a manager cannot grant it');

    console.log('\n6. a deactivated supervisor');
    await as(T.own)(request(base).put(`/api/staff/${samId}`)).send({ role: 'cashier', supervisor: true, pin: '5555' });
    await as(T.own)(request(base).post(`/api/staff/${samId}/deactivate`)).send({});
    resetApprovalRateLimits();
    const b5 = await sellCash();
    ok((await refund(T.cash, b5.billId, { reason: 'x', amount: 1, override_pin: '5555' })).status === 403, 'a deactivated supervisor\'s PIN is refused');

    console.log(`\n✅ Supervisor passed (${passed} checks)`);
  } finally {
    await stopServer();
    closeDatabase();
  }
}
run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
