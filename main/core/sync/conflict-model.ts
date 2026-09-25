/**
 * Plemmo Core — the formal sales-conflict model (SYNC-F, Part B/C/D/E).
 *
 * Pure, dependency-free domain logic: the closed conflict taxonomy, the
 * conflict state machine, and the legality matrix that decides which
 * resolution strategy is permitted for a given conflict type and lifecycle
 * state. Kept side-effect-free so it is trivially unit-testable and can be
 * reasoned about in isolation — the resolution engine (conflict-resolution.ts)
 * and the cloud server (defense-in-depth re-validation) both derive their
 * decisions from these tables, so "what is legal" is defined in exactly one
 * place.
 *
 * ## Financial safety rule (Part C)
 *
 * A completed local transaction must NEVER be silently changed by
 * synchronization. Concretely: `accept_remote` (blindly taking the remote
 * value) is ILLEGAL whenever the local entity is in a completed/paid
 * lifecycle state, and is ALWAYS illegal for the two intrinsically financial
 * conflict types (`payment_conflict`, `completion_conflict`). High-risk
 * conflicts are resolved by PRESERVE + FLAG + RECONCILE (accept_local /
 * retain_both / compensate / dismiss), never by OVERWRITE.
 */

/** The closed conflict-type union (Part B). Do not widen without a spec change. */
export type ConflictType =
  | 'concurrent_update'   // two devices produced snapshots of the same entity
  | 'stale_snapshot'      // an out-of-order lower-version snapshot arrived
  | 'parent_missing'      // a child event arrived before its parent
  | 'lifecycle_conflict'  // divergent lifecycle transitions (e.g. cancel vs edit)
  | 'payment_conflict'    // divergent/duplicate payment linkage on a bill/order
  | 'completion_conflict'; // a remote edit targets a locally completed sale

export const CONFLICT_TYPES: readonly ConflictType[] = [
  'concurrent_update', 'stale_snapshot', 'parent_missing',
  'lifecycle_conflict', 'payment_conflict', 'completion_conflict',
];

export function isConflictType(t: string): t is ConflictType {
  return (CONFLICT_TYPES as readonly string[]).includes(t);
}

/** The conflict state machine (Part D). resolved/dismissed are terminal. */
export type ConflictStatus = 'open' | 'acknowledged' | 'resolving' | 'resolved' | 'dismissed';

export const TERMINAL_STATUSES: readonly ConflictStatus[] = ['resolved', 'dismissed'];

export function isTerminalStatus(s: ConflictStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(s);
}

/** Allowed state transitions. A transition not listed here is rejected. */
const ALLOWED_TRANSITIONS: Record<ConflictStatus, readonly ConflictStatus[]> = {
  open: ['acknowledged', 'resolving', 'resolved', 'dismissed'],
  acknowledged: ['resolving', 'resolved', 'dismissed'],
  resolving: ['resolved', 'dismissed', 'acknowledged'],
  resolved: [],
  dismissed: [],
};

export function canTransition(from: ConflictStatus, to: ConflictStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** The closed set of resolution strategies (Part E). */
export type ResolutionStrategy = 'accept_local' | 'accept_remote' | 'retain_both' | 'compensate' | 'dismiss';

export const RESOLUTION_STRATEGIES: readonly ResolutionStrategy[] = [
  'accept_local', 'accept_remote', 'retain_both', 'compensate', 'dismiss',
];

export function isResolutionStrategy(s: string): s is ResolutionStrategy {
  return (RESOLUTION_STRATEGIES as readonly string[]).includes(s);
}

/**
 * The local authoritative entity's lifecycle bucket, as it bears on financial
 * safety. `completed` means the local record is final/paid — the class of
 * state that must never be silently overwritten by a remote value.
 */
export type LifecycleState = 'completed' | 'open' | 'unknown';

const COMPLETED_ORDER_STATES = new Set(['completed', 'cancelled', 'refunded', 'void', 'voided']);
const COMPLETED_PAYMENT_STATES = new Set(['paid', 'refunded']);

/** Classifies an order status string into a lifecycle bucket. */
export function orderLifecycle(status: string | null | undefined): LifecycleState {
  if (!status) return 'unknown';
  return COMPLETED_ORDER_STATES.has(status) ? 'completed' : 'open';
}

/** Classifies a bill payment_status string into a lifecycle bucket. */
export function billLifecycle(paymentStatus: string | null | undefined): LifecycleState {
  if (!paymentStatus) return 'unknown';
  return COMPLETED_PAYMENT_STATES.has(paymentStatus) ? 'completed' : 'open';
}

/**
 * The legality matrix (Part C/E). Returns true iff `strategy` may be applied
 * to a conflict of `conflictType` whose local entity is in `lifecycle`.
 *
 * Invariants encoded here:
 *   - `dismiss`, `accept_local`, `retain_both` are always structurally safe:
 *     they never take a remote financial value over a completed local one.
 *   - `accept_remote` is BANNED for completed lifecycles (financial safety),
 *     and BANNED outright for payment_conflict/completion_conflict (those are
 *     intrinsically financial — a blind overwrite is never legal).
 *   - `compensate` is offered for the financial/lifecycle conflict types; it
 *     records a reconciliation decision, it does not overwrite history.
 *   - `parent_missing` is normally resolved by automatic recovery, not by a
 *     strategy; only `dismiss` (operator gives up on a permanently-invalid
 *     relationship) is offered manually.
 */
export function isLegalStrategy(conflictType: ConflictType, strategy: ResolutionStrategy, lifecycle: LifecycleState): boolean {
  // Universal financial-safety guard: never blind-overwrite a completed local record.
  if (strategy === 'accept_remote' && lifecycle === 'completed') return false;

  switch (conflictType) {
    case 'completion_conflict':
      // The remote edit targets a locally completed sale. Overwriting is never legal.
      return strategy === 'accept_local' || strategy === 'retain_both' || strategy === 'compensate' || strategy === 'dismiss';
    case 'payment_conflict':
      // Intrinsically financial — no blind accept of either side.
      return strategy === 'retain_both' || strategy === 'compensate' || strategy === 'dismiss';
    case 'concurrent_update':
    case 'stale_snapshot':
    case 'lifecycle_conflict':
      // Overwrite the still-open local record with the remote value only when
      // the local record is not completed (guard above already blocks completed).
      return strategy === 'accept_local' || strategy === 'accept_remote'
        || strategy === 'retain_both' || strategy === 'compensate' || strategy === 'dismiss';
    case 'parent_missing':
      return strategy === 'dismiss';
    default:
      return false;
  }
}

/** The list of strategies legal for a conflict — what the API surfaces to an operator. */
export function legalStrategies(conflictType: ConflictType, lifecycle: LifecycleState): ResolutionStrategy[] {
  return RESOLUTION_STRATEGIES.filter((s) => isLegalStrategy(conflictType, s, lifecycle));
}

/** The resulting-state label recorded on a resolved conflict, for the durable history. */
export function resultingState(strategy: ResolutionStrategy): string {
  switch (strategy) {
    case 'accept_local': return 'local_authoritative_retained';
    case 'accept_remote': return 'remote_value_accepted';
    case 'retain_both': return 'both_preserved_for_review';
    case 'compensate': return 'compensation_recorded';
    case 'dismiss': return 'dismissed_no_action';
  }
}
