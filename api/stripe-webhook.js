/* PropBetEdge NFL — Stripe webhook
 *
 * Ordering is deliberate and must not be rearranged:
 *   1. verify signature against the RAW body
 *   2. if event_id is already in nfl_stripe_webhook_events -> 200 duplicate
 *   3. apply the entitlement mutation (idempotent upsert / guarded patch)
 *   4. only on success, record event_id in the ledger
 *   5. 200
 *
 * The ledger has no processing/failed state, so recording before the mutation
 * would turn a failed write into a permanent entitlement loss: Stripe's retry
 * would short-circuit on the duplicate id. Recording after means a crash
 * between 3 and 4 replays the mutation, which is safe because every mutation
 * here is idempotent.
 */

import Stripe from 'stripe';

export const config = { api: { bodyParser: false } };

const SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';

/* CHECK constraint on nfl_subscriptions.status */
const ALLOWED_STATUS = new Set([
  'incomplete', 'incomplete_expired', 'trialing', 'active',
  'past_due', 'canceled', 'unpaid', 'paused'
]);

function sbHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json; charset=utf-8',
    accept: 'application/json'
  };
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function sbFetch(path, init = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...sbHeaders(), ...(init.headers || {}) },
    cache: 'no-store'
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`supabase_${response.status}: ${detail.slice(0, 200)}`);
  }
  return response;
}

async function alreadyProcessed(eventId) {
  const response = await sbFetch(
    `nfl_stripe_webhook_events?event_id=eq.${encodeURIComponent(eventId)}&select=event_id&limit=1`
  );
  const rows = await response.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function recordEvent(event) {
  await sbFetch('nfl_stripe_webhook_events', {
    method: 'POST',
    headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({
      event_id: event.id,
      event_type: event.type,
      stripe_created: event.created ?? null
    })
  });
}

async function findBySubscriptionId(subscriptionId) {
  const response = await sbFetch(
    `nfl_subscriptions?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}` +
    `&select=id,last_stripe_event_created&limit=1`
  );
  const rows = await response.json();
  return rows?.[0] || null;
}

/* Upsert keyed on a real unique column. onConflict must name a column that
 * actually carries a unique index, otherwise PostgREST inserts duplicates. */
async function upsert(record, onConflict) {
  await sbFetch(`nfl_subscriptions?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(record)
  });
}

async function patchBySubscriptionId(subscriptionId, updates) {
  await sbFetch(`nfl_subscriptions?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify(updates)
  });
}

function isoFromUnix(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function normalizeStatus(status) {
  return ALLOWED_STATUS.has(status) ? status : null;
}

async function handleCheckoutCompleted(stripe, event) {
  const session = event.data.object;

  /* Product guard. One Stripe account serves MLB, PropData, PropSports and
   * NFL, so this endpoint will receive their checkouts too. Checkout sessions
   * created by api/checkout.js always carry acquired_sport. */
  if (session.metadata?.acquired_sport !== 'nfl') {
    console.log(`[webhook] checkout.session.completed ignored — acquired_sport="${session.metadata?.acquired_sport || 'none'}"`);
    return { applied: false, reason: 'not_nfl' };
  }

  const userId = session.metadata?.user_id || null;
  const email = session.customer_details?.email || session.customer_email || null;

  const isSeasonPass =
    session.mode === 'payment' ||
    session.metadata?.plan === 'nfl_season_pass' ||
    session.metadata?.billing_mode === 'one_time';

  const base = {
    user_id: userId,
    customer_email: email,
    stripe_customer_id: session.customer || null,
    stripe_checkout_session_id: session.id,
    stripe_price_id: session.metadata?.price_id || null,
    last_stripe_event_id: event.id,
    last_stripe_event_created: event.created ?? null,
    updated_at: new Date().toISOString()
  };

  if (isSeasonPass) {
    const raw = session.metadata?.expires_at;
    const parsed = raw ? new Date(raw) : null;
    if (!raw || !parsed || Number.isNaN(parsed.getTime())) {
      /* Never invent an expiry. Throwing returns 5xx so Stripe retries, and
       * the event is not recorded, so a corrected replay can still land. */
      throw new Error(`season_pass_missing_expires_at: session=${session.id} raw=${JSON.stringify(raw)}`);
    }

    await upsert({
      ...base,
      stripe_subscription_id: null,
      status: 'active',
      current_period_end: parsed.toISOString(),
      cancel_at_period_end: false
    }, 'stripe_checkout_session_id');

    console.log(`[webhook] season pass active: user=${userId} until=${parsed.toISOString()}`);
    return { applied: true, reason: 'season_pass' };
  }

  /* Weekly. Status and period end are authoritative on the subscription
   * object, not on the session. */
  const subscriptionId = session.subscription;
  if (!subscriptionId) {
    throw new Error(`weekly_checkout_without_subscription: session=${session.id}`);
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const status = normalizeStatus(subscription.status);
  if (!status) {
    throw new Error(`unmappable_subscription_status: ${subscription.status}`);
  }

  await upsert({
    ...base,
    stripe_subscription_id: subscriptionId,
    stripe_price_id: subscription.items?.data?.[0]?.price?.id || base.stripe_price_id,
    status,
    current_period_end: isoFromUnix(subscription.current_period_end),
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end)
  }, 'stripe_subscription_id');

  console.log(`[webhook] weekly ${status}: user=${userId} sub=${subscriptionId}`);
  return { applied: true, reason: 'weekly' };
}

async function handleSubscriptionLifecycle(event) {
  const subscription = event.data.object;
  const subscriptionId = subscription.id;

  /* Guard by row existence rather than by metadata. Legacy Payment Link
   * subscribers have no metadata at all, and MLB/PropData subscriptions have
   * no row here, so this is both safer and stricter than a metadata check. */
  const row = await findBySubscriptionId(subscriptionId);
  if (!row) {
    console.log(`[webhook] ${event.type} ignored — no nfl_subscriptions row for ${subscriptionId}`);
    return { applied: false, reason: 'not_nfl' };
  }

  /* Reject stale/out-of-order deliveries so a delayed older update cannot
   * resurrect access after a newer cancellation. */
  const incoming = event.created ?? 0;
  if (Number.isFinite(row.last_stripe_event_created) && row.last_stripe_event_created > incoming) {
    console.log(`[webhook] ${event.type} ignored — stale (stored=${row.last_stripe_event_created} incoming=${incoming})`);
    return { applied: false, reason: 'stale' };
  }

  const status = event.type === 'customer.subscription.deleted'
    ? 'canceled'
    : normalizeStatus(subscription.status);

  if (!status) {
    throw new Error(`unmappable_subscription_status: ${subscription.status}`);
  }

  await patchBySubscriptionId(subscriptionId, {
    status,
    current_period_end: isoFromUnix(subscription.current_period_end),
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    last_stripe_event_id: event.id,
    last_stripe_event_created: incoming,
    updated_at: new Date().toISOString()
  });

  console.log(`[webhook] ${event.type} -> ${status} for ${subscriptionId}`);
  return { applied: true, reason: status };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('[webhook] STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'stripe_env_not_configured' });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[webhook] SUPABASE_SERVICE_ROLE_KEY is not set');
    return res.status(500).json({ error: 'supabase_env_not_configured' });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

  // 1. Verify against the raw body. An unverified webhook endpoint would let
  //    anyone grant themselves NFL Pro.
  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: err.message });
  }

  try {
    // 2. Duplicate delivery.
    if (await alreadyProcessed(event.id)) {
      console.log(`[webhook] duplicate ${event.type} ${event.id}`);
      return res.status(200).json({ received: true, duplicate: true });
    }

    // 3. Apply the mutation.
    let result;
    switch (event.type) {
      case 'checkout.session.completed':
        result = await handleCheckoutCompleted(stripe, event);
        break;
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        result = await handleSubscriptionLifecycle(event);
        break;
      default:
        console.log(`[webhook] unhandled event: ${event.type}`);
        result = { applied: false, reason: 'unhandled' };
    }

    // 4. Record only after the mutation succeeded.
    await recordEvent(event);

    // 5.
    return res.status(200).json({ received: true, applied: result.applied, reason: result.reason });

  } catch (err) {
    /* Not recorded, so Stripe will retry and the mutation can still land. */
    console.error(`[webhook] ${event.type} ${event.id} failed:`, err.message);
    return res.status(500).json({ error: 'webhook_processing_failed' });
  }
}
