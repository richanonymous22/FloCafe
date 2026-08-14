/**
 * Purchase order management (Milestone 5, Part D/E). Everything here is a
 * financial/quantity record; receiving is deliberately a separate module
 * (receiving.ts) so this file never touches inventory directly (Part H).
 */

import { getDatabase, now, withTxn } from '../../db';
import { ulid } from '../../core/ids';
import { getCurrentOrganizationId, getCurrentLocationId } from '../../core/location';

export class PurchaseOrderError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'PurchaseOrderError';
    this.statusCode = statusCode;
  }
}

export type PurchaseOrderStatus = 'draft' | 'ordered' | 'partially_received' | 'received' | 'cancelled';

const EDITABLE_STATUSES: PurchaseOrderStatus[] = ['draft'];
const CANCELLABLE_STATUSES: PurchaseOrderStatus[] = ['draft', 'ordered', 'partially_received'];

export interface CreatePurchaseOrderInput {
  supplierId: string;
  referenceNumber?: string | null;
  orderDate?: string | null;
  expectedDate?: string | null;
  notes?: string | null;
  locationId?: string | null;
  createdBy?: string | null;
}

function recalculateTotals(db: ReturnType<typeof getDatabase>, purchaseOrderId: string): void {
  const totals = db.prepare(`
    SELECT COALESCE(SUM(quantity_ordered * unit_cost), 0) as subtotal, COALESCE(SUM(tax), 0) as tax
    FROM purchase_order_items WHERE purchase_order_id = ? AND deleted_at IS NULL
  `).get(purchaseOrderId) as { subtotal: number; tax: number };
  const total = totals.subtotal + totals.tax;
  db.prepare('UPDATE purchase_orders SET subtotal = ?, tax = ?, total = ?, updated_at = ? WHERE id = ?')
    .run(totals.subtotal, totals.tax, total, now(), purchaseOrderId);
}

export function createPurchaseOrder(input: CreatePurchaseOrderInput): any {
  if (!input.supplierId) {
    throw new PurchaseOrderError('supplier_id is required');
  }
  const db = getDatabase();
  const supplier = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(input.supplierId);
  if (!supplier) {
    throw new PurchaseOrderError(`Supplier ${input.supplierId} not found`, 404);
  }
  const id = ulid();
  const timestamp = now();
  db.prepare(`
    INSERT INTO purchase_orders
      (id, organization_id, location_id, supplier_id, status, reference_number, order_date, expected_date, notes, subtotal, tax, total, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)
  `).run(
    id, getCurrentOrganizationId(), input.locationId || getCurrentLocationId(), input.supplierId,
    input.referenceNumber || null, input.orderDate || null, input.expectedDate || null, input.notes || null,
    input.createdBy || null, timestamp, timestamp,
  );
  return db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
}

function requireDraft(po: any): void {
  if (!EDITABLE_STATUSES.includes(po.status)) {
    throw new PurchaseOrderError(`Purchase order items can only be changed while the order is in draft (current status: ${po.status})`, 400);
  }
}

export interface PurchaseOrderItemInput {
  productId: string;
  variantId?: string | null;
  quantityOrdered: number;
  unitCost: number;
  tax?: number;
}

export function addItem(purchaseOrderId: string, input: PurchaseOrderItemInput): any {
  if (!Number.isFinite(input.quantityOrdered) || input.quantityOrdered <= 0) {
    throw new PurchaseOrderError('quantity_ordered must be a positive number');
  }
  if (!Number.isFinite(input.unitCost) || input.unitCost < 0) {
    throw new PurchaseOrderError('unit_cost must be a non-negative number');
  }
  const db = getDatabase();
  return withTxn(() => {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(purchaseOrderId) as any;
    if (!po) throw new PurchaseOrderError(`Purchase order ${purchaseOrderId} not found`, 404);
    requireDraft(po);

    const product = db.prepare('SELECT id FROM products WHERE id = ?').get(input.productId);
    if (!product) throw new PurchaseOrderError(`Product ${input.productId} not found`, 404);
    if (input.variantId) {
      const variant = db.prepare('SELECT id FROM product_variants WHERE id = ? AND product_id = ?').get(input.variantId, input.productId);
      if (!variant) throw new PurchaseOrderError(`Variant ${input.variantId} not found for product ${input.productId}`, 404);
    }

    const tax = input.tax || 0;
    const lineTotal = input.quantityOrdered * input.unitCost + tax;
    const id = ulid();
    const timestamp = now();
    db.prepare(`
      INSERT INTO purchase_order_items
        (id, purchase_order_id, product_id, product_variant_id, quantity_ordered, unit_cost, tax, line_total, quantity_received, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, purchaseOrderId, input.productId, input.variantId || null, input.quantityOrdered, input.unitCost, tax, lineTotal, timestamp, timestamp);

    recalculateTotals(db, purchaseOrderId);
    return db.prepare('SELECT * FROM purchase_order_items WHERE id = ?').get(id);
  });
}

export function updateItem(purchaseOrderId: string, itemId: string, input: Partial<PurchaseOrderItemInput>): any {
  const db = getDatabase();
  return withTxn(() => {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(purchaseOrderId) as any;
    if (!po) throw new PurchaseOrderError(`Purchase order ${purchaseOrderId} not found`, 404);
    requireDraft(po);

    const item = db.prepare('SELECT * FROM purchase_order_items WHERE id = ? AND purchase_order_id = ? AND deleted_at IS NULL').get(itemId, purchaseOrderId) as any;
    if (!item) throw new PurchaseOrderError(`Purchase order item ${itemId} not found`, 404);

    const quantityOrdered = input.quantityOrdered !== undefined ? input.quantityOrdered : item.quantity_ordered;
    const unitCost = input.unitCost !== undefined ? input.unitCost : item.unit_cost;
    const tax = input.tax !== undefined ? input.tax : item.tax;
    if (!Number.isFinite(quantityOrdered) || quantityOrdered <= 0) {
      throw new PurchaseOrderError('quantity_ordered must be a positive number');
    }
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw new PurchaseOrderError('unit_cost must be a non-negative number');
    }
    const lineTotal = quantityOrdered * unitCost + tax;

    db.prepare('UPDATE purchase_order_items SET quantity_ordered = ?, unit_cost = ?, tax = ?, line_total = ?, updated_at = ? WHERE id = ?')
      .run(quantityOrdered, unitCost, tax, lineTotal, now(), itemId);

    recalculateTotals(db, purchaseOrderId);
    return db.prepare('SELECT * FROM purchase_order_items WHERE id = ?').get(itemId);
  });
}

export function removeItem(purchaseOrderId: string, itemId: string): void {
  const db = getDatabase();
  withTxn(() => {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(purchaseOrderId) as any;
    if (!po) throw new PurchaseOrderError(`Purchase order ${purchaseOrderId} not found`, 404);
    requireDraft(po);
    // SYNC-0 Part C: tombstone, not hard delete — the row stays for a future
    // sync engine to propagate the removal, but is absent from every active
    // query (which all filter `deleted_at IS NULL`).
    const result = db.prepare('UPDATE purchase_order_items SET deleted_at = ?, updated_at = ? WHERE id = ? AND purchase_order_id = ? AND deleted_at IS NULL')
      .run(now(), now(), itemId, purchaseOrderId);
    if (result.changes === 0) throw new PurchaseOrderError(`Purchase order item ${itemId} not found`, 404);
    recalculateTotals(db, purchaseOrderId);
  });
}

export function markOrdered(purchaseOrderId: string): any {
  const db = getDatabase();
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(purchaseOrderId) as any;
  if (!po) throw new PurchaseOrderError(`Purchase order ${purchaseOrderId} not found`, 404);
  if (po.status !== 'draft') {
    throw new PurchaseOrderError(`Only a draft purchase order can be marked ordered (current status: ${po.status})`, 400);
  }
  const itemCount = (db.prepare('SELECT COUNT(*) as c FROM purchase_order_items WHERE purchase_order_id = ? AND deleted_at IS NULL').get(purchaseOrderId) as { c: number }).c;
  if (itemCount === 0) {
    throw new PurchaseOrderError('A purchase order needs at least one item before it can be ordered');
  }
  db.prepare("UPDATE purchase_orders SET status = 'ordered', updated_at = ? WHERE id = ?").run(now(), purchaseOrderId);
  return db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(purchaseOrderId);
}

export function cancelPurchaseOrder(purchaseOrderId: string): any {
  const db = getDatabase();
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(purchaseOrderId) as any;
  if (!po) throw new PurchaseOrderError(`Purchase order ${purchaseOrderId} not found`, 404);
  if (!CANCELLABLE_STATUSES.includes(po.status)) {
    throw new PurchaseOrderError(`A purchase order in status '${po.status}' cannot be cancelled`, 400);
  }
  db.prepare("UPDATE purchase_orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), purchaseOrderId);
  return db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(purchaseOrderId);
}

export function getPurchaseOrder(id: string): any {
  const db = getDatabase();
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
  if (!po) return null;
  const items = db.prepare('SELECT * FROM purchase_order_items WHERE purchase_order_id = ? AND deleted_at IS NULL ORDER BY created_at ASC').all(id);
  return { ...(po as object), items };
}

export function listPurchaseOrders(opts: { status?: PurchaseOrderStatus; supplierId?: string } = {}): any[] {
  const db = getDatabase();
  const wheres: string[] = [];
  const params: any[] = [];
  if (opts.status) { wheres.push('status = ?'); params.push(opts.status); }
  if (opts.supplierId) { wheres.push('supplier_id = ?'); params.push(opts.supplierId); }
  const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM purchase_orders ${where} ORDER BY created_at DESC`).all(...params) as any[];
}
