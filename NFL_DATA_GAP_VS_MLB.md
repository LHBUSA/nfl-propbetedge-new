# Why MLB PBEcast has pitch-level fidelity and NFL PBEcast does not

Audited against the real code in `LHBUSA/propbetedge-v2` (`src/data/mlb-api.js`,
`src/pages/pbecast.js`, `src/pages/replay.js`) and the real ESPN / nflverse NFL
contracts, on 2026-09-05. Nothing below is assumed.

## The MLB contract

`src/data/mlb-api.js:57` —

```js
/** Full live feed for a game — pitch coordinates, play-by-play, box score */
export async function getLiveFeed(gamePk) {
  return _fetch(`${BASE_LIVE}/game/${gamePk}/feed/live`, 20);
}
```

One free, keyless, **official-league** endpoint, polled every 20 s. Counting the
field references actually made by `pbecast.js` and `replay.js`:

| what MLB PBEcast reads per pitch | field | refs |
|---|---|---|
| pitch velocity | `pitchData.startSpeed` | ✓ |
| **plate location, physical coordinates** | `pitchData.coordinates.pX`, `.pZ` | 15 / 17 |
| strike-zone cell | `pitchData.zone` | 33 |
| pitch type | `details.type.code`, `.description` | ✓ |
| in play / call | `isInPlay` | 11 |
| batter, pitcher | `matchup.batter`, `matchup.pitcher` | ✓ structured objects |
| count | `balls`, `strikes`, `outs` | 33 / 11 / 27 |
| inning state | `inning`, `halfInning`, `atBatIndex` | 49 / 3 / 13 |
| runners | `runners[]` | ✓ |
| **batted-ball physics** | `hitData.launchSpeed`, `.launchAngle`, `.totalDistance`, `.coordinates.coordX/Y` | ✓ |
| score / result | `homeScore`, `awayScore`, `rbi`, `event`, `eventType` | 59 refs to `event` |
| timing | `about.startTime`, `about.endTime` | ✓ |

**That is the whole reason.** MLB's own public Stats API publishes, live and free:
physical coordinates for every pitch, a measured velocity, a classified pitch
type, structured participant objects, complete count/base/out state, and Statcast
batted-ball physics. PBEcast does not reconstruct any of it — it *draws what the
league published*.

## The NFL contract, measured

| capability | MLB (free, live) | NFL via ESPN (free, live) | NFL via nflverse (free, historical) |
|---|---|---|---|
| event coordinates | **pX/pZ per pitch** | ✗ nothing | ✗ nothing |
| event velocity/physics | **startSpeed, launchSpeed/angle** | ✗ | ✗ |
| structured participants | **batter/pitcher objects** | **✗ — 0 of 192 plays** | ✅ passer/receiver/rusher/tackler/interceptor GSIS ids |
| event classification | pitch type code | play `type_id` (24 observed) | 372 columns |
| full state | count/outs/inning/runners | down/distance/yard line/score ✅ | ✅ + EPA, WP |
| per-player event stats | ✅ live | boxscore *cumulative* only | ✅ per play |
| update latency | ~20 s poll | ~5 s poll | **hours to days** |
| air yards / YAC | n/a | ✗ | ✅ |
| formation / personnel / box | n/a | ✗ | ✅ (season-gated) |
| pressure / pass rushers | n/a | ✗ | ✅ FTN charting, 2022+ |
| time to throw / CPOE | n/a | ✗ | ✅ NGS aggregates, weekly |
| 10 Hz player tracking | ✗ (Statcast per-event only) | ✗ | ✗ — only Big Data Bowl, which forbids redistribution |

### The three structural gaps

1. **No live participants.** ESPN's play object carries no athlete list at all —
   verified 0 of 192 plays on a completed game and 0 across a 59-game,
   10,832-play sample. MLB hands us `matchup.batter` on every pitch. This is the
   single biggest live gap and it is *not* something a better parser fixes.
2. **No event geometry.** MLB gives a physical (pX, pZ) per pitch. The NFL's
   equivalent — player/ball x/y — exists (Next Gen Stats) but is not published on
   any free endpoint, and the one public corpus is licence-blocked.
3. **The rich NFL data is not live.** Everything in the nflverse column above is
   real, free and commercially licensed (CC-BY-4.0) — and arrives *after* the
   game. MLB's equivalent arrives *during* it.

## What that means for PBEcast Arcade

| level | source | what Arcade can truthfully render |
|---|---|---|
| **1 — today** | ESPN live | exact snap spot, destination, down/distance, possession change, result, published text. Everything between them reconstructed. **This is what we ship.** |
| **2 — achievable now, free** | ESPN live + our warehouse | the above, plus who is on the field by *likelihood* from depth charts/snap counts (must be labelled as such), plus live prop and historical context for the actual participants once the play text names them |
| **3 — achievable next day, free** | nflverse | a *post-game* replay with the real 22 players, real formation, real personnel, real box count, real air yards and YAC. Arcade could redraw yesterday's game accurately |
| **4 — not available** | NGS tracking | true routes and player paths. No public source. Would require an NFL licence |

**The honest headline: we can close most of the NFL↔MLB gap for *historical and
next-day* fidelity for free, and we cannot close the *live* participant or
geometry gap at all from public sources.**
