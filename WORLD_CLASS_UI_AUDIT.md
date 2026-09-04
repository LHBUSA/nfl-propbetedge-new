# PropBetEdge NFL — World-Class UI Audit

**Date:** 2026-09-04
**Repo:** `C:\Workers\nfl-propbetedge-new` (branch `worldclass-pass`)
**Production:** https://nfl.propbetedge.ai (currently serving `origin/main`)
**Method:** static code map + real headless Chrome measurement of live production and the
working tree at 390 / 768 / 1280 / 1440, via `scripts/ui-audit.mjs` and `scripts/ui-probe.mjs`
(both added by this audit; they reuse the CDP + local-file-substitution pattern already proven
in `scripts/recovery-browser-smoke.mjs`).

Every number below is measured, not estimated. Raw data:
`scratchpad/shots/live/report.json`.

---

## 1. What the product actually is

A **no-build static SPA**. `index.html` boots `app-core-v3.js` (a small, genuinely good hash
router with a `VIEWS` proxy registry that replays a route when its renderer registers late).
`page-loader.js` then sequentially loads ~110 generational enhancement layers, each of which
registers one or more view renderers that `innerHTML` into `#view-container`.

Deployment is Vercel static hosting with `cleanUrls`; `/api/*` are Vercel functions that proxy
Cloudflare Workers and Supabase. There is no framework, no bundler, and no CSS pipeline.

**This architecture is not the problem.** The router is clean, there are no console errors on
any route at any breakpoint, there is no horizontal overflow, and image loading is healthy
(0 broken images across 58 images on the heaviest route). The regression tooling
(`.github/workflows/*`, 5 node test files, a post-deploy smoke, a fault-injecting recovery
smoke) is better than most products this size have.

The problem is that **eleven generations of styling were layered on top of each other and none
were ever retired**, and that **the highest-traffic surfaces were designed as marketing pages
rather than as tools**.

### Measured load profile (live production, desktop home)

| Metric | Value |
|---|---|
| Stylesheets | **65** |
| Scripts | **69** |
| Total resource requests | **223** |
| Transfer | **639 KB** |
| FCP | 1,496 ms |
| DOMContentLoaded | 1,364 ms |
| Load | 4,527 ms |
| CSS on disk | **607 KB** across ~70 files |
| `!important` declarations | **2,425** |
| Competing `:root` token blocks | **13** |

Those 13 token blocks define **eight rival palettes** for the same product:
`--surface/--accent` (`base-v3.css`), `--v2-*` (`ui-v2.css`), `--nfl-*` (`sports-shell-v1.css`),
`--wc-*` (`world-class-v1.css`), `--read-*` (`readability-v1.css`), `--cast-*` (`pbecast-v4/v6`),
plus `prop-board-v3.css`, `paywall.css` and `stadium-selector-v1.css`. Nothing arbitrates between
them except source order and `!important`, which is why there are 2,425 of them.

### Dead weight already in the tree

31 root files totalling **278 KB** are referenced by nothing — not `index.html`, not
`page-loader.js`, not any loaded module. Including eleven superseded copies of the loader itself:

```
app.js  command-palette-v2.js  dashboard-v4.{css,js}  enhancements.{css,js}
game-center-v2.{css,js}  global-polish-v{2,3,4}.js  index-v2.html  index-v3.html
market-watch-v2.js  nfl-brand-media-v1.js  page-loader-v{2..11}.js
paywall-checkout-continuation-v1.js  pbe-picks-v1.js  sports-shell-v1.js
styles.css  teams-v2.{css,js}
```

Deleting these is zero-risk and makes the real cascade legible for the first time.

---

## P0 — Materially hurting the consumer experience

### P0-1 · Text is rendered below the threshold of legibility, product-wide

This is the single largest defect. Measured **rendered** font sizes (not source values):

| Route | Text nodes under 11px | Smallest | Worst offenders |
|---|---|---|---|
| Prop Board | **1,287** (1,365 at 390px) | 4.7px | `button.pbe3-lock` @5.5px ×210, `.pbe3-sub` @5.8px ×142, `small` @4.7px ×33 |
| Games | **630** (618 at 390px) | 4.6px | `small` @4.6px ×102, `b` @4.8px ×17 |
| Injuries | **346** | 5.4px | `span.person` @5.4px ×26, `.pbe13-editorial-meta` @5.8px ×23 |
| Dashboard | **308** (344 at 390px) | 5.0px | `span` @6.0px ×12, `span` @6.5px ×23, `small` @7.0px ×17 |
| Market Watch | 199 | 5.5px | |

The source is explicit about it — `base-v3.css` ships `.nav-badge{font:800 5px}`,
`.nav-group-label{font:800 6px}`, `.sf-status{font:700 5.5px}`, `.nav-item{font-size:9.5px}` —
and the later layers reproduce the same scale rather than correcting it.

Nothing else on this list matters as much. A market table whose book names, odds adjustments and
status labels render at 4.6–5.8px is not a professional information display; it is unreadable, and
it is the first thing a new user notices. It also single-handedly defeats the "Bloomberg-level
information hierarchy" goal: when *everything* is tiny, size can no longer encode importance.

### P0-2 · Contrast failures at scale

Elements failing WCAG AA against their own computed background:

| Route | Failing elements | Worst measured |
|---|---|---|
| Prop Board | **520** | `small` @ **2.53:1** ×34 |
| Games | 72 | `small` @ 3.38:1 ×19 |
| Injuries | 60 | `span` @ 3.39:1 ×28, `.pbe13-editorial-meta` @ 4.30:1 ×23 |
| Matchups | 37 | `span` @ 3.39:1 ×19 |
| Dashboard | 29 | `.pbe-network-link-label` @ 3.23:1 ×3 |

Because most of these are *also* under 8px (P0-1), the two defects compound: 5.5px text at
3.4:1 is effectively invisible, not merely hard to read.

A separate cluster (`button.primary` @1.05:1, `.pbes-nav-btn.cast` @1.06:1,
`.pbe3-button.gold` @1.07:1) reflects buttons whose visible background is a gradient or image
that the probe can't resolve — those need eyes-on confirmation rather than automatic fixing.

### P0-3 · The Dashboard is a sales manifesto, not a dashboard

Measured document height of the home route: **5,043px desktop, 9,295px mobile.**

The actual "what is happening in the NFL right now" content is *one* featured game card. Below it,
before any further intelligence, sit roughly 3,500px of engine marketing:

- "WE DON'T PUBLISH OPINIONS. WE MAKE THE MARKET PROVE US WRONG." + six numbered process cards
- "A PICK HAS TO SURVIVE THREE SYSTEMS." + a validation gate panel reading `0/100 · 0/4 WKS`
- five stat tiles (`2–3PP`, `A/B/C`, `¼ KELLY`, `70/30`, `CHAMPION`)
- "THE ALGORITHM IS NOT THE MARKETING CLAIM."
- "ENGINE 02 · PLAYER PROPS" — a second six-card process explainer
- "GAME PICKS CANNOT PROMOTE PLAYER PROPS..." governance panel

Only then does the NFL Intelligence Wire appear. The brief's five-second test cannot be passed by
this page: a first-time user learns the company's model governance philosophy before learning
what is happening in the NFL today, and a returning user has to scroll past all of it every visit.

The manifesto content is *good* and should not be deleted — it is a genuine differentiator. It
belongs on a dedicated "How the model works" surface (and is exactly what should be linked from
the news site), not stacked above the daily slate.

### P0-4 · Pro-gated surfaces show the user nothing

Total rendered text in `#view-container`:

| Route | Characters | What the free user sees |
|---|---|---|
| **Market Watch** | **869** | A hero, one empty dark box with a centred title + gold button, then ~150px of dead space, then the footer |
| **Model Lab** | 1,405 | Same shape |
| **Matchups** | 1,821 | Same shape |
| Prop Board | 27,184 | (works — free tier genuinely useful) |
| Games | 10,250 | (works) |

Market Watch at 2,502px tall contains under 900 characters. There is no preview, no sample row,
no shape of the tool, no explanation of what dispersion or a watchlist would show. This is the
"hostile interruption" the brief rules out, and it converts worse than a real preview would: the
user cannot want a thing they have never seen.

Prop Board proves the team knows how to do this properly — free cross-book pricing is fully
visible and only the modelled columns are gated. But it then overcorrects: three entire columns
(PBE Fair / PBE Over / Model Gap) × 70 rows render **210 identical gold "NFL PRO" lock pills**.
That is not showing what exists; it is 210 repetitions of an advertisement inside the data table.

### P0-5 · News content presented as fact does not match its own headline

On the Dashboard wire and News Intelligence, article cards render a summary and a
`MARKET IMPACT · CONTEXT · 3` block with a player scope line. Measured against
`/api/news-feed?limit=12`:

- **8 of 12 articles share one identical summary**: *"Kansas City's quarterback cleared nine
  months after ACL surgery, and Denver's defensive gameplan just became obsolete."*
- **All 8 are tagged `players: ["Patrick Mahomes"]`**, which the UI renders as the scope line.

So production currently shows *"49ers announce defensive end Sam Okuayinonu will not play
Thursday vs. Rams"* with a Kansas City quarterback ACL summary attributed to Patrick Mahomes, and
*"DE Azeez Ojulari, OL Evan Neal, WR Ronnie Bell sign with Raiders' practice squad"* the same way.

**Root cause is upstream, not in this repo.** `api/news-feed.js` is a faithful pass-through; I
verified the corruption is served by `propbet-news-api.sales-fd3.workers.dev` itself, and that
propbetedge.ai's own news site renders correct summaries for the same stories. Aggregated wire
items get a fallback dek from an unrelated article; PBE's own editorial items are fine.

Two separate fixes are needed, and the frontend one is ours:

1. **(This repo, P0)** A trust guard: do not present an uncorroborated summary or player scope as
   fact. If the dek shares no entity with the headline, suppress it and show source + timestamp
   only. Label the scope line as what it is rather than letting it read as a byline.
2. **(News worker repo, escalate)** Fix the fallback that assigns an unrelated dek and player tag.

This is the most serious item in the audit relative to the truth contract, because the interface
is currently making confident factual claims that are wrong.

### P0-6 · Loading architecture

65 stylesheets and 69 scripts, chained. `page-loader.js` `await`s each script in sequence
specifically so late layers can override earlier ones — which means load time is the *sum* of
110 round trips, not the max. FCP 1.5s / load 4.5s in headless Chrome on a fast desktop with a
warm CDN is the floor, not the typical case.

Compounding it: **42 of 43 images on the Dashboard carry no width/height or aspect-ratio**
(68 of 69 on Games, 57 of 58 on Injuries). Every one is a layout-shift opportunity.

And the unshipped local commit adds **3.2 MB of decorative stadium JPEGs** (`stadiums/*.jpg`,
~400 KB each ×5, plus @960 variants) for a background photograph.

### P0-7 · Chrome consumes the first third of the screen

`#pbe-sports-shell` measures **309px tall on desktop** before any product content:

| Strip | Height | Contents |
|---|---|---|
| `.pbes-top` | 71px | brand, live pill, date, search, account |
| `.pbes-news` | 34px | auto-scrolling headline marquee |
| `.pbes-scorebar` | 114px | game strip |
| `.pbes-primary` | 50px | **12 flat nav buttons** |
| `.pbes-research` | 39px | **11 more flat nav buttons** |

On mobile (working tree) it is 201px of a 844px viewport — 24% — before content, and the deployed
production is worse still (see P0-8).

The scorebar is the most valuable strip and gets 114px; the headline marquee is the least
valuable and is a permanently-moving element directly under the brand, which fights the eye on
every surface. `#pbes-news-track` is ~16,900px wide in the DOM.

### P0-8 · Mobile navigation is broken in production and thin in the working tree

Live production at 390px still renders `.pbes-primary` and `.pbes-research` as off-screen
horizontally-scrolling rails, and `#mobile-bottom-nav` is `display:none`. A phone user gets the
desktop nav model, badly.

**The two unpushed local commits on `worldclass-pass` already fix this** (`92fe5da` hides the
desktop rails below the breakpoint and enables the bottom nav; `dcb1d7b` reworks the stadium
layer). Measured on the working tree at 390px: rails `display:none`, bottom nav 60px, chrome down
from ~285px to 201px. **These are real improvements sitting unshipped** and should go out early.

Remaining gap: the bottom nav exposes 5 destinations (Home / Props / Matchup / Game / Menu) for a
23-surface product. Market Watch, Model Lab, Injuries, News and everything in Research are
reachable on a phone only via hamburger → the legacy sidebar.

Also measured at 390px: a 7px-tall link (`a` 71×7), `.pbes-score-nav` at 26px wide, and
`.pbes-head-btn` at 88×35 — all below the 44px touch target the page's own inline CSS asks for.

---

## P1 — Major polish / usability opportunity

### P1-1 · The navigation has 23 flat destinations and no mental model

`PRIMARY` (12) and `RESEARCH` (11) in `sports-shell-v2.js` are two undifferentiated rows. There is
no signal that Prop Board and Market Watch are the same *kind* of thing, or that Hall of Fame and
Super Bowl History are archives a daily user will never open. A capable product reads as
intimidating because breadth is presented as a flat list.

The brief's proposed TODAY / INTELLIGENCE / TOOLS / RESEARCH grouping is directionally right. My
recommendation, adjusted to what the routes actually do:

- **TODAY** — Dashboard · Games · Prop Board · Game Center
- **INTELLIGENCE** — Market Watch · Model Lab · PBE Picks · Track Record · Matchups · Usage · Injuries · News
- **TOOLS** — Line Simulator · SGP Lab · PropChain
- **ARCHIVE** — Teams · Standings · Stats · Seasons · Records · Hall of Fame · Super Bowls · Draft

`Track Record` and `PBE Picks` currently sit beside `Model Lab` with no indication they are the
*outputs* of it. Grouping fixes that for free.

### P1-2 · The featured-game hero is visually broken

On both desktop and mobile the hero card shows two unexplained white rectangles above the kickoff
time, the card's action buttons are clipped by the section below it, the full-bleed stadium
photograph has visible seams at the container edges, and the team logos are pushed to the extreme
left/right at mid-height on mobile while the market card runs down the centre.

### P1-3 · Decorative stadium photography costs 3.2 MB

A user-selectable full-bleed stadium background sits behind the Dashboard, Prop Board, Market
Watch and Matchups, defaulting to SoFi Stadium, with a `STADIUM · SoFi Stadium` picker chip.

**Correction to an earlier reading of this finding:** the chip is not floating over page content.
It is `position:fixed; right:18px; bottom:18px`, a well-behaved bottom-right utility control, and
it already raises itself to `bottom:74px` on mobile so it clears the bottom nav (measured: control
at y=728 with a 42px height, bottom nav at y=784 — no overlap). What looked like an overlap was an
artefact of full-page screenshots compositing fixed elements at their viewport offset.

What does stand: `stadiums/*.jpg` totals **3.2 MB** (five venues, ~400 KB each, plus @960
variants) for a decorative background, which is the performance concern in P0-6. The parent brand
achieves the same effect at `--pbe-scene-opacity: .21` with a grayscale/saturate filter over a
single shared image.

Recommendation is to keep the atmosphere — it is on-brand and deliberately built — and reduce the
asset cost, rather than remove the feature.

### P1-4 · Brand continuity with PropBetEdge.ai does not currently exist

This is worth stating plainly because the brief assumes the two already share DNA. Measured from
`propbetedge.ai/assets/index-FpTlv2Qq.css`:

| | PropBetEdge (news / parent) | PropBetEdge NFL |
|---|---|---|
| Ground | `--ink: #14110d` (warm near-black) | `#06090f` (cold blue-black) |
| Surface | `--ink-2/-3: #1d1914 / #2a241c` | `#0d141f / #111b29` |
| Text | `--paper: #f5f1eb` (warm off-white) | `#f5f7fb` (cool white) |
| Primary accent | **`--gold: #d4af37`** | **`--accent: #55d68c`** (green) |
| Urgent | `--crimson: #c1273d / #e63946` | `--danger: #f16b78` |
| Display face | **Playfair Display** (serif) | **Barlow Condensed** (condensed sans) |
| UI face | **Inter** | **DM Sans** |
| Mono | **JetBrains Mono** | **DM Mono** |
| Its NFL colour | `--gh5-nfl: #9b8a63` (bronze) | — |

They share exactly one value: gold, at different hexes. A user moving from a warm, serif,
gold-and-crimson editorial site into a cold, condensed-sans, green terminal will not feel they
went deeper into one brand — they will feel they left.

The parent already builds the bridge from its side: a network bar reading *"News is the surface.
The intelligence layer goes much deeper."* and a gold **NFL INTELLIGENCE →** button in its header.
The NFL app's `index.html` already sets `<meta name="theme-color" content="#14110d">` — the
parent's ink. The intent exists; the execution does not.

**This needs a decision, because it changes every subsequent pass.** See the open question at the
end of this document.

### P1-5 · No focus system

There is no `:focus-visible` treatment anywhere in the 607 KB of CSS beyond browser defaults,
which the dark surfaces largely swallow. Keyboard navigation through a 23-item nav and a 70-row
market table is currently close to impossible to follow.

### P1-6 · Numeric presentation is inconsistent

Prop Board mixes mono and sans within a single row; odds adjustments (`+182`, `-127`) render as
5–6px superscripts in a different family from the line they modify; consensus and best-price
columns are not decimal-aligned. Positive/negative currently relies on colour alone in several
places (`.pbe3-row-status`, market-implied percentages), which fails the brief's principle 2 and
principle 7 simultaneously.

### P1-7 · Repeated dead space and inconsistent section rhythm

Measured gaps of ~150px between the news wire and the network footer on Dashboard, and ~200px
below the paywall panel on Market Watch. Section spacing varies between roughly 24px and 96px
across surfaces with no system behind it.

### P1-8 · Mobile header collision

At 390px the `PBE` brand pill overlaps the `⌘ K · SEARCH` button in `.pbes-top` — the two render
on top of each other.

---

## P2 — Refinement / delight

- **P2-1** Route transitions are instantaneous `innerHTML` swaps with no enter state; a 120ms
  fade would make navigation feel deliberate rather than abrupt.
- **P2-2** Live/odds updates repaint without any change indication. A brief flash on a changed
  number is the single highest-value micro-interaction available in a market product.
- **P2-3** Loading states are a single centred spinner regardless of surface. Skeletons that match
  the destination layout would remove the perceived-latency cost of the 110-layer load.
- **P2-4** The nav badges (`LIVE`, `PRO`, `BETA`, `NEWS`, `2026`, `BASELINE`, `EVENT`, `REVIEW`)
  use seven colours across three meanings — status, tier and recency are visually interchangeable.
- **P2-5** Iconography is Unicode geometry (`⌂ ▦ ↗ ◌ ◫ ◈ ◎ ▧ ⌁ ⎇ ▥ ◇ ◉ ▤ ＋ ⇄ ⬡ ★ ⌖ ◆`) that
  renders differently per platform and carries no semantic relationship to its destination.
- **P2-6** `prefers-reduced-motion` is honoured nowhere, though the marquee, the scorebar
  auto-advance and the spinner all animate continuously.
- **P2-7** No URL state beyond the route hash. A news article cannot link to
  *this player's* research or *this game's* matchup — only to the surface. Implementing
  `#propboard?event=…&player=…` on top of the existing `App.nav` is small and unlocks the entire
  top-of-funnel strategy.

---

## What is already good and must be preserved

Stated explicitly so no pass regresses it:

- `app-core-v3.js` — the late-registration replay proxy is genuinely elegant and is why a
  110-layer load doesn't produce blank routes. Keep it exactly as it is.
- **Zero console errors and zero horizontal overflow** on every route at every breakpoint.
  Both are hard-won; `prop-board-responsive-v5.css` and the inline `overflow-x` rules in
  `index.html` are load-bearing.
- Prop Board's free tier — a real 70-row cross-book market table with book attribution, range
  visualisation and consensus is a legitimately strong product.
- The truth vocabulary already in the codebase: `semantics: 'CONTEXT_NOT_PRICE_MOVE'`,
  `'REPORTED_AVAILABILITY'`, `provenance.upstream`, `LIVE`/`MODEL`/`UNAVAILABLE` bands. The
  discipline exists in the data layer; the UI just needs to express it consistently.
- The regression tooling, especially `scripts/recovery-browser-smoke.mjs`'s fault injection.
- The Games surface's underlying data richness (10,250 chars of real schedule + market context).
- The engine manifesto copy — it is a real differentiator, on the wrong page.

---

## Open question that gates the design system

**P1-4 is a decision, not a defect.** The brief describes the NFL app's existing green/navy/
Barlow identity as the shared PropBetEdge DNA to preserve, but the parent brand at
propbetedge.ai is warm ink + paper, gold + crimson, Playfair + Inter + JetBrains Mono. Both are
coherent; they are not the same brand.

Three viable directions, in my order of preference:

1. **Bridge (recommended).** Adopt the parent's warm ink ground (`#14110d` family) and its
   editorial confidence, keep PropBetEdge NFL green as the *intelligence* accent that signals
   "you are now in the product", keep Barlow Condensed for sports display (it is the right face
   for scoreboards in a way Playfair is not), and adopt JetBrains Mono for data. Gold stays
   premium, crimson replaces the current pink-red for urgency. The user feels continuity in
   ground, type rhythm and gold, and feels *depth* in the green and the density.
2. **Inherit.** Take the parent's palette and type stack wholesale. Maximum continuity, but
   Playfair over a 70-row market table is the wrong tool and the NFL product loses its identity.
3. **Diverge.** Keep the NFL app exactly as branded and fix only hierarchy, legibility and
   density. Lowest risk, fastest, but the brief's stated top-of-funnel goal is not met.

I recommend **(1)**, and `PROPBETEDGE_DESIGN_SYSTEM.md` is written against it. It is reversible
at the token layer alone if you prefer (3).
