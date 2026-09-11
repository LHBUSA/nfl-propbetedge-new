# NFL-Native Intelligence Tools — Roadmap

Written 2026-09-11 on branch `nfl-product-depth-v1`. The rule: a tool ships only when a
**defensible source field** backs every number it shows. Tools are not cloned from MLB names, and
none exist to inflate a tool count. The source availability below was checked against the nflverse
release API and live ESPN endpoints on 2026-09-11.

## Source inventory (what is actually reachable)

| Source | 2026 asset | Latency | Reachable from | Licence / terms |
|---|---|---|---|---|
| ESPN scoreboard / summary (live state, play log, box score) | live | ~16–30 s | Vercel (site.api 403s Worker egress) | public endpoints, attribution |
| ESPN injury records, core API (`teams/{id}/injuries` → records) | live | 10-min ingest | **Workers** (nfl-intel) | as above — site.api's league report caps each team at 25 and 403s Workers |
| ESPN core API depth charts (`seasons/2026/teams/{id}/depthcharts`) | live | unknown cadence | Workers + Vercel | as above |
| nflverse `play_by_play_2026` | ✅ | next day | anywhere | CC-BY-4.0 |
| nflverse `snap_counts_2026` (keyed by `pfr_player_id`) | ✅ | next day | anywhere | CC-BY-4.0 (PFR-derived) |
| nflverse `depth_charts_2026` (snapshot `dt` timestamp, `espn_id` + `gsis_id`) | ✅ | snapshots (latest `dt` 2026-09-11T12:21Z) | anywhere | CC-BY-4.0 |
| nflverse `injuries_2026` (`report_status` + `practice_status` per player per **week** — no intraday timestamp) | ✅ | through the week | anywhere | CC-BY-4.0 |
| nflverse `roster_weekly_2026` | ✅ | weekly | anywhere | CC-BY-4.0 |
| nflverse `pbp_participation` (formation, personnel, box) | ❌ 2024–2025 only | season-gated | — | CC-BY-4.0 |
| nflverse `ftn_charting` (pressure, play action) | ❌ none for 2026 | season-gated | — | CC-BY-SA-4.0 (check before commercial use) |
| nflverse `pfr_advstats` | ❌ none for 2026 | — | — | — |
| PropBetEdge market tape `nfl_odds_snapshots` | live (3 ingests/day) | scheduled | service role only | internal |
| nfl-odds KV snapshot (`/api/odds`, `/api/odds/board`) | live | scheduled | public read | internal |
| Player tracking (NGS 10 Hz) | never public | — | — | licence-blocked |

## The tools, in build order

### 1 · USAGE SHIFT — *highest leverage, sourced now*
**Question:** whose role just changed?
**Fields:** `snap_counts_2026` offense_pct / offense_snaps per player per game;
`play_by_play_2026` targets (receiver_player_id), carries (rusher_player_id), red-zone opportunities
(`yardline_100 <= 20`); `depth_charts_2026` position rank.
**Shows:** week-over-week snap share delta, target share and carry share deltas, and the teammate
availability that coincided with the shift (from the injury ledger). The coincidence is shown and
never asserted as the cause.
**Not shown:** routes run. There is no public 2026 source; route participation stays UNAVAILABLE.
**Joins:** `roster_weekly_2026` carries `gsis_id`, `espn_id` and `pfr_id` on one row, so snap counts
(`pfr_player_id`), play-by-play (`gsis`) and ESPN (athlete id) join by id — never by name.

### 2 · VOLUME WATCH
**Question:** is this prop line pricing the volume the player actually gets?
**Fields:** pass attempts, rush attempts, targets and receptions per game (pbp aggregates), and the
current market line (`/api/odds/board`).
**Shows:** a rolling 1/3/season volume line against the current prop line and the issued PBE line.
An expected role appears only when a PBE model publishes one, labelled **MODEL**.

### 3 · RED ZONE LAB
**Question:** who gets the ball inside the 20, and inside the 5?
**Fields:** pbp `yardline_100`, `rusher_player_id`, `receiver_player_id`, `touchdown`,
`goal_to_go`.
**Shows:** team red-zone trips and conversion, player red-zone carries and targets, and goal-line
share. It pairs directly with anytime-TD prices on Best Line.

### 4 · MATCHUP LAB (evolves the existing Matchups route)
**Fields:** team EPA per play split by pass and rush, allowed and gained (pbp); explosive-play rate
(yards ≥ 20); pressure only once FTN 2026 exists.
**Rule:** every split carries its sample size (plays), and a split under 50 plays is labelled
**LIMITED SAMPLE**.

### 5 · QB DNA (exists — extend, do not rebuild)
The existing research (`research/qbdna`, `api/qb-dna*`) is the base. Next: `cpoe`, `air_yards` and
`pass_oe` by game from pbp, and time-to-throw from NGS weekly aggregates (the nflverse
`nextgen_stats` 2026 naming is not verified yet). Pressure splits wait for FTN 2026.

### 6 · WEATHER / GAME ENVIRONMENT (exists as PBE Breaking weather + What Changed)
Next: a per-game environment card (roof state, wind band, precipitation band, NWS alerts) inside
Best Line and PBEcast Before Kickoff. The existing thresholds in `api/_breaking/weather.js` stay the
only thresholds. Weather is never credited with a market move.

### 7 · BEST LINE (shipped in this milestone)
Next: an anytime-TD shopping view; alt-line ladders where the snapshot carries them; closing line
per game from `nfl_odds_snapshots.is_closing` for CLV. The best/consensus/fair/edge separation is
permanent.

### 8 · MARKET MOVEMENT (shipped as What Changed · market)
Next: a per-game movement chart from the market tape (consensus line per ingest), with key-number
crossings marked. Moves are never attributed to news unless a sourced event shares the timestamp
window, and even then the page shows both facts, not a causal claim.

### 9 · PROP BOARD / PBE PICKS / TRACK RECORD (exist)
No new tool. Connect them: the Prop Board row links to Best Line for that player and market; a
Track Record row links to its Replay (prop-progress history, see `NFL_REPLAY_ARCHITECTURE.md` §7).

## What Changed — the change ledger (DESIGNED, Cloudflare-owned)

The shipped What Changed reports current designations with ESPN's own update time. **Transitions**
(QUESTIONABLE → OUT, unexpected ACTIVE, depth-chart moves) need prior observations.

**Seeded 2026-09-11:** the nfl-intel injuries lane already stores the designation it saw per athlete
(`inj:v1:state`) and appends a transition between two of its own observations
(`inj:v1:transitions`). It is not displayed. The ledger milestone moves this into D1 and publishes it:

```
Cron */10 in season  ->  nfl-changes Worker
  injuries:     ESPN core API records (Worker-reachable; dated by ESPN) — already ingested by nfl-intel;
                nflverse injuries_2026 (report_status + practice_status per week) as the
                weekly reference — it has no intraday timestamp, so it never dates a change
  depth charts: nflverse depth_charts_2026 snapshots (dated by `dt`, keyed by espn_id)
                diffed snapshot to snapshot; ESPN core API depthcharts as a cross-check
  market:       nfl-odds batch_id change -> consensus diff (same thresholds as api/_changes/core.js)
  ledger:       D1 table change_events(id, kind, subject_id, from, to, source, source_ts,
                observed_at, batch) — append-only, unique(kind, subject_id, to, source_ts)
  read:         /api/changes/transitions?since=  -> What Changed "changed from" rows
```

Inactives (the game-day ACTIVE/INACTIVE list, 90 minutes before kickoff) have **no verified
structured public source**. Until one is verified they are not shown. The UI never infers them from
the injury report.

## Alerts (DESIGNED)

Principle, from MLB: *tell the user when an assumption behind the bet just changed.* The
triggers are the ledger events above, filtered to what the user holds:

| Trigger | Source event | Fires for |
|---|---|---|
| Player ruled OUT / DOUBTFUL / SUSPENDED | ledger transition | followed player; official PBE Pick in that game |
| Unexpected ACTIVE | ledger transition Q/D → ACTIVE | same |
| Starter / depth change | depth-chart diff | followed player; picks on that team |
| Weather materially changed | `weatherEvents()` band transition or NWS alert (outdoor venues only) | picks in that game |
| Line crossed a key number / moved ≥ threshold | market tape diff | picks and watched markets |
| Prop market disappeared | board availability `IN_SNAPSHOT` → absent | watched props |
| Game delayed / postponed | scoreboard `STATUS_*` | everything in that game |
| PBE Pick materially affected | any HIGH change joined to an open official pick | Pro users holding it |

**Anti-spam:** at most one alert per subject per 30 minutes, with coalescing ("3 changes in DET @
BUF"). Quiet hours are the user's. Nothing fires for LOW severity. Every alert links to the What
Changed row that caused it.
**Delivery:** in-app first (What Changed badge plus a dashboard strip; this ships with the ledger),
then Web Push through a Worker with a Durable Object per user for dedupe and quiet hours. Email
digests are opt-in only.
**Fan-out** runs on a Cloudflare Queue consumer from ledger inserts, never from page polling.

## News → entity linking (DESIGNED)

Today: the trust guard (`pbe-news-trust.js`) suppresses uncorroborated summaries and scopes. What
Changed links each player to the unified player drawer (market, model, news, archive) and to
PBEcast for their game.
Next: resolve `players[]` to ESPN athlete ids through the injury report and roster (id-first; a name
is accepted only when it matches exactly one active roster player on a team the article names).
Then attach article → player → team → game → market → PBE Pick. An article whose entities cannot be
resolved keeps its headline and source. It gets no scope, and no AI summary is shown as fact.
