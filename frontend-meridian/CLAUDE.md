# Meridian POS — project notes for Claude Code

Read this before making changes. It's the fastest way to get oriented.

## What this is

A single-page point-of-sale app: register, tables, kitchen display, orders,
stock, customers/loyalty, team/timesheets, cash drawer, reports, an AI
assistant, and a self-service kiosk mode. Vanilla JavaScript, no framework,
no build tooling beyond string concatenation.

**The till server is the source of truth.** Signed in to a till, every price, tax figure, total, stock level,
refund, report and setting is the server's (`PlemmoAPI` in `src/00-plemmo-api.js` and the `03*-plemmo-*.js`
adapters); a failed request changes nothing on screen. The local state object `S` is a cache of what the
server returned, and `localStorage` only keeps this device's own preferences. Anything a screen cannot get
from the server is hidden or labelled, never faked. The older standalone behaviour described below applies only
when no server is reachable. The product name and links come from the server (`brand/brand.json`, `GET /api/brand`).

## Build

```bash
./build.sh
```

Concatenates everything in `src/` (in filename order) into
`dist/meridian-pos.html` — one self-contained file with inline `<style>` and
`<script>`. Open that file directly in a browser, or serve it statically.
There's no dev server requirement; `python3 -m http.server` from `dist/`
works fine for local testing.

Re-run `./build.sh` after every edit to `src/*` — the dist file is a build
artifact, not something to hand-edit.

## File order matters

The six files in `src/` are concatenated in this order and depend on
declarations earlier in the sequence (later files call functions/use `const`s
defined in earlier ones, no modules/imports):

| File | Contains |
|---|---|
| `01-shell.html` | `<head>`, fonts, the entire CSS design system, `<body>` skeleton, opening `<script>` |
| `02-data.js` | Utilities (`money`, `esc`, `uid`, date helpers), icon set (`ic()`), sample menu/catalog data, the state store (`save`/`loadState`), `buildBusiness()`, `genHistory()` (demo data generator) |
| `03-app-shell.js` | Session state (`U`), permissions (`can()`), modal/drawer/toast/popover system, command palette, PIN lock screen, onboarding wizard |
| `04-register-kitchen.js` | Register (cart, modifiers, discounts, payments, receipts), tables floor plan, kitchen display, order history & refunds |
| `05-backoffice.js` | Items & stock, customers/loyalty, team/timesheets, cash drawer, settings |
| `06-dashboard-ai-kiosk.js` | Home dashboard, reports, end-of-day report, AI assistant, self-service kiosk, all global event wiring, the boot sequence |

If you add a new file, insert it in the right position in this list **and**
update `build.sh`'s `cat` command to match.

## Core architecture

- **One global state object, `S`**, created by `buildBusiness(cfg)` in
  `02-data.js`. Shape:
  ```
  S = { settings, roles, categories, modGroups, products, employees, shifts,
        customers, orders, tickets, tables, held, stockLog, drawer }
  ```
  `orders` is the central entity — it drives stock deduction, loyalty points,
  kitchen tickets, cash drawer totals, and every report.

- **Every mutation goes through `save()` / `saveNow()`** (in `02-data.js`),
  which writes `S` to `localStorage`. There is no other persistence path —
  if you add a new field to `S`, it's automatically saved; you don't need to
  touch the save logic itself.

- **Rendering is a full re-render per view, no virtual DOM.** `render()` /
  `renderView()` in `03-app-shell.js` rebuild the current view's HTML from
  scratch on every state change via `.innerHTML =`. Views are registered in
  the `VIEWS` object (e.g. `VIEWS.pos`, `VIEWS.reports`) as functions
  returning an HTML string. An `AFTER` hook per view runs post-render setup
  (focus, scroll position, etc.) if needed.

- **All interactivity is event delegation, not per-element listeners.**
  Three attributes drive everything, wired once in `06-dashboard-ai-kiosk.js`:
  - `data-act="handlerName"` + a click → calls `A.handlerName(dataset, el, event)`
  - `data-in="handlerName"` + input → calls `IN.handlerName(value, el)`
  - `data-ch="handlerName"` + change → calls `CH.handlerName(value, el)`

  To add a new button, give it `data-act="myThing"` and define
  `A.myThing = (d, el) => { ... }` anywhere in the codebase — no manual
  `addEventListener` needed.

- **Modals/drawers/popovers** go through `modal()`, `drawer()`, `popover()`,
  `confirmBox()`, `promptBox()` in `03-app-shell.js` — use these rather than
  hand-rolling new overlay markup.

- **Money, dates, IDs**: always use the existing helpers (`money()`, `r2()`,
  `fmtT()`/`fmtD()`/`fmtDT()`, `uid()`) rather than reformatting inline —
  they're what keeps currency/rounding/timezone handling consistent.

- **Icons**: `ic('name', size)` renders inline SVG from the `ICONS` map in
  `02-data.js`. Add new icons there rather than pasting raw SVG into views.

## The AI assistant

`06-dashboard-ai-kiosk.js` — `VIEWS.assistant`. Tries `window.claude.use('sample')`
(Anthropic's artifact runtime capability) first; if unavailable, falls back to
`localAnswer()`, a rule-based/regex engine over `snapshot()` (a JSON summary
of the live business state) so the assistant still answers something useful
outside that hosting environment. If you change `snapshot()`'s shape, check
both the Claude prompt construction (`buildTurns`) and `localAnswer()` still
make sense together.

## Known limitations

- A till with no server connection falls back to the cached local flow; the connected-only screens (stocktake,
  suppliers and purchase orders, period reports, options) are not offered then.
- Cards are recorded by staff as approved on their own terminal (no provider integration yet); the till labels
  such takings as not confirmed by a card provider.
- Auth is the server's: account sign-in plus a per-staff PIN checked on the server.

## Conventions to keep

- No dependencies, no build step beyond concatenation. Keep it that way
  unless there's a strong reason to introduce tooling.
- British English in user-facing copy, £ as the default currency symbol
  (configurable per-business in settings).
- Keep new views/components self-contained in the file where they
  thematically belong (see table above) rather than splitting further.
