# Milestone 9A — Sync Architecture Adversarial Review

**Status: review only. No production code, migrations, or dependencies
were created or modified.** This document reviews
[`MILESTONE_9_SYNC_ARCHITECTURE.md`](./MILESTONE_9_SYNC_ARCHITECTURE.md)
against the actual repository, not against its own claims, and corrects
that report where it was wrong.

Every finding below was checked against real code at a cited `file:line`.
Where the Milestone 9 report contradicts the code, **the code wins and the
report was wrong** — this review says so plainly rather than defending the
prior design.

---

## 0. What this review found, in one paragraph

The Milestone 9 outbox/inbox skeleton survives review — it is the right
transport. But three of its substantive claims were wrong or unsafe, and
two of its recommendations were more complex than the problem requires:
(1) the inventory model was **factually wrong** about current behavior —
Plemmo hard-rejects oversells today, it does not warn-and-allow; (2) the
recommendation to event-source `orders`/`order_items`/`bills` is
**overengineered** and is retracted; (3) the payment dual-write it named
as "the biggest blocker" is worse than described — it is **error-swallowing
and untested**, and *neither* payment table is currently complete; (4) the
cursor/inbox transaction boundary was **underspecified** in a way that can
lose events if implemented naively; (5) the transfer model's "atomic two
sides" cannot literally cross two offline databases and needs an explicit
two-phase decision. Verdict: **GO WITH CHANGES**, with a short list of
product/architecture decisions that must be resolved before SYNC-0.

---

## Review Issue 1 — Inventory policy (the report was WRONG)

### What the code actually does today

| Path | File:line | Behavior on insufficient stock |
|---|---|---|
| Sale of a tracked product | `main/core/sale.ts:409` (pre-check) + `main/core/inventory.ts:196` (`recordSale`, backstop) | **Hard reject** — `SaleError`/`InventoryError('Insufficient stock…')`. The sale does not happen. |
| Manual adjustment | `main/core/inventory.ts:293` (`adjustStock`) | **Hard reject** — `InventoryError('Adjustment would take stock negative…')` |
| Transfer out | `main/core/inventory.ts` (`recordTransfer`, `direction==='out'`) | **Hard reject** — `InventoryError('Insufficient stock at the source location…')` |
| Sale of an **untracked** product (`track_inventory = 0`) | `main/core/sale.ts:409` guard is skipped | Always allowed, never decremented (correct — untracked means "don't count") |

`docs/MILESTONE_4_INVENTORY.md` §12 is explicit: *"stock negative is
prevented (`InventoryError`/`SaleError`…). No merchant-configurable
override exists yet."*

**Answers to the four questions:**

1. **What happens today when tracked stock is insufficient?** The operation
   is *rejected* before it commits — for sales, adjustments, and transfer-outs
   alike. Negative stock cannot be reached through any normal path.
2. **Is negative stock permitted for sales, adjustments, or both?** Neither.
   It is prevented everywhere. (An untracked product simply isn't counted;
   that is not "negative stock," it is "no stock tracking.")
3. **Did the sync design accidentally change the business policy?** **Yes,
   and this review owns that error.** Milestone 9 §10 claimed overselling is
   "already the existing single-till local behavior… a soft warning… not a
   hard block," and attributed that to the Milestone 4 doc. That attribution
   was fabricated — the M4 doc says the opposite. The M9 "allow negative
   stock, we're just extending an existing policy" framing was therefore
   built on a false premise. It is not an extension of current behavior; it
   is a **reversal** of it.
4. **Practical options** — evaluated on merchant consequence, not
   implementation ease:

| Option | What it means | Merchant consequence | Verdict |
|---|---|---|---|
| **A. Preserve hard enforcement** | Every till keeps rejecting a sale it can't cover *from its own local balance* | A cashier can never sell "the last one" if the local count says zero — including when the count is wrong (shrinkage, an un-synced receipt). In a fast retail queue this means turning away a customer holding physical stock. But no single till ever oversells. | **Keep as the local default** |
| **B. Configurable overselling** | A per-merchant `allow_negative_stock` setting turns the local guard into a warning | Grocers/high-velocity retail often *want* this (never block a sale over a count that's usually stale); a pharmacy/serialised-goods merchant never does | **Add later, off by default** |
| **C. Overselling only while offline** | Allow negative only when disconnected | Unimplementable honestly: a till only ever sees its *own* local balance, which is non-negative by construction (option A already holds per-till). A till has no "I am offline, relax the rule" signal that maps to a real stock fact — it would just be option B triggered by connectivity, which is worse (behavior silently changes when the wifi drops) | **Reject** |
| **D. Hard local enforcement + accept-and-flag at cloud** | Local stays option A. The cloud **never rejects an already-completed sale** (a printed receipt is an immutable fact), and raises a *reconciliation alert* when independent offline tills sum below zero | Matches physics: two tills offline, each sees 7, each sells 5 — each is locally valid, the cloud sees -3 and tells the merchant "you oversold by 3 across your tills," which is *true and actionable*. No sale is ever un-happened. | **Recommended** |

### Recommendation

**Option D as the sync policy, with option A unchanged as the local policy,
and option B as a later opt-in.** The key correction to Milestone 9: the
cloud does **not** "allow negative stock" as a *policy* — each till still
hard-enforces locally (no SaleService change). The negative only ever
appears in the cloud's *aggregate*, and it represents genuine
across-till overselling that **no offline-first system can prevent without
abandoning offline operation** (preventing it needs a live global lock).
The honest model is: *preserve the local guarantee, accept that the sum of
independent offline decisions can exceed physical stock, treat completed
sales as immutable facts, and surface the discrepancy for reconciliation.*

**This must be an explicit, signed-off product decision before SYNC-0**,
because it means telling merchants "your tills can collectively oversell
while offline, and we'll flag it" — a real business statement, not an
implementation detail. `SaleService` does **not** change.

---

## Review Issue 2 — Sale event sourcing (the report was OVERENGINEERED; retracted)

Milestone 9 §2/§10 recommended turning `orders`/`order_items`/`bills` into
projections of a `SaleOpened`/`ItemAdded`/…/`SaleCompleted` event stream.
**This review retracts that recommendation.**

| Criterion | A. Full event sourcing | B. Canonical rows + append-only sync facts | C. — |
|---|---|---|---|
| Implementation complexity | High — rewrite `SaleService`, rebuild every read as a projection | **Low — add an outbox write to the existing `withTxn()`; `SaleService` untouched** | |
| Migration risk | High — every existing order must be back-derived or dual-modelled | **Low — additive outbox table, existing rows unaffected** | |
| Crash recovery | Must rebuild projection from events on every inconsistency | **Same as today — the row *is* the state, already crash-safe under WAL** | |
| Sync correctness | Strong, but only if every mutation is perfectly captured as an event | **Sufficient — a completed sale is one durable fact; corrections are additional facts** | |
| Reporting | Every report re-derives from events (slow, or needs a projection anyway) | **Unchanged — reports read the same rows they read today** | |
| Debugging | Hard — "why is this order wrong" means replaying an event log | **Easy — inspect the row, same as today** | |
| Future payments/refunds | Neutral | **Neutral — payments already have their own event log (`payment_events`)** | |
| Offline operation | Neutral | **Neutral** | |
| AI-agent maintainability | Poor — a large, unfamiliar pattern invites regressions in a working POS | **Good — small additive change to a well-understood service** | |
| Preserves working hospitality POS | **No — it rewrites the spine** | **Yes — zero behavior change** | |

**Recommendation: Architecture B.** `orders`/`order_items`/`bills` remain
the authoritative local business records exactly as they are. The sync
layer captures **durable facts at meaningful checkpoints** — a finalized
sale (on completion/payment) as a snapshot, and any post-finalize
correction (void, discount adjustment, cancellation) as a follow-on fact.
A till has no reason to stream a half-built cart to the cloud; it has every
reason to durably record "this sale completed." This is ~10× fewer sync
records than event-sourcing every item-add (see Issue 10) and, critically,
**honours the explicit instruction not to rewrite the working
`SaleService`.** Event sourcing was elegance the problem did not ask for.

---

## Review Issue 3 — Payment migration (worse than the report said)

### What actually writes each payment store

| Path | Entry point | Writes `bills.payment_details`? | Writes `payments`/`payment_events`? |
|---|---|---|---|
| **Hospitality / all bill payments** | `applyPaymentBatch()` — `main/routes/bills.ts:705` — via `POST /:id/payment` and `POST /:id/payments` | **Yes, authoritative** (`bills.ts:706`) | **Yes, but best-effort** — `recordAppliedPaymentLine()` (`bills.ts:713` → `payment.ts:666`) |
| **Retail checkout** | `tender()` — `main/modules/retail/checkout.ts:100` | **No** — retail never writes `payment_details` | **Yes, authoritative** (`tender()` is "complete, tested, standalone") |

### The findings the M9 report missed

1. **The hospitality dual-write swallows all errors and is untested.**
   `recordAppliedPaymentLine()` (`payment.ts:666`) wraps its entire body in
   `try { … } catch (err) { console.error(…) }` — its own comment says
   *"Never let the dual-write break a real payment"* and *"This path has no
   test coverage backing it."* So a `payments`/`payment_events` write can
   **silently fail** while the `payment_details` write succeeds. The new
   tables are therefore not a guaranteed-faithful mirror even for the
   hospitality path.
2. **Neither table is a complete record of all payments.**
   `payment_details` has hospitality but **not retail**.
   `payments`/`payment_events` has retail (reliably) and hospitality
   (best-effort). This is visible in the reporting split:
   `main/routes/reports.ts:60` aggregates from `payment_details` (misses
   retail); `main/modules/retail/reports.ts:32` aggregates from `payments`
   (misses hospitality). **Two report systems reading two different,
   individually-incomplete payment stores** — a pre-existing latent
   inconsistency, and a direct sync blocker.
3. **The printer and legacy reports read `payment_details`**
   (`thermal.ts:899/1001/1113`, `reports.ts:60`, `payment-methods.ts:21`) —
   so it cannot simply be dropped; readers must migrate first.

### Answers

1. **Which live paths write `payment_details`?** Exactly one:
   `applyPaymentBatch()` at `bills.ts:706`.
2. **Which write `payments`/`payment_events`?** `tender()` (retail,
   authoritative) and `recordAppliedPaymentLine()` (hospitality,
   best-effort).
3. **Is dual-write complete for all workflows?** No — retail writes only
   the new tables; hospitality writes both but the new-table half is
   unreliable and untested.
4. **Hidden payment paths?** No third *write* path, but two hidden *read*
   dependencies matter: the thermal printer and the legacy report/payment-
   method aggregations all read `payment_details`, and retail payments are
   invisible to them today.
5. **What's required to make `payments`/`payment_events` sole authority?**
   (a) Make the hospitality dual-write **authoritative and atomic** — remove
   the error-swallowing `try/catch`, run it inside `applyPaymentBatch`'s
   existing transaction so it commits-or-rolls-back with the bill, and back
   it with real tests. (b) Migrate the three readers (`reports.ts`,
   `payment-methods.ts`, `thermal.ts`) onto `payments`. (c) Reduce
   `payment_details` to a derived compatibility write, then retire it once
   nothing reads it.
6. **What must remain temporarily?** `payment_details` must keep being
   written throughout the transition (the printer and legacy reports depend
   on it) — it is retired *last*, only after every reader has moved.

### Migration plan (does not break hospitality or retail)

- **P-1.** Add tests that assert `payments`/`payment_events` exactly mirror
  every `applyPaymentBatch` outcome (cash, card, wallet, split, partial).
  *These tests will currently fail intermittently or silently pass over
  gaps — that is the point; they establish the baseline.*
- **P-2.** Promote the hospitality dual-write: move `recordAppliedPaymentLine`
  inside the same `withTxn` and let it throw (remove the swallow), so a
  payment either lands in both stores or neither. **Ship behind the existing
  tests; no reader changes yet — `payment_details` still authoritative.**
- **P-3.** Backfill `payments`/`payment_events` from historical
  `payment_details` for existing installs (a migration with the usual
  fresh + legacy-fixture upgrade-path tests).
- **P-4.** Migrate readers onto `payments` one at a time (retail reports
  already there; move `reports.ts`, `payment-methods.ts`, then `thermal.ts`).
- **P-5.** Reduce `payment_details` to a compatibility write, then retire it.
- Only after P-2 (+P-3 for history) is `payments`/`payment_events` safe to
  treat as the sync source. **P-1/P-2 are SYNC-0 blockers; P-3–P-5 can
  overlap SYNC-A onward.**

---

## Review Issue 4 — Device authentication

| Option | Extraction resistance (Electron/Windows) | Rotation | Revocation | Impl complexity | Server infra | Offline | Support burden | Verdict |
|---|---|---|---|---|---|---|---|---|
| A. Long-lived bearer | Poor — plaintext on disk, valid forever | None | Blocklist only | Trivial | Minimal | Fine | Low until a token leaks, then severe | Reject |
| B. Rotatable bearer (access + refresh) | Moderate — short access-token window limits a leak; refresh secret still on disk | Built-in | `devices.status='revoked'` at refresh | Low | Token endpoint + store | Fine (access token cached, refresh online) | Low | **Recommended baseline** |
| C. Device asymmetric keypair + signed requests | Good *if* private key is OS-protected; on Electron the key still sits on disk unless DPAPI/keychain is used | Re-enroll or key-roll | Revoke public key | Moderate | Signature verification | Fine | Moderate | **Target, phase 2** |
| D. Mutual TLS | Strong | Cert lifecycle | CRL/short certs | High — client certs in Electron's net stack are awkward, cert distribution/renewal is real ops | mTLS termination | Fine | High (cert expiry = silent outage) | Reject for now |
| E. Hybrid | — | — | — | — | — | — | — | (B→C is the hybrid) |

### Recommendation

**Ship SYNC-G with B (rotatable bearer): a short-lived access token plus a
device-bound refresh credential, both stored via OS-level protection
(Windows DPAPI / macOS Keychain), revocable through the `devices.status`
column that already exists (`active`/`retired`/`revoked`,
`main/db.ts:3683`).** Design the request envelope as a signed structure so
**upgrading to C (device-generated asymmetric signatures) is a drop-in
later without changing the `/sync/*` contract.** This gives real security
(short leak window, OS-protected secrets, instant server-side revocation)
without mTLS's operational weight. Pure long-lived bearer (A) and mTLS (D)
are both rejected — A is insecure, D is operationally disproportionate for
a fleet of merchant desktops that IT staff will not babysit.

**Honest caveat:** on a compromised Windows desktop with disk/DPAPI access,
*no* on-device credential scheme is fully extraction-proof without a TPM/HSM
this product cannot assume. B limits the blast radius (rotation + revocation)
better than A, and C's marginal gain over B on Electron is small unless
paired with hardware-backed key storage — which is why B-now/C-later is the
right sequencing, not C-immediately.

---

## Review Issue 5 — Transfer semantics (a real behavior decision)

### What the code does today

`completeTransfer()` (`main/core/transfers.ts`) writes **both** the
`transfer_out` (source) **and** `transfer_in` (destination) movements
**atomically in one transaction, from a single call** (`inventory.ts`
`recordTransfer` ×2). This works today because **both locations live in one
SQLite database** — a Plemmo install holds every location the merchant has.

### Why it cannot survive multi-location offline sync unchanged

In an offline multi-device world, Location A's till and Location B's till
have **separate** SQLite databases. When A completes a transfer, its atomic
call writes a `transfer_in` into *A's local copy* of B's balance — a row B's
database never executed and, until sync, knows nothing about. The atomic
two-sided write is **structurally single-database**; it cannot atomically
credit a balance that lives in another device's database. It also credits
destination stock *the instant the source dispatches* — before the goods
physically arrive — which is already physically wrong even in the
single-DB case.

| Model | Fits offline multi-device? | Physical honesty | Verdict |
|---|---|---|---|
| A. Existing atomic two-sided | No — see above | Poor (credits destination before goods arrive) | Keep only for same-DB legacy |
| B. Two-phase dispatch/receipt | **Yes** — source records `transfer_out` (dispatch); destination independently records `transfer_in` (receipt) when goods physically arrive, mirroring how PO receiving already works (`ReceivingService`) | **Good** — stock is "in transit" between dispatch and receipt | **Recommended** |
| C. Cloud-mediated escrow | Yes but requires the cloud to be authoritative for the intermediate state | Good | Overengineered — reject |

### What should happen when A and B are both offline

- A (offline) dispatches: `transfer_out` at A, transfer marked `dispatched`.
  A's stock drops immediately (correct — it left A).
- B (offline) continues selling its **own existing** stock — unaffected,
  because the transfer has not credited B anything yet (this is the correct
  answer to the M9 brief's "what if B sold the same stock" — B can only
  sell stock it physically has; the in-transit units aren't B's yet).
- When both reconnect, the dispatch syncs; B sees an **incoming transfer
  awaiting receipt**.
- B's staff **confirm physical receipt** → `transfer_in` at B, transfer
  `completed`. Stock arrives in B's ledger when it arrives on B's shelf.

### Recommendation

**Adopt two-phase dispatch/receipt (B) as the Plemmo transfer model.** This
*is* a behavior change from today's atomic completion and **requires product
sign-off before SYNC-0**, but it is the correct model even ignoring sync
(goods in transit are neither location's shelf stock). Preserve the current
atomic path only as the degenerate same-install case if needed for
backward compatibility, but the forward model is two-phase.

---

## Review Issue 6 — Cloud authorization (the report was too dismissive)

Milestone 9 §S said the cloud "does not need to re-authorize whether a
cashier was allowed to create this sale." That is correct **only** for the
per-cashier permission check, and the report over-generalised it into
"sync isn't an authorization surface." **Challenge upheld.** The cloud must
separate two layers:

**Transport authentication (per request):** is this a validly enrolled,
non-revoked device, and which organization does *its enrollment record*
(never the payload) say it belongs to.

**Business validation (per event):**

| Threat | Cloud MUST validate |
|---|---|
| Compromised / malicious device forging events | Every event's `organization_id`/`location_id` is **derived from the authenticated device**, never trusted from payload; entity ownership — a referenced sale/PO/payment must already belong to this org |
| Cloned device | Device credential binding + `device_sequence` monotonicity — a cloned device replaying another's sequence is detected as a rollback/gap |
| Revoked employee creating events before revocation propagates | Cloud cannot retroactively un-happen a locally-completed sale, but it **records the actor**, and flags events whose `actor_user_id` was revoked *before* the event's local timestamp for review (anomaly detection, not silent acceptance) |
| Stale device reconnecting months later | Reject events referencing entities/state the org no longer has; validate feature entitlement **at apply time** (a feature disabled since the device went offline) |
| Invalid state transitions | Re-validate PO/transfer/refund/payment state machines cloud-side (duplicated *validation*, not *business logic*) — a `received` against a `cancelled` PO is rejected regardless of what the device believed |
| Feature-gated operations | Re-check `organization_features` entitlement for events representing feature-gated subsystems |

**What the cloud does NOT do:** re-run the *per-cashier permission* check
(`AuthorizationService.can`) — it lacks the actor's permission state at
event-time and the local context, and the check already happened locally
before the fact was created. Instead it records the actor and relies on the
audit stream + anomaly flags. So M9's instinct wasn't wrong, but its scope
was: **transport auth ≠ business validation, and the cloud needs both.**

---

## Review Issue 7 — Multi-till inventory commutativity

**Claim under test:** "movement ledger ⇒ no conflict."

**Partly true, and the report over-claimed it.** Movements are additively
commutative *for the derived balance* — `7 − 5 − 4 = 7 − 4 − 5`, order
doesn't matter for the sum. That much holds. But *business correctness* is
**not** commutative in two places the M9 report glossed:

1. **Availability at sale time is order-dependent** — but this is already
   resolved locally (each till decided against its own truth), so the cloud
   isn't re-deciding it. The residue is exactly the cross-till oversell of
   Issue 1, which needs a **negative-balance reconciliation flag** — not
   conflict *resolution*, but conflict *detection*.
2. **Dependency edges are not commutative:** a `transfer_in` is meaningless
   before its `transfer_out`; a `receipt` is invalid against a cancelled PO;
   a `return`/refund movement must not exceed what the referenced sale line
   actually sold (already capped locally by `recordReturn`, must be
   re-capped cloud-side).

**Minimum additional mechanism (beyond "store the movements"):**
(a) a cloud-side **negative-balance detector** that raises a reconciliation
alert per (product, location) when the derived balance goes below zero;
(b) **dependency validation** for `transfer_in`→`transfer_out`,
`receipt`→`PO-not-cancelled`, and `return`→`sold-quantity-cap`. With those
two, "ledger = no conflict" is sufficient; without them it is not.

---

## Review Issue 8 — Entity classification review

Flagging the classifications that could cause a real-world inconsistency:

| Entity | M9 said | Problem found | Corrected |
|---|---|---|---|
| **products** | SYNCED (LWW) | **`products.stock_quantity` is a *mirror* of the inventory ledger for variant-less products** (`syncLegacyStockQuantity`, `inventory.ts`). Syncing the product row would sync `stock_quantity`, **double-counting** against synced `inventory_movements`. | SYNC the product's *catalogue* fields (name/price/sku/…) but **exclude `stock_quantity`** — stock syncs only via movements. Critical catch the M9 report missed. |
| **bills** | "SYNCED today, should become DERIVED" | Bills carry `payment_details` **authoritatively for hospitality** until the payment migration (Issue 3) completes. Treating them as DERIVED *now* would drop hospitality payment data. | STATEFUL_SYNCED **until** payment migration P-4/P-5, then DERIVED. Sequence matters. |
| **settings** | Split org-level (SYNCED) vs device-level (LOCAL_ONLY) | The real `settings` table is a **flat key-value store** with no such column; the split must be a hand-maintained **allowlist**, which is fragile — a new setting added without classifying it defaults to an ambiguous state. | Keep the split but make it an **explicit, tested allowlist** with a default of LOCAL_ONLY (safe: a mis-classified setting stays local rather than leaking/overwriting across devices). |
| **refunds** | STATEFUL_SYNCED | The `refunds` table exists but `refundPayment()` has **no HTTP route** (confirmed — real merchant refunds still flow through the legacy bill path, not `PaymentService`). Cross-device refund correctness depends on machinery that isn't wired up yet. | Correct classification, but **refund sync depends on the payment migration first** — flag as blocked, not ready. |
| **customers** (wallet) | profile LWW + wallet append-only | `loyalty_ledger` is the append-only store — correct — but wallet **balance is read in the hot payment path** ("Insufficient wallet balance" checks). Two offline redemptions summing past the balance is a real overspend risk, same shape as inventory oversell. | Correct model; add the same **reconciliation-flag** treatment as inventory for cross-device wallet overspend. |
| **locations/registers** | SYNCED | Creating a location/register offline mints a local ULID; two offline devices creating "Till 2" is harmless (distinct ULIDs) but produces **duplicate-looking** registers a human must merge. | SYNCED is fine; note the merge is a human dedup task, not automatic. |
| **purchase orders / transfers** | STATEFUL_SYNCED | Sound. | Unchanged. |

---

## Review Issue 9 — Cursor / inbox safety (boundary was underspecified)

Milestone 9 §6.2 said the cursor can advance "as soon as a pull's contents
are durably written to `sync_inbox` — before they are applied." That is
safe **only if** the inbox-write and the cursor-advance are in the **same
transaction**. The report did not state that, and the naive reading (two
separate writes) can lose events. Precise boundaries:

**Required boundary: `{ INSERT all inbox rows for the batch; UPDATE
sync_state.cursor }` = ONE transaction. Apply = a SEPARATE transaction per
inbox row.**

Walking the scenarios under that boundary:

1. **download → write inbox → advance cursor → crash → restart.** Inbox rows
   are durably `pending`; cursor advanced. On restart the apply loop finds
   the `pending` rows and applies them. Nothing re-fetched, nothing lost.
   **Safe.** *(If cursor-advance were a separate transaction that committed
   while the inbox insert didn't: cursor points past un-stored events → lost
   forever. This is the failure the same-transaction rule prevents.)*
2. **download → partial inbox write → crash.** The batch insert + cursor
   update is one transaction → partial = full rollback → cursor unchanged →
   the whole batch is re-fetched next pull. Duplicates are absorbed by
   idempotency (`sync_inbox.uid` PK). **Safe.**
3. **inbox write + cursor write succeed → apply fails.** The event is
   durably in `sync_inbox` (`pending`/`failed`); apply retries independently.
   Cursor already advanced, correctly — the event is not lost, it is stored
   and pending. **Safe.**

**Conclusion:** the design is safe **iff** the inbox-insert and
cursor-advance share one transaction and apply is separate. The M9 report's
wording allowed an unsafe implementation; this review makes the boundary a
hard requirement. (Note the asymmetry with the *outbox*, which advances its
"acked" state only *after* the cloud ACK — different direction, different
rule.)

---

## Review Issue 10 — Cloud scale

The M9 estimate (~200 events/register/day) is **only right under
Architecture B (snapshot sync)**. Under the retracted event-sourcing model
a 20-line order emits ~23 events — ~10× higher — which alone is a reason to
prefer B. Recomputing with B (a sale ≈ 1 finalized-sale fact + 1–2 payment
facts + a few inventory movements ≈ ~6–8 sync records/sale, ~150
sales/register/day ≈ ~1,000 records/register/day, higher than M9's 200 but
the same order of magnitude):

| Merchants | Registers | Sync records/day | /month | Sufficient with… |
|---|---|---|---|---|
| 100 | ~200 | ~200K | ~6M | A single Postgres, `organization_id`-indexed. Trivial. |
| 500 | ~1,000 | ~1M | ~30M | Same, with the events table indexed/partitioned by `organization_id` from day one. |
| 1,000 | ~2,000 | ~2M | ~60M | Same + a read replica for `/sync/pull`. |
| 3,000 | ~6,000 | ~6M | ~180M | Partition by `organization_id`; pull served from replicas; **rate-limit + jittered backoff to survive reconnection storms** (see below). |
| 10,000+ | ~20,000 | ~20M | ~600M+ | Now needs real partitioning/sharding by org, a queue in front of `/sync/upload`, and archival of old events out of the hot table. **Above the "sufficient without redesign" line.** |

**Bottlenecks the M9 report under-weighted:**

- **Reconnection storms.** A regional outage ending means thousands of
  devices flush simultaneously — a thundering herd on `/sync/upload`. **Not
  optional:** jittered exponential backoff on the client **and** server-side
  rate limiting/load shedding from day one. This is the single most likely
  real-world scale incident and M9 mentioned it only in passing.
- **Per-org, not per-merchant, is the right unit** — a 6-register merchant
  is 6× the pull load of a 1-register merchant. Confirmed correct in M9;
  restated because it drives the partition key.
- **`organization_id`-first indexing/partitioning must be in the first cloud
  migration**, not retrofitted — retrofitting a partition key on a
  180M-row table is a migration outage.

**Sufficient through 3,000 merchants** with single-Postgres +
`organization_id` partitioning + read replica + backoff/rate-limiting.
**10,000+ requires sharding and a queue** — design the contract so that's a
cloud-side change invisible to the POS (the `/sync/*` contract already
allows it).

---

## Review Issue 11 — Failure / conflict UX

The dangerous new failure mode: **"completed locally, rejected by cloud
later"** — acute for refunds, receiving, transfers, permission changes.

**Design principle: a locally-completed action is never silently un-happened
and never silently disappears. It becomes a flagged item needing
reconciliation, visible at the right level.**

| Audience | What they see |
|---|---|
| **Cashier** | Nothing changes at the moment of action — the sale/refund succeeds locally, the receipt prints (no lie). If the cloud later rejects it, a **non-blocking notification** appears at that till ("A refund from Tue needs manager attention"), never a silent drop |
| **Store manager** | A **"Sync exceptions" queue** in the POS: each rejected event with its reason, the original local record, and a suggested resolution (e.g. "cloud says this PO was cancelled elsewhere; the goods you received need a manual stock adjustment") |
| **Plemmo support/admin** | A cloud-side conflict/exception dashboard (Observability, M9 §19) across the merchant's devices |

| Auto-resolved (no human) | Requires human |
|---|---|
| Duplicate events (idempotent replay) | Refund rejected as double-refund |
| LWW field conflicts (product price, customer field) | Receiving against a since-cancelled PO |
| Commutative inventory movements | Permission-change conflicts (server-wins, but the loser must know) |
| Cross-till oversell within a tolerance → alert only | Cross-till oversell beyond tolerance, or wallet overspend |

**Preventing the "it never happened" misconception:** rejected events are
**retained locally as completed facts with a `sync-rejected / needs-
reconciliation` flag** — the merchant always sees both "this happened at my
till" *and* "the cloud flagged it." Reconciliation produces a **compensating
action** (a manual adjustment, a store credit, a corrected refund) — never a
silent reversal. The mental model must be accounting-style (you post a
correcting entry), not database-style (you delete the bad row).

---

## Review Issue 12 — Implementation risk / coupling

**God files (regression surface):**

| File | Lines | Risk |
|---|---|---|
| `main/db.ts` | **5,584** | Schema + all 79 migrations + helpers in one file. **Every** SYNC migration touches it; highest regression surface in the repo. |
| `main/services/cloud-sync.ts` | 1,815 | The **unrelated FloAdmin bridge**. Its `cloud_sync_outbox` and `flushOutbox` naming is a trap — an agent could wire the new engine into the old flush loop. **Must not be touched or imported by the new sync engine.** |
| `main/routes/bills.ts` | 1,059 | `applyPaymentBatch` — the load-bearing payment monolith the payment migration (Issue 3) must modify. Highest-stakes change in SYNC-0. |
| `main/routes/orders.ts` | 1,012 | Sale HTTP surface; the outbox write attaches near here. |
| `main/core/sale.ts` | 932 | Do **not** rewrite (Issue 2). |

**Legacy DB dependencies / hidden side effects:**
- Integer PKs on `orders`/`order_items`/`bills` with a bolted-on `uid`
  (v69) that is **not yet load-bearing** — SYNC-0 must make it so, and
  verify *current* insert paths populate it, not just the historical
  backfill.
- The payment dual-write's **error-swallowing `try/catch`** — an agent
  "tidying" it could either break real payments (if it lets errors
  propagate without moving the call into the transaction first) or entrench
  the silent gaps. Change it deliberately, with tests, per Issue 3 P-1/P-2.
- `syncLegacyStockQuantity` double-write — the `products.stock_quantity`
  mirror (Issue 8) that must be excluded from product sync.

**Test fixtures that will break:** `tests/upgrade-path.test.ts` (real
v1.5.0 legacy fixture) and `tests/schema-health.test.ts` fail on **any**
schema addition and must be updated for every SYNC migration — this is the
established discipline, not a surprise, but each SYNC-0/A migration inherits
it.

**Where to isolate implementation:**
1. New engine lives in **`main/core/sync/*`**, entirely separate from
   `cloud-sync.ts`; a lint/review rule that the new engine never imports
   `services/cloud-sync`.
2. **Payment migration is its own milestone (SYNC-0a) with exhaustive tests
   landing before any sync transport exists** — it is the single highest-
   risk change and must not be entangled with outbox work.
3. Outbox writes attach to existing `withTxn()` call sites as **additive
   single statements**, reviewed one service at a time (inventory first —
   lowest risk, already append-only, no dual-write baggage).

---

# FINAL DELIVERABLE

## 1. Executive architecture verdict

The Milestone 9 transport design (outbox/inbox, ULID-keyed idempotency,
per-device sequence, provider-neutral contract) is **sound and approved**.
But the report contained one factual error (inventory), one overengineered
recommendation (sale event sourcing), one under-assessed blocker (the
payment dual-write is unreliable and untested, and *neither* payment store
is complete), one underspecified safety boundary (cursor/inbox
transactionality), and one unresolved behavior change (transfer
semantics). None is fatal; all are resolvable before implementation.
**GO WITH CHANGES.**

## 2. What remains approved

Outbox/inbox model; ULID `event_uid` idempotency extending the existing
`payment_idempotency` pattern; per-device monotonic `sequence` for
device-local ordering; entity-dependency (not global) ordering; the
provider-neutral `/sync/upload|pull|ack` contract; server-side resolution
of org/location/device identity from the authenticated device;
tombstones-not-hard-deletes; `updated_at`-server-stamped LWW for
configuration entities; the append-only ledgers (`inventory_movements`,
`payment_events`, `audit_events`) as the primary sync primitives; the
SYNC-0→SYNC-I staging shape.

## 3. What must change

- **Inventory model** (Issue 1): retract "allow negative stock." Local hard
  enforcement stays; the cloud accepts completed sales as facts and flags
  cross-till oversell. Needs product sign-off.
- **Sale model** (Issue 2): retract event sourcing. Keep canonical rows +
  append-only sync facts (snapshot on finalize).
- **Payment** (Issue 3): make the hospitality dual-write authoritative,
  atomic, and tested *before* sync; migrate readers; retire `payment_details`
  last.
- **Transfers** (Issue 5): adopt two-phase dispatch/receipt. Needs product
  sign-off.
- **Cloud authorization** (Issue 6): specify transport-auth vs
  business-validation; the cloud validates ownership, state transitions,
  entitlement, device status — not per-cashier permissions.
- **Cursor/inbox** (Issue 9): inbox-insert + cursor-advance in one
  transaction; apply separate.
- **products sync** (Issue 8): exclude `stock_quantity` from product sync.

## 4. What should be simplified

Sale synchronisation (rows + facts, not event sourcing). Device auth (start
with rotatable bearer, not asymmetric/mTLS). Conflict handling (detection +
reconciliation flags, not automated resolution machinery).

## 5. What is overengineered

Full sale event sourcing (retracted). Any attempt at global event ordering
(already rejected in M9, reaffirmed). Cloud-mediated transfer escrow
(rejected in favour of two-phase). mTLS device auth (rejected for now).

## 6. Revised entity classification

Per Issue 8: **products** SYNCED *excluding `stock_quantity`*; **bills**
STATEFUL_SYNCED until payment migration then DERIVED; **settings** explicit
allowlist defaulting to LOCAL_ONLY; **refunds** STATEFUL_SYNCED but blocked
on payment migration; **customers** profile LWW + wallet append-only with
reconciliation flag; **inventory_movements/payment_events/audit_events**
APPEND_ONLY_SYNCED (unchanged); **locations/registers** SYNCED (human dedup
on collision). All other M9 classifications stand.

## 7. Revised source-of-truth model

Local authoritative for: completed business transactions (sales, payments,
movements, refunds), password/PIN hashes, device-local settings. Cloud
authoritative for: organization/billing identity, device
enrollment/auth/revocation, feature entitlements (once licensing exists),
and the merge outcome of LWW configuration collisions. **Neither
authoritative for payment data until the payment migration unifies it into
`payments`/`payment_events`.**

## 8. Revised inventory policy

Local: hard-reject oversell per till (unchanged `SaleService`). Cloud:
never reject a completed sale; derive balances from movements; **flag**
cross-till negative aggregate as a reconciliation exception. Optional later:
per-merchant `allow_negative_stock` toggle (default off).

## 9. Revised sale sync model

`orders`/`order_items`/`bills` stay authoritative local rows. Sync a
**finalized-sale snapshot** on completion/payment, plus append-only
follow-on facts for post-finalize corrections (void/cancel/discount). No
`SaleService` rewrite.

## 10. Revised payment migration

P-1 tests → P-2 authoritative+atomic+throwing dual-write → P-3 historical
backfill → P-4 migrate readers → P-5 retire `payment_details`. P-1/P-2
block SYNC-0; the rest overlaps later stages. `payments`/`payment_events`
becomes the sole sync source only after P-2 (+P-3 for history).

## 11. Revised device authentication

Rotatable bearer (access + device-bound refresh), OS-keystore-protected,
revocable via `devices.status`, in a signed envelope that allows a later
drop-in upgrade to asymmetric device signatures. No mTLS.

## 12. Revised transfer model

Two-phase: source `transfer_out` = dispatch (stock leaves immediately);
destination `transfer_in` = receipt (staff confirm physical arrival),
mirroring PO receiving. Stock is "in transit" between the two. Requires
product sign-off; replaces the current single-DB atomic completion for the
multi-location case.

## 13. Revised cloud authorization

Transport auth (enrolled, non-revoked device → org identity) **separated
from** business validation (entity ownership, state-machine legality,
feature entitlement, actor recording + anomaly flags, sequence
monotonicity). Cloud does **not** re-run per-cashier permission checks.

## 14. Revised cursor/inbox model

`{ insert inbox batch; advance cursor }` = one transaction. Apply = a
separate transaction per row. Idempotency via `sync_inbox.uid` PK absorbs
any re-fetch. Proven lossless against the three crash scenarios (Issue 9).

## 15. Revised scale model

Snapshot sync (~6–8 records/sale). Single Postgres + `organization_id`
partitioning (day one) + read replica for pull + jittered backoff and
server rate-limiting (for reconnection storms) is **sufficient to ~3,000
merchants**. 10,000+ needs sharding + an upload queue + event archival —
absorbable behind the unchanged `/sync/*` contract.

## 16. Revised failure / conflict UX

Locally-completed actions are never silently reversed or dropped. Rejected
events are retained as flagged `needs-reconciliation` facts, surfaced
non-blockingly to the cashier, as a queue to the manager, and as a
dashboard to support. Resolution is a compensating action, never a silent
un-happening. Auto-resolve only idempotent/commutative/LWW cases.

## 17. Revised sync roadmap

- **SYNC-0a — Payment unification** (Issue 3, P-1/P-2): make
  `payments`/`payment_events` authoritative, atomic, tested. *Blocks
  everything. Highest risk. Isolated milestone.*
- **SYNC-0b — Identity/foundation:** promote `uid` to load-bearing on
  orders/order_items/bills + add order/bill uid to payments; convert the two
  hard-deletes (transfer/PO line) to tombstones; exclude `stock_quantity`
  from product sync; backfill/tighten `organization_id`.
- **SYNC-A — Outbox/inbox/sync_state tables**, wired to `inventory_movements`
  first (lowest risk).
- **SYNC-B — Cloud contract** against a minimal real backend.
- **SYNC-C — Upload + idempotency + backoff/rate-limit.**
- **SYNC-D — Download + cursor (single-transaction boundary, Issue 9).**
- **SYNC-E — Entity sync in order:** inventory movements → audit events →
  payment events (needs SYNC-0a) → finalized-sale snapshots (needs SYNC-0b)
  → catalogue (LWW, exclude stock_quantity) → PO/transfer (two-phase,
  state-machine re-validation).
- **SYNC-F — Inventory + wallet reconciliation flags** (Issues 1, 7, 8).
- **SYNC-G — Device auth** (rotatable bearer).
- **SYNC-H — Recovery.**
- **SYNC-I — Observability + conflict UX** (Issue 11).

---

## FINAL GO / NO-GO

### GO WITH CHANGES

The transport architecture is approved. The following **decisions must be
resolved before SYNC-0 begins** — the first three are product/business
decisions that are not the engineering team's to make unilaterally:

1. **Inventory oversell policy (product decision).** Confirm: local tills
   hard-reject as today; the cloud accepts completed sales as immutable
   facts and *flags* cross-till oversell rather than preventing it. Confirm
   whether a per-merchant `allow_negative_stock` opt-in is in scope later.
2. **Transfer semantics (product decision).** Confirm the move to two-phase
   dispatch/receipt (stock in transit), replacing today's atomic completion
   for multi-location. Confirm whether destination receipt is an explicit
   staff action (recommended) or auto-applied on sync.
3. **"Completed locally, rejected by cloud" UX (product decision).** Confirm
   the reconciliation-flag model (retain + flag + compensate) and that
   merchants are told, in plain terms, that offline tills can collectively
   oversell and that some events may need reconciliation.
4. **Payment unification sequencing (engineering, but gating).** Confirm
   SYNC-0a lands — authoritative, atomic, tested `payments`/`payment_events`
   — *before* any sync transport, and that `payment_details` is retired last
   after readers migrate.
5. **`uid` promotion + `stock_quantity` exclusion + tombstones**
   (engineering). Confirm SYNC-0b scope.
6. **Device auth baseline (engineering/security).** Confirm rotatable
   bearer + OS keystore for SYNC-G, with an asymmetric-signature upgrade
   path.
7. **Cursor/inbox transaction boundary (engineering).** Confirm the
   single-transaction rule (Issue 9) is a hard implementation requirement.

None of these is a redesign. The outbox/inbox spine, idempotency model,
ordering model, and contract all stand. Resolve the seven decisions, land
SYNC-0a/0b, and implementation can proceed.

---

## Corrections to Milestone 9 (explicit)

For the record, where the prior report was wrong:

1. **Inventory (M9 §10):** claimed overselling is "already the existing
   single-till behavior… a soft warning, not a hard block," citing the M4
   doc. **False.** Current behavior hard-rejects oversell everywhere
   (`sale.ts:409`, `inventory.ts:196/293`, `recordTransfer`); M4 §12 says
   negative stock is *prevented*. The "extend existing policy" framing was
   built on a fabricated citation.
2. **Sale event sourcing (M9 §2/§10):** recommending
   orders/order_items/bills become event-stream projections was
   overengineered and contradicted the explicit instruction not to rewrite
   `SaleService`. Retracted in favour of canonical-rows-plus-facts.
3. **Payment (M9 §22):** correctly named the dual-write a blocker but
   missed that it is **error-swallowing and untested** (`payment.ts:666`)
   and that **neither** payment table is currently complete (retail absent
   from `payment_details`; hospitality unreliable in `payments`).
4. **Cursor/inbox (M9 §6.2):** the "advance cursor before apply" wording
   permitted a lossy two-transaction implementation; the single-transaction
   boundary must be explicit.
5. **Transfers (M9 §13):** described asymmetric two-sided completion as a
   minor "recommendation" without confronting that today's atomic model is
   structurally single-database and cannot cross two offline DBs — it is a
   real behavior change requiring sign-off.
6. **products classification (M9 §2):** missed that `stock_quantity` is a
   ledger mirror and would double-count if synced as part of the product row.

---

**STOP AFTER THE REVIEW.** No code, migrations, dependencies, or schema
were created or modified as part of this milestone.
