# Plemmo Cloud — production deployment (SYNC-D)

The standalone cloud sync service: an Express app (`cloud/server.ts`) over a
`CloudStore`. In production the store is `PostgresCloudStore` on managed
PostgreSQL. The desktop client never runs any of this — it only speaks the
HTTP sync protocol.

> **Deployment status in this milestone:** NOT executed against a hosted
> provider — no managed-Postgres credentials were available in the build
> environment. Everything below is validated against a REAL local PostgreSQL
> 16 server (migration runner, concurrency, transactions, the async HTTP API).
> The single remaining external step is provisioning the managed instance and
> setting `PLEMMO_CLOUD_DB_URL`. See "Remaining external step".

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
