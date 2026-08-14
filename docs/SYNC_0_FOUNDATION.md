# SYNC-0 — Foundation Repair

Design and implementation record for the foundation repairs that must land
before any offline sync engine is built. **SYNC-0 is not the sync engine** —
no outbox/inbox, no cloud, no upload/download, no cursor, no device
enrollment flow. It repairs the local architecture so those can be built
safely later.

Read alongside [`MILESTONE_9A_SYNC_REVIEW.md`](./MILESTONE_9A_SYNC_REVIEW.md)
(the review that identified these repairs),
[`MILESTONE_9_SYNC_ARCHITECTURE.md`](./MILESTONE_9_SYNC_ARCHITECTURE.md) (the
original design), and [`SYNC_0_PAYMENT_MIGRATION.md`](./SYNC_0_PAYMENT_MIGRATION.md)
(Part A in detail).

**Status: complete.** Everything described as built is built and tested.

---

## Decisions locked for this milestone

Recorded here so future work does not re-litigate them:

1. **Inventory / offline sales — unchanged.** A tracked product with
   insufficient stock still rejects the local sale (`SaleService`/
   `InventoryService` untouched). SYNC-0 does not weaken this. Future cloud
   behavior may *detect* a cross-till deficit after sync; that is not built
   here (see § Future sync concerns).
2. **Sale data model — unchanged.** `orders`/`order_items`/`bills` stay the
   authoritative local records. No event sourcing. The future sync layer
   wraps these with an outbox, it does not replace them.
3. **Cross-location transfers — foundation only.** The data model is
   prepared for a future explicit `DRAFT → SHIPPED → RECEIVED | CANCELLED`
   flow (child-row tombstones make line edits sync-representable; movements
   already carry the identity a two-phase flow needs). The current
   single-database atomic transfer behavior is unchanged locally. The
   offline two-phase flow itself is not built.
4. **Rejected-after-local-completion — never silently undone.** No SYNC-0
   change deletes, reverses, or rewrites a completed sale/refund/receipt.
   (The conflict UI is a later milestone.)
5. **Device authentication — domain foundation only.** A `device_credentials`
   table stores the public credential + lifecycle metadata. The private key
   is generated on-device and OS-protected, never in the database. No
   enrollment UX, no cloud auth.
6. **Sync transaction boundary — established as a hard rule.** The future
   outbox insert must occur inside the same SQLite transaction as the
   business write. SYNC-0 does not create the outbox, but every write path
   it touches already runs inside a single `withTxn()` — the seam is ready.

---

## Part A — Payment authority (see SYNC_0_PAYMENT_MIGRATION.md)

`payments`/`payment_events` is now the authoritative, complete payment
model. The hospitality dual-write (`recordAppliedPaymentLine`) no longer
swallows errors — a payment lands in both the legacy and new models
atomically or in neither. Legacy `payment_details` is backfilled (migration
v80) and retained as a compatibility bridge. `payments`/`refunds` gained
`bill_uid`/`order_uid` global references. Full detail, entry-point audit,
and migration strategy in [`SYNC_0_PAYMENT_MIGRATION.md`](./SYNC_0_PAYMENT_MIGRATION.md).

---

## Part B — Load-bearing UIDs

`orders`/`order_items`/`bills` carry a ULID `uid` beside their integer PK
(migration v69). The audit found **three insert paths that created rows with
a NULL uid**, so the column was not yet reliable:

| Path | File | Fix |
|---|---|---|
| `POST /bills/generate` | `main/routes/bills.ts` | now inserts `uid = ulid()` |
| Split-check bill creation | `main/routes/bills.ts` | now inserts `uid = ulid()` |
| Void-adjustment order_item | `main/routes/index.ts` | now inserts `uid = ulid()` |

Migration **v81** (`sync_0_load_bearing_uids`) backfills any NULL uid those
paths already produced on existing installs, seeding each ULID from the
row's own `created_at` so it sorts historically (the v69 approach). The v69
partial unique indexes still guard against duplicates. Integer PKs are kept;
no JOIN is rewritten (Part B2's "smallest safe global-identity layer").

---

## Part C — Tombstones

The two hard `DELETE`s on sync-relevant child rows are replaced with a
`deleted_at` tombstone (migration **v82**, `sync_0_child_row_tombstones`):

| Operation | File | Before | After |
|---|---|---|---|
| Draft PO line removal | `main/modules/purchasing/purchase-orders.ts` `removeItem` | `DELETE` | `UPDATE … SET deleted_at` |
| Draft transfer line removal | `main/core/transfers.ts` `removeTransferItem` | `DELETE` | `UPDATE … SET deleted_at` |

Every **active** query filters `deleted_at IS NULL`: PO totals
recalculation, PO item listing, `markOrdered`'s item count, `updateItem`'s
lookup, receiving's completion check, the outstanding-quantity report, the
transfer completion item read, the transfer item listing, and the
location transfer report. Current draft-editing behavior is therefore
unchanged (a removed line is absent from every active operation), while the
removal is retained as a durable fact a future sync engine can propagate.

---

## Part D — Organization / location identity

Audit result per table (Part D: "audit rather than assume"):

| Table | org/location stamped going forward? | Backfill needed? |
|---|---|---|
| `orders`, `payments` | Yes (v76, context) | No |
| `purchase_orders`, `stock_transfers` | Yes (on insert, from context) | Defensive backfill of any NULL (v83) |
| `audit_events` | Yes (context, `audit.ts`) | No |
| `inventory_movements` | **No — `organization_id` was never written** | **Yes** |
| `inventory_balances` | location only | No — see below |

`InventoryService.recordMovement` now stamps `organization_id`, resolved
from the movement's own location (`locations.organization_id` — a real
foreign key, not a guess), falling back to the install's organization.
Migration **v83** (`sync_0_sync_identity_backfill`) backfills existing
movements from the same location join, and defensively backfills any
unstamped `purchase_orders`/`stock_transfers`.

`inventory_balances` deliberately gets **no** organization column
(Part D1): it is a DERIVED projection keyed by `(product, variant,
location)`, never itself a sync fact; its organization is always resolvable
via the location, and adding a column would risk a second, divergent
balance key.

**`products.stock_quantity` is a compatibility mirror, not a sync
primitive** (Part D1 / 9A Review Issue 8) — a future sync engine syncs stock
via `inventory_movements`, never by treating `stock_quantity` as an
independent fact. No code change was needed for this; it is a design
constraint recorded here and in the architecture doc.

---

## Part E — Device credential foundation

Migration **v84** (`sync_0_device_credentials`) creates `device_credentials`:
`credential_type` (`device_keypair` | `rotatable_bearer`), `public_key`,
`credential_identifier`, `status` (`pending`/`active`/`rotated`/`revoked`),
and `issued_at`/`expires_at`/`rotated_at`/`revoked_at` lifecycle timestamps.
`main/core/device-credentials.ts` is the thin domain module
(record/getActive/list/revoke, with rotation).

**The table has no column that could hold a private key** — asserted by
test. The private key is generated on-device and kept in OS-protected
storage (Windows DPAPI / macOS Keychain), never persisted here. No
enrollment flow, cloud, or auth middleware is built (Part E / Part J). This
prepares for the rotatable-bearer-now, asymmetric-later model from 9A
Review Issue 4.

---

## Migrations (Part H)

All additive, all guarded, all idempotent; each preserves existing data and
supports both fresh install and legacy upgrade:

| Version | Name | What |
|---|---|---|
| v80 | `sync_0_payment_foundation` | `payments`/`refunds` uid columns + backfill; legacy `payment_details` → `payments`/`payment_events` backfill |
| v81 | `sync_0_load_bearing_uids` | backfill NULL uids on `orders`/`order_items`/`bills` |
| v82 | `sync_0_child_row_tombstones` | `deleted_at` on `purchase_order_items`/`stock_transfer_items` |
| v83 | `sync_0_sync_identity_backfill` | `inventory_movements.organization_id` + PO/transfer org/location backfill |
| v84 | `sync_0_device_credentials` | `device_credentials` table |

Verified fresh (`tests/schema-health.test.ts` — zero drift between a
migrated legacy install and a fresh one) and against the real v1.5.0
fixture (`tests/upgrade-path.test.ts`, extended with the payment backfill
assertions).

---

## Tests (Part G)

- `tests/sync-0-foundation.test.ts` (45 checks): authoritative hospitality
  + retail payments, payment_events, atomic-rollback invariant, refund uid
  references, load-bearing uids on every insert path, duplicate-uid
  rejection, PO/transfer tombstones + active-query exclusion, inventory
  organization stamping, no duplicate balances, and the device-credential
  domain (persistence, rotation, revocation, no private key column).
- `tests/plemmo-payment-service.test.ts §16` updated: proves the dual-write
  is now authoritative (payment fails atomically when the payments model is
  unavailable), replacing the old assertion of the swallow behavior.
- `tests/upgrade-path.test.ts` extended: the real fixture's legacy UPI
  `payment_details` is reconstructed into the authoritative model.
- Full regression: hospitality, retail, inventory, purchasing,
  multi-location, payments, authorization suites all green; local inventory
  policy (reject oversell) unchanged.

---

## Future sync concerns (documented, not built)

- **Cross-till inventory deficit.** Independent offline tills can each make
  a locally-valid sale from stale stock; the cloud may later sum them below
  zero. SYNC-0 changes nothing about local enforcement (each till still
  hard-rejects locally). The cloud-side deficit *detection* and
  reconciliation flag are a future milestone (9A Review Issue 1).
- **Two-phase transfers.** The tombstone + movement-identity work makes the
  future `DRAFT → SHIPPED → RECEIVED` flow representable without rewriting
  transfers; the flow itself is not built.
- **Payment_details retirement.** Deferred until the receipt printer and
  legacy reports migrate onto `payments`.

---

## Remaining prerequisites before SYNC-A

1. Migrate the `payment_details` readers (`thermal.ts`, `reports.ts`,
   `payment-methods.ts`) onto `payments`, then retire `payment_details`.
2. Design the `sync_outbox`/`sync_inbox`/`sync_state` tables (SYNC-A) — the
   transaction-boundary seam is ready (Decision 6).
3. Nothing in SYNC-0 blocks starting SYNC-A on `inventory_movements` (the
   recommended pilot entity): it is append-only, now organization-stamped,
   and free of the payment dual-write's history.

---

## See also

- [`SYNC_0_PAYMENT_MIGRATION.md`](./SYNC_0_PAYMENT_MIGRATION.md) — Part A in full
- [`MILESTONE_9A_SYNC_REVIEW.md`](./MILESTONE_9A_SYNC_REVIEW.md) — the review these repairs implement
- `main/core/payment.ts`, `main/core/inventory.ts`,
  `main/core/device-credentials.ts`, `main/db.ts` (migrations v80–v84) — the code
- `tests/sync-0-foundation.test.ts`, `tests/upgrade-path.test.ts` — the verification
