# PLEMMO EPOS FINAL MASTER AUDIT

Audit only. No code, schema, licensing or branch was changed. Date: 2026-09-30.
Authority order used: current code → current tests → stated requirements → chronology.

**Status legend** (as requested): A production-ready · B code-complete, real-world test required · C code-complete, external dependency · D partial · E not implemented · F deferred by agreed scope · G optional future · H legal/commercial decision.

**Evidence limits (read first).**
- The original "Plemmo EPOS Software specification" PDF is **not in the repository**; no `.pdf` exists. The §74 developer-acceptance list is **not in the repository**. The scope matrix (§3–4) is reconstructed from the brief, `PLEMMO_ARCHITECTURE.md`, `COMMERCIAL_PLATFORM_COMPLETION.md` and code. It must be checked against the PDF by the owner.
- `PLEMMO_DELIVERY_AUDIT` and `PLEMMO_PACKAGE_1_3` do not exist under those names. The closest documents are `MERIDIAN_PLEMMO_PRODUCTION_AUDIT.md` and `MERIDIAN_PLEMMO_MASTER_INTEGRATION.md`.
- No hardware, Windows install, cloud deployment, or card terminal was available. Nothing in those areas is verified by this audit.

---

## 1. Executive Summary

The repository is a substantial, well-tested **backend and cloud-sync platform** with a **Meridian front end that is only partly wired to it**.

- **Verified by running:** `npm test` (96 chained suites) exits 0. `npm run test:meridian` (12 suites) exits 0. The six real-PostgreSQL suites (`test:pg-sync`: SYNC-D/E/F/G, commercialization, platform-hardening) pass against a live PostgreSQL 16 (43/34/63/49/45/27 checks, 0 failed).
- **The biggest finding:** several till actions in the Meridian UI are **local-only or simulated**, even though the backend has the capability. These are refund, void, receipt printing, the Devices/hardware panel, and (to be checked) hold. A sale taken in Meridian reaches the authoritative backend. A refund or void in Meridian does not. See §6.
- **Refunds have no customer-facing backend route.** `refundPayment()`/`voidPayment()` exist in `main/core/payment.ts` and are reachable only through the sync-conflict compensation path (`main/core/admin/compensation.ts`). No till route calls them.
- **Missing features (E):** X report, Z report and end-of-day as backend reports (`/api/reports/*` has none; Meridian computes its "End of day" client-side from loaded orders); stocktake as a document/workflow; XLSX import; barcode-scanner UI; customer display; any real card-terminal integration; purchasing/supplier/transfer/terminal/license screens in Meridian.
- **Nothing is deployed.** No cloud host, database, domain, signing key, code-signing certificate, update feed or release exists. There is no git tag.
- **Branding is unfinished:** the product is still "Plemmo EPOS" / `com.plemmo.epos`, and `package.json` still carries FloCafe / Codify Apps store identities.

---

## 2. Current Repository State

| Item | Finding |
|---|---|
| Delivery branch | `PLEMMO-DELIVERY` exists (head `44ed5d0`). It is the active delivery line. |
| Default branch | `main` (`223a04e`) contains the merged PRs #2 and #3. |
| Frozen MASTER | `origin/claude/MASTER` = `6f2aff2`. It is an ancestor of `main`, and no commit has been added to it since. **Untouched.** Note that `main` itself is not frozen. It has received delivery merges. If "MASTER" was meant to mean the default branch, it has been modified by design. |
| Open PRs | #4 (draft): de-FloPOS endpoints, license lifecycle tests, operator admin API, ReDoS fix. Mergeable, repo CI green. |
| Merged PRs | #2 (Meridian integration + foundation), #3 (first-run setup fix). #1 closed unmerged (branch `claude/plemmo-epos-audit-fro8v9`). |
| Working tree | Clean before this document was added. |
| Version | `3.1.0` (`package.json`), CHANGELOG entry exists, **no tag, no release**. |
| DB migration | SQLite schema v95 (`PRAGMA user_version`). Cloud Postgres has its own `cloud/migrations/postgres`. |
| Frontend | Meridian (`frontend-meridian/`, vanilla JS, 5,160 lines across 17 source files, concatenated to `dist/meridian-pos.html`), served on :3001 by default. Next.js `frontend/` is retained for KDS and server display. |
| Backend | Express + better-sqlite3 in Electron main (`main/`). |
| Cloud | `cloud/`: Express over a `CloudStore`, with `SqliteCloudStore` (test) and `PostgresCloudStore` (prod). Dockerfile, `/health`, `/ready`. |
| CI | `ci.yml`: changes, dependency-review, tax-invariant, linux-baseline, e2e-playwright, meridian, postgres-sync. CodeQL via GitHub default setup. |

---

## 3. Original Product Scope (reconstructed)

Baseline: your brief §4–7 plus the repository documents. Because the PDF is absent, **every "required for V1" classification below is my reading and needs owner confirmation.**

Phase grouping used in §4: Core/Phase 1, Hospitality, Phase 2, Phase 3, Phase 4/AI.

---

## 4. Requirement-by-Requirement Matrix

Columns: Backend / UI (Meridian) / Test / Status. "PG" = covered by real PostgreSQL tests.

### Core retail

| Requirement | Backend | Meridian UI | Tests | Status |
|---|---|---|---|---|
| Touchscreen UI, large buttons | n/a | Yes (by design) | visual QA jsdom only | B |
| Categories, products, favourites | Yes | Loaded from backend | meridian-catalogue | A (favourites: unverified) |
| Barcode lookup | `GET /retail/lookup`, `products?barcode=` | Search box says "scan a barcode" but there is no scan handler | issue-137-barcode (API) | D |
| Product search, basket, quantity | Yes | Yes | meridian-orders | A |
| Discounts | `applyDiscount` (manager) | UI exists | discount suites | D (UI → backend wiring not proven for order-level discount) |
| Price override | No route found | No | none | E |
| Cash payment, change | Yes (`cash.ts`, `payment.ts`) | Yes | plemmo-cash, payment-service | A |
| Card payment | Manual-card attestation only (see §11) | Manual | payment-service | D |
| Hold / resume | `held-orders` API | Button exists; API wiring not verified in `03*.js` (no `/held-orders` write call) | held-orders (API) | D |
| Receipts | `/bills/:id/receipt`, email delivery | Receipt view; **Print is a toast** | receipt suites | D |
| Refunds | Core function only; **no till route** | **Local-state only** (`A.refund` edits `S`) | payment-service (core) | E (till path) |
| Voids | Order status PATCH (cancel) exists; payment void core-only | **Local-state only** (`A.voidOpen`) | cancel-override | D |
| Customer attach | Yes | Yes | meridian-staff-loyalty | A |
| Permissions | Yes | PIN approvals | authz suites | A |

### Inventory

| Requirement | Status | Note |
|---|---|---|
| Stock ledger, stock-in, adjustment | A (backend), D (UI only adjust/receive/waste/count) | `meridian-inventory`, `plemmo-inventory` |
| Stocktake | **E** | "Count" mode = single-item set-to-quantity adjustment. No stocktake session, no variance report. |
| Scan stock | E | No scanner UI |
| Low-stock alerts | D | threshold fields exist; alert UI not verified |
| CSV import | D | `/api/menu-csv` is **menu** import only (100 KB, 10k rows). No stock CSV. |
| XLSX import | **E** | No xlsx library in `package.json` |
| Location stock, transfers, purchasing, suppliers | A backend (`plemmo-purchasing`, `plemmo-multi-location`); **UI E** in Meridian (API wrappers in `03f` only) | |
| Valuation | D | unit_cost in ledger; no valuation report verified |

### Reports

| Requirement | Status |
|---|---|
| Daily stats, summary, sales, tax components, top products, tables, insights (`/api/reports/*`) | A backend |
| X report / Z report / end-of-day (server-side, immutable, numbered) | **E**. Cash sessions give expected/variance on close; no Z report document. Meridian "End of day" is client computed. |
| VAT report | D (`tax-components` only) |
| Refund / void / discount / staff / margin reports | D/E (no dedicated endpoints found) |
| Exports | D (client CSV of orders only) |

### Core infrastructure

| Requirement | Status |
|---|---|
| Business/Location/Terminal/User IDs (ULID) | A (`plemmo-identifiers`, PG suites) |
| Licensing | B/C (see §8) |
| Cloud database | C (code ready, nothing deployed) |
| Offline mode, outbox, sync | A code, B real-world (see §12) |
| Audit trail | A (`plemmo-audit`, append-only) |
| Backup/restore | A code (`backup-restore*`), B real-world (see §14) |
| Remote dashboard | **E/F**. Only operator API exists. There is no dashboard UI; FloAdmin is a separate, unbuilt application. |

### Hospitality (inherited)

Tables, floor plan (editor added), KDS, KOT, stations, modifiers, held orders, split checks: A for backend (inherited suites pass). Meridian dine-in routes through real orders (`meridian-tables`). Takeaway/delivery "order types": channel field exists. No third-party delivery integration.

### Phase 2

| Item | Classification |
|---|---|
| Offers/promotions | D. A catalog-promotion admin path exists for sync; no offer engine or UI. Clarify scope (G?). |
| Customer management, loyalty | A (backend), A (Meridian) |
| Advanced inventory, transfer, multi-location | A backend; UI E |
| Advanced reporting | D |
| Accounting integration | E/F (nothing exists) |
| Remote monitoring | D (operator health endpoint only) |
| Product photos | D (`product-images` suite, backend) |
| AI product assistance | D (advisory AI service `core/ai.ts`; no product-description AI) |

### Phase 3

Uber Eats, Deliveroo, Just Eat, online ordering, weighing machines, advanced payment integrations, mobile app: **E**, presumably **F** (none started; owner must confirm they are out of the V1 sale). KDS and hospitality mode: A.

### Phase 4 / AI

Business-assistant (advisory, audited): D/A as built. Forecasting, reorder suggestions, anomaly detection, AI images: E, presumably **F/G**.

---

## 5. Backend Audit

Grouped result (implemented / wired / tested / integration / real PG / real HTTP / offline / multi-terminal / production-ready / real-world validated):

| Area | Implemented | Tests | Real PG | HTTP | Notes | Status |
|---|---|---|---|---|---|---|
| Sale, order, bill | Y | Y (integration) | Sales sync only | Y (supertest on real Express) | | A |
| Payment service | Y | Y | payment sync | Y | manual-card only | D for cards |
| Refund | Core only | core unit | via compensation | **No route** | | E |
| Void | Partial | cancel tests | n | Y (order status) | | D |
| Discount, price override | Discount Y / override E | Y | n | Y | | D |
| Tax engine / VAT | Y (tax-engine, packs, inclusive) | Y | n | Y | UK pack present; HMRC accuracy not externally reviewed | B |
| Inventory ledger, adjust, receipt | Y | Y | inventory sync | Y | | A |
| Stocktake | N | n | n | n | | E |
| Purchasing, suppliers, transfers | Y | Y | transfers via sync | Y | | A (no UI) |
| Customers, loyalty | Y | Y | customer sync | Y | | A |
| Staff, permissions, authz | Y | Y (matrix) | n | Y | | A |
| Audit trail | Y | Y | audit sync | n | | A |
| Locations, terminals, devices | Y (schema, device identity, Ed25519) | Y | Y | Y | | A |
| Auth, tenant isolation | Y | Y | Y (cloud isolation in D/G) | Y | | A |
| Licensing, entitlements | Y | Y | Y | Y | see §8 | C |
| Sync, reconciliation, conflicts | Y | Y | **Y (passed this audit)** | Y | | B |
| Admin ops (promotion, compensation) | Y | Y | Y | Y | no UI | C/D |
| Reports | Partial | Y | n | Y | no X/Z/EOD | D |
| Cash sessions | Y | Y | n | Y | | A |
| Backups, migrations | Y | Y | n | n | see §14 | A code |

"Real-world validated": **none of the above.** No merchant has used the system.

---

## 6. Frontend Audit (Meridian)

| Screen / feature | Finding | Status |
|---|---|---|
| Login, first-run owner setup, tenant select | Wired (PR #3), tested | A |
| Register: catalogue, basket, counter checkout | Wired → `POST /orders` → bill → payment | A |
| Dine-in / tables / send to kitchen / floor plan | Wired | A |
| Customers, loyalty tiers | Wired | A |
| Inventory adjust/receive/waste/count | Wired to ledger | A (single-item only) |
| Cash drawer session | Wired | A |
| Staff shifts, PIN | Wired | A |
| Reports, dashboard | Wired for loaded data; End-of-day is client-side | D |
| AI assistant | Wired, advisory | A |
| Kiosk, digital receipts | Wired | B |
| Sync/licence status pill | Wired, read-only | A |
| **Refund** | `A.refund` (04-register-kitchen.js) mutates local `S` only; no backend call | **Demo-only** |
| **Void open order** | `A.voidOpen` mutates local `S` only | **Demo-only** |
| **Print receipt** | `A.printRc=()=>toast('Sent to the receipt printer')`, no print call | **Placeholder** |
| **Settings → Devices** | Hard-coded rows ("Connected", "battery 82%") for printer, card reader, drawer | **Placeholder / misleading** |
| Hold / resume | Button exists; no backend `/held-orders` write found in `03*.js` | D (verify) |
| Barcode scan | Search field only | D |
| Price override | None | E |
| Purchasing / suppliers / transfers screens | API wrappers only, no screens | E (backend-only) |
| Locations / terminals / devices / license activation | No screens | E |
| Reconciliation / conflict admin | No screen (operator API only) | E |
| Backup | "Backup" downloads `JSON.stringify(S)` (client state), **not the SQLite backup** | D / misleading |
| Support | not found | E |

**Structural risk:** Meridian still carries a client-side `S` state object and `localStorage` from its prototype origin. Where a feature was not rewired it silently falls back to `S`. That is the mechanism behind the demo-only items above. The integration docs call `S` a cache. For the unwired features it is still the source of truth.

---

## 7. Cloud / Server Audit

- **Development cloud (B):** `cloud/DEPLOYMENT.md` and the tests run `EPOS → cloud API → PostgreSQL`. To reproduce: start PostgreSQL 16, then `PLEMMO_CLOUD_DB_URL=postgres://… node -r ts-node/register cloud/run-migrations.ts`, then `cloud/serve.ts`. I did not run the EPOS→HTTP→Postgres chain interactively. I did run the test equivalents.
- **Test cloud (A):** Automated suites run against real PostgreSQL and real HTTP. Verified this audit: `test:pg-sync` 6/6 suites pass (Postgres 16). In CI the `postgres-sync` job does this.
- **Production cloud (C):** **Nothing is deployed.** Code-ready: Dockerfile, `/health`, `/ready`, migrations runner, protocol version header, token enrolment, Ed25519 license serving, operator API, graceful shutdown, production refuses to start without a database URL. Requires: host account, managed PostgreSQL, domain/TLS, secrets (`PLEMMO_CLOUD_ADMIN_TOKEN`, `PLEMMO_LICENSE_SIGNING_KEY`, `PLEMMO_CLOUD_DB_URL`), keypair generation.
- **Gaps:**
  - Rate limiter is in-memory per instance (comment in code says to replace it with a gateway for multi-instance).
  - Logging is `console.log/error` only. No structured or request logging, no metrics, no error tracking.
  - No documented backup/restore or rollback procedure for the cloud Postgres, beyond the expand/contract note.
  - `enableDevEnroll` is off by default. Confirm the production entrypoint never sets it (I did not trace `serve.ts` fully).
  - No version-compatibility rejection policy beyond stamping the protocol version.

## 8. Licensing Audit

| Step | Finding |
|---|---|
| Creation | `POST /admin/v1/licenses` (token-gated; closed when unset) |
| Identity/association | org-scoped; device + location limits in the record |
| Plan / entitlements | caller-supplied values; **no plan catalogue is stored** (H) |
| Ed25519 signing / verification | Real. Cloud signs per request; client verifies when `PLEMMO_LICENSE_PUBLIC_KEY` is pinned. If the key is **not** pinned, the client does not enforce the signature. The build does not pin it (E/C). |
| Activation | One-time enrolment token → `/sync/v1/enroll` |
| Expiry, grace, suspend, revoke | State machine tested (`plemmo-license-lifecycle`), incl. revoked-never-graced, cached entitlement offline |
| Device/location limits | Tested |
| Tamper resistance | Signature only if pinned. Local DB is user-writable, and the cached license lives in it. A determined operator with file access can tamper with state. That is typical for desktop POS, but it should be a conscious decision (H). |
| Audit logging | Admin auth failures logged. License changes go through the store. A dedicated license audit trail was not verified. |
| UI | **None** in Meridian (no activation or status screen beyond the pill). |

**First paying merchant needs:** a keypair, a deployed cloud with the admin token, a pinned public key in the build, an activation UI or a documented manual step, and a plan decision. Status: **C** (+ E for activation UI).

## 9. Commercialization Audit

Manual flow `MERCHANT → ORG → LOCATION → TERMINAL → DEVICE → PLAN → LICENSE → ACTIVATE → INSTALL → LOGIN → SELL`:

| Step | Can it be done today? |
|---|---|
| Create merchant/org | Implicit: org appears via license issue + enrolment token. No explicit merchant CRUD. |
| Location, terminal | Created by enrolment/sync. No operator UI/API to create explicitly. |
| Plan + issue license | Yes via operator API (manual `curl`), once the cloud is deployed. |
| Activation token → enrol device | Yes via API. **No activation screen in Meridian.** The client cloud-sync setup path is in the legacy Next.js settings, not Meridian. |
| Install | Needs a signed Windows installer (not produced). |
| Login / sell | Yes, offline. |

**It breaks at:** (1) no deployed cloud, (2) no activation UI in Meridian, (3) no installer, (4) no merchant/location/terminal operator CRUD, (5) no support or version-management tooling. Stripe/billing is not needed for first launch. Future SaaS would need billing, a merchant portal, FloAdmin UI, usage metering and self-serve activation (G).

## 10. Hardware Compatibility Audit

| Item | Finding |
|---|---|
| ESC/POS receipt (58/80 mm) | Implemented (`printers/thermal.ts`, profiles). Tested with byte-level and mock tests only. **B**. |
| USB / network TCP 9100 / OS print queue | Implemented in backend. Serial: not verified. Bluetooth listed in type. **B** |
| Kitchen printing, stations | Implemented, tested (issue-134) |
| Error handling, retry | Partial. Not validated with a real disconnected printer. |
| Paper/cover status | Not found (E) |
| Cash drawer | `buildCashDrawerKick` + `/retail/cash-drawer/open`. **Meridian drawer button: not wired** (hard-coded panel). B / D |
| Barcode scanners | Keyboard-wedge would work through the search box, but no scan handler or rapid-scan guard. **D/B** |
| Customer display | Not found. **E/F** |
| Test-print workflow | Backend test-print route exists (legacy UI). **Meridian has none.** |
| Hardware simulator / diagnostics | Mock transports in tests only. No user-facing simulator. |

### Real Hardware Test Matrix (all ACTUAL = not yet tested)

| Device | Protocol | Model | Connection | Test | Expected | Actual | Status |
|---|---|---|---|---|---|---|---|
| Receipt printer | ESC/POS | pilot's model (TBD) | USB | test print, full receipt, cut | prints, correct width | not tested | B |
| Receipt printer | ESC/POS | TBD | TCP 9100 | same, unplug mid-job | error surfaced + retry | not tested | B |
| Receipt printer | OS queue | TBD | Windows spooler | print via driver | prints | not tested | B |
| 58 mm vs 80 mm | profile | TBD | any | column wrap check | no wrap errors | not tested | B |
| Kitchen printer | ESC/POS | TBD | TCP | KOT per station | routed ticket | not tested | B |
| Cash drawer | printer kick RJ11/12 | TBD | via printer | open on cash sale + manual open | opens | not tested | B |
| Barcode scanner | HID keyboard | TBD | USB | scan 20 items fast, repeat scan | one add per scan | not tested | B/D |
| Card terminal | provider SDK | pilot provider (TBD) | LAN/cloud | authorise, decline, refund | real settlement | **no integration** | E |
| KDS screen | browser :3002 | any | LAN | order → KDS → bump | real-time | inherited tests pass; not on device | B |
| Two-terminal | sync | 2 PCs | LAN + cloud | sell on both offline, reconnect | no duplicates | PG tests only | B |

## 11. Payment Provider Audit

Only `cash`, `wallet` and `manual_card` adapters exist (`PaymentAdapterId`). `payment.ts` lists Teya, Worldpay, SumUp, Shift4 and Elavon as "(later)". Dojo is not mentioned.

| Provider | Status |
|---|---|
| Teya, Dojo, Worldpay, SumUp, Elavon, Shift4 | **NOT IMPLEMENTED** (comment only; external credentials and a physical test would be required) |
| Manual card | Cashier attests; the payment is recorded as `captured`, not `settled`. Honest model, but no verification. |

The first pilot provider is **H**: it must be chosen by the owner. With manual-card entry the pilot can run, but card takings are not reconciled to the terminal by software.

## 12. Offline / Sync / Multi-Terminal Audit

- **Implemented (A code):** outbox, uploader, downloader, worker, idempotency, device signing (Ed25519), conflict model and resolution, reconciliation, inventory/sales/payment/audit/catalog/customer/supplier/purchasing/transfer event flows, stale and revoked devices (`main/core/sync/*`).
- **Run this audit:** SYNC-D/E/F/G, commercialization and platform-hardening against real Postgres: all pass. `npm test` (which runs with the Postgres suites self-skipped) also passes. `meridian-sync-status` passes.
- **Offline selling:** local SQLite is the source of truth, so selling offline is structural. **B:** no real network-drop test on a device.
- **Multi-terminal:** tested with two simulated devices in PG suites. Not tested with two physical machines. The Meridian UI has no conflict or reconciliation screen.
- **Not proven:** long-offline (days) resync volume, clock skew on real POS hardware, the cloud under concurrent load.

## 13. Money / Financial Integrity Audit

- **Integer minor units (A for the new path):** `main/core/money.ts`, `payments` (`amount_minor`, `refunded_minor`, `tendered_minor`, `change_minor`, `tip_minor`), cash sessions and movements (`*_minor`). `allocateMinor` (largest-remainder) guarantees that splits sum exactly. Tests: `plemmo-money` (54).
- **Floating-point currency remains (the known issue):** `main/db.ts` has about 72 `REAL` columns. These include `products.price`/`cost`, `orders`/`order_items` totals, `bills` (`subtotal`, `tax`, `total`, `paid_amount`, `balance`), purchase-order totals, inventory `unit_cost`, and the `sales_*` sync mirror columns (`total REAL`). `PLEMMO_ARCHITECTURE.md` lists conversion of these as deliberately deferred.
  - **Classification: MUST FIX BEFORE REAL MERCHANT, or be explicitly accepted by the owner (H).**
  - Mitigation in place: the payment ledger uses integer minor units, and the tax engine is tested (inclusive/exclusive, rounding). Risk: a penny drift between bill totals (REAL) and the payment ledger (integer). I did not find a failing case, and the tests pass. The design does not exclude one.
  - Converting core money columns is a one-way door, and should be done before any live data exists.
- **Refunds/voids keep history:** payment refunds are separate rows (`refunds` table). Original rows are not overwritten. But the Meridian refund path is local-only (see §6), so a till refund never reaches the ledger.
- **VAT, margins, valuation:** VAT tested. Margin and valuation reports not verified. No external accountant review has been done (H).

## 14. Data / Migration / Backup Audit

- Migrations v1–v95, non-destructive pattern (additive; PRAGMA user_version), upgrade-path test against a real v1.5.0 fixture, `schema-health` (fresh vs migrated zero drift), `migration-v56-v57`, `issue-214-migration`: all pass (A).
- Backup creation, restore, pre-migration backup, corrupted/legacy-FK recovery: tested (`backup-restore*`, `recovery-legacy-fk`) (A code). **B:** not tested on a real Windows install or with a real restore drill.
- Meridian's own "Backup" button exports client state JSON, not the database (see §6). Operators must use the database-tools API, which has no Meridian screen.
- Cloud Postgres backup and rollback: undocumented (C/E).
- History preservation: audit events are append-only. Sales use a status field, payments have refund rows. Adjustments go through the inventory ledger. No destructive rewrite found.

## 15. Security Audit

What was done: ran the existing security suites (passing in `npm test`: security-hardening, cors, authz matrix, staff/orders authz, customer auth, jwt lifecycle, admin API 401/503/ReDoS edge cases). `npm audit --omit=dev` run. CodeQL default setup is active and green. I did **not** perform new live attack tests or penetration testing.

| Area | Finding |
|---|---|
| Auth, sessions, roles, tenant isolation | Tested (A) |
| Device identity/revocation, signed requests | Ed25519 device signing (A code) |
| Replay protection | Idempotency keys + signed uploads. Nonce/timestamp replay window not verified. |
| Admin API | Bearer token, timing-safe, rate-limited, closed by default (A). Static shared token with no rotation/IP allow-list (D). |
| Licence tampering | See §8. |
| LAN exposure | API and KDS bind to `0.0.0.0` (`main/server.ts:314`, `kds-server.ts:598`) so other devices on the LAN can reach the POS API, with no TLS on the LAN. Protected by auth. **D (decision: LAN terminals need it)**. |
| Electron | `contextIsolation: true`, `nodeIntegration: false`, but **`sandbox: false`** (`main/index.ts:220`). Comment justifies it. (D) |
| Dependencies | `npm audit --omit=dev`: 3 advisories (2 high: `brace-expansion`, `js-yaml`; 1 moderate: `qs`), fixes available. Likely transitive build/dev-chain. **Not triaged for reachability.** (D) |
| Secrets | No committed private keys or API tokens found by pattern scan. Test passwords in tests only. Secret scanning and push protection are not confirmed enabled (C). No gitleaks in CI. |
| ReDoS | One CodeQL high found and fixed this cycle. |
| GitHub Actions | SHA-pinned actions. CodeQL default setup. Dependabot configured. |

## 16. Electron / Windows Audit

- Config: NSIS x64 target, `asarUnpack` for better-sqlite3, `extraResources` ships `frontend-out` and `meridian`. `electron-updater` is wired to the GitHub repo `richanonymous22/FloCafe`.
- **Not verified, cannot be verified here:** a Windows build has not been produced or installed by this audit. No Windows-runner CI job exists (linux-baseline only).
- **Branding/identity:** `appId com.plemmo.epos`, `productName Plemmo EPOS`. The **AppX block still says `CodifyAppsPrivateLimited.FloCafe`, `Flo Cafe`, Codify publisher GUID**; the **mac block still says `Codify Apps Private Limited (BKDY677XJA)`** and `build/flo.provisionprofile`. These are third-party identities and cannot produce a valid build for you (E/H).
- **Update feed** points at the development repo, not a release repo (H/C).
- Code signing: no certificate (C, longest lead time). Without one, SmartScreen will warn.
- DPAPI/safeStorage: used by Google Drive token and master PIN (keyring availability is checked at first-run).
- Fresh Windows machine can install and operate? **Unknown / not proven (B).**
- Crash recovery, logging: `electron-log` is used. No crash reporter.

## 17. Production Deployment Audit

| Item | State |
|---|---|
| PostgreSQL, API host, domain, HTTPS/DNS | C: none exist |
| Secrets, signing keypair | C: none generated (and none should be by me) |
| Code-signing cert | C |
| Update feed | C/H |
| Email provider (receipts) | C (env-driven transport exists) |
| Backup storage, monitoring, log pipeline | E/C |
| CI/CD | A for tests; release workflow exists (tag must equal package.json version and a CHANGELOG entry). No tag was ever created, so the release path has never run end to end. |
| Release artifacts | none |

## 18. Acceptance Test Audit

The §74 list is **not in the repository**, so it cannot be recreated faithfully. I will not invent it. Provisional replacement: the 30-step walk in §20 is the practical acceptance list. The owner should supply §74 and map each item (requirement / implementation / automated / manual / hardware / cloud / status). Automated coverage summary: 96 chained suites plus 12 Meridian plus 6 PG suites, all green. Manual, hardware and cloud acceptance: **0 recorded.**

## 19. Source-Code Sale / Owner Handoff Audit

| Item | Finding |
|---|---|
| Repo cleanliness | FloCafe mentions remain in: tax-pack catalog URLs and signing key (`main/tax-packs/*`), `google-drive.ts`, `db.ts` (legacy/upgrade names), `auth.ts`, issue templates, workflows, `renderer/*.html`, `frontend` hooks/config, `kill-ports.js`, `package.json` (AppX/mac identities, publish repo), tests. Some are legitimate (migration fixtures, MIT attribution). Others are functional (tax-pack source, Drive). **Needs classification pass.** |
| Tax-pack endpoint/signing key | `main/tax-packs` still references upstream catalogue details. A functional external dependency on FloCafe's tax-pack service needs an owner decision (H). |
| MIT attribution | Present and must stay (H: legal). |
| LGPL `sharp/libvips`, other third-party licences | Flagged in PR #1. No consolidated third-party notice file yet (D). |
| Setup/env/deploy docs | `cloud/DEPLOYMENT.md`, `.env.example` good. No owner-facing build/release/runbook, no secrets-handoff procedure, no troubleshooting or support guide (D/E). |
| API docs | `docs/API.md` covers inherited API. The new `/api/cash`, `/api/sync/status`, AI, receipts and `/admin/v1` are only partly documented (D). |
| Admin docs | Operator API in DEPLOYMENT.md only. |
| Reproducible build | CI builds on Linux. Electron Windows build unproven. |
| Demo routes/credentials | First-run `demo` profile seeds a Spanish-language demo restaurant (`seedDemoRestaurant`), a leftover from upstream (D). `02-data.js` holds demo data in the Meridian prototype. |
| Branding | Product name to be changed to "Meridian POS"/"Meridian EPOS" (user decision, not started). |
| IP/ownership | Whether Plemmo gets the source under MIT-derived terms, exclusivity, warranty and support terms: **H**. Not touched. |

## 20. Real Merchant Tomorrow Test

Walk-through, stop points in bold:

1. Get installer — **STOP: no installer/release exists.**
2. Install on Windows — **STOP (unsigned, never built/tested).**
3. First launch — works in tests (first-run setup form, PR #3). Not seen on Windows.
4. Configure business, 5. create user — works (setup, staff).
6. Configure products — single add and menu CSV work. No XLSX, no stock CSV.
7. VAT — UK pack present, configurable. Unreviewed by an accountant.
8. Printer — **STOP: Meridian has no printer setup or test print; receipts do not print from Meridian.**
9. Cash drawer — **STOP: no working drawer action in Meridian.**
10. Scanner — would type into the search box. Untested.
11. Card terminal — **manual card entry only, no integration.**
12. Register terminal, 13. activate license — **STOP: no cloud deployed, no activation UI in Meridian.** (Offline/unlicensed single-store use works.)
14. Sale — works.
15. Cash — works. 16. Card (manual) — works, unverified against terminal.
17. Print receipt — **STOP.**
18. Kitchen — works (KDS). Kitchen printer wiring from Meridian unverified.
19. Refund — **STOP: no backend path from the till, and Meridian only edits local state, so reports and stock will be wrong.**
20. Void — same local-state issue for open orders.
21. Close cash session — works.
22. Z report — **STOP: does not exist as a server report.**
23. Backup — API exists, no Meridian screen; the Meridian button exports the wrong data.
24–27. Offline / reconnect / sync — designed and tested; not physically tested.
28. Verify data — no merchant-facing reconciliation UI.
29. Update — updater is wired to the dev repo, unsigned; **STOP.**
30. Recover from failure — backup/restore tested in code; no operator UI; untested on Windows.

**Answer:** at least steps 1, 2, 8, 9, 13, 17, 19, 22 and 29 stop you. You could run a cash-only, offline, no-printer pilot. You should not do that for a paying merchant.

## 21. Contradictions Found

| # | Old document said | Code shows | Actually true | Remains |
|---|---|---|---|---|
| 1 | `MERIDIAN_PLEMMO_PRODUCTION_AUDIT` lists refunds, voids, receipts as COMPLETE or covered | `A.refund`, `A.voidOpen`, `printRc` do not call the backend | Sale path is authoritative. Refund, void and print are local/simulated in Meridian. | Wire the UI to backend. Add a refund route. |
| 2 | "Backend complete" (hardening docs) | No X/Z/EOD, stocktake, refund route, XLSX | Backend is complete for the built scope, not for the original scope. | Build or formally defer |
| 3 | "Licensing foundation" vs commercial licensing | Signing + lifecycle done; public key not pinned in build; no UI; no plan catalogue | Server contract complete, client enforcement depends on configuration | Pin key, UI, decide plans |
| 4 | Cloud architecture documents | No deployment | Code-ready only | Deploy |
| 5 | "Hardware/printer support" (`docs/printers.md`, tests) | Byte/mock tests only; Meridian Devices panel is hard-coded "Connected" | Not validated on any physical device; the panel is misleading | Physical tests and real panel |
| 6 | Payment abstraction | Only cash/wallet/manual_card | No provider integrations | Pick the provider and build |
| 7 | `docs/printers.md`, `docs/API.md` title "FloCafe" | Product is Plemmo/Meridian | Docs partly stale | Docs pass |
| 8 | Automated tests green | Tests cover the core, not the Meridian-local paths | Green ≠ wired | Add UI→backend tests |
| 9 | Commercialization tests | No merchant/location CRUD, no activation UI | Provisioning is API-only and partial | See §9 |
| 10 | "Remote dashboard" in requirements | Operator API only; FloAdmin is external/unbuilt | No dashboard exists | Build or defer |
| 11 | `COMMERCIAL_PLATFORM_COMPLETION` "NOT FloCafe" | AppX/mac/publish config still FloCafe/Codify | Branding/identity incomplete | Fix |
| 12 | Meridian backup "Backup" | Exports client `S` JSON | Not a database backup | Fix/relabel |
| 13 | Spec lists "price override" | No route/UI | Missing | Build or defer |

## 22. MUST FIX

1. **Refund path:** add a till refund route that calls `refundPayment`, and wire Meridian refund to it (restock, loyalty, audit, cash-drawer effect). Until then, hide or disable the Meridian refund button.
2. **Void:** wire Meridian void to the order status endpoint (and payment void where applicable), or disable it.
3. **Receipt printing from Meridian:** call `POST /bills/:id/print` and show real printer errors.
4. **Replace the hard-coded Devices panel** with real detection, test print and drawer test, or remove it.
5. **Z/X/End-of-day:** server-side report with immutable sequence numbers.
6. **Float money columns:** convert or get an explicit signed-off acceptance (§13).
7. **Pin the license public key** in the production build, and add a licence/activation screen.
8. **Replace FloCafe/Codify signing and store identities** in `package.json`.
9. **Fix the Meridian "Backup" action.**
10. **Hold/resume:** verify it, or wire it to `/held-orders`.
11. Triage `npm audit` high findings (2).
12. Confirm the production cloud entrypoint never enables dev enrol.

## 23. CODE COMPLETE — EXTERNAL DEPENDENCY (C)

Cloud host, Postgres, domain/TLS, admin token, license signing keypair, Windows code-signing certificate, update feed, email provider, backup storage, monitoring, secret scanning enablement, a release tag.

## 24. REAL-WORLD TEST REQUIRED (B)

Printers (USB/TCP/queue, 58/80), kitchen printer, cash drawer, scanner, KDS on device, two-terminal offline/reconnect, a fresh Windows install, updater, backup/restore drill, UK VAT accuracy check, cloud under load, a card terminal flow.

## 25. DEFERRED / FUTURE (F/G, subject to owner confirmation)

Uber Eats, Deliveroo, Just Eat, online ordering, weighing scales, mobile app, accounting integration, AI forecasting/reorder/anomaly/images, Stripe/billing/self-serve portal, FloAdmin UI, advanced offers engine, customer display.

## 26. LEGAL / COMMERCIAL DECISIONS (H)

Plan names, prices and limits; first card-terminal provider; ownership/licence terms of the source-code sale (MIT attribution to FloCafe must remain); who holds the signing keys after handoff; which Phase 2/3 items are in the V1 sale; acceptance of the float-money risk; whether the LAN-exposed API is acceptable; tax-pack service dependency on FloCafe upstream; LGPL review of `sharp`/`libvips`; support/warranty terms; Plemmo vs Meridian final product name.

## 27. FINAL BLOCKER LIST

1. Refund/void/print/Devices in Meridian are not connected to the backend.
2. No Z/X/EOD reports.
3. No deployed cloud, database, domain, keys; no signed installer; no update feed.
4. No activation/licence UI; public key not pinned.
5. No card-terminal integration (provider undecided).
6. Floating-point money columns unresolved.
7. No physical-hardware validation of any kind.
8. FloCafe/Codify identities in build config; rebrand not done.
9. Original spec PDF and §74 acceptance list not available to verify against.
10. Owner-agreement and commercial decisions (§26).

## 28. Recommended Completion Order

1. Get the spec PDF and §74 from the owner, and confirm V1 scope (closes most "presumed F" items).
2. Wire or disable the Meridian till gaps: refund, void, print, hold, backup, Devices panel, scanner handler. Add the refund route and tests.
3. Server-side X/Z/EOD.
4. Decide and handle money: convert or sign off.
5. Rebrand and identity cleanup (incl. signing/store config), then the logo.
6. Deploy cloud (Postgres, host, domain, keys), pin the public key, add the activation screen, write the operator runbook.
7. Windows build on a Windows runner, install on a clean PC, code-sign.
8. Hardware test matrix (§10) with the pilot's real devices. Choose the card provider.
9. Pilot merchant.
10. Handoff pack: docs, third-party notices, secrets handoff, legal terms.

---

## Verification run log (this audit)

- `npm test`: exit 0 (96 chained suites; PG suites self-skipped in this run).
- `npm run test:meridian`: exit 0.
- `npm run test:pg-sync` with local PostgreSQL 16: exit 0 (6 suites, 0 failed).
- `npm audit --omit=dev`: 3 advisories (2 high, 1 moderate).
- Not run: Playwright e2e, Windows build/install, hardware, cloud deploy.
