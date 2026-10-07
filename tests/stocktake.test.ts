/*
 * Stocktakes, stock valuation and stock import — through the real API and the real ledger.
 *
 * A stocktake is counted (typed and scanned), reviewed as a variance report and approved into exactly one
 * ledger adjustment per counted line. Sales made while counting must survive approval; a correction can
 * never take stock below zero; an approved stocktake is final. Valuation is ledger balance × cost. A stock
 * import is validated whole (any bad row refuses the file), can be dry-run, and is exactly-once.
 */
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-stocktake-'));
Module._load = function (requestName: string) {
  if (requestName === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

import { startServer, stopServer, getServerPort } from '../main/server';
import { initDatabase, closeDatabase, getDatabase } from '../main/db';
import { adjustStock, getBalance } from '../main/core/inventory';

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
  passed++;
  console.log(`  ✓ ${msg}`);
}
const now = () => new Date().toISOString();

async function run() {
  console.log('Testing stocktakes, valuation and stock import...');
  initDatabase();
  const db = getDatabase();
  const bcrypt = require('bcryptjs');
  const pw = bcrypt.hashSync('Passw0rd!x', 10);
  const user = (id: string, role: string) =>
    db.prepare(`INSERT INTO users (id, name, email, password, role, pin_hash, is_active) VALUES (?,?,?,?,?,NULL,1)`).run(id, id, `${id}@till.local`, pw, role);
  user('u-own', 'owner'); user('u-mgr', 'manager'); user('u-cash', 'cashier');
  const { grantLocationAccess } = require('../main/core/employee-access');
  const { getCurrentLocationId } = require('../main/core/location');
  grantLocationAccess('u-cash', getCurrentLocationId());
  const setting = (k: string, v: string) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
  setting('currency', 'GBP');
  for (const [id, name] of [['catA', 'Hardware'], ['catB', 'Sundries']]) db.prepare(`INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES (?,?,1,1,?,?)`).run(id, name, now(), now());
  const prod = (id: string, name: string, cat: string, cost: number, stock: number, track: number, barcode: string | null, sku: string) =>
    db.prepare(`INSERT INTO products (id, category_id, name, price, cost, sku, barcode, is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
                VALUES (?, ?, ?, 10, ?, ?, ?, 1, 1, ?, ?, 0, ?, ?)`).run(id, cat, name, cost, sku, barcode, track, stock, now(), now());
  prod('p1', 'Widget', 'catA', 2.5, 10, 1, 'W1', 'S1');
  prod('p2', 'Gadget', 'catA', 4, 5, 1, 'G1', 'S2');
  prod('p3', 'Gizmo', 'catB', 1, 3, 1, 'Z1', 'S3');
  prod('p4', 'Service', 'catB', 0, 0, 0, null, 'S4');
  prod('p5', 'Shirt', 'catA', 6, 0, 1, null, 'S5');
  for (const [vid, name, sku, bc] of [['v-s', 'Small', 'SH-S', 'SHS'], ['v-m', 'Medium', 'SH-M', 'SHM']]) {
    db.prepare(`INSERT INTO product_variants (id, product_id, name, sku, barcode, price, cost, is_default, is_active, sort_order, created_at, updated_at) VALUES (?, 'p5', ?, ?, ?, 20, 6, 0, 1, 1, ?, ?)`).run(vid, name, sku, bc, now(), now());
  }
  adjustStock({ productId: 'p5', variantId: 'v-s', quantityDelta: 6, reason: 'Opening', movementType: 'receipt' });
  adjustStock({ productId: 'p5', variantId: 'v-m', quantityDelta: 4, reason: 'Opening', movementType: 'receipt' });

  await startServer();
  const base = `http://127.0.0.1:${getServerPort()}`;
  try {
    const login = async (id: string) => (await request(base).post('/api/auth/login').send({ email: `${id}@till.local`, password: 'Passw0rd!x' })).body.access_token as string;
    const T = { own: await login('u-own'), mgr: await login('u-mgr'), cash: await login('u-cash') };
    const as = (t: string) => (r: any) => r.set('Authorization', `Bearer ${t}`);
    const api = (tok: string, method: 'get' | 'post' | 'put', p: string, body?: any) => { const r = as(tok)((request(base) as any)[method](p)); return body === undefined ? r : r.send(body); };
    const line = (st: any, id: string, variant: string | null = null) => st.lines.find((l: any) => l.product_id === id && l.product_variant_id === variant);

    console.log('\n1. starting a stocktake');
    ok((await api(T.cash, 'post', '/api/stocktakes', {})).status === 403, 'a cashier cannot start a stocktake');
    const start = await api(T.mgr, 'post', '/api/stocktakes', { name: 'March count' });
    ok(start.status === 201 && start.body.stocktake.number === 1 && start.body.stocktake.name === 'March count' && start.body.stocktake.status === 'counting', 'a manager starts stocktake 1');
    ok(start.body.lines.length === 5, 'a line for each tracked item and variant: Widget, Gadget, Gizmo, Shirt Small, Shirt Medium (the untracked Service is left out)');
    ok(line(start.body, 'p1').expected === 10 && line(start.body, 'p5', 'v-s').expected === 6 && line(start.body, 'p5', 'v-m').expected === 4, 'expected quantities come from the ledger');
    ok(start.body.summary.uncounted === 5 && start.body.summary.counted === 0, 'nothing is counted yet');
    ok((await api(T.mgr, 'post', '/api/stocktakes', {})).status === 409, 'a second stocktake cannot be started while one is open');
    const id = start.body.stocktake.id as string;

    console.log('\n2. counting by typing and scanning');
    const c1 = await api(T.mgr, 'put', `/api/stocktakes/${id}/lines`, { product_id: 'p1', quantity: 8, mode: 'set' });
    ok(c1.status === 200 && c1.body.line.counted === 8 && c1.body.line.variance === -2 && c1.body.line.variance_value_minor === -500, 'Widget counted 8 of 10: 2 short, £5.00 at cost');
    const s1 = await api(T.mgr, 'post', `/api/stocktakes/${id}/scan`, { code: 'W1' });
    ok(s1.status === 200 && s1.body.line.counted === 9 && s1.body.line.variance === -1, 'scanning the Widget barcode adds one (9)');
    const s2 = await api(T.mgr, 'post', `/api/stocktakes/${id}/scan`, { code: 'G1' });
    const s3 = await api(T.mgr, 'post', `/api/stocktakes/${id}/scan`, { code: 'G1', quantity: 1 });
    ok(s2.body.line.counted === 1 && s3.body.line.counted === 2, 'scanning the Gadget barcode twice counts 2');
    ok((await api(T.mgr, 'post', `/api/stocktakes/${id}/scan`, { code: 'S3' })).body.line.counted === 1, 'a typed SKU works like a scan');
    await api(T.mgr, 'put', `/api/stocktakes/${id}/lines`, { product_id: 'p3', quantity: 5, mode: 'set' });
    ok(line((await api(T.mgr, 'get', `/api/stocktakes/${id}`)).body, 'p3').variance === 2, 'Gizmo counted 5 of 3: 2 over (a re-count replaces the earlier one)');
    const sv = await api(T.mgr, 'post', `/api/stocktakes/${id}/scan`, { code: 'SHM', quantity: 3 });
    ok(sv.body.line.product_variant_id === 'v-m' && sv.body.line.counted === 3 && sv.body.line.variance === -1, 'a variant barcode counts that variant (Medium 3 of 4)');
    const unk = await api(T.mgr, 'post', `/api/stocktakes/${id}/scan`, { code: 'NOPE' });
    ok(unk.status === 404 && unk.body.code === 'unknown_code', 'an unknown code is refused with a clear message');
    ok((await api(T.mgr, 'put', `/api/stocktakes/${id}/lines`, { product_id: 'p1', quantity: -1 })).status === 400, 'a negative count is refused');
    ok((await api(T.mgr, 'put', `/api/stocktakes/${id}/lines`, { product_id: 'p4', quantity: 1 })).status === 404, 'an item that is not part of the stocktake is refused');
    ok((await api(T.cash, 'get', `/api/stocktakes/${id}`)).status === 403, 'a cashier cannot read it either');

    console.log('\n3. a sale made while counting is not overwritten');
    adjustStock({ productId: 'p2', quantityDelta: -2, reason: 'Sale while counting', movementType: 'adjustment' });
    ok(getBalance('p2') === 3, 'two Gadgets sold after they were counted: ledger says 3');

    console.log('\n4. the variance report');
    const review = (await api(T.mgr, 'get', `/api/stocktakes/${id}`)).body;
    const S = review.summary;
    ok(S.lines === 5 && S.counted === 4 && S.uncounted === 1, '5 lines: 4 counted, 1 not counted (Shirt Small)');
    ok(S.short === 3 && S.over === 1 && S.matching === 0, '3 short, 1 over');
    ok(S.variance_units === -3, 'net variance is 3 units short: −1 Widget, −3 Gadget, +2 Gizmo, −1 Shirt Medium');
    ok(S.over_value_minor === 200 && S.short_value_minor === -(250 + 3 * 400 + 600), 'values at cost: over £2.00; short £2.50 + £12.00 + £6.00');
    ok(S.variance_value_minor === 200 - (250 + 1200 + 600), 'net variance value is exact');

    console.log('\n5. approving posts one adjustment per counted line');
    ok((await api(T.cash, 'post', `/api/stocktakes/${id}/approve`, {})).status === 403, 'a cashier cannot approve');
    const ap = await api(T.mgr, 'post', `/api/stocktakes/${id}/approve`, { note: 'March' });
    ok(ap.status === 200 && ap.body.stocktake.status === 'approved' && ap.body.adjustments === 4, 'approved: 4 adjustments (Widget, Gadget, Gizmo, Shirt Medium)');
    ok(getBalance('p1') === 9, 'Widget 10 → 9 (counted 9)');
    ok(getBalance('p2') === 0, 'Gadget: counted 2 when 5 were on hand (3 missing), then 2 sold → 0, not the stale 2');
    ok(getBalance('p3') === 5, 'Gizmo 3 → 5');
    ok(getBalance('p5', 'v-m') === 3 && getBalance('p5', 'v-s') === 6, 'Shirt Medium 4 → 3; Shirt Small (uncounted) untouched');
    const mv = db.prepare(`SELECT COUNT(*) AS n FROM inventory_movements WHERE reason LIKE 'Stocktake 1%'`).get() as { n: number };
    ok(mv.n === 4, 'the ledger has exactly four stocktake movements, each with the reason');
    const audit = db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'stock.counted'`).get() as { n: number };
    ok(audit.n === 2, 'started and approved are both audited');
    ok((await api(T.mgr, 'post', `/api/stocktakes/${id}/approve`, {})).status === 409, 'it cannot be approved twice');
    ok((await api(T.mgr, 'put', `/api/stocktakes/${id}/lines`, { product_id: 'p1', quantity: 1 })).status === 409, 'it can no longer be counted');
    ok((await api(T.mgr, 'post', `/api/stocktakes/${id}/cancel`, {})).status === 409, 'or cancelled');
    ok(getBalance('p1') === 9 && getBalance('p2') === 0, 'and the refused calls changed no stock');
    const hist = (await api(T.mgr, 'get', '/api/stocktakes')).body.stocktakes;
    ok(hist.length === 1 && hist[0].status === 'approved' && hist[0].summary.counted === 4, 'history lists it with its summary');

    console.log('\n6. cancel, category scope, uncounted → zero, and the clamp');
    const st2 = await api(T.mgr, 'post', '/api/stocktakes', { category_ids: ['catB'] });
    ok(st2.status === 201 && st2.body.lines.length === 1 && st2.body.lines[0].product_id === 'p3' && st2.body.stocktake.number === 2, 'a stocktake limited to Sundries counts only Gizmo');
    await api(T.mgr, 'put', `/api/stocktakes/${st2.body.stocktake.id}/lines`, { product_id: 'p3', quantity: 1 });
    const cn = await api(T.mgr, 'post', `/api/stocktakes/${st2.body.stocktake.id}/cancel`, {});
    ok(cn.status === 200 && cn.body.stocktake.status === 'cancelled' && getBalance('p3') === 5, 'a cancelled stocktake posts nothing');
    const st3 = await api(T.mgr, 'post', '/api/stocktakes', { category_ids: ['catB'] });
    const id3 = st3.body.stocktake.id as string;
    ok((await api(T.mgr, 'post', `/api/stocktakes/${id3}/approve`, {})).status === 409, 'approving with nothing counted is refused');
    const z = await api(T.mgr, 'post', `/api/stocktakes/${id3}/approve`, { uncounted: 'zero' });
    ok(z.status === 200 && getBalance('p3') === 0 && z.body.adjustments === 1, 'uncounted → zero writes the shelf off (Gizmo 5 → 0)');
    const st4 = await api(T.mgr, 'post', '/api/stocktakes', { category_ids: ['catA'] });
    const id4 = st4.body.stocktake.id as string;
    await api(T.mgr, 'put', `/api/stocktakes/${id4}/lines`, { product_id: 'p1', quantity: 0 });
    adjustStock({ productId: 'p1', quantityDelta: -5, reason: 'Sold after the count', movementType: 'adjustment' });
    const ap4 = await api(T.mgr, 'post', `/api/stocktakes/${id4}/approve`, {});
    ok(ap4.status === 200 && getBalance('p1') === 0, 'a correction that would go below zero is clamped to zero, not refused');
    ok(line(ap4.body, 'p1').clamped === true && line(ap4.body, 'p1').applied_delta === -4, 'and the line says it was clamped (−4 applied, not −9)');

    console.log('\n7. valuation');
    adjustStock({ productId: 'p1', quantityDelta: 4, reason: 'Delivery', movementType: 'receipt' });
    adjustStock({ productId: 'p3', quantityDelta: 10, reason: 'Delivery', movementType: 'receipt' });
    const val = (await api(T.mgr, 'get', '/api/inventory/valuation')).body.valuation;
    // Widget 4 × 2.50 = 10.00; Gadget 0; Gizmo 10 × 1.00 = 10.00; Shirt S 6 × 6 + M 3 × 6 = 54.00
    ok(val.total_minor === 1000 + 1000 + 5400 && val.total_units === 4 + 0 + 10 + 9, 'total value £74.00 on 23 units: ledger balance × cost');
    ok(val.rows.length === 5 && !val.rows.some((r: any) => r.product_id === 'p4'), 'one row per tracked item or variant; the Service is not stock');
    const hw = val.by_category.find((c: any) => c.category === 'Hardware');
    ok(hw && hw.value_minor === 1000 + 5400 && val.by_category.find((c: any) => c.category === 'Sundries').value_minor === 1000, 'by category: Hardware £64.00, Sundries £10.00');
    ok((await api(T.cash, 'get', '/api/inventory/valuation')).status === 200, 'a cashier may read stock values (inventory.view)');
    const vcsv = await api(T.mgr, 'get', '/api/inventory/valuation/csv');
    ok(vcsv.status === 200 && /text\/csv/.test(vcsv.headers['content-type']) && vcsv.text.split('\r\n')[0] === 'SKU,Item,Category,Quantity,Unit cost,Value', 'valuation CSV downloads with its header');
    ok(/\r\nS1,Widget,Hardware,4,2\.50,10\.00\r\n/.test(vcsv.text) && /,Total,,23,,74\.00\r\n$/.test(vcsv.text), 'valuation CSV rows and total are exact');

    console.log('\n8. stock import (CSV)');
    const imp = (tok: string, body: any) => api(tok, 'post', '/api/inventory/import', body);
    ok((await imp(T.cash, { csv: 'sku,quantity\nS1,5', mode: 'set' })).status === 403, 'a cashier cannot import stock');
    const dry = await imp(T.mgr, { csv: 'sku,quantity\nS1,6\nS2,0\nNOPE,3\nS3,abc\nS4,2\nS1,9', mode: 'set' });
    const R = dry.body.report;
    ok(dry.status === 200 && R.dry_run && !R.applied, 'a dry run is the default and applies nothing');
    ok(R.rows[0].status === 'ok' && R.rows[0].current === 4 && R.rows[0].new_quantity === 6 && R.rows[0].delta === 2, 'row 2 (Widget): 4 → 6');
    ok(R.rows[1].status === 'unchanged', 'row 3 (Gadget 0 → 0) is unchanged');
    ok(/No item has this SKU/.test(R.rows[2].error) && /not a number/.test(R.rows[3].error) && /switched off/.test(R.rows[4].error) && /more than once/.test(R.rows[5].error), 'rows 4–7 say exactly what is wrong');
    ok(R.errors === 4 && R.ok === 1 && getBalance('p1') === 4, 'four errors; the dry run changed no stock');
    const bad = await imp(T.mgr, { csv: 'sku,quantity\nS1,6\nNOPE,3', mode: 'set', dry_run: false, import_id: 'imp-bad-0001' });
    ok(bad.status === 422 && getBalance('p1') === 4, 'applying a file with any bad row is refused whole: even the valid row is not applied');
    ok((await imp(T.mgr, { csv: 'sku,quantity\nS1,6', mode: 'set', dry_run: false })).status === 400, 'applying needs an import_id');
    ok((await imp(T.mgr, { csv: 'name,qty\nx,1', mode: 'set' })).status === 400, 'a file without the right columns is refused');
    const good = 'barcode,quantity,reason\nW1,6,Recount\nG1,12,';
    const a1 = await imp(T.mgr, { csv: good, mode: 'set', dry_run: false, import_id: 'imp-set-0001' });
    ok(a1.status === 200 && a1.body.report.applied && a1.body.report.adjustments === 2 && getBalance('p1') === 6 && getBalance('p2') === 12, 'a valid file is applied: Widget 6, Gadget 12');
    const a2 = await imp(T.mgr, { csv: good, mode: 'set', dry_run: false, import_id: 'imp-set-0002' });
    ok(a2.body.report.adjustments === 0 && a2.body.report.unchanged === 2 && getBalance('p1') === 6, 're-importing the same set file changes nothing (idempotent)');
    const add = 'sku,quantity\nS1,10\nSH-S,5';
    const b1 = await imp(T.mgr, { csv: add, mode: 'add', dry_run: false, import_id: 'imp-add-0001' });
    ok(b1.status === 200 && getBalance('p1') === 16 && getBalance('p5', 'v-s') === 11, 'add mode adds what arrived (Widget +10, Shirt Small +5 by its variant SKU)');
    await imp(T.mgr, { csv: add, mode: 'add', dry_run: false, import_id: 'imp-add-0001' });
    ok(getBalance('p1') === 16 && getBalance('p5', 'v-s') === 11, 'repeating an add import with the same id applies nothing a second time');
    const recv = db.prepare(`SELECT COUNT(*) AS n FROM inventory_movements WHERE movement_type = 'receipt' AND reason LIKE 'Import%'`).get() as { n: number };
    ok(recv.n === 2, 'add-mode rows are recorded as receipts with an Import reason');
    ok((await imp(T.mgr, { csv: 'sku,quantity\nS2,-50', mode: 'add' })).body.report.rows[0].error.includes('below zero'), 'an add that would take stock below zero is flagged');

    console.log('\n9. upgrade v100 → v101 keeps all data and adds the stocktake tables');
    const movements = (db.prepare('SELECT COUNT(*) AS n FROM inventory_movements').get() as { n: number }).n;
    const products = (db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n;
    stopServer();
    db.exec('DROP TABLE stocktake_lines; DROP TABLE stocktakes;');
    db.pragma('user_version = 100');
    closeDatabase();
    initDatabase();
    const db2 = getDatabase();
    ok(db2.pragma('user_version', { simple: true }) >= 101, 'database migrated to v101 or later');
    ok(!!db2.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='stocktake_lines'").get() && !!db2.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='stocktakes'").get(), 'stocktakes and stocktake_lines exist again');
    ok((db2.prepare('SELECT COUNT(*) AS n FROM inventory_movements').get() as { n: number }).n === movements && (db2.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n === products, 'no inventory movement or product was lost');

    console.log(`\n✅ Stocktakes, valuation and stock import passed (${passed} checks)`);
  } finally {
    stopServer();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
