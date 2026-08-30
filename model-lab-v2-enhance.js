/* Model Lab v2 quantitative enhancement
 * Additive only: production model output remains owned by model-lab.js.
 * Scenario changes are browser-local mean shifts; they do NOT rerun the model.
 * Market tape is browser-local from the moment this browser observes it; no
 * fake 48-hour provider history is claimed.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const DEFAULT_EVENT = '8c94552d022acec4a0458d70c19d3da9';
  const POLL_MS = 60000;
  const scenario = new Map();
  let latestBoard = null;
  let pollTimer = null;
  let enhanceTimer = null;
  let enhancing = false;

  const esc = value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const num = value => { const n = Number(value); return Number.isFinite(n) ? n : NaN; };
  const fmt = (value, digits = 1) => Number.isFinite(num(value)) ? num(value).toFixed(digits).replace(/\.0$/,'') : '—';
  const playerOf = item => item?.player || item?.player_name || '';
  const currentEvent = () => new URLSearchParams(location.search).get('event') || localStorage.getItem('pbe_nfl_event') || DEFAULT_EVENT;

  function erf(x) {
    const sign = x < 0 ? -1 : 1, a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
    const y = 1 - (((((1.061405429*t - 1.453152027)*t + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t*Math.exp(-a*a));
    return sign * y;
  }
  const normalCdf = z => .5 * (1 + erf(z / Math.sqrt(2)));
  const overProb = (threshold, mean, sd) => Number.isFinite(threshold) && Number.isFinite(mean) && Number.isFinite(sd) && sd > 0 ? Math.max(0, Math.min(1, 1 - normalCdf((threshold - mean) / sd))) : NaN;
  const normalPdf = z => Math.exp(-.5*z*z) / Math.sqrt(2*Math.PI);

  function marketMap(board) {
    const out = new Map();
    (board?.market_summary || []).forEach(row => {
      const p = playerOf(row); const value = num(row.consensus_line ?? row.line);
      if (p && Number.isFinite(value)) out.set(p.toLowerCase(), value);
    });
    if (!out.size) {
      const groups = new Map();
      (board?.quotes || []).forEach(q => {
        const p = playerOf(q), point = num(q.point ?? q.line); if (!p || !Number.isFinite(point)) return;
        const key = p.toLowerCase(); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(point);
      });
      groups.forEach((values, key) => {
        values.sort((a,b)=>a-b); const i = Math.floor(values.length/2);
        out.set(key, values.length % 2 ? values[i] : (values[i-1]+values[i])/2);
      });
    }
    return out;
  }

  function rows() {
    const state = window.PBEModelLab?.state;
    const model = state?.model;
    const board = latestBoard || state?.board;
    const raw = model?.models || model?.picks || model?.data || [];
    const market = marketMap(board);
    return (Array.isArray(raw) ? raw : []).filter(row => row?.available !== false).map(row => {
      const player = playerOf(row); const consensus = num(row.market_consensus_line);
      return {
        ...row, player,
        market: Number.isFinite(consensus) ? consensus : market.get(player.toLowerCase()),
        fair: num(row.fair_line ?? row.projected_line),
        gap: num(row.fair_line_gap_yards ?? row.model_gap ?? row.gap),
        prob: num(row.model_over_at_consensus_pct ?? row.over_probability_pct ?? row.probability),
        sd: num(row.predictive_sd)
      };
    }).sort((a,b)=>Math.abs(b.gap||0)-Math.abs(a.gap||0));
  }

  function scenarioFor(row) {
    const key = row.player.toLowerCase();
    if (!scenario.has(key)) scenario.set(key, { pct:0, lens:'manual' });
    return scenario.get(key);
  }

  function americanFair(p) {
    if (!Number.isFinite(p) || p <= 0 || p >= 1) return '—';
    const value = p >= .5 ? -100 * p / (1-p) : 100 * (1-p) / p;
    return `${value > 0 ? '+' : ''}${Math.round(value)}`;
  }
  function american(value) { const n = num(value); return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${Math.round(n)}` : '—'; }
  function rawImplied(value) {
    const a = num(value); if (!Number.isFinite(a) || a === 0) return NaN;
    return a < 0 ? Math.abs(a)/(Math.abs(a)+100) : 100/(a+100);
  }
  function decimalOdds(value) {
    const a = num(value); if (!Number.isFinite(a) || a === 0) return NaN;
    return a > 0 ? 1 + a/100 : 1 + 100/Math.abs(a);
  }
  function evPct(p, price) {
    const dec = decimalOdds(price); if (!Number.isFinite(p) || !Number.isFinite(dec)) return NaN;
    return (p*(dec-1) - (1-p))*100;
  }
  function kellyPct(p, price) {
    const dec = decimalOdds(price); if (!Number.isFinite(p) || !Number.isFinite(dec) || dec <= 1) return NaN;
    const b = dec - 1, f = (b*p - (1-p))/b;
    return Math.max(0, f)*100;
  }

  function sideOf(q) {
    const raw = String(q?.direction || q?.outcome || q?.side || q?.name || '').toUpperCase();
    if (raw === 'YES' || raw.includes('OVER')) return 'OVER';
    if (raw === 'NO' || raw.includes('UNDER')) return 'UNDER';
    return raw;
  }
  const bookOf = q => q?.book || q?.book_title || q?.sportsbook || q?.book_key || 'Book';
  const pointOf = q => num(q?.point ?? q?.line);
  const priceOf = q => num(q?.price ?? q?.american_odds ?? q?.odds);

  function quotesFor(row) {
    const all = (latestBoard || window.PBEModelLab?.state?.board)?.quotes || [];
    return all.filter(q => playerOf(q).toLowerCase() === row.player.toLowerCase() && (!q.market || q.market === 'player_pass_yds'));
  }
  function bestQuote(row, side) {
    const q = quotesFor(row).filter(x => sideOf(x) === side && Number.isFinite(pointOf(x)) && Number.isFinite(priceOf(x)));
    if (!q.length) return null;
    return q.slice().sort((a,b) => {
      const ap=pointOf(a), bp=pointOf(b);
      if (ap !== bp) return side === 'OVER' ? ap-bp : bp-ap;
      return priceOf(b)-priceOf(a);
    })[0];
  }
  function deVigFor(row, quote, side) {
    if (!quote) return NaN;
    const line = pointOf(quote), book = bookOf(quote);
    const opposite = quotesFor(row).find(q => bookOf(q) === book && sideOf(q) !== side && Math.abs(pointOf(q)-line) < .01 && Number.isFinite(priceOf(q)));
    if (!opposite) return NaN;
    const a = rawImplied(priceOf(quote)), b = rawImplied(priceOf(opposite));
    return Number.isFinite(a) && Number.isFinite(b) && a+b>0 ? a/(a+b) : NaN;
  }

  function distributionSvg(row, scenarioMean) {
    const mean=row.fair, sd=row.sd, market=row.market;
    if (![mean,sd,market].every(Number.isFinite) || sd <= 0) return '<div class="pbemlx-tape-empty">Distribution unavailable: fair line, market and predictive SD are required.</div>';
    const min=Math.max(0, mean-3*sd), max=mean+3*sd, span=max-min;
    const pts=[];
    for(let i=0;i<=72;i++){
      const x=min+span*i/72, z=(x-mean)/sd, pdf=normalPdf(z), px=i/72*100, py=94-(pdf/.39894228)*76;
      pts.push({x,px,py});
    }
    const curve=pts.map((p,i)=>`${i?'L':'M'} ${p.px.toFixed(2)} ${p.py.toFixed(2)}`).join(' ');
    const shadePts=pts.filter(p=>p.x>=market);
    const shade=shadePts.length ? `M ${shadePts[0].px.toFixed(2)} 94 ${shadePts.map(p=>`L ${p.px.toFixed(2)} ${p.py.toFixed(2)}`).join(' ')} L 100 94 Z` : '';
    const xPos=value=>Math.max(0,Math.min(100,(value-min)/span*100));
    return `<div class="pbemlx-dist"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Normal distribution centered on production PBE fair line"><path class="shade" d="${shade}"></path><path class="curve" d="${curve}"></path><line class="mean" x1="${xPos(mean).toFixed(2)}" x2="${xPos(mean).toFixed(2)}" y1="8" y2="94"></line><line class="market" x1="${xPos(market).toFixed(2)}" x2="${xPos(market).toFixed(2)}" y1="8" y2="94"></line>${Math.abs(scenarioMean-mean)>.01?`<line class="scenario" x1="${xPos(scenarioMean).toFixed(2)}" x2="${xPos(scenarioMean).toFixed(2)}" y1="8" y2="94"></line>`:''}</svg><div class="pbemlx-axis"><span>${fmt(min,0)}</span><span>${fmt(mean,1)} PBE fair</span><span>${fmt(max,0)}</span></div></div>`;
  }

  function sdPercentile(row, allRows) {
    const sds=allRows.map(r=>r.sd).filter(Number.isFinite).sort((a,b)=>a-b); if (!sds.length || !Number.isFinite(row.sd)) return null;
    const below=sds.filter(v=>v<=row.sd).length; return Math.round(below/sds.length*100);
  }

  function tapeKey(row){return `pbe_model_lab_tape_${currentEvent()}_${row.player.toLowerCase().replace(/[^a-z0-9]+/g,'_')}`;}
  function readTape(row){try{const x=JSON.parse(localStorage.getItem(tapeKey(row))||'[]');return Array.isArray(x)?x:[];}catch(_){return[];}}
  function recordTape(row, at=Date.now()){
    if (!Number.isFinite(row.market)) return;
    const tape=readTape(row).filter(p=>Number.isFinite(Number(p.at))&&at-Number(p.at)<=48*3600000);
    const last=tape[tape.length-1];
    if (!last || Number(last.value)!==Number(row.market) || at-Number(last.at)>=5*60000) tape.push({at,value:row.market});
    try{localStorage.setItem(tapeKey(row),JSON.stringify(tape.slice(-96)));}catch(_){}
  }
  function tapeSvg(row){
    const tape=readTape(row); if(tape.length<2)return '<div class="pbemlx-tape-empty">Browser-local 48h tape starts when this browser observes the market. Historical provider movement is not backfilled.</div>';
    const vals=tape.map(p=>Number(p.value)), min=Math.min(...vals), max=Math.max(...vals), span=Math.max(.5,max-min);
    const pts=tape.map((p,i)=>`${(i/(tape.length-1)*100).toFixed(2)},${(46-((Number(p.value)-min)/span)*38).toFixed(2)}`).join(' ');
    return `<div class="pbemlx-tape-svg"><svg viewBox="0 0 100 54" preserveAspectRatio="none"><polyline points="${pts}"></polyline></svg></div><div class="pbemlx-axis" style="position:static;margin-top:1px"><span>${fmt(vals[0],1)} open obs.</span><span>${tape.length} local samples</span><span>${fmt(vals[vals.length-1],1)} now</span></div>`;
  }

  function priceCard(row, side) {
    const quote=bestQuote(row,side); if(!quote)return `<article class="pbemlx-price-card"><header><span>${side}</span><b>NO QUOTE</b></header><div class="price">—</div><div class="pbemlx-note">No current executable ${side.toLowerCase()} quote was returned for this player.</div></article>`;
    const threshold=pointOf(quote), price=priceOf(quote), pOver=overProb(threshold,row.fair,row.sd), p=side==='OVER'?pOver:1-pOver;
    const ev=evPct(p,price), kelly=kellyPct(p,price), vigfree=deVigFor(row,quote,side);
    return `<article class="pbemlx-price-card"><header><span>${side} ${esc(fmt(threshold,1))} · ${esc(bookOf(quote))}</span><b>${esc(american(price))}</b></header><div class="price ${Number.isFinite(ev)&&ev>0?'good':''}">${Number.isFinite(ev)?`${ev>0?'+':''}${ev.toFixed(1)}% EV`:'EV —'}</div><div class="pbemlx-price-metrics"><div><span>Model</span><strong>${Number.isFinite(p)?`${(p*100).toFixed(1)}%`:'—'}</strong></div><div><span>Fair odds</span><strong>${americanFair(p)}</strong></div><div><span>Vig-free mkt</span><strong>${Number.isFinite(vigfree)?`${(vigfree*100).toFixed(1)}%`:'—'}</strong></div><div><span>Full Kelly</span><strong>${Number.isFinite(kelly)?`${kelly.toFixed(1)}%`:'—'}</strong></div><div><span>Quarter Kelly</span><strong class="${Number.isFinite(kelly)&&kelly>0?'good':''}">${Number.isFinite(kelly)?`${(kelly/4).toFixed(1)}%`:'—'}</strong></div><div><span>Raw implied</span><strong>${Number.isFinite(rawImplied(price))?`${(rawImplied(price)*100).toFixed(1)}%`:'—'}</strong></div></div></article>`;
  }

  function panel(row, allRows) {
    const s=scenarioFor(row), scenarioMean=row.fair*(1+s.pct/100), scenarioP=overProb(row.market,scenarioMean,row.sd), prodP=overProb(row.market,row.fair,row.sd);
    const missing=Array.isArray(row.missing_inputs)?row.missing_inputs:[];
    const lenses=['manual',...missing];
    const rank=sdPercentile(row,allRows);
    return `<section class="pbemlx" data-pbemlx-player="${esc(row.player)}"><section class="pbemlx-panel"><div class="pbemlx-head"><div><span>Predictive distribution</span><strong>Probability surface</strong></div><b>PRODUCTION MEAN + SD</b></div>${distributionSvg(row,scenarioMean)}<div class="pbemlx-legend"><span><i></i>PBE fair ${esc(fmt(row.fair,1))}</span><span><i class="market"></i>Market ${esc(fmt(row.market,1))}</span>${Math.abs(s.pct)>.001?`<span><i class="scenario"></i>Scenario mean ${esc(fmt(scenarioMean,1))}</span>`:''}</div><div class="pbemlx-ci"><div><span>68% interval · ±1 SD</span><strong>${esc(fmt(Math.max(0,row.fair-row.sd),1))} – ${esc(fmt(row.fair+row.sd,1))}</strong></div><div><span>95% interval · ±1.96 SD</span><strong>${esc(fmt(Math.max(0,row.fair-1.96*row.sd),1))} – ${esc(fmt(row.fair+1.96*row.sd,1))}</strong></div></div><div class="pbemlx-note" style="margin-top:7px">Predictive SD ${esc(fmt(row.sd,1))}${rank===null?'':` · ${rank}th percentile of the currently loaded PBE slate`} — current-slate context only, not a historical player benchmark.</div></section><section class="pbemlx-panel"><div class="pbemlx-head"><div><span>What-if sandbox</span><strong>Manual scenario overlay</strong></div><b>NOT A MODEL RERUN</b></div><div class="pbemlx-sandbox"><div class="pbemlx-control"><label><span>Scenario lens</span><select data-pbemlx-lens="${esc(row.player)}">${lenses.map(value=>`<option value="${esc(value)}" ${s.lens===value?'selected':''}>${esc(value==='manual'?'Manual fair-line shift':String(value).replace(/_/g,' '))}</option>`).join('')}</select></label><label><span>Fair-line shift</span><input data-pbemlx-pct="${esc(row.player)}" type="number" min="-30" max="30" step="0.5" value="${esc(s.pct)}"></label></div><input class="pbemlx-slider" data-pbemlx-range="${esc(row.player)}" type="range" min="-20" max="20" step="0.5" value="${esc(s.pct)}"><div class="pbemlx-scenario-read"><div><span>Scenario fair</span><strong>${esc(fmt(scenarioMean,1))}</strong></div><div><span>Scenario Over</span><strong>${Number.isFinite(scenarioP)?`${(scenarioP*100).toFixed(1)}%`:'—'}</strong></div><div><span>Production Over</span><strong>${Number.isFinite(prodP)?`${(prodP*100).toFixed(1)}%`:'—'}</strong></div></div><div class="pbemlx-note">A ${s.pct>0?'+':''}${esc(fmt(s.pct,1))}% shift changes only the distribution mean while holding production predictive SD fixed. Selecting “${esc(s.lens==='manual'?'manual':String(s.lens).replace(/_/g,' '))}” is a label for your scenario, not a claim that PBE measured that causal effect.</div></div></section><section class="pbemlx-pricing"><div class="pbemlx-market-tape"><div class="pbemlx-head" style="margin:0"><div><span>Market movement</span><strong>Browser-local 48h tape</strong></div><b>NO BACKFILL</b></div>${tapeSvg(row)}</div><div class="pbemlx-market-tape"><div class="pbemlx-head" style="margin:0 0 8px"><div><span>Live price translation</span><strong>EV + Kelly context</strong></div><b>MODEL-DERIVED</b></div><div class="pbemlx-price-grid">${priceCard(row,'OVER')}${priceCard(row,'UNDER')}</div><div class="pbemlx-note" style="margin-top:7px">EV, fair odds and Kelly are mathematical translations of the production distribution against the displayed current quote. Quarter Kelly is an allocation sandbox, not a performance guarantee or independently trained sizing model.</div></div></section></section>`;
  }

  function wire(container,row) {
    const key=row.player.toLowerCase();
    container.querySelector(`[data-pbemlx-lens="${CSS.escape(row.player)}"]`)?.addEventListener('change',e=>{scenarioFor(row).lens=e.currentTarget.value;queueEnhance();});
    const update=value=>{const n=Math.max(-30,Math.min(30,Number(value)||0));scenarioFor(row).pct=Math.round(n*2)/2;queueEnhance();};
    container.querySelector(`[data-pbemlx-pct="${CSS.escape(row.player)}"]`)?.addEventListener('change',e=>update(e.currentTarget.value));
    container.querySelector(`[data-pbemlx-range="${CSS.escape(row.player)}"]`)?.addEventListener('input',e=>update(e.currentTarget.value));
  }

  function enhance() {
    if (enhancing || window.App?.current !== 'picks' || !window.PBEModelLab?.state?.model) return;
    const cards=[...document.querySelectorAll('.pbe4-model-row')]; if(!cards.length)return;
    enhancing=true;
    try{
      const allRows=rows();
      cards.forEach((card,index)=>{
        const row=allRows[index]; if(!row||!Number.isFinite(row.fair)||!Number.isFinite(row.sd)||row.sd<=0)return;
        recordTape(row);
        const existing=card.querySelector(':scope > .pbemlx');
        const wrap=document.createElement('div'); wrap.innerHTML=panel(row,allRows); const next=wrap.firstElementChild;
        if(existing)existing.replaceWith(next); else card.appendChild(next);
        wire(next,row);
      });
    }finally{enhancing=false;}
  }

  function queueEnhance(){clearTimeout(enhanceTimer);enhanceTimer=setTimeout(enhance,35);}

  async function pollMarket(){
    if(window.App?.current!=='picks'||document.visibilityState!=='visible'||!window.PBEModelLab?.state?.model)return;
    try{
      const r=await fetch(`${API}/api/odds/board?event_id=${encodeURIComponent(currentEvent())}&markets=player_pass_yds`,{cache:'no-store',headers:{Accept:'application/json'}});
      if(!r.ok)return; latestBoard=await r.json();
      const mm=marketMap(latestBoard); rows().forEach(row=>{const v=mm.get(row.player.toLowerCase());if(Number.isFinite(v)){row.market=v;recordTape(row);}});
      queueEnhance();
    }catch(_){}
  }

  const observer=new MutationObserver(queueEnhance);
  observer.observe(document.documentElement,{childList:true,subtree:true});
  window.addEventListener('pbe:route-changed',()=>{queueEnhance();setTimeout(pollMarket,100);});
  window.addEventListener('pbe:event-changed',()=>{latestBoard=null;setTimeout(pollMarket,150);});
  window.addEventListener('pbe:pro-state',queueEnhance);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')pollMarket();});
  pollTimer=setInterval(pollMarket,POLL_MS);
  setTimeout(queueEnhance,100);
})();
