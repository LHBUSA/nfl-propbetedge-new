# Participation-derived reconciliation — what we would derive, and the ShareAlike question

**Status:** DOCUMENTATION ONLY · 2026-09-15 · for owner/counsel decision.
No source was downloaded for this document. Nothing was derived into production. `career-ledger.json`
is unchanged and labels are unchanged. **No participation-based output may be exposed or
redistributed until this is decided.** Not legal advice.

Companion to [SOURCE_RIGHTS_AND_RECONCILIATION_AUDIT.md](SOURCE_RIGHTS_AND_RECONCILIATION_AUDIT.md).
The existing ESPN production dependency is a **separate** risk item:
[docs/risk/ESPN_PRODUCTION_DEPENDENCY.md](../risk/ESPN_PRODUCTION_DEPENDENCY.md). It is deliberately not mixed in here.

Numbers reproduce with `python scripts/career-ledger/participation_period_projection.py --schedule <games.csv> --out <dir>`
(read-only; locally held files only).

## 0. Owner decisions on record (2026-09-15)

| Item | Decision |
|---|---|
| Reconciliation rules R1–R11, 40-player cohort | Approved for **technical validation** only |
| `snap_counts` (PFR) | **Rejected**: do not use unless explicit rights are obtained |
| ESPN Core event logs | **Rejected** |
| `stats_player_week` | **Hold**: review required |
| `pbp_participation` | **Hold**: review required, specifically CC-BY-SA / ShareAlike for a commercial derived Career Ledger |
| nflverse player id columns | Approved for **internal identity reconciliation only** |
| schedule id columns | Approved for **internal game-id reconciliation only** |

---

## 1. Exactly what PropBetEdge would read and derive

### 1.1 Read from the source (and nothing else)

| File | Columns read | Columns never read |
|---|---|---|
| `pbp_participation_{season}` | `nflverse_game_id`, `players_on_play` | `play_id`, `old_game_id`, `possession_team`, `offense_formation`, `offense_personnel`, `defenders_in_box`, `defense_personnel`, `number_of_pass_rushers`, `offense_players`, `defense_players`, `n_offense`, `n_defense`, `ngs_air_yards`, `time_to_throw`, `was_pressure`, `route`, `defense_man_zone_type`, `defense_coverage_type`, `offense_names`, `defense_names`, `offense_positions`, `defense_positions`, `offense_numbers`, `defense_numbers` |
| `players` (approved id columns) | `gsis_id`, `espn_id`, `nfl_id` | every attribute column |
| schedule (approved id columns) | `game_id`, `season`, `game_type`, `week`, `away_team`, `home_team`, `espn` | scores, lines, odds, venue, coaches, QBs, referee |

`players_on_play` holds player ids per play (GSIS from 2023; NFL numeric ids for 2016–2022, mapped through `players.nfl_id` only).

### 1.2 Intermediate (in memory, never persisted, never served)
A set of `(gsis_id, nflverse game_id)` pairs meaning "this player was on the field for at least one play of this game". It is built only for **ledger-scope players** (the 1,203 DNA players) and only for their **failing seasons**. It is discarded after the run.

### 1.3 Candidate derived outputs (per the approved rules)

| # | Output | Rule | What it states | Contains source data? | Volume if applied (projection) |
|---|---|---|---|---|---|
| D1 | `appeared` for a (player, game) the ESPN game log lacks | R3/R4 | one boolean fact per player-game: *he played in this game* | A **game-level aggregate** of the id list. No play ids, play order, play count, names, positions, numbers, formation, personnel, routes or coverage | NGS 2016–22: **1,055** games · FTN 2023+: **13** games |
| D2 | zero-stat game row added to the ledger | R4 | event id, date, team, opponent (from ESPN/schedule ids); stats recorded as zero **because no stat exists in the stat sources**, not from participation | The row's **existence** is D1. Every other field is ESPN or schedule id data | same games as D1 |
| D3 | `did_not_play` flag on an ESPN row with all-zero stats and no participation | R5 | *he did not play in this listed game* | absence-derived boolean | NGS: **41** rows · FTN: **56** rows (upper bounds) |
| D4 | season proven 0-game | R6 | *no appearance in any team game this season* | one boolean per player-season | entire-season + pre-debut cases: NGS **311** · FTN **171** (upper bounds; measured shares in §4) |
| D5 | season appearance count equals the logged count | R7 | a count used only to accept ESPN's rows | a count per player-season | row-missing cases: NGS **60** · FTN **58** |
| D6 | label change TRACKED → CAREER, and games totals | R9 | aggregate over a player's seasons | aggregates of D1–D5 | see §4 player reach |
| D7 | provenance on each derived value | R9/R11 | `source`, `rule`, attribution string | **Must stay non-reproductive.** Recommend `evidence: "appearance in participation data"` only. **Never** play ids, snap or play counts, or on-field lists | per derived value |

**Answer to "reproduce or only reconcile?"** As designed, the output is **boolean and count reconciliation only** (D1, D3, D4, D5, D6), plus ledger rows whose non-boolean fields come from ESPN or schedule ids (D2).
- **Scale:** one season of the source has ~46–50k plays and **~1.0 million player-play id slots** in 20–26 columns (measured: 2020 = 975,877, 2023 = 1,015,592). Across all seasons the derived facts total roughly **1,068 player-games plus a few hundred season-level booleans**.
- **What it does not carry:** no play-level record, no selection or arrangement of the source, none of its descriptive columns.
- **What it still is:** each D1 fact comes from the source. A "played in game X" boolean is information obtained from that dataset, even though it is a fact.

**Design constraints (if ever approved):**
- no play counts
- no per-play evidence
- nothing from the "never read" columns
- participation-derived values kept **segregated** and tagged by period (NGS vs FTN)

---

## 2. What CC-BY-SA 4.0 actually requires (quoted from the legal code)

Key definitions (creativecommons.org/licenses/by-sa/4.0/legalcode):
- **Licensed Rights:** *"limited to all Copyright and Similar Rights that apply to Your use of the Licensed Material and that the Licensor has authority to license."*
- **Adapted Material:** material *"derived from or based upon the Licensed Material and in which the Licensed Material is translated, altered, arranged, transformed, or otherwise modified **in a manner requiring permission under the Copyright and Similar Rights held by the Licensor**."*
- **Copyright and Similar Rights** include **Sui Generis Database Rights**: *"rights … resulting from Directive 96/9/EC … as well as other essentially equivalent rights anywhere in the world."*
- **Share:** *"to provide material to the public by any means or process **that requires permission under the Licensed Rights**."*
- **§8(a):** the licence does not *"reduce, limit, restrict, or impose conditions on any use of the Licensed Material that could lawfully be made without permission under this Public License."*

### 2.1 When obligations attach

| Situation | Obligation |
|---|---|
| Internal use only (compute, never share) | None under the licence. Attribution and ShareAlike attach to **Sharing** |
| Sharing the Licensed Material itself, or a use requiring permission | **§3(a) Attribution** (below) |
| Sharing **Adapted Material** we produce | §3(a) **plus §3(b) ShareAlike** |
| We include "all or a substantial portion" of a database's contents in **our** database where **Sui Generis Database Rights** apply | **§4(b):** our database (not its individual contents) *"is Adapted Material, including for purposes of Section 3(b)"*; **§4(c)** attribution if we share that portion |

### 2.2 Minimum obligations if they attach

**§3(a) Attribution** (when Sharing, in any reasonable manner for the medium, e.g. a linked credits page):
1. retain the creator/attribution-party identification the licensor supplied. nflverse asks for **"FTN Data via nflverse"** (2023+) or **"NFL NextGenStats via nflverse"** (2016–2022)
2. a copyright notice, **if supplied** (none is supplied with the release)
3. a notice referring to the licence
4. a notice referring to the disclaimer of warranties
5. a URI or hyperlink to the Licensed Material, to the extent reasonably practicable
6. indicate that we modified it, and retain any previous modification notices
7. state that it is CC-BY-SA 4.0, with the licence text or its URI

**§3(b) ShareAlike** (only when Sharing **Adapted Material**):
1. license our contributions to that Adapted Material under **CC BY-SA 4.0 or later, or a BY-SA-compatible licence**
2. include the text or URI of that licence
3. **no additional terms, conditions or Effective Technological Measures that restrict the rights granted under that licence**

**§2(a)(5)(c):** no downstream restrictions on the Licensed Material itself.

### 2.3 Why this matters for a commercial Career Ledger (issues for counsel)
1. **Is the reconciliation output "Adapted Material" at all?** In the US, the facts (who played in which game) are not copyrightable, and the output reproduces no selection or arrangement. If no permission under copyright is needed, it arguably is not Adapted Material, and under §8(a) ShareAlike would not attach. **Counsel to confirm.**
2. **Sui Generis Database Rights.** If a licensor (FTN; for NGS, whoever holds rights in that database) holds EU-style database rights, and our extraction is a "substantial portion" (qualitatively or quantitatively), §4(b) makes our database Adapted Material. Unresolved: whether those rights exist for either licensor, whether ~1,068 player-game facts from ~1M slots per season are "substantial", and PropBetEdge's jurisdictional exposure (EU users).
3. **Mixed-source incompatibility.** If the Career Ledger database became Adapted Material, ShareAlike would require offering it under BY-SA with no restricting terms. The ledger is predominantly ESPN-derived data we cannot license under BY-SA, and the product is paywalled with its own terms. **A combined database cannot satisfy ShareAlike.** If counsel finds ShareAlike attaches, participation-derived values must stay a **separately licensed, separately served, attributed layer**, or not be used.
4. **Paywall / terms vs §3(b)(3).** Charging for access is not itself prohibited. But a term forbidding subscribers from redistributing BY-SA Adapted Material would be an "additional term restricting" the licence's rights.
5. **NGS-era chain of rights (2016–2022)** is a separate question from ShareAlike: the release labels NFL Next Gen Stats data CC-BY-SA, but the NFL's grant is not documented (see the rights audit). FTN 2023+ is documented: nflreadr's changelog says *"FTNData.com has graciously offered to provide participation data … licensed under CC-BY-SA 4.0 and should be credited … to FTN Data via nflverse."*

### 2.4 Lowest-exposure options (ranked, none chosen)
| Option | What is exposed | ShareAlike exposure | Coverage kept |
|---|---|---|---|
| A. Do not use participation | nothing | none | none |
| B. **Internal validation signal only**: participation never changes served data. It only produces an internal report or queues cases for manual review against a licensed or approved source | nothing derived is served | lowest (no Sharing) | none in product; operational value only |
| C. **Segregated, attributed BY-SA "appearance layer"** (D1/D3/D4/D5 only, FTN 2023+ first), served separately from the ESPN-derived ledger, with credits and licence URI, no restricting terms on that layer | booleans and counts, attributed | accepted and scoped to the layer | per period (§4) |
| D. Merge into the ledger as designed | booleans affect labels and totals | **highest; likely incompatible** (§2.3.3) | full |

---

## 3. The two periods are different sources

| | **NGS-origin 2016–2022** | **FTN-origin 2023+** |
|---|---|---|
| Upstream | NFL Next Gen Stats, distributed by nflverse | FTN Data, provided to nflverse after each season |
| Stated licence | CC-BY-SA 4.0 (nflreadr `load_participation`) | CC-BY-SA 4.0 (nflreadr docs + changelog grant) |
| Required credit | **"NFL NextGenStats via nflverse"** | **"FTN Data via nflverse"** |
| Chain of rights | **Unresolved**: no documented NFL grant; NFL terms restrict systematic retrieval and commercial use | **Documented** licensor grant (FTN) |
| Player id in file | NFL numeric id → `players.nfl_id` → GSIS | GSIS |
| Seasons held locally | 2019–2022 (2016–2018 **not held**) | 2023 (2024–2025 **not held**) |
| Published availability | 2016–2022 | 2023–2025, released after each postseason |
| False negatives measured on CAREER players | 29 of 9,330 logged games missed, **all zero-stat rows**; **0** with stats | 2 of 3,550, **both zero-stat**; **0** with stats |

---

## 4. Coverage gained per period (no player upgraded)

Scope: 696 TRACKED players. 524 have 1,266 named failing seasons. 172 have no ESPN history, of whom 114 are 2026 rookies with no prior season (nothing for participation to reconcile) and 1 has a suspect ESPN id (Chris Manhertz).

### 4.1 Failing seasons in each period

| Case | NGS 2016–22 | FTN 2023+ | Outside participation (pre-2016) |
|---|---|---|---|
| ESPN under-count (missing games) | **452** (1,055 games) | **7** (13 games) | 20 (25 games) |
| ESPN over-count (extra rows) | **26** (41 rows) | **29** (56 rows) | 12 (22 rows) |
| Entire season missing | **278** | **121** | 76 |
| Pre-debut roster season | **33** | **50** | 40 |
| Game log without season row | **60** | **58** | 4 |
| **Total** | **849** | **265** | **152** |

### 4.2 Measured on locally held seasons (NGS 2019–22, FTN 2023)

| Case | NGS (held/in period) | NGS result | FTN (held/in period) | FTN result |
|---|---|---|---|---|
| Under-count | 367 / 452 | **367 / 367** missing games all explained | 1 / 7 | 1 / 1 |
| Over-count | 24 / 26 | **16 / 24** extra rows shown not played | 11 / 29 | **10 / 11** |
| Entire season missing | 175 / 278 | **117** proven 0-game · 58 appeared (need a stat source) | 40 / 121 | **35** proven 0-game · 5 appeared |
| Pre-debut roster season | 30 / 33 | **24** proven no appearance · 6 appeared | 27 / 50 | **20** proven · 7 appeared |
| Game log without season row | 46 / 60 | **38** appearance count equals the log | 21 / 58 | **21 / 21** equal |

"Appeared" seasons still need an approved **stat** source (`stats_player_week` is on hold) before they could become CAREER.

### 4.3 Players

| | NGS only | FTN only | NGS + FTN |
|---|---|---|---|
| Players with ≥1 failing season in the period | **413** | **191** | — |
| Players whose **every** failing season is in reach (upper bound) | **284** | **95** | **461** |

Reading this:
- **FTN-only** (documented grant) reaches at most **95 players**, and only 2023 is measured locally.
- **NGS** carries most of the value (the 1,055 missing games of under-counts) and also the unresolved chain of rights.
- Neither period reaches the **152 pre-2016 failing seasons**.
- Upper bounds shrink when an "appeared" season needs stats, when an over-count stays unexplained, or on identity edge cases.

---

## 5. Questions for owner / counsel

1. Does game-level appearance reconciliation (booleans/counts only, §1.3) require permission under copyright or Sui Generis Database Rights held by FTN or by the NGS-era licensor? If not, does §8(a) mean neither attribution nor ShareAlike attaches?
2. If database rights may apply, is ~1,068 player-game facts plus season booleans a "substantial portion"?
3. Is option **C** (segregated, attributed BY-SA appearance layer) acceptable commercially, including how the paywall and terms interact with §3(b)(3)?
4. Is the NGS-era (2016–2022) chain of rights acceptable at all, given the undocumented NFL grant?
5. If only FTN 2023+ is approved: may we fetch the 2024–2025 FTN files for measurement (not yet approved)?
6. Regardless of 1–4: publish the required credit strings on the Career Ledger sources line whenever any participation-derived value is served.

**Stop point:** no download, no derivation into production, no exposure until decided.
