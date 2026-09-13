# nfl-schedule — schedule + broadcast authority

`/api/schedule` (via nfl-gateway's `NFL_SCHEDULE` binding) is the one place the
product learns a game's kickoff identity and where it is televised. Deployed
provenance: [CAPTURE.md](CAPTURE.md).

## Source priority (evidence, 2026-09-13)

1. **nflverse schedule network** — none exists (`games.csv` has no network
   column). Supplies identity only: `game_id` and the ESPN event id (`espn`).
2. **ESPN CDN scoreboard, by week** —
   `cdn.espn.com/core/nfl/scoreboard?xhr=1&limit=100&week=N&seasontype=2&year=2026`.
   `competitions[0].broadcasts[].names` plus `geoBroadcasts[]` typed `TV` /
   `Streaming`. Covers every scheduled game, not just in-progress ones: all
   272 regular-season games were present; 248 carried TV, 24 (weeks 16–18,
   kickoff times not final) carried none. Reachable from Worker egress
   (nfl-intel's production weather lane reads the same host).
3. **ESPN site scoreboard through the existing relay** —
   `nfl.propbetedge.ai/api/nfl-live?range=YYYYMMDD-YYYYMMDD` (site.api 403s
   Worker egress, so nfl-current already reads it this way). Names only; used
   for a week only when (2) fails.
4. **Nothing** — `UNASSIGNED` when ESPN publishes no TV, `UNAVAILABLE` when the
   source could not be read or the game could not be joined safely.

No weekday, time-slot or team rule exists anywhere.

## Identity

`espn_event_id` (from nflverse) must name the same away and home teams on
ESPN. Fallback when a row has no id: same away team, same home team and the
same Eastern calendar date on a time-valid kickoff, and only if exactly one
event matches. Ambiguity or disagreement joins nothing. Evidence is published
per game in `broadcast.match`.

## `broadcast` contract

```jsonc
{
  "status": "VERIFIED",            // VERIFIED | UNASSIGNED | STALE | UNAVAILABLE
  "primary": "CBS",                // first network, else first streaming service; null when none
  "networks": ["CBS"],             // television networks, source order ("ESPN","ABC" kept as two)
  "streaming": [],                 // streaming services ESPN itself lists (Prime Video, Netflix); never inferred
  "distribution": "regional",      // national | regional | unknown
  "national": false,               // true | false | null
  "distribution_basis": "concurrent_games_on_same_channel",
  "local_affiliate": null,         // reserved: { callsign, channel, market } — never claimed in v1
  "destinations": [
    { "provider": "CBS", "provider_id": "cbs", "type": "network",
      "url": "https://www.cbs.com/live-tv/stream/", "url_type": "official_watch",
      "verified": true, "verified_at": "2026-09-13T20:59:16Z" }
  ],
  "source": "espn_cdn_scoreboard",
  "source_event_id": "401872927",
  "verified_at": "2026-09-13T21:10:35.794Z",   // last time the source confirmed this
  "changed_at": null,                          // last time the published channels changed
  "previous": null,                            // { networks, streaming, verified_at } before that change
  "match": { "method": "espn_event_id", "confidence": "exact", "kickoff_agrees": true, ... }
}
```

`distribution`: ESPN marks every NFL broadcast `market: national`, including
regional 1 p.m. CBS/FOX games, so it is derived from the published slate: a
channel with another game kicking off within 150 minutes is regional for each;
a game alone on all of its channels in its window is national; unknown when
the kickoff time is not final.

Links come only from the verified registry in `broadcasters.js`, only when the
URL's host is on that provider's allow-list, and never from a network name,
event id or slug. Re-verify with `node scripts/verify-broadcaster-links.mjs`.

## Freshness

Cron `*/15 * * * *`; `refresh.js` decides per tick: full-season sweep daily
(18 requests over three ticks), current + next week hourly (2), current week
every 15 minutes on game days (1). At most 8 upstream requests per tick; idle
ticks make none. The fetch path makes none: it reads the KV key
`schedule:broadcast:v1` (shared `NFL_KV` namespace), cached 30 s per isolate.
`STALE` after 6 h without confirmation for a game within 36 h, 60 h otherwise.

Routes added: `/api/schedule/broadcast/health` (diagnostics),
`/api/schedule/broadcast/registry`.

## Deploy order (not done on this branch)

1. Frontend first — `games-v2.js` must accept `broadcast` as an object before
   the Worker starts sending one (the current production build would print
   `[object Object]`).
2. `wrangler versions upload`, gradual deploy, verify `/api/schedule/broadcast/health`
   after the first cron ticks, promote. Rollback: version `1a88cfca`.
