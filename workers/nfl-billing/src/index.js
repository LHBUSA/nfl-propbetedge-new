/* PropBetEdge NFL billing — Cloudflare Worker
 *
 * Production contract:
 *   Stripe webhook -> Cloudflare Worker -> Supabase entitlement truth
 *   purchase email -> propbetedge-nfl-auth Worker -> Resend
 *
 * Vercel is frontend hosting only and is intentionally absent from this path.
 * GitHub stores this source; it does not schedule or execute billing work.
 *
 * Supported acquisition prices:
 *   legacy weekly    $9.99/wk  price_1U9QUZF3CaVzg4OR3QNfwWCS
 *   founding weekly  $3.99/wk  price_1UEWAOF3CaVzg4ORjkWpwOz9
 *   founding monthly $9.99/mo  price_1UEWAXF3CaVzg4ORGlsgboLq
 *   legacy pass      $99 once  price_1U9oVzF3CaVzg4ORnk5NiJFA
 *
 * Existing subscriptions are NEVER migrated by this Worker. It mirrors Stripe
 * state only. Old customers keep the price/term they already purchased.
 *
 * Event order (v1.2.0). Stripe does not deliver events in creation order. A
 * Payment Link purchase produces customer.subscription.created, invoice.paid
 * and checkout.session.completed within a second of each other, in any order.
 * `last_stripe_event_created` is therefore owned by customer.subscription.*
 * events ONLY — they carry status, price and current_period_end. Checkout and
 * invoice events fill identity (email, customer, checkout id) and send the
 * access email, and never advance that ordering column; otherwise a checkout
 * delivered before an earlier-created subscription.created made the latter
 * "stale" and left current_period_end null, which denies a paying customer.
 */

const SERVICE = 'propbetedge-nfl-billing';
const VERSION = 'v1.2.0';
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
      const configured = Boolean(env.STRIPE_WEBHOOK_SECRET && env.SUPABASE_SERVICE_ROLE_KEY);
      /* ?deep=1 proves the two dependencies a delivery needs, read-only: the
       * ledger answers with this Worker's key, and the auth Worker (access
       * email) is reachable through its binding. No rows are returned. */
      const deep = url.searchParams.get('deep') === '1' ? await deepHealth(env) : null;
      return json({
        ok: configured && (!deep || (deep.ledger === 'ok' && deep.auth === 'ok')),
        configured,
        ...(deep ? { deep } : {}),
        service: SERVICE,
        version: VERSION,
        runtime: 'cloudflare-workers',
        trigger: 'stripe-webhook',
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

async function deepHealth(env) {
  const out = { ledger: 'unchecked', auth: 'unchecked' };
  try {
    await sbSelect(env, 'nfl_stripe_webhook_events?select=event_id&limit=1');
    out.ledger = 'ok';
  } catch (error) {
    out.ledger = String(error?.message || 'error').replace(/:.*/, '');
  }
  try {
    const r = env.AUTH ? await env.AUTH.fetch('https://auth/health') : await fetch(`${AUTH_WORKER_URL}/health`);
    const body = await r.json().catch(() => ({}));
    out.auth = r.ok && body?.ok === true ? 'ok' : `auth_${r.status}`;
  } catch (error) {
    out.auth = 'unreachable';
  }
  return out;
}

async function handleWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'webhook_not_configured' }, 503);
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'database_not_configured' }, 503);

  const raw = await request.text();
  const signature = request.headers.get('stripe-signature') || '';
  if (!(await validStripeSignature(raw, signature, env.STRIPE_WEBHOOK_SECRET))) {
    return json({ error: 'invalid_signature' }, 400);
  }

  let event;
  try { event = JSON.parse(raw); }
  catch { return json({ error: 'invalid_json' }, 400); }

  const eventId = typeof event?.id === 'string' ? event.id : null;
  const eventType = typeof event?.type === 'string' ? event.type : 'unknown';
  const eventCreated = finiteNumber(event?.created);
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

    /* Idempotency ledger comes AFTER the mutation. If anything above fails,
     * Stripe receives 5xx and may retry; no failed event is falsely marked done. */
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
  const email = normalizeEmail(session?.customer_details?.email || session?.customer_email || metadata?.email);
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
    return handleLegacySeasonPass(env, {
      session, metadata, checkoutId, email, userId, eventId, eventCreated,
    });
  }

  if (!subscriptionId) throw new Error('recurring_checkout_missing_subscription');

  let priceId = metadata?.price_id || null;
  if (!RECURRING_PRICE_IDS.has(priceId) && paymentLinkId === LEGACY_WEEKLY_PAYMENT_LINK) {
    priceId = PRICE.legacyWeekly;
  }
  if (!RECURRING_PRICE_IDS.has(priceId)) {
    throw new Error(`unsupported_nfl_recurring_price:${priceId || 'none'}`);
  }

  const existing = await findSubscription(env, subscriptionId);
  const paymentComplete = session?.payment_status === 'paid' || session?.payment_status === 'no_payment_required';
  /* Has any customer.subscription.* event been applied? Then the lifecycle
   * owns status, price and period; checkout only links identity. */
  const lifecycleApplied = Boolean(existing && Number(existing.last_stripe_event_created || 0) > 0);

  if (existing) {
    const patchRecord = {
      customer_email: email || existing.customer_email || null,
      stripe_customer_id: idOf(session?.customer) || existing.stripe_customer_id || null,
      stripe_checkout_session_id: checkoutId,
      stripe_price_id: existing.stripe_price_id || priceId,
      updated_at: new Date().toISOString(),
    };
    if (userId) patchRecord.user_id = userId;
    if (!lifecycleApplied) patchRecord.status = paymentComplete ? 'active' : (existing.status || 'incomplete');
    /* Never writes current_period_end or the ordering column: a delayed
     * checkout can neither erase a period nor resurrect a canceled sub. */
    await patch(env, 'nfl_subscriptions', `stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}`, patchRecord);
  } else {
    await insert(env, 'nfl_subscriptions', {
      user_id: userId,
      customer_email: email,
      stripe_customer_id: idOf(session?.customer),
      stripe_subscription_id: subscriptionId,
      stripe_checkout_session_id: checkoutId,
      stripe_price_id: priceId,
      status: paymentComplete ? 'active' : 'incomplete',
      current_period_end: null,
      cancel_at_period_end: false,
      /* ordering is left to customer.subscription.* (see header) */
      last_stripe_event_id: null,
      last_stripe_event_created: null,
      updated_at: new Date().toISOString(),
    });
  }

  await sendAccessEmailOnce(env, email, `subscription:${subscriptionId}`, eventId);
  return { applied: true, reason: planForPrice(priceId) };
}

async function handleLegacySeasonPass(env, ctx) {
  const { session, metadata, checkoutId, email, userId, eventId, eventCreated } = ctx;
  const priceId = metadata?.price_id || null;
  if (priceId !== PRICE.legacySeasonPass) {
    throw new Error(`season_pass_price_mismatch:${priceId || 'none'}`);
  }
  if (!userId && !email) throw new Error('season_pass_missing_identity');

  const expiresAt = typeof metadata?.expires_at === 'string' ? metadata.expires_at : '';
  const expiresMs = Date.parse(expiresAt);
  if (!expiresAt || !Number.isFinite(expiresMs)) throw new Error('season_pass_invalid_expiry');

  const rows = await sbSelect(env,
    `nfl_subscriptions?select=id,last_stripe_event_created&stripe_checkout_session_id=eq.${encodeURIComponent(checkoutId)}&limit=1`
  );
  const existing = rows[0] || null;
  const record = {
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
  };

  /* stripe_checkout_session_id is protected by a partial unique index, not a
   * normal UNIQUE constraint, so use explicit select->update/insert instead of
   * PostgREST on_conflict inference. */
  if (existing) {
    const incoming = eventCreated || 0;
    const stored = Number(existing.last_stripe_event_created || 0);
    if (!stored || !incoming || incoming >= stored) {
      await patch(env, 'nfl_subscriptions', `id=eq.${encodeURIComponent(existing.id)}`, record);
    }
  } else {
    await insert(env, 'nfl_subscriptions', record);
  }

  await sendAccessEmailOnce(env, email, `checkout:${checkoutId}`, eventId);
  return { applied: true, reason: 'legacy_season_pass' };
}

async function handleSubscriptionLifecycle(env, subscription, eventType, eventId, eventCreated) {
  const subscriptionId = idOf(subscription);
  if (!subscriptionId) return { applied: false, reason: 'missing_subscription_id' };

  const recognizedPriceId = recurringPriceFromSubscription(subscription);
  const existing = await findSubscription(env, subscriptionId);

  /* Price recognition identifies new rows. Once a subscription has a row in the
   * NFL ledger it stays ours even if Stripe later changes its item to a price a
   * newer build has not learned yet. That prevents orphaning a paid customer. */
  if (!recognizedPriceId && !existing) return { applied: false, reason: 'not_nfl' };

  const incoming = eventCreated || 0;
  const stored = Number(existing?.last_stripe_event_created || 0);
  if (existing && stored > incoming && incoming > 0) {
    return { applied: false, reason: 'stale' };
  }

  const status = eventType === 'customer.subscription.deleted'
    ? 'canceled'
    : normalizeStatus(subscription?.status);
  if (!status) throw new Error(`unmappable_subscription_status:${subscription?.status || 'none'}`);

  /* Stripe stamps created and the first updated with the same second. At an
   * equal timestamp the lifecycle only moves forward: a late .created never
   * overwrites an applied event, and nothing returns a live subscription to
   * incomplete. */
  if (existing && stored > 0 && incoming === stored) {
    if (eventType === 'customer.subscription.created') return { applied: false, reason: 'stale_same_second' };
    if ((status === 'incomplete' || status === 'incomplete_expired') && existing.status && existing.status !== status) {
      return { applied: false, reason: 'stale_same_second' };
    }
  }

  const record = {
    stripe_subscription_id: subscriptionId,
    stripe_customer_id: idOf(subscription?.customer),
    stripe_price_id: recognizedPriceId || existing?.stripe_price_id || null,
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
    await insert(env, 'nfl_subscriptions', record);
  }

  return { applied: true, reason: `${planForPrice(record.stripe_price_id)}:${status}` };
}

async function handleInvoice(env, invoice, eventType, eventId, eventCreated) {
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) return { applied: false, reason: 'no_subscription' };

  const existing = await findSubscription(env, subscriptionId);
  if (!existing) {
    /* An NFL first invoice can arrive before customer.subscription.created.
     * Nothing is lost by recording it: checkout.session.completed carries the
     * same email and sends the same (idempotent) access email. */
    return { applied: false, reason: invoiceHasNflPrice(invoice) ? 'nfl_invoice_before_subscription' : 'not_nfl' };
  }

  /* Status comes from customer.subscription.updated, which Stripe sends on
   * every status transition (incomplete -> active, active -> past_due, ...).
   * Invoices only fill a missing email and trigger the access email, so an
   * invoice delivered out of order can never flip access either way. */
  const email = normalizeEmail(invoice?.customer_email || existing.customer_email);
  if (email && email !== existing.customer_email) {
    await patch(env, 'nfl_subscriptions', `stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}`, {
      customer_email: email,
      updated_at: new Date().toISOString(),
    });
  }

  if (eventType === 'invoice.paid') {
    await sendAccessEmailOnce(env, email, `subscription:${subscriptionId}`, eventId);
    return { applied: true, reason: 'invoice_paid_identity' };
  }
  return { applied: false, reason: 'payment_failed_status_from_subscription_event' };
}

function invoiceHasNflPrice(invoice) {
  const lines = Array.isArray(invoice?.lines?.data) ? invoice.lines.data : [];
  return lines.some(line => {
    const price = idOf(line?.price) || idOf(line?.pricing?.price_details?.price) || line?.pricing?.price_details?.price || null;
    return RECURRING_PRICE_IDS.has(price);
  });
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

function normalizeStatus(status) { return ALLOWED_STATUS.has(status) ? status : null; }
function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^\S+@\S+\.\S+$/.test(email) && email.length <= 254 ? email : null;
}
function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
    `nfl_subscriptions?select=id,user_id,customer_email,stripe_customer_id,stripe_price_id,status,current_period_end,cancel_at_period_end,last_stripe_event_created&stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}&limit=1`
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
    await insert(env, 'nfl_access_email_deliveries', {
      delivery_key: deliveryKey,
      customer_email: email,
      stripe_event_id: eventId,
      provider: 'resend',
    });
  } catch (error) {
    if (String(error?.message || '').includes('23505')) return false;
    throw error;
  }

  try {
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', origin: APP_ORIGIN },
      body: JSON.stringify({ email, purpose: 'purchase' }),
    };
    const response = env.AUTH
      ? await env.AUTH.fetch('https://auth/v1/auth/request', init)
      : await fetch(`${AUTH_WORKER_URL}/v1/auth/request`, init);
    const text = await response.text();
    if (!response.ok) throw new Error(`access_email_${response.status}:${text.slice(0, 180)}`);
    return true;
  } catch (error) {
    /* Only a failed delivery removes its reservation, allowing Stripe's retry to
     * make another attempt without duplicating a successful email. */
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
/* Legacy service_role JWTs use apikey + Bearer; sb_secret_* API keys are not
 * JWTs and must be sent on apikey only (same rule as api/_nfl-auth.js). */
function sbHeaders(env, extra = {}) {
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const headers = { apikey: key, accept: 'application/json', ...extra };
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  return headers;
}
async function sbSelect(env, path) {
  const response = await fetch(`${supabaseUrl(env)}/rest/v1/${path}`, {
    method: 'GET', headers: sbHeaders(env), cache: 'no-store',
  });
  if (!response.ok) throw new Error(`supabase_${response.status}:${(await response.text()).slice(0, 180)}`);
  const body = await response.json().catch(() => []);
  return Array.isArray(body) ? body : [];
}
async function sbWrite(env, path, init = {}) {
  const response = await fetch(`${supabaseUrl(env)}/rest/v1/${path}`, {
    ...init,
    headers: sbHeaders(env, { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) }),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`supabase_${response.status}:${(await response.text()).slice(0, 240)}`);
  return response;
}
function insert(env, table, record) {
  return sbWrite(env, table, {
    method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify(record),
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
  const digest = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${timestamp}.${raw}`)
  );
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
