# Milestone 4 — Inventory Engine + Retail Stock Management

Design record for turning Milestone 3's retail checkout into a real retail
inventory system: an auditable movement ledger behind every stock change,
variant-level balances, and refund/adjustment integration. Read alongside
[`PLEMMO_ARCHITECTURE.md`](./PLEMMO_ARCHITECTURE.md) (the living reference)
and [`MILESTONE_3_VERTICALS_AND_RETAIL.md`](./MILESTONE_3_VERTICALS_AND_RETAIL.md)
(the retail checkout this milestone integrates with).

**Status: complete.** Everything described as built below is built and
tested. Everything marked deferred is not.

---

## 1. Part A — audit of current stock behavior (before this milestone)

Every place that read or wrote `products.stock_quantity`/`track_inventory`:

| Location | Behavior |
|---|---|
| `main/core/sale.ts` (`persistSaleLine`) | Guard: `track_inventory && stock_quantity < quantity` throws `SaleError('Insufficient stock for ...')` (no `statusCode` — inherited 500 mapping). Decrement: unconditional `UPDATE products SET stock_quantity = stock_quantity - ?` when `track_inventory`. Both fired on the **parent product's** scalar even for a Milestone-3 variant line — the exact gap this milestone closes. |
| `main/routes/index.ts` (item-level cancel, "all items cancelled" path) | Restores stock for **every** item on the order (not just the one just cancelled) once the last active item is cancelled — because a plain single-item cancel does *not* restore stock on its own. Coherent by design: stock is only ever restored once, when the whole order becomes cancelled. |
| `main/routes/orders.ts` (`PATCH /:id` → `status: 'cancelled'`) | Same restore-on-whole-order-cancel behavior, for the explicit order-level cancel endpoint. |
| `main/routes/index.ts` (in-progress void, `status: 'voided'`) | Deliberately does **not** restore stock — an already-prepared item was already consumed. |
| `main/routes/products.ts` (`POST /:id/stock`) | Manual `set`/`increase`/`decrease` actions, decrease guarded by `stock_quantity >= quantity` (no negative stock). No history kept — a `set` silently discards the prior number. |
| `main/routes/products.ts` (`GET /`, `?low_stock=true`) | Reads `stock_quantity`/`low_stock_threshold` directly for the product list and low-stock filter. |
| `main/core/payment.ts` (`refundPayment`, pre-Milestone-4) | Explicitly documented as **not** touching inventory — "a refund here is purely a financial record." |

**Policy already in force, preserved by this milestone:** insufficient
*tracked* stock prevents a sale; untracked products (`track_inventory = 0`)
are never checked or decremented at all. No merchant-configurable override
existed. See §7 for what a future configurable version needs.

---

## 2. Target architecture

```
Product
   ↓
ProductVariant (optional — a hospitality product never has one)
   ↓
InventoryBalance   ← maintained, O(1) read
   ↓
InventoryMovement[] ← immutable, append-only ledger
```

```
main/core/inventory.ts (InventoryService)
   recordSale()    ← called from SaleService.persistSaleLine()
   recordReturn()  ← called from PaymentService.refundPayment() (opt-in per call)
   adjustStock()   ← standalone, called from routes/inventory.ts and the UI
   getBalance() / getMovementHistory() / listLowStock()
```

## 3. Tables (migration v73, `plemmo_inventory_ledger`)

Two brand-new tables — additive, `products.stock_quantity` untouched:

- **`inventory_movements`** — immutable. `id` (ULID PK), `product_id`,
  `product_variant_id` (nullable), `location_id` (nullable, unused this
  milestone), `quantity_delta`, `movement_type`
  (`sale | return | adjustment | receipt | opening` — a CHECK constraint,
  deliberately not including `transfer_in`/`transfer_out`/`count` yet, per
  "do not add movement types we don't need"), `reason`, `reference_type`/
  `reference_id` (what caused it), `unit_cost`, `actor_user_id`,
  `balance_after` (a denormalized snapshot so history doesn't need to
  recompute), `metadata` (JSON — used by returns, §5), `created_at`.
- **`inventory_balances`** — maintained. One row per
  `(product_id, product_variant_id, location_id)` (a `COALESCE`-based unique
  index, since SQLite treats `NULL`s as distinct in a plain `UNIQUE`),
  upserted inside the same transaction as every movement insert.

`product_variants` also gained a nullable `low_stock_threshold` column
(falls back to the parent product's when unset).

## 4. Balance strategy (Part D)

Maintained balance + immutable ledger, chosen explicitly over "derive from
movements every read": a till asking "how many are left" is a hot path and
must not recompute a SUM over potentially years of history. Every write goes
through one function (`recordMovement`), which inserts the movement and
upserts the balance in the same call — they can never drift apart because
nothing else is allowed to write either table.

**The lazy-seed fallback.** A variant-less product created *after* this
migration ran (or whose `track_inventory` was switched on afterward) has no
`inventory_balances` row yet. `getBalance()` and `listLowStock()` both fall
back to `products.stock_quantity` in that case, rather than reporting 0 —
otherwise a legitimate sale against real, pre-existing stock would be
wrongly rejected as "insufficient" purely because the ledger hadn't
recorded a movement for that product yet. The first real movement against
such a product seeds its balance row from that same fallback value before
applying the delta, so the ledger and the legacy scalar never disagree. A
variant has no such fallback — there is no legacy per-variant number to
inherit from, so a fresh variant genuinely starts at 0 and needs an explicit
`adjustStock()` to receive opening stock (see the retail compatibility
test's "Seed initial variant stock" step).

## 5. Migration strategy (Part E) and dual-write (Part F)

One migration, v73, purely additive. For every product with
`track_inventory = 1`, it inserts one `'opening'` movement carrying the
product's existing `stock_quantity`, plus a matching `inventory_balances`
row — deterministic and idempotent (guarded by
`reference_type = 'opening_stock_migration'` + `reference_id = product.id`,
so re-running the migration logic, which the normal pipeline never does but
the ideal-schema-rebuild path used by tests effectively re-derives, cannot
double-insert). Verified against a real legacy fixture with an injected
tracked-stock product (`tests/upgrade-path.test.ts`) — this is also where a
real bug was caught and fixed: the original `insertMovement.run(...)` call
had its parameters in the wrong order, silently swapping `reference_id` and
`balance_after`. **`products.stock_quantity` is not removed and is not
stopped being written** — see §9 for exactly when it safely can be.

**Dual-write direction, same shape as Milestone 2's payment dual-write but
inverted:** where the payment ledger dual-writes *from* the legacy path
*into* the new tables (legacy stays authoritative), the inventory ledger is
the *primary* write for every new sale/return/adjustment, and the legacy
`products.stock_quantity` column is kept in sync as a **compatibility
write** — but only for variant-less products (§6). This is deliberate: the
new ledger is the actual architectural target from day one for inventory,
unlike payments where `applyPaymentBatch` was judged too load-bearing to
route through immediately.

## 6. Sale integration (Part G)

`persistSaleLine()`'s direct `UPDATE products SET stock_quantity = ...` is
replaced by a call to `InventoryService.recordSale()`, now variant-aware. A
sale of Variant A can no longer be confused with Variant B's stock, which
`products.stock_quantity` alone had no way to express.

**Exact-behavior preservation for the bare-product case:** the
insufficient-stock check is kept as an explicit pre-check inside
`persistSaleLine()` itself (not delegated to `recordSale()`'s own guard),
so a variant-less line still throws byte-for-byte the same `SaleError`
(message using the product's *name*, no `statusCode`) it always has.
`recordSale()`'s own guard is a defensive backstop that cannot realistically
fire behind it — single-threaded, same transaction, nothing changes between
the two checks. The *variant* case is new behavior with no legacy contract
to match, so it throws its own `SaleError` with a clear message.

**Only variant-less products get the legacy compatibility write.** A
product with three variants has no single correct number for
`products.stock_quantity` — three independent balances can't collapse into
one column. `stock_quantity` is simply left alone for such products; the
ledger becomes their only source of truth. A hospitality product (never
varianted) keeps reading `products.stock_quantity` everywhere it always
did (the product list, the low-stock filter) with zero visible change.

**Atomicity (Part Q):** `InventoryService`'s public functions self-transact
via `withTxn()`. Called from inside `SaleService.createSale`'s
already-open transaction, better-sqlite3 nests it as a `SAVEPOINT`
automatically — no second transaction mechanism, and a failure anywhere
(including a later line in a multi-line sale) rolls back the whole sale,
proven by a dedicated rollback test (`tests/plemmo-inventory.test.ts` §14:
a two-line sale where the second line oversells leaves *zero* order_items
and *zero* inventory_movements, not just the failing line's effects).

## 7. Refund integration (Part H)

`refundPayment()` gained an optional `items?: { orderItemId, quantity }[]`.
Omitted, behavior is unchanged from Milestone 2/3 — a pure financial record,
no stock effect. Provided, each line's quantity is credited back via
`recordReturn()`, atomic with the financial refund in the same transaction.

**The over-refund cap is computed, not trusted.** `recordReturn()` sums
`sale` movements against the order_item (how much it actually sold) minus
prior `return` movements against the same sold line (tracked via
`metadata.soldOrderItemId`, independent of the movement's own
`reference_type`/`reference_id`, which instead points at what *caused* the
return — the refund itself, so a merchant's history view reads "RETURN +3
Refund #..." the way Part J's own example shows). A caller cannot return
more than that computed remainder; the function throws rather than
clamping, on the theory that a real correction beyond what was actually
sold is `adjustStock()`'s job — an explicit manual override, not something
a refund flow should paper over silently.

## 8. Variant stock (Part C/N)

Proven directly: selling Variant A does not touch Variant B's balance, does
not touch the bare product's balance, and a fresh variant starts genuinely
at 0 (no inherited number) and must be given opening stock via
`adjustStock()` before it can be sold — see
`tests/plemmo-inventory.test.ts` §5 and the "Seed initial variant stock"
step `tests/plemmo-retail.test.ts` needed to add for its checkout flow to
succeed under the new, correct per-variant accounting.

## 9. Stock adjustment (Part I)

`adjustStock()` is the one generic manual-correction entry point — found
stock, damage, a count correction, or a goods receipt (`movementType:
'receipt'`, reusing this same function rather than a dedicated receiving
workflow, out of scope per Part V). `reason` is required and non-empty:
`"stock = 27"` never happens without an explanation attached. Rejects a
delta that would take stock negative, same policy as a sale.

## 10. Movement history and low stock (Part J/K)

`getMovementHistory()` returns movements newest-first, each carrying its
own `balance_after` (no client-side recomputation needed to render a running
balance column). `listLowStock()` joins products/variants/balances and
filters to `quantity <= threshold`, using the same legacy-fallback rule as
`getBalance()` for a variant-less product with no balance row yet.

## 11. Unit cost / margin foundation (Part L)

`order_items.unit_cost` (added in Milestone 3) is unchanged; `inventory_movements.unit_cost`
now carries the same snapshot for `sale` movements, so a future
gross-margin report can join either table and get the same number. No
report reads it yet.

## 12. Negative stock policy (Part T)

**Preserved exactly, not redesigned:** a sale that would take *tracked*
stock negative is prevented (`InventoryError`/`SaleError`, matching prior
behavior); untracked products are never checked. `adjustStock()` applies
the same rule. No merchant-configurable override exists yet. A future
configurable policy (allow negative with a permission, or per-merchant
setting) would live as an additional check inside `recordSale()`/
`adjustStock()`, gated by a new setting this milestone deliberately does not
invent — there is no evidence yet from real usage about what the right
default or granularity should be.

## 13. Concurrency (Part R)

better-sqlite3 is synchronous — every write from this Node process executes
to completion before the next one starts, so `applyBalanceDelta()`'s
read-modify-write has no interleaving race *within one process*, today.
This is not a claim about multiple tills: a future milestone that lets two
physical devices write to the same database (or two independent local
databases that sync) needs real conflict resolution for a balance that both
devices decremented concurrently — CRDT-style merge, a version/lock column,
or a server-arbitrated queue are the standard options. This milestone
explicitly does not attempt that (Part R's own instruction); it's recorded
here as exactly what a future sync milestone needs to solve, not guessed at.

## 14. Multi-location preparation (Part O)

`location_id` exists on both new tables and is always `NULL` today. The
balance table's uniqueness already includes it via `COALESCE`, so scoping
inventory to `organizations → locations` later is additive — no migration
needed to *add* the column, only to start populating and querying by it.

## 15. Known limitations

1. `product_variants.tax_category_id` still isn't read by tax calculation —
   inherited from Milestone 3, unrelated to this milestone's scope.
2. No merchant-configurable negative-stock policy (§12).
3. No purchasing/goods-receiving workflow — `'receipt'` exists as a
   movement type but has no dedicated UI or supplier concept behind it.
4. Refund/inventory integration is opt-in per call (`items` on
   `refundPayment`) — no live route calls it with items yet, matching how
   `tender()`/`refundPayment()` themselves aren't wired into any hospitality
   route (Milestone 2/3's own deferral, unchanged here).
5. `inventory_movements.movement_type` is a CHECK constraint covering only
   what this milestone needs; adding `transfer_in`/`transfer_out`/`count`
   later requires a migration that rebuilds the table (SQLite cannot alter a
   CHECK constraint in place) — a known, accepted cost, consistent with how
   `payments.state`'s CHECK already works in this codebase.

## 16. Deferred work (Part V, unchanged)

Suppliers, purchase orders, a full goods-receiving workflow, stock
transfers, multi-location synchronization, cloud sync, offline conflict
resolution, Plemmo Admin, licensing, real payment providers, IMEI, repairs,
trade-ins, advanced promotions, advanced inventory forecasting.

## 17. See also

- [`PLEMMO_ARCHITECTURE.md`](./PLEMMO_ARCHITECTURE.md) §3 (Core module
  table, entity status), §9 (hardware) — the living reference this record
  feeds into
- [`MILESTONE_3_VERTICALS_AND_RETAIL.md`](./MILESTONE_3_VERTICALS_AND_RETAIL.md) —
  the retail checkout and Product/Variant foundation this milestone builds on
- `main/core/inventory.ts` — the code itself, commented in the same voice as
  this document
- `tests/plemmo-inventory.test.ts`, `tests/upgrade-path.test.ts` — the
  verification this record's claims are checked against
