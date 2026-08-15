# SYNC-E — Sales / Orders Synchronization

The first synchronization of MUTABLE, financially-meaningful business data:
`orders`, `order_items`, `bills`. Built as an additive layer that surrounds
the existing authoritative records with durable, versioned sync facts — no
rewrite of `SaleService`, no event sourcing, no change to local POS behaviour.

Read alongside [`SYNC_D_MULTI_ENTITY.md`](./SYNC_D_MULTI_ENTITY.md) (the
multi-entity seam this extends) and [`cloud/DEPLOYMENT.md`](../cloud/DEPLOYMENT.md).

**Status: complete.** Synchronizes order / order_item / bill only. NO
product / customer / supplier / purchase-order / transfer / refund sync; no
Admin, licensing, or payment-provider work.

---

## Current Sales Sync Audit (Part A — done before any change)

Every runtime write path for the sales tables was enumerated (not just
`SaleService`). There are ~40 mutation sites across `core/sale.ts`,
`routes/bills.ts`, `routes/index.ts`, `routes/orders.ts`, `routes/tables.ts`,
`modules/retail/checkout.ts`, `services/kds.ts`, `services/receipt.ts`.

| Record | Source of truth | Global uid | Local PK | Org / Location | Mutability | Hard-delete risk | Proposed sync behaviour |
|---|---|---|---|---|---|---|---|
| `orders` | local orders row | `orders.uid` (ULID, v69/v81) | `id` INTEGER | org+loc columns (v82) | MUTABLE (status, totals) | none — no runtime DELETE | versioned snapshot at create + item change + terminal transition |
| `order_items` | local order_items row | `order_items.uid` (ULID) | `id` INTEGER | derived from parent order | MUTABLE (status, qty via add/void) | none — void is `status`, not DELETE | versioned snapshot at create + void/cancel |
| `bills` | local bills row | `bills.uid` (ULID) | `id` INTEGER | derived from parent order | MUTABLE (totals, payment_status) | none | versioned snapshot at create + paid |

**Findings that shaped the design:**
1. `uid` is **load-bearing on every insert path** (verified: `sale.ts:578/458`,
   `bills.ts:249/355`, `index.ts:349` — SYNC-0 v81 fixed the three paths that
   once left it NULL). Identity is consistent (ULID), so no STOP on identity.
2. **No hard DELETEs** — history is preserved via `status` (`voided`,
   `cancelled`, `void_adjustment`). The 9A "never silently undo" rule already
   holds locally.
3. **Bills/order_items have no org/location columns** → derived from the parent
   order (authoritative for them), exactly as payment-events derive theirs.
4. Records are **mutable** → the append-only outbox's one-event-per-fact rule
   is wrong for them; they need multiple versioned snapshot events per uid.
5. Payments are **already synced** (SYNC-D `payment_event`); a synced sale
   links to them by `bill_uid`/`order_uid`/`payment_uid` — no payment engine
   duplication, no fake payments.

**No STOP condition was triggered:** identity is uniform, lifecycle is
well-defined, remote apply is made safe by writing to mirror tables (never the
authoritative records), inventory/payments are separate synced facts (no
double-count), missing parents are durably staged, and no `SaleService`
behaviour is rewritten.

---

## Part B — Sales sync model

Not event sourcing. The authoritative records stay `orders`/`order_items`/
`bills`. Each emits **versioned business-fact SNAPSHOTS** at lifecycle
boundaries:

- **Business identity** = the row `uid` (ULID). **Sync-event identity** = a
  fresh `event_uid` per snapshot. The two are distinct (a mutable entity has
  one uid but many snapshot events).
- **Immutable in a snapshot:** the uid and its create time. **Mutable:**
  status, totals, payment_status. **snapshot_version** is a per-entity
  monotonic counter (not identity, not a timestamp).
- **Conflict** = two DIFFERENT devices producing snapshots of the same uid.
  Handled by DETECT-AND-RECORD, never last-write-wins merge of financial data.
- **Server rejection** is possible (org/location/identity mismatch, malformed).
- **Compensation** is represented by durable conflict records for later review.

---

## Part C — Identity

`order_uid`, `order_item_uid`, `bill_uid` are ULIDs present on every insert
path. Children link to parents by global uid: an `order_item` carries
`order_uid`; a `bill` carries `order_uid`; payments already carry
`bill_uid`/`order_uid` (SYNC-0). Local integer FKs are untouched. Emitters
refuse to emit an unkeyable fact (a row with no uid / no parent uid returns
null rather than producing a bad event).

## Part D — Entity relationships & missing parents

`Order → OrderItems, Bill(s) → Payments`. Remote apply writes into FK-free
mirror tables, so a child that arrives before its parent is **durably staged**
in its mirror and reconciles when the parent arrives — no silent loss, no
ordering assumption, retry- and reorder-safe (test §7).

## Part E — Order create sync

`createSale` emits the order snapshot + one snapshot per line INSIDE the sale
transaction, after the authoritative rows are final. The emit is **atomic, not
best-effort**: a real outbox-write failure propagates and rolls the whole sale
back (Part T) — a financial record and its sync fact never disagree. Test §1
(both rows + events exist) and §10 (rollback removes both).

## Part F — Order item sync

Snapshots at create (`createSale`) and add-item (`addSaleItems`), and — via the
same helper — at void/cancel status changes. Voids are already `status`
transitions (and `void_adjustment` counter-lines), never deletes, so they sync
as ordinary snapshots. Existing hospitality/retail item behaviour is unchanged.

## Part G — Bill synchronization

Snapshots at bill create (`bills.ts` generate + split) and at payment-status
change (`applyPaymentBatch`). **Authoritative facts** synced: totals, tax,
discount, `payment_status`, `paid_amount`, `balance` (as the local projection
at snapshot time). **NOT** synced as a source of truth: `bills.payment_details`
(the compatibility JSON) — payments remain their own synced fact (SYNC-0 /
Payment Cutover preserved).

## Part H — Payment linkage

Payment events are synced by SYNC-D and are NOT duplicated here. A bill
snapshot references its order via `order_uid`; payments reference
`bill_uid`/`order_uid`/`payment_uid`. Payment-before-order and
order-before-payment are both fine: each is an independent fact in the one
per-org feed, joined by uid on read; a missing side is staged, never faked.

## Part I — Conflict model (most important)

Multiple devices can snapshot the same entity. The cloud keeps a current-
version projection (`cloud_entity_versions`) per (org, entity_type, entity_uid)
and, when a snapshot arrives from a DIFFERENT device than the current one,
records a durable `cloud_conflicts` row (`concurrent_update`, status `open`).
**Every snapshot event is preserved in `cloud_events`; nothing is deleted or
overwritten.** The projection pointer moves to the higher snapshot_version as a
read-model hint only — the conflict record is the truth. This is deliberately
**conservative** (it may flag a benign sequential hand-off), which is the safe
direction: over-reporting a conflict never loses data; under-reporting could.
High-risk financial conflicts are never auto-resolved. Test §8.

## Part J — Order lifecycle

Actual states: `pending` / (KDS: cooking/ready/served) / `completed` /
`cancelled`. Snapshots are emitted at create and at the terminal transitions
(`completed` via bill-paid, `cancelled`). All transitions are SYNCABLE as
snapshots; a locally completed order is IMMUTABLE to sync (remote snapshots
land in mirrors, never the authoritative row) — so a completed sale can never
be undone by another device.

## Part K — Hospitality (unchanged)

Table association, waiter (`user_id`), KOT/KDS, addons, modifiers, discounts,
and bill workflow are untouched. Table occupancy is operational state and is
NOT synced as the financial sale. The order snapshot carries `table_id` and
`channel` as facts; the hospitality hooks still run exactly as before.

## Part L — Retail (unchanged)

Variant, SKU/barcode, quantity, unit cost, cash/card tender, receipts, customer
association are preserved. The sale is the business transaction; the inventory
movement is the inventory fact (synced separately, SYNC-D); the payment event
is the payment fact (SYNC-D). SYNC-E links them by uid without duplicating any.

## Part M — Inventory relationship

Local behaviour UNCHANGED: insufficient tracked stock still rejects the sale
(test §11), no negative local stock. A local sale still produces exactly one
inventory movement (its own synced fact). A remote sale snapshot is applied
into the mirror ONLY — it never calls local checkout, never decrements stock,
never creates a second movement. No double inventory, no sync loop.

## Part N — Payload

Typed snapshots (`OrderEventPayload` / `OrderItemEventPayload` /
`BillEventPayload`) carry the authoritative facts + `snapshot_version` +
lineage (`device_id`). Deliberately excluded: local integer ids,
`stock_quantity`, `bills.payment_details`, derived report fields, secrets.

## Part O — Outbox generalization

The SYNC-D generic outbox/registry is extended, not duplicated: same
`event_uid`/`entity_uid`/`entity_type`/`sequence`/`payload`/`schema_version`.
Mutable snapshots use `appendSnapshotOutboxEvent` (a fresh event each time);
the outbox unique index is scoped (migration v88) to append-only entities so
mutable entities can hold many events. All six entity types
(inventory_movement, audit_event, payment_event, order, order_item, bill) share
one pipeline.

## Part P — Cloud schema

`cloud_events` (relaxed uniqueness — partial index on append-only types),
`cloud_entity_versions` (current-version projection), `cloud_conflicts`
(durable conflict log). PG migration `0002_sales.sql`. Idempotency: append-only
by (entity_type, entity_uid); mutable by `event_uid`.

## Part Q — Remote apply

`applyRemoteEvent` dispatches order/order_item/bill into
`remote_orders`/`remote_order_items`/`remote_bills` (migration v88, FK-free),
upserting the highest snapshot_version. It NEVER touches authoritative
orders/order_items/bills, never invokes checkout/payment/inventory, and never
appends an outbox event (loop prevention). Transactional; missing parents
stage in their mirror.

## Part R — Conflict / compensation storage

`cloud_conflicts`: conflict_uid, org/location, entity_type, entity_uid, local/
remote event uids, device ids, conflict_type, detected_at, status
(open/acknowledged/resolved), resolution. `listConflicts(org)` exposes it for a
future Admin. No auto-resolution of financial conflicts; no UI.

## Part S / Cross-device — Tests

`tests/sync-e-sales.test.ts` — 34 checks against REAL PostgreSQL + REAL HTTP:
identity, upload, versioned re-snapshot + idempotency, pull → mirror apply +
loop prevention, stale-snapshot handling, missing-parent staging + recovery,
cross-device conflict detection + preservation (no silent undo), security
spoofs, and atomicity (business rollback on outbox failure). Self-skips without
PG.

## Part T — Transactional atomicity

Sales emit inside the sale's `withTxn`; an outbox failure rolls the sale back
(test §10). A committed sale whose later cloud upload fails stays locally valid
and retryable (SYNC-A/B semantics). No split transactions.

## Migrations

Local additive v88: relax `idx_sync_outbox_entity` to append-only types + add
`remote_orders`/`remote_order_items`/`remote_bills`. Cloud additive
`0002_sales.sql`. No existing data touched; verified by schema-health +
upgrade-path.

## Known limitations

1. Sync entities: order/order_item/bill only (+ SYNC-A–D entities).
2. Snapshots are emitted at the wired lifecycle points (create, add-item,
   bill create, bill paid, order terminal); other fine-grained mutations
   propagate at the next snapshot boundary rather than per keystroke.
3. Conflict detection is conservative (cross-device divergence), not a full
   three-way merge; resolution is status-only (no UI, no auto-resolve).
4. Remote sales live in mirror tables (a local read model / staging); a
   consolidated authoritative-vs-remote reconciliation view is future Admin.
5. Production cloud remains un-deployed (no hosted credentials — SYNC-D);
   proven on real local PostgreSQL.

## Recommended next bundled milestone

**SYNC-F — Conflict resolution + Admin sales console APIs:** operator-facing
APIs to review/resolve conflicts and reconcile mirror vs authoritative, richer
lifecycle-transition emission, and the read APIs a Plemmo Admin will consume —
before extending sync to the remaining catalog domains (products/customers/
suppliers).
