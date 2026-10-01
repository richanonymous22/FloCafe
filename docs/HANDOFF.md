# Handoff guide

For whoever takes this codebase over (it is being sold to Plemmo). It says what is here, how to run and ship it, what
has been verified and how, and what you must supply. Read `docs/PLEMMO_COMPLETION_PLAN.md` §9 for the history.

## 1. What this is

An Electron desktop point of sale for UK retail, cafés and restaurants, plus a cloud service that licenses, syncs and
supports it.

| Part | Where | Notes |
| --- | --- | --- |
| Till server (Express :3001, WebSocket) | `main/` | SQLite (better-sqlite3, WAL), migrations by `PRAGMA user_version` in `main/db.ts` |
| Till interface ("Meridian") | `frontend-meridian/` | Vanilla JS concatenated by `build.sh` into `dist/meridian-pos.html`; the server is the source of truth |
| Legacy interface | `frontend/` | Next.js static export; kept, not the main till UI |
| Kitchen display | `main/` (KDS on :3002) | Standalone server |
| Cloud service | `cloud/` | Express + PostgreSQL; operator API `/admin/v1/*` and the operator console at `/operator` (`cloud/panel/`); device-signed sync; licence signing |
| Release tooling | `scripts/prepare-release.cjs`, `.github/workflows/` | Pins licence public keys and the cloud URL into builds |

Domain areas: money model (`docs/MONEY_MODEL.md`), payments and refunds (`main/core/payment.ts`, `refund.ts`), card
terminals (`docs/CARD_PROVIDERS.md`), trading reports (`docs/TRADING_REPORTS.md`), inventory and stocktakes
(`docs/API.md`), licensing and activation (`docs/OPERATOR_RUNBOOK.md`), updates and releasing (`docs/RELEASING.md`),
cloud hosting (`docs/CLOUD_HOSTING.md`). Every HTTP route is listed with its guard in `docs/ROUTE_INDEX.md`
(generated; `npm run test:route-index` keeps it current).

## 2. Run it

Node 22+.

```sh
npm ci
npm run dev                  # Electron app
node dev-server.js           # backend only
npm run build:meridian       # build the till interface
npm test                     # whole backend + integration suite (about 120 suites)
npm run test:meridian        # interface tests in a headless DOM (needs build:meridian first)
npm run lint                 # lint + typecheck (till and cloud)
npm run test:merchant-day    # the simulated merchant day
PLEMMO_CLOUD_DB_URL=postgres://... npm run test:pg-sync   # needs a PostgreSQL
```

## 3. Rules that matter

- **Customer data must survive upgrades.** Schema changes are new migration versions only, additive, tested on a fresh
  and an upgraded database. Never rewrite history of a migration that shipped.
- **No feature may pretend.** Anything the server cannot do is hidden or labelled, never faked. Card takings not
  confirmed by a provider are labelled unverified; the simulator is labelled simulated and is not offered in release
  builds.
- **Nothing is hard-wired to a brand or domain.** Product name and links come from `brand/brand.json` (or
  `PLEMMO_BRAND_*`); the cloud address is activation-code or environment driven.
- **No secrets in the repository.** Licence private keys, the operator token, database URLs and provider keys live in
  the host's secret store.

## 4. Configuration

| Variable | Used by | Purpose |
| --- | --- | --- |
| `PORT`, `KDS_PORT` | till | API and kitchen display ports (3001, 3002) |
| `JWT_SECRET` | till | Token signing (generated per install if unset) |
| `PLEMMO_CLOUD_DB_URL` | cloud | PostgreSQL connection |
| `PLEMMO_CLOUD_ADMIN_TOKEN` | cloud | Operator API token (long random string) |
| `PLEMMO_LICENSE_SIGNING_KEY`, `PLEMMO_LICENSE_SIGNING_KEY_ID` | cloud | Ed25519 licence signing key and its id (rotation by id) |
| `PLEMMO_CLOUD_PUBLIC_URL`, `PLEMMO_CLOUD_ALLOWED_ORIGINS`, `PLEMMO_TRUST_PROXY_HOPS` | cloud | Public address, CORS, proxy depth |
| `PLEMMO_MIN_CLIENT_PROTOCOL` | cloud | Oldest till protocol the cloud accepts (426 beyond that) |
| `PLEMMO_EMAIL_TRANSPORT`, `PLEMMO_EMAIL_WEBHOOK_URL`, `PLEMMO_EMAIL_WEBHOOK_TOKEN`, `PLEMMO_EMAIL_FROM` | cloud | Operator email |
| `PLEMMO_RELEASE_CLOUD_URL`, `PLEMMO_LICENSE_PUBLIC_KEYS`, `PLEMMO_RELEASE_UPDATE_URL` | release build | Pinned into the installer; the release refuses to build without them |
| `PLEMMO_LICENSE_PUBLIC_KEY`, `PLEMMO_LICENSE_POLICY_FILE` | till | Override pinned keys (development) |
| `PLEMMO_SYNC_URL`, `PLEMMO_SYNC_INTERVAL_MS`, `PLEMMO_SYNC_ENABLE_DEV_ENROLL` | till | Sync target and cadence; dev enrolment is refused in production |
| `PLEMMO_ALLOW_CARD_SIMULATOR`, `PLEMMO_CARD_SIMULATOR_DELAY_MS` | till | Simulated card terminal (never in release builds unless set) |
| `PLEMMO_BRAND_*` | till | Override `brand/brand.json` |

## 5. What has been verified, and how

| Claim | Evidence | Kind |
| --- | --- | --- |
| Money, VAT, refunds, reports balance | `trading-report`, `period-report`, `money-integrity`, `merchant-day` | Automated, real API and DB |
| A busy mixed day balances to the penny, unit and drawer | `merchant-day` (seeded, three seeds) | **Simulated** |
| Licensing, activation, tamper, rotation, revocation | `activation-e2e`, `cloud-commercial` (SQLite and real PostgreSQL), `meridian-licence` | Automated |
| Cloud backup and restore | `cloud-backup`, `cloud/ops/restore-rehearsal.sh` | Automated rehearsal |
| Safe updates | `update-manager`, `meridian-updates` with a fake updater | **Simulated** updater |
| Card payments | `card-terminal`, `meridian-card-terminal` with the simulator | **Simulated** terminal |
| Printing | `printer` tests against a fake TCP printer | **Simulated** printer |
| Cloud container image | CI `cloud-image` job; `docker build` could not be run in the authoring sandbox | CI only |

**Nothing has been verified on real hardware, a real card terminal, a real Windows machine, or a real merchant.**
`docs/HARDWARE_TEST_MATRIX.md` is the sheet to fill in.

## 6. What you must supply before launch

1. **Card provider**: choose one, get sandbox credentials and a terminal, implement the provider file (one file against
   `CardProvider`, see `docs/CARD_PROVIDERS.md`), and add settlement-report import (payments stay `captured` until then).
2. **Windows code-signing certificate** and, for the Microsoft Store, the Partner Center identity values; the installer
   product name and icons; an update feed (GitHub releases of the final repository, or an https feed).
3. **Cloud hosting accounts**: host, PostgreSQL, domain, TLS, backup schedule storage, error tracking and alerting
   (`docs/CLOUD_HOSTING.md` has the recommendation and a rehearsed restore).
4. **Licence keys**: generate the Ed25519 signing key in your secret store, pin the public key(s) in release builds,
   decide the rotation routine (`docs/OPERATOR_RUNBOOK.md`).
5. **Real-device testing** of printers, scanners, drawers, tablets and the Windows installer; a **pilot merchant** (WP12).
6. **Product decisions still open**: a Supervisor role (needs a `users` table rebuild migration), offers/promotions,
   stock transfers screen, low-stock alert list,
   (product CSV import is now in Items & stock → Items file).

## 7. Known limits

- A till with no server connection falls back to a cached local flow; connected-only screens (stocktake, purchase
  orders, period reports, card terminals) are not offered then.
- Wallet payments cannot cover a tip.
- `£` on thermal printers depends on the printer's code page; there is no per-printer code-page setting yet.
- Staggered update rollout across merchants from the cloud is not built (publish to a pilot first, then to everyone).
- MIT and FloCafe attribution must stay; the `origin/claude/MASTER` branch is frozen and must not be modified.
