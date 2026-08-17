# SYNC-G — Admin Sales Console + Cross-Device Balance Reconciliation

Turns the SYNC-F backend foundation into an operational control layer: purpose-
built read models + APIs and a minimal, genuinely usable Admin interface for an
authorized operator (owner/manager) to inspect sales, work a conflict queue,
review cross-device inventory discrepancies, and see sync/device health — with
**no new dangerous financial automation**. No product/customer/supplier/PO/
transfer sync; no licensing/billing/payment-provider work; no EPOS redesign.

Read alongside [`SYNC_F_CONFLICT_RECONCILIATION.md`](./SYNC_F_CONFLICT_RECONCILIATION.md),
[`SYNC_E_SALES_ARCHITECTURE.md`](./SYNC_E_SALES_ARCHITECTURE.md),
[`SYNC_D_MULTI_ENTITY.md`](./SYNC_D_MULTI_ENTITY.md) and `cloud/DEPLOYMENT.md`.

**Status: complete.** Proven against real PostgreSQL + real HTTP
(`tests/sync-g-admin-reconciliation.test.ts`).

---

## SYNC-F Audit

Before any SYNC-G code, SYNC-D/E/F, the conflict model, resolution engine,
reconciliation service, cloud conflict protocol, authorization, audit, the
SYNC-D deficit system, the remote mirrors, and the existing admin/management
routes + frontend nav were re-read. Each SYNC-F capability was classified for
operator readiness:

| SYNC-F capability | Classification | Gap SYNC-G closes |
|---|---|---|
| `resolveConflict` / `acknowledgeConflict` engine | **operationally ready** | exposed unchanged behind admin APIs + UI; nothing about the engine relaxed |
| legality matrix + financial safety | **operationally ready** | UI only ever offers `availableStrategies`; never invents a strategy |
| `getOrderReconciliation` / `getBillReconciliation` | **backend-only** | wrapped in a paginated sales overview + a UI-ready detail read model |
| conflict list (`listConflicts`) | **missing information** | no pagination, no location/device/date filter, no financial-significance, no sort → new conflict-queue read model |
| conflict detail | **missing information** | lacked local-vs-remote side comparison, payment/inventory evidence, audit history, snapshot versions → new detail read model |
| `sales.reconcile` permission | **operationally ready** | reused as the single console gate (owner/manager) |
| payment reconciliation (`reconcilePayments`) | **backend-only** | surfaced as payment evidence in conflict + sales detail |
| inventory reconciliation (`reconcileInventory`) | **backend-only / missing information** | per-order only; no cross-device product/variant/location discrepancy view → new discrepancy read model with KNOWN/LIKELY/UNKNOWN evidence |
| SYNC-D cloud deficits | **backend-only** | no operator-facing read; overlaid onto the discrepancy view via a new org-scoped cloud endpoint |
| sync health (SYNC-C `getSyncHealth`) + cloud `organizationHealth` | **backend-only** | combined into one operator sync/device-health read model; cloud half via a new org-scoped HTTP endpoint |
| compensation | **unsafe for UI exposure (as automation)** | exposed as an explicit **`manual_action_required`** state + a durable operator decision record — never an auto refund/void/stock mutation |
| auto-materializing a remote value into an authoritative record | **unsafe for UI exposure** | deliberately NOT built; `accept_remote` remains decision-recording only (SYNC-F) |

### Dangerous-action review (STOP-condition check)

- **Compensation / refund / void / stock adjustment:** FloCafe's refund/void
  primitives have not been audited for exactly-once Admin automation, so
  SYNC-G does **not** invoke them. Compensation-required conflicts surface a
  `manual_action_required` state and record an explicit operator decision. This
  is a deliberate STOP-SHORT (Part G), documented — not a silent omission.
- **Inventory:** the discrepancy layer is strictly read-only; no admin action
  mutates `inventory_movements`/`inventory_balances`.
- **Resolution:** unchanged from SYNC-F — authorization → state machine →
  legality/financial-safety, never mutating an authoritative sale.

**Conclusion — no STOP condition.** Safe Admin resolution is exactly SYNC-F's;
no compensation invents financial behaviour; inventory discrepancies are shown
with evidence and honest KNOWN/LIKELY/UNKNOWN attribution; authorization scope
is unambiguous (owner/manager + org/location); no UI action silently modifies
financial history; cloud/local ownership is inherited from SYNC-F; and the one
additive migration (v90) touches no existing data.

---

## Admin architecture (Part B/C)

Backend read models live under `main/core/admin/` and are consumed by
`main/routes/admin-reconciliation.ts` (mounted at `/api/admin`), gated by
`requirePermission('sales.reconcile')` (owner/manager). They compose SYNC-F/E/D
data into **purpose-built responses**, never raw row dumps, with deterministic
keyset/offset pagination and org/location scoping. Two org-scoped cloud
endpoints were added (`GET /sync/v1/health`, `GET /sync/v1/deficits`) so the
console's cross-device half is read over real HTTP.

- **Sales overview** (`admin/sales-overview.ts`): paginated sales list with
  search (order/bill number, uid), date range, location, status, payment
  status, and conflict-presence filters; order/bill detail + history.
- **Conflict queue + detail** (`admin/conflict-console.ts`): filtered/sorted
  paginated queue with financial significance; a UI-ready detail with LOCAL and
  REMOTE sides, payment + inventory evidence, snapshot version history, audit
  events, and prior actions.
- **Inventory discrepancy** (`admin/inventory-reconciliation.ts`): per
  product/variant/location expected-vs-actual movement analysis, contributing
  movement evidence classified KNOWN/LIKELY/UNKNOWN, and the SYNC-D cloud
  deficit overlay. Read-only.
- **Sync/device health** (`admin/sync-health.ts`): local backlog/failed/devices
  + cloud organization health, merchant-focused.

## Resolution + compensation (Part F/G)

Resolution actions call the SYNC-F engine directly — enforcing `sales.reconcile`,
location access, the state machine, and financial safety — and expose only
`availableStrategies`. Compensation-required conflicts (payment/completion, or a
conflict whose only legal non-dismiss strategies are `compensate`/`retain_both`)
are surfaced with a `manual_action_required` flag and a reason; the operator can
record a durable reconciliation decision (a `sales_reconciliation_actions`
row), but no refund/void/stock movement is created.

## Inventory discrepancy model (Part H/I)

For a (product, variant, location): expected balance (from movements), local
balance (`inventory_balances`), remote movement totals (mirror), and the deltas
between them. Evidence is classified: **KNOWN** (a duplicate movement id, a
missing movement for a sold line), **LIKELY** (a cloud deficit, a sale from
another device's till, an unreconciled transfer), **UNKNOWN** (an unexplained
residual). The system shows evidence and never asserts a cause it cannot prove.

## Authorization + security (Part J/P)

Single gate: `sales.reconcile` (owner/manager). Every read model filters by the
caller's organization and, where relevant, location; identity is taken from the
authenticated session/device, never the client. The cloud endpoints resolve org
from the device. Backend authorization is the source of truth — the UI never
relies on hiding.

## Audit (Part K)

Conflict acknowledge/resolve/dismiss already audit (SYNC-F). SYNC-G adds
discrepancy acknowledge/resolve and compensation-decision audit events, written
transactionally with the action, loop-safe (a remote-applied audit event is
never re-emitted).

## APIs (Part O)

`/api/admin`: `sales`, `sales/order/:uid`, `sales/bill/:uid`,
`sales/order/:uid/history`, `sales/bill/:uid/history`, `conflicts`,
`conflicts/:uid`, `conflicts/:uid/acknowledge`, `conflicts/:uid/resolve`,
`reconciliation/order/:uid`, `inventory/discrepancies`,
`inventory/discrepancies/:key`, `inventory/discrepancies/:key/acknowledge`,
`sync-health`, `device-health`. Deterministic pagination, validated input,
explicit error shapes.

## Frontend (Part N)

A single **Reconciliation** dashboard section (owner/manager) with five views:
sales overview, conflict queue, conflict detail, inventory discrepancies, and
sync/device health — using the existing design system, with financial warnings,
filters, safe actions, and empty/error/loading states. No EPOS redesign.

## Migrations (Part S)

**None.** SYNC-G is purely additive read models + APIs + UI. Discrepancy
detection is computed on read; operator discrepancy acknowledgements reuse the
existing `sales_reconciliation_actions` table (`entity_type =
'inventory_discrepancy'`) rather than introducing a competing store — one
source of truth, no schema change.

## Known limitations

1. Compensation stops at a recorded decision + `manual_action_required` — no
   automated refund/void/stock movement (FloCafe primitives not yet audited for
   exactly-once Admin automation — Part G STOP-SHORT).
2. `accept_remote` still records a decision only; materializing a remote value
   into an authoritative record is future work.
3. Inventory attribution is evidence-based (KNOWN/LIKELY/UNKNOWN), not a solver.
4. The Admin UI is minimal-but-usable; a full console is future work.
5. Production cloud is not yet a permanently operated deployment (hosted Neon
   connectivity + the SYNC-D hosted test are proven — see `cloud/DEPLOYMENT.md`).

## Recommended next bundled milestone

**SYNC-H — Compensation Execution + Catalog Sync Onboarding:** audit the
refund/void/stock primitives for exactly-once Admin invocation and wire the
compensation workflow to execute them safely, then begin the first catalog
domain (products) sync — before customers/suppliers.
