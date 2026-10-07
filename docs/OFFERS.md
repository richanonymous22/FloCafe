# Offers

Automatic promotions the till applies on its own. Set them up in **Items & stock → Offers** (owners and managers).

## Types

| Type | Example | How the saving is worked out |
| --- | --- | --- |
| Percent off | 10% off drinks | each unit's price × percent, rounded half-up to the penny |
| Amount off each | 50p off each cake | per unit, never more than the unit costs |
| Fixed price each | any sandwich £3 | per unit, only if it normally costs more |
| Multi-buy price | 3 for £5 | each complete bundle of the dearest matching items costs the bundle price |
| Buy some, get some free | buy 2 get 1 free | in each complete group (dearest first) the cheapest ones are free |

An offer can apply to everything, one category or chosen items; can be limited by start and end date, days of the week, a
time of day (an overnight window is fine), customers (anyone, only when a customer is added, or loyalty tiers) and
priority. Times are the shop's clock. An offer can be switched off, and removing one archives it (past sales keep their record).

## Rules

- The till server applies offers, not the screen. The saving becomes the sale's **discount**, so VAT, the bill, loyalty
  cashback, refunds and the X/Z reports already agree with it. Refunds by item value each item at what was actually paid.
- **A discount a person adds always wins**: while a sale has one (on the order or on a single line), offers do nothing
  for that sale. Removing it lets offers apply again.
- Each item takes part in **one** offer. Offers apply in priority order (highest first), then the one that saves most,
  then the oldest.
- Lines with a manager's price override, free items and part-quantities (weighed goods) are left out.
- Nothing changes once money has been taken on the bill, and a paid sale is never recalculated.
- The register shows the expected saving as you build the basket (a preview); the sale itself is priced by the server
  when it is made, and the pay screen charges the server's total.

## API

`GET /api/offers`, `POST /api/offers`, `PUT /api/offers/:id`, `POST /api/offers/:id/active`, `DELETE /api/offers/:id`,
`POST /api/offers/preview`, `GET /api/offers/usage?from=&to=` (savings per offer for paid sales). Creating and changing
need the `offers.manage` permission (owner, manager). Every change is audited (`offer.changed`).

## Limits in this version

- Offers are stored on each till. They are not copied between tills or to the cloud yet, so a merchant with several tills
  sets them up on each.
- Bundles and free items are grouped from the **dearest** matching units first (the customer's cheapest items are the free ones).
- The Z report counts offer savings inside "discounts"; the per-offer figures are in `GET /api/offers/usage`.
