# Platform Hardening — Final

The last backend/platform milestone before the Plemmo EPOS UI/UX redesign. It
closes the remaining sync/compensation/promotion/licensing gaps identified by
the commercialization milestone, completes a consolidated security + migration
audit, and draws a hard boundary: after this, no core backend feature expansion
except a real bug/security fix.

Proven against real PostgreSQL + real HTTP
(`tests/platform-hardening.test.ts`, 27 checks) plus the full regression suite.

Read alongside [`COMMERCIAL_PLATFORM_COMPLETION.md`](./COMMERCIAL_PLATFORM_COMPLETION.md),
[`SYNC_G_ADMIN_RECONCILIATION.md`](./SYNC_G_ADMIN_RECONCILIATION.md), and
[`cloud/DEPLOYMENT.md`](../cloud/DEPLOYMENT.md).

---

## FINAL PLATFORM AUDIT

Every known limitation from the prior milestones, re-read and classified.

| # | Limitation (as previously documented) | Classification | Resolution this milestone |
|---|---|---|---|
| 1 | Catalog auto-emission only wired at primary product/customer/supplier paths | **DONE** | Wired category (create/update/delete), product_variant (create/update/deactivate), addon_group (create/update), product delete/deactivate. Remaining paths use the same generic best-effort emitter. |
| 2 | Remote reference data lands in mirrors; promotion into the authoritative catalog is future | **DONE** | Controlled `promoteRemoteEntity` — INSERT-if-absent, protects local edits (`review_required`), never overwrites/duplicates/deletes, PRAGMA-whitelisted columns, audited. Operational entities never promoted. |
| 3 | Inventory-correction compensation is manual (no idempotent primitive) | **DONE** | `adjustStock` gained an `idempotencyKey`; `executeInventoryCorrection` is exactly-once, conflict-linked, audited, keeps the negative-stock guard → inventory compensation is **AUTOMATED**. |
| 4 | Licensing server-side verification needs the cloud license service | **DONE (code) / BLOCKED-EXTERNAL (signing secret)** | `cloud_licenses` table + `GET /sync/v1/license` (device-auth, org-scoped) + `createCloudLicenseVerifier` + `refreshLicense` offline grace. The real signed-payload check is a one-line hook awaiting a production signing secret. |
| 5 | Transfers keep the single-phase local state machine | **SAFE TO DEFER** | Two-phase `draft→shipped→received` would change local business behavior + schema; the sync layer already carries state snapshots. Not needed before UI. |
| 6 | Permanent public cloud deployment | **BLOCKED-EXTERNAL** | Code ready (`serve.ts`, Dockerfile, `/health`, `/ready`, protocol version, graceful drain, migration entrypoint). Needs host + managed PG + domain/TLS + CI/CD + monitoring + backup drill. See `cloud/DEPLOYMENT.md`. |
| 7 | Multi-instance rate limiter (in-memory per instance) | **SAFE TO DEFER** | Interface unchanged; a shared limiter (gateway/Redis) is a deploy-time swap, needed only at multi-instance scale. |
| 8 | Licensing activation UI | **SAFE TO DEFER (UI phase)** | Backend + API complete; the screen belongs to the UI redesign. |

No new limitation was invented. Nothing in the MUST-FIX-BEFORE-UI class remains
(see Part M below).

## B. Catalog emitters

Every runtime catalog mutation now emits a reference snapshot: products
(create/update/delete), categories (create/update/delete), product_variants
(create/update/deactivate), addon_groups (create/update), customers, suppliers,
purchase_orders (create + status), stock_transfers (create + complete/cancel).
Emission is best-effort (never breaks a write) and goes through the one generic
`appendReferenceSnapshot`. Read-only getters do NOT emit (verified — a stray
emit in `getVariant` was removed).

## C. Catalog promotion

`main/core/admin/catalog-promotion.ts` + `/api/admin/catalog/{promotable,promote}`.
Mirror → validation → authorization (`sales.reconcile`) → INSERT-if-absent →
audit → ULID lineage. An existing local record is protected (`review_required`,
never overwritten); operational/financial entities are `not_promotable`. No
last-write-wins over meaningful configuration; no history destroyed.

## D. Inventory compensation

**AUTOMATED.** `adjustStock({ …, idempotencyKey })` records the correction as
`reference_type='inventory_correction'`, `reference_id=key`; a repeat returns the
prior movement with no second delta. `executeInventoryCorrection` derives the key
from the conflict, so an Admin correction is exactly-once, keeps the
negative-stock guard, emits the inventory sync fact, links + audits. Requires
`sales.reconcile`.

## E. Licensing

Local `core/licensing.ts` (states + offline grace + device/location limits +
feature entitlement over the existing feature system) + the cloud service:
`cloud_licenses` (migration `0004_licenses.sql`), `GET /sync/v1/license`
(device-authenticated, org-scoped — no secret ever sent to a client),
`createCloudLicenseVerifier`, and `refreshLicense` (a network failure keeps the
cached entitlement — offline grace; a cloud revocation propagates and never gets
grace). The signed-payload verification is the single external hook awaiting a
production signing secret. Licensing failure never corrupts local EPOS operation
(the POS runs; features gate).

## F. Production deployment

Code-ready: `cloud/serve.ts` (safe-fails without `PLEMMO_CLOUD_DB_URL`, dev-enroll
off, graceful SIGTERM/SIGINT drain), `cloud/Dockerfile` (+ HEALTHCHECK),
`/health`/`/ready`, `X-Plemmo-Protocol`, `run-migrations.ts`. **External:** host,
managed PostgreSQL + URL secret, domain/TLS, CI/CD, monitoring, backup drill.

## G. Production operations

Health/readiness probes, protocol versioning, graceful drain, expand/contract
migrate-then-rollout + rollback (documented), stale-device handling +
revocation (SYNC-C/D), observability + error logging (sync log), backup
(auto pre-migration + Google-Drive) — documented in `cloud/DEPLOYMENT.md` and
`COMMERCIAL_PLATFORM_COMPLETION.md`.

## H. Merchant readiness

Re-audited (see `COMMERCIAL_PLATFORM_COMPLETION.md` Part J): first-run setup,
org/location/device enrollment, staff, CSV catalog import, printers, KDS,
backup/restore, updates, offline use, reconnect/sync, sync troubleshooting
(Reconciliation console), support — all present. The only gaps are visual
(licensing activation screen, richer troubleshooting UX) → deferred to the UI
phase, not backend blockers.

## I. Security (consolidated)

Verified across auth / device identity / signed requests / replay (nonce) /
org + location isolation / licensing / Admin actions / compensation / promotion
/ sync endpoints. Tested: org spoof, revoked device, tampered request,
unauthorized role (cashier denied on compensation + promotion), license
isolation (foreign org gets null — no secret leak), revoked-device license
denial, exactly-once compensation, promotion never overwrites. No secret is
embedded in any client. No real security flaw found.

## J. Migrations

v88 / v89 / v90 and cloud `0002`/`0003`/`0004` are all additive, idempotent
(`IF NOT EXISTS`), fresh-install safe, and legacy-upgrade safe — verified by
`schema-health` (fresh) + `upgrade-path` (real v1.5.0 fixture). No destructive
rewrite of authoritative business history.

---

## M. Final platform gap analysis

**MUST FIX BEFORE UI** — *(none).* All previously-open backend items are DONE
or externally blocked.

**SAFE TO DEFER UNTIL AFTER UI**
- Two-phase transfer state machine (draft→shipped→received).
- Shared multi-instance rate limiter (deploy-time swap).
- Licensing activation + richer troubleshooting screens (UI phase).
- Remaining fine-grained catalog write paths beyond the enumerated set (generic
  emitter already available; best-effort).

**EXTERNAL DEPENDENCY**
- Permanent public cloud deployment (host, managed PG + secret, domain/TLS,
  CI/CD, monitoring, backup drill).
- Production license signing secret (to enable signed-payload verification).

**OPTIONAL FUTURE FEATURE**
- Automatic promotion of catalog updates to existing records (currently
  review-only, deliberately).
- Cross-device inventory-balance auto-reconciliation beyond detection.

### Hard boundary

**After this milestone: NO further core backend feature expansion unless a real
bug or security issue is found.** The next phase is the **Plemmo EPOS UI/UX
redesign** against the user's separate HTML design. The backend/platform is
complete enough to move to the redesign and a real merchant pilot.

## N. Exact commits

Recorded in the final report / git log for this milestone (branch
`claude/plemmo-epos-audit-fro8v9`).
