/* PropBetEdge NFL — Games & Schedule v2
 * Schedule is factual SCHEDULE data. LIVE/FINAL status is shown only when the score feed says so.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const state = { loading:false, games:[], scores:null, query:'', week:'all', team:'all', sort:'date' };

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

  function team(name){const text=String(name||'').toLowerCase();return Object.values(window.NFL_TEAMS||{}).find(t=>text===String(t.name||'').toLowerCase()||text===String(t.abbr||'').toLowerCase()||text.includes(String(t.city||'').toLowerCase())||text.includes(String(t.name||'').toLowerCase().split(' ').pop()))||null;}
  function crest(t,size=26){try{if(t?.abbr&&typeof teamCrest==='function')return teamCrest(t.abbr,size)}catch(_){}return `<strong style="color:#fff;font:900 10px 'Barlow Condensed',sans-serif">${esc(t?.abbr||'NFL')}</strong>`;}
  function date(value){const d=new Date(value);return Number.isNaN(d.getTime())?null:d;}
  function dateLabel(value){const d=date(value);return d?d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}):'Date unavailable';}
  function timeLabel(value){const d=date(value);return d?d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):'Time unavailable';}
  function fullTime(value){const d=date(value);return d?d.toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):String(value||'Time unavailable');}
  function sameTeam(a,b){const ta=team(a),tb=team(b);if(ta&&tb)return ta.abbr===tb.abbr;const x=String(a||'').toLowerCase(),y=String(b||'').toLowerCase();return x===y||x.includes(y)||y.includes(x);}

  function scoreRows(){return arrayOf(state.scores);}
  function scoreMatch(game){return scoreRows().find(s=>{const away=s.away_team||s.away||s.awayTeam||s.visitor||s.away_name,home=s.home_team||s.home||s.homeTeam||s.host||s.home_name;return sameTeam(away,game.away)&&sameTeam(home,game.home);})||null;}
  function scoreSemantics(score){return String(score?.source?.semantics||score?.semantics||state.scores?.source?.semantics||state.scores?.semantics||'').toUpperCase();}
  function scoreStatus(score){return String(score?.status||score?.game_status||score?.state||score?.status_type||'').toUpperCase();}
  function scoreValue(score,side){const keys=side==='away'?['away_score','awayScore','visitor_score','visitorScore','away_points']:['home_score','homeScore','host_score','hostScore','home_points'];for(const key of keys){const n=num(score?.[key]);if(Number.isFinite(n))return n;}const nested=side==='away'?score?.away:score?.home;if(nested&&typeof nested==='object'){for(const key of ['score','points','total']){const n=num(nested[key]);if(Number.isFinite(n))return n;}}return NaN;}
  function gameState(game){const score=scoreMatch(game),sem=scoreSemantics(score),status=scoreStatus(score),a=scoreValue(score,'away'),h=scoreValue(score,'home');if(sem==='LIVE'&&(/LIVE|IN_PROGRESS|HALFTIME|Q[1-4]/.test(status)||Number.isFinite(a)||Number.isFinite(h)))return{kind:'LIVE',label:status||'LIVE',a,h};if(/FINAL|COMPLETE|COMPLETED|CLOSED/.test(status)||sem==='FINAL')return{kind:'FINAL',label:status||'FINAL',a,h};const d=date(game.start);if(d&&d.getTime()>Date.now())return{kind:'SCHEDULE',label:'SCHEDULED',a:NaN,h:NaN};return{kind:'SCHEDULE',label:'SCHEDULE',a,h};}

  function providerEvents(){return Array.isArray(window.PBEEventSelector?.state?.events)?PBEEventSelector.state.events:[];}
  function providerMatch(game){const gd=date(game.start);return providerEvents().find(e=>{const ed=date(e.start),timeOk=!gd||!ed||Math.abs(gd.getTime()-ed.getTime())<36*3600000;return timeOk&&sameTeam(e.away,game.away)&&sameTeam(e.home,game.home);})||null;}
  function selectedProviderId(){return window.PBEEventSelector?.state?.selectedId||localStorage.getItem('pbe_nfl_event')||'';}

  function filters(){const q=state.query.trim().toLowerCase();return state.games.filter(g=>{const qOk=!q||`${g.away} ${g.home} ${g.venue||''} ${g.broadcast||''}`.toLowerCase().includes(q);const wOk=state.week==='all'||String(g.week)===state.week;const tOk=state.team==='all'||sameTeam(g.away,state.team)||sameTeam(g.home,state.team);return qOk&&wOk&&tOk;}).sort((a,b)=>date(a.start)-date(b.start));}
  function teams(){const set=new Set();state.games.forEach(g=>{const a=team(g.away),h=team(g.home);set.add(a?.abbr||g.away);set.add(h?.abbr||g.home)});return[...set].sort();}
  function weeks(){return [...new Set(state.games.map(g=>g.week).filter(Number.isFinite))].sort((a,b)=>a-b);}
  function upcoming(){const now=Date.now();return state.games.filter(g=>{const d=date(g.start);return d&&d.getTime()>=now;}).sort((a,b)=>date(a.start)-date(b.start));}

  function summary(){const up=upcoming(),live=state.games.filter(g=>gameState(g).kind==='LIVE').length,finals=state.games.filter(g=>gameState(g).kind==='FINAL').length;return `<div class="pbe25-summary"><div class="pbe25-stat"><b>${state.games.length}</b><span>2026 scheduled games loaded</span></div><div class="pbe25-stat"><b class="blue">${weeks().length}</b><span>Weeks represented</span></div><div class="pbe25-stat"><b class="green">${up.length}</b><span>Upcoming games</span></div><div class="pbe25-stat"><b>${finals}</b><span>Finals in score feed</span></div><div class="pbe25-stat"><b class="${live?'green':''}">${live}</b><span>Explicit LIVE games</span></div></div>`;}

  function nextCards(){const rows=upcoming().slice(0,6);if(!rows.length)return'';return `<section class="pbe25-next"><div class="pbe25-panel-head"><strong>Next Up</strong><span>SCHEDULE · earliest upcoming</span></div><div class="pbe25-next-grid">${rows.map(g=>`<article class="pbe25-next-card"><div class="pbe25-next-time">Week ${esc(g.week??'—')} · ${esc(fullTime(g.start))}</div><div class="pbe25-next-match">${esc(g.away)} @ ${esc(g.home)}</div><div class="pbe25-next-meta">${esc(g.venue||'Venue unavailable')}${g.broadcast?` · ${esc(g.broadcast)}`:''}</div></article>`).join('')}</div></section>`;}

  function gameCard(g){const at=team(g.away),ht=team(g.home),stateObj=gameState(g),provider=providerMatch(g),selected=provider?.id&&provider.id===selectedProviderId(),scoreReady=Number.isFinite(stateObj.a)&&Number.isFinite(stateObj.h)&&(stateObj.kind==='LIVE'||stateObj.kind==='FINAL');return `<article class="pbe25-card ${selected?'active-event':''}"><div class="pbe25-time"><div class="${stateObj.kind==='LIVE'?'live':stateObj.kind==='FINAL'?'final':''}">${esc(stateObj.label)}</div><div>${esc(timeLabel(g.start))}</div><div>WK ${esc(g.week??'—')}</div></div><div class="pbe25-match"><div class="pbe25-team"><span class="pbe25-crest">${crest(at,26)}</span><span><span class="pbe25-team-name">${esc(at?.name||g.away)}</span><span class="pbe25-team-record">AWAY</span></span></div><div class="pbe25-vs">${scoreReady?`<span class="pbe25-score">${stateObj.a} – ${stateObj.h}</span>`:'@'}</div><div class="pbe25-team home"><span><span class="pbe25-team-name">${esc(ht?.name||g.home)}</span><span class="pbe25-team-record">HOME${g.venue?` · ${esc(g.venue)}`:''}</span></span><span class="pbe25-crest">${crest(ht,26)}</span></div></div><div class="pbe25-actions">${provider?`<button class="pbe25-btn primary" data-provider="${esc(provider.id)}">${selected?'Active Event':'Use Game'}</button>`:'<button class="pbe25-btn" disabled>No Prop Event</button>'}<button class="pbe25-btn blue" data-team="${esc(at?.abbr||'')}">Away Team</button></div></article>`;}

  function list(){const rows=filters();if(!rows.length)return'<div class="pbe25-empty">No 2026 schedule games match the current filters.</div>';const groups=new Map();rows.forEach(g=>{const key=dateLabel(g.start);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(g);});return `<div class="pbe25-list">${[...groups.entries()].map(([day,games])=>`<section><div class="pbe25-date">${esc(day)}</div>${games.map(gameCard).join('')}</section>`).join('')}</div>`;}

  function shell(){const sem=String(state.games[0]?.raw?.source?.semantics||'SCHEDULE').toUpperCase();return `<section class="pbe25-games"><header class="pbe25-hero"><div><div class="pbe25-kicker">2026 NFL GAMES · FACTUAL SCHEDULE</div><h1 class="pbe25-title">Every week.<br><em>One game context.</em></h1><div class="pbe25-copy">Browse the factual 2026 NFL schedule independently of sportsbook prop availability. When the odds provider exposes a matching event, one click makes that game the shared context for Props, Matchups, Model Lab, Game Center, Player Research and PropChain.</div></div><aside class="pbe25-status"><b>${esc(sem||'SCHEDULE')}</b><span>${state.games.length} games · ${weeks().length} weeks · score labels only become LIVE/FINAL when the factual score feed explicitly supports them</span></aside></header>${summary()}<section class="pbe25-controls"><div class="pbe25-control-top"><input id="pbe25-search" class="pbe25-input" type="search" placeholder="Search team, venue or network…" value="${esc(state.query)}"><select id="pbe25-team" class="pbe25-select"><option value="all">All teams</option>${teams().map(t=>`<option value="${esc(t)}" ${state.team===t?'selected':''}>${esc(t)}</option>`).join('')}</select><select id="pbe25-sort" class="pbe25-select"><option value="date">Chronological</option></select></div><div class="pbe25-weeks"><button class="pbe25-week ${state.week==='all'?'active':''}" data-week="all">All</button>${weeks().map(w=>`<button class="pbe25-week ${state.week===String(w)?'active':''}" data-week="${w}">WK ${w}</button>`).join('')}</div></section>${nextCards()}<div id="pbe25-list">${list()}</div></section>`;}

  function wire(){document.getElementById('pbe25-search')?.addEventListener('input',e=>{state.query=e.currentTarget.value||'';refreshList()});document.getElementById('pbe25-team')?.addEventListener('change',e=>{state.team=e.currentTarget.value||'all';refreshList()});document.querySelectorAll('.pbe25-week[data-week]').forEach(btn=>btn.addEventListener('click',()=>{state.week=btn.dataset.week||'all';renderShell()}));wireCards();}
  function wireCards(){document.querySelectorAll('[data-provider]').forEach(btn=>btn.addEventListener('click',()=>window.PBEEventSelector?.choose(btn.dataset.provider)));document.querySelectorAll('[data-team]').forEach(btn=>btn.addEventListener('click',()=>{const abbr=btn.dataset.team;if(abbr)window.PBETeamsV2?.openTeam(abbr)}));}
  function refreshList(){const host=document.getElementById('pbe25-list');if(host)host.innerHTML=list();wireCards();}
  function renderShell(){const vc=document.getElementById('view-container');if(vc){vc.innerHTML=shell();wire();}}

  async function loadSchedule(){let last='schedule_unavailable';for(const path of ['/api/schedule?season=2026&season_type=REG','/api/schedule?season=2026','/api/schedule']){try{const payload=await fetchJson(`${API}${path}`),rows=arrayOf(payload).map(normalize).filter(Boolean).filter(g=>g.season===2026&&(!g.seasonType||g.seasonType==='REG'||g.seasonType==='REGULAR'));if(rows.length)return rows;last='empty_schedule';}catch(error){last=error instanceof Error?error.message:String(error)}}throw new Error(last);}
  async function render(){if(state.loading)return;state.loading=true;const vc=document.getElementById('view-container');if(!vc){state.loading=false;return;}vc.innerHTML='<section class="pbe25-games"><div class="pbe25-empty">Loading factual 2026 NFL schedule…</div></section>';try{const [games,scores]=await Promise.all([loadSchedule(),fetchJson(`${API}/api/scores`).catch(()=>null)]);state.games=games;state.scores=scores;renderShell();if(window.PBEEventSelector&&!PBEEventSelector.state.events.length)PBEEventSelector.open().then?.(()=>PBEEventSelector.close());}catch(error){vc.innerHTML=`<section class="pbe25-games"><div class="pbe25-empty">Schedule unavailable: ${esc(error instanceof Error?error.message:String(error))}</div></section>`;}finally{state.loading=false;}}
  function install(){if(!window.App?.VIEWS)return false;App.VIEWS.games=render;const group=document.getElementById('intelligence-nav-group');if(group&&!document.getElementById('nav-games')){const home=document.getElementById('nav-home');const a=document.createElement('a');a.className='nav-item';a.id='nav-games';a.href='javascript:void(0)';a.onclick=()=>App.nav('games');a.innerHTML='<span class="ni-icon">▦</span> Games & Schedule <span class="nav-badge" style="color:#7da7ff;background:rgba(125,167,255,.06)">2026</span>';home?.insertAdjacentElement('afterend',a);}return true;}
  window.PBEGamesV2={render,state};install();document.addEventListener('DOMContentLoaded',install,{once:true});window.addEventListener('pbe:event-changed',()=>{if(document.querySelector('.pbe25-games')&&!state.loading)renderShell();});
})();
