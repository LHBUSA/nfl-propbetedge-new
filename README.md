# PropBetEdge NFL — Additive Redesign

This repository is the isolated redesign workspace for the existing PropBetEdge NFL product.

## Baseline

The product intentionally starts from the live NFL v5.5.33 experience rather than replacing it. The existing dashboard, sidebar navigation, Picks Engine, PropChain, team pages, standings, season encyclopedia, Hall of Fame, records, Super Bowl history and mobile navigation remain part of the product.

## What is being added

A first-class **Prop Board** is added to the Intelligence section using the rebuilt NFL gateway:

- `https://nfl-api.propbetedge.ai/api/odds/board`
- `https://nfl-api.propbetedge.ai/api/picks/pass`

The current live Prop Board accepts at most **5 player markets per request**, so the frontend requests the 10 launch markets in two batches of five and merges them client-side.

## Truth contract

- `LIVE` = genuine current authorized provider data.
- `MODEL` = PropBetEdge model output.
- `UNAVAILABLE` = required data/input is unavailable.
- Synthetic/demo content is never relabeled as live.

The legacy PBEcast badge is relabeled `BETA` in this redesign until its transport is reconnected to verified live play-by-play.

## Deployment isolation

Vercel project: `nfl-propbetedge-new`

This workspace is separate from MLB and from the existing `nfl-real` production project. The purpose is to improve the current NFL product safely before any future domain promotion.

Current redesign baseline commit: `8153a583`.
