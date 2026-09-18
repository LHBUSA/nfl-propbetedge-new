# Football History Graph

A canonical American football intelligence layer: NFL history, leagues, franchises, people, games,
plays, pathways and provenance as one auditable graph. **Additive and isolated.**

Status 2026-09-15: design + policy code + a proven technical-validation slice (NFL 2023).
Nothing here is deployed, applied to any database, served by nfl.propbetedge.ai, or read by the
picks / prop-picks models. `history/` is excluded from the Vercel deployment.

| Path | What |
|---|---|
| `docs/AUDIT.md` | Phase 1 inventory: coverage, schema, missing-data matrix, identifier facts (A, B, E) |
| `docs/SOURCES_AND_RIGHTS.md` | source registry + rights map, decision view (C, D) |
| `docs/ARCHITECTURE.md` | franchise lineage, identity, positions, rosters, draft, college, game/play/drive, injuries, PropChain, APIs (F-N, P) |
| `docs/PLAN.md` | ingestion sequence, slice result, decisions needed, risks found (O, Q) |
| `docs/SUPABASE_DEPLOYMENT.md` | the deployment package: separate project, rights as row-level security, runbook, backup/restore, rollback, Hyperdrive connection |
| `docs/COLLEGE_DATA_RIGHTS.md` | go / restricted / no-go matrix by college dataset (D3) |
| `docs/LICENSED_FEED_REQUIREMENTS.md` | what a licensed feed would have to provide (D4) |
| `docs/GAME_IDENTITY.md` | the durable game identity model and the Super Bowl week defect |
| `docs/OPEN_METEO_DEPENDENCY.md` | every production use of Open-Meteo and the provider abstraction |
| `docs/RIGHTS_ENGINE.md` | how rights are enforced: lanes, the ingestion boundary, model-use guards |
| `registry/sources.v2.json` | machine-readable source registry (loads into `football_src.source`). `sources.v1.json` is kept as the superseded 2026-09-15 record |
| `registry/lanes.v2.json` | per-dataset lane policy (loads into `football_src.source_lane_policy`) |
| `registry/cfbd_ingest_policy.v1.json` | CFBD endpoint classification, field allowlist and denylist |
| `registry/nfl_team_crosswalk.v1.json` | our own abbreviation → franchise mapping |
| `ontology/positions.v1.json` | position ontology, historical labels kept |
| `schema/00*.sql` | canonical DDL (64 tables). Validated by applying to PGlite; **not applied anywhere** |
| `lib/` | pure policy: identity matching, franchise lineage, bitemporal AS-OF, position resolution |
| `api/history-api.mjs` | API handler with rights filter + provenance envelope (storage-agnostic) |
| `pipeline/` | Wikidata seeds, all-era skeleton builder, 2023 slice builder, loader + validator |
| `deploy/` | generated migrations, roles and rights policy, apply / seed / validate / canary / rollback, connection contract |
| `ingest/cfbd-adapter.mjs` | the CFBD adapter: built, tested, **disabled**. No key, no request, no data |
| `tests/` | `core.test.mjs` (policy), `skeleton.test.mjs` (bounds and lineage severity), `slice-api.test.mjs` (API contract), `deploy.test.mjs` (migrations + rights gate), `rights-lanes.test.mjs` (lane policy, ingestion refusals, model-use guards), `college-spine.test.mjs` (the built spine) |

```bash
node --test history/tests/core.test.mjs        # 13 policy tests
node --test history/tests/skeleton.test.mjs    # 9 tests: precision-aware bounds, lineage severity
node --test history/tests/deploy.test.mjs      # 15 tests: migrations + rights gate, no server needed
node --test history/tests/rights-lanes.test.mjs # 23 tests: lanes, refusals, model-use guards

python history/pipeline/fetch_college_seed.py  # CC0 Wikidata college seed
python history/pipeline/fetch_eada.py --years 2003 2025   # US Dept of Education football sponsorship
python history/pipeline/build_college_spine.py # the rights-clean college->NFL spine
node --test history/tests/college-spine.test.mjs

python history/pipeline/fetch_skeleton_seed.py # CC0 Wikidata seed, with time precision
python history/pipeline/build_skeleton.py      # all-era skeleton (1920-2026)
python history/pipeline/build_slice_2023.py    # the 2023 season, attached to the skeleton
npm --prefix history run slice:load            # schema + load + validate (36/37, 0 blockers)
node --test history/tests/slice-api.test.mjs   # API contract incl. rights filter
```

State: the skeleton covers the NFL, the AFL (1960-69) and the AAFC — 46 franchises, 69 identities
through time, 121 seasons, 61 venues, 139 coaching tenures, 64 championship results, all CC0. The
2023 season attaches to it (32/32 teams). An unknown bound is null and says why; a date is never
claimed more precisely than the source stated it; a conflict the source itself contains is named
rather than resolved.

Rules that hold everywhere in this directory: provenance on every row; source facts and derived
analytics in separate schemas; bitemporal AS-OF with a leakage audit; verbatim source labels kept
beside canonical interpretations; era-aware rules and stat definitions; and rights enforced in the
data layer, not at display time.
