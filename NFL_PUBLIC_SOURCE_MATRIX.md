# NFL public / free source matrix

Branch `prototype/nfl-data-harvest`, cut from the **actual production commit
`2360156`** (verified from the Vercel deployment with `target: production`, not
from `main`, which is still behind at `dc60e60`). Isolated git worktree at
`C:/Workers/nfl-data-harvest`. `prototype/arcade-replay` untouched. No production
writes, no purchases, no vendor contact, no credentialed or paywalled endpoint,
no CAPTCHA or auth bypass.

Everything below was **probed live on 2026-09-05**, not assumed.

| SOURCE | DATA | LIVE / HIST | STRUCTURED | UPDATE RATE | IDENTIFIERS | LICENCE / TERMS | PROD SAFE? | NOTES |
|---|---|---|---|---|---|---|---|---|
| **ESPN** `cdn.espn.com/core/nfl/playbyplay` | drives, plays, field state, scores | **LIVE** | JSON | poll; wallclock per play | ESPN game id, ESPN team id | Public endpoint, no key. No published redistribution licence — treat as *display of factual game state*. | ⚠️ already in use in prod | What we ship today. 20-odd structured play fields, **no athlete participants** |
| **ESPN** `cdn.espn.com/core/nfl/game` | + `gameInfo`, `leaders`, `pickcenter`, `boxscore.players` | **LIVE** | JSON | poll | ESPN athlete id + **guid** | as above | ⚠️ | **Richer than the endpoint we call.** Per-player game stats in 10 groups, officials, attendance, venue `grass`/`indoor` |
| **ESPN** `site.api.espn.com/.../teams/{id}` | team + home venue: city, state, zip, country, `grass`, `indoor`, venue id + guid | HISTORICAL (static) | JSON | rare | ESPN team id, ESPN venue id | as above | ✅ | **32/32 venues resolved.** This is our venue spine |
| **nflverse** `play_by_play_{yr}` | 372 columns of play detail | **HISTORICAL** | parquet | ~daily in season | **GSIS** game/player id | **CC-BY-4.0** — commercial use permitted with attribution | ✅ | The single biggest win. See below |
| **nflverse** `pbp_participation_{yr}` | all 22 players on field, formation, personnel, box count, pass rushers, route, coverage | HISTORICAL | parquet | ~daily | GSIS | CC-BY-4.0 | ✅ | Coverage varies **sharply** by season — see the gate table |
| **nflverse** `nextgen_stats/ngs_*` | time to throw, intended air yards, aggressiveness, **CPOE**, xCOMP, air yards to sticks | HISTORICAL | parquet | weekly | **`player_gsis_id`** | CC-BY-4.0 | ✅ | Lawful NGS **aggregates** without touching nfl.com |
| **nflverse** `ftn_charting_{yr}` | play action, screen, RPO, motion, out of pocket, **n_blitzers**, **n_pass_rushers**, throwaway, drop, QB-fault sack | HISTORICAL | parquet | weekly | nflverse play id | CC-BY-4.0 | ✅ | Manual charting. 2022+ only |
| **nflverse** `players`, `rosters`, `depth_charts`, `injuries`, `snap_counts` | identity crosswalk, weekly status | HISTORICAL | parquet | weekly | GSIS + ESPN + PFR + Sleeper + others | CC-BY-4.0 | ✅ | The ID spine |
| **Open-Meteo Archive** `archive-api.open-meteo.com` | hourly temp, apparent, humidity, rain, snow, wind, gust, weather code | HISTORICAL | JSON | static history | lat/lon + timestamp | Free, **no key**; CC-BY-4.0 for the data | ✅ | Our weather reconstruction |
| **Open-Meteo Geocoding** | place → lat/lon | static | JSON | — | — | as above | ✅ | Place-based only — **stadium names do not resolve**, cities do |
| **nfl.com** `api.nfl.com/v1/...` | shield API | — | — | — | — | **HTTP 401** | ❌ | Requires credentials. Out of bounds |
| **NGS** `appapi.ngs.nfl.com/statboard/*` | NGS statboard | — | JSON | — | — | TLS certificate did not validate from here | ❌ | **Not pursued.** Using it would mean disabling certificate verification, which is circumventing a security control. nflverse redistributes the same aggregates under CC-BY-4.0 |
| **NFL Big Data Bowl** (Kaggle) | player + ball x/y, speed, acceleration, orientation, direction, frame events | HISTORICAL | csv | annual | NFL ids | **"Participation does not grant any license or right of ownership in the NGS Data… keep strictly confidential and not transmit, duplicate, publish, redistribute"** | ❌ **NOT USABLE** | **I did not download it.** See §Tracking below |

---

## What nflverse actually gives us — measured, not assumed

`play_by_play_2023.parquet`: **49,665 plays × 372 columns**.

Present and verified on the real file:

* **Structured participants with GSIS ids** — passer, receiver, rusher, interceptor, sack, half-sack, forced-fumble, fumbled-by, fumble-recovery, tackle-for-loss, solo tackle 1/2, assist tackle, punt/kickoff returner, plus every lateral variant.
* **Pass detail** — `air_yards`, `yards_after_catch`, `pass_length`, `pass_location`, `qb_dropback`, `qb_scramble`, `qb_kneel`, `qb_spike`, `shotgun`, `no_huddle`, `qb_hit`.
* **Rush detail** — `run_location`, `run_gap`.
* **Advanced** — `epa`, `qb_epa`, `wp`, `wpa`, `cp`, `xyac_epa`, `success`, `series_result`.
* **Environment already in PBP** — `roof`, `surface`, `temp`, `wind`, `weather`, `stadium_id`, `div_game`, `spread_line`, `total_line`.
* **Penalties** — `penalty_team`, `penalty_player_id`, `penalty_yards`, `penalty_type`.

Against the ~20 structured fields ESPN gives per play, this is a different
category of data.

### The gate: participation coverage is NOT uniform

Share of participation rows where the column is populated:

| season | rows | formation | personnel | box | pass rushers | ngs_air_yards | time_to_throw | was_pressure | route |
|---|---|---|---|---|---|---|---|---|---|
| 2019 | 48,034 | 73.1% | 76.1% | 74.2% | 43.3% | 37.1% | 38.5% | 38.5% | 37.0% |
| 2020 | 48,513 | 73.1% | 76.1% | 74.4% | 43.5% | 37.6% | 39.0% | 39.0% | 37.5% |
| 2021 | 50,714 | 73.0% | 76.2% | 74.4% | 43.3% | 37.4% | 38.6% | 38.6% | 37.3% |
| 2022 | 50,150 | 73.4% | 76.2% | 74.4% | 42.7% | 36.3% | 37.8% | 37.8% | 36.2% |
| 2023 | 46,168 | 80.1% | **100.0%** | **100.0%** | **97.2%** | **0.0%** | 44.0% | **100.0%** | 42.5% |

**`ngs_air_yards` is 0.0% in 2023** — the column exists and is empty. Any split
built on it must be unavailable for 2023, not zero. 2024 participation is not
published at all. This is exactly the "do not present a metric for seasons where
the source is unavailable" rule, and it has to be enforced per season per column.

---

## Live vs historical — the honest split

**LIVE, from public sources, today:** exact field state, down/distance, play type,
scores, drives, published play text, per-player *cumulative game* stats and
officials/venue/attendance from the ESPN game endpoint.

**HISTORICAL only:** every structured participant id, air yards, YAC, EPA/CPOE,
formation, personnel, box count, pass rushers, route, coverage, time to throw.
nflverse publishes these on a **daily-to-weekly** cadence — hours to days after a
game, not during it.

**Genuinely impossible from public sources:** live 10 Hz player/ball tracking.
The only public NFL tracking corpus is Big Data Bowl, and its terms forbid
redistribution and grant no licence.

---

## Tracking — why there is no Big Data Bowl adapter here

The brief allowed a research adapter "if legally usable". It is not. The
competition terms state participation "does not grant any license or right of
ownership in the NGS Data" and require each participant to "keep the data
strictly confidential and not transmit, duplicate, publish, redistribute, or
communicate the data to any other person or entity without prior written
consent". Building even a local adapter would mean accepting those terms and
holding the data inside a commercial codebase.

**I did not download it and did not build the adapter.** If you want a
gold-standard tracking comparison for Arcade, the route is a written licence
request to the NFL, not a competition download.

Sources:
- [nflverse-data (CC-BY-4.0)](https://github.com/nflverse/nflverse-data)
- [NFL Big Data Bowl terms and conditions](https://operations.nfl.com/gameday/analytics/big-data-bowl/terms-and-conditions/)
- [NFL Big Data Bowl 2023 rules](https://www.kaggle.com/competitions/nfl-big-data-bowl-2023/rules)
