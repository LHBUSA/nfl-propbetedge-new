/* PropBetEdge NFL — Model Lab
 * Uses live passing-yard market for context and server-gated production PBE model output for NFL Pro.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const DEFAULT_EVENT = '8c94552d022acec4a0458d70c19d3da9';
  const state = { loading:false, eventId:'', board:null, model:null };

  const esc = value => String(value ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const num = value => { const n=Number(value); return Number.isFinite(n)?n:NaN; };
  const fmt = (value,digits=1) => { const n=num(value); return Number.isFinite(n)?n.toFixed(digits).replace(/\.0$/,''):'—'; };
  const isPro = () => Boolean(window.PBEPro?.state?.pro);
  const playerOf = item => item?.player || item?.player_name || '';
  const currentEvent = () => new URLSearchParams(location.search).get('event') || localStorage.getItem('pbe_nfl_event') || DEFAULT_EVENT;

  async function fetchJson(url) {
    const response = await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});
    if (!response.ok) {
      const detail=await response.text().catch(()=> '');
      const error=new Error(`${response.status}${detail?` · ${detail.slice(0,160)}`:''}`);
      error.status=response.status;
      throw error;
    }
    return response.json();
  }

  function marketMap(board) {
    const out=new Map();
    (board?.market_summary || []).forEach(row => {
      const player=playerOf(row);
      if (player) out.set(player.toLowerCase(),num(row.consensus_line ?? row.line));
    });
    if (!out.size) {
      const groups=new Map();
      (board?.quotes || []).forEach(q => {
        const player=playerOf(q);
        const point=num(q.point ?? q.line);
        if (!player || !Number.isFinite(point)) return;
        const key=player.toLowerCase();
        if (!groups.has(key)) groups.set(key,[]);
        groups.get(key).push(point);
      });
      groups.forEach((values,key) => {
        const clean=[...values].sort((a,b)=>a-b);
        const i=Math.floor(clean.length/2);
        const med=clean.length%2?clean[i]:(clean[i-1]+clean[i])/2;
        out.set(key,med);
      });
    }
    return out;
  }

  function modelRows(model,board) {
    const rows=model?.models || model?.picks || model?.data || [];
    const market=marketMap(board);
    return (Array.isArray(rows)?rows:[]).filter(row=>row?.available!==false).map(row => {
      const player=playerOf(row);
      const consensus=num(row.market_consensus_line);
      return {
        ...row,
        player,
        market:Number.isFinite(consensus)?consensus:market.get(player.toLowerCase()),
        fair:num(row.fair_line ?? row.projected_line),
        gap:num(row.fair_line_gap_yards ?? row.model_gap ?? row.gap),
        prob:num(row.model_over_at_consensus_pct ?? row.over_probability_pct ?? row.probability),
        sd:num(row.predictive_sd),
        attempts:num(row.projected_attempts)
      };
    }).sort((a,b)=>Math.abs(b.gap||0)-Math.abs(a.gap||0));
  }

  function eventMeta(board) {
    const event=board?.event || {};
    return {
      away:event.away_team || event.away || 'Away',
      home:event.home_team || event.home || 'Home',
      time:event.commence_time || event.start_time || event.game_time || null
    };
  }

  function versionOf(model) {
    return model?.model_version || model?.source?.model_version || model?.lineage || 'PBE production model';
  }

  function statusOf(model) {
    return model?.status || model?.decision_status || model?.model_status || 'MODEL';
  }

  function freeView(board) {
    const event=eventMeta(board);
    const semantics=board?.source?.semantics || 'UNAVAILABLE';
    const provider=board?.source?.provider || 'unknown';
    return `<section class="pbe4-model-lab">
      <header class="pbe4-model-hero">
        <div><div class="pbe4-kicker">PBE MODEL LAB · NFL PRO</div><h1 class="pbe4-title">Understand the model.<br><em>Not just the output.</em></h1><div class="pbe4-copy">Model Lab is the audit surface for PropBetEdge NFL. The current production passing model is kept separate from sportsbook pricing, missing inputs remain visible, and no synthetic pick cards are used when the model does not support a market.</div><div class="pbe4-actions"><button class="pbe4-button gold" type="button" onclick="PBEPro.open('upgrade')">Unlock NFL Pro · $9.99/week</button><button class="pbe4-button" type="button" onclick="App.nav('propboard')">View free market board</button></div></div>
        <aside class="pbe4-model-status"><div class="pbe4-status-label">Current event context</div><div class="pbe4-status-version">${esc(event.away)} @ ${esc(event.home)}</div><span class="pbe4-status-pill ${semantics==='LIVE'?'live':''}">MARKET ${esc(semantics)}</span><div class="pbe4-status-rule"></div><div class="pbe4-status-row"><span>Sportsbook provider</span><strong>${esc(provider)}</strong></div><div class="pbe4-status-row"><span>Model layer</span><strong style="color:#d8b75b">NFL PRO LOCKED</strong></div><div class="pbe4-status-row"><span>Model endpoint</span><strong>SERVER GATED</strong></div></aside>
      </header>
      <div class="pbe4-free-wall"><section class="pbe4-free-panel"><strong>Proprietary model intelligence is protected.</strong><p>The underlying sportsbook market remains visible on the Prop Board. NFL Pro unlocks the PBE fair line, probability at the current consensus, fair-line gap, uncertainty and model input audit.</p><div class="pbe4-preview-grid"><div class="pbe4-preview"><b>254.1</b><span>PBE fair line</span></div><div class="pbe4-preview"><b>66.5%</b><span>Model over probability</span></div><div class="pbe4-preview"><b>+24.6</b><span>Fair-line gap</span></div></div></section><section class="pbe4-method-panel"><div class="pbe4-panel-head"><strong>What Model Lab exposes</strong><span>Truth-first analysis</span></div><div class="pbe4-method-list"><div class="pbe4-method-item"><b>Market vs. fair value</b><span>The sportsbook consensus is displayed separately from PBE fair value. The difference is labeled model gap, not guaranteed edge.</span></div><div class="pbe4-method-item"><b>Uncertainty and sample</b><span>Predictive standard deviation and effective sample size stay visible so a point estimate is never presented without context.</span></div><div class="pbe4-method-item"><b>Missing inputs</b><span>Unavailable adjustments remain explicit instead of being silently replaced by assumptions.</span></div><div class="pbe4-method-item"><b>Versioned model output</b><span>Model version/status comes from the current production response so the page does not hardcode a stale model identity.</span></div></div></section></div>
    </section>`;
  }

  function modelMeter(row) {
    if (!Number.isFinite(row.market) || !Number.isFinite(row.fair)) return '<div class="pbe4-meter"></div>';
    const range=Math.max(20,Math.abs(row.fair-row.market)*3);
    const min=row.market-range/2;
    const max=row.market+range/2;
    const pos=Math.max(2,Math.min(98,((row.fair-min)/(max-min))*100));
    return `<div class="pbe4-meter-head"><span>Lower than market</span><span>Market ${esc(fmt(row.market,1))}</span><span>Higher than market</span></div><div class="pbe4-meter"><span class="pbe4-meter-mid"></span><span class="pbe4-meter-dot" style="left:${pos.toFixed(1)}%"></span></div>`;
  }

  function missingChips(row) {
    const missing=Array.isArray(row.missing_inputs)?row.missing_inputs:[];
    if (!missing.length) return '<span class="pbe4-chip">No missing inputs reported</span>';
    return missing.map(value=>`<span class="pbe4-chip missing">${esc(String(value).replace(/_/g,' '))}</span>`).join('');
  }

  function rowHtml(row) {
    const gap=row.gap;
    const gapClass=Number.isFinite(gap)?(gap>=0?'green':'red'):'';
    const status=row.decision_status || row.confidence || 'MODEL';
    return `<article class="pbe4-model-row">
      <div class="pbe4-model-main">
        <div class="pbe4-cell"><div class="pbe4-player">${esc(row.player || 'Player')}</div><div class="pbe4-player-meta">Passing yards · ${esc(String(status).replace(/_/g,' '))}<br>${esc(row.effective_games ?? row.raw_games ?? '—')} effective/raw games</div></div>
        <div class="pbe4-cell"><div class="pbe4-value">${esc(fmt(row.market,1))}</div><div class="pbe4-label">Market consensus</div></div>
        <div class="pbe4-cell"><div class="pbe4-value blue">${esc(fmt(row.fair,1))}</div><div class="pbe4-label">PBE fair line</div></div>
        <div class="pbe4-cell"><div class="pbe4-value green">${esc(fmt(row.prob,1))}%</div><div class="pbe4-label">Model over @ consensus</div></div>
        <div class="pbe4-cell"><div class="pbe4-value ${gapClass}">${Number.isFinite(gap)&&gap>0?'+':''}${esc(fmt(gap,1))}</div><div class="pbe4-label">Fair-line gap</div></div>
      </div>
      <div class="pbe4-meter-wrap">${modelMeter(row)}</div>
      <div class="pbe4-details">
        <div class="pbe4-detail-box"><strong>Model inputs</strong><p>Projected attempts: ${esc(fmt(row.attempts,1))} · Predictive SD: ${esc(fmt(row.sd,1))} · Raw games: ${esc(row.raw_games ?? '—')} · Effective games: ${esc(row.effective_games ?? '—')}</p><div class="pbe4-input-chips"><span class="pbe4-chip">Market context</span><span class="pbe4-chip">Recency weighting</span><span class="pbe4-chip">Opponent context</span></div></div>
        <div class="pbe4-detail-box"><strong>Missing / unresolved inputs</strong><p>If an adjustment is not available, it stays visible here rather than being converted into an invented neutral score.</p><div class="pbe4-input-chips">${missingChips(row)}</div></div>
      </div>
    </article>`;
  }

  function proView(board,model) {
    const rows=modelRows(model,board);
    const event=eventMeta(board);
    const semantics=board?.source?.semantics || 'UNAVAILABLE';
    const version=versionOf(model);
    const status=statusOf(model);
    const gaps=rows.map(row=>Math.abs(row.gap)).filter(Number.isFinite);
    const avgGap=gaps.length?gaps.reduce((a,b)=>a+b,0)/gaps.length:NaN;
    const probs=rows.map(row=>row.prob).filter(Number.isFinite);
    const avgProb=probs.length?probs.reduce((a,b)=>a+b,0)/probs.length:NaN;
    return `<section class="pbe4-model-lab">
      <header class="pbe4-model-hero">
        <div><div class="pbe4-kicker">PBE MODEL LAB · NFL PRO ACTIVE</div><h1 class="pbe4-title">Audit the model.<br><em>Interrogate every output.</em></h1><div class="pbe4-copy">This page is not a pick generator. It is the production model's analysis surface: current market, PBE fair line, probability, uncertainty, sample size, missing inputs and decision status in one place.</div><div class="pbe4-actions"><button class="pbe4-button primary" type="button" onclick="App.nav('propboard')">Open market desk</button><button class="pbe4-button" type="button" onclick="App.nav('picks')">Refresh model</button></div></div>
        <aside class="pbe4-model-status"><div class="pbe4-status-label">Production model</div><div class="pbe4-status-version">${esc(version)}</div><span class="pbe4-status-pill">MODEL · ${esc(String(status).replace(/_/g,' '))}</span><div class="pbe4-status-rule"></div><div class="pbe4-status-row"><span>Current event</span><strong>${esc(event.away)} @ ${esc(event.home)}</strong></div><div class="pbe4-status-row"><span>Market semantics</span><strong class="${semantics==='LIVE'?'good':''}">${esc(semantics)}</strong></div><div class="pbe4-status-row"><span>Modeled props returned</span><strong>${rows.length}</strong></div><div class="pbe4-status-row"><span>Entitlement</span><strong style="color:#55d68c">NFL PRO VERIFIED</strong></div></aside>
      </header>
      <div class="pbe4-summary"><div class="pbe4-card"><div class="pbe4-card-value">${rows.length}</div><div class="pbe4-card-label">Production model rows</div></div><div class="pbe4-card"><div class="pbe4-card-value blue">${esc(fmt(avgGap,1))}</div><div class="pbe4-card-label">Average absolute model gap</div></div><div class="pbe4-card"><div class="pbe4-card-value green">${esc(fmt(avgProb,1))}%</div><div class="pbe4-card-label">Average model over probability</div></div><div class="pbe4-card"><div class="pbe4-card-value">${esc(board?.quote_count ?? board?.quotes?.length ?? 0)}</div><div class="pbe4-card-label">Passing-yard market quotes</div></div><div class="pbe4-card"><div class="pbe4-card-value">${esc(rows.filter(row=>Array.isArray(row.missing_inputs)&&row.missing_inputs.length).length)}</div><div class="pbe4-card-label">Rows reporting missing inputs</div></div></div>
      <div class="pbe4-model-list">${rows.length?rows.map(rowHtml).join(''):`<div class="pbe4-error"><div><strong>No production model rows returned</strong><p>The current event does not have supported passing-model output. Model Lab will not fabricate rows to fill the page.</p></div></div>`}</div>
      <div class="pbe4-audit-grid"><section class="pbe4-audit-panel"><div class="pbe4-panel-head"><strong>Model contract</strong><span>What this page guarantees</span></div><div class="pbe4-audit-list"><div class="pbe4-audit-row"><span>Sportsbook lines shown as MARKET, never model values</span><strong class="good">ENFORCED</strong></div><div class="pbe4-audit-row"><span>PBE projections labeled MODEL</span><strong class="good">ENFORCED</strong></div><div class="pbe4-audit-row"><span>Difference labeled fair-line/model gap, not guaranteed edge</span><strong class="good">ENFORCED</strong></div><div class="pbe4-audit-row"><span>Missing model inputs exposed when supplied by model</span><strong class="good">VISIBLE</strong></div><div class="pbe4-audit-row"><span>Unsupported props replaced with synthetic output</span><strong class="warn">NEVER</strong></div></div></section><section class="pbe4-audit-panel"><div class="pbe4-panel-head"><strong>Interpretation</strong><span>Analysis, not certainty</span></div><div class="pbe4-disclaimer"><strong>Fair line</strong> is the model's point estimate for the supported prop. <strong>Model over probability</strong> is the modeled probability at the displayed consensus line. <strong>Fair-line gap</strong> is the numeric difference between those two line estimates. It is not itself a bet recommendation, guaranteed edge, expected return, or claim about future results.<br><br>Uncertainty, sample size and missing adjustments matter. Model Lab keeps those visible so the product can get more sophisticated without pretending the current model knows more than it does.</div></section></div>
    </section>`;
  }

  async function render() {
    if (state.loading) return;
    state.loading=true;
    state.eventId=currentEvent();
    const vc=document.getElementById('view-container');
    if (!vc) { state.loading=false; return; }
    vc.innerHTML=`<section class="pbe4-model-lab"><div class="pbe4-loading"><div><strong>Opening Model Lab</strong><p>Loading current passing-yard market context and checking NFL Pro model access.</p><div class="pbe4-loadbar"></div></div></div></section>`;
    try {
      state.board=await fetchJson(`${API}/api/odds/board?event_id=${encodeURIComponent(state.eventId)}&markets=player_pass_yds`);
      if (!isPro()) {
        state.model=null;
        vc.innerHTML=freeView(state.board);
        return;
      }
      state.model=await fetchJson(`${API}/api/picks/pass?event_id=${encodeURIComponent(state.eventId)}`);
      vc.innerHTML=proView(state.board,state.model);
    } catch (error) {
      if ((error.status===401 || error.status===403) && state.board) {
        state.model=null;
        vc.innerHTML=freeView(state.board);
      } else {
        vc.innerHTML=`<section class="pbe4-model-lab"><div class="pbe4-error"><div><strong>Model Lab unavailable</strong><p>${esc(error?.message || 'The current market/model services did not return a usable response.')}</p><div style="display:flex;gap:7px;justify-content:center;margin-top:14px"><button class="pbe4-button primary" onclick="App.nav('picks')">Retry</button><button class="pbe4-button" onclick="App.nav('propboard')">Market desk</button></div></div></div></section>`;
      }
    } finally {
      state.loading=false;
    }
  }

  function install() {
    if (!window.App?.VIEWS) return false;
    App.VIEWS.picks=render;
    return true;
  }

  window.PBEModelLab={render,state};
  install();
  document.addEventListener('DOMContentLoaded',install,{once:true});
  window.addEventListener('pbe:pro-state',event => {
    if (!document.querySelector('.pbe4-model-lab') || state.loading) return;
    const pro=Boolean(event.detail?.pro);
    if ((pro && !state.model) || (!pro && state.model)) render();
  });
})();
