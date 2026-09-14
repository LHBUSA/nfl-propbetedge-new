# nfl-picks: premium model output is server-enforced

Found 2026-09-13: `GET /api/picks/pass?event_id=…` returned the full Pro passing
model with no credential on all three hosts below. Closed 2026-09-14.

| Host | Before | Now (anonymous or spoofed) |
| --- | --- | --- |
| `nfl-api.propbetedge.ai` (nfl-gateway custom domain) | 200, full model | 401 `nfl_pro_required` |
| `nfl-gateway.sales-fd3.workers.dev` | 200, full model | 401 |
| `nfl-picks.sales-fd3.workers.dev` | 200, full model | 401 |

## The boundary

`workers/nfl-picks/src/index.js` (production capture `24fd03dc` plus the gate):
for every path containing `/picks` (not `/health`), before any market read:

- secret `NFL_GATEWAY_TOKEN` unset -> `503 {"error":"model_access_unavailable"}` (fail closed)
- header `x-pbe-gateway-token` missing or not equal (constant-time digest compare)
  -> `401 {"error":"nfl_pro_required","entitlement":"nfl_pro"}`
- otherwise the unchanged model response

The gateway forwards the original request to `NFL_PICKS`, so one check covers
every host. Origin, Referer and cookies are never treated as authentication.

## Trusted callers (the only holders of the credential)

- `api/pro-model.js` (Vercel, env `NFL_GATEWAY_TOKEN`): the only browser-reachable
  path to the model. It checks the reader's NFL entitlement first (401 signed out,
  403 no qualifying purchase, 503 entitlement unavailable) and only then presents
  the credential server-side. A refused credential is reported as 503, never as a
  sign-in prompt.
- `nfl-prop-picks-orchestrator` (Worker secret `NFL_GATEWAY_TOKEN`), cron.

Browsers never hold it: `paywall.js` routes every client model read to
`/api/pro-model`. `tests/nfl-auth-model-boundary.test.mjs` fails if any client
file references the credential.

## Rotation

Generate a new value, set it on `nfl-picks`, `nfl-prop-picks-orchestrator` and
Vercel production (`NFL_GATEWAY_TOKEN`), then redeploy Vercel. During the short
window between the Worker and Vercel updates, Pro model reads answer 503.
