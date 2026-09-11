# PBE Replay — Architecture

Status 2026-09-11, branch `nfl-product-depth-v1`. What is built is marked **BUILT**; what is
designed but not deployed is marked **DESIGNED**. Nothing in this document is deployed to
production.

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

## 4 · What is built

| Piece | File | State |
|---|---|---|
| Replay v0: scoring, turnover and explosive (20+ yds stated in play text) jump lists; drive chart with expandable drives | `pbecast-command-v1.js` (`keyMomentsHtml`, `driveChart`) | **BUILT**, live-source only |
| Enrichment core: RFC-4180 CSV, per-game extraction keyed by ESPN play id; NA stays absent; a schema change throws | `api/_replay/nflverse.js` | **BUILT**, 6 tests on real rows |
| Prototype read path | `api/replay-enrich.js` | **BUILT**, bounded (see §5) |
| Enriched chips per play (EPA, WPA, air, YAC, CPOE, passer→receiver) and a **Biggest swings** jump list (top \|WPA\|) | `pbecast-command-v1.js` | **BUILT**, final games only, fetched once per game |

## 5 · Why the prototype read path is bounded

`api/replay-enrich.js` downloads the season file from the nflverse release on a cache miss
(`s-maxage=3600`). That is fine at week 1 (0.1 MB gzipped). A full season is about 19 MB gzipped and
100 MB as CSV, which is wrong for a request path. Above **8 MB gzipped** the endpoint returns
`503 ENRICHMENT_PIPELINE_REQUIRED` instead of degrading. Estimated from the 2025 file (19 MB
gzipped over ~20 weeks), that point arrives around week 8. The pipeline below must ship before then.

## 6 · Production pipeline (DESIGNED, Cloudflare-owned)

GitHub Actions stays CI only. The pipeline is Cloudflare compute:

```
Cron (daily 10:00 UTC, plus Tue 10:00 for MNF)
  -> nfl-replay-enrich  Workflow
       step 1  HEAD release asset; compare Last-Modified / ETag with KV replay:asset:<season>
               unchanged -> exit (idempotent, no work)
       step 2  stream play_by_play_<season>.csv.gz (DecompressionStream)
               line-split, keep COLUMNS only, group by game_id
       step 3  per game: R2 put replay/<season>/<game_id>.json   (checkpoint: KV replay:done:<game_id>=etag)
       step 4  KV replay:index:<season> = [{game_id, espn_event?, plays, etag, published_at}]
  -> read path  GET /api/replay?event=  (Vercel function or Worker route)
       R2 get by game_id; attach ESPN play ids; same response contract as api/replay-enrich.js
```

- **Resumable:** each game is a Workflow step, and completed games are skipped by ETag.
- **Idempotent:** the same asset ETag produces the same objects. R2 puts are overwrites of
  identical content.
- **Bounded:** streaming never holds the full CSV in memory. Per-game objects are 40–80 KB.
- **Attribution** travels in every object: `{dataset, license:'CC-BY-4.0', attribution:'nflverse'}`.

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
