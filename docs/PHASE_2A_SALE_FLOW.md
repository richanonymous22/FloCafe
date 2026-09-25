# Phase 2A — Sale flow audit

A trace of how a sale actually moves through the system **as inherited**, done
before any code was changed. This is the reference the `SaleService` extraction
is measured against: anything the service does must reproduce what is written
here.

Line references are against `d8eec56` (end of Phase 1).

---

## 1. The entity chain

```
ORDER  (orders)              open, mutable. Nullable table_id / guest_count /
   │                         packaging_charge / delivery_charge / cooking times.
   │                         Integer AUTOINCREMENT pk + (Phase 1) ULID `uid`.
   │  1
   │  ▼  n
ORDER_ITEMS (order_items)    denormalised product_name/product_sku, per-line
   │                         tax snapshot, addons in order_item_addons.
   ▼
BILL   (bills)               payable snapshot. 1:1 normally; 1:many when split
   │                         (split_group_id). Re-syncs from the order while unpaid.
   ▼
PAYMENT                      NOT a table — a JSON array in bills.payment_details.
```

There is no `sale` table. **"Sale" in Plemmo terms is the `orders` row plus its
items**; `bills` is the payable document produced from it.

---

## 2. Where sales are created, modified and finalized

| Operation | Route / entry point | File | Txn? |
|---|---|---|---|
| **Create sale** | `POST /api/orders` | `routes/orders.ts:306` | ✅ `withTxn` |
| **Add items to sale** | `POST /api/orders/:id/items` | `routes/orders.ts:554` | ✅ `withTxn` |
| Change item status | `PATCH /api/order-items/:id/status` | `routes/order-items.ts` | ❌ single UPDATE |
| Cancel item | `POST /api/orders/:id/items/:itemId/cancel` | `routes/index.ts:320` | ✅ `withTxn` ("BUG #17 FIX") |
| Restore item | `POST /api/orders/:id/items/:itemId/restore` | `routes/index.ts:515` | ✅ `withTxn` |
| Order status transitions | `PATCH /api/orders/:id/status` | `routes/orders.ts:806` | partial |
| Cancel order | via status → `cancelled` | `routes/orders.ts:806` | partial |
| Convert dine-in → takeaway | `PATCH /api/orders/:id/convert-to-takeaway` | `routes/orders.ts:976` | ✅ |
| Reassign customer | `PATCH /api/orders/:id/customer` | `routes/orders.ts:932` | ✅ |
| Order discount | `PATCH /api/orders/:id/discount` | `routes/orders.ts:1019` | ✅ |
| Line discount | `PATCH /api/orders/:id/items/:itemId/discount` | `routes/orders.ts:1220` | ✅ |
| **Generate bill** | `POST /api/bills/generate` | `routes/bills.ts:155` | ✅ `withTxn` |
| **Split check** | `POST /api/bills/:id/split-check` | `routes/bills.ts:263` | ✅ `withTxn` |
| **Take payment** | `POST /api/bills/:id/payment(s)` | `routes/bills.ts:712 / 741` | ✅ `withTxn(applyPaymentBatch)` |
| Bill discount | `POST /api/bills/:id/applyDiscount` | `routes/bills.ts:771` | ✅ |
| Print receipt | `POST /api/bills/:id/print` | `routes/bills.ts:975` → `services/receipt.ts:12` | ❌ |
| Hold / resume | `POST` / `DELETE /api/held-orders` | `routes/held-orders.ts:132 / 170` | ✅ |
| **Refund** | — | — | **does not exist** |
| Table assignment | `routes/tables.ts` | | ✅ |
| KDS item status | `routes/kds.ts`, `kds-server.ts`, `services/kds.ts` | | ❌ single UPDATE |

### Held orders are not orders

`held_orders` is a **separate table storing a JSON blob of cart items keyed by
table**, not an order in a held state. "Hold" parks a cart before an order
exists; "resume" reads the blob back into the UI. No `orders` row is involved.
This matters for the eventual `holdSale`/`resumeSale` contract — it is a
different concept from what those names usually mean.

---

## 3. `POST /api/orders` — the primary creation path, traced

The path chosen for migration. Full call graph:

```
POST /api/orders                                      routes/orders.ts:306
│
├─ OUTSIDE the transaction ─────────────────────────────────────────────
│   orderIdempotencyKey(req)                          :20   header parse/validate
│   requestHash = sha256(JSON.stringify(body))        :312
│   authenticatedUserId = req.user.userId             :318  (never client-supplied)
│   guard: items non-empty                            :321
│   guard: type ∈ {dine_in,takeaway,delivery,online}  :327
│   guard: guest_count 1..99 integer                  :331
│   guard: packaging/delivery charges finite, >= 0    :336
│   validateOrderNotes(db, special_instructions)      routes/orders-validation.ts
│   validateItemNotes(db, item.special_instructions)  (per item)
│   validateItemAddonGroupLimits(db, item.addons)     :64
│
└─ withTxn(() => { ────────────────────────────────── main/db.ts:558
    │
    ├─ order_idempotency replay lookup (user-scoped, 'legacy' fallback)
    │     mismatched request_hash → 409
    │     hit → return stored response, idempotentReplay: true
    │
    ├─ generateOrderNumber()                          db.ts (sequences table)
    ├─ SELECT key,value FROM settings → tenantInfo
    │     { country ?? 'IN', business_type ?? 'restaurant', state_code, taxes_enabled }
    ├─ getConfiguredChargeTaxCategories(country)      services/tax.ts
    ├─ INSERT INTO orders (header, status='pending')  → orderId = lastInsertRowid
    ├─ SELECT customers WHERE id = customer_id        (nullable)
    │
    ├─ FOR EACH item ────────────────────────────────────────────────
    │    SELECT products WHERE id                     → throw if missing
    │    guard: track_inventory && stock_quantity < qty → throw "Insufficient stock"
    │    unitPrice = parseFloat(product.price)        ← price from DB, never client
    │    itemDiscount = 0                             ← client discount IGNORED (vuln-0002)
    │    guard: quantity positive finite; unitPrice non-negative finite
    │    guard: addon.quantity positive integer
    │    itemSubtotal = unitPrice*qty + Σ(addon.price * addonQty * qty)
    │    calculateItemTax(tenantInfo, product, itemSubtotal, customer)   services/tax.ts
    │    INSERT INTO order_items (+ tax snapshot, tax_type, variant/modifier JSON)
    │    insertOrderItemAddons(db, itemId, addons, ts)                   db.ts
    │    if (track_inventory) UPDATE products SET stock_quantity -= qty  ← inventory
    │
    ├─ calculateConfiguredChargeTaxes(tenantInfo, chargeContext, customer)
    ├─ combineItemAndChargeTaxes({...})               → taxRollup
    ├─ total = Number((subtotal + exclusiveTax + delivery + packaging).toFixed(2))
    │  roundOff = 0                                   ← always 0 on create
    ├─ UPDATE orders SET subtotal, tax_amount, tax_breakdown, tax_snapshot,
    │                    total, round_off, updated_at
    ├─ if (table_id && type === 'dine_in')
    │      UPDATE tables SET status='occupied'        ← THE ONLY hospitality branch
    ├─ SELECT order + items (response shape, parseRowJson / attachEffectiveAddons)
    └─ INSERT INTO order_idempotency
   })
│
└─ AFTER the transaction (side effects, only when !idempotentReplay) ────
    notifyKdsUpdate()                                 services/kds.ts:642  WebSocket
    cloudSync.recordOrderChanged(id, 'order.created') services/cloud-sync.ts (inert)
    syncCustomerTagCounts(db, customer_id, items)     :46  ← DB WRITE, try/catch swallowed
```

### Side-effect classification

| Effect | Inside txn? | Class |
|---|---|---|
| `orders` / `order_items` / `order_item_addons` writes | ✅ | Domain |
| `products.stock_quantity` decrement | ✅ | Domain (inventory) |
| `tables.status = 'occupied'` | ✅ | Domain (hospitality) |
| `order_idempotency` write | ✅ | Domain |
| `notifyKdsUpdate()` | ❌ after | Infrastructure (WebSocket) |
| `cloudSync.recordOrderChanged()` | ❌ after | Infrastructure (outbox) |
| `syncCustomerTagCounts()` | ❌ after | **Domain write outside the txn** — see §7 |

The clean separation of DB-inside / notifications-outside is correct and must be
preserved: emitting a KDS notification inside the transaction would announce an
order that could still roll back.

---

## 4. Transaction boundaries

`withTxn` (`main/db.ts:558`) is `db.transaction(fn)()` from better-sqlite3 —
**synchronous**, so nothing can interleave inside it. This is precisely why the
money paths are trustworthy, and it is why the service must stay synchronous.

Current atomicity, per operation:

| Operation | Atomic across |
|---|---|
| Create order | header + items + addons + stock + table status + idempotency |
| Add items | items + addons + stock + order totals + bill totals |
| Cancel/restore item | item status + order totals + bill totals + stock restore |
| Generate bill | bill insert **or** totals re-sync |
| Split check | all sibling bills |
| Payment | idempotency + transaction refs + loyalty ledger + bill + order completion + table release |

**Already atomic today** for a completed sale: order → items → inventory →
payment each sit in their own transaction, but they are *separate*
transactions across separate HTTP requests. A sale is not created and paid in
one atomic step, and it never has been — the POS creates an order, then bills
it, then takes payment, as three calls. Phase 2A does not change that.

---

## 5. Duplication found

`POST /api/orders` (:425–492) and `POST /api/orders/:id/items` (:644–700)
contain a **near-verbatim copy** of the per-item loop: product lookup, stock
guard, price/quantity validation, addon subtotal, `calculateItemTax`, insert,
addon insert, stock decrement. They differ only in surrounding total
recalculation (create sets totals; add-items recalculates and also re-syncs an
existing unpaid bill).

This is the single strongest argument for the seam: the same rules are
maintained in two places today, and a retail "add item" would have made three.

Discount logic exists at three levels (order `:1019`, line `:1220`, bill
`bills.ts:771`) with separate implementations — noted, out of scope for 2A.

---

## 6. Test coverage of the migrated path

20 suites exercise order creation, giving a strong regression net:

`integration-happy-path`, `integration-order-lifecycle`, `integration-tax`,
`integration-inclusive-tax`, `integration-payments`,
`integration-bill-reconciliation`, `integration-discount-edge`,
`integration-discount-settings`, `integration-loyalty*` (3),
`issue-214-payment-integrity`, `issue-24-cancel-item-checkout`,
`issue-122-addon-quantities`, `issue-125-addon-read-paths`,
`order-item-addons`, `orders-authz`, `authz-matrix-phase3`,
`discount-system`, `cancel-override`, plus `smoke-test`, `tables-string-ids`,
`kds-integration`.

---

## 7. Behaviours found that look wrong — documented, NOT changed

Per the Phase 2A rule, these are recorded rather than silently fixed.

| # | Behaviour | Where | Why it looks wrong |
|---|---|---|---|
| B1 | `syncCustomerTagCounts()` runs **outside** the transaction with its errors swallowed | `orders.ts:46`, called `:541` | It writes `customers.tag_counts`. If it throws, the order commits with stale tag counts and nothing surfaces it. Should be inside the txn or made idempotent+retryable. |
| B2 | Stock is decremented at **order creation**, not at payment | `orders.ts:492` | An abandoned/cancelled order holds stock until explicitly cancelled. Defensible for hospitality (the food is committed when ordered); wrong for retail, where stock should move when the sale completes. Must be revisited with the inventory ledger. |
| B3 | Stock check and decrement are **not** a single atomic read-modify-write | `orders.ts:431` + `:492` | Within one transaction it is safe, but the guard reads a value it then blindly decrements. A `WHERE stock_quantity >= ?` guard on the UPDATE (as `products.ts:773` already does) would be stronger. |
| B4 | `total` is computed with `Number(x.toFixed(2))` | `orders.ts:507` | Float rounding to 2dp regardless of currency exponent — wrong for JPY/KWD, and the pattern `main/core/money.ts` exists to replace. |
| B5 | `roundOff` is hardcoded `0` on create but `applyPayableRounding()` is used at bill generation | `orders.ts:508` vs `bills.ts:184` | Order total and bill total can legitimately differ by the rounding adjustment. Intended, but easy to misread as a bug. |
| B6 | `tenantInfo.country` defaults to `'IN'` and `business_type` to `'restaurant'` | `orders.ts:481` | India-shaped defaults in a UK product. Harmless once settings are populated; wrong if they are not. |
| B7 | Order-level `special_instructions` validated but item `discount_amount` silently ignored | `orders.ts:439` | Deliberate (vuln-0002) and correctly commented, but a client sending a discount gets no error — it is silently dropped. |
| B8 | "Product not found", "Insufficient stock" and invalid quantity/price answer **HTTP 500 "Internal server error"**, with the real message hidden | `orders.ts` catch block | These throws carry no `statusCode`, and the handler maps a missing status to 500 with a generic body. They are client-correctable conditions and should be 400/409 with the message. `SaleService` reproduces this exactly (a `SaleError` with no `statusCode`) so the refactor changes nothing; fixing it is a deliberate follow-up because it changes a public API response. |

None of these are changed in Phase 2A.

---

## 8. What the seam must preserve

For `POST /api/orders` the extraction is behaviour-preserving only if all of
these still hold:

1. Prices come from the `products` table, never the request.
2. Client-supplied item discounts stay ignored.
3. `user_id` is the authenticated caller, never client-supplied.
4. Stock guard throws before any write for that item.
5. Tax is computed per line through `calculateItemTax` with the same
   `tenantInfo` shape, and charge taxes combined identically.
6. Totals arithmetic is byte-identical (including `toFixed(2)` and `roundOff = 0`).
7. Table is marked occupied only for `dine_in` **with** a `table_id`.
8. Idempotency replay returns the stored response with HTTP 200, a fresh create
   returns 201, and a hash mismatch is 409.
9. All DB writes stay in one transaction; KDS/cloud/tag-sync stay outside it.
10. The response shape is `{ order: { ...order, items: [...] } }` with addons
    attached via `attachEffectiveAddons`.


---

## 9. What Phase 2A actually changed

`createSale` in `main/core/sale.ts` is a line-by-line extraction of the handler
traced in § 3. The route (`main/routes/orders.ts`) now validates transport
concerns, calls the service, and performs the post-commit side effects.

**Three intentional additions**, none of which alter the sale outcome:

1. The sale header and each line receive a ULID `uid` (the Phase 1 foundation
   was in place but nothing populated it on insert).
2. A `sale.created` audit event is written **inside** the same transaction, so
   it cannot survive a rollback or be missing from a committed sale. It is not
   written on an idempotent replay.
3. `validateItemAddonGroupLimits` moved into the domain as
   `validateLineAddonGroupLimits` (copied verbatim, diff-verified) and
   `routes/orders-validation.ts` moved to `core/notes-validation.ts`, because
   Core must not import from `routes/`.

**One intentional behavioural deviation**, recorded rather than hidden:

| Before | After |
|---|---|
| `items` supplied as a non-array with a truthy `.length` (e.g. the string `"ab"`) passed the guard, then iterated character-by-character and failed with a 500 | Rejected up front with **400 "At least one item is required"** |

The service validates `Array.isArray` because it is a typed, reusable entry
point that a retail POS and a future API will also call. No test covered the
old behaviour, and 400 is the correct answer for malformed input.

**Everything else is byte-identical**, including the `toFixed(2)` total, the
hardcoded `roundOff = 0`, the ignored client discount, the India-shaped tenant
defaults, and the 500-for-unknown-product mapping in B8.

### Not migrated in this phase

`POST /api/orders/:id/items` still contains its own copy of the per-item loop
(§ 5). It was left alone deliberately: one path at a time, verified against a
green suite. It is the obvious first candidate for Phase 2B, at which point the
duplicated loop disappears.
