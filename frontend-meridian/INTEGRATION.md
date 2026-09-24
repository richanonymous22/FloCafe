# Meridian → Plemmo integration status

Meridian is the new merchant frontend for Plemmo (FloCafe). Its **stack is
preserved** (vanilla JS, no framework, concatenation build) — see the brief and
[`docs/MERIDIAN_PLEMMO_MASTER_INTEGRATION.md`](../docs/MERIDIAN_PLEMMO_MASTER_INTEGRATION.md)
for the full audit and feature cross-map.

## How it is served

The embedded Plemmo Express server (`main/server.ts`) can serve the built
Meridian bundle as the active merchant UI instead of the Next.js export.

```sh
npm run build:meridian          # builds frontend-meridian/dist/meridian-pos.html
PLEMMO_MERIDIAN_UI=1 npm run dev # or set the flag before launching Electron
```

- Flag off (default): the existing Next.js frontend is served — nothing changes.
- Flag on: Meridian is served for every non-`/api`, non-`/kds` route.

This flag exists so the migration is **staged and reversible** — the current
app is never broken while Meridian reaches feature parity.

## What is real vs. still to wire

- **Real now:** `src/00-plemmo-api.js` — the `window.PlemmoAPI` client. Real
  JWT login against `/api/auth/login` + `/api/auth/tenants/select`, token
  storage, authenticated JSON requests, 401 handling, network-failure
  online/offline signalling, idempotency keys, and thin resource helpers that
  mirror Plemmo routes.
- **Still to wire (per the master map):** the `A.*`/`IN.*`/`CH.*` handlers and
  `save`/`loadState` in `src/02-data.js` still read/write the local `S` object.
  These become async and call `PlemmoAPI` so Plemmo is the source of truth. Each
  view is migrated and verified before the corresponding old Plemmo screen is
  retired.

Do **not** re-introduce a second backend, a second database, or a second sync
protocol in Meridian. Plemmo owns persistence, money, auth, tenancy, licensing,
and sync.
