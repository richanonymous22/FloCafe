/**
 * Plemmo Core — inventory movement sync events (SYNC-A).
 *
 * Builds the typed outbox event for an inventory movement (the first, and
 * for SYNC-A the only, synchronized entity) and appends it. Called from
 * `InventoryService.recordMovement()` inside the same transaction as the
 * movement write, so the movement and its sync event commit or roll back
 * together.
 */

import { getDatabase } from '../../db';
import { appendOutboxEvent, OutboxRow } from './outbox';
import { InventoryMovementEventPayload } from './types';

interface MovementRowLike {
  id: string;
  organization_id: string | null;
  location_id: string | null;
  product_id: string;
  product_variant_id: string | null;
  quantity_delta: number;
  movement_type: string;
  reason: string | null;
  reference_type: string | null;
  reference_id: string | null;
  unit_cost: number | null;
  actor_user_id: string | null;
  metadata: string | null;
  created_at: string;
  [column: string]: unknown;
}

/**
 * Maps an `inventory_movements` row to the business-fact payload. Note what
 * is deliberately NOT copied: `balance_after` (a derived projection) and any
 * column not part of the movement fact itself. `metadata` is passed through
 * parsed, since it is genuine business data already on the movement (e.g. a
 * return's sold-line reference) — not a derived value or a device-local one.
 */
export function buildInventoryMovementPayload(movement: MovementRowLike): InventoryMovementEventPayload {
  let metadata: Record<string, unknown> | null = null;
  if (movement.metadata) {
    try { metadata = JSON.parse(movement.metadata); } catch { metadata = null; }
  }
  return {
    schema_version: 1,
    movement_uid: movement.id,
    organization_id: movement.organization_id,
    location_id: movement.location_id,
    product_id: movement.product_id,
    product_variant_id: movement.product_variant_id,
    quantity_delta: movement.quantity_delta,
    movement_type: movement.movement_type,
    reason: movement.reason,
    reference_type: movement.reference_type,
    reference_id: movement.reference_id,
    unit_cost: movement.unit_cost,
    actor_user_id: movement.actor_user_id,
    metadata,
    created_at: movement.created_at,
  };
}

/**
 * Appends the sync outbox event for a just-written inventory movement.
 * `db` is the caller's transaction connection, so this joins the same
 * atomic unit as the movement and balance writes.
 */
export function appendInventoryMovementEvent(db: ReturnType<typeof getDatabase>, movement: MovementRowLike): OutboxRow {
  return appendOutboxEvent({
    db,
    entityType: 'inventory_movement',
    entityUid: movement.id,
    operation: 'create',
    organizationId: movement.organization_id,
    locationId: movement.location_id,
    payload: buildInventoryMovementPayload(movement),
  });
}
