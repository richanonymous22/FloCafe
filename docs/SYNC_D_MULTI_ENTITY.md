# SYNC-D — Real PostgreSQL + Multi-Entity Sync

Takes the SYNC-C foundation from "production-shaped" to "proven against real
infrastructure," and generalizes the sync seam from one entity to three:
`inventory_movement`, `audit_event`, `payment_event` — all through one
protocol, one outbox, one per-organization cloud feed.

Read alongside [`SYNC_C_PRODUCTION_FOUNDATION.md`](./SYNC_C_PRODUCTION_FOUNDATION.md),
[`SYNC_B_CLOUD_TRANSPORT.md`](./SYNC_B_CLOUD_TRANSPORT.md), and
[`cloud/DEPLOYMENT.md`](../cloud/DEPLOYMENT.md).

**Status: complete.** Only these three append-only entities sync; sales,
products, customers, suppliers, POs, transfers, refunds do NOT.

---

## Proven in REAL infrastructure vs TESTED LOCALLY / SIMULATED

The milestone requires these be kept distinct. `tests/sync-d-production.test.ts`
runs against a REAL PostgreSQL 16 server and the REAL HTTP API.

| Capability | Level of proof |
|---|---|
| Cloud persistence (insert/pull/idempotency) | ✅ **REAL PostgreSQL** |
| Migration runner (create schema, indexes, UNIQUE constraint) | ✅ **REAL PostgreSQL** |
| Concurrent per-org feed sequencing (5 real parallel connections, ×3 runs) | ✅ **REAL PostgreSQL** |
| Duplicate race → one fact; transaction rollback leaves no partial | ✅ **REAL PostgreSQL** |
| Per-org isolation; multi-entity ordering; deficit workflow | ✅ **REAL PostgreSQL** |
| Ed25519-authenticated HTTP upload/pull, enrollment, security spoofs, worker | ✅ **REAL HTTP over REAL PostgreSQL** (async server) |
| Local outbox emission for audit/payment; remote apply; loop prevention | ✅ real SQLite + real HTTP |
| Production **deployment** to a hosted provider | ⚠️ **NOT executed** — no managed-PG credentials; validated on local PG; deployment procedure documented |
| **Windows** DPAPI key storage on a real Windows box | ⚠️ **NOT executable here** (headless Linux). Real-`safeStorage` validation script provided: `scripts/validate-windows-key-storage.cjs`. The Linux/CI path is proven with an injected safeStorage; DPAPI itself must be validated on Windows. |

---

## Part A — SYNC-C audit (before changing anything)

| Subsystem | Classification (pre-SYNC-D) | Action taken |
|---|---|---|
| `SqliteCloudStore` | WORKING; TESTED (SQLite) | Generalized to a `cloud_events` multi-entity feed; kept inventory wrappers. |
| `PostgresCloudStore` | WORKING; **TESTED ONLY WITH FAKE PgClient** | **Now TESTED AGAINST REAL POSTGRES**; generalized to multi-entity. |
| Cloud feed sequencing | WORKING; concurrency **only reasoned** | **Proven under real concurrency** (5 parallel connections, gapless). |
| `sync_outbox`/`sync_inbox`/`sync_state` | WORKING; TESTED | Already generic (entity_type column) — reused unchanged. |
| `HttpSyncTransport` / `downloader` / `remote-apply` | WORKING; TESTED (inventory only) | Generalized to dispatch by entity_type; audit/payment apply added. |
| Device identity / enrollment / signing | WORKING; TESTED | Enrollment made async-safe; enrollment now logged as an auditable cloud event. |
| Nonce/replay, org isolation | WORKING; TESTED | Re-audited & re-tested against real PG. |
| Inventory deficit detection | WORKING; TESTED | Added a status lifecycle (open→acknowledged→resolved) + query API. |
| Env config / health / worker | WORKING; TESTED | Worker now drives all three entity types; per-entity failure isolation. |
| The server's sync-vs-async seam | KNOWN LIMITATION | **Removed**: the server + auth + enrollment are async-capable, so ONE server runs over sync SQLite (dev) and async Postgres (prod). |

---

## Part B — Real PostgreSQL setup

PostgreSQL 16 (local cluster) is used for integration testing; Docker was not
required. `cloud/migrate.ts` is a real forward-only migration runner that
applies `cloud/migrations/postgres/*.sql`, tracking `cloud_schema_version`,
each file in its own transaction. `cloud/run-migrations.ts` is the production
CLI entrypoint. Proven against real PG: schema/index/constraint creation,
transactions, `UNIQUE(entity_type, entity_uid)` idempotency, per-org sequence
allocation, duplicate handling, rollback (test §1–3).

## Part C — Real concurrency proof

Five devices upload **concurrently** using real parallel pool connections;
the per-org feed is a gapless `1,2,3,4,5` with no duplicate, gap, or lost
event — repeated across three independent runs. A second organization has an
independent sequence starting at 1 (test §4–5). There is no global all-tenant
sequence. Concurrency is safe because each `storeEvent` runs in one
transaction and the per-org `cloud_feed_sequence` row is bumped with
`UPSERT … RETURNING`, so concurrent transactions serialize on that row.

## Part D — Real failure/rollback proof

A concurrent 6-way duplicate upload yields **exactly one** business fact — the
`UNIQUE(entity_type, entity_uid)` constraint makes the losing transactions
roll back entirely (including their feed-sequence bump), so there is no
partial row and no wasted gap. An explicit `BEGIN … INSERT … ROLLBACK` leaves
no row (test §3, §6). Isolation: READ COMMITTED (default); correctness does
not depend on a stricter level because idempotency is enforced by the UNIQUE
constraint and ordering by the serialized per-org counter.

## Part E — Production database decision

**Managed PostgreSQL** — see [`cloud/DEPLOYMENT.md`](../cloud/DEPLOYMENT.md)
for the full comparison (managed vs VPS vs Supabase vs NoSQL) and the
deployment procedure. **Deployment was NOT executed**: no hosted credentials
were available. The adapter, migrations, and async server are complete and
proven on real local PostgreSQL; the single remaining step is provisioning the
instance and setting `PLEMMO_CLOUD_DB_URL`.

## Part F — Device enrollment

Production enrollment (`POST /sync/v1/enroll`): a one-time, HASHED,
org/location/register-scoped activation token is issued out of band and
atomically consumed; the device binds to the token's identity, never its own
claim; the private key never leaves the device. Enrollment is recorded as an
auditable cloud event (`cloud_sync_log kind='enrolled'`). Rotation and
revocation exist (SYNC-C). Dev-enroll stays gated off. Proven over real HTTP
against Postgres (test §10).

## Part G — Windows secure key storage

`SafeStorageKeyStore` encrypts the private key with Electron `safeStorage`
(Windows **DPAPI** / macOS Keychain / libsecret); production **fails closed**
without it; the dev `FileKeyStore` path is preserved. **This environment is
headless Linux and cannot exercise Windows DPAPI** — that is reported honestly,
not claimed as tested. `scripts/validate-windows-key-storage.cjs` runs under
real Electron on the target OS and validates generation, ciphertext-at-rest,
restart round-trip, signing, rotation, revocation, and fail-closed. Run it on
a Windows machine before go-live.

## Part H — Background worker

The worker now drives all three entity types in one tick (upload batch → acks →
pull → inbox → apply → cursor), with backoff, restart recovery, re-entrancy
guard, and clean shutdown (SYNC-C). A failure applying one event marks only
that inbox row failed and never discards unrelated pending events (per-event
isolation, Part Q). Proven draining inventory+audit+payment over real HTTP to
Postgres (test §11). The POS remains fully usable offline.

## Part I — Audit event sync

Authoritative identity: `audit_events.id`. `recordAuditEvent` enqueues a typed
`audit_event` outbox row in the same connection (best-effort — never breaks
auditing). Remote audit events are applied via a RAW insert into local
`audit_events` (idempotent by id, marked `sync_origin='remote'`) — never
through `recordAuditEvent`, which would re-enqueue them (the loop). Proven
upload→pull→apply with loop prevention (test §12).

## Part J — Payment event sync

Authoritative identity: `payment_events.id`; `payment_uid` links to the
`payments` row (Payment Cutover). Each `payment_events` insert in
`main/core/payment.ts` enqueues a typed `payment_event` (best-effort, same
txn). **Not synced:** `bills.payment_details`, `paid_amount`, `balance`,
derived `payment_status`. Remote payment events are applied into the FK-free
`remote_payment_events` mirror (migration v87) — the authoritative
`payment_events` FKs to a local `payments` row that does not exist for another
device's payment. Payment business behaviour is unchanged.

## Part K/M — Multi-entity outbox contract

One outbox (`entity_type`, `entity_uid`, `uid`, `sequence`, `payload`), one
transport, one inbox, one `applyRemoteEvent` dispatcher, one server entity
registry. Idempotency, ordering, transaction atomicity, and retry are shared
across all three entities. No per-entity sync engines.

## Part L/N — Cloud feed ordering (deliberate choice)

**One per-organization feed spanning all entity types**, ordered by a single
per-org `feed_seq`. Chosen over per-entity-type partitioning so the client has
ONE cursor and ONE deterministic order, and cross-entity causality within an
org is preserved. There is **no** global all-tenant sequence. Contract is
deterministic and proven (test §7).

## Part P — Security

Cloud identity is derived from the authenticated device — `organization_id`,
`location_id`, `device_id`, and actor are never trusted from the payload.
Tested against the Postgres-backed API: org spoof rejected, tampered signature
rejected, replay rejected (nonce store in Postgres), revoked device rejected;
plus (SYNC-C, SQLite HTTP) location spoof, malformed/oversized payload,
cross-org pull. Coarse client auth reasons; per-device rate limiting; nonce
pruning; TLS required in production.

## Part O — Failure recovery

Crash mid-upload (stalled `uploading` recovered), crash between inbox-persist
and apply (reapplied), cloud unavailable (POS records locally, backlog waits),
network loss (pending), lost-ACK (dedup), key revoked/rotated, stale/own-tail
cursor — all covered by the SYNC-C suite; the multi-entity worker + real-PG
paths are covered by the SYNC-D suite.

## Part Q — Tests

`tests/sync-d-production.test.ts` — 43 checks against **real PostgreSQL + real
HTTP** (self-skips if no PG). SYNC-0/A/B/C suites (45/52/42/80) remain green.
Regression across audit, payment, schema-health, upgrade-path confirmed.

## Part R — Regression / business behaviour

Unchanged: stock enforcement, sale/payment/purchasing/transfer logic,
hospitality, retail, authorization. Audit/payment sync is additive, best-effort,
and in-transaction; it never alters business outcomes.

## Part S — Observability

Cloud `cloud_sync_log` carries `entity_type`; `observabilityByEntity()` and
`organizationHealth()` report accepted/duplicate/rejected per entity, device
last-seen/last-sync, deficits/open-deficits, and per-entity counts. Local
`getSyncHealth()` unchanged. No Admin UI — internal APIs only.

## Part T — Migrations

Local: additive v87 (`remote_payment_events`) only — no existing-data risk.
Cloud: independent, versioned SQL in `cloud/migrations/postgres/`, applied by
the runner, never by the desktop app.

## Known limitations

1. Only inventory/audit/payment events sync.
2. Production cloud **not deployed** (no hosted credentials) — proven on local PG.
3. Windows DPAPI validated only by a script to run on Windows, not here.
4. `remote_payment_events`/remote audit rows are a local mirror; a consolidated
   Admin view is future work.
5. Rate limiting is per-instance; a multi-instance deploy needs a shared limiter.
6. Deficit **resolution actions** are status-only; an operator workflow/UI is later.

## Recommended next bundled milestone

**SYNC-E — Deploy + sales/orders sync foundation:** stand up managed Postgres
(execute the deployment), run the Windows DPAPI validation on real hardware,
add the Admin token-issuance + device/deficit console APIs, then extend the
proven multi-entity seam to sales/orders with an explicit conflict model
(the first non-append-only entity).
