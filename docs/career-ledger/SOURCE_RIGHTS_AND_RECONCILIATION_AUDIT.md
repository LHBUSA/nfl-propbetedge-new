# Career Ledger — source rights + reconciliation audit (decision receipt)

**Status:** AUDIT ONLY · 2026-09-15 · awaiting owner approval.
Nothing was ingested, the production Career Ledger is untouched, `career-ledger.json`
was not regenerated. Not legal advice: every REVIEW REQUIRED item needs owner/counsel sign-off.

Reproduce the numbers: `python scripts/career-ledger/reconciliation_audit.py --schedule <nflverse games.csv> --out <dir>`
(reads only the production ledger, the DNA datasets and nflverse files already held under
`data/nflverse/`; the locally present `snap_counts_*` files are deliberately not read).

---

## 1. Source-rights matrix

Principle applied: a repository-level licence only licenses rights the licensor holds.
CC-BY 4.0 grants "the Licensed Rights" of the Licensor; it cannot waive a third party's
terms of use, database licence, or contract. Facts themselves are not copyrightable (Sports
Reference says so on its own data-use page), so the risk is mostly **contractual/terms-of-use**
and **ShareAlike scope**, not copyright in individual statistics.

| Source | Upstream / original | Stated licence | Does the nflverse licence cover the upstream? | Upstream restrictions | Commercial use in PropBetEdge clearly permitted? | Required attribution | Confidence |
|---|---|---|---|---|---|---|---|
| **nflverse `snap_counts`** | Pro Football Reference (Sports Reference LLC), scraped by `nflverse/nflverse-pfr` (GPL-3.0 code). nflreadr: *"game level snap counts stats provided by Pro Football Reference"* | Only the nflverse-data **repository** licence (CC-BY-4.0). No dataset-specific licence; release notes silent | **No.** nflverse is not SR's licensor. SR: *"For some of our datasets, our licenses completely preclude any redistribution of the data."* | SR Terms of Use §5 (last updated 2023-05-19): may not use *"any statistics or data (i) to create any database, archive, or other data store that competes with or constitutes a material substitute for the services or data stores offered on the Site or by the Site's Data Providers"*, nor *"for purposes of training, fine-tuning, prompting, or instructing artificial intelligence models … (ii) supporting machine learning methods used to predict, classify, label, or score"*. Bulk data requests: US$5,000 minimum | **No.** A multi-season, every-player, every-game appearance ledger inside a paid NFL stats product is plausibly a "material substitute"; PropBetEdge also runs predictive models | SR requires explicit credit to Sports Reference; CC-BY credit to nflverse | **DO NOT USE** (without written permission from Sports Reference) |
| **nflverse `stats_player_week`** | Computed by nflverse from nflfastR play-by-play; nflfastR reads **NFL's own game-detail feed** (`viewer.gameDetail`) | nflverse-pbp / nflverse-data: CC-BY-4.0. nflfastR code: MIT | **Only nflverse's derivation work.** nflverse cannot license NFL's rights or terms | NFL.com Terms (updated 2024-05-16): *"solely for your own individual non-commercial and informational purposes"*; *"Systematic retrieval of data … to create or compile … a collection, compilation, database, or directory, is prohibited absent our express prior written consent."* PropBetEdge would not access NFL.com itself; the terms bind the accessing party, but the chain of rights stops at nflverse | **Not clearly.** Widely used commercially in analytics; no explicit NFL grant | "Data: nflverse (nflfastR / nflreadr), CC-BY 4.0", plus a note of changes | **REVIEW REQUIRED.** Same review already applies to the production Player DNA datasets, which are built from this nflverse play-by-play |
| **nflverse `pbp_participation`** *(found during the audit: the strongest appearance source)* | 2016–2022: **NFL Next Gen Stats**; 2023+: **FTN Data** (*"courtesy of FTN"*) | Explicitly **CC-BY-SA 4.0** (nflreadr `load_participation`), **not** CC-BY. `NFL_PUBLIC_SOURCE_MATRIX.md` mislabelled it CC-BY | 2023+ (FTN): the owner granted the release, so yes, under ShareAlike. 2016–2022 (NGS): an nflverse assertion over NFL-origin data, same chain-of-rights gap as play-by-play | **ShareAlike:** Adapted Material we *share* must be CC-BY-SA. Serving a games-played count derived from it in a paid API may make the ledger Adapted Material. NFL terms as above for the NGS era | FTN: yes, if ShareAlike obligations are accepted or the use stays a non-shared verification signal (**counsel to confirm scope**). NGS era: not clearly | **"FTN Data via nflverse"** (2023+) / **"NFL NextGenStats via nflverse"** (≤2022), CC-BY-SA 4.0 | **REVIEW REQUIRED** (ShareAlike scope; NGS-era chain of rights) |
| **nflverse player/id mapping** (`players`) | NFL GSIS (`gsis_id`, `smart_id`, bio), **PFR** (`pfr_id`, draft info, scraped), **PFF** (`pff_id`, position/status), **OTC** (`otc_id`), ESB, **ESPN** (`espn_id`), plus a manual overwrite file | nflverse-data CC-BY-4.0; builder repo `nflverse-players` licence NOASSERTION | Partially. Identifiers are facts; PFR/PFF/OTC-sourced **attributes** are not nflverse's to license | SR §5 for PFR-sourced fields at scale; PFF/OTC terms for their fields; Disney terms for ESPN ids | **Identifiers only, internal join:** low risk, not explicitly granted. Republishing PFR draft or PFF fields: no | nflverse CC-BY credit | **REVIEW REQUIRED, low risk.** Restrict to `gsis_id`, `espn_id`, `nfl_id`. Never use or republish PFR/PFF/OTC attributes. `pfr_id` is **not needed** once snap counts are out |
| **nflverse schedule ESPN-id mapping** (`games.csv`, Lee Sharpe `nfldata`) | Lee Sharpe's curation of NFL / ESPN / PFR / PFF / FTN game ids, plus third-party betting lines | `nflverse/nfldata` has **no licence file**; hosted in the nflverse org; nflreadr gives no dataset licence | **Unclear.** No explicit grant from the author; ids are factual | Betting-line columns come from third parties (not needed) | Identifier columns for an internal join: low risk, not explicitly granted | "Schedule ids: Lee Sharpe / nflverse nfldata" | **REVIEW REQUIRED, low risk.** Use only `game_id, season, game_type, week, away_team, home_team, espn`. Measured errors (§3) mean it must never be authoritative alone |
| **ESPN Core API event logs** (`sports.core.api.espn.com/.../athletes/{id}/eventlog`) | ESPN (The Walt Disney Company), undocumented endpoints | None published | n/a | Disney Terms of Use (updated 2024-05-24): personal, non-commercial licence only; may not *"access, monitor, copy or extract the Disney Products using a robot, spider, script, or other automated means, including … data mining or web scraping"*; *"do not allow uses … that are commercial or business-related"* | **No** | n/a | **DO NOT USE** for new bulk ingestion. Also technically unreliable: Adams 2014 returned 1 event where 16 were played; Witten 2003 returned 404 |

### Material finding outside the proposed sources (not acted on; Career Ledger frozen)
The **production Career Ledger already depends on ESPN**, as do other production NFL surfaces:
- the history harvest (`site.web.api` athlete game logs, 1,203 players)
- the request-time 2026 game log
- live box scores
- `nfl-live`, the `nfl-current` adapter, `game-context`, and the injuries read from the ESPN core API

The Disney terms that block ESPN Core for new ingestion read the same for these. The existing matrix treats ESPN as "display of factual game state ⚠️". **Owner/counsel should review the existing ESPN dependency explicitly.** This audit changes nothing in production.

Tracked as its own risk item: [docs/risk/ESPN_PRODUCTION_DEPENDENCY.md](../risk/ESPN_PRODUCTION_DEPENDENCY.md). Participation / ShareAlike follow-up: [PARTICIPATION_DERIVATION_AND_SHAREALIKE.md](PARTICIPATION_DERIVATION_AND_SHAREALIKE.md).

`NFL_PUBLIC_SOURCE_MATRIX.md` also marks `snap_counts` CC-BY-4.0 ✅ and participation CC-BY-4.0. Both were corrected there by pointer to this document.

---

## 2. Recommendation

| | Sources | Why |
|---|---|---|
| **Allowed (pending counsel sign-off on the noted scope)** | 1. **`pbp_participation` 2023+ (FTN)**: licensor-granted CC-BY-SA; appearance proof. 2. **`players` identifiers only** (`gsis_id`, `espn_id`, `nfl_id`). 3. **`games.csv` identifier columns only**, cross-checked (§4 R2) | Owner-granted licence (FTN) or factual identifiers used only for internal joins |
| **Review before any use** | 4. **`pbp_participation` 2016–2022 (NGS)**: the biggest coverage gain, NFL-origin chain of rights, ShareAlike. 5. **`stats_player_week`**: NFL-origin chain of rights, and **low value** (the missing games are zero-stat, §3) | Rights not clearly granted by the original owner |
| **Blocked** | **`snap_counts` (PFR)**: SR ToU §5 competing-database and ML clauses; SR states some licences preclude redistribution. **ESPN Core API event logs**: Disney ToU prohibits automated extraction and commercial use; unreliable in testing | Upstream terms expressly restrict this use |

Only source that could fill 2012–2015 appearance gaps: `snap_counts`, which is blocked. Those seasons stay TRACKED unless Sports Reference grants written permission.

---

## 3. Coverage projection (no player upgraded)

Inventory from the production ledger:
- **696 TRACKED players** (72 QB · 142 RB · 291 WR · 191 TE).
- **524** have named failing seasons: **1,266**.
- **172** have **no ESPN history at all** (no debut, no season rows). 171 are on 2026 rosters.

| Case type (ledger) | Seasons | 1999–2011 | 2012–2015 | 2016–2018 | 2019–2025 |
|---|---|---|---|---|---|
| ESPN under-count (game log < ESPN GP), 1,093 missing games | 479 | 1 | 19 | 85 | 374 |
| ESPN over-count (game log > ESPN GP), 119 extra rows | 67 | 12 | 0 | 2 | 53 |
| Entire season missing (no log, no season row) | 475 | 11 | 65 | 103 | 296 |
| Game log without a provider season row | 122 | 0 | 4 | 14 | 104 |
| nflverse roster season before ESPN debut | 123 | 36 | 4 | 3 | 80 |

**Measured on data already held (2019–2023 participation, identity-mapped; DNA play-by-play rows 2019–2025):**
- **Participation false negatives:** for CAREER players, 12,880 logged games in covered games. Participation missed the player in **31 (0.24%)**, and **all 31 were zero-stat rows**, i.e. likely genuine did-not-play (e.g. LeSean McCoy inactive in KC's 2019 playoffs). Games with a recorded stat missed: **0 of 12,031**. So "no participation, no stat" can prove non-appearance.
- **ESPN under-count (2019+, participation held for 368 of 374):** participation explains **every** missing game in **368 of 368**. Play-by-play stat rows explain only **1 of 374**: the missing games are **zero-stat appearances** (special teams, blocking snaps).
- **ESPN over-count (2019+, participation held for 35 of 53):** participation shows the extra logged game(s) were **not played** in **26 of 35**; 9 are unexplained.
- **Entire season missing (2019+, participation held for 215 of 296):** **152** proven **no appearance** (a 0-game season); 63 did appear (ESPN missing real games). **62 of 296** have play-by-play stat rows.
- **Pre-debut roster season (2019+, held for 57 of 80):** **44** no appearance; 13 appeared.
- **Game log without a season row (2019+, held for 67 of 104):** 66 appeared (participation can verify the logged count); 1 no appearance.
- **No-history players (172):**
  - 4 appeared in 2019–23 participation. **Chris Manhertz: 83 games while ESPN has nothing**, so the ESPN id is suspect: identity edge case.
  - 5 no appearance.
  - 163 are 2024+ rookies, outside the held participation seasons.

**Expected gain by source** (seasons theoretically in reach, and the realistic outcome):

| Source | Under-count | Over-count | Entire season | Row missing | Pre-debut | Players whose every failing season is in reach |
|---|---|---|---|---|---|---|
| Participation 2016–2025 (REVIEW) | 459 in reach; **~100% measured** | 55 in reach; **~74% measured** | 399 in reach; **~71% proven 0-game**; appeared cases still need stats | 118 in reach | 83 in reach; **~77% measured** | **461 of 524** (upper bound; ESPN id problems and unexplained over-counts reduce it) |
| Participation 2023+ FTN only (allowed tier) | 2023–25 only | 2023–25 only | 2023–25 only | 2023–25 only | 2023–25 only | small; dry run to measure (2024/2025 files not held) |
| `stats_player_week` (REVIEW) | **≈0** (missing games are zero-stat) | 0 (cannot prove DNP) | only seasons where he recorded a stat (**~21%** of 2019+ measured) | adds stat lines | 0 | not a standalone fix; complements participation for the 63 "appeared" seasons |
| `snap_counts` (BLOCKED) | 478 | 55 | 464 | 122 | 87 | 507 of 524; the only extra reach over participation is 2012–2015 (**54 players**) |
| ESPN Core event log (BLOCKED) | all, in theory | all | all | all | all | unreliable in testing |
| **Pre-2012 unprovable** | 1 | 12 | 11 | 0 | 36 | **17 players** have a pre-2012 failing season: stay TRACKED under any allowed source |

Upper bounds, not promises: a player becomes CAREER only when **every** season reconciles, and the §5 edge cases fail closed.

---

## 4. Exact reconciliation rules (proposal, not implemented)

**R1 · Player identity.**
- The ESPN athlete id is the ledger key.
- ESPN ↔ GSIS through `players.espn_id` ↔ `players.gsis_id`, one-to-one in both directions (measured: 1,203 / 1,203 ledger players match; 0 conflicts).
- Participation ids: 2023+ are GSIS; **2016–2022 are NFL numeric ids mapped only through the typed `players.nfl_id` column** (2,201 / 2,201 mapped in 2020). Those numbers also collide with 207 unrelated `pff_id`s, so bare-number joins are forbidden.
- Any one-to-many, missing or conflicting mapping: that player stays TRACKED.
- Names are never joined.

**R2 · Game identity.**
- ESPN event id → `games.espn` → nflverse `game_id`.
- Accepted only if the schedule row agrees on season, game type and both teams, after the explicit team-code map `WSH→WAS`, `LAR→LA` (historical codes unchanged).
- Postseason type comes from the schedule's `game_type` (WC/DIV/CON/SB), **never ESPN's postseason week number**: pre-2009 ESPN labels the Super Bowl week 4.
- Duplicated ESPN ids in `games.csv` (12) and any row that disagrees: fail closed.
- Measured over all 62,362 ledger games: **62,347 exact**, 8 disagreements (all pre-2009 Super Bowls labelled POST week 4, a rule fix), 5 ambiguous duplicated ids, 2 no match. The schedule has a few **wrong ESPN ids (2003–2010)**.

**R3 · Appearance.** A player appeared in a game iff he is on ≥1 participation play in that game (offense, defense or special teams), or he has a non-zero ESPN or play-by-play stat line in it.

**R4 · Under-count.** An ESPN-GP game missing from the game log counts as a **zero-stat appearance** only when R3 proves the appearance (participation) **and** no stat line exists anywhere. Stats are recorded as provable zeros with `source: participation` and `stat_basis: no recorded stat in complete play-by-play`.

**R5 · Over-count / DNP.**
- A logged ESPN row with **all-zero stats** and **no participation** (in a game participation covers) is **excluded from games** and kept visible as `did_not_play`.
- A logged row **with** any stat is never excluded.

**R6 · Entire season or pre-debut season.** A season with no ESPN data counts as a **proven 0-game season** only when participation covers every game of the player's teams that season and he appears in none. Otherwise that season stays a gap.

**R7 · Game log without a season row.** Accept the logged games when the participation appearance count equals the logged count; otherwise gap.

**R8 · Stat lines ESPN lacks** (player appeared, recorded stats, no ESPN row). Only from an approved stat source (`stats_player_week` needs REVIEW). Never inferred from participation. Until approved, such a season stays TRACKED.

**R9 · CAREER label.** Every season from debut to the last season reconciles by ESPN GP **or** by R3–R7 using approved sources. Every derived row carries `source`, `rule`, `evidence`.

**R10 · Eras without an approved appearance source.** Pre-2016 (and 2012–2015 unless SR permission): zero-stat appearances and non-appearances are **unprovable**, so those players stay TRACKED.

**R11 · Attribution and licence obligations.** Surface the required attribution on the Career Ledger sources line. Resolve ShareAlike scope with counsel **before** any participation-derived value is served.

---

## 5. 40-player dry-run cohort

Chosen by case type with a fixed seed from the audit script, then balanced: QB 9 · RB 9 · WR 9 · TE 13.
The script prints 41 raw candidates; four of them (Freddie Swain, Adam Shaheen, Jeremy Sprinkle, DeeJay Dallas, all duplicate case types)
were swapped for the three no-ESPN-history cases (#38–#40), which the script does not sample.

| # | Player (ESPN id) | Pos | Season | Case |
|---|---|---|---|---|
| 1 | Travis Kelce (15847) | TE | 2013 | entire season missing (debut year) |
| 2 | Jason Witten (4527) | TE | 2003 | under-count |
| 3 | Davante Adams (16800) | WR | 2014 | under-count; ESPN Core returned 1 event |
| 4 | Demetrius Harris (16318) | TE | 2021 | under-count, 4 games |
| 5 | Tyler Johnson (2310331) | WR | 2020 | under-count |
| 6 | Jeff Wilson Jr. (3122976) | RB | 2021 | under-count |
| 7 | Carlos Hyde (16777) | RB | 2021 | under-count |
| 8 | Josiah Deguara (3914151) | TE | 2021 | under-count, 4 games |
| 9 | Mike Thomas (3123986) | WR | 2016 | under-count (NGS era) |
| 10 | Richie James (3122899) | WR | 2018 | under-count |
| 11 | Ross Dwelley (3120303) | TE | 2018 | under-count |
| 12 | Ryan Griffin (15887) | TE | 2014 | under-count (2012–15: no approved source) |
| 13 | Ryan Fitzpatrick (8664) | QB | 2008 | under-count pre-2012 (unprovable) |
| 14 | Feleipe Franks (4034948) | TE | 2022 | over-count |
| 15 | Mark Ingram II (13981) | RB | 2022 | over-count |
| 16 | Jack Stoll (4034862) | TE | 2024 | over-count, 4 rows (2024 participation not held) |
| 17 | Chris Evans (4046530) | RB | 2022 | over-count |
| 18 | Brandon Allen (2574511) | QB | 2022 | over-count (backup QB DNP rows) |
| 19 | Sam Darnold (3912547) | QB | 2023 | over-count (FTN era) |
| 20 | Marcus Mariota (2576980) | QB | 2021 | under-count, 3 games |
| 21 | Mitchell Trubisky (3039707) | QB | 2021 | under-count |
| 22 | Jody Fortson (4408854) | TE | 2019 | entire season missing |
| 23 | Jalen Hurd (3115328) | WR | 2025 | entire season missing |
| 24 | Justin Jackson (3116136) | RB | 2024 | entire season missing |
| 25 | Joshua Dobbs (3044720) | QB | 2019 | entire season missing |
| 26 | Rico Dowdle (4038815) | RB | 2021 | entire season missing |
| 27 | Damiere Byrd (2577667) | WR | 2015 | entire season missing pre-2016 |
| 28 | Giovani Bernard (15826) | RB | 2018 | entire season missing (NGS era) |
| 29 | Zach Ertz (15835) | TE | 2013 | entire season missing (debut year) |
| 30 | Mason Rudolph (3116407) | QB | 2018 | entire season missing |
| 31 | Andy Dalton (14012) | QB | 2012 | entire season missing, **but he started 16 games**: an ESPN athlete-record gap |
| 32 | Justin Watson (3118892) | WR | 2021 | game log without a season row |
| 33 | Jimmy Garoppolo (16760) | QB | 2016 | game log without a season row |
| 34 | Marcedes Lewis (9614) | TE | 2025 | game log without a season row |
| 35 | Mike Washington Jr. (4686658) | RB | 2005 | nflverse rookie_season 2005 for a current player: **crosswalk error** |
| 36 | Austin Trammell (4244856) | WR | 2021 | pre-debut roster season |
| 37 | Sincere McCormick (4430104) | RB | 2022 | pre-debut roster season |
| 38 | Chris Manhertz (4071345) | TE | — | no ESPN history, 83 participation games: **suspect ESPN id** |
| 39 | Cameron Latu (4372026) | TE | — | no ESPN history, no 2019–23 appearance |
| 40 | Julian Hicks (4244768) | WR | — | no ESPN history, 2024 rookie (needs 2024/25 participation) |

Dry-run acceptance, per player:
- before/after label with every season's rule and evidence
- zero upgrades on any fail-closed condition
- no stat value from a non-approved source
- totals still equal the sum of the rows

---

## 6. Unresolved edge cases

1. **ESPN DNP rows inside CAREER players.** 31 zero-stat, no-participation rows among CAREER players (2019–2023 alone). ESPN's GP counts them, so the production ledger counts them as games. Truthful counts need R5 even for players already labelled CAREER. **The frozen ledger was not changed; owner decision.**
2. **Wrong or absent ESPN athlete ids** (Chris Manhertz; Andy Dalton 2012). A player can play while his ESPN id returns nothing. Needs an ESPN-id correction path that fails closed, never a name match.
3. **nflverse crosswalk errors** (Mike Washington Jr. rookie_season 2005). R1 must treat implausible crosswalk seasons as conflicts.
4. **Schedule ESPN-id errors 2003–2010.** 12 duplicated ids, wrong assignments. Covered by R2's field agreement; affected games fail closed.
5. **Nine unexplained 2019+ over-counts.** ESPN GP lower than the rows, but participation shows the rows were played. Possibly ESPN GP excludes special-teams-only games: needs row-level review in the dry run.
6. **Participation coverage gaps.** 8.6% of 2019–2022 plays have an empty `players_on_play`. Game-level false negatives measured at 0 for stat games, but R6 requires coverage of **every** team game before proving a 0-game season.
7. **2024–2025 participation not held.** Measuring the 163 no-history rookies and 2024+ cases needs an approved fetch.
8. **ShareAlike scope.** Does serving a participation-derived games count make the ledger CC-BY-SA Adapted Material? Counsel.
9. **2012–2015 and pre-2012.** No approved appearance source. 54 players have a 2012–2015 failing season and 17 a pre-2012 one; both groups stay TRACKED absent SR permission or another licensed source.
10. **Existing ESPN dependency** of the production ledger and other NFL surfaces under Disney terms. Owner/counsel review.

**Stop point:** no bulk fetch, no ingestion, no ledger regeneration until the owner approves the allowed-source list, the rules and the cohort.
