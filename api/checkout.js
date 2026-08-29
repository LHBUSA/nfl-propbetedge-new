/* PropBetEdge NFL — resilient email-first checkout router
 * Preferred: server-created Stripe Checkout Session when STRIPE_SECRET_KEY exists.
 * Fallback: live Stripe Payment Link with locked_prefilled_email.
 * Never return a 503 just because Vercel is missing a Stripe secret.
 */

import Stripe from 'stripe';
import { getNflSession, verifiedEmail } from './_nfl-auth.js';

const SITE_URL = 'https://nfl.propbetedge.ai';
const SEASON_PASS_PRICE_ID = 'price_1U9oVzF3CaVzg4ORnk5NiJFA';
const SEASON_PASS_EXPIRES_AT = '2027-02-14T23:59:59-06:00';
const WEEKLY_PRICE_ID = 'price_1U9QUZF3CaVzg4OR3QNfwWCS';
const PAYMENT_LINKS = {
  [SEASON_PASS_PRICE_ID]: 'https://buy.stripe.com/cNidR9eeGbuCe05f2X7wA06',
  [WEEKLY_PRICE_ID]: 'https://buy.stripe.com/fZueVd1rU0PYg8d8Ez7wA05'
};

const VALID_PRICES = {
  [SEASON_PASS_PRICE_ID]: { tier: 'season_pass', mode: 'payment' },
  [WEEKLY_PRICE_ID]: { tier: 'weekly', mode: 'subscription' }
};

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^\S+@\S+\.\S+$/.test(email) && email.length <= 254 ? email : '';
}

function paymentLinkUrl(priceId, email) {
  const base = PAYMENT_LINKS[priceId];
  if (!base) return '';
  const url = new URL(base);
  url.searchParams.set('locked_prefilled_email', email);
  return url.toString();
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
    // New buyers do not need an existing session.
  }

  const requestedEmail = normalizeEmail(req.body?.email);
  const email = sessionEmail || requestedEmail;
  if (!email) return res.status(400).json({ error: 'Enter a valid email for your NFL Pro access.' });
  if (sessionEmail && requestedEmail && sessionEmail !== requestedEmail) {
    return res.status(409).json({ error: 'Checkout email must match your signed-in PropBetEdge account.' });
  }

  const fallbackUrl = paymentLinkUrl(priceId, email);
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(200).json({
      url: fallbackUrl,
      provider: 'stripe_payment_link',
      tier: plan.tier,
      email_locked: true,
      access_delivery: 'stripe_webhook_then_resend'
    });
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
      access_delivery: 'stripe_webhook_then_resend'
    });
  } catch (error) {
    console.error('[checkout] Stripe session creation failed; falling back to Payment Link:', error?.message || error);
    return res.status(200).json({
      url: fallbackUrl,
      provider: 'stripe_payment_link_fallback',
      tier,
      email_locked: true,
      access_delivery: 'stripe_webhook_then_resend'
    });
  }
}
