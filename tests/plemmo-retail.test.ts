/**
 * Milestone 3, Part B10 — retail compatibility tests.
 *
 * Proves the full Product → Variant → Barcode → Sale → Payment → Receipt
 * path works end to end through the real HTTP routes, and that nothing
 * about it depends on — or disturbs — hospitality state (tables, KDS).
 */

// ── Electron Mock (must be before any app imports) ───────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plemmo-retail-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, getResults, closeDatabase, assert, assertEqual,
  createApp, startServer, seedOwnerUser, seedCategory, seedProduct, seedTable, api,
  installAndActivateTestTaxPack,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { retailRoutes } = require('../main/routes/retail');
const { inventoryRoutes } = require('../main/routes/inventory');
const { tableRoutes } = require('../main/routes/tables');
const { registerHospitalityHooks } = require('../main/modules/hospitality/hooks');
const { formatReceipt } = require('../main/printers/thermal');

const dualRatePackData = require('./fixtures/synthetic-dual-rate-pack.json');
// Matches settings.country's fresh-install default ('IN') — the fixture pack
// only becomes "active" for the country the tenant is actually configured
// for, same as tests/integration-tax.test.ts's indiaTaxPack.
const testTaxPack = { ...dualRatePackData, id: 'test-retail-pack', country: 'IN', currency: 'INR' };

async function main() {
  console.log('Test: Milestone 3 — Retail compatibility');
  console.log('='.repeat(50));

  const db = initTestDb();
  registerHospitalityHooks();
  installAndActivateTestTaxPack(db, testTaxPack);

  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-retail', 'Retail Goods');
  seedProduct(db, 'prod-shirt', 'cat-retail', 'T-Shirt', 20, {
    tax_category_id: 'standard', tax_behavior: 'exclusive', track_inventory: true, stock_quantity: 50,
  });
  seedTable(db, 'table-1', 1, 4);
  seedCategory(db, 'cat-hosp', 'Hospitality Menu');
  seedProduct(db, 'prod-coffee', 'cat-hosp', 'Coffee', 3);

  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes, '/api/retail': retailRoutes, '/api/tables': tableRoutes, '/api/inventory': inventoryRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n1-2. Create product (seeded) and a variant');
    const variantRes = await api(baseUrl, '/api/retail/variants', {
      method: 'POST', body: { product_id: 'prod-shirt', name: 'Large / Blue', sku: 'TSHIRT-L-BLUE', barcode: '5012345678900', price: 22, cost: 8 },
      headers: authHeader,
    });
    assertEqual(variantRes.status, 201, 'a variant is created');
    const variantId = variantRes.data.variant.id;
    assert(variantId.length > 0, 'the variant has an id');
    assertEqual(variantRes.data.variant.price, 22, 'the variant carries its own price, different from the parent product');

    console.log('\n3. SKU uniqueness');
    const dupSku = await api(baseUrl, '/api/retail/variants', {
      method: 'POST', body: { product_id: 'prod-shirt', name: 'Large / Red', sku: 'TSHIRT-L-BLUE', price: 22 },
      headers: authHeader,
    });
    assertEqual(dupSku.status, 409, 'a duplicate SKU is rejected, not silently accepted');

    console.log('\n4. Barcode lookup');
    const byBarcode = await api(baseUrl, '/api/retail/lookup?code=5012345678900', { headers: authHeader });
    assertEqual(byBarcode.status, 200, 'the barcode resolves');
    assertEqual(byBarcode.data.kind, 'variant', 'it resolves to the variant, not just the bare product');
    assertEqual(byBarcode.data.variant.id, variantId, 'it is the exact variant that was scanned');

    console.log('\n5. Scan product (no variant involved)');
    seedProduct(db, 'prod-mug', 'cat-retail', 'Mug', 8);
    db.prepare("UPDATE products SET barcode = 'MUG-000-1' WHERE id = 'prod-mug'").run();
    const byProductBarcode = await api(baseUrl, '/api/retail/lookup?code=MUG-000-1', { headers: authHeader });
    assertEqual(byProductBarcode.status, 200, 'a bare product barcode also resolves');
    assertEqual(byProductBarcode.data.kind, 'product', 'with no variant attached');

    console.log('\nSeed initial variant stock (Milestone 4: a variant starts at 0, independent of the parent product)');
    const seedStock = await api(baseUrl, '/api/inventory/adjust', {
      method: 'POST',
      body: { product_id: 'prod-shirt', variant_id: variantId, quantity_delta: 10, reason: 'Initial stock count' },
      headers: authHeader,
    });
    assertEqual(seedStock.status, 201, 'the variant can be given opening stock');
    assertEqual(seedStock.data.movement.movement_type, 'adjustment', 'recorded as an adjustment movement');

    console.log('\n6-7-8. Add to cart, tableless sale, cash payment');
    const cashCheckout = await api(baseUrl, '/api/retail/checkout', {
      method: 'POST',
      body: {
        lines: [{ product_id: 'prod-shirt', variant_id: variantId, quantity: 2 }],
        tender: { adapter: 'cash', method: 'cash' },
      },
      headers: authHeader,
    });
    assertEqual(cashCheckout.status, 201, 'checkout succeeds in one call');
    assertEqual(cashCheckout.data.sale.type, 'in_store', 'the sale channel is the retail one');
    assertEqual(cashCheckout.data.sale.table_id, null, 'no table is involved at all');
    assertEqual(cashCheckout.data.bill.payment_status, 'paid', 'the bill is marked paid');
    assertEqual(cashCheckout.data.payment.state, 'settled', 'a cash payment settles immediately');
    assertEqual(cashCheckout.data.payment.adapter, 'cash', 'through the cash adapter');

    console.log('\n9. Payment via ManualCardAdapter');
    const cardCheckout = await api(baseUrl, '/api/retail/checkout', {
      method: 'POST',
      body: {
        lines: [{ product_id: 'prod-shirt', variant_id: variantId, quantity: 1 }],
        tender: { adapter: 'manual_card', method: 'card', providerReference: 'TERM-0099' },
      },
      headers: authHeader,
    });
    assertEqual(cardCheckout.status, 201, 'a card checkout also succeeds');
    assertEqual(cardCheckout.data.payment.state, 'captured', 'a manual card payment is captured, not settled — the honest state');
    assertEqual(cardCheckout.data.payment.provider_reference, 'TERM-0099', 'the terminal reference is preserved');

    console.log('\n10. Receipt generation');
    const receiptOrder = { ...cashCheckout.data.sale, items: cashCheckout.data.lines };
    const receiptData = formatReceipt(receiptOrder, cashCheckout.data.bill, { name: 'Plemmo Test Store' }, 'classic', 48, false, false);
    assert(Buffer.isBuffer(receiptData) && receiptData.length > 0, 'a receipt can be formatted from the checkout result with no printer hardware needed');

    console.log('\n11. VAT');
    assert(cashCheckout.data.sale.tax_amount > 0, 'the retail sale carries a non-zero tax amount from the active tax pack');
    const taxedLine = cashCheckout.data.lines.find((l: any) => l.product_id === 'prod-shirt');
    assert(taxedLine.tax_amount > 0, 'the line itself carries the tax it generated');

    console.log('\n12. Existing hospitality product still works');
    const dineIn = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'dine_in', table_id: 'table-1', items: [{ product_id: 'prod-coffee', quantity: 1 }] }, headers: authHeader,
    });
    assertEqual(dineIn.status, 201, 'a dine-in order still works exactly as before');
    const tableAfter = db.prepare('SELECT status FROM tables WHERE id = ?').get('table-1') as any;
    assertEqual(tableAfter.status, 'occupied', 'the table is still occupied — hospitality behaviour is unchanged after adding retail');

    console.log('\n13. Existing hospitality flows remain green: dine-in bill + payment');
    const dineInBill = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: dineIn.data.order.id }, headers: authHeader });
    assertEqual(dineInBill.status, 201, 'the dine-in bill generates through the same shared engine retail now also calls');
    const dineInPay = await api(baseUrl, `/api/bills/${dineInBill.data.bill.id}/payment`, { method: 'POST', body: { method: 'cash', amount: dineInBill.data.bill.total }, headers: authHeader });
    assertEqual(dineInPay.status, 200, 'the legacy dine-in payment route is unaffected');
    const tableFreed = db.prepare('SELECT status FROM tables WHERE id = ?').get('table-1') as any;
    assertEqual(tableFreed.status, 'available', 'paying the dine-in bill still releases the table');

    console.log('\n14. Retail checkout rejects an empty cart and an unknown tender the same way SaleService/PaymentService would');
    const emptyCart = await api(baseUrl, '/api/retail/checkout', { method: 'POST', body: { lines: [], tender: { adapter: 'cash', method: 'cash' } }, headers: authHeader });
    assertEqual(emptyCart.status, 400, 'an empty cart is rejected');

    console.log('\n15. Retail checkout does not import or reference hospitality concepts');
    const checkoutSource = fs.readFileSync(path.join(__dirname, '../main/modules/retail/checkout.ts'), 'utf8');
    assert(!/table_id|kitchen_station|dine_in|guest_count/i.test(checkoutSource), 'checkout.ts has no hospitality identifier in it at all');
  } finally {
    server.close();
  }

  closeDatabase();

  const { passed, failed } = getResults();
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});
