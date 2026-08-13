# Milestone 2 — Plemmo Core Transaction Engine

Design record for the work that took `main/core/` from "a sale can be created"
(Phase 2A) to "a sale can be created, added to, and paid for through a real
payment abstraction" (this milestone). Read alongside
[`PLEMMO_ARCHITECTURE.md`](./PLEMMO_ARCHITECTURE.md) (the living reference)
and [`PHASE_2A_SALE_FLOW.md`](./PHASE_2A_SALE_FLOW.md) (the pre-extraction
audit this milestone's Part 1 continues).

**Status: complete.** Everything described as built below is built and
tested. Everything marked deferred is not.

---

## 1. Scope

```
PLEMMO CORE
     │
 ┌───┴────┐
 │        │
HOSPITALITY   RETAIL
 │        │
 └───┬────┘
     │
 Sale Engine       ✅ createSale, addSaleItems, shared line engine
     │
 Payment Engine    ✅ adapters, persistence, dual-write, refund/void foundation
     │
 Inventory Hooks   existing stock_quantity writes, unchanged — no ledger yet
```

In scope and built: `SaleService.addItems()`, the shared item-processing
engine, `PaymentService`, `PaymentAdapter` + `CashAdapter`/`ManualCardAdapter`/
`WalletAdapter`, the `payments`/`payment_events`/`refunds` persistence
foundation, a minimal payment state machine, idempotency reuse, and the
void/refund foundation.

Explicitly out of scope and **not** built: real payment-provider integrations
(Teya/Worldpay/SumUp/Shift4/Elavon), cloud sync, multi-till synchronisation,
the inventory movement ledger, product variants, suppliers/purchasing, retail
UI, phone-shop features, Plemmo Admin, licensing enforcement.

---

## 2. Architecture before → after

### Before (end of Phase 2A)

```
routes/orders.ts
  POST /orders            → SaleService.createSale()          ✅ migrated
  POST /orders/:id/items  → 251 lines of inline logic, a near-duplicate
                             of createSale's item loop           ❌ not migrated

routes/bills.ts
  applyPaymentBatch()     → tenders as a JSON array in
                             bills.payment_details, no identity,
                             no state, no adapter concept          untouched
```

### After (end of Milestone 2)

```
routes/orders.ts
  POST /orders            → SaleService.createSale()
  POST /orders/:id/items  → SaleService.addSaleItems()  ← both call the
                                                            shared persistSaleLine()

routes/bills.ts
  applyPaymentBatch()     → UNCHANGED, plus one additive call:
                             recordAppliedPaymentLine() → PaymentService
                             (dual-write into payments/payment_events)

core/payment.ts (NEW)
  tender() / voidPayment() / refundPayment()  ← standalone, not yet
                                                  wired to any route
```

The shape of the change is consistent across both halves of this milestone:
**extract and share what's duplicated; wrap and dual-write what's too
load-bearing to rewrite.** Those are different techniques for the same
underlying goal — get to a real Core engine without a rewrite.

---

## 3. Design decisions

### 3.1 The shared sale-line engine

**Decision:** one function, `persistSaleLine()`, does the per-line work
(product lookup, stock guard, price/quantity validation, addon subtotal, tax
calculation, insert, addon insert, stock decrement) for both `createSale` and
`addSaleItems`. Each caller aggregates the results differently.

**Why:** the two inherited routes carried near-identical copies of this logic.
Consolidating it is the direct payoff of Part 1/2 — "one business rule
implementation, multiple callers" — and it is also why items added via
`addSaleItems` now get a `uid`, which the old route never populated.

**What was deliberately NOT unified:** aggregation. `createSale` sums
per-line results as it iterates, because nothing else exists on a brand-new
sale. `addSaleItems` re-derives totals from every *active* line already in the
database afterward, because it may be adding to a sale that already has
items, some of which may be cancelled (inherited as "BUG #3 FIX"). Forcing
these into one aggregation strategy would have been a real behaviour change,
not a refactor.

### 3.2 Two guard clauses stayed in the route

**Decision:** the `bills.split_group_id` lock and the waiter-ownership check
were not moved into `addSaleItems`.

**Why:** the split-lock is a simple, self-contained check with nothing to
share between callers — moving it would have added indirection for no
benefit. The waiter-ownership check is an authorization decision tied to the
HTTP caller's role (`req.user.role`), which belongs beside `requireRole` at
the HTTP layer, not inside a service with an explicit "no Express dependency"
rule. Both run in the same relative order as before, so no response code
changes for any input — verified by keeping the exact original check sequence
in the route and only calling into the service afterward.

### 3.3 `specialInstructions` needed a typed wrapper

**Decision:** `AddSaleItemsInput.specialInstructions` is
`{ value: string | null } | undefined`, not `string | null | undefined`.

**Why:** the inherited route branches on `special_instructions !== undefined`
in the raw request body — "the key wasn't sent at all" (leave untouched) is a
different case from "the key was sent as `null`" (clear the notes), and a
plain optional string can't distinguish those once it's been through a typed
interface. The wrapper's presence, not its value, carries the signal.

### 3.4 Dual-write, not a rewrite, for payments

**Decision:** `applyPaymentBatch()` in `routes/bills.ts` was not rewritten,
migrated, or wrapped in a new abstraction. It gained exactly one additive
call — `recordAppliedPaymentLine()` — placed after it has already decided
each tender's final allocated amount and updated the bill.

**Why:** `applyPaymentBatch` is idempotency handling, transaction-reference
uniqueness, integer-cent allocation across split tenders, wallet balance
checks, and cashback calculation, all interleaved. This project's own
development rules (`PLEMMO_DEVELOPMENT_RULES.md`) name it explicitly as code
an agent must not touch unsupervised, and this milestone's own instructions
repeated that. Nothing about that risk assessment changed by reading the code
again — if anything, reading it closely confirmed it. The STOP CONDITIONS
listed "`applyPaymentBatch()` cannot be safely wrapped" and "the payment JSON
cannot be dual-written safely" as reasons to halt; investigation showed both
concerns *are* addressable — not by touching the function's logic, but by
adding one call at a point where its outcome is already fully decided. That
is what "safely wrapped" turned out to mean in practice.

**What makes the dual-write safe, specifically:**
- **Idempotency is free.** Both of `applyPaymentBatch`'s own replay
  paths — the idempotency-key check at the top, and the transaction-id-match
  check inside `preparePaymentBatch` — return *before* the new call is ever
  reached. A retried HTTP request (same `Idempotency-Key`) cannot produce a
  duplicate `payments` row, and this is proven over real HTTP in
  `tests/plemmo-payment-service.test.ts` §15, not just asserted from reading
  the code.
- **It cannot break a real payment.** `recordAppliedPaymentLine()` wraps its
  entire body in try/catch and only logs on failure — same rule as
  `recordAuditEvent()` from Phase 1. Proven in §16 of the same test: the
  `payments` table is renamed out from under a live HTTP payment request, and
  the payment still succeeds and the bill still ends up `paid`.
- **It mirrors the legacy path's actual behaviour, bugs included.** See §5.1
  below.

### 3.5 `tender()` exists but is not wired to any route

**Decision:** `PaymentService.tender()` is a complete, tested, standalone
entry point. It is not called from `POST /bills/:id/payment(s)` or anywhere
else in this milestone.

**Why:** wiring it in would mean replacing `applyPaymentBatch`'s allocation
(splitting one request across multiple tender lines, applying cash up to the
remaining balance) and validation (wallet balance, transaction-ref
uniqueness) — exactly the rewrite Decision 3.4 avoids. `tender()` is real
infrastructure for a caller that doesn't exist yet: a future retail checkout,
or a later, deliberate migration of the bills.ts routes once there is
appetite to actually replace `applyPaymentBatch`. Its existence and test
coverage prove Part 13's retail-compatibility contract (`SaleService` →
`addItems` → bill → `PaymentService` → receipt, no table, no hospitality
import) without requiring that contract to be live in production yet.

### 3.6 ManualCardAdapter lands on `captured`, not `settled`

**Decision:** `CashAdapter` and `WalletAdapter` return `settled` from
`capture()`. `ManualCardAdapter` returns `captured`.

**Why:** this is the one sentence Part 5 asked to be architecturally
enforced, not just documented: *"Recorded in the POS database" must NOT
automatically mean "the external card payment is definitely settled."* Cash
and an internal wallet debit are fully in-process — there is no external
party whose confirmation is missing. A manually entered card payment is the
cashier attesting that a terminal accepted it; Plemmo has not independently
verified that with a provider. `captured` is the honest word for that state,
and it is a real, different value from `settled` that a future provider
adapter's callback will actually need to distinguish once it exists.

### 3.7 Refund/void live in `payment.ts`, not a separate `RefundService`

**Decision:** `voidPayment()` and `refundPayment()` are functions in
`main/core/payment.ts`, operating directly on `payments`/`refunds`. No
`RefundService` module was created.

**Why:** Part 8 explicitly frames this as a boundary for a *later* module —
"define the boundary so that later: `RefundService → InventoryService →
InventoryMovement` can be implemented cleanly" — not a request to build that
module now. A refund is intimately about a payment's state (how much of it is
still owed back), so co-locating it with `PaymentService` is the natural
scope for a foundation-only implementation. Critically, **neither function
touches `products.stock_quantity` or any other inventory state** — proven by
a test that refunds a payment and asserts stock is unchanged. That is the
actual boundary Part 8 asked for: the point where a future `RefundService`
would take over to decide whether and how stock comes back.

### 3.8 Reused `payment_idempotency`, invented nothing new

**Decision:** `tender()`, `voidPayment()`, and `refundPayment()` all accept an
optional `PaymentIdempotency` (`{ key, requestHash, userId }`) and check/store
it against the *existing* `payment_idempotency` table — the same one
`applyPaymentBatch` already uses.

**Why:** Part 7 was explicit — "use existing idempotency tables/logic rather
than inventing a second mechanism." The table's actual shape (`user_id`,
`idempotency_key` → `bill_id`, `request_hash`, `response_json`) has nothing
`applyPaymentBatch`-specific about it; it is a generic "replay a stored
response for this user+key" primitive that any payment-domain operation can
share.

### 3.9 Brand-new tables get a ULID primary key directly

**Decision:** `payments`, `payment_events`, and `refunds` use `id TEXT
PRIMARY KEY` populated with `ulid()` — not an integer autoincrement key with
a bolted-on `uid` column.

**Why:** the `uid`-beside-integer-PK pattern from migration v69 exists
specifically to avoid breaking the extensive FK/join/report/WebSocket web
already built on `orders.id`/`order_items.id`/`bills.id`. `payments` et al.
have no such legacy web — they're new in this milestone — so there's nothing
to preserve compatibility with. This is the same call Phase 1 already made
for `organizations`/`locations`/`registers`/`devices`/`audit_events`; nothing
new was invented here, the existing pattern was just applied consistently.

---

## 4. Migration strategy

One migration, v71 (`plemmo_payment_persistence`), purely additive:
`CREATE TABLE IF NOT EXISTS` for three new tables plus indexes. No existing
table, column, or row is touched. Verified against both a fresh install and
the real v1.5.0-era upgrade fixture (`tests/upgrade-path.test.ts`), and
`schema-health` reports zero drift between them.

The payment *data* migration strategy is dual-write, not cutover:

```
Phase A (this milestone):  bills.payment_details JSON  ← still the
                            source of truth. payments/payment_events
                            dual-written alongside it, unread by
                            anything.

Phase B (future, not started): a real caller starts reading from
                            payments instead of the JSON — likely
                            reporting first, since that's the lowest-
                            risk consumer.

Phase C (future, not started): applyPaymentBatch itself is deliberately
                            rewritten to write ONLY the new tables,
                            once the dual-write has run in production
                            long enough to be trusted. bills.payment_details
                            is deprecated, not dropped, until every
                            reader has moved off it.
```

No target date or trigger condition for Phase B/C is set here — that is a
product decision for whoever is running the fleet, informed by how the
dual-write behaves once real merchants are on it.

---

## 5. Known issues, deliberately left unchanged

### 5.1 The dual-write inherits the legacy 2-decimal-currency bug

`applyPaymentBatch`'s `paymentAmountCents()` computes `Math.round(parsed *
100)` unconditionally — correct for GBP/EUR/USD, wrong for JPY (0 decimals)
or KWD (3 decimals). The dual-write stores exactly what that function
computed, bug and all, because fixing it means changing
`applyPaymentBatch` — out of scope per Decision 3.4. `tender()`, which new
code should use, takes an already-correct `amountMinor` and is not affected.

### 5.2 `tender()` does no allocation

A single call to `tender()` records exactly one tender for exactly one
amount. It has no concept of "apply cash up to the remaining balance after
non-cash lines," which is core to how `applyPaymentBatch` behaves for a
multi-line request. Any future caller of `tender()` for a split payment must
either call it once per already-allocated line, or a future allocation layer
must be built above it — not assumed to exist here.

### 5.3 `tender()` does not update `bills.paid_amount`/`payment_status`

Calling `tender()` records a payment in the new model but does not touch the
`bills` row's `paid_amount`, `balance`, or `payment_status` columns — that
reconciliation is bespoke to `applyPaymentBatch` and was not reimplemented.
A bill paid *only* through `tender()` (as in the Part 13 retail-compatibility
test) will still show as `unpaid` in the legacy columns. This is the correct
boundary for a foundation-only entry point, but it means `tender()` is not
yet a drop-in replacement for the legacy payment routes.

### 5.4 Refunds do not touch inventory

By design (Decision 3.7). A refund recorded through `refundPayment()` has no
effect on `products.stock_quantity`. A caller wanting "refund and restock"
must currently orchestrate both operations itself; there is no
`RefundService` to do it atomically yet.

---

## 6. Assumptions

- `applyPaymentBatch`'s two routes (`POST /bills/:id/payment` and
  `POST /bills/:id/payments`) always pass `idempotencyUserId` from
  `req.user.userId` in practice, even though the function's signature marks
  it optional (for direct test calls). `recordAppliedPaymentLine`'s
  `actorUserId` relies on this being populated for audit attribution to be
  meaningful; if it's absent, the audit event simply has a null actor, which
  is the same graceful degradation `createSale`'s system-initiated events
  already use.
- The tenant's currency, read via `getSettingValue('currency')` with a
  fallback of `'INR'`, is assumed stable for the lifetime of a dual-written
  payment row. Changing a merchant's currency mid-operation is out of scope
  everywhere in this codebase, not just here.
- `payment_methods`-configured custom method names are passed through to
  `ManualCardAdapter` under the `manual_card` adapter id regardless of what
  the merchant named them (`'card'`, `'UPI'`, a custom name) — the adapter
  boundary is "not cash, not wallet," not a precise mapping to a future real
  provider. That mapping will need real thought when an actual provider
  adapter is built.

---

## 7. See also

- [`PLEMMO_ARCHITECTURE.md`](./PLEMMO_ARCHITECTURE.md) §3–5, §8 — the living
  reference this record feeds into
- [`PHASE_2A_SALE_FLOW.md`](./PHASE_2A_SALE_FLOW.md) — the pre-extraction
  audit of `POST /api/orders` and `POST /api/orders/:id/items`
- [`PLEMMO_DEVELOPMENT_RULES.md`](./PLEMMO_DEVELOPMENT_RULES.md) — the
  red/amber/green zones, including why `applyPaymentBatch` is red
- `main/core/sale.ts`, `main/core/payment.ts` — the code itself, commented
  in the same voice as this document
- `tests/plemmo-sale-service.test.ts`, `tests/plemmo-payment-service.test.ts`
  — the verification this record's claims are checked against
