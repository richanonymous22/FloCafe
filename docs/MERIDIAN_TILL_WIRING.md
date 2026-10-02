# Meridian till wiring

The Meridian register used to change a local state object (`S`) for several
money/stock/hardware actions. Each of these now goes to the authoritative
backend; Meridian only displays what the backend answered and then re-reads the
affected order. `frontend-meridian/src/03k-plemmo-till.js` holds the thin client
(`window.PlemmoTill`); the screens are in `04-register-kitchen.js` and
`05-backoffice.js`.

| Action | Route | Decides |
|---|---|---|
| Refund | `POST /api/bills/:id/refund` | permission or manager PIN, amount ≤ unrefunded balance, idempotency, refund row, stock return, cash drawer, loyalty, audit |
| Void (unpaid order) | `PATCH /api/orders/:id/status` `{status:'cancelled'}` | PIN when the order is in progress; refuses an order with payments (409 → refund) |
| Print receipt | `POST /api/printers/print-bill` | default printer, 58/80 mm profile, transport result (502 + `detail` on failure) |
| Hold / resume | `POST/GET /api/held-orders/carts`, `POST …/:id/resume`, `DELETE …/:id` | storage, duplicate protection, atomic resume |
| Backup | `POST /api/db/backup` | owner + Master PIN, new uniquely-named file each time |
| Devices | `GET /api/printers`, `/printers/detect`, `POST /printers/:id/test`, `POST /retail/cash-drawer/open`, `GET /kitchen-stations` | real results only |
| Barcode | `GET /api/retail/lookup?code=` | product/variant match |
| Price override | `price_override` on `POST /api/orders` and `POST /api/orders/:id/items` | `sales.price_override` permission or manager PIN, audit |

## Things worth knowing

- **`POST /api/bills/:id/print` does not print.** It only records a print-log
  row. The route that dispatches to the printer is `POST /api/printers/print-bill`.
  Meridian calls that, and writes the log entry only after a successful print.
- **Approvals.** Meridian cannot verify a manager PIN (staff PINs are hashed on
  the server). When the signed-in user lacks the permission it only *collects*
  the PIN and sends it as `override_pin`; `main/core/approval.ts` validates it,
  rate-limits wrong attempts (5 / 15 min) and records the approving user.
- **Refunds return the sale amount, not the tip.** Tips are recorded separately
  on the payment and are not refunded automatically.
- **Partial refunds** are supported by the route (`amount`) and by the order
  status (`refundedAmt`); the Meridian screen currently offers a full refund of
  what remains.
- **Held carts** are not sales: no totals, no stock effect, no sync. They live in
  `held_carts` (migration v96), separate from the table-keyed `held_orders`.
- **Removing an item the kitchen already has** on a backend order is refused in
  Meridian: there is no till-facing per-item void in the backend, so the screen
  would otherwise show a total the customer is not charged.

Tests: `test:till-refund-void`, `test:till-price-override`,
`test:till-print-held-backup` (backend over HTTP) and `test:meridian-till` (the
built Meridian bundle in jsdom → HTTP → SQLite, asserting against the database
and a real TCP socket standing in for the printer).
