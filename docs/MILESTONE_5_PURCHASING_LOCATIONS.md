# Milestone 5 — Purchasing + Suppliers + Location-Aware Inventory

Design record for extending the retail side from
`Product → Variant → Inventory → Sale → Return` into
`Supplier → Purchase Order → Goods Receiving → Inventory`, and for making
inventory genuinely location-aware ahead of any future multi-store
operation. Read alongside [`PLEMMO_ARCHITECTURE.md`](./PLEMMO_ARCHITECTURE.md)
(the living reference) and
[`MILESTONE_4_INVENTORY.md`](./MILESTONE_4_INVENTORY.md) (the inventory
ledger this milestone builds on without modifying its guarantees).

**Status: complete.** Everything described as built below is built and
tested. Everything marked deferred is not.

---

## 1. Part A — audit of the current location/inventory model

| Table | Has `location_id`? | Notes |
|---|---|---|
| `organizations` | — (is the org) | One row per install, seeded by migration v68 |
| `locations` | — (is the location) | One row per install, seeded by v68, pointed to by the `plemmo_location_id` setting |
| `registers` | `location_id` (required) | One row per install, seeded by v68 |
| `devices` | `register_id` (required) | One row per install — this installation's own identity |
| `products` | ❌ | Vertical/location-neutral catalogue data |
| `product_variants` | ❌ | Same |
| `inventory_balances` | ✅ (v73) | Existed but was always `NULL` before this milestone |
| `inventory_movements` | ✅ (v73) | Same |
| `orders` / `bills` | ❌ | No location concept at all — a sale implicitly happens "here", the one location this install represents |
| Frontend | No location switcher anywhere | Confirms a single local SQLite install represents exactly one physical location today, matching the schema |

**Finding:** the organization hierarchy (`organizations → locations → registers → devices`)
was already fully built in Phase 1 (Milestone 1) and seeded automatically on
every install — this milestone did not need to invent it, only to *use* it.
`inventory_balances`/`inventory_movements` already had a `location_id`
column, deliberately added in Milestone 4 "designed for, not built" (Part O
of that milestone). This milestone is what populates it.

**Target**, unchanged from the brief:

```
Organization
    ↓
Location
    ↓
Inventory
```

---

## 2. Location model (Part B)

`main/core/location.ts`: `getCurrentLocationId()`/`getCurrentOrganizationId()`,
the one place that reads the `plemmo_location_id`/`plemmo_organization_id`
settings pointers v68 already seeds. `InventoryService`'s
`recordSale`/`recordReturn`/`adjustStock`/`recordReceipt`/`getBalance` all
resolve an unspecified `locationId` to this value via a shared
`resolveLocationId()` helper, rather than leaving it `null`.

**Migration v74 (`plemmo_location_aware_inventory`)** backfills every
existing `NULL`-location row in `inventory_balances`/`inventory_movements`
to this same real location id. This is not cosmetic: once
`InventoryService` starts resolving unspecified locations to a real id, the
*next* write against an already-tracked product would otherwise create a
*second*, disjoint balance row (real `location_id`) instead of updating the
existing one (`NULL` `location_id`) — silently duplicating stock.
Backfilling the existing rows first is what keeps them the same row.
Verified against the real v1.5.0-era upgrade fixture, with an injected
tracked-stock product carried over from Milestone 4's own fixture addition.

`purchase_orders` also carries `location_id`, resolved the same way at
creation time.

**B1 — location stamps.** Applied to `inventory_movements`, `inventory_balances`,
and `purchase_orders` — the three places genuinely transactional about "this
stock/order belongs somewhere." Not added to `products`/`product_variants`
(catalogue, not stock) or to `orders`/`bills` (out of scope — those tables
have never had a location concept and adding one is a larger, unrelated
change this milestone does not need to make).

**B3 — legacy compatibility.** `products.stock_quantity` is untouched, still
written by `InventoryService` for variant-less products exactly as
Milestone 4 left it. Nothing about this milestone changes when it can be
removed — see `MILESTONE_4_INVENTORY.md` §15.

---

## 3. Supplier model (Part C)

`suppliers` (migration v75): `id` (ULID PK), `organization_id`, `name`
(required), `business_name`, `contact_person`, `phone`, `email`, `address`,
`notes`, `tax_registration_number`, `is_active`. No accounting fields —
credit terms, payment methods, ledgers are all out of scope; a supplier
here is purely a purchasing relationship. Two suppliers may share a name
(not an identity key) — a real business is free to have two trading
partners with the same name.

`main/modules/purchasing/suppliers.ts` (`SupplierService`): create, update,
get, list (search across name/business_name/contact_person, active-only
filter), deactivate (soft — `is_active = 0`, no delete).

---

## 4. Purchase order model (Part D)

`purchase_orders` + `purchase_order_items` (migration v75), both ULID PK,
brand-new/empty — same reasoning as every Plemmo Core table since v71.

`purchase_orders`: `supplier_id`, `location_id`, `status` (CHECK-constrained
to `draft | ordered | partially_received | received | cancelled` — the five
states the brief actually needs, nothing speculative), `reference_number`,
`order_date`, `expected_date`, `notes`, `subtotal`/`tax`/`total`
(recalculated from items on every change), `created_by`.

`purchase_order_items`: `product_id`, `product_variant_id` (nullable),
`quantity_ordered`, `unit_cost`, `tax`, `line_total`, `quantity_received`
(the running total receiving increments — no separate line-item history
table needed, see §5).

---

## 5. Purchase order workflow (Part E) and receiving model (Part F)

```
Create PO (draft) → addItem/updateItem/removeItem (draft only)
  → markOrdered (requires ≥1 item) → receiveGoods (partial or full,
    repeatable) → status auto-derived from every item's own
    quantity_received vs quantity_ordered
```

Editing items is locked to `draft` — once a PO is `ordered`, its committed
quantities/costs cannot be silently changed underneath a receiving flow
that may already be in progress against them.

**No separate receiving/receipt table.** A receipt is one
`inventory_movements` row (`movement_type = 'receipt'`,
`reference_type = 'purchase_order_item'`, `reference_id` = the item's id)
plus an increment of that item's own `quantity_received` column — the
ledger *is* the receiving history (Part J's "recent goods received" report
queries `inventory_movements` directly). Building a parallel table would
have duplicated data the ledger already records faithfully.

**Status derivation**, computed fresh after every receive rather than
tracked incrementally: every item's `quantity_received >= quantity_ordered`
→ `received`; any item with `quantity_received > 0` → `partially_received`;
otherwise unchanged. Recomputing from the actual item rows (rather than,
say, incrementing a counter) means the status can never drift from what the
items actually say.

**Over-receipt policy (Part F "over-receipt policy"):** rejected, not
clamped or allowed with an override. `ReceivingService.receiveGoods()`
throws if a line's requested quantity exceeds
`quantity_ordered - quantity_received` for that item. This is the
conservative default Part J explicitly asked for ("be conservative...
create sensible validation") where the legacy application had no prior
behavior to preserve (goods receiving did not exist before this milestone).

---

## 6. Inventory integration (Part H)

```
routes/purchase-orders.ts  (thin HTTP layer)
        ↓
ReceivingService.receiveGoods()
        ↓
InventoryService.recordReceipt()   ← new, purpose-built entry point
        ↓
inventory_movements (movement_type='receipt') + inventory_balances
```

Neither `purchase-orders.ts` nor `receiving.ts` ever touches
`inventory_balances` or `products.stock_quantity` directly — verified by
inspection (grep for `inventory_balances`/`stock_quantity` outside
`main/core/inventory.ts` in the purchasing module turns up nothing) and
implicitly by the transactional-rollback test (§8): if receiving wrote
inventory directly instead of exclusively through `InventoryService`, a
mid-receive failure could leave a partial write that
`InventoryService.recordReceipt()`'s own `withTxn()` wrapper wouldn't cover.

`recordReceipt()` is deliberately distinct from `adjustStock()` (Milestone
4): always a positive quantity, always carries a real per-unit cost from
the actual delivery, always tied to a specific `purchase_order_items` row.
`adjustStock()` remains the generic manual-correction path; a goods receipt
is a different, more specific kind of event with its own guarantees.

---

## 7. Migration details (Part R)

Two migrations. v74 (`plemmo_location_aware_inventory`) is a pure backfill
`UPDATE` — no new columns, since `inventory_balances`/`inventory_movements`
already had `location_id` from v73. v75 (`plemmo_purchasing`) is three new,
empty tables. Both additive, both verified fresh and against the real
v1.5.0-era upgrade fixture (`tests/upgrade-path.test.ts`, extended with
assertions that the Milestone-4-era opening movement/balance are correctly
backfilled to the install's real location). `schema-health` reports zero
drift on both paths.

---

## 8. Idempotency (Part P/G)

`ReceivingService.receiveGoods()` accepts an optional
`{ key, requestHash, userId }` and reuses the existing `order_idempotency`
table directly — the same generic "replay a stored response for this
user+key" table `SaleService.createSale()`/`addSaleItems()` already use.
No new idempotency mechanism was invented. Proven by test: the same key
submitted twice returns the identical response and does not create a
second inventory movement or double `quantity_received`.

Transactional atomicity (Part Q) is inherited from `InventoryService`'s own
`withTxn()`-per-call guarantee (Milestone 4): a multi-line receive where a
later line over-receives rolls back the *entire* call, including any
earlier line that would otherwise have succeeded — proven by a dedicated
test with a two-line receive where the second line fails.

---

## 9. Unit cost handling (Part G)

A receipt's `unit_cost` comes from the actual delivery (an optional
per-line override on the receive request), not silently copied from the
PO's expected cost — the two are allowed to differ, and the movement
records what was actually paid. `purchase_order_items.unit_cost` (the PO's
*expected* cost) is left unchanged by receiving; only the resulting
`inventory_movements.unit_cost` row reflects the real figure. No margin
report reads this yet — foundation only, same posture as Milestone 4's
`unit_cost` snapshot on sale movements.

---

## 10. Concurrency

Unchanged from Milestone 4's analysis (`MILESTONE_4_INVENTORY.md` §13):
better-sqlite3 is synchronous, so no interleaving race exists within one
process today. A future multi-till milestone still needs real conflict
resolution for concurrent writes to the same balance or the same PO item's
`quantity_received` — not attempted here, per this milestone's own
instruction not to build offline conflict resolution.

---

## 11. Known limitations

1. No supplier/accounting integration (Xero, QuickBooks) — explicitly out
   of scope.
2. Receiving has no photo/document attachment or invoice-matching workflow
   — "goods receiving beyond the generic movement type/foundation" was
   explicitly deferred by Milestone 4 and remains so here.
3. `purchase_orders.location_id` is always this install's one location —
   choosing a *different* location for a PO (multi-location selection) has
   no UI or enforcement yet; the column exists for a future milestone to
   use.
4. No PO editing after `markOrdered` beyond cancel — a merchant who needs
   to change quantities on an already-ordered PO must cancel and recreate
   it. Judged acceptable for a first purchasing milestone; revisit if real
   usage shows otherwise.
5. Reports (`purchasesBySupplier`, `stockReceivedByDate`) are not
   pagination- or date-range-optimized for very large purchase histories —
   fine at the "basic reporting" scope this milestone targets.

---

## 12. Deferred work (Part S, unchanged)

Supplier APIs, automated supplier ordering, accounting integrations, cloud
sync, offline conflict resolution, multi-location synchronization, Plemmo
Admin, licensing, real payment providers, IMEI, repairs, trade-ins,
advanced promotions, warehouse management, forecasting, complex
accounting.

---

## 13. See also

- [`PLEMMO_ARCHITECTURE.md`](./PLEMMO_ARCHITECTURE.md) §3 (Core module
  table, entity status), §6 (Organization/Location/Register/Device), §12
  (roadmap) — the living reference this record feeds into
- [`MILESTONE_4_INVENTORY.md`](./MILESTONE_4_INVENTORY.md) — the inventory
  ledger this milestone extends without modifying its guarantees
- `main/core/location.ts`, `main/modules/purchasing/*.ts` — the code
  itself, commented in the same voice as this document
- `tests/plemmo-purchasing.test.ts`, `tests/upgrade-path.test.ts` — the
  verification this record's claims are checked against
