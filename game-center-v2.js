/* PropBetEdge NFL — PBEcast Game Center v2
 * No LIVE label unless the scoreboard source explicitly reports LIVE semantics.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const DEFAULT_EVENT = '8c94552d022acec4a0458d70c19d3da9';
  const state = { loading:false, board:null, scores:null, news:[], eventId:'', teams:[] };

  const esc = value => String(value ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const num = value => { const n=Number(value); return Number.isFinite(n)?n:NaN; };
  const currentEvent = () => new URLSearchParams(location.search).get('event') || localStorage.getItem('pbe_nfl_event') || DEFAULT_EVENT;

  async function fetchJson(url) {
    const response=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function eventOf(board) { return board?.event || {}; }
  function awayOf(event){ return event.away_team || event.away || event.awayTeam || 'Away'; }
  function homeOf(event){ return event.home_team || event.home || event.homeTeam || 'Home'; }
  function kickoffOf(event){ return event.commence_time || event.start_time || event.game_time || event.kickoff || null; }

  function teamAbbr(name) {
    const text=String(name||'').toLowerCase();
    const hit=Object.values(window.NFL_TEAMS||{}).find(team =>
      text===String(team.name||'').toLowerCase() ||
      text===String(team.abbr||'').toLowerCase() ||
      (team.city && text.includes(String(team.city).toLowerCase())) ||
      (team.name && text.includes(String(team.name).toLowerCase().split(' ').pop()))
    );
    return hit?.abbr || '';
  }

  function crest(abbr,size=58){
    try{if(abbr&&typeof teamCrest==='function')return teamCrest(abbr,size)}catch(_){}
    return `<strong style="color:#fff;font:900 17px 'Barlow Condensed',sans-serif">${esc(abbr||'NFL')}</strong>`;
  }

  function rowsOf(payload) {
    if(Array.isArray(payload)) return payload;
    for(const key of ['games','scores','data','events','results','schedule']) if(Array.isArray(payload?.[key])) return payload[key];
    return [];
  }

  function nameMatches(value,target) {
    const a=String(value||'').toLowerCase(), b=String(target||'').toLowerCase();
    if(!a||!b)return false;
    return a===b || a.includes(b) || b.includes(a);
  }

  function scoreGame() {
    const event=eventOf(state.board);
    const away=awayOf(event), home=homeOf(event);
    return rowsOf(state.scores).find(game => {
      const ga=game.away_team||game.away||game.awayTeam||game.visitor||game.away_name;
      const gh=game.home_team||game.home||game.homeTeam||game.host||game.home_name;
      return (nameMatches(ga,away)&&nameMatches(gh,home)) || (nameMatches(ga,home)&&nameMatches(gh,away));
    }) || null;
  }

  function semanticsOf(scorePayload,game) {
    return String(game?.source?.semantics || game?.semantics || scorePayload?.source?.semantics || scorePayload?.semantics || '').toUpperCase();
  }

  function statusOf(game) {
    return String(game?.status || game?.game_status || game?.state || game?.status_type || '').toUpperCase();
  }

  function scoreValue(game,side) {
    const keys=side==='away'
      ? ['away_score','awayScore','visitor_score','visitorScore','away_points']
      : ['home_score','homeScore','host_score','hostScore','home_points'];
    for(const key of keys){const n=num(game?.[key]);if(Number.isFinite(n))return n;}
    const nested=side==='away'?game?.away:game?.home;
    if(nested&&typeof nested==='object'){
      for(const key of ['score','points','total']){const n=num(nested[key]);if(Number.isFinite(n))return n;}
    }
    return NaN;
  }

  function stateContract() {
    const game=scoreGame();
    const semantics=semanticsOf(state.scores,game);
    const status=statusOf(game);
    const awayScore=scoreValue(game,'away'), homeScore=scoreValue(game,'home');
    const explicitLive = semantics==='LIVE' && (/LIVE|IN_PROGRESS|IN PROGRESS|HALFTIME|Q[1-4]/.test(status) || (Number.isFinite(awayScore)&&Number.isFinite(homeScore)));
    const explicitFinal = /FINAL|COMPLETE|COMPLETED|CLOSED/.test(status) || semantics==='FINAL';
    if(explicitLive) return {kind:'LIVE',label:status||'LIVE',game,awayScore,homeScore};
    if(explicitFinal) return {kind:'FINAL',label:status||'FINAL',game,awayScore,homeScore};
    const kickoff=kickoffOf(eventOf(state.board));
    const future=kickoff && !Number.isNaN(new Date(kickoff).getTime()) && new Date(kickoff).getTime()>Date.now();
    if(future) return {kind:'SCHEDULE',label:'SCHEDULED',game,awayScore,homeScore};
    return {kind:'UNAVAILABLE',label:'SCORE FEED UNAVAILABLE',game,awayScore,homeScore};
  }

  function dateTime(value){
    if(!value)return'Time unavailable';
    const d=new Date(value);if(Number.isNaN(d.getTime()))return String(value);
    return d.toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  }

  function countdown(value){
    if(!value)return'';
    const d=new Date(value);if(Number.isNaN(d.getTime()))return'';
    const ms=d.getTime()-Date.now();if(ms<=0)return'';
    const hours=Math.floor(ms/3600000), days=Math.floor(hours/24);
    if(days>0)return`${days}d ${hours%24}h until kickoff`;
    return`${hours}h ${Math.floor((ms%3600000)/60000)}m until kickoff`;
  }

  function relevantNews() {
    const abbrs=new Set(state.teams.map(t=>t.abbr).filter(Boolean));
    const names=state.teams.map(t=>String(t.name||'').toLowerCase());
    return state.news.filter(a => {
      if((a.teams||[]).some(t=>abbrs.has(String(t).toUpperCase())))return true;
      const text=`${a.title||''} ${a.summary||''}`.toLowerCase();
      return names.some(n=>n&&text.includes(n));
    }).slice(0,6);
  }

  function marketStats() {
    const board=state.board||{};
    const quotes=Array.isArray(board.quotes)?board.quotes:[];
    const books=new Set(quotes.map(q=>q.book||q.book_title||q.book_key||q.sportsbook).filter(Boolean));
    return {quotes:board.quote_count??quotes.length,players:board.player_market_count??(board.market_summary||[]).length,books:books.size,semantics:board?.source?.semantics||'UNAVAILABLE'};
  }

  function render() {
    const vc=document.getElementById('view-container');if(!vc)return;
    if(state.loading){vc.innerHTML='<section class="pbe14-game"><div class="pbe14-empty">Opening selected NFL Game Center…</div></section>';return;}
    const event=eventOf(state.board), away=awayOf(event), home=homeOf(event), kickoff=kickoffOf(event);
    const aAbbr=teamAbbr(away), hAbbr=teamAbbr(home);
    state.teams=[{abbr:aAbbr,name:away},{abbr:hAbbr,name:home}];
    const contract=stateContract();
    const market=marketStats();
    const news=relevantNews();
    const scoreReady=Number.isFinite(contract.awayScore)&&Number.isFinite(contract.homeScore) && (contract.kind==='LIVE'||contract.kind==='FINAL');
    const scoreHtml=scoreReady?`${contract.awayScore}<span style="color:#526070;margin:0 8px">–</span>${contract.homeScore}`:contract.kind==='SCHEDULE'?'UPCOMING':'—';
    const liveClass=contract.kind==='LIVE'?'live':contract.kind==='SCHEDULE'?'schedule':'';
    vc.innerHTML=`<section class="pbe14-game"><header class="pbe14-scoreboard"><div class="pbe14-topline"><span class="pbe14-brand">PBEcast · NFL GAME CENTER</span><span class="pbe14-state ${liveClass}">${esc(contract.label)}</span></div><div class="pbe14-matchup"><div class="pbe14-team"><div class="pbe14-crest">${crest(aAbbr,58)}</div><div class="pbe14-team-city">Away</div><div class="pbe14-team-name">${esc(away)}</div></div><div class="pbe14-score"><div class="pbe14-score-main ${scoreReady?'':'pending'}">${scoreHtml}</div><div class="pbe14-score-meta">${esc(contract.kind)} · selected sportsbook event</div></div><div class="pbe14-team"><div class="pbe14-crest">${crest(hAbbr,58)}</div><div class="pbe14-team-city">Home</div><div class="pbe14-team-name">${esc(home)}</div></div></div><div class="pbe14-kickoff"><strong>${esc(dateTime(kickoff))}</strong>${countdown(kickoff)?` · ${esc(countdown(kickoff))}`:''}<br>${contract.kind==='LIVE'?'Score display is allowed because the score feed explicitly reports LIVE semantics.':contract.kind==='FINAL'?'Final score comes from the factual score feed.':'No live play-by-play is being simulated before a verified live feed is attached.'}</div></header><div class="pbe14-grid"><section class="pbe14-panel"><div class="pbe14-panel-head"><strong>Market State</strong><span>${esc(market.semantics)}</span></div><div class="pbe14-market-body"><div class="pbe14-market-stat"><b class="green">${esc(market.quotes)}</b><span>Current sportsbook quotes</span></div><div class="pbe14-market-stat"><b>${esc(market.players)}</b><span>Player / market rows</span></div><div class="pbe14-market-stat"><b>${esc(market.books)}</b><span>Sportsbooks</span></div><div class="pbe14-market-actions"><button class="pbe14-btn primary" onclick="App.nav('propboard')">Open Prop Board</button><button class="pbe14-btn" onclick="App.nav('picks')">Model Lab</button></div></div></section><section class="pbe14-panel"><div class="pbe14-panel-head"><strong>Game News</strong><span>NEWS · current teams</span></div><div class="pbe14-feed">${news.length?news.map(a=>`<div class="pbe14-feed-row"><a href="${esc(a.url||'#')}">${esc(a.title)}</a><div class="pbe14-feed-meta">${esc(a.source||'source unavailable')} · ${esc(a.topic_kind||'news')} · impact ${esc(a.impact_score??'—')}</div></div>`).join(''):'<div class="pbe14-empty">No current newsroom stories matched the selected teams.</div>'}</div></section></div><section class="pbe14-live-box"><div class="pbe14-live-title">Live intelligence contract</div><div class="pbe14-live-copy">PBEcast is preserved as the game-intelligence concept, but the old simulated-live presentation is retired. The selected event can show schedule, verified score state, current market depth and current news today. Play visualization, probability deltas and play-by-play remain disabled until a verified live event feed is attached.</div><div class="pbe14-live-roadmap"><div class="pbe14-live-step ready"><b>Schedule / event</b><span>Selected sportsbook event and kickoff are factual.</span></div><div class="pbe14-live-step ready"><b>Market layer</b><span>Current sportsbook quotes route to the Prop Board.</span></div><div class="pbe14-live-step ready"><b>News context</b><span>Current team news comes from PropBetEdge newsroom.</span></div><div class="pbe14-live-step off"><b>Play-by-play</b><span>Disabled until verified transport is production-ready.</span></div></div></section></section>`;
  }

  async function load() {
    if(state.loading)return;
    state.loading=true;state.eventId=currentEvent();render();
    try{
      const [board,scores,news]=await Promise.all([
        fetchJson(`${API}/api/odds/board?event_id=${encodeURIComponent(state.eventId)}&markets=player_pass_yds`),
        fetchJson(`${API}/api/scores`).catch(()=>null),
        fetchJson('/api/news-feed?limit=80').catch(()=>null)
      ]);
      state.board=board;state.scores=scores;state.news=Array.isArray(news?.articles)?news.articles:[];
    }catch(error){
      state.board=null;state.scores=null;state.news=[];
    }finally{state.loading=false;render();}
  }

  function install(){if(!window.App?.VIEWS)return false;App.VIEWS.pbecast=load;const nav=document.getElementById('nav-pbecast');if(nav)nav.innerHTML='<span class="ni-icon">◉</span> Game Center <span class="nav-badge" style="color:#7da7ff;background:rgba(125,167,255,.07)">EVENT</span>';return true;}
  window.PBEGameCenterV2={render:load,state};install();document.addEventListener('DOMContentLoaded',install,{once:true});
})();
