/* PropBetEdge NFL — Games & Schedule v3
 * Factual schedule first. LIVE/FINAL only when explicitly supported by score semantics.
 * The page is a game-context command surface for the rest of the NFL Intelligence OS.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const state = { loading:false, games:[], scores:null, query:'', week:'next', team:'all' };

  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const num=v=>{const n=Number(v);return Number.isFinite(n)?n:NaN};
  async function fetchJson(url){const r=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();}
  function arrayOf(payload){if(Array.isArray(payload))return payload;for(const key of ['games','schedule','data','events','results'])if(Array.isArray(payload?.[key]))return payload[key];return[];}

  function normalize(raw,index){
    const away=raw?.away_team||raw?.away||raw?.awayTeam||raw?.visitor||raw?.visitor_team||raw?.away_name;
    const home=raw?.home_team||raw?.home||raw?.homeTeam||raw?.host||raw?.home_team_name||raw?.home_name;
    const start=raw?.kickoff||raw?.start_time||raw?.game_time||raw?.commence_time||raw?.date||raw?.gameday||raw?.datetime;
    if(!away||!home||!start)return null;
    const week=num(raw?.week??raw?.week_number??raw?.game_week);
    const seasonType=String(raw?.season_type||raw?.seasonType||raw?.game_type||raw?.type||'REG').toUpperCase();
    return {
      id:String(raw?.game_id||raw?.id||raw?.gameId||raw?.key||`schedule-${index}`),
      away:String(away),home:String(home),start,
      week:Number.isFinite(week)?week:null,
      season:Number(raw?.season||raw?.year||2026)||2026,
      seasonType,
      venue:raw?.stadium||raw?.venue||raw?.site||null,
      broadcast:raw?.network||raw?.tv||raw?.broadcast||null,
      raw
    };
  }

  function team(name){
    const text=String(name||'').toLowerCase();
    return Object.values(window.NFL_TEAMS||{}).find(t=>
      text===String(t.name||'').toLowerCase()||
      text===String(t.abbr||'').toLowerCase()||
      text.includes(String(t.city||'').toLowerCase())||
      text.includes(String(t.name||'').toLowerCase().split(' ').pop())
    )||null;
  }
  function crest(t,size=42){try{if(t?.abbr&&typeof teamCrest==='function')return teamCrest(t.abbr,size)}catch(_){}return `<strong style="color:#fff;font:900 13px 'Barlow Condensed',sans-serif">${esc(t?.abbr||'NFL')}</strong>`;}
  function date(value){const d=new Date(value);return Number.isNaN(d.getTime())?null:d;}
  function dateLabel(value){const d=date(value);return d?d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}):'Date unavailable';}
  function shortDate(value){const d=date(value);return d?d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}):'Date unavailable';}
  function timeLabel(value){const d=date(value);return d?d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):'Time unavailable';}
  function sameTeam(a,b){const ta=team(a),tb=team(b);if(ta&&tb)return ta.abbr===tb.abbr;const x=String(a||'').toLowerCase(),y=String(b||'').toLowerCase();return x===y||x.includes(y)||y.includes(x);}
  function gameId(raw){return String(raw?.game_id||raw?.id||raw?.gameId||raw?.key||'');}
  function eventStart(raw){return raw?.kickoff||raw?.start_time||raw?.game_time||raw?.commence_time||raw?.date||raw?.gameday||raw?.datetime||null;}

  function scoreRows(){return arrayOf(state.scores);}
  function scoreMatch(game){
    return scoreRows().find(s=>{
      const sid=gameId(s);
      if(sid&&sid===game.id)return true;
      const away=s.away_team||s.away||s.awayTeam||s.visitor||s.away_name;
      const home=s.home_team||s.home||s.homeTeam||s.host||s.home_name;
      if(!sameTeam(away,game.away)||!sameTeam(home,game.home))return false;
      const gd=date(game.start),sd=date(eventStart(s));
      return !gd||!sd||Math.abs(gd.getTime()-sd.getTime())<36*3600000;
    })||null;
  }
  function scoreSemantics(score){return String(score?.source?.semantics||score?.semantics||state.scores?.source?.semantics||state.scores?.semantics||'').toUpperCase();}
  function scoreStatus(score){return String(score?.status||score?.game_status||score?.state||score?.status_type||'').toUpperCase();}
  function scoreValue(score,side){
    const keys=side==='away'?['away_score','awayScore','visitor_score','visitorScore','away_points']:['home_score','homeScore','host_score','hostScore','home_points'];
    for(const key of keys){const n=num(score?.[key]);if(Number.isFinite(n))return n;}
    const nested=side==='away'?score?.away:score?.home;
    if(nested&&typeof nested==='object')for(const key of ['score','points','total']){const n=num(nested[key]);if(Number.isFinite(n))return n;}
    return NaN;
  }
  function gameState(game){
    const score=scoreMatch(game),sem=scoreSemantics(score),status=scoreStatus(score),a=scoreValue(score,'away'),h=scoreValue(score,'home');
    if(sem==='LIVE'&&(/LIVE|IN_PROGRESS|HALFTIME|Q[1-4]/.test(status)||Number.isFinite(a)||Number.isFinite(h)))return{kind:'LIVE',label:status||'LIVE',a,h};
    if(/FINAL|COMPLETE|COMPLETED|CLOSED/.test(status)||sem==='FINAL')return{kind:'FINAL',label:'FINAL',a,h};
    const d=date(game.start);
    if(d&&d.getTime()>Date.now())return{kind:'SCHEDULE',label:'SCHEDULED',a:NaN,h:NaN};
    return{kind:'SCHEDULE',label:'SCHEDULE',a,h};
  }

  function providerEvents(){return Array.isArray(window.PBEEventSelector?.state?.events)?PBEEventSelector.state.events:[];}
  function providerMatch(game){
    const gd=date(game.start);
    return providerEvents().find(e=>{
      const ed=date(e.start),timeOk=!gd||!ed||Math.abs(gd.getTime()-ed.getTime())<36*3600000;
      return timeOk&&sameTeam(e.away,game.away)&&sameTeam(e.home,game.home);
    })||null;
  }
  function selectedProviderId(){return window.PBEEventSelector?.state?.selectedId||localStorage.getItem('pbe_nfl_event')||'';}

  function weeks(){return [...new Set(state.games.map(g=>g.week).filter(Number.isFinite))].sort((a,b)=>a-b);}
  function upcoming(){const now=Date.now();return state.games.filter(g=>{const d=date(g.start);return d&&d.getTime()>=now;}).sort((a,b)=>date(a.start)-date(b.start));}
  function nextWeek(){return upcoming().find(g=>Number.isFinite(g.week))?.week??weeks()[0]??null;}
  function filtered(){
    const q=state.query.trim().toLowerCase(),nw=nextWeek();
    return state.games.filter(g=>{
      const qOk=!q||`${g.away} ${g.home} ${g.venue||''} ${g.broadcast||''}`.toLowerCase().includes(q);
      const wOk=state.week==='all'||(state.week==='next'&&g.week===nw)||String(g.week)===state.week;
      const tOk=state.team==='all'||sameTeam(g.away,state.team)||sameTeam(g.home,state.team);
      return qOk&&wOk&&tOk;
    }).sort((a,b)=>date(a.start)-date(b.start));
  }
  function teams(){
    const map=new Map();
    state.games.forEach(g=>[g.away,g.home].forEach(name=>{const t=team(name),key=t?.abbr||name;if(!map.has(key))map.set(key,t?.name||String(name));}));
    return [...map.entries()].sort((a,b)=>a[1].localeCompare(b[1]));
  }
  function marketLinkedCount(){return state.games.filter(providerMatch).length;}

  function summary(){
    const live=state.games.filter(g=>gameState(g).kind==='LIVE').length;
    return `<div class="pbe25-summary">
      <div class="pbe25-stat"><b>${state.games.length}</b><span>2026 regular-season games</span></div>
      <div class="pbe25-stat"><b class="blue">${weeks().length}</b><span>Weeks on the board</span></div>
      <div class="pbe25-stat"><b class="green">${marketLinkedCount()}</b><span>Games linked to prop markets</span></div>
      <div class="pbe25-stat"><b class="${live?'gold':''}">${live||upcoming().length}</b><span>${live?'Live games right now':'Upcoming games remaining'}</span></div>
    </div>`;
  }

  function providerAction(provider,label,go,klass=''){
    return `<button class="pbe25-btn ${klass}" data-provider="${esc(provider.id)}" data-go="${esc(go)}">${esc(label)}</button>`;
  }
  function teamAction(t,label){
    const abbr=t?.abbr||'';
    return abbr?`<button class="pbe25-btn blue" data-team="${esc(abbr)}">${esc(label)}</button>`:'';
  }

  function featured(){
    const g=upcoming()[0];
    if(!g)return'';
    const at=team(g.away),ht=team(g.home),provider=providerMatch(g),selected=provider?.id&&provider.id===selectedProviderId();
    return `<aside class="pbe25-feature">
      <div>
        <div class="pbe25-feature-head">
          <div><div class="pbe25-feature-label">Next kickoff · Week ${esc(g.week??'—')}</div><div class="pbe25-feature-date">${esc(shortDate(g.start))} · ${esc(timeLabel(g.start))}</div></div>
          <span class="pbe25-feature-status">${provider?(selected?'Active market context':'Prop market linked'):'Schedule only'}</span>
        </div>
        <div class="pbe25-feature-match">
          <div class="pbe25-feature-team"><div class="pbe25-feature-crest">${crest(at,52)}</div><strong>${esc(at?.abbr||g.away)}</strong><span>${esc(at?.name||g.away)}</span></div>
          <div class="pbe25-feature-at">@</div>
          <div class="pbe25-feature-team"><div class="pbe25-feature-crest">${crest(ht,52)}</div><strong>${esc(ht?.abbr||g.home)}</strong><span>${esc(ht?.name||g.home)}</span></div>
        </div>
        <div class="pbe25-feature-meta"><span>${esc(g.venue||'Venue TBA')}</span>${g.broadcast?`<span>${esc(g.broadcast)}</span>`:''}</div>
      </div>
      <div class="pbe25-feature-actions">
        ${provider?`${providerAction(provider,selected?'Open Active Props':'Open Props','propboard','primary')}${providerAction(provider,'Game Center','pbecast','blue')}`:`${teamAction(at,'Away Research')}${teamAction(ht,'Home Research')}`}
      </div>
    </aside>`;
  }

  function gameCard(g){
    const at=team(g.away),ht=team(g.home),gs=gameState(g),provider=providerMatch(g),selected=provider?.id&&provider.id===selectedProviderId();
    const scoreReady=Number.isFinite(gs.a)&&Number.isFinite(gs.h)&&(gs.kind==='LIVE'||gs.kind==='FINAL');
    const stateClass=gs.kind==='LIVE'?'is-live':'';
    return `<article class="pbe25-card ${selected?'active-event':''} ${stateClass}">
      <div class="pbe25-time">
        <span class="pbe25-state-pill ${gs.kind==='LIVE'?'live':gs.kind==='FINAL'?'final':''}">${esc(gs.label)}</span>
        <strong>${esc(timeLabel(g.start))}</strong>
        <small>WK ${esc(g.week??'—')}${g.broadcast?` · ${esc(g.broadcast)}`:''}</small>
      </div>
      <div class="pbe25-match">
        <button class="pbe25-team-btn" type="button" ${at?.abbr?`data-team="${esc(at.abbr)}"`:''}>
          <span class="pbe25-crest">${crest(at,42)}</span>
          <span class="pbe25-team-copy"><span class="pbe25-team-name">${esc(at?.name||g.away)}</span><span class="pbe25-team-record">Away</span></span>
        </button>
        <div class="pbe25-vs">
          ${scoreReady?`<span class="pbe25-score">${gs.a} – ${gs.h}</span>`:'<span class="pbe25-vs-label">at</span>'}
          <span class="pbe25-market-state ${provider?'linked':''}">${provider?(selected?'Active context':'Props linked'):'Schedule only'}</span>
        </div>
        <button class="pbe25-team-btn home" type="button" ${ht?.abbr?`data-team="${esc(ht.abbr)}"`:''}>
          <span class="pbe25-team-copy"><span class="pbe25-team-name">${esc(ht?.name||g.home)}</span><span class="pbe25-team-record">Home${g.venue?` · ${esc(g.venue)}`:''}</span></span>
          <span class="pbe25-crest">${crest(ht,42)}</span>
        </button>
      </div>
      <div class="pbe25-actions">
        ${provider?`${providerAction(provider,selected?'Active · Props':'Open Props','propboard','primary')}${providerAction(provider,'Game Center','pbecast','blue')}`:`${teamAction(at,'Away Research')}${teamAction(ht,'Home Research')}`}
      </div>
    </article>`;
  }

  function list(){
    const rows=filtered();
    if(!rows.length)return'<div class="pbe25-empty">No games match those filters. Try All Weeks or clear the team/search filter.</div>';
    const groups=new Map();
    rows.forEach(g=>{const key=dateLabel(g.start);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(g);});
    return `<div class="pbe25-list">${[...groups.entries()].map(([day,games])=>`<section class="pbe25-day"><div class="pbe25-date"><strong>${esc(day)}</strong><span>${games.length} matchup${games.length===1?'':'s'}</span></div>${games.map(gameCard).join('')}</section>`).join('')}</div>`;
  }

  function shell(){
    const sem=String(state.games[0]?.raw?.source?.semantics||'SCHEDULE').toUpperCase();
    const nw=nextWeek();
    return `<section class="pbe25-games">
      <header class="pbe25-hero">
        <div class="pbe25-hero-copy">
          <div class="pbe25-kicker">2026 NFL · GAME COMMAND</div>
          <h1 class="pbe25-title">Pick the game.<br><em>Open the intelligence.</em></h1>
          <div class="pbe25-copy">Start with the factual schedule, then carry one matchup through Props, Matchup Research, Model Lab, Game Center, Player Research and PropChain. Market buttons appear only when the sportsbook provider exposes a matching NFL event.</div>
          <div class="pbe25-trust-row"><span class="pbe25-trust"><i></i>${esc(sem||'SCHEDULE')} schedule</span><span class="pbe25-trust"><i></i>Score-state guarded</span><span class="pbe25-trust"><i></i>Provider-linked props</span></div>
        </div>
        ${featured()}
      </header>
      ${summary()}
      <section class="pbe25-controls">
        <div class="pbe25-control-top">
          <input id="pbe25-search" class="pbe25-input" type="search" placeholder="Search team, venue or network…" value="${esc(state.query)}">
          <select id="pbe25-team" class="pbe25-select"><option value="all">All teams</option>${teams().map(([value,label])=>`<option value="${esc(value)}" ${state.team===value?'selected':''}>${esc(label)}</option>`).join('')}</select>
        </div>
        <div class="pbe25-weeks">
          <button class="pbe25-week next ${state.week==='next'?'active':''}" data-week="next">NEXT${nw?` · WK ${nw}`:''}</button>
          <button class="pbe25-week ${state.week==='all'?'active':''}" data-week="all">ALL WEEKS</button>
          ${weeks().map(w=>`<button class="pbe25-week ${state.week===String(w)?'active':''}" data-week="${w}">WK ${w}</button>`).join('')}
        </div>
      </section>
      <div id="pbe25-list">${list()}</div>
    </section>`;
  }

  function navigateWithProvider(id,route){
    window.PBEEventSelector?.choose(id);
    if(route)setTimeout(()=>window.App?.nav(route),40);
  }
  function wire(){
    document.getElementById('pbe25-search')?.addEventListener('input',e=>{state.query=e.currentTarget.value||'';refreshList();});
    document.getElementById('pbe25-team')?.addEventListener('change',e=>{state.team=e.currentTarget.value||'all';refreshList();});
    document.querySelectorAll('.pbe25-week[data-week]').forEach(btn=>btn.addEventListener('click',()=>{state.week=btn.dataset.week||'next';renderShell();}));
    wireCards();
  }
  function wireCards(){
    document.querySelectorAll('[data-provider]').forEach(btn=>btn.addEventListener('click',()=>navigateWithProvider(btn.dataset.provider,btn.dataset.go||'')));
    document.querySelectorAll('[data-team]').forEach(btn=>btn.addEventListener('click',()=>{const abbr=btn.dataset.team;if(abbr)window.PBETeamsV2?.openTeam(abbr);}));
  }
  function refreshList(){const host=document.getElementById('pbe25-list');if(host)host.innerHTML=list();wireCards();}
  function renderShell(){const vc=document.getElementById('view-container');if(vc){vc.innerHTML=shell();wire();}}

  async function loadSchedule(){
    let last='schedule_unavailable';
    for(const path of ['/api/schedule?season=2026&season_type=REG','/api/schedule?season=2026','/api/schedule']){
      try{
        const payload=await fetchJson(`${API}${path}`),rows=arrayOf(payload).map(normalize).filter(Boolean).filter(g=>g.season===2026&&(!g.seasonType||g.seasonType==='REG'||g.seasonType==='REGULAR'));
        if(rows.length)return rows;
        last='empty_schedule';
      }catch(error){last=error instanceof Error?error.message:String(error);}
    }
    throw new Error(last);
  }
  async function render(){
    if(state.loading)return;
    state.loading=true;
    const vc=document.getElementById('view-container');
    if(!vc){state.loading=false;return;}
    vc.innerHTML='<section class="pbe25-games"><div class="pbe25-empty">Loading the 2026 NFL game board…</div></section>';
    try{
      const [games,scores]=await Promise.all([loadSchedule(),fetchJson(`${API}/api/scores`).catch(()=>null)]);
      state.games=games;
      state.scores=scores;
      renderShell();
      if(window.PBEEventSelector?.discover){
        PBEEventSelector.discover().then(()=>{if(document.querySelector('.pbe25-games')&&!state.loading)renderShell();}).catch(()=>{});
      }
    }catch(error){
      vc.innerHTML=`<section class="pbe25-games"><div class="pbe25-empty">Schedule unavailable: ${esc(error instanceof Error?error.message:String(error))}</div></section>`;
    }finally{state.loading=false;}
  }
  function install(){
    if(!window.App?.VIEWS)return false;
    App.VIEWS.games=render;
    const group=document.getElementById('intelligence-nav-group');
    if(group&&!document.getElementById('nav-games')){
      const home=document.getElementById('nav-home'),a=document.createElement('a');
      a.className='nav-item';a.id='nav-games';a.href='javascript:void(0)';a.onclick=()=>App.nav('games');
      a.innerHTML='<span class="ni-icon">▦</span> Games & Schedule <span class="nav-badge" style="color:#7da7ff;background:rgba(125,167,255,.06)">2026</span>';
      home?.insertAdjacentElement('afterend',a);
    }
    return true;
  }

  window.PBEGamesV2={render,state};
  install();
  document.addEventListener('DOMContentLoaded',install,{once:true});
  window.addEventListener('pbe:event-changed',()=>{if(document.querySelector('.pbe25-games')&&!state.loading)renderShell();});
})();
