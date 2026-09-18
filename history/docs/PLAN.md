# Football History Graph — Sequence, Slice Result, Decisions (O, Q)

## Q. First vertical slice — NFL 2023, proven

**Mode: technical validation only.** Built from data already on disk plus Wikidata (CC0).
No database was created in Supabase, nothing was deployed, nothing published, no new downloads of
rights-restricted data. Outputs live in `history/.out/` (gitignored).

```
npm --prefix history run slice:seed    # Wikidata CC0 seed (franchises, divisions, names, SB LVIII)
npm --prefix history run slice:build   # local parquet + seed  ->  canonical CSV
npm --prefix history run slice:load    # apply schema to PGlite, load, validate  (25/26, 0 blockers)
node --test history/tests/slice-api.test.mjs   # API contract incl. rights filter (10/10)
```

**What is in the slice** (241,429 rows loaded into a real Postgres against the canonical DDL):

| Entity | Rows | Notes |
|---|---|---|
| franchises / team identities / lineage events | 32 / 37 / 39 | 3 franchises have documented dated identities (Wikidata P1448); 29 are bounded by evidence window |
| org units / alignments | 10 / 32 | 2 conferences × 4 divisions × 4 teams (structural check) |
| venues (+ names, attributes) | 33 / 33 / 59 | as played; roof/surface only where the season agrees |
| people / players / coaches | 3,124 / 3,089 / 35 | head coaches from the game header |
| games | 285 | 272 regular + 13 postseason incl. Super Bowl LVIII |
| team scores | 570 | period scores derived, reconciled to finals |
| drives | 6,047 | canonical result + verbatim source label |
| plays | 49,665 | verbatim descriptions, per-field confidence |
| play participants / penalties | 104,391 / 3,229 | typed roles |
| player game stats / team stats / appearances | 22,042 / 570 / 16,320 | long form, definition-versioned |
| roster periods / positions / jerseys | 3,089 each | season-level (see gaps) |
| external ids | 11,875 | gsis + approved crosswalk columns |

**Validation: 25/26 checks pass, 0 blockers** (`history/.out/slice2023/_validation.json`). Highlights:
- 285 games; every team exactly 17 regular-season games; no double-booking.
- Period scores sum to finals; derived team points equal finals; wins equal losses (285/285/0 ties).
- Bracket 6/4/2/1.
- **Cross-source check:** our Super Bowl LVIII result (Kansas City 25-22, 2024-02-11, Allegiant
  Stadium, overtime) matches Wikidata's independent CC0 record on winner, date and venue.
- Provenance: 52 tables carry `source_snapshot_id`, zero null citations; snapshot sha256 still
  matches every file on disk.
- **Rights enforced in data:** 0 play rows visible on the public surface, 37 CC0 team identities
  visible; 0 plays from a model-use-allowed source.
- Temporal: a knowledge cutoff before ingestion returns nothing; roster AS-OF resolves by date.
- Leaderboard derived from canonical rows (2023 passing yards: Tagovailoa 4,624 / Goff 4,575 / Prescott 4,516).

**Defects the slice found (all real, all in the inputs or in naive modelling):**
1. A London venue carries an empty `surface` value — rejected by the schema rather than stored blank.
2. `start_time` is a malformed, timezone-less string ("9/10/23, 13:02:43"), so **kickoff instant is
   recorded as unknown** instead of guessed. Kickoff times need a source that states them.
3. On kicking plays the source's `posteam` is the kicking team, so naive offense/defense attribution
   credits returners and coverage tacklers to the wrong side. Returners now follow the returning
   team, and on special teams a tackler's team is left **unknown** rather than guessed.
4. Laterals: the source splits receiving yards between carriers; ignoring the lateral loses team
   yards. Now credited — and the two plays with *multiple* laterals (which the source cannot fully
   attribute, one lateral column per play) are flagged `incomplete_multi_lateral` on the play, which
   is exactly why the last two team-game differences are explained rather than hidden.
5. `roster_2023` is a **season** roster (one row per player), not weekly. Week-by-week squads need
   `weekly_rosters`, which is not held. 5.6% of appearances have no roster row (in-season signings,
   practice-squad elevations) — recorded as a warning, not papered over.

**What the slice deliberately does NOT contain** (no rights-clean source; see SOURCES_AND_RIGHTS):
draft selections and pick lineage, combine/pro-day, college pathway, transactions, injuries,
depth charts, snaps/participation, officials, attendance, awards, contracts.

## Scaling argument (one season → the rest)

| Step | What changes | What does not |
|---|---|---|
| 2023 → 1999-2025 | same builder, loop the season files | schema, ids, validations, API |
| → pre-1999 | new sources per era; `stat_definition` gains era versions; identities gain documented bounds | canonical tables |
| → player careers | career stages + external ids already modelled; the 2023 slice already links 3,089 players | — |
| → drafts / college / transactions | tables exist (003); need approved sources | — |
| → other leagues (AFL/AAFC/CFL/UFL) | new `league` + `league_relation` rows; competitions stay separate | franchise/person model |
| → PropChain | read-only adapter over the API; ids resolved through `external_id` | PropChain code |

The binding constraint is **rights, not architecture**.

## O. Recommended ingestion sequence

Each stage is gated: nothing ingests until its source has an owner decision recorded in
`history/registry/sources.v2.json`, and — where the provider's datasets carry different rights —
a lane policy in `history/registry/lanes.v2.json`. A lane with `ingest_allowed = false` is refused
at the boundary, not filtered at display.

| # | Stage | Source status | Unlocks |
|---|---|---|---|
| 0 | **Decisions D1-D4 below** | — | everything |
| 1 | Franchise/league/venue skeleton, all eras (Wikidata CC0 + our curated crosswalk, curated gaps flagged) | CLEAR | Franchise Passport, era-correct identities, the join spine |
| 2 | Weather rebuild (NOAA US stations; ERA5 elsewhere) | CLEAR | replaces the non-commercial Open-Meteo dependency (see risk below) |
| 3 | Modern era games/plays/drives/box scores 1999-2025 | **needs D1** (nflverse/NFL chain) or a licensed feed | Game DNA, records, PropChain history, Similar Game Finder |
| 4 | Rosters, transactions, injuries, depth charts | needs D1/licensed feed | roster-as-of, availability timeline, OL continuity |
| 5 | Draft + combine | **needs a licensed source** (PFR rejected) | Draft Explorer, draft-class analytics |
| 6a | **College spine (Wikidata CC0 + EADA)** | **CLEAR — BUILT** | school/programme identity, conference, coaches, player→college, college→pro transition |
| 6b | College performance (CFBD) | **D3 resolved; adapter built and DISABLED** — needs owner approval + a key | production curves, usage, efficiency. Nothing else in the CFBD contract unlocks this |
| 7 | Pre-1999 NFL, AFL, AAFC | public-domain newspapers + curation; or licence | deep history, franchise records |
| 8 | Snaps/participation | blocked (rejected/hold) | usage, workload |
| 9 | Other leagues (CFL/UFL/international) | licence | global pathways |

Only after stage 3 is stable does a **separate** experimental model lineage
(`pbe-nfl-model-v2-history`) become meaningful, with its own feature contract, leakage audit,
holdout, calibration and promotion rules. The official track record is untouched throughout.

## Decisions I need from you

| # | Decision | Why it blocks |
|---|---|---|
| **D1** | The NFL chain-of-rights question for nflverse NFL-origin data (pbp 1999+, weekly rosters 2002+, depth charts ≤2024, injuries ≤2024, officials 2015+). Accept for a paid product and models, restrict to internal, or replace with a licensed feed? | This is the only near-term route to game-level history, and **production Player DNA, team ratings, nfl-replay and the picks HISTORY already depend on it** |
| **D2** | Where the history graph lives: (a) new schemas in the shared NFL/UFC Supabase project, (b) a **new Supabase project** (my recommendation — 64 tables, different lifecycle, no risk to the picks ledger), (c) Cloudflare D1/R2 only until stage 3 | Nothing can be applied until chosen; I have applied no migration anywhere |
| **D3** | College: accept CollegeFootballData's contractual grant (commercial use permitted) without confirming its upstream origin, or ask CFBD first? | Gates the college→NFL graph |
| **D4** | Licensed feed: do you want me to prepare a scoped brief for Sportradar / SportsDataIO / Genius (coverage, history depth, cost) — the only way to get draft, transactions, injuries and pre-1999 legitimately? | Stages 4, 5, 7, 9 |
| **D5** | Wikipedia bulk table extraction for AFL/AAFC/pre-1999 facts: acceptable, or public-domain newspapers only? | Stage 7 |
| **D6** | `archive/*.js` (see risk R3): retire the model-generated content now, keep with a disclaimer, or replace when stage 1 lands? | Product truthfulness today |

## Risks found during this audit (outside the history build)

| # | Risk | Evidence |
|---|---|---|
| **R1** | **`qb_tier` is dead in production.** `qbTierMap` reads `body.injuries`, but `/api/injuries` returns `{teams:[{injuries}]}`, so the map is always empty; `qb_tier` is null for every team and `qb_tier_diff` is 0 on every pick. Even if fixed, the tier is derived from injury status, and the feed's team codes (LAR/WSH) do not match the ratings' codes (LA/WAS). `line_move` is likewise hardcoded to 0, and the weight tuner is on hold | nfl-game-grader/src/index.js:253-265; ratings.mjs:330; orchestrator:1051,1059 |
| **R2** | **Super Bowl game ids are wrong.** `nflverseGameId` adds 18 to ESPN's postseason week, giving week 23; nflverse uses 22 (2021+). The id keys picks, the odds tape, receipts and replay, and a test pins the wrong value | current-slate.mjs:37; live-engine.test.mjs:33 |
| **R3** | **The site serves model-generated "history".** `archive/teams.js` contains "2024 Playoff results (known through my knowledge cutoff)" and "2025 season notable players (pre-season knowledge)"; `archive/*.js` has no provenance at all and is vendored by a workflow that pushes to main | archive/teams.js:62; .github/workflows/vendor-nfl-archive.yml |
| **R4** | **Open-Meteo's free tier is non-commercial** and is the weather source behind DNA context and `nfl_game_environment` | open-meteo.com/en/terms |
| **R5** | **Internal docs are publicly served.** `docs/risk/*`, `docs/career-ledger/*`, `migrations/*.sql` and `scripts/*` all return 200 on nfl.propbetedge.ai | measured |
| **R6** | Ten gateway service bindings (incl. `nfl-historical`) have **no source in the repo** — capture before building a new history service | nfl-gateway wrangler.toml |
| **R7** | Warehouse venue defects: 42 neutral-site games and 102 LA/LAC home games mapped to the wrong venue; 31 got weather for the wrong location | data audit |

R1-R2 touch the picks lineage and R3-R5 touch the live product, so I have changed none of them.

---

# Decisions taken, and what changed (2026-09-18)

The owner accepted D1-D6. What each now means in the code:

| # | Decision | State |
|---|---|---|
| **D1** | nflverse/PFR-derived data is **not** expanded onto new public or pro surfaces until the upstream chain is verified or replaced. Existing production dependencies were inventoried, not removed. | Enforced in the data layer: nflverse sources are `internal_only`, and the row-level security policies make a public or pro connection unable to read a row backed by them (`docs/SUPABASE_DEPLOYMENT.md`). |
| **D2** | The history graph gets its **own Supabase project**. Nothing created yet. | Deployment package prepared and proven against PGlite. The commands refuse the two product project refs and have no default connection string. |
| **D3** | Do not ingest CollegeFootballData yet; audit upstream rights first. | **Resolved and made executable (2026-09-18).** The audit is `docs/COLLEGE_DATA_RIGHTS.md`; the policy it produced is no longer a document. CFBD's **contract** rights were reviewed and are permissive. Its **upstream** rights vary by dataset, so `src_cfbd` carries a per-lane policy rather than one verdict: named third-party relays (SP+, FPI, talent, recruiting, betting lines, pre-draft grades) are refused at the ingestion boundary, ambiguous raw lanes (plays, drives, box scores, player stats) are internal-only, and thin-fact lanes (games, coaches, venues) are public. The clean CC0/federal college spine is built and approved. **CFBD ingestion remains disabled pending owner approval and a key; no CFBD data has been ingested.** See `docs/RIGHTS_ENGINE.md`. |
| **D4** | Write down what a licensed feed must provide. Do not purchase, do not contact anyone. | `docs/LICENSED_FEED_REQUIREMENTS.md`. Sportradar is listed as one candidate among others, evaluated on the requirements rather than assumed. |
| **D5** | Prefer Wikidata CC0 and other redistributable structured sources. Wikipedia prose is not a canonical source. | The whole skeleton is CC0 Wikidata via SPARQL, with the query, retrieval time and content hash recorded per snapshot. No prose was parsed. |
| **D6** | Legacy generated history must not be canonical, and must not be silently replaced by guesses. | Every route exposing `archive/*.js` history is suppressed behind a provenance guard that fails closed; nothing was replaced with invented data. Suppressed, not overwritten. |

## Risks: current state

| # | State |
|---|---|
| **R1** | Fixed in source, proven by tests first: `qbTierMap` now reads `teams[].injuries[]` and maps through `nflverseCode`; `line_move` and the other optional features report unavailability instead of sending 0 into the model. Behind `PICKS_FEATURES_V2` and **not yet deployed** — a champion trained on zeros must not meet live non-zero inputs without a deliberate re-tune. |
| **R2** | Modelled, not renamed. `history/lib/game-identity.mjs` measures the week rather than assuming it, refuses Pro Bowl ids, returns ambiguity instead of guessing, and issues an additive alias so old ids keep resolving. No production migration — the receipt chain is append-only and an in-place rewrite would drop picks from the verified record. |
| **R3** | Suppressed at the renderer seams (never by editing `archive/*.js`, which a workflow re-downloads and force-pushes). 16 tests assert the suppressed claims cannot reappear. |
| **R4** | All four production call sites go through one provider abstraction that fails closed; NOAA/ERA5/Meteostat and a licensed replacement are declared but not implemented. `docs/OPEN_METEO_DEPENDENCY.md`. |
| **R5** | Fixed and verified live: `.vercelignore` now allowlists the public surface, worker source / migrations / tests / rights docs return 404, and both a unit test and a live gate assert it. |
| **R6** | Still open. Capture the ten unsourced gateway bindings before any new history service is built. |
| **R7** | Venue defects fixed in the warehouse earlier; the skeleton models venues and their names through time so a rename never creates a second venue. |

## Phase 2 result

The rights-clean historical skeleton is built and validated: NFL, AFL (1960-69) and AAFC;
46 franchises; 69 time-bounded identities; relocations, renames, conferences and divisions;
61 venues with names through time; 121 seasons (1920-2026); 139 coaching tenures; 64 championship
results. The 2023 slice attaches to it, 32/32.

Three things the skeleton deliberately does not do:

- It does not claim a Super Bowl **game**. Wikidata records the winner of all 64 and the
  participants of none, so a game row with two teams could not be built honestly. They are
  championship *results*, and a check enforces that.
- It does not fill an unknown bound. 22 identity bounds the source never gave are null with a
  stated basis; 20 identities inside multi-item lineages have unknown starts because the only
  available date was the franchise's inception, which is not that name's start.
- It does not resolve a conflict the source contains. Wikidata says the Washington Redskins name
  ended 2020-07-24 and the Washington Football Team name began 2020-07-23; both are reported by
  name rather than reconciled by picking one.

## Phase 3 result — the rights engine and the college spine (2026-09-18)

Two things shipped, and they are separate things.

**The rights model became executable.** A source used to carry one decision. That could not
express what the D3 audit found — that CollegeFootballData serves publishable facts,
ESPN-shaped records and relayed third-party ratings through one contract — so the registry
was versioned rather than bent. `football_src.source_lane_policy` now refines a source per
dataset family, every snapshot names its lane, and row-level security resolves the pair. A
lane can narrow a source and never widen it; a snapshot with no decided lane is invisible
everywhere and unusable for models. `docs/RIGHTS_ENGINE.md`.

**The clean college spine was built** from CC0 Wikidata and the federal EADA filing, and from
nothing else: 1,149 institutions, 951 programmes, 849 conferences, 28,896 NFL players of whom
13,947 carry a college association, 317 college coaching tenures, and 5,580 EADA
institution-seasons across 2016-2024.

Four things the spine deliberately does not do:

- **It carries no college statistics at all** — not because they are missing, but because we
  hold no rights to any of them. The public read contract refuses fields that would imply
  otherwise, by name, at any depth.
- **It does not fill in a draft pick.** 273 transitions come from Wikidata's own P647
  statements and **none** carries a round or a pick. Every draft-detail source we hold is
  marked `do_not_use`, and a fact being widely known is not a licence, so the column stays
  null and a schema constraint refuses an uncited one.
- **It does not upgrade attendance into having played.** Wikidata's P69 is an attendance
  claim; `played_football` stays null for every such row rather than being inferred.
- **It does not present itself as a population.** Every player in it is anchored on a
  Pro-Football-Reference id, so every player in it reached professional football. There is no
  denominator. The lane carries `sampling_bias = notability_survivorship` and refuses six
  named model purposes, enforced in SQL and in the model builder.

Two findings worth recording because they were measured rather than assumed:

- **Wikidata does not model college football programmes as entities.** `P641` (sport) =
  college football is a statement on *people*; querying it returns 2,893 players, not teams.
  The programme layer that does exist is the 195 items carrying `P8761`, linked to their
  university by `P831`. The EADA filing is what actually establishes that a programme existed
  in a given year, and the two join on the IPEDS unit id (`P1771`) rather than on institution
  name — which would merge Miami in Florida with Miami in Ohio on its first attempt.
- **EADA sport codes are not stable across years.** Code 7 is football in most years, absent
  in 2018-19, and in 2019-20 selects a sport with 1,754 institutions and a median squad of 41.
  The code is now detected from squad-size shape and verified per year; a year that does not
  fit is refused and recorded as a gap rather than ingested as football.
