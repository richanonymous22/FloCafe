/**
 * Plemmo Core — apply remote inventory movements (SYNC-B, Part K/L).
 *
 * A movement pulled from the cloud is a synchronized FACT that already
 * happened on another device. Applying it locally must:
 *
 *   1. NOT re-run the local sale/adjust logic — it is not a new local
 *      operation, just a fact to record. So it does NOT go through
 *      `recordMovement()`, which would append a new outbox event and send
 *      the same fact back to the cloud — an infinite loop. This is the core
 *      loop-prevention mechanism (Part L): the remote-apply path has no
 *      outbox append at all.
 *   2. Be idempotent by `movement_uid` — re-pulling or re-applying the same
 *      fact must not double-count.
 *   3. Not touch `products.stock_quantity` (a local compatibility mirror,
 *      not a sync primitive).
 *   4. Carry an explicit origin marker (`metadata.sync_origin = 'remote'`)
 *      so a remote-sourced movement is distinguishable from a local one.
 */

import type Database from 'better-sqlite3';
import { now } from '../../db';
import { InventoryMovementEventPayload } from './types';

type Db = Database.Database;

export type RemoteApplyResult = 'applied' | 'skipped';

export function applyRemoteInventoryMovement(db: Db, payload: InventoryMovementEventPayload): RemoteApplyResult {
  // Idempotency (Part D/K): the movement's own uid IS the business fact
  // identity. If we already hold this fact, applying again is a no-op.
  const exists = db.prepare('SELECT 1 FROM inventory_movements WHERE id = ?').get(payload.movement_uid);
  if (exists) return 'skipped';

  const variantId = payload.product_variant_id || null;
  const locationId = payload.location_id || null;

  // Balance projection: add the delta to the local balance for this
  // (product, variant, location). Seeded at 0 for a remote fact — the local
  // stock_quantity mirror is not the right seed for another device's fact,
  // and full cross-device balance reconciliation is future work (documented).
  const existingBalance = db.prepare(`
    SELECT id, quantity FROM inventory_balances
    WHERE product_id = ? AND COALESCE(product_variant_id, '') = COALESCE(?, '') AND COALESCE(location_id, '') = COALESCE(?, '')
  `).get(payload.product_id, variantId, locationId) as { id: string; quantity: number } | undefined;
  const balanceAfter = (existingBalance ? existingBalance.quantity : 0) + payload.quantity_delta;
  if (existingBalance) {
    db.prepare('UPDATE inventory_balances SET quantity = ?, updated_at = ? WHERE id = ?').run(balanceAfter, now(), existingBalance.id);
  } else {
    db.prepare(`INSERT INTO inventory_balances (id, product_id, product_variant_id, location_id, quantity, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`${payload.movement_uid}-bal`, payload.product_id, variantId, locationId, balanceAfter, now());
  }

  const metadata = { ...(payload.metadata ?? {}), sync_origin: 'remote' };
  db.prepare(`
    INSERT INTO inventory_movements
      (id, organization_id, product_id, product_variant_id, location_id, quantity_delta, movement_type, reason,
       reference_type, reference_id, unit_cost, actor_user_id, balance_after, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.movement_uid, payload.organization_id, payload.product_id, variantId, locationId,
    payload.quantity_delta, payload.movement_type, payload.reason,
    payload.reference_type, payload.reference_id, payload.unit_cost, payload.actor_user_id,
    balanceAfter, JSON.stringify(metadata), payload.created_at,
  );
  // Deliberately NO appendOutboxEvent(...) here — that is the loop prevention.
  return 'applied';
}
