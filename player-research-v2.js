/* PropBetEdge NFL — Player Research v2
 * Layers are kept separate: CURRENT MARKET / MODEL / NEWS / HISTORICAL ARCHIVE.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const DEFAULT_EVENT = '8c94552d022acec4a0458d70c19d3da9';
  const MARKETS = ['player_pass_yds','player_reception_yds','player_receptions','player_rush_yds'];
  const state = { player:'', loading:false, board:null, model:null, news:[], marketRows:[], archive:[] };

  const esc = value => String(value ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const num = value => { const n=Number(value); return Number.isFinite(n)?n:NaN; };
  const fmt = (value,d=1) => { const n=num(value); return Number.isFinite(n)?n.toFixed(d).replace(/\.0$/,''):'—'; };
  const odds = value => { const n=num(value); return Number.isFinite(n)?`${n>0?'+':''}${Math.round(n)}`:'—'; };
  const currentEvent = () => new URLSearchParams(location.search).get('event') || localStorage.getItem('pbe_nfl_event') || DEFAULT_EVENT;
  const isPro = () => Boolean(window.PBEPro?.state?.pro);
  const playerOf = item => item?.player || item?.player_name || '';
  const bookOf = q => q?.book || q?.book_title || q?.sportsbook || q?.book_key || '';
  const sideOf = q => String(q?.direction || q?.outcome || q?.side || q?.name || '').toUpperCase();
  const pointOf = q => num(q?.point ?? q?.line);
  const priceOf = q => num(q?.price ?? q?.american_odds ?? q?.odds);
  const marketLabel = market => ({player_pass_yds:'Passing Yards',player_reception_yds:'Receiving Yards',player_receptions:'Receptions',player_rush_yds:'Rushing Yards'}[market] || String(market||'').replace(/^player_/,'').replace(/_/g,' '));

  async function fetchJson(url) {
    const response=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});
    if(!response.ok){const detail=await response.text().catch(()=> '');const error=new Error(`${response.status}${detail?` · ${detail.slice(0,140)}`:''}`);error.status=response.status;throw error;}
    return response.json();
  }

  function samePlayer(a,b) {
    const x=String(a||'').trim().toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ');
    const y=String(b||'').trim().toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ');
    if(!x||!y)return false;
    if(x===y)return true;
    const xa=x.split(' '),ya=y.split(' ');
    return xa.length>1&&ya.length>1&&xa[xa.length-1]===ya[ya.length-1]&&xa[0][0]===ya[0][0];
  }

  function median(values){const clean=values.map(num).filter(Number.isFinite).sort((a,b)=>a-b);if(!clean.length)return NaN;const i=Math.floor(clean.length/2);return clean.length%2?clean[i]:(clean[i-1]+clean[i])/2;}
  function bestQuote(quotes,side){const rows=quotes.filter(q=>sideOf(q).includes(side));if(!rows.length)return null;return [...rows].sort((a,b)=>{const ap=pointOf(a),bp=pointOf(b);if(Number.isFinite(ap)&&Number.isFinite(bp)&&ap!==bp)return side==='OVER'?ap-bp:bp-ap;return priceOf(b)-priceOf(a);})[0];}

  function buildMarketRows(board,player) {
    const groups=new Map();
    (board?.market_summary||[]).forEach(s=>{
      if(!samePlayer(playerOf(s),player)||!s.market)return;
      const key=s.market; if(!groups.has(key))groups.set(key,{market:key,summary:null,quotes:[]});groups.get(key).summary=s;
    });
    (board?.quotes||[]).forEach(q=>{
      if(!samePlayer(playerOf(q),player)||!q.market)return;
      const key=q.market;if(!groups.has(key))groups.set(key,{market:key,summary:null,quotes:[]});groups.get(key).quotes.push(q);
    });
    return [...groups.values()].map(g=>{
      let consensus=num(g.summary?.consensus_line ?? g.summary?.line);if(!Number.isFinite(consensus))consensus=median(g.quotes.map(pointOf));
      return {...g,consensus,bestOver:bestQuote(g.quotes,'OVER'),bestUnder:bestQuote(g.quotes,'UNDER'),books:[...new Set(g.quotes.map(bookOf).filter(Boolean))].sort()};
    });
  }

  function findModel(model,player) {
    const rows=model?.models||model?.picks||model?.data||[];
    return (Array.isArray(rows)?rows:[]).find(m=>samePlayer(playerOf(m),player))||null;
  }

  function newsFor(news,player) {
    const target=String(player||'').toLowerCase();
    return (news||[]).filter(a=>(a.players||[]).some(p=>samePlayer(p,player)) || `${a.title||''} ${a.summary||''}`.toLowerCase().includes(target)).sort((a,b)=>new Date(b.published_at||0)-new Date(a.published_at||0)).slice(0,8);
  }

  function archiveFor(player) {
    const items=[];
    const stats=window.StatsView?.STATS||{};
    Object.values(stats).forEach(cat=>{
      const headers=cat?.headers||[];
      (cat?.rows||[]).forEach(row=>{
        if(!samePlayer(row?.[1],player))return;
        const pairs=headers.map((h,i)=>i>=3&&row[i]!=null?`${h}: ${row[i]}`:null).filter(Boolean).slice(0,5);
        items.push({type:'2025 FINAL STATS',title:cat.title||'2025 leaderboard',copy:`${row[2]||''}${pairs.length?` · ${pairs.join(' · ')}`:''}`});
      });
    });
    (window.HOF_MEMBERS||[]).forEach(m=>{if(samePlayer(m.name,player))items.push({type:'HALL OF FAME',title:`Inducted ${m.inducted||'—'} · ${m.pos||''}`,copy:`${m.teams||''}${m.era?` · ${m.era}`:''}${m.note?` · ${m.note}`:''}`});});
    (window.MVP_HISTORY||[]).forEach(m=>{if(samePlayer(m.player,player))items.push({type:'MVP HISTORY',title:`${m.year} League MVP`,copy:`${m.pos||''}${m.team?` · ${m.team}`:''}`});});
    Object.entries(window.NFL_RECORDS||{}).forEach(([cat,rows])=>(rows||[]).forEach(r=>{if(samePlayer(r.holder,player)||String(r.holder||'').toLowerCase().includes(String(player||'').toLowerCase()))items.push({type:`NFL RECORD · ${cat}`,title:`${r.record} · ${r.stat}`,copy:`${r.team||''}${r.year?` · ${r.year}`:''}${r.note?` · ${r.note}`:''}`});}));
    (window.SUPER_BOWLS||[]).forEach(sb=>{const mvp=String(sb.mvp||'').split(',')[0].trim();if(samePlayer(mvp,player))items.push({type:'SUPER BOWL MVP',title:`Super Bowl ${sb.roman||''} · ${sb.year||''}`,copy:`${sb.winner||''} ${sb.score||''} vs ${sb.loser||''} · ${sb.venue||''}`});});
    (window.NFL_SEASONS||[]).forEach(s=>{
      [['Passing Leader',s.passLeader],['Rushing Leader',s.rushLeader],['Receiving Leader',s.recLeader]].forEach(([label,l])=>{if(l?.player&&samePlayer(l.player,player))items.push({type:`SEASON ARCHIVE · ${s.year}`,title:label,copy:`${l.team||''}${l.yards?` · ${Number(l.yards).toLocaleString()} YDS`:''}${l.tds?` · ${l.tds} TD`:''}`});});
    });
    const seen=new Set();return items.filter(item=>{const key=`${item.type}|${item.title}|${item.copy}`;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,16);
  }

  function eventLabel() {
    const e=state.board?.event||{};const away=e.away_team||e.away,home=e.home_team||e.home;return away&&home?`${away} @ ${home}`:'Selected NFL event';
  }

  function marketSection() {
    if(!state.marketRows.length)return `<div class="pbe17-empty"><div><strong>No current market row</strong>This player is not present in the four current selected-event markets loaded for Player Research. No market value is inferred.</div></div>`;
    return `<div class="pbe17-market-grid">${state.marketRows.map(row=>`<article class="pbe17-market-card"><div class="pbe17-market-name">${esc(marketLabel(row.market))}</div><div class="pbe17-market-meta">${row.books.length} sportsbook${row.books.length===1?'':'s'} · selected event</div><div class="pbe17-market-line"><div class="pbe17-market-stat"><b>${esc(fmt(row.consensus,1))}</b><span>Consensus</span></div><div class="pbe17-market-stat"><b class="green">${row.bestOver?esc(`${fmt(pointOf(row.bestOver),1)} ${odds(priceOf(row.bestOver))}`):'—'}</b><span>Best Over</span></div><div class="pbe17-market-stat"><b class="green">${row.bestUnder?esc(`${fmt(pointOf(row.bestUnder),1)} ${odds(priceOf(row.bestUnder))}`):'—'}</b><span>Best Under</span></div></div><div class="pbe17-book-row">${row.books.map(book=>`<span class="pbe17-book">${esc(book)}</span>`).join('')}</div></article>`).join('')}</div>`;
  }

  function modelSection() {
    if(!isPro())return `<div class="pbe17-prolock"><strong>NFL Pro model context</strong><p>Unlock PBE fair line, model probability, fair-line gap and input audit for supported passing-yard props. Current sportsbook lines above remain visible.</p><button class="pbe17-btn gold" onclick="PBEPro.open('upgrade')">Unlock NFL Pro · $9.99/week</button></div>`;
    const m=findModel(state.model,state.player);
    if(!m)return `<div class="pbe17-empty"><div><strong>Production model unavailable</strong>The current PBE production model does not support this player/prop in the selected event or lacks required inputs. No synthetic model value is inserted.</div></div>`;
    const fair=num(m.fair_line),prob=num(m.model_over_at_consensus_pct),gap=num(m.fair_line_gap_yards),sd=num(m.predictive_sd),missing=Array.isArray(m.missing_inputs)?m.missing_inputs:[];
    return `<div class="pbe17-model"><div class="pbe17-model-grid"><div class="pbe17-model-stat"><b>${esc(fmt(m.market_consensus_line,1))}</b><span>Market consensus</span></div><div class="pbe17-model-stat"><b>${esc(fmt(fair,1))}</b><span>PBE fair line</span></div><div class="pbe17-model-stat"><b class="green">${esc(fmt(prob,1))}%</b><span>Model over</span></div><div class="pbe17-model-stat"><b class="${gap>=0?'green':''}">${Number.isFinite(gap)&&gap>0?'+':''}${esc(fmt(gap,1))}</b><span>Fair-line gap</span></div></div><div class="pbe17-model-note">Predictive SD ${esc(fmt(sd,1))} · projected attempts ${esc(fmt(m.projected_attempts,1))} · effective/raw games ${esc(m.effective_games??m.raw_games??'—')} · status ${esc(String(m.decision_status||m.confidence||'MODEL').replace(/_/g,' '))}. Model context is analysis, not a guaranteed outcome.</div><div class="pbe17-chiprow">${missing.length?missing.map(x=>`<span class="pbe17-chip missing">Missing: ${esc(String(x).replace(/_/g,' '))}</span>`).join(''):'<span class="pbe17-chip">No missing inputs reported</span>'}</div></div>`;
  }

  function newsSection() {
    if(!state.news.length)return `<div class="pbe17-empty"><div><strong>No current player news</strong>The current newsroom feed did not return a story naming this player. No old news is substituted.</div></div>`;
    return `<div class="pbe17-news">${state.news.map(a=>`<article class="pbe17-news-row"><a href="${esc(a.url||'#')}">${esc(a.title)}</a><div class="pbe17-news-meta">${esc(a.source||'source unavailable')} · ${esc(a.topic_kind||'news')} · impact ${esc(a.impact_score??'—')}</div>${a.summary?`<div class="pbe17-news-summary">${esc(a.summary)}</div>`:''}</article>`).join('')}</div>`;
  }

  function archiveSection() {
    if(!state.archive.length)return `<div class="pbe17-empty"><div><strong>No retained archive match</strong>No 2025 leaderboard, Hall of Fame, MVP, records, Super Bowl MVP or season-leader entry matched this player.</div></div>`;
    return `<div class="pbe17-archive">${state.archive.map(item=>`<article class="pbe17-archive-group"><div class="pbe17-archive-label">${esc(item.type)}</div><div class="pbe17-archive-title">${esc(item.title)}</div><div class="pbe17-archive-copy">${esc(item.copy)}</div></article>`).join('')}</div>`;
  }

  function shell() {
    const market=state.marketRows.length>0,model=Boolean(findModel(state.model,state.player)),news=state.news.length>0,archive=state.archive.length>0;
    return `<aside class="pbe17-player"><header class="pbe17-head"><button class="pbe17-close" onclick="PBEPlayerResearch.close()">×</button><div class="pbe17-kicker">UNIFIED PLAYER RESEARCH</div><div class="pbe17-name">${esc(state.player)}</div><div class="pbe17-sub">${esc(eventLabel())} · each data layer below keeps its own provenance and time semantics.</div><div class="pbe17-layerbar"><span class="pbe17-layer ${market?'live':''}">MARKET ${market?'CURRENT':'UNAVAILABLE'}</span><span class="pbe17-layer ${model&&isPro()?'model':''}">MODEL ${isPro()?(model?'AVAILABLE':'UNAVAILABLE'):'PRO'}</span><span class="pbe17-layer ${news?'news':''}">NEWS ${news?'CURRENT':'NONE'}</span><span class="pbe17-layer ${archive?'archive':''}">ARCHIVE ${archive?'MATCHED':'NONE'}</span></div></header><div class="pbe17-body"><section class="pbe17-section"><div class="pbe17-section-head"><strong>Current Market</strong><span>Sportsbook provider · selected event</span></div>${marketSection()}</section><section class="pbe17-section"><div class="pbe17-section-head"><strong>PBE Model</strong><span>MODEL · NFL Pro</span></div>${modelSection()}</section><section class="pbe17-section"><div class="pbe17-section-head"><strong>Current News</strong><span>NEWS · PropBetEdge newsroom</span></div>${newsSection()}</section><section class="pbe17-section"><div class="pbe17-section-head"><strong>Historical Archive</strong><span>HISTORICAL · retained datasets</span></div>${archiveSection()}<div class="pbe17-actions"><button class="pbe17-btn" onclick="PBEPlayerResearch.close();App.nav('stats')">2025 Stats</button><button class="pbe17-btn" onclick="PBEPlayerResearch.close();App.nav('records')">Record Book</button><button class="pbe17-btn" onclick="PBEPlayerResearch.close();App.nav('hof')">Hall of Fame</button>${market?'<button class="pbe17-btn green" onclick="PBEPlayerResearch.close();App.nav(\'propboard\')">Open Prop Board</button>':''}</div></section></div></aside>`;
  }

  function backdrop() {
    let el=document.getElementById('pbe17-player-backdrop');
    if(!el){el=document.createElement('div');el.id='pbe17-player-backdrop';el.className='pbe17-player-backdrop';el.addEventListener('click',e=>{if(e.target===el)close();});document.body.appendChild(el);}
    return el;
  }

  function loading(player) {
    const el=backdrop();el.innerHTML=`<aside class="pbe17-player"><header class="pbe17-head"><button class="pbe17-close" onclick="PBEPlayerResearch.close()">×</button><div class="pbe17-kicker">UNIFIED PLAYER RESEARCH</div><div class="pbe17-name">${esc(player)}</div><div class="pbe17-sub">Loading current market, model entitlement, current news and historical matches…</div></header><div class="pbe17-body"><div class="pbe17-section"><div class="pbe17-empty"><div><strong>Building player context</strong>No synthetic profile values are used while factual layers load.</div></div></div></div></aside>`;el.classList.add('open');document.body.style.overflow='hidden';
  }

  async function show(player) {
    const name=String(player||'').trim();if(!name)return;
    state.player=name;state.loading=true;state.board=null;state.model=null;state.news=[];state.marketRows=[];state.archive=archiveFor(name);loading(name);
    const eventId=currentEvent();
    try{
      const [board,news,model]=await Promise.all([
        fetchJson(`${API}/api/odds/board?event_id=${encodeURIComponent(eventId)}&markets=${encodeURIComponent(MARKETS.join(','))}`).catch(()=>null),
        fetchJson('/api/news-feed?limit=100').catch(()=>({articles:[]})),
        isPro()?fetchJson(`${API}/api/picks/pass?event_id=${encodeURIComponent(eventId)}`).catch(()=>null):Promise.resolve(null)
      ]);
      state.board=board;state.model=model;state.marketRows=board?buildMarketRows(board,name):[];state.news=newsFor(news?.articles||[],name);
    } finally {
      state.loading=false;const el=backdrop();el.innerHTML=shell();el.classList.add('open');
    }
  }

  function close(){document.getElementById('pbe17-player-backdrop')?.classList.remove('open');document.body.style.overflow='';}

  function install(){
    const api={show,close};
    if(window.PlayerModal&&typeof window.PlayerModal==='object'){window.PlayerModal.show=show;window.PlayerModal.close=close;}
    else window.PlayerModal=api;
    return true;
  }

  window.PBEPlayerResearch={show,close,state};
  install();document.addEventListener('DOMContentLoaded',install,{once:true});document.addEventListener('keydown',e=>{if(e.key==='Escape')close();});
  window.addEventListener('pbe:pro-state',()=>{if(document.getElementById('pbe17-player-backdrop')?.classList.contains('open')&&state.player&&!state.loading)show(state.player);});
})();
