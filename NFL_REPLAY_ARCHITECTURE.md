# PBE Replay — Architecture

Status 2026-09-11, branch `nfl-product-depth-v1`. The ingest pipeline and read path are deployed
Cloudflare Workers (`nfl-replay`, R2 bucket `nfl-replay`, Workflow `nfl-replay-ingest`).

## 1 · Two layers, never merged

| Layer | Source | When it exists | Label in the product |
|---|---|---|---|
| **LIVE SOURCE** | ESPN published play-by-play and drives (`/api/nfl-live?event=`) | During the game, final a few minutes after | `LIVE SOURCE · ESPN published play-by-play` |
| **POST-GAME ENRICHED** | nflverse `play_by_play_<season>` (CC-BY-4.0) | The next day (nflverse nightly release) | `POST-GAME ENRICHED · nflverse … published <time>` |

A value from the enriched layer is never shown on a live game, and never shown without the
enriched label. A game nflverse has not published says `NOT_YET_PUBLISHED`. It is never an empty
success.

## 2 · The join is a key, not a heuristic (measured)

ESPN's play id is the ESPN event id followed by the nflverse/GSIS `play_id`:

```
ESPN play 4018726571539  =  event 401872657  +  nflverse play_id 1539
```

This was measured on `2026_01_SF_LA` (ESPN 401872657) on 2026-09-11:

| | count |
|---|---|
| nflverse plays for the game | 157 |
| ESPN published plays | 169 |
| joined by key | **147** |
| nflverse rows with no ESPN play | 10 |

The 10 unjoined nflverse rows are the GAME start row, timeouts and extra points; ESPN folds the
extra point into the scoring play's text. The 22 unjoined ESPN rows are all stoppages: 15 official
timeouts, 5 team timeouts and 2 two-minute warnings. **Every ESPN snap joins.** The UI reports the measured join count on every enriched game ("147 of 169 ESPN plays
joined by play id").

The game id is `nflverseGameId()` from `workers/nfl-picks-engine-shared/current-slate.mjs`, the same
derivation the picks engine uses. ESPN abbreviations are mapped `LAR→LA` and `WSH→WAS`. No schedule
file is needed.

## 3 · Data inventory (verified against `play_by_play_2026.csv`, 372 columns)

**Present and used** (`api/_replay/nflverse.js` `COLUMNS`):
`passer/receiver/rusher_player_name + _id`, `interception_player_name`, `solo_tackle_1_player_name`,
`air_yards`, `yards_after_catch`, `yards_gained`, `epa`, `wp`, `wpa` (possession team's
perspective), `cpoe`, `xpass`, `pass_oe`, `touchdown`, `interception`, `fumble_lost`, `sack`, `drive`,
`posteam`, `defteam`, `play_type`, `qtr`.

**Not in this file.** These come from separate, season-gated nflverse releases:
`offense_formation`, `offense_personnel`, `defenders_in_box`, `was_pressure` (participation / FTN
charting). `pbp_participation` has 2024 and 2025 assets and no 2026 asset yet. Pressure and
formation stay **UNAVAILABLE** until a 2026 asset exists. They are never inferred.

**Never available:** 10 Hz player tracking. The only public corpus (Big Data Bowl) forbids
redistribution. See `NFL_DATA_GAP_VS_MLB.md`.

## 4 · What is built (Cloudflare-owned, 2026-09-11)

| Piece | File | State |
|---|---|---|
| Replay v0: scoring, turnover and explosive (20+ yds stated in play text) jump lists; drive chart | `pbecast-command-v1.js` | **BUILT**, live-source only |
| Enrichment core: RFC-4180 CSV (whole-file and streaming, chunk-boundary safe), compact play, ESPN-id keying; NA stays absent; a renamed key column throws | `workers/nfl-replay/src/nflverse.js` | **BUILT** |
| Ingest pipeline: cron (`20 */3`) → HEAD the release asset → Workflow `nfl-replay-ingest` (instance id = season + Last-Modified, so idempotent) → stream gunzip → CSV → one R2 object per game → season index | `workers/nfl-replay/src/{index,pipeline}.js` | **BUILT, DEPLOYED** |
| Read path `GET /api/replay/enrich` through the NFL gateway: one R2 object, keyed to ESPN play ids | same | **BUILT, DEPLOYED** |
| Enriched chips per play and a **Biggest swings** jump list; LIVE SOURCE and POST-GAME ENRICHED labelled separately | `pbecast-command-v1.js` | **BUILT**, final games only, one fetch per game |

The Vercel prototype `api/replay-enrich.js` is deleted.

## 5 · Read-path states

| State | When | Response |
|---|---|---|
| `available: true`, `read_path: R2_INGESTED` | the game is in the ingested file | plays keyed by ESPN play id, attribution, `ingested_at` |
| `NOT_YET_PUBLISHED` | the season is ingested and this game is not in it | names the ingested asset's Last-Modified |
| `read_path: TRANSITIONAL_BOUNDED_READ` | no season index exists yet (pipeline never completed) and the file is ≤ 8 MB gzipped | same contract, labelled transitional |
| `POST_GAME_ENRICHMENT_UNAVAILABLE` | no season index and the file exceeds 8 MB gzipped | 503, explicit reason |

The 8 MB bound applies only to the transitional path and is not to be raised. The pipeline is the
fix.

## 6 · Pipeline properties (measured)

- **Throughput:** the full 2025 file (19 MB gzipped, 98 MB CSV, 285 games, 48,771 plays) streamed
  in 1.8 s wall / 2.3 s CPU in the Node simulation of the Worker code, with output byte-identical
  to the whole-file extractor. Per-game objects are a median of 45 KB, 60 KB at most; the index is
  13 KB. The Worker runs with `limits.cpu_ms = 300000` for headroom.
- **Memory:** the file is grouped by game (285 contiguous runs), so one game is held at a time.
- **Idempotent:** an unchanged asset starts nothing. A re-run for the same asset overwrites
  identical objects.
- **Resumable:** the probe, stream and record steps are Workflow steps with retries. A failed
  stream retries from the start and rewrites.
- **Attribution** in every object and response: `{dataset, license: 'CC-BY-4.0', attribution:
  'nflverse'}`.

## 7 · Next replay capabilities, in order

1. **Prop-progress history.** Cumulative player stat by play from the enriched layer: passing yards
   by play for the passer, receptions by play for receivers. Shown against the *issued* line of an
   official PBE Pick. Never shown against a line reconstructed after the fact.
2. **Pick result timeline.** For a game with official picks, mark the play at which a pick was
   decided (the over crossed, the under became impossible). This comes from the enriched cumulative
   stats; grading itself stays with the grader.
3. **Win-probability chart** from the enriched `wp`, with the swing plays pinned. It replaces
   nothing live; ESPN's live WP remains the live chart.
4. **Formation / personnel / pressure**, once a 2026 participation or FTN asset is published, as its
   own labelled layer.

## 8 · Rules

- Enriched values appear only on FINAL games, only with their label and publication time.
- The join count is shown. A low join rate is reported, not hidden.
- An unpublished game is `NOT_YET_PUBLISHED`, never "no data".
- No reconstructed geometry, no inferred participants, no fabricated tracking.
