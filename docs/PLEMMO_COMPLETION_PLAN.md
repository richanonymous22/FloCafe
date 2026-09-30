# Meridian POS — Completion Plan (to first paying merchant, then handoff)

Status: PLAN ONLY. Nothing in this document has been started. Source: the Final Master Audit
(`docs/PLEMMO_FINAL_MASTER_AUDIT.md`) plus the till-wiring work already merged into PR #4.

Units: effort is in **working sessions** (one focused Claude session ≈ one work package slice). "You" =
the owner/seller; "External" = needs an account, money, a physical device or a third party.

---

## 0. Where we actually are (corrected — some of the audit's gaps are already closed)

| Area | Audit said | Now |
|---|---|---|
| Refund, void, receipt print, hold/resume, backup, Devices panel, barcode scan, price override | local-only / fake / missing | **Done on PLEMMO-DELIVERY (PR #4)**, tested UI → HTTP → DB. PR is waiting on one decision (§1, D0). |
| X / Z / End-of-day (server-side) | missing | **Not started** |
| Stocktake, stock CSV/XLSX import, valuation | missing | **Not started** |
| Refunds reflected in reports | — | **Not done** (reports ignore refunds today) |
| Discounts at the till | — | **Local-only** (backend never receives them) — found during wiring, must fix |
| Item-level void / partial-refund screen | — | Backend has no till route for item void; screen only offers full refund |
| Purchasing / suppliers / transfers screens, location/terminal/licence/admin/reconciliation screens | missing | **Not started** (backend exists) |
| Licensing engine | done | unchanged; **not** production-ready (key not pinned, no activation screen, no plan catalogue) |
| Commercial provisioning (merchant→…→activate) | breaks at several points | unchanged |
| Production cloud | not deployed | unchanged |
| Rebrand to Meridian | not started | unchanged (your decision: product is "Meridian POS", Plemmo gets it later as source code) |
| Money stored as REAL | decision needed | unchanged |
| Windows installer / signing / update feed / release | none | unchanged |
| Hardware, card provider | untested / none | unchanged |
| Original spec PDF + §74 acceptance list | not in repo | **still missing — blocks scope lock** |

The foundation (sale/payment/inventory/audit/sync/cash/cloud code, real-Postgres tests) is sound and stays.
No rebuild, no framework change, `frontend/` stays for KDS/server display, MIT/FloCafe attribution stays.

---

## 1. Decisions and inputs needed from you (gates)

Nothing below needs code. Each has my recommendation so you can just say "yes".

| # | Decision / input | Blocks | My recommendation |
|---|---|---|---|
| D0 | CodeQL "missing rate limiting" ×5 on new routes (repo's own limiter isn't recognised by CodeQL) | merge of PR #4 | Dismiss as false positive (global limiter at `main/server.ts:191` + stricter per-route limiter). Adding `express-rate-limit` is the alternative. |
| D1 | **Send me the original Plemmo spec PDF and the §74 acceptance checklist** (or paste them) | WP1, WP12 | Required. Without them "deferred" items are my guess. |
| D2 | V1 scope for each Phase 2/3/4 item (offers, accounting, customer display, delivery apps, online ordering, scales, mobile app, AI forecasting…) | WP1 | Defer all Phase 3/4 and accounting; keep customer display **out** unless the spec marks it required. |
| D3 | Money model: convert money columns to integer minor units, or keep REAL and sign off | WP2 | Convert the sales-side money columns (orders, order_items, bills, purchasing totals, unit costs) with additive `*_minor` columns + backfill; leave quantities/geometry as REAL. No live data exists, so this is the cheapest moment. |
| D4 | Hosting: provider for Postgres / API / DNS | WP8 | Neon (Postgres) + Fly.io (API) + Cloudflare (DNS/TLS) — generous free tiers, cheap to scale. |
| D5 | Plan catalogue (names, prices, limits) | WP7 | My placeholders: Trial £0/14d; Starter £19/mo (1 location, 1 terminal); Standard £39 (1 loc, 3 terminals); Pro £89 (5 loc, unlimited terminals); Enterprise custom; add-ons +£10/terminal, +£25/location. Stored as data, changeable without code. |
| D6 | First card provider for the pilot (Teya / Dojo / Worldpay / SumUp / Elavon / Shift4) | WP10 | Whichever the pilot merchant already uses; if none, SumUp or Teya (simplest sandbox/SDK). Build exactly one. |
| D7 | Operator tooling for V1: CLI/runbook scripts vs a web admin console | WP7 | CLI + documented API calls for V1 (merchant count is ~1); the FloAdmin web console stays a separate later project. |
| D8 | Logo files (PNG + SVG), product name confirmation ("Meridian POS" vs "Meridian EPOS"), bundle id (`com.meridian.pos`) | WP6 | Approve the defaults: package `meridian-pos`, env prefix `MERIDIAN_*`, `window.Meridian*`. |
| D9 | Stock import format (CSV only, or also XLSX) and XLSX library (SheetJS vs exceljs — licences differ) | WP5 | CSV first (already partly there); XLSX via `exceljs` (MIT) only if the spec requires it. |
| D10 | Ownership/IP terms of the source-code sale, who holds the signing keys after handoff, support/warranty terms | WP13 | Needs you/a solicitor. I will not draft legal terms. |

**Start-now items with long lead time (you, in parallel with all coding):**
1. Windows code-signing certificate (EV/OV) — days to weeks for validation.
2. Cloud accounts + domain purchase/DNS access.
3. Buy the pilot hardware set (see WP10).
4. Identify the pilot merchant and their card provider.
5. Generate the licence signing keypair on a machine you control (I will provide the exact command; I never generate or see the private key).

---

## 2. Work packages, in dependency order

Legend: **Dep** = must be done first · **Exit** = evidence required before the next package starts.
Every package: branch off `PLEMMO-DELIVERY`, one PR, tests added first-class, full `npm test` + `test:meridian` green, no unrelated changes, report of what was and wasn't done.

### WP0 — Close out what's open (S, 0.5 session)
- Resolve D0 and merge PR #4.
- Triage the 3 `npm audit` advisories (2 high: `brace-expansion`, `js-yaml`; 1 moderate: `qs`) — check reachability, apply fixes if they're in the shipped tree.
- Confirm production cloud entrypoint can never enable `enableDevEnroll`.
- Enable GitHub secret scanning + push protection (you: Settings → Advanced Security).
**Exit:** PR #4 merged, `npm audit --omit=dev` has no reachable highs.

### WP1 — Lock the V1 scope (S, 0.5 session; needs D1, D2)
- Read the spec PDF and §74; build the requirement matrix **from the source**, not from my reconstruction.
- Reclassify every item: V1-required / done / partial / deferred-by-agreement / future.
- Produce `docs/V1_SCOPE.md` and an acceptance checklist (`docs/ACCEPTANCE.md`): one row per §74 item with requirement, implementation, automated test, manual test, hardware test, cloud test, status.
**Exit:** you sign off the scope list. After this, anything not on it is out, and nothing on it is "presumed".

### WP2 — Money model (M–L, 2–4 sessions; needs D3) — before reports
Why first: Z reports, refunds-in-reports and VAT must total exactly.
1. Inventory every `REAL` column (audit counts ~72; an earlier architecture note says ~33 are money — the rest are quantities/geometry). Classify money / quantity / geometry.
2. If D3 = convert: migration v97+ adds `*_minor INTEGER` beside each money column, backfills from the existing value with correct rounding, then switches all writers (sale engine, tax engine, bills, purchasing, inventory cost) and readers (reports, receipts, sync payloads, cloud mirror tables) to minor units; legacy REAL columns kept read-only for one release (no destructive change, per AGENTS.md data-safety rule).
3. Sync + cloud: update event payload schemas (versioned), Postgres mirror columns, protocol version bump, old-client compatibility test.
4. Invariant tests: Σ line totals = order total; Σ tender = bill total; refund never exceeds paid; Z = Σ of the above; fresh-DB and upgrade-path (v95/v96 fixtures) tests; property-style rounding tests across GBP/JPY/KWD.
5. If D3 = keep REAL: write the boundary-rounding rule, route every write through `money.ts`, add the same invariant tests, record your sign-off in the audit doc.
**Exit:** invariant suite green on SQLite and real Postgres; upgrade-path proves old data survives.

### WP3 — Finish the Meridian till (M, 2 sessions; Dep WP0)
What prompt 1 left open:
1. **Discounts → backend.** Send order/line discounts through the existing `applyDiscount`/discount routes (limits + manager PIN enforced server-side); remove local-only discount math as the source of truth.
2. **Item-level void** of a sent item: smallest safe route (permission/PIN, ledger restock, totals recompute, KDS update, audit); then allow it in Meridian.
3. **Partial refund screen** (amount and/or item selection) using the existing route; show refund history on the order.
4. **Refund-aware everything**: orders list/drawer, receipts (refund line), dashboard/reports read net-of-refund numbers (coordinate with WP4).
5. **Kitchen/KOT printing from Meridian** (send-to-kitchen → real KOT to station printers) and **auto-print receipt** option; verify station routing still works.
6. **Variants in the till** (barcode returns a variant today and the till refuses it) — either support variant lines or explicitly exclude variants from V1 (scope decision).
7. **Kiosk** "Printing your receipt…" message made truthful (real print or remove the claim).
8. Offline behaviour of the new actions (what happens when the server is unreachable mid-refund/print/hold) — define and test.
9. Replace leftover local-only flows in Meridian that touch money/stock (audit list: anything that mutates `S` without an API call in register/orders/items/customers).
**Exit:** a written list of every Meridian handler that mutates money/stock/hardware, each with its backend call and a UI→DB test. Zero handlers left that only change `S`.

### WP4 — X / Z / End-of-day and required reports (L, 3 sessions; Dep WP2, WP3; scope from WP1)
- **Server-side X and Z reports**: immutable, sequentially numbered, per cash session/location/terminal; include sales, refunds, voids, discounts, VAT by rate, tenders (cash/card/wallet), tips, paid-in/out, float/variance, stock-affecting totals. Z closes the period and cannot be regenerated with different numbers (store the snapshot).
- **End-of-day** orchestration: close cash session → Z → lock day → backup prompt.
- Required reports (per WP1): VAT, cash, refund, void, discount, staff, profit/margin — all net-of-refund, all exportable (CSV; PDF only if the spec says so).
- Receipt-style printing of X/Z on the thermal printer.
- Meridian screens replace the client-side "End of day" view.
- Tests: totals reconcile to payments ledger and cash movements to the penny on a scripted day (sales, refunds, voids, split tender, tips); Z immutability; re-run idempotency.
**Exit:** scripted "trading day" test where X, Z, cash count, payment ledger and bill totals all reconcile exactly.

### WP5 — Inventory workflows and Meridian back-office screens (L, 3 sessions; Dep WP2; scope from WP1)
- **Stocktake** as a document: start → count (scan or type) → variance review → approve → ledger adjustments with reason; partial/zone counts; history kept.
- **Stock-in / goods receipt** screen on top of the existing receipt movement; **scan stock** (reuse the scanner handler).
- **CSV import** for stock (and products if in scope); **XLSX** only if D9 says so; validation, dry-run, error report, idempotent re-import.
- **Valuation report** (cost-based, per location) and **low-stock alerts** (dashboard + list).
- **Purchasing / suppliers / transfers** Meridian screens over the existing APIs (PO create/receive/cancel, supplier CRUD, inter-location transfer with complete/cancel).
- Tests: import edge cases, stocktake variance maths, ledger balance = Σ movements invariant.
**Exit:** every inventory requirement in the WP1 list has a screen, an API call and a test.

### WP6 — Rebrand to Meridian and repository clean-up (M, 2 sessions; needs D8)
- Centralise the brand string; rename product/app id/package/env vars/globals/docs (~1,650 mentions, ~170 files); swap in your logo; update icons (`assets/`), installer/AppStream metadata.
- **Replace third-party identities** in `package.json`: AppX block, macOS signing identity/provisioning profile, `publish` repo — these still point at FloCafe/Codify and will not produce a valid build for you.
- Keep MIT LICENSE and "Derived from FloCafe (MIT)" attribution; add third-party notices file (incl. LGPL `sharp/libvips` note).
- Classify remaining FloCafe/FloPOS mentions: keep (attribution, migration fixtures) vs change (tax-pack upstream catalogue/signing key — functional external dependency, needs your decision on hosting your own tax-pack feed or vendoring the packs).
- Remove the Spanish demo-restaurant seed and prototype demo data paths from shipped builds.
**Exit:** grep for old names returns only intentional attribution/fixtures; fresh install shows only Meridian branding.

### WP7 — Commercial layer: provisioning and licensing (L, 3 sessions; Dep WP6 for naming; needs D5, D7, keypair)
1. **Plan catalogue stored as data** (table + operator API), referenced by licences; feature entitlements per plan enforced by existing checks.
2. **Operator provisioning** (merchant → organisation → location → terminal → device): explicit create/list/update/suspend endpoints (today these appear implicitly), with audit. Delivered as CLI scripts + documented API for V1 (D7).
3. **Licence issuing runbook** (issue, renew, suspend, revoke, reactivate, change plan, replace terminal).
4. **Client activation in Meridian**: first-run "activate this device" (enter activation token) → enrol → fetch signed licence; licence status page (plan, expiry, devices used, grace/blocked states); clear blocked/expired screens.
5. **Pin the licence public key at build time**; fail the release build if it isn't set; make the client refuse unsigned licences when pinned; key-rotation procedure.
6. Tamper/abuse tests: modified cached licence, clock rollback, replayed activation token, revoked device offline then online.
**Exit:** scripted "new merchant" walk-through on a dev cloud: create merchant → licence → activation token → fresh client activates → sells → suspend → blocked → reactivate → sells.

### WP8 — Production cloud (M, 2 sessions; needs D4 + your accounts/domain)
- Provision Postgres, deploy API container, domain + TLS, secrets (`PLEMMO_CLOUD_ADMIN_TOKEN`→ renamed in WP6, licence signing key, DB URL); run migrations as a separate step.
- **Operational readiness**: structured request/error logging, error tracking, uptime/health alerts, shared rate limiter (the current one is per-instance), log/secret hygiene review, CORS/TLS settings.
- **Backups and recovery**: automated Postgres backups, a documented and *rehearsed* restore, migration rollback procedure, version/protocol compatibility policy (what happens to an old client).
- **Connect a real Meridian build** to it: enrol, sync, licence fetch, offline → reconnect, two terminals.
- Docs: deployment runbook, secrets handoff procedure, environment reference.
**Exit:** a staging merchant on the real cloud completes the WP7 walk-through; restore drill succeeds.

### WP9 — Windows product (L, 2–3 sessions; Dep WP6, WP7; needs signing cert)
- Windows CI job (build, unit tests where possible, NSIS installer artifact).
- Clean Windows VM test: install → first run → setup → login → licence activation → sale → print → offline → update → crash/recovery → uninstall/reinstall keeps data.
- Code signing wired into CI (secret-managed); SmartScreen check.
- **Update feed**: release repo/host, `electron-updater` config, signed update test, failed-update rollback, migration-during-update backup verification.
- Release workflow dry run: tag == version, changelog entry, artifacts.
- DPAPI/safeStorage behaviour on Windows (Master PIN, tokens); logs location and crash reporting.
**Exit:** signed installer + signed update both verified on a clean machine.

### WP10 — Hardware and card payments (L, 3+ sessions; Dep WP3, WP9; needs hardware, D6)
Hardware set to buy: one 80 mm USB and one 80 mm network ESC/POS receipt printer (one 58 mm if the spec needs it), a cash drawer (RJ11 via printer), a keyboard-wedge USB scanner, a kitchen printer, the pilot's card terminal, a second PC/terminal for multi-terminal tests.
1. Run the **hardware test matrix** from the audit on the real devices; fix what breaks (column widths, cut mode, drawer pulse pin, code pages/£ symbol, reconnect/retry).
2. Improve diagnostics where the tests show gaps (paper-out/cover status if the printer reports it).
3. **One card provider adapter** (D6): sandbox integration → payment states `requested→authorized→captured→settled`, declines/cancels, refunds and voids through the provider, reconciliation of terminal totals vs POS; credentials in secrets, never in the repo. Until then "manual card" stays and is labelled as unverified.
4. Customer display only if D2 says required.
**Exit:** filled-in hardware matrix (actual results, dates, models) and provider sandbox transactions recorded.

### WP11 — Full merchant-day simulation (M, 2 sessions; Dep WP4, 5, 7, 8, 9, 10)
Scripted + manual day on the real stack: open till → sell (cash, card, split, tips, discounts, price override) → kitchen → refund → void → stock-in/stocktake → offline for 30+ min → reconnect → two terminals → Z/EOD → backup → update → deliberate failure recovery (power loss mid-sale, corrupt DB restore).
- Fix defects found; re-run until a whole day passes with no manual database edits.
- Complete every row of the WP1 acceptance checklist with evidence.
**Exit:** signed-off acceptance checklist.

### WP12 — Pilot (External, 1–4 weeks real time; Dep WP11)
- Install at the pilot merchant with you present; shadow their real trading for a few days alongside their old system; daily check of Z vs their records; fix list; support log.
**Exit:** pilot merchant trades unassisted for an agreed period.

### WP13 — Source-code sale / handoff (M, 2 sessions; needs D10)
Repository clean and buildable from scratch by a stranger; setup, environment, database, migration, licensing, hardware, API, admin, cloud-deployment, release, backup/restore, troubleshooting and support docs; architecture overview; third-party notices; secrets handoff procedure (no secrets in git); release artefacts; ownership/IP items flagged for the agreement; a "build it from zero" dry run by a fresh checkout.
**Exit:** handoff checklist complete; fresh-clone build + tests pass.

---

## 3. Critical path and parallel lanes

```
WP0 → WP1 ─┬→ WP2 → WP4 ──────────────┐
           ├→ WP3 ────────────────────┤
           ├→ WP5 ────────────────────┼→ WP11 → WP12 → WP13
           └→ WP6 → WP7 → WP8 → WP9 ──┤
                        WP10 (hardware/card, starts once WP3 + WP9 ready) ─┘
```
- **Parallel for you right now:** signing certificate, cloud accounts/domain, hardware purchase, pilot merchant + card provider, spec PDF/§74, logo.
- **Sequential for me:** I'll work one package per PR, in the order WP0 → WP1 → WP2 → WP3 → WP4 → WP5 → WP6 → WP7 → WP8 → WP9 → WP10 → WP11 → WP13. WP6 (rebrand) deliberately comes after the feature work to avoid a giant rename conflicting with every PR; if you prefer branding earlier, it costs merge churn but nothing else.
- Rough total of Claude work: ~27–35 sessions; real elapsed time is dominated by certificate validation, hardware arrival, card-provider onboarding and the pilot.

## 4. Rules for every package (so we don't go in circles)
1. One package → one branch/PR → one report: done / not done / blocked, commands run with actual results.
2. Definition of done = tests prove it through the real path (UI → HTTP → DB; real Postgres for cloud; real TCP/hardware where possible). Mocks don't count as "wired".
3. No scope expansion: anything new discovered goes on a list for you, not into the PR.
4. No invented credentials, prices-as-fact, legal terms or hardware claims. Anything untestable here is labelled "needs hardware / needs cloud / needs you".
5. Additive migrations only, with fresh-install and upgrade-path tests; nothing destructive on customer data.
6. After each package I update the audit's status table so the audit stays the single source of truth.

## 5. Known open risks carried into the plan
- Discounts are local-only today (WP3.1).
- Reports ignore refunds today (WP3.4/WP4).
- Legacy cancel path restocked only `stock_quantity` — fixed for orders; item-level paths still to be reviewed (WP3.2).
- Cloud rate limiter is per-instance (WP8).
- Tax-pack feed and signing key still reference the upstream FloCafe service (WP6).
- CodeQL flags five routes as unrate-limited although the repo limiter covers them (D0).
- Spec PDF/§74 unverified; every "deferred" label is provisional until WP1.

## 6. What I need from you to start
Minimum to begin immediately: **D0** (dismiss vs add dependency) and **D1** (spec PDF + §74). With those I can run WP0 and WP1 straight away. D3 (money model) is the next most important decision; D4–D8 can follow while WP2–WP5 are in progress.
