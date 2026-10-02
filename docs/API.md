# Flo API Documentation

## Base URL

**Local:** `http://flo.local:3001` or `http://<local-ip>:3001`

---

## Authentication

### POST `/api/auth/login`
Authenticate user and receive JWT token.

**Request:**
```json
{
  "email": "chef1@flo.local",
  "password": "chef123"
}
```

**Response (200):**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "user": {
    "id": "chef-1",
    "name": "Chef One",
    "email": "chef1@flo.local",
    "role": "chef",
    "category_ids": ["cat-1", "cat-2"]
  }
}
```

**Error (401):**
```json
{
  "error": "Invalid credentials"
}
```

---

### POST `/api/auth/register`
Register new user (owner/admin only).

**Request:**
```json
{
  "name": "John Doe",
  "email": "john@flo.local",
  "password": "securepassword",
  "role": "cashier"
}
```

**Response (201):**
```json
{
  "message": "User created",
  "user_id": "user-xxx"
}
```

---

## User Management

### GET `/api/users`
List all users (owner/manager only).

**Headers:** `Authorization: Bearer <token>`

**Response (200):**
```json
{
  "users": [
    {
      "id": "user-1",
      "name": "Owner",
      "email": "admin@flo.local",
      "role": "owner",
      "is_active": 1
    }
  ]
}
```

---

### POST `/api/users`
Create new user.

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "name": "Chef One",
  "email": "chef1@flo.local",
  "password": "chef123",
  "role": "chef",
  "category_ids": ["cat-1", "cat-2"]
}
```

**Response (201):**
```json
{
  "success": true,
  "id": "chef-1"
}
```

---

### PATCH `/api/users/:id`
Update user details.

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "name": "Updated Name",
  "role": "manager",
  "category_ids": ["cat-1", "cat-2", "cat-3"]
}
```

---

### DELETE `/api/users/:id`
Delete user.

**Headers:** `Authorization: Bearer <token>`

---

## Categories

### GET `/api/categories`
List all categories.

**Headers:** `Authorization: Bearer <token>`

**Response (200):**
```json
{
  "categories": [
    { "id": "cat-1", "name": "Food", "is_active": 1 },
    { "id": "cat-2", "name": "Beverages", "is_active": 1 },
    { "id": "cat-3", "name": "Desserts", "is_active": 1 }
  ]
}
```

---

### POST `/api/categories`
Create category.

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "name": "Appetizers"
}
```

---

### PATCH `/api/categories/:id`
Update category.

---

### DELETE `/api/categories/:id`
Delete category.

---

## Products

### GET `/api/products`
List all products.

**Headers:** `Authorization: Bearer <token>`

**Query params:** `?category_id=cat-1&is_active=1`

**Response (200):**
```json
{
  "products": [
    {
      "id": "prod-1",
      "name": "Cheeseburger",
      "price": 250.0,
      "category_id": "cat-1",
      "is_active": 1,
      "has_addons": true
    }
  ]
}
```

---

### POST `/api/products`
Create product.

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "name": "Veggie Wrap",
  "price": 180.0,
  "category_id": "cat-1",
  "has_addons": false
}
```

---

### PATCH `/api/products/:id`
Update product.

---

### DELETE `/api/products/:id`
Delete (deactivate) product.

---

## Addon Groups

### GET `/api/addon-groups`
List addon groups.

**Headers:** `Authorization: Bearer <token>`

---

### POST `/api/addon-groups`
Create addon group.

**Request:**
```json
{
  "name": "Sauce Options",
  "addons": [
    { "name": "Extra Cheese", "price": 20 },
    { "name": "No Onions", "price": 0 }
  ]
}
```

---

## Tables

### GET `/api/tables`
List all tables.

**Headers:** `Authorization: Bearer <token>`

**Response (200):**
```json
{
  "tables": [
    { "id": "table-1", "name": "T1", "capacity": 4, "is_active": 1 }
  ]
}
```

---

### POST `/api/tables`
Create table.

---

### PATCH `/api/tables/:id`
Update table.

---

### DELETE `/api/tables/:id`
Delete table.

---

## Orders

### GET `/api/orders`
List orders.

**Headers:** `Authorization: Bearer <token>`

**Query params:**
- `?status=pending,preparing` - Filter by status
- `?date=2025-03-31` - Filter by date

**Response (200):**
```json
{
  "orders": [
    {
      "id": 1,
      "order_number": "ORD-001",
      "type": "dine_in",
      "status": "pending",
      "table": { "id": "table-1", "name": "T1" },
      "items": [
        {
          "id": 1,
          "product_name": "Cheeseburger",
          "quantity": 2,
          "status": "pending",
          "addons": [{ "name": "Extra Cheese", "price": 20 }],
          "special_instructions": "No onions"
        }
      ],
      "created_at": "2025-03-31T12:00:00Z"
    }
  ]
}
```

---

### POST `/api/orders`
Create new order.

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "type": "dine_in",
  "table_id": "table-1",
  "customer_id": "cust-1",
  "items": [
    {
      "product_id": "prod-1",
      "quantity": 2,
      "addons": [{ "addon_id": "addon-1", "price": 20 }],
      "special_instructions": "No onions"
    }
  ]
}
```

**Response (201):**
```json
{
  "order": { ... },
  "bill": { ... }
}
```

---

**Price override.** A line may carry `"price_override": { "unit_price": 3.00, "reason": "Damaged box" }` (also accepted by `POST /api/orders/:id/items`). It needs the `sales.price_override` permission (owner/manager) or a manager/owner `override_pin` in the request body; otherwise `403` (`requiresApproval: true`). The line is sold at the override price; the catalogue price is kept on the line as `original_unit_price` (with `price_override_reason` / `price_override_by`), the product's own price is never changed, and a `sale.price_overridden` audit event records the original price, new price, reason, requester and approver.

**Cancelling (void).** `PATCH /api/orders/:id/status` with `{"status":"cancelled"}` cancels an unpaid order and returns its stock through the inventory ledger. An order that has taken payment is refused with `409` (`code: "order_has_payments"`) — refund it instead.

---

### GET `/api/orders/:id`
Get order details.

---

### PATCH `/api/orders/:id`
Update order status.

**Request:**
```json
{
  "status": "preparing"
}
```

---

## Order Items

### PATCH `/api/order-items/:id/status`
Update item status (KDS workflow).

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "status": "preparing"
}
```

**Valid statuses:** `pending` → `preparing` → `ready` → `served`

---

### PATCH `/api/orders/:orderId/items/:itemId/cancel`
Remove one line from an order. An owner/manager removes it outright; a cashier or waiter must send a manager/owner `override_pin` (waiters only on their own orders). The approver is resolved from the PIN on the server and audited (`sale.item_voided`, with `requested_by` and `approved_by`).

**Request:** `{ "override_pin": "2222", "reason": "Customer changed their mind" }`

- A line the kitchen has **not started** is cancelled and goes back to stock through the inventory ledger (`item_cancel` return).
- A line **already preparing/ready** is voided: the original line is kept, a negative `void_adjustment` line is added so the bill nets out, and stock is **not** returned (the food was made).
- Removing the last active line cancels the order (stock is returned once, never twice).
- Order totals, discount, tax and an unpaid bill are recomputed in exact minor units.

**Errors:** `403` approval required (`requiresApproval: true`) or invalid PIN · `404` order/item not found · `409` the item is already removed · `429` too many PIN attempts.

---

## Order Discounts

### PATCH `/api/orders/:id/discount`
Apply order-level discount.

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "discount_type": "percentage",
  "discount_value": 10,
  "discount_reason": "Happy hour"
}
```

**Validations:**
- `discount_type`: must be `"percentage"` or `"amount"`
- `discount_value`: must be positive; cannot exceed store limits (`discount_max_percentage`, `discount_max_amount`)
- `discount_mode` setting is checked — if `'flat'`, percentage discounts are rejected; if `'percentage'`, flat discounts are rejected
- **Who may discount:** an owner/manager outright (permission `sales.discount`); a cashier or waiter only with a manager/owner `override_pin` — the approving user is whoever the PIN belongs to and is recorded in the `sale.discount_applied` audit event beside the requester. If `discount_requires_approval` is true, a PIN is required from everyone, managers included. Removing a discount (`discount_value: 0`) needs no approval.
- Tax and the bill are recomputed in exact minor units; an unpaid bill is kept in step
- Order must exist and not be completed/cancelled

**Error (400):**
```json
{ "error": "Percentage discounts are disabled" }
```

**Error (403) — approval required:**
```json
{ "error": "Manager PIN required for discounts", "requiresApproval": true }
```

---

### PATCH `/api/orders/:id/items/:itemId/discount`
Apply item-level discount.

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "discount_type": "amount",
  "discount_value": 25,
  "discount_reason": "Comp item"
}
```

**Validations:** Same as order-level discount.

---

## Bills

### GET `/api/bills`
List bills.

**Headers:** `Authorization: Bearer <token>`

**Query params:** `?date=2025-03-31&payment_status=paid`

---

### POST `/api/bills`
Create bill (after order completion).

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "order_id": 1,
  "payment_method": "cash",
  "amount_tendered": 500
}
```

---

### PATCH `/api/bills/:id/pay`
Mark bill as paid.

**Request:**
```json
{
  "payment_method": "cash",
  "amount_tendered": 500
}
```

---

### POST `/api/bills/:id/refund`
Refund all or part of a paid bill. Owners/managers refund directly; a cashier must send a manager/owner `override_pin`, and the approving user is recorded against the refund. The original sale, bill and payments are never rewritten — a refund only adds records (refund row, payment event, inventory return, cash-drawer movement, ledger entries, audit events).

**Headers:** `Authorization: Bearer <token>`, optional `Idempotency-Key` (a retry with the same key replays the stored result; the same key with a different request is `409`)

**Request:**
```json
{ "reason": "Wrong item", "amount": 4.00, "items": [{ "order_item_id": 12, "quantity": 1 }], "override_pin": "2222" }
```
`reason` is required. `amount` is optional (omitted = everything still refundable). `items` is optional: listed lines are returned to stock through the inventory ledger (capped at what was sold and not yet returned).

**Response (200):** `bill_id`, `amount_minor`, `refunds[]`, `payments[]`, `fully_refunded`, `refundable_remaining_minor`, `restocked[]`, `cash_drawer_recorded`, `loyalty_points_reversed`, `wallet_points_returned`, `idempotentReplay`.

**Refunding by item.** Send `"amount_from_items": true` with `items` and the server sizes the refund from the returned lines: each unit is worth its share of what the customer actually paid (`bills.total`, so an order discount and payable rounding are carried through), and returning every remaining unit refunds exactly what is left, to the minor unit. Each item may carry `"restock": false` for a money-only return (damaged goods). The quantity per line is capped at what was sold minus what has already come back (tracked in `refund_lines`). Item refunds are refused on split checks — refund an amount instead. Without `amount_from_items`, `items` only decides which lines go back to stock and `amount` (or "everything left") decides the money.

**Errors:** `400` invalid amount/items, amount above the unrefunded balance, or nothing left to refund · `403` approval required (`requiresApproval: true`) or invalid manager PIN · `404` bill not found · `409` idempotency-key reuse · `429` too many PIN attempts.

### GET `/api/bills/:id/refunds`
Refund history for a bill and what is still refundable (`refunds`, `payments`, `paid_minor`, `refunded_minor`, `refundable_minor`, `exponent`, `currency`) plus `items[]` — for each active line `order_item_id`, `name`, `quantity`, `refunded_quantity`, `refundable_quantity` and `unit_refund_minor` (what one returned unit refunds). This is what the till's partial-refund screen shows.

---

### POST `/api/bills/:id/applyDiscount`
Apply discount to a bill (owner/manager only).

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "type": "percentage",
  "value": 10,
  "reason": "Happy hour"
}
```

**Validations:**
- `type`: must be `"percentage"` or `"amount"`
- `value`: must be positive; cannot exceed store limits (`discount_max_percentage`, `discount_max_amount`)
- `discount_mode` setting is checked — restricts which discount types are allowed
- If `discount_requires_approval` is true, `override_pin` is required
- Recalculates tax on discounted subtotal
- Updates both bill and order in a transaction

**Error (400):**
```json
{ "error": "Discount exceeds maximum allowed" }
```

---

## Kitchen Display (KDS)

### WebSocket `/kds`
Real-time KDS connection.

**Step 1:** Connect to WebSocket
```
ws://flo.local:3001/kds
```

**Step 2:** Authenticate
```json
{
  "type": "auth",
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Step 3:** Receive initial data
```json
{
  "type": "auth_success",
  "user": {
    "id": "chef-1",
    "name": "Chef One",
    "role": "chef",
    "categoryIds": ["cat-1", "cat-2"]
  },
  "orders": [...],
  "counts": {
    "pending": 5,
    "preparing": 3,
    "ready": 1,
    "served": 10
  }
}
```

**Step 4:** Receive real-time updates
```json
{
  "type": "new_order",
  "order": { ... }
}
```

```json
{
  "type": "order_updated",
  "order": { ... }
}
```

**Update item status (send):**
```json
{
  "type": "status_update",
  "order_item_id": 1,
  "status": "preparing"
}
```

**Error response:**
```json
{
  "type": "auth_error",
  "message": "Invalid token"
}
```

---

### REST (Fallback) `GET /api/kitchen/orders`
Fetch kitchen orders (REST fallback for cloud/web).

**Headers:** `Authorization: Bearer <token>`

**Query params:** `?status=pending,preparing,ready,served`

**Response (200):**
```json
{
  "orders": [...],
  "counts": {
    "pending": 5,
    "preparing": 3,
    "ready": 1,
    "served": 10
  }
}
```

---

## Customers

### GET `/api/customers`
List customers.

**Headers:** `Authorization: Bearer <token>`

**Query params:** `?search=John&phone=9876543210`

---

### POST `/api/customers`
Create customer.

**Request:**
```json
{
  "name": "John Doe",
  "phone": "+919876543210",
  "email": "john@email.com"
}
```

---

### GET `/api/customers/:id/loyalty`
Get loyalty points.

**Response:**
```json
{
  "points": 150,
  "last_activity": "2025-03-30"
}
```

---

### POST `/api/customers/:id/loyalty/earn`
Earn loyalty points.

**Request:**
```json
{
  "points": 10,
  "description": "Order #123"
}
```

---

## Reports

### GET `/api/reports/sales`
Daily/monthly sales report.

**Headers:** `Authorization: Bearer <token>`

**Query params:** `?date=2025-03-31`

**Response:**
```json
{
  "date": "2025-03-31",
  "total_revenue": 15000,
  "order_count": 45,
  "avg_order_value": 333.33
}
```

---

### GET `/api/reports/x`
X report: a read-only look at the open trading period (permission `reports.view`). See `docs/TRADING_REPORTS.md`.

### POST `/api/reports/z`
Close the trading period and store an immutable, numbered Z report (permission `reports.z`). `409 cash_session_open` while a drawer is open; `409 nothing_to_report` when nothing happened since the last Z.

### GET `/api/reports/z` · `/api/reports/z/:id`
List Z reports / read one (with `verified`, the seal check). CSV: `GET /api/reports/x/csv`, `GET /api/reports/z/:id/csv`. Print: `POST /api/reports/x/print`, `POST /api/reports/z/:id/print` (`{ "reprint": true }`).

### GET `/api/reports/period?from=&to=&tz=&bucket=`
Report for any date range, net of refunds. `from` is exclusive and `to` inclusive, both UTC `YYYY-MM-DD HH:MM:SS`; `tz` is an IANA zone for the series (unknown zones fall back to UTC); `bucket` is `day` (default) or `hour`. Returns the same `snapshot` as the X report plus `products` (units, gross, VAT, net, refunded, cost, profit, margin), `categories`, `staff` (sales, discounts given, refunds processed, items removed), `discounts`, `refunds`, `voids`, `series` and `checks`. All money is integer minor units. Permission `reports.view`.

### GET `/api/reports/period/csv?section=&from=&to=`
The same data as CSV. `section` is one of `summary`, `vat`, `products`, `categories`, `staff`, `discounts`, `refunds`, `voids`. Cells that could be read as a spreadsheet formula are neutralised.

---

## Inventory, stocktakes and stock import

All quantities come from the inventory ledger (`inventory_movements`); nothing here edits a stock column directly.

### GET `/api/inventory/movements?limit=&product_id=&type=&from=&to=`
The ledger as a feed, newest first, with item, variant and person names (`inventory.view`).

### GET `/api/inventory/valuation` · `/api/inventory/valuation/csv`
Stock on hand at cost: ledger balance × cost, per tracked item or variant, with totals by category and the number of items in stock that have no cost (`inventory.view`).

### POST `/api/inventory/import`
`{ "csv": "sku,quantity\nABC,12", "mode": "set" | "add", "dry_run": true, "import_id": "...", "reason": "..." }` (`inventory.adjust`). Columns: `sku` and/or `barcode`, `quantity`, optional `reason`. `dry_run` is the default and posts nothing; it returns every row (`current`, `new_quantity`, `delta`, or the `error`). Applying needs a unique `import_id`; a file with ANY invalid row is refused whole (`422`, with the report). `set` states what is on the shelf (re-importing changes nothing); `add` states what arrived (exactly-once per `import_id` and row). Limit 100 KB / 10,000 rows.

### Stocktakes — `/api/stocktakes` (`inventory.stocktake`: owner, manager)
| Call | Purpose |
| --- | --- |
| `POST /` `{ name?, category_ids? }` | Start. A line for every tracked item/variant in scope; one open stocktake per location (`409` otherwise). |
| `GET /` · `GET /:id` | History; one stocktake with its lines and variance summary (units and value at cost). |
| `PUT /:id/lines` `{ product_id, variant_id?, quantity, mode: "set"\|"add" }` | Record a count. |
| `POST /:id/scan` `{ code, quantity? }` | Add to the line whose barcode or SKU matches (default +1; `404 unknown_code`). |
| `POST /:id/approve` `{ uncounted: "ignore"\|"zero", note? }` | Post one ledger adjustment per counted line, atomically. |
| `POST /:id/cancel` | Discard; posts nothing. |
A line's adjustment is `counted − balance when it was counted`, so sales made while counting are kept. A correction that would take stock below zero is clamped to zero and the line is flagged `clamped`. An approved or cancelled stocktake is final (`409`).

---

## Settings

### GET `/api/settings/business`
Get business settings.

**Response:**
```json
{
  "business_name": "My Restaurant",
  "timezone": "Asia/Kolkata",
  "currency": "INR",
  "tax_registration_number": "22AAAAA0000A1Z5"
}
```

---

### PUT `/api/settings/business`
Update business settings.

---

### GET `/api/settings/tax`
Get tax settings.

---

### GET `/api/settings/discount`
Get discount limits configuration.

**Headers:** `Authorization: Bearer <token>`

**Response (200):**
```json
{
  "discount_max_percentage": 50,
  "discount_max_amount": 100,
  "discount_mode": "both",
  "discount_requires_approval": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `discount_max_percentage` | number | Max % for percentage discounts (0 = no limit) |
| `discount_max_amount` | number | Max flat amount for discounts (0 = no limit) |
| `discount_mode` | string | `'percentage'`, `'flat'`, or `'both'` — which discount types are allowed |
| `discount_requires_approval` | boolean | Require manager PIN to apply discounts |

---

### PUT `/api/settings/discount`
Update discount limits (owner/manager only).

**Headers:** `Authorization: Bearer <token>`

**Request:**
```json
{
  "discount_max_percentage": 30,
  "discount_max_amount": 200,
  "discount_mode": "both",
  "discount_requires_approval": true
}
```

**Validation:**
- `discount_max_percentage`: float, range 0–100 (0 = no limit)
- `discount_max_amount`: float, range 0–999999 (0 = no limit)
- `discount_mode`: must be `'percentage'`, `'flat'`, or `'both'`
- `discount_requires_approval`: boolean

**Error (400):**
```json
{ "error": "discount_mode must be \"percentage\", \"flat\", or \"both\"" }
```

---

## Printers

Printer configuration is available to owners and managers. Receipt and KOT print endpoints also allow cashiers. See [Printer setup](printers.md) for the operational guide.

### GET `/api/printers`

List configured printers, with their resolved printer profile.

### GET `/api/printers/detect`

Detect available USB and network printers.

### GET `/api/printers/supported`

List FloCafe's known printer profiles.

### GET `/api/printers/:id`

Get one configured printer.

### POST `/api/printers`

Create a printer. `connection_type` must be `network`, `usb`, or `webusb`. Network printers require `ip_address`.

```json
{
  "name": "Kitchen Printer",
  "connection_type": "network",
  "ip_address": "192.168.1.100",
  "port": 9100,
  "paper_width": "80mm",
  "is_default": true
}
```

A WebUSB entry stores the paper-width preference; the browser selects the physical device.

### PUT `/api/printers/:id`

Update printer configuration. The request accepts the same fields as creation.

### DELETE `/api/printers/:id`

Delete a configured printer.

### POST `/api/printers/:id/set-default`

Make a printer the default for regular receipt printing.

### POST `/api/printers/:id/test`

Send a test page. For WebUSB, the response contains the ESC/POS bytes for the browser to send.

### POST `/api/printers/print-bill`

Print the bill identified by `billId` or the bill associated with `orderId`.

```json
{
  "billId": 123,
  "useUnicode": false,
  "isReprint": false
}
```

### POST `/api/printers/print-kot`

Print a kitchen order ticket for `orderId`. A caller may provide `stationName` and `items`; otherwise FloCafe routes items to configured kitchen stations. This endpoint returns `403` when KOT printing is disabled.

```json
{
  "orderId": 123,
  "useUnicode": false
}
```

---

### POST `/api/printers/print-bill`
Sends a bill's receipt to the default printer (this is the route that actually prints; `POST /api/bills/:id/print` only records a print-log entry). Body: `{ "billId": 12, "isReprint": false, "preview": false }`. `200 { success: true }` only when the printer transport accepted the job; `400` no default printer; `404` unknown bill; `502` print failed, with `detail` (the transport's reason, e.g. connection refused), `code`, `stage` and `correlation_id`.

## Held carts

Parked counter carts (not sales — no totals, stock or sync until resumed and rung up). Separate from the table-keyed `/api/held-orders`.

- `POST /api/held-orders/carts` `{ "id": "h_ab12", "label": "Sam", "cart": { "items": [{ "pid": "p1", "qty": 2 }], … } }` — park (or update) a cart; `201` created, `200` updated.
- `GET /api/held-orders/carts` — `{ carts: [{ id, label, cart, heldBy, heldAt }] }`.
- `POST /api/held-orders/carts/:id/resume` — returns the cart and removes it in one step (`404` if another till already took it).
- `DELETE /api/held-orders/carts/:id` — discard.

---

## Mobile Pairing

### GET `/api/mobile/pairing-code`
Get current pairing code.

**Response:**
```json
{
  "pairing_code": "123456",
  "rotated_at": "2025-03-31T10:00:00Z"
}
```

---

### POST `/api/mobile/rotate-code`
Generate new pairing code.

---

## KDS Info

### GET `/api/kds-info`
Get KDS access URLs and QR code.

**Response:**
```json
{
  "mdns_url": "http://flo.local:3001/kds",
  "ip_url": "http://192.168.1.50:3001/kds",
  "qr_url": "http://192.168.1.50:3001/kds",
  "qr_data_url": "data:image/png;base64,..."
}
```

---

## WebSocket Events Summary

| Event | Direction | Description |
|-------|-----------|-------------|
| `auth` | → Server | Authenticate with JWT token |
| `auth_success` | ← Server | Authentication successful |
| `auth_error` | ← Server | Authentication failed |
| `initial_data` | ← Server | Initial orders and counts |
| `new_order` | ← Server | New order created |
| `order_updated` | ← Server | Order status changed |
| `status_update` | → Server | Update item status |
| `orders` | ← Server | Full orders list (periodic) |

---

## Order Status Flow

```
pending → preparing → ready → served
```

Each item in an order has its own status, allowing:
- Multiple items in one order
- Different items at different stages
- KDS shows items filtered by status

---

## Role-Based Access

| Role | Access |
|------|--------|
| `owner` | Full access, user management, settings |
| `manager` | Most features, limited settings |
| `cashier` | POS, orders, bills |
| `waiter` | Orders, tables |
| `chef` | KDS only |

**Supervisor** is not a separate role: it is a `cashier` account with `is_supervisor = 1` (`supervisor: true` in the
sign-in response and the staff list; migration v103, additive). Every role-gated route still treats them as a cashier.
On top of a cashier they may approve refunds, voids, discounts and price changes, signed in themselves or by entering
their PIN on someone else's request, and nothing else (no reports, stock, staff, card settings or reconciliation).
Only an owner can set the flag (`POST /api/staff` / `PUT /api/staff/:id` with `"supervisor": true`); a supervisor
may hold a PIN, an ordinary cashier may not, and removing the flag or changing the role also removes the PIN.

---

## Category Filtering (KDS)

Users with `chef` role have `category_ids` array. When accessing KDS:
1. Server validates JWT token
2. Server checks role is `chef`, `manager`, or `owner`
3. Server filters order items to only show products in user's categories
4. One user can have multiple categories

Example: Chef1 (cat-1, cat-2) only sees Food and Beverages items.
