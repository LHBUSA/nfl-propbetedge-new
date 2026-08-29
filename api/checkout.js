/* PropBetEdge NFL — authenticated checkout router
 * Preferred path: server-created Stripe Checkout Session when STRIPE_SECRET_KEY exists.
 * Production-safe fallback: live Stripe Payment Links with the signed-in email locked.
 * Both paths feed the canonical Supabase NFL Stripe webhook and entitlement table.
 */

import Stripe from 'stripe';

const SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_YkSuX7oXCxyTTMPtPqYIyw_qtbfA5c6';

const SEASON_PASS_PRICE_ID = 'price_1U9oVzF3CaVzg4ORnk5NiJFA';
const SEASON_PASS_EXPIRES_AT = '2027-02-14T23:59:59-06:00';
const SEASON_PASS_PAYMENT_LINK = 'https://buy.stripe.com/cNidR9eeGbuCe05f2X7wA06';

const WEEKLY_PRICE_ID = 'price_1U9QUZF3CaVzg4OR3QNfwWCS';
const WEEKLY_PAYMENT_LINK = 'https://buy.stripe.com/fZueVd1rU0PYg8d8Ez7wA05';

const VALID_PRICES = {
  [SEASON_PASS_PRICE_ID]: { tier: 'season_pass', mode: 'payment', paymentLink: SEASON_PASS_PAYMENT_LINK },
  [WEEKLY_PRICE_ID]: { tier: 'weekly', mode: 'subscription', paymentLink: WEEKLY_PAYMENT_LINK }
};

function paymentLinkUrl(base, email, userId) {
  try {
    const url = new URL(base);
    if (email) url.searchParams.set('locked_prefilled_email', email);
    if (userId) url.searchParams.set('client_reference_id', userId);
    return url.toString();
  } catch (_) {
    return base;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { priceId } = req.body || {};
  const plan = VALID_PRICES[priceId];
  if (!plan) return res.status(400).json({ error: `Invalid price ID: ${priceId}` });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'sign_in_required', entitlement: 'nfl_pro' });

  let user;
  try {
    const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        authorization: `Bearer ${token}`,
        accept: 'application/json'
      },
      cache: 'no-store'
    });
    if (!userResponse.ok) return res.status(401).json({ error: 'invalid_session', entitlement: 'nfl_pro' });
    user = await userResponse.json();
  } catch (error) {
    console.error('[checkout] Supabase session check failed:', error?.message || error);
    return res.status(502).json({ error: 'session_check_failed' });
  }

  const userId = user?.id;
  const email = String(user?.email || '').trim().toLowerCase();
  if (!userId || !email) return res.status(401).json({ error: 'invalid_session', entitlement: 'nfl_pro' });

  const { tier, mode, paymentLink } = plan;

  /* Live Payment Links are the production fallback until Vercel has the Stripe
   * secret. The email is locked to the authenticated Supabase account so the
   * webhook can deterministically grant the entitlement by email. */
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(200).json({
      url: paymentLinkUrl(paymentLink, email, userId),
      provider: 'stripe_payment_link',
      tier
    });
  }

  const siteUrl = process.env.SITE_URL || 'https://nfl.propbetedge.ai';

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
    const params = {
      mode,
      payment_method_types: ['card'],
      customer_email: email,
      client_reference_id: userId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${siteUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}&tier=${tier}`,
      cancel_url: `${siteUrl}/?checkout=cancelled`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      metadata: {
        price_id: priceId,
        tier,
        user_id: userId,
        email,
        acquired_sport: 'nfl',
        product: 'propbetedge_nfl'
      }
    };

    if (mode === 'subscription') {
      params.subscription_data = {
        metadata: {
          tier,
          user_id: userId,
          email,
          acquired_sport: 'nfl',
          product: 'propbetedge_nfl'
        }
      };
    }

    if (tier === 'season_pass') {
      params.metadata.plan = 'nfl_season_pass';
      params.metadata.billing_mode = 'one_time';
      params.metadata.expires_at = SEASON_PASS_EXPIRES_AT;
      params.metadata.access = 'pro';
    }

    const session = await stripe.checkout.sessions.create(params);
    return res.status(200).json({ url: session.url, provider: 'stripe_checkout_session', tier });
  } catch (err) {
    console.error('[checkout] Stripe session failed; returning Payment Link fallback:', err?.message || err);
    return res.status(200).json({
      url: paymentLinkUrl(paymentLink, email, userId),
      provider: 'stripe_payment_link_fallback',
      tier
    });
  }
}
