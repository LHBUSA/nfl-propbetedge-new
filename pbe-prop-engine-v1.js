/* PropBetEdge NFL — Player Prop Engine public/product surface v1.
 * Event-driven only: no page-wide MutationObserver.
 */
(() => {
  'use strict';
  const API='/api/pbe-prop-picks';
  const data={state:null,current:null,track:null,promise:null};
  let timers=[];
  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null};
  const pct=(a,b)=>b>0?Math.max(0,Math.min(100,(Number(a)||0)/(Number(b)||1)*100)):0;
  const american=v=>{const x=n(v);return x===null?'—':`${x>0?'+':''}${Math.round(x)}`};
  const prob=v=>{const x=n(v);return x===null?'—':`${(Math.abs(x)<=1?x*100:x).toFixed(1)}%`};
  const edge=v=>{const x=n(v);if(x===null)return'—';const p=Math.abs(x)<=1?x*100:x;return`${p>0?'+':''}${p.toFixed(1)}pp`};

  async function get(view){
    const response=await fetch(`${API}?view=${view}`,{cache:'no-store',headers:{accept:'application/json'}});
    const body=await response.json().catch(()=>null);
    if(!response.ok){const e=new Error(body?.error||`HTTP ${response.status}`);e.status=response.status;throw e}
    return body;
  }
  async function load(){
    if(data.promise)return data.promise;
    data.promise=(async()=>{
      if(!data.state)data.state=await get('state').catch(()=>null);
      const route=window.App?.current;
      if(route==='pbepicks'&&window.PBEPro?.state?.pro===true){
        data.current=await get('current').catch(()=>null);
      }
      if(route==='trackrecord')data.track=await get('trackrecord').catch(()=>null);
    })().finally(()=>{data.promise=null});
    return data.promise;
  }

  function stage(s){
    if(s?.selector_trained===true)return{key:'production',label:'PRODUCTION',copy:'Trained selector · official publication enabled'};
    if(s?.runtime_evidence?.first_decision_seen)return{key:'tracking',label:'TRACKING · VALIDATING',copy:'Real pregame decisions are being frozen and graded privately'};
    return{key:'staged',label:'STAGED · BOOTSTRAP READY',copy:'Infrastructure is ready; first factual tracking decision has not been recorded yet'};
  }

  function engineCard(compact=false){
    const s=data.state||{};
    const status=stage(s),done=Number(s.finalized_sample||0),req=Number(s.finalized_required||100),weeks=Number(s.distinct_weeks||0),weekReq=Number(s.distinct_weeks_required||4);
    const c=s.selector_config_public||{};
    return `<section class="pbe-prop-engine ${compact?'compact':''}" data-stage="${status.key}">
      <div class="pbe-prop-gridwash"></div>
      <header><div><span>ENGINE 02 · PLAYER PROPS</span><h2>The projection finds the number.<br><em>The selector decides if it is bettable.</em></h2><p>Passing Yards v1 prices the player's distribution, compares it against an exact executable two-way sportsbook quote, removes the vig, demands real separation, sizes the risk and freezes the original decision before kickoff.</p></div><aside><span>${esc(status.label)}</span><strong>PASS YDS</strong><small>${esc(status.copy)}</small></aside></header>
      <div class="pbe-prop-flow">
        <div><i>01</i><span>PROJECT</span><b>Fair line + SD</b><small>Production passing model supplies the distribution.</small></div>
        <div><i>02</i><span>PRICE</span><b>Exact book pair</b><small>Over and Under must exist at the same book and same line.</small></div>
        <div><i>03</i><span>DE-VIG</span><b>True market probability</b><small>Sportsbook hold is stripped before edge is measured.</small></div>
        <div><i>04</i><span>SELECT</span><b>${c.min_edge!=null?(c.min_edge*100).toFixed(0):'4'}pp + ${c.min_ev_pct??5}% EV</b><small>Also requires ${c.min_books??4}+ books of market depth.</small></div>
        <div><i>05</i><span>SIZE</span><b>¼ Kelly</b><small>${c.stake_floor_units??0.5}u floor · ${c.stake_cap_units??2}u hard cap.</small></div>
        <div><i>06</i><span>PROVE</span><b>Close + final</b><small>Pre-kick tape → FINAL box score → CLV, Brier and P&amp;L.</small></div>
      </div>
      <div class="pbe-prop-contract">
        <div class="pbe-prop-windows"><span>ISSUANCE WINDOWS</span><div><b>EARLY BIRD</b><strong>≥ ${c.early_bird_min_hours??12}H</strong><small>Capture mispricing before the market matures.</small></div><div><b>LOCKED</b><strong>≤ ${c.locked_max_hours??4}H</strong><small>Re-check close to kickoff with mature book depth.</small></div></div>
        <div class="pbe-prop-gate"><div class="pbe-prop-gate-head"><span>INDEPENDENT VALIDATION GATE</span><b>${done}/${req} · ${weeks}/${weekReq} WKS</b></div><i><b style="width:${pct(done,req).toFixed(1)}%"></b></i><p>At ${req} finalized decisions across ${weekReq} weeks, a challenger trains on the older 80% and is judged on the newest 20%. It still has to beat the incumbent before promotion.</p></div>
      </div>
      <footer><div><span>SEPARATE MODEL GOVERNANCE</span><b>Game picks cannot promote player props. Player props cannot inherit the game record.</b><small>Every prop decision gets its own publication scope, receipt chain, closing tape, grade, learning observation and selector version.</small></div><div class="pbe-prop-proof"><span>EXACT BOOK PRICE</span><span>NO BACKFILL</span><span>SHA-256 RECEIPT</span><span>FINAL BOX SCORE</span></div></footer>
    </section>`;
  }

  function pickCard(row){
    return `<article class="pbe-prop-pick"><div class="pbe-prop-player" data-pbe-player-media="1" data-player="${esc(row.player_name)}"><strong>${esc(row.player_name)}</strong><span>${esc(String(row.phase||'').replace('_',' ').toUpperCase())} · ${esc(row.book)}</span></div><div class="pbe-prop-call"><span>${esc(row.side)}</span><strong>${n(row.market_line)?.toFixed(1)??'—'}</strong><b>${american(row.market_price)}</b></div><div class="pbe-prop-econ"><div><span>PBE FAIR</span><b>${n(row.model_fair_line)?.toFixed(1)??'—'}</b></div><div><span>PBE PROB</span><b>${prob(row.model_prob)}</b></div><div><span>EDGE</span><b>${edge(row.edge_pct)}</b></div><div><span>EV</span><b>${n(row.ev_pct)===null?'—':`${n(row.ev_pct).toFixed(1)}%`}</b></div><div><span>STAKE</span><b>${n(row.stake_units)===null?'—':`${n(row.stake_units).toFixed(2)}u`}</b></div></div></article>`;
  }

  function currentPanel(){
    const rows=data.current?.picks||[];
    if(!data.state?.selector_trained)return'';
    if(!rows.length)return`<section class="pbe-prop-live"><header><span>ENGINE 02 · CURRENT CARD</span><strong>PASS</strong></header><p>The trained player-prop selector evaluated the current executable passing-yard board and no quote cleared production requirements.</p></section>`;
    return `<section class="pbe-prop-live"><header><span>ENGINE 02 · CURRENT CARD</span><strong>${rows.length} OFFICIAL</strong></header><div class="pbe-prop-picks">${rows.map(pickCard).join('')}</div></section>`;
  }

  function trackPanel(){
    const rows=data.track?.picks||[];
    if(!rows.length)return`<section class="pbe-prop-record"><header><span>PLAYER PROP TRACK RECORD</span><strong>0 OFFICIAL DECISIONS</strong></header><p>Bootstrap tracking decisions never enter this record. The public player-prop ledger begins only after a trained selector is promoted and issues its first official pick.</p></section>`;
    const settled=rows.filter(r=>['win','loss','push'].includes(String(r?.grade?.result||'').toLowerCase()));
    const wins=settled.filter(r=>r.grade.result==='win').length,losses=settled.filter(r=>r.grade.result==='loss').length,pushes=settled.filter(r=>r.grade.result==='push').length;
    const units=settled.reduce((sum,r)=>sum+(Number(r?.grade?.units_delta)||0),0);
    const clv=rows.filter(r=>typeof r?.grade?.clv_beat==='boolean'),clvPct=clv.length?clv.filter(r=>r.grade.clv_beat).length/clv.length*100:null;
    return `<section class="pbe-prop-record"><header><span>PLAYER PROP TRACK RECORD</span><strong>${wins}-${losses}-${pushes}</strong></header><div class="pbe-prop-record-kpis"><div><span>ACTUAL UNITS</span><b>${units>=0?'+':''}${units.toFixed(2)}u</b></div><div><span>CLV BEAT</span><b>${clvPct===null?'—':`${clvPct.toFixed(1)}%`}</b></div><div><span>OFFICIAL PICKS</span><b>${rows.length}</b></div></div></section>`;
  }

  /* Second copy of the same product-education card; see pbe-engine-story-v1.js.
     The prop engine explainer lives on PBE Picks, not on the Dashboard. */
  function mountPicks(){
    const page=document.querySelector('.pbe2-wrap');if(!page)return;
    let host=document.getElementById('pbe-prop-engine-picks');if(host)return;
    host=document.createElement('div');host.id='pbe-prop-engine-picks';host.innerHTML=engineCard(false)+currentPanel();
    page.appendChild(host);window.PBENFLPlayerMediaV3?.scan?.();
  }
  function mountRecord(){
    const page=document.querySelector('.pbe2-wrap');if(!page)return;
    let host=document.getElementById('pbe-prop-engine-record');if(host)return;
    host=document.createElement('div');host.id='pbe-prop-engine-record';host.innerHTML=trackPanel();page.appendChild(host);window.PBENFLPlayerMediaV3?.scan?.();
  }
  function paint(){
    const route=window.App?.current;
    if(route==='pbepicks')mountPicks();
    if(route==='trackrecord')mountRecord();
  }
  function schedule(){
    timers.forEach(clearTimeout);timers=[];
    [0,80,300,900].forEach(delay=>timers.push(setTimeout(paint,delay)));
    load().then(()=>{document.querySelectorAll('#pbe-prop-engine-picks,#pbe-prop-engine-record').forEach(el=>el.remove());paint()});
  }
  document.addEventListener('DOMContentLoaded',schedule,{once:true});
  ['pbe:route-changed','pbe:upgrades-ready','pbe:pro-state'].forEach(name=>window.addEventListener(name,schedule));
  if(document.readyState!=='loading')schedule();
  window.PBEPropEngineV1={schedule,data};
})();
