# Card payments

The till takes cards in one of two ways. Both are honest about what they know.

| Mode | How it works | How the payment is recorded |
| --- | --- | --- |
| **No provider** (default) | The cashier takes the card on a separate terminal and tells the till what happened. | `manual_card`, state `captured`. The till and the end-of-day report label it **not confirmed by a card provider**. |
| **Provider connected** | The till sends the amount to the terminal through the provider. Only the provider's own answer approves it. | `card_terminal`, state `captured`, with the provider reference, scheme and last four digits. Never labelled unconfirmed. |

Choose the mode in **Settings → Card payments** (owner or manager). A hand-recorded card is always available as a
fallback when the terminal is down, and stays labelled unconfirmed.

## What is built

- `main/core/card-terminal/` is provider-neutral: `types.ts` (the contract), `registry.ts` (which provider is
  active), `service.ts` (the attempt ledger and money rules), `simulator.ts` (a labelled test double).
- Table `card_attempts` (migration v102) holds every request to a provider, for sales and refunds.
- `POST /api/card/attempts`, `GET /api/card/attempts/:id` (poll), `POST /api/card/attempts/:id/cancel`,
  `GET /api/card/config`, `PUT /api/card/config`, `GET /api/card/terminals`, `GET /api/card/reconciliation`.
- Paying a bill with `{ method: "card", card_attempt_id }` takes the amount, tip and reference **from the approved
  attempt**, not from the browser. An attempt can be used once, only on its own bill, only when approved.
- Refunds of a `card_terminal` payment go to the provider first. If the provider refuses, nothing changes on the
  till. If the provider refunds but the till then fails to save, the refund shows in reconciliation.
- Reconciliation lists approved attempts with no payment, provider refunds with no refund row, and payments whose
  amount differs from the approval.

## The simulator

For development, demos and the test suite. It is **not offered in a packaged release build** unless
`PLEMMO_ALLOW_CARD_SIMULATOR=1` is set, so a merchant can never take real orders through a test double. Everything it
produces is marked simulated in the database, the till and the receipt.

The outcome follows the pence in the amount: `.05` declined, `.06` never answers (times out), `.07` terminal offline,
everything else approved. A refund ending `.13` is rejected. `PLEMMO_CARD_SIMULATOR_DELAY_MS` sets how long an
approval takes (default 1.5 seconds).

## Adding a real provider

A provider is one file implementing `CardProvider` (`types.ts`) and one `registerCardProvider(id, factory)` call.
Requirements:

1. `startSale` and `refund` must be idempotent for the same key (the attempt id, or the derived refund key).
2. `getStatus` must reflect the provider's authoritative state. Never report `approved` from anything the browser
   or the cashier supplied.
3. Never store or log a full card number, CVV or track data. Only scheme and last four digits.
4. Secrets (API keys, terminal pairing tokens) belong in the secret store (`safeStorage`), never in settings,
   the repository or the browser.
5. Map provider failures to `CardProviderError` with `kind: 'offline'` (nothing was sent) or `'rejected'` (the
   provider said no). Anything else is treated as "could not be reached, nothing charged".

To finish a real integration the following are needed from the business (see `docs/PLEMMO_COMPLETION_PLAN.md`, WP10):
the chosen provider, sandbox credentials, and a terminal to test with. Until then the framework is complete and
exercised end to end by the simulator, and **no real provider has been verified**.

## Settlement

`card_terminal` payments stay `captured` until a provider settlement report marks them `settled`. Importing that
report is part of the provider-specific work and is not built yet; the trading report counts these takings as
card takings confirmed by the provider, but not yet as settled to the bank.
