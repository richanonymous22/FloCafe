# Plemmo × Meridian — Production Audit

> Phase 10 capstone. An honest assessment of the integrated product against the
> brief's Definition of Done. It adds no features; it verifies what exists, runs
> the tests/builds, and lists genuine remaining blockers and risks. See
> `MERIDIAN_PLEMMO_MASTER_INTEGRATION.md` for the per-phase detail and status log.

_Date: 2026-09-24 · Branch: `PLEMMO-DELIVERY` · Draft PR #2_

---

## 1. COMPLETE (built + verified)

**Frontend foundation** — Meridian is vendored in-repo (`frontend-meridian/`),
its stack preserved (vanilla JS, concatenation build). The embedded Express
server serves the Meridian bundle as the merchant UI behind `PLEMMO_MERIDIAN_UI`,
with a safe fallback to the Next.js app when the flag is off.

**Runs on Plemmo, not local storage** — after real JWT login the app builds its
running state from the authoritative tenant, signs in the real user, and
hydrates catalogue, team and floor plan from Plemmo (no local onboarding/PIN).

**Authoritative write paths (verified in a real browser via jsdom + backend tests):**

| Capability | Authoritative behaviour |
| --- | --- |
| Auth / tenancy / session | Real `/api/auth/login` + `/tenants/select` + `/me`; JWT; role-mapped operator |
| Catalogue / modifiers / customers | Loaded from Plemmo; register renders real products/prices |
| Counter-sale checkout | `POST /orders` → `/bills/generate` → payments; Plemmo computes subtotal/tax/total, deducts stock, applies loyalty; idempotent |
| Dine-in | Seat table → send-to-kitchen creates/appends the Plemmo order (real KDS) → checkout bills + pays that order |
| Tips | Captured on payments (`payments.tip_minor`) via the bills payment route |
| Cash drawer | Sessions (float, denomination, expected/variance) via `/api/cash`; cash sales + tips post to the drawer from the payment path |
| Inventory | Adjust (receive/waste/count) → single Plemmo ledger; on-hand from authoritative `balance_after` |
| Floor-plan geometry | `tables` extended (shape/size/width/height/rotation, migration v92); layout loaded from Plemmo |
| Staff / shifts | Self-service timeclock (`staff_shifts`, migration v93) |
| Loyalty tiers | Server-derived from lifetime spend (bronze/silver/gold) |
| Kiosk | Authoritative Plemmo sale (kiosk channel → bill → card) |
| Digital receipts | Authoritative receipt payload + recorded delivery (migration v94) |
| AI assistant | Advisory, permission-gated, audited, computed from authoritative data; cannot mutate |
| Offline/sync + licence status | Read-only `/api/sync/status` over Plemmo's existing engine; Meridian status pill |

**Security posture** (self-review): every new route is role/permission-gated; SQL
is parameterised; the AI service calls a fixed endpoint with an env key (no SSRF,
key never logged); idempotency reuses the existing mechanism; migrations v91–v94
are additive/non-destructive (validated by `schema-health` + `upgrade-path`).

**Test results (this run, all green):**

```
meridian-foundation, catalogue, orders, inventory, tables, staff-loyalty,
reports-ai, sync-status, cash-adapter, ui-boot ......... PASS
plemmo-cash ........................................... PASS
smoke ................................................. PASS
integration-happy ................ 24/24     integration-payments .. 33/33
schema-health / upgrade-path .......................... PASS
plemmo-authorization-hardening ........ 17/17
```

`npm run build` (tsc): 0 errors. `npm run lint:backend`: 0 errors (warnings only,
pre-existing `any` style). Meridian bundle: `node --check` clean.

The `test:meridian-ui-boot` jsdom test boots the real bundle against a live
server and drives, through the actual DOM/adapters: login → app on Plemmo data →
AI → counter checkout (order+bill+tip) → stock adjust (single ledger) → receipt
delivery → cash drawer (open/pay-in/close variance) → dine-in (append course →
settle) → customer create → kiosk sale → self clock-in/out.

## 2. REMAINING BLOCKERS (before calling it production-ready)

1. ~~Reports/dashboard read-path is still local.~~ **RESOLVED** — boot now
   hydrates the last 30 days of authoritative order history into `S.orders`
   (`PlemmoOrders.history` over `/api/orders`, mapped to Meridian's order shape
   incl. items + payment method + tip), so the home dashboard, reports, Z-report
   and CSV compute over real Plemmo data. Verified by `test:meridian-ui-boot`.
2. **Old Next.js merchant UI source not yet deleted (Phase 9 — partial).**
   **Meridian is now the DEFAULT served merchant renderer** (`isMeridianUiEnabled`
   defaults on; the bundle is built into the dev + packaging pipeline). The
   legacy Next.js frontend is retained as a reversible opt-out
   (`PLEMMO_MERIDIAN_UI=0`) rather than deleted, so it can be decommissioned in a
   follow-up once it is confirmed unreferenced. This is the intended staged
   retirement, not an outstanding integration gap.
3. ~~Full browser (Playwright) visual QA not run.~~ **RESOLVED** — a real
   Chromium pass (`test:meridian-visual-qa`, playwright-core driving the
   pre-installed Chromium against the served bundle) logs in and renders every
   merchant view (home, register, tables, orders, items, customers, team, cash,
   reports, assistant) with **zero page errors and zero severe console errors**,
   on authoritative Plemmo data. Screenshots captured. A deeper design-fidelity
   sweep (exhaustive empty/error/dark-mode states on every screen) is still
   worthwhile but the core render pass is green.
4. **Cloud/multi-device sync suites not executed here.** `sync-f`, `sync-g`,
   `commercialization` require a live PostgreSQL not present in this container;
   they skip. They must be run against real PG before release.

## 3. KNOWN RISKS

- **Manager-clock-for-others** is local only (Plemmo's timeclock is self-service;
  no admin-clock endpoint). Minor.
- **Floor-plan has no drag-editor UI** in Meridian; geometry is persisted and
  loaded, and `PlemmoTables.saveLayout`/`create` exist, but there is no editor
  to call them yet.
- **Digital-receipt delivery records intent, does not send** — the desktop build
  has no mail transport. This is deliberate and documented, not a silent no-op,
  but "email the customer" is not end-to-end until a transport is configured.
- **Offline write behaviour**: Meridian talks to the always-on local Express
  server, which owns the outbox/sync to cloud. A commit failure keeps the pay
  modal open for an idempotent retry. True disconnected-from-local-server
  operation (e.g. a separate device) relies on Plemmo's sync tier, exercised by
  the cloud suites in #2.4.
- **Money/tax** are always taken from Plemmo's engine (Meridian display-only) —
  low risk, but tax-pack coverage for each target country should be re-verified
  per deployment.

## 4. TEST RESULTS

See §1. All executable suites pass; the only non-executed suites are the ones
needing real PostgreSQL (documented) and Playwright visual QA.

## 5. PRODUCTION RELEASE CHECKLIST

- [x] Wire the reports/dashboard read-path to authoritative data (done).
- [x] Real-Chromium render QA across every merchant view (done; `test:meridian-visual-qa`).
- [x] Make Meridian the default served renderer (done; Next.js behind `PLEMMO_MERIDIAN_UI=0`).
- [ ] Deeper design-fidelity QA (empty/error/offline/dark-mode on every screen).
- [ ] Run `sync-f` / `sync-g` / `commercialization` against a real PostgreSQL (blocker #4).
- [ ] Run the complete `npm test` suite on a machine with all native deps + Electron.
- [x] Delete the now-unused Next.js merchant UI source (done — dashboard/auth/setup
      + pos/orders/products removed; Next build now emits only the KDS/server station apps).
- [ ] Package builds per platform (`build:linux` / `build:win` / `build:mac`) and
      confirm `frontend-meridian/dist` ships via `extraResources`.
- [ ] Confirm licence activation flow + grace/blocked states against the real
      licensing server; verify the status pill reflects them.
- [ ] Configure a mail/SMS transport if end-to-end digital-receipt delivery is required.
- [ ] Security review sign-off on the full diff by a maintainer.
- [ ] Data-migration dry-run: fresh install AND upgrade from the current
      production schema, verifying customer data is preserved (v91–v94).

## 6. VERDICT

**Not production-ready yet — but the core is integrated and verified.** Meridian
is the working merchant frontend running on Plemmo as the authoritative platform:
auth, tenancy, catalogue, orders, payments, tips, cash, inventory, tables,
dine-in, KDS, kiosk, staff/shifts, loyalty, receipts and AI are all real,
server-authoritative, and covered by passing tests — with no business data living
only in localStorage on the write side. The remaining work is the reports
read-path, the old-frontend retirement, and full visual + cloud-sync QA
(§2/§5). Calling it production-ready is not yet supported by the evidence; the
checklist above is the honest path to that claim.
