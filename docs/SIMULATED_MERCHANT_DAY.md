# Simulated merchant day

**This is a simulation.** It is a scripted, seeded day run through the real till server, database and the simulated
card terminal. It is not a pilot, and it says nothing about real hardware, real card terminals, real network
conditions or real staff. Those are covered by `docs/HARDWARE_TEST_MATRIX.md` and the pilot (WP12). Anything below
that is labelled *simulated* must not be quoted as "verified".

Run it: `npm run test:merchant-day` (`DAY_SEED=7 DAY_SALES=300 npm run test:merchant-day` for another day).

## What the day contains

A small shop of 14 items across standard, reduced, zero-rated and exempt VAT, ten of them tracking stock, two
cashiers, a manager and an owner. About 140 attempted sales with:

- cash with change; card on the terminal with and without tips; card recorded by hand; cash + card splits;
- card declines, a customer who never taps (cancelled), and an offline terminal, each recovered by taking cash or
  recording the card by hand;
- order discounts; orders abandoned before billing (voided, stock returned);
- the same payment request sent twice after a "lost response", and two identical requests fired at once (double tap);
- a power cut: two customers charged on the terminal while the till recorded nothing, found by reconciliation and
  recorded by the manager;
- cash and card refunds (whole, part, by item), one the card provider refuses;
- goods in, a stocktake with shrinkage, pay in / pay out, a drawer counted 3.00 short;
- X report, drawer close, Z report.

## What it checks

The script keeps its own running figures and never reads them back from the till. At the end it requires, to the
penny and to the unit:

- sales, refunds and net on the X and Z reports equal the script's totals; tenders (cash, terminal, hand-recorded
  card, tips) equal the script's totals; only hand-recorded card takings are flagged unverified;
- the drawer's expected cash equals float + cash sales − cash refunds + pay in − pay out, and the 3.00 shortage shows;
- gross by VAT rate adds up to the day's gross, and net + VAT equals gross for every rate;
- stock of every tracked item equals start + goods in − sold + returned + stocktake corrections;
- every bill's payments add up to exactly its total; no provider reference sits on two payments; every terminal
  approval became exactly one payment; no approval is left unmatched; every payment has an audit event;
- SQLite integrity and foreign-key checks pass; exactly one Z exists;
- a provider refusal changes nothing locally; a fully refunded sale cannot be refunded again;
- 95% of sales are billed and paid in under 1.5 s.

## Results (simulated)

Seeds 20261001, 7 and 424242 each pass (132–138 sales, about 3,200–3,450 gross, 42 checks). On the development
machine the median bill-and-pay time was about 30 ms and p95 about 55 ms. Those latencies are a regression guard
for this simulation only; real tills with slower disks, networks and printers will differ.

## What it does not cover

Real printers, scanners, drawers and card terminals; the Windows installer and updates; the cloud over a real
network; many tills trading at once; a multi-day trading period; kitchen display and table service; tax returns.
