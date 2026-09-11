# NFL Sunday Command Center + Product Loop — Milestone 1

Branch `nfl-product-depth-v1`, cut from `main` @ `07f6725` on 2026-09-11. **Main is untouched.
Nothing is deployed to production. Nothing is merged.** Previews are git-integration builds of
this branch (target: preview).

Companion documents: `NFL_REPLAY_ARCHITECTURE.md` (post-game layer and pipeline),
`NFL_INTELLIGENCE_TOOLS_ROADMAP.md` (football-native tools, change ledger, alerts, news
linking).

---

## 1 · Audit before edits (measured, 2026-09-11, production)

Measured with `scripts/product-loop-gate.mjs --live` (headless Chrome, cache disabled, 12 s):

| Finding | Measured |
|---|---|
| Home load | **262 requests**, **59 API calls** in 12 s — 28 `/api/nfl-live`, 14 `/api/news-feed`, 4 `/api/home-market` |
| Cause | dashboard v5, v6 and v7 all registered `home` and each ran a scoreboard + event + news round on boot; v7 `load()` was re-entered by four boot paths |
| Home content | one featured game, a core-market box, the news wire and a tool rail. No slate, no changes, no picks state, no injuries |
| Dashboard → PBEcast | "Open PBEcast" focused through `PBEcastV5/V4.focus` — both retired — so PBEcast opened whatever game it chose |
| `/api/injuries` | a stub worker (`{"worker":"nfl-injuries","status":"ok"}`) — no injury data behind it |
| PBEcast | one game at a time; the board lane ran at the 30 s idle cadence whenever the *focused* game was not live, even with other games live |
| Picks engine | `ENGINE GATED — MODEL VALIDATION IN PROGRESS`, 0 official picks, graded sample 3/100, 1/4 weeks — honest, and correctly not faked |
| Text below the 10 px floor | 6 nodes on home (tool badges at 9 px) |

## 2 · What shipped, by brief section

| § | Shipped | Files |
|---|---|---|
| 2 Game-day home | **Sunday Command Center**: the slate above the featured game (LIVE / NEXT KICKOFF / FINAL / LATER, live situation, snapshot consensus line, OUT/Q counts per game). The week as a loop. Top sourced changes, picks engine state verbatim, best-line shopping. The manifesto stays off the dashboard | `nfl-command-center-v1.{js,css}`, `dashboard-v7.js` |
| 3 What Changed | `#changes` route and `/api/nfl-changes`: ESPN injury designations with ESPN's own update time, game disruptions, market-tape moves (key numbers 3/7/10), NWS weather. Game availability grid. Each row links player → market & research drawer → DNA → PBEcast | `what-changed-v1.{js,css}`, `api/nfl-changes.js`, `api/_changes/core.js` |
| 4 PBEcast | **Sunday board** of every game (score, clock, possession, down & distance, red zone) from v6's existing scoreboard lane. **Around the league** feed diffed from scoreboard frames, stamped with observation time. **Before kickoff** context for scheduled games. The board lane runs at live cadence while any game is live. No geometry | `pbecast-command-v1.{js,css}`, `pbecast-v6.js` (cadence, source label, image dims) |
| 5 Replay | Replay v0 for FINAL games: scoring / turnover / explosive jumps and a drive chart. **Post-game enrichment**: nflverse EPA / WPA / air yards / YAC / CPOE / passer→receiver joined by ESPN play id, plus a **Biggest swings** jump list. LIVE SOURCE and POST-GAME ENRICHED are labelled separately | `api/replay-enrich.js`, `api/_replay/nflverse.js`, `NFL_REPLAY_ARCHITECTURE.md` |
| 6 Tools | Roadmap with verified 2026 source availability | `NFL_INTELLIGENCE_TOOLS_ROADMAP.md` |
| 7 Best Line | `#bestline` route and `/api/best-line`: best available price (best number, then price, named book), market consensus (median line; vig-free from two-sided books only), PBE fair value and model edge as separate columns left blank by design. Book leaderboard, player-prop shopping, snapshot age. Folds per game on phones | `best-line-v1.{js,css}`, `api/best-line.js`, `api/_bestline/core.js` |
| 8/9 Picks + Track Record | Home shows the engine's own state, the official counts and the gate progress, with direct paths to PBE Picks and Track Record. The loop strip on every loop surface puts Track Record and Replay one tap away. "PBE PICK AFFECTED" flags a HIGH change in the game of an open official pick (Pro session only; the join is on game identity) | `nfl-command-center-v1.js`, `what-changed-v1.js` |
| 10 Alerts | Designed (triggers, anti-spam, delivery, fan-out) | roadmap § Alerts |
| 11 News | Trust guard retained. Player → drawer linking from What Changed. Id-first entity resolution designed | roadmap § News |
| 12 Community | The verified permanent Discord invite (`discord.gg/kb5zCTHbME`, no expiry, the MLB product's link) in the network footer and one line on the dashboard. Three other invite codes in the network repos no longer resolve | `network-footer-v1.js` |
| 13 Performance | See §4 | `page-loader.js` |
| 14 Cloudflare | No GitHub Actions runtime added. Every workflow is push-to-main / PR / manual CI (checked). The change ledger and replay pipeline are designed as Cloudflare Cron + Workflow + D1/R2/KV | docs |

## 3 · Truth rules this milestone enforces

- A change names its source and the **source's** time. "Updated" is never written as "changed
  from": ESPN's report has no prior designation.
- A designation for a game already final is history. It stays visible but is never material.
- An unavailable source is shown as **UNAVAILABLE with its reason**. A failed read is never an
  empty list: market tape on previews, the picks backend on previews, an unpublished nflverse game.
- The scoreboard gives points, not plays, so the around-the-league feed reports `SF +7` and does not
  name the play.
- Weather at a fixed-roof venue is labelled indoor and never material.
- Best price, consensus, PBE fair value and model edge are four columns. Fair and edge are blank
  where no fair value is published, and are never estimated from consensus.
- Post-game values appear only on final games, only with their label and publication time.
- No player or ball geometry anywhere. PBEcast says so on screen.

## 4 · Performance

1440, 12 s window, cache disabled, live APIs:

| | production `07f6725` | branch |
|---|---|---|
| Home requests | 262 | **212** |
| Home API calls | 59 | **26** |
| `/api/nfl-live` on home | 28 | 5 |
| `/api/news-feed` on home | 14 | 2 |
| Module stylesheets / scripts injected at boot | 61 / 60 | **57 / 56** (4 new modules added, 6 archive modules lazy, v5/v6 gone) |

How: dashboard v5/v6 unloaded; v7 `load()` coalesces concurrent calls and repaints from state
within 15 s; hidden tabs hold no dashboard poll. Six archive routes (Standings 2025, Seasons, Hall
of Fame, Records, Super Bowls, Draft) lazy-load on first open, with their CSS inserted at the
original cascade position; all six render character-for-character what production renders.
Deleted (unreferenced): dashboard-v5/v6, PBEcast v4/v5/v5-renderer, Prop Board v4 and
responsive-v5, and 3.7 MB of stadium JPEGs superseded by the WebP set. Images the new surfaces
render carry intrinsic dimensions, and the v6/v7 news and PBEcast images gained them too.

Bytes: the branch transfers more per home load in the local gate because `/api/nfl-changes`
(~226 KB) and `/api/best-line` (~118 KB) are served uncompressed by the in-process handler. On
Vercel both are compressed and shared-cached (`s-maxage` 120 s / 60 s).

## 5 · QA

`scripts/product-loop-gate.mjs` renders the working tree against live production APIs, or a
deployed preview with `--live` + `PBE_GATE_BOOTSTRAP`. It asserts: no console errors, no horizontal
overflow, no broken images, no text under 10 px, and per-route contracts (command center mounted
above the hero, every change row names source and time, the four best-line terms defined
separately, single `.pbecast6` root, the Sunday board mounted, no geometry elements).

## 6 · Status

**PROVEN**
- Branch cut from current main (`07f6725`); main unchanged; every commit pushed.
- Home answers "what is happening now": slate, loop, changes, engine state, best line, all above
  the news wire. Measured request reduction (§4).
- What Changed live on real ESPN data: 800 report entries → material rows with source times;
  game availability for 14 open games.
- Best Line live on the real snapshot: 15 games, 11 books, consensus and vig-free from two-sided
  books only; unit-tested.
- PBEcast Sunday board, around-the-league diffing, before-kickoff context; Replay v0 on SF @ LA
  (6 scoring plays = 27–7, 4 turnovers, 19 drives).
- Post-game enrichment on real nflverse data: 147/169 ESPN plays joined by key (the 22 unjoined
  are all stoppages); EPA/WPA/air/YAC shown only on the final game, labelled.
- Gate: all routes pass at 1440/1280/1024/390/360 on the working tree, and 1440/390 on the
  deployed preview.
- Unit tests: 79/79 in `tests/`. Full suite (`tests/` + `research/`): 339 tests, 335 pass, 3 skipped,
  1 fail — `archive teamCrest`, which fails identically on untouched main.

**IN PROGRESS / DESIGNED**
- Change ledger worker (status transitions, depth-chart diffs) — designed, not built.
- Alerts — designed; delivery depends on the ledger.
- Replay production pipeline (Cloudflare Workflow → R2 per game) — designed; the prototype read
  path is bounded at 8 MB gzipped (estimated to be reached around week 8).
- Usage Shift / Volume Watch / Red Zone Lab — sources verified, not built.

**BLOCKED**
- Market movement on previews: `nfl_odds_snapshots` is service-role only, and previews carry no
  `SUPABASE_SERVICE_ROLE_KEY`. It shows UNAVAILABLE with that reason. It needs production (or the
  key added to preview env — an owner decision).
- PBE Picks on previews: `/api/pbe-picks` returns `picks_backend_unavailable` for the same reason.
  The home panel shows the failure, not "no picks".
- Game-day inactives: no verified structured public source.
- Production deploy / merge: awaiting approval.

**UNVERIFIED**
- Market-move detection against the real tape (logic unit-tested on tape-shaped fixtures; never
  run against production rows).
- PBE PICK AFFECTED against a real official pick. There are 0 official picks while the engine is
  gated.
- Live-game behaviour of the Sunday board and around-the-league feed. No game was live during this
  session (next kickoff Sun 2026-09-13 17:00 UTC); only scheduled and final states were exercised.
- The existing PBEcast refresh / nav / resilience / latency gates were not re-run during a live
  game.
