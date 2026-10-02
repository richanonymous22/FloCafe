# V1 acceptance checklist (spec §74) — current status

Source: *Plemmo EPOS Software — Full Developer Requirements & Product Specification*, §74. Status is
from the code as of PR #4 (`PLEMMO-DELIVERY`). **Nothing here is ticked until it has been shown working on the
real path** (UI → HTTP → DB, real Postgres for cloud, real hardware where hardware is involved).

Legend: **A** done & tested · **B** built, needs real-world/hardware test · **D** partial · **E** not built · WP = work package in `PLEMMO_COMPLETION_PLAN.md`.

| § | Acceptance item | Status | What exists / what's missing | WP |
|---|---|---|---|---|
| Till | Product sold by barcode | B | Scan → `/retail/lookup` → basket, tested with simulated keystrokes; no real scanner tested | 3, 10 |
| | Product sold by search | A | Search box + Enter | — |
| | Favourite product works | **E** | No favourites concept (business/location/user) | 3b |
| | Categories work | A | Backend + Meridian; default UK retail category set not seeded, no subcategories/hide/VAT-per-category UI | 3b |
| | Swipe works | **E** | No swipe navigation | 3b |
| | Left layout / Right layout works | **E** | No left/right till layout setting | 3b |
| | Buttons are finger-friendly | D | Designed touch-first; not verified on a touchscreen; spec sizes not measured | 3b |
| | Payment works | D | Cash A. **Card is simulated**: the pay screen fakes a reader ("Approved – Visa ending 4417") after 1.7 s; it is really manual card entry. Must be replaced by an honest confirm-on-terminal flow | 3, 10 |
| | Receipt works | B | Real print path wired (PR #4), email works; no physical printer tested | 10 |
| | Refund works | A | Backend + UI; full refund screen only; no credit note document | 3, 4 |
| | Void works | A | Unpaid-order cancel wired; item-level void missing | 3 |
| | Discount works | **D** | Backend enforces limits/PIN, but the till applies discounts locally and never sends them | 3 |
| Inventory | Scan product shows stock (SCAN STOCK) | **E** | Scan only adds to basket; no stock-lookup screen (current/reserved/available/location) | 5 |
| | Stock can be added by scanning | **E** | Stock-in is a single-item form; no scan → qty → next → "complete receipt" flow | 5 |
| | Stock can be adjusted | A | Adjust/receive/waste/count on one item via ledger | — |
| | Stocktake works | **E** | No stocktake document (expected vs counted vs difference, manager approval) | 5 |
| | Low-stock alert works | D | Thresholds exist; no alert surface per spec (dashboard counts, per-product reorder level) | 5 |
| | Out-of-stock alert works | D | Sold-out/zero stock handled in till; no alert surface | 5 |
| | USB/CSV/XLSX import works | **E** | Only a menu CSV import (100 KB/10k rows cap); no stock import, no XLSX | 5 |
| | Import validation works | D | Menu CSV validates; spec flow (preview → map columns → validate → import, error classes) not built | 5 |
| Reports | X Report | **E** | Not built (client-side day view only) | 4 |
| | Z Report (permanent record) | **E** | Not built | 4 |
| | End-of-Day | **E** | Cash-session close exists; no EOD flow | 4 |
| | VAT report | D | Tax components endpoint only; no VAT report (refund VAT, credit notes) | 4 |
| | Cash report | D | Session expected/variance exist; no report | 4 |
| | Refund report / Void report | **E** | Not built | 4 |
| Security | User permissions work | D | Role gates + 12 permissions; spec needs granular set + Supervisor role | 3c |
| | Audit trail works | A | Append-only audit events across sale/refund/void/override/cash | — |
| | Refund permissions work | A | `sales.refund` or manager PIN, tested | — |
| | Discount permissions work | D | Enforced on backend route; till bypasses it today | 3 |
| | Manager approval works | A | PIN approval on refund/void/price override | — |
| | Business MID works | D | Internal ULIDs only; no `PLM-########` business MID | 7 |
| | Terminal ID works | D | Internal ULIDs only; no `T-0001` terminal ID | 7 |
| Cloud | Remote dashboard works | **E** | No customer web dashboard (operator API only) | 7b |
| | Offline mode works | B | Offline-first by design, sync tested; no real network-drop test | 11 |
| | Automatic sync works | B | Real-Postgres suites pass; not run on a deployed cloud | 8, 11 |
| | Backup works | D | Local DB backup works; no automatic/cloud backup, no restore drill | 8 |
| | Update system works | D | `electron-updater` wired to dev repo; unsigned, untested | 9 |
| | Scheduled update works | **E** | No maintenance window / "update tonight" | 9 |
| | Rollback works | **E** | No rollback procedure | 9 |

Also required by §77 before sign-off: the end-to-end trace **Barcode scan → product → basket → VAT → discount → payment → receipt → inventory reduction → audit log → cloud sync → dashboard → reporting**, demonstrated as one automated test (WP11).
