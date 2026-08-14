/**
 * Plemmo Core — InventoryService.
 *
 * A "how many are left, and why" ledger for the sellable unit — a bare
 * product for hospitality, or a specific variant for retail. Every write
 * goes through `recordMovement()`, which inserts one immutable
 * `inventory_movements` row and updates the matching `inventory_balances`
 * row in the same call, so a till read (`getBalance`) is O(1) while the
 * full history (`getMovementHistory`) stays fully auditable.
 *
 * See docs/MILESTONE_4_INVENTORY.md for the full design record: why the
 * legacy `products.stock_quantity` compatibility write only happens for
 * variant-less products, why refund/inventory integration is opt-in per
 * call rather than automatic, and what is deliberately deferred
 * (multi-location, transfers, stock counts).
 *
 * ## Boundaries
 *
 *   - No Express types, no React imports.
 *   - Every public entry point is self-transacting via `withTxn()`.
 *     better-sqlite3 nests transactions as SAVEPOINTs automatically, so
 *     calling `recordSale()` from inside `SaleService`'s already-open
 *     transaction still commits (or rolls back) as one atomic unit with the
 *     sale itself — no second transaction mechanism, per this milestone's
 *     Part Q.
 */

import { getDatabase, now, withTxn } from '../db';
import { ulid } from './ids';
import { getCurrentLocationId, getCurrentOrganizationId } from './location';
import { appendInventoryMovementEvent } from './sync/inventory-events';

/**
 * An explicit `locationId` always wins (a future multi-location caller will
 * pass one); an unspecified one resolves to this install's single physical
 * location (Milestone 5, Part B) rather than staying `null` — `null` would
 * mean "not stamped", which is exactly the pre-Milestone-5 state migration
 * v74 backfills away from. See docs/MILESTONE_5_PURCHASING_LOCATIONS.md
 * § Location model.
 */
function resolveLocationId(explicit: string | null | undefined): string | null {
  return explicit || getCurrentLocationId();
}

/**
 * SYNC-0 (Part D): an inventory movement is an append-only sync primitive, so
 * it must carry an unambiguous organization. Resolve it from the movement's
 * own location (a location always belongs to exactly one organization),
 * falling back to the install's current organization when the location is
 * unknown. Derived, never guessed — the location→organization link is a real
 * foreign key, not an assumption.
 */
function resolveOrganizationId(db: ReturnType<typeof getDatabase>, locationId: string | null): string | null {
  if (locationId) {
    const loc = db.prepare('SELECT organization_id FROM locations WHERE id = ?').get(locationId) as { organization_id: string | null } | undefined;
    if (loc?.organization_id) return loc.organization_id;
  }
  return getCurrentOrganizationId();
}

export class InventoryError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'InventoryError';
    this.statusCode = statusCode;
  }
}

export type MovementType = 'sale' | 'return' | 'adjustment' | 'receipt' | 'opening' | 'transfer_out' | 'transfer_in';

export interface InventoryMovementRecord {
  id: string;
  organization_id: string | null;
  location_id: string | null;
  product_id: string;
  product_variant_id: string | null;
  quantity_delta: number;
  movement_type: MovementType;
  reason: string | null;
  reference_type: string | null;
  reference_id: string | null;
  unit_cost: number | null;
  actor_user_id: string | null;
  balance_after: number;
  metadata: string | null;
  created_at: string;
  [column: string]: unknown;
}

interface InventoryKey {
  productId: string;
  variantId?: string | null;
  locationId?: string | null;
}

interface RecordMovementInput extends InventoryKey {
  db: ReturnType<typeof getDatabase>;
  quantityDelta: number;
  movementType: MovementType;
  reason?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  unitCost?: number | null;
  actorUserId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Reads the current balance for a key (0 if no row exists yet), applies
 * `quantityDelta`, and either updates or inserts the balance row. Single
 * threaded/synchronous by construction (better-sqlite3), so this
 * read-modify-write has no interleaving race within one process — see
 * docs/MILESTONE_4_INVENTORY.md § Concurrency for what a future multi-till
 * milestone needs to revisit.
 */
function applyBalanceDelta(db: ReturnType<typeof getDatabase>, key: InventoryKey, delta: number): number {
  const variantId = key.variantId || null;
  const locationId = resolveLocationId(key.locationId);
  const existing = db.prepare(`
    SELECT id, quantity FROM inventory_balances
    WHERE product_id = ? AND COALESCE(product_variant_id, '') = COALESCE(?, '') AND COALESCE(location_id, '') = COALESCE(?, '')
  `).get(key.productId, variantId, locationId) as { id: string; quantity: number } | undefined;

  // The first movement ever recorded against a variant-less product that
  // has no balance row yet (created after the v73 migration ran, or
  // track_inventory flipped on afterwards) seeds from the legacy
  // `products.stock_quantity` rather than starting at 0 — see
  // `getBalance()`'s docstring for why 0 would silently reject a valid
  // sale against real, pre-existing stock.
  const seed = existing ? existing.quantity : seedFromLegacyStock(db, key.productId, variantId);
  const nextQuantity = seed + delta;

  if (existing) {
    db.prepare('UPDATE inventory_balances SET quantity = ?, updated_at = ? WHERE id = ?')
      .run(nextQuantity, now(), existing.id);
  } else {
    db.prepare(`
      INSERT INTO inventory_balances (id, product_id, product_variant_id, location_id, quantity, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(ulid(), key.productId, variantId, locationId, nextQuantity, now());
  }

  return nextQuantity;
}

/** A variant always starts at 0 (there is no legacy per-variant scalar to seed from). */
function seedFromLegacyStock(db: ReturnType<typeof getDatabase>, productId: string, variantId: string | null): number {
  if (variantId) return 0;
  const product = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(productId) as { stock_quantity: number } | undefined;
  return product?.stock_quantity || 0;
}

function recordMovement(input: RecordMovementInput): InventoryMovementRecord {
  const { db } = input;
  const balanceAfter = applyBalanceDelta(db, input, input.quantityDelta);
  const id = ulid();
  const createdAt = now();
  const locationId = resolveLocationId(input.locationId);
  const organizationId = resolveOrganizationId(db, locationId);

  db.prepare(`
    INSERT INTO inventory_movements
      (id, organization_id, product_id, product_variant_id, location_id, quantity_delta, movement_type, reason,
       reference_type, reference_id, unit_cost, actor_user_id, balance_after, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, organizationId, input.productId, input.variantId || null, locationId,
    input.quantityDelta, input.movementType, input.reason || null,
    input.referenceType || null, input.referenceId || null,
    input.unitCost ?? null, input.actorUserId || null, balanceAfter,
    input.metadata ? JSON.stringify(input.metadata) : null, createdAt,
  );

  const movement = db.prepare('SELECT * FROM inventory_movements WHERE id = ?').get(id) as InventoryMovementRecord;

  // SYNC-A: append the durable sync event for this movement in the SAME
  // transaction (recordMovement always runs inside the caller's withTxn).
  // The movement, its balance update, and this event commit or roll back as
  // one atomic unit — a movement can never commit while its sync event is
  // missing, and this never issues a network request. See
  // docs/SYNC_A_LOCAL_FOUNDATION.md.
  appendInventoryMovementEvent(db, movement);

  return movement;
}

/**
 * Only variant-less sellable units get the legacy `products.stock_quantity`
 * compatibility write. A product with variants has no single correct number
 * to put in that column — three variants have three independent balances —
 * so `stock_quantity` is left alone for them and the ledger becomes the only
 * source of truth. This is the exact hospitality/retail split Part C asks
 * for: a hospitality product (never varianted) keeps behaving exactly as it
 * did before this milestone, reading `products.stock_quantity` anywhere
 * that still does so (e.g. `GET /products` list, low-stock filters).
 */
function syncLegacyStockQuantity(db: ReturnType<typeof getDatabase>, productId: string, variantId: string | null | undefined, delta: number): void {
  if (variantId) return;
  db.prepare('UPDATE products SET stock_quantity = stock_quantity + ?, updated_at = ? WHERE id = ?')
    .run(delta, now(), productId);
}

export interface RecordSaleInput extends InventoryKey {
  quantity: number;
  unitCost?: number | null;
  referenceType: string;
  referenceId: string;
  actorUserId?: string | null;
}

/**
 * Records a sale's stock effect. Preserves the exact policy
 * `SaleService.persistSaleLine()` already enforced before this milestone:
 * insufficient tracked stock throws (a sale is prevented), untracked
 * products (`track_inventory = 0`) are not checked or decremented at all —
 * this function is simply never called for them (see `sale.ts`). Negative
 * stock is not possible through this path; see docs/MILESTONE_4_INVENTORY.md
 * § Negative stock policy for the deferred configurable version.
 */
export function recordSale(input: RecordSaleInput): InventoryMovementRecord {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new InventoryError('Sale quantity must be a positive number');
  }
  const db = getDatabase();
  return withTxn(() => {
    const current = getBalance(input.productId, input.variantId, input.locationId) ?? 0;
    if (current < input.quantity) {
      throw new InventoryError(`Insufficient stock for ${input.variantId ? `variant ${input.variantId}` : `product ${input.productId}`}`, 400);
    }
    const movement = recordMovement({
      db, productId: input.productId, variantId: input.variantId, locationId: input.locationId,
      quantityDelta: -input.quantity, movementType: 'sale', unitCost: input.unitCost,
      referenceType: input.referenceType, referenceId: input.referenceId, actorUserId: input.actorUserId,
    });
    syncLegacyStockQuantity(db, input.productId, input.variantId, -input.quantity);
    return movement;
  });
}

export interface RecordReturnInput extends InventoryKey {
  quantity: number;
  reason?: string | null;
  /** The `order_items.id` the returned quantity is being credited against — used to cap over-refunding stock. */
  saleReferenceId: string;
  /** What actually caused this return (e.g. 'payment_refund' + the refund's id) — shown as the movement's reference in history. */
  referenceType: string;
  referenceId: string;
  actorUserId?: string | null;
}

/**
 * Records a return's stock effect (Part H). Caps the total quantity ever
 * returned against one `saleReferenceId` at the quantity that was actually
 * sold on it — computed as (sale movements' quantity) - (prior return
 * movements' quantity) for that same sold line, rather than trusting the
 * caller's claimed "amount sold". Throws rather than silently clamping, so
 * a caller with a real correction to make uses `adjustStock()` instead,
 * which is explicit about being a manual override.
 *
 * The movement's own `reference_type`/`reference_id` record what *caused*
 * the return (a refund, typically — what Part J's history view shows as
 * "Refund #..."), which is a separate concern from *which sold line* is
 * being credited back; the latter is tracked via `metadata.soldOrderItemId`
 * specifically so two different refunds against the same order_item still
 * cap correctly against each other.
 */
export function recordReturn(input: RecordReturnInput): InventoryMovementRecord {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new InventoryError('Return quantity must be a positive number');
  }
  const db = getDatabase();
  return withTxn(() => {
    const sold = (db.prepare(`
      SELECT COALESCE(SUM(-quantity_delta), 0) as total FROM inventory_movements
      WHERE movement_type = 'sale' AND reference_type = 'order_item' AND reference_id = ?
    `).get(input.saleReferenceId) as { total: number }).total;
    const alreadyReturned = (db.prepare(`
      SELECT COALESCE(SUM(quantity_delta), 0) as total FROM inventory_movements
      WHERE movement_type = 'return' AND json_extract(metadata, '$.soldOrderItemId') = ?
    `).get(input.saleReferenceId) as { total: number }).total;

    const returnable = sold - alreadyReturned;
    if (input.quantity > returnable) {
      throw new InventoryError(`Return quantity (${input.quantity}) exceeds the remaining returnable quantity (${returnable})`, 400);
    }

    const movement = recordMovement({
      db, productId: input.productId, variantId: input.variantId, locationId: input.locationId,
      quantityDelta: input.quantity, movementType: 'return', reason: input.reason,
      referenceType: input.referenceType, referenceId: input.referenceId, actorUserId: input.actorUserId,
      metadata: { soldOrderItemId: input.saleReferenceId },
    });
    syncLegacyStockQuantity(db, input.productId, input.variantId, input.quantity);
    return movement;
  });
}

export interface AdjustStockInput extends InventoryKey {
  quantityDelta: number;
  reason: string;
  movementType?: 'adjustment' | 'receipt';
  actorUserId?: string | null;
}

/**
 * The generic manual-correction entry point (Part I) — found stock, damage,
 * a count correction, or a goods receipt. `reason` is required: this
 * function exists specifically so "stock = 27" never happens without an
 * explanation attached. `movementType` defaults to `'adjustment'`;
 * `'receipt'` is available for a positive stock increase whose cause is
 * "goods arrived", reusing this same function rather than a dedicated
 * receiving workflow (explicitly out of scope this milestone — Part V).
 */
export function adjustStock(input: AdjustStockInput): InventoryMovementRecord {
  if (!Number.isFinite(input.quantityDelta) || input.quantityDelta === 0) {
    throw new InventoryError('Adjustment quantity must be a non-zero number');
  }
  if (!input.reason || !input.reason.trim()) {
    throw new InventoryError('An adjustment reason is required');
  }
  const db = getDatabase();
  return withTxn(() => {
    const current = getBalance(input.productId, input.variantId, input.locationId) ?? 0;
    if (current + input.quantityDelta < 0) {
      throw new InventoryError(`Adjustment would take stock negative (current: ${current})`, 400);
    }
    const movement = recordMovement({
      db, productId: input.productId, variantId: input.variantId, locationId: input.locationId,
      quantityDelta: input.quantityDelta, movementType: input.movementType || 'adjustment',
      reason: input.reason, referenceType: 'manual', actorUserId: input.actorUserId,
    });
    syncLegacyStockQuantity(db, input.productId, input.variantId, input.quantityDelta);
    return movement;
  });
}

export interface RecordReceiptInput extends InventoryKey {
  quantity: number;
  /** The actual cost this receipt was recorded at — may differ from a purchase order's expected unit_cost (Part G). */
  unitCost: number;
  referenceType: string;
  referenceId: string;
  actorUserId?: string | null;
}

/**
 * Records a goods-receipt's stock effect (Milestone 5, Part F/H). The
 * purpose-built entry point `ReceivingService` calls, distinct from
 * `adjustStock()`: a receipt always has a positive quantity and a real
 * per-unit cost from the actual delivery, and is always tied to a specific
 * `purchase_order_items` row via `referenceType`/`referenceId` — a manual
 * adjustment has neither of those guarantees. No quantity cap here (unlike
 * `recordReturn()`): how much can be received against a PO item is
 * `ReceivingService`'s concern, since it also has to update
 * `quantity_received` atomically with this movement.
 */
export function recordReceipt(input: RecordReceiptInput): InventoryMovementRecord {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new InventoryError('Receipt quantity must be a positive number');
  }
  if (!Number.isFinite(input.unitCost) || input.unitCost < 0) {
    throw new InventoryError('Receipt unit cost must be a non-negative number');
  }
  const db = getDatabase();
  return withTxn(() => {
    const movement = recordMovement({
      db, productId: input.productId, variantId: input.variantId, locationId: input.locationId,
      quantityDelta: input.quantity, movementType: 'receipt', unitCost: input.unitCost,
      referenceType: input.referenceType, referenceId: input.referenceId, actorUserId: input.actorUserId,
    });
    syncLegacyStockQuantity(db, input.productId, input.variantId, input.quantity);
    return movement;
  });
}

export interface RecordTransferInput extends InventoryKey {
  quantity: number;
  direction: 'out' | 'in';
  referenceType: string;
  referenceId: string;
  actorUserId?: string | null;
}

/**
 * Records one side (out or in) of a stock transfer (Milestone 6, Part G/I).
 * `TransferService.completeTransfer()` calls this twice per line — once for
 * the source location with `direction: 'out'`, once for the destination
 * with `direction: 'in'` — inside one `withTxn()`, so both sides (and every
 * other line in the same transfer) commit or roll back together.
 *
 * The `'out'` side enforces the same "cannot take stock negative" policy
 * every other movement type does (Part J: "cannot transfer more than
 * source stock"); the `'in'` side has no such ceiling.
 *
 * Deliberately does **not** call `syncLegacyStockQuantity()`: a transfer
 * moves stock *between* two locations, and `products.stock_quantity` is a
 * single, location-less scalar with no correct value to represent "some at
 * location A, some at location B" — the same reasoning that already
 * excludes variants from that compatibility write (a product with
 * variants/multiple locations has no one number that column could hold).
 */
export function recordTransfer(input: RecordTransferInput): InventoryMovementRecord {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new InventoryError('Transfer quantity must be a positive number');
  }
  const db = getDatabase();
  return withTxn(() => {
    if (input.direction === 'out') {
      const current = getBalance(input.productId, input.variantId, input.locationId) ?? 0;
      if (current < input.quantity) {
        throw new InventoryError(
          `Insufficient stock at the source location for ${input.variantId ? `variant ${input.variantId}` : `product ${input.productId}`} (available: ${current}, requested: ${input.quantity})`, 400,
        );
      }
    }
    return recordMovement({
      db, productId: input.productId, variantId: input.variantId, locationId: input.locationId,
      quantityDelta: input.direction === 'out' ? -input.quantity : input.quantity,
      movementType: input.direction === 'out' ? 'transfer_out' : 'transfer_in',
      referenceType: input.referenceType, referenceId: input.referenceId, actorUserId: input.actorUserId,
    });
  });
}

/**
 * Returns the current balance. When no `inventory_balances` row exists yet
 * for a variant-less product — one created after the v73 migration ran, or
 * whose `track_inventory` was switched on afterward — this falls back to
 * `products.stock_quantity` rather than reporting 0, so a legitimate sale
 * against real existing stock is never rejected just because the ledger
 * hasn't recorded a movement for that product yet. A variant with no
 * balance row genuinely has 0 stock (there is no legacy per-variant number
 * to fall back to).
 */
export function getBalance(productId: string, variantId?: string | null, locationId?: string | null): number | null {
  const db = getDatabase();
  const normalizedVariantId = variantId || null;
  const row = db.prepare(`
    SELECT quantity FROM inventory_balances
    WHERE product_id = ? AND COALESCE(product_variant_id, '') = COALESCE(?, '') AND COALESCE(location_id, '') = COALESCE(?, '')
  `).get(productId, normalizedVariantId, resolveLocationId(locationId)) as { quantity: number } | undefined;
  if (row) return row.quantity;
  if (normalizedVariantId) return null;
  const product = db.prepare('SELECT track_inventory, stock_quantity FROM products WHERE id = ?').get(productId) as { track_inventory: number; stock_quantity: number } | undefined;
  if (!product || !product.track_inventory) return null;
  return product.stock_quantity || 0;
}

export function getMovementHistory(productId: string, variantId?: string | null, limit = 100): InventoryMovementRecord[] {
  const db = getDatabase();
  if (variantId) {
    return db.prepare(`
      SELECT * FROM inventory_movements WHERE product_id = ? AND product_variant_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(productId, variantId, limit) as InventoryMovementRecord[];
  }
  return db.prepare(`
    SELECT * FROM inventory_movements WHERE product_id = ? AND product_variant_id IS NULL
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(productId, limit) as InventoryMovementRecord[];
}

export interface LowStockRow {
  productId: string;
  productName: string;
  variantId: string | null;
  variantName: string | null;
  quantity: number;
  threshold: number;
}

/**
 * Variant-level threshold (Part K) falls back to the parent product's when
 * unset, since `product_variants.low_stock_threshold` is nullable and most
 * variants will never need their own value.
 */
export function listLowStock(): LowStockRow[] {
  const db = getDatabase();
  // A variant-less row (v.id IS NULL) with no balance row yet falls back to
  // products.stock_quantity — the same lazy-migration fallback getBalance()
  // uses, so a product created after v73 ran (or whose track_inventory
  // switched on afterward) shows its real stock here too, not a false 0.
  // A variant with no balance row genuinely has 0 stock.
  const rows = db.prepare(`
    SELECT
      p.id as productId, p.name as productName,
      v.id as variantId, v.name as variantName,
      COALESCE(b.quantity, CASE WHEN v.id IS NULL THEN p.stock_quantity ELSE 0 END) as quantity,
      COALESCE(v.low_stock_threshold, p.low_stock_threshold) as threshold
    FROM products p
    LEFT JOIN product_variants v ON v.product_id = p.id AND v.is_active = 1
    LEFT JOIN inventory_balances b
      ON b.product_id = p.id AND COALESCE(b.product_variant_id, '') = COALESCE(v.id, '')
    WHERE p.track_inventory = 1 AND p.deleted_at IS NULL
  `).all() as LowStockRow[];

  return rows.filter((row) => row.quantity <= row.threshold);
}

