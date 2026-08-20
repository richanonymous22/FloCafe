# Plemmo EPOS — Design System

The foundation for the Plemmo frontend rebuild. Everything visual reads from
the tokens defined in `frontend/src/app/globals.css`; components never pick
colours, spacing or type sizes ad hoc. This keeps the product coherent across
retail, hospitality, back office and admin.

> Principle: **simple on the front, powerful in the back.** The interface is
> operational software businesses trust with money and stock — restrained,
> confident, fast. Not a marketing site, not a generic SaaS dashboard.

## Colour

Semantic tokens only. The names are shadcn-compatible so existing screens
inherit the Plemmo palette automatically; new work uses the extended tokens.

| Token | Tailwind class | Use |
| --- | --- | --- |
| `--background` | `bg-background` | App canvas (cool off-white / deep slate) |
| `--surface` | `bg-surface` | Primary card / panel surface |
| `--surface-sunken` | `bg-surface-sunken` | Wells, inset areas, footers |
| `--surface-raised` | `bg-surface-raised` | Surfaces that float above others |
| `--foreground` | `text-foreground` | Primary text |
| `--muted-foreground` | `text-muted-foreground` | Secondary text / metadata |
| `--text-subtle` | `text-text-subtle` | Tertiary text |
| `--border` / `--border-strong` | `border-border` / `border-border-strong` | Hairlines / dividers that must read |
| `--primary` / `--brand` | `bg-primary` / `bg-brand` | Plemmo indigo (#3248FF) — primary actions |
| `--brand-soft` | `bg-brand-soft` | Indigo tint for chips / active states |
| `--success` (+ `-tint`) | `text-success` / `bg-success-tint` | Money-safe confirmation, change due |
| `--warning` (+ `-tint`) | `text-warning-foreground` / `bg-warning-tint` | Low stock, attention |
| `--destructive` / `--danger-tint` | `text-destructive` / `bg-danger-tint` | Errors, voids, danger |
| `--info` (+ `-tint`) | `text-info` / `bg-info-tint` | Neutral information |

State colour is never the only signal — pair it with a label or icon.

## Typography

Geist (sans) + Geist Mono. Utilities in `globals.css`:

- `.tabular-nums` / `.numeric` — **all money, quantities, percentages, IDs.**
  Figures must column-align and never jitter as they change.
- `.font-identity` — monospaced identity strings (Business MID, terminal ID,
  licence keys).

Hierarchy is restrained: page titles are `text-xl`/`text-2xl` semibold, not
oversized marketing headings. Money totals earn the largest weight on a screen.

## Spacing & density

Two density modes, opted into with `data-density`:

- **touch** (`data-density="touch"`) — till, scanning, stocktake. Larger hit
  areas (`--tap`, `--control-h`).
- **comfortable** (default) — back office, admin, reports.

## Shape & depth

Radius is restrained (`--radius: 0.625rem`). Depth comes from spacing,
borders and alignment first; elevation (`--shadow-xs…lg`) is used sparingly.
Avoid the "everything is a floating rounded card" look — cards group, they do
not decorate.

## Primitives

Reusable, in `frontend/src/components/ui/`:

| Component | Purpose |
| --- | --- |
| `StatusPill` | Semantic state chip (sync, licence, stock, payment) |
| `SegmentedControl` | Mutually-exclusive mode toggle |
| `QuantityStepper` | −/value/+ for baskets, counts, receiving |
| `NumericKeypad` | On-screen pad — cash, quantity, price, PIN (no keyboard needed) |
| `ProductTile` | Fast catalogue tile with image fallback + stock state |
| `StatBlock` | Single KPI for mode-aware dashboards |
| `EmptyState` | Coherent "nothing here yet" + next action |

## Application shell

`frontend/src/components/layout/Sidebar.tsx` — grouped, context-aware
navigation (Sell / Operations / Insights / People / Business), business + role
context header, online/offline indicator. All role and business-type
visibility rules are enforced here and server-side. The previous flat nav is
preserved as `Sidebar.legacy.tsx` until the new shell is signed off.

## Reference screen

`frontend/src/app/(dashboard)/retail/page.tsx` — the retail till. The screen
that must convince a buyer: catalogue (search / scan / categories / grid),
live basket, and a keypad-driven pay flow, all against real retail endpoints.
