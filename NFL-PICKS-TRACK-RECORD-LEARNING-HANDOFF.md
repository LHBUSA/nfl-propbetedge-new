# PropBetEdge NFL Picks Engine — UI, Track Record, and Learning Contract

This file is part of the implementation definition-of-done for the NFL picks algorithm. It is not a future-ideas document.

## Product separation

Do not repurpose Model Lab. The current Model Lab remains the research/audit surface for market context, fair values, probabilities, uncertainty, missing inputs, and model provenance. The new Picks Engine is the decision surface.

Target product flow:

```text
Prop Board -> sportsbook market
Model Lab -> model analysis / fair value / probability / audit
PBE Picks -> official qualified champion decisions
Track Record -> immutable real-world outcomes and accountability
Learning Loop -> finalized graded observations -> challenger -> gated promotion
```

## Navigation

Add first-class routes near the top of Intelligence navigation once the backend read contracts exist:

```text
Dashboard
Games
Prop Board
PBE Picks       PRO
Track Record
Market Watch
Model Lab       PRO
Line Simulator
...
```

Do not reuse the existing `picks` route for PBE Picks if that route is still owned by Model Lab. Preserve the current Model Lab route contract and choose an unambiguous route such as `pbepicks` for the new Picks Engine.

## Server-gated read path

The browser must not call private algorithm workers using privileged credentials.

Use same-origin NFL endpoints in `nfl-propbetedge-new`:

```text
browser
  -> nfl.propbetedge.ai/api/...
  -> existing NFL Pro session / entitlement check
  -> picks read worker or persisted read model
```

Reuse the current server-side NFL Pro authority (`getNflSession()` / existing session contract). A free user must not receive proprietary pick JSON and merely have it hidden by JavaScript.

Do not invent a parallel frontend schema before the backend is built. Inspect the actual algorithm worker routes/responses and adapt the frontend to those contracts.

## Official pick contract

Every official PBE Pick is an immutable decision record created at issuance time. Persist, using the backend brief's existing names where already defined:

- pick ID
- event ID
- player / subject
- market
- side / selection
- sportsbook line at issuance
- price / odds at issuance
- sportsbook / source when available
- market consensus at issuance
- model probability
- market implied probability when calculated
- model edge / EV when calculated
- confidence / qualification state
- champion model version
- generation / publication timestamp
- required `features jsonb` snapshot
- source / provenance metadata

The required `features jsonb` snapshot must be present on every official pick. It is the historical record of what the algorithm knew at decision time.

Never overwrite the original pick line, odds, features, or model version because the market later changes.

## Champion / challenger product rule

Only the production champion may publish official PBE Picks.

Challenger output must never silently appear as an official customer-facing PBE Pick.

Expose engine governance only from factual backend state, for example:

```text
Production model: Champion vX
Challenger: Evaluating
Auto-tuner: GATED
Graded sample: 63 / 100
Minimum age: 2.4 / 4 weeks
```

The hard tuner gate remains mandatory:

```text
>= 100 finalized graded picks
AND
>= 4 weeks of observation
```

No bypass.

## PBE Picks UI

When supplied by the backend, an official pick card/detail may show:

- event / kickoff
- player
- prop market
- OVER / UNDER or applicable selection
- issued line
- current line if separately sourced
- sportsbook / best available book if supplied
- issued odds
- model probability
- market implied probability
- model edge / EV if actually calculated
- confidence / qualification state
- champion model version
- generated timestamp
- current status
- final grade / result when resolved

Never synthesize missing values. Show `—` or omit fields that the backend does not provide.

Add an expandable `Why this pick?` / `Model Audit` section that can show selected human-readable feature drivers, provenance, model/version, and issuance market state. Do not reconstruct historical features in the browser and do not dump internal raw JSON unnecessarily.

## Honest Picks Engine states

Distinguish:

```text
ENGINE LIVE — picks available
ENGINE LIVE — no qualified picks
ENGINE WAITING — upcoming slate not ready
ENGINE DEGRADED — source unavailable
ENGINE GATED — production gate prevents publishing
```

Backend failures must not be rendered as `no picks`.

A valid zero-pick slate should say plainly:

```text
NO QUALIFIED PBE PICKS
The engine is active. No current market has cleared the production decision threshold.
```

Never create fixture/demo/fake pick cards in production simply to populate the page.

## Free vs Pro

Signed-out/free users may see that the Picks Engine exists, but proprietary decision output is NFL Pro.

Do not leak player, selection, probability, model edge, or proprietary feature data before entitlement verification.

## Real-time track record

Build a first-class `Track Record` surface backed only by persisted official picks and factual results.

Every official published pick must eventually appear in Track Record. Losses cannot be deleted or hidden. The original issuance line cannot be changed after the outcome is known.

Useful factual filters include:

- Today
- This week
- Season
- market / prop category
- model version
- pending / live / final

Metrics may include only what can be reconciled exactly from persisted data:

- record
- wins
- losses
- pushes
- win rate
- units
- ROI
- average issued odds
- average model edge at issuance
- closing-line value when factual closing data exists
- calibration by probability bucket
- pending picks
- graded sample size

Always show sample size. Do not imply statistical significance from a tiny record.

## Real-time result state

While games are in progress, Track Record/PBE Picks may show factual live states when the live source actually supports the necessary stat:

```text
PENDING
LIVE
WINNING
LOSING
PUSHING
FINAL — WIN
FINAL — LOSS
FINAL — PUSH
```

Example presentation when supported:

```text
Josh Allen OVER 267.5 Passing Yards
Issued line: 267.5
Current stat: 221
Game: Q4 08:14
Status: LIVE
Needed: 47 yards
```

Do not fabricate live progress. Official grading happens only from finalized authoritative results.

## Immutable grading and corrections

The grader must be deterministic and idempotent.

Preserve an audit trail for:

- pick created
- features locked
- issuance market state
- live result observations
- official final result
- first grade
- authoritative correction/regrade
- model version
- training run
- challenger evaluation
- champion promotion/rejection

If an official-stat correction changes a pick result, retain an auditable correction event. Do not silently rewrite history.

## Closed-loop learning

The algorithm must learn from actual outcomes, but the production champion must not self-modify from partial live-game information.

Required conceptual loop:

```text
MAKE OFFICIAL PICK
  -> LOCK FEATURES AT DECISION TIME
  -> GAME PLAYS
  -> FINAL AUTHORITATIVE RESULT
  -> GRADE PICK
  -> CREATE FINALIZED LEARNING OBSERVATION
  -> TRAIN / CALIBRATE CHALLENGER
  -> EVALUATE CHALLENGER OUT OF SAMPLE
  -> PROMOTE ONLY IF ALL HARD GATES AND PERFORMANCE CRITERIA PASS
```

Every finalized graded pick becomes a supervised-learning observation using the immutable decision-time feature snapshot plus the official outcome.

Do not rebuild historical feature values using information that became known after issuance. That is look-ahead leakage.

Only finalized observations may enter challenger training. Live/provisional results may update UI state but may not update production model weights.

## Learning evaluation

Do not optimize only for raw win rate. Where applicable, challenger evaluation should consider:

- out-of-sample predictive performance
- calibration
- log loss / Brier score when probabilities are produced
- ROI using actual persisted issuance prices
- closing-line value when factual closing lines exist
- performance by market/category
- sample size / stability

The challenger must actually beat the configured champion criteria after the minimum gate. If it does not, the champion stays champion.

## Model version ledger

Every official pick must remain permanently attributable to the exact model version that generated it.

Track champion chronology, evaluation, and promotion events. Never recalculate old picks with a newer model and present those as historical live decisions.

## Verified live record vs backtest

Keep these separate:

```text
VERIFIED LIVE TRACK RECORD
vs.
HISTORICAL BACKTEST
```

Do not manufacture a customer-facing historical record from what the current model would have selected in the past.

The verified live record begins only when decisions were timestamped and persisted before outcomes were known. Backtesting may exist, but it must be labeled `BACKTEST` and must never be mixed into the verified live record.

## Cross-product UI integration

Once official picks exist, connect the rest of the NFL OS:

### Dashboard
- `Today's PBE Picks`
- qualified pick count
- pending/live/final counts
- highest-ranked opportunities only if backend supplies a valid ranking
- verified current/season track-record summaries from persisted data

### Games
- event card may show `PBE PICK` only when that event actually has a qualified champion pick
- CTA opens PBE Picks filtered to that event

### Prop Board
- matching player/market row may show `PBE PICK`
- click opens exact persisted pick/audit

### Model Lab
- add `View Qualified Picks`
- keep Model Lab itself as the analysis/audit surface, not the pick generator

Use existing `PBEEventSelector` event context where appropriate.

## Acceptance tests

Do not call the Picks/Track Record/Learning integration complete until automated or fixture acceptance coverage proves at minimum:

1. Free users cannot retrieve proprietary official pick payloads.
2. Pro user can retrieve current official champion picks.
3. UI pick output matches persisted database record exactly.
4. Every official pick has a non-null decision-time `features jsonb` snapshot.
5. Issuance line/odds/features/model version cannot be silently overwritten.
6. Challenger cannot publish as an official pick.
7. Tuner cannot promote before 100 finalized grades AND 4 weeks.
8. Zero-qualified-pick slate renders an honest empty state.
9. Backend/source degradation does not render as `no picks`.
10. Live stats may update display without finalizing a grade prematurely.
11. Final authoritative result grades deterministically.
12. Re-running grader is idempotent.
13. An authoritative correction creates an auditable regrade.
14. Losing picks remain in Track Record.
15. Track Record aggregates reconcile exactly to individual official picks.
16. ROI uses persisted issuance odds; never default all picks to -110.
17. Only finalized observations enter challenger training.
18. Future information cannot enter a historical decision-time feature snapshot.
19. Historical picks stay attributable to their original model version.
20. Backtests cannot be counted in the verified live record.
21. Games -> PBE Picks event context works.
22. Prop Board -> persisted pick detail works.
23. Hard reload retains NFL Pro access and the Picks Engine still loads correctly.
24. No random/demo/synthetic pick data exists in production paths.

## Definition of done

The NFL picks system is complete only when it forms a closed, auditable production loop:

```text
market intelligence
-> champion decision
-> immutable official pick
-> live factual tracking
-> final authoritative grade
-> verified track record
-> finalized learning observation
-> challenger training/evaluation
-> gated champion promotion
-> next production decision
```

The system must improve without rewriting its own history.
