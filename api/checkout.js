/* PropBetEdge NFL — authenticated checkout router
 * Identity: first-party PropBetEdge NFL Worker session cookie.
 * Billing: Stripe Checkout Session, with locked-email Payment Link fallback.
 * Entitlement: canonical Supabase nfl-stripe-webhook keyed by verified email.
 */

import Stripe from 'stripe';
import { getNflSession, verifiedEmail } from './_nfl-auth.js';

const SEASON_PASS_PRICE_ID = 'price_1U9oVzF3CaVzg4ORnk5NiJFA';
const SEASON_PASS_EXPIRES_AT = '2027-02-14T23:59:59-06:00';
const SEASON_PASS_PAYMENT_LINK = 'https://buy.stripe.com/cNidR9eeGbuCe05f2X7wA06';

const WEEKLY_PRICE_ID = 'price_1U9QUZF3CaVzg4OR3QNfwWCS';
const WEEKLY_PAYMENT_LINK = 'https://buy.stripe.com/fZueVd1rU0PYg8d8Ez7wA05';

const VALID_PRICES = {
  [SEASON_PASS_PRICE_ID]: { tier: 'season_pass', mode: 'payment', paymentLink: SEASON_PASS_PAYMENT_LINK },
  [WEEKLY_PRICE_ID]: { tier: 'weekly', mode: 'subscription', paymentLink: WEEKLY_PAYMENT_LINK }
};

function paymentLinkUrl(base, email) {
  try {
    const url = new URL(base);
    if (email) url.searchParams.set('locked_prefilled_email', email);
    return url.toString();
  } catch (_) {
    return base;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://nfl.propbetedge.ai');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { priceId } = req.body || {};
  const plan = VALID_PRICES[priceId];
  if (!plan) return res.status(400).json({ error: `Invalid price ID: ${priceId}` });

  let auth;
  try {
    auth = await getNflSession(req);
  } catch (error) {
    console.error('[checkout] NFL session service failed:', error?.message || error);
    return res.status(503).json({ error: 'session_unavailable', entitlement: 'nfl_pro' });
  }

  const email = verifiedEmail(auth);
  if (!email) return res.status(401).json({ error: 'sign_in_required', entitlement: 'nfl_pro' });

  const { tier, mode, paymentLink } = plan;

  /* Payment Links remain a real production fallback. The live NFL links already
   * carry canonical product/plan metadata and the customer email is locked to
   * the verified PropBetEdge session email. */
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(200).json({
      url: paymentLinkUrl(paymentLink, email),
      provider: 'stripe_payment_link',
      tier,
      identity: 'propbetedge_nfl_session'
    });
  }

  const siteUrl = process.env.SITE_URL || 'https://nfl.propbetedge.ai';

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
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
        email,
        acquired_sport: 'nfl',
        product: 'propbetedge_nfl',
        identity_source: 'propbetedge_nfl_session'
      }
    };

    if (mode === 'subscription') {
      params.subscription_data = {
        metadata: {
          tier,
          email,
          acquired_sport: 'nfl',
          product: 'propbetedge_nfl',
          identity_source: 'propbetedge_nfl_session'
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
    return res.status(200).json({
      url: session.url,
      provider: 'stripe_checkout_session',
      tier,
      identity: 'propbetedge_nfl_session'
    });
  } catch (error) {
    console.error('[checkout] Stripe session failed; returning locked Payment Link fallback:', error?.message || error);
    return res.status(200).json({
      url: paymentLinkUrl(paymentLink, email),
      provider: 'stripe_payment_link_fallback',
      tier,
      identity: 'propbetedge_nfl_session'
    });
  }
}
