/**
 * PLEMMO CORE — vertical hook registry.
 *
 * Core (main/core/*) must stay usable by both verticals without importing
 * either one. Hospitality-specific behavior that Core needs to trigger at a
 * specific point in a sale's lifecycle (occupying a table, releasing one)
 * is expressed here as a named hook Core calls, not as a direct
 * `import ... from '../modules/hospitality'`.
 *
 * The hospitality module registers its own implementation of these hooks at
 * app start-up (see main/routes/index.ts, the composition root that already
 * wires up every hospitality-only route). Retail registers nothing here in
 * this milestone — it has no lifecycle side effect that needs one yet.
 *
 * This is deliberately not an event bus: hooks are synchronous, run inside
 * the caller's transaction where documented, and a caller expects at most
 * one registration per (vertical, hook) pair. A broader pub/sub mechanism
 * would be solving a problem Plemmo doesn't have.
 *
 * See docs/MILESTONE_3_VERTICALS_AND_RETAIL.md § Hospitality boundary.
 */

import Database from 'better-sqlite3';

export interface SaleOpenedContext {
  db: Database.Database;
  orderId: number | bigint;
  tableId: string | null;
  channel: string;
  now: string;
}

export interface SaleLifecycleHooks {
  /** Called once, inside createSale's transaction, right after the order row exists. */
  onSaleOpened?(ctx: SaleOpenedContext): void;
}

const registry = new Map<string, SaleLifecycleHooks>();

/**
 * Registers a vertical's hook implementations. Safe to call more than once
 * for the same vertical (last registration wins) — useful for tests that
 * re-initialize the app in one process.
 */
export function registerVerticalHooks(vertical: 'hospitality' | 'retail', hooks: SaleLifecycleHooks): void {
  registry.set(vertical, hooks);
}

/** Test-only: clears all registrations so a test file starts from a clean slate. */
export function __resetVerticalHooksForTests(): void {
  registry.clear();
}

/**
 * Runs `onSaleOpened` for every vertical that registered one.
 *
 * Deliberately NOT wrapped in try/catch, unlike `recordAuditEvent` or
 * `recordAppliedPaymentLine`. Those guard genuinely new, additive side
 * observations that must never be able to block a sale. Table occupation is
 * neither new nor additive — it is the exact pre-existing behavior this hook
 * relocates out of `createSale`'s body, and it ran uncaught, inside the same
 * transaction, before this milestone. Swallowing its errors here would be a
 * real behavior change (a table that fails to mark occupied would now
 * silently let the sale through instead of rolling back), not a refactor.
 */
export function runOnSaleOpened(ctx: SaleOpenedContext): void {
  for (const hooks of registry.values()) {
    hooks.onSaleOpened?.(ctx);
  }
}
