# Plemmo EPOS — Architecture

Plemmo EPOS is a dual-vertical, offline-first EPOS platform derived from
[FloCafe](https://github.com/FreeOpenSourcePOS/FloCafe) (MIT). This document
records what the system is now, what it is becoming, and — just as important —
which decisions have been **deliberately deferred** and why.

**Status: Phase 0 and Phase 1 complete.** Everything below marked _(not built)_
is design intent, not code.

---

## 1. Product shape

Hospitality and retail are **peer verticals over one core**. Hospitality is not
legacy to be removed; it is a working, tested asset that Plemmo can sell on day
one. Retail is added beside it, not instead of it.

```
                        PLEMMO EPOS
                             │
              ┌──────────────┴──────────────┐
        HOSPITALITY                      RETAIL
        restaurant / cafe                shops / phone shops
        takeaway / delivery              electronics / grocery
        tables · KDS · KOT               barcode · SKU · variants
        modifiers · courses              stock · purchasing · returns
              └──────────────┬──────────────┘
                             ▼
                        PLEMMO CORE
   Sale · SaleItem · Payment · Refund · Tax · Discount · Receipt
   Product · Variant · Category · Inventory · InventoryMovement
   Customer · Supplier · Employee · Role · Permission · CashSession
   Organization · Location · Register · Device · AuditEvent
                             ▼
                LOCAL-FIRST SQLite  →  SYNC  →  PLEMMO CLOUD
```

### The convergence thesis

The single most important architectural finding: **the inherited transaction
engine is already vertical-agnostic.** An order carries a *nullable* `table_id`,
`guest_count` and packaging/delivery charges, and the only hospitality-specific
behaviour in order creation is one line (`main/routes/orders.ts:519`, marking a
table occupied).

```
        ORDER  (open, mutable header + lines + tax rollup)
          │      nullable table/guest/charges, status lifecycle
          ▼
        BILL   (payable snapshot; 1:1 normally, 1:many via split_group_id)
          ▼
        PAYMENT (integer cents, idempotent, multi-tender)
```

A **retail sale is the degenerate case of the same spine** — the open-order
phase collapses to milliseconds. A **hospitality order** holds that phase open
and decorates it with kitchen workflow. Neither needs its own Sale entity, its
own payment path or its own tax path.

Consequence: convergence is an **extraction** job (lift the spine into a
`SaleService`, push vertical behaviour behind hooks), not a rewrite.

---

## 2. Current architecture (as built)

```
Electron main (main/index.ts) — BrowserWindow · autoUpdater · IPC · tray
        │
        ├── Express API :3001 (main/server.ts + routes/*)  ← business logic lives here
        │     serves the statically-exported Next.js frontend, WebSocket /kds
        │
        └── KDS server :3002 (main/kds-server.ts) — separate Express + WS
        │
        ▼
   better-sqlite3 (WAL, synchronous) — main/db.ts
   PRAGMA user_version, 78 migrations, pre-migration backup, drift detection
        │
        ▼
   main/core/   ← PLEMMO CORE (Phase 1 onward)
        money.ts · ids.ts · audit.ts · hooks.ts · sale.ts · payment.ts · inventory.ts
        location.ts · context.ts · transfers.ts · employee-access.ts · location-reports.ts
        │
        ├── main/modules/hospitality/   ← Milestone 3: tables, KDS routing
        ├── main/modules/retail/        ← Milestone 3: variants, checkout, reports
        └── main/modules/purchasing/    ← Milestone 5: suppliers, purchase orders, receiving
```

**Where business logic lives today:** the transaction engine (sale creation,
line items, payments) lives in `main/core/`, called from thin route handlers.
Everything else — products, customers, staff, settings, reporting — is still
inline in Express route handlers, as it was before Phase 1. There is no
domain layer for those yet, no ORM, no repository pattern. The tax engine
(`services/tax-engine.ts`) is the one other genuinely separated, pure
component.

Extending Core coverage to the remaining route handlers is not scheduled —
Plemmo extracts a route into Core when a real second caller needs it (a
second vertical, a sync engine, a background job), not speculatively. See
§ 12 Roadmap.

---

## 3. Plemmo Core

`main/core/` is the beginning of the domain layer. Everything in it is pure
TypeScript with no Express dependency.

| Module | Status | Purpose |
|---|---|---|
| `money.ts` | ✅ Built | Integer minor units, currency-aware, deterministic rounding, penny-exact allocation |
| `notes-validation.ts` | ✅ Built (2A) | Order/line note length rules (moved out of `routes/`) |
| `ids.ts` | ✅ Built | ULID generation for distributed entities |
| `audit.ts` | ✅ Built | Append-only who/what/when/where event log |
| `sale.ts` (`SaleService`) | ✅ Built (M2/M3) | `createSale`, `addSaleItems`, shared `persistSaleLine` engine; M3 adds an optional `variant_id` per line |
| `payment.ts` (`PaymentService`) | ✅ Built (M2/M3) | Adapter registry, `tender`/`voidPayment`/`refundPayment`, legacy dual-write; M3's retail checkout is `tender()`'s first live caller |
| `hooks.ts` | ✅ Built (M3) | Vertical hook registry — Core calls into it, never into a vertical module directly |
| `inventory.ts` (`InventoryService`) | ✅ Built (M4/M5) | `recordSale`, `recordReturn`, `adjustStock`, `recordReceipt` (M5), `getBalance`, `getMovementHistory`, `listLowStock` |
| `location.ts` | ✅ Built (M5) | `getCurrentLocationId`/`getCurrentOrganizationId` — the one place that resolves "where is this install" |
| `context.ts` | ✅ Built (M6) | `getOrganizationContext`/`getLocationContext`/`getRegisterContext`/`getDeviceContext` — the typed, full-object version; `audit.ts`'s own cache now delegates to it |
| `transfers.ts` (`TransferService`) | ✅ Built (M6) | `createTransfer`, `addTransferItem`, `completeTransfer`, `cancelTransfer` |
| `employee-access.ts` | ✅ Built (M6) | `grantLocationAccess`/`revokeLocationAccess`/`listUserLocations` — foundation only, not enforced |
| `location-reports.ts` | ✅ Built (M6) | Sales/inventory/purchases by location, transfers, adjustments |
| `authorization.ts` (`AuthorizationService`) | ✅ Built (M7), canonical (M8) | `hasPermission`, `hasLocationAccess`, `can`, `requireCan` — role→permission table plus `user_locations` enforcement; exports the canonical `Role`/`ALL_ROLES` every `requireRole()` call site now type-checks against |
| `features.ts` (`FeatureService`) | ✅ Built (M7) | `isEnabled`, `requireEnabled`, `grantFeature`/`revokeFeature`, `applyPreset`, `setCustomFeatures` — per-organization feature entitlements |
| `device-credentials.ts` | ✅ Built (SYNC-0) | `recordDeviceCredential`/`getActiveDeviceCredential`/`revokeDeviceCredential` — public-key + lifecycle only; no private key ever stored. Domain foundation for future device-authenticated sync |

### Module boundary (Milestone 3)

```
main/core/          ← imports nothing vertical-specific. Ever.
     ▲        ▲
     │        │
main/modules/hospitality/     main/modules/retail/
  hooks.ts (table occupation)   variants.ts, checkout.ts, reports.ts
```

Core defines hook *interfaces* (`SaleLifecycleHooks` in `hooks.ts`) and calls
them by name; it never imports a vertical module. Each vertical registers its
own implementation at app start-up, from the routes composition root
(`main/routes/index.ts`) — the one place that already owns every
hospitality-only route (tables, kitchen, KDS) and now also mounts
`/api/retail`. Hospitality and retail never import each other.

In practice this milestone only needed one Core-side hook
(`onSaleOpened` → table occupation), because that was the only
hospitality-specific branch left inside `main/core/sale.ts` after Milestone
2. Everything else hospitality-specific — KDS notification, kitchen station
routing, table release on payment/cancel — already lived in
`main/routes/orders.ts`/`bills.ts`/`kds.ts`, i.e. outside Core to begin with.
Those were deliberately **not** moved into `main/modules/hospitality/` this
milestone: they cost real regression risk to relocate and, since they were
never inside Core, moving them buys no additional architectural safety — see
`docs/MILESTONE_3_VERTICALS_AND_RETAIL.md` § Hospitality audit for the full
classification.

### Entity status

| Entity | Exists? | Where | Notes |
|---|---|---|---|
| Organization | ✅ New | `organizations` (v68) | One per local DB |
| Location | ✅ New | `locations` (v68) | One per local DB |
| Register | ✅ New | `registers` (v68) | One per local DB |
| Device | ✅ New | `devices` (v68) | This installation's identity |
| Employee | ⚠️ Partial | `users` | Sound bcrypt/PIN auth; location scope now enforced (M7) via `user_locations` on the routes that accept a client-supplied location |
| Role | ⚠️ Partial | `users.role` CHECK | 5 hardcoded roles, no `supervisor` |
| Permission | ⚠️ Partial (M7), canonical gate on business-critical routes (M8) | `authorization.ts`'s `ROLE_PERMISSIONS` | `main/middleware/authorize.ts`'s `requirePermission()` is the primary gate on 42 sales/inventory/purchasing/staff/location/report route handlers; the remaining ~166 stay on `requireRole()` by deliberate choice (docs/MILESTONE_8_AUTHORIZATION.md §1) |
| Feature entitlement | ✅ New (M7) | `features`/`feature_presets`/`feature_preset_items`/`organization_features` (v79) | Per-organization; 14 real feature keys; presets + custom configuration; `isEnabled()` is the single enforcement entry point |
| Product | ✅ | `products` | Flat; a variant's parent when it has one |
| ProductVariant | ✅ New (M3) | `product_variants` (v72) | ULID PK; own price/cost/SKU/barcode; a hospitality product never needs one — see § Product/Variant below |
| Category | ✅ | `categories` | Has `parent_id` |
| Customer | ✅ | `customers` | E.164 phone, search |
| Supplier | ✅ New (M5) | `suppliers` (v75) | Purchasing relationship only — no accounting fields |
| PurchaseOrder | ✅ New (M5) | `purchase_orders`/`purchase_order_items` (v75) | draft → ordered → partially_received/received; location-aware |
| Inventory | ✅ New (M4), location-aware (M5) | `inventory_balances` (v73, `location_id` populated from v74) | Maintained balance, per (product, variant, location); `products.stock_quantity` kept in sync as a compatibility write for variant-less products only |
| InventoryMovement | ✅ New (M4), location-aware (M5) | `inventory_movements` (v73) | Immutable ledger — sale/return/adjustment/receipt/opening; see docs/MILESTONE_4_INVENTORY.md and docs/MILESTONE_5_PURCHASING_LOCATIONS.md |
| Sale | ✅ | `orders` | The convergent spine; `createSale`/`addSaleItems` built; M3 adds `channel: 'in_store'` for retail, no table; M6 stamps organization/location/register/device |
| SaleItem | ✅ | `order_items` | Inserted via the shared `persistSaleLine` engine; M3 adds `product_variant_id`/`unit_cost` columns, populated when a line names a variant |
| Bill | ✅ | `bills` | Payable snapshot; now has `uid`; generation/split not yet in Core |
| Payment | ✅ New (M2), authoritative (SYNC-0) | `payments`/`payment_events` (v71) | ULID PK, adapter-based state machine; **now the authoritative, complete payment model** — the hospitality dual-write is atomic (no longer error-swallowing) and legacy `payment_details` is backfilled (v80) and kept only as a compatibility bridge; `bill_uid`/`order_uid` global refs added (SYNC-0); M6 stamps organization/location |
| StockTransfer | ✅ New (M6) | `stock_transfers`/`stock_transfer_items` (v77) | draft → completed/cancelled; atomic transfer_out + transfer_in |
| Refund | ✅ New (M2) | `refunds` (v71) | Foundation only — `refundPayment()` in `payment.ts`, no inventory return yet |
| Tax/VAT | ✅ Strong | `services/tax-engine.ts` | Decimal, pack-driven; **no GB pack yet** |
| Discount | ⚠️ Fragmented | 3 implementations | Order, line, bill |
| CashSession | ❌ | — | No shift or drawer accounting |
| Receipt | ✅ Strong | `printers/thermal.ts` | ESC/POS, profiles, typed failures |
| AuditEvent | ✅ New | `audit_events` (v70) | |
| Synchronization | ❌ | — | See §7 |

### Product / Variant (Milestone 3)

`product_variants` (migration v72) is additive and starts empty. A
hospitality menu item never gets a row here — it stays exactly what it was
before this milestone: a bare `products` row, sold directly, no variant UI
ever shown to a restaurant merchant. A retail product that needs distinct
SKUs/barcodes/prices per option gets one `product_variants` row per option.

```
Product (products)
    │
    └── ProductVariant (product_variants)   ← optional
            ├── sku, barcode        (own, uniquely constrained)
            ├── price, cost         (own — can differ from the parent)
            └── tax_category_id     (column exists; tax still resolves at the
                                      product level in M3 — see Known limitations)
```

`order_items` gained two columns: `product_variant_id` (which variant sold,
for historical accuracy even if the variant is edited later) and `unit_cost`
(a cost snapshot for future gross-margin reporting, not wired into any report
yet). `SaleService.persistSaleLine()` resolves price/SKU from the variant
when a line names one, and from the product otherwise — the exact same
function hospitality has always called, now vertical-agnostic about where
its price comes from.

SKU/barcode uniqueness is a hard, partial-unique database constraint on
`product_variants` (safe — the table starts empty). It is deliberately
**not** enforced on `products.sku`/`products.barcode` — years of real
merchant data may already contain blanks or duplicates there, and a blind
`UNIQUE` index was an explicit stop condition for this milestone.

---

## 4. Money model

**Rule: integer minor units. Never floats. See `main/core/money.ts`.**

### Why

A POS must produce identical pennies on the receipt, in the report and in the
VAT return, on every machine. Doubles cannot promise that.

### What is built

`toMinor` / `fromMinor` / `formatMinor`, `addMinor` / `subMinor` / `mulMinor`,
`percentOfMinor`, `divideRound`, `allocateMinor`, `moneyFor(currency)`.

Three properties worth knowing:

1. **`toMinor` is string-based**, not `Math.round(n * 100)`. The naive form
   inherits the input's representation error: `1.005` is stored as
   `1.00499999999999989`, so `Math.round(1.005 * 100)` is 100, not 101. A test
   asserts the naive form really is wrong so the reason cannot be forgotten.
2. **Rounding mode is always explicit.** Which way a half goes is a
   jurisdiction rule, not a language detail.
3. **`allocateMinor` is the penny-leak guard.** Largest-remainder allocation
   whose parts always sum back to the original exactly. Splitting a bill,
   prorating an order discount and apportioning inclusive VAT share one failure
   mode: round each part independently and the receipt stops agreeing with the
   payment.

Currency exponent is derived from ISO 4217 (`GBP` → 2, `JPY` → 0, `KWD` → 3),
fixing a latent bug in the inherited `Math.round(v * 100)` payment path for the
non-2-decimal currencies the app already offers.

### ⚠️ Deferred: storage columns are still `REAL`

The schema stores money in ~33 SQLite `REAL` columns across `products`,
`addons`, `orders`, `order_items`, `bills` and `loyalty_ledger`. **These have
not been converted** — every query in the repo reads them as floats, so
converting is a wide breaking change.

This is survivable in the meantime: doubles hold pennies exactly well beyond
any realistic transaction value, and the payment path already converts to
integer cents before doing arithmetic. It is nonetheless wrong for a UK
financial product long-term.

**Staged plan (not yet executed):**

1. New code computes in minor units and converts at the storage boundary. ✅ *now possible*
2. Add `*_minor INTEGER` columns beside the `REAL` ones; dual-write.
3. Migrate reads table by table, starting with `bills`/`payments`.
4. Drop the `REAL` columns once nothing reads them.

**Do this before real merchants are live.** It gets dramatically more expensive
afterwards.

---

## 5. Identifiers

**Rule: anything that can be created on more than one device gets a ULID.**

### Why ULID over UUIDv4

Both are collision-safe without coordination. ULID additionally sorts
lexicographically by time, which keeps SQLite indexes dense, makes "recent
sales" and future sync cursors range scans on the key itself, and makes logs
readable.

Implemented in-repo (`main/core/ids.ts`) rather than adding a dependency: the
spec is short and stable, it is financial identity code a commercial product
should own, and it preserves the licence-clean dependency tree.

### What is built

`orders`, `order_items` and `bills` each gained a `uid TEXT` column
(migration v69) with a **partial unique index** (`WHERE uid IS NOT NULL`).

- **Unique**, because a duplicate would silently merge two distinct sales
  during a future sync.
- **Partial**, so insert paths not yet taught to populate `uid` keep working.

Existing rows were backfilled with each ULID's timestamp seeded from the row's
own `created_at`, so generated ids sort in true historical order.

`createSale` and `addSaleItems` (both in `sale.ts`) now populate `uid` on
every sale and sale line they create — the migration made the column
possible, Milestone 2 made it actually happen on the write path. `payments`,
`payment_events` and `refunds` (migration v71) are brand-new tables with no
legacy integer key to preserve, so they use a ULID **directly as the primary
key**, the same pattern `organizations`/`locations`/`registers`/`devices`/
`audit_events` already established in Phase 1.

### Why `uid` beside the key, not a primary-key conversion

Converting `orders.id` outright would break every foreign key, join, report and
the KDS WebSocket contract in one commit. The `uid` column gives every row a
globally unique identity **now**, at zero risk, while existing code is
untouched.

| Entity | Strategy |
|---|---|
| Sale, SaleItem, Bill | ✅ ULID `uid` beside integer PK, now populated on write |
| Payment, Refund | ✅ ULID PK directly (new tables, M2) |
| InventoryMovement, CashSession | ULID PK when built |
| Organization, Location, Register, Device | ✅ ULID PK |
| AuditEvent | ✅ ULID PK |
| Product, Category, Customer, User | Already TEXT UUID — standardise on ULID going forward |
| settings, sequences, local caches | Integer/local keys are fine — never leave the device |

### ⚠️ Deferred: promoting `uid` to primary key

Needed before multi-till sync. Requires rewriting FKs, joins, reports and the
KDS contract. **One-way door — do it while merchant count is zero.**

---

## 6. Organization / Location / Register / Device

```
Organization  (the merchant business)
   └── Location    (branch/store)
         └── Register   (till/lane)
               └── Device     (this installation)
```

### Scope decision

**A till's local database holds exactly ONE organization, location and
register.** It is single-tenant by construction: a shop-floor machine must be
physically incapable of holding another merchant's data. That is the simplest
code, the strongest GDPR posture, and it removes any chance of a cross-tenant
leak on a counter.

Multi-tenancy proper — many organizations in one database — is a **cloud**
concern (shared schema, `organization_id` on every row, one hard tenant guard)
and is deliberately not modelled locally.

Migration v68 seeds the hierarchy from existing settings and writes pointers
(`plemmo_organization_id`, `plemmo_location_id`, `plemmo_register_id`,
`plemmo_device_id`) so "which register am I?" is one cheap settings read.

### ⚠️ Deferred

- **Stamping transactional rows** with `location_id`/`register_id`/`device_id`
  so they self-identify after upload. Needed before sync. Milestone 5 did
  this for `inventory_movements`/`inventory_balances`/`purchase_orders`
  (`location_id`). Milestone 6 added the full chain
  (`organization_id`/`location_id`/`register_id`/`device_id`) to `orders`,
  and `organization_id`/`location_id` to `payments`
  (`register_id`/`device_id` deliberately omitted there — derivable via
  `order_id`). `bills` and `stock_transfers`/`purchase_orders`'
  `register_id`/`device_id` remain unstamped.
- **Device pairing, certificates, revocation.** The KDS module already contains
  a working pairing-token + QR + WebSocket-auth-revalidation implementation —
  harvest it rather than inventing a new flow.
- **Licence binding** to device identity.

---

## 7. Offline and synchronisation

### What is true today

Single-till offline operation is genuinely excellent: SQLite is the only
database, every write is local and synchronous, `withTxn()` gives real
transactions, and nothing in the sell path touches the network.

### What is *not* true

**There is no sync engine.** What the inherited code calls "cloud sync"
(`main/services/cloud-sync.ts`) is a one-way outbound bridge to the upstream
vendor's SaaS: it pushes telemetry-shaped events and answers eight read-only
report commands. Nothing is ever written back into the local database.

**As of Phase 0 it is switched off** (migration v67) and does not contact
anything.

### ⚠️ Deferred: the real engine (largest single build ahead)

Target design:

```
Every local write → domain txn + append to change_log (SAME transaction)
   change_log: id(ULID), entity, entity_id, op, payload, hlc, device_id, synced_at?

PUSH: batch unsynced → cloud (signed, resumable); cloud dedups by ULID
PULL: cloud → device: changes since cursor; apply locally; advance cursor
```

Conflict policy is **per entity, not global**:

| Entity class | Policy | Why it is safe |
|---|---|---|
| Sales, payments, refunds, cash movements | Immutable append; never conflict | A completed sale is a fact. Two tills create different sales with different ULIDs — they merge, they do not collide. |
| Inventory | Ledger **deltas**, not absolute values | −5, −3, +1 are independent and commutative, so offline convergence is automatic. Overselling is *detected and reconciled*, not prevented — the honest POS answer. |
| Products, prices, config | Last-writer-wins by HLC, cloud-authoritative | Catalogue edits are rare and usually single-origin. |
| Customers | Field-level LWW | Merge non-conflicting fields. |

This is why inventory **must** become a movement ledger before sync: a mutable
scalar cannot converge.

---

## 8. Payments

### Two payment systems exist side by side, on purpose

**The legacy path is still the only one anything real uses.** Tenders are a
JSON array inside `bills.payment_details`, applied by `applyPaymentBatch()` in
`main/routes/bills.ts` — user-scoped idempotency (`payment_idempotency`),
transaction-reference uniqueness (`payment_transaction_refs`), integer-cent
allocation across split tenders, wallet balance checks, cashback. This is
genuinely good, load-bearing code and **it was not rewritten**.

**A new persistence and adapter layer exists alongside it** (`main/core/payment.ts`,
migration v71 — `payments` / `payment_events` / `refunds`), built to the target
design below, and connected to the legacy path by an **additive dual-write**:
`applyPaymentBatch()` gained one extra call, right after it has already decided
each tender's final amount, that mirrors the outcome into the new tables. It
inherits idempotency for free (both of `applyPaymentBatch`'s own replay paths
return before that call is reached) and can never break a real payment (wrapped,
logged, swallowed on failure — proven by a test that removes the `payments`
table out from under a live HTTP payment and confirms the payment still
succeeds).

```
SaleService
     │
PaymentService  (main/core/payment.ts) — state machine + idempotency + persistence
     │  tender() — as of M3, called by retail checkout (main/modules/retail/
     │             checkout.ts); still not wired into any hospitality route
     │  voidPayment() / refundPayment() — the Part 8 foundation, still unwired
     ▼
PaymentAdapter (interface: capture)
   ├── CashAdapter          in-process, settles instantly            ✅ built
   ├── WalletAdapter        internal loyalty debit, settles instantly ✅ built
   ├── ManualCardAdapter    cashier attestation, unverified → captured, not settled  ✅ built
   └── Teya / Worldpay / SumUp / Shift4 / Elavon — later, one at a time, unbuilt

applyPaymentBatch() (main/routes/bills.ts, UNCHANGED)
   │
   └─▶ recordAppliedPaymentLine()  — additive dual-write, never throws
```

**The rule this whole layer exists to enforce:** "recorded in the POS database"
must not automatically mean "the external card payment is definitely settled."
`ManualCardAdapter` landing on `captured` rather than `settled` is the concrete
expression of that — a future real provider adapter is what gets to say
`settled`, once it has actually heard back from a processor.

### Why the legacy path was not replaced

`tender()` deliberately does no split-tender allocation and no wallet-balance
checking — one tender for one amount, which is what an adapter-based flow
naturally is. Wiring it into `POST /bills/:id/payment(s)` in place of
`applyPaymentBatch` would mean re-implementing that allocation and validation
logic, which is exactly the "don't rewrite blindly" risk that milestone's own
rules existed to prevent. `tender()` is real, tested, and now has its first
live caller — retail checkout (`main/modules/retail/checkout.ts`, M3), which
needs neither split-tender allocation nor wallet checks for a single-tender
counter sale. `applyPaymentBatch` remains the only path hospitality's
multi-line payment UI uses; migrating it onto `tender()` is still deferred —
see § 12 Roadmap.

One known compromise, recorded rather than hidden: the dual-write stores
whatever `applyPaymentBatch` computed, and that function computes amounts as
integer *cents* unconditionally (`paymentAmountCents()`, `* 100` regardless of
currency exponent) — a real latent bug for JPY/KWD-style currencies, and
exactly the class of bug `main/core/money.ts` exists to fix. Fixing it means
touching `applyPaymentBatch`, so for now the new `payments` table is a
truthful mirror of the old one, bug included. `tender()` itself is
exponent-correct from day one.

`tender()` still does not update `bills.paid_amount`/`payment_status` — that
reconciliation is bespoke to `applyPaymentBatch` and was never reimplemented
inside `tender()` itself. Retail checkout, as `tender()`'s first caller, does
that reconciliation itself in `main/modules/retail/checkout.ts` right after
calling `tender()`, since it is a brand-new path with no legacy gap to
inherit. Any *other* future caller of `tender()` needs to do the same.

### Refunds and voids — the Part 8 foundation, not a RefundService

`voidPayment()` and `refundPayment()` live in `payment.ts` because they operate
directly on `payments`. Void is reachable only from `requested`/`captured` —
a settled cash payment is already in the drawer, so that gets refunded, not
voided. Refund supports partial amounts via a running `refunded_minor` total
on the payment row, moving to `refunded` only once fully covered. **Neither
touches `products.stock_quantity` or any other inventory state** — that
boundary is deliberate, so a later `RefundService → InventoryService →
InventoryMovement` chain can compose cleanly without this layer having already
made an assumption about how stock returns work.

---

## 9. Hardware

Preserved as-is — this is the strongest inherited asset.

| Device | Status |
|---|---|
| Thermal ESC/POS (network / USB / WebUSB) | ✅ Production quality, 10 typed failure classes |
| Printer profiles + mDNS discovery | ✅ Model registry with aliases, column counts |
| Barcode scanner (keyboard wedge) | ✅ Retail-ready as written |
| **Cash drawer** | ✅ Foundation (M3) — `openCashDrawer()` in `printers/thermal.ts`, standard ESC/POS kick pulse through the same connection `printReceipt`/`printKOT` already use |
| **Customer display** | ❌ Absent |
| Touchscreen / kiosk mode | ⚠️ Implicit only |

### ⚠️ Deferred

A Core `PeripheralRegistry` so device types are registered rather than
hardcoded (`printers.connection_type` is a `CHECK` constraint today, so adding
Bluetooth or serial is a migration). Domain emits intents ("open drawer",
"print receipt"); the peripheral layer executes them. Keeps hardware out of
domain logic and makes the domain testable without hardware.
`openCashDrawer()` is a first, narrow step in that direction — one named
domain call, no registry yet — not the full abstraction.

---

## 10. Security

Inherited and sound: `contextIsolation: true`, `nodeIntegration: false`, a
51-line preload, per-install random JWT secret, working token revocation
(`tokensValidAfter`), bcrypt passwords and PINs, auth rate limiting that
deliberately does **not** exempt LAN IPs, and a URL allowlist.

### ⚠️ Deferred (known risks)

| Risk | Note |
|---|---|
| LAN API is cleartext HTTP on `0.0.0.0` | JWTs and order payloads cross the shop network unencrypted. Needs TLS or loopback-only until sync-based multi-till replaces LAN-client multi-till. |
| No device identity in auth | Staff JWT authenticates the person; nothing authenticates the machine. |
| Role-only authorization | Cannot express "cashier may refund up to £20". |
| Database unencrypted at rest | A stolen till exposes PII and trading history. |
| JWT in `localStorage` | XSS would yield a long-lived token. |

---

## 11. Phase 0/1 decisions record

### Decisions made

| # | Decision | Rationale |
|---|---|---|
| 1 | Remove WhatsApp entirely | `@whiskeysockets/baileys` → `libsignal` **GPL-3.0**, bundled into the shipped asar. Blocking for proprietary white-label licensing. Backend tree is now 100% permissive. |
| 2 | Keep `whatsapp_*` tables as inert legacy schema | The GPL exposure was the *dependency*, not the rows. Dropping tables is a destructive migration for zero licensing benefit. |
| 3 | Rename app identity (`plemmo-epos`, `com.plemmo.epos`) | Also relocates Electron's userData directory — intended, since Plemmo must not adopt another product's data. |
| 4 | **Disable all upstream cloud/telemetry by default** (v67) | Not cosmetic. Cloud v2 removed the human claim step, so `cloudSync.start()` → `attemptAutoRegister()` fired on every boot and would POST business name, contact and address to `blue.flopos.com` unprompted. |
| 5 | Keep upstream endpoint constants, documented | Inventing placeholder Plemmo URLs would only produce confusing connection failures. The switches make them inert. |
| 6 | Cloud sync remains explicit opt-in, not hard-disabled | Preserves the path for a self-hosted or future Plemmo endpoint. |
| 7 | Money foundation without schema conversion | Column conversion is a wide breaking change; the module lets new code be correct immediately. |
| 8 | `uid` column beside integer PK, not PK conversion | Zero-risk distributed identity now; PK promotion stays a deliberate future step. |
| 9 | Partial unique index on `uid` | Unique prevents a future sync merging two sales; partial keeps legacy insert paths working. |
| 10 | Single-tenant local DB | A shop-floor machine must be physically incapable of holding another merchant's data. |
| 11 | Audit writes never throw | Refusing a sale is worse than losing one audit row. |
| 12 | Own ULID implementation | Short stable spec; financial identity code a commercial product should own; keeps the dependency tree clean. |
| 13 | Receipt branding via a brand seam with empty URLs | A dead or third-party legal/marketing link is worse than none. |

### Deliberately deferred

**Before real merchants (one-way doors):**
- `REAL` → `INTEGER` minor-unit money columns
- `uid` → primary key promotion
- Stamping transactional rows with location/register/device

**Phase 2+:**
- `SaleService` / `PaymentService` extraction from route handlers — done (M2)
- Hospitality module boundary; `ProductVariant`; retail checkout; cash-drawer
  foundation — done (M3)
- Roles → granular permissions (blocked by the `users.role` CHECK constraint)
- Inventory movement ledger; per-variant stock — done (M4)
- Suppliers, purchase orders, goods receiving, location-aware inventory — done (M5)
- Stock transfers between locations; device/location context (`context.ts`);
  `orders`/`payments` location stamping; employee location-scope foundation
  — done (M6)
- Employee location-scope *enforcement*; multi-location selection/switching UI
- GB VAT tax pack (engine exists, **no GB pack is bundled** — only `generic.json`)
- Cash sessions, till reconciliation (drawer *kick* exists; shift accounting doesn't)
- Sync engine, Plemmo Cloud, device pairing, licensing
- Payment provider adapters
- Removal of the upstream cloud client, Google Drive backup, RevFlo surface
- Dropping the inert `whatsapp_*` tables
- Renaming the database file (`flo.db`) — touches backup/restore/recovery paths
- Splitting the two god-files (`main/db.ts`, `settings/page.tsx`)

### ⚠️ Requires human action before distribution

| Item | Detail |
|---|---|
| **Code signing** | `build.mac.identity`, `build.mas.provisioningProfile`, `build.appx.publisher` still hold **third-party** credentials (Codify Apps Private Limited). Untouched deliberately — replacing credentials needs a human. |
| **Update feed** | Repointed to `richanonymous22/FloCafe`. Set the real Plemmo release repo before shipping. |
| **Legal URLs** | `frontend/src/lib/brand.ts` terms/privacy/disclaimer are empty; links are hidden until set. |
| **Licence review** | `sharp` bundles LGPL-3.0 `libvips` (dynamically linked; generally accepted, but confirm with a solicitor). Root `LICENSE` (MIT, FloCafe Contributors) must be retained in distributions. |
| **`package.json` `license` field** | Still `MIT`. Whether the Plemmo derivative is relicensed is a commercial/legal decision. |

---

## 12. Roadmap

| Phase | Objective | Status |
|---|---|---|
| 0 | Safety & identity — GPL removal, branding, third-party disconnection | ✅ Done |
| 1 | Foundations — money, identifiers, org hierarchy, audit | ✅ Done |
| 2 (M2) | Core transaction engine — `SaleService` (`createSale`, `addSaleItems`, shared line engine), `PaymentService` (adapters, persistence, dual-write, refund/void foundation) | ✅ Done |
| 3 (M3) | Verticals + retail foundation — hospitality hook boundary, `ProductVariant`, retail checkout (`in_store` channel, `tender()`'s first live caller), cash-drawer foundation, basic retail reporting | ✅ Done |
| 4 (M4) | Inventory engine — movement ledger, variant-level balances, refund/adjustment integration, low-stock, basic inventory UI | ✅ Done |
| 5 (M5) | Purchasing + suppliers + location-aware inventory — `SupplierService`, `PurchaseOrderService`, `ReceivingService`, `inventory_movements`/`inventory_balances` now stamped with the install's real location | ✅ Done |
| 6 (M6) | Multi-location + device context + stock transfers — typed `context.ts`, `orders`/`payments` location stamping, `TransferService`, employee location-scope foundation, location-scoped reports | ✅ Done |
| 7 (M7) | Access control + feature entitlements — `user_locations` enforcement on client-facing routes, `AuthorizationService` (role→permission model alongside `requireRole()`), `FeatureService` (`Organization → FeatureEntitlement[] → Feature`), presets, custom configuration, backend enforcement on business-critical routes | ✅ Done |
| 8 (M8) | Authorization hardening — full `requireRole()` audit (212 call sites, 28 files), canonical `requirePermission()` gate on 42 business-critical routes (sales/inventory/purchasing/staff/locations/reports), device-location enforcement on sale creation, spoofing-resistance tests, `requireRole()` type-checked against `AuthorizationService`'s own `Role` union | ✅ Done |
| 9 (design) | Offline sync architecture — [`MILESTONE_9_SYNC_ARCHITECTURE.md`](./MILESTONE_9_SYNC_ARCHITECTURE.md) design, [`MILESTONE_9A_SYNC_REVIEW.md`](./MILESTONE_9A_SYNC_REVIEW.md) adversarial review | ✅ Done (design) |
| SYNC-0 | Foundation repair before sync — authoritative payments (v80), load-bearing uids (v81), child-row tombstones (v82), inventory organization identity (v83), device-credential foundation (v84). [`SYNC_0_FOUNDATION.md`](./SYNC_0_FOUNDATION.md) | ✅ Done |
| SYNC-A+ | The sync engine itself (outbox/inbox/cloud) — not started | Next |
| (later) | Multi-location selection/switching UI; two-phase transfers; a dedicated refund/void HTTP surface for `PaymentService` | |
| 10 | Retire the dual-write once the new payment model is trusted in production; migrate `applyPaymentBatch`'s callers onto `tender()` | |
| 11 | Sync engine — including real conflict resolution for concurrent inventory writes across tills (docs/MILESTONE_4_INVENTORY.md § Concurrency) | |
| 12 | Plemmo Cloud + Admin | |
| 13 | Licensing enforcement | |
| 14 | Payment provider adapters | |
| 15 | Advanced retail: phone-shop/IMEI, repairs, trade-ins | |

Phases 0–11 yield a product a single-location merchant can trade on, and a
multi-location merchant can operate locally. The pilot does not wait for
the cloud. See `docs/MILESTONE_2_CORE_ENGINE.md`,
`docs/MILESTONE_4_INVENTORY.md`, `docs/MILESTONE_5_PURCHASING_LOCATIONS.md`,
`docs/MILESTONE_6_MULTI_LOCATION.md`,
`docs/MILESTONE_7_ACCESS_AND_ENTITLEMENTS.md`, and
`docs/MILESTONE_8_AUTHORIZATION.md` for the detailed design records of
Milestones 2, 4, 5, 6, 7, and 8.

---

## See also

- [`PLEMMO_DEVELOPMENT_RULES.md`](./PLEMMO_DEVELOPMENT_RULES.md) — the rules, and the AI-agent red/amber/green zones
- [`PHASE_2A_SALE_FLOW.md`](./PHASE_2A_SALE_FLOW.md) — the pre-extraction audit `createSale` was built against
- [`MILESTONE_2_CORE_ENGINE.md`](./MILESTONE_2_CORE_ENGINE.md) — the Core transaction engine design record: `SaleService`, `PaymentService`, adapters, the dual-write strategy, deferred work
- [`MILESTONE_3_VERTICALS_AND_RETAIL.md`](./MILESTONE_3_VERTICALS_AND_RETAIL.md) — the hospitality boundary and retail foundation design record: the hospitality coupling audit, the hook seam, `ProductVariant`, retail checkout, cash drawer, deferred work
- [`MILESTONE_4_INVENTORY.md`](./MILESTONE_4_INVENTORY.md) — the inventory engine design record: the stock-behavior audit, the movement ledger and balance strategy, the opening-balance migration, sale/refund integration, negative-stock policy, concurrency assumptions, deferred work
- [`MILESTONE_5_PURCHASING_LOCATIONS.md`](./MILESTONE_5_PURCHASING_LOCATIONS.md) — the purchasing and location-aware inventory design record: the location model audit, suppliers, purchase orders, receiving, idempotency, deferred work
- [`MILESTONE_6_MULTI_LOCATION.md`](./MILESTONE_6_MULTI_LOCATION.md) — the multi-location design record: the device/location context audit, sale/payment stamping, stock transfers and their atomicity, employee location scope, future sync implications, deferred work
- [`MILESTONE_7_ACCESS_AND_ENTITLEMENTS.md`](./MILESTONE_7_ACCESS_AND_ENTITLEMENTS.md) — the access-control and feature-entitlement design record: `AuthorizationService`, location enforcement, the permission model, `FeatureService`, presets, custom configuration, backend enforcement, security considerations, deferred work
- [`MILESTONE_8_AUTHORIZATION.md`](./MILESTONE_8_AUTHORIZATION.md) — the authorization hardening design record: the full `requireRole()` audit, the canonical `requirePermission()` gate, which routes were migrated and why, the security review of client-supplied context, remaining gaps
- [`MILESTONE_9_SYNC_ARCHITECTURE.md`](./MILESTONE_9_SYNC_ARCHITECTURE.md) / [`MILESTONE_9A_SYNC_REVIEW.md`](./MILESTONE_9A_SYNC_REVIEW.md) — the offline-sync architecture design and its adversarial review
- [`SYNC_0_FOUNDATION.md`](./SYNC_0_FOUNDATION.md) / [`SYNC_0_PAYMENT_MIGRATION.md`](./SYNC_0_PAYMENT_MIGRATION.md) — the pre-sync foundation repairs (authoritative payments, load-bearing uids, tombstones, sync identity, device credentials) and the payment migration in detail
- [`../AGENTS.md`](../AGENTS.md) — inherited repository conventions
- [`tax-packs.md`](./tax-packs.md), [`printers.md`](./printers.md) — inherited subsystem docs
