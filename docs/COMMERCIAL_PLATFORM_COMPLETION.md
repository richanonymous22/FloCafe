# Commercial Platform Completion

The bundled commercialization milestone: moving Plemmo from "technically strong
EPOS + sync infrastructure" toward "commercially deployable platform." It
extends the PROVEN sync seam (SYNC-D…G) to the remaining business domains,
completes the safe-compensation audit, adds a production deployment path and a
licensing foundation, and documents what is real vs what still needs external
provisioning. The major UI/UX redesign is deliberately NOT started (a separate
HTML design will be the direction later).

Proven against real PostgreSQL + real HTTP (`tests/commercialization.test.ts`,
44 checks) plus the full regression suite.

Read alongside [`SYNC_G_ADMIN_RECONCILIATION.md`](./SYNC_G_ADMIN_RECONCILIATION.md),
[`SYNC_F_CONFLICT_RECONCILIATION.md`](./SYNC_F_CONFLICT_RECONCILIATION.md),
[`SYNC_E_SALES_ARCHITECTURE.md`](./SYNC_E_SALES_ARCHITECTURE.md),
[`SYNC_D_MULTI_ENTITY.md`](./SYNC_D_MULTI_ENTITY.md), and
[`cloud/DEPLOYMENT.md`](../cloud/DEPLOYMENT.md).

---

## A. Production cloud status

The full production audit + artifacts live in
[`cloud/DEPLOYMENT.md`](../cloud/DEPLOYMENT.md) ("Permanent production
service"). Summary:

- **Built:** `cloud/serve.ts` production entrypoint (resolves the managed-PG
  backend, graceful SIGTERM/SIGINT drain, dev-enroll off by default);
  `cloud/Dockerfile` + `.dockerignore` (multi-stage image with a built-in
  `HEALTHCHECK`); `GET /health` (liveness) + `GET /ready` (datastore readiness)
  + `X-Plemmo-Protocol` on every response; the migration entrypoint
  (`run-migrations.ts`) already existed.
- **Proven:** hosted **Neon PostgreSQL** connectivity + `test:sync-d-production`
  43/43 from the real Windows client (dated 2026-08-17); health/protocol over
  real HTTP in this milestone's suite.
- **STOP — external dependency:** a permanent public deployment needs the user
  to provide a cloud host, a managed PostgreSQL instance + `PLEMMO_CLOUD_DB_URL`
  secret, a production domain + TLS, CI/CD, monitoring, and a verified
  backup/restore drill. No code change remains; see DEPLOYMENT.md for the exact
  list.

## B. Compensation

Audit result (details in `main/core/admin/compensation.ts`):

| Primitive | Idempotent? | Txn | Guards | Safe for Admin? |
|---|---|---|---|---|
| `refundPayment` | YES (`PaymentIdempotency` key) | `withTxn` | no over-refund / bad-state | ✅ **automated** |
| `voidPayment` | YES (idempotency key) | `withTxn` | no void of settled/refunded | ✅ **automated** |
| inventory correction (bare adjustment) | NO idempotency key | — | — | ❌ **manual** (documented) |

`executeCompensation` derives a DETERMINISTIC idempotency key from
`(conflict, action, payment)`, so a repeated Admin refund/void yields exactly
ONE effect (proven: repeat did not double-refund). It links the compensation to
the conflict + audits it, and enforces `sales.reconcile`. Inventory correction
stays `manual_action_required` until an idempotent inventory-correction
primitive exists — an honest STOP-SHORT, not a silent omission.

## C. Catalog sync

Products, categories, product_variants, addon_groups, addons synchronize as
**versioned mutable snapshots** through the existing seam (no new engine).
Emission is best-effort at the write paths (products wired in `routes/products.ts`;
the rest via `appendReferenceSnapshot`). The cloud persists them in the one
per-org feed; remote apply lands them in a generic mirror.

## D. Customer sync

Customers sync the same way (wired in `routes/customers.ts` create/update). The
existing phone-based **dedup** on create is preserved; global identity is the
stable ULID, so remote apply is idempotent by id and **cannot duplicate a local
customer**. Historical customer↔order relationships are untouched (sync writes
only the mirror).

## E. Supplier / purchasing / receiving sync

Suppliers (wired in `modules/purchasing/suppliers.ts`), purchase_orders +
purchase_order_items (wired at create + status transitions in
`modules/purchasing/purchase-orders.ts`). "Receiving" is not a separate entity:
it is a PO status transition (`partially_received`/`received`) — synced as a PO
snapshot — plus the existing `movement_type='receipt'` inventory movement,
which already syncs (SYNC-B/D). So the PO → receiving → inventory-movement chain
survives offline sync without any duplicate inventory movement (remote apply is
mirror-only; it never re-runs receiving).

## F. Transfers

`stock_transfers` + `stock_transfer_items` sync as versioned snapshots (wired at
create + `completeTransfer`/`cancelTransfer` in `core/transfers.ts`). The local
physical model (`draft`/`completed`/`cancelled`) is UNCHANGED — no risky local
schema rewrite. The two-location OUT-then-IN visibility is realized at the sync
layer: a completed source transfer is a snapshot the destination sees in its
mirror, and remote apply never moves stock (no duplicate inventory). A richer
`draft→shipped→received` two-phase local state machine is a future local-schema
change, documented as a limitation.

## G. Conflict policies (per entity)

| Entity class | Source of truth | Conflict class | Mutation | Legal resolution | Remote apply | Idempotency |
|---|---|---|---|---|---|---|
| order / order_item / bill (SYNC-E/F) | local authoritative | financial (blocking) | versioned snapshot | authorized engine, financial-safe | mirror; never authoritative | event_uid / uid |
| payment_event (SYNC-D) | local authoritative | append-only fact | none | n/a | mirror | event id |
| inventory_movement (SYNC-B/D) | local authoritative | append-only fact | none | deficit workflow | applied + balance projection | movement uid |
| product / category / variant / addon | local authoritative | **reference_snapshot** (non-blocking) | versioned snapshot | accept-highest-version (LWW-safe) | **mirror only** | ULID id |
| customer | local authoritative | **reference_snapshot** + dedup on create | versioned snapshot | accept-highest-version | mirror only | ULID id |
| supplier | local authoritative | reference_snapshot | versioned snapshot | accept-highest-version | mirror only | ULID id |
| purchase_order (+items) | local authoritative | **state-transition snapshot** | versioned snapshot | highest version = latest state | mirror only | ULID id |
| stock_transfer (+items) | local authoritative | **two-location state snapshot** | versioned snapshot | highest version = latest state | mirror only | ULID id |

Naive last-write-wins is NOT used for the financial sales entities (they keep
the SYNC-F engine). It IS used — deliberately and safely — for reference data,
where the ULID identity makes it non-destructive. See
`main/core/sync/reference-entities.ts` (`REFERENCE_CONFLICT_POLICY`).

## H. Production operations

Reuses SYNC-G's operator health (local backlog/failed/devices + cloud org
health) and adds: `/health` + `/ready` for load-balancer probes, the
`X-Plemmo-Protocol` version header (protocol versioning), graceful shutdown, and
the documented migrate-then-rollout (expand/contract) release + rollback
procedure. Environment separation is already enforced (`getSyncCloudConfig`
guards dev vs production). A giant DevOps dashboard was deliberately not built.

## I. Licensing

`main/core/licensing.ts` — a foundation, not a billing system (billing stays
separate). Architected around Organization → Locations → Registers → Devices →
License/entitlement. It sits ABOVE the existing feature-entitlement system: a
feature is licensed only when the license is effective AND the org's entitlement
grants it. States: active / expired / suspended / revoked / unlicensed, with an
**offline grace** window (a just-expired or long-unverified license keeps
working within `grace_days` — a merchant is warned, never stranded mid-service;
a `revoked` license never gets grace). The cached entitlement lives in a
`settings` row (offline-usable, no migration). Server-side verification is an
interface (`LicenseVerifier`) — the real signed-license check is an external
dependency (the cloud license service, not deployed). Answers the core question:
"Is this merchant/till/device authorized to use this feature?"
(`isFeatureLicensed`, `deviceCountWithinLimit`, `locationCountWithinLimit`).

## J. Merchant onboarding

A first-merchant readiness audit (what a real shop/restaurant owner needs):

| Capability | Status |
|---|---|
| First-run configuration / setup flow | ✅ exists (`/setup`, org/location/register seeding) |
| Device registration / enrollment | ✅ exists (token enrollment, SYNC-C/D) |
| Staff setup | ✅ exists (`/staff`) |
| Location setup | ✅ exists (`/locations`) |
| Product/menu import | ✅ exists (CSV import — `routes/menu-csv.ts`) |
| Printer setup | ✅ exists (`/printers`) |
| Backup / recovery | ✅ exists (auto pre-migration backups; Google-Drive backup) |
| Update process | ✅ exists (electron-builder auto-update channels) |
| Sync troubleshooting | ✅ SYNC-G Reconciliation → Sync Health |
| Merchant support info | ✅ support ticket flow |
| Licensing activation UI | ⚠️ backend + API only (no UI — deferred with the UI redesign) |

No unnecessary enterprise features were added.

## K. Remaining gaps

1. Reference/operational entities sync into MIRRORS; promoting a remote catalog
   record into the local authoritative catalog is a controlled Admin/merge step
   (future) — deliberately not an automatic sync mutation (preserves the local
   authoritative model, cannot duplicate or overwrite).
2. Automatic emission is wired at the primary write paths for products,
   customers, suppliers, purchase orders, and transfers; categories / variants /
   addons emit via the same generic function and need their write-site hooks to
   be automatic (mechanical follow-up).
3. Transfers keep the current local state machine; the two-phase
   `draft→shipped→received` model is future.
4. Inventory-correction compensation is manual (no idempotent primitive yet).
5. Licensing signature verification needs the cloud license service.

## L. Launch checklist (pre-pilot)

- [ ] Provision cloud host + managed PostgreSQL; set `PLEMMO_CLOUD_DB_URL`.
- [ ] Production domain + TLS; secrets manager binding.
- [ ] CI/CD: build → `run-migrations.js` → roll out `serve.js`; rollback step.
- [ ] Monitoring/alerting on `/health`, `/ready`, sync log.
- [ ] Backup/restore drill on the managed instance.
- [ ] Shared rate limiter for multi-instance.
- [ ] Issue + activate a pilot license per merchant.
- [x] Catalog / customer / supplier / operations sync (this milestone).
- [x] Safe refund/void compensation (this milestone).
- [x] Full regression green, build green, lint 0 errors.

## M. Known limitations

See Part K. Additionally: production cloud is not a permanently operated
deployment (external — Part A); the Admin UI is the SYNC-G minimal set (the
full redesign is deferred to the separate HTML design direction).

## N. Exact commits

Recorded in the final report / git log for this milestone (branch
`claude/plemmo-epos-audit-fro8v9`).

---

## Recommended final pre-UI work

**PLATFORM-HARDENING:** wire the remaining catalog write-site emitters, add an
idempotent inventory-correction primitive (unlocking that compensation),
implement controlled promotion of mirrored reference data into the authoritative
catalog, and stand up the cloud license service — then the platform is ready for
the UI/UX redesign against the separate HTML design.
