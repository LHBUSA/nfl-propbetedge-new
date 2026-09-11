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
| 3 What Changed | `#changes` route and `/api/changes` (nfl-intel Worker): ESPN injury designations with ESPN's own update time, game disruptions, market-tape moves (key numbers 3/7/10), NWS weather. Game availability grid. Each row links player → market & research drawer → DNA → PBEcast | `what-changed-v1.{js,css}`, `workers/nfl-intel/` |
| 4 PBEcast | **Sunday board** of every game (score, clock, possession, down & distance, red zone) from v6's existing scoreboard lane. **Around the league** feed diffed from scoreboard frames, stamped with observation time. **Before kickoff** context for scheduled games. The board lane runs at live cadence while any game is live. No geometry | `pbecast-command-v1.{js,css}`, `pbecast-v6.js` (cadence, source label, image dims) |
| 5 Replay | Replay v0 for FINAL games: scoring / turnover / explosive jumps and a drive chart. **Post-game enrichment**: nflverse EPA / WPA / air yards / YAC / CPOE / passer→receiver joined by ESPN play id, plus a **Biggest swings** jump list. LIVE SOURCE and POST-GAME ENRICHED are labelled separately | `workers/nfl-replay/`, `NFL_REPLAY_ARCHITECTURE.md` |
| 6 Tools | Roadmap with verified 2026 source availability | `NFL_INTELLIGENCE_TOOLS_ROADMAP.md` |
| 7 Best Line | `#bestline` route and `/api/best-line` (nfl-intel Worker): best available price (best number, then price, named book), market consensus (median line; vig-free from two-sided books only), PBE fair value and model edge as separate columns left blank by design. Book leaderboard, player-prop shopping, snapshot age. Folds per game on phones | `best-line-v1.{js,css}`, `workers/nfl-intel/src/bestline-core.js` |
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

Bytes: `/api/changes` and `/api/best-line` are served by the Worker with Brotli compression and
`max-age=60`.

## 5 · QA

`scripts/product-loop-gate.mjs` renders the working tree against live production APIs, or a
deployed preview with `--live` + `PBE_GATE_BOOTSTRAP`. It asserts: no console errors, no horizontal
overflow, no broken images, no text under 10 px, and per-route contracts (command center mounted
above the hero, every change row names source and time, the four best-line terms defined
separately, single `.pbecast6` root, the Sunday board mounted, no geometry elements).

## 6 · Runtime architecture (Milestone 1.1 — Cloudflare-owned)

Owner ruling 2026-09-11: GitHub Actions = CI/tests only · Vercel = frontend hosting/build/preview ·
Cloudflare Workers = API/runtime · Cloudflare Cron / Queues / Workflows = scheduled/background
work · KV / R2 / D1 / Supabase = persistence. The prototype Vercel routes `api/nfl-changes.js`,
`api/best-line.js` and `api/replay-enrich.js` were **deleted**, not kept as proxies. The frontend
calls the NFL gateway (`nfl-api.propbetedge.ai`), which routes to two new Workers through
service bindings:

```
browser ─► nfl-api.propbetedge.ai (nfl-gateway)
             ├─ /api/changes, /api/best-line ─► nfl-intel  (KV NFL_INTEL; bindings nfl-current, nfl-odds)
             │     cron */10: injuries lane  — ESPN core API, 32 team lists + every record, athletes cached
             │                market lane    — new nfl-odds batch → consensus history (zero provider credits)
             │                weather lane   — NWS + Open-Meteo per game, every 30 min (PBE Breaking thresholds)
             └─ /api/replay/* ─────────────────► nfl-replay (R2 nfl-replay; Workflow nfl-replay-ingest)
                   cron 20 */3: nflverse asset changed? → one idempotent Workflow instance →
                                stream gunzip+CSV, one game in memory → R2 replay/<season>/<game>.json + index
```

**Why the injury source changed.** ESPN's `site.api` (the one-call league report) refuses
Cloudflare egress. The core API does not and serves the same records (status, ESPN `date`,
attributed note, details). Measured: ESPN's site report shows each team's **25 most recent**
records (800 = 32 × 25). The core API keeps every current record: 1,883 in the first run, with **0**
of the site report's restrictive designations missing. Designations older than 14 days are shown
with their update date so an old note never reads as fresh. Two ingest traps were found and fixed:
negative injury ids (e.g. `-2000004`) and team lists that keep records for players rostered
elsewhere (the athlete's own current team decides).

**Why market movement no longer needs Supabase.** nfl-intel records cross-book consensus per
nfl-odds batch in its own KV, keyed by batch id, through the nfl-odds service binding. History
starts at the first capture (2026-09-11 12:00 UTC batch). A move needs two captures, and until
then the page says so (`one_capture_so_far_a_move_needs_two`).

**Ledger seed.** Each injury run also stores the designation seen per athlete and appends a
transition when it changes between two of our own observations. It is stored, not displayed.
The product still says **UPDATED**, never CHANGED FROM, until the ledger milestone publishes
transitions.

**Replay.** Ingest once, read many: the Workflow streamed the full 2025 file (98 MB CSV, 285 games,
48,771 plays) in 1.8 s wall / 2.3 s CPU in the local simulation, output byte-identical to the
whole-file extractor. In production the first ingest wrote 2026's two published games. A read is
one R2 object (≈45 KB). The bounded 8 MB direct read survives only for a season with no index,
and answers `POST_GAME_ENRICHMENT_UNAVAILABLE` over the bound. The bound is not to be raised.

**Deployed versions and rollback**

| Worker | Version | Previous (rollback) |
|---|---|---|
| nfl-gateway | `e2c05c4b-08d1-4afd-9913-b5cfb2643639` | `95d5a419-c563-4452-ab24-625abf09e0ce` (`wrangler rollback` in workers/nfl-gateway) |
| nfl-intel | see `wrangler deployments list` (new Worker) | none — remove the gateway routes to disable |
| nfl-replay | see `wrangler deployments list` (new Worker) | none — remove the gateway route to disable |

## 7 · Status

**PROVEN**
- Branch cut from current main (`07f6725`); main unchanged until the approved merge; every commit
  pushed.
- Home answers "what is happening now": slate, loop, changes, engine state, best line, all above
  the news wire. Measured request reduction (§4).
- What Changed on the Cloudflare runtime against real ESPN core-API records (1,883 records, 32/32
  teams, 0 site-report restrictive designations missing); game disruptions from nfl-current; NWS +
  forecast weather from the Worker's own snapshot.
- Best Line on the Cloudflare runtime against the real snapshot: 15 games, 11 books; consensus and
  vig-free only from two-sided books; fair value and edge null.
- Replay enrichment on the Cloudflare runtime: SF @ LA served from R2 (`R2_INGESTED`, 157 plays);
  TB @ CIN `NOT_YET_PUBLISHED`; the Workflow completes and is idempotent per asset version.
- PBEcast Sunday board, around-the-league diffing, before-kickoff context; Replay v0 on SF @ LA
  (6 scoring plays = 27–7, 4 turnovers, 19 drives).
- Tests: full suite (`tests/` + `research/`) 355 tests, 352 pass, 3 skipped, **0 fail**. The
  `archive teamCrest` failure was not a product failure. The test's function extraction matched LF
  only, and a Windows checkout with `core.autocrlf=true` is CRLF; CI on Linux would have passed. The
  extraction is now line-ending agnostic with the same assertions, and it still rejects a synthetic
  shield (proven with a mutated copy).

**IN PROGRESS / DESIGNED**
- Durable change ledger (publishing transitions, depth-chart diffs from nflverse `depth_charts`,
  D1 event table). Seeded in KV now, not displayed.
- Alerts — designed; delivery depends on the ledger.
- Usage Shift / Volume Watch / Red Zone Lab — sources verified, deliberately not built until the
  ledger and replay persistence are established.

**BLOCKED**
- PBE Picks and Track Record on previews: the existing entitlement-aware `/api/pbe-picks`
  (pre-existing Vercel route with the service-role key) returns `picks_backend_unavailable` on
  previews. Production is unaffected.
- Game-day inactives: no verified structured public source.

**UNVERIFIED**
- Market moves on real data: history began at the 2026-09-11 12:00 UTC batch, and the first
  comparison needs the next ingest (13:00 / 18:00 ET).
- PBE PICK AFFECTED against a real official pick — 0 official picks while the engine is gated.
- Live PBEcast behaviour (status transitions, cadence, around-the-league, scoring transitions,
  source delay, audio cues, recovery). No game was live; it stays UNVERIFIED until the first live
  slate is observed.
