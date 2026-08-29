/* PropBetEdge NFL — Stripe Checkout Session
 * Mirrors propdata-api-vercel/api/checkout.js: server-side price allowlist,
 * { url } response, { error } failure shape.
 *
 * Differs in two ways:
 *  - VALID_PRICES maps price -> { tier, mode }, because the season pass is a
 *    one-time payment and the weekly tier is a subscription.
 *  - The caller must present a valid Supabase session. The Bearer check is the
 *    same one api/pro-model.js:30-37 performs, and the resolved user id is put
 *    in session metadata so the webhook can key the purchase to an account
 *    (nfl_subscriptions.user_id), rather than matching loosely on email.
 */

import Stripe from 'stripe';

const SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_YkSuX7oXCxyTTMPtPqYIyw_qtbfA5c6';

const SEASON_PASS_PRICE_ID = 'price_1U9oVzF3CaVzg4ORnk5NiJFA';
const SEASON_PASS_EXPIRES_AT = '2027-02-14T23:59:59-06:00';

const WEEKLY_PRICE_ID = 'price_1U9QUZF3CaVzg4OR3QNfwWCS';

const VALID_PRICES = {
  [SEASON_PASS_PRICE_ID]: { tier: 'season_pass', mode: 'payment' },
  [WEEKLY_PRICE_ID]: { tier: 'weekly', mode: 'subscription' }
};

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Validate env
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[checkout] STRIPE_SECRET_KEY is not set');
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });
  }

  const { priceId } = req.body || {};

  if (!VALID_PRICES[priceId]) {
    return res.status(400).json({ error: `Invalid price ID: ${priceId}` });
  }

  // Same Supabase session validation as api/pro-model.js:30-37.
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

    if (!userResponse.ok) {
      return res.status(401).json({ error: 'invalid_session', entitlement: 'nfl_pro' });
    }

    user = await userResponse.json();
  } catch (error) {
    console.error('[checkout] Supabase session check failed:', error.message);
    return res.status(502).json({ error: 'session_check_failed' });
  }

  const userId = user?.id;
  const email = user?.email;
  if (!userId) return res.status(401).json({ error: 'invalid_session', entitlement: 'nfl_pro' });

  const siteUrl = process.env.SITE_URL || 'https://nfl-propbetedge-new.vercel.app';
  const { tier, mode } = VALID_PRICES[priceId];

  try {
    // Stripe v14 compatible init
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2023-10-16'
    });

    // `checkout=success` is what paywall.js:392 waits for before re-checking
    // entitlement, so the redirect back must carry it.
    const params = {
      mode,
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${siteUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}&tier=${tier}`,
      cancel_url: `${siteUrl}/?checkout=cancelled`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      metadata: {
        price_id: priceId,
        tier,
        user_id: userId,
        email: email || '',
        acquired_sport: 'nfl',
        product: 'propbetedge_nfl'
      }
    };

    if (mode === 'subscription') {
      params.subscription_data = {
        metadata: {
          tier,
          user_id: userId,
          email: email || '',
          acquired_sport: 'nfl',
          product: 'propbetedge_nfl'
        }
      };
    }

    // Season pass is a one-time payment with a hard expiry, mirroring
    // propbetedge-stripe/src/index.js:240-268. It does not auto-renew, so the
    // webhook has to derive access from metadata rather than from a Stripe
    // subscription period.
    if (tier === 'season_pass') {
      params.metadata.plan = 'nfl_season_pass';
      params.metadata.billing_mode = 'one_time';
      params.metadata.expires_at = SEASON_PASS_EXPIRES_AT;
      params.metadata.access = 'pro';
    }

    const session = await stripe.checkout.sessions.create(params);

    console.log(`[checkout] Session created: ${session.id} for ${userId} (${tier}/${mode})`);
    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('[checkout] Stripe error:', err.message, err.type);
    return res.status(500).json({ error: err.message });
  }
}
