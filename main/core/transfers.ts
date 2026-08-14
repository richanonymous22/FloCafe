/**
 * Plemmo Core — TransferService (Milestone 6, Part G).
 *
 * Moves stock between two locations. Deliberately simple states —
 * `draft → completed | cancelled`, no `in_transit` — since no existing
 * transfer workflow needs one (Part G: "if the existing business model
 * does not require an in_transit workflow... do not overengineer").
 *
 * Vertical-neutral, like `sale.ts`/`payment.ts`/`inventory.ts`: a transfer
 * is a Core concept either vertical could eventually use, not a
 * retail-specific one.
 */

import { getDatabase, now, withTxn } from '../db';
import { ulid } from './ids';
import { recordTransfer } from './inventory';
import { getCurrentOrganizationId } from './location';

export class TransferError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'TransferError';
    this.statusCode = statusCode;
  }
}

export interface CreateTransferInput {
  fromLocationId: string;
  toLocationId: string;
  referenceNumber?: string | null;
  notes?: string | null;
  createdBy?: string | null;
}

function requireLocation(db: ReturnType<typeof getDatabase>, id: string): void {
  const row = db.prepare('SELECT id FROM locations WHERE id = ?').get(id);
  if (!row) throw new TransferError(`Location ${id} not found`, 404);
}

export function createTransfer(input: CreateTransferInput): any {
  if (!input.fromLocationId || !input.toLocationId) {
    throw new TransferError('from_location_id and to_location_id are required');
  }
  if (input.fromLocationId === input.toLocationId) {
    throw new TransferError('Source and destination locations must be different');
  }
  const db = getDatabase();
  requireLocation(db, input.fromLocationId);
  requireLocation(db, input.toLocationId);

  const id = ulid();
  const timestamp = now();
  db.prepare(`
    INSERT INTO stock_transfers
      (id, organization_id, from_location_id, to_location_id, status, reference_number, notes, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
  `).run(id, getCurrentOrganizationId(), input.fromLocationId, input.toLocationId, input.referenceNumber || null, input.notes || null, input.createdBy || null, timestamp, timestamp);

  return db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(id);
}

function requireDraft(transfer: any): void {
  if (transfer.status !== 'draft') {
    throw new TransferError(`Transfer items can only be changed while the transfer is in draft (current status: ${transfer.status})`, 400);
  }
}

export interface TransferItemInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

export function addTransferItem(transferId: string, input: TransferItemInput): any {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new TransferError('quantity must be a positive number');
  }
  const db = getDatabase();
  return withTxn(() => {
    const transfer = db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(transferId) as any;
    if (!transfer) throw new TransferError(`Transfer ${transferId} not found`, 404);
    requireDraft(transfer);

    const product = db.prepare('SELECT id FROM products WHERE id = ?').get(input.productId);
    if (!product) throw new TransferError(`Product ${input.productId} not found`, 404);
    if (input.variantId) {
      const variant = db.prepare('SELECT id FROM product_variants WHERE id = ? AND product_id = ?').get(input.variantId, input.productId);
      if (!variant) throw new TransferError(`Variant ${input.variantId} not found for product ${input.productId}`, 404);
    }

    const id = ulid();
    const timestamp = now();
    db.prepare(`
      INSERT INTO stock_transfer_items (id, stock_transfer_id, product_id, product_variant_id, quantity, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, transferId, input.productId, input.variantId || null, input.quantity, timestamp);

    return db.prepare('SELECT * FROM stock_transfer_items WHERE id = ?').get(id);
  });
}

export function removeTransferItem(transferId: string, itemId: string): void {
  const db = getDatabase();
  withTxn(() => {
    const transfer = db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(transferId) as any;
    if (!transfer) throw new TransferError(`Transfer ${transferId} not found`, 404);
    requireDraft(transfer);
    // SYNC-0 Part C: tombstone, not hard delete (mirrors purchase-order line
    // removal) — the row stays for a future sync engine, absent from every
    // active query.
    const result = db.prepare('UPDATE stock_transfer_items SET deleted_at = ? WHERE id = ? AND stock_transfer_id = ? AND deleted_at IS NULL')
      .run(now(), itemId, transferId);
    if (result.changes === 0) throw new TransferError(`Transfer item ${itemId} not found`, 404);
  });
}

/**
 * Completes a transfer: for every line, records a `transfer_out` movement
 * at the source location and a `transfer_in` movement at the destination,
 * both referencing this transfer (`reference_type = 'stock_transfer'`).
 * All lines commit or fail together — if any line's source location lacks
 * enough stock, the entire completion (including any earlier line that
 * would otherwise have succeeded) rolls back (Part H).
 */
export function completeTransfer(transferId: string, actorUserId?: string | null): any {
  const db = getDatabase();
  return withTxn(() => {
    const transfer = db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(transferId) as any;
    if (!transfer) throw new TransferError(`Transfer ${transferId} not found`, 404);
    if (transfer.status !== 'draft') {
      throw new TransferError(`Only a draft transfer can be completed (current status: ${transfer.status})`, 400);
    }
    const items = db.prepare('SELECT * FROM stock_transfer_items WHERE stock_transfer_id = ? AND deleted_at IS NULL').all(transferId) as any[];
    if (items.length === 0) {
      throw new TransferError('A transfer needs at least one item before it can be completed');
    }

    for (const item of items) {
      recordTransfer({
        productId: item.product_id, variantId: item.product_variant_id, locationId: transfer.from_location_id,
        quantity: item.quantity, direction: 'out', referenceType: 'stock_transfer', referenceId: transfer.id, actorUserId,
      });
      recordTransfer({
        productId: item.product_id, variantId: item.product_variant_id, locationId: transfer.to_location_id,
        quantity: item.quantity, direction: 'in', referenceType: 'stock_transfer', referenceId: transfer.id, actorUserId,
      });
    }

    db.prepare("UPDATE stock_transfers SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?")
      .run(now(), now(), transferId);
    return db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(transferId);
  });
}

export function cancelTransfer(transferId: string): any {
  const db = getDatabase();
  const transfer = db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(transferId) as any;
  if (!transfer) throw new TransferError(`Transfer ${transferId} not found`, 404);
  if (transfer.status !== 'draft') {
    throw new TransferError(`Only a draft transfer can be cancelled (current status: ${transfer.status})`, 400);
  }
  db.prepare("UPDATE stock_transfers SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), transferId);
  return db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(transferId);
}

export function getTransfer(id: string): any {
  const db = getDatabase();
  const transfer = db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(id);
  if (!transfer) return null;
  const items = db.prepare('SELECT * FROM stock_transfer_items WHERE stock_transfer_id = ? AND deleted_at IS NULL ORDER BY created_at ASC').all(id);
  return { ...(transfer as object), items };
}

export function listTransfers(opts: { status?: string; locationId?: string } = {}): any[] {
  const db = getDatabase();
  const wheres: string[] = [];
  const params: any[] = [];
  if (opts.status) { wheres.push('status = ?'); params.push(opts.status); }
  if (opts.locationId) { wheres.push('(from_location_id = ? OR to_location_id = ?)'); params.push(opts.locationId, opts.locationId); }
  const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM stock_transfers ${where} ORDER BY created_at DESC`).all(...params) as any[];
}
