/* PropBetEdge NFL — All Access hero v1 (NFL presentation layer)
 *
 * All Access is the PRIMARY offer; NFL Pro is the single-sport alternative.
 * This module renders the hero card and the "ONLY WANT NFL?" divider that the
 * purchase funnel (paywall-funnel-v2.js) and the home sales surface
 * (nfl-pro-sales-v1.js) place ABOVE the NFL plans for FREE readers, and the
 * upgrade variant shown to NFL PRO ACTIVE members. It never renders for
 * ALL ACCESS ACTIVE or OWNER.
 *
 * The commercial facts come from the shared membership contract
 * (pbe-membership.js -> window.PBEMembership.ALL_ACCESS_OFFER). The literal
 * fallback below is byte-for-byte the same offer so a load-order race can
 * never show a different price or a different checkout link. Checkout is the
 * live Stripe Payment Link; nothing here creates or mutates billing state.
 */
(() => {
  'use strict';

  const FALLBACK_OFFER = Object.freeze({
    name: 'PropBetEdge All Access',
    productKey: 'pbe_all_access',
    price: '$29/month',
    priceUsd: 29,
    tagline: 'Every current and future PropBetEdge Pro sport.',
    promoCode: 'THEEDGE25',
    promoLine: '25% off while active with code THEEDGE25',
    checkoutUrl: 'https://buy.stripe.com/8x2eVdgmOaqy4pv8Ez7wA0N',
    learnUrl: 'https://propbetedge.ai/pro',
  });
  const SPORTS_LINE = 'MLB · NFL · NBA · NHL · WNBA · UFC · Tennis';
  const SPORTS_NEXT = 'plus every Pro sport added next.';
  const NO_HERO_STATES = new Set(['all_access', 'owner']);

  const esc = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function offer() {
    const shared = window.PBEMembership?.ALL_ACCESS_OFFER;
    return shared && shared.checkoutUrl ? shared : FALLBACK_OFFER;
  }

  /** The hero renders for free readers and as an upgrade for NFL Pro members;
   *  never for All Access members or the owner (nothing to sell). */
  function shouldRender(m) {
    return !NO_HERO_STATES.has(String(m?.state || 'free'));
  }

  /* variant: 'modal' (purchase surface, compact), 'home' (homepage band),
     'mini' (sidebar). state: the membership state naming the heading. */
  function heroHtml(m, { variant = 'modal' } = {}) {
    if (!shouldRender(m)) return '';
    const o = offer();
    const upgrade = m?.state === 'sport_pro';
    const title = upgrade ? 'UPGRADE TO ALL ACCESS' : 'ALL ACCESS';
    const [amount, cadence] = String(o.price).split('/');
    return `<aside class="nfl-aa-hero is-${esc(variant)}${upgrade ? ' is-upgrade' : ''}" data-nfl-all-access="hero" data-nfl-all-access-state="${esc(m?.state || 'free')}" aria-label="PropBetEdge All Access">
      <div class="nfl-aa-top">
        <span class="nfl-aa-eyebrow">PROPBETEDGE NETWORK</span>
        <span class="nfl-aa-badge">BEST VALUE · MOST COMPLETE</span>
      </div>
      <div class="nfl-aa-title-row">
        <h3 class="nfl-aa-title">${title}</h3>
        <span class="nfl-aa-price" aria-label="${esc(o.price)}"><strong>${esc(amount)}</strong>/${esc(cadence)}</span>
      </div>
      <p class="nfl-aa-tagline">${esc(o.tagline)}</p>
      <p class="nfl-aa-sports"><b>${esc(SPORTS_LINE)}</b> <span>${esc(SPORTS_NEXT)}</span></p>
      <p class="nfl-aa-promo">Launch offer: ${esc(o.promoLine).replace(o.promoCode, `<b class="nfl-aa-code">${esc(o.promoCode)}</b>`)}</p>
      <div class="nfl-aa-actions">
        <a class="nfl-aa-cta" href="${esc(o.checkoutUrl)}" rel="noopener" data-pbe-placement="all_access_checkout" data-nfl-all-access-cta="checkout">GET ALL ACCESS</a>
        <a class="nfl-aa-learn" href="${esc(o.learnUrl)}" rel="noopener" data-nfl-all-access-cta="learn">WHAT'S INCLUDED</a>
      </div>
    </aside>`;
  }

  /** The seam between the umbrella and the single-sport alternative. */
  function dividerHtml(label = 'ONLY WANT NFL?') {
    return `<div class="nfl-aa-divider" role="separator" aria-label="${esc(label)}" data-nfl-all-access="divider"><span>${esc(label)}</span></div>`;
  }

  /** One-line gold entry for compact chrome (sidebar mini card). */
  function miniHtml(m) {
    if (!shouldRender(m)) return '';
    const o = offer();
    return `<a class="nfl-aa-mini" href="${esc(o.checkoutUrl)}" rel="noopener" data-pbe-placement="all_access_checkout" data-nfl-all-access="mini"><span>ALL ACCESS</span><b>${esc(o.price)}</b><i>every Pro sport →</i></a>`;
  }

  window.NFLAllAccessHero = Object.freeze({ offer, shouldRender, heroHtml, dividerHtml, miniHtml, SPORTS_LINE, SPORTS_NEXT, version: 1 });
})();
