# Odds provider quota — NFL Picks Engine

> **Policy change, 2026-09-06 — USER TRAFFIC MUST NEVER DETERMINE OUR ODDS
> PROVIDER SPEND.** The `nfl-odds` worker (source: `workers/nfl-odds/`) no
> longer contacts The Odds API on any GET. It ingests the full slate on a
> schedule — **08:00, 13:00 and 18:00 America/New_York** (crons at every UTC
> hour that can be those times; the worker checks the New York hour) — and
> serves every read (`/api/odds`, `/api/odds/board`, `/api/odds/events`,
> `/api/odds/props`) from the persisted KV snapshot under
> `semantics: LAST_VERIFIED_MARKET` with `captured_at`, `batch_id`, `age_seconds`
> and the status of the newest ingest attempt. A token-protected
> `POST /api/odds/ingest` exists for exceptional manual refreshes.
>
> **How 20,000 credits were spent (Aug 28 → Sep 6).** Cloudflare analytics for
> `nfl-odds`: 29,004 requests, **15,097 provider subrequests** in 30 days, ~10,000
> of them on Sep 4–6. Every worker cache miss was a paid provider call, and the
> cache key was the request URL, so each surface's market combination and each
> `season_type` variant missed independently: Dashboard `/api/home-market` every
> 15 s (3 credits per 30 s cache miss), Market Watch 2 board calls per 30 s,
> PBEcast v6 + v7 board calls every 8–30 s, Model Lab every 60 s, plus 20 other
> once-per-route-entry board calls and the snapshot cron every 15 min in kickoff
> windows. With a few open tabs that is thousands of credits per day.
>
> **Measured cost of one ingest (Sep 6, batch 20260906T201407Z-manual):**
> **113 credits** = 3 (featured slate, 272 events) + 110 for 10 in-window events'
> player markets (the provider bills only the markets it returns; the worst case
> is 18 per event). At 16 games in an 8-day window: ≤ 3 + 16 × 18 = **291 per
> ingest**, **≤ 873 per day**, **≈ 26,000 per month worst case** and roughly
> **10,000 per month at the measured rate** — on a plan of 100,000, independent
> of user count. Ordinary website traffic now costs **0**.
>
> Regression gates: `research/odds-provider-spend.test.mjs` (100 sequential
> reads → 0 provider requests; cron hour policy in EDT and EST) and
> `scripts/odds-surface-gate.mjs` (eight surfaces, no odds re-request during a
> dwell, no browser provider access).

Everything below this line is the **2026-08-30** measurement of the previous, traffic-driven design and is kept for the record.

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
