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
  /* The network, as published by the canonical family registry. This block is
     GENERATED from network-family.json (keys, labels, names, urls, order) and
     tests/nfl-all-access-page.test.mjs fails if it drifts from that file, so a
     sport added to the registry changes this card or fails the build. */
  const FAMILY = Object.freeze(/* family:begin */{
    "sports": [
      {
        "key": "mlb",
        "label": "MLB",
        "name": "PropBetEdge MLB",
        "url": "https://mlb.propbetedge.ai/"
      },
      {
        "key": "nfl",
        "label": "NFL",
        "name": "PropBetEdge NFL",
        "url": "https://nfl.propbetedge.ai/"
      },
      {
        "key": "nba",
        "label": "NBA",
        "name": "PropBetEdge NBA",
        "url": "https://nba.propbetedge.ai/"
      },
      {
        "key": "wnba",
        "label": "WNBA",
        "name": "PropBetEdge WNBA",
        "url": "https://wnba.propbetedge.ai/"
      },
      {
        "key": "nhl",
        "label": "NHL",
        "name": "PropBetEdge NHL",
        "url": "https://nhl.propbetedge.ai/"
      },
      {
        "key": "ufc",
        "label": "UFC",
        "name": "PropBetEdge UFC",
        "url": "https://ufc.propbetedge.ai/"
      },
      {
        "key": "tennis",
        "label": "Tennis",
        "name": "PropBetEdge Tennis",
        "url": "https://tennis.propbetedge.ai/"
      },
      {
        "key": "soccer",
        "label": "Soccer",
        "name": "PropBetEdge Soccer",
        "url": "https://soccer.propbetedge.ai/"
      },
      {
        "key": "golf",
        "label": "Golf",
        "name": "PropBetEdge Golf",
        "url": "https://golf.propbetedge.ai/"
      },
      {
        "key": "f1",
        "label": "F1",
        "name": "F1 Intelligence",
        "url": "https://f1.propbetedge.ai/"
      }
    ],
    "products": [
      {
        "key": "predictions",
        "label": "Predictions",
        "name": "PropBetEdge Predictions",
        "url": "https://predictions.propbetedge.ai/"
      }
    ]
  }/* family:end */);
  /* Display name: the sport label, or the registry's own product name where it
     is not "PropBetEdge <label>" (F1 is published as "F1 Intelligence"). */
  const displayName = (e) => (e.name === `PropBetEdge ${e.label}` ? e.label : e.name);
  const SPORT_NAMES = Object.freeze(FAMILY.sports.map(displayName));
  const PRODUCT_NAMES = Object.freeze(FAMILY.products.map((p) => p.name));
  const SPORTS_LINE = SPORT_NAMES.join(' · ');
  /* "10 sports + PropBetEdge Predictions." Predictions is a product, never a sport. */
  const VALUE_LINE = `${FAMILY.sports.length} sports + ${PRODUCT_NAMES.join(' + ')}.`;
  const SUPPORT_LINE = 'One membership across the PropBetEdge intelligence network.';
  const SPORTS_NEXT = 'Future PropBetEdge Pro sports join All Access at launch.';
  const NO_HERO_STATES = new Set(['all_access', 'owner']);
  /* WHAT'S INCLUDED and the compact mini are information, not purchase: they
     open the NFL-native All Access page. Only GET ALL ACCESS goes to Stripe. */
  const LOCAL_ALL_ACCESS_PATH = '/all-access';

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
      <p class="nfl-aa-tagline"><b class="nfl-aa-value">${esc(VALUE_LINE)}</b><span class="nfl-aa-support">${esc(SUPPORT_LINE)}</span></p>
      <div class="nfl-aa-sports">
        <span class="nfl-aa-k">SPORTS · ${FAMILY.sports.length}</span>
        <b>${esc(SPORTS_LINE)}</b>
        <span class="nfl-aa-intel"><span class="nfl-aa-k">INTELLIGENCE</span><b>◆ ${esc(PRODUCT_NAMES.join(' · '))}</b></span>
        <span class="nfl-aa-next">${esc(SPORTS_NEXT)}</span>
      </div>
      <p class="nfl-aa-promo">Launch offer: ${esc(o.promoLine).replace(o.promoCode, `<b class="nfl-aa-code">${esc(o.promoCode)}</b>`)}</p>
      <div class="nfl-aa-actions">
        <a class="nfl-aa-cta" href="${esc(o.checkoutUrl)}" rel="noopener" data-pbe-placement="all_access_checkout" data-nfl-all-access-cta="checkout">GET ALL ACCESS</a>
        <a class="nfl-aa-learn" href="${LOCAL_ALL_ACCESS_PATH}" data-nfl-all-access-cta="learn">WHAT'S INCLUDED</a>
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
    /* Owner link policy (2026-10-05): the ALL ACCESS promo is a purchase action and
       keeps the canonical All Access Stripe Payment Link; only informational links
       (WHAT'S INCLUDED, the network) open the local /all-access page. */
    return `<a class="nfl-aa-mini" href="${esc(o.checkoutUrl)}" rel="noopener" data-pbe-placement="all_access_checkout" data-nfl-all-access="mini"><span>ALL ACCESS</span><b>${esc(o.price)}</b><i>${FAMILY.sports.length} sports + Predictions →</i></a>`;
  }

  window.NFLAllAccessHero = Object.freeze({ offer, shouldRender, heroHtml, dividerHtml, miniHtml, FAMILY, SPORT_NAMES, PRODUCT_NAMES, SPORTS_LINE, VALUE_LINE, SUPPORT_LINE, SPORTS_NEXT, LOCAL_ALL_ACCESS_PATH, displayName, version: 2 });
})();
