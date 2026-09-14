/* PropBetEdge NFL — resilient email-first checkout router
 * Preferred: server-created Stripe Checkout Session when STRIPE_SECRET_KEY exists.
 * Fallback: live Stripe Payment Link with locked_prefilled_email.
 * Never return a 503 just because Vercel is missing a Stripe secret.
 */

import Stripe from 'stripe';
import { getNflSession, verifiedEmail } from './_nfl-auth.js';

const SITE_URL = 'https://nfl.propbetedge.ai';
/* Only the 2026 Founding Season plans are sold (the same prices and Payment
   Links as window.PBEPricing in paywall.js). The retired $9.99/week and $99
   Season Pass prices are never offered here; existing holders of those prices
   remain recognized by api/_nfl-entitlement.js and workers/nfl-billing. */
const MONTHLY_PRICE_ID = 'price_1UEWAXF3CaVzg4ORGlsgboLq';
const WEEKLY_PRICE_ID = 'price_1UEWAOF3CaVzg4ORjkWpwOz9';
const PAYMENT_LINKS = {
  [MONTHLY_PRICE_ID]: 'https://buy.stripe.com/eVqeVd1rUcyG5tz2gb7wA0y',
  [WEEKLY_PRICE_ID]: 'https://buy.stripe.com/9B628rb2udCK5tzf2X7wA0x'
};

const VALID_PRICES = {
  [MONTHLY_PRICE_ID]: { tier: 'founding_monthly', mode: 'subscription' },
  [WEEKLY_PRICE_ID]: { tier: 'founding_weekly', mode: 'subscription' }
};
const PLAN_KEYS = { monthly: MONTHLY_PRICE_ID, weekly: WEEKLY_PRICE_ID };

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

  const requested = String(req.body?.priceId || req.body?.plan || '');
  const priceId = PLAN_KEYS[requested] || requested;
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
