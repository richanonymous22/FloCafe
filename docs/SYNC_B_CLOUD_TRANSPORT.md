# SYNC-B — Real Cloud Transport for Inventory Movements

The first real cloud communication: `inventory_movements` (and only that
entity) travel local → HTTPS → Plemmo Sync API → cloud persistence → ACK →
local outbox acked, and cloud → pull/cursor → local inbox → local apply.
Everything else in the application is untouched.

Read alongside [`SYNC_A_LOCAL_FOUNDATION.md`](./SYNC_A_LOCAL_FOUNDATION.md)
(the local mechanism this builds the transport for),
[`MILESTONE_9_SYNC_ARCHITECTURE.md`](./MILESTONE_9_SYNC_ARCHITECTURE.md) and
[`MILESTONE_9A_SYNC_REVIEW.md`](./MILESTONE_9A_SYNC_REVIEW.md) (the design and
its review).

**Status: complete.**

---

## Part A — Current infrastructure audit

Done before any implementation, per the milestone's instruction.

### 1. What exists

| Area | State |
|---|---|
| Backend runtime | Node ≥22 inside Electron 43; the API is a plain Express app (`main/server.ts` builds it, `app.listen(3001)`). A second Express app runs the KDS server (`main/kds-server.ts`, port 3002). So **Express + `better-sqlite3` is the established server stack.** |
| HTTP server pattern | `express()` + route modules mounted under `/api/*`, JWT bearer auth middleware, `requireRole`/`requirePermission` gates. |
| Auth patterns | Staff auth is JWT (login → bearer token). Separately, **Ed25519 signing already exists in-repo** for tax-pack verification (`main/tax-packs/catalog.ts` uses `crypto.verify(null, data, publicKey, sig)`), so Node's Ed25519 support and the exact sign/verify idiom are already proven here. |
| Config/env | `process.env.PORT`-style env reads (`main/server.ts`). No config framework; plain env vars + the `settings` table. |
| Cloud code | `main/services/cloud-sync.ts` — the **FloAdmin/"Blue" vendor bridge**, disabled by default since migration v67 (`plemmo_disconnect_upstream_services`). Unrelated to Plemmo's own sync. |
| Supabase/Vercel/Postgres | **None present.** No `createClient`, no `pg`, no serverless config. A genuinely clean choice. |
| DB utilities | `better-sqlite3` (WAL, synchronous), a mature migration system (`user_version`, 86 migrations), `withTxn`. |
| CORS/security | CORS config, rate limiting (`main/middleware/security.ts`), request-size limits on the local API. |
| SYNC-A foundation | `sync_outbox`/`sync_inbox`/`sync_state`, per-device sequence, `SyncTransport` interface, `uploadPendingBatch`, `device_credentials` (SYNC-0, public-key-only). |

### 2. What is reusable

- **Express + better-sqlite3** — the cloud dev server reuses exactly this
  stack, so no new runtime/infra is introduced.
- **The Ed25519 sign/verify idiom** from tax-packs — reused for device
  request signing.
- **The `SyncTransport` interface** (SYNC-A) — the real HTTP transport is a
  drop-in for the mock; nothing else in the local sync layer changes.
- **`device_credentials`** (SYNC-0) — the public-key + lifecycle store; the
  cloud's device registry mirrors its shape.
- **`sync_outbox`/`sync_inbox`/`sync_state`** — upload reads the outbox;
  download writes the inbox and advances `sync_state.last_download_cursor`.

### 3. What is unrelated legacy code

`main/services/cloud-sync.ts` (FloAdmin bridge) — **explicitly not touched,
not extended, not imported** by any SYNC-B code. Its `cloud_sync_outbox`
table and naming remain a deliberate no-go (9A review R-1). SYNC-B lives in
`cloud/` (the server) and `main/core/sync/` (the client), never in
`services/cloud-sync.ts`.

### 4. What infrastructure is required

- A cloud HTTP service exposing `POST /sync/v1/upload` and
  `GET /sync/v1/pull`, authenticating devices by signed request and
  persisting inventory-movement facts with per-organization isolation and
  idempotency.
- A device registry (which public key belongs to which org/location).
- A provider-neutral storage seam so the concrete database is an
  implementation detail.

### 5. What is still undecided (documented, per Part V)

**The final production cloud infrastructure is deliberately left
undecided.** SYNC-B ships a **provider-neutral cloud boundary** (`CloudStore`
interface) with a **SQLite-backed development implementation**
(`SqliteCloudStore`) — the "temporary development deployment architecture"
the milestone permits. The storage engine sits entirely behind the
interface, so a future Postgres/Supabase/VPS/custom implementation is a
drop-in with **no change to the sync protocol or the local client**. This
milestone deliberately does **not** pick Vercel or Supabase. The local POS
only ever speaks the HTTP sync protocol; it has no knowledge of what backs
the cloud.

**No STOP condition was triggered by the audit:** device auth is
implementable with Ed25519 signed requests (no security hole), organization
isolation is guaranteed by server-side identity resolution, cursor/inbox
atomicity reuses SYNC-A's single-transaction pattern, loop prevention has a
clean dedicated remote-apply path, the cloud storage model is keyed to
prevent duplicate facts, the chosen infra reuses the existing stack (no
redesign), and no inventory behavior changes.

---

## Part B — Provider-neutral cloud boundary

```
  Local POS                          Cloud (dev: SQLite; prod: undecided)
  ─────────                          ────────────────────────────────────
  SyncTransport (interface)          Express /sync/v1/*  (cloud/server.ts)
     ├─ MockTransport   (SYNC-A)          │
     └─ HttpSyncTransport (SYNC-B) ─HTTPS─┤ verifies device signature
        signs each request                │ resolves org/location server-side
                                          ▼
                                    CloudStore (interface)  ← provider-neutral
                                          └─ SqliteCloudStore (dev impl)
```

The local `HttpSyncTransport` contains **no** Supabase/Vercel/Postgres/
SQLite-specific logic — only the HTTP sync protocol (sign, POST/GET, parse
the typed response). The cloud may use any backend internally.

*(Parts C–Z are documented at the end of this file, after the implementation
sections, to keep the audit — the milestone's required first deliverable —
at the top.)*

---

## Part C — Cloud data model

`cloud_inventory_movements` stores the business fact, not a SQLite row dump:
`event_uid` (PK), `movement_uid` (UNIQUE — the idempotency key),
`organization_uid`, `location_uid`, `device_uid`, `device_sequence`,
`feed_seq` (cloud cursor position), `movement_type`, `product_uid`,
`variant_uid`, `quantity_delta`, `unit_cost`, `reason`, `reference_type`,
`reference_uid`, `actor_uid`, `metadata`, `created_at` (device fact time),
`received_at` (cloud receipt time). Deliberately **not** stored: local
SQLite integer ids, `products.stock_quantity`, or derived balances — the
cloud recomputes any balance from the movement stream, exactly as the local
side does. Supporting tables: `cloud_devices` (registry), `cloud_feed_sequence`
(per-org cursor allocator), `cloud_nonces` (replay), `cloud_sync_log`
(observability).

## Part D — Cloud idempotency

`UNIQUE(movement_uid)`. `storeMovement()` checks for an existing
`movement_uid` inside a transaction and returns `duplicate` without creating
a second fact or allocating a new feed position. The device's stable outbox
`event_uid` and `movement_uid` mean a retried upload (after a lost ACK)
carries the same identity and is deduped. Proven over real HTTP (test §3,
§10): re-uploading an already-stored movement returns it as `duplicate`
(an idempotent success the client acks), and the cloud row count stays at 1.

## Part E — Device authentication

Ed25519 signed requests. The device generates a keypair
(`device-identity.ts`); the **private key is a local file with 0600 perms,
never in any database** (SYNC-0 Part O) — the DEV/TEST store, with production
using OS keychain/DPAPI (out of scope, clearly marked). The public key is
enrolled with the cloud via a **DEV/TEST-only** `POST /sync/v1/dev/enroll`
(gated behind `enableDevEnroll`, never exposed in production; the real
merchant/admin enrollment flow is a later milestone). Every `/upload` and
`/pull` request is signed over a canonical string (method, path+query,
timestamp, nonce, body hash); the cloud verifies against the registered
public key and resolves org/location from the device record. A payload
claiming a different `organization_id` cannot change who the cloud believes
the caller is.

## Part F — Organization / location security

The cloud validates each incoming movement against the **authenticated**
device: the event's org (if the payload states one) must equal the device's
registered org, and — for a location-bound device — its location. Mismatches
are rejected (`category: 'auth'`) and logged. The stored `organization_uid`
is always taken from the device record, never the payload. Pull returns only
the device's own organization's events. Proven (test §4-5): a device
enrolled to `org-attacker` signing a movement whose payload claims the
victim org is rejected with `organization mismatch`, and nothing lands in
the victim org.

## Part G — Upload API

`POST /sync/v1/upload`, authenticated, batched, returning **per-event**
results: `{ accepted: [...], duplicate: [...], rejected: [{uid, reason,
category}] }` — never a single opaque 200. `category` distinguishes
`permanent` (malformed/unsupported) from `auth` (isolation) so the client
and future milestones classify correctly.

## Part H — Batch behavior

`uploadPendingBatch` (SYNC-A) selects pending events **in sequence order**,
sends one batch, acks `accepted ∪ duplicate`, marks `rejected` failed, and
returns transiently-failed events to pending. Max batch 500; the test uses a
small batch. Proven (test §17-18): five movements upload in one request in
sequence order.

## Part I — Pull API

`GET /sync/v1/pull?cursor=&limit=`, authenticated. Returns the caller's
organization's events with `feed_seq > cursor`, ascending, **excluding the
caller's own uploads** (a SYNC-B simplification — a device already holds its
own movements). A device never receives another organization's events.

## Part J — Cursor implementation

Download persists the inbox batch and advances
`sync_state.last_download_cursor` in **one transaction**; apply is a separate
transaction per row (Part K). The cursor is the cloud `feed_seq`. Proven
(test §13): forcing the cursor write to fail leaves neither the inbox rows
nor the cursor advanced — they are atomic — and a subsequent normal pull
recovers and applies the event.

## Part K — Inbox application

`applyRemoteInventoryMovement()` records the remote fact locally: inserts the
movement (preserving its uid), adjusts `inventory_balances` by the delta,
marks `metadata.sync_origin = 'remote'`, and is idempotent by `movement_uid`.
It does **not** touch `products.stock_quantity` and does **not** go through
`recordMovement()`.

## Part L — Loop prevention

The remote-apply path has **no outbox append at all** — that is the loop
prevention. A movement pulled from the cloud and applied locally produces no
outbound sync event, so it is never sent back. Proven (test §11-16): a
movement created by device A2, uploaded, pulled here, and applied leaves the
outbox row count unchanged and creates no `sync_outbox` row for that
movement uid.

## Part M — Cloud sequence / cursor

Two distinct concepts, deliberately not conflated: the **device upload
sequence** (per-device, allocated locally in SYNC-A, for upload ordering/gap
detection) and the **cloud feed cursor** (`feed_seq`, per-organization,
allocated by the cloud on receipt, for download ordering). Pull is
deterministic per organization by `feed_seq`; no global cross-merchant
ordering is attempted.

## Part N — Error taxonomy

- **TRANSIENT** — network error, timeout, 5xx, 413: `SyncTransportError`
  thrown → the batch returns to pending, retryable.
- **PERMANENT** — malformed / unsupported entity: `rejected` with
  `category: 'permanent'` → the event is marked `failed`, not retried.
- **AUTH** — unknown/revoked device, org/location mismatch, bad signature,
  stale timestamp, replayed nonce → 401 or `rejected` with `category:
  'auth'`. Upload-level auth failures throw (events stay pending, so a
  revoked device simply never acks); per-event isolation mismatches are
  `rejected`.
- **CONFLICT** — classified in the taxonomy for the future, but **no
  conflict-resolution engine is built** in SYNC-B (inventory movements are
  append-only facts; there is no state to conflict yet).

## Part O — Retry behavior

`uploadPendingBatch` is an explicit call (no autonomous loop in SYNC-B).
Transient failures return events to pending and increment
`sync_state.failure_count`; the caller retries on its own cadence. A minimal
background worker with backoff is deferred to a later milestone so it cannot
interfere with cashier operations. Recovery of stalled `uploading` events is
handled at the start of each upload (SYNC-A).

## Part P — Configuration

`getSyncCloudConfig()` reads `PLEMMO_SYNC_URL` from the environment (no
hardcoded production URL); sync is **off** unless a URL is set, keeping the
POS local-first. Dev/staging/production are selected purely by the env var.
No secret is read here or placed in a frontend bundle — only the base URL.

## Part Q — Observability

`cloud_sync_log` records `accepted` / `duplicate` / `rejected` /
`auth_failure` per device and organization; `store.observability()` returns
counts. Latency and last-seen can be derived from the log's timestamps. This
is server-side logging/metrics, not the (out-of-scope) Admin dashboard.

## Part R — Scale considerations

`organization_uid`-leading indexes on the feed (`idx_cloud_mov_feed`),
`movement_uid` UNIQUE for O(1) duplicate detection, per-organization cursor
lookup, and batched upload keep the dev implementation comfortable well past
1,000 merchants. Cross-merchant global ordering is deliberately avoided. The
provider-neutral store means the production backend (a real DB with the same
indexes) can scale further without touching the protocol or client. No
premature optimization for 100,000 merchants.

## Part S — Tests

`tests/sync-b-cloud-transport.test.ts` — 42 checks against a real local HTTP
server, covering all 19 mechanism items plus regression. No public internet.

## Part T — Failure scenarios

| Scenario | Local state | Cloud state | Recovery |
|---|---|---|---|
| Network dies during upload | events `uploading`→`pending` (recover) | nothing committed | retry next upload |
| Cloud commits but ACK lost | event still `pending` | fact stored once | retry → `duplicate` → acked (test §10) |
| Device restarts during upload | stalled `uploading` reset to `pending` | fact may/may not be stored | idempotent retry |
| Duplicate upload | acked on `duplicate` | one fact | no second fact (test §3) |
| Invalid credentials / bad signature | events stay pending | nothing stored | fix credential, retry |
| Revoked device | events stay pending, never acked | auth failure logged | re-enroll, retry (test §19) |
| Organization spoof | rejected | nothing in victim org | n/a — rejected (test §4-5) |
| Location spoof | rejected (`location mismatch`) | nothing stored | n/a |
| Cloud unavailable (5xx) | transient → pending | unchanged | retry with backoff |
| Malformed event | marked `failed` (permanent) | nothing stored | needs code fix, not retried |
| Cursor persistence failure | inbox+cursor roll back together | fact stored | re-pull applies (test §13) |
| Inbox apply failure | inbox row `failed`, cursor already advanced | fact stored | row retried on next pull cycle |
| Device offline for hours then reconnects | outbox accumulates | unchanged | batch upload drains backlog |

## Part U — Migrations

Cloud and local migrations are **separate concerns**. The local SQLite
migration system is untouched (no new local migration in SYNC-B — the
`sync_*` tables already exist from SYNC-A v86). The cloud has its **own**
schema management (`SqliteCloudStore.migrate()`); the desktop app never
executes cloud schema migrations.

## Part V — Deployment

The provider-neutral `CloudStore` with a SQLite dev implementation is the
"temporary development deployment architecture." **The final production
infrastructure is deliberately undecided** — not Vercel, not Supabase. A
future implementation of `CloudStore` (Postgres/managed/VPS) is a drop-in
with no protocol or client change. The sync client is provider-neutral.

## Part W — Build / lint

`tsc -p .` (main) and `tsc -p cloud/tsconfig.json` (cloud) both clean;
`eslint main/ cloud/` 0 errors; full `npm test` green.

## Part X — Known limitations

1. Only `inventory_movements` syncs (by design).
2. The cloud is a SQLite dev implementation; production infra undecided.
3. Enrollment is a DEV/TEST endpoint; the real merchant/admin enrollment
   flow and OS-keychain private-key storage are later milestones.
4. Cross-device balance reconciliation is simplified: remote apply adds the
   delta (seeded at 0), correct for the append-only ledger but full
   convergence semantics are future work.
5. No background worker/scheduler; uploads/pulls are explicit calls.
6. No conflict-resolution engine (not needed for append-only movements yet).
7. Pull excludes the device's own uploads (a device can't recover its own
   history from the cloud in SYNC-B).

## Part Z — Recommended SYNC-C

1. A minimal, non-interfering background sync worker with conservative
   backoff, wired to the Electron main process.
2. The real device enrollment flow + OS-protected private-key storage.
3. Extend `entity_type` coverage to the next append-only entity (audit
   events — near-zero-change), reusing this exact transport.
4. Begin the cross-device balance-convergence model and the negative-stock
   reconciliation flag from the 9A review (Issue 1/7).
5. Decide and stand up the production cloud backend behind the unchanged
   `CloudStore` interface.
