# nfl-picks: the model Worker is reachable without the gateway

Found 2026-09-13 during post-release hardening. **Enforcement is on hold** until
the P0 NFL paywall work (`p0-bestline-props-paywall-v1`) lands; it owns the
entitlement architecture and the canonical service credential.

## Exposure (measured 2026-09-13, no credentials)

| Host | `GET /api/picks/pass?event_id=…` |
| --- | --- |
| `nfl-api.propbetedge.ai` (nfl-gateway custom domain) | 200, full passing model |
| `nfl-gateway.sales-fd3.workers.dev` | 200, full passing model |
| `nfl-picks.sales-fd3.workers.dev` | 200, full passing model |

A lock in `nfl-gateway` covers the first two. The third bypasses the gateway
entirely: `nfl-picks` has `workers_dev` enabled and its handler answers every
path containing `/picks` with no check.

## Callers (30-min production tail of nfl-picks, 18:31-19:01Z)

Only `nfl-prop-picks-orchestrator` (cron, via the gateway). Browser model reads
go through `api/pro-model.js`, which calls the gateway server-side.

## Source

`workers/nfl-picks/src/index.js` is production version `24fd03dc` captured
verbatim; a dry-run build reproduces the deployed bundle.

## Intended change once P0 lands (Worker only, P0's credential contract)

In `nfl-picks` `fetch`, before `buildPassModel`, for any path containing
`/picks` (not `/health`):

- secret unset -> `503 {"error":"model_access_unavailable"}` (fail closed)
- header missing or not equal (constant-time) -> `401 {"error":"nfl_pro_required","entitlement":"nfl_pro"}`, no market read
- otherwise the unchanged response

Header and secret name: **whatever P0 selected** — its tree uses
`x-pbe-gateway-token` / `NFL_GATEWAY_TOKEN`. The gateway already forwards the
original request (and its headers) to `NFL_PICKS`, so a request that passed the
gateway lock arrives carrying it. Same value as the gateway secret; no second
scheme. Canary it at 10% after P0's consumers send the header, verify
anonymous 401 on all three hosts and 200 for credentialed callers, then 100%.

## Inert leftovers from the paused attempt (safe to keep or remove)

- `nfl-prop-picks-orchestrator` `d10f6606` (rollback `954997c3`): sends
  `Authorization: Bearer PICKS_MODEL_TOKEN`; nothing checks it; tail shows the
  value REDACTED. Superseded when P0 deploys its orchestrator.
- Vercel production env `NFL_PICKS_MODEL_TOKEN`: read by no deployed code.
