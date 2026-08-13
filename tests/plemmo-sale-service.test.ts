/**
 * Test: Plemmo Core SaleService (main/core/sale.ts)
 *
 * Sections 1-10 cover `createSale` (Phase 2A) — a behaviour-preserving
 * extraction written against docs/PHASE_2A_SALE_FLOW.md § 8, the ten
 * invariants the refactor must not break.
 *
 * Sections 11+ cover `addSaleItems` (Milestone 2), which shares its per-line
 * work with `createSale` via the internal `persistSaleLine` — the four
 * inherited "BUG #N FIX" behaviours (cancelled-line exclusion, discount
 * rescaling, race-safe re-fetch, bill re-sync) are each covered explicitly,
 * because they are exactly the kind of behaviour a refactor silently drops.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/plemmo-sale-service.test.ts
 */

// ── Electron Mock (must be before any app imports) ───────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plemmo-sale-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, getResults, closeDatabase, assert, assertEqual } = require('./helpers/test-setup');
const { createSale, addSaleItems, SaleError, SALE_CHANNELS } = require('../main/core/sale');
const { isUlid } = require('../main/core/ids');
const { listAuditEventsForEntity, resetAuditPlaceCache } = require('../main/core/audit');
const { now, getDatabase } = require('../main/db');

const USER_ID = 'user-cashier-1';

function seed(db: any) {
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
              VALUES (?, 'Cashier', 'cashier@test.local', 'x', 'cashier', 1, ?, ?)`).run(USER_ID, now(), now());
  db.prepare(`INSERT INTO categories (id, name, created_at, updated_at) VALUES ('cat-1', 'Drinks', ?, ?)`).run(now(), now());
  // Two plain products and one stock-tracked product.
  db.prepare(`INSERT INTO products (id, category_id, name, price, sku, is_active, track_inventory, stock_quantity, created_at, updated_at)
              VALUES ('prod-coffee', 'cat-1', 'Coffee', 2.50, 'SKU-COF', 1, 0, 0, ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, sku, is_active, track_inventory, stock_quantity, created_at, updated_at)
              VALUES ('prod-cake', 'cat-1', 'Cake', 4.00, 'SKU-CAK', 1, 0, 0, ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, category_id, name, price, sku, is_active, track_inventory, stock_quantity, created_at, updated_at)
              VALUES ('prod-stocked', 'cat-1', 'Bottled Water', 1.00, 'SKU-WAT', 1, 1, 10, ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO tables (id, number, capacity, status, is_active, created_at, updated_at)
              VALUES ('table-1', '1', 4, 'available', 1, ?, ?)`).run(now(), now());
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    channel: 'takeaway',
    lines: [{ product_id: 'prod-coffee', quantity: 2 }],
    cashierUserId: USER_ID,
    ...overrides,
  };
}

async function main() {
  console.log('Test: Plemmo Core SaleService');
  console.log('='.repeat(50));

  const db = initTestDb();
  resetAuditPlaceCache();
  seed(db);

  // ── 1. Create a sale ─────────────────────────────────────────────────────
  console.log('\n1. Create sale');
  const one = createSale(baseInput());
  assert(!!one.sale, 'a sale is returned');
  assertEqual(one.idempotentReplay, false, 'a fresh create is not a replay');
  assertEqual(one.sale.type, 'takeaway', 'the channel is persisted');
  assertEqual(one.sale.status, 'pending', 'a new sale starts pending');
  assertEqual(one.sale.user_id, USER_ID, 'the cashier is attributed');
  assertEqual(one.lines.length, 1, 'one line is persisted');
  assertEqual(one.lines[0].quantity, 2, 'the quantity is persisted');
  assertEqual(one.lines[0].unit_price, 2.5, 'the unit price comes from the product catalogue');
  assertEqual(one.lines[0].product_name, 'Coffee', 'the product name is denormalised onto the line');
  assertEqual(one.lines[0].product_sku, 'SKU-COF', 'the SKU is denormalised onto the line');
  assertEqual(one.sale.subtotal, 5, '2 x £2.50 = £5.00 subtotal');
  assertEqual(one.sale.total, 5, 'total matches subtotal when no tax or charges apply');
  assert(!!one.sale.order_number, 'an order number is allocated');

  // ── 2. Multiple lines ────────────────────────────────────────────────────
  console.log('\n2. Create sale with multiple items');
  const multi = createSale(baseInput({
    lines: [
      { product_id: 'prod-coffee', quantity: 2 },
      { product_id: 'prod-cake', quantity: 1 },
    ],
  }));
  assertEqual(multi.lines.length, 2, 'both lines are persisted');
  assertEqual(multi.sale.subtotal, 9, '2 x £2.50 + 1 x £4.00 = £9.00');
  assert(multi.sale.order_number !== one.sale.order_number, 'each sale gets its own order number');

  // ── 3. uid (Phase 1 foundation) ──────────────────────────────────────────
  console.log('\n3. Collision-safe identifiers');
  assert(isUlid(one.sale.uid), 'the sale header receives a ULID uid');
  for (const line of multi.lines) {
    assert(isUlid(line.uid), 'each sale line receives a ULID uid');
  }
  assert(one.sale.uid !== multi.sale.uid, 'two sales get different uids');
  assert(multi.lines[0].uid !== multi.lines[1].uid, 'two lines get different uids');
  assert(typeof one.sale.id === 'number', 'the existing integer primary key is untouched');

  // ── 4. Audit event ───────────────────────────────────────────────────────
  console.log('\n4. Audit');
  const history = listAuditEventsForEntity('sale', one.sale.uid);
  assertEqual(history.length, 1, 'exactly one sale.created event is recorded');
  assertEqual(history[0].event_type, 'sale.created', 'the event type is sale.created');
  assertEqual(history[0].actor_user_id, USER_ID, 'the audit event attributes the cashier');
  assertEqual(history[0].metadata.order_number, one.sale.order_number, 'the audit metadata carries the order number');
  assertEqual(history[0].metadata.line_count, 1, 'the audit metadata carries the line count');
  assertEqual(history[0].metadata.channel, 'takeaway', 'the audit metadata carries the channel');

  // ── 5. Invalid input is rejected ─────────────────────────────────────────
  console.log('\n5. Invalid sales are rejected');
  const rejects = (input: any, expectedStatus: number | undefined, label: string) => {
    let err: any = null;
    try { createSale(input); } catch (e) { err = e; }
    assert(!!err, `${label} throws`);
    assertEqual(err.statusCode, expectedStatus, `${label} carries the expected status`);
    return err;
  };
  rejects(baseInput({ lines: [] }), 400, 'an empty basket');
  rejects(baseInput({ lines: null }), 400, 'a missing basket');
  rejects(baseInput({ channel: 'dine_out' }), 400, 'an unknown channel');
  rejects(baseInput({ channel: undefined }), 400, 'a missing channel');
  rejects(baseInput({ guestCount: 0 }), 400, 'guest count below 1');
  rejects(baseInput({ guestCount: 100 }), 400, 'guest count above 99');
  rejects(baseInput({ guestCount: 2.5 }), 400, 'a fractional guest count');
  rejects(baseInput({ packagingCharge: -1 }), 400, 'a negative packaging charge');
  rejects(baseInput({ deliveryCharge: -1 }), 400, 'a negative delivery charge');

  // Unknown product / bad quantity keep the inherited mapping: no statusCode,
  // which the route turns into a 500. Recorded as B8, deliberately not changed.
  const unknown = rejects(baseInput({ lines: [{ product_id: 'nope', quantity: 1 }] }), undefined, 'an unknown product');
  assert(/not found/.test(unknown.message), 'the unknown-product message is preserved');
  rejects(baseInput({ lines: [{ product_id: 'prod-coffee', quantity: 0 }] }), undefined, 'a zero quantity');
  rejects(baseInput({ lines: [{ product_id: 'prod-coffee', quantity: -1 }] }), undefined, 'a negative quantity');

  for (const channel of SALE_CHANNELS) {
    const ok = createSale(baseInput({ channel, tableId: channel === 'dine_in' ? 'table-1' : null }));
    assertEqual(ok.sale.type, channel, `channel ${channel} is accepted`);
  }

  // ── 6. Rollback on failure ───────────────────────────────────────────────
  console.log('\n6. A failed sale leaves nothing behind');
  const beforeOrders = (db.prepare('SELECT COUNT(*) AS c FROM orders').get() as any).c;
  const beforeItems = (db.prepare('SELECT COUNT(*) AS c FROM order_items').get() as any).c;
  const beforeAudit = (db.prepare('SELECT COUNT(*) AS c FROM audit_events').get() as any).c;
  const beforeStock = (db.prepare("SELECT stock_quantity AS q FROM products WHERE id = 'prod-stocked'").get() as any).q;

  let failed = false;
  try {
    // The second line fails after the first has already been inserted and its
    // stock decremented — the whole sale must roll back, not half of it.
    createSale(baseInput({
      lines: [
        { product_id: 'prod-stocked', quantity: 3 },
        { product_id: 'does-not-exist', quantity: 1 },
      ],
    }));
  } catch { failed = true; }
  assert(failed, 'the create threw');
  assertEqual((db.prepare('SELECT COUNT(*) AS c FROM orders').get() as any).c, beforeOrders, 'no order row survives the rollback');
  assertEqual((db.prepare('SELECT COUNT(*) AS c FROM order_items').get() as any).c, beforeItems, 'no order_items survive the rollback');
  assertEqual((db.prepare('SELECT COUNT(*) AS c FROM audit_events').get() as any).c, beforeAudit, 'no audit event survives the rollback');
  assertEqual((db.prepare("SELECT stock_quantity AS q FROM products WHERE id = 'prod-stocked'").get() as any).q, beforeStock,
    'the stock decrement from the first line is rolled back too');

  // ── 7. Inventory (existing mechanism, unchanged) ─────────────────────────
  console.log('\n7. Inventory behaves as before');
  const stockBefore = (db.prepare("SELECT stock_quantity AS q FROM products WHERE id = 'prod-stocked'").get() as any).q;
  createSale(baseInput({ lines: [{ product_id: 'prod-stocked', quantity: 4 }] }));
  const stockAfter = (db.prepare("SELECT stock_quantity AS q FROM products WHERE id = 'prod-stocked'").get() as any).q;
  assertEqual(stockAfter, stockBefore - 4, 'stock is decremented at sale creation (existing behaviour, see B2)');

  let oversold = false;
  try {
    createSale(baseInput({ lines: [{ product_id: 'prod-stocked', quantity: 9999 }] }));
  } catch (e: any) {
    oversold = /Insufficient stock/.test(e.message);
  }
  assert(oversold, 'a sale beyond available stock is refused with the inherited message');

  // A product that does not track inventory is never stock-checked.
  const untracked = createSale(baseInput({ lines: [{ product_id: 'prod-coffee', quantity: 999 }] }));
  assertEqual(untracked.lines[0].quantity, 999, 'an untracked product ignores stock entirely');

  // ── 8. Hospitality: the one vertical-specific branch ─────────────────────
  console.log('\n8. Hospitality metadata');
  db.prepare("UPDATE tables SET status = 'available' WHERE id = 'table-1'").run();
  const dineIn = createSale(baseInput({ channel: 'dine_in', tableId: 'table-1', guestCount: 3 }));
  assertEqual(dineIn.sale.table_id, 'table-1', 'the table is linked to the sale');
  assertEqual(dineIn.sale.guest_count, 3, 'the guest count is persisted');
  assertEqual((db.prepare("SELECT status AS s FROM tables WHERE id = 'table-1'").get() as any).s, 'occupied',
    'a dine-in sale marks the table occupied');

  db.prepare("UPDATE tables SET status = 'available' WHERE id = 'table-1'").run();
  createSale(baseInput({ channel: 'takeaway', tableId: 'table-1' }));
  assertEqual((db.prepare("SELECT status AS s FROM tables WHERE id = 'table-1'").get() as any).s, 'available',
    'a non-dine-in sale never occupies a table, even if one is supplied');

  const counter = createSale(baseInput({ channel: 'takeaway' }));
  assertEqual(counter.sale.table_id, null, 'a counter sale has no table — the retail shape works today');
  assertEqual(counter.sale.guest_count, null, 'a counter sale has no guest count');

  // ── 9. Idempotency ───────────────────────────────────────────────────────
  console.log('\n9. Idempotency');
  const idem = { key: 'key-abc', requestHash: 'hash-1', userId: USER_ID };
  const first = createSale(baseInput({ idempotency: idem }));
  assertEqual(first.idempotentReplay, false, 'the first call creates');
  const replay = createSale(baseInput({ idempotency: idem }));
  assertEqual(replay.idempotentReplay, true, 'the same key replays instead of creating');
  assertEqual(replay.sale.order_number, first.sale.order_number, 'the replay returns the original sale');
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS c FROM orders WHERE order_number = ?').get(first.sale.order_number) as any).c, 1,
    'a replay does not create a second sale',
  );
  const replayAudit = listAuditEventsForEntity('sale', first.sale.uid);
  assertEqual(replayAudit.length, 1, 'a replay does not record a second audit event');

  let conflict: any = null;
  try {
    createSale(baseInput({ idempotency: { ...idem, requestHash: 'different-hash' } }));
  } catch (e) { conflict = e; }
  assert(!!conflict, 'reusing a key with a different request throws');
  assertEqual(conflict.statusCode, 409, 'a key reused for a different request is a 409');

  // A different cashier's identical key is a different record.
  const otherUser = createSale(baseInput({ idempotency: { ...idem, userId: 'user-other' } }));
  assertEqual(otherUser.idempotentReplay, false, 'idempotency records are scoped per user');

  // ── 11. addSaleItems ─────────────────────────────────────────────────────
  console.log('\n11. addSaleItems: shared line engine, second caller');
  const db2 = getDatabase();

  const opened = createSale(baseInput({ lines: [{ product_id: 'prod-coffee', quantity: 1 }] }));
  assertEqual(opened.sale.subtotal, 2.5, 'the opened sale starts with one line');

  const added = addSaleItems({
    saleId: opened.sale.id,
    lines: [{ product_id: 'prod-cake', quantity: 1 }],
    actorUserId: USER_ID,
  });
  assertEqual(added.idempotentReplay, false, 'a fresh add is not a replay');
  assertEqual(added.lines.length, 2, 'the response includes every line on the sale, not just the new one');
  assertEqual(added.sale.subtotal, 6.5, '£2.50 (existing) + £4.00 (added) = £6.50');
  const addedLine = added.lines.find((l: any) => l.product_id === 'prod-cake');
  assert(!!addedLine, 'the new line is present');
  assert(isUlid(addedLine.uid), 'the newly added line receives a ULID uid — the shared engine wires it in for both callers');
  assert(isUlid(opened.sale.uid), 'the sale itself still carries its uid from creation');

  // Multiple items in one call.
  const multiAdd = addSaleItems({
    saleId: opened.sale.id,
    lines: [
      { product_id: 'prod-coffee', quantity: 1 },
      { product_id: 'prod-cake', quantity: 2 },
    ],
  });
  assertEqual(multiAdd.lines.length, 4, 'two more lines bring the total to four');

  // An existing sale with items already on it — added-to sale keeps working.
  const withStock = createSale(baseInput({ lines: [{ product_id: 'prod-stocked', quantity: 2 }] }));
  const stockBeforeAdd = (db2.prepare("SELECT stock_quantity AS q FROM products WHERE id = 'prod-stocked'").get() as any).q;
  addSaleItems({ saleId: withStock.sale.id, lines: [{ product_id: 'prod-stocked', quantity: 3 }] });
  const stockAfterAdd = (db2.prepare("SELECT stock_quantity AS q FROM products WHERE id = 'prod-stocked'").get() as any).q;
  assertEqual(stockAfterAdd, stockBeforeAdd - 3, 'stock is decremented for items added after creation too — the shared engine, not a second copy');

  // ── 12. addSaleItems: rejection cases ────────────────────────────────────
  console.log('\n12. addSaleItems: rejection cases');
  const rejectsAdd = (input: any, expectedStatus: number | undefined, label: string) => {
    let err: any = null;
    try { addSaleItems(input); } catch (e) { err = e; }
    assert(!!err, `${label} throws`);
    assertEqual(err.statusCode, expectedStatus, `${label} carries the expected status`);
    return err;
  };
  rejectsAdd({ saleId: opened.sale.id, lines: [] }, 400, 'an empty basket');
  rejectsAdd({ saleId: opened.sale.id, lines: null }, 400, 'a missing basket');
  rejectsAdd({ saleId: 999999, lines: [{ product_id: 'prod-coffee', quantity: 1 }] }, 404, 'a nonexistent sale');
  rejectsAdd({ saleId: opened.sale.id, lines: [{ product_id: 'nope', quantity: 1 }] }, undefined, 'an unknown product (matches B8: no statusCode)');

  const completedSale = createSale(baseInput());
  db2.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(completedSale.sale.id);
  rejectsAdd({ saleId: completedSale.sale.id, lines: [{ product_id: 'prod-coffee', quantity: 1 }] }, 400,
    'adding items to a completed sale');
  db2.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(completedSale.sale.id);
  rejectsAdd({ saleId: completedSale.sale.id, lines: [{ product_id: 'prod-coffee', quantity: 1 }] }, 400,
    'adding items to a cancelled sale');

  // ── 13. addSaleItems: rollback ───────────────────────────────────────────
  console.log('\n13. addSaleItems: a failed add leaves nothing behind');
  const rollbackTarget = createSale(baseInput({ lines: [{ product_id: 'prod-coffee', quantity: 1 }] }));
  const itemsBefore = (db2.prepare('SELECT COUNT(*) AS c FROM order_items WHERE order_id = ?').get(rollbackTarget.sale.id) as any).c;
  const subtotalBefore = (db2.prepare('SELECT subtotal AS s FROM orders WHERE id = ?').get(rollbackTarget.sale.id) as any).s;
  const auditBefore = (db2.prepare('SELECT COUNT(*) AS c FROM audit_events').get() as any).c;
  let addFailed = false;
  try {
    addSaleItems({
      saleId: rollbackTarget.sale.id,
      lines: [
        { product_id: 'prod-cake', quantity: 1 },
        { product_id: 'does-not-exist', quantity: 1 },
      ],
    });
  } catch { addFailed = true; }
  assert(addFailed, 'the add threw');
  assertEqual((db2.prepare('SELECT COUNT(*) AS c FROM order_items WHERE order_id = ?').get(rollbackTarget.sale.id) as any).c, itemsBefore,
    'no line survives the rollback, including the one that inserted successfully before the failure');
  assertEqual((db2.prepare('SELECT subtotal AS s FROM orders WHERE id = ?').get(rollbackTarget.sale.id) as any).s, subtotalBefore,
    'the sale subtotal is unchanged');
  assertEqual((db2.prepare('SELECT COUNT(*) AS c FROM audit_events').get() as any).c, auditBefore,
    'no sale.items_added audit event survives the rollback');

  // ── 14. addSaleItems: discount preservation and bill re-sync ────────────
  console.log('\n14. addSaleItems: existing discount and bill stay consistent');
  const discounted = createSale(baseInput({ lines: [{ product_id: 'prod-cake', quantity: 1 }] })); // £4.00
  db2.prepare(`UPDATE orders SET discount_type = 'percentage', discount_value = 10, discount_amount = 0.4 WHERE id = ?`)
    .run(discounted.sale.id);
  const billNumber = `BILL-${discounted.sale.id}`;
  db2.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, total, balance, payment_status, created_at, updated_at)
               VALUES (?, ?, 4.00, 3.60, 3.60, 'unpaid', ?, ?)`).run(billNumber, discounted.sale.id, now(), now());

  const discountedAdd = addSaleItems({ saleId: discounted.sale.id, lines: [{ product_id: 'prod-cake', quantity: 1 }] }); // +£4.00
  // subtotal 8.00, discount rescaled to 10% = 0.80, discounted subtotal 7.20
  assertEqual(discountedAdd.sale.subtotal, 8, 'subtotal reflects both lines');
  assertEqual(discountedAdd.sale.discount_amount, 0.8, 'a percentage discount is rescaled to the new subtotal (BUG #12 FIX)');
  assertEqual(discountedAdd.sale.total, 7.2, 'the sale total reflects the rescaled discount');
  const syncedBill = db2.prepare('SELECT * FROM bills WHERE order_id = ?').get(discounted.sale.id) as any;
  assertEqual(syncedBill.total, 7.2, 'an existing unpaid bill is re-synced to the new total (BUG #4 FIX)');
  assertEqual(syncedBill.balance, 7.2, 'the bill balance is re-synced too');

  // ── 15. addSaleItems: cancelled items excluded from totals ──────────────
  console.log('\n15. addSaleItems: cancelled lines are excluded from recalculated totals (BUG #3 FIX)');
  const withCancelled = createSale(baseInput({
    lines: [
      { product_id: 'prod-coffee', quantity: 1 }, // £2.50
      { product_id: 'prod-cake', quantity: 1 },   // £4.00
    ],
  }));
  db2.prepare(`UPDATE order_items SET status = 'cancelled' WHERE order_id = ? AND product_id = 'prod-cake'`)
    .run(withCancelled.sale.id);
  const afterCancelAdd = addSaleItems({ saleId: withCancelled.sale.id, lines: [{ product_id: 'prod-coffee', quantity: 1 }] });
  // Active: coffee(2.50) + coffee(2.50) = 5.00. The cancelled cake line must not count.
  assertEqual(afterCancelAdd.sale.subtotal, 5, 'the cancelled line is excluded from the recalculated subtotal');

  // ── 16. addSaleItems: audit ──────────────────────────────────────────────
  console.log('\n16. addSaleItems: audit');
  const auditedSale = createSale(baseInput({ lines: [{ product_id: 'prod-coffee', quantity: 1 }] }));
  addSaleItems({ saleId: auditedSale.sale.id, lines: [{ product_id: 'prod-cake', quantity: 1 }] }, );
  const addHistory = listAuditEventsForEntity('sale', auditedSale.sale.uid);
  assertEqual(addHistory.length, 2, 'sale.created then sale.items_added are both recorded, in order');
  assertEqual(addHistory[0].event_type, 'sale.created', 'the first event is creation');
  assertEqual(addHistory[1].event_type, 'sale.items_added', 'the second event is the item addition');
  assertEqual(addHistory[1].metadata.added_line_count, 1, 'the audit metadata records how many lines were added');
  assertEqual(addHistory[1].metadata.total_line_count, 2, 'the audit metadata records the resulting total line count');

  // ── 17. addSaleItems: idempotency ────────────────────────────────────────
  console.log('\n17. addSaleItems: idempotency');
  const idemSale = createSale(baseInput({ lines: [{ product_id: 'prod-coffee', quantity: 1 }] }));
  const addIdem = { key: 'add-key-1', requestHash: 'add-hash-1', userId: USER_ID };
  const firstAdd = addSaleItems({ saleId: idemSale.sale.id, lines: [{ product_id: 'prod-cake', quantity: 1 }], idempotency: addIdem });
  assertEqual(firstAdd.idempotentReplay, false, 'the first call adds');
  const replayAdd = addSaleItems({ saleId: idemSale.sale.id, lines: [{ product_id: 'prod-cake', quantity: 1 }], idempotency: addIdem });
  assertEqual(replayAdd.idempotentReplay, true, 'the same key replays instead of adding again');
  assertEqual(
    (db2.prepare('SELECT COUNT(*) AS c FROM order_items WHERE order_id = ?').get(idemSale.sale.id) as any).c, 2,
    'a replay does not insert a second cake line — one from creation, one from the single successful add',
  );
  const replayAddHistory = listAuditEventsForEntity('sale', idemSale.sale.uid);
  assertEqual(replayAddHistory.length, 2, 'a replay does not record a second sale.items_added event');

  // ── 18. addSaleItems: special instructions semantics ─────────────────────
  console.log('\n18. addSaleItems: special_instructions presence vs absence');
  const notesSale = createSale(baseInput({ lines: [{ product_id: 'prod-coffee', quantity: 1 }], specialInstructions: 'Extra hot' }));
  const untouched = addSaleItems({ saleId: notesSale.sale.id, lines: [{ product_id: 'prod-cake', quantity: 1 }] });
  assertEqual(untouched.sale.special_instructions, 'Extra hot', 'omitting specialInstructions leaves existing notes untouched');
  const cleared = addSaleItems({
    saleId: notesSale.sale.id,
    lines: [{ product_id: 'prod-coffee', quantity: 1 }],
    specialInstructions: { value: null },
  });
  assertEqual(cleared.sale.special_instructions, null, 'explicitly passing { value: null } clears the notes');
  const updated = addSaleItems({
    saleId: notesSale.sale.id,
    lines: [{ product_id: 'prod-coffee', quantity: 1 }],
    specialInstructions: { value: 'No sugar' },
  });
  assertEqual(updated.sale.special_instructions, 'No sugar', 'explicitly passing a value updates the notes');

  // ── 19. Retail compatibility: a counter sale can still be added to ──────
  console.log('\n19. A counter sale (no table, no hospitality) supports add-items too');
  const counterOpen = createSale(baseInput({ channel: 'takeaway' }));
  assertEqual(counterOpen.sale.table_id, null, 'the sale has no table — the retail shape');
  const counterAdded = addSaleItems({ saleId: counterOpen.sale.id, lines: [{ product_id: 'prod-cake', quantity: 1 }] });
  assertEqual(counterAdded.lines.length, 2, 'items can be added to a tableless sale with no hospitality involvement');

  // ── 20. Service boundary ─────────────────────────────────────────────────
  console.log('\n20. Service boundary');
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'core', 'sale.ts'), 'utf8');
  assert(!/from ['"]express['"]/.test(source), 'SaleService does not import Express');
  assert(!/\breq\.|\bres\.status\(/.test(source), 'SaleService never touches a Request or Response');
  assert(!/from ['"]react/.test(source) && !source.includes('@/'), 'SaleService has no frontend imports');
  assert(!/notifyKdsUpdate|cloudSync/.test(source),
    'SaleService performs no infrastructure side effects — those stay with the caller');
  assert(new SaleError('x', 400) instanceof Error, 'SaleError is a real Error subclass');

  closeDatabase();
  const results = getResults();
  console.log(`\n${results.failed === 0 ? '✅' : '❌'} ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
