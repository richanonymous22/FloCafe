# SYNC-A — Local Sync Foundation

The first sync implementation milestone, intentionally limited to the
**local** mechanism: a durable outbox that captures one business fact
(inventory movements) atomically with the write that produces it, a
per-device sequence, a mock transport proving upload/ack/retry/recovery,
and the inbox/sync_state foundations. **No cloud, no network, no provider,
no device enrollment, no other entity is synchronized.**

Read alongside [`MILESTONE_9_SYNC_ARCHITECTURE.md`](./MILESTONE_9_SYNC_ARCHITECTURE.md)
(the design), [`MILESTONE_9A_SYNC_REVIEW.md`](./MILESTONE_9A_SYNC_REVIEW.md)
(the review), and [`SYNC_0_FOUNDATION.md`](./SYNC_0_FOUNDATION.md) /
[`PAYMENT_CUTOVER.md`](./PAYMENT_CUTOVER.md) (the prerequisites).

**Status: complete.**

---

## Part A — inventory write-path audit

There are exactly **two** `INSERT INTO inventory_movements` statements in
the codebase, and only one is a runtime path:

| Site | Kind | Reaches the outbox? |
|---|---|---|
| `main/core/inventory.ts` `recordMovement()` | **The single runtime chokepoint.** All five public entry points funnel through it. | **Yes** — the outbox append is wired here |
| `main/db.ts` migration v73 (opening-balance backfill) | One-time historical migration, raw SQL, not a runtime path | No — see below |
| `main/db.ts` migration v77 (`INSERT INTO inventory_movements_v2 SELECT *`) | Schema table-rebuild copy, not a business write | No |

Every runtime movement is created by `recordMovement()`, called by these
five entry points, each already inside its own `withTxn()`:

| Entry point | Movement type(s) | Caller | Reference type / uid | Actor | Immutable after commit? |
|---|---|---|---|---|---|
| `recordSale()` | `sale` | `SaleService.persistSaleLine` (`sale.ts`) | `order_item` / the sold line's uid | cashier | Yes |
| `recordReturn()` | `return` | `refundPayment()` (`payment.ts`) | `payment_refund` / the refund's id | actor of the refund | Yes |
| `adjustStock()` | `adjustment` (or a caller-supplied type) | `POST /api/inventory/adjust` | `manual` | authenticated user | Yes |
| `recordReceipt()` | `receipt` | `ReceivingService.receiveGoods` | `purchase_order_item` / the PO line | receiver | Yes |
| `recordTransfer()` | `transfer_out` / `transfer_in` | `TransferService.completeTransfer` | `stock_transfer` / the transfer id | actor of the transfer | Yes |

All movements share: ULID `id` (the business fact identity),
`organization_id` (stamped in SYNC-0), `location_id`, `quantity_delta`,
`unit_cost` where relevant, `created_at`, and are append-only/immutable
once committed — the ideal first sync entity (append-only, ULID identity,
no mutable state machine, derived balance).

**Migration-created `opening` movements are deliberately not captured.**
They are written by raw SQL in migration v73, not through `recordMovement`,
and represent pre-existing stock that predates the outbox entirely — a
future initial-sync/bootstrap concern, not an outbox event. Documented
rather than forced through the runtime path.

---

## Part B — outbox schema

`sync_outbox` (migration v86). Designed against the actual SQLite
environment, not copied blindly from the M9 doc:

```
uid              TEXT PRIMARY KEY      -- the sync EVENT's own ULID identity
device_id        TEXT NOT NULL         -- attribution, resolved server-side
sequence         INTEGER NOT NULL      -- per-device monotonic counter (Part G)
entity_type      TEXT NOT NULL         -- 'inventory_movement'
entity_uid       TEXT NOT NULL         -- the BUSINESS FACT's uid (Part H)
operation        TEXT ('create'|'update'|'append')
payload          TEXT NOT NULL         -- JSON typed event (Part F)
organization_id  TEXT                  -- routing context
location_id      TEXT
status           TEXT ('pending'|'uploading'|'acked'|'failed')
attempt_count    INTEGER
last_attempt_at  TEXT
last_error       TEXT
created_at       TEXT NOT NULL
acked_at         TEXT
```

Indexes:
- `UNIQUE(device_id, sequence)` — enforces per-device sequence uniqueness.
- `UNIQUE(entity_type, entity_uid)` — the **idempotency guard**: one event
  per business fact (Part H).
- `(device_id, status, sequence)` — serves the future worker's core query,
  "next N pending for this device, in order" (Part N).

---

## Part C — sync_state

`sync_state`, keyed by `device_id` (one row per device — a normal install
has exactly one). Keying by device serves double duty: restart recovery
bookkeeping **and** the naturally-independent per-device sequence counter,
without a separate table.

```
device_id, device_sequence, last_uploaded_sequence, last_upload_at,
last_download_cursor, last_download_at, failure_count, last_error,
last_error_at, protocol_version, created_at, updated_at
```

Seeded for the current device at migration time (best-effort from the
device pointer) and created lazily on first outbox append otherwise, so a
restart always knows exactly where it was.

---

## Part D — inbox foundation

`sync_inbox` establishes the durable local shape for future cloud→local
events. **Not functional for download in SYNC-A** — it is storage only:

```
uid (cloud-assigned event id / download idempotency key), entity_type,
entity_uid, operation, payload, cursor, status
('pending'|'applied'|'skipped'|'failed'), received_at, applied_at, last_error
```

Crash-safe by construction (durable rows with an explicit status), so a
future apply loop can resume mid-batch.

---

## Part E — sequence model

A per-device monotonic counter in `sync_state.device_sequence`, allocated
by `allocateSequence()` inside the caller's transaction via an upsert
(`ON CONFLICT DO UPDATE SET device_sequence = device_sequence + 1`). Because
better-sqlite3 is synchronous and single-threaded, the read-modify-write
cannot interleave — no lock needed. The counter never decreases, so pruning
acked rows later can never reissue a sequence. No global ordering is
attempted (Part G) — the sequence exists for upload ordering, gap
detection, recovery, and debugging, per device.

---

## Part F — inventory payload

`InventoryMovementEventPayload` (`main/core/sync/types.ts`) — the typed
business fact, not a blind row serialization:

```
schema_version: 1, movement_uid, organization_id, location_id, product_id,
product_variant_id, quantity_delta, movement_type, reason, reference_type,
reference_id, unit_cost, actor_user_id, metadata, created_at
```

**Deliberately excluded:** `balance_after` (a DERIVED projection — never an
authoritative sync fact), `products.stock_quantity` (a compatibility
mirror), any local integer row id (movements are ULID-keyed, so there are
none), and any device-local setting. `metadata` **is** included (parsed) —
it is genuine business data already on the movement (e.g. a return's
sold-line link), not derived or device-local; excluding it would lose real
information (the SYNC-0 doc's guidance: don't invent, but don't drop what's
already there).

---

## Part G — transaction boundary (the central proof)

`recordMovement()` now does, in one transaction:

```
withTxn(() => {              // opened by the caller (recordSale/adjustStock/…)
  1. validate                // (unchanged)
  2. applyBalanceDelta       // update inventory_balances  (unchanged)
  3. INSERT inventory_movements                            (unchanged)
  4. appendInventoryMovementEvent → INSERT sync_outbox     (NEW)
})
```

Because `recordMovement` receives the caller's `db` and better-sqlite3
nests transactions as SAVEPOINTs, the outbox insert joins the same atomic
unit as the movement, its balance update, and — when the movement is part
of a larger business operation (a sale, a transfer completion) — that whole
operation. **If any step fails, all roll back**: a movement can never
commit while its sync event is missing, and an outbox-append failure rolls
the movement back too. No network request is ever made in this path — the
POS stays local-first. Both directions are proven by test (a forced
rollback removes the event; a broken outbox table rolls the movement back).

---

## Part H — mock transport & idempotency

`SyncTransport` (`types.ts`) is the seam a future HTTP client implements;
in SYNC-A only a **test-only mock** exists (`tests/sync-a-local-foundation.test.ts`).
`uploadPendingBatch()` (`main/core/sync/uploader.ts`) is the explicit
upload flow — **no background worker** (Part J): recover stalled uploads →
read next pending batch in sequence order → mark uploading → hand to
transport → mark acked/failed, advancing `last_uploaded_sequence`.

**Two identities, kept distinct (Part H):**
- `entity_uid` = the business fact's uid (`inventory_movements.id`) — the
  **local** idempotency key: `UNIQUE(entity_type, entity_uid)` guarantees
  one outbox event per movement, and `appendOutboxEvent` returns the
  existing event (without burning a sequence) if asked to append a
  duplicate.
- `uid` = the sync event's own ULID — the key a future **cloud** dedupes
  uploads on; the mock cloud replays an ack for a uid it has already seen
  without duplicating.

---

## Part I / J — retry & recovery

Statuses: `pending → uploading → acked | failed`. A transient transport
error returns the whole batch to `pending` (nothing confirmed, nothing
lost) and increments `sync_state.failure_count`. A permanent rejection
marks the specific event `failed` (not retried forever). A crash
mid-upload leaves events `uploading`; `recoverStalledUploads()` (called at
the start of every `uploadPendingBatch`, and directly testable) resets them
to `pending`. All state is durable in SQLite, so a restart resumes exactly
where it left off. No autonomous loop is introduced.

---

## Part K — inbox crash-safety / download boundary (documented, not built)

Download is **not** implemented in SYNC-A. The intended boundary, enforced
when it is built: **`{ insert the inbox batch; advance
sync_state.last_download_cursor }` must occur in ONE transaction**, with
apply as a **separate** transaction per inbox row (idempotent via
`sync_inbox.uid`). Advancing the cursor in a different transaction from the
inbox insert could lose events — this is the hard rule from the 9A review
(Cursor/Inbox), recorded here so the future download implementation honors
it. The `sync_inbox.cursor` column already exists to carry it.

---

## Part L — tests

`tests/sync-a-local-foundation.test.ts` — 52 checks: movement still
succeeds and balance still updates; exactly one correctly-typed outbox
event with a distinct event uid, device identity, and sequence; payload
correctness including the deliberate exclusions; movement+event atomicity
in **both** directions (rollback removes the event; outbox failure rolls
the movement back); deterministic and per-device-independent sequences;
duplicate-event/sequence-burn protection; pending-batch read; mock
upload/ack; retry after transient failure; permanent rejection; crash
restart recovery; inbox durability; sync_state persistence; server-side
device resolution; no credential in any payload.

Wired into the main chain as `test:sync-a-local-foundation`.

---

## Migrations (Part M)

Migration **v86** (`sync_a_local_foundation`) — additive: three new tables
(`sync_outbox`, `sync_inbox`, `sync_state`) and their indexes, plus a
best-effort seed of the current device's `sync_state` row. No existing
table or data is touched. Verified fresh (`schema-health` — zero drift) and
against the real v1.5.0 fixture (`upgrade-path`). No prior migration is
modified.

---

## Known limitations

1. Only `inventory_movements` is synchronized (by design). No sale,
   payment, product, customer, or employee sync.
2. Download is storage-foundation only — the inbox exists but no cloud
   sends to it and no apply loop consumes it yet.
3. The transport is a test-only mock; no real cloud, HTTP, auth, or
   enrollment exists.
4. Migration-created `opening` movements (v73) have no outbox event —
   historical bootstrap, out of scope.
5. No background worker — uploads are explicit calls. A future SYNC-B/worker
   milestone adds scheduling/backoff on top of this foundation.

---

## Remaining SYNC-B work

1. Define the provider-neutral cloud API contract (`/sync/upload`,
   `/sync/pull`, `/sync/ack`) and a real HTTP `SyncTransport`.
2. Device authentication/enrollment (the `device_credentials` foundation
   from SYNC-0 + the rotatable-bearer model from the 9A review).
3. The download/inbox apply loop honoring the § K transaction boundary.
4. A background sync worker with backoff/rate-limiting.
5. Extend `entity_type` coverage entity by entity (audit events next —
   near-zero-change — then payment events, then sales), each reusing this
   same outbox seam.

---

## See also

- `main/core/sync/*` (`types.ts`, `outbox.ts`, `inventory-events.ts`,
  `uploader.ts`) and `main/core/inventory.ts` (`recordMovement`) — the code
- `main/db.ts` migration v86 — the schema
- `tests/sync-a-local-foundation.test.ts` — the verification
- [`MILESTONE_9A_SYNC_REVIEW.md`](./MILESTONE_9A_SYNC_REVIEW.md) — the review whose decisions this foundation implements
