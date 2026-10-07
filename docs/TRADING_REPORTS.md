# Trading reports: X and Z

Server-side, from the authoritative ledgers, in integer minor units. Code: `main/core/trading-report.ts`,
`main/core/vat-buckets.ts`; routes in `main/routes/reports.ts`; schema: migration v100 (`z_reports`).

## Vocabulary

- **Trading period** — everything after the previous Z up to now, for one location. Before the first Z, everything
  from the first recorded activity. A period is `(previous Z end, this end]`.
- **X report** — a read-only look at the open period. Run it as often as you like; it changes nothing.
- **Z report** — closes the period. The figures are computed once and stored as an immutable, sequentially numbered
  snapshot with a SHA-256 digest. The database refuses any `UPDATE` or `DELETE` of a Z row, so a Z cannot be
  regenerated with different numbers. The next period starts exactly where this one ended.

## API

| Call | Who | What |
| --- | --- | --- |
| `GET /api/reports/x` | owner, manager (`reports.view`) | The open period. |
| `POST /api/reports/z` | owner, manager (`reports.z`) | Close the period. `201` with the stored report. `409 cash_session_open` while the drawer is open; `409 nothing_to_report` when nothing happened since the last Z (pass `{"allow_empty": true}` to record a nil Z deliberately). |
| `GET /api/reports/z` | owner, manager | History: number, period, gross, net, refunds, `ok` (all checks passed). |
| `GET /api/reports/z/:id` | owner, manager | The stored report and `verified` (digest re-checked). |

## What a report contains

| Section | Source and rule |
| --- | --- |
| Sales | Bills that became fully paid in the period (`bills.paid_at`): count, items sold, average, gross. |
| Tenders | Payments on those bills by method: taken, tips, refunded, net. Card takings made without a card provider's confirmation (`manual_card` adapter) are flagged as **unverified**. |
| Refunds | Credit notes created in the period (`refunds.requested_at`), by the tender they went back to. A refund belongs to the period it is made in, not the period of the original sale. |
| VAT | Per rate: gross, net, VAT, and the refunds' own gross and VAT. Zero-rated and exempt sales are separate lines (needed for the VAT return). VAT per rate comes from each bill's own tax breakdown; gross per rate shares the bill total across its lines (so an order discount and rounding are carried through). A refund by item credits that item's own rate and VAT; an amount refund is spread over the bill's rates. The VAT is recorded on the refund row (`refunds.metadata.vat`) when the refund is made. |
| Discounts, voids, overrides | Order-level discounts on paid bills; orders cancelled in the period; lines removed after sending and price overrides (from the audit log). |
| Cash | Drawer movements in the period (sales, refunds, pay in/out, drops, tips), float of sessions opened, and counted / expected / variance of sessions closed. |
| Checks | `tenders_equal_bills`, `vat_equals_bills`, `gross_by_rate_equals_bills`, `cash_tenders_equal_drawer`, and `open_cash_session`. A Z that fails a check is still stored (it is a true record) but the failure is visible. |

## Printing

`POST /api/reports/x/print` and `POST /api/reports/z/:id/print` (owner/manager) send the report to the default receipt
printer using the printer's own column count and cut mode (`main/printers/report-format.ts`). A Z is never recomputed to
print: it prints from the stored snapshot, and a later print with `{"reprint": true}` is marked `*** REPRINT ***`. Failures
come back as `502` with the printer's own reason (`detail`, `failure_class`), exactly like receipts.

Currency on paper follows the printer's character set: in plain-text mode `£` is printed as `GBP` (the same rule receipts
use). Printing a true `£` depends on the printer's code page and is part of the hardware test matrix.

## Why the period boundary is inclusive and Z waits a second

Timestamps have one-second resolution. The period end is inclusive and `POST /z` waits out the current second before it
commits, so a sale made right after a Z is stamped strictly later than the period end. An event can therefore never fall
in two periods or in neither.

## Tested

`tests/trading-report.test.ts` runs a scripted day (cash, card with a tip, a split, a discount, a price override, a full
refund, a refund by item, a void, drawer pay in/out, a short drawer count) and checks every figure to the penny against
expectations worked out independently, the VAT by rate and net of credit notes, the checks, immutability, numbering, and
that the next period starts exactly where the last ended.

## Period reports and CSV

`GET /api/reports/period` answers the same questions for any date range (the Reports screen's Today /
Yesterday / 7 / 30 days). A bill belongs to the range in which it became fully paid and a refund to the
range in which it was made, exactly as for a Z report, so the two never disagree about which day a figure
belongs to. Products, categories and staff are NET OF REFUNDS: a returned line comes off its product (a
whole-bill refund is shared over the bill's lines by value), the VAT share comes off net sales, and cost
comes back only for stock that went back on the shelf. The response includes checks that products and staff
add up to the bills. Each section downloads as CSV (`/period/csv?section=`), and X/Z reports as
`/x/csv` and `/z/:id/csv`. Tests: `npm run test:period-report`, `npm run test:meridian-reports-live`.
