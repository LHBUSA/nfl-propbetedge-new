# NFL warehouse ingest architecture

Production-candidate. **Nothing here has been applied to production and no
production write path exists yet.** The five jobs below are specified against
migrations `001_CANDIDATE_SCHEMA.sql` and `002_qbdna_derived.sql`.

```
SOURCE  →  R2 RAW ARCHIVE  →  SUPABASE CANONICAL  →  DERIVED  →  OUR API
          (immutable)         (normalised)          (served)
```

## Why raw-first

Every collector's first act is to write the source payload, byte for byte, to
R2 and record its hash. Normalisation reads from the archive, never from the
network. That gives three things we would otherwise lose permanently:

1. **Reprocessing.** When our parser improves, we re-derive six seasons without
   re-fetching anything and without asking the source for the same data twice.
2. **Auditability.** Any number the API serves traces to a specific archived
   payload, by hash.
3. **Source drift detection.** ESPN silently reshapes objects. A changed hash on
   an unchanged URL is the signal.

## R2 layout

```
raw/espn/scoreboard/{yyyy-mm-dd}/{fetched_at}-{sha8}.json
raw/espn/summary/{season}/{event_id}/{fetched_at}-{sha8}.json
raw/espn/teams/{yyyy-mm-dd}/{fetched_at}-{sha8}.json
raw/nflverse/pbp/{season}/{fetched_at}-{sha8}.parquet
raw/nflverse/players/{yyyy-mm-dd}/{fetched_at}-{sha8}.parquet
raw/openmeteo/archive/{lat},{lon}/{date}/{fetched_at}-{sha8}.json
dist/qbdna/{build_sha8}/qb-dna-dataset.json
```

The `sha8` in the key is the first 8 hex of the payload's SHA-256. Two fetches
returning identical bytes produce the same key, so **an unchanged source costs
one HEAD and writes nothing**. Objects are never overwritten or deleted.

## The five jobs

Every one of them satisfies the same contract:

| requirement | mechanism |
|---|---|
| resumable | `ingest_checkpoint (job, partition_key)`; the job asks for its incomplete partitions and starts there |
| checkpointed | a partition is marked complete only after its rows commit |
| content-hashed | SHA-256 of the raw payload, stored on the snapshot and the checkpoint |
| no-ops on unchanged | hash matches the checkpoint → skip, increment `rows_unchanged`, do not touch canonical |
| provenance-stamped | every canonical row carries `source`, `source_fetched_at`; every play carries per-field `field_provenance`; every derived row carries `built_by_run_id` |
| retries | exponential backoff 1s→2s→4s→8s→16s, 5 attempts, jittered; `attempts` and `last_error` persist on the checkpoint |
| fails without partial corruption | one transaction per partition; a failure rolls the partition back whole and leaves the checkpoint incomplete |

Concurrency is bounded per source and politeness is a hard rule: at most 2
concurrent requests to any one host, a 250 ms floor between requests to ESPN,
and a descriptive User-Agent. No authentication is bypassed, no paywall is
crossed, and no CAPTCHA is answered — every source is a public endpoint or a
published dataset.

---

### 1 · `nflverse_pbp` — historical play-by-play

* **Source** nflverse-data releases, `play_by_play_{season}.parquet` (CC-BY-4.0)
* **Partition** one season
* **Cadence** weekly in season, on release
* **Writes** `raw_nfl_source_snapshot` → `nfl_games`, `nfl_plays`, `nfl_play_participants`
* **Idempotency** the release asset's ETag plus the payload hash. nflverse
  re-publishes the current season repeatedly, so most runs must be no-ops.
* **Failure mode that matters** a partially-written season would silently change
  every split for every quarterback on those teams. One transaction per season,
  and the checkpoint is written last.

### 2 · `nflverse_players` — the identity spine

* **Source** nflverse `players.parquet`
* **Partition** the whole file (small)
* **Writes** `nfl_player_identity`
* **The invariant this job exists to protect**: GSIS is the spine and it is
  100% populated. `espn_id`, `pfr_id`, `pff_id` and the rest are *attributes of
  a GSIS identity*, never join keys of their own. A row is written with
  `confidence='exact_id'` only when it came from this file. A name-derived match
  is written `confidence='probable'` and **is not usable for stat attribution**.
* **Never**: a fuzzy name match may not overwrite a row whose `confidence` is
  `exact_id`. This is asserted in `research/qbdna/qbdna.test.mjs`.

### 3 · `espn_scoreboard` — live schedule, scores and state

* **Source** `site.api.espn.com/.../nfl/scoreboard`
* **Partition** one game day
* **Cadence** every 5 min while a game is live; hourly otherwise
* **Writes** `raw_nfl_source_snapshot` → `nfl_game_identity` (`espn_event_id`),
  and enrichment onto `nfl_games`
* **Identity** ESPN event id ↔ nflverse `game_id` via (season, week, home, away).
  A pairing that does not resolve is written to `nfl_source_conflict`, never guessed.

### 4 · `espn_venues` — venue table and geocoding

* **Source** ESPN teams API; Open-Meteo geocoding of the venue **city**
* **Partition** the whole league (32 rows)
* **Cadence** monthly, and on any unrecognised venue
* **Writes** `nfl_venue`
* **Learned the hard way**: Open-Meteo's geocoder is place-based, so stadium
  names resolve 2/48. Geocoding the venue's city resolves 32/32.
* **Neutral sites** are not this job's business — a neutral-site game must not
  inherit the home team's venue. `/api/qb-dna/game-context` refuses to apply a
  venue in that case rather than borrowing the wrong stadium.

### 5 · `openmeteo_archive` — game-time conditions

* **Source** Open-Meteo ERA5 archive (free, keyless, no attribution required
  beyond courtesy; we credit it anyway)
* **Partition** one game
* **Writes** `nfl_game_environment`
* **Roofed games get a row** with `is_indoor_game=true` and NULL readings, so
  their exclusion from outdoor splits is an explicit recorded fact rather than a
  gap that a later join could mistake for missing data.
* **Validation** against the NFL gamebook where both exist: 2.7 °F and 2.8 mph
  mean absolute difference over n=1,007 games, and it resolves 158 outdoor games
  the gamebook left blank.
* **Never re-queried per user request.** Weather is stored once.

### Derived rebuild (not a source job)

`qbdna_build` reads `nfl_qb_game_metrics` and rewrites
`nfl_qb_condition_splits`, `nfl_qb_prop_threshold_cache`,
`nfl_qb_head_to_head` and `nfl_field_availability`, then emits the public
artifact and records it in `qbdna_dataset_build`. It is pure: same inputs, same
bytes, same hash. That is asserted by the determinism test.

## Ordering and dependencies

```
nflverse_players ─┐
                  ├─→ nflverse_pbp ─→ nfl_qb_game_metrics ─→ qbdna_build
espn_venues ──────┼─→ openmeteo_archive ─┘
espn_scoreboard ──┘
```

`nflverse_players` runs first: without the identity spine, plays cannot be
attributed. `espn_venues` runs before `openmeteo_archive`, which needs
coordinates and a timezone to pick the local kickoff hour.

## Failure policy

* A source that is down is **not** an error — the checkpoint stays incomplete
  and the next run resumes. The API keeps serving the last good derived state.
* A source that returns *changed* data for a settled partition writes a new raw
  snapshot and raises a `nfl_source_conflict` row. It does **not** overwrite
  canonical silently.
* A derived build that produces fewer rows than the previous build by more than
  a set tolerance aborts and keeps the previous artifact.

## ESPN additive enrichment contract

ESPN fields are ingested **additively and retained internally first**. A field
being present upstream is not a reason to expose it.

| ESPN field | retained | served publicly | why |
|---|---|---|---|
| `scoringPlay`, `statYardage` | ✅ | ✅ via play data | corroborated against nflverse on a 10,832-play sample |
| `isTurnover`, `isPenalty` | ✅ | ✅ | same |
| `start.team.id`, `end.team.id` | ✅ | internal only | possession bookkeeping; not a user-facing fact |
| `probability.*` (win probability) | ✅ | ❌ | a third-party model. Publishing it would present someone else's model as ours. |
| `athlete` on a play | n/a | ❌ | **verified absent**: 0 of 192 plays on a completed game, 0 across 10,832 plays |
| drive-level aggregates | ✅ | internal only | not yet reconciled with nflverse drive boundaries |

Rule: a field moves from *retained* to *served* only after it has been
reconciled against a second source, or its provenance is stated in the response.

## Attribution

nflverse is CC-BY-4.0 and that obligation is discharged in the payload, not
only in a footer. Every response from all four endpoints carries
`provenance.sources[]` with the attribution string, and `/#qbdna` renders it in
a Sources panel.

```
Data by nflverse, CC BY 4.0 — https://github.com/nflverse/nflverse-data
Weather data by Open-Meteo.com, CC BY 4.0 — https://archive-api.open-meteo.com/
```

Any redistribution of derived tables carries the same notice. Big Data Bowl
tracking data is **not used**: its terms forbid redistribution, and it is marked
NOT USABLE in `NFL_PUBLIC_SOURCE_MATRIX.md`.
