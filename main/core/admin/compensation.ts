/**
 * Plemmo Admin — safe compensation execution (COMMERCIALIZATION, Part B).
 *
 * SYNC-F/G deliberately stopped at `manual_action_required` because the
 * compensation primitives had not been audited for exactly-once Admin
 * invocation. This milestone completed that audit:
 *
 *   - `refundPayment` and `voidPayment` (main/core/payment.ts) are ALREADY
 *     exactly-once safe: they take a `PaymentIdempotency` key checked against
 *     the `payment_idempotency` table (a replay returns the prior result), run
 *     inside `withTxn`, and enforce state guards (no double refund, no
 *     over-refund, no voiding a settled/refunded payment). Their payment /
 *     inventory / audit / sync effects are the same as a live refund/void.
 *     → SAFE to invoke from Admin.
 *   - Inventory *correction*: PLATFORM-HARDENING (Part D) added an
 *     `idempotencyKey` to `adjustStock`, so an Admin correction is now
 *     exactly-once (a repeat with the same key returns the prior movement
 *     without a second delta, and keeps the negative-stock guard).
 *     → SAFE to invoke from Admin.
 *
 * The Admin path here derives a DETERMINISTIC idempotency key from the
 * conflict + action + payment, so pressing "issue refund" twice for the same
 * conflict yields exactly ONE refund. It links the compensation to the
 * conflict (a durable reconciliation action) and audits it. Authorization is
 * the canonical `sales.reconcile`.
 */

import { createHash } from 'crypto';
import { getDatabase, withTxn, now } from '../../db';
import { requireCan, AuthUser } from '../authorization';
import { recordAuditEvent } from '../audit';
import { refundPayment, voidPayment, PaymentIdempotency } from '../payment';
import { adjustStock } from '../inventory';
import { getConflict, updateConflictState, recordReconciliationAction } from '../sync/conflict-store';
import { ConflictNotFoundError } from '../sync/conflict-resolution';

export type CompensationAction = 'refund' | 'void';

export class CompensationError extends Error {
  statusCode = 400;
  constructor(message: string, statusCode = 400) { super(message); this.name = 'CompensationError'; this.statusCode = statusCode; }
}

export interface CompensationInput {
  conflictUid: string;
  action: CompensationAction;
  paymentId: string;
  amountMinor?: number;   // required for refund
  reason?: string | null;
  user: AuthUser;
}

/** Deterministic idempotency key → exactly-once compensation per (conflict, action, payment). */
function idempotencyFor(conflictUid: string, action: string, paymentId: string, user: AuthUser): PaymentIdempotency {
  const key = `compensation:${conflictUid}:${action}:${paymentId}`;
  const requestHash = createHash('sha256').update(key).digest('hex');
  return { key, requestHash, userId: user.userId };
}

/**
 * Executes a SAFE compensation (refund or void) for a conflict and links it.
 * Exactly-once: a repeated call replays the same refund/void. Never mutates an
 * authoritative sale directly — it goes through the audited payment primitives.
 */
export function executeCompensation(input: CompensationInput): { conflict: unknown; result: unknown } {
  return withTxn(() => {
    const db = getDatabase();
    const conflict = getConflict(input.conflictUid, db);
    if (!conflict) throw new ConflictNotFoundError(input.conflictUid);
    requireCan(input.user, 'sales.reconcile', { locationId: conflict.location_id });

    const idempotency = idempotencyFor(input.conflictUid, input.action, input.paymentId, input.user);
    let result: unknown;
    if (input.action === 'refund') {
      if (!Number.isInteger(input.amountMinor) || (input.amountMinor as number) <= 0) {
        throw new CompensationError('A positive integer amountMinor is required for a refund');
      }
      result = refundPayment({ paymentId: input.paymentId, amountMinor: input.amountMinor as number, reason: input.reason ?? 'conflict compensation', actorUserId: input.user.userId, idempotency });
    } else {
      result = voidPayment({ paymentId: input.paymentId, reason: input.reason ?? 'conflict compensation', actorUserId: input.user.userId, idempotency });
    }

    // Link + resolve the conflict as a recorded compensation.
    recordReconciliationAction({
      conflictUid: input.conflictUid, organizationId: conflict.organization_id, locationId: conflict.location_id,
      entityType: conflict.entity_type, entityUid: conflict.entity_uid, actionType: 'compensation', strategy: 'compensate',
      actorUserId: input.user.userId, actorRole: input.user.role, notes: input.reason ?? null,
      reference: `${input.action}:${input.paymentId}`,
    }, db);
    if (conflict.status !== 'resolved' && conflict.status !== 'dismissed') {
      updateConflictState(input.conflictUid, {
        status: 'resolved', resolution_strategy: 'compensate', resolution_actor: input.user.userId,
        resolved_at: now(), resolution_notes: input.reason ?? null,
        compensation_reference: `${input.action}:${input.paymentId}`, resulting_state: 'compensation_executed',
      }, db);
    }
    recordAuditEvent({
      type: 'sync.reconciliation_recorded', actor: { userId: input.user.userId, role: input.user.role },
      entity: { type: conflict.entity_type, id: conflict.entity_uid },
      summary: `Executed ${input.action} compensation for conflict ${input.conflictUid}`,
      metadata: { conflict_uid: input.conflictUid, action: input.action, payment_id: input.paymentId },
    });

    return { conflict: getConflict(input.conflictUid, db), result };
  });
}

export interface InventoryCorrectionInput {
  conflictUid: string;
  productId: string;
  variantId?: string | null;
  locationId?: string | null;
  quantityDelta: number;
  reason: string;
  user: AuthUser;
}

/**
 * Executes a SAFE, exactly-once inventory correction for a conflict
 * (PLATFORM-HARDENING Part D). The deterministic idempotency key
 * (`invcorr:<conflict>:<product>:<variant>`) makes a repeated correction a
 * no-op — no double-decrement, no silent rewrite. Links + audits like the
 * payment path. `adjustStock` keeps its negative-stock guard and emits the
 * inventory sync fact.
 */
export function executeInventoryCorrection(input: InventoryCorrectionInput): { conflict: unknown; movement: unknown } {
  return withTxn(() => {
    const db = getDatabase();
    const conflict = getConflict(input.conflictUid, db);
    if (!conflict) throw new ConflictNotFoundError(input.conflictUid);
    requireCan(input.user, 'sales.reconcile', { locationId: conflict.location_id ?? input.locationId ?? null });
    const idempotencyKey = `invcorr:${input.conflictUid}:${input.productId}:${input.variantId ?? ''}`;
    const movement = adjustStock({
      productId: input.productId, variantId: input.variantId ?? null, locationId: input.locationId ?? null,
      quantityDelta: input.quantityDelta, reason: input.reason || 'conflict inventory correction',
      actorUserId: input.user.userId, idempotencyKey,
    });
    recordReconciliationAction({
      conflictUid: input.conflictUid, organizationId: conflict.organization_id, locationId: conflict.location_id,
      entityType: conflict.entity_type, entityUid: conflict.entity_uid, actionType: 'compensation', strategy: 'compensate',
      actorUserId: input.user.userId, actorRole: input.user.role, notes: input.reason ?? null,
      reference: `inventory_correction:${(movement as { id?: string }).id ?? idempotencyKey}`,
    }, db);
    recordAuditEvent({
      type: 'sync.reconciliation_recorded', actor: { userId: input.user.userId, role: input.user.role },
      entity: { type: 'inventory_correction', id: input.productId },
      summary: `Executed inventory correction (${input.quantityDelta}) for conflict ${input.conflictUid}`,
      metadata: { conflict_uid: input.conflictUid, product_id: input.productId, delta: input.quantityDelta },
    });
    return { conflict: getConflict(input.conflictUid, db), movement };
  });
}
