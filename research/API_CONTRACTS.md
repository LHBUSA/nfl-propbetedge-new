# QB DNA API contracts

Four endpoints, all deterministic, all read-only, none touching production.
Implemented in `api/qb-dna.js`, `api/qb-dna/prop-history.js`,
`api/qb-dna/compare.js`, `api/qb-dna/game-context.js`, over the shared engine in
`api/_qbdna/engine.js` and the season gate in `api/_qbdna/gating.js`.

The prototype serves from `data/dist/qb-dna-dataset.json` (1.39 MB, 3,522
qb-games, 78 quarterbacks, seasons 2019–2024). In production the same functions
read `nfl_qb_game_metrics`; the row shape is identical, which is why the engine
is source-agnostic. **The API computes; it does not serve canned answers.**

## Rules enforced in code, and tested

| rule | where | test |
|---|---|---|
| a stable id always beats a name | `resolvePlayer()` | *a stable id match is never overridden by a name* |
| GSIS outranks ESPN when both are given | `resolvePlayer()` | *a GSIS id outranks an ESPN id* |
| an unknown stable id fails closed | `resolvePlayer()` | *fails closed rather than falling back to a name* |
| names match exactly or not at all | `resolvePlayer()` | *name matching is exact only, never fuzzy* |
| a zero denominator is never 0% | `rate()` / `ratio()` | *a zero denominator is never reported as 0%* |
| every rate carries numerator + denominator | `baseline()` | *every rate carries numerator and denominator* |
| roofed games never enter a weather split | `isOutdoorResolved()` | *a roofed game can never enter an outdoor weather split* |
| an empty window is unavailable, not zero | `splitRows()` | *a split with no games reports unavailable, not zero* |
| thin advanced coverage is withheld | `gate()` | *a thinly covered field is WITHHELD* |
| identical requests are byte-identical | all | *the same request returns byte-identical output* |

48 tests, all passing: `node --test research/qbdna/qbdna.test.mjs`

---

## `GET /api/qb-dna`

Baseline, form windows, recent game log, the full condition matrix, the served-
field manifest and the advanced-field gate.

**Identification** — exactly one is required, in this precedence:

| param | notes |
|---|---|
| `player_id` / `gsis_id` | the spine. preferred. |
| `espn_id` | a **live** athlete id, e.g. from a boxscore. Resolves deterministically to a GSIS identity. |
| `name` | exact match only. An ambiguous name returns 404 with `candidates[]`. |

**Options** — `season` (restricts the whole response), `metric`
(`passing_yards` default; `passing_attempts`, `completions`,
`passing_touchdowns`, `interceptions`), `list=1` (the quarterback index).

**Response shape**

```jsonc
{
  "player": { "gsis_id", "espn_id", "pfr_id", "name", "current_team",
              "matched_by": "gsis_id | espn_id | exact_name" },
  "window":  { "seasons": [...], "games", "date_range": [from, to] },
  "baseline": {
    "games", "wins", "losses", "games_with_result",
    "completion_pct": { "numerator", "denominator", "pct" },
    "ypa":            { "numerator", "denominator", "value", "unit": "yards per attempt" },
    "passing_yards":  { "n","mean","median","std","min","max","p25","p75" },
    "td_rate", "int_rate", "sack_rate",     // all {numerator,denominator,pct}
    "sample_label": "STRONG SAMPLE"
  },
  "current_season": {...}, "recent": { "last_5", "last_10" },
  "game_log": [ { ..., "environment_status": "ok | skipped_indoor | ..." } ],
  "conditions": { "<key>": { "available", "label", "games",
                             "passing_yards_avg", "baseline_delta_pct",
                             "sample_label", "coverage": { "note" } } },
  "served_fields": { "<field>": "<source>" },
  "advanced_availability": { "policy", "by_field", "unavailable_fields" },
  "provenance": { "sources", "field_availability_by_season", "notes" }
}
```

Note `ypa` carries `value`, not `pct` — it is a ratio in yards, not a
percentage. That distinction is a regression test.

**19 condition keys**: `home`, `road`, `dome`, `outdoor`, `below_freezing`,
`cold_33_50`, `mild_51_70`, `warm_70_plus`, `snow`, `rain`, `dry`,
`wind_10_plus`, `wind_15_plus`, `wind_20_plus`, `primetime`, `divisional`,
`playoffs`, `favorite`, `underdog`.

The eleven weather-dependent keys apply **only** to open-air games whose
environment row resolved. Each returns a `coverage` block naming how many
outdoor games were excluded and why.

---

## `GET /api/qb-dna/prop-history`

How often a number has actually been cleared. It counts; it does not price.

`player_id` · `market` · `line` (required) · `condition` · `season`

```jsonc
{
  "full_history": { "total", "over", "under", "push", "over_pct",
                    "mean", "median",
                    "statement": "56/114 over 274.5 = 49.1%",
                    "sample_label": "STRONG SAMPLE" },
  "windowed": { "condition", "condition_label", ... } | { "available": false, "reason" },
  "game_log": [ { "value", "outcome": "OVER|UNDER|PUSH", ... } ],
  "disclosure": { "statement", "sample_label", "caveat" }
}
```

`over + under + push === total`, always — asserted. A whole-number line produces
real pushes and they are never folded into overs. A condition window with no
games returns `available: false` with a reason; it never returns 0%.

---

## `GET /api/qb-dna/compare`

**`mode=players`** — `player_a` · `player_b`

Baselines side by side, the full condition matrix for both (each also shown
against **his own** baseline), and `head_to_head`: the real intersection of game
ids, so it lists games both quarterbacks actually played in. Two who never met
return `available: false`, never 0-0.

**`mode=context`** — `player_id` plus any of `roof`, `temp_f`, `wind_mph`,
`precip`, `home`, `opponent`, `primetime`, `divisional`

Today's conditions against that quarterback's own history. Returns
`matched_windows` (which historical windows this game falls into),
`unevaluated` (**what could not be assessed, and why** — a context field we were
not given produces no window rather than a guess), per-window movement from his
own baseline, and `vs_opponent`.

A roofed game matches **no** weather window; `unevaluated` says so explicitly.

Each window carries the sentence the UI is allowed to print:

```
245.0 avg vs 282.6 baseline · -13.3% · N=3 · VERY SMALL SAMPLE
```

Never "struggles in snow".

---

## `GET /api/qb-dna/game-context`

The bridge from a live schedule to the historical splits. No args returns the
real upcoming slate from ESPN's public scoreboard. With `event_id` it resolves
the venue **from our own venue table**, fetches an Open-Meteo forecast for the
venue's local kickoff hour **only for an open-air venue**, and returns the exact
query string to pass to `compare`.

Three behaviours worth stating:

* a **roofed** venue fetches no forecast and infers no conditions
* a **neutral-site** game refuses to apply the home team's venue at all
* the forecast is mapped onto the historical flags by the *same rule* the
  history uses — rain/snow are accumulation > 0 — so trace drizzle with zero
  accumulation is not counted as rain

---

## Season gating

`gate(season, field)` reads measured coverage. It never infers availability from
a column's existence.

| status | coverage | served |
|---|---|---|
| `AVAILABLE` | ≥ 90% | not yet — this prototype has not aggregated these fields |
| `INTERNAL_ONLY` | 50–90% | never |
| `WITHHELD` | < 50%, including 0% | never |
| `NOT_PUBLISHED` | source published nothing (NULL) | never |

Measured, from the warehouse:

| field | 2019–2022 | 2023 | 2024 |
|---|---|---|---|
| `offense_personnel` / `defense_personnel` | ~76% | 100% | not published |
| `defenders_in_box` | ~74% | 100% | not published |
| `number_of_pass_rushers` | ~43% | 97.2% | not published |
| `was_pressure` | ~38% | 100% | not published |
| `ngs_air_yards` | ~37% | **0%** | not published |
| `route`, `defense_coverage_type` | ~37% | ~42–50% | not published |

`NOT_PUBLISHED` is not zero coverage, and the DDL enforces that distinction.

## Sample labels

`N ≥ 20` STRONG · `10–19` MODERATE · `5–9` SMALL · `< 5` VERY SMALL

**These are product labels describing SIZE. They are not claims of statistical
significance**, and the copy never upgrades them into one. Every response repeats
that sentence in `provenance.notes`.
