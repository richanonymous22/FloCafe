# Milestone 6 — Multi-Location + Device Context + Stock Transfers

Design record for turning the existing location model into a real
operational model for multi-store merchants: a typed device/location
context, location-aware sales and payments, hardened location isolation for
inventory and purchasing, stock transfers between locations, and the
structural foundation for employee location scoping. Read alongside
[`PLEMMO_ARCHITECTURE.md`](./PLEMMO_ARCHITECTURE.md) (the living reference)
and [`MILESTONE_5_PURCHASING_LOCATIONS.md`](./MILESTONE_5_PURCHASING_LOCATIONS.md)
(the location-aware inventory foundation this milestone builds on).

**Status: complete.** Everything described as built below is built and
tested. Everything marked deferred is not.

---

## 1. Part A — audit of the current context model

| Piece | Status before this milestone |
|---|---|
| `organizations`/`locations`/`registers`/`devices` tables | **Real.** Built and seeded in Phase 1 (migration v68) — one row of each per install. |
| `plemmo_organization_id`/`plemmo_location_id`/`plemmo_register_id`/`plemmo_device_id` settings pointers | **Real.** Written once by v68, read in two places: `main/core/location.ts` (Milestone 5, ids only) and `main/core/audit.ts` (a private, parallel cache of all four, for audit-event attribution). |
| `inventory_balances`/`inventory_movements.location_id` | **Real**, populated since Milestone 5's v74 backfill. |
| `purchase_orders.location_id` | **Real**, stamped since Milestone 5. |
| `orders`/`payments` location data | **Missing entirely** before this milestone — a sale or payment had no location identity of its own. |
| Employee ↔ location scope | **Missing entirely.** |
| A typed, reusable "who am I" abstraction | **Missing.** Two independent, ad hoc ID-only lookups (`location.ts`, `audit.ts`'s private cache) existed instead of one. |
| Frontend location switcher | **None**, confirming a local install represents exactly one physical location — consistent with the schema. |

**Finding:** this milestone did not need to invent the organization
hierarchy — it already existed, real, since Phase 1. The actual gaps were
(a) no single typed context abstraction, (b) `orders`/`payments` not
stamped, (c) no transfer mechanism between locations, (d) no employee
location scope at all.

---

## 2. Device context (Part B/R)

`main/core/context.ts`: `getOrganizationContext()`/`getLocationContext()`/
`getRegisterContext()`/`getDeviceContext()`, each returning a real typed
object (not just an id), resolved from the same settings pointers and
cached identically to how `audit.ts` already did privately.
`audit.ts`'s own cache now delegates to this module instead of duplicating
the four lookups — one canonical resolution path, not two.

```
getDeviceContext()   → { id, registerId, name, status }
getRegisterContext() → { id, locationId, name, code, isActive }
getLocationContext() → { id, organizationId, name, code, isActive }
getOrganizationContext() → { id, name, country }
```

No route or frontend code parses settings keys directly for this — every
future caller (sync, licensing, admin, reports) has one place to ask.

---

## 3. Data model / migrations

- **v76 (`plemmo_location_aware_sales_and_payments`)**: additive
  `organization_id`/`location_id`/`register_id`/`device_id` on `orders`;
  `organization_id`/`location_id` only on `payments` (Part E: "minimum
  required fields" — `register_id`/`device_id` add no information a
  payment doesn't already have via its `order_id` join). Existing rows
  backfilled to this install's one real context, the same pattern v74
  established for inventory. Verified against the real v1.5.0-era upgrade
  fixture, extended with an assertion that a pre-existing legacy order is
  correctly backfilled.
- **v77 (`plemmo_stock_transfers`)**: two brand-new tables
  (`stock_transfers`, `stock_transfer_items`) plus a table-rebuild of
  `inventory_movements` to widen its `movement_type` CHECK constraint to
  include `transfer_out`/`transfer_in` — SQLite cannot `ALTER` a CHECK in
  place, and migration v73's own comment already flagged this exact
  rebuild as the accepted future cost of a new movement type. Same
  create-copy-drop-rename dance migration v53 already used for the
  idempotency tables.
- **v78 (`plemmo_employee_location_scope`)**: one join table,
  `user_locations`. Every existing user is granted the install's one real
  location so the foundation starts populated, not empty.

All three additive, all verified fresh and against the real legacy
fixture; `schema-health` reports zero drift.

---

## 4. Sale/payment location stamping (Part D/E)

`SaleService.createSale()` writes the full chain
(`organization_id`/`location_id`/`register_id`/`device_id`) on every new
`orders` row. `PaymentService.persistPayment()` — the single function both
`tender()` and the legacy `recordAppliedPaymentLine()` dual-write already
shared — writes `organization_id`/`location_id` on every new `payments`
row, so both payment paths get this for free without duplicating the
stamping logic.

Existing hospitality flows are unaffected: these are purely additive
columns, populated from context that already existed, with no behavior
change to any existing code path.

---

## 5. Inventory location behavior — verified and hardened (Part F)

Milestone 5 built location-aware inventory; this milestone proves the
isolation guarantee with real tests rather than by inspection alone:
a sale, a purchase receipt, and a manual adjustment at Location A are each
proven — via `tests/plemmo-multi-location.test.ts` — to leave Location B's
balance completely untouched, including at the variant level. Because Part
K rules out building a location-switching UI in this milestone, the
sale/payment side of this proof works by pointing the settings pointer at
a different location between two calls and resetting the context cache —
a legitimate way to exercise the real `SaleService`/`PaymentService` under
two different locations without building a switcher.

---

## 6. Transfer model (Part G)

```
Location A
    │  TransferService.createTransfer()     (draft)
    │  TransferService.addTransferItem()     × N
    │  TransferService.completeTransfer()
    ↓
InventoryService.recordTransfer({ direction: 'out' }, locationId: A)
InventoryService.recordTransfer({ direction: 'in' },  locationId: B)
    ↓
Location B
```

`stock_transfers`/`stock_transfer_items`, both ULID PK. States:
`draft → completed | cancelled` — deliberately no `in_transit`, since no
existing transfer workflow needs one (Part G's own instruction). Cancel is
only possible from `draft`; there is nothing to reverse for a completed
transfer in this milestone (see §9, Known limitations).

`recordTransfer()` (Core, `main/core/inventory.ts`) is one function
handling both sides via a `direction: 'out' | 'in'` parameter, rather than
two near-duplicate functions — the `'out'` side enforces the same
"cannot go negative" policy every other movement type already has (Part J:
"cannot transfer more than source stock"); the `'in'` side has none.

**Deliberately skips the legacy `products.stock_quantity` compatibility
write.** That scalar has no correct value to represent "some stock at
Location A, some at Location B" — the same reasoning Milestone 4 already
used to exclude variants from it.

---

## 7. Transfer atomicity (Part H)

`completeTransfer()` runs entirely inside one `withTxn()`: every line's
`transfer_out` and `transfer_in` movements, for every line in the transfer,
commit or roll back together. Proven by a dedicated test: a two-line
transfer where the second line's quantity exceeds source stock leaves
*zero* movements, *zero* balance change on either location, and the
transfer record itself still `draft` — not the first line silently applied
while the second failed.

---

## 8. Transfer references (Part I)

Every movement a transfer generates carries
`reference_type = 'stock_transfer'`, `reference_id = <transfer id>` —
both the `transfer_out` and `transfer_in` sides, so a merchant looking at
either location's movement history can trace the exact transfer that moved
the stock. Verified directly by test.

---

## 9. Transfer inventory rules (Part J)

- Zero or negative transfer quantity: rejected (`TransferError`).
- Quantity exceeding source stock: rejected, checked live at completion
  time (not at draft-creation time, since stock can change between
  drafting and completing a transfer).
- Source and destination identical: rejected at creation.
- Variant identity: `product_id` + `product_variant_id` carried through
  every step exactly as given — proven isolated from both the bare
  product's balance and the other location's balance.
- Cancellation: only from `draft` — a `completed` transfer has already
  moved real stock and has no defined "undo" in this milestone (a merchant
  wanting to reverse one creates a new transfer in the opposite direction).

---

## 10. Employee scoping (Part L)

`user_locations` (migration v78) plus
`main/core/employee-access.ts`: `grantLocationAccess`/
`revokeLocationAccess`/`listUserLocations`/`userHasLocationAccess`. This is
the structural foundation only — **no route enforces it yet**. `users.role`
+ `requireRole()` remain the entire authorization story for what a user may
*do*; this new table only records *where* they're allowed to do it, for a
future milestone to wire into actual enforcement without another
migration. Deliberately not built further, per this milestone's own
instruction not to build a full RBAC system now.

---

## 11. Reports (Part M)

`main/core/location-reports.ts`: sales by location, inventory by location,
purchases by location, a transfers report, and stock adjustments by
location. Grouped counts/sums, the same posture as the existing retail/
purchasing reports — not an analytics system.

---

## 12. UI (Part Q)

`/locations`: this device's own context (organization/location/register/
device), a list of all locations, and the ability to add more (needed for
a transfer to have a destination). `/transfers`: create a draft transfer,
add items via product search, complete or cancel. Both deliberately
minimal — not the final Admin panel or device provisioning workflow.

---

## 13. Hospitality (Part N)

Unaffected. The new `orders`/`payments` columns are purely additive with
no behavior change; hospitality's own regression suite
(`tests/plemmo-inventory.test.ts` §17, plus the full pre-existing suite)
stayed green throughout. A hospitality merchant with multiple locations
gets the same structural separation retail does — tables/KDS remain
entirely location-agnostic concepts that simply happen to run at whichever
location the till is stamped with.

---

## 14. Known limitations

1. No reverse-transfer/undo for a completed transfer — a correction is a
   new transfer in the opposite direction.
2. Employee location scope is not enforced anywhere — foundation only.
3. No location-switching UI — a local install stays pinned to the one
   location it was set up with; `tests/plemmo-multi-location.test.ts`
   exercises the underlying mechanism directly, not through any UI.
4. `payments` are not stamped with `register_id`/`device_id` — derivable
   via `order_id`, judged not worth a direct column for this milestone.
5. Reports are not paginated/date-range-optimized for very large multi-
   location histories.

---

## 15. Deferred work (Part S, unchanged)

Cloud sync, offline conflict resolution, remote device activation,
licensing, bulk licenses, Plemmo Admin, feature entitlements, payment
provider integrations, supplier APIs, accounting, IMEI, repairs,
trade-ins, advanced analytics.

---

## 16. Future sync implications

Every transactional row this milestone stamps
(`orders`/`payments`/`inventory_movements`/`purchase_orders`/
`stock_transfers`) now carries enough identity (`organization_id`,
`location_id`, and for orders `register_id`/`device_id`) to be uploaded and
attributed correctly by a future sync engine without needing a separate
backfill pass. `stock_transfers` additionally gives a future sync engine a
first-class, already-atomic unit of "stock moved between two places" to
reconcile, rather than having to infer a transfer from two independent
movements after the fact.

---

## 17. See also

- [`PLEMMO_ARCHITECTURE.md`](./PLEMMO_ARCHITECTURE.md) §3 (Core module
  table, entity status), §6 (Organization/Location/Register/Device), §12
  (roadmap) — the living reference this record feeds into
- [`MILESTONE_5_PURCHASING_LOCATIONS.md`](./MILESTONE_5_PURCHASING_LOCATIONS.md) —
  the location-aware inventory foundation this milestone hardens and extends
- `main/core/context.ts`, `main/core/transfers.ts`,
  `main/core/employee-access.ts` — the code itself, commented in the same
  voice as this document
- `tests/plemmo-multi-location.test.ts`, `tests/upgrade-path.test.ts` —
  the verification this record's claims are checked against
