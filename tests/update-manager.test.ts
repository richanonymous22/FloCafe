/*
 * Application updates — an update installs only when it is safe: never mid-sale, always after a verified
 * backup, always on the record; quiet-hours installs are staggered and happen only when nothing is open.
 * Driven through the real API with a fake updater (no installer is run).
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-update-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';
import * as um from '../main/services/update-manager';
const { createSale } = require('../main/core/sale');

let passed = 0;
function ok(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); passed++; console.log(`  ✓ ${msg}`); }
const now = () => new Date().toISOString();

async function run() {
  console.log('Testing update manager...');
  initDatabase();
  const db = getDatabase();
  const bcrypt = require('bcryptjs');
  const pw = bcrypt.hashSync('Passw0rd!x', 10);
  for (const [id, role] of [['u-own', 'owner'], ['u-mgr', 'manager'], ['u-cash', 'cashier']]) db.prepare(`INSERT INTO users (id, name, email, password, role, is_active) VALUES (?,?,?,?,?,1)`).run(id, id, `${id}@till.local`, pw, role);
  const { grantLocationAccess } = require('../main/core/employee-access');
  const { getCurrentLocationId } = require('../main/core/location');
  grantLocationAccess('u-cash', getCurrentLocationId());
  db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES ('c','Shop',1,1,?,?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at) VALUES ('p1','c','Widget',5,2,'W1',1,1,0,0,0,?,?)`).run(now(), now());
  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  try {
    const login = async (id: string) => (await request(base).post('/api/auth/login').send({ email: `${id}@till.local`, password: 'Passw0rd!x' })).body.access_token as string;
    const T = { own: await login('u-own'), mgr: await login('u-mgr'), cash: await login('u-cash') };
    const api = (t: string, method: 'get' | 'post' | 'put', p: string, body?: any) => { const r = (request(base) as any)[method](p).set('Authorization', `Bearer ${t}`); return body === undefined ? r : r.send(body); };
    let installs = 0;
    const attach = () => { um.detachUpdater(); installs = 0; um.attachUpdater({ checkForUpdates: async () => { um.noteUpdaterEvent('not-available'); }, quitAndInstall: () => { installs++; } }, '3.1.0'); };
    const settleOrders = () => db.prepare("UPDATE orders SET status = 'completed'").run();

    console.log('\n1. status');
    attach();
    const s0 = (await api(T.cash, 'get', '/api/updates/status')).body;
    ok(s0.current === '3.1.0' && s0.can_install_now === false && /no update/.test(s0.blockers[0]) && s0.settings.mode === 'ask', 'a cashier can read the status: nothing to install, mode "ask"');
    ok((await api(T.cash, 'post', '/api/updates/install')).status === 403 && (await api(T.cash, 'put', '/api/updates/settings', { mode: 'manual' })).status === 403, 'a cashier cannot install or change the settings');
    ok((await api(T.mgr, 'put', '/api/updates/settings', { mode: 'manual' })).status === 403, 'a manager cannot change the settings (owner only)');
    um.noteUpdaterEvent('available', { version: '3.2.0' });
    ok((await api(T.own, 'get', '/api/updates/status')).body.blockers[0].includes('still downloading'), 'while it downloads, installing is not offered');
    um.noteUpdaterEvent('downloaded', { version: '3.2.0' });
    const s1 = (await api(T.own, 'get', '/api/updates/status')).body;
    ok(s1.downloaded === '3.2.0' && s1.can_install_now === true && s1.blockers.length === 0, 'once downloaded and nothing is happening, it can be installed');

    console.log('\n2. never mid-sale');
    createSale({ channel: 'takeaway', lines: [{ product_id: 'p1', quantity: 1 }], cashierUserId: 'u-own' });
    const blocked = await api(T.own, 'post', '/api/updates/install');
    ok(blocked.status === 409 && blocked.body.code === 'update_blocked' && /opened or changed in the last ten minutes/.test(blocked.body.reasons.join()), 'a sale opened a moment ago blocks the install, with the reason');
    ok(installs === 0 && um.getUpdateHistory().length === 0, 'nothing restarted and no backup or history was made');
    db.prepare("UPDATE orders SET updated_at = datetime('now', '-30 minutes'), created_at = datetime('now', '-30 minutes')").run();
    ok(um.installBlockers().length === 0, 'an order left open for half an hour (a tab) does not block an install you ask for');
    ok(um.installBlockers({ strict: true }).length === 1, 'but counts as open for an unattended install');
    db.pragma('foreign_keys = OFF'); // a bare in-flight payment row is enough to test the rule
    db.prepare(`INSERT INTO payments (id, bill_id, order_id, adapter, method, state, amount_minor, currency, requested_at) VALUES ('pay-x', 1, 1, 'manual_card', 'card', 'authorized', 500, 'GBP', ?)`).run(now());
    ok(um.installBlockers().some((r) => /payment/.test(r)), 'a card payment in flight blocks it');
    db.prepare("DELETE FROM payments WHERE id = 'pay-x'").run();
    db.pragma('foreign_keys = ON');
    settleOrders();

    console.log('\n3. a safe install backs up, verifies and records');
    const go = await api(T.mgr, 'post', '/api/updates/install');
    ok(go.status === 202 && go.body.installing && go.body.to === '3.2.0' && fs.existsSync(go.body.backup), 'the install starts and a backup file exists');
    ok(installs === 1, 'the restart was requested exactly once');
    const Sqlite = require('better-sqlite3'); const copy = new Sqlite(go.body.backup, { readonly: true });
    ok(copy.pragma('integrity_check', { simple: true }) === 'ok' && (copy.prepare('SELECT COUNT(*) n FROM products').get() as any).n === 1, 'the backup is a readable, intact copy of the data');
    copy.close();
    const h = um.getUpdateHistory();
    ok(h.length === 1 && h[0].status === 'installing' && h[0].from === '3.1.0' && h[0].to === '3.2.0' && h[0].backup === go.body.backup && h[0].automatic === false, 'the history records from, to, the backup and that it was manual');
    ok((db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type = 'system.update_started'").get() as any).n === 1, 'the start is audited');
    ok((await api(T.own, 'post', '/api/updates/install')).status === 409, 'a second install while one is running is refused');

    console.log('\n4. the new version checks itself on the next start');
    const bad = um.finalizeUpdateOnBoot('3.1.0');
    ok(!!bad && bad.status === 'failed' && /did not complete/.test(bad.note || ''), 'if the old version is still running the entry is marked failed');
    ok((db.prepare("SELECT COUNT(*) n FROM audit_events WHERE event_type = 'system.update_failed'").get() as any).n === 1, 'and that is audited');
    attach(); um.noteUpdaterEvent('downloaded', { version: '3.3.0' });
    await um.installNow({ actorUserId: 'u-own' });
    const good = um.finalizeUpdateOnBoot('3.3.0');
    ok(!!good && good.status === 'ok' && good.to === '3.3.0', 'when the new version runs and the database checks out, the entry is "ok"');
    ok(um.finalizeUpdateOnBoot('3.3.0') === null, 'a finished entry is not judged twice');
    ok(um.getUpdateHistory().length === 2 && um.getUpdateHistory()[0].status === 'ok', 'the history lists newest first');

    console.log('\n5. settings and "remind me later"');
    attach(); um.noteUpdaterEvent('downloaded', { version: '3.4.0' });
    ok((await api(T.own, 'put', '/api/updates/settings', { mode: 'sometimes' })).status === 400, 'an unknown mode is refused');
    ok((await api(T.own, 'put', '/api/updates/settings', { window_start_hour: 25 })).status === 400, 'an hour outside 0–23 is refused');
    const set = await api(T.own, 'put', '/api/updates/settings', { mode: 'quiet_hours', window_start_hour: 2, window_end_hour: 6 });
    ok(set.status === 200 && set.body.settings.mode === 'quiet_hours' && set.body.settings.window_start_hour === 2 && set.body.settings.window_end_hour === 6, 'the owner sets quiet hours 02:00–06:00');
    ok((await api(T.mgr, 'post', '/api/updates/defer', { minutes: 0 })).status === 400, 'a deferral must be at least a minute');
    const def = await api(T.mgr, 'post', '/api/updates/defer', { minutes: 240 });
    ok(def.status === 200 && def.body.deferred === true, 'a manager can say "remind me later" (4 hours)');

    console.log('\n6. quiet hours');
    const winter = (h: number, m = 0) => Date.UTC(2026, 0, 15, h, m); // January: London time is UTC
    const settings = um.getUpdateSettings();
    const devA = 'till-A'; const devB = 'till-B-with-another-id';
    ok(um.staggerMinutes(devA) >= 0 && um.staggerMinutes(devA) < 45 && um.staggerMinutes(devA) === um.staggerMinutes(devA), 'each till has a fixed wait of under 45 minutes after the window opens');
    ok(um.staggerMinutes(devA) !== um.staggerMinutes(devB), 'different tills wait different times (so they never restart together)');
    ok(um.inQuietWindow(settings, devA, winter(4, 0)) && !um.inQuietWindow(settings, devA, winter(12, 0)) && !um.inQuietWindow(settings, devA, winter(1, 59)) && !um.inQuietWindow(settings, devA, winter(6, 0)), '04:00 is inside the window; noon, 01:59 and 06:00 are not');
    ok(!um.inQuietWindow({ ...settings, window_start_hour: 2 }, 'x'.repeat(1), winter(2, 0)) || um.staggerMinutes('x') === 0, 'a till does not start at the very opening minute unless its wait is zero');
    ok(await um.autoInstallTick(winter(4, 0)) === false && installs === 0, 'while "remind me later" is in force nothing installs by itself');
    db.prepare("DELETE FROM settings WHERE key = 'update_deferred_until'").run();
    ok(await um.autoInstallTick(winter(12, 0)) === false, 'outside the window nothing installs');
    createSale({ channel: 'takeaway', lines: [{ product_id: 'p1', quantity: 1 }], cashierUserId: 'u-own' });
    db.prepare("UPDATE orders SET updated_at = datetime('now', '-3 hours'), created_at = datetime('now', '-3 hours')").run();
    ok(await um.autoInstallTick(winter(4, 0)) === false && installs === 0, 'an order still open — even an old one — stops an unattended install');
    settleOrders();
    ok(await um.autoInstallTick(winter(4, 0)) === true && installs === 1, 'inside the window with nothing open, it installs by itself');
    ok(um.getUpdateHistory()[0].automatic === true && um.getUpdateHistory()[0].status === 'installing', 'and the history says it was automatic');
    attach(); um.noteUpdaterEvent('downloaded', { version: '3.5.0' });
    await api(T.own, 'put', '/api/updates/settings', { mode: 'ask' });
    ok(await um.autoInstallTick(winter(4, 0)) === false, 'in "ask" mode nothing ever installs by itself');
    await api(T.own, 'put', '/api/updates/settings', { mode: 'manual' });
    ok(await um.autoInstallTick(winter(4, 0)) === false, 'nor in "manual" mode');

    console.log(`\n✅ Update manager passed (${passed} checks)`);
  } finally {
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
run().catch((err) => { console.error(err); process.exit(1); });
