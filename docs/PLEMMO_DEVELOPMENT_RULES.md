# Plemmo EPOS — Development Rules

These are the rules that keep a financial product correct while it is being
built quickly, mostly by one developer working through AI coding agents. They
are short on purpose. Read them before changing anything in `main/`.

If a rule blocks something you need to do, the answer is to change the rule
deliberately in a PR — not to make an exception quietly.

---

## The ten rules

### 1. Do not put provider-specific payment logic inside Sale

A sale knows that it was paid, by how much, and with what kind of tender. It
must never know that Teya returns a particular auth-code shape or that SumUp
needs a terminal handle. Provider detail lives behind a payment adapter
interface. If `SaleService` has to change to add a provider, the abstraction is
in the wrong place.

### 2. Do not put retail-specific logic into hospitality modules

### 3. Do not put hospitality-specific logic into retail modules

Hospitality and retail are peer verticals over one core. They may both depend
on Core; neither may depend on the other. A café install must be able to run
with the retail module absent, and a phone shop with the hospitality module
absent. If you find yourself importing across that line, the thing you need
belongs in Core.

### 4. Do not use floating point for financial calculations

Use `main/core/money.ts`. Integer minor units, explicit rounding mode, and
`allocateMinor()` whenever a total is split across parts so the parts always
sum back exactly.

Never write `Math.round(value * 100)`. It hard-codes a 2-decimal currency and
it inherits the input's binary representation error — `Math.round(1.005 * 100)`
is 100, not 101.

`decimal.js` inside the tax engine is fine and stays: it is the right tool for
evaluating tax rules. Convert its output to minor units at the boundary.

### 5. Distributed entities must have collision-safe IDs

Anything that can be created on more than one device — sale, sale item,
payment, refund, inventory movement, cash session, audit event, device — gets a
ULID from `main/core/ids.ts`. Never an autoincrementing integer.

Rows that never leave the machine (settings, sequences, local caches) may keep
integer keys.

### 6. Database changes require migrations

- Append a new entry to `MIGRATIONS` in `main/db.ts`. **Never edit an existing
  one.** They are historical fact; editing one silently diverges every install
  that already ran it.
- A new table goes in the migration only, not in `createSchema()`. Fresh
  installs run every migration from v1, so they get it either way, and putting
  it in both is how the two paths drift apart.
- Adding a column to an existing table means a guarded `ALTER` in a migration,
  even if you also touched `createSchema()` — otherwise existing installs never
  receive it. `tests/upgrade-path.test.ts` exists to catch exactly this.
- Run `npm run test:upgrade-path` and `npm run test:schema-health` after any
  schema change. Health check must report **zero drift** between a migrated old
  install and a fresh one.
- Prefer additive and reversible. A destructive migration needs a written
  data-preservation plan and human review before it is written.

### 7. Do not break offline operation

The sell path — open a sale, add items, take payment, print — must complete
with no network, forever, with no degradation. Nothing in that path may await
a remote call, and no feature may make trading conditional on connectivity.

### 8. Do not introduce cloud dependencies into core POS workflows

Cloud is for coordination, reporting, licensing and backup. If the cloud is
unreachable the till keeps trading and queues what it needs to send. A cloud
call belongs behind a durable outbox, never inline in a business transaction.

### 9. Do not rewrite working hardware integrations without a concrete reason

`main/printers/thermal.ts`, `main/printers/profiles.ts` and the barcode
scanner hook are production-tested against real hardware, including Windows
spooler behaviour and ten typed failure classes. Wrap them, extend them, add
new device types beside them — do not refactor them for tidiness.

### 10. Do not perform giant refactors without an approved migration plan

Incremental, always-runnable, always-green. If a change cannot be landed with
the app still working and the suite still passing, it needs to be split until
it can. "Rewrite X" is a proposal, not a task.

---

## Working with AI agents

The architecture is deliberately shaped so agents can move fast in safe areas
and are fenced out of dangerous ones. Three zones:

### 🟢 Green — agent-led

New vertical modules, retail UI, CRUD screens, reports, adapters written
behind an existing interface, component work, tests. Build freely against the
suite.

### 🟡 Amber — agent drafts, human reads every line

Anything in `main/core/`, tax usage, inventory writes, refund logic, anything
that computes or persists money. Tests must exist **before** the change, not
after.

### 🔴 Red — human-designed; agent may only fill in mechanical detail

Never hand these to an agent unsupervised:

| Area | Why |
|---|---|
| Existing entries in `MIGRATIONS` | Editing one corrupts every install that ran it. Append only. |
| `applyPaymentBatch()` in `main/routes/bills.ts` | Idempotency replay, integer cents, transaction-ref uniqueness, loyalty side-effects and order completion are interleaved in ~90 lines. It looks refactorable and is not. |
| `main/services/tax-engine.ts` Decimal core | Rounding remainders are load-bearing. "Simplifying" to floats produces penny errors that surface months later. |
| `getDatabase()` / `withTxn()` | ~700 call sites. The synchronous better-sqlite3 API is *why* the money code is correct — introducing async here breaks atomicity without failing a single test. |
| Identifier and money-unit migrations | One-way doors. Cheap now, impossible once merchants are live. |
| Sync conflict policy (when it exists) | Failure modes are subtle and only appear under real partition. |

### Before asking an agent to change something

1. Does a test cover the behaviour you are about to change? If not, write it
   first.
2. Is the file small enough to be held in context? `main/db.ts` (4.9k lines)
   and `frontend/src/app/(dashboard)/settings/page.tsx` (4.5k lines) are not.
   Split before editing, or edit by exact anchored replacement.
3. Would this change be visible in `npm run test:upgrade-path`? If it touches
   the schema, it must be.

---

## Verification expectations

| Change | Minimum |
|---|---|
| Docs | link check, `git diff --check` |
| Frontend | `npm run lint`, `npm run build:frontend` |
| Main process / API | `npm run lint`, `npm run build`, focused tests |
| Anything touching money | `npm run test:plemmo-money` plus the payment/tax suites |
| Schema migration | `npm run test:upgrade-path`, `npm run test:schema-health` — both fresh and upgrade paths |
| Identifiers | `npm run test:plemmo-identifiers` |
| Release / packaging | full `npm test`, target-platform build |

Run the full `npm test` before any release, and whenever a change crosses more
than one subsystem.

---

## Stop and ask a human

Do not guess on any of these:

- A destructive or irreversible migration.
- Anything that could invalidate existing merchant data.
- Signing certificates, provisioning profiles, private keys, production
  credentials.
- Third-party licence questions.
- Changes to authentication or authorization architecture.
- Replacing a major working subsystem.
