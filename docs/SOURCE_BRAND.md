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
| `espn_id`, `espn_event_id`, `espn_athlete_id`, `?espn_id=` | player, game and DNA endpoints | PropSports player/event ids (future versioned contract) | deprecated, still accepted and returned |

Guard: `scripts/guard-source-brand.mjs` (v2) runs in `npm test` / `npm run test:nfl` / `npm run guard`.
