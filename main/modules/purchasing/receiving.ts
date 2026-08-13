/**
 * Goods receiving (Milestone 5, Part F). The only module allowed to move a
 * purchase order's items from "ordered" toward "received", and the only
 * caller of InventoryService.recordReceipt() for a purchase order — Part H
 * is explicit that purchase-order routes must never touch
 * inventory_balances/products.stock_quantity directly.
 */

import { getDatabase, now, withTxn } from '../../db';
import { recordReceipt } from '../../core/inventory';
import { PurchaseOrderError } from './purchase-orders';

export interface ReceiveIdempotency {
  key: string;
  requestHash: string;
  userId: string;
}

export interface ReceiveItemInput {
  itemId: string;
  quantity: number;
  /** Actual cost for this receipt, if it differs from the PO's expected unit_cost (Part G). Defaults to the PO item's unit_cost. */
  unitCost?: number | null;
}

export interface ReceiveGoodsInput {
  purchaseOrderId: string;
  items: ReceiveItemInput[];
  actorUserId?: string | null;
  idempotency?: ReceiveIdempotency | null;
}

export interface ReceiveGoodsResult {
  purchaseOrder: any;
  movements: any[];
  idempotentReplay: boolean;
}

/**
 * Receives some or all of a purchase order's outstanding quantity.
 * Rejects — rather than clamping — any line that would receive more than
 * its own remaining `quantity_ordered - quantity_received` (Part J: "be
 * conservative"). Idempotent via the existing `order_idempotency` table
 * (Part P) — reused rather than inventing a parallel mechanism, the same
 * table `SaleService.createSale()` already replays from.
 */
export function receiveGoods(input: ReceiveGoodsInput): ReceiveGoodsResult {
  if (!input.items || input.items.length === 0) {
    throw new PurchaseOrderError('At least one item is required to receive');
  }
  const db = getDatabase();

  return withTxn(() => {
    if (input.idempotency) {
      const prior = db.prepare(`
        SELECT request_hash, response_json FROM order_idempotency WHERE user_id = ? AND idempotency_key = ?
      `).get(input.idempotency.userId, input.idempotency.key) as { request_hash: string; response_json: string } | undefined;
      if (prior) {
        if (prior.request_hash !== input.idempotency.requestHash) {
          throw new PurchaseOrderError('Idempotency-Key was already used for a different receiving request', 409);
        }
        return { ...JSON.parse(prior.response_json), idempotentReplay: true };
      }
    }

    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(input.purchaseOrderId) as any;
    if (!po) throw new PurchaseOrderError(`Purchase order ${input.purchaseOrderId} not found`, 404);
    if (!['ordered', 'partially_received'].includes(po.status)) {
      throw new PurchaseOrderError(`Purchase order in status '${po.status}' cannot receive goods`, 400);
    }

    const movements: any[] = [];
    for (const line of input.items) {
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
        throw new PurchaseOrderError('Receive quantity must be a positive number');
      }
      const item = db.prepare('SELECT * FROM purchase_order_items WHERE id = ? AND purchase_order_id = ?')
        .get(line.itemId, input.purchaseOrderId) as any;
      if (!item) throw new PurchaseOrderError(`Purchase order item ${line.itemId} not found`, 404);

      const remaining = item.quantity_ordered - item.quantity_received;
      if (line.quantity > remaining) {
        throw new PurchaseOrderError(
          `Cannot receive ${line.quantity} of item ${line.itemId} — only ${remaining} remain outstanding`, 400,
        );
      }

      const unitCost = line.unitCost != null ? line.unitCost : item.unit_cost;
      const movement = recordReceipt({
        productId: item.product_id, variantId: item.product_variant_id, locationId: po.location_id,
        quantity: line.quantity, unitCost,
        referenceType: 'purchase_order_item', referenceId: item.id,
        actorUserId: input.actorUserId,
      });
      movements.push(movement);

      db.prepare('UPDATE purchase_order_items SET quantity_received = quantity_received + ?, updated_at = ? WHERE id = ?')
        .run(line.quantity, now(), item.id);
    }

    const items = db.prepare('SELECT quantity_ordered, quantity_received FROM purchase_order_items WHERE purchase_order_id = ?')
      .all(input.purchaseOrderId) as { quantity_ordered: number; quantity_received: number }[];
    const fullyReceived = items.every((i) => i.quantity_received >= i.quantity_ordered);
    const anyReceived = items.some((i) => i.quantity_received > 0);
    const newStatus = fullyReceived ? 'received' : (anyReceived ? 'partially_received' : po.status);
    db.prepare('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, now(), input.purchaseOrderId);

    const purchaseOrder = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(input.purchaseOrderId);
    const response = { purchaseOrder, movements };

    if (input.idempotency) {
      db.prepare('INSERT INTO order_idempotency (user_id, idempotency_key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(input.idempotency.userId, input.idempotency.key, input.idempotency.requestHash, JSON.stringify(response), now());
    }

    return { ...response, idempotentReplay: false };
  });
}
