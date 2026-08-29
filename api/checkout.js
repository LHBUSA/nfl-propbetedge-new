/* PropBetEdge NFL — public email-first checkout router
 * New customer flow: email -> Stripe Checkout -> payment -> access email.
 * Existing authenticated customers may omit email; their verified session email is used.
 * Entitlement remains canonical in nfl_subscriptions through the Stripe webhook.
 */

import Stripe from 'stripe';
import { getNflSession, verifiedEmail } from './_nfl-auth.js';

const SITE_URL = 'https://nfl.propbetedge.ai';
const SEASON_PASS_PRICE_ID = 'price_1U9oVzF3CaVzg4ORnk5NiJFA';
const SEASON_PASS_EXPIRES_AT = '2027-02-14T23:59:59-06:00';
const WEEKLY_PRICE_ID = 'price_1U9QUZF3CaVzg4OR3QNfwWCS';

const VALID_PRICES = {
  [SEASON_PASS_PRICE_ID]: { tier: 'season_pass', mode: 'payment' },
  [WEEKLY_PRICE_ID]: { tier: 'weekly', mode: 'subscription' }
};

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^\S+@\S+\.\S+$/.test(email) && email.length <= 254 ? email : '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', SITE_URL);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { priceId } = req.body || {};
  const plan = VALID_PRICES[priceId];
  if (!plan) return res.status(400).json({ error: 'Invalid NFL Pro plan.' });

  let sessionEmail = '';
  try {
    const auth = await getNflSession(req);
    sessionEmail = verifiedEmail(auth) || '';
  } catch (_) {
    // A new purchaser does not need an existing PropBetEdge session.
  }

  const requestedEmail = normalizeEmail(req.body?.email);
  const email = sessionEmail || requestedEmail;
  if (!email) return res.status(400).json({ error: 'Enter a valid email for your NFL Pro access.' });

  if (sessionEmail && requestedEmail && sessionEmail !== requestedEmail) {
    return res.status(409).json({ error: 'Checkout email must match your signed-in PropBetEdge account.' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Secure Stripe checkout is temporarily unavailable.' });
  }

  const siteUrl = process.env.SITE_URL || SITE_URL;
  const { tier, mode } = plan;

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
    const params = {
      mode,
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${siteUrl}/api/checkout-complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/?checkout=cancelled`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      metadata: {
        price_id: priceId,
        tier,
        email,
        acquired_sport: 'nfl',
        product: 'propbetedge_nfl',
        identity_source: sessionEmail ? 'propbetedge_nfl_session' : 'checkout_email'
      }
    };

    if (mode === 'subscription') {
      params.subscription_data = {
        metadata: {
          tier,
          email,
          acquired_sport: 'nfl',
          product: 'propbetedge_nfl',
          identity_source: sessionEmail ? 'propbetedge_nfl_session' : 'checkout_email'
        }
      };
    }

    if (tier === 'season_pass') {
      params.metadata.plan = 'nfl_season_pass';
      params.metadata.billing_mode = 'one_time';
      params.metadata.expires_at = SEASON_PASS_EXPIRES_AT;
      params.metadata.access = 'pro';
    }

    const checkout = await stripe.checkout.sessions.create(params);
    return res.status(200).json({
      url: checkout.url,
      provider: 'stripe_checkout_session',
      tier,
      email_locked: true,
      access_delivery: 'resend_after_payment'
    });
  } catch (error) {
    console.error('[checkout] Stripe session creation failed:', error?.message || error);
    return res.status(502).json({ error: 'Could not open secure Stripe checkout. Please try again.' });
  }
}
