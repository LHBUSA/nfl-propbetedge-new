# PBE Touchdown Targets — product and engineering contract

This file is part of the definition of done for Algorithm #3. It is not a
future-ideas document.

```text
factual football inputs
  -> PBE TD PROBABILITY MODEL        pbe-td-hazard-v1 (committed artefact)
  -> GAME RANKER / SELECTOR          pbe-td-selector-v1
  -> ONE PRIMARY TARGET PER GAME     locked before kickoff, immutable after
  -> OFFICIAL FINAL BOX SCORE
  -> GRADE                           deterministic, idempotent, correction-aware
  -> FINALIZED LEARNING OBSERVATION
  -> CHALLENGER                      trained weekly, publishes nothing
  -> GATED PROMOTION                 >=100 finalized AND >=4 distinct weeks
  -> next production decision
```

## The product rule

Every eligible game leaves the engine in exactly one recorded state, and never
in silence:

```text
PRIMARY TARGET     one named player, probability frozen, locked pregame
MODEL ABSTAIN      a reason code, with the pool the model evaluated
SOURCE DEGRADED    an upstream could not answer
```

`SOURCE DEGRADED` is deliberately a different outcome from `MODEL ABSTAIN`. A
broken market is not an opinion, it is excluded from the abstention rate, and a
tick where every game degraded is recorded as a degraded run. Turning a failed
source into "no target" is the single most dishonest thing this engine could do.

A game may additionally carry ONE SECONDARY target, which must clear a strictly
higher standard on the model's own number, on the edge against the market, and
on book depth. **The primary record is reported separately and is never
inflated by secondaries**, so "if PBE named one touchdown scorer in every game,
how often was it right?" always has an exact answer.

There is no rule anywhere that says snow means no pick. Weather is a feature and
reaches the decision only through the probability model.

## What a touchdown means here

```text
PBE TARGET RESULT = WIN  when the official final box score credits the selected
                         player with at least one RUSHING or RECEIVING
                         touchdown in that game.
```

* A quarterback's passing touchdowns are never his own score.
* A return or defensive touchdown is **not** part of the PBE result. It is read
  off the same box score and recorded on the grade
  (`non_offensive_td`, `settlement_note.book_settlement_may_differ`), because a
  book's anytime-touchdown rule may include it and we hold no book's rulebook.
  The divergence lives on the row as a fact instead of in an argument later.
* Absent from the final box score is a **LOSS**, with
  `participation: absent_from_final_box_score` recorded. A receiver who played
  every snap and was never thrown to may not appear in a box score, and neither
  may a healthy scratch; voiding both would quietly delete the misses.
* Only an explicit did-not-play flag voids a target.
* `PBE TARGET RESULT` and `BET SETTLEMENT / ROI` are reported as separate
  things. ROI is one unit risked at the price frozen at issuance. A target with
  no persisted executable price contributes no units and no ROI — never a
  default, never `-110`.

## The probability model — pbe-td-hazard-v1

Estimates `P(player scores >=1 offensive touchdown | pregame information)`.

```text
lambda = blended per-game touchdown rate
         x red-zone role
         x team scoring environment
         x opponent concession
         x game script
         x weather

p       = 1 - exp(-lambda)                         Poisson, at least one
p_cal   = logistic(a + b * logit(p))               fitted out of sample
```

* **Blended rate** — the player's own recency-weighted rate (10-game half-life),
  the current season's observed rate, and a position + red-zone-tier prior,
  combined by their own weights with a six-game shrinkage strength. This is what
  stops a player who scored twice last week from being crowned.
* **Every multiplier is a measured ratio damped by a weight selected on a
  held-out season**, and reports whether its input existed. A component with no
  factual input contributes exactly 1 and says `available: false`.
* **The market is not an input to the probability.** A de-vigged
  anytime-touchdown price is recorded in every snapshot, drives edge, EV and the
  qualification gate, and is available to a future challenger. The champion's
  number is generated from football alone, so "PBE probability" can never be
  the sportsbook's probability wearing our name.

### Inputs, and what is genuinely available

Compiled by `scripts/build-td-model-v1.mjs` from the four Player DNA datasets
this site already serves (`data/dist/{rb,wr,te,qb}-dna-dataset.json`), 2019–2025
regular season. **No new data source and therefore no new rights exposure**; the
dataset-level rights position is
`docs/career-ledger/SOURCE_RIGHTS_AND_RECONCILIATION_AUDIT.md`. Nothing reads
`data/nflverse/*.parquet`.

| Family | Feature | Available | Note |
|---|---|---|---|
| Player | season + recent TD rate, rushing / receiving split, games | YES | recency-weighted, shrunk |
| Player | red-zone opportunities per game, red-zone TD conversion | YES | RB carries, WR/TE targets |
| Player | red-zone target share | WR / TE only | RB has no team red-zone-carry denominator, so the share is withheld rather than estimated |
| Player | position, role tier | YES | tier from population terciles |
| Player | current-season TD rate | leader boards only | see below |
| Player | availability / injury status | YES | nfl-intel reported designations |
| Player | snap / route / target share | NO | not in a production source for this lane |
| Team | offensive TDs per game, rush/pass TD mix | YES | DNA cohort; ratio is meaningful, the absolute is not a team total |
| Opponent | rushing / receiving TDs allowed per game | YES | same cohort discipline |
| Game | spread, game script | YES | fitted, strong and monotone |
| Game | total, implied team total | RECORDED, NOT CONSUMED | the DNA rows carry a spread but no game total, so there is no historical sample to fit a total term on without inventing one |
| Game | roof, temperature, wind | YES | open-air games with a forecast only |
| Game | precipitation | NO | `rn` and `sn` are present in all 23,000 REG rows and 0 in every one; that is an unpopulated source, not a league with no rain |
| Market | anytime-TD prices, de-vigged consensus, book count, disagreement | YES | edge / EV / gate only |
| Market | closing price, CLV | YES | pre-kick tape in `nfl_prop_closing_snapshots` |

**Current-season layer.** `nfl-current` serves one player per request out of a
whole-season accumulator; reading it per candidate would mean hundreds of
re-parses of that accumulator in one scheduled invocation. The lane therefore
reads `/api/current-stats` **once per tick** and takes the layer from the
published rushing and receiving leader boards. A player outside them has **no**
current-season layer, recorded as unavailable with its reason. That is a smaller
sample, not a zero: his weight is 0 and his historical baseline and prior carry
the estimate, which is the correct treatment of an absent observation.

### Fitted state (shipped artefact)

Weights selected on 2024, holdout scored **once** on 2025 with the weights
fixed:

```text
weights            role 0.15 · team 0 · opponent 0 · script 1 · weather 1
calibration        a = -0.513984   b = 0.648859
train (<=2024)     n = 21,095   base .2258   brier .1631   log loss .5028
holdout (2025)     n =  4,353   base .2192   brier .1579   log loss .4899
base-rate ref                                brier .1712   log loss .5260
by position        QB .1199 · TE .1422 · WR .1591 · RB .1854 (brier)
```

The team and opponent damping weights are **0**: on a held-out season neither
improved log loss, largely because a player's own shrunk rate already carries
his team's scoring. They are measured and recorded in every snapshot so a
challenger can earn them, and no card shows a driver chip for a component the
champion does not move on. This is reported rather than hidden.

`calibration` is a **HISTORICAL BACKTEST** (`research/td-model-v1-backtest.json`)
and is never presented as the verified live record.

## The selector — pbe-td-selector-v1

Separate file from the probability model so either can improve alone.

```text
eligible pool   every player the anytime-TD market actually prices, with a
                resolvable identity and a non-null PBE probability
rank            calibrated probability, then edge, then book depth
primary         rank 1, subject to the publication floors
secondary       optional, strictly higher bar, never more than one
```

Publication floors (the promoted selector row's `config` overrides every one):
`primary_min_prob .22`, `secondary_min_prob .30`, `secondary_min_edge .03`,
`min_books 2`, `max_publishable_prob .92`, `availability_abstain_share .6`,
`replace_min_prob_gap .025`.

Abstention reasons: `no_credible_scorer_probability`,
`extreme_low_scoring_environment`, `widespread_availability_uncertainty`,
`identity_unresolved`, `model_integrity_guard`, `no_eligible_scoring_pool`.
Degradation reasons: `market_snapshot_unavailable`, `market_snapshot_stale`,
`model_artefact_unavailable`, `current_slate_unavailable`.

Identity is resolved only through the artefact's own name index, which was built
with ambiguous names **removed**. Two players who share a normalised name
resolve to nobody and the game reports `identity_unresolved` rather than
guessing which one a book meant.

### Replacement

Targets may evolve while a game is still pregame. A newcomer takes over only
when the model prefers him by more than `replace_min_prob_gap`, or when the
incumbent has become unpublishable. Both states survive: the superseded row
keeps every field it was published with, the replacement names what it replaced,
and an audit event records the reason and both probabilities. **Nothing changes
after kickoff** — the orchestrator will not, and the database will not.

## Publication scope, and what "tracking" means

`promoted = true, trained = false` on the seeded champion:

* **promoted** — the only row allowed to publish. A challenger is inserted
  unpromoted and cannot publish even for the minutes between training and
  evaluation.
* **trained** — the selector's learning stage has not been fitted, because no
  finalized outcomes exist yet. The existing
  `nfl_prop_picks_official_requires_trained` trigger therefore holds today's
  issuance at `publication_scope = 'tracking'`.

**A tracking target is not a lesser prediction and it is not a backtest.** It is
generated by the champion, named before kickoff, frozen, graded from the
official result and kept forever: a VERIFIED LIVE record. It is simply a
*separate* record from the official one. The two are never merged and never
relabelled. Issuance becomes `official` only when the hard gate trains and
promotes a touchdown selector.

## The learning loop

The committed artefact is never edited by the loop. What the loop produces is an
**override**: a logistic model over the exact feature vector frozen at issuance,
including the artefact's own probability as a feature. `model_prob` inside that
vector is always the artefact's number, so promoting an override cannot change
what the training data means.

`is_primary` is recorded on every observation but is deliberately **not** an
override input: whether a candidate becomes the primary is decided after his
probability, so feeding it back would ask the model for a number it needs in
order to exist.

Hard gate, not relaxed because touchdown targets produce observations faster —
a fast denominator is exactly when a lucky numerator is most convincing:

```text
>= 100 finalized observations AND >= 4 distinct weeks
```

Promotion requires **every** criterion, each named in the verdict:

1. hard gate open
2. holdout at least 20 rows (chronological, newest 20%)
3. holdout log loss at least 1% better than the champion's
4. holdout Brier no worse by more than 0.002
5. calibration: worst populated probability bucket within 0.10
6. week stability: no week with an adequate sample got worse
7. probability-bucket stability: same test by probability band

**ROI is computed, reported, and is not a promotion criterion.** A short run of
long-priced winners is the easiest thing in this product to mistake for skill.

There is no HTTP train route and no HTTP promote route. Promotion happens inside
a scheduled invocation through `nfl_promote_prop_selector`, which demotes the
incumbent and promotes one already-trained candidate under an advisory lock,
keyed on `market` — so a touchdown selector can never become the passing-yards
champion and vice versa.

## Database

`migrations/nfl_td_targets_binary_market_v1.sql`, additive.

Reused because it is market-neutral and already hardened: immutable issuance,
the append-only SHA-256 receipt chain, the audit ledger, publication scope, the
grade table, finalized learning observations, the closing tape, and the
one-promoted-selector-per-market index.

New:

* `nfl_prop_market_is_binary(text)` — one definition of "binary", called by five
  constraints so they cannot drift apart.
* `nfl_prop_pick_continuous_projection` — the v1 requirement for
  `market_line`, `model_fair_line` and `predictive_sd` now binds **non-binary
  markets only**. Nothing about passing yards is relaxed.
* `nfl_prop_pick_binary_contract` — a binary row must carry YES/NO, a model
  probability and a market probability, and must carry **none** of the
  continuous fields. `market_line = 0.5` cannot be written in to satisfy an old
  shape.
* `target_rank` — `primary` / `secondary`, required for binary markets and
  forbidden for continuous ones, plus a partial unique index making two open
  primaries per event impossible rather than merely unlikely.
* `nfl_prop_pick_binary_issued_pregame` — `created_at < kickoff_ts`. Because
  `created_at` is frozen by the issuance trigger, a row that satisfies this on
  insert satisfies it forever.
* `nfl_td_no_withdrawal_after_kickoff` — grading is the only status change a
  kicked-off game may make.
* `nfl_td_slate_evaluations` (append-only) + `nfl_td_final_pregame_evaluation`
  (the last pregame decision per game) — the denominator of coverage and
  abstention, and the reason no game can be silently omitted.
* `nfl_replace_open_td_target` — a **new** function, so the passing-yards RPC
  keeps its exact signature and behaviour.
* Grade columns `result_definition`, `non_offensive_td`, `settlement_note`.

The receipt payload gains `target_rank` **additively**: a passing-yards row has
`target_rank` NULL and therefore produces a byte-identical payload, the same
`payload_sha256` and the same chain arithmetic as before, so the existing chain
stays verifiable.

## Services

| Lane | Cron | Job |
|---|---|---|
| `nfl-touchdown-targets-orchestrator` | `*/15 * * * *` | decide every game in the window; game-state-aware cadence |
| `nfl-touchdown-targets-grader` | `*/15 * * * *` | settle from official final box scores only |
| `nfl-touchdown-targets-tuner` | `20 9 * * TUE` | train, evaluate, and promote only through the gate |

A separate lane rather than an extension of `nfl-prop-picks-orchestrator`: the
passing-yards engine is in production and a binary market has a different
decision shape and failure surface. Market-neutral code is shared, never copied.

Inputs are all persisted-snapshot reads through service bindings —
`nfl-current`, `nfl-odds`, `nfl-intel` — and **no lane contacts a paid
provider**. The probability model is bundled, not fetched: a decision must never
depend on a network read of its own brain.

All three lanes are registered in the durable run ledger
(`workers/nfl-picks-engine-shared/runs.mjs`) and reported under their own
`overall_touchdown` verdict, so a brand-new lane cannot make the game-picks
engine report degraded.

## API

`/api/pbe-touchdown-targets`, same origin, server gated.

| View | Access | Contents |
|---|---|---|
| `state` | public | governance, engine health, coverage and abstention counts. No player, no probability, no price. |
| `current` | NFL Pro | this week's game cards: named target, PBE probability, market, drivers |
| `week` | NFL Pro | the same, for `?season=&week=` |
| `trackrecord` | public | **graded** history only; open targets are excluded by the query |
| `model` | public | the artefact's provenance and backtest; never the per-player baselines |

A free browser cannot receive a live target in JSON and have it hidden by
JavaScript afterwards: `current` and `week` refuse before they read a row. The
entitlement authority is the existing `getNflSession()`.

States: `ENGINE LIVE — TARGETS AVAILABLE`, `ENGINE LIVE — SLATE EVALUATED`,
`ENGINE WAITING — UPCOMING SLATE NOT READY`,
`ENGINE DEGRADED — SOURCE UNAVAILABLE`,
`ENGINE GATED — MODEL VALIDATION IN PROGRESS`, plus `MODEL ABSTAIN` per game.
Health dominates publication: an engine that is not running never says it
evaluated the slate.

## Surfaces

* **`#tdtargets`** — `touchdown-targets-v1.{css,js}`, first-class navigation
  entry `TOUCHDOWN TARGETS · NEW · PRO`, and the **one** client owner of the
  endpoint. Four surfaces cost one request.
* **Track Record** — a category switcher above the existing tabs:
  `GAME PICKS` / `TOUCHDOWN TARGETS` / `PLAYER PROPS`. Three separate records,
  three separate endpoints; a touchdown result never enters the game-pick
  numerator or denominator.
* **Dashboard** — a compact rail inside the command centre's `intel` slot,
  which already owns that region and already has a scoped observer.
* **Games** — `PBE TD TARGET <player>` on a card, only when a target exists for
  that ESPN event.
* **Prop Board** — `PBE PRIMARY / SECONDARY TARGET` on the anytime-touchdown
  row, only for the event on the board, only once the official prediction
  exists.

Player photos are requested by ESPN athlete id only. A name-based image lookup
can return a different person's face, so the module has no path to one.

## Verified live record vs backtest

```text
VERIFIED LIVE TRACK RECORD        targets timestamped and locked before kickoff
HISTORICAL BACKTEST               research/td-model-v1-backtest.json
```

Never mixed, and the backtest names itself as one everywhere it is served.
Losses cannot be deleted, the issued price cannot be rewritten, and no
historical target is ever re-scored with a newer model and shown as a live
decision.

## Acceptance

`node --test tests/nfl-td-targets.test.mjs` — 44 tests covering the thirty
numbered requirements plus the behaviour the spec describes around them.

## Bring-up runbook

Source is on `main`. The frontend and `/api/pbe-touchdown-targets` are live and
degrade honestly until the steps below are done: `view=state` reports
`engine_health: STALE` with its three lanes `UNKNOWN`, and `view=trackrecord`
returns 503 because `target_rank` does not exist yet.

**Order matters.** Do not deploy the Workers before the migration: the
orchestrator fails closed on a missing promoted selector and would write failed
runs into the durable ledger.

```bash
REPO=D:/Workers/nfl-data-harvest
EXPORT=$(mktemp -d) && git -C "$REPO" archive HEAD | tar -x -C "$EXPORT"

# 1 ── schema. Supabase project tkmlnhmylqnttmnsnief (NFL + UFC share it).
#      Rollback: migrations/nfl_td_targets_binary_market_v1_rollback.sql
#      It refuses once any touchdown target has been published.
psql "$NFL_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f "$REPO/migrations/nfl_td_targets_binary_market_v1.sql"

# verify: one promoted, untrained touchdown selector and an empty ledger
psql "$NFL_SUPABASE_DB_URL" -c "
  select version, market, projection_model, promoted, trained
    from nfl_prop_selector_models where market = 'player_anytime_td';
  select count(*) from nfl_td_slate_evaluations;
  select count(*) from nfl_prop_picks where target_rank is not null;"

# 2 ── the three lanes. Each needs the service-role key and nothing else.
for w in nfl-touchdown-targets-orchestrator \
         nfl-touchdown-targets-grader \
         nfl-touchdown-targets-tuner; do
  (cd "$EXPORT/workers/$w" \
    && wrangler secret put SUPABASE_SERVICE_ROLE_KEY \
    && wrangler deploy)
done

# 3 ── canaries
for w in nfl-touchdown-targets-orchestrator \
         nfl-touchdown-targets-grader \
         nfl-touchdown-targets-tuner; do
  curl -s "https://$w.sales-fd3.workers.dev/health" | jq '{service,version,health,requirements}'
done
curl -s https://nfl-touchdown-targets-orchestrator.sales-fd3.workers.dev/v1/engine/state | jq
curl -s https://nfl-touchdown-targets-orchestrator.sales-fd3.workers.dev/v1/engine/model | jq '.calibration.holdout'
curl -s https://nfl-game-picks-orchestrator.sales-fd3.workers.dev/v1/engine/runs \
  | jq '{overall, overall_props, overall_touchdown}'
curl -s "https://nfl.propbetedge.ai/api/pbe-touchdown-targets?view=state" | jq '{engine_health, publication, coverage}'
```

What a healthy first slate looks like, after one cron tick inside the horizon:

* every lane `/health` reports `HEALTHY` with all `requirements` true;
* `overall` and `overall_props` are unchanged at `HEALTHY`, `overall_touchdown`
  becomes `HEALTHY`;
* the orchestrator's last work record carries
  `counts.games_evaluated == counts.targets_issued + counts.abstained + counts.degraded`,
  with `abstained` small and every reason named;
* `view=state` reports `coverage.games_evaluated` equal to the number of games
  in the window and an `abstention_rate` computed only over decidable games;
* `view=current` still refuses without an NFL Pro session, and returns game
  cards with one primary target each for a Pro session.

`nfl-game-picks-orchestrator` was redeployed for the per-engine health verdict.
Rollback version: `15345e9d-6144-4d41-8b35-c58035481adb`.

## Production launch record — 2026-09-26 (owner-approved)

- Root cause of "ENGINE DEGRADED — SOURCE UNAVAILABLE": the lane was never brought up. The three
  Workers did not exist on Cloudflare (10007) and `nfl_td_targets_binary_market_v1.sql` was not
  applied, so `nfl_prop_picks.target_rank` did not exist and `view=trackrecord` 503'd. Vercel's
  `SUPABASE_SERVICE_ROLE_KEY` was present (`view=state` answered 200); `service_secret_missing`
  was only ever seen on secret-less previews.
- Migration applied in one transaction via the Supabase Management API. Proven identical
  before/after: 45 pass_yds rows (full-row hash), 45 grades, all 45 receipt hashes and the chain;
  every legacy receipt payload re-derived with the NEW receipt function reproduces its stored
  SHA-256; `nfl_replace_open_prop_pick` unchanged. Pre-migration shared function definitions are
  archived at `D:\Workers\nfl-td-pre-migration-shared-functions-2026-09-26.sql`.
- `migrations/nfl_td_targets_rpc_grants_v1.sql` applied right after: anon/authenticated could
  EXECUTE the SECURITY DEFINER `nfl_replace_open_td_target` (Supabase default role grants survive
  `revoke ... from public`). Now service_role only.
- Workers deployed from a clean export of main 0c1ee9f: grader 7e2acad0, tuner af57fbc6,
  orchestrator 42878d12 (first deployed with cron disabled for pre-publication checks, then armed).
- First tick 2026-09-26T00:30Z: 14 games in the 60 h horizon, 14 primary + 7 secondary targets,
  0 abstained, 0 degraded, all TRACKING scope, 0 issued after kickoff, 0 duplicate primaries.
  PHI @ CHI (MNF) enters the horizon on a later tick. ATL @ GB (final 09-24) was not backfilled.
- Rollback is forward-fix only: the supplied rollback script refuses while any TD target exists.
