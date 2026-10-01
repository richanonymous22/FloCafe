/**
 * Test: exact money (WP2) — main/core/money-integrity.ts + migration v97.
 *
 * Proves: (1) sums are exact, (2) the DB guards re-quantise any writer's
 * output for GBP / JPY / KWD, (3) the scanner really detects residue,
 * (4) the sale engine no longer accumulates float error, (5) the v96→v97
 * upgrade repairs existing data and keeps every row.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/money-integrity.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plemmo-money-int-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, getResults, closeDatabase, assert, assertEqual } = require('./helpers/test-setup');
const { initDatabase, getDatabase, now, MIGRATIONS } = require('../main/db');
const { createSale } = require('../main/core/sale');
const {
  MONEY_COLUMNS, quantiseMoney, sumMoney, minorSql, installMoneyGuards, dropMoneyGuards,
  repairMoneyColumns, scanMoneyIntegrity,
} = require('../main/core/money-integrity');

const USER_ID = 'user-money-1';
const setCurrency = (db: any, code: string) =>
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('currency', ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(code, now());
const addProduct = (db: any, id: string, price: number) =>
  db.prepare(`INSERT INTO products (id, category_id, name, price, sku, is_active, track_inventory, stock_quantity, created_at, updated_at)
              VALUES (?, 'cat-1', ?, ?, ?, 1, 0, 0, ?, ?)`).run(id, id, price, `SKU-${id}`, now(), now());
const priceOf = (db: any, id: string) => (db.prepare('SELECT price FROM products WHERE id = ?').get(id) as any).price;

async function main() {
  console.log('Test: exact money');
  console.log('='.repeat(50));
  const db = initTestDb();
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
              VALUES (?, 'Cashier', 'c@test.local', 'x', 'cashier', 1, ?, ?)`).run(USER_ID, now(), now());
  db.prepare(`INSERT INTO categories (id, name, created_at, updated_at) VALUES ('cat-1', 'Cat', ?, ?)`).run(now(), now());

  console.log('\n1. Helpers');
  assertEqual(0.1 + 0.2 === 0.3, false, 'sanity: plain double addition is inexact');
  assertEqual(sumMoney([0.1, 0.2]), 0.3, 'sumMoney(0.1, 0.2) is exactly 0.3');
  assertEqual(sumMoney([0.1, 0.2, 0.3]), 0.6, 'sumMoney(0.1, 0.2, 0.3) is exactly 0.6');
  assertEqual(sumMoney([19.99, -5.01]), 14.98, 'sumMoney handles negatives');
  assertEqual(sumMoney([]), 0, 'sumMoney of nothing is 0');
  assertEqual(quantiseMoney(1.005), 1.01, 'quantiseMoney rounds the written value half-up (1.005 -> 1.01)');
  assertEqual(quantiseMoney(12.5, 0), 13, 'JPY has no minor unit');
  assertEqual(sumMoney([1.234, 0.001], 3), 1.235, 'KWD keeps 3 decimals');
  assertEqual(minorSql('total'), 'CAST(ROUND(COALESCE(total, 0) * 100) AS INTEGER)', 'minorSql fragment');
  let threw = false;
  try { minorSql('total; DROP TABLE x'); } catch { threw = true; }
  assert(threw, 'minorSql rejects an unsafe column expression');
  threw = false;
  try { quantiseMoney(NaN); } catch { threw = true; }
  assert(threw, 'quantiseMoney rejects NaN');

  console.log('\n2. DB guards re-quantise any writer (GBP)');
  setCurrency(db, 'GBP');
  addProduct(db, 'p-dirty', 0.1 + 0.2);
  assertEqual(priceOf(db, 'p-dirty'), 0.3, 'INSERT of 0.30000000000000004 is stored as 0.3');
  db.prepare('UPDATE products SET price = ? WHERE id = ?').run(0.1 * 3, 'p-dirty');
  assertEqual(priceOf(db, 'p-dirty'), 0.3, 'UPDATE of 0.30000000000000004 is stored as 0.3');
  addProduct(db, 'p-clean', 12.35);
  assertEqual(priceOf(db, 'p-clean'), 12.35, 'an already-exact value is untouched');
  db.prepare('UPDATE products SET cost = NULL WHERE id = ?').run('p-clean');
  assertEqual((db.prepare('SELECT cost FROM products WHERE id = ?').get('p-clean') as any).cost, null, 'NULL stays NULL');
  assertEqual(scanMoneyIntegrity(db).length, 0, 'scan is clean after guarded writes');

  console.log('\n3. Other currencies use their own exponent');
  setCurrency(db, 'JPY');
  addProduct(db, 'p-jpy', 12.4);
  assertEqual(priceOf(db, 'p-jpy'), 12, 'JPY value quantised to whole yen');
  setCurrency(db, 'KWD');
  addProduct(db, 'p-kwd', 1.2346);
  assertEqual(priceOf(db, 'p-kwd'), 1.235, 'KWD value quantised to 3 decimals');
  setCurrency(db, 'GBP');

  console.log('\n4. Scanner detects residue; repair fixes it');
  dropMoneyGuards(db);
  addProduct(db, 'p-residue', 0.1 + 0.2);
  assertEqual(priceOf(db, 'p-residue'), 0.1 + 0.2, 'with guards removed the residue is stored (control)');
  const found = scanMoneyIntegrity(db);
  assert(found.some((v: any) => v.table === 'products' && v.column === 'price'), 'scan reports products.price');
  assert(repairMoneyColumns(db) >= 1, 'repair changes at least the dirty row');
  assertEqual(scanMoneyIntegrity(db).length, 0, 'scan is clean after repair');
  installMoneyGuards(db);
  installMoneyGuards(db); // idempotent
  const trig = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_money_q_%'").get() as any;
  assertEqual(trig.n, Object.keys(MONEY_COLUMNS).length * 2, 'two guard triggers per money table, none duplicated');

  console.log('\n5. Sale engine sums exactly');
  addProduct(db, 'p-a', 0.1);
  addProduct(db, 'p-b', 0.2);
  addProduct(db, 'p-c', 0.3);
  const res = createSale({
    channel: 'takeaway',
    lines: [{ product_id: 'p-a', quantity: 1 }, { product_id: 'p-b', quantity: 1 }, { product_id: 'p-c', quantity: 1 }],
    cashierUserId: USER_ID,
  });
  assertEqual(res.sale.subtotal, 0.6, '0.10 + 0.20 + 0.30 sale subtotal is exactly 0.6');
  assertEqual(res.sale.total, 0.6, 'sale total is exactly 0.6');
  const thirds = createSale({
    channel: 'takeaway',
    lines: [{ product_id: 'p-a', quantity: 3 }, { product_id: 'p-b', quantity: 7 }],
    cashierUserId: USER_ID,
  });
  assertEqual(thirds.sale.subtotal, 1.7, '3 x 0.10 + 7 x 0.20 is exactly 1.7');
  assertEqual(scanMoneyIntegrity(db).length, 0, 'no residue anywhere after sales');
  const sqlSum = (db.prepare(`SELECT SUM(${minorSql('total')}) AS m FROM orders`).get() as any).m;
  assertEqual(sqlSum, 60 + 170, 'SQL aggregation in minor units is an exact integer');

  console.log('\n6. Upgrade v96 -> v97 repairs data and keeps every row');
  dropMoneyGuards(db);
  addProduct(db, 'p-old', 0.1 + 0.2);
  const rowsBefore = (db.prepare('SELECT COUNT(*) AS n FROM products').get() as any).n;
  db.pragma('user_version = 96');
  closeDatabase();
  initDatabase();
  const db2 = getDatabase();
  assertEqual(db2.pragma('user_version', { simple: true }), MIGRATIONS[MIGRATIONS.length - 1].version, 'database is migrated to the latest version (v97 ran on the way)');
  assertEqual(priceOf(db2, 'p-old'), 0.3, 'pre-existing residue was repaired by the migration');
  assertEqual((db2.prepare('SELECT COUNT(*) AS n FROM products').get() as any).n, rowsBefore, 'no rows lost');
  assertEqual(scanMoneyIntegrity(db2).length, 0, 'scan clean after upgrade');
  const trig2 = db2.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_money_q_%'").get() as any;
  assertEqual(trig2.n, Object.keys(MONEY_COLUMNS).length * 2, 'guards reinstalled after upgrade');

  console.log('\n7. Property check: 150 random sales stay exact');
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const id = `p-rand-${i}`;
    addProduct(db2, id, Math.round(rnd() * 5000) / 100 + 0.01);
    ids.push(id);
  }
  let badSubtotal = 0; let badTotal = 0;
  for (let n = 0; n < 150; n++) {
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => ({
      product_id: ids[Math.floor(rnd() * ids.length)], quantity: 1 + Math.floor(rnd() * 9),
    }));
    const r = createSale({ channel: 'takeaway', lines, cashierUserId: USER_ID });
    const row = db2.prepare(`SELECT ${minorSql('subtotal')} AS s, ${minorSql('total')} AS t, ${minorSql('tax_amount')} AS x FROM orders WHERE id = ?`).get(r.sale.id) as any;
    const items = db2.prepare(`SELECT SUM(${minorSql('subtotal')}) AS s FROM order_items WHERE order_id = ?`).get(r.sale.id) as any;
    if (row.s !== items.s) badSubtotal++;
    if (row.t < row.s) badTotal++; // tax-exclusive totals can never be below the subtotal
  }
  assertEqual(badSubtotal, 0, 'order subtotal equals the sum of its line subtotals, in minor units, for every sale');
  assertEqual(badTotal, 0, 'order total is never below its subtotal');
  assertEqual(scanMoneyIntegrity(db2).length, 0, 'no residue after 150 random sales');

  closeDatabase();
  const results = getResults();
  console.log(`\n${results.failed === 0 ? '✅' : '❌'} ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
