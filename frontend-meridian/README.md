# Meridian POS

A single-page point-of-sale app — register, tables, kitchen display, order
history, stock & items, customer loyalty, team/timesheets, cash drawer,
reports, an AI assistant, and a self-service kiosk mode. Vanilla JavaScript,
no framework, no backend — runs entirely client-side.

Try it: run `./build.sh`, open `dist/meridian-pos.html` in a browser, and
pick **"Open the demo café"** at setup for nine weeks of sample data.

Demo PINs: Jordan (owner) `1234`, Priya (manager) `1111`, Tom `2222`,
Leah `3333`, Marco `4444`.

## Quick start

```bash
git clone <this-repo>
cd meridian-pos
./build.sh
open dist/meridian-pos.html   # or just double-click it
```

No `npm install`, no dev server required. If you want one anyway for local
testing (e.g. to test on a phone on the same network):

```bash
cd dist && python3 -m http.server 8080
```

## Project structure

```
.
├── CLAUDE.md          ← read this first if you're working in Claude Code
├── README.md          ← this file
├── build.sh           ← concatenates src/ into dist/meridian-pos.html
├── src/
│   ├── 01-shell.html            head, CSS design system, body skeleton
│   ├── 02-data.js               utilities, icons, sample data, state store
│   ├── 03-app-shell.js          nav, modals, command palette, lock, onboarding
│   ├── 04-register-kitchen.js   register, payments, tables, kitchen display
│   ├── 05-backoffice.js         items/stock, customers, team, cash drawer
│   └── 06-dashboard-ai-kiosk.js home, reports, AI assistant, kiosk, wiring
└── dist/
    └── meridian-pos.html        ← built output, the one file you actually run
```

`src/` is edited; `dist/meridian-pos.html` is generated. Re-run `./build.sh`
after any change under `src/`.

## Architecture in short

- One global state object `S` (products, orders, employees, customers,
  tables, kitchen tickets, cash drawer sessions, etc.), persisted to
  `localStorage` on every change.
- Full-view re-render on state change — no virtual DOM, no framework.
- All interactivity via event delegation: `data-act` / `data-in` / `data-ch`
  attributes map to handler functions in the `A` / `IN` / `CH` objects.
- No backend, no API, no real multi-tenancy or multi-device sync — see
  `CLAUDE.md` → "Known limitations" for the full list and what a real
  backend integration would need to change.

Full architecture notes, the state shape, and coding conventions are in
[`CLAUDE.md`](./CLAUDE.md) — Claude Code reads it automatically, and it's
worth a read yourself before diving in.

## Features

Register · order types (dine-in/takeaway/delivery/retail) · item modifiers ·
discounts with manager PIN approval · split payments · printed-style receipts
· table floor plan · kitchen display system · order history & refunds ·
self-service kiosk with upsells · stock tracking & margins · customer loyalty
(points + tiers) · team timesheets & role permissions · cash drawer counting
· reports with period comparisons, a busy-times heatmap, and CSV export · an
AI assistant (Claude-powered where available, with a built-in offline
fallback) · light/dark themes · 5 accent colours · responsive down to phone
width.

## License

Add one before you make this repo public.
