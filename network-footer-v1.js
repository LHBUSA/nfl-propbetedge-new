/* PropBetEdge NFL — compact global network + account footer */
(() => {
  'use strict';

  const FOOTER_ID = 'pbe-network-footer';
  const BILLING = 'https://billing.stripe.com/p/login/cNi3cv2vY7em3lr4oj7wA00';

  function html() {
    const year = new Date().getFullYear();
    return `<footer id="${FOOTER_ID}" class="pbe-network-footer" aria-label="PropBetEdge sports network and NFL account management">
      <div class="pbe-network-footer-shell">
        <div class="pbe-network-footer-top">
          <div class="pbe-network-footer-brand">
            <a class="pbe-network-footer-logo" href="https://propbetedge.ai" aria-label="PropBetEdge home">
              <img src="https://propbetedge.ai/logo/pbe-full-400.png" alt="PropBetEdge" loading="lazy" decoding="async">
            </a>
            <div class="pbe-network-footer-brand-copy">
              <strong>PropBetEdge NFL</strong>
              <span>Football intelligence, built from the data layer up.</span>
            </div>
          </div>

          <aside class="pbe-footer-account-strip" aria-label="NFL Pro account controls">
            <div class="pbe-footer-account-state">
              <i data-pbe-footer-account-dot></i>
              <div><span>NFL PRO</span><strong data-pbe-footer-account-state>Account</strong></div>
            </div>
            <div class="pbe-footer-account-actions">
              <button type="button" data-pbe-footer-account>Open account</button>
              <a href="${BILLING}" target="_blank" rel="noopener">Billing ↗</a>
            </div>
          </aside>
        </div>

        <div class="pbe-network-footer-grid">
          <nav class="pbe-network-link-group" aria-label="NFL Pro product">
            <span class="pbe-network-link-label">NFL PRO</span>
            <a href="javascript:void(0)" data-pbe-footer-route="pbepicks">PBE Picks</a>
            <a href="javascript:void(0)" data-pbe-footer-route="propboard">Prop Board</a>
            <a href="javascript:void(0)" data-pbe-footer-route="games">Games</a>
            <a href="javascript:void(0)" data-pbe-footer-route="pbecast">PBEcast</a>
            <a href="javascript:void(0)" data-pbe-footer-route="matchups">Matchups</a>
            <a href="javascript:void(0)" data-pbe-footer-route="trackrecord">Track Record</a>
          </nav>

          <nav class="pbe-network-link-group" aria-label="PropBetEdge sports">
            <span class="pbe-network-link-label">SPORTS</span>
            <span class="pbe-network-current-sport">NFL <em>YOU ARE HERE</em></span>
            <a href="https://mlb.propbetedge.ai" target="_blank" rel="noopener">MLB</a>
            <a href="https://nba.propbetedge.ai" target="_blank" rel="noopener">NBA</a>
            <a href="https://nhl.propbetedge.ai" target="_blank" rel="noopener">NHL</a>
            <a href="https://ufc.propbetedge.ai" target="_blank" rel="noopener">UFC</a>
            <span class="pbe-network-soon">WNBA <em>BUILDING</em></span>
          </nav>

          <nav class="pbe-network-link-group" aria-label="PropBetEdge network">
            <span class="pbe-network-link-label">NETWORK</span>
            <a href="https://propbetedge.ai">Sports News</a>
            <a href="https://propsports.proptechusa.ai" target="_blank" rel="noopener">PropSports API</a>
            <a href="https://proptechusa.ai" target="_blank" rel="noopener">PropTechUSA.ai</a>
            <a href="https://discord.gg/kb5zCTHbME" target="_blank" rel="noopener">Discord ↗</a>
          </nav>

          <nav class="pbe-network-link-group account" aria-label="Account and billing">
            <span class="pbe-network-link-label">ACCOUNT</span>
            <a href="javascript:void(0)" data-pbe-footer-account>NFL Pro Account</a>
            <a href="${BILLING}" target="_blank" rel="noopener">Manage Subscription ↗</a>
            <span class="pbe-network-account-note" data-pbe-footer-account-copy>Passwordless access · Stripe billing</span>
          </nav>
        </div>

        <div class="pbe-network-footer-rail">
          <span>© ${year} PropTechUSA.ai</span>
          <span>Independent sports intelligence.</span>
          <span>Market data and model outputs are informational, not guarantees.</span>
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

    if (title) title.textContent = loading ? 'Checking access…' : pro ? 'NFL Pro active' : signed ? 'Signed in · Pro inactive' : 'Sign in or upgrade';
    if (copy) copy.textContent = pro ? 'NFL Pro active · Stripe billing' : signed ? 'Signed in · review NFL Pro access' : 'Passwordless access · Stripe billing';
    if (dot) {
      dot.classList.toggle('on', pro);
      dot.classList.toggle('signed', signed && !pro);
    }
    footer.querySelectorAll('[data-pbe-footer-account]').forEach((el) => {
      if (el.tagName === 'BUTTON') el.textContent = pro ? 'Open account' : signed ? 'Review access' : 'Sign in / Pro';
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