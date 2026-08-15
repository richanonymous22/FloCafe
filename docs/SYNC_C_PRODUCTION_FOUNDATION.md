# SYNC-C — Production Sync Foundation

Turns the SYNC-A/SYNC-B development sync into a **production-shaped**
synchronization foundation: a hardened cloud store behind a provider-neutral
seam, a production Postgres adapter + migrations, concurrency-safe per-org
feed sequencing, real device enrollment, OS-protected key storage, a
background worker, sync-health telemetry, and cross-till inventory deficit
detection — with the local POS behaviour and the wire protocol unchanged.

Read alongside [`SYNC_A_LOCAL_FOUNDATION.md`](./SYNC_A_LOCAL_FOUNDATION.md),
[`SYNC_B_CLOUD_TRANSPORT.md`](./SYNC_B_CLOUD_TRANSPORT.md),
[`MILESTONE_9_SYNC_ARCHITECTURE.md`](./MILESTONE_9_SYNC_ARCHITECTURE.md) and
[`MILESTONE_9A_SYNC_REVIEW.md`](./MILESTONE_9A_SYNC_REVIEW.md).

**Status: complete.** Still inventory-movements only — no other business
entity is synchronized (that is later bundled work).

---

## Part A — SYNC-B audit findings

Done before any change, per the milestone. The SYNC-B implementation was
correct for its scope; SYNC-C fixes the following real gaps found by
re-reading every module (`sync_outbox`, `sync_inbox`, `sync_state`, the
uploader/downloader, `remote-apply`, `cloud/server.ts`, `CloudStore`,
`device-identity`, request signing, the feed sequence, retry, observability).

| # | Finding | Severity | Fixed in SYNC-C |
|---|---------|----------|-----------------|
| A1 | **Pull cursor could stall.** `pullMovements` excluded the caller's own device and the server computed `next_cursor` from the *returned* (filtered) events. When the tail of the feed was the device's own uploads, `next_cursor` never advanced past them, so the client re-scanned the same window on every pull; and the downloader early-returned on an empty page without persisting any advance. | Efficiency / correctness | `pullMovements` now scans the raw window (all devices) and reports the **scanned** `nextCursor`; the downloader advances the cursor even on an empty page. |
| A2 | **`cloud_nonces` grew unbounded.** Replay nonces were recorded forever. | Resource leak | `pruneNonces()` deletes nonces older than the freshness window; called on every auth. |
| A3 | **Cloud API lacked rate limiting, emitted detailed auth reasons, and had no explicit body-error handling.** Detailed reasons (`unknown_device`, `bad_signature`) are a device-enumeration oracle. | Security | Per-device fixed-window rate limiter; **coarse** client reason (`unauthenticated`) with the detailed reason logged server-side only; JSON parse/size errors answered as 400/413 without a stack. |
| A4 | **Feed-sequence atomicity was implicit.** Correct in single-process SQLite (synchronous), but never proven under concurrency and undefined for a multi-process backend. | Correctness (latent) | Concurrency test (3 devices, overlapping uploads → gapless `1,2,3`); Postgres adapter uses `UPSERT … RETURNING` so concurrent txns serialize on the org row. |
| A5 | **Cross-till divergence undetected.** `remote-apply` seeds a remote fact's balance at 0; two offline tills selling the same stock leaves the cloud unaware of the global deficit (the 9A open issue). | Data integrity | Cloud stock projection + `cloud_inventory_deficits`: negative global balance is recorded as a fact — no sale reversed, no movement mutated. |
| A6 | **Not production-ready:** dev-only enrollment, plaintext `.pem` key, no worker. | Productionization | Token enrollment (Part D), safeStorage/DPAPI key store (Part E), background worker (Part F). |

No STOP condition was triggered (see §Stop-conditions at the end).

---

## Part B — Production cloud architecture

**Chosen backend: managed PostgreSQL.** Reasoned explicitly, not by
familiarity:

| Option | Verdict |
|--------|---------|
| **Managed PostgreSQL** (RDS / Cloud SQL / Supabase-Postgres / Neon) | **Chosen.** Transactional integrity and real per-org sequencing (`UPSERT … RETURNING` / sequences) give exact idempotency and gapless feed ordering; `UNIQUE(movement_uid)` is a hard idempotency backstop; automated backups + PITR; managed patching/failover; comfortably serves 3,000 merchants of append-only movement traffic. Operationally the simplest *reliable* option — no database servers to run. |
| VPS-hosted PostgreSQL | Same engine, but we own backups, patching, failover, disk, and monitoring. More operational burden for no correctness gain at this stage. Rejected for now; the adapter works against it unchanged if ever wanted. |
| Supabase | It *is* Postgres — usable via the same adapter and connection string. Its extra surface (auth, RLS, edge functions) is unneeded here and would couple us to a vendor. Treated as one managed-Postgres provider, not a distinct architecture. |
| DynamoDB / Firestore / other NoSQL | Rejected: per-org monotonic sequencing and multi-row transactional idempotency are awkward and error-prone without SQL transactions. |

The concrete engine sits entirely behind the **`CloudStore`** seam. The
desktop client speaks only the HTTP protocol and is unaffected by the choice.

### The one honest seam: sync vs async

The in-process dev store (`SqliteCloudStore`) is **synchronous** because
better-sqlite3 is synchronous; a real Postgres driver is **asynchronous**.
Rather than fake it, the production cloud runs as a **standalone async
service** and `PostgresCloudStore` is async. Method names and semantics mirror
the dev store one-for-one — same idempotency key, same per-org sequence, same
org isolation, same deficit projection — so the sync **protocol** and the
**local client** are untouched, which is the property the milestone requires.
`pg` is loaded lazily (`connectPg`) only when a production DB URL is set, so it
is not a build/test/lint dependency and tests never touch a real database or
the public internet.

---

## Part C — Cloud database & migrations

- **Schema:** `cloud/migrations/postgres/0001_init.sql` — devices, movements
  (`UNIQUE(movement_uid)`, `(organization_uid, feed_seq)` index), per-org
  `cloud_feed_sequence`, nonces (+ `seen_at` index), enrollment tokens, the
  stock projection + deficits, and the sync log.
- **Independence:** the cloud schema is *not* a translation of any local
  SQLite migration. Local and cloud schemas evolve separately.
- **Mechanism:** forward-only, additive SQL files; a `cloud_schema_version`
  row per applied file; an expand/contract deploy order (**migrate before
  rolling out code that needs it**).
- **Rollback:** additive DDL is data-preserving; a paired down-migration is
  written only when genuinely required.
- **Backups:** managed automated backups + point-in-time recovery.
- **The desktop app never runs cloud migrations** — it has no cloud DB handle
  and no cloud DDL; only the standalone cloud service migrates.

---

## Part D — Device enrollment

Domain chain: **Organization → Location → Register → Device → Credential**.
`cloud_devices` carries `register_uid`, `status`, `created_at`, `revoked_at`,
`rotated_at`, `superseded_by`, `last_seen_at`, `last_sync_at`.

Two clearly-separated paths:

- **Development** (`POST /sync/v1/dev/enroll`): the device posts its own
  org/location + public key; trusts the caller; **gated off** unless
  `enableDevEnroll` is set; never exposed in production.
- **Production** (`POST /sync/v1/enroll`, `cloud/enrollment.ts`): an operator
  issues a **one-time activation token** scoped to org/location/register (a
  future Admin action — no UI built here). The device presents the token + its
  freshly-generated **public** key. The cloud verifies the token is real,
  unexpired, and unused, **atomically consumes** it, and binds a device whose
  org/location/register come from the **token**, never from the device. Tokens
  are stored **hashed** (sha256), so a leaked DB yields no usable secrets. The
  private key never leaves the device.

---

## Part E — Windows secure key storage

`main/core/sync/key-store.ts` is the storage seam; `device-identity.ts` knows
nothing about where the bytes rest.

- **Production — `SafeStorageKeyStore`:** the private key is encrypted at rest
  with Electron `safeStorage`, backed by the OS keychain: **Windows DPAPI**,
  macOS Keychain, libsecret on Linux. Only OS ciphertext is written to disk.
  This is the **same mechanism the repo already uses** for the master PIN and
  Google Drive tokens.
- **Development/Test — `FileKeyStore`:** a `0600` PEM file beside the DB.
- **`createKeyStore(env)`** selects: production **requires** OS-backed storage
  and **fails closed** if it is unavailable (never writes a plaintext key in
  production); dev/staging prefer safeStorage when present and fall back to a
  file so the dev/test path is never broken.
- Lifecycle: first-time generation, persistence across restart, signing,
  **rotation** (`rotateDeviceKey`), **revocation** (`revokeDeviceKey`), and
  device replacement are all supported. The key is never in a DB table,
  plaintext JSON, repo file, localStorage, or any frontend bundle.

---

## Part F — Background sync worker

`main/core/sync/worker.ts` (`SyncWorker`) drives the existing explicit
upload/download functions on a timer; it adds no new sync logic.

- **Cashiering-safe / non-blocking:** work is on a timer off the request path;
  batches are bounded; it runs only when sync is enabled; a slow/dead cloud
  never blocks a sale. The timer is `unref`'d so it never keeps the app alive.
- **Re-entrancy guard:** a tick already in flight is never restarted — no
  overlap, no double-upload.
- **Restart-safe:** each tick first recovers events stuck `uploading` from a
  prior crash back to `pending` (SYNC-A recovery).
- **Backoff:** the interval doubles on failure up to a cap and resets on
  success — no retry storm, but never gives up (offline-first).
- **Clean shutdown:** `stop()` clears the timer and awaits the in-flight tick.
- **Order per tick:** detect pending → upload batch → process acks → pull →
  persist inbox → apply → advance cursor → record health.

`tick()` is public so tests drive it deterministically without real timers.

---

## Part G — Sync health & observability

- **Local — `getSyncHealth()`:** online/offline (null before first attempt),
  last upload/download, pending/uploading/failed outbox, inbox pending/failed,
  last error + consecutive failures, and last tick duration (from the worker's
  in-process liveness). Pure read; triggers nothing.
- **Cloud — `store.organizationHealth(org)` + `observability()` + device
  `last_seen_at`/`last_sync_at`:** devices, active devices, movements,
  deficits, last received time; accepted/duplicate/rejected/auth-failure
  counts from `cloud_sync_log`.
- No Admin dashboard is built — these are the internal APIs a future Admin
  consumes.

---

## Part H — Inventory reconciliation (cross-till deficits)

**Local behaviour is unchanged**: insufficient tracked stock still rejects the
local sale. The cloud additionally sums movement deltas per
(org, location, product, variant) in `cloud_inventory_stock` inside the same
transaction that stores each fact. When independently-offline tills sell the
same stale stock, the projection goes negative and a row is recorded in
`cloud_inventory_deficits` (org, location, product, variant, balance,
first/last detected, triggering movement). **No sale is reversed and no
historical movement is mutated** — the deficit is a queryable fact for a future
Admin. *Limitation:* accuracy assumes opening balances are represented as
synced movements (documented in Part Q).

---

## Part I — Environment configuration

`getSyncCloudConfig(env)` / `getSyncEnvironment(env)`:

- Environments: `development` | `staging` | `production` via `PLEMMO_SYNC_ENV`.
- Endpoint from `PLEMMO_SYNC_URL`; **never** hardcoded.
- **Safe default:** no URL ⇒ sync disabled (local-first).
- **Guards:** a production-looking `https://` endpoint is **refused** while
  `PLEMMO_SYNC_ENV=development` (a dev build cannot hit production); production
  **requires** `https://`. Each refusal reports a `disabledReason`.
- No secret is read here or placed in a frontend bundle — only the base URL and
  environment name. The cloud DB URL (`PLEMMO_CLOUD_DB_URL`) is read only by
  the standalone cloud service (`cloud/factory.ts`), never the client.

---

## Part J — Security hardening

Audited request signing, replay/nonce, timestamp window, key rotation, revoked
devices, org/location isolation, payload validation, body limits, auth
failures, rate limiting, error leakage, log contents, CORS, TLS.

- Every `/upload` and `/pull` is Ed25519-signed; org/location resolved from the
  **device registry**, never trusted from the payload (org-spoof test proves
  it). Timestamp window ±5 min; per-device nonce, pruned to that window.
- **Per-device rate limiting**; **coarse** client auth reason (detailed reason
  logged only); body capped at 1 MB and batch at 500 events (413 over-limit);
  malformed JSON answered 400 without a stack.
- **No CORS headers** are emitted — this is a device-to-server API, never
  browser-origin; a browser cross-origin call is blocked by default. **TLS**
  is required in production (enforced by the env guard); certificate handling
  is the platform/hosting layer's.
- Tested malicious inputs: org spoof, over-limit batch, tampered signature,
  replayed request, revoked/rotated device, expired/reused enrollment token.

---

## Part K — Recovery

Tested (T = test §): crash mid-upload → stalled `uploading` recovered & acked
(T10); crash between inbox-persist and apply → reapplied on next pull (T16);
cloud unavailable → POS records locally, backlog waits (T11); network vanish
mid-batch → stays pending (T9/T11); network vanish after cloud commit →
lost-ACK dedup (SYNC-B T10); key revoked → sync blocked (T6); credential
rotated → old sig fails, new sig works (T5); stalled upload → recovered (T10);
stale/own-tail cursor → advances, no re-scan (T15). Device-offline-for-days is
just a large pending backlog the worker drains (T9). Cloud restart: the store
is durable; cursors/idempotency make re-pull safe.

---

## Part L — Scale (100 → 3,000 merchants)

Append-only movements, per-org indexed feed, bounded batches, per-org sequence
(no global bottleneck), `UNIQUE(movement_uid)` idempotency lookup, worker
backoff to prevent retry storms, and reconnection spikes absorbed by batching.
3,000 merchants of inventory-movement traffic is comfortably within a single
managed-Postgres instance's envelope; nothing in the protocol needs redesign
to get there. This is deliberately **not** a hyperscale design.

---

## Part M — Tests

`tests/sync-c-production-foundation.test.ts` (80 checks, real local HTTP + real
transport, no public internet): concurrent 3-device gapless sequence;
independent org sequence; production token enrollment + reuse/expiry rejection;
rotation; revocation; file & safeStorage key stores + fail-closed production;
worker upload/download/retry-backoff/restart-recovery; cloud-unavailable
resilience; sync-health snapshots; replay + nonce pruning; cross-till deficit
detection with movements preserved; own-tail cursor advance; crash-recovery;
env guards; oversized-batch + tampered-signature rejection; Postgres adapter
transaction/idempotency structure (fake `PgClient`); cloud org health. SYNC-0
(45), SYNC-A (52) and SYNC-B (42) suites remain green.

---

## Part N — Regressions

The sync layer stays an infrastructure layer. Unchanged: stock enforcement,
sale/payment/purchasing/transfer logic, hospitality, retail, authorization.
`remote-apply` never runs local sale logic and never appends an outbox event.
Full `npm test` is green.

---

## Part O — Migrations

No new **local** SQLite migration was needed — SYNC-A's v86 tables suffice, and
`device_credentials` (v84) already holds public-key lifecycle. New schema is
**cloud-side only** and additive. No existing-data risk.

---

## Part P — Build / lint

`tsc -p .` (main) and `tsc -p cloud/tsconfig.json` (cloud) clean; `eslint main/
cloud/` 0 errors; full `npm test` green.

---

## Part Q — Known limitations

1. Inventory movements are the only synchronized entity.
2. Production cloud is **defined and adapter-implemented** but not stood up;
   `PostgresCloudStore` is validated against a fake `PgClient`, not a live DB.
3. Cross-till deficit accuracy assumes opening balances are synced movements;
   a v73-style raw backfill is not in the feed.
4. Rate limiting is in-process (per instance); a multi-instance deployment
   needs a shared limiter (gateway/Redis) — same interface.
5. Enrollment tokens are issued programmatically; the operator/Admin UI is
   later work.
6. Worker liveness (last tick duration) is in-process; durable cross-process
   health can be layered on later.

---

## Part R — Remaining sync work

Stand up the managed-Postgres cloud + a migration runner and CI deploy; real
Admin issuance of enrollment tokens and a device/deficit console; extend sync
to the next append-only entity (audit events), then sales/payments with a
conflict model; a shared rate limiter; deficit **resolution** workflow
(alert → operator action), still never auto-reversing sales.

---

## Stop-conditions (none triggered)

Production persistence is safely selectable (managed Postgres behind the seam);
secure Windows key storage is implementable (safeStorage/DPAPI, already in
repo); enrollment is unambiguous (token flow); the worker cannot interfere with
cashiering (off-path, bounded, unref'd, guarded); sequence allocation is atomic
(synchronous SQLite / `UPSERT … RETURNING` Postgres); reconciliation needs no
local behaviour change (cloud-side projection only); org isolation is
guaranteed (server-side identity); no migration risks existing data (additive,
cloud-side); the protocol needs no redesign.
