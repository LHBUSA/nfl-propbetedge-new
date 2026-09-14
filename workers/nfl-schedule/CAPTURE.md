# nfl-schedule — deployed implementation capture

Captured 2026-09-13 with read-only Cloudflare API calls using wrangler's own
OAuth session (account `fd3a233edadd0a60916413c1199f71ee`). Nothing was
deployed, uploaded or changed.

| Item | Value |
|---|---|
| Active deployment | 2026-08-28T17:35:43Z, 100% version `1a88cfca-1f81-41b8-9f91-61dcf78d55ce` |
| Previous deployment | 2026-04-06T21:45:52Z, version `74825cbf-ad78-428d-a98b-980a72032fb4` (stub era) |
| Uploaded from | `wrangler`, module `index.candidate.js` (esbuild bundle) |
| Script etag | `d4b2f8f4284082fa7a42b681e294911c95a5d6c9c5817e79371524c75520bc82` |
| Bundle sha256 | `74c6bb15474a54b17849d62ce3446814e51d54ae090afaaedc9ec253aa92e67a` (48,772 bytes) |
| compatibility_date / flags | `2026-08-28` / none |
| Bindings | none (no KV, no services, no secrets, no vars) |
| Cron triggers | none |
| Handlers | `fetch` only |
| workers.dev | enabled |

`index.js` in this directory is the deployed bundle byte-for-byte
(`GET /workers/scripts/nfl-schedule/content/v2`).

## What the deployed Worker does

* Serves a **hardcoded** 272-game 2026 regular-season array baked into the
  bundle at upload time. Fields per game: `game_id, season, game_type, week,
  gameday, gametime, away_team, home_team`. `source` is declared as nflverse
  `schedules/games.csv`.
* Routes: `*/health`; any path containing `schedule` with filters
  `season` (2026 only), `week` (`current` or a number), `date`, `team`,
  `type=today|upcoming`.
* No upstream fetch, no cache, no refresh. The data changes only when someone
  re-uploads the bundle.

## Diff against the local copy at `C:\Workers\nfl-schedule\`

The local `index.js` (390 bytes, 2026-04-06) is a stub returning
`{worker:'nfl-schedule',status:'ok',path,ts}` for every path. It shares nothing
with the deployed code except the Worker name; its `wrangler.toml` declares an
`NFL_KV` binding and `compatibility_date = 2024-01-01`, neither of which is
deployed. It must not be used as a source.

## Verified against nflverse

All 272 deployed rows equal nflverse `data/games.csv` 2026 rows on `game_id,
week, game_type, gameday, gametime, away_team, home_team` (0 differences,
checked 2026-09-13). nflverse carries an `espn` event id for all 272 games; the
deployed bundle dropped it, and nflverse has **no network column**, which is
why no broadcast could ever flow through `/api/schedule`.
