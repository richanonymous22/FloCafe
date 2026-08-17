# Plemmo Cloud — production deployment (SYNC-D)

The standalone cloud sync service: an Express app (`cloud/server.ts`) over a
`CloudStore`. In production the store is `PostgresCloudStore` on managed
PostgreSQL. The desktop client never runs any of this — it only speaks the
HTTP sync protocol.

> **Deployment status in the SYNC-D milestone (historical):** NOT executed
> against a hosted provider — no managed-Postgres credentials were available in
> the build environment at the time. Everything below was validated against a
> REAL local PostgreSQL 16 server (migration runner, concurrency, transactions,
> the async HTTP API). See "Remaining external step".
>
> ---
>
> #### Verification update — 2026-08-17 (post-SYNC-F)
>
> A hosted **Neon PostgreSQL** project was subsequently created, and from the
> **real Windows client** `npm run test:sync-d-production` was run against that
> hosted Neon database with the result **43 passed, 0 failed** — exercising real
> hosted PostgreSQL + real HTTP end-to-end: migration, concurrency, duplicate
> handling, device enrollment, multi-entity sync, security, and observability.
>
> **Now proven:** hosted Neon PostgreSQL connectivity; the SYNC-D real
> hosted-DB integration test against Neon.
>
> **Still NOT done** (a permanent production service is more than one green
> test run): a permanent public cloud **API deployment**; a production
> **domain / HTTPS**; production **CI/CD**; **monitoring / alerting**; and
> documented production **backup / restore** procedures. Provisioning the
> managed instance is done; standing up and operating the service is not.

## Production database decision

**Managed PostgreSQL** (AWS RDS / GCP Cloud SQL / Neon / Supabase-Postgres).
Chosen for transactional integrity (exact idempotency + gapless per-org
sequencing), `UNIQUE(entity_type, entity_uid)` idempotency, automated backups
+ PITR, managed patching/failover, and ample headroom for 3,000 merchants of
append-only event traffic — the simplest *reliable* option, no DB servers to
run. VPS-hosted Postgres works with the same adapter but adds ops burden;
Supabase is just one managed-Postgres provider via the same connection string.

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `PLEMMO_CLOUD_DB_URL` | cloud service | Postgres connection string. Selects the Postgres backend (`cloud/factory.ts`). |
| `PLEMMO_SYNC_ENABLE_DEV_ENROLL` | cloud service | Must be UNSET/false in production (gates the dev-enroll endpoint). |
| `PORT` | cloud service | HTTP listen port. |
| `PLEMMO_SYNC_URL` | desktop client | The cloud base URL the POS talks to. |
| `PLEMMO_SYNC_ENV` | desktop client | `development` \| `staging` \| `production` (guards; production requires https). |

No production URL or secret is hardcoded anywhere in source.

## Deploy procedure (expand/contract)

```sh
# 1. Provision managed PostgreSQL; capture its connection string.
export PLEMMO_CLOUD_DB_URL='postgres://USER:PASS@HOST:5432/plemmo?sslmode=require'

# 2. Run migrations BEFORE rolling out server code that depends on them.
npx ts-node cloud/run-migrations.ts
#   → [cloud-migrate] applied: [1], now at version 1

# 3. Roll out the cloud service (PLEMMO_CLOUD_DB_URL set, dev-enroll disabled),
#    e.g. behind TLS + a shared rate limiter/gateway.

# 4. Smoke-check: POST /sync/v1/enroll with a token, then a signed upload/pull.
```

Rollback: additive DDL is data-preserving; add a paired down-migration only
when a change is not additive. Backups: managed automated backups + PITR
(point-in-time recovery) — verify a restore before go-live.

## Local integration (what IS proven here)

A real local PostgreSQL is enough to run the full production path:

```sh
pg_ctlcluster 16 main start                       # or any local/hosted PG
createdb plemmo_sync_test
export PLEMMO_CLOUD_DB_URL='postgres://USER:PASS@127.0.0.1:5432/plemmo_sync_test'
npm run test:sync-d-production                     # real PG + real HTTP suite
```

The suite self-skips if no PostgreSQL is reachable, so CI stays green without
it.

## Remaining external step

Provision the managed PostgreSQL instance and set `PLEMMO_CLOUD_DB_URL` in the
cloud service's environment. No code change is required — the adapter, the
migration runner, and the async HTTP server are complete and proven against
real PostgreSQL.

---

## Permanent production service (COMMERCIALIZATION, Part A)

The smallest reliable architecture: **one stateless Node service**
(`cloud/serve.ts`, containerized by `cloud/Dockerfile`) behind the managed
PostgreSQL, fronted by the platform's HTTPS load balancer. No second backend,
no protocol redesign — the same `createCloudServer` proven in dev/test.

### Operational endpoints (built)

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness — process up. For the load balancer. |
| `GET /ready` | none | Readiness — datastore reachable (trivial round-trip). |
| every response | — | `X-Plemmo-Protocol` header (protocol versioning, Part H). |

### PROVEN ALREADY

- Provider-neutral `CloudStore`, async PostgreSQL adapter, real migration
  runner, per-org atomic sequencing, idempotency, security (device-signed,
  org/location isolation, revoked/tampered rejection), rate limiting.
- Hosted **Neon PostgreSQL** connectivity + `test:sync-d-production` **43/43**
  from the real Windows client (dated verification 2026-08-17, above).
- Health/readiness endpoints; protocol version header; graceful shutdown
  (SIGTERM/SIGINT drain); production server entrypoint; container image with a
  built-in `HEALTHCHECK`; one-shot migration entrypoint (`run-migrations.ts`).

### STILL REQUIRED (external — needs the user)

These need external provisioning/credentials and are **NOT done**; the code is
ready to consume them:

1. A cloud host/account (container platform or VM) to run the image.
2. A managed PostgreSQL instance + its `PLEMMO_CLOUD_DB_URL` secret.
3. A production **domain** + **TLS certificate** (HTTPS terminates at the LB).
4. A **secrets manager** binding for `PLEMMO_CLOUD_DB_URL` (never committed).
5. **CI/CD**: build → run `run-migrations.js` → roll out `serve.js`, with a
   rollback step (previous image + expand/contract migrations so rollback is
   schema-safe).
6. **Monitoring/alerting** wired to `/health`, `/ready`, and the sync log.
7. Verified **backup/restore** on the managed instance (PITR is available on
   the chosen providers; a restore drill must actually be run).

### PRODUCTION RISK (to weigh before pilot)

- The in-memory rate limiter is per-instance; a multi-instance deployment needs
  a shared limiter (gateway/Redis) — the interface is unchanged, see
  `createRateLimiter`.
- `/ready` proves DB reachability, not migration currency — the deploy order
  (migrate first) is what guarantees schema compatibility.
- Protocol is `v1`; a breaking change must bump `PLEMMO_PROTOCOL_VERSION` and
  gate old clients.

**STOP — external dependency.** A permanent public deployment cannot be
completed from here: it requires the user to provide a cloud host, a managed
PostgreSQL instance + URL secret, and a domain/TLS. Everything the service
needs in code is built and proven against real PostgreSQL; the remaining steps
are provisioning, not code.
