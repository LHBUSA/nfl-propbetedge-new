# Open-Meteo — production dependency and replacement status

Measured 2026-09-18. Open-Meteo's terms describe the free tier as non-commercial
(https://open-meteo.com/en/terms); PropBetEdge is a paid product. This is the
map of where it is used, what changes when it is switched off, and what replacing
it requires. **No workaround was invented.** The provider is now a policy
decision in one place: `api/_weather/provider.mjs`.

## The switch

| Setting | Effect |
|---|---|
| `PBE_WEATHER_DISABLED=1` | no forecast request is made anywhere; every surface reports weather as unresolved |
| `PBE_WEATHER_PROVIDER=<id>` | selects a provider; unknown or unimplemented ids **fail closed**, they never fall back to Open-Meteo |
| unset (today) | `open_meteo`, i.e. current behaviour, unchanged |

Vercel functions read `process.env`. A Cloudflare Worker has no `process.env`, so
`workers/nfl-intel/src/weather.js` calls `setWeatherPolicy(env)` before taking any
snapshot. One decision, both runtimes.

Proven by `tests/nfl-weather-provider.test.mjs`: when disabled, **zero** requests
reach the provider, `window`/`bands`/`source_url` stay null, the reason is stated,
and NWS alerts still work because they are a different provider.

## Where it is used

| # | Consumer | Endpoint | Stored? | Surface |
|---|---|---|---|---|
| 1 | `api/_breaking/weather.js` (shared core) → `/api/weather-watch` → PBE BREAKING rail | `api.open-meteo.com/v1/forecast`, kickoff −1h…+3h | edge cache 300s only | public |
| 2 | `workers/nfl-intel` weather lane → `/api/game-weather`, `/api/changes` | same, per open game within 8 days | **KV** `wx:v1:snapshot` (30 min refresh) | public |
| 3 | `nfl-game-context-v1.js` → games board + PBEcast hero | reads `/api/game-weather` | client memo | public |
| 4 | `api/qb-dna/game-context.js` → Player DNA next game (QB/RB/TE/WR) | same API, single kickoff hour | edge cache 120s | public |
| 5 | `api/qb-dna/compare.js` | consumes #4's `temp_f/wind_mph/precip` to pick historical context windows | — | public |
| 6 | `workers/nfl-game-picks-orchestrator` `weatherFor()` | own client, `forecast_days=8` | **Supabase** `nfl_game_picks.features` (`wind15`, `cold25`) | Pro |
| 7 | `research/ingest/weather.py` (archive API) | historical rebuild | **parquet** `nfl_game_environment`, then baked into `data/dist/*-dna-dataset.json` (`tf/wd/sn/rn/ws`) | public via DNA splits |
| 8 | `research/ingest/venues.py` (geocoding API) | built `data/dist/nfl-venues.json` lat/lon | committed JSON | public |

Consumers #1–#5 now route through the provider policy. #6 is the picks engine and
is handled with the rest of the feature-integrity work (it also fabricated
`wind15:false` when the forecast was missing). #7 and #8 are build-time only: they
are not needed to disable the provider at runtime, only to rebuild history.

## What degrades when it is off

| Feature | Degrades to |
|---|---|
| PBE BREAKING weather rail | no weather events; **NWS alerts still fire** |
| Games board / PBEcast context | "Local forecast unavailable"; venue, roof and broadcast unaffected |
| `/api/game-weather`, `/api/changes` | `available:false` with a stated reason |
| Player DNA "today's game" env strip | the one visible loss; the rest of Player DNA is unaffected |
| Player DNA context-matched splits | temperature/wind/precip windows are skipped with a reason; home/road, roof, primetime, divisional splits unchanged |
| Historical DNA weather splits | **unaffected** — already baked in; they only stop growing |

## Replacing it

Registered in `api/_weather/provider.mjs` with licence and terms, each needing a
URL builder and a normalizer into the same hourly shape:

| Provider | Licence | Commercial use | Fit |
|---|---|---|---|
| NOAA NCEI ISD / GHCNh | public domain (17 U.S.C. §105) | clear | US venues; nearest-station hourly observation |
| Copernicus ERA5 | CC-BY | clear | anywhere, incl. international games; label as reanalysis, not observation |
| Meteostat | CC-BY 4.0 | clear | easier API; non-US rows may inherit WMO Res 40 limits |
| Open-Meteo paid plan | commercial terms | licensed | no code change at all |

**Owner decision needed:** buy the Open-Meteo plan, or implement NOAA + ERA5.
Note that the historical weather already inside the DNA datasets came from the
Open-Meteo archive and keeps its CC-BY attribution either way — switching the
live provider does not retract it, and that is a separate question.
