# PropBetEdge NFL

Clean-room NFL prop intelligence frontend for PropBetEdge.

## Product contract

- `LIVE` = current authorized sportsbook/provider data.
- `MODEL` = PropBetEdge model output with explicit provenance.
- `UNAVAILABLE` = required source/input is not available.
- No synthetic data is presented as live.
- No hardcoded current picks or random betting metrics.

## Current data plane

Frontend -> `https://nfl-api.propbetedge.ai`

- `/api/odds/board` — normalized sportsbook Prop Board.
- `/api/picks/pass` — PBE passing model.

The Prop Board enforces a maximum of 8 requested player markets per call. The frontend preserves that backend guardrail by splitting the 10 launch markets into multiple requests and merging the factual responses client-side.

## Launch markets

Passing yards, completions, attempts, touchdowns, interceptions, receiving yards, receptions, rushing yards, rush attempts, anytime TD.

## UI direction

A football intelligence command center, not an encyclopedia. Props and market quality lead the experience. Other modules fail closed until their factual data services are production-ready.
