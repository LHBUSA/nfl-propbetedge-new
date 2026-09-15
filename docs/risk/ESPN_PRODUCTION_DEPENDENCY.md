# Risk item: PropBetEdge NFL production depends on ESPN

**Status:** RISK REGISTER ENTRY · documentation only · 2026-09-15 · for owner/counsel decision.
**Separate from the Career Ledger participation decision.** Nothing here was changed.
Not legal advice.

## Why this is flagged
ESPN products are governed by the Disney Terms of Use (updated 2024-05-24):
- a *"limited, non-exclusive … license … for your **personal, noncommercial use only**"*
- users may not *"access, monitor, copy or extract the Disney Products using a **robot, spider, script, or other automated means**, including … data mining or web scraping"*
- Disney does *"not allow uses of the Disney Products … that are **commercial or business-related**"*

No ESPN developer terms or licence were found for the endpoints below. The repository's source matrix previously treated ESPN as *"display of factual game state ⚠️"*. The 2026-09-15 rights audit rejected ESPN Core event logs for new ingestion under these terms. By the same reading, existing production uses carry the same exposure.

Facts are not copyrightable. The exposure is mainly **contractual/terms-of-use** for automated commercial extraction, plus **copyright in images** (photographs are creative works), plus trademarks (team logos belong to the NFL and clubs, not ESPN).

## Inventory (code references on main)

### A. Automated server-side data extraction
| Component | Runtime | ESPN surface | Purpose | Persisted? |
|---|---|---|---|---|
| `api/nfl-live.js` | Vercel | `site.api.espn.com` scoreboard (undated, dated, range), summary, `apis/v2` standings; `cdn.espn.com/core/nfl` fallback | PBEcast live lanes, dashboard slate, provider adapter for `nfl-current` | no (edge cache only) |
| `workers/nfl-current` | Cloudflare | reads ESPN via `nfl-live`; `diag` route probes `site.api`, `cdn.espn.com`, `sports.core.api` | season/week contract, scores ledger, standings, current-season stats accumulator, current-player, team schedule | **yes**: KV scores ledger + stats accumulator |
| **Picks engine** (`nfl-game-picks-orchestrator`, graders via `NFL_CURRENT` binding) | Cloudflare | ESPN-derived `nfl-current /api/current-games` | what is pregame, what is FINAL and **final scores used for grading** | engine records in Supabase |
| `workers/nfl-intel/src/injuries.js` | Cloudflare | `sports.core.api.espn.com` team injuries + athletes | What Changed, injury board | **yes**: INTEL_KV |
| `workers/nfl-intel/src/weather.js` | Cloudflare | `cdn.espn.com/core/nfl/scoreboard` | game list for weather | yes (weather snapshot keyed by ESPN event) |
| `workers/nfl-schedule/refresh.js` | Cloudflare | `cdn.espn.com/core/nfl/scoreboard` by week | broadcast, venue, kickoff for every card | **yes**: NFL_KV broadcast snapshot |
| `api/qb-dna/game-context.js` | Vercel | `site.api` scoreboard (undated/dated) | Player DNA next game + venue context | no |
| `api/weather-watch.js` | Vercel | `site.api` scoreboard | weather watch | no |
| `api/player-career.js` | Vercel | `site.web.api` athlete game log (current season), `site.api` scoreboard + summary | Career Ledger current season + live totals | no (memo cache) |
| `scripts/career-ledger/harvest_career_ledger.py` → `data/dist/career-ledger.json` | offline, committed | `site.web.api` athlete, stats, game logs for **1,203 players, all seasons** | Career Ledger history | **yes: 13.7 MB ESPN-derived dataset in the repo and deployment** |
| `api/nfl-media.js` | Vercel | `site.api` teams, `site.web.api` search | player/team media resolution | no |
| `research/ingest/active_players.py`, `active_qbs.py`, `espn_diff.py`, `venues.py`, `audit_*` | offline | `site.api` team rosters, teams | 2026 roster audit (`active_2026`, `espn_id`), venue table → DNA datasets, `data/dist/nfl-venues.json` | **yes**: DNA datasets / venue table |

### B. Hotlinked images (served from ESPN's CDN into our pages)
| Component | Asset | Note |
|---|---|---|
| `api/_playerdna/media.js` | `a.espncdn.com/i/headshots/nfl/players/full/{espn_id}` | **Player photographs**: copyright in photos, plus athlete publicity rights. Highest-sensitivity item in this register |
| `sports-shell-v2.js`, `pbe-card-v3.js`, `pbe-picks-v2.js`, `player-dna-shared.js`, `games-command-v4.js`, `injury-intel-v2.js`, `newsroom-v2.js`, `nfl-brand-media-v2.js`, `pbe-breaking-v1.js`, `production-polish-v2.js`, `workers/nfl-intel/src/changes-core.js`, `injury-board.js` | `a.espncdn.com/i/teamlogos/nfl/500/...` | Team logos: NFL/club **trademarks**, hosted by ESPN |

### C. Outbound links (lowest sensitivity)
`propchain-core-v3.js` (ESPN player page links); `workers/nfl-schedule/broadcasters.js` (ESPN watch/official links for ESPN-broadcast games).

### D. Identifiers used as keys
ESPN athlete and event ids join Player DNA, Career Ledger, market joins, weather and broadcast snapshots. Identifiers are factual; the dependency is structural rather than a rights issue in itself.

### E. Specific concern to remove regardless of outcome — **RESOLVED 2026-09-15** (removed in main `1e4b178`, nfl-current `3e0d835e`, rollback `1aedaef5`; `/api/current/diag` now returns 404)
`workers/nfl-current/src/index.js` `/api/current/diag` sends requests with a **spoofed browser user-agent and referer** to an ESPN surface that returns 403 to Cloudflare egress (a historical diagnosis of that block). Header spoofing against a provider's block reads as circumvention. As deployed, the route references an undefined `SITE` constant, so it throws before sending those requests; the code is still present. Recommend removing the probe in a future approved change (not done here: nfl-current changes are frozen).

## Exposure ranking (suggested, for counsel)
1. **Persisted bulk extraction:** Career Ledger history (1,203 players, all seasons), KV accumulators/snapshots, roster audit.
2. **Headshot photographs** hotlinked from ESPN.
3. **Picks grading** relies on ESPN final scores (commercial decisions and track record).
4. Live polling for display (PBEcast, dashboard, game context).
5. Logos (trademark; ESPN only hosts them) and outbound links.
6. The diag probe (§E).

## Remediation options (none selected)
| Option | Effect | Cost / impact |
|---|---|---|
| R-A. Obtain a licence (ESPN/Disney, or a licensed NFL data provider such as the league's official distributors) | resolves the ingestion exposure | commercial cost, integration work |
| R-B. Replace live and schedule state with a licensed feed; keep ESPN ids only as keys | removes A-rows 1–9 | provider cost |
| R-C. Remove persisted ESPN-derived history (Career Ledger history) or rebuild it from an approved source | removes rank 1 | Career Ledger coverage drops until rebuilt |
| R-D. Self-host licensed or owned imagery; stop hotlinking ESPN headshots and logos (logos need NFL/club permission anyway) | removes rank 2 and 5 | image rights needed |
| R-E. Grade picks from an approved results source | removes rank 3 | grader change + reconciliation |
| R-F. Document risk acceptance with counsel for specific low-exposure uses | keeps current state, informed | legal review |
| R-G. Remove the diag header-spoofing probe | removes §E | **done** (1e4b178) |

## Owner / counsel decisions needed
1. Is the current ESPN use acceptable, and which items require remediation first?
2. Should the Career Ledger's ESPN-derived history remain served while this is reviewed? It is unchanged and frozen, pending decision.
3. ~~Approve removal of the diag probe (§E)?~~ Approved and done (1e4b178). Remediation order and steps: [ESPN_REMEDIATION_PLAN.md](ESPN_REMEDIATION_PLAN.md).
4. Budget and timeline appetite for a licensed data provider.

This entry does not change the Career Ledger participation decision, which is tracked in
[docs/career-ledger/PARTICIPATION_DERIVATION_AND_SHAREALIKE.md](../career-ledger/PARTICIPATION_DERIVATION_AND_SHAREALIKE.md).
