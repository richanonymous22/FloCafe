# V1 scope — reconciled against the original specification

Inputs: the original spec (*Plemmo EPOS Software*, 77 sections), the Final Master Audit, and the code on
`PLEMMO-DELIVERY`. The spec is treated as a source of requirements, **not** as a design to copy: where the spec
and a better approach differ, the "Better approach" column says so and needs your sign-off.

Status: **PROPOSED — waiting for owner sign-off on the items marked ❓.** Nothing outside this list gets built.

## 1. What the spec says is Phase 1 ("must have", §70) and where we are

| Spec area | Status | Note |
|---|---|---|
| Touch UI: large buttons/fonts, finger-friendly | D | Designed touch-first; needs a measured pass (min target sizes) |
| Left/right till layout (§5), swipe (§6) | E | Build. Small, self-contained |
| Categories, products, barcode, search, basket | A/B | Default UK retail category set + subcategories/hide/VAT-per-category missing |
| Favourites (business / location / user) | E | Build |
| Cash, card, receipts | A / D | **Card is a simulation in the checkout today — must be replaced**; real provider = one adapter (§12) |
| Refund, void, discount | A / A / D | Discount still local-only; no item void; no credit note |
| Inventory: scan stock, stock-in by scan, stocktake by scan, low/out-of-stock alerts, CSV/XLSX import with preview/map/validate | E / D | Backend ledger is solid; the scan-driven workflows and import wizard are not built |
| Reports: X, Z, EOD, sales, VAT, cash, refund, void, discount (+ staff, payment, stock, margin) | E / D | Build on exact money (WP2 first) |
| Business MID / Location ID / Terminal ID | D | We have internal ULIDs, not the human-readable `PLM-00045821` / `LOC-001` / `T-0001` |
| Licensing | A (engine) / D | See WP7 |
| Cloud database, offline mode, audit trail | A / B | Built and tested; not deployed |
| Backup | D | Local backup works; cloud/automatic + restore drill missing |
| **Remote dashboard** (customer, web) | **E** | Phase 1 per §70 and an acceptance item — my earlier plan wrongly deferred it |

## 2. Phase 2/3/4 and "reinvent better" decisions (❓ = needs your yes/no)

| Spec item | Proposed V1 position | Better approach / reason |
|---|---|---|
| ❓ Offers engine (§13) — menu lists OFFERS, §71 lists it as Phase 2 | **Include a small server-side engine**: multi-buy, % off, fixed £ off, fixed price, BOGO, date/time window, customer group, location | Put it in the sale service so totals stay authoritative and receipts/reports/refunds stay correct; don't hard-code hospitality offers (spec agrees) |
| Customers, loyalty | A (exists) | Keep. Spec loyalty extras (member pricing, QR ID) → later |
| Multi-location, stock transfer | A backend / E screens | Screens go under an "Admin" area, **not** the main retail menu (spec §3) |
| Suppliers / Purchase Orders | A backend / E screens | Spec says they must not clutter the retail menu → admin area only; lower priority |
| Product photos (§39), AI product creation (§38) | Later (V1.1) | Photo upload/crop/compress is small; AI suggestions from a photo need a provider decision |
| AI assistant (§37) | A (advisory, permission-gated) | Already built; Phase 4 AI (forecasting etc.) deferred |
| Accounting integrations (§48) | Deferred | Only an API/export foundation: CSV/XLSX + documented read API |
| Uber/Deliveroo/Just Eat, online ordering (§40) | Deferred (Phase 3) | No work in V1 |
| Weighing scales (§41) | Deferred (Phase 3) | Needs legal-for-trade hardware; no work in V1 |
| Gift cards, store credit (§11, §42) | ❓ Defer to V1.1 | Wallet exists via loyalty; gift cards need liability accounting — don't rush |
| Exchange (§10) | Include, simply | Model as a linked refund + new sale (no new money concept) |
| Customer display | ❓ Not in V1 unless you need it | Spec mentions only in the architecture diagram |
| Mobile/tablet (§61) | Deferred | Architecture already allows it (HTTP API) |
| Hospitality mode (§55–57) | A (inherited, separate mode) | Keep as a mode; allergen/PPDS workflow → only if pilot is hospitality |

## 3. Things the spec requires that my audit and first plan missed

| Spec § | Requirement | Proposed work |
|---|---|---|
| §5–6, §9 | Left/right layout, swipe, favourites | **WP3b** retail touch UX |
| §3, §67 | **Simple retail main menu** (SELL, PRODUCTS, INVENTORY, OFFERS, CUSTOMERS, STAFF, REPORTS, DASHBOARD, SETTINGS); no suppliers/POs/kitchen on it | WP3b: a retail mode of the Meridian shell using the existing `business_type`; hospitality UI stays separate |
| §7–8 | Default retail category set; subcategories; PLU; reorder level; supplier field; favourite flag | WP3b/5 (verify which product fields already exist) |
| §16, §60 | Global **SCAN** hub: sell / stock / stock-in / stocktake / transfer / details / offers | WP5 |
| §17–20 | Stock-in by scan with "complete stock receipt"; stocktake by scan with approval; import wizard (preview → map columns → validate → import, error classes) | WP5 |
| §47 | **Credit notes** for refunds; refund VAT; "VAT registered vs not", exempt, inclusive/exclusive | WP4 |
| §28–30 | Human-readable Business MID / Location ID / Terminal ID, stored separately from payment-provider MID | WP7 — keep ULIDs as keys; add a server-assigned, sequential, unique display ID |
| §31–32, §62 | Customer web dashboard + separate Plemmo admin portal | **WP7b** (new): read-only customer dashboard served by the cloud (today/stock/products/staff/multi-site), minimal read-only admin status page; write operations stay CLI/API for V1 |
| §34–35 | Update policy: background download, "now / tonight / schedule / remind me", never restart during trading, staggered multi-terminal, backup-verify-install-verify, version history, rollback | WP9 |
| §44–45 | Roles Owner/Manager/**Supervisor**/Cashier (+ stock staff, auditor, support); granular permissions incl. cash adjustment, open drawer, export reports, change VAT, create offers | **WP3c** (new): extend the permission model |
| §49 | GDPR: consent flags, marketing opt-in/out, data export, anonymisation, retention setting | WP5/7 minimal version |
| §50 | 2FA for administrators, session timeout, login history, failed-login monitoring | WP7b/8: TOTP for owner/admin cloud logins; till keeps PIN + idle lock |
| §52 | Documented API in all major areas | WP13: OpenAPI for `/api`, `/sync/v1`, `/admin/v1` |
| §53 | Remote monitoring statuses (online, offline, update available, sync required, payment terminal error, low storage, software error) | WP8/7b, read-only |
| §54 | Automatic cloud backup, transaction/config backup, verification, DR plan | WP8 |
| §58–59 | Performance targets; global search (product, barcode, SKU, PLU, customer, transaction, staff) | WP3b: measured budget + global search |
| §46 | Receipt fields incl. terminal and payment reference; printed + email (SMS/QR later) | WP3/4 |
| §68 | No "HMRC certified" claims; compliance review before launch | Docs/UI copy rule; your legal/accountant review |
| §77 | Architecture package + **end-to-end trace test** (scan → … → dashboard → reporting) | WP1 (docs), WP11 (test) |

## 4. A discovery that changes priorities
The card payment screen in the register **simulates a card reader** (spinner, then "Approved – Visa ending 4417",
"Connected, battery 82%"). Card takings are really manual entry with no terminal confirmation. Until a provider
adapter exists, the screen must say so and make the cashier confirm *Approved / Declined* from the real terminal.
I missed this in the till-wiring work; it is now WP3 item #1.

## 5. Questions for you (new, from reading the spec)
1. ❓ **What is the pilot merchant?** The spec's Phase 1 is **retail** (grocery/convenience); Meridian grew from a café till. A retail pilot means building WP3b/WP5 first; a café pilot means the current till is closer and offers/scan hub move later.
2. ❓ Offers engine in V1 (recommended: small engine, above)?
3. ❓ Gift cards / store credit in V1 (recommended: no)?
4. ❓ Customer display in V1 (recommended: no)?
5. ❓ XLSX import/export and PDF reports in V1 (spec says yes) — adds the `exceljs` dependency (MIT).
6. ❓ Customer web dashboard in V1 (spec: yes, recommended: yes, read-only).
