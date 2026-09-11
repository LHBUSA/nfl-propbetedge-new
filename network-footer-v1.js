/* PropBetEdge NFL — premium sports-network footer */
(() => {
  'use strict';

  const FOOTER_ID = 'pbe-network-footer';
  const BILLING = 'https://billing.stripe.com/p/login/cNi3cv2vY7em3lr4oj7wA00';

  const SPORTS = [
    { key: 'nfl', label: 'NFL', sub: 'Football', current: true, route: 'home' },
    { key: 'mlb', label: 'MLB', sub: 'Baseball', href: 'https://mlb.propbetedge.ai' },
    { key: 'nba', label: 'NBA', sub: 'Basketball', href: 'https://nba.propbetedge.ai' },
    { key: 'wnba', label: 'WNBA', sub: "Women's Basketball", href: 'https://wnba.propbetedge.ai', live: true },
    { key: 'nhl', label: 'NHL', sub: 'Hockey', href: 'https://nhl.propbetedge.ai' },
    { key: 'ufc', label: 'UFC', sub: 'Fight Intelligence', href: 'https://ufc.propbetedge.ai' }
  ];

  function sportTile(sport) {
    const attrs = sport.current
      ? `href="javascript:void(0)" data-pbe-footer-route="${sport.route}"`
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
          <div class="pbe-network-live-mark" aria-label="Six live PropBetEdge sport products">
            <span><i></i> LIVE NETWORK</span>
            <strong>6</strong>
            <small>SPORT PRODUCTS</small>
          </div>
        </section>

        <section class="pbe-network-sports" aria-label="PropBetEdge sports products">
          ${SPORTS.map(sportTile).join('')}
        </section>

        <section class="pbe-network-footer-console">
          <div class="pbe-network-nflpro">
            <div class="pbe-network-console-head">
              <div><span>NFL PRO</span><strong>Your football intelligence desk</strong></div>
              <a href="javascript:void(0)" data-pbe-footer-route="pbepicks" class="pbe-network-primary-link">Today's PBE Card <b>→</b></a>
            </div>
            <nav class="pbe-network-nfl-links" aria-label="NFL Pro navigation">
              <a href="javascript:void(0)" data-pbe-footer-route="pbepicks" class="featured">PBE Picks <em>LIVE</em></a>
              <a href="javascript:void(0)" data-pbe-footer-route="propboard">Prop Board</a>
              <a href="javascript:void(0)" data-pbe-footer-route="pbecast">PBEcast</a>
              <a href="javascript:void(0)" data-pbe-footer-route="matchups">Matchups</a>
              <a href="javascript:void(0)" data-pbe-footer-route="bestline">Best Line</a>
              <a href="javascript:void(0)" data-pbe-footer-route="trackrecord">Track Record</a>
            </nav>
          </div>

          <aside class="pbe-footer-account-card" aria-label="NFL Pro account controls">
            <div class="pbe-footer-account-card-head">
              <div class="pbe-footer-account-state"><i data-pbe-footer-account-dot></i><div><span>ACCESS</span><strong data-pbe-footer-account-state>NFL Pro account</strong></div></div>
              <button type="button" data-pbe-footer-account>Open account</button>
            </div>
            <p data-pbe-footer-account-copy>Passwordless access · Stripe billing</p>
            <div class="pbe-footer-account-card-links">
              <a href="${BILLING}" target="_blank" rel="noopener">Manage subscription ↗</a>
              <a href="https://discord.gg/kb5zCTHbME" target="_blank" rel="noopener">Member community ↗</a>
            </div>
          </aside>
        </section>

        <section class="pbe-network-footer-ecosystem">
          <div class="pbe-network-ecosystem-brand">
            <strong>PropBetEdge</strong>
            <span>Independent sports intelligence built from the data layer up.</span>
          </div>
          <nav aria-label="PropBetEdge ecosystem">
            <a href="https://propbetedge.ai">Sports News</a>
            <a href="https://propsports.proptechusa.ai" target="_blank" rel="noopener">PropSports API</a>
            <a href="https://proptechusa.ai" target="_blank" rel="noopener">PropTechUSA.ai</a>
            <a href="https://discord.gg/kb5zCTHbME" target="_blank" rel="noopener">Discord ↗</a>
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

    if (title) title.textContent = loading ? 'Checking access…' : pro ? 'NFL Pro active' : signed ? 'Signed in · Pro inactive' : 'NFL Pro account';
    if (copy) copy.textContent = pro
      ? 'Verified NFL Pro access · Stripe subscription active'
      : signed
        ? 'Verified account · NFL Pro is not active'
        : 'Passwordless access · secure Stripe billing';
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
      event.preventDefault();
      const route = link.dataset.pbeFooterRoute;
      if (window.App?.nav) {
        window.App.nav(route);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
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