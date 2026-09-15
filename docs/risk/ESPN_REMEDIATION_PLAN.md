# ESPN dependency remediation plan (PREPARED, NOT EXECUTED)

**Status:** plan only · 2026-09-15 · requires owner approval per phase (and counsel where noted).
Risk entry: [ESPN_PRODUCTION_DEPENDENCY.md](ESPN_PRODUCTION_DEPENDENCY.md). Not legal advice.

**Done so far:** the dead diagnostic probe that spoofed a browser user-agent and referer was removed from `nfl-current`, as an approved narrow cleanup (main `1e4b178`, Worker version `3e0d835e`, rollback `1aedaef5`). No ESPN feed, grading, schedule, scoring or Player DNA behaviour changed.

**Order (owner-specified):**
1. Hotlinked photographs and media
2. Grading / final-score dependency
3. Live and current feeds
4. Persisted historical datasets
5. Identifiers and outbound links

**Rules for every phase:**
- **Replacement source:** licensed or otherwise approved in writing before any build.
- **Cutover:** shadow-run the new path next to ESPN, compare deterministically, cut over only after a zero-unexplained-diff window.
- **Rollback:** one step per phase (Worker version or Vercel deployment).
- **Do not relaunch into frozen areas:** Player DNA next-game, week-state UI and Career Ledger stay frozen unless a phase is explicitly approved to touch them.
- **No hidden fallback:** no ESPN fallback may linger behind the new path (the old ESPN headshot fallback rule is superseded for any phase you approve).

---

## Phase 1 — Hotlinked photographs and media (highest sensitivity)

**Exposure.**
- **Headshots:** player photographs served from `a.espncdn.com/i/headshots/...`. Photos carry copyright, plus athletes' publicity rights.
- **Logos:** team marks served from `a.espncdn.com/i/teamlogos/...`. Trademarks of the NFL and clubs; ESPN only hosts them.

**Inventory (main):**
- **Headshots, built from ESPN ids:** `api/_playerdna/media.js` (DNA heroes, lists, picker, Best Line prop faces through the DNA list media block), `api/nfl-media.js`, `nfl-player-media-v3.js`, `api/nfl-live.js` (athlete headshots in summary payloads, used by `pbecast-v6.js`, `dashboard-v7.js` leaders, `pbe-breaking-v1.js`), `workers/nfl-intel/src/injuries.js` → `what-changed-v1.js`, `injury-command-center-v1.js`, `propchain-core-v3.js` / `propchain-v3.js`.
- **Logos:** `sports-shell-v2.js`, `pbe-card-v3.js`, `pbe-picks-v2.js`, `player-dna-shared.js`, `games-command-v4.js`, `injury-intel-v2.js`, `newsroom-v2.js`, `nfl-brand-media-v2.js`, `pbe-breaking-v1.js`, `production-polish-v2.js`, `workers/nfl-intel/src/changes-core.js`, `injury-board.js`, `api/_playerdna/media.js`.
- **Adjacent:** `propbet-img-proxy` is an open proxy that returns 200 even on failure. It must not become a way to keep serving ESPN images.

**Target state.**
- **Headshots:** removed, or replaced by imagery under an explicit licence (league or club media licence, a licensed photo agency, or athlete/agency-granted assets). Until a licence exists, show the product's neutral player mark with no photo.
- **Logos:** removed, or self-hosted only under a trademark licence/permission. Until then, a text team-code badge (the product already has a `pbecc-logo-fallback` / text-badge pattern).

**Steps.**
1. Single media authority: one shared resolver that returns `{ kind: 'none' | 'licensed', url, credit }`. Every surface above reads only it.
2. Default switch: headshots `none`; logos text badge. Remove all `espncdn` URLs from source.
3. Gate: a repository check fails the build on any `espncdn.com` / `espn.com` image URL in served code, plus a browser gate counting image requests to ESPN hosts on every route at 1440/390 (must be 0).
4. When licensed assets exist: ingest with provenance and credit, self-host (R2), serve through the resolver.

**Validation.** Zero requests to ESPN image hosts across the 26-route sweep; no layout regression (image boxes keep their dimensions); no broken-image states.
**Rollback.** Revert the resolver commit.
**Dependencies / decisions.** Image licensing budget; a design decision on the no-photo presentation. Touches frozen Player DNA hero visuals: **needs explicit approval**.
**Effort.** Code small to medium; licensing lead time unknown.

---

## Phase 2 — Grading and final-score dependency

**Exposure.** Official picks and the track record are settled from ESPN data:
- **`nfl-game-grader`:** FINAL state and final scores from `nfl-current /api/current-games`, which reads ESPN scoreboards through `api/nfl-live.js`.
- **`nfl-prop-picks-grader`:** FINAL from `nfl-current`, and the player result from ESPN's **CDN game package box score** (`source: 'espn_cdn_gamepackage'`).
- **`nfl-picks-engine-shared/current-slate.mjs`:** what is pregame, LIVE or FINAL, and game ids.
- **Model inputs** (ratings from nflverse play-by-play) are NFL-origin; they are tracked under the separate nflverse review, not here.

**Target state.** Grading reads final scores and player box-score results from a **licensed results source** (an official league data distributor or licensed sports-data provider), keyed to the same games through a documented id crosswalk. ESPN stays out of settlement entirely.

**Steps.**
1. **Results authority contract:** a new internal contract (`results/v1`: game id, FINAL flag, final scores, stat corrections with timestamps, per-player result lines for graded markets) behind one Worker. Graders and picks read only it.
2. **Crosswalk:** licensed provider game id ↔ ESPN event id ↔ nflverse `game_id` (approved schedule id columns), with field-agreement checks (season, type, teams, kickoff).
3. **Shadow grading:** run both paths for ≥2 full weeks. Settlement must match exactly, except documented stat-correction timing.
4. **Cutover per grader:** game grader first, then prop grader. Engine attribution (`current_week`) and grading logic stay unchanged; only the result source changes.
5. **Corrections:** re-grade deterministically when the licensed source publishes a correction, with an audit row.

**Validation.** Existing engine suites (`workers/nfl-picks-engine-shared/tests`, `tests/pbe-card-v3.test.mjs`, `tests/pbe-track-record-v3.test.mjs`); shadow diff report of zero unexplained differences; track-record totals identical over the shadow window.
**Rollback.** Service-binding switch back to `nfl-current` (Worker version rollback).
**Dependencies / decisions.** Provider licence and cost. **Touches frozen picks attribution/grading paths: needs explicit approval.**
**Effort.** Medium; provider integration dominates.

---

## Phase 3 — Live and current feeds

**Exposure.** Automated polling of ESPN for display and state:
- `api/nfl-live.js`: PBEcast lanes, dashboard, adapter for `nfl-current`
- `workers/nfl-current`: season/week contract, scores ledger, standings, current stats, current player, team schedule
- `workers/nfl-intel` injuries (ESPN core API) and weather game list
- `workers/nfl-schedule/refresh.js`: broadcast, venue, kickoff
- `api/qb-dna/game-context.js`, `api/weather-watch.js`, `api/player-career.js` (current season and live), `api/nfl-media.js`

**Target state.** One licensed live-data feed (scores, clock/state, play-by-play for PBEcast, standings, injuries, schedule, venues) behind the existing internal contracts. The contracts (`/api/season`, `/api/current-games`, `/api/nfl-live` layers, `team_schedule`, injuries) keep their shapes, so frontends do not change.

**Steps.**
1. **Adapter swap, not a rewrite:** `api/nfl-live.js` is already the single provider adapter. Add a licensed-provider adapter with the same normalised output (`readGame` and `detail` shapes).
2. **Order of cutover:** schedule/venue/broadcast (`nfl-schedule`) → season/current-games/scores/standings (`nfl-current`; the week-state rules in `slate.js` are provider-agnostic) → injuries (`nfl-intel`) → PBEcast live lanes (the latency gates in `scripts/pbecast-*` must pass) → DNA game context and Career Ledger current season.
3. **Shadow per feed:** existing gates run against both (season-audit invariants, career-slate gate, PBEcast latency and resilience gates, nfl-intel tests).
4. Remove the ESPN adapter paths once each feed is cut over; the repository check from Phase 1 is extended to ESPN API hosts.

**Validation.** `scripts/season-audit-gate.mjs` (invariants), `scripts/dna-layers-gate.mjs`, `scripts/career-slate-gate.mjs`, PBEcast latency/resilience gates on a live slate; freshness SLAs unchanged.
**Rollback.** Adapter selection flag per Worker; Worker version rollback.
**Dependencies / decisions.** Provider licence (can be the same as Phase 2). Touches frozen `nfl-current` / week-state / PBEcast areas: **needs explicit approval per feed.**
**Effort.** Medium to large (PBEcast live lanes are the hardest).

---

## Phase 4 — Persisted historical datasets

**Exposure.** ESPN-derived data at rest:
- `data/dist/career-ledger.json` (13.7 MB, 1,203 players, all seasons, committed and deployed)
- `nfl-current` KV scores ledger and stats accumulator
- `nfl-intel` INTEL_KV injury/athlete snapshots
- `nfl-schedule` NFL_KV broadcast snapshot
- DNA roster audit fields (`active_2026`, `espn_id`) and `data/dist/nfl-venues.json`, built from ESPN rosters and teams

**Target state.** Historical facts rebuilt from licensed or approved sources, with provenance per row. ESPN-derived stores deleted, not merely hidden (the git history question goes to counsel: whether a history rewrite is warranted for committed ESPN-derived data).

**Steps.**
1. **Career Ledger:** a decision between (a) rebuild history from a licensed historical stats source and (b) withdraw the Career Ledger surface until one exists. Participation-based reconciliation stays governed by its own decision record (2016–22 NGS not approved; FTN measurement only).
2. **KV stores:** repopulated by the Phase 3 feeds; purge ESPN-derived keys after cutover (explicit key lists, logged).
3. **Roster audit and venues:** rebuild from the licensed provider; `active_2026` recomputed; diff report before replacement.
4. Update the source matrix and attribution surfaces.

**Validation.** Career Ledger invariants (`tests/player-career-ledger.test.mjs`, the career-slate gate); DNA identity gates; no ESPN-derived keys remaining (inventory script).
**Rollback.** Keep the previous dataset versions restorable, subject to the counsel decision on retention.
**Dependencies / decisions.** Counsel on retention and git history. **Career Ledger is frozen: needs explicit approval.**
**Effort.** Medium (depends on the historical source).

---

## Phase 5 — Identifiers and outbound links (lowest sensitivity)

**Exposure.**
- ESPN athlete and event ids as join keys (DNA, Career Ledger, market joins, weather and broadcast snapshots)
- Outbound links to `espn.com` player pages (`propchain-core-v3.js`) and ESPN watch/official links (`workers/nfl-schedule/broadcasters.js`)

**Target state.**
- **Keys:** internal canonical ids (GSIS for players, nflverse `game_id` or the licensed provider's ids for games) are primary. ESPN ids become optional crosswalk columns (approved for internal reconciliation), never required.
- **Links:** kept only where they are factual navigation (a broadcaster's own watch page for an ESPN-televised game); no ESPN player-page links as product content.

**Steps.**
1. Add canonical ids alongside ESPN ids in every contract (additive), then migrate joins, then make ESPN ids optional.
2. Remove ESPN player-page links; keep broadcaster watch links under the verified broadcaster registry.

**Validation.** Identity gates unchanged (0 conflicts, fail closed); link registry check.
**Rollback.** Additive fields; revert commits.
**Effort.** Small to medium.

---

## Owner decisions required before any phase starts
1. **Licensed provider(s):** live/results feed (Phases 2–3), historical stats (Phase 4), imagery and logo permissions (Phase 1).
2. **Phase 1 interim:** approve "no photo / text team badge" as the default presentation now, independent of licensing?
3. **Approval to unfreeze** the specific frozen areas each phase touches.
4. **Counsel:** retention of persisted ESPN-derived data and committed history.
