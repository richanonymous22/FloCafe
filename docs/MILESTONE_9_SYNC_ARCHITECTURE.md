# Milestone 9 — Offline Sync Architecture Design

**Status: design only. No production code, migrations, or dependencies were
added for this milestone.** Every schema shown below is a proposal for a
future milestone to build, not something that exists in the repository
today. Everything in this document was checked against the actual current
schema (`main/db.ts`) and Core services (`main/core/*.ts`) as they exist
after Milestone 8 — this is not a green-field sync design, it is a design
grounded in, and honest about, what's already built.

Read alongside [`PLEMMO_ARCHITECTURE.md`](./PLEMMO_ARCHITECTURE.md) and
milestones 2, 4, 5, 6, 7, and 8, which built the foundations this design
builds on.

---

## 1. Executive summary

Plemmo already has almost everything a sync engine needs to consume, and
almost nothing a sync engine needs to transmit:

- **The good news.** Every transactional write path (`SaleService`,
  `PaymentService`, `InventoryService`, `TransferService`,
  `PurchaseOrderService`/`ReceivingService`) already resolves organization/
  location/register/device identity server-side from device context, never
  from client input (Milestones 6–8 built this specifically). Every new
  Core table uses ULID primary keys, collision-safe across devices with no
  coordination. `inventory_movements` and `payment_events` are already
  append-only ledgers — the exact shape a sync primitive needs. A local
  idempotency pattern (`payment_idempotency_scoped`/`order_idempotency_scoped`,
  keyed on `(user_id, idempotency_key)`, replaying a cached response on
  retry) already exists and is the direct ancestor of the cloud-side
  idempotency design in §7.
- **The gap.** Nothing in the app today produces a *durable, ordered record
  of what changed* for another party to consume. `orders`/`order_items`/
  `bills` still key on legacy `INTEGER AUTOINCREMENT` primary keys (a ULID
  `uid` was bolted on beside them in migration v69 for exactly this future
  need, but no code populates or reads it as a sync identity yet).
  `payments.bill_id`/`order_id` reference those local integers, not the
  `uid`s. The real, merchant-visible payment record for most bills is still
  `bills.payment_details`, an opaque JSON blob written by the legacy
  `applyPaymentBatch()` path — not a decomposable, idempotent, orderable
  fact. And a handful of child-row deletes (`removeTransferItem`,
  `removeItem` on purchase order lines) are real `DELETE`s, not tombstones.
- **There is also a false friend already in the codebase.** `main/services/
  cloud-sync.ts` and its `cloud_sync_outbox` table are a *pre-existing,
  unrelated* outbound bridge to FloCafe's original vendor backend
  ("Blue"/FloAdmin, `blue.flopos.com`) for order-snapshot reporting and
  remote support commands — switched off by default for Plemmo since
  migration v67 (`plemmo_disconnect_upstream_services`). It is not
  Plemmo's own merchant-data sync engine, must not be confused with it,
  and this document recommends the new sync engine use deliberately
  distinct names (`main/core/sync.ts`, `sync_outbox`, not
  `cloud_sync_outbox`) to avoid the collision. See §22 and the risk
  register (§26, R-1).

None of this is a reason to distrust the architecture — it is a reason to
sequence the work correctly. §Q1–Q12 answer directly whether the
foundation is suitable; the short version is **yes, with two specific
things fixed first** (§Q3): the payment dual-write, and the integer-PK/uid
seam on orders/order_items/bills. Everything else — the organization
hierarchy, the movement-based inventory model, the idempotency pattern, the
device/location/register context model, the append-only audit log — is
already shaped the way a sync engine needs it to be.

The chosen architecture (§4) is an **outbox/inbox model with per-entity
sequence numbers and a cursor-based pull**, matching the pattern the
milestone brief itself sketched, chosen over CDC (SQLite has no native
logical replication; simulating it with triggers is fragile and couples
the sync engine to every table's shape) and over timestamp polling (clock
skew across devices, no way to guarantee a row wasn't missed at a boundary,
no natural place to hang idempotency). The outbox is the same pattern
`main/services/cloud-sync.ts` already uses for its own (unrelated) purpose
— proof this pattern is one the codebase, and Electron/SQLite generally,
handles well.

---

## 2. Entity classification table

Classification legend: **LOCAL_ONLY**, **CLOUD_ONLY**, **SYNCED**,
**LOCAL_CACHE_OF_CLOUD**, **APPEND_ONLY_SYNCED**, **STATEFUL_SYNCED**,
**DERIVED**.

A pattern recurs throughout this table and is worth naming once: wherever
Plemmo already separates an **immutable ledger** from a **maintained
projection** (`inventory_movements` → `inventory_balances`,
`payment_events` → `payments`), the ledger is the sync primitive
(`APPEND_ONLY_SYNCED`) and the projection is `DERIVED` — recomputed
locally and, independently, recomputed by the cloud from the same
ledger events. Nothing that is `DERIVED` should ever be synced as a row
in its own right. §10–14 apply this pattern to entities that don't have
it yet (sales, refunds) and explain why.

| Entity | Classification | Local source of truth | Cloud source of truth |
|---|---|---|---|
| `organizations` | LOCAL_CACHE_OF_CLOUD | Seeded locally today (no cloud exists yet) | **Cloud, once it exists.** An organization is a billing/licensing identity; the cloud must own creation and renaming. Local caches a read-only copy. |
| `locations` | SYNCED | Can be created offline (a merchant opening a new site before the till there ever talks to the cloud) | Cloud is the merge point once more than one till can create locations; see §9 conflict policy |
| `registers` | SYNCED | Same reasoning as locations | Cloud is the merge point |
| `devices` | SYNCED (metadata) + CLOUD_ONLY (auth credential) | Device row (name, platform, app_version, last_seen_at) | **Cloud is authoritative for device *identity/authentication*** — enrollment, secret issuance, revocation (`status`). See §17. |
| `employees` (`users`) | SYNCED (profile) + LOCAL_ONLY (credential material) | **Password/PIN hashes are local-authoritative, always** — a till must authenticate staff with zero connectivity | Cloud syncs profile fields (name, role, is_active, category assignments) for cross-location staff visibility; never receives or sets password/PIN hashes over sync |
| `roles` | LOCAL_ONLY (code-defined) | `Role` union in `main/core/authorization.ts`, fixed by app version | N/A — not merchant data, ships with the binary |
| `permissions` | LOCAL_ONLY (code-defined) | `ROLE_PERMISSIONS` static table | N/A — same reasoning |
| `feature entitlements` (`organization_features`) | SYNCED, cloud-authoritative once licensing exists | Today: fully local (no cloud/licensing yet) | **Cloud, once licensing exists** — an entitlement is fundamentally "what did the merchant pay for," which cannot be locally decided. Local remains the *enforcement* point (Milestone 7's `FeatureService.isEnabled()`), never the *grant* authority, once cloud exists. |
| `products` | SYNCED | Can be created/edited offline | Cloud is catalog merge point (§9) |
| `product variants` | SYNCED | Same as products | Same as products |
| `customers` | SYNCED (profile) + APPEND_ONLY_SYNCED (wallet/loyalty ledger) | Profile edits happen at any till | Cloud merges profile edits (§9); the loyalty *ledger* (if/when it exists as an explicit table, not just `loyalty_ledger`'s current shape) is append-only, balance is DERIVED from it |
| `suppliers` | SYNCED | Created/edited at any location (owner/manager only — low contention) | Cloud is merge point |
| `purchase orders` | STATEFUL_SYNCED | A PO's lifecycle (`draft → ordered → partially_received/received/cancelled`) is a state machine, not a freely-editable row | Cloud validates transitions against the same state machine `main/modules/purchasing/purchase-orders.ts` already enforces locally — no duplicated *business* logic, duplicated *validation* only (§S) |
| `purchase order items` | STATEFUL_SYNCED | Tied to the parent PO's lifecycle; mutable only in `draft` | Same lifecycle-bound handling |
| `inventory balances` | DERIVED | Recomputed from `inventory_movements`, never authoritative on its own | Cloud independently derives its own copy from the same movement stream it receives — never receives a balance row directly |
| `inventory movements` | **APPEND_ONLY_SYNCED — the primary inventory sync primitive** | Immutable once written, ULID PK, already exactly this shape today | Cloud receives and stores every movement; never mutates one |
| `stock transfers` | STATEFUL_SYNCED | `draft → completed/cancelled`, touches two locations (§13) | Cloud validates the same state machine |
| `sales`/`orders` | **APPEND_ONLY_SYNCED (recommended: event-sourced)** | Today: a single mutable row per sale. **Recommended for sync:** the *events* that build a sale (`SaleOpened`, `ItemAdded`, `DiscountApplied`, `StatusChanged`, `SaleCompleted`, `SaleCancelled`) are what actually sync — the local `orders` row remains a `DERIVED` projection of its own event history, same pattern as inventory/payments | Cloud applies the same event stream to build its own projection — never receives or trusts a raw "current state" row |
| `sale items` | Folded into the sales event stream above (`ItemAdded`/`ItemVoided` events) | — | — |
| `bills` | **SYNCED today, should become DERIVED** | Currently semi-authoritative (`payment_details` JSON) because of the legacy dual-write (§Q3) | Once the dual-write retires (Milestone 8's roadmap item), a bill becomes a payable snapshot derived from its order + payments, not an independently synced entity |
| `payments` | STATEFUL_SYNCED (row) backed by APPEND_ONLY_SYNCED (`payment_events`) | Already exactly this shape — `payment_events` is documented in `main/db.ts` as "append-only... nothing in Plemmo should ever UPDATE or DELETE a row here" | Cloud receives `payment_events`, derives its own `payments` projection — this entity needs **no new local architecture**, only a transport |
| `payment events` | **APPEND_ONLY_SYNCED — the primary payment sync primitive** | Already this shape | Cloud stores every event, replays them to reach the same state a local device reached |
| `refunds` | STATEFUL_SYNCED (small state machine: `requested → settled/failed`) | Low volume, low contention (one refund touches one payment) | Cloud validates the same transitions; §12 |
| `cash sessions` | **Does not exist yet** (`PLEMMO_ARCHITECTURE.md`'s entity table: `❌ No shift or drawer accounting`) | — | Recommended shape when built: APPEND_ONLY_SYNCED (`SessionOpened`/`SessionClosed`/`CashMovement` events), same pattern as everything else — flagged in §22 as a "when it's built, build it sync-ready from day one" item, not a blocker |
| `audit events` | **APPEND_ONLY_SYNCED** | Already exactly this shape (`audit_events`, explicitly append-only by convention) | Cloud stores every event; this is close to a zero-change sync candidate |
| `receipts` | LOCAL_ONLY (rendering artifact) | A receipt is a render of an order+payment for a specific printer, not independent data | N/A — the underlying sale/payment already sync; the printed page itself never needs to leave the device. `print_logs` (if a "was this printed" record matters for support) could optionally become APPEND_ONLY_SYNCED later, but is not essential |
| `reports` | DERIVED | Computed on demand, locally, from local data (already true today) | Cloud computes its own cross-location reports from the synced movement/sale/payment streams — never receives a "report" as data |
| `settings` — organization-level (tax rate, receipt template, loyalty config, business name) | SYNCED | Editable at any till today | Cloud is merge point, low contention (owner/manager only) |
| `settings` — device-local (`plemmo_device_id`, `plemmo_location_id`/`register_id` pointers, KDS LAN config, printer USB paths) | **LOCAL_ONLY — must never sync** | This device's own physical identity/configuration | N/A — syncing these would let one till overwrite another's physical identity |

---

## 3. Local/cloud source-of-truth summary

Restating §2's split concisely, by *who wins when both sides have a
value*:

| Local wins (device is the source of truth) | Cloud wins (once cloud exists) | Neither — merged/append-only |
|---|---|---|
| Password/PIN hashes | Organization identity, billing | Products/variants (LWW + conflict log, §9) |
| Device-local settings | Feature entitlements (once licensing exists) | Customers (profile LWW, wallet append-only) |
| — | Device authentication/enrollment | Locations/registers (creation is local, merge is cloud) |
| — | — | Inventory movements, payment events, audit events, sale events (append-only, no "winner" needed) |

---

## 4. Sync architecture

### 4.1 Models considered

| Model | Verdict | Why |
|---|---|---|
| **Timestamp polling** (`WHERE updated_at > last_sync`) | Rejected | Clock skew across till hardware is real and unmanaged today (no NTP discipline exists in this codebase); a row updated in the same second as a poll can be silently missed; provides no natural idempotency key, so a retried upload after a lost ACK can duplicate a sale |
| **Change Data Capture** (SQLite WAL/trigger-based) | Rejected | better-sqlite3 has no logical replication feature; simulating CDC needs triggers on every synced table, which couples the sync engine to every table's shape and is exactly the kind of "duplicated business logic" Principle 7 warns against. It also captures *row changes*, not *facts* — violating Principle 2 |
| **Pure pub/sub event bus** | Rejected as standalone | Still needs a durable per-device queue to survive offline periods and crashes — which is the outbox, just without a name. Adopting pub/sub *language* without the outbox *mechanism* would leave events unrecoverable after a crash mid-send |
| **Outbox/inbox with sequence + cursor** | **Chosen** | Every write is durable before it is ever transmitted (the outbox row commits in the same SQLite transaction as the business write — §5). Retries are naturally idempotent (§7). Ordering is explicit and local (§8) instead of assumed from wall-clock time. This is also the exact pattern `main/services/cloud-sync.ts` already uses successfully for its own (different) purpose, so it is a proven fit for this codebase's runtime (Electron + better-sqlite3 + a background flush timer) |

### 4.2 The two independent pipelines

```
UPLOAD (local → cloud)

  Local business transaction (Sale/Payment/Inventory/…)
        │  same SQLite transaction, same withTxn() call
        ▼
  sync_outbox row (status: pending)
        │  background flush loop (same pattern as CloudSyncService.flushOutbox)
        ▼
  POST /sync/upload  (batch, device-authenticated)
        │
        ▼
  Cloud: idempotency check (device_uid + event_uid) → apply or replay-ack
        │
        ▼
  200 ACK { accepted: [event_uid...] }
        │
        ▼
  UPDATE sync_outbox SET status = 'acked' WHERE uid IN (...)


DOWNLOAD (cloud → local)

  GET /sync/pull?cursor=<opaque cursor>
        │
        ▼
  Cloud returns events since cursor, plus a next_cursor
        │
        ▼
  sync_inbox row per event (status: pending)
        │  applied inside a local transaction, one entity type at a time
        ▼
  Apply to local tables (idempotent — see §7)
        │
        ▼
  POST /sync/ack { cursor: next_cursor }  (or: persist cursor locally only —
        see §6, both are valid; this document recommends persisting the
        cursor locally and only re-requesting from the cloud on recovery)
```

The two pipelines are **independent and asymmetric on purpose**: upload
must never block on download (a till mid-sale should never wait on a
pending download to finish), and download never needs the upload's ACK to
proceed. They share only the same HTTP client, device credential, and
`sync_state` row (§18).

### 4.3 Why this is safer than the alternatives

1. **Durability precedes transmission.** The outbox row and the business
   row commit atomically (§5) — a crash between "sale committed" and "sale
   uploaded" cannot lose the sale; it is simply still pending in the
   outbox on restart.
2. **Idempotency is structural, not best-effort.** Every outbox row has a
   stable `uid` from the moment it is created (§7) — a retried upload
   after a lost ACK carries the same `uid`, and the cloud's job is simply
   "have I seen this `uid` before."
3. **Ordering is explicit.** A `sequence` column (§8) gives the cloud a
   deterministic per-device, per-entity order to apply events in, instead
   of inferring order from `created_at`/`updated_at`, which two different
   tills' clocks cannot be trusted to agree on.
4. **No dependency on cloud vendor.** The contract (§21) is HTTP + JSON
   with a bearer credential — nothing about the outbox/inbox tables or the
   `sync.ts` service cares whether the far end is Supabase, a bespoke
   Postgres API, or something else.

---

## 5. Outbox design

### 5.1 Proposed schema (not created in this milestone)

```sql
CREATE TABLE sync_outbox (
  uid             TEXT PRIMARY KEY,       -- ULID, the event's own global identity
  device_id       TEXT NOT NULL,          -- this device's id (from context.ts), stamped at write time
  sequence        INTEGER NOT NULL,       -- monotonic per-device counter, see §8
  entity_type     TEXT NOT NULL,          -- 'sale_event' | 'inventory_movement' | 'payment_event' | 'product' | ...
  entity_uid      TEXT NOT NULL,          -- the uid of the row/event this outbox entry carries
  operation       TEXT NOT NULL,          -- 'create' | 'update' | 'append' (no 'delete' — see §15)
  payload         TEXT NOT NULL,          -- JSON, the actual fact being transmitted
  organization_id TEXT NOT NULL,          -- stamped server-side at write time, never client input
  location_id     TEXT,                   -- stamped server-side, nullable only for org-level facts
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending', 'acked', 'failed', 'dead_letter')),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  next_attempt_at TEXT,                   -- backoff scheduling, see §Q(uick)/Part Q
  error           TEXT,
  created_at      TEXT NOT NULL,
  acked_at        TEXT
);

CREATE UNIQUE INDEX idx_sync_outbox_device_sequence ON sync_outbox(device_id, sequence);
CREATE INDEX idx_sync_outbox_status ON sync_outbox(status, next_attempt_at);
```

Deliberately named `sync_outbox`, not `cloud_sync_outbox` — the latter
name is already taken by the unrelated, disabled-by-default FloAdmin
bridge (§1, R-1). Reusing that name or table would be a real
implementation hazard: a future engineer searching the codebase for
"outbox" would find both and could plausibly wire the new engine into the
old (deprecated, vendor-specific) flush loop by mistake.

### 5.2 Atomicity — the non-negotiable part

The milestone brief is explicit that this is critical, and the existing
codebase already has the exact mechanism needed: **`withTxn()`**
(`db.transaction(fn)()`), which better-sqlite3 nests as SAVEPOINTs
automatically. Every Core service that produces a synced fact already runs
inside one `withTxn()` call per business operation
(`SaleService.createSale`, `PaymentService.tender`,
`InventoryService.adjustStock`, `TransferService.completeTransfer`, etc.).
The outbox insert is simply **one more statement inside that same
transaction**:

```
withTxn(() => {
  // 1. the business write(s) — e.g. insert order, order_items,
  //    inventory_movements, audit_events — exactly as today
  // 2. one (or more) INSERT INTO sync_outbox rows, built from the
  //    same data just written, inside the SAME withTxn() call
})
```

No new transaction-management code is needed — this is additive to
existing call sites, not a redesign of them. If the business write rolls
back (a validation failure partway through), the outbox insert rolls back
with it, because SQLite transactions are atomic by construction. This is
the same guarantee that already protects, for example, `TransferService.
completeTransfer()`'s multi-line atomicity today (Milestone 6, §7 of that
milestone's doc) — outbox rows are just more statements inside an
already-atomic boundary, not a new one.

### 5.3 What actually goes in the payload

Per §2's pattern, the payload is the **event**, not a snapshot of the
current row:

| entity_type | Example payload shape |
|---|---|
| `inventory_movement` | The `inventory_movements` row exactly as written — it is already an immutable fact |
| `payment_event` | The `payment_events` row exactly as written |
| `sale_event` | `{ event: 'ItemAdded', sale_uid, line: {...} }` — see §10 for why sales become event-shaped for sync even though the local table stays row-shaped |
| `product` (create/update) | The full current row — products are LWW-merged, not event-sourced (§9), so the "fact" *is* the current state |

---

## 6. Inbox / download design

### 6.1 Proposed schema

```sql
CREATE TABLE sync_inbox (
  uid             TEXT PRIMARY KEY,       -- the cloud-assigned event uid (globally unique — may originate
                                           -- from another device or from the cloud itself)
  received_cursor TEXT NOT NULL,          -- the cursor value this event arrived under
  entity_type     TEXT NOT NULL,
  entity_uid      TEXT NOT NULL,
  operation       TEXT NOT NULL,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'applied', 'skipped', 'failed')),
  applied_at      TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL
);
```

### 6.2 Cursor semantics

The cursor is an **opaque, cloud-issued token** (not a raw timestamp — see
§4.1's rejection of timestamp polling), persisted in `sync_state` (§18) as
soon as a pull's contents are durably written to `sync_inbox` — before
they are applied. This ordering matters: if the device crashes after
persisting the cursor but before applying every inbox row, the pending
inbox rows are still there on restart (`status = 'pending'`) and get
applied then; the device does not re-request data it already durably has,
but also cannot lose it. Advancing the cursor only after full application
would instead risk **re-requesting and re-processing** the same batch
after a crash — harmless given idempotent apply (§7), but wasteful at
scale (§20).

### 6.3 Apply order

Inbox rows apply in the order the cloud returned them, which the cloud
itself derives from its own global sequence (not from the arrival order
across different devices' uploads — see §8 for what does and doesn't need
global ordering). A device only ever downloads events for entities it's
entitled to see (its organization, filtered further by which locations
this device's users have — though in practice most catalog/organization
data is broadcast to every device in the org, and only location-scoped
operational data like inventory movements is filtered by location).

---

## 7. Idempotency strategy

**Server-side identity: `(device_id, event_uid)`, with `event_uid` alone
as the practical dedup key** since `event_uid` is already a ULID generated
once at creation time and never reused (the same guarantee `orders.uid`/
`bills.uid`/every Core ULID PK already provides). `device_id` is included
in the composite for defense in depth — even if two devices' ULID
generators somehow collided (astronomically unlikely, ULID's 80 bits of
randomness), they could not collide *and* share a device id.

This directly extends the pattern already proven locally:
`payment_idempotency_scoped`/`order_idempotency_scoped` key on
`(user_id, idempotency_key)` and cache the **response**, not just a
"seen" flag, so a retried request gets back the exact same result instead
of a generic "duplicate" error. The cloud-side idempotency table follows
the same shape:

```sql
-- Cloud-side (illustrative — this is the cloud's schema, not local SQLite)
CREATE TABLE sync_event_receipts (
  device_id       TEXT NOT NULL,
  event_uid       TEXT NOT NULL,
  applied_at      TIMESTAMPTZ NOT NULL,
  result_summary  JSONB,                  -- enough to reconstruct the ACK, not the full payload
  PRIMARY KEY (device_id, event_uid)
);
```

**Upload flow:**

```
device uploads batch [event_uid: A, B, C]
    ↓
cloud checks sync_event_receipts for A, B, C
    ↓
A: not seen → apply → record receipt → ack
B: already seen → skip apply → replay cached ack (not re-derive)
C: not seen → apply → record receipt → ack
    ↓
cloud responds: { accepted: [A, B, C] }  (idempotent from the device's perspective either way)
    ↓
device marks A, B, C 'acked' in sync_outbox
```

This is what makes "POST event → cloud commits → response lost → client
retries" (the milestone brief's own example) safe: the retry carries the
same `event_uid`, the cloud recognizes it, and returns the same ACK
without re-applying the sale/payment/movement/refund/transfer a second
time.

**Local idempotency (download direction)** is symmetric: `sync_inbox.uid`
is the cloud-assigned event id; applying an inbox row is guarded by
checking whether an entity with that `uid` already exists locally before
insert (or, for events that mutate a projection — like a `sale_event`
building up an order — checking whether that specific event has already
been folded into the projection, tracked via `sync_inbox.status =
'applied'` itself, which is already the natural idempotency guard for a
locally-processed inbox row).

---

## 8. Ordering strategy

**Not everything needs global ordering — and forcing it everywhere would
be the exact "theoretical distributed-systems perfection" Principle 9
warns against.** Three distinct ordering scopes:

1. **Device-local ordering (always required, cheap to provide).** Every
   outbox row gets a `sequence` value from a per-device monotonic counter
   (a single-row counter in `sync_state`, incremented inside the same
   `withTxn()` as the outbox insert — no coordination needed since it's
   local to one SQLite file). This guarantees the cloud can always
   reconstruct *this device's* event order exactly, even if network
   retries or batching reorder delivery.
2. **Entity-dependency ordering (required, but scoped to the entity, not
   global).** A payment event for a sale must apply after that sale's
   `SaleOpened` event; a `TransferIn` movement must apply after the
   corresponding `TransferOut`; goods-received must apply after (or
   reject if it precedes) the purchase order it receives against. This is
   enforced by the cloud validating each event's stated `depends_on`
   (the entity `uid` it references) exists in its own already-applied set
   before accepting — a foreign-key-style check at the application layer,
   not a global sequence number.
3. **No ordering needed.** Two different sales at two different tills, an
   inventory adjustment at Location A and a product price edit from
   Location B, two unrelated audit events — none of this needs to agree
   on a global order. The cloud's own ingestion order (whatever arrives
   first) is fine, because nothing about correctness depends on which one
   "happened first" in absolute time.

**Global ordering is explicitly not attempted.** No vector clocks, no
Lamport timestamps, no attempt to reconstruct a single linear history
across every device in an organization — Principle 9 and Principle 10
both argue against it, and nothing in §2's entity list actually needs it:
even inventory (§10) is resolved without a global order, by treating
movements as commutative facts rather than an ordered log that must
replay in exactly one sequence.

---

## 9. Conflict strategies by entity

**One generic policy is deliberately not used.** Each entity's policy
follows from what kind of thing it is (a fact vs. a mutable configuration
vs. a workflow):

| Entity | Policy | Why |
|---|---|---|
| **Product** — price changes | **Last-write-wins by `updated_at`, server-timestamped** (the cloud stamps the authoritative `updated_at` on ingestion, not trusting the device's clock) | Price is a single scalar with no natural way to "merge" two different offline edits; LWW is simple, deterministic, and the loser's edit is never silently lost — it is logged (§26, and a "conflicts" observability metric, §19) so a merchant can notice if two managers genuinely fought over a price offline |
| **Product** — deletion | **Soft delete only (`is_active = 0`), never a hard delete** | Already how `products` behaves locally today (no code path hard-deletes a product with sale history); sync makes this a hard requirement, not a new behavior — a product referenced by an order on another device cannot be allowed to vanish before that device reconnects |
| **Product** — SKU/barcode changes | **Reject + flag for manual resolution if two devices assign the same SKU to two different products offline** | This is the one place LWW is actively wrong — silently letting the second edit win would leave one product invisibly using another's barcode. The partial-unique constraint already enforced locally (Milestone 3) becomes a *cloud-side* conflict trigger: the second offline edit to arrive is accepted as a `product` update but flagged `sku_conflict`, not silently overwritten and not silently rejected |
| **Customer** — profile fields | **Last-write-wins by field, not by row** (field-level merge: if Device A edited `phone` and Device B edited `email` while both offline, both edits apply — only a genuine same-field collision picks a winner by timestamp) | Two managers editing different fields of the same loyal customer while both offline is a completely ordinary scenario (adding a phone number at one till, correcting an email at another) and should not force one edit to silently vanish |
| **Customer** — wallet/loyalty balance | **Never LWW — append-only ledger, balance always DERIVED** | A balance is a sum, not a value with a "latest" version; two offline redemptions must both apply (or both correctly fail if they'd overdraw — see the wallet-payment tests already covering "Insufficient wallet balance" locally) rather than one clobbering the other |
| **Employee** — permission/role changes | **Server wins, always** | A role or permission change is a security-relevant fact set by an owner/manager, almost always from the Admin surface (once it exists) rather than a till; a till making an offline role edit that later conflicts with an Admin-issued change should never win — the cloud/Admin's copy is authoritative here even though local devices otherwise get generous LWW treatment. This deliberately breaks the "local can always operate" principle for this one field set, because a stale, offline-set permission is a security risk, not just a data-quality one |
| **Inventory** — movements | **Append-only, no conflict possible by construction** | See §10 — this is the entity Principle 3 is written about |
| **Purchase order** | **Reject conflicting concurrent edits to a non-draft PO; last-writer-wins is not offered** | A PO transitions through a small state machine (`draft → ordered → received/cancelled`); two devices attempting to, say, both mark the same PO `ordered` is a workflow conflict, not a data conflict — the second transition attempt is rejected with "already ordered," exactly the same 4xx a route already returns today for an invalid transition, just arriving via sync instead of a live request. `draft`-stage edits (add/remove line, still local-only since nothing has committed to a supplier yet) use LWW per §"products"'s reasoning, since a draft is inherently pre-commitment |
| **Stock transfer** — source/destination | **Append-only movements + reject on state-machine violation**, same policy as purchase orders | See §13 for the full walkthrough |
| **Payment** — state changes | **Append-only event log is authoritative; the `payments` row is DERIVED, so "conflict" mostly cannot occur** | Two events for the same payment (e.g. `captured` then `voided`) apply in dependency order (§8); a genuinely contradictory pair (both devices somehow recording `captured` for the same payment with different amounts) is rejected as a data-integrity error requiring manual review, not resolved automatically — this should be exceptionally rare given a payment is created and driven from one till |
| **Sales/orders** | **Append-only, by construction (§2, §10)** | No conflict policy needed — every event is a fact that gets folded in, in dependency order; a `StatusChanged` to `cancelled` arriving after a `StatusChanged` to `completed` for the same sale is a workflow conflict resolved the same way PO transitions are (reject the invalid transition, since Core's own `SaleService` already defines which transitions are legal) |

---

## 10. Inventory conflict model

### 10.1 The scenario from the brief

```
Location A, starting stock = 7
  Till 1 (offline) sells 5   →  till 1's own local balance: 2
  Till 2 (offline) sells 4   →  till 2's own local balance: 3 (till 2 never saw till 1's sale)

Cloud eventually receives both movements: -5, -4 → total -9 against a starting balance of 7
```

**Chosen policy: allow negative stock during offline operation; do not
reserve, do not block the sale.** Reasoning, directly from the milestone's
own design principles: a business transaction (a sale) must remain valid
*locally* even without the cloud (Principle 1), and inventory tracking is
a courtesy to the merchant, not a hard constraint on whether a sale is
allowed to happen — this is already true in the *local, single-till* case
today (`InventoryService.adjustStock`'s "cannot go negative" policy,
documented in Milestone 4, is a **soft warning surfaced to the merchant**,
not a hard block on the sale itself; the milestone 4 doc is explicit that
overselling is allowed with a visible warning). Extending this to the
multi-till offline case is not a new policy, it is the same policy applied
across devices instead of within one.

**What actually happens, step by step:**

1. Both movements are accepted by the cloud unconditionally — they are
   *facts* ("5 units left Location A via a sale," "4 units left Location A
   via a sale"), and facts are never rejected for making a derived number
   go negative.
2. The cloud recomputes its own `inventory_balances`-equivalent
   projection from the full movement stream: `7 - 5 - 4 = -2`.
3. Neither till is ever "wrong" — each device's own local balance was
   correct *given what that device knew* at the time (2, then separately
   3). Once both reconnect and pull the other's movements, both
   local balances converge to the same cloud-derived `-2`, because
   `inventory_balances` is DERIVED (§2) and gets recomputed from the
   now-complete movement stream, not overwritten by a "cloud says" value
   that could contradict the device's own ledger.
4. The negative balance is surfaced as a **low-stock/negative-stock alert**
   (already a UI-observable concept via `listLowStock()`), not an error —
   the merchant now has real information: "you oversold by 2 across your
   two tills while offline," which is actionable (reorder, or write off).

**Why not the alternatives:**

- *Reserve inventory* — requires a live coordination point (a lock,
  effectively) that cannot exist while offline by definition; this would
  mean either blocking sales when offline (violates Principle 1 directly)
  or reserving optimistically and reconciling anyway (which is just this
  policy with extra steps and false confidence).
- *Conflict at sync* — there is no real "conflict" here in the technical
  sense (two updates to the same field disagreeing); it's two independent,
  compatible facts. Treating it as a conflict needing resolution would
  invent work (a human deciding "which sale wins") for a situation that
  has no wrong answer to pick between — both sales genuinely happened.
- *Reject impossible offline sales only* — impossible to implement
  correctly: "impossible" can only be known with a global, live view of
  stock, which is precisely what's unavailable offline. A device would
  have to guess at sync time whether a sale it already completed, printed
  a receipt for, and already reported to the till operator as successful
  should retroactively be un-happened — not implementable without breaking
  Principle 1.

### 10.2 Concurrent transfer + sale + receiving

```
Location A offline: sells 3 units of Product X
Location A offline: receives 10 units of Product X from a purchase order
Location B offline: initiates a transfer of 2 units of Product X FROM Location A
```

All three are independent `inventory_movements` rows
(`movement_type IN ('sale','receipt','transfer_out')`), each carrying its
own `reference_type`/`reference_id` back to the sale/PO/transfer that
caused it (already true locally today). **None of the three needs to know
about the other two to be individually valid** — they're all facts about
what left or entered Location A's stock, and movements are commutative:
applying them in any order produces the same final balance
(`7 - 3 + 10 - 2 = 12`, regardless of the order the three are folded in).
This is exactly why §8 does not require global ordering for inventory:
correctness does not depend on knowing "the sale happened before the
receipt" — only the final sum matters, and sums do not care about their
addends' order.

The one thing that *does* need ordering here is the transfer's own two
sides (`transfer_out` at A, `transfer_in` at B — see §13), which is
entity-dependency ordering (§8, category 2), not a global order across all
three movements.

---

## 11. Payment sync model

**Cash and manual card** payments sync exactly like any other
`STATEFUL_SYNCED` entity backed by `payment_events` (§2, §9) — no special
handling, because both are fully decided locally the instant they're
recorded; there is no external party to reconcile against.

**Future integrated terminal payments** (not implemented, and explicitly
out of scope to implement here) introduce a case the current model doesn't
have: a payment whose final state is decided by a **third party's
webhook/callback**, arriving on the cloud side, not the device side. The
design for that (when it is eventually built) follows the same
event-sourced shape already established:

```
Till: creates payment (state: requested) → payment_event('requested')
    → outbox → cloud
Terminal provider: independently calls the cloud's webhook with the
    authoritative outcome (captured/declined) → cloud appends a
    payment_event on the CLOUD side
Till: next pull() download cycle receives that payment_event via the
    inbox → applies it locally → local payments row (DERIVED) reflects
    the provider's real outcome
```

The device never needs to poll the provider directly, and the provider
never needs to talk to the device directly — the cloud is the natural
integration point (it already needs to be reachable from the internet;
the till often isn't). This is consistent with the entity classification
in §2 (`payment_events` is the sync primitive) and requires no new
mechanism, only a new *source* of `payment_event` rows (the cloud itself,
not just devices) — which the inbox/apply pipeline (§6) already handles,
since it doesn't distinguish "an event that originated from another
device" from "an event that originated from the cloud."

---

## 12. Refund model

**Can a refund be performed offline? Yes, under the same conditions a
sale can be created offline** — a refund against a payment whose
`payment_events` the device already has locally (i.e., a refund against a
sale/payment this device knows about, which is the overwhelmingly common
case: a customer returns to the till that served them, same day, likely
still offline for the same reason the original sale was). This is not a
new policy — `refundPayment()` (`main/core/payment.ts`, Milestone 2) is
already Core-only application logic with no network dependency.

**Linking:** a refund's `payment_id`/`bill_id` already point at the
original payment/bill locally (schema unchanged); for sync, a refund event
carries the original payment's `uid` (§22's uid-promotion item makes this
possible for bill/order-linked payments) so the cloud can validate the
refund against a payment it has actually seen — see the ordering rule
below.

**What if the till has never synced the original sale before going
offline again and someone tries to refund it?** Not possible in this
model — the refund can only be created against a payment that already
exists as a **local row** (the refund route already requires the payment
row to exist to compute `refundable = amount_minor - refunded_minor`
before allowing the refund at all), so a refund is always causally *after*
its own sale in local terms, and therefore always uploads *after* it in
the outbox (same device, so §8's device-local sequence guarantees this
ordering automatically — no special case needed).

**Cross-device refund** (a customer returns to a *different* location/till
than the one that sold to them) requires that till to have already synced
and downloaded the original sale/payment — if it hasn't, the refund cannot
be created locally at all (there is no local payment row to refund), which
is the correct behavior: refunding something the till has no record of
would be trusting an unverified claim.

**Duplicate refund / conflict at the cloud:** the cloud rejects a refund
event whose `amount_minor` would exceed the payment's already-known
`refundable` balance, exactly the same validation `refundPayment()`
already performs locally (`PaymentError`) — this is deliberately
*duplicated validation*, not duplicated business logic (Principle 7): the
cloud re-checks the same invariant using the same event history it has,
rather than trusting the device's local check was correct, because the
device's local check was only correct *given what that device knew at the
time* — if two devices both attempt to refund overlapping amounts from
the same payment while both offline, the first refund event the cloud
applies wins, and the second is rejected the same way a real-time
double-refund attempt would be rejected today, just discovered at sync
time instead of at request time. This is surfaced back to the device that
"lost" as a rejected-event notification for a human to review (§19,
§24 scenario 8) — not silently dropped.

---

## 13. Transfer model

### 13.1 The scenario from the brief

```
Location A is offline and initiates a transfer to Location B
Location B is also offline
```

This is fine and requires no special handling: `createTransfer()` at
Location A produces a `stock_transfers` row plus (on completion) a
`transfer_out` movement — both are facts, both upload via the normal
outbox path whenever A reconnects, independent of B's connectivity state.
**B does not "recognize" the transfer until B has both reconnected AND
pulled the events** — there is no other trigger; a transfer sitting
unacknowledged in the cloud waiting for B to reconnect is the expected,
correct state, not an error state.

### 13.2 What if B sold the stock before receiving the transfer?

This cannot happen in the sense the question implies, because of how
`stock_transfers` already works locally (Milestone 6): a transfer's
`transfer_in` movement only exists once `completeTransfer()` runs, and B's
own local balance for that product is **only affected by the transfer once
B has actually recorded a `transfer_in`** — which requires B to have
already applied A's `transfer_out`-originated `stock_transfers` row from
the inbox (B needs to know the transfer exists before it can complete its
own inbound side). So the real scenario is: **B sells stock it physically
already had before the transfer's goods physically arrived** — a completely
ordinary retail scenario (the transfer is in transit, B is still selling
down its existing stock), not a sync bug. B's sale movement and the
eventual `transfer_in` movement are just two more commutative facts (§10.2)
— no conflict, the balance is correct either way once both are applied.

### 13.3 Exact behavior, step by step

1. A (offline) creates a transfer, adds items, marks it `completed` →
   locally: `stock_transfers` row (`status: completed`) + `transfer_out`
   movements at A. A's own balance decreases immediately, locally,
   regardless of B's state.
2. A reconnects → uploads the transfer + movements.
3. Cloud accepts, and stores the transfer as an event B will receive on
   its next pull.
4. B reconnects (independently of A's timing) → downloads the transfer
   event → applies it locally. **B's own local balance is not affected by
   downloading the transfer alone** — a transfer arriving does not
   automatically move stock into B's balance; per the existing local model,
   receiving the *goods* is what should trigger B's own `transfer_in`
   (this document recommends that, for symmetry with `PurchaseOrderService`/
   `ReceivingService`'s existing "someone at the receiving location
   confirms goods arrived" pattern, B's staff explicitly acknowledge
   receipt of the transfer rather than the cloud event alone silently
   crediting stock nobody has physically counted — see §22's flagged
   design decision, since today's `completeTransfer()` writes both sides
   atomically for the *single-connectivity* case and this asymmetric
   two-sided completion for the *offline* case is new).
5. If B sold stock in the meantime, that's an unrelated, independently
   valid movement — no conflict (§10.2).

---

## 14. Purchase receiving model

- **PO modified offline, then synced:** allowed only while the PO is
  still `draft` (already the local rule — `addItem`/`updateItem`/
  `removeItem` all call `requireDraft()`); a `draft`-stage edit uses LWW
  per §9's product reasoning, since nothing external (a supplier) has
  committed to it yet.
- **Receiving happens offline:** allowed and expected — `receiveGoods()`
  is already idempotent locally (Milestone 5's idempotency key/request
  hash), which extends directly to sync: the receiving event's own `uid`
  is the sync-level idempotency key too (§7), so an offline receipt that
  gets uploaded, ACKed, but has its ACK lost and gets retried cannot
  double the stock — exactly the guarantee `tests/plemmo-purchasing.test.ts`
  already proves locally ("a retried receive request does not double the
  stock"), now also guaranteed across the sync boundary by the same
  mechanism, not a new one.
- **Another device cancels the PO (while this device is mid-receiving,
  offline):** the cancellation and the receipt are two independent events
  that both eventually reach the cloud. The cloud applies whichever
  arrives first; if the cancellation is already applied when the receipt
  event arrives, the receipt event is rejected — same state-machine
  violation handling as §9's PO conflict policy. The device that receives
  the rejection is notified (§19) so a human can reconcile physically
  (goods that arrived against a since-cancelled PO are now an inventory
  adjustment, not a receipt — a manual step, correctly, since only a human
  knows what actually physically happened at the loading dock).
- **Duplicate receiving event arrives** (e.g. two different devices both
  attempt to receive against the same PO, unlikely but not impossible if
  a merchant's process allows it): idempotency (§7) prevents the exact
  same event from double-applying; a *second, different* receiving event
  against a PO already fully received is rejected the same way it would
  be rejected today outside of sync (the local `receiveGoods()` already
  validates against the PO's remaining quantity).

---

## 15. Deletion / tombstone model

**No synced entity is ever hard-deleted once it exists at the sync
boundary.** Three mechanisms, chosen per entity, deliberately not one:

1. **Soft-delete flags already in use — extend, don't replace.**
   `products`/`product_variants`/`locations`/`registers`/`tables` already
   use `is_active`; this is already a tombstone in effect (a row that
   still exists for referential integrity but signals "don't offer this
   anymore"). No schema change needed for these — sync simply treats an
   `is_active = 0` update as a normal `SYNCED` update (§9), not a delete
   operation.
2. **`deleted_at` for entities with no existing soft-delete flag** (a
   genuinely new need — none identified among the currently-synced-worthy
   entities beyond what already has `is_active`, but flagged as the
   pattern to use if one arises, e.g. a future `customers.deleted_at` for
   GDPR-driven removal requests, which is a real, different concept from
   `is_active` and should not overload it).
3. **Child-row deletes that are currently real `DELETE`s must become
   tombstones before sync ships.** `removeTransferItem()` and `removeItem()`
   (purchase order lines) issue genuine SQL `DELETE`s today. Both are
   already guarded by `requireDraft()` — only possible before the parent
   is shared in any meaningful cross-device sense — which meaningfully
   limits, but does not eliminate, the risk: a device could go offline
   immediately after adding a draft line, another device could (in a
   future multi-editor world) reference it, and the delete would need to
   propagate rather than silently vanish a referenced row. **This document
   recommends converting both to a `deleted_at` tombstone before Milestone
   9's implementation phase begins** — a small, low-risk change (§22).

**Why not versioning-as-the-deletion-mechanism:** a delete is a distinct
kind of fact from an edit (§16 discusses versioning for conflict
*detection*, which is a different problem from making a deletion visible
to a device that hasn't synced yet). Overloading version numbers to also
signal "and also this was deleted" is exactly the kind of unnecessary
cleverness Principle 10 warns against — an explicit flag is simpler and
unambiguous.

---

## 16. Versioning model

**The simplest mechanism that provides reliable conflict detection:
`updated_at`, server-stamped on ingestion, plus the event's own `uid` as
the tiebreaker for exact-simultaneous edits.** No vector clocks, no
per-row revision counters, no CRDTs.

Why this is sufficient and not an under-engineering risk:

- **Append-only entities (the majority of §2's table) need no versioning
  at all** — a fact, once written, is never edited, so "which version is
  newer" is not a question that ever gets asked.
- **LWW entities (products, customer profile fields, locations/registers)**
  need exactly one signal: "which edit happened later." `updated_at`,
  **stamped by the cloud at ingestion time** (not trusted from the
  device's own clock — this is the one place this document deviates from
  "trust the device," because clock skew across till hardware is a real,
  unmanaged risk today) gives a reliable, monotonic-enough ordering for
  this purpose. A genuine tie (two edits landing in the same cloud-ingestion
  millisecond) is vanishingly rare and resolved by the deterministic
  tiebreaker of comparing `event_uid` lexicographically (ULIDs are
  lexicographically sortable, so this is free).
- **State-machine entities (POs, transfers, sales)** don't need version
  numbers either — their "version" is which state they're in, and an
  invalid transition is rejected outright (§9), not merged.

**When this would not be enough** (and is deliberately not attempted
here): a system where the *same field* on the *same row* needs
fine-grained, automatic three-way merging beyond "last edit wins" — e.g.
if two devices both incremented a shared counter offline and both
increments needed to be preserved. No entity in §2 has this shape *except*
the wallet/loyalty balance, which is explicitly handled by making the
balance `DERIVED` from an append-only ledger instead (§9) — the correct
fix for that class of problem is "don't store the mutable sum, store the
immutable deltas," not "invent a fancier merge algorithm for the sum."

---

## 17. Device authentication model

Builds directly on the existing `Organization → Location → Register →
Device` model (Milestone 6) — no new hierarchy invented.

**Gap identified: `devices` currently has no authentication credential
column.** Today, `devices.id`/`status` exist, but nothing cryptographically
proves a request claiming to be "device X" actually is. This must be added
before sync ships (§22).

**Proposed model:**

1. **Enrollment (once, when a till first connects to the cloud):** the
   device presents something proving it belongs to this merchant — in
   practice, a short-lived enrollment code an owner generates from a
   future Admin surface and types into the till once, out of band. The
   cloud issues the device a long-lived credential (an asymmetric keypair
   generated *on the device*, with only the public key ever transmitted,
   or a rotatable bearer secret — either is provider-neutral; the choice
   is deferred to §21's implementation phase, not decided here).
2. **Every subsequent sync request is signed/authenticated with that
   credential**, not with the organization id, not with a user's login
   token (a cashier's shift-scoped JWT is the wrong lifetime and the wrong
   *subject* for a device-level channel — sync is a device-to-cloud
   relationship, independent of which staff member happens to be logged
   into the till at that moment).
3. **The cloud resolves `organization_id`/`location_id`/`register_id`
   from the authenticated device's own enrollment record — never from
   anything in the request payload.** This is the exact same principle
   Milestones 6–8 already established locally (`getCurrentOrganizationId()`
   resolved server-side, never from client input) — extended to the cloud
   boundary rather than invented fresh. A compromised device can only ever
   act as *itself* (its own org/location), never claim to be another
   device or another organization, because the server-side identity
   resolution has nothing to do with what the payload claims.
4. **Revocation** uses the `devices.status` column that already exists
   (`active`/`retired`/`revoked`) — a revoked device's credential is
   rejected at the authentication layer before any sync logic runs, and a
   replaced/lost till (§22, "device is replaced") re-enrolls as a new
   device row, with the old one marked `revoked`.

Every outbox event, and by extension every fact that ever reaches the
cloud, is therefore attributable to `organization → location → register →
device` by construction — the same four-level chain already stamped on
every `orders`/`payments`/`inventory_movements` row locally since
Milestone 6, now also the identity the transport layer itself
authenticates against.

---

## 18. Sync state model

```sql
-- Local SQLite, one row (singleton, like the settings pointers already are)
CREATE TABLE sync_state (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton pattern
  device_sequence       INTEGER NOT NULL DEFAULT 0,          -- next outbox sequence to assign (§8)
  last_uploaded_sequence INTEGER NOT NULL DEFAULT 0,         -- highest ACKed outbox sequence
  last_download_cursor  TEXT,                                -- opaque cloud cursor (§6.2)
  pending_upload_count  INTEGER NOT NULL DEFAULT 0,          -- denormalized, refreshed on flush (observability, §19)
  failed_upload_count   INTEGER NOT NULL DEFAULT 0,
  last_successful_sync_at TEXT,
  last_error            TEXT,
  last_error_at         TEXT,
  sync_engine_version    TEXT NOT NULL,                      -- for forward-compatible protocol changes
  updated_at            TEXT NOT NULL
);
```

**Survives restart/crash/power loss by construction**, for the same
reason the outbox itself does (§5.2): every field here is updated inside
the same SQLite transaction as the outbox/inbox row it describes, using
the existing `withTxn()`/WAL-mode durability the whole database already
relies on — no new durability mechanism, no separate state file that could
fall out of sync with the database it describes (a real risk `main/
services/cloud-sync.ts` avoids too, for the same reason — see its own
persistent settings-table-backed state). Network interruption mid-sync
simply leaves outbox rows `sending`/`pending` and inbox rows `pending` —
resumed exactly where they left off on the next flush cycle, with `sending`
rows reset to `pending` on startup (the existing `CloudSyncService`
already does exactly this reset-on-boot pattern for its own outbox, a
direct precedent).

---

## 19. Observability model

| Metric | Source | Surfaced to (future) Admin as |
|---|---|---|
| Outbox depth (pending count) | `COUNT(*) FROM sync_outbox WHERE status = 'pending'` | "N events waiting to upload" |
| Failed event count | `COUNT(*) FROM sync_outbox WHERE status IN ('failed','dead_letter')` | Alertable — a device stuck failing needs a human |
| Last successful sync | `sync_state.last_successful_sync_at` | Per-device "last seen syncing" |
| Device last seen | `devices.last_seen_at` (already exists) | Per-device online/offline indicator |
| Sync duration | Measured client-side per flush cycle, reported as a `sync_event` alongside the next upload batch (piggy-backed, not a separate channel) | Trend — is sync getting slower as a merchant's data grows? |
| Conflict count | Incremented whenever §9's conflict-log path fires (product LWW loser, refund rejection, PO state violation) | "N conflicts needing review" — directly actionable for a merchant/support |

This is deliberately built from data the design already produces as a
byproduct (outbox/inbox status columns, the existing `devices.last_seen_at`,
the conflict-log entries §9/§12/§14 already call for) rather than a
separate telemetry system — consistent with Principle 7 (no duplicated
logic between local and cloud) and with the existing codebase's own
`telemetry_enabled`/`diagnostics_consent` settings already being
explicit, opt-in concepts (Milestone/Phase 0's disconnection of the
FloAdmin telemetry channel, §1, means Plemmo's *own* observability data
must be a clean, separately-consented channel, not accidentally revived
through the old one).

---

## 20. Scale estimate

Assumptions: an average merchant runs 1–3 registers, ~150 sale-related
events/day/register (order create + a few item-adds + payment + maybe a
refund), plus a much smaller trickle of inventory/purchasing/catalog
events. This is a rough planning estimate, not a benchmark.

| Merchants | Registers (≈2/merchant) | Events/day (≈200/register) | Events/month | Rows/month (outbox-equivalent, cloud-side) |
|---|---|---|---|---|
| 100 | 200 | 40,000 | ~1.2M | ~1.2M |
| 500 | 1,000 | 200,000 | ~6M | ~6M |
| 1,000 | 2,000 | 400,000 | ~12M | ~12M |
| 3,000 | 6,000 | 1,200,000 | ~36M | ~36M |
| 10,000 | 20,000 | 4,000,000 | ~120M | ~120M |

**Architectural bottlenecks this predicts, without prematurely
optimizing for them:**

1. **A single unpartitioned events table becomes an indexing problem well
   before 10,000 merchants.** At ~36M rows/month at the 3,000-merchant
   tier, a table scanned by `organization_id` needs that as a leading
   index from day one (cheap to add now, expensive to retrofit at scale)
   — this document recommends the cloud schema partition or index by
   `organization_id` from the very first migration, not as a later
   optimization.
2. **Batching matters more than per-event overhead.** The outbox already
   naturally batches (a flush cycle uploads everything pending in one
   request, the same pattern `CloudSyncService.flushOutbox` already uses
   locally) — this is the right default and should not be "optimized" into
   per-event HTTP calls, which would multiply request volume by 100–200x
   at the top of this table for no benefit.
3. **Download (pull) cost scales with organization size, not merchant
   count** — a merchant with 3 tills all pulling the same organization's
   catalog changes is 3x the read load of that same organization with 1
   till, independent of how many *other* merchants exist. This argues for
   a per-organization cursor and per-organization data isolation (§21)
   rather than a single global change stream every device filters
   client-side (which would force every device to receive and discard
   every other merchant's events — both a privacy problem, §21's isolation
   requirement, and a bandwidth problem).
4. **Storage is cheap relative to the numbers above** — even at 10,000
   merchants and ~120M events/month, at a few hundred bytes/event this is
   tens of GB/month, not an infrastructure-defining number on any modern
   provider. Not a bottleneck worth designing around prematurely.

---

## 21. API contract

Provider-neutral: HTTP + JSON + a bearer-style device credential (§17).
Nothing here assumes Supabase, a bespoke Postgres API, or any other
specific backend.

```
POST /sync/upload
  Headers: Authorization: Bearer <device credential>
  Body: {
    device_id: "...",           // informational; identity is the credential, not this field (§17, §S)
    events: [
      { uid, sequence, entity_type, entity_uid, operation, payload, created_at },
      ...
    ]
  }
  Response 200: {
    accepted: ["uid1", "uid2", ...],
    rejected: [{ uid, reason, code }],   // e.g. state-machine violation (§9), sku_conflict (§9)
    server_time: "..."                  // for the device's own clock-skew awareness, informational only
  }

GET /sync/pull?cursor=<opaque>&limit=<n>
  Headers: Authorization: Bearer <device credential>
  Response 200: {
    events: [
      { uid, entity_type, entity_uid, operation, payload, sequence_hint },
      ...
    ],
    next_cursor: "...",
    has_more: true|false
  }

POST /sync/ack   (optional — see §6.2; this design persists the cursor
                  locally on receipt and treats explicit ack as a
                  belt-and-braces confirmation, not a requirement for
                  the cursor to advance)
  Body: { cursor: "..." }
  Response 200: {}

GET /sync/health   (device → cloud liveness/version check, used by the
                    background flush loop to decide whether to attempt
                    a cycle at all — same purpose the existing
                    CloudSyncService's heartbeat already serves)
```

**What the POS never needs to care about:** table names, SQL dialect,
whether the cloud is Postgres/Supabase/something else, connection pooling,
or any cloud-side implementation detail — the contract above is the entire
surface. This mirrors the existing `main/services/cloud-sync.ts`'s own
`normalizeCloudServerUrl()`/`endpoint()` abstraction, which already treats
the cloud as "some HTTPS server implementing this contract," not a
specific product.

---

## 22. Database changes that will eventually be required

Not created in this milestone (design only). Ranked by how much they
block the rest of this design:

| # | Change | Why it's needed | Risk if skipped |
|---|---|---|---|
| 1 | **Retire (or complete) the payment dual-write** — `bills.payment_details` JSON stops being the authoritative payment record; `payments`/`payment_events` (already sync-shaped) become authoritative for every payment, not just `tender()`'s callers | `bills.payment_details` is an opaque blob — not decomposable into idempotent, orderable, append-only facts, so it cannot be synced by this design as-is | Sync ships covering only some payments (whichever path already uses `PaymentService`) and silently misses others — a worse outcome than not shipping sync at all, since it would look complete while being partially blind |
| 2 | **Promote `orders`/`order_items`/`bills`'s `uid` from bolted-on to load-bearing** — every new write path populates it (already true since v69's backfill, needs auditing that *current* insert paths also populate it, not just the historical backfill), and `payments.bill_id`/`order_id` gain parallel `bill_uid`/`order_uid` columns (or a lookup) since integer PKs are not globally unique | Sync needs a global identity for every synced row; the integer PK cannot serve that role across devices | Without this, payments/refunds cannot be correctly linked to the sale/bill they belong to once more than one device is involved — this is the single most concrete "must fix before sync" item found in this audit |
| 3 | **New tables**: `sync_outbox`, `sync_inbox`, `sync_state` (§5, §6, §18) | Core mechanism | N/A — required by definition |
| 4 | **Device credential storage** — a column (or side table) on `devices` for the enrollment credential/public key (§17) | No cryptographic device identity exists today | Sync cannot authenticate devices at all without this |
| 5 | **Convert `removeTransferItem()`/`removeItem()` (PO lines) from hard `DELETE` to a `deleted_at` tombstone** (§15) | Currently the only two identified hard-deletes on entities that will be `SYNCED`/`STATEFUL_SYNCED` | Small, low-probability-of-actual-collision risk given the existing `requireDraft()` guard, but a real gap if left as-is |
| 6 | **Backfill/tighten `organization_id` non-nullability** on tables where it's currently optional (`purchase_orders.organization_id` has no FK per Milestone 7's own note; `inventory_movements.location_id` is nullable) | Every row that will ever leave the device needs an unambiguous organization/location to attribute it to | A null-organization row cannot be routed to the correct cloud tenant — must be resolved (backfilled from context, or the write path fixed to always stamp it) before that table starts syncing |
| 7 | **Cash sessions, when built** (§2 — doesn't exist yet) should be designed sync-ready (event-sourced) from its very first migration, not retrofitted later | Avoids repeating item #1's mistake (a new entity shaped as a mutable row when it should have been an event log from day one) | Cheap to get right now, expensive to fix after merchants have real session history in the wrong shape |

Items 3 and 4 are pure additions (no risk to existing behavior). Items 1,
2, 5, and 6 touch existing, currently-working code paths and each need
their own focused migration/upgrade-path test, in the same discipline
every prior Plemmo migration has followed (fresh + legacy fixture,
Milestone 4/5/6's established pattern) — **not** attempted in this
design-only milestone.

---

## 23. Implementation roadmap

Redesigned slightly from the brief's example stages, reordered so that
the two "must change before sync" items (§22 #1, #2) come first as their
own stage rather than being folded silently into a later one — making the
dependency explicit rather than discovered mid-implementation.

| Stage | Scope | Depends on | Independently testable? |
|---|---|---|---|
| **SYNC-0** | Foundation repair: retire/complete payment dual-write (§22 #1), promote `uid` to load-bearing on orders/order_items/bills + add `bill_uid`/`order_uid` to payments (§22 #2), convert the two hard-deletes to tombstones (§22 #5) | Nothing new — this is finishing work on existing Milestone 2/5/6 architecture | Yes, entirely — this has zero dependency on any sync code existing yet, and is valuable (a cleaner payment model, a real global sale identity) independent of whether sync ever ships |
| **SYNC-A** | Local outbox/inbox foundation: `sync_outbox`/`sync_inbox`/`sync_state` tables, the `withTxn()`-integrated outbox-insert pattern wired into one pilot write path (recommend: `inventory_movements`, since it's already append-only and has no dual-write baggage) | SYNC-0's tombstone/uid work only where the pilot entity needs it (inventory doesn't, so SYNC-A could in principle start before SYNC-0 finishes, if sequenced carefully) | Yes — fully testable against a mock/local cloud stub, no real cloud needed |
| **SYNC-B** | Cloud API contract (§21) implemented against a real (even minimal) cloud backend | SYNC-A (needs real outbox rows to send) | Yes, once SYNC-A exists |
| **SYNC-C** | Upload + idempotency (§5, §7) — the full upload pipeline, retry/backoff (§Q), dead-letter handling | SYNC-A, SYNC-B | Yes |
| **SYNC-D** | Download/cursors (§6) — the full pull pipeline, inbox apply | SYNC-B | Yes, and can be developed in parallel with SYNC-C once SYNC-B exists — upload and download are genuinely independent pipelines (§4.2) |
| **SYNC-E** | Core entity sync, entity by entity, in this order: inventory movements (pilot, already done in SYNC-A) → audit events (near-zero-change, low risk) → payment events (needs SYNC-0) → sale events (needs SYNC-0, and the event-sourcing recommendation in §2/§10 to actually be built) → catalog (products/variants, needs LWW conflict handling, §9) → purchase orders/transfers (needs state-machine validation duplicated cloud-side, §9) | SYNC-C, SYNC-D, and per-entity: SYNC-0 for payment/sale events | Each entity is independently shippable and testable — this is the stage most amenable to incremental rollout |
| **SYNC-F** | Inventory conflict handling / negative-stock alerting (§10) as a first-class merchant-visible feature, not just "it doesn't crash" | SYNC-E (inventory movements syncing) | Yes |
| **SYNC-G** | Device authentication + enrollment (§17) | Can be developed in parallel with SYNC-A–E against a stub credential, but must be real before any pilot merchant goes live | Yes, in isolation |
| **SYNC-H** | Recovery workflows (§24/V) — device replacement, damaged local DB, stale-cursor recovery | SYNC-A–E functioning end to end | Yes, as a dedicated test suite once the pipeline exists |
| **SYNC-I** | Observability (§19) surfaced into a real Admin UI | Everything above producing the underlying data; the UI itself is explicitly out of scope for this milestone and the next (Milestone 9 is design-only; the Admin Panel is its own future milestone per every prior milestone's "do not build" list) |

**Safest sequence, restated simply:** fix the foundation (SYNC-0) →
prove the mechanism on the lowest-risk entity (SYNC-A, inventory
movements) → build the transport (SYNC-B/C/D) → extend entity by entity
in order of increasing complexity (SYNC-E) → harden (SYNC-F/G/H) →
observe (SYNC-I). No stage requires guessing at a later stage's design —
each is independently testable against the contract the previous stage
already fixed.

---

## 24. Failure scenarios

| # | Scenario | Local result | Sync result | Cloud result | Final state | Human intervention? |
|---|---|---|---|---|---|---|
| 1 | Internet dies during a sale | Sale completes fully locally — `SaleService` has no network dependency | Outbox row created but stays `pending` | Nothing received yet | Sale exists locally, uploads on next successful flush | No |
| 2 | Internet dies after payment but before sync | Payment committed locally in full | Outbox row(s) for the payment stay `pending` | Nothing received | Same as #1 — nothing lost, just delayed | No |
| 3 | Upload succeeds but ACK is lost | Cloud has applied the event; device never saw the 200 | Device retries on next flush cycle with the same `uid` | Cloud recognizes the `uid` via `sync_event_receipts` (§7), replays the cached ACK instead of re-applying | Outbox row marked `acked` once the replayed ACK arrives; no duplicate | No |
| 4 | Device crashes during sync | Whatever was durably committed before the crash (either the business transaction with its outbox row, or nothing, per §5.2's atomicity) survives; nothing "half-written" | On restart, any `sending`-status outbox rows reset to `pending` (§18) and retry | Cloud has applied whatever it received and ACKed before the crash — possibly ACKed rows the device never marked, handled by #3's idempotent-replay path | Fully recovered on next successful sync | No |
| 5 | Two tills sell the last item offline | Both sales complete fully and independently, locally | Both movements upload independently, no coordination attempted | Cloud accepts both movements unconditionally (§10) | Negative/zero derived balance, surfaced as a low-stock alert, both sales stand | **No** — this is a merchant process/inventory question ("we oversold"), not a data-integrity error; no rollback of either sale is attempted or offered |
| 6 | One till receives stock while another sells it offline | Both operate on their own local view; if the selling till's local stock happened to already be positive (from stock it had before either offline period), the sale is simply an ordinary sale | Both movements (receipt, sale) upload independently | Cloud applies both — commutative (§10.2) | Correct final balance once both are applied, regardless of order | No |
| 7 | Offline transfer between two locations, both offline | Each location logs a valid StockTransfer/movement locally at their own pace | Independent outbox uploads whenever each reconnects | Cloud applies whichever arrives first; the receiving side's local acknowledgment is a separate, later step (§13.3) | Transfer completes once both sides have reconnected and, per §13.3's recommendation, the receiving location has explicitly acknowledged receipt | Yes, in the mild sense that receipt confirmation is a deliberate staff action, not automatic — see §13.3 |
| 8 | Offline refund | Refund created locally against a payment this till already has (§12) | Uploads normally; if it conflicts with another device's overlapping refund of the same payment, the second to be applied cloud-side is rejected | Cloud validates against `refundable` balance at apply time (§12) | The winning refund stands; the losing device is notified of a rejected event | **Yes**, if rejected — a human needs to review why a refund that succeeded locally was rejected at sync time (e.g., issue store credit manually if the original overlapping intent was legitimate) |
| 9 | Device offline for 7 days | Fully operational the entire time — no functionality depends on connectivity (Principle 1, Principle 8) | A large outbox backlog accumulates; uploads in batches once reconnected (§4.2, §20's batching point) | Cloud processes the backlog like any other batch, just larger | Fully caught up after enough flush cycles; no data loss | No, assuming no conflicts arose in the interim (if they did, same handling as any conflict scenario above) |
| 10 | Device is replaced | Old device's local SQLite file is gone/inaccessible | New device enrolls fresh (§17) as a *new* `device_id`; it downloads the organization's full current state via the inbox from cursor zero (a "cold start" pull) | Cloud serves the new device the same data any device would get on first sync | New device becomes fully operational once its initial pull completes; old device's `status` is set `revoked` | Yes — enrollment is inherently a deliberate, human-initiated action (§17), not automatic |
| 11 | Duplicate event replay | N/A (this is a transport-level concern) | The same `uid` arrives twice, for any reason (network retry, buggy client, replay attack) | Idempotency check (§7) recognizes the `uid`, does not re-apply | No duplicate business effect, ever | No |
| 12 | Cloud temporarily unavailable | Fully operational (Principle 1, Principle 8) | Flush cycle attempts fail, retry with backoff (§Q) | N/A — unavailable | Outbox/inbox both stay pending until the cloud recovers, then catch up like scenario 9 | No |

---

## 25. Security review

| Concern | Design answer |
|---|---|
| **Device authentication** | Enrollment-issued credential, not a shared secret; every request authenticated per-device, not per-organization (§17) |
| **Sync authentication** | Same credential as device authentication — sync is not a separate identity from the device itself |
| **Organization isolation** | The cloud resolves `organization_id` from the authenticated device's own enrollment record, never from the request payload — mirrors `getCurrentOrganizationId()`'s local pattern exactly (§17). A compromised device can act only as its own organization |
| **TLS** | Assumed mandatory for every sync request; the existing `main/services/cloud-sync.ts` already only speaks HTTPS (`normalizeCloudServerUrl` rejects non-HTTPS except explicit local-dev URLs) — the new sync engine should hold the same bar, no exception |
| **Signatures/tokens** | Bearer-style device credential per request (§17, §21); whether it's a rotatable secret or an asymmetric signature is an implementation choice deferred to SYNC-G, not decided here — either satisfies "the cloud can verify this request really came from this device" |
| **Replay protection** | Idempotency (§7) already prevents a replayed event from having a *duplicate effect*; a genuine replay attack (an attacker capturing and resending a legitimate device's traffic) is a transport-layer concern TLS already mitigates (nothing to capture in plaintext), and the credential's own expiry/rotation (SYNC-G) bounds how long a captured credential would remain useful even if TLS were somehow defeated |
| **Event identity** | Every event's `uid` is globally unique (ULID) and immutable once assigned — nothing about accepting or rejecting an event can be confused by a colliding or reused id |
| **Authorization** | Sync itself is not a new authorization surface — it transmits *facts already authorized locally* by `AuthorizationService`/`FeatureService` (Milestones 7–8) at the moment they were created. The cloud does not need to re-authorize "was this cashier allowed to create this sale" (already enforced locally, before the fact ever reached the outbox) — it only needs to authorize "is this device allowed to submit facts for this organization" (§17), a much narrower, transport-level question |
| **Assume the device could be compromised** | The entire design already assumes this as a baseline, not an afterthought: organization/location identity is never taken from payload (§17, repeatedly cross-referenced), a compromised device can forge facts *about its own organization* (a real risk, bounded by needing physical/credential access to that specific till) but categorically cannot forge facts about a *different* organization, because the server-side identity resolution has no path for a payload to claim one |

**What a compromised device *can* still do, honestly stated:** create
fraudulent sales/refunds/inventory adjustments *for its own organization*
— the same thing a malicious employee with physical till access could
already do today, locally, with no sync involved. Sync does not introduce
this risk; it does not meaningfully increase it either, since every fact
sync transmits was already possible to create locally by definition
(sync transmits facts, it does not grant new capabilities). The
observability model (§19) and audit event stream (already `SYNCED`,
already append-only) are the intended detection mechanism for this class
of risk, consistent with how the local audit trail already serves that
purpose today.

---

## 26. Risk register

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| R-1 | Name collision between the new sync engine and the existing, unrelated `main/services/cloud-sync.ts`/`cloud_sync_outbox` (FloAdmin bridge) | Medium — implementation confusion, not a correctness risk if avoided | Use clearly distinct names (`main/core/sync.ts`, `sync_outbox`/`sync_inbox`/`sync_state`) from the first line of code; call this out explicitly in the eventual implementation milestone's own doc, not just this one |
| R-2 | Shipping sync against the current payment dual-write (§22 #1) before it's retired | High — would produce silently incomplete payment sync | SYNC-0 is sequenced first in §23 specifically to prevent this |
| R-3 | Integer-PK/uid seam on orders/bills causing incorrectly-linked payments/refunds across devices | High if skipped, low effort to fix | SYNC-0, §22 #2 |
| R-4 | Two hard-deletes (transfer/PO line removal) on entities that will sync | Low (mitigated today by `requireDraft()`) but real | Convert to tombstones in SYNC-0, §22 #5 |
| R-5 | Device credential storage doesn't exist yet | Blocks SYNC-G entirely until added | Explicit schema item, §22 #4 |
| R-6 | Clock skew across till hardware, if ever trusted for ordering/versioning | Medium if mishandled | Explicitly not trusted anywhere in this design — device-local sequence (§8) and server-stamped `updated_at` (§16) are both immune to device clock skew by construction |
| R-7 | Unbounded outbox growth if a device is offline for a very long time and the merchant doesn't notice | Low probability, medium impact (large sync burst, possible timeout on first reconnect) | §20's batching already handles large backlogs incrementally; §19's observability (pending count) is the detection mechanism for a merchant/support noticing a stuck device before the backlog becomes extreme |
| R-8 | A future entity (e.g. cash sessions) gets built as a mutable row instead of event-sourced, repeating the sales/bills mistake | Medium, preventable | §22's explicit recommendation to build new entities sync-ready from their first migration |
| R-9 | Cloud-side `organization_id` indexing/partitioning treated as a later optimization instead of a day-one requirement | Medium at scale (§20) | Called out explicitly in §20 as a from-day-one requirement, not deferred |
| R-10 | Inventory's "allow negative stock" policy surprising a merchant who expects a hard block | Low-medium, a training/UX question more than an architecture one | Already the existing single-till local behavior (Milestone 4); sync extends a policy merchants are already operating under today, not introducing a new one |

---

## Q1. Is the current Flo/Plemmo local architecture suitable for offline-first sync?

**Yes, largely — with two specific, well-scoped exceptions (§22 #1, #2).**
The organization/location/register/device hierarchy, the ULID identity
scheme, the movement-based inventory ledger, the append-only payment-event
and audit-event logs, the existing local idempotency pattern, and the
server-side-only resolution of sensitive context are all already built
the way a sync engine needs them — not coincidentally, but because
Milestones 2–8 were explicitly building toward this. The exceptions are
narrow (a JSON blob payment path, an integer-PK identity seam) and already
flagged in the codebase's own comments as exactly the kind of thing a
future sync milestone would need to address — this document did not
discover a hidden architectural flaw so much as confirm and formalize
gaps the codebase already knew about itself.

## Q2. What is the biggest architectural risk?

**The payment dual-write (§22 #1, R-2).** Every other gap identified is
either additive (new tables, a credential column) or narrow and low-risk
(two guarded hard-deletes). The dual-write is the one place where *shipping
sync as designed against the current state* would produce a genuinely
misleading result — a sync engine that appears to work (uploads real
payment_events for `tender()`'s callers) while silently missing whatever
volume of real merchant payments still flows through
`bills.payment_details`. This is a risk of *false confidence*, the worst
kind, not a risk of an obvious failure.

## Q3. What must change BEFORE implementing sync?

In priority order: (1) retire or complete the payment dual-write, (2)
promote `uid` to a load-bearing sync identity on orders/order_items/bills
and give payments a matching `bill_uid`/`order_uid`, (3) convert the two
hard-deletes on transfer/PO line items to tombstones, (4) backfill/tighten
`organization_id` non-nullability on the handful of tables where it's
currently optional. All four are captured as SYNC-0 in the roadmap (§23)
and are valuable independent of whether sync ships next quarter or next
year — none of them is sync-specific busywork.

## Q4. What can remain unchanged?

Everything else in §2's classification table — which is most of the
domain. Specifically: the entire organization/location/register/device
model, `SaleService`/`PaymentService`/`InventoryService`/`TransferService`/
`PurchaseOrderService`'s own business logic and validation (sync
*duplicates* their validation server-side per Principle 7, it does not
replace or rewrite it), `AuthorizationService`/`FeatureService` (sync
transmits facts already authorized by these, it is not a new
authorization layer), the ULID scheme, `audit_events`, `payment_events`,
`inventory_movements`, and the local idempotency pattern that the
cloud-side design directly extends.

## Q5. What sync model would you personally choose?

The outbox/inbox model with per-device sequence numbers and cursor-based
pull, exactly as designed in §4–§8 — chosen specifically because it lets
every existing `withTxn()` call site gain sync durability with one
additional statement, rather than requiring a parallel change-tracking
mechanism (CDC) or a fragile assumption about clock-synchronized
timestamps (polling). It is also, concretely, a pattern this codebase
already runs successfully for an unrelated purpose (`CloudSyncService`),
which is a real signal about fit, not just a theoretical preference.

## Q6. How should inventory conflicts work?

They shouldn't be modeled as conflicts at all (§10) — every
`inventory_movements` row is an independent, commutative fact, and the
derived balance is simply the sum of whatever facts have been applied so
far, in any order. Overselling while offline is allowed (extending the
existing single-till "soft warning, not a hard block" policy across
devices, not inventing a new policy) and surfaced as a negative-stock
alert for the merchant to act on, rather than something the sync engine
tries to prevent or silently resolve.

## Q7. How should duplicate events be handled?

Server-side idempotency keyed on the event's own globally-unique `uid`
(with `device_id` as defense-in-depth), directly extending the
`(user_id, idempotency_key)` → cached-response pattern already proven
locally by `payment_idempotency_scoped`/`order_idempotency_scoped` (§7).
A retried upload gets back the same ACK it would have gotten the first
time, never a duplicate business effect.

## Q8. What should the cloud be authoritative for?

Organization identity/billing, device enrollment/authentication, feature
entitlements (once licensing exists), and the merge outcome for
`SYNCED`/`LWW` entities (products, customer profiles, locations/registers)
when two offline edits genuinely collide. Not authoritative for anything
that already happened locally as a fact — a completed sale, a recorded
payment, an inventory movement, a refund the device had grounds to create
— those are never overruled by the cloud, only recorded and reconciled
(§9's table draws this line entity by entity).

## Q9. What should the local POS be authoritative for?

Every business transaction as it happens: sale creation, payment capture,
inventory movement, refund creation (against a locally-known payment),
transfer initiation, staff authentication (password/PIN hashes are
local-only, always, by design — §2). The local device is also
authoritative for its own physical/device-scoped settings, which
deliberately never sync at all.

## Q10. How would this scale to 3,000 merchants?

Comfortably, on the estimate in §20 (~36M events/month, ~6,000 registers)
— provided the one architectural precondition called out there is
actually followed: `organization_id`-first indexing/partitioning on the
cloud side from the very first migration, not retrofitted after the fact.
Nothing else in this design has a bottleneck that appears specifically at
the 3,000-merchant tier rather than gradually across the whole range in
§20's table; the batching behavior the outbox already provides is what
keeps request volume (as opposed to row volume) from becoming the binding
constraint.

## Q11. What would make you reject this architecture and redesign it?

Three concrete signals, none of which this audit found evidence of today:
(1) discovering that a currently-`SYNCED` or `STATEFUL_SYNCED` entity
actually needs true concurrent multi-writer field-level merging beyond
LWW — e.g. if customer wallet balances turned out to need arbitrary
concurrent decrement/increment beyond what the append-only-ledger model
in §9 already handles — which would suggest CRDTs or a different
conflict model are needed after all; (2) discovering that inventory
correctness genuinely requires cross-device reservation/locking for a
real business reason this design didn't anticipate (e.g. a merchant
segment where overselling is unacceptable even briefly) — which would
require rethinking §10's "allow negative stock" policy into something
closer to true distributed locking, a materially harder problem; (3)
discovering that "no global ordering" (§8) actually breaks some workflow
this audit didn't identify — in which case the entity-dependency-ordering
model would need to grow into something closer to a full causal/vector
clock scheme. None of these appeared in this audit of the actual
codebase; if a future implementation phase discovers one, that is the
signal to stop and redesign that specific section, not the whole
architecture.

## Q12. What is the safest implementation sequence?

Exactly §23's roadmap: fix the foundation first (SYNC-0, entirely
independent of any sync code and valuable on its own), prove the
mechanism on the lowest-risk entity (SYNC-A, inventory movements — already
append-only, already free of the dual-write problem), build and test the
transport in isolation (SYNC-B/C/D, against a stub if a real cloud isn't
ready yet), then extend to every other entity one at a time in order of
increasing complexity (SYNC-E), then harden and observe (SYNC-F/G/H/I).
Every stage is independently testable, and no stage requires guessing at
a later stage's unresolved design questions.

---

## See also

- [`PLEMMO_ARCHITECTURE.md`](./PLEMMO_ARCHITECTURE.md) §3 (Core module
  table), §7 (Offline and synchronisation — this document supersedes that
  section's "not yet true" list with a concrete design), §12 (roadmap)
- [`MILESTONE_6_MULTI_LOCATION.md`](./MILESTONE_6_MULTI_LOCATION.md) §16
  (Future sync implications) — the earliest version of this thinking,
  now made concrete
- [`MILESTONE_2_CORE_ENGINE.md`](./MILESTONE_2_CORE_ENGINE.md) — the
  payment dual-write this design depends on retiring (§22 #1)
- `main/core/authorization.ts`, `main/core/features.ts`, `main/core/
  context.ts`, `main/core/location.ts` — the server-side-identity-
  resolution pattern §17's device authentication model extends to the
  cloud boundary
- `main/services/cloud-sync.ts` — the existing, unrelated FloAdmin
  outbound bridge referenced throughout as prior art for the outbox
  pattern, and as the specific naming collision to avoid (§1, R-1)

---

**STOP AFTER THE DESIGN REPORT.** No code, migrations, dependencies, or
schema were created or modified as part of this milestone.
