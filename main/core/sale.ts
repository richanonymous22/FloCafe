/**
 * Plemmo Core — SaleService.
 *
 * The shared transaction engine for both verticals. A hospitality order and a
 * retail sale are the same thing here: a header, some lines, tax, and totals.
 * They differ only in which optional metadata is populated (a table and a guest
 * count for dine-in; neither for a shop counter) and in how long the sale stays
 * open before it is billed.
 *
 *     Route / Controller          ← HTTP, auth, status codes live there
 *            ↓
 *     SaleService                 ← this file: business rules, one transaction
 *            ↓
 *     main/db.ts (getDatabase, withTxn)   ← persistence
 *
 * ## Boundaries
 *
 *   - No Express types in any signature here. The service never sees a
 *     Request or a Response and never chooses an HTTP status code; it throws
 *     typed errors and the route maps them.
 *   - No frontend imports.
 *   - No infrastructure side effects. KDS WebSocket notifications, the cloud
 *     outbox and customer tag-count syncing happen AFTER the transaction
 *     commits and are the caller's job — announcing an order from inside the
 *     transaction would broadcast something that can still roll back.
 *
 * ## Persistence naming
 *
 * The domain word is "sale"; the inherited tables are `orders` / `order_items`.
 * That mapping is deliberate and stays for now — renaming the tables is a
 * migration with no behavioural payoff. See docs/PHASE_2A_SALE_FLOW.md.
 *
 * ## Scope
 *
 * `createSale` (Phase 2A) and `addSaleItems` (Milestone 2). Both were
 * behaviour-preserving extractions verified against
 * docs/PHASE_2A_SALE_FLOW.md § 8 and docs/MILESTONE_2_CORE_ENGINE.md.
 * Deliberately NOT implemented yet: removeItem, updateItem, holdSale,
 * resumeSale, finalizeSale, cancelSale, voidSale. Each arrives when a real
 * caller needs it, so the service never grows speculative API.
 *
 * ## Shared line engine
 *
 * `createSale` and `addSaleItems` used to carry two near-identical copies of
 * the per-item loop (product lookup, stock guard, price/quantity validation,
 * addon subtotal, tax calculation, insert, addon insert, stock decrement).
 * Both now call the internal `persistSaleLine()` for that work — one business
 * rule implementation, two callers. What differs between them is how the
 * results are aggregated: `createSale` sums the per-line results as it goes
 * (there is nothing else on the sale yet); `addSaleItems` re-derives the
 * sale's totals from every *active* line in the database afterwards, because
 * it may be adding items to a sale that already has some — see "BUG #3 FIX"
 * in the extraction notes.
 */

import {
  getDatabase,
  generateOrderNumber,
  now,
  parseItemJson,
  parseRowJson,
  withTxn,
  insertOrderItemAddons,
  attachEffectiveAddons,
} from '../db';
import {
  calculateConfiguredChargeTaxes,
  calculateItemTax,
  combineItemAndChargeTaxes,
  getActiveCountryPack,
  getConfiguredChargeTaxCategories,
} from '../services/tax';
import { applyPayableRounding } from '../services/tax-engine';
import { validateOrderNotes, validateItemNotes } from './notes-validation';
import { recordAuditEvent } from './audit';
import { ulid } from './ids';
import { runOnSaleOpened } from './hooks';
import { getBalance as getInventoryBalance, recordSale as recordInventorySale } from './inventory';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * How the sale reaches the customer.
 *
 * `dine_in`/`takeaway`/`delivery`/`online` are the values the inherited
 * `orders.type` column already accepted. `in_store` is new in Milestone 3:
 * a retail counter sale — no table, no kitchen routing, nothing hospitality
 * about it. The column itself has no CHECK constraint (kept as a union here
 * so a typo fails the build instead of reaching the database), so this is a
 * pure type-level widening — no migration needed. See
 * docs/MILESTONE_3_VERTICALS_AND_RETAIL.md § Retail checkout.
 */
export type SaleChannel = 'dine_in' | 'takeaway' | 'delivery' | 'online' | 'in_store';

export const SALE_CHANNELS: readonly SaleChannel[] = ['dine_in', 'takeaway', 'delivery', 'online', 'in_store'];

export interface SaleAddonInput {
  id?: string;
  addon_group_id?: string | null;
  name?: string;
  price?: number;
  quantity?: number;
}

export interface SaleLineInput {
  product_id: string;
  quantity: number;
  addons?: SaleAddonInput[] | null;
  special_instructions?: string | null;
  variant_selection?: unknown;
  modifier_selection?: unknown;
  /**
   * A `product_variants` row id (Milestone 3). Optional and vertical-neutral
   * at this layer: a hospitality line never sets it and behaves exactly as
   * before. When set, the variant's own price/SKU are used instead of the
   * parent product's — see `persistSaleLine`. Unrelated to
   * `variant_selection`, the pre-existing free-form JSON column.
   */
  variant_id?: string | null;
}

/**
 * Transport-level replay protection.
 *
 * `requestHash` is computed by the caller over the *original request*, not over
 * the domain input. That is deliberate: it keeps hashes stable across this
 * refactor, so an idempotency record written by the pre-refactor code still
 * matches on retry instead of producing a spurious conflict.
 */
export interface SaleIdempotency {
  key: string;
  requestHash: string;
  /** Records are user-scoped so one cashier's key cannot replay another's sale. */
  userId: string;
}

export interface CreateSaleInput {
  channel: SaleChannel;
  lines: SaleLineInput[];
  /** The authenticated cashier. Never client-supplied — it drives sales attribution and waiter visibility. */
  cashierUserId: string;
  customerId?: string | number | null;
  /** Hospitality only. Null for a counter sale. */
  tableId?: string | null;
  guestCount?: number | null;
  specialInstructions?: string | null;
  packagingCharge?: number | null;
  deliveryCharge?: number | null;
  idempotency?: SaleIdempotency | null;
}

/** The persisted sale header. Mirrors the `orders` row. */
export interface SaleRecord {
  id: number;
  uid: string | null;
  order_number: string;
  table_id: string | null;
  customer_id: string | null;
  user_id: string | null;
  type: string;
  status: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  round_off: number;
  [column: string]: unknown;
}

/** A persisted sale line. Mirrors the `order_items` row. */
export interface SaleLineRecord {
  id: number;
  uid: string | null;
  order_id: number;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  total: number;
  [column: string]: unknown;
}

export interface CreateSaleResult {
  sale: SaleRecord;
  lines: SaleLineRecord[];
  /** True when an idempotency key replayed a previous result; no new sale was created. */
  idempotentReplay: boolean;
}

/**
 * A failure the caller can map to a response.
 *
 * `statusCode` is intentionally optional and intentionally absent on most
 * errors: the inherited route maps a missing statusCode to a 500 "Internal
 * server error" with the message hidden. Preserving that mapping exactly is
 * more important in a behaviour-preserving refactor than improving it — the
 * cases where it is arguably wrong are recorded in
 * docs/PHASE_2A_SALE_FLOW.md § 7 (B8) rather than changed here.
 */
export class SaleError extends Error {
  readonly statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'SaleError';
    this.statusCode = statusCode;
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Enforce a group's min/max selection and multi-quantity rules for one line's
 * add-ons.
 *
 * Moved verbatim out of routes/orders.ts so the rule lives with the domain
 * instead of the route. Exported because routes/orders.ts still imports it
 * back for the item-cancel/restore paths that have not moved into
 * SaleService yet.
 */
export function validateLineAddonGroupLimits(
  db: ReturnType<typeof getDatabase>,
  addons: SaleAddonInput[] | null | undefined,
): void {
  if (!addons || !Array.isArray(addons) || addons.length === 0) return;

  for (const addon of addons) {
    if (!addon) continue;
    if (addon.quantity !== undefined) {
      if (typeof addon.quantity !== 'number' || !Number.isInteger(addon.quantity) || addon.quantity <= 0) {
        throw new Error(`Invalid add-on quantity for ${addon.name || 'addon'}: must be a positive integer`);
      }
    }
  }

  const groupSelections = new Map<string, { totalQty: number; hasMultiQty: boolean }>();

  for (const addon of addons) {
    if (!addon) continue;
    let groupId: string | null = addon.addon_group_id || null;
    if (!groupId && addon.id) {
      const dbAddon = db.prepare('SELECT addon_group_id FROM addons WHERE id = ?').get(addon.id) as { addon_group_id: string } | undefined;
      if (dbAddon) groupId = dbAddon.addon_group_id;
    }

    if (groupId) {
      const qty = Math.max(1, Math.floor(addon.quantity || 1));
      const current = groupSelections.get(groupId) || { totalQty: 0, hasMultiQty: false };
      groupSelections.set(groupId, {
        totalQty: current.totalQty + qty,
        hasMultiQty: current.hasMultiQty || qty > 1,
      });
    }
  }

  for (const [groupId, selection] of groupSelections.entries()) {
    const group = db.prepare('SELECT * FROM addon_groups WHERE id = ? AND is_active = 1').get(groupId) as any;
    if (!group) continue;

    if (!group.allow_multiple_quantities && selection.hasMultiQty) {
      throw new Error(`Add-on group "${group.name}" does not allow multiple quantities`);
    }

    if (group.max_selection !== null && group.max_selection !== undefined && selection.totalQty > group.max_selection) {
      throw new Error(`Total add-on quantity for group "${group.name}" exceeds maximum allowed (${group.max_selection})`);
    }

    if (group.min_selection && selection.totalQty < group.min_selection) {
      throw new Error(`Selection for group "${group.name}" requires at least ${group.min_selection} item(s)`);
    }
  }
}

/**
 * Shape and range checks that do not need the database transaction.
 *
 * Runs before any write, exactly as the route did. Every throw here carries
 * statusCode 400 because the inherited route returned 400 for all of them.
 */
function validateCreateSaleInput(db: ReturnType<typeof getDatabase>, input: CreateSaleInput): void {
  if (!input.lines || !Array.isArray(input.lines) || input.lines.length === 0) {
    throw new SaleError('At least one item is required', 400);
  }
  if (!input.channel || !SALE_CHANNELS.includes(input.channel)) {
    throw new SaleError('Valid type is required (dine_in, takeaway, delivery, online, in_store)', 400);
  }
  if (
    input.guestCount !== undefined && input.guestCount !== null
    && (!Number.isSafeInteger(input.guestCount) || input.guestCount < 1 || input.guestCount > 99)
  ) {
    throw new SaleError('guest_count must be a whole number between 1 and 99', 400);
  }

  const packaging = Number(input.packagingCharge || 0);
  const delivery = Number(input.deliveryCharge || 0);
  if (!Number.isFinite(packaging) || packaging < 0 || !Number.isFinite(delivery) || delivery < 0) {
    throw new SaleError('Packaging and delivery charges must be non-negative numbers', 400);
  }

  // These throw plain Errors; the inherited route caught them and answered 400,
  // so they are re-thrown with that status attached.
  try {
    validateOrderNotes(db, input.specialInstructions);
    for (const line of input.lines) {
      validateItemNotes(db, line.special_instructions);
      validateLineAddonGroupLimits(db, line.addons);
    }
  } catch (err) {
    throw new SaleError((err as Error).message, 400);
  }
}

// ─── Tenant context ───────────────────────────────────────────────────────────

interface TenantContext {
  country: string;
  business_type: string;
  state_code: string;
  taxes_enabled: boolean;
}

function readTenantContext(db: ReturnType<typeof getDatabase>): TenantContext {
  const settings: Record<string, string> = {};
  (db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[])
    .forEach((row) => { settings[row.key] = row.value; });
  return {
    country: settings.country || 'IN',
    business_type: settings.business_type || 'restaurant',
    state_code: settings.state_code || '',
    taxes_enabled: settings.taxes_enabled === 'true',
  };
}

// ─── Shared sale-line engine ────────────────────────────────────────────────

interface PersistLineContext {
  db: ReturnType<typeof getDatabase>;
  /** `number`/`bigint` from a freshly inserted row's `lastInsertRowid`, or the `string` route param for an existing sale. */
  orderId: number | bigint | string;
  tenantInfo: TenantContext;
  customer: any;
  /** The authenticated cashier, threaded through for inventory movement attribution (Milestone 4). */
  actorUserId?: string | null;
}

/** What `persistSaleLine` reports back, so both callers can aggregate however they need to. */
interface PersistedSaleLine {
  itemId: number | bigint;
  uid: string;
  /** Pre-tax line subtotal, after addons and the (currently always-zero) line discount. */
  subtotal: number;
  taxAmount: number;
  taxType: string;
  taxBreakdown: unknown;
  taxSnapshotJson: string | null;
  total: number;
}

/**
 * Validate, price, tax and persist ONE sale line: look up the product, guard
 * stock, resolve price/tax from the catalogue (never the request), insert the
 * row and its addons, and decrement stock. This is the operation that used to
 * be duplicated between `createSale` and `POST /orders/:id/items` — see the
 * module docstring.
 *
 * Must run inside the caller's transaction. Throws `SaleError` (no
 * `statusCode`, matching the inherited 500 mapping — see
 * docs/PHASE_2A_SALE_FLOW.md § 7 B8) on an invalid line.
 *
 * The insert statement is prepared fresh per call rather than once per loop,
 * trading a little repeated `db.prepare()` for a self-contained, easily
 * testable function — an order/sale has at most a few dozen lines, not a hot
 * path where that matters.
 */
function persistSaleLine(ctx: PersistLineContext, line: SaleLineInput): PersistedSaleLine {
  const { db, orderId, tenantInfo, customer } = ctx;

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(line.product_id) as any;
  if (!product) {
    throw new SaleError(`Product ${line.product_id} not found`);
  }

  // Milestone 3: a line may name a specific product_variants row instead of
  // selling the bare product. Price and SKU come from the variant when one
  // is given. A hospitality line never sets `variant_id`, so `variant`
  // stays null and every line below behaves exactly as it did before this
  // field existed.
  let variant: any = null;
  if (line.variant_id) {
    variant = db.prepare('SELECT * FROM product_variants WHERE id = ? AND product_id = ?')
      .get(line.variant_id, line.product_id) as any;
    if (!variant) {
      throw new SaleError(`Variant ${line.variant_id} not found for product ${line.product_id}`);
    }
    if (!variant.is_active) {
      throw new SaleError(`Variant ${line.variant_id} is not active`);
    }
  }

  // Milestone 4: stock now lives in the inventory ledger, not a direct read
  // of `products.stock_quantity` — variant-aware, so Variant A's stock
  // cannot be confused with Variant B's or the bare product's. This
  // pre-check is a deliberate, exact-message duplicate of what
  // `InventoryService.recordSale()` itself would reject with; kept here so
  // the bare-product, no-variant case throws byte-for-byte the same
  // `SaleError` (message, no `statusCode` — the inherited 500 mapping) it
  // always has, rather than the differently-worded error `recordSale()`
  // throws internally. See docs/MILESTONE_4_INVENTORY.md § Sale integration.
  if (product.track_inventory) {
    const available = variant
      ? (getInventoryBalance(product.id, variant.id) ?? 0)
      : (getInventoryBalance(product.id) ?? product.stock_quantity ?? 0);
    if (available < line.quantity) {
      throw new SaleError(`Insufficient stock for ${product.name}`);
    }
  }

  // Price always comes from the catalogue, never from the request — the
  // catalogue is now "the variant if one was named, else the product".
  const unitPrice = parseFloat(variant ? variant.price : product.price);
  const unitCost = parseFloat((variant ? variant.cost : product.cost) ?? 0) || 0;
  const lineSku = variant ? (variant.sku || product.sku) : product.sku;
  const quantity = line.quantity;
  // line.discount_amount is intentionally ignored — discounts are only
  // applied through the dedicated discount endpoints, which enforce
  // discount_mode/max_percentage/max_amount/approval (vuln-0002).
  const itemDiscount = 0;

  if (!quantity || quantity <= 0 || !Number.isFinite(quantity)) {
    throw new SaleError(`Invalid quantity for ${product.name}: must be a positive number`);
  }
  if (unitPrice < 0 || !Number.isFinite(unitPrice)) {
    throw new SaleError(`Invalid price for ${product.name}: must be a non-negative number`);
  }

  let itemSubtotal = unitPrice * quantity;
  if (line.addons && Array.isArray(line.addons)) {
    for (const addon of line.addons) {
      if (!addon) continue;
      if (addon.quantity !== undefined) {
        if (typeof addon.quantity !== 'number' || !Number.isInteger(addon.quantity) || addon.quantity <= 0) {
          throw new SaleError(`Invalid add-on quantity for ${addon.name || 'addon'}: must be a positive integer`);
        }
      }
      const addonQty = addon.quantity || 1;
      itemSubtotal += (addon.price || 0) * addonQty * quantity;
    }
  }
  itemSubtotal = Math.max(0, itemSubtotal - itemDiscount);

  const taxResult = calculateItemTax(tenantInfo, product, itemSubtotal, customer);
  const itemTaxSnapshotJson = taxResult.tax_snapshot ? JSON.stringify(taxResult.tax_snapshot) : null;
  const itemTotal = itemSubtotal + (taxResult.tax_type === 'inclusive' ? 0 : taxResult.tax_amount);

  const lineUid = ulid();
  const itemCreatedAt = now();
  const insertItemResult = db.prepare(`
    INSERT INTO order_items (order_id, uid, product_id, product_name, product_sku, unit_price, quantity,
      subtotal, tax_amount, tax_breakdown, tax_snapshot, tax_type, discount_amount, total, variant_selection,
      modifier_selection, special_instructions, status, created_at, updated_at, product_variant_id, unit_cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(
    orderId, lineUid, product.id, product.name, lineSku, unitPrice, quantity,
    itemSubtotal, taxResult.tax_amount, JSON.stringify(taxResult.tax_breakdown), itemTaxSnapshotJson,
    taxResult.tax_type, itemDiscount, itemTotal,
    JSON.stringify(line.variant_selection || null),
    JSON.stringify(line.modifier_selection || null),
    line.special_instructions || null, itemCreatedAt, itemCreatedAt,
    variant ? variant.id : null, unitCost,
  );
  insertOrderItemAddons(db, insertItemResult.lastInsertRowid, line.addons, itemCreatedAt);

  if (product.track_inventory) {
    // The pre-check above already validated availability; this call cannot
    // realistically re-reject (single-threaded, same transaction, nothing
    // changed in between) but its own guard stays as a defensive backstop.
    // reference_id ties this movement to the exact order_item row, which is
    // what lets a later refund (main/core/payment.ts's recordReturn call)
    // cap itself at "no more than this line actually sold".
    recordInventorySale({
      productId: product.id,
      variantId: variant ? variant.id : null,
      quantity,
      unitCost,
      referenceType: 'order_item',
      referenceId: String(insertItemResult.lastInsertRowid),
      actorUserId: ctx.actorUserId || null,
    });
  }

  return {
    itemId: insertItemResult.lastInsertRowid,
    uid: lineUid,
    subtotal: itemSubtotal,
    taxAmount: taxResult.tax_amount,
    taxType: taxResult.tax_type,
    taxBreakdown: taxResult.tax_breakdown,
    taxSnapshotJson: itemTaxSnapshotJson,
    total: itemTotal,
  };
}

// ─── createSale ───────────────────────────────────────────────────────────────

/**
 * Create a sale with its lines, tax and totals, in one transaction.
 *
 * Behaviour is intentionally identical to the inherited `POST /api/orders`
 * handler, including its quirks — see docs/PHASE_2A_SALE_FLOW.md § 8 for the
 * ten invariants this must preserve, and § 7 for the behaviours that look
 * wrong and were recorded rather than fixed.
 *
 * Two additions that do not change the sale outcome:
 *   - the sale header gets a ULID `uid` (Phase 1 foundation), and
 *   - a `sale.created` audit event is written inside the same transaction, so
 *     it cannot survive a rollback or be missing from a committed sale.
 *
 * The caller is responsible for post-commit effects (KDS notify, cloud outbox,
 * customer tag counts) and must skip them on an idempotent replay.
 */
export function createSale(input: CreateSaleInput): CreateSaleResult {
  const db = getDatabase();
  validateCreateSaleInput(db, input);

  const idempotency = input.idempotency ?? null;

  return withTxn(() => {
    // ── Idempotent replay ────────────────────────────────────────────────
    if (idempotency) {
      // `legacy` is an append-only compatibility owner for pre-user-scoped
      // records whose original user cannot be recovered.
      const prior = db.prepare(`
        SELECT request_hash, response_json
        FROM order_idempotency
        WHERE (user_id = ? OR user_id = 'legacy') AND idempotency_key = ?
        ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(idempotency.userId, idempotency.key, idempotency.userId) as
        { request_hash: string; response_json: string } | undefined;
      if (prior) {
        if (prior.request_hash !== idempotency.requestHash) {
          throw new SaleError('Idempotency-Key was already used for a different order request', 409);
        }
        try {
          const response = JSON.parse(prior.response_json);
          return {
            sale: response.order as SaleRecord,
            lines: (response.order?.items || []) as SaleLineRecord[],
            idempotentReplay: true,
          };
        } catch {
          throw new SaleError('Stored order response is invalid', 500);
        }
      }
    }

    // Generated inside the transaction so two concurrent creates cannot race.
    const orderNumber = generateOrderNumber();
    const tenantInfo = readTenantContext(db);

    const chargeCategories = getConfiguredChargeTaxCategories(tenantInfo.country);
    const packagingCharge = input.packagingCharge || 0;
    const deliveryCharge = input.deliveryCharge || 0;
    const chargeContext = {
      packaging_charge: packagingCharge,
      delivery_charge: deliveryCharge,
      service_charge: 0,
      packaging_tax_category_id: chargeCategories.packaging?.categoryId || null,
      delivery_tax_category_id: chargeCategories.delivery?.categoryId || null,
      service_charge_tax_category_id: chargeCategories.service_charge?.categoryId || null,
    };

    // Phase 1 foundation: a collision-safe identity for a row that will one day
    // be created on one till and read on another.
    const saleUid = ulid();

    const orderResult = db.prepare(`
      INSERT INTO orders (order_number, uid, table_id, customer_id, user_id, type, guest_count, special_instructions,
        packaging_charge, delivery_charge, packaging_tax_category_id, delivery_tax_category_id,
        service_charge_tax_category_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      orderNumber, saleUid, input.tableId || null, input.customerId || null, input.cashierUserId,
      input.channel, input.guestCount || null, input.specialInstructions || null,
      packagingCharge, deliveryCharge,
      chargeContext.packaging_tax_category_id, chargeContext.delivery_tax_category_id,
      chargeContext.service_charge_tax_category_id, now(), now(),
    );
    const orderId = orderResult.lastInsertRowid;

    let subtotal = 0;
    let totalTax = 0;
    let exclusiveTax = 0;
    const allTaxBreakdowns: any[] = [];
    const allTaxSnapshots: (string | null)[] = [];
    const customer = input.customerId
      ? db.prepare('SELECT * FROM customers WHERE id = ?').get(input.customerId) as any
      : null;

    // Shared line engine (see the module docstring): the per-item work is
    // identical to addSaleItems below. Only the aggregation differs — a new
    // sale has nothing to aggregate but the lines just inserted, so summing
    // as we go is correct and matches the original inline behaviour exactly.
    for (const line of input.lines) {
      const persisted = persistSaleLine({ db, orderId, tenantInfo, customer, actorUserId: input.cashierUserId }, line);
      totalTax += persisted.taxAmount;
      if (persisted.taxType !== 'inclusive') {
        exclusiveTax += persisted.taxAmount;
      }
      if (persisted.taxBreakdown) {
        allTaxBreakdowns.push(persisted.taxBreakdown);
      }
      allTaxSnapshots.push(persisted.taxSnapshotJson);
      subtotal += persisted.subtotal;
    }

    const chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, chargeContext, customer);
    const taxRollup = combineItemAndChargeTaxes({
      itemTaxAmount: totalTax,
      itemExclusiveTaxAmount: exclusiveTax,
      itemBreakdowns: allTaxBreakdowns,
      itemSnapshots: allTaxSnapshots,
      itemTaxRatio: 1,
      chargeTaxes,
    });
    const preRoundTotal = subtotal + taxRollup.exclusiveTaxAmount + deliveryCharge + packagingCharge;
    const total = Number(preRoundTotal.toFixed(2));
    // Payable rounding is applied at bill generation, not here — an order total
    // and its bill total can legitimately differ by that adjustment (B5).
    const roundOff = 0;

    db.prepare(`
      UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, total = ?,
        round_off = ?, updated_at = ? WHERE id = ?
    `).run(
      subtotal, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns),
      taxRollup.snapshotJson, total, roundOff, now(), orderId,
    );

    // Sale creation itself has no hospitality-specific branch anymore: this
    // used to be a direct `UPDATE tables ...` here. It now goes through the
    // Core hook registry (main/core/hooks.ts) so this file has zero
    // knowledge of what "occupying a table" means — that rule lives in
    // main/modules/hospitality/hooks.ts. Retail's `in_store` channel simply
    // has nothing registered against it, so nothing runs. Same transaction,
    // same failure semantics as before (a hook error still rolls back the
    // sale) — see the hook file's docstring for why this is not wrapped in
    // try/catch like the audit/payment side-effects are.
    runOnSaleOpened({ db, orderId, tableId: input.tableId || null, channel: input.channel, now: now() });

    const sale = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)) as SaleRecord;
    const lines = attachEffectiveAddons(
      db,
      db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId).map(parseItemJson) as any[],
    ) as SaleLineRecord[];

    // Enrolled in this transaction on purpose: a sale and the record that it
    // happened must not be able to disagree.
    recordAuditEvent({
      type: 'sale.created',
      actor: { userId: input.cashierUserId },
      entity: { type: 'sale', id: saleUid },
      summary: `Sale ${orderNumber} created with ${lines.length} line(s)`,
      metadata: {
        order_id: Number(orderId),
        order_number: orderNumber,
        channel: input.channel,
        line_count: lines.length,
        total,
        table_id: input.tableId || null,
        customer_id: input.customerId || null,
      },
    });

    if (idempotency) {
      // Stored in the response shape the route replays verbatim.
      const response = { order: Object.assign({}, sale, { items: lines }) };
      db.prepare('INSERT INTO order_idempotency (user_id, idempotency_key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(idempotency.userId, idempotency.key, idempotency.requestHash, JSON.stringify(response), now());
    }

    return { sale, lines, idempotentReplay: false };
  });
}

// ─── addSaleItems ───────────────────────────────────────────────────────────

export interface AddSaleItemsInput {
  saleId: number | string;
  lines: SaleLineInput[];
  /**
   * Present (even with `value: null`) only when the caller wants to update
   * the sale-level notes; absent leaves them untouched. A plain optional
   * string could not distinguish "clear the notes" from "don't mention
   * notes at all", which the inherited route did via `!== undefined` on the
   * raw request body — this wrapper reproduces that distinction in a typed
   * input.
   */
  specialInstructions?: { value: string | null };
  /** For audit attribution only — see the note above `recordAuditEvent` below. Not used for authorization. */
  actorUserId?: string | null;
  idempotency?: SaleIdempotency | null;
}

export interface AddSaleItemsResult {
  sale: SaleRecord;
  /** Every current line on the sale, not just the ones just added — matches the response shape the route has always returned. */
  lines: SaleLineRecord[];
  idempotentReplay: boolean;
}

/**
 * Shape/range checks that do not need the database transaction. Mirrors
 * `validateCreateSaleInput`'s structure and the inherited route's check order:
 * items array, then per-line notes/addons, then sale-level notes.
 */
function validateAddSaleItemsInput(db: ReturnType<typeof getDatabase>, input: AddSaleItemsInput): void {
  if (!input.lines || !Array.isArray(input.lines) || input.lines.length === 0) {
    throw new SaleError('At least one item is required', 400);
  }
  try {
    for (const line of input.lines) {
      validateItemNotes(db, line.special_instructions);
      validateLineAddonGroupLimits(db, line.addons);
    }
    if (input.specialInstructions !== undefined) {
      validateOrderNotes(db, input.specialInstructions.value);
    }
  } catch (err) {
    throw new SaleError((err as Error).message, 400);
  }
}

/**
 * Add lines to an existing, still-open sale.
 *
 * Behaviour is intentionally identical to the inherited
 * `POST /api/orders/:id/items` handler. It shares `persistSaleLine` with
 * `createSale` for the per-line work, but aggregates differently: totals are
 * re-derived from every ACTIVE line already on the sale (not just the ones
 * being added), because the sale may already have items and some may have
 * been cancelled — the inherited "BUG #3 FIX". An existing order-level
 * discount is preserved and rescaled if it was a percentage ("BUG #12 FIX"),
 * and an existing unpaid bill is re-synced to the new totals, since adding
 * items alone would otherwise leave it stale ("BUG #4 FIX").
 *
 * Two guard clauses the inherited route ran before acquiring the database
 * lock — the `bills.split_group_id` check and the waiter-ownership check —
 * are NOT reproduced here. They stay in the route: the split check is a
 * simple, self-contained pre-check with no shared logic to consolidate, and
 * the waiter-ownership check is an authorization decision tied to the HTTP
 * caller's role, which belongs with `requireRole` at the HTTP layer rather
 * than in a service with no Express dependency. Both run in the same relative
 * order as before, so no response code changes for any input.
 *
 * `actorUserId` is accepted for audit attribution only (WHO added these
 * items) — it plays no part in any business or authorization decision here.
 */
export function addSaleItems(input: AddSaleItemsInput): AddSaleItemsResult {
  const db = getDatabase();
  validateAddSaleItemsInput(db, input);

  const idempotency = input.idempotency ?? null;
  // Read outside the transaction, matching the inherited route exactly —
  // unlike createSale, which reads tenant context inside its transaction.
  const tenantInfo = readTenantContext(db);

  return withTxn(() => {
    // Re-fetch and re-validate under the transaction lock: another request
    // (e.g. a cashier completing/cancelling the sale) can race the checks
    // the route already ran before this lock was acquired (#175).
    const currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(input.saleId) as any;
    if (!currentOrder) {
      throw new SaleError('Order not found', 404);
    }

    if (idempotency) {
      const prior = db.prepare(`
        SELECT request_hash, response_json
        FROM order_idempotency
        WHERE (user_id = ? OR user_id = 'legacy') AND idempotency_key = ?
        ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(idempotency.userId, idempotency.key, idempotency.userId) as
        { request_hash: string; response_json: string } | undefined;
      if (prior) {
        if (prior.request_hash !== idempotency.requestHash) {
          throw new SaleError('Idempotency-Key was already used for a different order request', 409);
        }
        try {
          const response = JSON.parse(prior.response_json);
          return {
            sale: response.order as SaleRecord,
            lines: (response.order?.items || []) as SaleLineRecord[],
            idempotentReplay: true,
          };
        } catch {
          throw new SaleError('Stored order response is invalid', 500);
        }
      }
    }

    if (['completed', 'cancelled'].includes(currentOrder.status)) {
      throw new SaleError('Cannot add items to a completed or cancelled order', 400);
    }

    const customer = currentOrder.customer_id
      ? db.prepare('SELECT * FROM customers WHERE id = ?').get(currentOrder.customer_id) as any
      : null;

    // Shared line engine — see the module docstring and persistSaleLine above.
    for (const line of input.lines) {
      persistSaleLine({ db, orderId: input.saleId, tenantInfo, customer, actorUserId: input.actorUserId }, line);
    }

    // Re-derive totals from every ACTIVE line on the sale, not just the ones
    // just inserted — the sale may already have items, and some may have
    // been cancelled since. (Inherited as "BUG #3 FIX".)
    const activeItems = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status != 'cancelled'").all(input.saleId) as any[];
    let subtotal = 0;
    let totalTax = 0;
    let exclusiveTax = 0;
    const allTaxBreakdowns: any[] = [];
    const allTaxSnapshots: (string | null)[] = [];
    for (const item of activeItems) {
      subtotal += item.subtotal;
      totalTax += item.tax_amount;
      if (item.tax_type !== 'inclusive') {
        exclusiveTax += item.tax_amount;
      }
      if (item.tax_breakdown) {
        try {
          const breakdown = JSON.parse(item.tax_breakdown);
          if (Array.isArray(breakdown)) allTaxBreakdowns.push(breakdown);
        } catch { /* malformed legacy breakdown — skip, matching inherited behaviour */ }
      }
      allTaxSnapshots.push(item.tax_snapshot || null);
    }

    // Preserve an existing order-level discount, rescaling a percentage
    // discount to the new subtotal. (Inherited as "BUG #12 FIX".)
    const existingDiscountAmount = currentOrder.discount_amount || 0;
    let newDiscountAmount = existingDiscountAmount;
    if (existingDiscountAmount > 0 && currentOrder.subtotal > 0) {
      if (currentOrder.discount_type === 'percentage') {
        const pct = currentOrder.discount_value || 0;
        newDiscountAmount = Math.round(subtotal * pct / 100 * 100) / 100;
      }
      // amount type: keep the same value
    }

    const discountedSubtotal = Math.max(0, subtotal - newDiscountAmount);
    let newTaxAmount = totalTax;
    let newExclusiveTax = exclusiveTax;
    let taxRatio = 1;
    if (newDiscountAmount > 0 && subtotal > 0) {
      taxRatio = discountedSubtotal / subtotal;
      newTaxAmount = Math.round(totalTax * taxRatio * 100) / 100;
      newExclusiveTax = Math.round(exclusiveTax * taxRatio * 100) / 100;
    }

    const chargeTaxes = calculateConfiguredChargeTaxes(tenantInfo, {
      ...currentOrder,
      service_charge: 0,
    }, customer);
    const taxRollup = combineItemAndChargeTaxes({
      itemTaxAmount: newTaxAmount,
      itemExclusiveTaxAmount: newExclusiveTax,
      itemBreakdowns: allTaxBreakdowns,
      itemSnapshots: allTaxSnapshots,
      itemTaxRatio: taxRatio,
      chargeTaxes,
    });
    const preRoundTotal = discountedSubtotal + taxRollup.exclusiveTaxAmount
      + (currentOrder.delivery_charge || 0) + (currentOrder.packaging_charge || 0);
    const total = Number(preRoundTotal.toFixed(2));
    const roundOff = 0;

    if (input.specialInstructions !== undefined) {
      db.prepare(`
        UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?, round_off = ?, special_instructions = ?, updated_at = ? WHERE id = ?
      `).run(subtotal, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, newDiscountAmount, total, roundOff, input.specialInstructions.value || null, now(), input.saleId);
    } else {
      db.prepare(`
        UPDATE orders SET subtotal = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, total = ?, round_off = ?, updated_at = ? WHERE id = ?
      `).run(subtotal, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, newDiscountAmount, total, roundOff, now(), input.saleId);
    }

    // Sync the bill if one already exists and is unpaid — add-items alone
    // doesn't otherwise touch it. (Inherited as "BUG #4 FIX".)
    const existingBill = db.prepare("SELECT * FROM bills WHERE order_id = ? AND payment_status != 'paid'").get(input.saleId) as any;
    if (existingBill) {
      const pack = getActiveCountryPack(tenantInfo.country);
      const { total: billTotal, adjustment: billRoundOff } = applyPayableRounding(total, pack);
      const newBillBalance = Math.max(0, billTotal - (existingBill.paid_amount || 0));
      db.prepare(`UPDATE bills SET total = ?, balance = ?, tax_amount = ?, tax_breakdown = ?, tax_snapshot = ?, discount_amount = ?, round_off = ?, updated_at = ? WHERE id = ?`)
        .run(billTotal, newBillBalance, taxRollup.taxAmount, JSON.stringify(taxRollup.breakdowns), taxRollup.snapshotJson, newDiscountAmount, billRoundOff, now(), existingBill.id);
    }

    const sale = parseRowJson(db.prepare('SELECT * FROM orders WHERE id = ?').get(input.saleId)) as SaleRecord;
    const lines = attachEffectiveAddons(
      db,
      db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(input.saleId).map(parseItemJson) as any[],
    ) as SaleLineRecord[];

    recordAuditEvent({
      type: 'sale.items_added',
      actor: { userId: input.actorUserId ?? null },
      entity: { type: 'sale', id: sale.uid || String(input.saleId) },
      summary: `${input.lines.length} line(s) added to sale ${sale.order_number}`,
      metadata: {
        order_id: Number(input.saleId),
        order_number: sale.order_number,
        added_line_count: input.lines.length,
        total_line_count: lines.length,
        total,
      },
    });

    if (idempotency) {
      // Stored in the response shape the route replays verbatim.
      const response = { order: Object.assign({}, sale, { items: lines }) };
      db.prepare('INSERT INTO order_idempotency (user_id, idempotency_key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(idempotency.userId, idempotency.key, idempotency.requestHash, JSON.stringify(response), now());
    }

    return { sale, lines, idempotentReplay: false };
  });
}
