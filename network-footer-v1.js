/* PropBetEdge NFL — global network footer */
(() => {
  'use strict';

  const FOOTER_ID='pbe-network-footer';

  function html(){
    const year=new Date().getFullYear();
    return `<footer id="${FOOTER_ID}" class="pbe-network-footer" aria-label="PropBetEdge sports network">
      <div class="pbe-network-footer-shell">
        <section class="pbe-network-footer-hero">
          <div class="pbe-network-footer-brand">
            <a class="pbe-network-footer-logo" href="https://propbetedge.ai" aria-label="PropBetEdge home">
              <img src="https://propbetedge.ai/logo/pbe-full-400.png" alt="PropBetEdge" loading="lazy" decoding="async">
            </a>
            <div class="pbe-network-footer-kicker">THE PROPBETEDGE SPORTS NETWORK</div>
            <h2>Data at the infrastructure layer.<br><em>Intelligence at the product layer.</em></h2>
            <p>One connected sports ecosystem for developers, products, analysts and fans — from API infrastructure to deep sport-specific intelligence experiences.</p>
            <div class="pbe-network-footer-current"><span></span><strong>YOU'RE IN</strong> PropBetEdge NFL · Football Intelligence OS</div>
          </div>

          <div class="pbe-network-footer-products">
            <a class="pbe-network-product-card api" href="https://propsports.proptechusa.ai" target="_blank" rel="noopener">
              <div class="pbe-network-card-top"><span class="pbe-network-card-eyebrow">DEVELOPER INFRASTRUCTURE</span><span class="pbe-network-card-arrow">↗</span></div>
              <div class="pbe-network-card-mark">API</div>
              <h3>PropSports API</h3>
              <p>Sports data infrastructure built for apps, products and AI. Go from raw sports feeds to production-ready experiences without rebuilding the data layer.</p>
              <div class="pbe-network-card-tags"><span>Sports Data</span><span>APIs</span><span>AI Ready</span></div>
              <div class="pbe-network-card-cta">Explore PropSports <strong>→</strong></div>
            </a>

            <a class="pbe-network-product-card mlb" href="https://mlb.propbetedge.ai" target="_blank" rel="noopener">
              <div class="pbe-network-card-top"><span class="pbe-network-card-eyebrow">BASEBALL INTELLIGENCE</span><span class="pbe-network-card-arrow">↗</span></div>
              <div class="pbe-network-card-mark">MLB</div>
              <h3>PropBetEdge MLB</h3>
              <p>A dedicated baseball intelligence OS for live game context, player research, prop markets, model analysis and deep MLB exploration.</p>
              <div class="pbe-network-card-tags"><span>MLB</span><span>Live</span><span>Research</span></div>
              <div class="pbe-network-card-cta">Open MLB Intelligence <strong>→</strong></div>
            </a>
          </div>
        </section>

        <section class="pbe-network-footer-links">
          <div class="pbe-network-link-group">
            <span class="pbe-network-link-label">NETWORK</span>
            <a href="https://propbetedge.ai">PropBetEdge</a>
            <a href="https://mlb.propbetedge.ai" target="_blank" rel="noopener">MLB Intelligence</a>
            <a href="https://propsports.proptechusa.ai" target="_blank" rel="noopener">PropSports API</a>
          </div>
          <div class="pbe-network-link-group">
            <span class="pbe-network-link-label">PLATFORM</span>
            <a href="javascript:void(0)" data-pbe-footer-route="propboard">NFL Prop Board</a>
            <a href="javascript:void(0)" data-pbe-footer-route="picks">Model Lab</a>
            <a href="javascript:void(0)" data-pbe-footer-route="pbecast">Game Center</a>
          </div>
          <div class="pbe-network-link-group">
            <span class="pbe-network-link-label">BUILT BY</span>
            <a href="https://proptechusa.ai" target="_blank" rel="noopener">PropTechUSA.ai</a>
            <span class="pbe-network-link-copy">Independent data infrastructure powering next-generation products.</span>
          </div>
        </section>

        <div class="pbe-network-footer-rail">
          <div><strong>PropBetEdge</strong><span>Sports intelligence, built from the data layer up.</span></div>
          <div class="pbe-network-footer-rail-right"><span>© ${year} PropTechUSA.ai</span><span class="pbe-network-footer-dot"></span><a href="https://propsports.proptechusa.ai" target="_blank" rel="noopener">Developer API</a><span class="pbe-network-footer-dot"></span><a href="https://mlb.propbetedge.ai" target="_blank" rel="noopener">MLB</a></div>
        </div>
      </div>
    </footer>`;
  }

  function wire(footer){
    footer.querySelectorAll('[data-pbe-footer-route]').forEach(link=>{
      link.addEventListener('click',event=>{
        event.preventDefault();
        const route=link.dataset.pbeFooterRoute;
        if(window.App?.nav){
          window.App.nav(route);
          window.scrollTo({top:0,behavior:'smooth'});
        }
      });
    });
  }

  function ensure(){
    if(document.getElementById(FOOTER_ID))return;
    const main=document.getElementById('main-content');
    const view=document.getElementById('view-container');
    if(!main||!view)return;
    view.insertAdjacentHTML('afterend',html());
    const footer=document.getElementById(FOOTER_ID);
    if(footer)wire(footer);
  }

  function init(){
    ensure();
    window.addEventListener('pbe:route-changed',ensure);
    window.addEventListener('pbe:upgrades-ready',ensure);
    new MutationObserver(()=>ensure()).observe(document.body,{childList:true,subtree:true});
    window.PBENetworkFooter={ensure};
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();