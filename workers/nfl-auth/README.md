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

## Deploy

```powershell
cd C:\Workers\nfl-propbetedge-new
git pull
cd .\workers\nfl-auth
wrangler deploy
```

Production Worker URL:

```text
https://propbetedge-nfl-auth.sales-fd3.workers.dev
```

Health check:

```powershell
curl.exe https://propbetedge-nfl-auth.sales-fd3.workers.dev/health
```

Expected v5 markers:

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
