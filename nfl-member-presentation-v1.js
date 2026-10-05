/* PropBetEdge NFL — member presentation v1 (display vocabulary only).
 *
 * Owner decision 2026-10-05: an active PropBetEdge All Access customer is
 * PRESENTED as a Platinum Member. Nothing here decides access and nothing is
 * renamed underneath: the server's shared membership contract still says
 * state 'all_access', the Stripe product is still PropBetEdge All Access, and
 * there is no separate Platinum product or SKU. This module only turns the verdict the
 * server already gave (pro + membership.state) into the words on screen.
 *
 *   all_access  PLATINUM MEMBER   badge ◆ PLATINUM   status PLATINUM ACCESS ACTIVE
 *               always beside the true product: PropBetEdge All Access · 10 sports + Predictions
 *   sport_pro   NFL PRO MEMBER    (a legacy tier keeps the server's own label where the contract carries one)
 *   owner       VERIFIED OWNER
 *
 * Signed-in readers without access are never labelled FREE.
 *
 * The /all-access constants live here too, so no file overloads one URL for
 * three jobs:
 *   LOCAL_ALL_ACCESS_PATH   the NFL-native All Access page (information, members)
 *   NETWORK_ALL_ACCESS_URL  the network hub page (reference only, not customer navigation)
 *   ALL_ACCESS_CHECKOUT_URL the existing Stripe Payment Link (explicit purchase CTAs only)
 */
(() => {
  'use strict';

  const LOCAL_ALL_ACCESS_PATH = '/all-access';
  const NETWORK_ALL_ACCESS_URL = 'https://propbetedge.ai/pro';
  /* Same literal as pbe-membership.js ALL_ACCESS_OFFER.checkoutUrl (pinned by tests). */
  const ALL_ACCESS_CHECKOUT_URL = 'https://buy.stripe.com/8x2eVdgmOaqy4pv8Ez7wA0N';
  const ALL_ACCESS_PRODUCT = 'PropBetEdge All Access';
  const ALL_ACCESS_LINE = '10 sports + Predictions';

  /* The rendered member state, from the server verdict only. */
  function stateOf(m, fallback) {
    if (m?.entitled === true && ['sport_pro', 'all_access', 'owner'].includes(m.state)) return m.state;
    return ['sport_pro', 'all_access', 'owner'].includes(fallback) ? fallback : null;
  }

  function display(m, fallback) {
    const state = stateOf(m, fallback);
    if (state === 'all_access') {
      return Object.freeze({
        state, platinum: true,
        designation: 'PLATINUM MEMBER',
        badge: '◆ PLATINUM',
        status: 'PLATINUM ACCESS ACTIVE',
        header: '◆ PLATINUM',
        headerShort: 'PLATINUM',
        eyebrow: 'NFL · PLATINUM MEMBER',
        product: `${ALL_ACCESS_PRODUCT} · ${ALL_ACCESS_LINE}`,
        plan: `${ALL_ACCESS_PRODUCT} · active`,
      });
    }
    if (state === 'owner') {
      return Object.freeze({
        state, platinum: false,
        designation: 'VERIFIED OWNER', badge: 'VERIFIED OWNER', status: 'VERIFIED OWNER',
        header: 'VERIFIED OWNER', headerShort: 'OWNER',
        eyebrow: 'NFL · VERIFIED OWNER',
        product: 'Owner access · no subscription required',
        plan: 'Owner access',
      });
    }
    if (state === 'sport_pro') {
      const legacy = m?.entitled === true && ['founding', 'season_pass'].includes(m.legacy_tier) && m.label ? String(m.label) : null;
      const name = legacy || 'NFL PRO MEMBER';
      return Object.freeze({
        state, platinum: false,
        designation: name, badge: name, status: legacy || 'NFL PRO ACTIVE',
        header: name, headerShort: 'NFL PRO',
        eyebrow: legacy ? `NFL · ${legacy}` : 'NFL PRO MEMBER',
        product: 'NFL Pro',
        plan: null,
      });
    }
    return null;
  }

  /* The verified badge, styled by the shared .pbe-mbr-badge rules plus the
     NFL platinum accent; the data attribute keeps the real contract state. */
  function badgeHtml(m, fallback) {
    const d = display(m, fallback);
    if (!d) return '';
    const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return `<span class="pbe-mbr-badge is-${d.state}${d.platinum ? ' is-platinum' : ''}" data-pbe-membership="${d.state}">${esc(d.badge)}</span>`;
  }

  window.PBENflMember = Object.freeze({
    display, badgeHtml, stateOf,
    LOCAL_ALL_ACCESS_PATH, NETWORK_ALL_ACCESS_URL, ALL_ACCESS_CHECKOUT_URL,
    ALL_ACCESS_PRODUCT, ALL_ACCESS_LINE, version: 1,
  });
})();
