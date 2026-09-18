# The rights engine — lanes, ingestion, and model use

**Status: implemented and tested. Nothing deployed. No CollegeFootballData data ingested.**

Rights decisions live in the database and at the ingestion boundary. They are not
a note in a Markdown file and not a condition in a frontend. This document
explains the shape; the enforcement is in the code the tests exercise.

## Why a source is no longer one decision

The D3 audit (`COLLEGE_DATA_RIGHTS.md`) found that CollegeFootballData serves,
through one contract and one API key, three materially different kinds of thing:

* facts we may publish (games, coaches, venues)
* ESPN-shaped records we may hold internally and model on, but not republish
  (play-by-play, drives, box scores, player statistics)
* third-party ratings CFBD does not own and we may not hold at all (SP+ from
  Bill Connelly, FPI from ESPN, the 247Sports talent composite, betting lines)

`football_src.source` can hold one `display_policy` and one `model_use_allowed`
for a source. Representing the above with one row means choosing between
under-using the first group and over-reaching on the third. So the registry was
versioned rather than bent: `sources.v1.json` is kept as the record of what was
decided on 2026-09-15 and marked superseded, and `sources.v2.json` +
`lanes.v2.json` are the current policy.

## The model

```
football_src.source                one row per provider   (the ceiling)
  └── football_src.source_lane_policy   one row per dataset family  (the refinement)
        └── football_src.source_snapshot.lane   every retrieval names its lane
              └── every canonical row cites its snapshot
                    └── row-level security resolves the lane at read time
```

A lane **refines** its source and can never widen it. The surfaces a row may
appear on are the intersection of the source's reach and the lane's own flags:

```sql
football_rights.effective_surfaces(source_id, lane)
  = surfaces_for_policy(source.display_policy) ∩ lane_surfaces(source_id, lane)
```

### Three ways it fails closed

| State | Result |
|---|---|
| a source marked `lane_policy_required` and a snapshot that names no lane | invisible everywhere, unusable for models |
| a snapshot naming a lane that has no policy row | invisible everywhere, unusable for models |
| a lane that exists and permits nothing | invisible everywhere |

"We have not decided" and "nothing may see this" are different states with the
same consequence, and that is deliberate.

### Mixed sources

Two rules, and they point in opposite directions on purpose.

* **Corroboration widens.** A person Wikidata names publicly does not become
  unpublishable because a restricted source also mentions them.
  `entity_source_record.role = 'supports'`.
* **Requirement narrows.** A row that needs several sources to exist takes the
  narrowest of them. `role = 'required'`, and
  `football_rights.all_snapshots_visible(text[])` for a composed row. The
  college read contract applies the same rule in JavaScript
  (`compositionSurfaces`), so a composed record is withheld entirely rather than
  served with the restricted part quietly removed.

## Ingestion is a stronger gate than display

`ingest_allowed = false` is not a display rule. The value must never reach
canonical storage — not in a column, not inside a JSON blob, not in a retained
raw payload. Hiding a prohibited value at read time still means holding it.

The CFBD boundary (`lib/cfbd-policy.mjs`, `registry/cfbd_ingest_policy.v1.json`)
therefore does four separate things, and the fourth is the one that matters:

1. **classify** — every endpoint maps to exactly one lane. An endpoint nobody has
   classified is *refused*, so a new CFBD route cannot inherit permission from
   the ones around it.
2. **allowlist** — where a lane has one, only named fields survive. Used on the
   lanes whose payloads are known to carry prohibited values.
3. **denylist** — prohibited fields are deleted at any depth. Some denials are
   unconditional (`talent` is the 247Sports composite wherever it appears) and
   some are conditional on the lane (`rating` inside a portal payload is a
   247/On3-family composite; `rating` elsewhere is not inherently anything).
4. **assert** — `assertClean()` proves nothing prohibited survived. It is
   separate from the strip on purpose: the strip is the intent, this is the
   proof. An adapter that forgets step 2 still cannot write, and a denylist entry
   added later fails loudly rather than leaving old values in place.

Crosswalk identifiers (`collegeAthleteId`, `nflAthleteId`, `recruitIds`) are not
deleted — they are the join keys the whole college→NFL graph depends on — but
they are *lifted* out of any surfaced row into the `identifier_crosswalk` lane,
which is internal only, hard, and has no endpoint of its own.

## Model use is a third question, not a consequence of the first two

A lane can be readable and still be unusable for a particular model.

`football_rights.model_use_allowed(snapshot_id, purpose)` and
`lib/rights.mjs assertModelUse({inputs, purpose})` require all three of:

* the source allows model use
* the lane allows model use
* the named purpose is not in the lane's `prohibited_model_uses`

The third gate exists because of the college spine. Wikidata is CC0 and every
row reaches the public surface — **the licence is clean and the sample is not.**
Wikidata holds items for people notable enough to have one, and the spine is
anchored on a Pro-Football-Reference id, so every player in it reached
professional football. There is no denominator: the college players who did not
are absent, and their absence is not a negative label.

So `src_wikidata / college_affiliation` carries
`sampling_bias = 'notability_survivorship'` and prohibits:

`reached_nfl_probability`, `draft_likelihood`, `pro_success_prediction`,
`prospect_ranking`, `who_becomes_a_pro`, `negative_class_population`

A licence check alone would wave every one of those through. A run must name its
purpose before its inputs can be checked, and `samplingBiases(inputs)` returns
what a permitted run inherited so the derivation can record it.

## Separation of layers

| Layer | Where | Rights |
|---|---|---|
| raw provider facts | `football.*` with `source_snapshot_id` | lane policy, per row |
| derived features | `football_derived.game_feature` | internal until the derivation records its inputs' rights |
| model artifacts | `football_derived.derivation` (`input_snapshot_ids`) | internal |
| public/pro output | the API contracts | only what the lane permits on that surface |

Every derived row names the snapshots it was built from, so "what did this
inherit" is a query rather than a guess.

## What the tests prove

`tests/rights-lanes.test.mjs` (23 tests). The numbered ones map to the
enforcement requirements:

1. games classified independently of plays — and they resolve to different surfaces
2. recruiting refused at endpoint and field
3. talent refused (CFBD names 247Sports itself)
4. FPI refused
5. SP+ refused — and Elo/SRS, which *are* CFBD's own, stay usable
6. betting lines refused, including ATS records derived from them
7. `preDraft*` stripped, and refused if they survive
8. portal `stars`/`rating` stripped; the movement fact survives
9. crosswalk identifiers cannot reach a surfaced row
10. one source, five lanes, five different answers; raw plays reach internal only
11. no JSON column is an ungated carrier
12. derived output keeps the lineage of every input
13. missing / undecided lane fails closed; 13b a lane never widens its source
14. a composed row takes the narrowest of its contributors
15. the model builder refuses a lane with `model_use_allowed = false`
16. the public college spine carries only approved lanes and approved fields
17. no name-only player merge
18. the survivorship-biased spine cannot become a negative-class population
19. the adapter refuses to run without explicit enablement and a secret, and
    never touches the network
20. no substitute CFBD API route exists and no raw payload is stored

Plus: the SQL and the JavaScript engines are asserted to agree lane by lane, so
the two copies of the rules cannot drift.

## The CFBD adapter is built and disabled

`ingest/cfbd-adapter.mjs` exists so that the D3 decisions became executable while
they were fresh, and so the tests that prove a prohibited value cannot be
persisted exist *before* there is any data to persist. A denylist written after
the first ingest is a cleanup.

It refuses to run unless `CFBD_ENABLED` is exactly the string `'true'` and
`CFBD_API_KEY` is a non-empty value. `'TRUE'`, `'1'` and `'yes'` are all refused
deliberately: an ambiguous enablement is the kind of thing that gets set by
accident, and this switch turns on paid requests against a source whose upstream
rights are undocumented.

**No key exists. No request has been made. No CFBD data is stored.** The deploy
check `rights.cfbd_not_ingested` asserts both that `src_cfbd` still requires
lanes and that zero CFBD snapshots exist.
