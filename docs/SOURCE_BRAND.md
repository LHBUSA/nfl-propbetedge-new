# Customer source brand (network standard, 2026-10-03)

Customer-facing data attribution is **DATA · PropSports**. Upstream collection lanes stay in
internal provenance (captures, Workers, logs, admin/debug, rights registry).

Kept on purpose: nflverse (CC BY 4.0), Open-Meteo (CC BY 4.0) and NWS credits; ESPN as a TV
broadcaster; ESPN BET as a sportsbook; owner-approved ESPN headshots/logos credited as images
(`source: 'ESPN'` on the media endpoints is an image credit).

## Deprecated compatibility fields (do not build on these)

| Field | Where | Replacement | Status |
|---|---|---|---|
| `source.provider` (`espn_site_*`, `espn_core_api_injuries`, …) | /api/nfl-live, nfl-current, nfl-intel, Career Ledger `sources` | `source.name` = `"PropSports"` | deprecated, compatibility-only; removed in a future versioned contract |
| `espn_id`, `espn_event_id`, `espn_athlete_id`, `espn_team_id`, `home_team_espn_id`/`away_team_espn_id`, `?espn_id=` | player, game, DNA, career, college path, media, TD game view, current-player | `player_id` / `game_id` / `team_id` (below) | deprecated, still accepted and returned; listed per response in `deprecated_fields` |

Guard: `scripts/guard-source-brand.mjs` (v2) runs in `npm test` / `npm run test:nfl` / `npm run guard`.

## Neutral identifiers (additive, 2026-10-03)

| Neutral field / param | Meaning | Values | Legacy kept (deprecated) |
|---|---|---|---|
| `player_id`, `?player_id=` | canonical NFL player id | gsis, e.g. `00-0033873` — the id the DNA endpoints already accepted as `?player_id=`. Added only when the crosswalk (`data/dist/player-id-crosswalk.json`, built by `scripts/build-player-id-crosswalk.mjs` from the Career Ledger + DNA datasets) proves the pair; **never** filled with a lane value; `null` when unproven. | `espn_id`, `espn_athlete_id`, `?espn_id=` |
| `game_id`, `?game_id=` | PropSports scoreboard game id | the opaque value of scoreboard `games[].id` (today numerically equal to the lane event id — treat as opaque, do not parse) | `espn_event_id`, TD game view `espn_id`, `?espn_id=` / `?event=` on the game view |
| `team_id` | team id | abbreviation, e.g. `KC` (what every NFL surface already keys teams by) | `espn_team_id`, `home_team_espn_id`, `away_team_espn_id` |

Why `game_id` and not `event_id`: `event_id` already means the MARKET (odds) event on `/api/game-intel` and
`/api/matchup-intel` (and `?event_id=` keeps that meaning there). Weather Watch and Career `today` already used
`event_id` for the scoreboard game; they now also emit `game_id`, the name to build on.

Endpoints: `/api/qb-dna`, `/api/rb-dna`, `/api/te-dna`, `/api/wr-dna` (+ `compare`, `prop-lab`, `prop-history`,
`game-context`), `/api/player-career`, `/api/nfl-college-path`, `/api/nfl-media`, `/api/pbe-touchdown-targets?view=game`,
`/api/weather-watch`, nfl-current `/api/current-player` (and every nfl-current / nfl-intel JSON body: player objects
get `player_id`). Removal of the legacy names happens only in a future versioned contract.
