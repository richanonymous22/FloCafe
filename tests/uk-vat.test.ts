/**
 * UK VAT (bundled GB pack) — standard 20%, reduced 5%, zero, exempt; prices VAT-inclusive.
 * Exercises the real sale engine and the migration that registers the pack offline.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/uk-vat.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plemmo-uk-vat-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, getResults, closeDatabase, assert, assertEqual } = require('./helpers/test-setup');
const { createSale } = require('../main/core/sale');
const { now, getDatabase, upsertSettings } = require('../main/db');
const { getActiveCountryPack } = require('../main/services/tax');

const USER_ID = 'user-vat-1';
const addProduct = (db: any, id: string, price: number, cat: string | null) =>
  db.prepare(`INSERT INTO products (id, category_id, name, price, sku, is_active, track_inventory, stock_quantity, tax_category_id, tax_behavior, created_at, updated_at)
              VALUES (?, 'cat-1', ?, ?, ?, 1, 0, 0, ?, 'country_default', ?, ?)`).run(id, id, price, `SKU-${id}`, cat, now(), now());

async function main() {
  console.log('Test: UK VAT');
  console.log('='.repeat(50));
  const db = initTestDb();
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
              VALUES (?, 'Cashier', 'c@test.local', 'x', 'cashier', 1, ?, ?)`).run(USER_ID, now(), now());
  db.prepare(`INSERT INTO categories (id, name, created_at, updated_at) VALUES ('cat-1', 'Cat', ?, ?)`).run(now(), now());
  upsertSettings({ country: 'GB', currency: 'GBP', business_type: 'retail', taxes_enabled: 'true' });

  console.log('\n1. the pack is registered offline and active for GB');
  const pack = getActiveCountryPack('GB');
  assertEqual(pack.id, 'meridian-gb-vat', 'the active GB pack is the bundled UK VAT pack');
  assertEqual(pack.inclusivePricingDefault, true, 'prices are VAT-inclusive by default');
  assertEqual(pack.rules.find((r: any) => r.id === 'vat-standard').rate, '20', 'standard rate is 20%');
  assertEqual(pack.rules.find((r: any) => r.id === 'vat-reduced').rate, '5', 'reduced rate is 5%');
  assert(pack.categories.some((c: any) => c.id === 'zero') && pack.categories.some((c: any) => c.id === 'exempt'), 'zero-rated and exempt categories exist');
  const row = db.prepare("SELECT status, active_version_id FROM country_packs WHERE country = 'GB'").get() as any;
  assert(row && row.status === 'active' && /^meridian-gb-vat@/.test(row.active_version_id), 'registered in country_packs by the migration');

  console.log('\n2. each rate, VAT-inclusive');
  addProduct(db, 'std', 12.00, 'standard');
  addProduct(db, 'red', 10.50, 'reduced');
  addProduct(db, 'zro', 5.00, 'zero');
  addProduct(db, 'exm', 7.00, 'exempt');
  const one = (pid: string, qty = 1) => createSale({ channel: 'takeaway', lines: [{ product_id: pid, quantity: qty }], cashierUserId: USER_ID }).sale;
  const s1 = one('std');
  assertEqual(s1.total, 12, 'standard: customer pays 12.00');
  assertEqual(s1.tax_amount, 2, 'standard: 12.00 includes 2.00 VAT (20%)');
  const s2 = one('red');
  assertEqual(s2.total, 10.5, 'reduced: customer pays 10.50');
  assertEqual(s2.tax_amount, 0.5, 'reduced: 10.50 includes 0.50 VAT (5%)');
  const s3 = one('zro');
  assertEqual(s3.total, 5, 'zero rate: 5.00');
  assertEqual(s3.tax_amount, 0, 'zero rate: no VAT');
  const s4 = one('exm');
  assertEqual(s4.total, 7, 'exempt: 7.00');
  assertEqual(s4.tax_amount, 0, 'exempt: no VAT');

  console.log('\n3. mixed basket — VAT is computed per rate on the document and totals do not change');
  const mixed = createSale({ channel: 'takeaway', cashierUserId: USER_ID, lines: [
    { product_id: 'std', quantity: 1 }, { product_id: 'red', quantity: 1 }, { product_id: 'zro', quantity: 2 }, { product_id: 'exm', quantity: 1 },
  ] }).sale;
  assertEqual(mixed.total, 12 + 10.5 + 10 + 7, 'total is the sum of the shelf prices (39.50)');
  assertEqual(mixed.tax_amount, 2.5, 'VAT = 2.00 + 0.50 = 2.50');
  const raw = typeof mixed.tax_breakdown === 'string' ? JSON.parse(mixed.tax_breakdown || '[]') : (mixed.tax_breakdown || []);
  const breakdown = raw.flat();
  const byLabel = (l: string) => breakdown.filter((b: any) => b.title === l).reduce((s: number, b: any) => s + Number(b.amount || 0), 0);
  assertEqual(Math.round(byLabel('VAT 20%') * 100), 200, 'breakdown: VAT 20% = 2.00');
  assertEqual(Math.round(byLabel('VAT 5%') * 100), 50, 'breakdown: VAT 5% = 0.50');
  assert(breakdown.some((b: any) => b.title === 'VAT 0%') && breakdown.some((b: any) => b.title === 'VAT exempt'), 'zero-rated and exempt sales appear as their own lines (needed for the VAT return)');

  console.log('\n4. awkward pennies stay exact');
  addProduct(db, 'odd', 7.99, 'standard');
  const odd = one('odd', 3); // 23.97 incl VAT => 3.995 -> 4.00 (half-up on the document)
  assertEqual(odd.total, 23.97, 'total is exactly 23.97');
  assertEqual(odd.tax_amount, 4, 'VAT on 23.97 at 20% is 4.00 (23.97 - 23.97/1.2 = 3.995, rounded half-up)');
  assertEqual(Math.round((odd.total - odd.tax_amount) * 100), 1997, 'net + VAT adds back to the gross to the penny');

  console.log('\n5. an unclassified product is never charged VAT silently');
  addProduct(db, 'unc', 10, null);
  const unc = one('unc');
  assertEqual(unc.tax_amount, 0, 'no category -> no VAT (the existing safety invariant)');

  console.log('\n6. not VAT-registered: no VAT at all');
  upsertSettings({ taxes_enabled: 'false' });
  const nv = one('std');
  assertEqual(nv.tax_amount, 0, 'taxes off: 12.00 carries no VAT');
  assertEqual(nv.total, 12, 'and the total is the shelf price');
  upsertSettings({ taxes_enabled: 'true' });

  closeDatabase();
  const results = getResults();
  console.log(`\n${results.failed === 0 ? '✅' : '❌'} ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
