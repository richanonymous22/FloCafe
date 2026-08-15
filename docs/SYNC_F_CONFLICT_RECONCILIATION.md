# SYNC-F — Sales Conflict Resolution + Reconciliation Foundation

Finishes the sales-synchronization foundation begun in SYNC-E: makes sales
conflicts not merely *detectable* but operationally *manageable* — durable,
queryable, auditable, and resolvable through an authorized, financially-safe
engine — plus a reconciliation layer over orders, bills, payments, and
inventory, and durable missing-parent recovery. No product / customer /
supplier / PO / transfer sync; no Admin UI; no licensing; no payment-provider
work.

Read alongside [`SYNC_E_SALES_ARCHITECTURE.md`](./SYNC_E_SALES_ARCHITECTURE.md)
and [`SYNC_D_MULTI_ENTITY.md`](./SYNC_D_MULTI_ENTITY.md).

**Status: complete.** Proven against real PostgreSQL + real HTTP
(`tests/sync-f-conflict-reconciliation.test.ts`, 63 checks).

---

## SYNC-E Audit

Every SYNC-E mechanism and every order/bill lifecycle mutation was re-read
before any SYNC-F code. Findings:

### Mechanisms (verified present and correct)

| SYNC-E mechanism | State | SYNC-F relevance |
|---|---|---|
| order/order_item/bill snapshot emitters | atomic, versioned, load-bearing uid | unchanged; reconciliation reads their `sync_outbox` history |
| `snapshot_version` generation | per-entity monotonic (`prior_count + 1`) | reconciliation surfaces it as "order/bill history" |
| `event_uid` generation | fresh ULID per snapshot | idempotency key for mutable dedup — unchanged |
| outbox uniqueness | partial index, append-only types only (v88) | unchanged |
| `cloud_entity_versions` | current-version projection | read-model hint; unchanged |
| `cloud_conflicts` | cross-device `concurrent_update`, `open` only | **EXTENDED** with full state machine + resolution fields |
| `remote_orders/_order_items/_bills` | FK-free mirrors, upsert-highest-version | reconciliation reads them; completion-conflict detection added |
| missing-parent staging | child lands in mirror regardless of parent | **EXTENDED** with durable `sales_pending_relationships` |
| remote apply | mirror-only, no outbox re-emit, loop-safe | **EXTENDED** with pending recovery + completion-conflict flag |
| stale snapshot handling | `mirrorIsStale` skips lower versions | unchanged; hardened + re-proven |
| payment linkage | payments synced separately (SYNC-D), joined by uid | reconciliation joins `payments` + `remote_payment_events` |
| inventory linkage | one movement per tracked line, remote never decrements | reconciliation detects missing/duplicate movements |
| org/location/device identity | resolved server-side, never trusted from payload | unchanged; extended to conflict endpoints |
| authorization | canonical `requireCan` (Milestone 8) | new `sales.reconcile` permission (owner/manager) |
| audit trail | `recordAuditEvent`, synced, loop-safe | new `sync.conflict_*` event types |

### Lifecycle mutations (re-enumerated)

| Mutation | Emits snapshot? | Authoritative/local | Cloud-visible? | Immutable after completion? | Conflict risk | Current handling | SYNC-F handling |
|---|---|---|---|---|---|---|---|
| order create (`createSale`) | YES (order+lines) | authoritative | yes | no (still open) | low | snapshot | reconciliation view |
| add item (`addSaleItems`) | YES (order+lines) | authoritative | yes | no | concurrent-edit | versioned snapshot | concurrent_update conflict |
| item void / cancel | YES (status snapshot) | authoritative | yes | no | lifecycle | snapshot | lifecycle_conflict (if divergent) |
| bill generate | YES | authoritative | yes | no | low | snapshot | reconciliation |
| bill paid / order terminal | YES | authoritative | yes | **YES** | completion/payment | snapshot | **completion_conflict flagged, never overwritten** |
| payment recorded | separate payment_event (SYNC-D) | authoritative | yes | payment is a fact | payment | synced fact | payment reconciliation |
| remote snapshot apply | NO (mirror only) | remote mirror | n/a | n/a | completion | mirror upsert | completion-conflict detection + pending recovery |

**Conclusion — no STOP condition.** Every conflict is safely classifiable into
the closed taxonomy below; no financial resolution requires silently changing
history (PRESERVE + FLAG + RECONCILE); compensation semantics are clear (a
durable record, never a fabricated transaction); authorization is enforceable
via the canonical local path; missing-parent handling never drops data; cloud
vs local ownership is unambiguous (below); resolution never creates duplicate
payment/inventory records; the migration is additive; and local sales behaviour
is unchanged. No lifecycle mutation was found misrepresented.

---

## Conflict model (Part B)

Closed conflict-type union (`main/core/sync/conflict-model.ts`), never widened
without a spec change:

`concurrent_update` · `stale_snapshot` · `parent_missing` ·
`lifecycle_conflict` · `payment_conflict` · `completion_conflict`

Each `sales_conflicts` row carries: conflict_uid, org/location, entity
type+uid, conflict_type, source (`cloud`|`local`), local/remote event uids,
local/remote device uids, local/remote snapshot versions, status, detected_at,
acknowledged_at/by, resolution strategy/actor/at/notes, compensation_reference,
resulting_state. The **`conflict_uid` is shared with the cloud's
`cloud_conflicts` row** — one logical conflict, never a competing pair.

## Financial safety rule (Part C)

A completed local transaction is NEVER silently changed by sync. Concretely:
`accept_remote` (blind overwrite) is illegal whenever the local entity is
completed/paid, and always illegal for `payment_conflict` /
`completion_conflict`. High-risk conflicts resolve by **PRESERVE + FLAG +
RECONCILE**, never OVERWRITE. The resolution engine mutates **no** authoritative
record; even `accept_remote` (legal only for still-open records) records a
decision — the remote value already sits in the mirror, and materializing it
into the authoritative row is deferred to a future operator action, never done
silently.

## Conflict state machine (Part D)

`open → acknowledged → resolving → resolved`, and `open|acknowledged →
dismissed`. `resolved`/`dismissed` are terminal and are never re-resolved. A
resolved conflict retains the original conflicting events (never deleted), who
resolved it, when, how (strategy), the resulting state, and any compensation
reference. Transitions are validated by `canTransition`.

## Resolution engine (Part E)

`main/core/sync/conflict-resolution.ts`. Strategies: `accept_local`,
`accept_remote`, `retain_both`, `compensate`, `dismiss`. `isLegalStrategy`
enforces the matrix; illegal attempts throw `IllegalResolutionError` and leave
the conflict untouched. Order of enforcement: **authorization → state machine →
legality/financial-safety**. Runs in one `withTxn` — a failure anywhere rolls
back the whole resolution (no partial state).

## Compensation (Part F)

A compensation is a durable `sales_reconciliation_actions` row
(`action_type='compensation'`) referencing the conflict + an operator-supplied
reference — a **decision an operator/Admin will act on**, NOT a refund / void /
payment / inventory transaction. FloCafe's compensation primitives (refund,
void) are deliberately NOT auto-invoked here: inventing a financial operation
would risk duplicate payment/inventory records, which the spec forbids. The
reconciliation record is the durable artifact; issuing the actual refund/void
remains an explicit, human, future-Admin action.

## Reconciliation (Part G/J/K)

`main/core/sync/sales-reconciliation.ts` — read-only, mutates nothing. For an
order/bill it returns the authoritative local record, remote mirror snapshot,
version history, conflicts, linked payments, linked inventory, and prior
actions. **Payment reconciliation** flags duplicate `payment_uid` linkage and
payments predating the sale. **Inventory reconciliation** flags tracked lines
with missing or duplicate movements. Both are detection-only — no double
decrement, no fabricated payment.

## Missing-parent handling (Part I)

`main/core/sync/pending-relationships.ts` + `sales_pending_relationships`. A
child that arrives before its parent is already staged in its mirror (no data
loss); SYNC-F additionally records a durable `pending` relationship. Recovery
is **event-driven, not polled**: when the parent is applied,
`resolvePendingForParent` flips it `resolved`. `markStalePendingInvalid`
(bounded retention sweep) is the only path to `permanently_invalid` — a clear,
finite reason, never an infinite retry loop. No state ever discards the child.

## Authorization (Part M)

New `Permission` `sales.reconcile`, granted to **owner + manager only**
(`main/core/authorization.ts`). Cashier / waiter / chef are refused. The
resolution engine enforces it via the canonical `requireCan(user,
'sales.reconcile', { locationId: conflict.location_id })`; routes additionally
gate with `requirePermission('sales.reconcile')`. Identity (org/location) is
always taken from authenticated context, never from the client.

## APIs (Part N)

`main/routes/sales-reconciliation.ts`, mounted at `/api/sales` — backend
contract only, no frontend:

- `GET /conflicts`, `GET /conflicts/:uid`
- `POST /conflicts/:uid/acknowledge`, `POST /conflicts/:uid/resolve`
- `GET /reconciliation/order/:orderUid` (+ `/history`)
- `GET /reconciliation/bill/:billUid` (+ `/history`)
- `GET /pending-relationships`
- `POST /reconciliation/action`

Cloud protocol (`cloud/server.ts`): `GET /sync/v1/conflicts` (org-scoped pull),
`POST /sync/v1/conflicts/resolve` (records resolution, re-validates financial
safety server-side).

## Cloud / local behaviour (Part P)

**Conflict ownership is split deliberately:**

- **Detection** of cross-device conflicts is the CLOUD's job — it is the only
  vantage point that sees two devices. `cloud_conflicts` is the source of truth
  for detection and cross-device status.
- **Resolution** is a LOCAL operation — only the local session knows the user's
  ROLE (so authorization is enforceable) and holds the authoritative record it
  must protect.

The device **pulls** cloud conflicts into `sales_conflicts` (same
`conflict_uid`), resolves locally, then **reports** the outcome back
(`/sync/v1/conflicts/resolve`) so other devices converge; the cloud keeps
append-only resolution history (`cloud_conflict_resolutions`).
**Completion-conflicts** and **pending relationships** are local-only
detections (they depend on this device's authoritative state). Every conflict
is org/location/device-scoped.

## Security (Part M/Q) & failure recovery (Part R)

Cloud conflict endpoints resolve org from the device; a foreign-org device sees
and can resolve nothing (404), a revoked device is 401, a tampered signature is
401, and the cloud independently refuses a blind financial overwrite. Every
mutation (detection, resolution, reconciliation action, pending relationship)
is transactional — a mid-operation failure rolls back with no partial state.

## Database changes (Part O/S)

Local additive migration **v89**: `sales_conflicts`,
`sales_reconciliation_actions`, `sales_pending_relationships`. Cloud additive
**0003_conflicts.sql**: extends `cloud_conflicts` (resolution/state columns +
`dismissed` status) and adds `cloud_conflict_resolutions`. No existing data
touched; no authoritative sales table altered. Verified by schema-health
(fresh) + upgrade-path (real v1.5.0 fixture).

## Known limitations

1. Resolution never materializes a remote value into the authoritative record,
   nor auto-issues refunds/voids — those are future operator/Admin actions
   (Part F). The reconciliation record is the durable hand-off.
2. Conflict detection remains conservative (SYNC-E) — cross-device divergence,
   not a semantic three-way merge.
3. `permanently_invalid` pending relationships require an explicit retention
   sweep to be invoked (wired as a function; no scheduler in this milestone).
4. No Admin UI — this milestone delivers the backend/domain contract only.
5. Production cloud remains un-deployed (no hosted credentials — SYNC-D);
   proven on real local PostgreSQL.

## Recommended next bundled milestone

**SYNC-G — Admin Sales Console + Cross-Device Balance Reconciliation:** the
operator-facing surface that consumes these APIs (conflict queue, reconciliation
views, resolution actions), materialization of an approved remote value into a
compensating business action, and cross-device inventory-balance reconciliation
— before extending sync to the catalog domains (products/customers/suppliers).
