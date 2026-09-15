# Football History Graph — Source Registry and Rights Map (C, D)

Machine-readable registry: `history/registry/sources.v1.json` (40 sources, the shape the
`football_src.source` table loads). This document is the decision view of it.
Research date 2026-09-15. **Not legal advice**; every verdict below is either an owner decision
already on record, or my recommendation pending your call.

Marks: **[V]** read in the governing primary document · **[S]** secondary/search excerpt ·
**[U]** unverified.

## The headline

**There is no rights-clean source today for game-level American football history** — box scores,
play-by-play, rosters, transactions, injuries, drafts — for any season. Everything in that class is
either an owner-rejected source, a source on hold, an undocumented chain of rights, or a paid feed.
What *is* clean now covers the skeleton: franchises, venues, coaches, championships, identifiers,
weather and geography.

## Rights-clean now (usable for a commercial surface)

| Source | Licence | Covers | Obligations |
|---|---|---|---|
| **Wikidata** [V] | CC0 | franchises, dated name history (sparse), venues + coordinates, head coaches, Super Bowls, awards (sparse), HoF, id crosswalk (PFR 28,896 / NFL.com 24,821 / ESPN 2,870) | none; we still cite QID + property |
| **PropBetEdge curated crosswalk** | our own | abbreviation → franchise, any mapping we author | validated structurally, never attributed to a provider |
| **NOAA ISD / GHCNh** [V] | US Government, public domain | hourly station observations, dense US airport coverage | none (US stations only; non-US under WMO Res 40 → review) |
| **Copernicus ERA5** [S] | CC-BY | gridded reanalysis anywhere, 1940+ | "Generated using Copernicus Climate Change Service information" |
| **Meteostat** [V] | CC-BY 4.0 | station weather, easier API | attribution + original provider |
| **GeoNames** [V] | CC-BY | cities, admin hierarchy | attribution |
| **Chronicling America (LoC)** [S] | public domain (pre-1931 certain) | early pro football results, standings, linescores | none |

Wikidata's quality is the catch: dated official-name history exists for only **3 of 32** current
franchises; AAFC teams are barely linked; "Super Bowl MVP" award links number **4**. It is a
skeleton and an id crosswalk, not an authority — which is why the schema records identity bounds as
`documented` vs `evidence_window`.

## Owner decisions already on record (2026-09-15, not re-litigated)

| Source | Decision |
|---|---|
| nflverse `snap_counts` (Pro Football Reference) | **REJECTED** |
| ESPN Core API | **REJECTED** (existing site-API production use on the risk register) |
| nflverse `stats_player_week` | **HOLD** |
| nflverse `pbp_participation` | **HOLD** — NGS 2016-22 not approved; FTN 2023+ measurement only |
| nflverse player id + schedule id columns | **APPROVED, internal reconciliation only** |

## Blocked or restricted (my recommendation, for your decision)

| Source | Verdict | Basis |
|---|---|---|
| **Pro Football Reference / Sports Reference / Stathead** [V] | DO NOT USE | ToU §5 bars databases that substitute for theirs **and** bars use for training or prompting AI models; bulk licence starts at $5,000 and may preclude redistribution. This removes the obvious route to 1920+ box scores, drafts (1936+) and combine |
| **nflverse `draft_picks`, `combine`, `trades`, `pfr_advstats`** [V] | DO NOT USE | all are PFR-origin, same basis as the rejected snap counts |
| **nflverse `contracts`** [V] | LICENSE REQUIRED | OverTheCap bars scraping for commercial use; they licence directly |
| **nflverse `nextgen_stats`** [V] | LICENSE REQUIRED | NFL NGS; Genius Sports holds exclusive distribution |
| **nflverse `depth_charts` 2025+** [V] | DO NOT USE | source switched to ESPN in 2025 (Disney ToU) |
| **NFL.com / operations.nfl.com / GSIS** [V] | LICENSE REQUIRED | "solely for your own individual non-commercial" + systematic-retrieval ban |
| **247Sports / On3 / Rivals** [V/U] | DO NOT USE | non-commercial terms |
| **NCAA.com / stats.ncaa.org** [S] | LICENSE REQUIRED | commercial use of NCAA content prohibited |
| **CFL.ca, UFL/USFL/XFL sites** [V/S] | LICENSE REQUIRED | non-commercial terms; Genius (CFL) and Sportradar (UFL) hold the data rights |
| **OpenStreetMap** [V] | REVIEW | individual venue lookups fine with attribution; a systematic stadium table may trigger ODbL ShareAlike — prefer Wikidata/GeoNames |
| **Wikipedia** [V] | REVIEW | individual facts low risk; bulk table extraction into a commercial database needs counsel on the sui generis waiver |

## The central open question (D1)

**nflverse data whose origin is the NFL's own feed** — `play_by_play` (1999+), `weekly_rosters`
(2002+), `depth_charts` (≤2024), `injuries` (2009-2024), `officials` (2015+). nflverse publishes
under CC-BY-4.0, but that licence covers only what nflverse itself owns; the underlying NFL terms
[V] bar systematic retrieval and commercial use. This is the same question as the `stats_player_week`
hold, and it is not hypothetical:

> **Production already depends on it today** — the Player DNA datasets, `nfl_team_ratings`, the
> nfl-replay R2 archive and the `HISTORY` table embedded in the nfl-picks Worker.

So D1 is not only a history decision; it decides whether existing production keeps that dependency,
restricts it to internal use, or moves to a licensed feed.

Options: (a) accept the risk and keep it internal-only (the history graph is already built that
way — the slice proves plays are withheld from public and pro surfaces); (b) accept for display too;
(c) replace with a licensed feed (Sportradar covers 2000+ schedules, box scores, pbp, rosters,
injuries, depth charts, transactions and draft [V]); (d) stop using it, which would also mean
unwinding parts of production.

## Licensed feeds, and what each unlocks

| Feed | Depth | Unlocks |
|---|---|---|
| **Sportradar NFL** [V] | REG/POST 2000+, PRE 2015+; 2000-2020 partly NFL-sourced | pbp, box scores, game rosters, weekly injuries, depth charts, daily transactions, draft — stages 3-5 at once, and would retire the ESPN dependency |
| **SportsDataIO** [S] | stats 2001+ | similar coverage, likely cheaper; depth needs confirming |
| **Genius Sports** [V] | official NFL real-time pbp + NGS, exclusive through the 2029 season | live/grading and NGS; historical depth unverified |
| **Sports Reference bulk licence** [V] | 1920+, drafts, combine | the only route to deep pre-1999 history; the AI/ML clause would have to be expressly overridden |
| **FTN Data** [U] | charting/participation 2022+ | participation without ShareAlike |

## How rights are enforced, not just documented

`football_src.source` carries `commercial_verdict`, `display_policy` and `model_use_allowed`, and
the API filters every row by the requested surface. The 2023 slice proves it: the same request
returns **0 play rows on `public` and `pro`** and the full play list on `internal`, while CC0
franchise identities are public. A source on HOLD can therefore sit in staging for measurement and
remain invisible to users and models — the state the owner's participation decision requires.
