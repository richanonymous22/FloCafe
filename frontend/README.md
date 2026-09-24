# FloUI (station apps only)

> **The merchant UI has moved to Meridian** (`frontend-meridian/`), which the
> embedded server now serves as the primary Plemmo merchant frontend. The former
> Next.js merchant dashboard, auth and setup routes were retired in the
> Meridian × Plemmo integration (see `docs/MERIDIAN_PLEMMO_MASTER_INTEGRATION.md`).

This Next.js 16 / React 19 app now builds **only the station surfaces** that the
device servers still serve as a static export:

- **`/kds-standalone`** — the Kitchen Display station UI, served by the KDS
  server (`main/kds-server.ts`, port 3002).
- **`/server-standalone`** — the customer-facing server/display UI, served by
  the server-app (`main/server-app.ts`).

Everything else (register, orders, products, inventory, customers, tables,
reports, settings, auth, setup) is now provided by Meridian.

## Build

```sh
NEXT_BUILD_MODE=desktop npm run build   # static export → frontend/out
```

`main/kds-server.ts` and `main/server-app.ts` serve `frontend/out` (packaged:
`resources/frontend-out`). The main application window is served by
`main/server.ts`, which now serves the Meridian bundle by default
(`PLEMMO_MERIDIAN_UI=0` falls back to this app's root stub).
