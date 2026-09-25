# Payment Cutover — Retire the Legacy Payment Readers

Follow-on to [`SYNC_0_FOUNDATION.md`](./SYNC_0_FOUNDATION.md) / [`SYNC_0_PAYMENT_MIGRATION.md`](./SYNC_0_PAYMENT_MIGRATION.md).
SYNC-0 made `payments`/`payment_events` authoritative and *complete* for
new payments. This milestone finishes the job: every merchant-facing
*reader* of a bill's payment data now sources from that authoritative
model instead of the legacy `bills.payment_details` JSON column, and a
reconciliation pass finds and repairs any bill whose pre-SYNC-0 dual-write
was only partially mirrored.

**Status: complete.** No sync engine, cloud, or transport was built.

---

## A. Every `payment_details` reader/writer found

Re-audited from scratch against the current repository (not assuming the
list from `SYNC_0_PAYMENT_MIGRATION.md` was complete):

| # | Location | What it does | Category |
|---|---|---|---|
| 1 | `main/routes/bills.ts:707` `applyPaymentBatch()` | Writes `payment_details` (still authoritative for the legacy shape) | Writer — unchanged |
| 2 | `main/core/payment.ts` `recordAppliedPaymentLine()` | The dual-write into `payments`/`payment_events` | Writer — unchanged (SYNC-0 already made it atomic) |
| 3 | `main/routes/bills.ts` `preparePaymentBatch()`'s `existingPayments` | Internal duplicate-transaction-id guard, reads "what's already applied to this bill" | **Migrated** — now derives from `payments` |
| 4 | `main/routes/bills.ts:295` split-bill guard | `source.payment_details` truthiness, one of three OR'd conditions | Reviewed, left as-is (redundant with `payment_status`/`paid_amount`, see § F) |
| 5 | `main/printers/thermal.ts` (×3) | Renders the payment breakdown on a receipt | **Migrated** (transitively, via `parseRowJson`/`printers.ts`) |
| 6 | `main/routes/printers.ts` `/print-bill` | Fetches the bill via raw SQL (not `parseRowJson`) for the real thermal print path | **Migrated** — explicit `deriveBillPaymentDetails()` call |
| 7 | `main/db.ts` `parseRowJson()` | The single shaping function behind every bill API response (`GET /bills`, `/bills/:id`, `/bills/generate`, payment responses, split-check, …) | **Migrated** — this is the central fix point |
| 8 | `main/routes/reports.ts` `paymentMethodBreakdown()` | Payment-method aggregation for `daily-stats`, `summary`, `sales` reports | **Migrated** |
| 9 | `main/routes/payment-methods.ts` `countUsage()` | Usage count shown in the payment-methods list, and the delete-guard | **Migrated** |
| 10 | `main/routes/payment-methods.ts` `merge` route | Renames a payment method across historical records | **Migrated** — now also updates `payments`, not only `payment_details` |
| 11 | `main/db.ts` `autoRepairPaymentDetails()` | Idempotent boot-time repair of pre-fix corrupted JSON | Left as-is — still useful for historical rows while the column exists (§ F) |
| 12 | `main/db.ts` (multiple, versions 40s–60s) | **Historical, already-applied migrations** that touched `payment_details` at the time (UPI backfill, corruption repair, etc.) | Immutable — never modified |
| 13 | `main/services/cloud-sync.ts` (×5) | The disabled-by-default FloAdmin bridge — sanitizes `payment_details` out of relayed bills, and its own unrelated `json_each` aggregation for its own dashboard | **Deliberately not migrated** — see reasoning below |
| 14 | Frontend: `receipt-encoder.ts`, `tax-bill-encoder.ts`, `web-print.ts`, `types.ts` | Consume `bill.payment_details` from the JSON API response for the browser-side web-print path | **Migrated transitively** — item 7 changes what the API returns; none of these files needed a code change |

**Why item 13 was not migrated:** `main/services/cloud-sync.ts` is the
pre-existing, unrelated FloAdmin/"Blue" vendor bridge (`cloud_sync_enabled`
defaults to `0` since migration v67, `plemmo_disconnect_upstream_services`
— see `MILESTONE_9_SYNC_ARCHITECTURE.md` §1 and the risk register in
`MILESTONE_9A_SYNC_REVIEW.md`, R-1). It is not a Plemmo merchant-facing
reader today. Migrating it would touch a disabled, out-of-scope subsystem
for no visible benefit and real regression risk to a code path this
audit is not equipped to fully verify; if/when FloAdmin is formally
retired or repurposed, its own `payment_details` usage should be revisited
then, not incidentally here.

---

## B. Reader migration

The central mechanism is one new function,
**`deriveBillPaymentDetails(billId)`** (`main/db.ts`, beside
`parseRowJson`): it queries `payments` for the bill and maps each row back
into the exact historical line shape
(`{method, payment_method_id?, amount, requested_amount, amount_omitted,
tendered_amount?, change_amount?, timestamp, transaction_id?, notes?}`),
using each payment's own currency (`main/core/money.ts`'s `fromMinor`) so
non-2-decimal currencies are now handled correctly — the old JSON-based
readers inherited `applyPaymentBatch`'s unconditional `* 100` assumption.
Returns `null` (matching legacy `payment_details IS NULL` semantics) when
the bill has no payments.

`parseRowJson()` calls this for any bill-shaped row (detected by
`bill_number !== undefined`, a column only bills have) instead of
`JSON.parse`-ing the stored column. Since `parseRowJson` is the one
shaping function behind every bill API response, this single change
transparently migrated the frontend's web-print receipt encoders and every
`GET`/`POST` bill response — **none of their own code needed to change.**

`main/routes/printers.ts`'s `/print-bill` route fetches the bill via raw
SQL (bypassing `parseRowJson`, since it needs the printer-facing shape)
and now explicitly calls `deriveBillPaymentDetails()` on the fetched row
before handing it to the thermal encoder — the one place the central fix
didn't already reach.

`main/routes/reports.ts`'s `paymentMethodBreakdown()` was rewritten to
query `payments` directly (real columns, real `requested_at`, no JSON1
extraction or bill-level pre-filter approximation needed) — see § C for
the one semantic detail that had to be preserved exactly.

`main/routes/payment-methods.ts`'s `countUsage()` now counts `payments`
rows by `metadata.payment_method_id`. Its `merge` route now **also**
updates the authoritative `payments.method`/`metadata` for every matching
row, in the same transaction as the existing `payment_details` rewrite —
without this, a merge would have silently stopped having any visible
effect once reads moved off `payment_details` (§ F documents why the
legacy write is kept anyway).

`preparePaymentBatch()`'s internal `existingPayments` (used only for the
duplicate-transaction-id guard, `transactionPaymentMatches`) now derives
from `payments` via the same helper instead of parsing the stored column.
`amount_omitted` is not tracked on `payments`, so a derived line simply
lacks it — `transactionPaymentMatches` already treats an absent
`amount_omitted` as "not enforced," the same fallback it has always used
for any legacy line that predated that field, so this is not a behavior
change.

**Defensive design:** `deriveBillPaymentDetails()` catches and logs any
query failure and returns `null` rather than throwing — it feeds bill
*display*, and a read-side failure must never take down basic bill
viewing (Principle 8). This is deliberately the opposite posture from the
payment *write* path (`persistPayment`), which correctly fails loudly —
proven by a test that renames the `payments` table away and confirms bill
generation still works while the payment write still fails atomically.

---

## C. Payment-status / paid-amount migration

Audited every place that derives paid amount, payment status, outstanding
balance, or bill paid/unpaid state:

- `bills.paid_amount`/`balance`/`payment_status` are written directly by
  `applyPaymentBatch()` (hospitality) and `markBillPaidFromPayment()`
  (retail) — **both unchanged**, both already independent of
  `payment_details` (they compute from the tender amounts in the request,
  not by re-reading what was just written).
- **One semantic detail had to be preserved exactly**, caught by the test
  suite: the old `paymentMethodBreakdown(..., paidOnly=true)` filtered by
  `bills.payment_status = 'paid'` — i.e. "this *bill* is fully settled" —
  not by whether any individual payment itself had settled. A first
  attempt at the migration filtered by `payments.state IN ('captured',
  'settled')` instead, which is a different concept: a settled cash
  payment against a bill that is only *partially* paid would then
  incorrectly appear in the `paidOnly` report. Fixed by joining back to
  `bills.payment_status` in the query, restoring the exact original
  semantic (`tests/issue-214-payment-integrity.test.ts` — "sales report
  includes only paid split lines").
- No other reader of paid amount/status was found depending on
  `payment_details`.

---

## D. Historical reconciliation (Part C)

**Partial legacy mirrors are real, not merely theoretical.** Before
SYNC-0, `recordAppliedPaymentLine()` swallowed errors **per line**, inside
`applyPaymentBatch`'s own loop over tender lines. A pre-SYNC-0 split
payment (e.g. £50 cash + £20 card) could have had its first line mirror
successfully and its second silently fail — leaving a bill with **one**
`payments` row, which migration v80's "skip if any payment exists" guard
would never touch, even though it is still missing a line.

`main/core/payment-reconciliation.ts` (new module):

- **`reconcileBillPayments(billId, { dryRun? })`** — compares a bill's
  legacy `payment_details` lines against its authoritative `payments`
  rows. Matching: a line with a `transaction_id` matches an authoritative
  row with the same `provider_reference`; otherwise matches by
  `(method, amount)`. Matched rows are consumed so a repeated identical
  line can't double-match. Every unmatched line is classified:
  - **matched** — already represented.
  - **reconstructed** — no authoritative row exists, but the line has a
    valid method and a positive, finite amount (the exact criteria
    migration v80 already uses), so a new `payments`/`payment_events` pair
    is created — with `metadata.legacy_method`/`metadata.backfill_source`
    preserving provenance (§ E).
  - **unrepresentable** — the line itself is malformed (no method, or a
    non-positive/non-finite amount) and is **left alone, not invented**;
    reported so a human can investigate.
- **`reconcileAllPaymentDetails({ dryRun? })`** — runs the above over every
  bill that still has `payment_details`, returning a summary report.
- **Idempotent** — a bill that already fully matches (including one v80
  already fully backfilled) produces zero reconstructions on a repeat run,
  which doubles as a consistency check on v80's own output.

**Migration v85** (`payment_cutover_reconciliation`) runs
`reconcileAllPaymentDetails()` once, logging a summary. It is lazily
`require()`d from inside the migration's closure (not a top-level
`import`), the same pattern already used for `./lib/phone` elsewhere in
`main/db.ts` — this avoids the circular-import hazard of `main/db.ts`
importing a module that itself imports `getDatabase`/`now` back from
`main/db.ts`.

**Test fixture matching the task's own example** (`tests/payment-cutover.test.ts`
§6-9): a bill with `payment_details` = `[£50 cash, £20 card]` but only a
£50 cash row in `payments` — `reconcileBillPayments` detects the missing
£20 line, reconstructs it deterministically, and a second pass confirms
nothing is reconstructed twice. A second fixture with a negative amount
and a missing-method line proves both are flagged `unrepresentable` and
**no payment row is fabricated** for either.

---

## E. Legacy method preservation

Every reconstructed payment (both v80's original backfill and this
milestone's reconciliation pass) stores the **original legacy method
label directly in `payments.method`** — e.g. `"UPI"`, not a coarsened
`"manual_card"`. The `adapter` column separately carries the coarse
adapter classification (`cash`/`wallet`/`manual_card`) used for behavioral
dispatch. This already matches the live `tender()`/`recordAppliedPaymentLine()`
path's own convention (`method` = display label, `adapter` = behavior
class) — no data was ever destroyed here.

This milestone adds one further layer specifically for **reconciliation**-
sourced payments: `metadata.legacy_method` and
`metadata.backfill_source: 'payment_reconciliation'`, so a reconstructed
payment is explicitly distinguishable from one created live or by v80's
bulk backfill (which does not set this marker — see § L). Example:

```json
{ "legacy_method": "upi", "backfill_source": "payment_reconciliation" }
```

---

## F. Dual-write status — kept, deliberately, as a narrow bridge

**`bills.payment_details` is still written** by `applyPaymentBatch()`.
This was a genuine decision point (Part F explicitly allows either
outcome), and the reasoning for keeping the write is recorded here rather
than assumed:

1. **Every reader that mattered for correctness has been migrated** —
   receipts, reports, usage counts, merge, bill rendering, the internal
   duplicate-payment guard. Nothing in the app depends on `payment_details`
   being populated for anything to work correctly.
2. **Stopping the write is a materially different risk than migrating a
   reader.** `applyPaymentBatch()` is the single most load-bearing function
   in the app, and two prior milestones (Milestone 2, SYNC-0) were
   explicit that it should not be rewritten. Migrating *what a reader
   consumes* is a small, encapsulated, reversible change; *removing an
   existing write* from that function is a step this audit is not
   confident is risk-free — Part K's own stop conditions include "removing
   the dual-write would change visible merchant behavior unexpectedly,"
   which cannot be fully ruled out without broader confidence than a
   focused reader audit can provide (e.g. dev tooling, CSV export/import,
   or a support workflow this audit did not find that still expects the
   column populated going forward).
3. **The cost of keeping it is genuinely small.** `allPayments` (the array
   written to `payment_details`) is already computed as part of allocating
   the tender batch — writing it is not new work, just an existing write
   left in place.
4. **It remains useful, narrowly:** a human-auditable, independent JSON
   snapshot on the bill row itself for support/debugging even if the
   authoritative model had a bug; the split-bill guard's defensive OR
   condition (§ A, item 4) still reads it, harmlessly, alongside the two
   authoritative conditions that already gate the same check; and the
   disabled FloAdmin bridge (§ A, item 13) still reads it.

**End state achieved:** `payments`/`payment_events` is the sole
authoritative source for every merchant-facing read.
`bills.payment_details` is exactly the "unused compatibility legacy" Part F
describes for *reads* — write-side, it remains a deliberate, narrow,
documented bridge, not a second source of truth anything depends on for
correctness. **It is now demonstrably ready for retirement (dropping the
write) whenever a future milestone chooses to accept that specific,
narrower risk** — the reader-migration work that would have blocked that
decision is done.

---

## G. Tests

`tests/payment-cutover.test.ts` — 36 checks covering all 15 requested
areas: receipt/bill rendering sourced from `payments` (including proof
that corrupting `payment_details` has zero effect), payment-method report
aggregation, usage counting, merge updating the authoritative model,
payment status/paid amount unaffected, historical reconciliation (both the
exact £50-cash/£20-card scenario and an ambiguous/unrepresentable case),
legacy method provenance in metadata, hospitality/retail/refund/split-bill/
payment-replay regression.

`tests/issue-214-payment-integrity.test.ts` updated: report-fixture
payments are now seeded as real `payments` rows (matching what the
migrated reader actually consumes) instead of raw `payment_details` JSON
injection; a new assertion proves malformed `payment_details` has zero
effect on the report.

---

## H. Hospitality regression

`plemmo-payment-service`, `plemmo-sale-service`, `plemmo-audit`,
`plemmo-access-control`, `plemmo-authorization-hardening`, `staff-authz`,
`orders-authz`, `held-orders`, `bills-print-api`, `printer`,
`receipt-printing`, `integration-order-lifecycle`,
`integration-bill-reconciliation` — all green, unchanged.

---

## I. Retail regression

`plemmo-retail`, `plemmo-inventory`, `plemmo-purchasing`,
`plemmo-multi-location`, `integration-payments`, `integration-happy-path`
— all green, unchanged.

---

## J. Full suite

`npm test` — including the new `test:payment-cutover` entry — passes with
`EXIT_CODE=0`, captured directly, zero failures.

---

## K. Build/lint

`tsc --noEmit`, `npm run build` clean. `npm run lint` — 0 errors (903
pre-existing-pattern warnings, two more than SYNC-0's count, from the new
files' own `any` usages matching the codebase's existing convention).
Frontend lint clean — no frontend file needed to change.

---

## L. Remaining `payment_details` dependency

- **Write:** `applyPaymentBatch()` still writes it, deliberately (§ F).
- **Read:** `autoRepairPaymentDetails()` (boot-time corruption self-heal)
  and the disabled FloAdmin bridge (`main/services/cloud-sync.ts`) still
  read it — both out of scope for this migration, documented in § A.
- **Known limitation:** v80's original bulk backfill (already shipped in
  SYNC-0) does not set `metadata.legacy_method`/`backfill_source` the way
  this milestone's reconciliation pass does — v80 predates that
  provenance convention and was not modified retroactively (migrations are
  treated as immutable once numbered, matching the codebase's own
  discipline). A payment backfilled by v80 is therefore indistinguishable
  from a live payment by metadata alone; one reconstructed by v85's
  reconciliation pass is not. This is a cosmetic gap, not a correctness
  one — both represent the same real historical payment.

---

## M. Exact commits

See the git log for `docs(payment-cutover)`, `payments(payment-cutover)`,
`reports(payment-cutover)`, `test(payment-cutover)` — logical commits
covering: the `deriveBillPaymentDetails` helper + `parseRowJson`/
`printers.ts` wiring; `reports.ts`/`payment-methods.ts` reader migration;
`preparePaymentBatch`'s internal read migration; the new
`payment-reconciliation.ts` module + migration v85; the test suite and
`issue-214` fixture update; this document.

---

## N. SYNC-A readiness verdict

**Ready.** The payment model is now singular, complete, and every
merchant-facing consumer sources from it. Historical partial-mirror risk
(the one genuine gap SYNC-0 left open) is closed by the reconciliation
pass, which is idempotent and safe to re-run. `bills.payment_details`
remains only as a narrow, explicitly-justified write-side bridge with no
read-side dependents that matter — SYNC-A's outbox can treat
`payment_events` as the complete, sole source of payment facts to
transmit, with no risk of silently missing hospitality payments that
predate this work.

---

## See also

- [`SYNC_0_FOUNDATION.md`](./SYNC_0_FOUNDATION.md) / [`SYNC_0_PAYMENT_MIGRATION.md`](./SYNC_0_PAYMENT_MIGRATION.md) — the prerequisite work this milestone completes
- `main/db.ts`'s `deriveBillPaymentDetails`/`parseRowJson`,
  `main/core/payment-reconciliation.ts` — the code itself
- `tests/payment-cutover.test.ts` — the verification this record's claims are checked against
