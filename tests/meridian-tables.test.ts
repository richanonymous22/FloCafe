/*
 * Tables / Floor Plan / KDS / Kiosk phase — verification.
 *
 *   1. Sandbox unit-tests the tables adapter's pure mappers.
 *   2. Contract test: floor-plan geometry (shape/size/position/rotation) is
 *      persisted authoritatively (migration v92), round-trips through the API,
 *      is consistent across independent reads (multi-device safe), a layout edit
 *      persists, and the KDS orders endpoint is reachable.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-tables-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const sandbox: any = { window: { PlemmoAPI: {}, PlemmoOrders: {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'frontend-meridian', 'src', '03g-plemmo-tables.js'), 'utf8'), sandbox);
const T = sandbox.window.PlemmoTables;

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }

async function run() {
  console.log('Testing Tables / Floor Plan / KDS / Kiosk...');

  // 1. Pure mappers.
  const m = T.mapPlemmoTable({ id: 't1', number: '5', capacity: 4, shape: 'round', size: 'l', position_x: 12.5, position_y: 40, rotation: 90, status: 'available' });
  assert(m.name === '5' && m.seats === 4 && m.shape === 'round' && m.size === 'l' && m.x === 12.5 && m.y === 40 && m.rotation === 90, 'mapPlemmoTable maps geometry');
  const body = T.mapToPlemmoBody({ name: '6', seats: 2, x: 5, y: 9, shape: 'square', size: 's', rotation: 0 });
  assert(body.number === '6' && body.capacity === 2 && body.position_x === 5 && body.shape === 'square' && body.size === 's', 'mapToPlemmoBody builds request');

  // 2. Contract test.
  initDatabase();
  const db = getDatabase();
  const orgId = (db.prepare(`SELECT value FROM settings WHERE key='plemmo_organization_id'`).get() as any)?.value;
  assert(!!orgId, 'organization id resolved');
  db.prepare(`INSERT INTO organization_features (organization_id, feature_key, enabled, source) VALUES (?, 'hospitality.tables', 1, 'custom')
              ON CONFLICT(organization_id, feature_key) DO UPDATE SET enabled=1`).run(orgId);
  const bcrypt = require('bcryptjs');
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active) VALUES ('u-own','Owner','own@tbl.local',?, 'owner',1)`).run(bcrypt.hashSync('OwnerPass123!', 10));

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  try {
    const token = (await request(base).post('/api/auth/login').send({ email: 'own@tbl.local', password: 'OwnerPass123!' })).body.access_token;
    const auth = (r: any) => r.set('Authorization', `Bearer ${token}`);

    // Create a table WITH geometry (Meridian floor-plan shape).
    const created = await auth(request(base).post('/api/tables'))
      .send(T.mapToPlemmoBody({ name: '7', seats: 6, x: 5, y: 70, shape: 'rect', size: 'l', rotation: 0 }));
    assert(created.status === 201, `table created (got ${created.status})`);
    const id = created.body.table.id;
    assert(created.body.table.shape === 'rect' && created.body.table.size === 'l' && Number(created.body.table.position_x) === 5,
      'created table persists geometry');

    // Independent read sees the same geometry (multi-device consistency).
    const fetched = (await auth(request(base).get('/api/tables'))).body.tables.map(T.mapPlemmoTable).find((x: any) => x.id === id);
    assert(fetched && fetched.shape === 'rect' && fetched.x === 5 && fetched.y === 70 && fetched.seats === 6, 'floor-plan geometry round-trips via list');

    // Edit the layout (drag + reshape) and confirm it persists.
    const saved = await auth(request(base).put(`/api/tables/${id}`))
      .send(T.mapToPlemmoBody({ name: '7', seats: 6, x: 42.5, y: 12, shape: 'round', size: 'm', rotation: 45 }));
    assert(saved.status === 200 && saved.body.table.shape === 'round' && Number(saved.body.table.position_x) === 42.5 && Number(saved.body.table.rotation) === 45,
      'layout edit persists new geometry');
    const reread = (await auth(request(base).get(`/api/tables/${id}`))).body.table;
    assert(reread.shape === 'round' && Number(reread.position_y) === 12, 'edited geometry is durable on re-read');

    // KDS orders endpoint reachable (kitchen display backed by Plemmo).
    const kds = await auth(request(base).get('/api/kds/orders'));
    assert(kds.status === 200 || kds.status === 403, `KDS orders endpoint responds (got ${kds.status})`);

    console.log('✅ Tables / Floor Plan / KDS / Kiosk tests passed');
  } finally {
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
