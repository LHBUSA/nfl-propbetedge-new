# NFL paywall and Best Line props: rollout order

Branch `p0-bestline-props-paywall-v1`. None of these steps has been run. Each one
touches production and needs the owner's approval before it runs.

## Why the order matters

- The browser currently reads `https://nfl-api.propbetedge.ai` directly. After
  the frontend deploy it reads `/api/gw/...` on nfl.propbetedge.ai instead. That
  route checks the session and the NFL entitlement, then calls the gateway with
  `NFL_GATEWAY_TOKEN`.
- The gateway only becomes a lock once `REQUIRE_GATEWAY_TOKEN = "true"`. Four
  engine Workers call it server-to-server: nfl-game-grader,
  nfl-game-picks-orchestrator, nfl-prop-picks-orchestrator and nfl-odds-snapshot.
  The source for the first three now sends the token when `NFL_GATEWAY_TOKEN` is
  set. nfl-odds-snapshot declares `NFL_GATEWAY` but never calls it.
- If the gateway is locked before the Vercel route and those Workers have the
  token, the site and the pick engines both go dark.

## Order

0. **Query the entitlement data (read-only).** Before any deploy, run this in the
   Supabase SQL editor on `tkmlnhmylqnttmnsnief`. It lists the rows that grant
   access today but will not under the new predicate. These are the customers
   who will lose access:

   ```sql
   select customer_email, status, stripe_price_id, stripe_subscription_id,
          stripe_customer_id, stripe_checkout_session_id, current_period_end, created_at
   from public.nfl_subscriptions
   where status in ('active','trialing')
     and (current_period_end is null or current_period_end > now())
     and not (
       ( stripe_price_id in ('price_1U9QUZF3CaVzg4OR3QNfwWCS','price_1UEWAOF3CaVzg4ORjkWpwOz9','price_1UEWAXF3CaVzg4ORGlsgboLq')
         and stripe_subscription_id like 'sub\_%' and stripe_customer_id like 'cus\_%'
         and current_period_end is not null and current_period_end > now()
         and current_period_end <= now() + interval '45 days' )
       or
       ( stripe_price_id = 'price_1U9oVzF3CaVzg4ORnk5NiJFA' and status = 'active'
         and stripe_checkout_session_id like 'cs\_%' and stripe_subscription_id is null
         and current_period_end is not null and current_period_end > now()
         and current_period_end <= '2027-02-15T05:59:59Z' )
     )
   order by created_at desc;
   ```

   Rows are never deleted. If a real paying customer shows up here, repair their
   row from Stripe (subscription id, customer id and period end) before step 3.

1. **Deploy the nfl-odds Worker** (`workers/nfl-odds`, v3.1.0-snapshot). Capture
   the current version id as the rollback first. Reads stay provider-free. The
   first ingest after the deploy promotes the previous batch's pre-game boards
   into `odds:v1:props-verified:*`.
   - Verify: `GET /api/odds/prop-coverage` returns `semantics: PLAYER_PROP_COVERAGE`.
   - Verify: a kicked-off game's `/api/odds/board` returns
     `LAST_VERIFIED_PREGAME_SNAPSHOT` with the capture's own `captured_at`.

2. **Create the gateway token** (a random 32+ byte secret) and store it outside
   Git under `D:\Workers\secrets\`. Set it as `NFL_GATEWAY_TOKEN` in:
   - the Vercel project `nfl-propbetedge-new` (Production and Preview)
   - `wrangler secret put NFL_GATEWAY_TOKEN` for nfl-gateway, nfl-game-grader,
     nfl-game-picks-orchestrator and nfl-prop-picks-orchestrator

   Setting the secret alone changes nothing: the gateway is not enforcing yet,
   and the three engine Workers keep running their deployed code, which does not
   send the token.

3. **Merge the branch** so the frontend and the Vercel API deploy. From this step,
   anonymous and non-subscribed visitors see the wall, and every paid
   `/api/*` route answers 401/403/503.
   - Run `node scripts/nfl-paywall-live-canary.mjs https://nfl.propbetedge.ai`.
     It checks the negative-access responses; it never signs in.
   - Run the Pro canary with the real passwordless flow (`PBE_PRO_EMAIL`).

4. **Deploy the three engine Workers** from this source so they send the token.
   Respect each Worker's own release rules; the picks engine needs an approved
   comparison first. Then set `REQUIRE_GATEWAY_TOKEN = "true"` in
   `workers/nfl-gateway/wrangler.toml` and deploy the gateway. Capture rollback
   ids for every Worker.
   - Verify: `curl https://nfl-api.propbetedge.ai/api/best-line` returns 401.
   - Verify: `/api/gw/api/best-line` returns 200 for a subscriber.
   - Verify: the engines' next runs are healthy.

5. **Close the remaining direct origins.** Owner decision, not in this branch.
   The Workers behind the gateway still answer on their `*.workers.dev`
   hostnames: nfl-odds, nfl-intel, nfl-replay, nfl-current (frozen), nfl-picks
   and nfl-schedule (source not in this repo). Close each one with
   `workers_dev = false`, or with the same token check. First move anything that
   calls a workers.dev URL, such as the nfl-odds manual ingest.

## Known residuals

- `/api/nfl-live` stays public. It is an ESPN relay, and the frozen nfl-current
  Worker (`?range`, `?standings`, `?event`) and nfl-prop-picks-grader
  (`?event`) depend on it.
- Static JS bundles are public, as in any SPA. The data behind them is not.
- `scripts/recovery-browser-smoke.mjs` runs against live production APIs.
  After step 3 it needs an entitled session. It now boots the workspace with a
  stubbed browser-side verdict and sends paid reads to the local API harness;
  see that script's header.
