/* PropBetEdge NFL billing — Cloudflare Worker
 *
 * Runtime contract:
 *   Stripe webhook -> Cloudflare Worker -> Supabase entitlement truth
 *   Access email   -> propbetedge-nfl-auth Worker -> Resend
 *
 * Vercel is intentionally absent from this path.
 *
 * Supported acquisition prices:
 *   legacy weekly  $9.99/wk   price_1U9QUZF3CaVzg4OR3QNfwWCS
 *   founding weekly $3.99/wk  price_1UEWAOF3CaVzg4ORjkWpwOz9
 *   founding monthly $9.99/mo price_1UEWAXF3CaVzg4ORGlsgboLq
 *   legacy season pass $99 one-time price_1U9oVzF3CaVzg4ORnk5NiJFA
 *
 * Existing customers stay on their existing Stripe price. This Worker only
 * mirrors Stripe truth into nfl_subscriptions; it never migrates a subscription.
 */

const SERVICE = 'propbetedge-nfl-billing';
const VERSION = 'v1.0.0';
const DEFAULT_SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const APP_ORIGIN = 'https://nfl.propbetedge.ai';
const AUTH_WORKER_URL = 'https://propbetedge-nfl-auth.sales-fd3.workers.dev';
const SIGNATURE_TOLERANCE_SECONDS = 300;

const PRICE = Object.freeze({
  legacyWeekly: 'price_1U9QUZF3CaVzg4OR3QNfwWCS',
  foundingWeekly: 'price_1UEWAOF3CaVzg4ORjkWpwOz9',
  foundingMonthly: 'price_1UEWAXF3CaVzg4ORGlsgboLq',
  legacySeasonPass: 'price_1U9oVzF3CaVzg4ORnk5NiJFA',
});

const RECURRING_PRICE_IDS = new Set([
  PRICE.legacyWeekly,
  PRICE.foundingWeekly,
  PRICE.foundingMonthly,
]);

const LEGACY_WEEKLY_PAYMENT_LINK = 'plink_1U9QUtF3CaVzg4ORqbkp3b2c';
const PRODUCT_TAG = 'propbetedge_nfl';
const ALLOWED_STATUS = new Set([
  'incomplete', 'incomplete_expired', 'trialing', 'active',
  'past_due', 'canceled', 'unpaid', 'paused',
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        ok: Boolean(env.STRIPE_WEBHOOK_SECRET && env.SUPABASE_SERVICE_ROLE_KEY),
        service: SERVICE,
        version: VERSION,
        runtime: 'cloudflare-workers',
        supabase: 'system-of-record',
        accepted_prices: {
          legacy_weekly: PRICE.legacyWeekly,
          founding_weekly: PRICE.foundingWeekly,
          founding_monthly: PRICE.foundingMonthly,
          legacy_season_pass: PRICE.legacySeasonPass,
        },
      });
    }

    if (request.method !== 'POST' || url.pathname !== '/webhook') {
      return json({ error: 'not_found', service: SERVICE, version: VERSION }, 404);
    }

    return handleWebhook(request, env);
  },
};

async function handleWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'webhook_not_configured' }, 503);
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'database_not_configured' }, 503);

  const raw = await request.text();
  const signature = request.headers.get('stripe-signature') || '';
  const valid = await validStripeSignature(raw, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return json({ error: 'invalid_signature' }, 400);

  let event;
  try { event = JSON.parse(raw); }
  catch { return json({ error: 'invalid_json' }, 400); }

  const eventId = typeof event?.id === 'string' ? event.id : null;
  const eventType = typeof event?.type === 'string' ? event.type : 'unknown';
  const eventCreated = Number.isFinite(Number(event?.created)) ? Number(event.created) : null;
  if (!eventId) return json({ error: 'missing_event_id' }, 400);

  try {
    if (await alreadyProcessed(env, eventId)) {
      return json({ received: true, duplicate: true });
    }

    const object = event?.data?.object || {};
    let result = { applied: false, reason: 'unhandled' };

    if (eventType === 'checkout.session.completed') {
      result = await handleCheckoutCompleted(env, object, eventId, eventCreated);
    } else if (
      eventType === 'customer.subscription.created' ||
      eventType === 'customer.subscription.updated' ||
      eventType === 'customer.subscription.deleted'
    ) {
      result = await handleSubscriptionLifecycle(env, object, eventType, eventId, eventCreated);
    } else if (eventType === 'invoice.paid' || eventType === 'invoice.payment_failed') {
      result = await handleInvoice(env, object, eventType, eventId, eventCreated);
    }

    /* Record only after the entitlement mutation succeeds. A 5xx before this
     * point lets Stripe retry safely; every mutation below is idempotent. */
    await recordEvent(env, eventId, eventType, eventCreated);
    return json({ received: true, applied: result.applied, reason: result.reason });
  } catch (error) {
    console.error(`[${SERVICE}] ${eventType} ${eventId} failed`, error instanceof Error ? error.message : String(error));
    return json({ error: 'processing_failed' }, 500);
  }
}

async function handleCheckoutCompleted(env, session, eventId, eventCreated) {
  const metadata = session?.metadata || {};
  const checkoutId = idOf(session);
  const paymentLinkId = idOf(session?.payment_link);
  const subscriptionId = idOf(session?.subscription);
  const email = normalizeEmail(
    session?.customer_details?.email || session?.customer_email || metadata?.email
  );
  const userId = typeof metadata?.user_id === 'string' && metadata.user_id ? metadata.user_id : null;

  const isNfl =
    metadata?.acquired_sport === 'nfl' ||
    metadata?.product === PRODUCT_TAG ||
    paymentLinkId === LEGACY_WEEKLY_PAYMENT_LINK;

  if (!isNfl) return { applied: false, reason: 'not_nfl' };
  if (!checkoutId) throw new Error('nfl_checkout_missing_session_id');

  const oneTime =
    session?.mode === 'payment' ||
    metadata?.plan === 'nfl_season_pass' ||
    metadata?.billing_mode === 'one_time';

  if (oneTime) {
    const priceId = metadata?.price_id || null;
    if (priceId !== PRICE.legacySeasonPass) throw new Error(`season_pass_price_mismatch:${priceId || 'none'}`);
    if (!userId && !email) throw new Error('season_pass_missing_identity');

    const expiresAt = typeof metadata?.expires_at === 'string' ? metadata.expires_at : '';
    const expiresMs = Date.parse(expiresAt);
    if (!expiresAt || !Number.isFinite(expiresMs)) throw new Error('season_pass_invalid_expiry');

    await upsert(env, 'nfl_subscriptions', {
      user_id: userId,
      customer_email: email,
      stripe_customer_id: idOf(session?.customer),
      stripe_subscription_id: null,
      stripe_checkout_session_id: checkoutId,
      stripe_price_id: PRICE.legacySeasonPass,
      status: 'active',
      current_period_end: new Date(expiresMs).toISOString(),
      cancel_at_period_end: false,
      last_stripe_event_id: eventId,
      last_stripe_event_created: eventCreated,
      updated_at: new Date().toISOString(),
    }, 'stripe_checkout_session_id');

    await sendAccessEmailOnce(env, email, `checkout:${checkoutId}`, eventId);
    return { applied: true, reason: 'legacy_season_pass' };
  }

  if (!subscriptionId) throw new Error('recurring_checkout_missing_subscription');

  /* Payment Links copy price_id into Checkout Session metadata. Legacy weekly
   * predates that convention, so it is allowed to fall back to the legacy id. */
  let priceId = metadata?.price_id || null;
  if (!RECURRING_PRICE_IDS.has(priceId) && paymentLinkId === LEGACY_WEEKLY_PAYMENT_LINK) {
    priceId = PRICE.legacyWeekly;
  }
  if (!RECURRING_PRICE_IDS.has(priceId)) {
    throw new Error(`unsupported_nfl_recurring_price:${priceId || 'none'}`);
  }

  const paymentComplete = session?.payment_status === 'paid' || session?.payment_status === 'no_payment_required';
  await upsert(env, 'nfl_subscriptions', {
    user_id: userId,
    customer_email: email,
    stripe_customer_id: idOf(session?.customer),
    stripe_subscription_id: subscriptionId,
    stripe_checkout_session_id: checkoutId,
    stripe_price_id: priceId,
    status: paymentComplete ? 'active' : 'incomplete',
    /* subscription.created/updated supplies the authoritative period end. */
    current_period_end: null,
    cancel_at_period_end: false,
    last_stripe_event_id: eventId,
    last_stripe_event_created: eventCreated,
    updated_at: new Date().toISOString(),
  }, 'stripe_subscription_id');

  await sendAccessEmailOnce(env, email, `subscription:${subscriptionId}`, eventId);
  return { applied: true, reason: planForPrice(priceId) };
}

async function handleSubscriptionLifecycle(env, subscription, eventType, eventId, eventCreated) {
  const subscriptionId = idOf(subscription);
  if (!subscriptionId) return { applied: false, reason: 'missing_subscription_id' };

  const priceId = recurringPriceFromSubscription(subscription);
  const existing = await findSubscription(env, subscriptionId);

  /* New + legacy NFL prices are recognized explicitly. For safety, an existing
   * NFL row also remains ours even if Stripe later changes the item to a price
   * not yet known by this build; we preserve lifecycle truth instead of orphaning
   * a paid customer. */
  if (!priceId && !existing) return { applied: false, reason: 'not_nfl' };

  const incoming = eventCreated || 0;
  const stored = Number(existing?.last_stripe_event_created || 0);
  if (existing && stored > incoming && incoming > 0) {
    return { applied: false, reason: 'stale' };
  }

  const status = eventType === 'customer.subscription.deleted'
    ? 'canceled'
    : normalizeStatus(subscription?.status);
  if (!status) throw new Error(`unmappable_subscription_status:${subscription?.status || 'none'}`);

  const record = {
    stripe_subscription_id: subscriptionId,
    stripe_customer_id: idOf(subscription?.customer),
    stripe_price_id: priceId || existing?.stripe_price_id || null,
    status,
    current_period_end: periodEnd(subscription),
    cancel_at_period_end: Boolean(subscription?.cancel_at_period_end),
    last_stripe_event_id: eventId,
    last_stripe_event_created: eventCreated,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    await patch(env, 'nfl_subscriptions', `stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}`, record);
  } else {
    await upsert(env, 'nfl_subscriptions', record, 'stripe_subscription_id');
  }

  return { applied: true, reason: `${planForPrice(record.stripe_price_id)}:${status}` };
}

async function handleInvoice(env, invoice, eventType, eventId, eventCreated) {
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) return { applied: false, reason: 'no_subscription' };

  const existing = await findSubscription(env, subscriptionId);
  if (!existing) return { applied: false, reason: 'not_nfl' };

  const incoming = eventCreated || 0;
  const stored = Number(existing?.last_stripe_event_created || 0);
  if (stored > incoming && incoming > 0) return { applied: false, reason: 'stale' };

  const email = normalizeEmail(invoice?.customer_email || existing?.customer_email);
  const status = eventType === 'invoice.payment_failed' ? 'past_due' : 'active';
  await patch(env, 'nfl_subscriptions', `stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}`, {
    status,
    customer_email: email || existing?.customer_email || null,
    last_stripe_event_id: eventId,
    last_stripe_event_created: eventCreated,
    updated_at: new Date().toISOString(),
  });

  if (eventType === 'invoice.paid') {
    await sendAccessEmailOnce(env, email, `subscription:${subscriptionId}`, eventId);
  }
  return { applied: true, reason: status };
}

function recurringPriceFromSubscription(subscription) {
  const items = Array.isArray(subscription?.items?.data) ? subscription.items.data : [];
  for (const item of items) {
    const priceId = idOf(item?.price);
    if (RECURRING_PRICE_IDS.has(priceId)) return priceId;
  }
  return null;
}

function planForPrice(priceId) {
  if (priceId === PRICE.foundingMonthly) return 'founding_monthly';
  if (priceId === PRICE.foundingWeekly) return 'founding_weekly';
  if (priceId === PRICE.legacyWeekly) return 'legacy_weekly';
  if (priceId === PRICE.legacySeasonPass) return 'legacy_season_pass';
  return 'unknown_nfl_plan';
}

function normalizeStatus(status) {
  return ALLOWED_STATUS.has(status) ? status : null;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^\S+@\S+\.\S+$/.test(email) && email.length <= 254 ? email : null;
}

function idOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id;
  return null;
}

function unixIso(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

function periodEnd(subscription) {
  if (subscription?.current_period_end) return unixIso(subscription.current_period_end);
  const values = (subscription?.items?.data || [])
    .map(item => Number(item?.current_period_end))
    .filter(n => Number.isFinite(n) && n > 0);
  return values.length ? unixIso(Math.max(...values)) : null;
}

function invoiceSubscriptionId(invoice) {
  return idOf(invoice?.subscription) ||
    idOf(invoice?.parent?.subscription_details?.subscription) ||
    idOf(invoice?.subscription_details?.subscription);
}

async function alreadyProcessed(env, eventId) {
  const rows = await sbSelect(env,
    `nfl_stripe_webhook_events?select=event_id&event_id=eq.${encodeURIComponent(eventId)}&limit=1`
  );
  return rows.length > 0;
}

async function recordEvent(env, eventId, eventType, stripeCreated) {
  await sbWrite(env, 'nfl_stripe_webhook_events', {
    method: 'POST',
    headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ event_id: eventId, event_type: eventType, stripe_created: stripeCreated }),
  });
}

async function findSubscription(env, subscriptionId) {
  const rows = await sbSelect(env,
    `nfl_subscriptions?select=id,customer_email,stripe_price_id,last_stripe_event_created&stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}&limit=1`
  );
  return rows[0] || null;
}

async function sendAccessEmailOnce(env, emailRaw, deliveryKey, eventId) {
  const email = normalizeEmail(emailRaw);
  if (!email) return false;

  const existing = await sbSelect(env,
    `nfl_access_email_deliveries?select=delivery_key&delivery_key=eq.${encodeURIComponent(deliveryKey)}&limit=1`
  );
  if (existing.length) return false;

  try {
    await sbWrite(env, 'nfl_access_email_deliveries', {
      method: 'POST',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({
        delivery_key: deliveryKey,
        customer_email: email,
        stripe_event_id: eventId,
        provider: 'resend',
      }),
    });
  } catch (error) {
    if (String(error?.message || '').includes('23505')) return false;
    throw error;
  }

  try {
    const target = 'https://auth/v1/auth/request';
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', origin: APP_ORIGIN },
      body: JSON.stringify({ email, purpose: 'purchase' }),
    };
    const response = env.AUTH
      ? await env.AUTH.fetch(target, init)
      : await fetch(`${AUTH_WORKER_URL}/v1/auth/request`, init);
    const text = await response.text();
    if (!response.ok) throw new Error(`access_email_${response.status}:${text.slice(0, 180)}`);
    return true;
  } catch (error) {
    /* Reservation is removed only when delivery fails, so Stripe retry can try
     * the email again without ever sending two successful purchase emails. */
    await sbWrite(env,
      `nfl_access_email_deliveries?delivery_key=eq.${encodeURIComponent(deliveryKey)}`,
      { method: 'DELETE', headers: { prefer: 'return=minimal' } }
    );
    throw error;
  }
}

function supabaseUrl(env) {
  return String(env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
}

function sbHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    accept: 'application/json',
    ...extra,
  };
}

async function sbSelect(env, path) {
  const response = await fetch(`${supabaseUrl(env)}/rest/v1/${path}`, {
    method: 'GET', headers: sbHeaders(env), cache: 'no-store',
  });
  if (!response.ok) throw new Error(`supabase_${response.status}:${(await response.text()).slice(0, 180)}`);
  const body = await response.json().catch(() => []);
  return Array.isArray(body) ? body : [];
}

async function sbWrite(env, path, init) {
  const response = await fetch(`${supabaseUrl(env)}/rest/v1/${path}`, {
    ...init,
    headers: sbHeaders(env, { 'content-type': 'application/json; charset=utf-8', ...(init?.headers || {}) }),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`supabase_${response.status}:${(await response.text()).slice(0, 240)}`);
  return response;
}

function upsert(env, table, record, onConflict) {
  return sbWrite(env, `${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(record),
  });
}

function patch(env, table, filter, record) {
  return sbWrite(env, `${table}?${filter}`, {
    method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(record),
  });
}

async function validStripeSignature(raw, header, secret) {
  const parts = header.split(',').map(value => value.trim());
  const timestamp = parts.find(value => value.startsWith('t='))?.slice(2);
  const signatures = parts.filter(value => value.startsWith('v1=')).map(value => value.slice(3));
  if (!timestamp || !signatures.length) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const payload = `${timestamp}.${raw}`;
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const expected = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return signatures.some(signature => timingSafeEqual(signature, expected));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
