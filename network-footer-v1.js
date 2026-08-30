/* PropBetEdge NFL — global network + account footer */
(() => {
  'use strict';

  const FOOTER_ID='pbe-network-footer';
  const BILLING='https://billing.stripe.com/p/login/cNi3cv2vY7em3lr4oj7wA00';

  function esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}

  function html(){
    const year=new Date().getFullYear();
    return `<footer id="${FOOTER_ID}" class="pbe-network-footer" aria-label="PropBetEdge sports network and NFL account management">
      <div class="pbe-network-footer-shell">
        <section class="pbe-network-footer-hero">
          <div class="pbe-network-footer-brand">
            <a class="pbe-network-footer-logo" href="https://propbetedge.ai" aria-label="PropBetEdge home">
              <img src="https://propbetedge.ai/logo/pbe-full-400.png" alt="PropBetEdge" loading="lazy" decoding="async">
            </a>
            <div class="pbe-network-footer-kicker">THE PROPBETEDGE SPORTS NETWORK</div>
            <h2>From raw signal<br><em>to decision infrastructure.</em></h2>
            <p>One connected sports intelligence stack spanning live markets, model research, historical archives and production-grade sports data infrastructure.</p>
            <div class="pbe-network-footer-current"><span></span><strong>ACTIVE PRODUCT</strong> PropBetEdge NFL · Football Intelligence OS</div>
          </div>

          <aside class="pbe-footer-account-card" aria-label="NFL Pro account controls">
            <div class="pbe-footer-account-top"><div><span>NFL PRO</span><strong data-pbe-footer-account-state>Account controls</strong></div><i data-pbe-footer-account-dot></i></div>
            <p data-pbe-footer-account-copy>Sign in, review NFL Pro access, or manage an existing Stripe subscription without leaving the account layer.</p>
            <div class="pbe-footer-account-actions">
              <button type="button" class="primary" data-pbe-footer-account>Open NFL Pro Account</button>
              <a href="${BILLING}" target="_blank" rel="noopener">Manage Billing in Stripe ↗</a>
            </div>
            <div class="pbe-footer-account-meta"><span>SECURE BILLING</span><span>STRIPE CUSTOMER PORTAL</span><span>PASSWORDLESS ACCESS</span></div>
          </aside>
        </section>

        <section class="pbe-network-footer-products">
          <a class="pbe-network-product-card nfl" href="javascript:void(0)" data-pbe-footer-route="propboard">
            <div class="pbe-network-card-top"><span class="pbe-network-card-eyebrow">FOOTBALL INTELLIGENCE OS</span><span class="pbe-network-card-arrow">→</span></div>
            <div class="pbe-network-card-mark">NFL</div><h3>PropBetEdge NFL</h3>
            <p>Live market boards, Model Lab, line simulation, game intelligence, usage research and verified model history in one operating surface.</p>
            <div class="pbe-network-card-tags"><span>Markets</span><span>Model</span><span>Live</span></div>
            <div class="pbe-network-card-cta">Return to Prop Board <strong>→</strong></div>
          </a>
          <a class="pbe-network-product-card mlb" href="https://mlb.propbetedge.ai" target="_blank" rel="noopener">
            <div class="pbe-network-card-top"><span class="pbe-network-card-eyebrow">BASEBALL INTELLIGENCE OS</span><span class="pbe-network-card-arrow">↗</span></div>
            <div class="pbe-network-card-mark">MLB</div><h3>PropBetEdge MLB</h3>
            <p>Live baseball context, player research, prop markets, model analysis and deep MLB exploration built on the same network.</p>
            <div class="pbe-network-card-tags"><span>MLB</span><span>Live</span><span>Research</span></div>
            <div class="pbe-network-card-cta">Open MLB Intelligence <strong>→</strong></div>
          </a>
          <a class="pbe-network-product-card api" href="https://propsports.proptechusa.ai" target="_blank" rel="noopener">
            <div class="pbe-network-card-top"><span class="pbe-network-card-eyebrow">DEVELOPER INFRASTRUCTURE</span><span class="pbe-network-card-arrow">↗</span></div>
            <div class="pbe-network-card-mark">API</div><h3>PropSports API</h3>
            <p>Sports data infrastructure for applications, automation and AI products that need production-ready sports data instead of another scraping project.</p>
            <div class="pbe-network-card-tags"><span>Sports Data</span><span>API</span><span>AI Ready</span></div>
            <div class="pbe-network-card-cta">Explore PropSports <strong>→</strong></div>
          </a>
        </section>

        <section class="pbe-network-footer-links">
          <div class="pbe-network-link-group">
            <span class="pbe-network-link-label">NFL TERMINAL</span>
            <a href="javascript:void(0)" data-pbe-footer-route="propboard">Prop Board</a><a href="javascript:void(0)" data-pbe-footer-route="picks">Model Lab</a><a href="javascript:void(0)" data-pbe-footer-route="simulator">Line Simulator</a><a href="javascript:void(0)" data-pbe-footer-route="pbecast">PBEcast</a><a href="javascript:void(0)" data-pbe-footer-route="usage">Usage Research</a>
          </div>
          <div class="pbe-network-link-group account">
            <span class="pbe-network-link-label">ACCOUNT & BILLING</span>
            <a href="javascript:void(0)" data-pbe-footer-account>NFL Pro Account</a><a href="${BILLING}" target="_blank" rel="noopener">Manage Subscription ↗</a><a href="javascript:void(0)" data-pbe-footer-account>Sign In / Access</a>
          </div>
          <div class="pbe-network-link-group">
            <span class="pbe-network-link-label">NETWORK</span>
            <a href="https://propbetedge.ai">PropBetEdge</a><a href="https://mlb.propbetedge.ai" target="_blank" rel="noopener">MLB Intelligence</a><a href="https://propsports.proptechusa.ai" target="_blank" rel="noopener">PropSports API</a><a href="https://proptechusa.ai" target="_blank" rel="noopener">PropTechUSA.ai</a>
          </div>
        </section>

        <div class="pbe-network-footer-rail">
          <div><strong>PropBetEdge</strong><span>Independent sports intelligence built from the data layer up.</span></div>
          <div class="pbe-network-footer-rail-right"><span>© ${year} PropTechUSA.ai</span><span class="pbe-network-footer-dot"></span><a href="${BILLING}" target="_blank" rel="noopener">Billing</a><span class="pbe-network-footer-dot"></span><a href="https://propsports.proptechusa.ai" target="_blank" rel="noopener">Developer API</a><span class="pbe-network-footer-dot"></span><a href="https://mlb.propbetedge.ai" target="_blank" rel="noopener">MLB</a></div>
        </div>
      </div>
    </footer>`;
  }

  function openAccount(event){
    event?.preventDefault?.();
    if(window.PBEPro?.open)window.PBEPro.open('account');
    else document.getElementById('pbes-account')?.click();
  }

  function syncAccount(footer=document.getElementById(FOOTER_ID)){
    if(!footer)return;
    const s=window.PBEPro?.state||{};
    const pro=s.pro===true,signed=Boolean(s.user?.email),loading=Boolean(s.loading);
    const title=footer.querySelector('[data-pbe-footer-account-state]');
    const copy=footer.querySelector('[data-pbe-footer-account-copy]');
    const dot=footer.querySelector('[data-pbe-footer-account-dot]');
    if(title)title.textContent=loading?'Checking account…':pro?'NFL Pro active':signed?'Signed in · NFL Pro inactive':'Account controls';
    if(copy)copy.textContent=pro?'Your NFL Pro entitlement is active. Use the account panel for access controls or Stripe to manage billing.':signed?'Your account is signed in. Open account controls to review access or use Stripe for billing management.':'Sign in, review NFL Pro access, or manage an existing Stripe subscription without leaving the account layer.';
    if(dot){dot.classList.toggle('on',pro);dot.classList.toggle('signed',signed&&!pro)}
    footer.querySelectorAll('[data-pbe-footer-account]').forEach(el=>{
      if(el.tagName==='BUTTON')el.textContent=pro?'Open NFL Pro Account':signed?'Review NFL Pro Access':'Sign In / NFL Pro';
      el.setAttribute('aria-label',pro?'Open NFL Pro account':signed?'Review NFL Pro access':'Sign in or open NFL Pro');
    });
  }

  function wire(footer){
    footer.querySelectorAll('[data-pbe-footer-route]').forEach(link=>link.addEventListener('click',event=>{
      event.preventDefault();const route=link.dataset.pbeFooterRoute;
      if(window.App?.nav){window.App.nav(route);window.scrollTo({top:0,behavior:'smooth'})}
    }));
    footer.querySelectorAll('[data-pbe-footer-account]').forEach(link=>link.addEventListener('click',openAccount));
    syncAccount(footer);
  }

  function ensure(){
    if(document.getElementById(FOOTER_ID))return;
    const main=document.getElementById('main-content'),view=document.getElementById('view-container');
    if(!main||!view)return;
    view.insertAdjacentHTML('afterend',html());
    const footer=document.getElementById(FOOTER_ID);if(footer)wire(footer);
  }

  function init(){
    ensure();
    window.addEventListener('pbe:route-changed',ensure);
    window.addEventListener('pbe:upgrades-ready',ensure);
    window.addEventListener('pbe:pro-state',()=>syncAccount());
    new MutationObserver(()=>ensure()).observe(document.body,{childList:true,subtree:true});
    window.PBENetworkFooter={ensure,syncAccount,openAccount};
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();