/* PropBetEdge NFL — Market Watch v2
 * Cross-sectional sportsbook dispersion is current provider data.
 * Movement is ONLY against a user-captured local baseline stored in this browser.
 * No provider-historical movement is claimed.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const DEFAULT_EVENT = '8c94552d022acec4a0458d70c19d3da9';
  const BATCH_SIZE = 5;
  const MARKETS = [
    'player_pass_yds','player_pass_completions','player_pass_attempts','player_pass_tds','player_pass_interceptions',
    'player_reception_yds','player_receptions','player_rush_yds','player_rush_attempts','player_anytime_td'
  ];
  const state = { loading:false,board:null,rows:[],search:'',market:'all',filter:'all',sort:'dispersion',watch:new Set(),baseline:null };

  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const num=v=>{const n=Number(v);return Number.isFinite(n)?n:NaN};
  const fmt=(v,d=1)=>{const n=num(v);return Number.isFinite(n)?n.toFixed(d).replace(/\.0$/,''):'—'};
  const price=v=>{const n=num(v);return Number.isFinite(n)?`${n>0?'+':''}${Math.round(n)}`:'—'};
  const currentEvent=()=>new URLSearchParams(location.search).get('event')||localStorage.getItem('pbe_nfl_event')||DEFAULT_EVENT;
  const isPro=()=>Boolean(window.PBEPro?.state?.pro);
  const playerOf=x=>x?.player||x?.player_name||'';
  const bookOf=q=>q?.book||q?.book_title||q?.sportsbook||q?.book_key||'';
  const sideOf=q=>String(q?.direction||q?.outcome||q?.side||q?.name||'').toUpperCase();
  const pointOf=q=>num(q?.point??q?.line);
  const priceOf=q=>num(q?.price??q?.american_odds??q?.odds);
  const eventKey=()=>`pbe_market_watch_${currentEvent()}`;
  const baselineKey=()=>`pbe_market_baseline_${currentEvent()}`;
  const marketLabel=m=>({player_pass_yds:'Passing Yards',player_pass_completions:'Pass Completions',player_pass_attempts:'Pass Attempts',player_pass_tds:'Passing TDs',player_pass_interceptions:'Interceptions',player_reception_yds:'Receiving Yards',player_receptions:'Receptions',player_rush_yds:'Rushing Yards',player_rush_attempts:'Rush Attempts',player_anytime_td:'Anytime TD'}[m]||String(m||'').replace(/^player_/,'').replace(/_/g,' '));

  async function fetchJson(url){const r=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});if(!r.ok){const text=await r.text().catch(()=> '');throw new Error(`${r.status}${text?` · ${text.slice(0,120)}`:''}`);}return r.json();}
  function batch(values,size){const out=[];for(let i=0;i<values.length;i+=size)out.push(values.slice(i,i+size));return out;}
  function median(values){const a=values.map(num).filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return NaN;const i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2;}
  function bestQuote(quotes,side){const rows=quotes.filter(q=>sideOf(q).includes(side));if(!rows.length)return null;return [...rows].sort((a,b)=>{const ap=pointOf(a),bp=pointOf(b);if(Number.isFinite(ap)&&Number.isFinite(bp)&&ap!==bp)return side==='OVER'?ap-bp:bp-ap;return priceOf(b)-priceOf(a);})[0];}

  function mergeBoards(parts){
    const valid=parts.filter(Boolean);if(!valid.length)throw new Error('No Prop Board batches returned');
    const merged={...valid[0],quotes:[],market_summary:[]},qSeen=new Set(),sSeen=new Set();
    valid.forEach(part=>{
      (part.quotes||[]).forEach(q=>{const key=[bookOf(q),q.market,playerOf(q),sideOf(q),q.point??q.line,q.price??q.odds??q.american_odds].join('|');if(!qSeen.has(key)){qSeen.add(key);merged.quotes.push(q);}});
      (part.market_summary||[]).forEach(s=>{const key=`${playerOf(s)}|${s.market}`;if(!sSeen.has(key)){sSeen.add(key);merged.market_summary.push(s);}});
    });
    merged.quote_count=merged.quotes.length;const pm=new Set();[...merged.quotes,...merged.market_summary].forEach(x=>{const p=playerOf(x);if(p&&x.market)pm.add(`${p}|${x.market}`)});merged.player_market_count=pm.size;
    const updates=valid.map(p=>p.provider_last_update||p.updated_at).filter(Boolean).sort();if(updates.length)merged.provider_last_update=updates[updates.length-1];return merged;
  }

  async function loadBoard(){
    const parts=[];
    for(const group of batch(MARKETS,BATCH_SIZE)){
      try{parts.push(await fetchJson(`${API}/api/odds/board?event_id=${encodeURIComponent(currentEvent())}&markets=${encodeURIComponent(group.join(','))}`));}
      catch(_){
        const settled=await Promise.allSettled(group.map(m=>fetchJson(`${API}/api/odds/board?event_id=${encodeURIComponent(currentEvent())}&markets=${encodeURIComponent(m)}`)));
        settled.forEach(r=>{if(r.status==='fulfilled')parts.push(r.value)});
      }
    }
    return mergeBoards(parts);
  }

  function buildRows(board){
    const map=new Map();
    const ensure=(player,market)=>{const key=`${player.toLowerCase()}|${market}`;if(!map.has(key))map.set(key,{key,player,market,summary:null,quotes:[]});return map.get(key)};
    (board.market_summary||[]).forEach(s=>{const p=playerOf(s);if(p&&s.market)ensure(p,s.market).summary=s;});
    (board.quotes||[]).forEach(q=>{const p=playerOf(q);if(p&&q.market)ensure(p,q.market).quotes.push(q);});
    return [...map.values()].map(row=>{
      const points=row.quotes.map(pointOf).filter(Number.isFinite),lo=points.length?Math.min(...points):NaN,hi=points.length?Math.max(...points):NaN;
      let consensus=num(row.summary?.consensus_line??row.summary?.line);if(!Number.isFinite(consensus))consensus=median(points);
      const books=[...new Set(row.quotes.map(bookOf).filter(Boolean))];
      return {...row,consensus,lo,hi,spread:Number.isFinite(lo)&&Number.isFinite(hi)?hi-lo:NaN,books,bestOver:bestQuote(row.quotes,'OVER'),bestUnder:bestQuote(row.quotes,'UNDER')};
    });
  }

  function loadLocal(){
    try{state.watch=new Set(JSON.parse(localStorage.getItem(eventKey())||'[]'));}catch(_){state.watch=new Set();}
    try{state.baseline=JSON.parse(localStorage.getItem(baselineKey())||'null');}catch(_){state.baseline=null;}
  }
  function saveWatch(){localStorage.setItem(eventKey(),JSON.stringify([...state.watch]));}
  function captureBaseline(){
    const rows={};state.rows.forEach(r=>{rows[r.key]={consensus:r.consensus,lo:r.lo,hi:r.hi,books:r.books.length};});
    state.baseline={captured_at:new Date().toISOString(),event_id:currentEvent(),rows};localStorage.setItem(baselineKey(),JSON.stringify(state.baseline));renderShell();
  }
  function clearBaseline(){state.baseline=null;localStorage.removeItem(baselineKey());renderShell();}
  function delta(row){const base=state.baseline?.rows?.[row.key];if(!base)return NaN;const now=num(row.consensus),before=num(base.consensus);return Number.isFinite(now)&&Number.isFinite(before)?now-before:NaN;}
  function visible(){
    const q=state.search.trim().toLowerCase();let rows=state.rows.filter(r=>(!q||`${r.player} ${marketLabel(r.market)}`.toLowerCase().includes(q))&&(state.market==='all'||r.market===state.market)&&(state.filter!=='watch'||state.watch.has(r.key)));
    if(state.sort==='spread')rows.sort((a,b)=>(num(b.spread)||0)-(num(a.spread)||0));
    else if(state.sort==='movement')rows.sort((a,b)=>Math.abs(num(delta(b))||0)-Math.abs(num(delta(a))||0));
    else if(state.sort==='books')rows.sort((a,b)=>b.books.length-a.books.length);
    else rows.sort((a,b)=>(num(b.spread)||0)-(num(a.spread)||0)||b.books.length-a.books.length);
    return rows;
  }
  function eventLabel(){const e=state.board?.event||{},a=e.away_team||e.away,h=e.home_team||e.home;return a&&h?`${a} @ ${h}`:'Selected NFL event';}
  function timeLabel(v){if(!v)return'unknown';const d=new Date(v);return Number.isNaN(d.getTime())?String(v):d.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}

  function rowHtml(r){const d=delta(r),disp=Number.isFinite(r.spread)?r.spread:0,max=Math.max(...state.rows.map(x=>num(x.spread)).filter(Number.isFinite),1),pct=Math.min(100,disp/max*100);const cls=!Number.isFinite(d)?'flat':d>0?'up':d<0?'down':'flat';return `<tr><td><button class="pbe22-star ${state.watch.has(r.key)?'on':''}" data-watch="${esc(r.key)}">${state.watch.has(r.key)?'★':'☆'}</button></td><td><div class="pbe22-player" data-player="${esc(r.player)}">${esc(r.player)}</div><div class="pbe22-sub">${esc(r.books.length)} books</div></td><td><div class="pbe22-market">${esc(marketLabel(r.market))}</div><div class="pbe22-sub">${esc(r.market)}</div></td><td><span class="pbe22-line">${esc(fmt(r.consensus,1))}</span></td><td><span class="pbe22-range">${esc(Number.isFinite(r.lo)&&Number.isFinite(r.hi)?`${fmt(r.lo,1)} – ${fmt(r.hi,1)}`:'—')}</span></td><td><div class="pbe22-dispersion"><b>${esc(fmt(r.spread,1))}</b><span class="pbe22-meter"><span style="width:${pct.toFixed(0)}%"></span></span></div></td><td><span class="pbe22-best">${r.bestOver?`${esc(fmt(pointOf(r.bestOver),1))} ${esc(price(priceOf(r.bestOver)))} · ${esc(bookOf(r.bestOver))}`:'—'}</span></td><td><span class="pbe22-best">${r.bestUnder?`${esc(fmt(pointOf(r.bestUnder),1))} ${esc(price(priceOf(r.bestUnder)))} · ${esc(bookOf(r.bestUnder))}`:'—'}</span></td><td><span class="pbe22-delta ${cls}">${Number.isFinite(d)?`${d>0?'+':''}${esc(fmt(d,1))}`:'—'}</span><div class="pbe22-sub">${state.baseline?'vs local baseline':'no baseline'}</div></td></tr>`;}

  function body(){const rows=visible();return rows.length?rows.map(rowHtml).join(''):`<tr><td colspan="9"><div class="pbe22-empty">No market rows match the current watch/filter settings.</div></td></tr>`;}
  function shell(){const rows=state.rows,watched=state.watch.size,withSpread=rows.filter(r=>num(r.spread)>0),maxSpread=withSpread.length?Math.max(...withSpread.map(r=>r.spread)):0;const markets=[...new Set(rows.map(r=>r.market))].sort();return `<section class="pbe22-watch"><header class="pbe22-hero"><div><div class="pbe22-kicker">NFL PRO · CURRENT MARKET MONITOR</div><h1 class="pbe22-title">Watch the market.<br><em>Know what actually changed.</em></h1><div class="pbe22-copy">Market Watch surfaces current cross-book line dispersion, best available numbers and a personal watchlist. Movement only appears after you capture a browser-local baseline; PropBetEdge does not pretend that a client-side snapshot is provider historical data.</div></div><aside class="pbe22-status"><b>${esc(eventLabel())}</b><span>${esc(state.board?.source?.semantics||'UNAVAILABLE')} market · ${esc(rows.length)} player/market rows · provider update ${esc(timeLabel(state.board?.provider_last_update||state.board?.updated_at))}</span></aside></header><div class="pbe22-contract"><strong>Movement contract:</strong> line Δ is calculated only against the explicit local baseline saved in this browser for this provider event. Cross-book spread is current provider data. Historical provider movement remains unavailable until we persist server-side market snapshots.</div>${!isPro()?`<div class="pbe22-prowall"><div><strong>NFL Pro Market Watch</strong><p>Watchlists, cross-book dispersion ranking and local baseline comparison are premium workflow tools. The current sportsbook Prop Board remains available for free.</p><button class="pbe22-btn gold" onclick="PBEPro.open('upgrade')">Unlock NFL Pro · $9.99/week</button></div></div>`:`<div class="pbe22-summary"><div class="pbe22-stat"><b>${rows.length}</b><span>Player / market rows</span></div><div class="pbe22-stat"><b class="green">${watched}</b><span>Watched rows</span></div><div class="pbe22-stat"><b>${new Set(rows.flatMap(r=>r.books)).size}</b><span>Sportsbooks</span></div><div class="pbe22-stat"><b class="green">${esc(fmt(maxSpread,1))}</b><span>Largest current line spread</span></div><div class="pbe22-stat"><b class="gold">${state.baseline?'SET':'NONE'}</b><span>Local movement baseline</span></div></div><div class="pbe22-baseline"><div><strong>${state.baseline?`Local baseline captured ${esc(timeLabel(state.baseline.captured_at))}`:'No local baseline captured'}</strong><span>${state.baseline?'Movement cells compare current consensus to that browser-local snapshot. This is not provider historical movement.':'Capture the current board to create an explicit personal reference point for future refreshes.'}</span></div><div class="pbe22-baseline-actions"><button class="pbe22-btn green" id="pbe22-capture">${state.baseline?'Reset baseline now':'Capture baseline'}</button>${state.baseline?'<button class="pbe22-btn" id="pbe22-clear">Clear baseline</button>':''}</div></div><div class="pbe22-toolbar"><input id="pbe22-search" class="pbe22-input" placeholder="Search player or prop…" value="${esc(state.search)}"><select id="pbe22-market" class="pbe22-select"><option value="all">All markets</option>${markets.map(m=>`<option value="${esc(m)}" ${state.market===m?'selected':''}>${esc(marketLabel(m))}</option>`).join('')}</select><select id="pbe22-filter" class="pbe22-select"><option value="all" ${state.filter==='all'?'selected':''}>All rows</option><option value="watch" ${state.filter==='watch'?'selected':''}>Watchlist only</option></select><select id="pbe22-sort" class="pbe22-select"><option value="dispersion" ${state.sort==='dispersion'?'selected':''}>Largest dispersion</option><option value="movement" ${state.sort==='movement'?'selected':''}>Largest local movement</option><option value="books" ${state.sort==='books'?'selected':''}>Most books</option></select></div><section class="pbe22-table-wrap"><div class="pbe22-scroll"><table class="pbe22-table"><thead><tr><th>Watch</th><th>Player</th><th>Prop</th><th>Consensus</th><th>Book Range</th><th>Dispersion</th><th>Best Over</th><th>Best Under</th><th>Local Δ</th></tr></thead><tbody id="pbe22-body">${body()}</tbody></table></div><div class="pbe22-foot">CURRENT = sportsbook provider cross-section. LOCAL Δ = explicit user-captured browser baseline. No synthetic market history, no implied steam label.</div></section>`}</section>`;}

  function wireRows(){document.querySelectorAll('[data-watch]').forEach(btn=>btn.addEventListener('click',()=>{const key=btn.dataset.watch;if(state.watch.has(key))state.watch.delete(key);else state.watch.add(key);saveWatch();renderShell();}));document.querySelectorAll('.pbe22-player[data-player]').forEach(el=>el.addEventListener('click',()=>window.PBEPlayerResearch?.show(el.dataset.player)));}
  function renderShell(){const vc=document.getElementById('view-container');if(!vc)return;vc.innerHTML=shell();wire();}
  function wire(){document.getElementById('pbe22-search')?.addEventListener('input',e=>{state.search=e.currentTarget.value||'';renderShell()});document.getElementById('pbe22-market')?.addEventListener('change',e=>{state.market=e.currentTarget.value||'all';renderShell()});document.getElementById('pbe22-filter')?.addEventListener('change',e=>{state.filter=e.currentTarget.value||'all';renderShell()});document.getElementById('pbe22-sort')?.addEventListener('change',e=>{state.sort=e.currentTarget.value||'dispersion';renderShell()});document.getElementById('pbe22-capture')?.addEventListener('click',captureBaseline);document.getElementById('pbe22-clear')?.addEventListener('click',clearBaseline);wireRows();}

  async function render(){if(state.loading)return;state.loading=true;const vc=document.getElementById('view-container');if(!vc){state.loading=false;return;}vc.innerHTML='<section class="pbe22-watch"><div class="pbe22-empty">Loading current NFL market watch surface…</div></section>';try{loadLocal();state.board=await loadBoard();state.rows=buildRows(state.board);vc.innerHTML=shell();wire();}catch(error){vc.innerHTML=`<section class="pbe22-watch"><div class="pbe22-empty">Market Watch unavailable: ${esc(error instanceof Error?error.message:String(error))}</div></section>`;}finally{state.loading=false;}}
  function install(){if(!window.App?.VIEWS)return false;App.VIEWS.marketwatch=render;const prop=document.getElementById('nav-propboard');if(prop&&!document.getElementById('nav-marketwatch')){const a=document.createElement('a');a.className='nav-item';a.id='nav-marketwatch';a.href='javascript:void(0)';a.onclick=()=>App.nav('marketwatch');a.innerHTML='<span class="ni-icon">◌</span> Market Watch <span class="nav-badge" style="color:#d8b75b;background:rgba(216,183,91,.06)">PRO</span>';prop.insertAdjacentElement('afterend',a);}return true;}
  window.PBEMarketWatch={render,state};install();document.addEventListener('DOMContentLoaded',install,{once:true});window.addEventListener('pbe:event-changed',()=>{state.board=null;state.rows=[];state.watch=new Set();state.baseline=null;if(document.querySelector('.pbe22-watch')&&!state.loading)render();});window.addEventListener('pbe:pro-state',()=>{if(document.querySelector('.pbe22-watch')&&!state.loading)renderShell();});
})();
