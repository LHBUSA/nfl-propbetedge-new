/* PropBetEdge membership contract — ONE vocabulary for every sport frontend.
 *
 * Copied verbatim into each sport repo (server AND client). Canonical source:
 * LHBUSA/propbetedge-workers shared/membership/pbe-membership.js.
 *
 * The state is derived ONLY from the backend entitlement decision (the billing
 * Worker's verdict, the NFL ledger verdict, or the MLB auth Worker's verdict).
 * The browser never decides entitlement, never infers All Access from plan
 * names or prices, and never sees ledger internals. This module is pure.
 *
 *   FREE        — no current entitlement (anonymous, unknown, canceled, expired, past_due)
 *   SPORT_PRO   — this sport's own plan grants (access_source 'sport')
 *   ALL_ACCESS  — the network umbrella grants (access_source 'all_access')
 *   OWNER       — verified owner identity (access_source 'owner')
 */

export const CONTRACT_VERSION = '1.2.0';

export const SPORT_LABELS = Object.freeze({ mlb: 'MLB', nfl: 'NFL', nba: 'NBA', nhl: 'NHL', wnba: 'WNBA', ufc: 'UFC', tennis: 'Tennis' });

export const ALL_ACCESS_URL = 'https://propbetedge.ai/pro';
export const MANAGE_URL = 'https://billing.stripe.com/p/login/cNi3cv2vY7em3lr4oj7wA00';

/* The live All Access commercial facts (verified against Stripe 2026-09-24).
   Display only: checkout is Stripe's own Payment Link. Never create another. */
export const ALL_ACCESS_OFFER = Object.freeze({
  name: 'PropBetEdge All Access',
  productKey: 'pbe_all_access',
  price: '$29/month',
  priceUsd: 29,
  tagline: 'Every current and future PropBetEdge Pro sport.',
  promoCode: 'THEEDGE25',
  promoLine: '25% off while active with code THEEDGE25',
  checkoutUrl: 'https://buy.stripe.com/8x2eVdgmOaqy4pv8Ez7wA0N',
  learnUrl: ALL_ACCESS_URL,
});

export const NETWORK = Object.freeze([
  { key: 'mlb', label: 'MLB', name: 'PropBetEdge MLB', url: 'https://mlb.propbetedge.ai' },
  { key: 'nfl', label: 'NFL', name: 'PropBetEdge NFL', url: 'https://nfl.propbetedge.ai' },
  { key: 'nba', label: 'NBA', name: 'PropBetEdge NBA', url: 'https://nba.propbetedge.ai' },
  { key: 'nhl', label: 'NHL', name: 'PropBetEdge NHL', url: 'https://nhl.propbetedge.ai' },
  { key: 'wnba', label: 'WNBA', name: 'PropBetEdge WNBA', url: 'https://wnba.propbetedge.ai' },
  { key: 'ufc', label: 'UFC', name: 'PropBetEdge UFC', url: 'https://ufc.propbetedge.ai' },
  { key: 'tennis', label: 'Tennis', name: 'PropBetEdge Tennis', url: 'https://tennis.propbetedge.ai' },
]);

export const STATES = Object.freeze(['free', 'sport_pro', 'all_access', 'owner']);
const SOURCES = new Set(['sport', 'all_access', 'owner']);
/* Legacy tiers inside sport_pro. 'founding' = a lifetime/grandfathered sport
   entitlement with no recurring billing (MLB founding_member and the pre-
   paywall lifetime cohort); 'season_pass' = a one-time pass with an end date.
   Decided server-side from the sport's own ledger, never by the browser. */
export const LEGACY_TIERS = Object.freeze(['founding', 'season_pass']);

/** Server side. Turn the authoritative verdict into the browser-safe object.
 *  `entitled` and `accessSource` come from the entitlement decision, nothing
 *  else. Unknown/absent source with entitled=true is treated as the sport's
 *  own plan (legacy ledgers that predate access_source). */
export function deriveMembership({ sport, entitled = false, accessSource = null, productKey = null, plan = null, email = null, currentPeriodEnd = null, cancelAtPeriodEnd = false, legacyTier = null, hasBilling = null } = {}) {
  const sportKey = String(sport || '').toLowerCase();
  const source = SOURCES.has(accessSource) ? accessSource : (entitled ? 'sport' : null);
  const state = !entitled ? 'free' : source === 'owner' ? 'owner' : source === 'all_access' ? 'all_access' : 'sport_pro';
  const tier = state === 'sport_pro' && LEGACY_TIERS.includes(legacyTier) ? legacyTier : null;
  /* A founding/lifetime member has nothing to manage unless the ledger says a
     paid subscription also exists (hasBilling). Season passes are one-time. */
  const billed = hasBilling === null ? tier === null : Boolean(hasBilling);
  return {
    contract: CONTRACT_VERSION,
    sport: sportKey,
    state,
    legacy_tier: tier,
    label: membershipLabel(state, sportKey, tier),
    sublabel: tier === 'founding' ? `Lifetime ${SPORT_LABELS[sportKey] || sportKey.toUpperCase()} access` : tier === 'season_pass' ? 'Season pass' : null,
    entitled: Boolean(entitled),
    access_source: entitled ? source : null,
    product_key: entitled ? (productKey || null) : null,
    plan: entitled ? (plan || null) : null,
    email: email || null,
    current_period_end: entitled ? (currentPeriodEnd || null) : null,
    cancel_at_period_end: entitled ? Boolean(cancelAtPeriodEnd) : false,
    manage_url: MANAGE_URL,
    network_url: ALL_ACCESS_URL,
    /* UI rules, decided once here so no sport re-derives them */
    show_purchase_cta: state === 'free',
    show_all_access_upgrade: state === 'sport_pro',
    show_manage: state === 'all_access' || (state === 'sport_pro' && billed),
  };
}

/** The labels, exactly. A legacy tier only refines the sport_pro label. */
export function membershipLabel(state, sport, legacyTier = null) {
  const sportLabel = SPORT_LABELS[String(sport || '').toLowerCase()] || String(sport || '').toUpperCase() || 'SPORT';
  if (state === 'owner') return 'OWNER';
  if (state === 'all_access') return 'ALL ACCESS ACTIVE';
  if (state === 'sport_pro') {
    if (legacyTier === 'founding') return 'FOUNDING MEMBER';
    if (legacyTier === 'season_pass') return `${sportLabel} SEASON PASS`;
    return `${sportLabel} PRO ACTIVE`;
  }
  return 'FREE';
}

/** Client side. Accept only the browser-safe object a server built; anything
 *  malformed is FREE. Never widens access. */
export function readMembership(value, sport) {
  const m = value && typeof value === 'object' ? value : null;
  if (!m || !STATES.includes(m.state) || m.entitled !== true && m.state !== 'free') return deriveMembership({ sport, entitled: false });
  if (m.state === 'free') return deriveMembership({ sport, entitled: false, email: m.email || null });
  return deriveMembership({
    sport: m.sport || sport,
    entitled: true,
    accessSource: m.access_source,
    productKey: m.product_key,
    plan: m.plan,
    email: m.email,
    currentPeriodEnd: m.current_period_end,
    cancelAtPeriodEnd: m.cancel_at_period_end,
    legacyTier: m.legacy_tier || null,
    hasBilling: typeof m.show_manage === 'boolean' && m.state === 'sport_pro' ? m.show_manage : null,
  });
}

/** Short human plan text for the account panel; never used for the decision. */
export function planText(m) {
  if (!m || !m.entitled) return '';
  if (m.state === 'owner') return 'Owner access';
  if (m.state === 'all_access') return 'All Access · every PropBetEdge sport';
  if (m.legacy_tier === 'founding') return m.sublabel || 'Lifetime access';
  if (m.legacy_tier === 'season_pass') return `${SPORT_LABELS[m.sport] || m.sport.toUpperCase()} season pass${m.current_period_end ? ` · through ${String(m.current_period_end).slice(0, 10)}` : ''}`;
  const plan = String(m.plan || '').replace(/_/g, ' ').trim();
  return plan ? `${SPORT_LABELS[m.sport] || m.sport.toUpperCase()} Pro · ${plan}` : `${SPORT_LABELS[m.sport] || m.sport.toUpperCase()} Pro`;
}

/* ---- shared markup (plain strings so every runtime can use them) ---- */

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The membership badge. Class hooks: .pbe-mbr-badge.is-{state} */
export function membershipBadgeHtml(m) {
  const state = STATES.includes(m?.state) ? m.state : 'free';
  const tier = LEGACY_TIERS.includes(m?.legacy_tier) ? m.legacy_tier : null;
  return `<span class="pbe-mbr-badge is-${state}${tier ? ` is-${tier}` : ''}" data-pbe-membership="${state}">${esc(membershipLabel(state, m?.sport, tier))}</span>`;
}

/** Manage-subscription link (only when the member has a subscription). */
export function manageLinkHtml(m, label = 'Manage subscription') {
  if (!m?.show_manage) return '';
  return `<a class="pbe-mbr-manage" href="${MANAGE_URL}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;
}

/** The All Access upgrade card shown to FREE and SPORT_PRO users; never to
 *  ALL_ACCESS or OWNER. `sportPlanHtml` is the sport's own plan block (kept
 *  intact); the umbrella sits beneath it as the premium option. */
export function allAccessCardHtml(m, { compact = false } = {}) {
  if (m?.state === 'all_access' || m?.state === 'owner') return '';
  const heading = m?.state === 'sport_pro' ? 'Upgrade to All Access' : 'All Access';
  return `<aside class="pbe-mbr-aa${compact ? ' is-compact' : ''}" aria-label="PropBetEdge All Access">
    <div class="pbe-mbr-aa-head"><span class="pbe-mbr-aa-eyebrow">PropBetEdge Network</span><span class="pbe-mbr-aa-price">${esc(ALL_ACCESS_OFFER.price)}</span></div>
    <h3 class="pbe-mbr-aa-title">${esc(heading)}</h3>
    <p class="pbe-mbr-aa-copy">${esc(ALL_ACCESS_OFFER.tagline)} MLB · NFL · NBA · NHL · WNBA · UFC · Tennis, plus every sport added next.</p>
    <p class="pbe-mbr-aa-promo">Launch offer: ${esc(ALL_ACCESS_OFFER.promoLine)}</p>
    <div class="pbe-mbr-aa-actions">
      <a class="pbe-mbr-aa-cta" href="${ALL_ACCESS_OFFER.checkoutUrl}" rel="noopener" data-pbe-placement="all_access_checkout">Get All Access →</a>
      <a class="pbe-mbr-aa-learn" href="${ALL_ACCESS_URL}" rel="noopener">What's included</a>
    </div>
  </aside>`;
}

/** Restrained network row for the account flyout: every PropBetEdge sport, current one marked. */
export function networkLinksHtml(currentSport) {
  return `<nav class="pbe-mbr-network" aria-label="PropBetEdge network">${NETWORK.map((s) =>
    `<a href="${s.url}" ${s.key === currentSport ? 'aria-current="page" class="is-current"' : 'rel="noopener"'}>${esc(s.label)}</a>`).join('')}</nav>`;
}

/** The account panel body shared by every sport: state badge, email, plan,
 *  manage link, network. Sport chrome wraps it; nothing here is sport-styled. */
export function accountPanelHtml(m, { sport } = {}) {
  const email = m?.email ? `<span class="pbe-mbr-email">${esc(m.email)}</span>` : '';
  const plan = planText(m);
  return `<div class="pbe-mbr-panel" data-pbe-membership="${esc(m?.state || 'free')}">
    <div class="pbe-mbr-row">${membershipBadgeHtml(m)}${email}</div>
    ${plan ? `<p class="pbe-mbr-plan">${esc(plan)}</p>` : ''}
    <div class="pbe-mbr-links">${manageLinkHtml(m)}<a class="pbe-mbr-network-link" href="${ALL_ACCESS_URL}" rel="noopener">${m?.state === 'all_access' ? 'Your network' : 'PropBetEdge All Access'}</a></div>
    ${networkLinksHtml(sport || m?.sport)}
  </div>`;
}
