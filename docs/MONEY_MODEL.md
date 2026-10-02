# Money model

Every amount a till shows, prints, reports or syncs must be exactly reproducible. This is how the
product guarantees it. Code: `main/core/money.ts`, `main/core/money-integrity.ts`; schema: migration v97.

## The rules

1. **Arithmetic is done in integer minor units** (pence, cents, yen). Never add, subtract or
   multiply money with floating-point `+ - *` and store the result. Use `sumMoney()`,
   `toMinor()/fromMinor()`, `percentOfMinor()`, `allocateMinor()` from `core/money.ts` and
   `core/money-integrity.ts`.
2. **Stored money is a whole number of minor units.** The sales-side tables keep money in SQLite
   `REAL` columns, but every stored value must equal `ROUND(v × 10^e) / 10^e` exactly
   (12.35, never 12.350000000000001). `e` is the tenant currency's exponent (GBP 2, JPY 0, KWD 3).
3. **The database enforces rule 2 for every writer.** Migration v97 installs `AFTER INSERT/UPDATE`
   triggers (`trg_money_q_<table>_insert|update`) on each table in `MONEY_COLUMNS`. A writer that
   produces residue (a rounding slip in some route, an imported row, a sync apply) is silently
   corrected to the nearest minor unit instead of failing the sale. The triggers are re-asserted on
   every start, so a later table rebuild cannot leave a table unguarded.
4. **SQL aggregation uses `minorSql(col)`** (`CAST(ROUND(col × 100) AS INTEGER)`) so a Z report or
   VAT summary sums exact integers and converts to money once at the end.
5. **Payments are already integer.** The `payments` table stores `amount_minor`, `refunded_minor`,
   `tendered_minor`, `change_minor`, `tip_minor`.

## What is and is not "money"

Listed in `MONEY_COLUMNS` (quantised): prices, line/order/bill totals, tax and discount amounts,
charges, round-off, paid/balance, purchase-order totals, catalogue price/cost, the cloud-mirror
`remote_*` copies.

Deliberately **not** listed: quantities, stock, percentages and rates (`tax_rate`, `cb_percent`,
`discount_value`), geometry, and **per-unit cost rates** (`unit_cost`), which may legitimately be
sub-penny (£0.0375 per gram). Totals derived from them are quantised.

## Why REAL + guards instead of new `*_minor` columns

The plan proposed additive integer columns beside each money column. The sales tables have ~50
writers, sync payloads and a Postgres mirror that all read the REAL columns. Adding parallel
columns means either changing all of them (large blast radius, risk to live trading) or keeping two
sources of truth that can disagree. Quantised REAL is exactly representable for every currency we
support (≤3 decimals), so the guarantee is identical and the change is one migration with no
reshaping. Real integer columns remain possible later; nothing here prevents it.

## Tooling

| What | How |
| --- | --- |
| Scan a database for residue | `scanMoneyIntegrity(db)` (used by `audit:db` and tests) |
| Fail a test run on any residue | run with `MERIDIAN_MONEY_SCAN=1` — `closeDatabase()` throws |
| One-off repair | `repairMoneyColumns(db)` (what v97 runs) |
| Find writers that bypass the rule | `MERIDIAN_MONEY_GUARDS=off MERIDIAN_MONEY_SCAN=1` (test/diagnostic only; disables the triggers so residue is visible) |

Tests: `npm run test:money-integrity` (33 checks: helpers, guards for GBP/JPY/KWD, scanner, sale
engine exactness, v96→v97 upgrade keeps every row).

## Adding a money column

Add it to `MONEY_COLUMNS`, write via `toMinor/fromMinor`, and the next start installs its guard.
