# Meridian → Plemmo Master Integration Map

> **Purpose.** This document is the authoritative cross-map for replacing the
> current Plemmo (FloCafe) merchant frontend with the **Meridian** UI while
> keeping Plemmo as the authoritative backend/platform, and extending the
> Plemmo backend wherever Meridian needs a capability Plemmo does not yet
> provide.
>
> It is a living document. Each feature row carries a **STATUS** and
> **REMAINING WORK** column so the integration can be executed and tracked
> across multiple PRs. This document is produced by the audit phase
> (Phases 1–5 of the brief); the implementation phases (6–16) reference it.

---

## 1. Meridian frontend stack (as found)

Determined by inspecting the attached `meridian-pos-repo`:

| Aspect | Finding |
| --- | --- |
| Framework | **None.** Vanilla JavaScript, no React/Vue/Next/Vite. |
| Build | `build.sh` concatenates `src/01-shell.html` + five `.js` files into a single self-contained `dist/meridian-pos.html`. No bundler, no `npm install`, no transpile. |
| Language | Plain ES2020+ browser JS (no TypeScript, no modules/imports — files share one global scope by concatenation order). |
| Rendering | Full-view re-render per state change via `.innerHTML =`. No virtual DOM. Views registered in a `VIEWS` map returning HTML strings; optional `AFTER` post-render hook per view. |
| Interactivity | Event delegation only. `data-act`→`A.fn`, `data-in`→`IN.fn`, `data-ch`→`CH.fn`, wired once. |
| State | One global object `S` (`settings, roles, categories, modGroups, products, employees, shifts, customers, orders, tickets, tables, held, stockLog, drawer`) persisted to `localStorage` on every mutation via `save()`/`saveNow()`. Session state in `U`. |
| Auth | 4-digit PIN checked in memory. No hashing, no sessions, no server. |
| Tenancy | None. "New business" rebuilds `S` from scratch. Single-device, single-browser. |
| IDs | Client-generated (`uid()`). |
| AI | `window.claude.use('sample')` (Anthropic artifact runtime) when present, else a local rule-based `localAnswer()` over `snapshot()`. |
| Styling | Inline CSS design system in `01-shell.html`: CSS custom properties, light/dark themes, 5 accent colours, responsive to phone width, touch targets. British English, £ default. |

**Decision (per brief §2):** preserve this stack. Meridian stays vanilla-JS,
concatenation-built, event-delegated, full-re-render. We do **not** migrate it
to React/Next. Refactoring happens *within* this stack — the seam we change is
the **data layer** (`save`/`loadState` and the `A.*`/`IN.*`/`CH.*` handlers
that mutate `S` directly), which becomes async and calls the Plemmo API, exactly
as Meridian's own `CLAUDE.md` "Known limitations" section anticipates.

## 2. Meridian frontend architecture

- `01-shell.html` — `<head>`, fonts, full CSS design system, body skeleton, opening `<script>`.
- `02-data.js` — utilities (`money`, `esc`, `uid`, dates), `ic()` icons, sample data, state store (`save`/`loadState`), `buildBusiness()`, `genHistory()`.
- `03-app-shell.js` — session (`U`), `can()` permissions, modal/drawer/toast/popover, command palette, PIN lock, onboarding.
- `04-register-kitchen.js` — register (cart, modifiers, discounts, split payments, receipts), tables floor plan, kitchen display, order history & refunds.
- `05-backoffice.js` — items & stock, customers/loyalty, team/timesheets, cash drawer, settings.
- `06-dashboard-ai-kiosk.js` — home dashboard, reports, end-of-day, AI assistant, self-service kiosk, global event wiring, boot sequence.

**Views (12):** `home, pos, tables, kitchen, orders, items, customers, team,
cash, reports, assistant, settings` + kiosk mode.

## 3. Plemmo backend architecture (as found)

| Aspect | Finding |
| --- | --- |
| Runtime | **Electron 43** desktop app. Main process (`main/`) in TypeScript, compiled to `dist/`. |
| API | **Express** on port 3001 (+ WebSocket). Standalone KDS server on 3002 (`KDS_PORT`). Routes registered in `main/routes/index.ts` under `/api/*`. |
| Persistence (local) | **better-sqlite3**, WAL mode, schema versioning via `PRAGMA user_version`. All schema + migrations + DAL in `main/db.ts` (~6.3k lines). |
| Persistence (cloud) | **PostgreSQL** store under `cloud/` (`postgres-store.ts`, `migrations/postgres/*`) for the cloud sync tier + licensing. |
| Auth | JWT (bcrypt password hashing) — `main/routes/auth.ts`. `/login`, `/tenants/select`, `/refresh`, `/logout`, `/me`, `/password/change`, `/recover-password`, `/setup/*`. |
| Authz | Server-enforced roles (`owner/manager/cashier/waiter`), `requireRole(...)`, `main/core/authorization.ts`, `employee-access.ts`. |
| Tenancy | Business / Location / Terminal / Device model; device identity + credentials under `main/core/sync/device-identity.ts`, `device-credentials.ts`; licensing in `main/core/licensing.ts`. |
| Sync | First-class offline-first sync engine: `main/core/sync/` — outbox, uploader/downloader, http-transport, signing/key-store, conflict-model/resolution/store, reconciliation (sales, payment, inventory), worker. |
| Domain | `main/core/`: `sale.ts`, `payment.ts`, `payment-reconciliation.ts`, `inventory.ts`, `transfers.ts`, `money.ts`, `audit.ts`, `location-reports.ts`, `features.ts`, `licensing.ts`. Verticals in `main/modules/` (hospitality, retail, purchasing). |
| Frontend (current) | **Next.js 16 / React 19** static export in `frontend/`, served by the embedded Express server from `frontend/out` (`main/server.ts` → `express.static` + per-route `index.html`). Electron loads `http://localhost:3001`. |

## 4. Serving model (how the frontend is delivered today)

`main/server.ts` locates `frontend/out` (dev) or `resources/frontend-out`
(packaged), serves it with `express.static`, and resolves clean routes to each
Next.js page's `index.html`. Electron's `BrowserWindow` loads
`http://localhost:${PORT}`. **This is the single seam where Meridian becomes
the active renderer** — the server chooses which built frontend directory to
serve.

---

## 5. Feature cross-map

Legend for **STATUS**: `✅ backend exists` · `🟡 partial` · `🔴 backend gap` ·
`⚪ frontend-only in Meridian`.

| # | Meridian feature | Meridian impl | Required Plemmo domain | Plemmo API | DB changes | Authz | Offline/Sync | STATUS | Remaining work |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Login / PIN | in-memory 4-digit PIN, `U` | Users, JWT, manager-PIN | `/api/auth/login`, `/tenants/select`, `/me`, `master-pin` | none | server roles | token cached | ✅ | Replace fake PIN with real login + PIN-verify for overrides; store JWT + tenant. **(Foundation PR: real auth client added.)** |
| 2 | Tenancy / business setup | `buildBusiness()` local | Business/Location/Terminal/Device | `/api/auth/setup/*`, `/api/locations`, `/api/settings` | none | owner | device identity | 🟡 | Wire onboarding to `/setup/status`+`/setup/initialize`; bind device via sync device-identity. |
| 3 | Catalogue (categories/products) | `S.categories/products` | Products, Categories | `/api/categories`, `/api/products` | none | roles | outbox | ✅ | Replace `S` reads with API loads; cache for offline. |
| 4 | Modifiers | `S.modGroups` | Addon groups | `/api/addon-groups` | none | roles | outbox | ✅ | Map Meridian modGroups ↔ addon-groups shape. |
| 5 | Register / cart / order build | `S.orders`, cart in memory | Orders, order-items, sale engine | `/api/orders`, `/api/order-items`, `core/sale.ts` | none | roles | outbox + idempotency | ✅ | Cart stays UI state; commit via orders API with client idempotency key. |
| 6 | Order types (dine-in/takeaway/delivery/retail) | field on order | order_type on orders | `/api/orders` | none | roles | outbox | ✅ | Map enum values. |
| 7 | Discounts (+ manager PIN) | local calc | discount on order/bill, master-pin | `/api/orders`, `services/master-pin` | none | manager PIN | outbox | ✅ | Enforce PIN server-side (already), remove client-only approval as source of truth. |
| 8 | Split payments / tips / change | local | Payments, bills | `/api/bills`, `core/payment.ts` | **tips: add `tip_amount`** | roles | payment-events + idempotency | 🟡 | Backend gap: **tips/gratuity** not modelled. Add tip fields + reconciliation. Split/partial already supported. |
| 9 | Receipts (printed-style + digital) | HTML render | Receipt service, printers | `services/receipt.ts`, `/api/printers` | none | roles | n/a | 🟡 | Reuse receipt service; add **digital receipt** delivery endpoint (email/QR) — backend gap. |
| 10 | Tables / floor plan | `S.tables` + x/y in UI | Tables | `/api/tables` | **add `shape`,`width`,`height`,`rotation`,`seats`** | roles | outbox | 🟡 | Backend has `position_x/y, floor, section, capacity`; **gap: shape/dimensions/rotation** for true floor-plan editing. |
| 11 | Kitchen display (KDS) | `S.tickets` | KDS service | `/api/kds`, `/api/kitchen`, `/api/kitchen-stations`, WS 3002 | none | roles | KDS WS | ✅ | Point Meridian kitchen view at KDS API/WS. |
| 12 | Order history & refunds | `S.orders` | Orders, refunds, void | `/api/orders`, `/api/bills` | none | manager | reconciliation | ✅ | Wire refund/void to real endpoints; server authoritative. |
| 13 | Held / parked orders | `S.held` | Held orders | `/api/held-orders` | none | roles | outbox | ✅ | Direct mapping. |
| 14 | Items & stock / adjustments | `S.stockLog` | Inventory | `/api/inventory`, `core/inventory.ts` | none | roles | inventory-events | ✅ | Replace `stockLog` with inventory API; single ledger. |
| 15 | Stocktake / variance | local | Inventory reconciliation | `/api/inventory`, `admin/inventory-reconciliation` | verify stocktake tables | manager | inventory-events | 🟡 | Confirm stocktake session endpoints; extend if missing. |
| 16 | Suppliers / purchasing / transfers | (limited in Meridian) | Purchasing | `/api/suppliers`, `/api/purchase-orders`, `/api/transfers` | none | manager | outbox | ✅ | Surface in Meridian where present. |
| 17 | Customers / loyalty (points+tiers) | `S.customers` | Customers, loyalty | `/api/customers`, `/api/crm/lookup`, `/api/customers-search` | verify tiers | roles | outbox | 🟡 | Points supported; confirm **tier** model, extend if needed. |
| 18 | Offers / promotions | local | Catalog promotion | `core/admin/catalog-promotion.ts` | verify | manager | outbox | 🟡 | Map Meridian offers to promotion engine; extend coverage. |
| 19 | Team / roles / permissions | `S.employees`, `S.roles` | Staff | `/api/staff` (`/api/users`) | none | owner | outbox | ✅ | Real users + server roles; client `can()` becomes UX-only. |
| 20 | Shifts / timesheets | `S.shifts` | Shifts | *(gap)* | **add shifts + clock-in/out**? verify | roles | outbox | 🔴 | No dedicated shifts route found; **backend gap** — build shift/timeclock domain + API. |
| 21 | Cash drawer / denomination count | `S.drawer` | Cash sessions | *(gap)* | **add cash_sessions + denomination lines** | manager | reconciliation | 🔴 | No cash-session route found; **backend gap** — build cash drawer open/close/count/variance domain + API. |
| 22 | Reports / heatmap / CSV / EOD | computed over `S` | Reports | `/api/reports`, `location-reports.ts` | none | manager | reads authoritative | ✅ | Point reports at real endpoints; keep Meridian visuals. |
| 23 | AI assistant / insights | `window.claude` + `localAnswer` | AI service | *(gap)* | none (or audit log) | roles | online-only + local fallback | 🔴 | **Backend gap** — build a Plemmo AI service endpoint that runs advisory queries over authoritative data via existing services; actions must pass validated services + authz + audit. |
| 24 | Self-service kiosk | mode flag | Orders, kiosk session | `/api/orders` (+ kiosk context) | verify kiosk flags | limited/anon | outbox | 🟡 | Kiosk order creation via orders API with kiosk terminal context; confirm anonymous cart rules. |
| 25 | Collection / order board | (customer-facing) | Orders/KDS status | `/api/kds-info`, `/api/orders` | none | public read | WS | 🟡 | Build read-only board fed by order/KDS status. |
| 26 | Settings (business/tax/receipt/theme) | `S.settings` | Settings, tax packs | `/api/settings`, `/api/tax-packs`, `/api/payment-methods` | none | owner/manager | outbox | ✅ | Map Meridian settings to real settings keys; tax via tax-pack engine. |
| 27 | Offline / online / syncing / license status UI | localStorage only | Sync + licensing | `sync/*`, `core/licensing.ts` | none | n/a | Plemmo sync engine | 🟡 | Add Meridian-styled status chips fed by real sync/license state; **do not** create a second sync protocol. |
| 28 | Device / terminal identity | fake | Device identity | `sync/device-identity`, `device-credentials`, `/api/mobile/*` | none | owner pairing | signed | 🟡 | Replace fake device state with real pairing + signed identity. |

### Backend gaps requiring new Plemmo capability (summary)

1. **AI assistant service** (#23) — new advisory endpoint over authoritative services, authz + audit enforced.
2. **Cash drawer sessions + denomination counting** (#21) — new domain, API, migration, reconciliation.
3. **Shifts / timeclock** (#20) — verify/build shift domain + API.
4. **Tips / gratuity** (#8) — add to payment/bill model + reconciliation.
5. **Floor-plan geometry** (#10) — extend `tables` with shape/dimensions/rotation/seats.
6. **Digital receipts delivery** (#9) — email/QR endpoint on top of receipt service.
7. **Customer tiers / offers coverage** (#17/#18) — verify and extend as needed.
8. **Kiosk session context + collection board** (#24/#25) — confirm/extend.

Every gap must be built on Plemmo's existing architecture (domain service →
route → migration with `user_version` bump preserving data → authz → audit →
outbox/sync → tests), per `AGENTS.md` and `docs/PLEMMO_DEVELOPMENT_RULES.md`.

---

## 6. Current Plemmo frontend to be retired

`frontend/` (Next.js 16 / React 19 static export) is the current merchant UI.
Per brief §16 it ceases to be the active merchant renderer. Retirement is
**staged, not a big-bang delete**:

- **Keep (infrastructure):** the embedded Express server, API routes, KDS
  server, Electron main process, build/packaging, sync engine — none of this
  is "frontend" in the retired sense.
- **Retire (merchant UI):** `frontend/src/app/(dashboard)/*` merchant screens,
  once the equivalent Meridian view is wired and verified. Remove per-view as
  its Meridian counterpart reaches parity (avoids a broken intermediate app).
- **Reuse if useful:** `frontend/src/lib/*` pure helpers (phone, currency,
  i18n enums, printer encoder usage) may inform the Meridian API client, but
  Meridian must not be rebuilt in React.

The **serving switch** (`main/server.ts`) selects Meridian vs Next output, so
retirement can be gated behind a flag and flipped when parity is reached.

---

## 7. Proposed final architecture

```
Electron main (unchanged)
  └─ Express :3001  ──serves──►  Meridian bundle (dist/meridian-pos.html + assets)
       ├─ /api/*   ── Plemmo routes (authoritative)
       ├─ core/*   ── sale/payment/inventory/... domain services
       ├─ sync/*   ── outbox / uploader / conflict / reconciliation
       └─ SQLite (local, WAL) ⇆ PostgreSQL (cloud tier, licensing)
  KDS server :3002 (unchanged)

Meridian (vanilla JS, same stack)
  ├─ CSS design system + 12 views + kiosk  (PRESERVED look & feel)
  ├─ plemmo-api.js  ── real fetch client: JWT, tenant, idempotency, retry
  ├─ store adapter  ── async load/commit against /api/*  (replaces localStorage-as-truth)
  ├─ offline cache  ── read-through cache + queued mutations via Plemmo outbox semantics
  └─ status/license/device UI  ── Meridian-styled, fed by real state
```

Source of truth = Plemmo (money, orders, bills, payments, refunds, stock,
customers, loyalty, users, tenancy, licensing, reports, audit). Meridian state
is UI/temporary + offline cache only.

## 8. Major technical risks

1. **Data-model impedance** between Meridian's flat `S` shapes and Plemmo's
   normalised schema (esp. modifiers, tax breakdown, bill/order split). Mitigate
   with an explicit adapter layer, not ad-hoc mapping.
2. **Offline correctness.** Meridian's localStorage "offline" must be replaced
   by Plemmo's outbox/idempotency/conflict engine — not a parallel one. Highest-
   risk area; requires reusing `sync/*` rather than reinventing.
3. **Money/tax integrity.** All totals/tax must come from Plemmo's money + tax
   engine; Meridian's local calculators must be display-only.
4. **New backend surface** (AI, cash, shifts, tips, floor-plan) must not bypass
   authz/audit/idempotency.
5. **Scope.** This is a multi-PR programme; a broken intermediate app is the
   main delivery risk — mitigated by the per-view serving flag and staged
   retirement.
6. **Packaging.** Meridian must be copied into `resources` for packaged builds
   (electron-builder `extraResources`) exactly as `frontend-out` is today.

## 9. Recommended implementation order (maps to brief Phases 6–17)

1. **Foundation (this PR):** audit + this map; vendor Meridian into the repo;
   add real Plemmo API/auth client in Meridian's stack; add a flagged serving
   path so Meridian can be the rendered app without breaking the current app.
2. Auth/tenancy/device/licensing wiring (#1,#2,#28,#27).
3. Catalogue/modifiers/customers/loyalty (#3,#4,#17,#18).
4. Register/orders/bills/payments/cash + **tips** + **cash-drawer** backend (#5–#8,#12,#13,#21).
5. Inventory/purchasing/suppliers/transfers (#14–#16).
6. Tables/floor-plan backend + KDS + kiosk + collection board (#10,#11,#24,#25).
7. Reports/analytics/digital-receipt + **AI service** backend (#9,#22,#23).
8. Offline/sync integration (#27) → remove Meridian mock plumbing → retire old merchant UI (§6).
9. Full automated tests + visual QA (Phases 15–16) → document blockers (Phase 17).

---

## 10. Progress against phases (honest status)

| Phase | Scope | Status |
| --- | --- | --- |
| 1. Foundation | Meridian in repo, serving path, API client, **real auth**, session context, licence/sync status, safe fallback | **✅ complete & verified** |
| 2. Catalogue | products/categories/modifiers/customers from Plemmo (authoritative, read-through cache) | **✅ complete & verified** |
| Core POS — order write path | Meridian cart → Plemmo sale, **authoritative totals/tax**, idempotency (adapter + tests) | **✅ adapter complete & verified**; wiring into Meridian's live pay/checkout button is Phase 3 work (not yet wired, to avoid a half-integrated pay flow) |
| 3. Payments + Cash | split/partial/tips/change/refund/void; **new backend: tips, cash sessions, denomination counting, drawer reconciliation** | **✅ backend complete & verified** + client adapter; wiring into Meridian's live pay/drawer buttons pending (adapters ready) |
| 4. Inventory / Purchasing | stock/adjust/stocktake/suppliers/PO/transfers on Plemmo (single ledger, no second stockLog) | **✅ complete & verified** (adapter + client; reuses existing Plemmo ledger — no backend change) |
| 5. Hospitality | tables/floor-plan (**geometry gap now filled**)/KDS/collection board/kiosk | **✅ complete & verified** (migration v92 + adapters) |
| 6. Kiosk/Loyalty/Staff | kiosk, loyalty tiers, staff/roles, **shifts/timeclock (gap now filled)** | **✅ complete & verified** (migration v93 + adapters) |
| 7. Reports / AI / Receipts | reports on authoritative data; **AI service (built)**; **digital receipts (built)** | **✅ complete & verified** (AI service + receipt endpoints + migration v94) |
| 8. Offline / Sync | surface Plemmo's existing outbox/idempotency/conflict + licence state; no second protocol | **✅ status surface complete & verified**; register/catalogue/orders already commit through Plemmo's authoritative APIs + idempotency (earlier phases) |
| 9. Retire old frontend | make Meridian the sole merchant renderer | ⏳ not started |
| 10. Final production audit | end-to-end verification + release checklist | ⏳ not started |

## 10b. View-wiring progress (making Meridian's own UI use the adapters)

The phases above built + verified the backend and typed adapters. This section
tracks connecting Meridian's actual view handlers to them (the last mile), each
verified in a real browser env via jsdom (`test:meridian-ui-boot`).

| Wiring | Status |
| --- | --- |
| Boot from Plemmo (real login → build state from tenant, sign in real user, hydrate catalogue/team/tables; no local onboarding/PIN) | ✅ done & jsdom-verified |
| Assistant view → `PlemmoAI` (advisory, audited; local engine offline fallback; client mutation tool removed) | ✅ done & verified |
| Register **counter-sale** checkout → `PlemmoOrders` + `/bills/generate` + `PlemmoPayments` (authoritative totals/tax/stock/loyalty + tip; idempotent-retry on failure) | ✅ done & jsdom-verified |
| Connection/licence **status pill** → `/api/sync/status` | ✅ done & verified |
| Catalogue render → hydrated from Plemmo | ✅ done (boot) |
| Items stock-adjust → `PlemmoInventory` (single ledger); digital-receipt email → `PlemmoReceipts` | ✅ done & jsdom-verified |
| Cash-drawer screen → `PlemmoCash` (open/pay-in/pay-out/no-sale/close; authoritative expected + variance) | ✅ done & jsdom-verified |
| Dine-in: seat table → send-to-kitchen creates/appends the authoritative Plemmo order (real KDS) → checkout bills + pays that order; floor-plan layout loaded from Plemmo at boot (no drag-editor UI in Meridian — `saveLayout`/`create` adapters await one) | ✅ done & jsdom-verified |
| Remaining view handlers: team/timeclock, customers/loyalty create, reports view figures, kiosk submit | ⏳ handlers still local; adapters + backends ready and tested |

## 11. Status log

- **2026-09-24** — Audit complete (Phases 1–5). This map created. Foundation
  slice started: Meridian vendored, real auth/API client scaffolded, flagged
  serving path added. See PR on branch `PLEMMO-DELIVERY`.
- **2026-09-24** — **Phase 1 Foundation complete & verified.** Real Plemmo
  authentication gate wired into Meridian's boot (email/password → JWT), session
  context loaded from `/auth/me` (user/tenant/business/licence), Meridian-styled
  connection/licence **status pill**, API error/loading handling, and a safe
  fallback to the Next.js frontend (flag off). Verified: `npm run build` (tsc,
  0 errors), `npm run lint:backend` (0 errors), new `test:meridian-foundation`
  integration test (serving path + real login/`me` flow + protected-route 401 +
  fallback), plus smoke/cors/static-routes/first-run regressions — all green.
  Meridian's per-staff PIN lock is preserved as the "who's on the till" UX and
  will be backed by real Plemmo staff in the staff/shifts phase.
- **2026-09-24** — **Phase 2 Catalogue complete & verified.** `PlemmoCatalogue`
  adapter maps Plemmo categories/products/addon-groups/customers into Meridian's
  shapes; register hydrates from the live API (read-through cache, offline-safe).
  Verified by `test:meridian-catalogue` (pure mappers + live API contract).
- **2026-09-24** — **Core POS order-commit adapter complete & verified.**
  `PlemmoOrders` maps a Meridian cart (incl. modifier→addon-id resolution via a
  catalogue addon index) to a Plemmo sale and commits it with an idempotency
  key; Plemmo computes authoritative subtotal/tax/total. Verified by
  `test:meridian-orders` (pure mappers + a real end-to-end sale asserting
  authoritative totals and idempotent replay / no duplicate). Wiring this into
  Meridian's live pay/checkout button is deferred to the Payments phase so the
  running app is never left with a half-integrated pay flow.
- **2026-09-24** — **Payments + Cash phase — backend complete & verified.**
  New authoritative capabilities (migration **v91**, additive/non-destructive):
  (a) **tips/gratuity** persisted on `payments.tip_minor`, captured through the
  bills payment route and the payment core; (b) **cash drawer sessions**
  (`cash_sessions`) with float, **denomination counting** (JSON counts →
  minor-unit totals), one-open-per-location, expected-vs-counted **variance**
  at close; (c) **cash movements** (`cash_movements`): pay-in/pay-out/drop/
  no-sale/float-adjust, plus cash sales & cash tips auto-recorded from the
  payment path so the drawer stays authoritative without the frontend being the
  source. New `main/core/cash.ts` service + `main/routes/cash.ts` API
  (`/api/cash/session*`), role-enforced, idempotent (shared
  `payment_idempotency`), audited. Client adapters `03e-plemmo-cash.js`
  (`PlemmoCash`, `PlemmoPayments`). Verified: `test:plemmo-cash` (open/float/
  denomination, movements + validation, cash sale+tip → drawer, reconciliation
  math, close variance, closed-session guard, cashier-cannot-close authz, tip
  persistence, idempotency) and `test:meridian-cash-adapter`; payment
  regressions (integration-payments, plemmo-payment-service,
  payment-methods-split, integration-reconciliation), schema-health and
  upgrade-path all green. Split/partial/change/refund/void already existed in
  the payment core and are unchanged. Wiring Meridian's live pay/drawer UI to
  these adapters is the remaining frontend step.
- **2026-09-24** — **Inventory / Purchasing phase complete & verified.** No
  backend change required — Plemmo's existing single authoritative stock ledger
  (`inventory_movements` + balances, with `products.stock_quantity` kept in
  sync) already covers Meridian's needs. New client `03f-plemmo-inventory.js`:
  `PlemmoInventory` maps Meridian's three stock actions to the one ledger
  (receive→receipt, waste→adjustment, count→stocktake delta; zero-delta no-op)
  and refreshes on-hand from the authoritative `balance_after` — Meridian's
  `S.stockLog` is no longer a source of truth. Thin `PlemmoSuppliers`,
  `PlemmoPurchasing`, `PlemmoTransfers` clients surface the existing purchasing
  APIs. Verified: `test:meridian-inventory` (pure mapping + a live contract test
  proving single-ledger balance/history/low-stock, `stock_quantity` sync with
  no drift, and the negative-stock guard); backend regressions
  `plemmo-inventory` (43), `plemmo-purchasing` (53), `plemmo-multi-location`
  (42) all green.
- **2026-09-24** — **Tables / Floor Plan / KDS / Kiosk phase complete &
  verified.** Backend gap filled: **migration v92** adds floor-plan geometry
  (`shape`, `size`, `width`, `height`, `rotation`) to `tables` alongside the
  existing `position_x/y` + `capacity`; the tables create/update routes now
  persist and return it, so the floor plan is authoritative backend data (not
  frontend/localStorage) and safe for multi-device/location use. New client
  `03g-plemmo-tables.js`: `PlemmoTables` (map ↔ Meridian, list/load,
  create/saveLayout/saveAll for the drag editor, setStatus), `PlemmoKDS`
  (real tickets + item-status transitions + collection board), `PlemmoKiosk`
  (kiosk orders via the authoritative order-commit path — never local-only).
  Verified: `test:meridian-tables` (pure mappers + a live contract test:
  geometry create/persist, list round-trip, independent-read consistency, a
  layout edit that stays durable on re-read, KDS reachable); regressions
  `issue-134-mgmt` (29), `tables-string-ids`, `kds-integration`,
  `schema-health`, `upgrade-path`, `migration-v56-v57` all green.
- **2026-09-24** — **Kiosk / Loyalty / Staff phase complete & verified.**
  Backend gaps filled via **migration v93**: (a) `staff_shifts` timeclock table
  (one-open-shift-per-user index) with a `main/core/shifts.ts` service +
  `main/routes/shifts.ts` (`/api/shifts/clock-in|clock-out|me`, manager
  timesheet + worked-hours), server-enforced; (b) **loyalty tiers** derived
  authoritatively from lifetime spend via `main/core/loyalty.ts`
  (`bronze/silver/gold`, thresholds seeded in settings), surfaced as `tier` on
  the customers API. Kiosk already runs through the authoritative order path
  (`PlemmoKiosk`, prior phase). New client `03h-plemmo-staff.js`: `PlemmoStaff`
  (CRUD + clock-in/out + timesheet) and `PlemmoLoyalty` (tier display meta);
  the catalogue customer mapper now carries `tier`. Verified:
  `test:meridian-staff-loyalty` (mappers + a live contract test: clock-in,
  one-open-shift guard, clock-out, timesheet authz, and server-derived
  gold/bronze tiers from a real order's spend); regressions `staff-authz` (36),
  `customer-auth` (21), `plemmo-access-control` (42), `schema-health`,
  `upgrade-path` all green.
- **2026-09-24** — **Reports / Digital Receipts / AI phase complete & verified.**
  Reports API already covered Meridian's needs (client adapter only). Two
  backend capabilities built: (a) **digital receipts** — `main/core/receipt-
  digital.ts` assembles an authoritative receipt (items, totals, tax breakdown,
  payments incl. tips, footer) + rendered text; `GET /api/bills/:id/receipt`
  and `POST /api/bills/:id/receipt/deliver` (migration **v94** `receipt_
  deliveries`, auditable — the desktop build has no mail transport, so a request
  is *recorded* with the payload, never silently "sent"); (b) **AI assistant** —
  `main/core/ai.ts` + `main/routes/ai.ts`: **advisory only**, answers over an
  authoritative snapshot built from real data, **permission-gated**
  (`reports.view`), **audited** (`ai.query`), and **incapable of mutation**;
  local rule engine is the always-on authoritative source, with an optional
  Claude API phrasing path (grounded in the same snapshot) when
  `ANTHROPIC_API_KEY` is set. New client `03i-plemmo-reports.js` (`PlemmoReports`,
  `PlemmoReceipts`, `PlemmoAI`). Verified: `test:meridian-reports-ai` (reports
  read; authoritative receipt incl. tip + recorded delivery; AI answers real
  figures, cashier-without-`reports.view` **403**, **no mutations**, each query
  audited); regressions `bills-print-api` (23), `receipt-printing` (8),
  `integration-payments` (33), `schema-health`, `upgrade-path` green.
  (`reports-insights` shows 6 pre-existing, time-of-day-dependent failures
  present on the base commit — unrelated to this work.)
- **2026-09-24** — **Offline / Sync phase — status surface complete & verified.**
  No second sync protocol: Plemmo's existing outbox / idempotency / uploader /
  downloader / conflict engine remains the single source of offline correctness,
  and Meridian already commits every mutation through the authoritative Plemmo
  APIs with idempotency keys (catalogue/orders/payments/cash/inventory/tables/
  shifts phases). New read-only `GET /api/sync/status`
  (`main/routes/sync-status.ts`) composes `getSyncHealth` (outbox pending/
  uploading/failed, last upload/error) + `effectiveStatus`/`withinOfflineGrace`
  (licence) into the UI states online / offline / syncing / sync_failed /
  license_grace / license_blocked. Client `03j-plemmo-sync.js` + the Meridian
  status pill (03b) now poll it and show the live state + outbox backlog; a
  failed poll = offline. Verified: `test:meridian-sync-status` (auth required,
  unlicensed-desktop→online, expired→blocked, within-grace→grace, valid→online,
  cashier may read); regressions `sync-a-local-foundation` (52), `schema-health`
  green (`sync-f`/`sync-g`/`commercialization` skip — they need a live
  PostgreSQL not present in this container).
