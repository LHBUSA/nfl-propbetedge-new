# Odds provider quota — NFL Picks Engine

All figures measured live against the deployed stack on **2026-08-30**, not estimated from documentation.

## Provider

**The Odds API v4**, reached through the existing **`nfl-odds`** Worker via a Cloudflare **service binding** (`env.NFL_ODDS`). `nfl-odds-snapshot` holds **no provider credential of its own** — there is one provider authority and one quota-control point.

## Measured facts

| Fact | Value | How it was measured |
|---|---|---|
| Cost per bulk refresh | **3 credits** | `usage.last_cost: "3"` on `/api/odds` — 1 credit per market × `h2h,spreads,totals` |
| Cost of a cached read | **0 credits** | Two calls 20s apart: `used` stayed `1560`, second reported `cache: "hit"` |
| Upstream cache TTL | **~15 minutes** | `provider_last_update` moved `15:24:01` → `15:39:48` across a miss |
| Events per call | **272** (full season) | `count: 272` — one call covers every game |
| Monthly cap | **20,000** | `remaining 18,440 + used 1,560 = 20,000` |
| Used this period | **1,560** (7.8%) | `usage.used` |

> **Correction to prior documentation.** `C:\Workers\propbet-edges\src\index.js` states a *"100K monthly Odds API budget"*. The live account reports a **20,000** monthly cap. All figures below use the measured 20,000.

## Why the bulk endpoint

The MLB props worker uses the **per-event** endpoint (`/events/{id}/odds`), which it must, because player props are only available per event. Game markets are not: a single `/sports/americanfootball_nfl/odds` call returns all three markets for all 272 events.

- Bulk: **3 credits** per refresh, all games.
- Per-event equivalent: **3 credits × ~16 games = 48** per refresh — 16× the cost, and it would blow the cap.

Per-event polling for game markets is therefore prohibited in this design.

## Projected consumption

Worst case, assuming **every** snapshot run misses the upstream cache and no other caller has warmed it.

| Trigger | Runs | Credits |
|---|---|---|
| Baseline `0 */6 * * *` | 4/day → 120/month | 120 × 3 = **360** |
| Kickoff windows `*/15 * * * *` | 66 quarter-hours/week¹ → ~286/month | 286 × 3 = **858** |
| **Total** | | **≈ 1,220 / month** |

¹ Thu 22:00–01:30 (3.5h) + Sun 16:30–02:00 (9.5h) + Mon 22:00–01:30 (3.5h) = 16.5 h/week = 66 quarter-hour slots.

**≈ 1,220 of 20,000 = 6.1% of the monthly cap.** Combined with the current 1,560 baseline, projected total is ~2,780/month (**~14%**), leaving ~86% headroom.

### Assumptions, stated explicitly

1. **Worst case only.** Because the upstream TTL (~15 min) matches the kickoff-window cadence, some runs will land on a warm cache and cost 0. Real consumption will be **at or below** 1,220.
2. Shared cache cuts both ways — Prop Board traffic warming the cache reduces our cost; it does not increase it.
3. The `*/15` trigger fires 96×/day, but **exits before any odds fetch** when outside a kickoff window (`inKickoffWindow`). Outside windows the provider cost is exactly **0**; only a free Worker invocation is consumed (~2,880/month against a 100k/day allowance).
4. Cost scales with *refresh frequency*, not with the number of games — the season slate size does not change the 3-credit figure.
5. A cap change or a TTL change upstream invalidates these numbers.

## Guardrails

- **Do not** add per-event polling for game markets.
- **Do not** duplicate `ODDS_API_KEY` into another Worker; use the service binding.
- **Do not** shorten the kickoff-window cadence below 15 minutes — it would only produce cache misses, tripling cost for no new information, since the upstream refreshes every ~15 minutes anyway.
- Adding a fourth market raises the per-refresh cost from 3 to 4 credits (~+33%).
- `usage.remaining` is returned on every `/api/odds` response and is surfaced by `nfl-odds-snapshot`'s `/health`, so budget drift is observable without extra calls.
