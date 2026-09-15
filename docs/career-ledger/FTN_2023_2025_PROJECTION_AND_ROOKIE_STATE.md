# FTN 2023–2025 coverage projection, and a truthful state for 2026 rookies

**Status:** measurement and proposal only · 2026-09-15.
Career Ledger production is **frozen**: no participation-derived value entered `career-ledger.json`, no label changed, no BY-SA layer exists. Not legal advice.

## Owner decisions applied
- 2016–22 NGS-origin participation: **not approved for production use** (and not read for this projection)
- 2023+ FTN-origin participation: **approved for read-only coverage measurement only**
- no participation-derived values in `career-ledger.json`; no public or shareable BY-SA layer
- no assumption that factual derivation avoids ShareAlike (a counsel question)

## 1. What was fetched, and how

| Season | Origin | Transferred | Kept locally | Columns |
|---|---|---|---|---|
| 2023 | FTN | already held | `data/nflverse/pbp_participation_2023.parquet` (only two columns are read) | — |
| 2024 | FTN | **1,221,460 of 4,644,767 bytes** (HTTP Range: footer + two column chunks) | `data/nflverse/pbp_participation_2024_min.parquet` + `.provenance.json` | `nflverse_game_id`, `players_on_play` |
| 2025 | FTN | **1,250,928 of 4,741,443 bytes** | `data/nflverse/pbp_participation_2025_min.parquet` + `.provenance.json` | same |

- `data/nflverse/` is gitignored (verified with `git check-ignore`).
- Each provenance note records **"FTN Data via nflverse", CC-BY-SA 4.0**, the source URL and "local read-only coverage measurement only".
- The fetch script (`scripts/career-ledger/fetch_ftn_participation_minimal.py`) refuses seasons before 2023 and refuses to fall back to a full download if the server ignores Range.
- Player ids in 2024 and 2025 are GSIS.

Reproduce: `python scripts/career-ledger/participation_period_projection.py --schedule <games.csv> --out <dir> --ftn-only` (reads FTN seasons only; writes aggregate counts only).

## 2. FTN-only projection (aggregate counts; no player-level output)

Scope: 696 TRACKED players, 524 with named failing seasons; **265 failing seasons fall in 2023–2025.**

| Case (2023–2025) | Seasons | Measured result (all three seasons held) |
|---|---|---|
| ESPN under-count | 7 (13 missing games) | **7 / 7** every missing game explained |
| ESPN over-count | 29 (56 extra rows) | **16 / 29** extra rows shown not played |
| Entire season missing | 121 | **112** proven no appearance · 9 appeared (need an approved stat source) |
| Pre-debut roster season | 50 | **36** proven no appearance · 14 appeared |
| Game log without a season row | 58 | **57 / 58** appearance count equals the log |

| Players | Count |
|---|---|
| with ≥1 failing season in 2023–2025 | 191 |
| whose **every** failing season is in 2023–2025 (theoretical reach) | **95** |
| whose every failing season is **resolved by measurement** | **75** |

The other 20 in reach stay unresolved: **8** have an over-count that participation does not explain, and **12** have a pre-debut roster season in which participation shows an appearance (that season would need an approved stat source). The 9 "entire season missing but appeared" seasons belong to players who are outside FTN-only reach for other reasons.

### FTN participation false negatives (known-played games of CAREER players)

| Season | Logged games checked | Missing, zero-stat row | **Missing, game with stats** |
|---|---|---|---|
| 2023 | 3,550 | 2 | 0 |
| 2024 | 4,107 | 2 | 0 |
| 2025 | 4,724 | 1 | **3** |

The three 2025 cases are games with fully populated on-field lists that omit a player who recorded stats. So **FTN 2025 has player-level omissions**, and absence does not prove non-appearance on its own. Rule consequences if participation is ever approved:
- R5 (did-not-play) must stay limited to **all-zero ESPN rows**
- R6 (0-game season) must require **absence from every team game**
- measured omission rates must be published alongside any projection

## 3. The 114 "2026 rookies with no prior season"

### What they are (read-only checks)

| Check | Result |
|---|---|
| Ledger games before 2026 | **0** for all 114 |
| ESPN athlete `debutYear` | null for all 114 |
| ESPN `displayExperience` | **"Rookie" 112** · "1st Season" 2 |
| ESPN draft string shows a 2026 draft | 49 (the rest undrafted) |
| ESPN season stat rows | 110 none · **4 with a 2026 row** (special teams / defense in Week 1) |
| FTN participation 2023–2025 appearances | **0 of 114** (measurement only; not a production signal) |
| 2026 roster audit `active_2026` | 114 |
| Positions | QB 17 · RB 18 · WR 51 · TE 28 |

What production shows today (frozen contract, verified on two players): `label: "TRACKED HISTORY"`, `coverage.complete: false`, `debut_season: null`, **`why_not_career: []`**. That is an empty reason, so the UI falls back to "Debut-to-today coverage is not proven." For a rookie who has already played (verified: one 2026 game), `career_span` is 2026–2026 with one game.

"TRACKED HISTORY" is not *false*, but it implies missing history where there is none to track.

### Does the existing contract support a ROOKIE state without weakening completeness?
**No, not as-is.**
- `player-career/v1` defines `label` as `CAREER` when `coverage.complete` and the current season are proven, otherwise `TRACKED HISTORY`.
- The frontend treats any label other than `CAREER` as tracked. A third label value is a contract change.
- Setting `CAREER` for rookies would weaken completeness. The current-season game log can itself miss zero-stat special-teams appearances (the same under-count pattern), so "debut to today is proven" does not automatically hold for a rookie with games.

**No label was changed.**

### Proposal (for approval): `player-career/v1.1`, additive

- **New label value** `ROOKIE`, displayed as **`ROOKIE · NO PRIOR NFL HISTORY`**.
- **New field** `history_state`: `CAREER` | `TRACKED_HISTORY` | `ROOKIE_NO_PRIOR_HISTORY`.
- **`coverage.complete` keeps its meaning unchanged:** it stays `false` for rookies. ROOKIE is a separate truthful state, not a proven career.
- **`why_not_career`** gets a real reason: `"no NFL season before <current season> (provider: Rookie)"`.

**ROOKIE is asserted only when all of these hold (fail closed otherwise):**
1. ESPN athlete `displayExperience === "Rookie"` (so the 2 "1st Season" players stay TRACKED)
2. ESPN `debutYear` is null or equals the current season
3. no ESPN season stat row before the current season
4. zero ledger games before the current season
5. the current-season game log is available
6. identity passes R1 (ESPN ↔ GSIS one-to-one)

**Presentation.**
- **No 2026 game yet:** `ROOKIE · NO PRIOR NFL HISTORY`, "No NFL game played yet", no totals rendered as zeros.
- **Has 2026 games:** `ROOKIE · NO PRIOR NFL HISTORY` with a "2026 only" span and the current-season rows. Keep the existing current-season caveat: special-teams-only appearances can be missing from the provider's position game log.

**Projected effect (not applied).**
- **112** of the 114 would read ROOKIE; the 2 "1st Season" players stay TRACKED.
- The remaining **58** of the 172 no-history players (non-rookies with no ESPN history, e.g. suspect ESPN ids) are unaffected and stay TRACKED.

**Inputs the proposal may use.** Only ESPN athlete fields and ledger rows already in the production pipeline, plus the approved identity columns. **Not** FTN participation (measurement only) and **not** nflverse `rookie_season` or draft fields: those are attribute columns, outside the "id columns only" approval.
- **Flag:** the existing (frozen) harvest already reads nflverse `rookie_season` / `last_season` for its coverage window, which predates the id-columns-only decision. Remediation is recorded here and not executed while the ledger is frozen.

**Work if approved** (a Career Ledger change; production is frozen until approved):
- `ledger-core.js` label/state
- `player-career-ledger-v1.js` rendering (eyebrow style for ROOKIE)
- tests: ROOKIE vs "1st Season" vs a played rookie vs a non-rookie with no history
- career-slate gate case
- deploy through main

## 4. Owner decisions requested
1. Approve `player-career/v1.1` ROOKIE state (additive, fail-closed criteria above)?
2. Participation remains measurement-only: confirm, pending counsel on ShareAlike.
3. Approve replacing the harvest's nflverse `rookie_season` / `last_season` use (attribute columns) when the ledger is next unfrozen?
