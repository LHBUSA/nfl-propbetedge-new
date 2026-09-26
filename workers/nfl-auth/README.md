# PropBetEdge NFL Auth Worker

Canonical passwordless access service for `nfl.propbetedge.ai`.

## Production flow

New purchase:

`email -> Stripe Checkout -> paid return -> Resend access email -> signed PropBetEdge session -> NFL Pro entitlement`

Existing subscriber / internal owner:

`email -> Resend sign-in link -> signed PropBetEdge session -> NFL Pro entitlement`

The Worker does **not** use Supabase Auth magic links. It signs its own short-lived access links and 30-day secure session cookie. Supabase is used only as the NFL entitlement store (`nfl_subscriptions`).

## Required Worker secrets

```powershell
cd workers\nfl-auth
wrangler secret put RESEND_API_KEY
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

No `RESEND_FROM_EMAIL` secret is required. The Worker deliberately uses the existing verified PropBetEdge sender:

```text
PropBetEdge Picks <picks@propbetedge.ai>
```

## Deploy (committed source only)

`propbetedge-nfl-auth` must be deployed **from committed, pushed source on `main`**, never from a local
working tree. On 2026-09-26 an audit could not tell whether production matched the repo because
versions carried no commit; every version is now tagged with its git commit and recorded in
[`DEPLOYMENTS.md`](./DEPLOYMENTS.md).

```bash
# from the repo root, on a clean main that is pushed
node scripts/deploy-nfl-auth.mjs      # refuses dirty inputs or unpushed HEAD; uploads a version tagged <sha> (preview only)
# canary the preview URL it prints: /health, POST /v1/auth/request validation, invalid-token exchange
cd workers/nfl-auth && npx wrangler versions deploy <version-id>@100% --message "git <sha>" -y
# append the printed receipt line (+ rollback version) to DEPLOYMENTS.md and commit it
```

Parity check (does production equal a commit?): bundle the commit with
`npx wrangler deploy --dry-run --outdir <dir>` and diff `<dir>/index-v5.js` against the deployed module
(Cloudflare API `workers/scripts/propbetedge-nfl-auth/content/v2`). Compare bundles, not raw source:
esbuild reformats and inlines `api/_nfl-entitlement*.js`.

Production Worker URL:

```text
https://propbetedge-nfl-auth.sales-fd3.workers.dev
```

Health check:

```powershell
curl.exe https://propbetedge-nfl-auth.sales-fd3.workers.dev/health
```

Expected markers (current version in `src/index-v5.js` `VERSION`):

```json
{
  "ok": true,
  "service": "propbetedge-nfl-auth",
  "version": "v5.0",
  "auth_issuer": "propbetedge",
  "session": "signed_worker_cookie",
  "entitlement_store": "supabase_nfl_subscriptions",
  "email_transport": "resend",
  "sender": "PropBetEdge Picks <picks@propbetedge.ai>"
}
```

## Endpoints

- `GET /health`
- `POST /v1/auth/request` `{ "email": "user@example.com", "purpose": "signin" }`
- `POST /v1/auth/request` `{ "email": "user@example.com", "purpose": "purchase" }`
- `GET /v1/auth/verify?token=...`
- `GET /v1/auth/session`
- `POST /v1/auth/logout`

The customer-facing email transport is Resend only. There is no Supabase email fallback.
