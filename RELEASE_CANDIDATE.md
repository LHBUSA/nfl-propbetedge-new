# PropBetEdge NFL — Release Candidate Report

## Reconciled manifest — read from the actual remote, 2026-09-04

| | |
|---|---|
| `origin/main` (production) | **`edd957e1bd9de309a203d43c5db14283014e1ac0`** |
| `origin/worldclass-pass` (candidate) | **`518d90a23dc49fe416b075646855a06361036ed4`** |
| merge base | `edd957e…` — identical to main, so the branch is a clean descendant |
| commits unique to the candidate | **18** |
| commits on main not in the candidate | **0** |
| changed files vs main | **160** (5,789 insertions, 4,998 deletions) |
| proposed production range | `edd957e..518d90a` |

An earlier draft of this document said 13 commits and referenced an intermediate
SHA. That was written mid-work and was wrong by the time it was committed. The
numbers above are read from `git rev-list`/`git diff` against the fetched remote.

The count grew from 13 because the branch has since gained the type-floor,
table-grammar, Games-hierarchy, image and consolidation passes, the alt-audit
correction, this report, the mobile-nav gate, and the merge of production main.

**Production status:** the mobile-navigation hotfix has shipped (see §16). The
worldclass candidate has NOT been merged.

All figures below are measured by rendering the working tree against live
production APIs in real headless Chrome, not estimated.

---

## 1 · Before / after visual system

| | Before (`main`) | After (`worldclass-pass`) |
|---|---|---|
| Ground | `#06090f` cold blue-black | `#14110d` parent warm ink |
| Surfaces | 8 rival palettes | `#1d1914` / `#2a241c` parent tones |
| Brand accent | green `#55d68c` | **gold `#d4af37`** (parent) |
| Green | brand identity | semantic only, retoned `#4ea373` |
| Crimson | `#f16b78` | `#c1273d` / `#e63946` (parent, verified from source) |
| Display face | Barlow Condensed | **Playfair Display**, rationed to brand moments |
| UI face | DM Sans | **Inter** |
| Data face | DM Mono | **JetBrains Mono**, tabular figures |
| Token authority | 13 `:root` blocks, 182 properties, 14 namespaces | **1 `:root`** |
| Hardcoded hex | 756 distinct, 1,798 uses | remapped to tokens; 186 left deliberately (team/chart hues) |
| Structural device | none | parent's gold rule + mono eyebrow, product-wide |
| Nav model | 23 flat destinations, two unlabelled rows | **TODAY / INTELLIGENCE / TOOLS / ARCHIVE** |
| Shell chrome | 309px, 5 strips | **252px**, 3 strips |
| Dead files | 31 unreferenced (278 KB) | **0** |

## 2 · Route × viewport audit

**110 combinations** — 22 routes × 1440 / 1280 / 768 / 430 / 390.

| Metric | Before | After |
|---|---|---|
| Routes rendering with live renderer | 24/24 | 24/24 |
| Console errors | 0 | **0** |
| Horizontal overflow | 0 | **0** |
| Broken images | 0 | **0** |

## 3 · WCAG

| | Before | After |
|---|---|---|
| AA contrast failures | **2,281** | **0** |
| Images missing an `alt` attribute | 0 | **0** (8 deliberately decorative `alt=""`) |
| `:focus-visible` treatment | absent from 607 KB of CSS | gold ring product-wide |
| Skip link | none | present |
| `prefers-reduced-motion` | honoured nowhere | honoured globally |
| Colour-only meaning | movement, status | every semantic paired with glyph or word |

## 4 · Smallest text remaining

| | Before | After |
|---|---|---|
| Smallest rendered text | **4.6px** | **10px** |
| Text nodes below 10px | **4,248** | **0** |

10px now appears only in its inherited role — tracked uppercase mono eyebrows,
badges, column heads and timestamps. Every player name, venue, stat label,
market number, action link and descriptive sentence sits at 11–14px.

Worst offenders, before → after: Prop Board 633 → 14, Super Bowls 207 → 9,
News 378 → 60, Teams 168 → 7, Standings 168 → 10, Games 270 → 25.

## 5 · Overflow

Zero horizontal document overflow at every route and width. The 6px reported at
1440/1280 is the scrollbar gutter, not content (`scrollWidth 1446` vs
`clientWidth 1440`); at 768/430/390 it is exactly 0.

## 6 · Broken images

0 across 1,130 images at 1440.

## 7 · Console errors

0, across every route at every width, and 0 exceptions in the fault-injecting
recovery soak.

## 8 · Observer alarm

`scripts/observer-alarm-check.mjs`: **PASS** — alarm installed, `count: 0`,
still `0` after a synthetic mutation storm (the guard can still fire).
`scripts/scan-observers.mjs`: **Observer safety OK across 53 active modules.**

## 9 · Cumulative layout shift

| | Before | After |
|---|---|---|
| Dashboard, 1440 | **0.175** | **0.005 – 0.038** |
| 1280 | — | 0.0025 |
| 768 / 390 | — | **0** |

Cause was not images: the JS-built shell was inserted above `.shell`, so every
page rendered at y=0 then dropped by the shell's height. `index.html` now
reserves the slot in critical inline CSS at the measured height per breakpoint
(252 / 175 / 163px) and the shell mounts into it. Reserved matches actual to
the pixel at every breakpoint.

## 10 · Request count

| | Before | After |
|---|---|---|
| Total requests | 223 | **225** |
| CSS | 64 | 64 |
| JS | 68 | 68 |
| API | 40 | 40 |
| FCP | 1,208–1,496 ms | 1,336 ms |
| Load | 1,146–4,527 ms | 1,290 ms |

**This did not improve, and the reason is a finding rather than an omission.**
See §11.

## 11 · CSS count

| | Before | After |
|---|---|---|
| Stylesheets | 65 | **66** (+`pbe-tokens.css`, +`pbe-system.css`, −1 retired) |
| `:root` blocks | **13** | **1** |
| Distinct token namespaces | 14 | 1 (+ aliases that retire with their surfaces) |

`scripts/css-ownership.mjs` walks every rule in all 66 stylesheets across all 24
routes and counts how many match a live element. Seven sheets matched nothing:
`dashboard-v5`, `pbecast-v4`, `pbecast-v5`, `simulator-v3-enhance`,
`player-research-v2`, `model-lab-v2-enhance`, `prop-board-responsive-v5`.

**None is safe to delete.** Every class each one styles is still emitted by a
module the loader ships — they are Pro-only views, the player research drawer,
and the Dashboard/PBEcast fallback renderers, none of which a logged-out route
sweep ever opens. Deleting on "did not match during a sweep" would have removed
the player drawer's entire stylesheet.

So the 66 stylesheets are a live state and fallback chain, not dead
archaeology. The honest remaining cost is request count, and reducing it needs
either a build step or retiring the fallback generations deliberately — both
real projects, neither safe to do blind. The measured page cost is already
acceptable (FCP 1.3s, load 1.3s); the count is an architecture debt, not a
current user-facing problem.

*(That analyzer had a bug worth recording: Chrome supports CSS nesting, so every
`CSSStyleRule` exposes a truthy but empty `cssRules`. Recursing on truthiness
alone skipped every style rule and reported all 66 sheets — including the token
file — as completely dead.)*

## 12 · Transferred image weight

| | Before | After |
|---|---|---|
| Stadium layer, per page load | **~1,965 KB** | **~217 KB desktop / ~182 KB phone** |
| Desktop background | 399 KB JPEG (1920×1080) | 139 KB WebP (1440w) |
| Phone background | 375 KB JPEG (1200×1600) | 104 KB WebP (820w) |
| Picker swatches (×4) | 217–366 KB each — the full portrait file | 13–19 KB each (240w) |
| Unsplash layers | requested at 2200–2400px | 1400–1600px WebP |
| Repo masters | shipped | excluded via `.vercelignore` |
| Images lazy-loaded | 258 | **1,786** |

Encoded for how the layer is actually displayed — opacity .18 behind a blur —
so a light pre-blur lets the encoder spend bits on shapes that survive.

## 13 · Deep-link smoke

`scripts/deeplink-smoke.mjs` — **all 5 cases pass**:

```
PASS  player deep link        /?player=Drake%20Maye#propboard -> research drawer opens on Drake Maye
PASS  event deep link         /?event=<id>#marketwatch        -> event-scoped terminal
PASS  hash-borne params       /#propboard?player=Sam%20Darnold
PASS  plain route still works /#games                         -> unaffected
PASS  link() builder          App.link('marketwatch',{event,player})
```

Funnel coverage: Game → Props / Matchup / Usage / SGP Lab / Market / Game Center
all carry the event id. News → Player lands in the research drawer. Player →
Props / Usage / Stats / Records / Hall of Fame. No cross-link was manufactured
where entity resolution is uncertain.

## 14 · API / auth / paywall regression

- `node --test tests/*.test.mjs` — **53/53 pass** (auth, signing secret, prop
  grader, prop picker, prop tuner).
- `node scripts/check-syntax.mjs *.js` — **59/59 parse**.
- `node scripts/recovery-browser-smoke.mjs` — **RESULT PASS**: 24/24 routes
  alive, 0 broken images, 0 exceptions, 36-navigation soak responsive, injected
  Usage fault recovered, mobile navigation reporting `bottom:"block"`.
- No `/api/*` handler, auth flow, Stripe path, entitlement check or model
  logic was modified. Paywall *presentation* changed; gating did not.
- Pro gating verified intact: Market Watch, Model Lab and Matchups render
  locked previews for a signed-out user with values withheld, not exposed.

## 15 · Exact-head acceptance test

Run against the **Vercel preview of `518d90a`** — real hosting, real routing,
real `/api` functions, not local file substitution:
`nfl-propbetedge-74s6beg6g-justins-projects-ad4f4bb7.vercel.app`

**20 surfaces × 7 widths (390 / 430 / 768 / 900 / 901 / 1280 / 1440) = 140
combinations.** Per combination: renders with a live renderer, no horizontal
overflow, no broken images, no image missing an alt attribute, no text below
10px, exactly one active nav item, nothing readable clipped, no fabricated
content markers, no console exceptions.

**Result: every check passes except the known pre-existing 901px 14px
overflow**, which appears on all 20 surfaces because it is a shell-level issue,
and which is confirmed identical on `main`.

Targeted checks, all passing:

```
deep link: player   /?player=Drake%20Maye#propboard -> drawer opens on Drake Maye
deep link: event    /?event=<id>#marketwatch
deep link: hash     /#propboard?player=Sam%20Darnold
locked states       Market Watch 24 rows / 96 locked cells / 1 CTA
                    Prop Board 78 rows, 0 lock buttons in body, 3 locked headers
                    Model Lab 2 free rows, no fabricated values
news trust          guard installed, 5 of 12 deks suppressed,
                    0 uncorroborated attributions, 0 false Mahomes
player drawer       opens; funnel links Usage / Stats / Records / HOF / Prop Board
                    layers MARKET CURRENT | MODEL PRO | NEWS NONE | ARCHIVE MATCHED
```

Visual review of the captured surfaces confirmed hierarchy, alignment,
typography, tables, team/player media, and live/model/unavailable semantics.
Game Center reads honestly pre-game: "WAITING FOR THE NEXT PUBLISHED PLAY",
"PUBLISHED PLAYS 0", "WP UNAVAILABLE", "Unsupported live model and usage inputs
remain explicitly offline". Injury Intelligence carries its provenance
disclaimer and shows "Timeline not reported" rather than inventing one.

### Key surfaces

Captured at 1440 and 390, `scratchpad/shots/FINAL/` and `scratchpad/accept/`:

- **Dashboard** — featured game centred (was 60px off axis), kickoff time as the
  hero value, core market inline, wire in Playfair under a gold rule, trust
  guard visibly suppressing the corrupted deks.
- **Prop Board** — 70-row market table, no lock pills in the body, three locked
  columns with one CTA.
- **Market Watch** — the real terminal for free users: every row, real players,
  live consensus, four locked columns.
- **Games** — compact slate, six working intelligence links per game, selected
  event emphasised.
- **Stats archive** — podium + gold-ruled sticky table with tabular figures.

## 16 · Commits proposed for production

**Already shipped — mobile-navigation hotfix:**

```
edd957e  Give phones a working navigation instead of an off-screen desktop rail
```

Merged fast-forward to `main` and deployed. Production went `f83800a` →
`edd957e`. Verified live: the blanket-hide rule is gone from the served
`sports-shell-v1.css`, the 901px media query and both added drawer destinations
are present. Post-deploy gate against the deployed bundle passed at 390, 430,
768, 900 and 1440 with the single known 901px exception; observer alarm
installed and silent.

**Proposed — worldclass candidate:** `edd957e..518d90a`, **18 commits, 160
files**. Verified by acceptance test against the Vercel preview of that exact
commit (§15).

**Rollback point:** production deployment `dpl_4XC7MuENrSrUA2c8kiRxCXboe8ns`
(`f83800a`), flagged by Vercel as a rollback candidate. The currently live
deployment is `dpl_9nwVc116doqVptFQumcusCPNZrrV` (`edd957e`), also a rollback
candidate, which is the point to return to if the worldclass merge misbehaves.

## 17 · Known imperfect

0. **Game Center still renders an em-dash score placeholder.** `.cast6-score-center`
   shows `—:—` beside the kickoff time on a scheduled game, which reads as two
   blank bars. It is the same placeholder class fixed on the Dashboard hero, on
   a surface this work did not rebuild; the kickoff time is present, so no
   information is missing. Deliberately NOT changed after the acceptance run,
   because editing the tree would invalidate the exact-head preview that 140
   combinations were tested against. One-line fix, next change window.

1. **The news corruption is contained, not fixed at source. The writer defect
   is UNRESOLVED.** Root cause is now located precisely:
   `propbet-news-enrich/src/index.js` hashes the scraped source body and, on a
   hash match, clones the matched article's body, summary and entire take onto
   the new row (`action: "cloned_from_duplicate"`). Its only precondition is
   that the body is ≥200 characters; the titles are never compared. When the
   source fetch returns the same non-article content for several URLs — a nav
   shell, consent wall or block page — every one hashes identically and inherits
   one real article's editorial.

   Both workers are now under version control with their deployed state as the
   first commit, and both fixes sit on branches, **neither deployed**:

   - `propbet-news-api` `fix/content-integrity` — read-layer containment at the
     single choke point every consumer shares. 13 tests. Verified against live
     payloads twice: the original snapshot (5 shared summaries → 0, 5 false
     Mahomes attributions → 0, 5 withheld / 7 intact) and the current feed
     (4 → 0, 2 → 0, 4 withheld / 8 intact). Zero false positives.
   - `propbet-news-enrich` `fix/duplicate-clone-guard` — requires the two titles
     to share distinctive tokens before anything is cloned; on mismatch it
     clones nothing, leaves the article unpublished, and records
     `source_body_hash_collision_with_unrelated_title`. 7 tests. **Not
     verifiable end to end from here** — the worker holds its Supabase
     credentials as Cloudflare secrets — so the predicate is covered but the
     integration is not.

   Rows already corrupted in the database are not repaired by either change.
   They need a backfill or re-enrichment; the read-layer guard is what protects
   consumers meanwhile.

2. **The old item 1 continues below.** Five of twelve NFL rows —
   every `pro-football-talk` row, with no healthy one — carry one Mahomes
   article's entire summary, body, take summary, take advice and player tag.
   `propbet-news-api` is a faithful pass-through of `v_news_with_takes`; the
   writer that fans one enrichment across a source batch is **not on this
   machine** (not in `content-workers`, `content-bot`, or `news-mvp`, which is
   the unrelated real-estate system). I fixed the deepest layer reachable — a
   guard at the read API's single choke point, protecting the news site, RSS,
   sitemap, The Algo and both sport apps — plus the frontend guard. Verified on
   the live payload: 5 corrupted rows withheld, 7 healthy rows untouched, zero
   false positives. **Not deployed.** See `propbet-news-api/CONTENT-INTEGRITY.md`.
2. **`GET /news/article/{slug}` is still exposed.** One row has no siblings, so
   cross-row reuse is undetectable there. Title-only corroboration was rejected
   because it strips correct attributions from healthy articles. Pinned by a
   test so it cannot be mistaken for coverage.
3. **Request count unchanged** (§11) — needs a build step or deliberate
   retirement of the fallback generations.
4. **901px has 14px of horizontal overflow.** Pre-existing on `main`, confirmed
   identical there, so not a regression — but still open.
5. **Model Lab and Matchups are thin** (1,474 and 2,006 chars) because the
   current event only has passing markets for two quarterbacks. That is honest
   data, not a layout failure, but the surfaces will look sparse until a fuller
   slate posts.
6. **PBE model has no published picks yet** (validation gate reads 0/100, 0/4
   weeks), so the Dashboard cannot yet show model signal. Deliberately not
   faked.
7. **`propbet-news-api` is not under version control.** The previous entry point
   is backed up as `src/index.js.pre-integrity-<timestamp>.bak`.
8. **`stadiums/*.jpg` masters remain in git history** (~3.5 MB). Excluded from
   deploys, not from the repo.
