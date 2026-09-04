/* PropBetEdge NFL — public engine story v1.1
 * Product education only. No model authority lives in this file.
 *
 * IMPORTANT: this module is deliberately event-driven. It does NOT observe the
 * entire SPA DOM. The previous global MutationObserver reacted to every market,
 * media and newsroom paint and could churn the main thread on busy pages.
 */
(() => {
  'use strict';

  const STATE_API='/api/pbe-picks?view=state';
  let snapshot=null;
  let statePromise=null;
  let timers=[];

  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const pct=(a,b)=>b>0?Math.max(0,Math.min(100,(Number(a)||0)/(Number(b)||1)*100)):0;

  async function loadState(){
    if(snapshot)return snapshot;
    if(statePromise)return statePromise;
    statePromise=fetch(STATE_API,{cache:'no-store',headers:{accept:'application/json'}})
      .then(async r=>r.ok?await r.json():null)
      .then(data=>{snapshot=data||snapshot;return snapshot})
      .catch(()=>null)
      .finally(()=>{statePromise=null});
    return statePromise;
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
          <p>Every NFL decision starts with the sportsbook market, removes the vig, freezes a game-state feature vector, prices the outcome with the active champion model, and measures the difference. If the edge is not large enough, there is no pick.</p>
        </div>
        <aside class="pbe-engine-state">
          <span>${trained?'PRODUCTION CHAMPION':'VALIDATION CHAMPION'}</span>
          <strong>v${esc(s.champion_version??'1')}</strong>
          <small>${trained?'Official publication enabled':'Bootstrap decisions stay hidden from the public record'}</small>
        </aside>
      </header>

      <div class="pbe-engine-flow">
        <article><i>01</i><span>MARKET</span><strong>Strip the vig.</strong><p>Spread, total and moneyline prices become fair two-way market probabilities before PBE compares anything.</p></article>
        <article><i>02</i><span>MODEL</span><strong>Price the game.</strong><p>EPA, QB quality, rest, venue, weather flags, PROE, pace, line movement and early-season context feed a deterministic probability model.</p></article>
        <article><i>03</i><span>EDGE</span><strong>Demand separation.</strong><p>PBE probability minus de-vigged market probability becomes the edge. Spread/total require 2.0pp; moneyline requires 3.0pp.</p></article>
        <article><i>04</i><span>SIZE</span><strong>Quarter Kelly.</strong><p>Qualified edges are sized from the actual sportsbook price, with a 0.5u floor and 2.0u hard cap.</p></article>
        <article><i>05</i><span>LOCK</span><strong>Freeze the decision.</strong><p>Issue line, odds, probability, model version, features and stake are immutable. Later market movement cannot rewrite the original call.</p></article>
        <article><i>06</i><span>LEARN</span><strong>Grade against reality.</strong><p>Final outcome, units, calibration and closing-line value become the next training observation. No provisional result moves production weights.</p></article>
      </div>

      <div class="pbe-engine-proof">
        <div class="pbe-engine-proof-copy">
          <span>WHY THIS IS DIFFERENT</span>
          <h3>A pick has to survive three systems.</h3>
          <p><b>Decision gate:</b> clear a real edge threshold and positive Kelly sizing. <b>Publication gate:</b> an untrained champion may create hidden tracking decisions but cannot publish customer picks. <b>Promotion gate:</b> a challenger cannot train until at least 100 finalized observations across 4 distinct weeks exist—and then it still has to beat the reigning model on CLV or calibration.</p>
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
        <div><span>THE ALGORITHM IS NOT THE MARKETING CLAIM.</span><strong>The audit trail is.</strong><p>See the validation gate now. When official picks begin, the same surface becomes the public immutable decision record.</p></div>
        <div><button type="button" data-engine-route="pbepicks">Open PBE Picks</button><button type="button" class="secondary" data-engine-route="trackrecord">Verified Track Record</button></div>
      </footer>
    </section>`;
  }

  function wire(root){
    root?.querySelectorAll('[data-engine-route]').forEach(btn=>{
      if(btn.dataset.engineWired==='1')return;
      btn.dataset.engineWired='1';
      btn.addEventListener('click',()=>go(btn.dataset.engineRoute));
    });
  }

  /* The engine story is product education, and it is the same markup that PBE
     Picks already renders. Mounting it on the Dashboard too put ~1,500px of
     manifesto between the featured game and the day's intelligence, on every
     visit, for a returning user who has already read it. It now lives on PBE
     Picks only; the Dashboard links to it once. Nothing is deleted. */

  function upsertPicks(){
    const page=document.querySelector('.pbe2-wrap');
    if(!page)return false;
    let story=page.querySelector('.pbe-engine-story');
    if(!story){
      const target=page.querySelector('.pbe2-pipeline')||page.querySelector('.pbe2-stage');
      if(!target)return false;
      target.insertAdjacentHTML('afterend',architecture());
      story=page.querySelector('.pbe-engine-story');
    }
    wire(story);
    return true;
  }

  function paint(){
    upsertPicks();
  }

  function refreshPaint(){
    // Replace only our own already-mounted story after state arrives; never
    // touch the rest of the SPA or watch its mutation stream.
    document.querySelectorAll('.pbe-engine-story').forEach(old=>{
      const shell=document.createElement('div');
      shell.innerHTML=architecture().trim();
      const next=shell.firstElementChild;
      if(next){old.replaceWith(next);wire(next)}
    });
    paint();
  }

  function schedule(){
    timers.forEach(clearTimeout);timers=[];
    [0,80,300,900,1800].forEach(delay=>timers.push(setTimeout(paint,delay)));
    loadState().then(data=>{if(data)refreshPaint()});
  }

  document.addEventListener('DOMContentLoaded',schedule,{once:true});
  ['pbe:route-changed','pbe:upgrades-ready','pbe:pro-state'].forEach(name=>window.addEventListener(name,schedule));
  if(document.readyState!=='loading')schedule();
  window.PBEEngineStory={sync:schedule};
})();
