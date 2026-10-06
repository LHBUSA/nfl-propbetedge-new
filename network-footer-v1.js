/* PropBetEdge NFL — premium sports-network footer */
(() => {
  'use strict';

  const FOOTER_ID = 'pbe-network-footer';
  const BILLING = 'https://billing.stripe.com/p/login/cNi3cv2vY7em3lr4oj7wA00';
  /* PropBetEdge All Access: ALL ACCESS + WHAT'S INCLUDED open the NFL-native
     All Access page in the same tab (the reader stays on NFL). Checkout stays
     on the page's explicit GET ALL ACCESS action. */
  const ALL_ACCESS = '/all-access';

  /* Family registry: kept in parity with network-family.json (vendored from
     propbetedge-workers shared/network/family.json; tests/nfl-network-family-parity.test.mjs). */
  const SPORTS = [
    { key: 'mlb', label: 'MLB', sub: 'Baseball', href: 'https://mlb.propbetedge.ai/' },
    { key: 'nfl', label: 'NFL', sub: 'Football', current: true, route: 'home' },
    { key: 'nba', label: 'NBA', sub: 'Basketball', href: 'https://nba.propbetedge.ai/' },
    { key: 'wnba', label: 'WNBA', sub: "Women's Basketball", href: 'https://wnba.propbetedge.ai/', live: true },
    { key: 'nhl', label: 'NHL', sub: 'Hockey', href: 'https://nhl.propbetedge.ai/' },
    { key: 'ufc', label: 'UFC', sub: 'Fight Intelligence', href: 'https://ufc.propbetedge.ai/' },
    { key: 'tennis', label: 'Tennis', sub: 'Tennis Intelligence', href: 'https://tennis.propbetedge.ai/' },
    { key: 'soccer', label: 'Soccer', sub: 'Soccer Intelligence', href: 'https://soccer.propbetedge.ai/' },
    { key: 'golf', label: 'Golf', sub: 'Golf Intelligence', href: 'https://golf.propbetedge.ai/' },
    { key: 'f1', label: 'F1', sub: 'F1 Intelligence', href: 'https://f1.propbetedge.ai/' }
  ];
  /* All Access products: never a sport, never in the sports grid or its count. */
  const PRODUCTS = [
    { key: 'members', label: 'Command Center', href: 'https://members.propbetedge.ai/' },
    { key: 'compare', label: 'Compare', href: 'https://compare.propbetedge.ai/' },
    { key: 'predictions', label: 'Predictions', href: 'https://predictions.propbetedge.ai/' }
  ];

  function sportTile(sport) {
    const attrs = sport.current
      ? `href="/#${sport.route}" data-pbe-footer-route="${sport.route}"`
      : `href="${sport.href}" target="_blank" rel="noopener"`;
    return `<a class="pbe-network-sport ${sport.key}${sport.current ? ' current' : ''}" ${attrs}>
      <span class="pbe-network-sport-top"><b>${sport.label}</b>${sport.current ? '<em>CURRENT</em>' : sport.live ? '<em>LIVE</em>' : '<i>↗</i>'}</span>
      <span class="pbe-network-sport-sub">${sport.sub}</span>
      <span class="pbe-network-sport-line"></span>
    </a>`;
  }

  function html() {
    const year = new Date().getFullYear();
    return `<footer id="${FOOTER_ID}" class="pbe-network-footer" aria-label="PropBetEdge sports network and NFL account management">
      <div class="pbe-network-footer-shell">
        <section class="pbe-network-footer-intro">
          <div class="pbe-network-footer-lockup">
            <a class="pbe-network-footer-logo" href="https://propbetedge.ai" aria-label="PropBetEdge home">
              <img src="https://propbetedge.ai/logo/pbe-full-400.png" alt="PropBetEdge" loading="lazy" decoding="async">
            </a>
            <div class="pbe-network-footer-copy">
              <span>THE PROPBETEDGE SPORTS NETWORK</span>
              <h2>One network. <em>Sport-native intelligence.</em></h2>
              <p>Markets, models, live context, verified decisions and deep research — built independently for how each sport actually works.</p>
            </div>
          </div>
          <div class="pbe-network-live-mark" aria-label="Ten live PropBetEdge sport products">
            <span><i></i> LIVE NETWORK</span>
            <strong>${SPORTS.length}</strong>
            <small>SPORT PRODUCTS</small>
          </div>
        </section>

        <section class="pbe-network-sports" aria-label="PropBetEdge sports products">
          ${SPORTS.map(sportTile).join('')}
        </section>

        <nav class="pbe-network-intel" aria-label="PropBetEdge All Access">
          <span>ALL ACCESS</span>
          <a href="https://propbetedge.ai/pro">All Access</a>
          ${PRODUCTS.map((p) => `<a href="${p.href}">${p.label}</a>`).join('')}
        </nav>

        <section class="pbe-network-footer-console">
          <div class="pbe-network-nflpro">
            <div class="pbe-network-console-head">
              <div><span>NFL PRO</span><strong>Your football intelligence desk</strong></div>
              <a href="/#pbepicks" data-pbe-footer-route="pbepicks" class="pbe-network-primary-link">Today's PBE Card <b>→</b></a>
            </div>
            <nav class="pbe-network-nfl-links" aria-label="NFL Pro navigation">
              <a href="/#pbepicks" data-pbe-footer-route="pbepicks" class="featured">PBE Picks <em>LIVE</em></a>
              <a href="/#propboard" data-pbe-footer-route="propboard">Prop Board</a>
              <a href="/#pbecast" data-pbe-footer-route="pbecast">PBEcast</a>
              <a href="/#matchups" data-pbe-footer-route="matchups">Matchups</a>
              <a href="/#bestline" data-pbe-footer-route="bestline">Best Line</a>
              <a href="/#trackrecord" data-pbe-footer-route="trackrecord">Track Record</a>
            </nav>
          </div>

          <aside class="pbe-footer-account-card" aria-label="NFL Pro account controls">
            <div class="pbe-footer-account-card-head">
              <div class="pbe-footer-account-state"><i data-pbe-footer-account-dot></i><div><span>ACCESS</span><strong data-pbe-footer-account-state>NFL Pro account</strong></div></div>
              <button type="button" data-pbe-footer-account>Open account</button>
            </div>
            <p data-pbe-footer-account-copy>Passwordless access · secure billing</p>
            <div class="pbe-footer-account-card-links">
              <a href="${ALL_ACCESS}" class="pbe-footer-aa-link" data-pbe-footer-all-access>ALL ACCESS</a>
              <a href="${ALL_ACCESS}" data-pbe-footer-all-access-included>WHAT'S INCLUDED</a>
              <a href="${BILLING}" target="_blank" rel="noopener" data-pbe-footer-manage hidden>Manage subscription ↗</a>
              <a href="https://discord.gg/kb5zCTHbME" target="_blank" rel="noopener">Member community ↗</a>
            </div>
          </aside>
        </section>

        ${window.PBEPreferredSource?.render({ surface: 'footer' }) || ''}

        <nav class="pbe-network-intel" aria-label="PropBetEdge editorial and legal">
          <span>EDITORIAL &amp; LEGAL</span>
          <a href="https://propbetedge.ai/about">About PropBetEdge</a>
          <a href="https://propbetedge.ai/terms">Terms</a>
          <a href="https://propbetedge.ai/legal">Legal</a>
          <a href="https://propbetedge.ai/support">Support</a>
          </nav>

        <section class="pbe-network-footer-ecosystem">
          <div class="pbe-network-ecosystem-brand">
            <strong>PropBetEdge</strong>
            <span>Independent sports intelligence built from the data layer up.</span>
          </div>
          <nav aria-label="PropBetEdge ecosystem">
            <a href="${ALL_ACCESS}" class="pbe-footer-aa-link">ALL ACCESS</a>
            <a href="https://propbetedge.ai/">Sports News</a>
            <a href="https://learn.propbetedge.ai/">Learn</a>
            <a href="https://propbetedge.ai/terms">Terms</a>
            <a href="https://propbetedge.ai/support">Support</a>
            <a href="https://propbetedge.ai/media">Media</a>
            <a href="https://propsports.proptechusa.ai" target="_blank" rel="noopener">PropSports API</a>
            <a href="https://proptechusa.ai" target="_blank" rel="noopener">PropTechUSA.ai</a>
            <a href="https://discord.gg/kb5zCTHbME" target="_blank" rel="noopener">Discord ↗</a>
            <a class="pbe-footer-x" href="https://x.com/PROPBETEDGE" target="_blank" rel="noopener noreferrer" aria-label="Follow PropBetEdge on X (@PROPBETEDGE)" title="Follow PropBetEdge on X"><span aria-hidden="true">𝕏</span> @PROPBETEDGE</a>
          </nav>
        </section>

        <div class="pbe-network-footer-rail">
          <span>© ${year} PropTechUSA.ai</span>
          <span>Market data and model outputs are informational, not guarantees.</span>
          <span>PropBetEdge is independent and is not affiliated with the NFL or its clubs.</span>
        </div>
      </div>
    </footer>`;
  }

  function openAccount(event) {
    event?.preventDefault?.();
    if (window.PBEPro?.open) window.PBEPro.open('account');
    else document.getElementById('pbes-account')?.click();
  }

  function syncAccount(footer = document.getElementById(FOOTER_ID)) {
    if (!footer) return;
    const s = window.PBEPro?.state || {};
    const pro = s.pro === true;
    const signed = Boolean(s.user?.email);
    const loading = Boolean(s.loading);
    const title = footer.querySelector('[data-pbe-footer-account-state]');
    const copy = footer.querySelector('[data-pbe-footer-account-copy]');
    const dot = footer.querySelector('[data-pbe-footer-account-dot]');
    const button = footer.querySelector('.pbe-footer-account-card button[data-pbe-footer-account]');
    const manage = footer.querySelector('[data-pbe-footer-manage]');
    /* Shared membership contract: label + plan text come from the server's
       object; Manage subscription shows only when it says show_manage. */
    const m = s.membership;
    const member = pro && m?.entitled === true;
    const shown = pro ? window.PBENflMember?.display?.(member ? m : null, s.role === 'owner' ? 'owner' : null) : null;
    const label = shown?.status || (member && m.label ? m.label : 'NFL Pro active');
    const plan = shown?.state === 'all_access' ? shown.product : member ? (window.PBEMembership?.planText?.(m) || 'Verified NFL Pro access') : 'Verified NFL Pro access';
    const showManage = pro && (member ? m.show_manage === true : s.role !== 'owner');

    if (title) title.textContent = loading ? 'Checking access…' : pro ? label : signed ? 'Signed in · Pro inactive' : 'NFL Pro account';
    if (copy) copy.textContent = pro
      ? plan
      : signed
        ? 'Verified account · NFL Pro is not active'
        : 'Passwordless access · secure billing';
    if (manage) manage.hidden = !showManage;
    if (dot) {
      dot.classList.toggle('on', pro);
      dot.classList.toggle('signed', signed && !pro);
    }
    if (button) button.textContent = pro ? 'Open account' : signed ? 'Review access' : 'Sign in / Pro';
    footer.querySelectorAll('[data-pbe-footer-account]').forEach((el) => {
      el.setAttribute('aria-label', pro ? 'Open NFL Pro account' : signed ? 'Review NFL Pro access' : 'Sign in or open NFL Pro');
    });
  }

  function wire(footer) {
    footer.querySelectorAll('[data-pbe-footer-route]').forEach((link) => link.addEventListener('click', (event) => {
      /* Inside the app the router handles it; elsewhere (the /all-access
         page) the link's own /#route href navigates normally. */
      if (!window.App?.nav) return;
      event.preventDefault();
      const route = link.dataset.pbeFooterRoute;
      window.App.nav(route);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }));
    footer.querySelectorAll('[data-pbe-footer-account]').forEach((link) => link.addEventListener('click', openAccount));
    syncAccount(footer);
  }

  function ensure() {
    if (document.getElementById(FOOTER_ID)) return;
    const main = document.getElementById('main-content');
    const view = document.getElementById('view-container');
    if (!main || !view) return;
    view.insertAdjacentHTML('afterend', html());
    const footer = document.getElementById(FOOTER_ID);
    if (footer) wire(footer);
  }

  function init() {
    ensure();
    window.addEventListener('pbe:route-changed', ensure);
    window.addEventListener('pbe:upgrades-ready', ensure);
    window.addEventListener('pbe:pro-state', () => syncAccount());
    new MutationObserver(() => ensure()).observe(document.body, { childList: true, subtree: true });
    window.PBENetworkFooter = { ensure, syncAccount, openAccount };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();