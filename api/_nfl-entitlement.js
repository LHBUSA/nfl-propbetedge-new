/* PropBetEdge NFL — entitlement predicate.
 *
 * Identity is not entitlement. A magic-link session proves WHO the reader is;
 * only a verifiable NFL purchase in nfl_subscriptions proves WHAT they bought.
 * This module is pure (no I/O) and is the single definition of "may open the
 * paid NFL product". Every server gate reaches it through _nfl-auth.js.
 *
 * A row grants access only when ALL of these hold:
 *
 *   recurring (weekly / monthly subscription)
 *     · customer_email, normalized, equals the verified session email
 *     · stripe_price_id is a recognized NFL RECURRING price
 *     · status is active or trialing
 *     · stripe_subscription_id is a Stripe subscription id (sub_…)
 *     · stripe_customer_id is a Stripe customer id (cus_…)
 *     · current_period_end is present, parseable, in the future, and not
 *       further out than one billing period can be (no perpetual rows)
 *
 *   one-time (2026 Season Pass)
 *     · customer_email, normalized, equals the verified session email
 *     · stripe_price_id is the recognized NFL season-pass price
 *     · status is active
 *     · stripe_checkout_session_id is a Stripe Checkout Session id (cs_…)
 *     · no subscription id (a one-time purchase creates none)
 *     · current_period_end is present, in the future, and no later than the
 *       season pass's published end
 *
 * Anything else — an orphan "active" row with no Stripe proof, a null expiry,
 * an unknown price, another sport's price — grants nothing.
 *
 * The recognized prices mirror workers/nfl-billing/src/index.js, the Stripe
 * webhook that writes these rows; tests/nfl-access-v2.test.mjs fails
 * if the two lists drift apart.
 */

export const NFL_PRODUCT = 'nfl';

export const NFL_PRICES = Object.freeze({
  legacyWeekly: 'price_1U9QUZF3CaVzg4OR3QNfwWCS',
  foundingWeekly: 'price_1UEWAOF3CaVzg4ORjkWpwOz9',
  foundingMonthly: 'price_1UEWAXF3CaVzg4ORGlsgboLq',
  legacySeasonPass: 'price_1U9oVzF3CaVzg4ORnk5NiJFA',
});

export const NFL_RECURRING_PRICES = Object.freeze(new Set([
  NFL_PRICES.legacyWeekly, NFL_PRICES.foundingWeekly, NFL_PRICES.foundingMonthly,
]));
export const NFL_ONE_TIME_PRICES = Object.freeze(new Set([NFL_PRICES.legacySeasonPass]));

/* api/checkout.js SEASON_PASS_EXPIRES_AT: 2027-02-14T23:59:59-06:00. */
export const SEASON_PASS_LATEST_EXPIRY_MS = Date.parse('2027-02-15T05:59:59Z');
/* A monthly period is at most 31 days; allow clock and proration slack. */
export const RECURRING_MAX_PERIOD_MS = 45 * 86400000;

const ACCEPTED_RECURRING_STATUS = new Set(['active', 'trialing']);
const STRIPE_SUBSCRIPTION = /^sub_[A-Za-z0-9]+$/;
const STRIPE_CUSTOMER = /^cus_[A-Za-z0-9]+$/;
const STRIPE_CHECKOUT = /^cs_(?:live|test)_[A-Za-z0-9]+$/;

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : '';
}

/* PostgREST ilike treats %, _ and * as wildcards. The lookup narrows by
   case-insensitive equality only; the exact comparison happens in JS below. */
export function ilikeLiteral(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/([%_*])/g, '\\$1');
}

function planOf(priceId) {
  if (priceId === NFL_PRICES.foundingMonthly) return 'founding_monthly';
  if (priceId === NFL_PRICES.foundingWeekly) return 'founding_weekly';
  if (priceId === NFL_PRICES.legacyWeekly) return 'legacy_weekly';
  if (priceId === NFL_PRICES.legacySeasonPass) return 'season_pass';
  return null;
}

/** Evaluate one nfl_subscriptions row for one verified email. Pure. */
export function evaluateNflEntitlementRow(row, email, nowMs = Date.now()) {
  const verified = normalizeEmail(email);
  const status = String(row?.status || '').trim().toLowerCase();
  const priceId = String(row?.stripe_price_id || '').trim();
  const deny = reason => ({ entitled: false, reason, status: status || null, plan: planOf(priceId) });

  if (!verified) return deny('unverified_email');
  if (normalizeEmail(row?.customer_email) !== verified) return deny('email_mismatch');

  const recurring = NFL_RECURRING_PRICES.has(priceId);
  const oneTime = NFL_ONE_TIME_PRICES.has(priceId);
  if (!recurring && !oneTime) return deny(priceId ? 'not_an_nfl_price' : 'no_price');

  const end = row?.current_period_end ? Date.parse(row.current_period_end) : NaN;

  if (recurring) {
    if (status === 'canceled' || status === 'incomplete_expired') return deny('canceled');
    if (status === 'past_due' || status === 'unpaid') return deny('payment_failed');
    if (!ACCEPTED_RECURRING_STATUS.has(status)) return deny(status ? `status_${status}` : 'no_status');
    if (!STRIPE_SUBSCRIPTION.test(String(row?.stripe_subscription_id || ''))) return deny('no_stripe_subscription');
    if (!STRIPE_CUSTOMER.test(String(row?.stripe_customer_id || ''))) return deny('no_stripe_customer');
    if (!row?.current_period_end) return deny('null_expiry');
    if (!Number.isFinite(end)) return deny('invalid_expiry');
    if (end <= nowMs) return deny('expired');
    if (end - nowMs > RECURRING_MAX_PERIOD_MS) return deny('expiry_out_of_range');
  } else {
    if (status !== 'active') return deny(status === 'canceled' ? 'canceled' : status ? `status_${status}` : 'no_status');
    if (!STRIPE_CHECKOUT.test(String(row?.stripe_checkout_session_id || ''))) return deny('no_stripe_checkout');
    if (row?.stripe_subscription_id) return deny('one_time_with_subscription');
    if (!row?.current_period_end) return deny('null_expiry');
    if (!Number.isFinite(end)) return deny('invalid_expiry');
    if (end <= nowMs) return deny('expired');
    if (end > SEASON_PASS_LATEST_EXPIRY_MS) return deny('expiry_out_of_range');
  }

  return {
    entitled: true,
    reason: 'entitled',
    product: NFL_PRODUCT,
    plan: planOf(priceId),
    billing: recurring ? 'recurring' : 'one_time',
    status,
    current_period_end: new Date(end).toISOString(),
    cancel_at_period_end: Boolean(row?.cancel_at_period_end),
    stripe_price_id: priceId,
  };
}

/* Most informative denial first when nothing grants. */
const DENIAL_RANK = ['expired', 'canceled', 'payment_failed', 'null_expiry', 'no_stripe_subscription', 'no_stripe_customer', 'no_stripe_checkout'];

/** Pick the granting row, if any, from every row the lookup returned. Pure. */
export function selectNflEntitlement(rows, email, nowMs = Date.now()) {
  const results = (Array.isArray(rows) ? rows : []).map(row => evaluateNflEntitlementRow(row, email, nowMs));
  const granted = results.filter(r => r.entitled)
    .sort((a, b) => Date.parse(b.current_period_end) - Date.parse(a.current_period_end))[0];
  if (granted) return granted;
  if (!results.length) return { entitled: false, reason: 'no_subscription', status: null, plan: null };
  const ranked = results.slice().sort((a, b) => {
    const ra = DENIAL_RANK.indexOf(a.reason), rb = DENIAL_RANK.indexOf(b.reason);
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
  });
  return ranked[0];
}
