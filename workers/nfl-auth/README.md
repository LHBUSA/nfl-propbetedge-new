# PropBetEdge NFL Auth Worker

Canonical auth-mail orchestration for `nfl.propbetedge.ai`.

## Responsibilities

- Accept passwordless email sign-in requests for the NFL product.
- Ask Supabase Auth to issue the secure sign-in action link.
- Send the customer-facing branded email through Resend.
- Enforce the NFL production origin.
- Expose a non-secret `/health` endpoint.
- Keep Supabase as identity/session authority and Resend as the only mail transport.

## Required Worker secrets

Set these with Wrangler. Never commit secret values.

```powershell
cd workers\nfl-auth
wrangler secret put RESEND_API_KEY
wrangler secret put RESEND_FROM_EMAIL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

`RESEND_FROM_EMAIL` should be the verified Resend sender, for example:

```text
PropBetEdge NFL <noreply@propbetedge.ai>
```

## Deploy

```powershell
cd workers\nfl-auth
wrangler deploy
```

Wrangler will print a URL similar to:

```text
https://propbetedge-nfl-auth.<account-subdomain>.workers.dev
```

Verify health:

```powershell
curl.exe https://propbetedge-nfl-auth.<account-subdomain>.workers.dev/health
```

Expected shape:

```json
{
  "ok": true,
  "service": "propbetedge-nfl-auth",
  "auth_issuer": "supabase",
  "email_transport": "resend",
  "fallback": false
}
```

## Vercel handoff

Add the Worker base URL to the `nfl-propbetedge-new` Vercel project:

```text
NFL_AUTH_WORKER_URL=https://propbetedge-nfl-auth.<account-subdomain>.workers.dev
```

Then redeploy production. `/api/auth-email` will use the Worker as the upstream auth service while preserving same-origin browser requests.

## Endpoints

- `GET /health`
- `POST /v1/auth/email` with JSON `{ "email": "user@example.com" }`

The Worker intentionally has no Supabase-delivery fallback.
