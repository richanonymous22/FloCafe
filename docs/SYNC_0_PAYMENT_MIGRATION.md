# SYNC-0 Payment Migration

The detailed payment-entry-point audit and migration record for SYNC-0
Part A. Read alongside [`SYNC_0_FOUNDATION.md`](./SYNC_0_FOUNDATION.md) (the
whole milestone) and [`MILESTONE_9A_SYNC_REVIEW.md`](./MILESTONE_9A_SYNC_REVIEW.md)
§ Review Issue 3, which identified the payment dual-write as the single
biggest sync blocker.

---

## A1 — Complete inventory of payment entry points

Every code path that creates or modifies payment state, found by auditing
the repository (not assuming the two known paths were the only ones):

### Writes that apply a payment

| Path | File | Writes `bills.payment_details` | Writes `payments`/`payment_events` |
|---|---|---|---|
| `applyPaymentBatch()` — hospitality / all bill payments (`POST /bills/:id/payment`, `POST /bills/:id/payments`) | `main/routes/bills.ts:706` | **Yes, authoritative** | **Yes** — via `recordAppliedPaymentLine()` (`bills.ts:713` → `payment.ts`) |
| `tender()` — retail checkout | `main/modules/retail/checkout.ts:100` | No | **Yes, authoritative** |

### Writes that mutate an existing payment (not new payments)

| Path | File | Effect |
|---|---|---|
| `voidPayment()` | `main/core/payment.ts` | `payment_events` state change. No live HTTP route (Core-only). |
| `refundPayment()` | `main/core/payment.ts` | `refunds` + `payment_events`. No live HTTP route (Core-only). |

### Non-payment modifications of the `payment_details` JSON

| Path | File | Purpose |
|---|---|---|
| Corruption auto-repair | `main/db.ts:691` | Normalizes a malformed `{A},{A}` blob to `[A]` |
| Legacy UPI method backfill | `main/db.ts:3435` (migration) | Rewrites the method label inside existing `payment_details` |
| Payment-method rename/merge | `main/routes/payment-methods.ts:103` | Updates method names inside existing `payment_details` |

### Readers of `payment_details`

`main/printers/thermal.ts` (receipt payment breakdown),
`main/routes/reports.ts:60` (payment-method report aggregation),
`main/routes/payment-methods.ts:21` (usage/merge history),
`main/routes/bills.ts:489` (bill rendering), and the disabled FloAdmin
bridge `main/services/cloud-sync.ts`. Retail reports
(`main/modules/retail/reports.ts:32`) read `payments` instead.

---

## A1 — Current behavior (before SYNC-0)

Two findings the Milestone 9A review surfaced, both confirmed at the
`file:line` above:

1. **The hospitality dual-write swallowed all errors and was untested.**
   `recordAppliedPaymentLine()` wrapped its whole body in
   `try { … } catch { console.error(…) }` — so a payment could commit to
   `payment_details` while its `payment_event` was silently lost.
2. **Neither payment store was complete.** `payment_details` had
   hospitality but not retail; `payments`/`payment_events` had retail
   reliably and hospitality best-effort. Two report systems read two
   different, individually-incomplete stores.

---

## A2/A3 — Target behavior and the chosen transition

**Target:** `payments`/`payment_events` is the single authoritative payment
model containing *all* real merchant payment activity — hospitality and
retail alike. `bills.payment_details` becomes compatibility data.

**Chosen strategy — transactional authoritative dual-write.** Considered
and rejected: a full rewrite of `applyPaymentBatch` onto `tender()` (the
milestone forbids rewriting the load-bearing payment path); a
compatibility rebuild that reads `payment_details` on the fly (leaves two
sources of truth). The chosen approach is the smallest safe change:

- `recordAppliedPaymentLine()` **no longer swallows errors**. It already
  ran inside `applyPaymentBatch`'s transaction; removing the `try/catch`
  makes it atomic — if the authoritative model cannot record a payment,
  the *entire* payment (including the `payment_details` write) rolls back.
- **Why this is safe:** the three local adapters (cash/wallet/manual_card)
  are pure functions that cannot throw, and `persistPayment` only touches
  the local database inside the already-open transaction. It cannot fail
  on valid input; if it somehow does, failing loudly (rolling the payment
  back) is the correct outcome — never "payment succeeded, record missing."
- **Idempotency is inherited:** both of `applyPaymentBatch`'s replay paths
  return before `recordAppliedPaymentLine` is reached, so a retried request
  never produces a duplicate `payments` row.

Guarantee delivered: **if a payment succeeds, the authoritative payment
model also succeeds** — proven end-to-end in
`tests/plemmo-payment-service.test.ts §16` (renaming the `payments` table
out from under the hook now makes the payment fail atomically, leaving the
bill unpaid and no partial `payment_details`).

---

## A4 — Historical backfill

Migration **v80** (`sync_0_payment_foundation`) reconstructs
`payments`/`payment_events` from legacy `bills.payment_details`:

- **Scope:** only bills with **zero** existing `payments` rows. A bill that
  already has payments (retail via `tender()`, or a hospitality bill whose
  dual-write already ran) is assumed mirrored and left untouched.
- **Deterministic / idempotent / duplicate-safe:** re-running finds the
  rows it created and skips them; the "zero payments rows" guard is the
  idempotency key.
- **Fidelity assumptions, both matching how the data was created:** amounts
  are 2-decimal (`Math.round(amount * 100)`, the same unconditional `* 100`
  `applyPaymentBatch` used); currency is the install's current `currency`
  setting (bills never stored a per-row currency).
- **Mapping:** `cash → cash/settled`, `wallet → wallet/settled`, anything
  else `→ manual_card/captured`. Organization/location resolved from the
  bill's order. `bill_uid`/`order_uid` resolved from the bill/order.
- **Never invents values (Part A4/K):** a line with no method or no
  positive amount is **skipped and counted**, not guessed. Legacy refunds
  encoded in `payment_details` (if any) are not reconstructed — a
  zero/negative line is not a captured payment. The migration logs
  `N bill(s), N line(s) reconstructed, N line(s) skipped`.

Tested against the **real v1.5.0 fixture** in `tests/upgrade-path.test.ts`:
the fixture's legacy UPI bill (`{method:'upi', amount:105}`, no payments
rows) is reconstructed into one `manual_card`/`captured` payment of
`10500` minor units with a matching `payment_event` and populated
`bill_uid`/`order_uid`.

---

## A5 — Backward compatibility (the compatibility period)

`bills.payment_details` is **not** dropped in SYNC-0. It is still written by
`applyPaymentBatch` and still read by the receipt printer and the legacy
reports. The end state is **one authoritative model
(`payments`/`payment_events`) plus one compatibility bridge
(`payment_details`)** — not two competing sources of truth. Retiring
`payment_details` entirely is deferred until its readers migrate onto
`payments` (a later, non-SYNC-0 step — see `SYNC_0_FOUNDATION.md`
§ Remaining prerequisites).

---

## A6 — Payment identity

`payments` gained `bill_uid`/`order_uid`; `refunds` gained
`bill_uid`/`order_uid` (its `payment_id` is already a ULID). Populated on
every new payment/refund by `persistPayment`/`refundPayment`, and
backfilled on existing rows by v80 from the local integer FKs. The integer
`bill_id`/`order_id` FKs stay for local joins — nothing is removed, no JOIN
is rewritten.

---

## Known limitations

- A hospitality bill whose pre-SYNC-0 dual-write *partially* succeeded (some
  lines mirrored, some swallowed) is skipped by the backfill (it has ≥1
  payment row) and is **not** completed — completing it would risk
  duplicates and requires guessing which lines are missing. In practice the
  adapters never throw, so a partial mirror is a theoretical, not observed,
  case. Documented rather than guessed (Part K).
- The 2-decimal backfill assumption is wrong for JPY/KWD-style currencies —
  but it faithfully reproduces what the legacy path actually stored, which
  is the only recoverable truth. New payments via `tender()` are
  currency-exponent-correct.
