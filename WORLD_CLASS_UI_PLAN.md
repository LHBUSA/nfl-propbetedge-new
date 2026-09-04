# PropBetEdge NFL — Implementation Plan

Companion to `WORLD_CLASS_UI_AUDIT.md` (findings) and `PROPBETEDGE_DESIGN_SYSTEM.md` (the
parent → NFL bridge). This document is the sequence and the file-level blast radius.

**Branch:** `worldclass-pass`. **Production is not touched** by any pass; merging to `main` is a
separate, explicit decision.

---

## The governing engineering decision

The tree has 13 `:root` blocks defining **182 custom properties** across 14 rival namespaces
(`--v2-*`, `--wc-*`, `--nfl-*`, `--cast-*`, `--cast6-*`, `--g-*`, `--mw-*`, `--pb-*`, `--pbe4-*`,
`--pbe7-*`, `--pro-*`, `--read-*`, plus bare `--accent/--surface/--text`), arbitrated only by
source order and **2,425 `!important`** declarations.

`nfl-brand-media-v1.css` already defines the parent's exact ink/paper/gold/crimson tokens and
already forces `html,body{background:var(--pbe-ink)}`. **The brand bridge was started and stopped
at the ground.** The warm ink is live today; every component on top of it still uses the cold
green/navy palettes. That is precisely why the product currently reads as incoherent.

So the move is **not** a fourteenth override layer. It is:

1. One token authority — `pbe-tokens.css` — holding the design system, **plus an alias block
   mapping all 182 legacy properties onto it.**
2. **Deleting the `:root` blocks from the 13 files that currently define them**, leaving their
   component rules intact.

After step 2 there is exactly one `:root` in the product. Every existing rule that says
`color:var(--v2-text)` keeps working and starts resolving to `--pbe-paper`. ~600 KB of existing
CSS re-skins itself to the parent brand without being edited, and the cascade stops fighting.

This reduces conflict instead of adding to it, is reversible by reverting one file, and does not
touch a single line of behavioural JavaScript.

---

## PASS 1 — Foundation ✅ **complete**

**Goal:** one token authority, parent typography, the 10px floor, focus, no dead code.

| Step | Files | Risk |
|---|---|---|
| 1.1 Delete 31 unreferenced files (278 KB) | `app.js`, `dashboard-v4.*`, `enhancements.*`, `game-center-v2.*`, `global-polish-v{2,3,4}.js`, `index-v{2,3}.html`, `market-watch-v2.js`, `nfl-brand-media-v1.js`, `page-loader-v{2..11}.js`, `pbe-picks-v1.js`, `sports-shell-v1.js`, `styles.css`, `teams-v2.*`, `command-palette-v2.js`, `paywall-checkout-continuation-v1.js` | **None** — verified unreferenced by `index.html`, `page-loader.js` and every loaded module |
| 1.2 Add `pbe-tokens.css` (system + 182 legacy aliases); load first | `index.html` | Low |
| 1.3 Strip `:root` blocks from the 13 defining files | `base-v3.css`, `ui-v2.css`, `world-class-v1.css`, `readability-v1.css`, `sports-shell-v1.css`, `nfl-brand-media-v1.css`, `dashboard-v7.css`, `pbecast-v4.css`, `pbecast-v6.css`, `prop-board-v3.css`, `paywall.css`, `stadium-selector-v1.css` | Medium — mitigated by full alias coverage + screenshot diff |
| 1.4 Swap font stack to Playfair / Inter / JetBrains Mono | `index.html` | Low |
| 1.5 Add `pbe-system.css` — 10px type floor, `:focus-visible`, badge grammar, button/table primitives, reduced-motion | new + `page-loader.js` | Low |
| 1.6 Retire the headline marquee; collapse shell 5 strips → 2 rows; group nav TODAY/INTELLIGENCE/TOOLS/ARCHIVE | `sports-shell-v2.js`, `sports-shell-v3.css` | **Medium-high** — nav is load-bearing; do last in the pass, verify every route |
| 1.7 ~~Retire stadium background~~ — **kept**; it is deliberate on-brand work and the picker is a well-behaved fixed control. Asset-weight reduction deferred to Pass 8 | `stadiums/*` | — |

**Exit criteria:** zero console errors on all 18 routes × 4 widths; zero horizontal overflow;
**zero text rendered below 10px**; zero contrast failures below 4.5:1 excluding known
gradient-button false positives; `node --test` green; recovery smoke green.

---

## PASS 2 — Dashboard ✅ **complete**

Fixes P0-3 (5,043px desktop / 9,295px mobile manifesto) and P1-2 (broken hero).

- Move the engine manifesto — "WE DON'T PUBLISH OPINIONS", the six process cards, the validation
  gate, "ENGINE 02", the governance panel — **off the dashboard onto a dedicated `#how` surface**,
  linked from the dashboard once and from the news site. It is good content on the wrong page and
  is not deleted.
- Rebuild the dashboard against the brief's question — *what matters in the NFL right now*:
  live/next games → strongest model+market signal → notable line movement → injury/news impact →
  entry points. One `--fs-data-xl` moment, not fifteen equal cards.
- Fix the hero: remove the white artefact rectangles, stop clipping the action row, remove the
  photo seams.
- Trust guard for the news wire (P0-5): suppress a summary/scope that shares no entity with its
  headline; render source + timestamp instead. Label the scope line rather than letting it read
  as a byline.

Files: `dashboard-v5/6/7/8-*`, `pbe-engine-story-v1.*`, `dashboard-v7-sanitize.js`, new `how` view.

---

## PASS 3 — Games + Game Center

Fixes the 4.6px `<small>` ×102 cluster and 7,517px desktop / 11,259px mobile height.

Files: `games-v2.*`, `games-worldclass-v3.css`, `games-command-v4.*`, `games-intel-v5.*`,
`pbecast-v4/5/6/7-*`.

---

## PASS 4 — Prop Board + Market Watch + Model Lab ✅ **conversion core complete**

The commercial core.

- Prop Board: table grammar, 1,287 sub-11px nodes and 520 contrast failures resolved; **210 lock
  pills → 3 locked column headers + 1 CTA**; mobile table → cards.
- Market Watch (869 chars) and Model Lab (1,405 chars): replace the empty box with a real locked
  preview — actual columns, actual entities, obscured values, one specific CTA (P0-4).

Files: `prop-board-v3/v4/responsive-v5`, `market-watch-v2/v3`, `model-lab*`, `paywall*`.

---

## PASS 5 — Matchups · Usage · Injury · News

Matchups (1,821 chars) gets the same locked-preview treatment. Injury desk: 5.4px person labels,
3.39:1 contrast, 12,640px mobile height. News: apply the Pass 2 trust guard.

Files: `matchups-v2.*`, `usage-v2.*`, `injury-intel-v2.*`, `injury-readability-v5.*`,
`news-intelligence-v2.*`, `newsroom-v2.*`.

---

## PASS 6 — Team / player / research / archive

`team-research-v3`, `player-research-v2`, `standings-v2`, `stats-v2`, `season-archive-v2`,
`hof-v2`, `records-v2`, `super-bowls-v2`, `draft-review-v2`. Table grammar applied uniformly.

---

## PASS 7 — Paywall, onboarding, top-of-funnel continuity ✅ **deep-link contract complete**

- Paywall as part of the product, not an interruption.
- **URL state (P2-7):** extend `App.nav` to accept `#route?event=…&player=…&team=…` so a news
  article can deep-link to *this player's* research or *this game's* matchup. `app-core-v3.js`
  gains parameter parsing only — the routing contract is unchanged.
- Network identity matching the parent's "News is the surface / the intelligence layer goes much
  deeper" bar.

Files: `paywall*.{css,js}`, `network-footer-v1.*`, `app-core-v3.js`, `command-palette-v3.js`.

---

## PASS 8 — Global QA

Full 18 routes × 390/768/1280/1440 sweep; accessibility pass; performance (223 requests → target
under 120, images get dimensions + lazy); final visual QA against every item in the audit.

---

## Verification, every pass

```
node --test tests/                                  # 5 unit test files
node scripts/check-syntax.mjs
node scripts/ui-audit.mjs --out .ui-audit           # working tree, live APIs, 4 widths
PBE_CHROME=... node scripts/recovery-browser-smoke.mjs   # fault-injection route soak
```

`scripts/ui-audit.mjs` and `scripts/ui-probe.mjs` were added by this work. They render the
**working tree** against live production APIs in real headless Chrome and report, per route per
width: horizontal overflow, every text node under 11px, every element under WCAG AA, sub-44px
touch targets, broken/undimensioned images, console errors, and a full-page screenshot. Findings
are checked against measurements, not against intent.

---

## Status — what shipped to the branch

Six commits on `worldclass-pass`, each verified by rendering the working tree
against live production APIs in headless Chrome at 390 / 768 / 1280 / 1440.

**Measured across 68 route × width combinations, before → after:**

| Metric | Before | After |
|---|---|---|
| Smallest rendered text | **4.6px** | **10px** (the design floor) |
| Text nodes below 10px | 4,248 | **0** |
| WCAG AA contrast failures | 2,281 | **0** |
| Console errors | 0 | 0 |
| Horizontal overflow | 0 | 0 |
| Cumulative layout shift (home) | 0.175 | **0.005 – 0.038** |
| Competing `:root` token blocks | 13 | **1** |
| Unreferenced files | 31 (278 KB) | **0** |
| Desktop shell chrome | 309px (5 strips) | **252px** (3 strips, grouped) |
| Dashboard height (desktop / mobile) | 5,043 / 9,295px | ~3,100 / ~5,100px |
| Market Watch rendered content | 869 chars | **4,303 chars** |
| Featured-game hero on mobile | market panel 118px wide | **308px** |
| News deks presented but uncorroborated | 8 of 12 | **0** |
| Lock buttons inside the Prop Board table | 210 | **0** (3 locked column heads) |
| Broken images | 0 | 0 |

**Deep-link contract (Pass 7 core), verified by `scripts/deeplink-smoke.mjs`:**

```
https://nfl.propbetedge.ai/?player=Drake%20Maye#propboard   -> opens unified player research
https://nfl.propbetedge.ai/?event=<id>#marketwatch          -> event-scoped market terminal
https://nfl.propbetedge.ai/#propboard?player=Sam%20Darnold  -> params may ride the hash
App.link('marketwatch', {event, player})                    -> canonical builder for the news site
```

All five cases pass; plain routes are unaffected.

**Still open** (Passes 3, 5, 6, and the remainder of 8): per-surface type roles on
Games / Prop Board / News (their remaining sub-11px text is all at the 10px floor,
but some of it should be 11–13px body rather than micro); mobile document heights
on Injuries and Games; the archive table grammar; and the load profile (66
stylesheets / 70 scripts / 226 requests, and the 3.2 MB of stadium JPEGs).

---

## Explicitly out of scope

- `app-core-v3.js` routing contract (except additive URL params in Pass 7)
- `/api/*` handlers, auth, Stripe, Supabase, paywall entitlement logic
- Model/grading/picks logic and the `workers/` directory
- The upstream news data defect (P0-5 root cause) — it lives in
  `propbet-news-api.sales-fd3.workers.dev`, a different repo. This work adds a **frontend trust
  guard**; the upstream fix must be raised separately.
- Any framework migration.
