# Football History Graph — Architecture (v1 design)

Status: **design + executable policy code**. Nothing here is deployed, applied to a
database, loaded by nfl.propbetedge.ai, or read by the picks / prop-picks models.
`history/` is excluded from the Vercel deployment (`.vercelignore`).

Companion files:
- `history/schema/001..004_*.sql` — canonical DDL (validated by applying to PGlite; not applied anywhere real)
- `history/lib/identity.mjs` — person identity policy (never merge on names)
- `history/lib/lineage.mjs` — franchise / team-identity resolution and validation
- `history/lib/temporal.mjs` — bitemporal AS-OF semantics and leakage audit
- `history/lib/positions.mjs` + `history/ontology/positions.v1.json` — position ontology
- `history/tests/core.test.mjs` — `node --test history/tests/core.test.mjs`
- `history/docs/AUDIT.md`, `SOURCES_AND_RIGHTS.md`, `PLAN.md` — inventory, rights, sequencing, vertical slice

---

## 0. Principles that bind every layer

1. **Additive and isolated.** New schemas (`football_src`, `football`, `football_derived`), a new
   Worker, new R2 prefix. No existing `nfl_*` table, KV key, Worker route, cron, model or page
   changes to make history work. Integration happens later through read-only contracts.
2. **Provenance is a column, not a comment.** Every canonical row cites a `source_snapshot_id`
   (source + dataset + retrieval time + sha256 + parser version). Multi-source facts list every
   supporting and conflicting record in `football_src.entity_source_record`.
3. **Rights are enforced in the data layer.** `football_src.source` carries `commercial_verdict`,
   `display_policy` and `model_use_allowed`. The API serves a row to a surface only if every source
   behind it permits that surface. A HOLD/REVIEW source can exist in staging for measurement and
   still be invisible to users and models.
4. **Source facts and derived analytics never share a table.** Leaderboards, records, Game DNA,
   era-normalized metrics and similarity live in `football_derived` with a `derivation` row
   (code version, input snapshots, knowledge cutoff).
5. **Time is bitemporal.** Valid time (`effective_from/effective_to`, half-open) and knowledge time
   (`observed_at`) on every time-varying fact. Model datasets must be generated through AS-OF
   queries (`history/lib/temporal.mjs`); a leakage audit runs on every training row.
6. **Verbatim beside canonical.** Source names, position labels, play descriptions, drive results,
   injury wording and week labels are stored as the source wrote them, next to our interpretation.
7. **Era-aware, not era-flattened.** Rules profiles and stat definitions are versioned by season.
   Original statistics are never rewritten; normalized metrics are derived and labelled.

---

## F. Franchise lineage model

Two ids, deliberately separate:

| id | meaning | example shape |
|---|---|---|
| `global_football_franchise_id` (`gfr_…`) | the enduring organization as its league recognizes continuity | one id for a franchise across every city/name it used |
| `global_football_team_identity_id` (`gti_…`) | a league + location + nickname used for a bounded period | one id per (name, city, league) span |

Tables (`002`): `franchise`, `team_identity`, `team_identity_franchise` (m:n, time-bounded),
`franchise_lineage_event`, `team_alignment` (conference/division per season), `team_home_venue`.

Rules (enforced by `lineage.mjs` + tests):
- **Every game, standing, roster period, draft selection and transaction references the team
  identity in force on its date.** `assertIdentityInForce` rejects a record whose identity was not
  valid that day — this is what stops "modern city/name" rewrites.
- A franchise has exactly one identity at a time (`franchise_identity_overlap` violation).
- A temporary combined identity (wartime merged teams) links to **several** franchises for its
  bounded span; each franchise's history includes it, and neither franchise's standalone identity
  is invented for those games.
- Lineage events are typed: `founded, admitted_to_league, relocated, renamed, merged_operations,
  merger_dissolved, suspended_operations, resumed_operations, folded, league_absorbed,
  conference_realigned, division_realigned, sold_no_identity_change`.
- Contested continuity (franchises whose official lineage is disputed or was later re-assigned by
  league agreement) is modelled as events citing the governing body's position **and** alternative
  claims as separate `entity_source_record` rows with `role='conflicts'`. We do not pick a
  narrative silently.
- Conference/division membership is its own time series (`team_alignment`), never inferred from
  the current alignment.

Franchise queries: *all franchise history* = identity → franchise traversal over time;
*as it appeared* = identity only.

## G. Global player identity model

Person is the root; product ids are role profiles:

- `football.person` (`gpe_…`) — one human. Merges are recorded (`status='merged_into'`), never
  destructive; splits are possible.
- `football.player` → `global_football_player_id` (`gpl_…`), `football.coach` →
  `global_football_coach_id` (`gco_…`); a player who became a coach keeps one person.
- `person_name` (canonical / legal / alias / former / nickname / transliteration, with
  `generational_suffix` and `normalized_key`), `person_attribute_observation` (DOB, birthplace,
  nationality, height/weight **with measurement context and date**), `external_id` (id system,
  value, confidence, validity), `player_position_observation`, `jersey_number_period`.
- `football_src.identity_match_decision` — every merge / review / refusal with rule and evidence,
  reversible.

Match policy (`identity.mjs`, tested):
- Name equality **never** merges. Same name + two corroborations (DOB, college team, draft
  selection) → human `review` at most.
- `Jr./Sr./II/III/IV/V` are identity-bearing; different suffixes are distinct unless a shared strong
  id proves one person (suffix added/dropped over a career is then recorded as a name change).
- A conflicting strong id or conflicting DOB blocks automatic merge.
- Strong id systems: NFL GSIS, NFL ESB, ESPN athlete, PFR id (as identifier only), Wikidata QID,
  CFL, NCAA, CFBD. Each strong id value may belong to one entity (partial unique index).
- Known namespace defect carried as data: nflverse 2016-22 participation numeric NFL ids collide
  with PFF ids (from the 2026-09-15 rights audit) — never join on bare numbers.

Bootstrap crosswalk: the existing ESPN athlete ids (Career Ledger, DNA datasets) and nflverse
`players` id columns (approved for **internal reconciliation only**) seed `external_id`; no
nflverse attribute columns are used as facts.

## H. Position ontology

`history/ontology/positions.v1.json` — PropBetEdge's classification (versioned), with:
- a canonical tree (OFFENSE/DEFENSE/SPECIAL/TWO_WAY → groups → positions → alignment variants:
  `LT/LG/C/RG/RT`, `FS/SS`, `NB`, `MLB`, `NT`, `EDGE`, `KR/PR`, `H`, `LS`),
- historical terms as first-class labels (`TB`, `BB`, `WB`, `FL`, `SE`, `MG`, two-way `E/T/G/C`, `B`),
- source-label mappings with `ambiguous` flags. Ambiguous labels map to the narrowest group that is
  certainly true (`E → END_TWO_WAY`), never to a modern position by guess.

Every observation stores `source_label` verbatim + `canonical_code` + `ambiguous` +
`ontology_version` + context (roster / depth chart / game / draft / combine / college).
Era context (platoon vs two-way) comes from the season's rules profile, not a hard-coded year.

## I. Roster + transaction model

`003`: `transaction` (+ `transaction_asset`), `roster_status_period`, `jersey_number_period`.

- A transaction has **three clocks**: `effective_on` (took effect), `announced_at` (public),
  `observed_at` (our source recorded it). Features use `announced_at`/`observed_at`, never
  `effective_on` alone (retroactive effective dates are common).
- Assets are typed (player, draft pick, cash, rights, conditional) with from/to identities, so
  trades are graph edges, and pick lineage can be reconstructed.
- `roster_status_period` is the reconstructable state: player × team identity × status
  (active, gameday inactive, IR, DTR, PUP, NFI, suspended, practice squad, PS-injured,
  reserve/futures, exempt, unsigned pick) × interval, with its basis (transactions, dated roster
  snapshot, official list) and the ids it was derived from.
- **Roster on date D** = `roster_status_period` valid at D and observed by the chosen knowledge
  time. A player's current team is never used.
- Suspensions only where publicly documented by the league/team; no speculation fields.

## J. Draft model

`003`: `draft` (annual / supplemental / common draft / dispersal / expansion / allocation),
`draft_pick_asset` (the pick as an asset, original owner, compensatory), `draft_selection`
(round, pick in round, overall, **selecting team identity** in force, player, verbatim name /
position / college as listed, forfeits).

- Pick lineage = `transaction_asset` rows that move a `draft_pick_asset_id` between identities,
  only where sourced; unknown hops stay unknown.
- Rival-league drafts (e.g., AFL and NFL drafting the same player pre-merger) are separate
  `draft` rows in different leagues; one player can have two selections.
- UDFA is a **transaction** (`signed_undrafted`), not a draft row.
- Draft status never implies team membership; membership comes only from `roster_status_period`.

Queries enabled: class explorer (draft_id), by school (`global_college_team_id`), by franchise
(identity → franchise), career output by slot (joins to derived career totals), draft-class
teammates (selection + later roster overlap), pick trades (asset edges), position runs (ordered
selections × ontology group).

## K. College → NFL development graph

`002/003`: `school` (`global_school_id`) + `school_name` history, `college_team`
(`global_college_team_id`) + `college_team_membership` (governing body, classification,
conference per season), `college_enrollment` (arrival type, transfer, redshirt seasons),
`combine_measurement` (combine / pro day, timing method), `career_stage`.

- Career is a sequence of stages (`high_school → college → transfer → combine/pro_day → draft |
  undrafted_free_agent → training_camp → practice_squad → active_roster → …`), each citing its
  source. High school appears only where legitimately public and relevant.
- College statistics, when licensed, go to separate college stat tables keyed by
  `global_college_team_id`; **no view sums college and professional numbers.**
- Recruiting-service rankings are out of scope until rights are resolved (commercial ToU).

### Built (2026-09-18): the rights-clean half

`006_college_spine.sql` adds what the CC0/federal layer actually needs, and the naming is
deliberate about what each table can carry:

| Table | Holds |
|---|---|
| `college_conference` + `college_conference_membership` | a conference as an entity, not a string on a membership row. Programmes move; conferences are founded and dissolve; the same name has meant different things. |
| `college_program_season` | which institution reported fielding football in which year, with `sponsored`, the reported squad size, the **survey year**, and `reporting_basis = institution_self_report`. EADA is a filing, not an audit, and the row says so. |
| `player_college_affiliation` | the CC0 association edge, with the precision the source actually gave. `basis` distinguishes `educated_at` (attendance) from `member_of_sports_team` (played there); `played_football` stays null for the former rather than being inferred. Separate from `college_enrollment`, which expects a roster-grade source we do not have. |
| `college_to_pro_transition` | how a player entered professional football. `draft_round` and `draft_overall_pick` are nullable and stay null unless an **approved** source supplies them, and a check constraint refuses a draft detail with no snapshot to justify it. |

The programme layer comes from two sources because neither is sufficient alone: Wikidata supplies
195 programme entities (the items carrying `P8761`, linked to their university by `P831`), and the
EADA filing is what actually establishes that a programme existed in a given year. They join on the
IPEDS unit id (`P1771` = EADA's `unitid`), never on institution name.

### The public read contract

`api/college-pipeline.mjs`. A field allowlist, a forbidden-name check that runs after composition
at any depth, and the mixed-source rule — a composed record is withheld entirely rather than served
with the restricted component quietly removed. It joins the spine and no statistics table, so
widening it would mean adding a join on purpose rather than loosening a select.

## K2. The rights engine

`football_src.source_lane_policy` refines a source per dataset family; every snapshot names its
lane; row-level security resolves the pair. A lane narrows a source and never widens it, and every
undecided state fails closed. Ingestion is a stronger gate than display: a lane with
`ingest_allowed = false` must never reach canonical storage, including inside a JSON column. Model
use is a third question — a lane can be readable and still be unusable for a named model purpose,
which is how the CC0 college spine's survivorship bias is enforced rather than noted.

Full description: `docs/RIGHTS_ENGINE.md`. The CFBD adapter (`ingest/cfbd-adapter.mjs`) is built,
tested and **disabled**; no key exists and no CFBD data is stored.

## L. Game / drive / play schema

`004`:
- `game` (`global_football_game_id`): competition (preseason / regular / postseason /
  championship / Super Bowl …), season, verbatim week label, local date, kickoff with precision,
  venue + name as played, neutral/international flags, home/away **identities**, status incl.
  forfeits/suspensions, overtime periods and the **overtime rule key in force for that game**,
  attendance; `game_team_score` with period scores as sourced; `game_official`;
  `game_weather_observation` with explicit method (reported in game record, venue station hourly,
  nearest station hourly, daily summary, indoor).
- Box scores in long form: `team_game_stat`, `player_game_stat` keyed by
  `(stat_key, definition_version)` → `stat_definition` (scope, official-from season, citation).
  Sacks before they were an official statistic are a separate definition, never backfilled into
  the official series. `player_game_appearance` records active/appeared/started **with basis**.
- `drive`: offense identity, start/end period+clock, start/end yardline_100, plays, yards,
  duration, first downs, canonical result + verbatim result label.
- `play` (`global_football_play_id`): game, drive, sequence, source play key, period, clock,
  down/distance/yardline, possession/defense identities, canonical play type + source label,
  **verbatim description**, yards, air yards / YAC only where structured by the source, flags,
  pre-play score, and `field_confidence` per field (`source_structured` |
  `parsed_from_description` | `absent`). `play_participant` (typed roles) and `play_penalty`
  (accepted/declined/offsetting). Nothing is parsed into a structured field that the
  description cannot establish.
- `player_game_snaps`: defined, **empty until a snap/participation source is approved**
  (PFR snap counts rejected; NGS/FTN participation on hold).

Win probability, EPA, success rate, pressure models → `football_derived.game_feature` / future
play-level derived tables, labelled as derived with the model version.

## M. Injury-history integration plan

Today: `nfl-intel` pulls current injuries from the ESPN core API (a source the owner has since
REJECTED for new use — see `docs/risk/ESPN_REMEDIATION_PLAN.md`) into KV for What Changed /
PropChain. The history graph does **not** copy that feed.

Plan:
1. Canonical entity `football.availability_report` (practice participation, game status,
   inactive list, reserve list, in-game update) keyed to `global_football_player_id` +
   team identity + game, with `body_area_reported` verbatim and only a coarse normalized area.
   No diagnosis, severity, recovery estimate or medical inference fields exist.
2. Reserve designations (IR, DTR, PUP, NFI) are `roster_status_period` rows; the availability
   timeline joins both.
3. Source: the league's official public injury reports (practice + game status) are the
   authoritative competition-availability record — rights must be confirmed before ingestion
   (`SOURCES_AND_RIGHTS.md`). nflverse `injuries` (held locally for 2024) is a republication and
   stays measurement-only until its origin is cleared.
4. Integration with current injury intelligence (after ingestion is approved): a read-only
   crosswalk from nfl-intel's player keys (ESPN athlete id) to `global_football_player_id`
   via `external_id`, exposed as `GET /v1/history/players/{id}/availability`. nfl-intel keeps
   running unchanged; history never writes to its KV.
5. Health-information guardrails: availability-only scope; no free-text medical commentary
   ingestion from news; retention of the verbatim public report only.

## N. PropChain integration plan

PropChain v3 today (`propchain-core-v3.js`, `nfl-intel /api/changes`) joins current markets,
ledger-observed transitions, injuries and weather for the current slate. It must not be rebuilt.

Integration contract (later, read-only, behind feature flags):
1. **History as a service.** A separate Worker (`nfl-history`) exposes typed traversal endpoints;
   PropChain's core module gains an optional adapter that calls them. No ingestion code, schema or
   source logic lives in PropChain; no PropChain UI logic lives in history.
2. **Stable keys.** PropChain nodes already carry ESPN event ids and athlete ids; the adapter
   resolves them once to `global_football_game_id` / `global_football_player_id` through
   `external_id` and caches the mapping.
3. **Traversals exposed** (each response carries provenance + derived flags + as-of):
   player → recent games (box score lines) → plays (role, targets) → depth-chart role as of kickoff
   → teammates on field (only where participation is approved) → availability timeline →
   opponent → prior matchups (games between identities of the same franchises) →
   historical comparables (`football_derived.game_feature` similarity; labelled derived).
4. **Pre-game integrity.** Every PropChain history call for an upcoming game passes
   `known_at = now` and `valid_at = kickoff`; for replays of past games it passes the historical
   kickoff, so PropChain can never show "what happened later" as pre-game context.
5. **Rights.** The adapter requests surface `pro` or `public`; sources without that display policy
   are filtered server-side.

## P. Proposed APIs (new Worker `nfl-history`; not routed through nfl-gateway until approved)

All responses: `{ data, provenance: { sources:[{source_id, snapshot_id, licence_class}], derived, derivation_id?, as_of: {valid_at, known_at} }, rights: { surface } }`.
Query params common to time-varying endpoints: `valid_at`, `known_at` (default now), `surface`.

| Route | Returns |
|---|---|
| `GET /v1/history/sources` · `/sources/{id}` | registry rows (verdict, obligations, display policy) |
| `GET /v1/history/leagues` · `/leagues/{id}/relations` | competition graph |
| `GET /v1/history/franchises` · `/franchises/{id}` · `/franchises/{id}/lineage` | franchise + identities + events |
| `GET /v1/history/team-identities/{id}` | name/city/league span, alignments, home venues |
| `GET /v1/history/seasons/{league}/{year}` · `/standings` · `/playoffs` | season, standings as computed (derived) and as published (source), bracket |
| `GET /v1/history/games?season=&week=&team_identity=&franchise=` | game list |
| `GET /v1/history/games/{id}` · `/boxscore` · `/drives` · `/plays` · `/officials` · `/weather` | canonical game package |
| `GET /v1/history/players/{id}` | passport core (names, ids, positions, pathway) |
| `GET /v1/history/players/{id}/career` · `/gamelog?season=` · `/transactions` · `/availability` · `/teammates` · `/coaches` | career graph views |
| `GET /v1/history/rosters/{team_identity}?valid_at=` | roster as of a date |
| `GET /v1/history/transactions?team_identity=&player=&from=&to=` | transaction log |
| `GET /v1/history/drafts/{league}/{year}` · `/draft-picks/{asset}/lineage` | draft class, pick lineage |
| `GET /v1/history/coaches/{id}` · `/coaching-tree?root=` | tenures, overlaps (no inferred philosophy edges) |
| `GET /v1/history/venues/{id}` | names over time, attributes, tenants |
| `GET /v1/history/records/{record_key}?scope=` · `/leaderboards?scope=&stat=` | derived, with derivation + era context |
| `GET /v1/history/connections?a=&b=` | shared teams, games, schools, drafts, transactions |
| `POST /internal/v1/history/dataset` (internal token) | AS-OF feature extraction for experimental model lineage, with leakage audit report |

Model isolation (Phase 29): the existing picks and prop-picks lineage never reads these routes.
A future `pbe-nfl-model-v2-history` is a separate lineage with its own feature contract, leakage
audit (`leakageViolations`), untouched holdout, calibration and promotion rules; it cannot write to
the official track record tables.
