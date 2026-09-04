# PropBetEdge Design System — Parent → NFL Intelligence Bridge

**Status:** authoritative. This document supersedes the eight competing palettes currently in
the NFL tree (`--surface/--accent`, `--v2-*`, `--nfl-*`, `--wc-*`, `--read-*`, `--cast-*`,
`--pbe3-*`, stadium tokens).

**Source of truth:** `propbetedge.ai` — verified against the live parent stylesheet
`propbetedge.ai/assets/index-FpTlv2Qq.css` (190 KB) and its rendered DOM, not from memory.
Every "PARENT" value below is quoted verbatim from that file.

**Implementation home:** `pbe-tokens.css` (new, single authority, loaded first) plus
`pbe-system.css` (component primitives). No `*-v9.css`. Existing generational layers are
retired into these two files surface by surface, as described in `WORLD_CLASS_UI_PLAN.md`.

---

## The bridge in one sentence

The parent is a **premium editorial brand**: warm ink, paper, gold rules, serif moments, mono
eyebrows. The NFL product is that same brand **operating a terminal** — same ground, same gold,
same mono discipline, but with the serif rationed to brand moments and the mono promoted from
decoration to the primary carrier of meaning.

What travels unchanged: **ground, surfaces, paper, gold, crimson, the three typefaces, the gold
rule, the mono eyebrow, `.15s` transitions, outline-not-fill badges.**

What is added for the application: **a data scale, semantic status colours, elevation for
interactive surfaces, focus, density, table grammar, and the locked/Pro state.**

---

## 1 · Colour

### Ground / surface / border

| Token | Value | Origin | Adaptation |
|---|---|---|---|
| `--pbe-ink` | `#14110d` | **PARENT `--ink`** — direct | Page ground. Unchanged. The NFL app's old `#06090f` cold blue-black is retired. |
| `--pbe-ink-2` | `#1d1914` | **PARENT `--ink-2`** — direct | Primary surface: cards, panels, table body. |
| `--pbe-ink-3` | `#2a241c` | **PARENT `--ink-3`** — direct | Elevated surface: hovered rows, popovers, sticky table headers, active controls. |
| `--pbe-ink-4` | `#0d0b08` | **ADAPTED** | *Recessed* surface — below ground. The parent has no recessed tone because an article never needs one; a terminal does, for table wells, input fields and code/data insets. Derived by darkening `--ink` on the same hue. |
| `--pbe-line` | `rgba(255,245,220,.10)` | **PARENT `--line`** — direct | Default hairline. Warm-white at 10%, never grey. |
| `--pbe-line-strong` | `rgba(255,245,220,.18)` | **PARENT `--line-strong`** — direct | Emphasis border, outline buttons, active cells. |
| `--pbe-line-faint` | `rgba(255,245,220,.055)` | **ADAPTED** | Row separators. A 70-row market table at `.10` reads as a grid of cages; it needs a lighter rule than editorial cards do. |

**Adaptation rationale.** The parent needs three tones because it stacks article cards on a
ground. A terminal needs five because it stacks *interactive* rows inside panels inside a ground,
and needs one step below ground for inputs. All five sit on the same warm hue — nothing cold
enters the system.

### Text

| Token | Value | Origin | Adaptation |
|---|---|---|---|
| `--pbe-paper` | `#f5f1eb` | **PARENT `--paper`** — direct | Primary text, key numbers. |
| `--pbe-paper-2` | `#e8e1d4` | **PARENT `--paper-2`** — direct | Secondary headings, table data. |
| `--pbe-dim` | `#b8b3a8` | **PARENT `--paper-dim`** — direct | Secondary text, labels, inactive nav. **This is the floor for meaningful text.** |
| `--pbe-faint` | `#7e7a72` | **PARENT `--paper-faint`** — direct | Meta, timestamps, attribution. Measured 4.4:1 on parent ink — AA at 14px+. **Never used below 11px.** |
| `--pbe-subtle` | `#524e47` | **PARENT `--paper-subtle`** — direct | Decorative only — rules, disabled glyphs, watermarks. **Never text.** |

**This is the fix for P0-2.** The audit found NFL text at 2.53:1 and 3.39:1. The parent's own
worst case is 4.19:1. Adopting the parent's ramp verbatim and forbidding `--pbe-subtle` for text
resolves the contrast failures as a consequence of brand alignment, not as a separate exercise.

### Brand accents

| Token | Value | Origin | Role in the NFL product |
|---|---|---|---|
| `--pbe-gold` | `#d4af37` | **PARENT `--gold`** — direct | **The PropBetEdge brand accent.** Primary actions, section rules, active nav, Pro/premium, selected state, key data emphasis. |
| `--pbe-gold-bright` | `#e9c75a` | **PARENT `--gold-bright`** — direct | Hover on gold, gold text on ink where `--pbe-gold` is short of contrast. |
| `--pbe-gold-soft` | `rgba(212,175,55,.18)` | **PARENT `--gold-soft`** — direct | Gold tint fills, selected row wash, focus ring halo. |
| `--pbe-crimson` | `#c1273d` | **PARENT `--crimson`** — direct | Structural crimson: borders, rules, severity bars. |
| `--pbe-crimson-bright` | `#e63946` | **PARENT `--crimson-bright`** — direct | Crimson text and badges on ink. Breaking, urgent injury, critical status. |

**Gold discipline.** The parent uses gold as a *rule and an underline*, almost never as a fill —
`.nav-link.active` gets a 2px gold underline, `.section-heading` a 2px gold bottom border,
`.sport-rail-header` a 4px gold top border. Only the single primary CTA is a gold fill. The NFL
app inherits exactly this discipline: **gold is a line before it is ever a surface.** This is the
guard against the "gold casino" failure mode, and it is inherited, not invented.

### Semantic colours

These carry meaning, never identity. All are outline-and-text treatments (parent badge grammar),
never full fills, so they cannot compete with gold.

| Token | Value | Origin | Meaning |
|---|---|---|---|
| `--pbe-live` | `#e63946` | **PARENT `--crimson-bright`** | **LIVE** — genuine current authorized provider data. Parent uses crimson for its live indicator and breaking bar; NFL inherits it. |
| `--pbe-model` | `#7aa9ff` | **ADAPTED** | **MODEL** — PropBetEdge model output. A cool blue is the only hue in the system that cannot be confused with gold (premium), crimson (urgent) or green (positive). Reused from the existing NFL `--nfl-blue`, which is the one legacy token worth keeping. |
| `--pbe-pro` | `#d4af37` | **PARENT `--gold`** | **PRO** — locked/premium. Deliberately identical to the brand accent: in this product, premium *is* the brand. |
| `--pbe-unavailable` | `#7e7a72` | **PARENT `--paper-faint`** | **UNAVAILABLE** — required input absent. Deliberately colourless. Absence must not look like a state worth wanting. |
| `--pbe-pos` | `#4ea373` | **ADAPTED** | Positive movement, favourable edge, healthy/available. |
| `--pbe-neg` | `#c1273d` | **PARENT `--crimson`** | Negative movement, unfavourable edge. |

**On the retired green.** The old NFL brand green `#55d68c` is demoted to semantics only and
retoned to `#4ea373` — desaturated and darkened so it sits inside the warm ink world rather than
glowing out of it. `#55d68c` on `#14110d` is a neon note that fights gold for attention; `#4ea373`
reads as "positive" without claiming identity. Green never appears in navigation, brand, or
chrome again.

**Never colour alone.** Every semantic pairs colour with a second channel — `▲`/`▼` glyph and
sign for movement, a label word for status, a lock glyph for Pro, an italic dash for unavailable.
This satisfies the accessibility principle and survives the 8% of users who cannot separate
`#4ea373` from `#c1273d`.

### Team colour

Permitted only as a **≤3px accent edge or a ≤10% wash** on a surface that is *about* one team —
a matchup card, a team research header, a roster row. Never as a panel background, never in the
shell, never behind numbers. PropBetEdge gold always outranks it in the same view.

---

## 2 · Typography

Three families, inherited verbatim from the parent's `--font-serif` / `--font-sans` / `--font-mono`.

```
--pbe-font-display : "Playfair Display", "Times New Roman", Georgia, serif
--pbe-font-ui      : "Inter", -apple-system, BlinkMacSystemFont, sans-serif
--pbe-font-data    : "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace
```

Barlow Condensed and DM Sans/DM Mono are retired. That removes one Google Fonts request while
adding none — the parent's three families replace the NFL's three.

### Playfair Display — rationed

Used **only** for: the dashboard's lead moment, a game's headline matchup presentation, section
headings on editorial surfaces (News, Injury desk, Records/History), premium onboarding and
paywall headlines, and empty-state moments.

Never for: navigation, buttons, table headers, labels, data, cards, or any repeated element.

Parent spec inherited directly — `.sport-rail-header .sport-name` is
`900 42px/-.025em italic`, `.section-heading h2` is `800 clamp(22px,2.6vw,30px)/-.015em`.

**Adaptation:** the parent sets its biggest serif at 42–64px on an article page. The NFL app caps
Playfair at **clamp(26px, 3vw, 40px)** — a terminal that gives 64px to a headline has given away
the fold.

### Inter — the interface

Everything structural: nav, buttons, controls, cards, body copy, form fields, table cell text,
descriptions.

### JetBrains Mono — data and eyebrows

Two distinct jobs, inherited from the parent, which already uses mono for both:

1. **Eyebrows / labels / nav** — the parent's signature. `11px / 700 / .14em / uppercase`
   (`.nav-link`), `10px / 700 / .16em / uppercase` (`.sport-rail-header .sport-meta`).
2. **Data** — odds, spreads, totals, prices, percentages, EV, deltas, line movement, timestamps,
   confidence, model output. `font-variant-numeric: tabular-nums` everywhere so columns align.

### The scale

Rebuilt around a **hard 10px floor**, derived from the parent (whose own floor is 8px, used only
for a tracked sport tag; its working small sizes are 9.5–11px). The NFL app currently renders text
at **4.6px**. This scale is the direct fix for P0-1.

| Token | Size / line | Family | Use |
|---|---|---|---|
| `--fs-display` | `clamp(26px,3vw,40px)` / 1.05 | Playfair 800–900 | Brand moments only |
| `--fs-h1` | `28px` / 1.15 | Inter 800 | Surface title |
| `--fs-h2` | `20px` / 1.2 | Inter 700 | Section title |
| `--fs-h3` | `16px` / 1.3 | Inter 700 | Card title |
| `--fs-body` | `14px` / 1.55 | Inter 400–500 | Body copy |
| `--fs-sm` | `13px` / 1.5 | Inter 400–500 | Secondary copy, table cells |
| `--fs-label` | `11px` / 1.2, `.14em`, upper | Mono 700 | Eyebrows, nav, column heads |
| `--fs-micro` | `10px` / 1.2, `.16em`, upper | Mono 700 | Badges, meta. **Absolute floor.** |
| `--fs-data-xl` | `28px` / 1 | Mono 600, tabular | Hero number (score, headline line) |
| `--fs-data-lg` | `20px` / 1 | Mono 600, tabular | Primary number (spread, total) |
| `--fs-data` | `15px` / 1.3 | Mono 500, tabular | Table numbers |
| `--fs-data-sm` | `13px` / 1.3 | Mono 500, tabular | Dense numbers, adjustments |

**Rule: nothing below 10px renders, ever.** `--fs-micro` is reserved for tracked uppercase mono,
which is legible at 10px in a way that 10px sentence-case Inter is not. Odds adjustments
(`+182`, `-127`) move from ~5px superscripts to `--fs-data-sm` — same family as the line they
modify, one step down, never a different family.

---

## 3 · Structure

### Radius

Parent's most-used values are `12px`, `10px`, `8px`, `4px`, `999px`. Adopted, trimmed to five
steps, and biased one step tighter than the parent because tight corners read as instrument
rather than toy:

| Token | Value | Use |
|---|---|---|
| `--r-xs` | `3px` | Badges, chips, inline tags |
| `--r-sm` | `6px` | Buttons, inputs, controls, table cells |
| `--r-md` | `10px` | Cards, panels |
| `--r-lg` | `14px` | Major containers, modals |
| `--r-pill` | `999px` | Toggles and status pills only |

Nothing in the product exceeds `--r-lg`. The current `18px`/`22px` card radii read as consumer-app
soft; they go.

### Spacing

4px base, matching the parent's rhythm (its `.section-heading` uses `56px 0 28px`,
`.sport-rail-header` `20px`):

`--s-1:4 · --s-2:8 · --s-3:12 · --s-4:16 · --s-5:24 · --s-6:32 · --s-7:48 · --s-8:64`

Section rhythm: `--s-7` (48px) between major sections on desktop, `--s-5` (24px) on mobile.
This replaces the current ad-hoc 24–96px variance and the measured ~150–200px dead gaps (P1-7).

### Shadows

The parent uses shadow sparingly and warm — `0 2px 10px #00000059`, `0 10px 30px #14110d0b`,
`0 4px 16px #d4af3740` for the gold CTA. Inherited:

| Token | Value | Use |
|---|---|---|
| `--sh-1` | `0 1px 3px rgba(0,0,0,.35)` | Resting card |
| `--sh-2` | `0 4px 16px rgba(0,0,0,.40)` | Hovered card, dropdown |
| `--sh-3` | `0 16px 50px rgba(0,0,0,.55)` | Modal, command palette |
| `--sh-gold` | `0 4px 16px rgba(212,175,55,.25)` | **PARENT** — primary CTA only |

No glow on borders. No shadow on table rows. Elevation is carried by `--pbe-ink-2` → `--pbe-ink-3`
first and shadow second.

---

## 4 · Components

### Navigation

**Parent grammar, inherited exactly** (`.nav-link`): JetBrains Mono `11px / 700 / .14em`,
uppercase, `--pbe-dim` at rest → `--pbe-paper` on hover/active, and the active item marked by a
**2px gold underline**, not a filled pill.

**Adapted for the application:**

- The 23 flat destinations gain the grouping from the audit (P1-1): **TODAY · INTELLIGENCE ·
  TOOLS · ARCHIVE**, with the group label in `--fs-micro` mono.
- The 5-strip / 309px desktop shell collapses to **two rows**: identity + live state + search +
  account, then one grouped nav row. The scorebar becomes a summonable panel rather than a
  permanent 114px band; the headline marquee is retired (a permanently-moving element under the
  brand fights every surface below it, and the wire already exists as a dashboard module).
- Mobile keeps the bottom bar but its 5th slot opens a **grouped sheet** exposing all four groups,
  so all 23 surfaces are two taps away instead of hamburger-only.

### Buttons

| Variant | Treatment | Origin |
|---|---|---|
| Primary | `--pbe-gold` fill, `--pbe-ink` text, Inter 700, `.06em`, `--r-sm`, `--sh-gold` | **PARENT `.nav-link.cta`** |
| Secondary | transparent, `1px solid var(--pbe-line-strong)`, `--pbe-dim` text → `--pbe-paper` + gold border on hover | **PARENT `.sport-rail-header .more-link`** |
| Ghost | no border, `--pbe-dim` → `--pbe-paper` | Parent nav-link |
| Danger | `--pbe-crimson-bright` outline + text | Parent badge grammar |

Height `36px` desktop / `44px` touch. Transition `all .15s` — the parent's value, used everywhere.

### Data cards

`--pbe-ink-2` on `--pbe-ink`, `1px solid --pbe-line`, `--r-md`, `--s-4` padding.
Structure is always: mono eyebrow (`--fs-micro`) → the number (`--fs-data-lg`/`xl`) → Inter
context line (`--fs-sm`). Hover lifts to `--pbe-ink-3` + `--sh-2`.

**Not every card gets equal weight.** A surface has at most one `--fs-data-xl` moment.

### Tables — the terminal grammar

The one component with no parent precedent; adapted from the parent's *rules* rather than its
components.

- Header: sticky, `--pbe-ink-3`, `--fs-label` mono uppercase `--pbe-dim`, `2px solid --pbe-gold`
  bottom border — **the parent's `.section-heading` gold rule, applied to a column head.**
- Rows: `--fs-sm` Inter for entities, `--fs-data` mono tabular for every number,
  `1px solid --pbe-line-faint` separators, `--pbe-ink-3` on hover.
- Numeric columns right-aligned and decimal-aligned via `tabular-nums`.
- Movement: sign + `▲`/`▼` + colour, never colour alone.
- Mobile: below 768px a table becomes stacked cards with the entity as title and label/value
  pairs — never a horizontal scroll of a desktop grid.

### Badges / status

**Parent `.impact-badge` grammar, inherited exactly:** mono `10px / 800 / .12em` uppercase,
`#14110deb` background, **1px border in the semantic colour, text in the same colour**, no fill.

This gives the truth contract a single visual form:

| Badge | Colour | Text |
|---|---|---|
| LIVE | `--pbe-live` | `● LIVE` |
| MODEL | `--pbe-model` | `◆ MODEL` |
| PRO | `--pbe-pro` | `▲ PRO` |
| BETA | `--pbe-dim` | `BETA` |
| UNAVAILABLE | `--pbe-unavailable` | `— UNAVAILABLE` |

Five badges replace the current seven-colour mixture of status, tier and recency (P2-4). Recency
is not a badge; it is a timestamp in `--fs-micro` mono.

### Locked / Pro state

The direct fix for P0-4. A locked region shows **real structure with unreadable values**, not an
empty box:

- Real column headers, real row entities, real row count.
- Values replaced by a `▲▲▲` mono glyph run at `--pbe-unavailable`, or a 4px-blurred sample.
- **One** gold CTA per locked region — never one per row. The 210 lock pills on Prop Board
  become three locked *column headers* plus one CTA.
- A one-line, specific value statement: *"PBE fair line, win probability and model gap across all
  70 markets"* — not "Unlock Pro".

### Charts

Ink ground, `--pbe-line-faint` gridlines, `--pbe-gold` for the primary series, `--pbe-model` blue
for modelled series, `--pbe-pos`/`--pbe-neg` for divergence. Mono tabular axis labels at
`--fs-micro`. No gradient fills, no shadows, no chart that does not answer a question.

### Player and team imagery

- Team logos: ESPN CDN, explicit `width`/`height`, `--r-xs`, no drop shadow. Already working
  (0 broken images) — preserved.
- Player headshots: fixed aspect box, `--pbe-ink-3` placeholder, PBE mark fallback (already
  implemented in `nfl-player-media-v3.js` — preserved).
- Editorial photography: full-bleed only in a genuine editorial module (News lead, Injury desk
  lead), always with a `--pbe-ink` gradient scrim under text.
- **Stadium atmosphere:** kept, cost reduced. It is deliberate, on-brand work and the parent uses
  scene imagery too (`--pbe-scene-opacity: .21` with a grayscale/saturate filter). The 3.2 MB of
  venue JPEGs (P1-3) should come down toward the parent's single-image approach; the picker itself
  is a well-behaved fixed control and stays.
- **Every image gets `width`/`height` or `aspect-ratio`, and `loading="lazy"` below the fold.**
  Parent lazy-loads 85 of 89 images; NFL lazy-loads 6 of 43 (P0-6).

---

## 5 · Motion

Parent's `.15s` is the system tempo.

| Event | Motion |
|---|---|
| Hover / press | `all .15s` |
| Focus | instant — no transition on a focus ring |
| Route change | 120ms opacity+2px rise on `#view-container` |
| Value change | 600ms colour flash on the changed number only (`--pbe-pos`/`--pbe-neg` → resting) |
| Live tick | 2s opacity pulse on the LIVE dot only |
| Expand | 180ms height + opacity |
| Loading | skeletons matching destination layout, not a centred spinner |

`@media (prefers-reduced-motion: reduce)` disables the marquee, the pulse and all transforms,
keeping opacity changes only. Currently honoured nowhere (P2-6).

---

## 6 · Focus and accessibility

Currently absent entirely (P1-5):

```css
:focus-visible {
  outline: 2px solid var(--pbe-gold);
  outline-offset: 2px;
  border-radius: var(--r-sm);
}
```

Plus: semantic `<button>`/`<a>`/`<table>` (several surfaces use `<div onclick>`), `aria-current`
on active nav, `aria-live="polite"` on the score strip and live values, visible skip link, and
44px minimum touch targets below 768px — the page's own inline CSS already asks for this and is
currently violated by `.pbes-score-nav` (26px wide) and a measured 7px-tall link.

---

## 7 · Breakpoints

| Width | Shell | Data |
|---|---|---|
| **≤ 390** | Bottom bar + grouped sheet; single column; 16px gutter | Tables → stacked cards |
| **≤ 768** | Same; 2-up cards | Tables → cards; 44px targets |
| **≤ 1280** | Top nav single row, groups collapse to overflow; 24px gutter | Tables scroll inside a bounded container |
| **≥ 1440** | Full grouped nav; 32px gutter; max content 1440px | Full tables |

No horizontal page scroll at any width — currently true and must stay true.

---

## 8 · Empty / loading / error / stale

One vocabulary, replacing the current per-surface improvisation:

| State | Treatment |
|---|---|
| **Loading** | Skeleton in destination layout; `--pbe-ink-2` blocks, 1.4s shimmer |
| **Empty** | Playfair line + one Inter sentence + one action. No illustration. |
| **Unavailable** | `— UNAVAILABLE` badge + plain reason: *"No authorized provider quote for this market."* Never a zero, never a dash pretending to be data. |
| **Error** | Crimson-outlined panel, what failed, a retry button. Never a blank surface. |
| **Stale** | Value at `--pbe-dim` + mono timestamp `LAST 14:02 ET`. Staleness is shown, not hidden. |
| **Locked** | Per the locked/Pro pattern above. |

---

## 9 · What this changes, concretely

| Before | After |
|---|---|
| 8 palettes, 13 `:root` blocks, 2,425 `!important` | 1 token file, 1 `:root`, `!important` only where a retired layer is being overridden during migration |
| Cold `#06090f` navy ground | Parent warm `#14110d` ink |
| Green `#55d68c` as identity | Gold `#d4af37` as identity; green demoted to `#4ea373` semantic |
| Barlow Condensed / DM Sans / DM Mono | Playfair Display / Inter / JetBrains Mono |
| Text rendering at 4.6px | Hard 10px floor |
| 2.53:1 contrast | Parent ramp, AA throughout |
| 7 badge colours, mixed meanings | 5 semantic badges, one grammar |
| 210 lock pills in one table | 3 locked column heads + 1 CTA |
| 309px desktop chrome, 5 strips | 2 rows, grouped nav |
| No focus system | Gold `:focus-visible` throughout |
| 65 stylesheets | Tokens + system + per-surface, migrated progressively |

---

## 10 · Non-goals

- Not a newspaper. Playfair is rationed; the working surfaces are Inter and mono.
- Not a recolour. If a surface is only recoloured and its hierarchy is unchanged, the pass is
  not done.
- Not gold everywhere. Gold is a line before it is a surface; one gold fill per view.
- Not a rewrite. `app-core-v3.js`, the API layer, auth, paywall logic, model logic and the
  regression tooling are untouched except where a specific audit finding requires it.
