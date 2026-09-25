/**
 * Hospitality's implementation of the Core sale-lifecycle hooks
 * (main/core/hooks.ts). This is the only file in the codebase where
 * "a sale occupies a table" is decided — Core no longer knows this rule at
 * all, it only knows that *something* may want to react to a sale opening.
 *
 * `registerHospitalityHooks()` must be called once at app start-up, before
 * any sale is created. See main/routes/index.ts, which already owns every
 * hospitality-only route (tables, kitchen, KDS) and is the natural place to
 * register this alongside them.
 */

import { registerVerticalHooks, SaleOpenedContext } from '../../core/hooks';

function onSaleOpened(ctx: SaleOpenedContext): void {
  // The exact rule `createSale` ran inline before this milestone: a
  // dine-in sale with a table occupies that table. Every other channel —
  // takeaway, delivery, online, and retail's new `in_store` — leaves
  // tables untouched, which is how a retail counter sale stays entirely
  // free of hospitality concepts without needing its own conditional here.
  if (ctx.tableId && ctx.channel === 'dine_in') {
    ctx.db.prepare("UPDATE tables SET status = 'occupied', updated_at = ? WHERE id = ?").run(ctx.now, ctx.tableId);
  }
}

export function registerHospitalityHooks(): void {
  registerVerticalHooks('hospitality', { onSaleOpened });
}
