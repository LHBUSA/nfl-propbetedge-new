# NFL Product Depth V2 — Opportunity Radar · My Sunday · Game Script Lab

Branch `nfl-opportunity-my-sunday-script-v1` (LHBUSA/nfl-propbetedge-new), based on
origin/main `09cf8f9`. **Nothing here is in production.** Production Workers,
production D1/Supabase, cron schedules and the production frontend are untouched.

Journey: discover a changing role (Opportunity Radar) → research the matchup
(Matchups) → explore a game script (Game Script Lab, inside Matchups) → save it
(My Sunday, from any research surface) → follow the game (My Sunday live phase,
exact-game PBEcast) → review the outcome (My Sunday final phase).

---

## 1. Ownership (inspected, not assumed)

| Concern | Owner | Where |
|---|---|---|
| nflverse play-by-play ingest (R2, Workflow, 3-hourly probe) | **nfl-replay** Worker (existing) | `workers/nfl-replay/` |
| Opportunity data contract `pbe-opportunity/v1` | nfl-replay 1.1.0 (new step + route) | `workers/nfl-replay/src/opportunity.js`, `pipeline.js` |
| Public read path | nfl-gateway → nfl-replay, existing `/api/replay/*` prefix (no gateway change) | `workers/nfl-gateway/index.js:71` |
| Browser read (same origin, CDN 5 min) | `api/opportunity.js` (pass-through; decides nothing) | Vercel |
| Session principal | `api/_nfl-auth.js` `getNflSession` (HS256 `pbe_nfl_session_v2`, host-only) | existing, unchanged |
| Entitlement (NFL Pro / All Access / Owner) | `api/_nfl-entitlement-ledger.js` via `getNflSession` | existing, unchanged |
| My Sunday session boundary + CSRF | `api/my-sunday.js` (new) | Vercel |
| My Sunday storage + alerts | **nfl-my-sunday** Worker + D1 (new) | `workers/nfl-my-sunday/` |
| Shared change ledger (availability, game status, consensus market) | **nfl-intel** (existing, read only) | service binding |
| Market snapshot (props) | **nfl-odds** KV snapshot (existing, read only, 0 provider credits) | service binding |
| Scoreboard / box scores | `api/nfl-live.js` (existing) | Vercel |
| Opportunity Radar UI (`#usage`, alias `#opportunity`) | `opportunity-radar-v1.js/.css` (replaces usage-v2) | loader |
| My Sunday UI (`#mysunday`, Save control, header control, rail) | `my-sunday-v1.js/.css` | loader |
| Game Script Lab | `game-script-core-v1.js` (pure) + `game-script-lab-v1.js/.css`, panel in `matchups-v3.js` | loader |

## 2. Data and identity contract — `pbe-opportunity/v1`

**Source.** nflverse `play_by_play_<season>.csv.gz`, already ingested by
nfl-replay in production (33 games / 5,662 plays for 2026 at build time). No new
dataset. Identity crosswalk: nflverse `players.csv`, **only** the `gsis_id` and
`espn_id` columns (owner-approved internal reconciliation use). No attribute
column is taken from it; names/positions/photos come from the Player DNA index
by gsis id.

> **Owner source decision (2026-09-25):** the owner approved continued use of
> the existing nflverse 2026 play-by-play for Opportunity Radar, Game Script
> Lab and the My Sunday features that depend on it. This does **not** clear the
> source: its status stays **REVIEW REQUIRED**, provenance and attribution are
> preserved, PFR snap counts and ESPN Core bulk ingestion stay rejected,
> nflverse player data stays limited to identifier joins, and participation
> stays on HOLD. The approval covers only this use.
>
> **Rights status (unchanged):** nflverse play-by-play is
> `REVIEW REQUIRED` in `docs/career-ledger/SOURCE_RIGHTS_AND_RECONCILIATION_AUDIT.md`
> (nflverse CC-BY over NFL-origin data). It already powers Player DNA, the
> Touchdown Targets model and PBE Replay in production; Opportunity Radar and
> Game Script Lab extend that same exposure to two more surfaces. Snap counts
> (PFR) and ESPN Core stay rejected and are not used; participation stays on
> hold and is not used.

**Play universe** (`opportunity-metrics/1.0`, `opportunity.js` header):

- excluded: `no_play`, two-point tries, kneels, spikes, aborted snaps, special
  teams, rows without a possession team;
- dropback = attempt (pass_attempt and not sack) | sack | scramble (checked
  first; 11 of 151 2026 scrambles lack `qb_dropback`) | other;
- designed run = rush_attempt that is not a scramble; carry to the ball carrier;
- target = attempt with an intended receiver; attempts without one stay
  "untargeted", never anybody's target;
- red zone / inside-10 / inside-5 from pre-snap `yardline_100`;
- game state (`game-state/1.0`): pre-snap `score_differential` of the offense,
  leading ≥ +7, trailing ≤ −7, balanced otherwise, missing → `unknown`.

**Rules.** Shares are ratios of sums over the same games. A team game without
a recorded target/carry for a player is its own state (the play-by-play cannot
tell inactive from unused) — never a 0% game. Byes are not games. Trades split
windows by team; other teams are listed separately. Incomplete games (final
quarter never reached 0:00 and no overtime) are excluded and listed.
Duplicated play ids collapse; a corrected nflverse file rewrites the per-game
aggregates and the rollup is rebuilt idempotently. Seasons never mix.

**Contract fields** (rollup): `contract, version, metric_version, label_version,
state_version, season, generated_at, source{dataset,url,license,attribution,
asset_last_modified,asset_etag,ingested_at,revision,identity{…}}, data_through
{game_id,season_type,week,games}, coverage{games_ingested,games_complete,
games_incomplete,weeks,game_ids,identity{resolved,unresolved}}, definitions,
rules, unsupported{snap_share,route_participation,air_yards_share}, highlights,
players[], teams{}`.

Radar row (compact): `gsis, espn, identity, name (pbp short), team, label,
metric (primary: target|carry), latest_game, latest_label, latest|prior|recent|
season {games, weeks, t, tt, c, tc, rz, trz, ts, cs, rs [, rzt, rzc, i10, ti10,
i5, ti5, sc]}, delta{ts,cs,rs} (pp), judged{target,carry}, insights[{code,text}],
notes[], other_teams[], no_recorded[], series[{w,st,g,o,t,tt,c,tc,rz,trz}]`.

**Labels** (`opportunity-labels/1.0`, `LABEL_RULES`): latest appearance vs up to
3 prior appearances with the same team. Target: Δ ≥ 7 pp and ≥ 4 targets latest
(expanding), Δ ≤ −7 pp from ≥ 3 targets/game (declining); latest game ≥ 15 team
targets, prior ≥ 25. Carry: 12 pp, 6 carries, 5/game; ≥ 10 / 15 designed runs.
Otherwise Stable; failing a sample rule → Insufficient sample. Insight
sentences are fixed templates, emitted only when their inputs exist. Homepage:
≤ 3 highlights from the latest data week, resolved identities only, never padded.

**Consumer states:** Ready · Updating (the scoreboard has a final the
play-by-play does not yet) · Not yet published · Temporarily unavailable.

## 3. Feature access rules

| Feature | Anonymous | NFL Pro / All Access / Owner |
|---|---|---|
| Opportunity Radar | full | full |
| Game Script Lab | full (free research, like Matchups) | full |
| My Sunday | device-only list (localStorage, 50 items), no alerts | synced account list (200 items) + in-app alerts |

- The NFL auth path issues sessions only to entitled readers (a verified email
  without an entitlement is paywalled and its cookie cleared), so there is no
  "signed-in free" state to serve; signed-out readers get the device list.
- `api/my-sunday.js` requires `access === 'granted'` from `getNflSession` for
  every write (401 anonymous / forged / expired, 403 `no_entitlement`, 503
  `unavailable`). A signed-out **read** answers 200 `{synced:false, items:[]}`
  without touching storage, so signed-out pages never log a 401.
- Owner key = HMAC-SHA256(`MY_SUNDAY_OWNER_SECRET`, `nfl-my-sunday:v1:<email>`);
  the Worker never sees an email; any `owner`/`owner_key`/`email`/`account_id`
  in a body is dropped.
- Writes: POST + `application/json` + `x-pbe-csrf: 1` + same-host `Origin`.
  Responses: `private, no-store`, `Vary: Cookie`.
- Every D1 statement is scoped by `owner_key` in code (D1 has no RLS).
- Flag: `MY_SUNDAY_ENABLED=1` or 404 `feature_disabled` → all My Sunday
  controls disappear.
- Saved items never enter official accounting; the Worker has no binding to any
  picks/grader Worker and names no picks table (test-enforced).

## 4. Implementation status

| Item | Status |
|---|---|
| A. Data foundation (nfl-replay 1.1.0) | Built, tested, **preview Worker live** (`nfl-replay-preview`) |
| A. Opportunity Radar | Built, tested, on preview |
| B. My Sunday boundary + Worker + D1 | Built, tested, **preview Worker + preview D1 live** |
| B. My Sunday UI + Save on 6 surfaces | Built, tested, on preview |
| B. In-app alerts (availability, game status, consensus + prop line/price) | Built, tested (unit + D1); live on preview via read-triggered refresh |
| C. Game Script Lab | Built, tested, on preview |
| Production | **Not deployed** (requires approval — §8) |

Known gaps / follow-ups:
- **Live box-score progress** is read on open and on "Update progress" (30 s
  floor), not on a timer: `/api/nfl-live?event=` is `no-store` while live, so a
  timer would be per-reader upstream polling. A shared, cached live box-score
  lane (e.g. in nfl-intel) would allow automatic progress.
- **Prop quote identity**: Prop Board quotes name players by provider string;
  My Sunday resolves them to one Player DNA entry with that exact full name on
  one of the two teams, else keeps the prop unresolved (no stat progress).
- **Consensus market alerts** are nfl-intel's cross-book consensus (spread /
  total / moneyline); saved **props** are compared same book + same side.
- Snap share / route participation: unsupported by design (no approved source).
- Early season: many players are "Insufficient sample" until week 3–4 by rule.

## 5. Test commands

```
npm test                    # 22/22  (baseline 22/22)
npm run test:nfl            # 743/743 (baseline 683/683; +60 new)
npm run test:research       # 114 pass / 6 fail (baseline identical: 6 pre-existing PBEcast lane/weather failures)
npm run test:engine         # 246 / 1 fail (baseline identical: shadow-lane test, pre-existing)
npm run test:td             # 44/44
npm run verify-deploy-target
node --test tests/nfl-opportunity.test.mjs tests/nfl-my-sunday.test.mjs tests/nfl-game-script.test.mjs
python scripts/opportunity-mutations.py   # 6/6 killed
python scripts/my-sunday-mutations.py     # 10/10 killed
node scripts/opportunity-local-build.mjs <play_by_play_2026.csv.gz> <players.csv>
node scripts/opportunity-reconcile.mjs --per-position 6 --pbp <play_by_play_2026.csv.gz>
node scripts/depth-v2-qa.mjs   --base=<preview> --share=<token> [--routes=…] [--widths=…]
node scripts/depth-v2-flow.mjs --base=<preview> --share=<token> --flow=device|synced|script [--cookie-a=<file> --cookie-b=<file>]
```

## 6. Evidence

**Reconciliation vs an independent source** (ESPN box scores via
`/api/current-player`): 51 player-games, 24 players, 22 teams, QB/RB/WR/TE —
42 exact on targets and carries; 9 QB games exact once scrambles + kneels +
aborted snaps (ESPN counts them as rushes; the radar's designed-run carry
excludes them) are added back; **0 mismatches**.

**Preview:** see §7 for URLs. Browser flows on the preview:
device 10/10 (1440, 390), synced two-account 13/13, Game Script Lab 9/9.
Screenshots: `.gate/depth-v2/` (not committed).

## 7. Preview configuration (isolated)

| Resource | Name | Notes |
|---|---|---|
| Vercel preview | `nfl-propbetedge-i8eh6wo5o-justins-projects-ad4f4bb7.vercel.app` | target=preview; SSO protected |
| Opportunity Worker | `nfl-replay-preview` (`wrangler deploy --env preview`) | own R2 `nfl-replay-preview`, own Workflow, **no cron** |
| My Sunday Worker | `nfl-my-sunday-preview` | own D1 `nfl-my-sunday-preview` (7fff5328…), **no cron** |

The project's Preview scope has **no** environment variables, so the preview
carries no production secret. Deployment-level env (`vercel deploy --env`):
`NFL_OPPORTUNITY_ORIGIN`, `MY_SUNDAY_ENABLED`, `MY_SUNDAY_ORIGIN`,
`MY_SUNDAY_INTERNAL_TOKEN`, `MY_SUNDAY_OWNER_SECRET`, and — for the
authenticated test only — a preview-only `NFL_SESSION_SIGNING_SECRET` and
`NFL_OWNER_EMAILS=qa-a@…,qa-b@preview.propbetedge.test`. QA sessions are
minted with that preview key (files in `D:\Workers\secrets\nfl-preview-*`).
They exercise the real verifier and the **Owner** verdict; the NFL Pro and All
Access verdicts are proven in `tests/nfl-my-sunday.test.mjs` through the real
`getNflSession` path with the ledgers faked at the network edge — **not** live.

Preview reads (read-only) of production nfl-intel `/api/changes` and nfl-odds
KV; all writes go to the preview D1 / R2 only.

## 8. Production rollout (requires approval) and rollback

Order matters: data first, then storage, then the frontend.

1. **Owner decisions:** nflverse play-by-play rights review (§2); flag rollout.
2. **nfl-replay 1.1.0** (captures rollback first):
   ```
   cd workers/nfl-replay
   npx wrangler deployments list            # current: 7bb23114-dfc5-48d7-b728-bbf52ef94877
   npx wrangler deploy
   curl -X POST -H "Authorization: Bearer $(cat D:/Workers/secrets/nfl-replay-admin-token)" \
     "https://nfl-api.propbetedge.ai/api/replay/ingest?season=2026&force=1"   # re-ingest once: old objects lack the new columns
   curl "https://nfl-api.propbetedge.ai/api/replay/opportunity?season=2026" # expect state READY
   ```
   Rollback: `npx wrangler rollback 7bb23114-dfc5-48d7-b728-bbf52ef94877`.
   The new R2 keys (`opportunity/…`) are additive; Replay objects keep their
   shape plus extra columns, which PBEcast ignores.
3. **nfl-my-sunday** (new):
   ```
   cd workers/nfl-my-sunday
   npx wrangler d1 create nfl-my-sunday      # put the id in wrangler.toml (placeholder today)
   npx wrangler d1 migrations apply nfl-my-sunday --remote
   npx wrangler deploy
   npx wrangler secret put MY_SUNDAY_INTERNAL_TOKEN     # value from a new D:\Workers\secrets file
   ```
   Rollback: `npx wrangler delete nfl-my-sunday` (no other service depends on it);
   the D1 database can be kept or deleted.
4. **Vercel production env** (Production scope): `MY_SUNDAY_ENABLED=1`,
   `MY_SUNDAY_ORIGIN=https://nfl-my-sunday.<subdomain>.workers.dev`,
   `MY_SUNDAY_INTERNAL_TOKEN`, `MY_SUNDAY_OWNER_SECRET` (≥ 32 chars, new).
   `NFL_OPPORTUNITY_ORIGIN` stays unset (defaults to the gateway).
5. **Frontend:** merge the branch to main (main auto-deploys production), then
   verify `/#usage`, `/#mysunday`, `/#matchups`, the six Save surfaces and PBEcast.
   Rollback: promote `dpl_CeBNuqYgQhxbQdbcbQAX3FUvEsJX` (09cf8f9). Kill switch
   without a deploy: set `MY_SUNDAY_ENABLED=0` (all My Sunday controls vanish;
   radar and lab are unaffected).
6. Update `release/last-production.json` per the release-module gate.
