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

## 10. Status log

- **2026-09-24** — Audit complete (Phases 1–5). This map created. Foundation
  slice started: Meridian vendored, real auth/API client scaffolded, flagged
  serving path added. See PR on branch `PLEMMO-DELIVERY`.
