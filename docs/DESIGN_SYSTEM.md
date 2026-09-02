# Plemmo EPOS — Design System

Extracted from the supplied reference (`Serva pos html`, ~40 screens covering
retail, hospitality, back-office and admin) and ported into the existing
shadcn/ui + Tailwind v4 frontend. This is the source of truth for the UI/UX
redesign — every screen should be built from these tokens and primitives, not
styled ad hoc.

**Integration strategy:** the frontend already uses shadcn/ui (`class-variance-
authority` + Tailwind v4 `@theme` semantic tokens) across `src/components/ui/`.
Rather than replacing that architecture, we **re-theme its semantic tokens**
(`--primary`, `--background`, `--radius`, font, etc.) to the Serva values —
this re-skins every existing primitive and every page that consumes them in
one place — and **extend** it with the Serva-specific primitives shadcn
doesn't ship (KPI tiles, segmented "chip" filters, POS product tiles, status
pills, empty states). This preserves every backend contract; nothing about
data-fetching or business logic changes.

## Brand

| Token | Value | Use |
|---|---|---|
| Primary (orange) | `#FF5E00` | primary actions, active states, focus ring |
| Primary hover/light | `#FF8A3D` | hover of primary |
| Primary tint | `#FFF1E9` | primary-tinted backgrounds (badges, highlights) |
| Ink (near-black) | `#1A1A1A` | headings, high-emphasis text |

## Semantic status colors (color + tint pair each)

| Status | Color | Tint |
|---|---|---|
| Success | `#40B119` | `#ECF8E7` |
| Warning | `#FFB833` | `#FFF6E5` |
| Danger | `#E5484D` | `#FDECEC` |
| Info (blue) | `#3B82F6` | `#EEF3FF` |
| Accent (purple) | `#8A3FCB` | `#F9EFFF` |

Used consistently as `color`-on-`tint` pills for order/payment/sync/license
status everywhere (never a bespoke one-off color per screen).

## Surfaces

| Token | Value |
|---|---|
| Page background | `#F7F7F8` |
| Card background | `#FFFFFF` |
| Border (hairline) | `#ECECEF` |
| Border (stronger) | `#E0E0E5` |
| Text muted | `#71717A` |
| Text faint | `#A1A1AA` |
| Hover surface | `#F4F4F5` |

## Typography

- Font: **DM Sans** (Google Fonts, weights 400/500/700), replacing Geist.
- Headings use `--ink`; body copy defaults to `--ink`, secondary copy to
  `--mute`, tertiary/placeholder to `--faint`.

## Geometry

| Token | Value | Use |
|---|---|---|
| Radius (default) | `14px` | inputs, buttons, list rows |
| Radius (large) | `18px` | cards |
| Radius (xl) | `24px` | modals, large panels |
| Sidebar width (expanded) | `264px` | |
| Sidebar width (collapsed) | `80px` | |
| Topbar height | `70px` | |

## Elevation

| Token | Value | Use |
|---|---|---|
| `--sh` | `0 1px 2px rgba(26,26,26,.05)` | resting cards |
| `--sh-md` | `0 8px 24px -12px rgba(26,26,26,.18)` | popovers, dropdowns |
| `--sh-pop` | `0 20px 52px -18px rgba(26,26,26,.34)` | modals, drawers |

Motion easing: `cubic-bezier(.2,.8,.25,1)`. Interactive elements (buttons,
chips) scale to `.94–.96` on `:active` for tactile touch feedback — important
for the till, which is touch-first.

## Component specs (from the reference, ported as shadcn variants)

- **Button** — height `48px`, radius `13–14px`, weight `700`, `14.5px` type.
  Primary = orange fill/white text; secondary = white fill/hairline border;
  destructive = red. `active:scale-96` for touch feedback.
- **Input / select / textarea** — height `48px` (textarea auto), radius
  `12px`, hairline border, **orange focus ring** (`0 0 0 3px` primary tint),
  label above in `12.5px/600/muted`, optional hint below in `11.5px/faint`.
- **Chip / segmented filter** (`chipf`) — height `48px`, radius `13px`,
  hairline border; **active state = solid black fill**, white text — used for
  category filters, till mode toggles.
- **Pill / status badge** — small (`11.5px/700`), color-on-tint per the
  semantic status table, leading dot indicator.
- **Card** — white surface, `18px` radius, `--sh` resting shadow, header /
  body / footer slots.
- **KPI tile** — card variant with a header label + large numeric value +
  footer trend/comparison.
- **Table** — hairline row dividers, sticky header, muted column headers.
- **Modal / drawer** — `24px` radius (modal) or edge-anchored (drawer),
  `--sh-pop` shadow, dimmed veil backdrop.
- **Toast** — bottom/corner transient notification, status-colored accent.
- **Empty state** — centered icon + heading + short copy + optional primary
  action, used for every zero-data screen (not a bare blank table).

## Application shell

`aside` (sidebar, `264px`/`80px` collapsed) + `header` (topbar, `70px`) +
`main` (page canvas, `--bg` background). The sidebar carries the vertical
switcher (hospitality/retail/admin), primary navigation, and a footer area for
staff/session context. The topbar carries global search, notifications, and —
new for Plemmo — the **connection/sync/license status cluster** (see below).

## Offline / sync / license status (new — no equivalent in the reference)

Plemmo is offline-first; the reference is a cloud-only mockup and has no
notion of this. This status cluster is a **Plemmo-specific addition** to the
topbar, built from the semantic status colors above, backed by the existing
`GET /api/admin/sync-health` (SYNC-G) and local `core/licensing.ts` /
`getSyncHealth` — no new backend capability, only new UI surfacing it:

- **Connection**: online (success) / offline (warning, not danger — offline
  operation is safe and expected) / syncing (info, animated).
- **Sync**: pending count, last sync time, sync failed (danger) if
  `consecutiveFailures > 0`.
- **License**: valid (success, hidden by default) / grace period (warning,
  with days remaining) / revoked or expired (danger, blocks the feature it
  gates — never blocks core offline sale-taking).

A transaction is never left ambiguous: local save confirmation is immediate
and independent of sync status; sync status is reported, never conflated with
"did the sale succeed."

## What is explicitly NOT the direction

The earlier `plemmo-blueprint.html` scratch document (the Phase 2 engineering
blueprint, sometimes called "Plemmo Counter") is an **architecture** document,
not a visual design — it is not used for any visual decision here. The Serva
reference above is the sole visual source of truth.
