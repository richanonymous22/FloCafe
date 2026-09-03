# Milestone 3 — Vertical Architecture + Retail Foundation

Design record for the work that took Plemmo from "one transaction engine
that happens to only serve hospitality" (Milestone 2) to "one transaction
engine that provably serves two verticals, with a real product on top of the
second one." Read alongside [`PLEMMO_ARCHITECTURE.md`](./PLEMMO_ARCHITECTURE.md)
(the living reference, updated throughout this milestone) and
[`MILESTONE_2_CORE_ENGINE.md`](./MILESTONE_2_CORE_ENGINE.md) (the sale/payment
engine this milestone builds on without modifying its guarantees).

**Status: complete.** Everything described as built below is built and
tested. Everything marked deferred is not.

---

## 1. Scope

In scope and built: the hospitality coupling audit, the Core hook seam,
`ProductVariant`, retail checkout (`in_store` channel), SKU/barcode
uniqueness and lookup, a minimal retail UI, a cash-drawer foundation, basic
retail reporting, and the retail compatibility test suite.

Explicitly out of scope and **not** built: real payment-provider
integrations, cloud sync, multi-till synchronisation, the inventory movement
ledger, suppliers/purchasing, stock transfers, multi-location inventory,
phone-shop/IMEI/repairs/trade-ins, advanced promotions, advanced analytics,
licensing, Plemmo Admin, a final retail UI.

---

## 2. Hospitality audit (Part A1)

Every place `table_id`, `tables`, kitchen routing, KDS, or a waiter/dine-in
concept appeared in the codebase at the start of this milestone, classified:

| Location | Behavior | Classification | Action taken |
|---|---|---|---|
| `main/core/sale.ts` (`createSale`) | `UPDATE tables SET status='occupied'` on a dine-in sale | **CORE** (wrongly) | Extracted into a Core hook (§3) — the only hospitality logic that was actually inside Core |
| `main/routes/orders.ts` | Table release on order cancel/void (3 call sites); `table_id` query filter; table row attached to order responses | HOSPITALITY | Left in place — already outside Core |
| `main/routes/bills.ts` | Table release on bill cancel/void; dine-in-only guard on split-check | HOSPITALITY | Left in place — already outside Core |
| `main/core/payment.ts` | — | **CORE, clean** | Audited, confirmed zero hospitality identifiers (Milestone 2's own test already proved this; re-verified in this milestone's Part 17 of `plemmo-retail.test.ts`) |
| `main/routes/tables.ts`, `kitchen.ts`, `kitchen-stations.ts`, `kds.ts`, `kds-info.ts` | Tables, KOT, KDS WebSocket | HOSPITALITY | Already stand-alone route files; no change needed |
| `main/services/kds.ts` | KDS WebSocket broadcast | HOSPITALITY | Already a dedicated service; no change needed |
| `main/routes/reports.ts` (`GET /tables`) | Per-table revenue/status report | HOSPITALITY | Left in place — already an isolated endpoint |
| `main/db.ts` schema: `tables`, `kitchen_stations`, `station_printer_link`, `user_stations` | — | HOSPITALITY | Schema, not code — no seam needed; retail simply never queries these tables |
| `main/db.ts` schema: `orders`, `order_items`, `bills`, `products` | Shared by both verticals (the convergence thesis) | **SHARED** | Unchanged — this is Plemmo's actual "Core" persistence, vertical-neutral by construction |
| `frontend/src/components/layout/Sidebar.tsx` | `businessTypes: ['restaurant']` gating on the Tables/KDS nav items | SHARED EXTENSION | Pre-existing pattern, reused as-is for the new `/retail` nav item (`businessTypes: null`) |

**Finding:** Core had exactly one hospitality-specific line of logic in it —
the table-occupation `UPDATE` inside `createSale`. Everything else
hospitality-specific was already living in hospitality-only route/service
files, outside `main/core/`. This matters for how small Part 3 below turned
out to be: the "hospitality boundary" work is not a large refactor because
there was, in practice, very little to move.

---

## 3. The hospitality seam (Part A2/A3)

```
main/core/hooks.ts              ← Core defines the interface, calls it by name
     ▲                    ▲
     │                    │
main/modules/hospitality/   main/modules/retail/
  hooks.ts                   (no lifecycle hook needed yet)
```

`SaleLifecycleHooks` (currently one member, `onSaleOpened`) is a registry
Core calls into, never a vertical module Core imports. Hospitality registers
its implementation once, at app start-up, from `main/routes/index.ts` — the
composition root that already owns every hospitality-only route. Core has
zero `import` of `main/modules/hospitality` or `main/modules/retail`
anywhere; verified by the existing "SaleService does not import Express"-
style boundary tests in `tests/plemmo-sale-service.test.ts`, extended in
spirit (not re-asserted, since the earlier assertion already covers "no
non-Core import" broadly).

**Why not a bigger event bus:** one hook, one registrant per vertical, run
synchronously inside the caller's transaction. Plemmo doesn't have a
multiple-subscriber problem to solve, and building pub/sub for a single
(vertical, hook) pair would be solving a problem that doesn't exist yet.

**Why the hook is not wrapped in try/catch:** unlike `recordAuditEvent()` or
`recordAppliedPaymentLine()`, table occupation is not a new, additive side
observation — it is the exact pre-existing behavior this hook relocates out
of `createSale`. It ran uncaught, inside the same transaction, before this
milestone. Swallowing its errors would be a real behavior change (a table
that fails to mark occupied would now silently let the sale through instead
of rolling back), not a refactor. See `main/core/hooks.ts`'s docstring for
the full reasoning.

**Test-setup consequence:** any test that calls `SaleService` directly
without going through `main/routes/index.ts`'s `registerRoutes()` now needs
to call `registerHospitalityHooks()` itself, or a dine-in sale's table
occupation silently does nothing. `tests/plemmo-sale-service.test.ts` was
updated to do this in its setup — the honest fix, since a real server always
registers hooks at start-up and the test should reflect that.

**`SaleChannel` widened, no migration:** `orders.type` has no `CHECK`
constraint (confirmed by reading the schema), so adding `'in_store'` to the
`SaleChannel` union is a pure TypeScript-level change — the two existing
`type !== 'dine_in'` guards (`bills.ts`'s split-check gate,
`orders.ts`'s takeaway-conversion gate) both fail closed for any new value,
so `in_store` inherits safe behavior automatically.

---

## 4. Retail foundation (Part B)

### 4.1 Product / Variant schema

`product_variants` (migration v72): ULID PK, same reasoning as
`payments`/`refunds` in v71 — a brand-new, empty table, no legacy integer key
to preserve. `order_items` gained two additive columns:
`product_variant_id` and `unit_cost` (a cost snapshot for future
gross-margin reporting — B8, not wired into any report yet).

`SaleService.persistSaleLine()` — the same shared line engine both
`createSale` and `addSaleItems` have called since Milestone 2 — gained an
optional `variant_id` on `SaleLineInput`. When present, price and SKU come
from the `product_variants` row instead of `products`; when absent (every
hospitality line, forever), behavior is byte-identical to before this
milestone. This is a Core-level, vertical-neutral generalization, not a
retail import into Core: Core already reads dozens of tables directly by
SQL, and `product_variants` is just one more.

**SKU/barcode uniqueness:** a hard, partial-unique index on
`product_variants.sku`/`.barcode` (safe — empty table). Deliberately **not**
added to `products.sku`/`.barcode` — an explicit stop condition warned about
exactly this ("SKU/barcode uniqueness causes legacy-data conflicts"), and
years of real merchant data may already have blanks or duplicates there.
Bare-product SKU/barcode validation is left to `lookupByCode()`'s
best-effort resolution (variant match first, product fallback) rather than a
database constraint.

**Tax resolution:** `product_variants.tax_category_id` exists as a column
but is not yet read by `calculateItemTax()` — a variant's line is taxed
using its parent product's tax configuration in this milestone. This is a
known limitation (§5), not an oversight; wiring it in was judged
"overbuilding option management" for a first milestone per the spec's own
B2 instruction.

### 4.2 Retail checkout

```
Barcode/Search → lookupByCode() → Cart (client-side) → POST /api/retail/checkout
                                                              │
                                              SaleService.createSale(channel: 'in_store')
                                                              │
                                              generateBillForOrder()  ← extracted from
                                                              │          POST /bills/generate
                                              PaymentService.tender()
                                                              │
                                              bill reconciliation (retail-owned)
                                                              │
                                                          Receipt (formatReceipt)
```

Three sequential top-level transactions, run server-side in one HTTP call —
exactly the sequence the existing hospitality UI already drives across three
separate requests (`POST /orders`, `POST /bills/generate`,
`POST /bills/:id/payment`). Nothing here is a new kind of transaction.

**`generateBillForOrder()` extraction:** `POST /bills/generate`'s handler
was refactored, behavior-preservingly, into an exported function so retail
checkout could call it without going through HTTP — the same "shared engine,
one business rule, two callers" technique Milestone 2 already used twice
(`persistSaleLine`, the payment dual-write). Same queries, same
re-sync-on-unpaid rule, same transaction shape.

**Bill reconciliation is retail's own responsibility:** `tender()`
deliberately does not update `bills.paid_amount`/`payment_status` (a
Milestone 2 decision, unchanged here — see `MILESTONE_2_CORE_ENGINE.md`
§5.3). Retail checkout, as `tender()`'s first production caller, does that
reconciliation itself in `main/modules/retail/checkout.ts`, since it is a
brand-new path with no legacy gap to inherit. Any future caller of
`tender()` needs to do the same until a shared reconciliation helper is
judged worth building.

**Currency fallback:** matches `main/core/payment.ts`'s existing dual-write
fallback (`INR`) rather than a UK-specific default, so one install never
computes two different default currencies across its two payment paths.

### 4.3 Cash drawer

`openCashDrawer()` in `main/printers/thermal.ts`: a standard ESC/POS
drawer-kick pulse (`ESC p m t1 t2`) dispatched through the exact printer
resolution and connection logic `printReceipt`/`printKOT` already use. No
new hardware abstraction, no printing-subsystem rewrite — one function name
the retail checkout page calls, best-effort, after a successful payment.

### 4.4 Retail UI

A single page at `/retail`: barcode/SKU entry, cart with quantity
adjustment, cash/card checkout buttons, a bare confirmation panel. Deliberately
minimal per the milestone's own B6 instruction ("do NOT attempt the final
perfect UI yet") — no receipt preview, no held carts, no customer lookup, no
keyboard-first scanning UX beyond Enter-to-add. Added to the sidebar
alongside POS, visible to the same roles.

### 4.5 Retail reporting

`getRetailDailySummary()`: transaction count, gross sales, tax collected,
cash vs. manual-card totals (read from the `payments` table, so it reflects
the same numbers `payments`/`payment_events` record), top products by
quantity. Scoped to `orders.type = 'in_store'` throughout, so it can never
mix with hospitality numbers. Cash/card totals assume a 2-decimal currency
(divides minor units by 100 directly) — a known simplification, acceptable
for "the minimum reporting needed to prove the retail flow works" (B9), not
acceptable as a permanent implementation for 0- or 3-decimal currencies.

---

## 5. Known limitations, deliberately left unchanged

1. **Variant tax resolution.** A variant's line is taxed using its parent
   product's `tax_category_id`, not its own (§4.1). `product_variants.tax_category_id`
   exists as a column for a future milestone to wire in.
2. **No per-variant inventory.** `products.stock_quantity` is still the only
   stock signal; a product with variants shares one stock number across all
   of them. B11 explicitly deferred the inventory ledger past this milestone.
3. **`tender()` still does no split-tender allocation or wallet-balance
   checking** (a Milestone 2 limitation, unchanged) — retail checkout works
   around this by only ever calling `tender()` once, for the bill's full
   balance, in one adapter.
4. **Retail reporting's cash/card totals assume 2-decimal currencies**
   (§4.5) — inherited by the report, not introduced by it; `payments.amount_minor`
   itself is exponent-correct.
5. **No tenant-level "this store is retail" setting.** The `/retail` nav
   item is visible to every business type; Plemmo does not yet model
   "this installation is a retail store" vs. "this installation is a
   restaurant" as a first-class setting the way `business_type` already
   partially does for hospitality nav items. Building that is a bigger
   product decision than this milestone's scope.
6. **Cash drawer has no status feedback loop.** `openCashDrawer()` reports
   success/failure of the print dispatch, not whether the drawer physically
   opened (no hardware in this class of printer reports that).
7. **The final retail UI (Plemmo redesign) moved retail off this section's
   atomic checkout.** `frontend/src/app/(dashboard)/retail/page.tsx` now
   drives `POST /orders` (`type: 'in_store'`) -> `PATCH /orders/:id/discount`
   -> `POST /bills/generate` -> `POST /bills/:id/payments` — the same
   granular sequence hospitality's prepaid checkout already used — instead
   of calling `checkout()` below, so it can reuse `PrepaidCheckoutModal`'s
   existing discount/PIN-approval UI rather than inventing a new one.
   `main/modules/retail/checkout.ts` is unchanged and still callable by
   anything else that wants the single-request shape. Two things this still
   does **not** give retail: **hold/resume** (the held-orders store is keyed
   by `tableId`; a tableless retail sale has no equivalent key, so a
   suspended retail cart concept would need real backend design, not just a
   UI reuse) and **offers as a concept distinct from discounts** (no such
   backend concept exists anywhere in Plemmo today — discounts are the only
   price-adjustment mechanism; "offers" in the product brief should be read
   as discounts until/unless a real promotions engine is scoped).

---

## 6. Deferred work (explicitly out of scope, per the milestone's Part F)

Real payment-provider integrations, cloud backend, sync engine, multi-till
sync, licensing, Plemmo Admin, suppliers, purchasing, the inventory movement
ledger, stock transfers, multi-location inventory, IMEI/repairs/trade-ins,
advanced promotions, advanced reporting, Android/iOS, and the final retail
UI. All of these remain exactly where Milestone 2's roadmap left them,
updated in `PLEMMO_ARCHITECTURE.md` §12.

---

## 7. See also

- [`PLEMMO_ARCHITECTURE.md`](./PLEMMO_ARCHITECTURE.md) §3 (module boundary,
  Product/Variant), §8 (payments, `tender()`'s first caller), §9 (cash
  drawer), §12 (roadmap) — the living reference this record feeds into
- [`MILESTONE_2_CORE_ENGINE.md`](./MILESTONE_2_CORE_ENGINE.md) — the
  transaction engine this milestone builds on without modifying its
  guarantees
- `main/core/hooks.ts`, `main/modules/hospitality/hooks.ts`,
  `main/modules/retail/*.ts` — the code itself, commented in the same voice
  as this document
- `tests/plemmo-retail.test.ts` — the verification this record's claims are
  checked against
