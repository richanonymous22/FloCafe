/**
 * Plemmo Core — sales-conflict resolution engine (SYNC-F, Part C/E/L/M).
 *
 * The domain service that drives a `sales_conflicts` row through its state
 * machine. It is the ONLY place a conflict is resolved, and it enforces, in
 * order:
 *
 *   1. Authorization (Part M) — the canonical `requireCan(user,
 *      'sales.reconcile', { locationId })` path (Milestone 8). A cashier /
 *      waiter / chef has no such permission and is rejected. Location access
 *      is checked against the conflict's location.
 *   2. State machine (Part D) — a terminal (resolved / dismissed) conflict is
 *      never re-resolved; only legal transitions are allowed.
 *   3. Legality + financial safety (Part C/E) — the strategy must be legal for
 *      the conflict type AND the local entity's lifecycle. `accept_remote`
 *      against a completed/paid local record is rejected outright.
 *
 * It NEVER mutates an authoritative sales record. `accept_local` means "the
 * local record stands, mark the conflict resolved"; `accept_remote` (only
 * legal for still-open records) records the decision — the remote value is
 * already durably in the mirror, and materializing it into the authoritative
 * record is deliberately left to a future operator-driven Admin action, not
 * done silently here. `compensate` records a durable reconciliation artifact;
 * it does NOT create a refund / void / payment / inventory transaction (Part
 * F). So resolution can never fabricate or overwrite financial history.
 *
 * Every action is recorded twice: as a durable `sales_reconciliation_actions`
 * row (the conflict's own trail) and as a standard audit event (Part L) —
 * which syncs like any other audit fact and never loops (remote-applied audit
 * events are not re-emitted).
 */

import type Database from 'better-sqlite3';
import { getDatabase, withTxn, now } from '../../db';
import { requireCan, AuthUser } from '../authorization';
import { recordAuditEvent } from '../audit';
import {
  ConflictType, ResolutionStrategy, LifecycleState,
  isResolutionStrategy, isLegalStrategy, canTransition, isTerminalStatus,
  orderLifecycle, billLifecycle, resultingState, legalStrategies,
} from './conflict-model';
import {
  getConflict, updateConflictState, recordReconciliationAction, SalesConflictRow,
} from './conflict-store';

export class ConflictNotFoundError extends Error {
  statusCode = 404;
  constructor(conflictUid: string) { super(`conflict not found: ${conflictUid}`); this.name = 'ConflictNotFoundError'; }
}
export class ConflictStateError extends Error {
  statusCode = 409;
  constructor(message: string) { super(message); this.name = 'ConflictStateError'; }
}
export class IllegalResolutionError extends Error {
  statusCode = 422;
  constructor(message: string) { super(message); this.name = 'IllegalResolutionError'; }
}

/**
 * Determines the local authoritative lifecycle bucket for a conflict's entity
 * — authoritative table first, then the remote mirror, so a conflict on an
 * entity this device never authored still gets a best-effort classification.
 */
export function resolveEntityLifecycle(entityType: string, entityUid: string, db: Database.Database = getDatabase()): LifecycleState {
  if (entityType === 'order' || entityType === 'order_item') {
    const orderUid = entityType === 'order'
      ? entityUid
      : (db.prepare('SELECT order_uid FROM remote_order_items WHERE uid = ?').get(entityUid) as { order_uid: string } | undefined)?.order_uid;
    if (!orderUid) return 'unknown';
    const auth = db.prepare('SELECT status FROM orders WHERE uid = ?').get(orderUid) as { status: string | null } | undefined;
    if (auth) return orderLifecycle(auth.status);
    const mirror = db.prepare('SELECT status FROM remote_orders WHERE uid = ?').get(orderUid) as { status: string | null } | undefined;
    return mirror ? orderLifecycle(mirror.status) : 'unknown';
  }
  if (entityType === 'bill') {
    const auth = db.prepare('SELECT payment_status FROM bills WHERE uid = ?').get(entityUid) as { payment_status: string | null } | undefined;
    if (auth) return billLifecycle(auth.payment_status);
    const mirror = db.prepare('SELECT payment_status FROM remote_bills WHERE uid = ?').get(entityUid) as { payment_status: string | null } | undefined;
    return mirror ? billLifecycle(mirror.payment_status) : 'unknown';
  }
  return 'unknown';
}

/** The strategies an operator may legally apply to this conflict right now. */
export function availableStrategies(conflict: SalesConflictRow, db: Database.Database = getDatabase()): ResolutionStrategy[] {
  if (isTerminalStatus(conflict.status)) return [];
  const lifecycle = resolveEntityLifecycle(conflict.entity_type, conflict.entity_uid, db);
  return legalStrategies(conflict.conflict_type as ConflictType, lifecycle);
}

export interface AcknowledgeInput {
  conflictUid: string;
  user: AuthUser;
  notes?: string | null;
}

/** Moves a conflict open → acknowledged (Part D). */
export function acknowledgeConflict(input: AcknowledgeInput): SalesConflictRow {
  return withTxn(() => {
    const db = getDatabase();
    const conflict = getConflict(input.conflictUid, db);
    if (!conflict) throw new ConflictNotFoundError(input.conflictUid);
    requireCan(input.user, 'sales.reconcile', { locationId: conflict.location_id });
    if (isTerminalStatus(conflict.status)) throw new ConflictStateError(`conflict ${input.conflictUid} is already ${conflict.status}`);
    if (!canTransition(conflict.status, 'acknowledged')) throw new ConflictStateError(`cannot acknowledge a conflict in state ${conflict.status}`);
    updateConflictState(input.conflictUid, { status: 'acknowledged', acknowledged_at: now(), acknowledged_by: input.user.userId }, db);
    recordReconciliationAction({
      conflictUid: input.conflictUid, organizationId: conflict.organization_id, locationId: conflict.location_id,
      entityType: conflict.entity_type, entityUid: conflict.entity_uid, actionType: 'acknowledge',
      actorUserId: input.user.userId, actorRole: input.user.role, notes: input.notes ?? null,
    }, db);
    recordAuditEvent({
      type: 'sync.conflict_acknowledged', actor: { userId: input.user.userId, role: input.user.role },
      entity: { type: conflict.entity_type, id: conflict.entity_uid },
      summary: `Acknowledged ${conflict.conflict_type} conflict on ${conflict.entity_type} ${conflict.entity_uid}`,
      metadata: { conflict_uid: input.conflictUid },
    });
    return getConflict(input.conflictUid, db) as SalesConflictRow;
  });
}

export interface ResolveInput {
  conflictUid: string;
  strategy: ResolutionStrategy | string;
  user: AuthUser;
  notes?: string | null;
  compensationReference?: string | null;
}

/**
 * Resolves a conflict with an explicit strategy. Enforces authorization,
 * legality, financial safety, and the state machine; records the outcome and
 * an audit event. `dismiss` transitions to 'dismissed'; every other legal
 * strategy transitions to 'resolved'. Never mutates an authoritative record.
 */
export function resolveConflict(input: ResolveInput): SalesConflictRow {
  return withTxn(() => {
    const db = getDatabase();
    const conflict = getConflict(input.conflictUid, db);
    if (!conflict) throw new ConflictNotFoundError(input.conflictUid);

    // 1. Authorization — canonical path, with the conflict's location.
    requireCan(input.user, 'sales.reconcile', { locationId: conflict.location_id });

    // 2. State machine — never re-resolve a terminal conflict.
    if (isTerminalStatus(conflict.status)) throw new ConflictStateError(`conflict ${input.conflictUid} is already ${conflict.status}`);

    // 3. Legality + financial safety.
    if (!isResolutionStrategy(input.strategy)) throw new IllegalResolutionError(`unknown resolution strategy: ${input.strategy}`);
    const strategy = input.strategy;
    const lifecycle = resolveEntityLifecycle(conflict.entity_type, conflict.entity_uid, db);
    if (!isLegalStrategy(conflict.conflict_type as ConflictType, strategy, lifecycle)) {
      throw new IllegalResolutionError(
        `strategy '${strategy}' is not legal for a '${conflict.conflict_type}' conflict on a '${lifecycle}' entity `
        + `(a completed financial record can never be silently overwritten)`,
      );
    }

    const targetStatus = strategy === 'dismiss' ? 'dismissed' : 'resolved';
    if (!canTransition(conflict.status, targetStatus)) throw new ConflictStateError(`cannot move conflict from ${conflict.status} to ${targetStatus}`);

    // A 'compensate' resolution writes a durable reconciliation artifact — a
    // decision for an operator/Admin — NOT a financial transaction (Part F).
    if (strategy === 'compensate') {
      recordReconciliationAction({
        conflictUid: input.conflictUid, organizationId: conflict.organization_id, locationId: conflict.location_id,
        entityType: conflict.entity_type, entityUid: conflict.entity_uid, actionType: 'compensation', strategy,
        actorUserId: input.user.userId, actorRole: input.user.role, notes: input.notes ?? null,
        reference: input.compensationReference ?? null,
      }, db);
    }

    updateConflictState(input.conflictUid, {
      status: targetStatus,
      resolution_strategy: strategy,
      resolution_actor: input.user.userId,
      resolved_at: now(),
      resolution_notes: input.notes ?? null,
      compensation_reference: input.compensationReference ?? null,
      resulting_state: resultingState(strategy),
    }, db);

    recordReconciliationAction({
      conflictUid: input.conflictUid, organizationId: conflict.organization_id, locationId: conflict.location_id,
      entityType: conflict.entity_type, entityUid: conflict.entity_uid,
      actionType: strategy === 'dismiss' ? 'dismiss' : 'resolve', strategy,
      actorUserId: input.user.userId, actorRole: input.user.role, notes: input.notes ?? null,
      reference: input.compensationReference ?? null,
    }, db);

    recordAuditEvent({
      type: strategy === 'dismiss' ? 'sync.conflict_dismissed' : 'sync.conflict_resolved',
      actor: { userId: input.user.userId, role: input.user.role },
      entity: { type: conflict.entity_type, id: conflict.entity_uid },
      summary: `Resolved ${conflict.conflict_type} conflict on ${conflict.entity_type} ${conflict.entity_uid} via ${strategy}`,
      metadata: { conflict_uid: input.conflictUid, strategy, resulting_state: resultingState(strategy) },
    });

    return getConflict(input.conflictUid, db) as SalesConflictRow;
  });
}
