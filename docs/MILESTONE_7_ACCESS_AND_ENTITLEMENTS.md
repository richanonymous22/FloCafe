# Milestone 7 — Access Control + Feature Entitlements

Design record for the authorization and feature-access foundation a future
Plemmo Admin Panel will control: enforcement of Milestone 6's
`user_locations` scope, a role→permission model alongside the existing
role system, a Core-level `AuthorizationService`, and a feature entitlement
model (`Organization → FeatureEntitlement[] → Feature`) with presets and
custom configuration. Read alongside
[`PLEMMO_ARCHITECTURE.md`](./PLEMMO_ARCHITECTURE.md) (the living reference)
and [`MILESTONE_6_MULTI_LOCATION.md`](./MILESTONE_6_MULTI_LOCATION.md) (the
`user_locations` foundation this milestone enforces).

**Status: complete.** Everything described as built below is built and
tested. Everything marked deferred is not.

---

## 1. Authorization architecture (Part C)

`main/core/authorization.ts` — `AuthorizationService` — is plain
TypeScript with no Express dependency, so it is usable from routes, Core
services, and a future Admin API alike, not only as request middleware.

Two independent questions, kept separate rather than folded into one check:

1. **"Does this role have this permission at all?"** — `hasPermission(role, permission)`,
   a static `Role → Permission[]` table. Additive to `users.role` +
   `requireRole()`: every existing route keeps using `requireRole()`
   exactly as before. This is new infrastructure for callers that need a
   finer-grained answer than "is this role in this list" — most don't
   yet, and this milestone does not force it onto them.
2. **"Is this user allowed at this specific location?"** — `hasLocationAccess(user, locationId)`,
   backed by Milestone 6's `user_locations` table
   (`main/core/employee-access.ts`). Owners and managers bypass this —
   they operate across every location in their organization by design;
   cashiers/waiters/chefs need an explicit grant.

`can(user, permission, context)` combines both and returns a boolean;
`requireCan(...)` throws `AuthorizationError` (`statusCode = 403`) for
call sites — Core services or route handlers — that need to fail the
operation outright rather than branch on it.

```
AuthorizationService
  hasPermission(role, permission)        → static role→permission table
  hasLocationAccess(user, locationId)     → user_locations, owner/manager bypass
  can(user, permission, { locationId? })  → combines both, boolean
  requireCan(user, permission, context)   → throws AuthorizationError
```

---

## 2. Location enforcement (Part A)

Milestone 6 built `user_locations` as a structural foundation only — no
route enforced it. This milestone enforces it, deliberately **not** as one
giant global middleware (explicitly ruled out by this milestone's
instructions), but as a small, route-specific resolver function passed to
a generic wrapper:

```
main/middleware/location-access.ts
  requireLocationAccess(resolveLocationId: (req) => string | null | undefined)
```

If the resolver returns nothing, the route has no location to check
against and the middleware passes trivially. Where it returns a location
id, the middleware calls `hasLocationAccess({userId, role}, locationId)`
and responds 403 if it fails.

Applied only to routes that actually accept or reach a client-influenceable
location:

| Route | Resolver source |
|---|---|
| `POST /api/purchase-orders` | `req.body.location_id` (falls back to the device's own current location) |
| `POST /api/purchase-orders/:id/receive` | the stored `purchase_orders.location_id` for that order |
| `POST /api/transfers` | both `from_location_id` **and** `to_location_id` — two chained checks, since a transfer touches two locations |
| `POST /api/transfers/:id/complete` | both stored transfer locations, via a `loadTransferLocation(field)` helper (the field name comes from a hardcoded TypeScript union, never from request input) |
| `POST /api/inventory/adjust` | `req.body.location_id` (falls back to current location) |

**`SaleService.createSale()` and `PaymentService.tender()`/`refundPayment()`
needed no new enforcement code at all** — they never accept a
client-supplied `location_id` in the first place; the location is always
resolved server-side from device context (`main/core/context.ts`). They are
safe by construction, the same way Part N requires: sensitive context is
resolved from authenticated identity and trusted device context, never
trusted from the client.

---

## 3. Permission model (Part B)

`Role` and `Permission` are both closed string-literal unions in
`authorization.ts`, deliberately alongside the existing `users.role` CHECK
and `requireRole()` middleware, not a replacement:

```
Permission: sales.create | sales.refund
          | inventory.view | inventory.adjust | inventory.receive | inventory.transfer
          | purchasing.manage
          | reports.view
          | employees.manage
          | locations.manage

Role: owner | manager | cashier | waiter | chef
```

`ROLE_PERMISSIONS` mirrors the trust levels `requireRole()` already
encodes throughout the app: `owner` gets all ten permissions, `manager`
all except `locations.manage`, `cashier` gets `sales.create` +
`inventory.view`, `waiter` gets `sales.create` only, `chef` gets
`inventory.view` only. An unrecognized role has no permissions (returns
`false`/`[]`), not a crash — proven directly by test.

Every existing route's `requireRole()` calls are untouched. This model
exists as finer-grained infrastructure for the small number of call sites
this milestone actually wires it into (Part J's "meaningful boundaries,
not coverage for its own sake") and for a future Admin Panel/Core caller
that needs to ask "can this role do X" without duplicating a hardcoded
`requireRole('owner', 'manager')` list at every call site.

---

## 4. Feature model (Part D)

`Organization → FeatureEntitlement[] → Feature`, migration v79
(`plemmo_feature_entitlements`):

```
features               (key TEXT PK, label, category)
feature_presets         (id TEXT PK, name, description)
feature_preset_items     (preset_id, feature_key)               composite PK
organization_features    (organization_id, feature_key, enabled, source, updated_at)  composite PK
```

`organization_id` is deliberately not a hard foreign key, matching the
existing `purchase_orders.organization_id` precedent from Milestone 5.
`source` is `'preset' | 'custom'`, recording how an entitlement got its
current value without adding a second table.

Only 14 real feature keys are seeded — every feature that actually exists
in the codebase today, not the full aspirational list the milestone spec
gave as illustrative examples:

```
core.pos, core.customers, core.staff
hospitality.tables, hospitality.kds, hospitality.kot, hospitality.modifiers
retail.catalog, retail.variants, retail.barcode,
retail.inventory, retail.purchasing, retail.transfers
advanced.multi_location
```

`main/core/features.ts` — `FeatureService`:

```
listAllFeatures()                          → the full catalog
listOrganizationFeatures(organizationId)    → catalog LEFT JOIN entitlements, COALESCE(enabled, 0)
isEnabled(organizationId, featureKey)       → the enforcement entry point
requireEnabled(organizationId, featureKey)  → throws FeatureError (statusCode 403)
grantFeature / revokeFeature                → single-feature UPSERT, source='custom'
listPresets() / getPresetFeatures(id)
applyPreset(organizationId, presetId)       → replaces the ENTIRE entitlement set
setCustomFeatures(organizationId, keys[])   → replaces the ENTIRE entitlement set, source='custom'
```

A feature with no `organization_features` row is **not** entitled by
default (`COALESCE(enabled, 0)`) — but migration v79 itself grants every
existing organization every existing feature at migration time, so no
current install's behavior changes on upgrade. Only organizations created
after this milestone, or ones whose owner deliberately narrows their
entitlements, ever see a feature actually withheld.

---

## 5. Presets (Part E)

Two presets seeded by v79 — conveniences that write into
`organization_features`, not a permanent restriction an organization is
locked into:

| Preset | Features |
|---|---|
| `preset-hospitality` | `core.pos`, `core.customers`, `core.staff`, `hospitality.tables`, `hospitality.kds`, `hospitality.kot`, `hospitality.modifiers` |
| `preset-retail` | `core.pos`, `core.customers`, `core.staff`, `retail.catalog`, `retail.variants`, `retail.barcode`, `retail.inventory`, `retail.purchasing` |

`preset-retail` notably excludes `retail.transfers` and
`advanced.multi_location` — both are single-location-irrelevant by
default and available as an explicit upgrade, not bundled in.

`applyPreset(organizationId, presetId)` sets every catalog feature's
`enabled` to exactly whether it's in the named preset's item list —
proven by test both for what it turns on (`hospitality.tables`) and for
what it turns off (retail-only features not in the hospitality preset's
list).

---

## 6. Custom configuration (Part F)

"Custom" is not a special code path — `setCustomFeatures(organizationId, featureKeys)`
calls the exact same replace-the-entire-set mechanism `applyPreset()`
uses, just against a caller-supplied key list instead of a preset's item
list, and validates every key is a known feature first (rejecting an
unknown key rather than silently ignoring it). `source` is recorded as
`'custom'` so `listOrganizationFeatures()` can distinguish "this was set
by a preset" from "this was hand-picked" for a future Admin UI, without
adding new enforcement logic — `isEnabled()` doesn't care which source
produced the value.

---

## 7. Backend feature enforcement (Part G)

`main/middleware/feature-access.ts`:

```
requireFeature(featureKey) → 403 if !isEnabled(getCurrentOrganizationId(), featureKey)
```

`organizationId` is always resolved via `getCurrentOrganizationId()`
(`main/core/location.ts`) — never accepted from the client (Part N).
Wired into the small number of routes that gate a genuinely
vertical-specific capability:

| Route | Feature |
|---|---|
| `POST /api/retail/checkout` | `retail.catalog` |
| `POST /api/purchase-orders` | `retail.purchasing` |
| `POST /api/transfers` | `retail.transfers` |
| `POST /api/tables` (table creation) | `hospitality.tables` |

**`POST /api/inventory/adjust` deliberately has no feature gate.**
Inventory tracking is a Core, vertical-neutral capability — Milestone 4
already proved a hospitality menu item can track stock — so gating the
generic adjust route behind `retail.inventory` would wrongly block a
hospitality-only organization (without that feature enabled) from
adjusting a tracked menu item's stock. This was implemented, recognized
as wrong against Milestone 4's own precedent, and reverted before commit.

`main/routes/features.ts` is the HTTP surface (`GET /api/features`,
`POST /api/features/:key/grant`, `.../:key/revoke`, `.../apply-preset`,
`.../custom`), owner/manager gated via the existing `requireRole()`, and
`frontend/src/app/(dashboard)/admin-preview/features/page.tsx` is a
minimal, un-navigated dev-preview toggle screen (Part K) — reachable only
by direct URL, explicitly not the real Plemmo Admin Panel.

---

## 8. Security considerations (Part N)

- No route or Core function in this milestone accepts `organization_id`,
  `location_id`, a feature flag, or a role from client-controlled input
  and treats it as authoritative. Sensitive context is always resolved
  server-side: `organizationId` via `getCurrentOrganizationId()`, `role`
  via the authenticated JWT/session identity `requireRole()` already
  established, location via the device's own context or via a row already
  owned by the organization (e.g. a purchase order's stored
  `location_id`).
- Where a route *does* accept a `location_id` in the request body (e.g.
  creating a purchase order or transfer, where the location genuinely is
  part of what's being created), that value is checked against the
  authenticated user's grants via `requireLocationAccess`, never trusted
  outright.
- Frontend hiding (`admin-preview/features`, disabled buttons) is UX only.
  Every enforcement point this milestone adds is backend-side; the HTTP
  integration test suite proves a disabled feature or an unauthorized
  location produces a real 403 through Express, not merely a hidden UI
  element, by making genuine requests against a genuine app instance.
- `AuthorizationError`/`FeatureError` both carry `statusCode = 403` so
  route handlers can respond consistently without re-deriving the status
  code at each call site.

---

## 9. Database / migrations (Part L)

**v79 (`plemmo_feature_entitlements`)** — additive only: four new tables
(`features`, `feature_presets`, `feature_preset_items`,
`organization_features`), no column changes to any existing table. Seeds
the 14-feature catalog and the two presets described above, then grants
every existing organization every existing feature — the safe default
that keeps current installs' behavior unchanged on upgrade. No table
rebuild was needed; nothing widened a `CHECK` constraint this time.

Migration v78's own limitation (its `user_locations` backfill only covers
users that existed at migration time) is unchanged by this milestone — a
user created after v78 ran still needs an explicit `grantLocationAccess()`
call, exactly as Milestone 6 documented. This surfaced directly in this
milestone's own test suite (see §10).

Verified fresh (`tests/schema-health.test.ts`) and against the real
v1.5.0-era upgrade fixture (`tests/upgrade-path.test.ts`); both report
zero drift after v79.

---

## 10. Tests (Part M)

`tests/plemmo-access-control.test.ts` — 42 checks across two parts:

**Part 1, Core-level (synchronous, items 1–16):** `AuthorizationService`
and `FeatureService` exercised directly, no HTTP layer.

- **1–2, Location access.** A freshly created cashier has *no* access to
  the install's own seeded location until explicitly granted — this
  reproduces Milestone 6's documented `user_locations` backfill
  limitation directly (a user created after `initTestDb()` was never seen
  by the v78 backfill), and the test asserts the pre-grant state is
  denied before granting and re-asserting access, rather than assuming
  the backfill covers it.
- **3.** Owner/manager access any location without an explicit grant.
- **4.** A restricted role is rejected for an ungranted location, both via
  `hasLocationAccess()` and `requireCan()` (which throws
  `AuthorizationError`), then accepted after an explicit grant.
- **5.** A pre-existing user (one that predates the test's own inserts,
  i.e. covered by the real v78 backfill path) retains its original
  location access — the regression case for v78 itself.
- **6–8, Permissions.** Owner has `employees.manage`; cashier does not.
  Cashier has `sales.create`; waiter lacks `purchasing.manage`. Every
  defined role, including an unrecognized one, returns a defined
  (possibly empty) permission set rather than crashing.
- **9.** `requireCan()` rejects at the Core level, not merely in UI code.
- **10–11, Feature enabled/disabled.** `retail.catalog` starts enabled by
  the v79 migration default, is disabled after `revokeFeature()`, throws
  `FeatureError` via `requireEnabled()` while disabled, and is enabled
  again after `grantFeature()`.
- **12–13.** Revoking one feature does not affect another.
- **14.** The full catalog is returned with an explicit `enabled` boolean
  on every row.
- **15, Presets.** `preset-hospitality` exists, enables
  `hospitality.tables`, and disables retail-only features not in its
  list.
- **16, Custom.** A custom feature list enables exactly the given keys and
  disables everything else.

**Part 2, HTTP integration (async, items 17–18 plus regression smoke):**
a real `createApp()` instance, real JWTs, real `supertest`-style HTTP
requests through Express, not mocks.

- **17.** Supplier creation succeeds (201) with `retail.purchasing`
  enabled; the owner revokes it via `POST /api/features/retail.purchasing/revoke`;
  creating a purchase order is then rejected with a real HTTP 403.
- **18.** The owner re-grants the feature; the identical request now
  succeeds (201) — the same route, proving the gate is live, not a
  fixture artifact.
- **Location enforcement via HTTP.** A cashier with no grant for a second
  location is rejected when the request names it explicitly; a second
  check confirms the cashier's role itself also lacks the route's
  `requireRole('owner', 'manager')` gate — proving the two authorization
  layers (role-gate and location-gate) are genuinely independent, not one
  masking the other.
- **19–24, Regression smoke.** Retail checkout still succeeds with
  `retail.catalog` enabled; hospitality-style order creation is
  unaffected by any of the new middleware.

Wired into `package.json` as `test:plemmo-access-control`, appended to the
main `test` chain immediately after `test:plemmo-multi-location`.

---

## 11. Hospitality regression

`tests/plemmo-inventory.test.ts`, `tests/plemmo-sale-service.test.ts`,
`tests/plemmo-payment-service.test.ts`, `tests/staff-authz.test.ts`,
`tests/orders-authz.test.ts`, `tests/authz-matrix-phase3.test.ts`,
`tests/tables-string-ids.test.ts`, and `tests/held-orders.test.ts` all pass
unchanged. The new `hospitality.tables` feature gate on table creation and
the location-access check on inventory adjustment do not alter any
existing hospitality flow's behavior for an install with default
entitlements (every feature enabled, as v79 guarantees for existing
organizations).

---

## 12. Retail regression

`tests/plemmo-retail.test.ts`, `tests/plemmo-inventory.test.ts`,
`tests/plemmo-purchasing.test.ts`, and `tests/plemmo-multi-location.test.ts`
all pass unchanged. The new `retail.catalog`/`retail.purchasing`/
`retail.transfers` feature gates and the location-access checks on
purchase orders, receiving, and transfers do not alter behavior for the
default (all-features-enabled) organization these suites operate against.

---

## 13. Full suite

`npm test` — the complete chain, including the new
`test:plemmo-access-control` entry — passes with `EXIT_CODE=0` and zero
failures.

---

## 14. Build / lint

`npx tsc --noEmit -p .` and `npm run build` both report zero errors.
`npm run lint` reports zero errors (pre-existing `no-explicit-any`
warnings only, none newly introduced by this milestone's files); the
frontend `eslint` run is clean.

---

## 15. Known limitations

1. Only a small, deliberately chosen set of routes carry the new
   location/feature middleware — this milestone did not add feature
   checks "for coverage," so some routes that touch retail- or
   hospitality-specific data have no explicit feature gate yet (e.g.
   retail reporting, KDS routes). A future milestone can extend coverage
   as real product boundaries demand it.
2. `AuthorizationService`'s permission table (`ROLE_PERMISSIONS`) is not
   yet wired into any route as the primary gate — every existing route
   still uses `requireRole()` directly. `hasPermission()`/`can()` are
   available infrastructure, exercised by this milestone's own tests, but
   not yet the authorization mechanism any live route depends on.
3. Feature entitlements are per-organization only; there is no
   per-location or per-user feature override.
4. No Admin UI beyond the single un-navigated `/admin-preview/features`
   dev screen — no bulk organization management, no audit trail specific
   to entitlement changes beyond the general `audit_events` log.
5. Milestone 6's `user_locations` backfill limitation (only covers users
   existing at migration time) is unchanged; a newly created user still
   needs an explicit `grantLocationAccess()` call, which this milestone's
   own test suite had to account for directly.
6. `organization_features` has no foreign key on `organization_id`,
   matching the existing `purchase_orders` precedent — a genuinely
   orphaned entitlement row is possible in principle, though nothing in
   this milestone creates one.

---

## 16. Deferred work (Part O, unchanged)

Full Plemmo Admin Panel, cloud sync, remote licensing/license servers,
license pools/seats, real payment provider integrations, device
activation service, advanced RBAC management UI, advanced analytics on
top of the feature model, any new vertical beyond the entitlement model
itself.

---

## 17. Future licensing integration (Part I)

The entitlement model is deliberately shaped so a future licensing layer
can sit *behind* `organization_features` without changing its shape or any
existing caller: `FeatureService.isEnabled()` is already the single
authoritative enforcement entry point every route calls, so a future
license-check step (e.g. "does this organization's active license include
this feature") can be inserted inside `isEnabled()`/`requireEnabled()` — or
as an additional write path that populates `organization_features` from a
license response — without touching any of the ~6 route call sites that
already call it. No license server, remote verification, or license-pool
concept exists yet; this milestone only avoids building the entitlement
model in a way that would need to be reshaped later to accommodate one.

---

## 18. Composable context (Part J)

`context.ts` (device/location/register/organization), `authorization.ts`
(role permissions + location access), and `features.ts` (organization
entitlements) are kept as three separate, composable modules rather than
merged into one large "current session" object:

- They answer different questions with different lifetimes: `context.ts`
  answers "what device/location is this install," resolved once from
  settings pointers and cached; `authorization.ts` answers "can this
  specific authenticated user do this," resolved per-request from the JWT
  identity; `features.ts` answers "is this organization entitled to this
  capability," resolved per-organization and independent of which user is
  asking.
- A caller that only needs one answer imports one module — `SaleService`
  never needed to import `features.ts` at all, because it never gates
  behind a feature; `POST /api/tables` needed `features.ts` but not
  `authorization.ts`'s permission table, because `requireRole()` already
  covered its role check.
- Keeping them separate is also what let each of Part A (location) and
  Part G (feature) enforcement land as small, targeted middleware wrapping
  a resolver function, rather than a single global middleware that would
  have needed to know about every context type on every route to decide
  what to check — the explicit anti-pattern this milestone's own
  instructions ruled out.

---

## 19. See also

- [`PLEMMO_ARCHITECTURE.md`](./PLEMMO_ARCHITECTURE.md) §3 (Core module
  table, entity status), §12 (roadmap) — the living reference this record
  feeds into
- [`MILESTONE_6_MULTI_LOCATION.md`](./MILESTONE_6_MULTI_LOCATION.md) —
  the `user_locations`/`context.ts` foundation this milestone enforces
  and builds on
- `main/core/authorization.ts`, `main/core/features.ts` — the code
  itself, commented in the same voice as this document
- `main/middleware/location-access.ts`, `main/middleware/feature-access.ts` —
  the two small, resolver-driven middleware wrappers, deliberately not a
  single global middleware
- `tests/plemmo-access-control.test.ts`, `tests/upgrade-path.test.ts` —
  the verification this record's claims are checked against
