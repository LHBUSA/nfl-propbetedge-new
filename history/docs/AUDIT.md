# Football History Graph — Phase 1 Audit (A, B, E)

Measured 2026-09-15, read-only, repo main 4045d34. No writes, migrations, deploys or downloads.
Rights handling during the audit: `snap_counts_*` never opened (PFR, rejected); `pbp_participation_*`
and `ftn_charting_*` read for parquet schema + row counts only (HOLD / measurement-only).

**Headline: PropBetEdge holds no canonical NFL history.** Supabase contains only the 2026 picks,
odds and billing engine. Everything before 2026 is local gitignored parquet (2019-2025 depth),
git-tracked `data/dist` JSON (2000-2025, QB/RB/WR/TE only), or hand-maintained frontend JS with no
provenance. Nothing at all before 1967; almost nothing structured before 2019.

---

## A. Current NFL historical coverage inventory

### A1. Local nflverse releases (`data/nflverse`, gitignored, `_manifest.json` with URL + fetched_at + short sha256)

| File | Rows | Coverage | Identifier columns | Rights status |
|---|---|---|---|---|
| play_by_play_2019…2025 | 342,249 plays (372 cols, identical schema) | 2019-2025 REG+POST; REG 256/256/272/271/272/272/272, POST 11/13×6; 0 duplicate (game_id, play_id) | game_id, old_game_id, nfl_api_id, play_id, drive, fixed_drive, series, stadium_id, 45 `*_player_id` (gsis) | REVIEW (NFL-origin feed via nflfastR) |
| players | 24,828 | rookie_season 1974-2026 | gsis 100%, esb 100%, smart 100%, pfr 91.2%, espn 66.7%, nfl_id 47.9%, pff 46.8%, otc 39.4% | id columns APPROVED internal reconciliation only |
| roster_2023 / 2024 | 3,090 / 3,216 | weekly weeks 1-22 | 12 id systems | REVIEW |
| depth_charts_2024 | 37,312 | 2024 weeks 1-22 | gsis, elias | REVIEW |
| injuries_2024 | 6,215 | 2024 REG+POST | gsis | REVIEW |
| ngs_passing / receiving / rushing | 5,933 / 14,731 / 6,059 | 2016-2025 | player_gsis_id | NOT APPROVED (NGS) |
| pbp_participation_2019…2023, 2024_min, 2025_min | schema/counts only | 2019-2025 | gsis lists | HOLD (CC-BY-SA; NGS ≤2022 not approved; FTN 2023+ measurement only) |
| ftn_charting_2023 / 2024 | schema/counts only | 2023-2024 | ftn + nflverse ids | HOLD |
| snap_counts_2023 / 2024 | not opened | — | — | REJECTED (PFR) |

pbp field presence (2019-2025): drive/fixed_drive/series 0% null; air_yards null 6.4-7.5% of passes;
receiver id null 9.2-11.0% of passes (throwaways/spikes); penalty player null 6.9-8.8% of penalties;
roof/surface/stadium/coaches 0% null; temp/wind null 26.6-62.3% at game level (indoor by design;
outdoor 2.1-2.5% except **2022: 43.1% outdoor missing**). **No officials columns.**

### A2. Local warehouse (`data/warehouse`, gitignored, built by `research/ingest/*.py`)

| File | Rows | Content | Provenance |
|---|---|---|---|
| nfl_games | 1,960 | 2019-2025 schedule, score, spread/total, roof/surface/temp/wind, stadium, coaches | **none** |
| nfl_game_environment | 1,960 | venue lat/lon + Open-Meteo archive weather | partial (om_url, om_fetched_at) |
| nfl_venues | 32 | ESPN team venues, geocoded | yes |
| nfl_players | 24,828 | copy of players.parquet | none |
| nfl_qb_games / receiver_games / receiver_passer_games / running_back_games | 4,864 / 31,433 / 33,065 / 37,720 | pbp aggregates | none; 0 duplicate keys, 0 orphan ids |

### A3. Git-tracked `data/dist` (served by the product)

| File | Content | Coverage | Provenance |
|---|---|---|---|
| career-ledger.json (13.7 MB) | ESPN gamelog per game, `career-ledger-history/v1` | 1,203 players, 62,362 game rows, 2000-2025 | ESPN site.web.api (ToU flagged) |
| qb/rb/te/wr-dna-dataset.json | pbp-derived game rows + weather/venue | 2019-2025 | nflverse + Open-Meteo + ESPN |
| active-*-2026.json | 2026 rosters (QB/RB/TE/WR) | 2026 | ESPN core API (now REJECTED for new use) |
| nfl-venues.json | 32 current venues | current | source string |

Flags: `receiver-coverage-audit.json` and `qb-dna-dataset.json` already embed coverage figures derived
from participation data (git-tracked and publicly served) — conflicts with the HOLD decision's
"no participation-derived output may be exposed"; owner decision needed. DNA `withheld_fields`
text is stale about 2024-25 participation.

### A4. Static frontend history (`archive/*.js`) — no provenance, hand-maintained

| File | Content |
|---|---|
| superbowls.js | 60 Super Bowls (I-LX, 1967-2026): score, venue, MVP |
| seasons.js | 2000-2025: champion, MVP/OPOY/DPOY/COY/ROY, stat leaders |
| hof.js | 92 Hall of Fame members (partial list) |
| records.js | 8 record categories + 23 milestones (1892-2024); contains at least one factual error (a Brady/Brees passing-yards milestone dated 2023; it occurred in 2021) |
| teams.js | current 32 teams (founded, SB count, stadium, coach, 2024 record) + 2024 playoffs |
| standings-2025.js / stats-2025.js | 2025 standings/leaders, "verified 2026-08-29" |

These are the only pre-2000 history surfaces on the site. They are editorial constants, not data;
the history graph must replace them with derived views rather than import them.

### A5. Cloudflare runtime storage

| Store | Use | Content |
|---|---|---|
| KV NFL_KV `71eaad8f…` | nfl-current / gateway / odds / schedule | 70 keys: odds per event, `current:*:2026`, `stats:{1999,2010,2020,2024,2025}:passing:25`, broadcast |
| KV PICKS_KV `0e7c77bc…` | picks orchestrators, graders, tuners | 47 TTL keys (run ledger, closing, eval) |
| KV INTEL_KV `4e9c622b…` | nfl-intel | injuries, market batches, weather snapshot |
| R2 `nfl-replay` | nfl-replay | 18 objects, 746 kB, compact plays from nflverse pbp csv |
| Workflow `nfl-replay-ingest` | nfl-replay | cron `20 */3 * * *` |
| DO `MagicLinkLedger` | nfl-auth | magic links + purchase delivery records |

No NFL D1, no Queues. **nfl-gateway binds ten services with no source in this repo** (nfl-scores,
nfl-stats, nfl-injuries, nfl-news, nfl-historical, nfl-ste-engine, nfl-matchup, nfl-target-share,
nfl-situational, nfl-pbecast) — an architecture-rule violation to capture before building a new
history service (`nfl-historical` in particular must be inspected first).

---

## B. Existing schema inventory (Supabase `tkmlnhmylqnttmnsnief`, shared with UFC)

PostgREST exposes `public` only: 165 relations (93 `ufc_*`, 72 other), 29 RPCs.

NFL relations (22), all 2026 engine/billing:

| Relation | Rows | Notes |
|---|---|---|
| nfl_game_picks / nfl_pick_receipts / nfl_pick_audit_events / nfl_pick_grades / nfl_learning_observations / nfl_pick_anomalies | 203 / 203 / 907 / 64 / 28 / 1 | official track record — history must never write here |
| nfl_model_weights / nfl_team_ratings | 2 / 64 | ratings 2026 as_of_week 0-1 |
| nfl_odds_snapshots | 5,856 | 2026-09-05 → 09-15 |
| nfl_prop_picks (+ grades/receipts/learning/audit/closing/selector) | 19 … | **player_key is a lower-case name; no gsis/espn id** |
| nfl_subscriptions / nfl_stripe_webhook_events / nfl_auth_* / nfl_access_email_deliveries | 2 / 50 / 0 | billing/auth |

Repo SQL: `migrations/*.sql` applied (verified by column match). `research/schema/CANDIDATE_SCHEMA.sql`
and `002_qbdna_derived.sql` are **not applied** (an earlier canonical attempt: player/game identity,
plays, participants, source conflict — superseded by `history/schema`, reuse its lessons).
Schema drift: live objects without repo DDL — `integrity_status/reason` columns, `nfl_subscriptions`
base table, `nfl_auth_*`, `nfl_stripe_webhook_events`, `nfl_access_email_deliveries`, three auth RPCs.

Other product tables on the same project: `combat_*` (MMA identity graph, 9,430 career bouts),
`nhl_pbe_*` (empty), `wnba_pbe_*`, `forum_*`, `store_*`. The history graph should not add ~64 tables
to this shared project without an isolation decision (see PLAN.md, decision D1).

---

## E. Missing-data matrix by season band

Codes: **L** held locally · **L\*** held but HOLD/REJECTED · **S** Supabase · **F** static frontend only · **K** runtime cache only · **—** absent.

| Category | 1920-45 | 1946-69 | 1970-98 | 1999-08 | 2009-15 | 2016-18 | 2019-22 | 2023-25 | 2026 |
|---|---|---|---|---|---|---|---|---|---|
| Franchises / identities / lineage | — | — | — | — | — | — | L (current-normalized codes, no lineage) | L (same) | F teams.js |
| Schedules / games | — | F (SB 1967+) | F (SB) | F; L partial (ledger events 2000+) | F; L partial | F; L partial | L nfl_games + pbp | L | S picks/odds; K |
| Final scores | — | F (SB) | F (SB) | F; L partial | F; L partial | F; L partial | L | L | K |
| Team box score | — | — | — | — | — | — | L (derivable from pbp) | L | K replay |
| Player game stats | — | — | — | L ledger (QB/RB/WR/TE) | L ledger | L ledger; ngs (not approved) | L warehouse/DNA/ledger | L | K replay |
| Season rosters | — | — | — (bio only 1974+) | — | — | — | — | L 2023-24 (2025 absent) | L active-*-2026 (skill positions) |
| Depth charts | — | — | — | — | — | — | — | L 2024 only | — |
| Injuries / availability | — | — | — | — | — | — | — | L 2024 only | K INTEL_KV |
| Transactions | — | — | — | — | — | — | — | — | — |
| Draft | — | — | L players.draft_* (1974+) | L | L | L | L | L | L |
| Combine / pro day | — | — | — | — | — | — | — | — | — |
| Coaches | — | — | — | F COY | F | F | L (game head coaches) | L | F |
| Officials | — | — | — | — | — | — | — | — | — |
| Venues | — | F (SB) | F | F | F | F | L stadium_id/name | L | L 32 current |
| Weather | — | — | — | — | — | — | L pbp + Open-Meteo | L | K |
| Drives | — | — | — | — | — | — | L pbp | L pbp | K |
| Play-by-play | — | — | — | — | — | — | L | L | K R2 |
| Participation | — | — | — | — | — | — | L\* HOLD | L\* HOLD | — |
| Snaps | — | — | — | — | — | — | — | L\* REJECTED | — |
| Awards | — | F (SB MVP) | F (SB MVP, HOF 1971+) | F seasons.js | F | F | F | F | — |
| College / pathway | — | — | — | — | — | — | — | — | — |
| Other leagues (AFL, AAFC, CFL, UFL…) | — | — | — | — | — | — | — | — | — |

## Identifier crosswalk facts (drive G)

- **players.parquet is the de-facto spine** but not clean: 6,078 rows carry an Elias-style id in the
  gsis column (equal to esb_id); only 171 of those have ESPN ids; 5,864 of them are marked `ACT`, so
  `status` is unreliable. One esb/smart collision is a duplicate person (same name + DOB under two
  gsis values). One same-name same-DOB pair at different positions needs review — exactly the case
  `identity.mjs` routes to `review`, never `merge`.
- Coverage decays backwards: players whose last season is 1970-98 have pfr 92%, espn 19%, nfl_id 0.8%.
- career-ledger espn→gsis agrees with players.parquet 1,203/1,203.
- Rosters: 163 (2023) / 203 (2024) gsis values absent from players.parquet (mostly CUT); espn_id
  disagrees with players.parquet for 7 / 4 players.
- **Team codes are current-normalized** (2019 `CHI_OAK` game carries home_team `LV`) — no historical
  identity survives in the local data; lineage must come from a separate source.
- **Venue defects in the warehouse:** 42 neutral-site games assigned the home team's venue (31 got
  Open-Meteo weather for the wrong location); 102 LA/LAC 2020+ home games mapped to the wrong
  stadium; 8 Oakland 2019 games mapped to Las Vegas. `nfl-venues.json` is already corrected;
  `nfl_game_environment.parquet` is stale. Check whether any DNA weather split consumed these rows.
- Supabase prop picks join players by lower-case name (`player_key`) — the one production name join
  found; the history crosswalk can later supply ids without changing that table.
