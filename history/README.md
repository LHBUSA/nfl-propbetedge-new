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
| `registry/sources.v1.json` | machine-readable source registry (loads into `football_src.source`) |
| `registry/nfl_team_crosswalk.v1.json` | our own abbreviation → franchise mapping |
| `ontology/positions.v1.json` | position ontology, historical labels kept |
| `schema/00*.sql` | canonical DDL (64 tables). Validated by applying to PGlite; **not applied anywhere** |
| `lib/` | pure policy: identity matching, franchise lineage, bitemporal AS-OF, position resolution |
| `api/history-api.mjs` | API handler with rights filter + provenance envelope (storage-agnostic) |
| `pipeline/` | Wikidata seed, 2023 slice builder, loader + validator |
| `tests/` | `core.test.mjs` (policy, always runs), `slice-api.test.mjs` (skips without the slice DB) |

```bash
node --test history/tests/core.test.mjs        # 13 policy tests
npm --prefix history run slice:seed            # CC0 Wikidata seed
npm --prefix history run slice:build           # canonical CSV from local data
npm --prefix history run slice:load            # schema + load + validate (25/26, 0 blockers)
node --test history/tests/slice-api.test.mjs   # API contract incl. rights filter
```

Rules that hold everywhere in this directory: provenance on every row; source facts and derived
analytics in separate schemas; bitemporal AS-OF with a leakage audit; verbatim source labels kept
beside canonical interpretations; era-aware rules and stat definitions; and rights enforced in the
data layer, not at display time.
