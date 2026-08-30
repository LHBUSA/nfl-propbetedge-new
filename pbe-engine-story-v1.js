/* PropBetEdge NFL — public engine story v1
 * Makes the decision architecture visible without exposing proprietary weights.
 * This is product education, not a second model authority.
 */
(() => {
  'use strict';

  const STATE_API='/api/pbe-picks?view=state';
  let snapshot=null, loading=false;
  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const pct=(a,b)=>b>0?Math.max(0,Math.min(100,(Number(a)||0)/(Number(b)||1)*100)):0;

  async function loadState(){
    if(snapshot||loading)return snapshot;
    loading=true;
    try{
      const r=await fetch(STATE_API,{cache:'no-store',headers:{accept:'application/json'}});
      if(r.ok)snapshot=await r.json();
    }catch(_){/* story still renders from immutable product contract */}
    finally{loading=false}
    return snapshot;
  }

  function go(route){
    if(window.App?.nav)return window.App.nav(route);
    location.hash=route;
  }

  function architecture(){
    const s=snapshot||{};
    const grades=Number(s.graded_sample||0),gradeReq=Number(s.graded_sample_required||100);
    const weeks=Number(s.distinct_weeks||0),weekReq=Number(s.distinct_weeks_required||4);
    const trained=s.champion_trained===true;
    return `<section class="pbe-engine-story" data-trained="${trained?'1':'0'}">
      <div class="pbe-engine-story-grid"></div>
      <header class="pbe-engine-head">
        <div>
          <span class="pbe-engine-kicker">PBE PICKS ENGINE · GOVERNED QUANTITATIVE DECISION SYSTEM</span>
          <h2>We don't publish opinions.<br><em>We make the market prove us wrong.</em></h2>
          <p>Every NFL decision starts with the current sportsbook market, removes the vig, builds a frozen game-state feature vector, prices the outcome with the active champion model, and measures the difference. If the edge is not large enough, there is no pick.</p>
        </div>
        <aside class="pbe-engine-state">
          <span>${trained?'PRODUCTION CHAMPION':'VALIDATION CHAMPION'}</span>
          <strong>v${esc(s.champion_version??'1')}</strong>
          <small>${trained?'Official publication enabled':'Bootstrap decisions stay hidden from the public record'}</small>
        </aside>
      </header>

      <div class="pbe-engine-flow">
        <article><i>01</i><span>MARKET</span><strong>Strip the vig.</strong><p>Spread, total and moneyline prices are converted into fair two-way market probabilities before PBE compares anything.</p></article>
        <article><i>02</i><span>MODEL</span><strong>Price the game.</strong><p>EPA, QB quality, rest, venue, weather flags, PROE, pace, line movement and early-season context feed a deterministic probability model.</p></article>
        <article><i>03</i><span>EDGE</span><strong>Demand separation.</strong><p>PBE probability minus de-vigged market probability becomes the edge. Spread/total require 2.0pp; moneyline requires 3.0pp.</p></article>
        <article><i>04</i><span>SIZE</span><strong>Quarter Kelly.</strong><p>Qualified edges are sized mathematically from the actual sportsbook price, with a 0.5u floor and 2.0u hard cap.</p></article>
        <article><i>05</i><span>LOCK</span><strong>Freeze the decision.</strong><p>Issue line, odds, probability, model version, features and stake are immutable. Later market movement cannot rewrite the original call.</p></article>
        <article><i>06</i><span>LEARN</span><strong>Grade against reality.</strong><p>Final outcome, units, calibration and closing-line value become the next training observation. No provisional result moves production weights.</p></article>
      </div>

      <div class="pbe-engine-proof">
        <div class="pbe-engine-proof-copy">
          <span>WHY THIS IS DIFFERENT</span>
          <h3>A pick has to survive three systems.</h3>
          <p><b>Decision gate:</b> the model must clear a real edge threshold and positive Kelly sizing. <b>Publication gate:</b> an untrained champion can create hidden tracking decisions, but it cannot publish customer picks. <b>Promotion gate:</b> a challenger cannot become champion until at least 100 finalized observations across 4 distinct weeks exist—and then it still has to beat the reigning model on CLV or calibration.</p>
          <div class="pbe-engine-badges"><span>NO LLM PICKS</span><span>NO RANDOMNESS</span><span>NO MANUAL OVERRIDE</span><span>NO BACKFILL</span><span>LOSSES STAY VISIBLE</span><span>ACTUAL ISSUE PRICE</span></div>
        </div>
        <div class="pbe-engine-gate">
          <div class="pbe-engine-gate-title"><span>LIVE VALIDATION GATE</span><b>${trained?'OPEN':'BUILDING'}</b></div>
          <div class="pbe-engine-meter"><div><span>Finalized decisions</span><strong>${grades}/${gradeReq}</strong></div><i><b style="width:${pct(grades,gradeReq).toFixed(1)}%"></b></i></div>
          <div class="pbe-engine-meter"><div><span>Distinct weeks</span><strong>${weeks}/${weekReq}</strong></div><i><b style="width:${pct(weeks,weekReq).toFixed(1)}%"></b></i></div>
          <small>${trained?'The active champion has cleared the publication contract.':'Only after the volume gate opens can a trained challenger attempt to replace the current champion.'}</small>
        </div>
      </div>

      <div class="pbe-engine-moat">
        <div><span>ENTRY THRESHOLD</span><strong>2–3pp</strong><small>Market-specific minimum edge</small></div>
        <div><span>CONFIDENCE</span><strong>A / B / C</strong><small>A begins at 5pp model edge</small></div>
        <div><span>RISK ENGINE</span><strong>¼ KELLY</strong><small>0.5u floor · 2.0u cap</small></div>
        <div><span>TRAINING SIGNAL</span><strong>70 / 30</strong><small>CLV / final outcome blend</small></div>
        <div><span>PROMOTION</span><strong>CHAMPION</strong><small>Challenger must earn replacement</small></div>
      </div>

      <footer class="pbe-engine-cta">
        <div><span>THE ALGORITHM IS NOT THE MARKETING CLAIM.</span><strong>The audit trail is.</strong><p>See the validation gate now. When official picks begin, the same surface becomes the public, immutable decision record.</p></div>
        <div><button type="button" data-engine-route="pbepicks">Open PBE Picks</button><button type="button" class="secondary" data-engine-route="trackrecord">Verified Track Record</button></div>
      </footer>
    </section>`;
  }

  function wire(root){
    root.querySelectorAll('[data-engine-route]').forEach(btn=>btn.addEventListener('click',()=>go(btn.dataset.engineRoute)));
  }

  function mountHome(){
    const page=document.querySelector('.pbehome7');
    if(!page||page.querySelector(':scope > .pbe-engine-story'))return;
    const main=page.querySelector('.pbe7-main');
    if(!main)return;
    main.insertAdjacentHTML('beforebegin',architecture());
    wire(page.querySelector(':scope > .pbe-engine-story'));
  }

  function mountPicks(){
    const page=document.querySelector('.pbe2-wrap');
    if(!page||page.querySelector('.pbe-engine-story'))return;
    const pipeline=page.querySelector('.pbe2-pipeline');
    const target=pipeline||page.querySelector('.pbe2-stage');
    if(!target)return;
    target.insertAdjacentHTML('afterend',architecture());
    wire(page.querySelector('.pbe-engine-story'));
  }

  async function sync(){
    await loadState();
    mountHome();
    mountPicks();
  }

  const observer=new MutationObserver(()=>queueMicrotask(sync));
  document.addEventListener('DOMContentLoaded',()=>{observer.observe(document.body,{childList:true,subtree:true});sync()},{once:true});
  ['pbe:route-changed','pbe:upgrades-ready','pbe:pro-state'].forEach(name=>window.addEventListener(name,()=>setTimeout(sync,25)));
  if(document.readyState!=='loading'){observer.observe(document.body,{childList:true,subtree:true});sync()}
  window.PBEEngineStory={sync};
})();
