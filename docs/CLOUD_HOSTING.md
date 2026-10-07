# Hosting the Plemmo cloud

The cloud is one small stateless container (`cloud/Dockerfile`) plus PostgreSQL. Nothing in it is tied to a
provider, so the choice below is about cost and operations, and can be changed later without code changes.

## What it needs

| Part | Needs | Notes |
| --- | --- | --- |
| Container | 0.25–0.5 vCPU, 256–512 MB, always on, outbound to the database | Node 22; the image has only `express` and `pg` |
| PostgreSQL | 1–2 GB to start | Event data is append-only and grows with sales; plan for a few GB per hundred merchants per year |
| TLS + domain | any domain you control (the product has none built in) | The PaaS options give a free `*.onrender.com`-style address for tests |
| Backups | nightly `cloud/ops/backup.sh` to storage off the database provider | plus the provider's point-in-time recovery |

## Options (verify prices on the vendor's page before buying)

Figures below come from third-party comparison articles read in October 2026, not from the vendors' own
pricing pages. Treat them as orders of magnitude.

| Option | Good for | Watch out for |
| --- | --- | --- |
| **Render** web service + Neon Postgres | Easiest start: deploy from the Dockerfile, managed TLS, health checks, log search | The free web service sleeps after ~15 minutes idle — fine for a test environment (tills queue and retry), not for production; the paid "Starter" instance is always on |
| **Koyeb** | Closest to Fly.io; has a free service with cold starts and a low-cost always-on tier | Smaller ecosystem |
| **Railway** | Pay for what runs; nice dashboard | No free tier any more (trial credit only) |
| **Hetzner Cloud VPS** (Docker or Docker Compose) + Neon | Cheapest always-on option (a few euro a month), full control | You run the box: OS updates, firewall, a reverse proxy for TLS (Caddy), restarts. Data centres are in Germany and Finland, not the UK |
| **Google Cloud Run** (London region) | Scale-to-zero, UK region | Needs a Google Cloud billing account; cold starts; more moving parts |
| **Neon** (PostgreSQL) | Branching, point-in-time recovery (about 6 hours on the free plan, up to 7 days on the first paid plan), regions in London and Frankfurt; you already have a project | Free-plan compute is limited and pauses when idle |
| **Supabase** (PostgreSQL) | Generous free database, London region | Free projects pause after a week of inactivity; point-in-time recovery is an extra monthly charge |

### Recommendation

1. **Now (pilot, test environment):** Render (free or Starter) for the container and your existing Neon
   project in London. Cost is zero to a few pounds a month. Tills keep selling if the cloud sleeps or is down.
2. **Production for the first merchants:** keep Neon on a paid plan (so recovery covers days, not hours) and run
   the container on an always-on plan, or on a small Hetzner VPS if you want the lowest cost and are happy to
   operate a server. Either way run `backup.sh` nightly to storage that is *not* the database provider.
3. **Later (hundreds of merchants):** move the database to a managed plan with high availability and add a
   second container; the limits are already shared across instances (see below).

If a UK-only data location is a requirement for a customer, choose Neon London plus a UK container region
(Cloud Run London, or a UK VPS) and say so in the privacy policy.

## Environment reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `PLEMMO_CLOUD_DB_URL` | yes | PostgreSQL connection string (`postgres://user:pass@host/db?sslmode=require`) |
| `PORT` | no (8080) | listen port |
| `PLEMMO_CLOUD_ADMIN_TOKEN` | yes for operators | bearer token for `/admin/v1/*`; unset = the operator API is closed (503) |
| `PLEMMO_LICENSE_SIGNING_KEY` | yes | Ed25519 private key (PKCS8 PEM; `\n` allowed) that signs licences |
| `PLEMMO_LICENSE_SIGNING_KEY_ID` | no (`k1`) | id the tills use to pick the matching pinned public key (rotation) |
| `PLEMMO_CLOUD_PUBLIC_URL` | recommended | the https address tills use; folded into activation codes |
| `PLEMMO_TRUST_PROXY_HOPS` | yes on a PaaS | number of proxies in front (usually `1`), so rate limits and logs see the real client |
| `PLEMMO_MIN_CLIENT_PROTOCOL` | no (1) | raise to make older tills update (they are told, not served) |
| `PLEMMO_LOG_REQUESTS` | no (on) | set `0` to turn the JSON request log off |
| `PLEMMO_SYNC_ENABLE_DEV_ENROLL` | never | the server refuses to start if this is true |

## Secrets handoff

Secrets are created by whoever owns the account and held in the host's secret store, never in the repository,
a chat, or an image. At handover: (1) the new owner creates the database and the host account; (2) generates a
fresh operator token (`openssl rand -base64 32`) and a fresh licence signing key (`openssl genpkey -algorithm
ed25519`); (3) puts the new **public** key into the next release build's `license-policy.json` (see
`docs/OPERATOR_RUNBOOK.md`), keeping the old public key pinned alongside it until every till has updated;
(4) rotates the operator token and deletes the previous owner's access. The private signing key and the
database password never leave the host's secret store and the owner's password manager.

## Deploying and rolling back

Migrations are forward-only and additive (expand/contract). Order every release:

1. Back up: `PLEMMO_CLOUD_DB_URL=… cloud/ops/backup.sh ./backups`.
2. Run migrations as a one-shot: `docker run --rm -e PLEMMO_CLOUD_DB_URL=… plemmo-cloud node dist/run-migrations.js`.
3. Roll out the new container; watch `/ready` and the request log.
4. **Rollback:** redeploy the previous image. Because migrations only *add* tables and columns, the previous
   image still works against the new schema. A migration that must remove or reshape something is done in two
   releases (stop using it, then drop it) and needs a restore rehearsal first.

## Backups and recovery

* **Nightly:** `cloud/ops/backup.sh` (dump + manifest of row counts + checksum; optional upload command;
  14 days kept locally). Run it from a scheduler (the host's cron, or a GitHub Actions schedule) with the
  database URL in that scheduler's secrets.
* **Monthly, and after any change to the above:** `cloud/ops/restore-rehearsal.sh <dump>` with a role that can
  create databases. It restores into a throwaway database and fails if the checksum, schema version or any
  table's row count differs from the manifest. `tests/cloud-backup.test.ts` runs the same procedure in CI.
* **Point-in-time recovery** is the database provider's feature (a branch restore on Neon); use it for "undo the
  last hour", and the dump for "the provider is gone".
* The tills hold their own complete records and an outbox of unsent events, so a restore of the cloud to an
  older point is repaired by the tills re-uploading what the cloud is missing (uploads are idempotent).

## Monitoring

Uptime check on `GET /ready` (database reachable) every minute from any free monitor, alerting to e-mail or
phone; `GET /health` is liveness only. The service writes one JSON line per request (`ts`, `level`, `id`,
`method`, `path`, `status`, `ms`, `device`) and never bodies, headers or tokens: send the platform's log drain to
any log search. Alert on 5xx rate, 401/429 bursts and `/ready` failures. Operator calls and enrolments are
rate-limited across all instances (120 and 20 per minute per client address); device sync keeps a per-instance
limit of 240 a minute.

## Client compatibility

Every response carries `X-Plemmo-Protocol`; tills send `x-plemmo-protocol`. Raising
`PLEMMO_MIN_CLIENT_PROTOCOL` makes the cloud answer older tills with `426 client_upgrade_required`; the till
keeps selling, queues its events and shows that it must be updated. Use it only after the new release is out.
