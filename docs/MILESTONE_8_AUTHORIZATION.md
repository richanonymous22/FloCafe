# Milestone 8 — Authorization Hardening

Design record for making `AuthorizationService` (Milestone 7) the canonical
backend authorization layer, without the two-systems drift the milestone's
own brief warned against: an audit of every `requireRole()`/ad-hoc role
check in the app, a canonical `requirePermission()` gate wrapping
`requireCan()` for the business-critical routes the audit identified,
location enforcement composed into that same gate, and real HTTP-level
tests proving permission, location, and feature checks compose correctly
and cannot be spoofed by the client. Read alongside
[`PLEMMO_ARCHITECTURE.md`](./PLEMMO_ARCHITECTURE.md) and
[`MILESTONE_7_ACCESS_AND_ENTITLEMENTS.md`](./MILESTONE_7_ACCESS_AND_ENTITLEMENTS.md)
(the `AuthorizationService`/`FeatureService` foundation this milestone
builds on).

**Status: complete.** Everything described as built below is built and
tested. Everything marked deferred is not.

---

## 1. Part A — audit

Before any code changed, every `requireRole()` call, every ad-hoc inline
role check, and every place a route reads `organization_id`/`location_id`/
`role` from client input was found and classified. 212 `requireRole()` call
sites across 28 route files, grouped by domain (matching the milestone's own
SALES/INVENTORY/PURCHASING/STAFF/LOCATIONS/REPORTS categories), plus the
handful of ad-hoc checks and client-input read sites found outside that
pattern.

**Category 1 — already safely protected.** The overwhelming majority of the
212 call sites: a route restricted to a fixed role list, where the app has
no dedicated finer-grained permission for that exact operation (menu/addon/
printer/tax-pack/settings CRUD, KDS pairing, database export/import,
customer management, held orders, bills). These are read or configuration
operations with no dedicated `Permission` entry in Milestone 7's model, and
migrating them would either invent permissions the milestone's own Part D
explicitly says not to ("do not invent dozens of permissions") or force an
imprecise mapping onto an existing one. Left on `requireRole()`, which
itself is now type-checked against `AuthorizationService`'s own `Role` union
(§2) so it cannot silently drift from what roles actually exist.

**Category 2 — needs migration.** The routes actually migrated in this
milestone (§3): sales creation and item-add, staff/employee management,
location management, reports, purchasing, inventory adjustment/receipt, and
stock transfers — every case where a `Permission` from Milestone 7's model
maps to the route with an *exact* role-set match (§3 explains why an exact
match was the bar, not "close enough").

**Category 3 — intentionally left alone.** Specific, deliberate exclusions
found during the audit, each with a concrete reason:

| Route | Reason |
|---|---|
| `POST /api/retail/checkout` | `requireRole('owner','manager','cashier')` excludes waiter; `sales.create` permission includes waiter (hospitality servers create dine-in sales). Swapping the gate would silently grant waiters retail checkout access they don't have today — see §3's "exact match" rule. Location check was still added (§4) without touching the role gate. |
| `PATCH /api/orders/:id/status` | A single endpoint serving multiple purposes — kitchen status transitions (`preparing`/`ready`/`served`, which `chef` legitimately needs) and cancellation/void (which a stricter permission would suit). No single permission fits every role this route must serve; wrapping the whole route in `sales.void` would lock chefs out of routine status updates. The route's own inline manager-PIN-override logic for the cancel path is untouched. |
| `PATCH /api/order-items/:id/status` | Bespoke KDS-station-scoped authorization (category/station assignment, live re-check of `tokens_valid_after` inside the transaction) with no `requireRole()` call at all — an inline role check plus a much richer authorization model than a single permission or role list can express. Migrating this to `requirePermission()` would lose the station-scoping nuance entirely. |
| `GET` list/detail routes across staff, purchase orders, transfers, suppliers | No dedicated `*.view` permission exists for these domains in Milestone 7's model (only `inventory.view` and `reports.view` do) beyond what's already migrated (§3). Inventing one for each domain would violate Part D's "do not invent dozens of permissions." Left on `requireRole()`. |
| `GET /api/inventory/low-stock` | Restricted to `owner`/`manager` only, while `inventory.view`'s permission holders also include `cashier` — an exact-match migration would broaden this route's access to cashiers, a real behavior change. Flagged, not migrated (see §7, Known limitations for the inconsistency this reveals in `/balance`/`/history` vs `/low-stock`). |

**Category 4 — security concerns found.** None that constituted an actual
authorization bypass. Two findings worth recording, neither fixed in this
milestone because both are pre-existing and out of the "hardening the
authorization layer" scope, not new risk this milestone introduces:

1. `main/core/employee-access.ts`'s `grantLocationAccess()` does not
   validate that `location_id` actually exists (no FK, no existence
   check). The only caller is now `requirePermission('locations.manage')`
   (owner-only), so this is not exploitable by a lower-privileged user —
   granting access to a bogus location id is harmless (nothing ever
   matches it) — but it is loose input handling worth tightening in a
   future pass. See §7.
2. `PATCH /api/order-items/:id/status` (Category 3 above) has no
   `requireRole()` at all — its own inline check is equivalent in effect,
   but its absence from the `requireRole()`-based inventory this audit
   otherwise relies on means a future blanket search for "does this route
   have `requireRole`" would miss it. Documented here so it isn't
   rediscovered as a false negative.

No route was found reading `organization_id`, `location_id`, or `role`
from client input and treating it as authoritative for an authorization
decision — see §6 for the specific places a client-supplied value exists
in a request body and how each is handled.

---

## 2. Part B — canonical authorization

`AuthorizationService` (`main/core/authorization.ts`) is now documented as
the canonical backend authorization layer (module header updated). Two
concrete, low-risk changes establish this without a blanket rewrite:

**`requireRole()` now delegates its type, not a rewritten runtime check.**
`main/middleware/security.ts`'s `requireRole(...roles: Role[])` imports
`Role` from `authorization.ts` instead of accepting bare `string[]`. Every
one of the 212 existing call sites now type-checks its role list against
`AuthorizationService`'s own canonical role union at compile time — a role
added to one and not the other becomes a compile error, not a silent
runtime gap. The runtime behavior (`roles.includes(user.role)`) is
byte-for-byte unchanged, so this establishes single-source-of-truth
without risking a single regression. `AuthorizationService` also now
exports `ALL_ROLES`, and the two other hardcoded role-list copies found in
the audit (`main/routes/staff.ts`'s `VALID_ROLES`,
`main/routes/support-ticket.ts`'s `supportRoles`) now source from it
instead of maintaining their own literal — real drift eliminated, not just
type-checked against.

**`requirePermission()` (`main/middleware/authorize.ts`) is the new
canonical gate**, wrapping `requireCan()` directly:

```
requirePermission(permission, { locationId? })
    ↓
requireCan({ userId, role }, permission, { locationId })
    ↓
hasPermission(role, permission)  →  hasLocationAccess(user, locationId)
```

One middleware call performs the "permission check → location access
check" sequence the milestone's own conceptual flow diagram describes,
instead of two independently-maintained middleware calls
(`requireRole` + `requireLocationAccess`) that could drift out of sync
with each other. `locationId` accepts a single resolver or an array (a
transfer touches two locations — see §4) — every resolved location must
pass. `requireRole()` is not removed and is not deprecated; it remains the
correct tool for Category 1/3 routes above.

---

## 3. Part C — business-critical routes migrated

Migrated only where a defined `Permission`'s exact role-set matched the
route's existing `requireRole()` list — the bar the audit applied
throughout, because a coincidental *subset* match (e.g. `inventory.adjust`
happening to also fit a route that's semantically a *view*, not an
*adjust*) would either broaden or narrow real access silently, which Part D
of this milestone's own brief explicitly warns against ("keep the current
role semantics compatible").

| Domain | Route | Permission | Notes |
|---|---|---|---|
| Sales | `POST /api/orders` | `sales.create` | Role set `{owner,manager,cashier,waiter}` — exact match. Location check added (device's own current location — see §4). |
| Sales | `POST /api/orders/:id/items` | `sales.create` | Same exact match; same location check. |
| Inventory | `GET /api/inventory/balance`, `/history` | `inventory.view` | Role set `{owner,manager,cashier}` — exact match. |
| Inventory | `POST /api/inventory/adjust` | `inventory.adjust` | Already had a separate `requireLocationAccess` from Milestone 7 — folded into one `requirePermission` call. |
| Purchasing | `POST /api/purchase-orders`, `/:id/items`, `PUT .../:itemId`, `DELETE .../:itemId`, `/:id/mark-ordered`, `/:id/cancel` | `purchasing.manage` | Role set `{owner,manager}` exact match throughout. |
| Purchasing | `POST /api/purchase-orders/:id/receive` | `inventory.receive` | More specific than `purchasing.manage` for a goods-receipt operation; same role set. |
| Purchasing/Reports | `GET /api/purchase-orders/reports/*` | `reports.view` | Read-only reporting; role set matches exactly. |
| Inventory | `POST /api/transfers`, `/:id/items`, `DELETE .../:itemId`, `/:id/complete`, `/:id/cancel` | `inventory.transfer` | Role set `{owner,manager}` exact match. |
| Staff | `POST /api/staff`, `PUT /:id`, `/:id/deactivate`, `/:id/reactivate` | `employees.manage` | Role set `{owner,manager}` exact match. Existing inline `canModifyTargetStaff()` fine-grained check (manager cannot touch owner/manager accounts) is untouched — the permission gate is coarse, the inline check remains the fine-grained one. |
| Staff/Locations | `POST /api/staff/:id/locations`, `DELETE /:id/locations/:locationId` | `locations.manage` | Previously `requireRole('owner')` — stricter than `employees.manage`; `locations.manage`'s holder set is owner-only, an exact match. |
| Locations | `POST /api/locations`, `PUT /:id` | `locations.manage` | Role set `{owner}` exact match. |
| Locations/Reports | `GET /api/locations/reports/*` | `reports.view` | Role set `{owner,manager}` exact match. |
| Reports | Every `GET /api/reports/*` route | `reports.view` | All eight routes, role set `{owner,manager}` exact match throughout — the cleanest fit in the whole migration, since `reports.view` is a dedicated read permission. |

42 route handlers now use `requirePermission()`. The remaining ~166
`requireRole()` call sites are Category 1/3 from §1 — intentionally
unchanged.

---

## 4. Part E — location access

Every migrated route that is genuinely location-sensitive now enforces
location access as part of the same `requirePermission()` call:

- **Client-supplied location** (purchase order/transfer creation, transfer
  completion, inventory adjustment): the resolver reads the location from
  the request body or an existing row (a purchase order's/transfer's
  stored location), exactly as Milestone 7 built it — `requirePermission`
  just folds what used to be two chained middleware calls into one.
- **Server-resolved device location** (`sales.create` on order creation
  and item-add): `SaleService` never accepts a client-supplied location at
  all, so the check added in this milestone verifies the *authenticated
  user* has access to the *device's own* current location
  (`getCurrentLocationId()`) — closing the gap where a cashier authorized
  only for Location A could otherwise log into a Location B till and
  create sales there. This is new in Milestone 8; Milestone 7 didn't need
  it because `SaleService`/`PaymentService` were "safe by construction"
  against client spoofing, but had no check against the *authenticated
  user's own* location grants.
- **Multi-location operations** (a transfer's `from`/`to`, a transfer's
  completion against both stored locations): `requirePermission`'s
  `locationId` option accepts an array of resolvers — every one must pass.

`tests/plemmo-authorization-hardening.test.ts` items 1, 3, and 7 prove this
against real HTTP requests, including the device-context-switch technique
(`tests/plemmo-multi-location.test.ts`'s established pattern) needed to
exercise a location check that has no client-controllable location value
to spoof.

---

## 5. Part D — permissions

One addition to Milestone 7's `Permission` union: **`sales.void`**
(`owner`, `manager` — the same holders as `sales.refund`). No route
currently gates on it: as §1's Category 3 entry for
`PATCH /api/orders/:id/status` explains, the only place an order is
actually cancelled is a multi-purpose status endpoint that chefs also use
for routine kitchen transitions, so wrapping the whole route in
`sales.void` would incorrectly lock chefs out. `sales.void` (and
`sales.refund`, which also has no HTTP call site yet — `refundPayment()`
in `main/core/payment.ts` remains Core-only, per Milestone 2's dual-write
architecture) exist as forward-looking, correctly-modeled infrastructure
for the future dedicated void/refund endpoints Milestone 2's own roadmap
already anticipates. No other new permissions were added — Part D's "do
not invent dozens of permissions" instruction was followed literally: one
addition, already implied by the existing `sales.refund` precedent.

---

## 6. Part F — feature entitlements

Unchanged from Milestone 7's model and gate points
(`retail.catalog`/`retail.purchasing`/`retail.transfers`/
`hospitality.tables`) — this milestone did not add new feature gates,
since Part F's brief only asked to "verify the merchant entitlement" where
a route already represents a feature-gated subsystem boundary, and
Milestone 7 already covered every such boundary that exists in the app
today. `tests/plemmo-authorization-hardening.test.ts` items 4-5 re-prove
this at the HTTP layer alongside the new permission/location checks, to
show the three checks compose correctly on the same request
(`POST /api/tables` runs `requireRole` → `requireFeature` in sequence,
unchanged from Milestone 7).

---

## 7. Part H — security review

Explicitly inspected, per the milestone's own instruction, every place a
route reads `organization_id`, `location_id`, `role`, or a feature flag
from client input:

| Source | Where found | Handling |
|---|---|---|
| `req.body.organization_id` | Nowhere. No route in the app reads this field from the client at all. | N/A — `getCurrentOrganizationId()` (`main/core/location.ts`) is the only source, resolved server-side from the device's own settings pointer. `tests/plemmo-authorization-hardening.test.ts` item 6 sends a spoofed `organization_id` to `POST /api/features/:key/grant` and proves it has zero effect — the grant lands on the real organization regardless. |
| `req.body.location_id` | `POST /api/purchase-orders`, `POST /api/inventory/adjust`, `POST /api/transfers` (`from_location_id`/`to_location_id`) | Read, but never trusted at face value — passed straight into `requirePermission`'s location resolver, which checks it against the authenticated user's real `user_locations` grants (or the owner/manager bypass). A value naming a location the user isn't authorized for is rejected regardless of what the client claims. |
| `req.body.role` | `POST /api/staff`, `PUT /api/staff/:id` | Legitimate — this is an owner/manager *setting another user's role*, not a client asserting its own. Existing checks (`VALID_ROLES.includes(role)`, `canModifyTargetStaff()`, the manager-cannot-create-owner/manager-accounts check) are all still in place and untouched by this milestone. |
| Feature flags in body | `POST /api/features/apply-preset`, `POST /api/features/custom` | The *feature keys/preset id* are legitimately client-supplied (that's the whole point of the endpoint — an owner picking what to enable) — but `organization_id` is never read from the body even here; every one of these routes resolves it via `getCurrentOrganizationId()`, same as everywhere else. |
| Hidden frontend controls | `/admin-preview/features` (Milestone 7) | Confirmed UX-only — every enforcement point is backend-side; disabling a button client-side does not and cannot substitute for the `requireFeature()`/`requirePermission()` checks proven in tests. |

No route was found trusting a client-supplied value for an authorization
decision. Every sensitive route derives its context server-side: role from
the authenticated JWT (`requireAuth`, `main/server.ts`), organization from
`getCurrentOrganizationId()`, and location either from the device's own
context or from a value the server independently verifies against the
authenticated user's real grants.

---

## 8. Part G — tests

`tests/plemmo-authorization-hardening.test.ts` — 17 checks, real HTTP
requests through a real Express app (no mocked `AuthorizationService`/
`FeatureService`):

1. Allowed role + allowed location = success (`POST /api/orders`, cashier
   with a granted location).
2. Wrong role = 403 (`POST /api/staff`, waiter lacking `employees.manage`).
3. Wrong location = 403 — using the device-context-switch technique
   (`tests/plemmo-multi-location.test.ts`'s established pattern) since
   `sales.create`'s location check targets the device's own current
   location, which no request body can name directly.
4. Feature disabled = 403 (`POST /api/tables` after revoking
   `hospitality.tables`).
5. Feature enabled = success (same route, after re-granting).
6. Client attempts to spoof organization = denied — a bogus
   `organization_id` in the body of a feature-grant request has no effect;
   the grant lands on the real, server-resolved organization.
7. Client attempts to spoof location = denied — naming an already-granted
   location in the body of an order-creation request does not bypass the
   server-resolved device-location check; granting the *actual* device
   location makes the identical request succeed, proving the earlier 403
   was a real check.
8. Owner/manager compatibility remains correct — a manager can still
   create a supplier and view reports without any location grant, is still
   correctly rejected from `locations.manage` (owner-only, unchanged), and
   an owner can create a location.
9. Existing hospitality operations still work — order creation via the
   canonical gate.
10. Existing retail operations still work — checkout, deliberately still
    on `requireRole()` (§1, Category 3), confirming that route needed no
    changes.

Wired into `package.json` as `test:plemmo-authorization-hardening`,
appended to the main `test` chain after `test:plemmo-access-control`.

---

## 9. Hospitality regression

`tests/plemmo-inventory.test.ts`, `tests/plemmo-sale-service.test.ts`,
`tests/plemmo-payment-service.test.ts`, `tests/staff-authz.test.ts`,
`tests/orders-authz.test.ts`, `tests/authz-matrix-phase3.test.ts`,
`tests/tables-string-ids.test.ts`, `tests/held-orders.test.ts`,
`tests/reports-insights.test.ts`, and `tests/plemmo-access-control.test.ts`
(Milestone 7's own suite) all pass unchanged — the exact-match discipline
in §3 was chosen specifically so no existing role's access to any of these
flows would change.

---

## 10. Retail regression

`tests/plemmo-retail.test.ts`, `tests/plemmo-inventory.test.ts`,
`tests/plemmo-purchasing.test.ts`, and `tests/plemmo-multi-location.test.ts`
all pass unchanged.

---

## 11. Full suite

`npm test` — the complete chain, including the new
`test:plemmo-authorization-hardening` entry — passes with `EXIT_CODE=0`
and zero failures, captured directly (not through a `tail` pipe).

---

## 12. Build / lint

`npx tsc --noEmit -p .` and `npm run build` both report zero errors.
`npm run lint` reports zero errors (901 pre-existing `no-explicit-any`
warnings, one more than Milestone 7's count — from `main/middleware/
authorize.ts`'s own `catch (error)` re-throw, matching the same pattern
every other middleware file in the repo already uses). The frontend
`eslint` run is clean.

---

## 13. Remaining authorization gaps (Part K)

1. **`requireRole()` is still the primary gate on ~166 routes.** This is
   by design (§1, Category 1/3) — not a rewrite backlog, but a deliberate
   boundary. A future milestone could add dedicated `*.view` permissions
   for staff/purchasing/transfers/suppliers if a real product reason
   emerges (an Admin Panel needing finer-grained read scopes, for
   example), but none exists yet.
2. **`sales.refund`/`sales.void` have no HTTP call site.** `refundPayment()`
   and `voidPayment()` (`main/core/payment.ts`, Milestone 2) remain
   Core-only; the legacy `bills.ts` payment path still handles real
   merchant refunds/voids outside the new `PaymentService`/
   `AuthorizationService` stack entirely. Wiring a dedicated refund/void
   route to `PaymentService` is Milestone 2's own long-deferred item, not
   new to this milestone.
3. **`retail.ts`'s checkout route's role gate is not canonical** — it
   still uses `requireRole('owner','manager','cashier')` because
   `sales.create`'s permission holder set (which includes `waiter`) does
   not exactly match. Resolving this cleanly needs either a second,
   narrower permission (e.g. `sales.create.retail`) or a decision that
   waiters should in fact never reach the retail surface at the route
   level regardless of what `sales.create` implies elsewhere — a product
   decision, not an authorization-wiring one, left for a future milestone.
4. **`grantLocationAccess()` does not validate the location exists** (§1,
   Category 4) — harmless today (owner-only caller, a bogus grant matches
   nothing), but worth a light validation pass later.
5. **`PATCH /api/order-items/:id/status`'s bespoke KDS-station
   authorization has no `requireRole()` call at all** — correctly gated
   via its own inline logic, but outside the pattern this audit otherwise
   relies on; documented so it isn't mistaken for an unprotected route.
6. **`inventory.view`'s `/low-stock` inconsistency** (§1) — `/balance` and
   `/history` allow `cashier`, `/low-stock` does not, and no clean
   permission migration resolves this without changing one route's real
   access. Left as-is; flagged for a product decision.

---

## 14. Deferred work (Part I, unchanged)

Cloud, offline sync, licensing, Plemmo Admin, device activation, real
payment providers, advanced RBAC UI, location-switching POS UI.

---

## 15. See also

- [`PLEMMO_ARCHITECTURE.md`](./PLEMMO_ARCHITECTURE.md) §3 (Core module
  table), §12 (roadmap) — the living reference this record feeds into
- [`MILESTONE_7_ACCESS_AND_ENTITLEMENTS.md`](./MILESTONE_7_ACCESS_AND_ENTITLEMENTS.md) —
  the `AuthorizationService`/`FeatureService`/location-enforcement
  foundation this milestone canonicalizes
- `main/core/authorization.ts`, `main/middleware/authorize.ts` — the code
  itself, commented in the same voice as this document
- `tests/plemmo-authorization-hardening.test.ts` — the verification this
  record's claims are checked against
