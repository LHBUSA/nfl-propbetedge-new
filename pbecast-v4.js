/* PropBetEdge NFL — PBEcast v4
 * Broadcast-first live game experience inspired by the proven MLB PBEcast interaction model.
 * LIVE is rendered only when /api/nfl-live explicitly returns source.semantics === LIVE.
 */
(() => {
  'use strict';

  const LIVE_API='/api/nfl-live';
  const NFL_API=typeof NFL_API_GATEWAY!=='undefined'?NFL_API_GATEWAY:'https://nfl-api.propbetedge.ai';
  const MARKETS=['player_pass_yds','player_rush_yds','player_reception_yds','player_receptions'];
  const STORAGE='pbe_nfl_cast_v4';
  const state={date:'',scoreboard:null,castIds:[],activeId:null,details:{},market:null,marketEvent:null,loading:false,poll:null,sound:false,lastPlay:{},error:null};

  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,Number(n)||0));
  const arr=v=>Array.isArray(v)?v:[];
  function sportsDay(){const d=new Date(Date.now()-3*3600000);return d.toLocaleDateString('en-CA',{timeZone:'America/New_York'}).replaceAll('-','');}
  function fmtDate(v){if(!v)return'';const d=new Date(v);if(Number.isNaN(d.getTime()))return String(v);return d.toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/New_York'})+' ET';}
  function hexWash(hex,alpha=.32){let s=String(hex||'').replace('#','').trim();if(s.length===3)s=s.split('').map(c=>c+c).join('');if(!/^[0-9a-f]{6}$/i.test(s))return`rgba(70,120,180,${alpha})`;const n=parseInt(s,16);return`rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${alpha})`;}
  async function getJson(url){const r=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});const text=await r.text();if(!r.ok)throw new Error(`${r.status} ${text.slice(0,120)}`);try{return JSON.parse(text)}catch{throw new Error('non_json_response')}}
  function games(){return arr(state.scoreboard?.games)}
  function gameById(id){return games().find(g=>String(g.id)===String(id))||state.details[id]?.game||null}
  function semantics(detail){return String(detail?.source?.semantics||detail?.game?.status?.semantics||'UNAVAILABLE').toUpperCase()}
  function isLive(detail){return semantics(detail)==='LIVE'}
  function saveCast(){try{localStorage.setItem(STORAGE,JSON.stringify(state.castIds.slice(0,4)))}catch(_){}}
  function restoreCast(){try{const v=JSON.parse(localStorage.getItem(STORAGE)||'[]');if(Array.isArray(v))state.castIds=v.map(String).slice(0,4)}catch(_){state.castIds=[]}}

  function teamRecord(team){return arr(team?.records).find(r=>r?.summary)?.summary||''}
  function score(team,sem){return sem==='SCHEDULE'?'—':(team?.score??'—')}
  function statusLabel(g){const s=g?.status||{};if(s.semantics==='LIVE')return `${s.short_detail||s.detail||`Q${s.period||''} ${s.clock||''}`}`;if(s.semantics==='FINAL')return s.short_detail||'FINAL';return s.short_detail||fmtDate(g?.date)||'SCHEDULED'}
  function teamImage(team,size=120){return team?.logo?`<img src="${esc(team.logo)}" width="${size}" height="${size}" alt="${esc(team.abbreviation||team.display_name||'NFL team')} logo">`:`<strong>${esc(team?.abbreviation||'NFL')}</strong>`}
  function playerInitial(name){return String(name||'?').split(/\s+/).map(x=>x[0]||'').slice(0,2).join('').toUpperCase()}

  function indexPlayers(detail){
    const map=new Map();
    arr(detail?.player_stats).forEach(tb=>arr(tb.groups).forEach(group=>arr(group.athletes).forEach(row=>{
      const a=row.athlete||{};const value={...a,group:group.name||group.display_name,values:row.values||[]};if(a.id)map.set(`id:${a.id}`,value);if(a.name)map.set(`name:${a.name.toLowerCase()}`,value);
    })));
    arr(detail?.leaders).forEach(row=>{const a=row.athlete||{};if(a.id&&!map.has(`id:${a.id}`))map.set(`id:${a.id}`,a);if(a.name&&!map.has(`name:${a.name.toLowerCase()}`))map.set(`name:${a.name.toLowerCase()}`,a)});
    return map;
  }
  function enrichPerson(p,index){return index.get(`id:${p?.id}`)||index.get(`name:${String(p?.name||'').toLowerCase()}`)||p||{}}
  function personHtml(p,index){const a=enrichPerson(p,index),name=a.name||p?.name||'Player',photo=a.headshot||p?.headshot;return `<div class="cast4-person">${photo?`<img src="${esc(photo)}" alt="${esc(name)}">`:`<div class="cast4-person-fallback">${esc(playerInitial(name))}</div>`}<div><b>${esc(name)}</b><span>${esc(a.position||p?.position||'NFL PLAYER')}${a.team?` · ${esc(a.team)}`:''}</span></div></div>`;}

  function turnover(play){return /intercept|fumble|turnover|downs/i.test(`${play?.type||''} ${play?.text||''}`)}
  function alertHtml(play){if(!play)return'';const score=Boolean(play.scoring_play),to=turnover(play);if(!score&&!to)return'';return `<div class="cast4-alert ${score?'scoring':''} ${to?'turnover':''}"><div class="cast4-alert-icon">${score?'⚡':'↺'}</div><div><b>${score?'Scoring play':'Possession swing'}</b><span>${esc(play.text||play.type||'Live game event')}</span></div></div>`;}

  function fieldHtml(detail){
    const p=detail?.current_play||detail?.game?.situation?.last_play||{};const sit=detail?.game?.situation||{};
    const yte=p?.end?.yards_to_endzone??p?.start?.yards_to_endzone;let pos=Number.isFinite(Number(yte))?100-Number(yte):null;
    if(pos==null&&Number.isFinite(Number(sit.yard_line)))pos=Number(sit.yard_line);
    pos=clamp(pos??50,2,98);const distance=Number(p?.end?.distance??p?.start?.distance??sit.distance)||0;const fd=clamp(pos+distance,2,98);
    const possession=p?.end?.possession_text||p?.start?.possession_text||sit.possession_text||'Field position';
    return `<div class="cast4-field-wrap"><div class="cast4-field-head"><strong>${esc(possession)}</strong><span>${sit.red_zone?'RED ZONE · ':''}${esc(sit.down_distance_text||p?.end?.down_distance_text||p?.start?.down_distance_text||'Down & distance unavailable')}</span></div><div class="cast4-field"><div class="cast4-drive-fill" style="width:${pos}%"></div><div class="cast4-redzone"></div><div class="cast4-field-lines"></div><div class="cast4-field-numbers">${['10','20','30','40','50','40','30','20','10','G'].map(n=>`<span>${n}</span>`).join('')}</div><div class="cast4-first-down" style="left:${fd}%"></div><div class="cast4-ball" style="left:${pos}%" title="Current ball position"></div></div></div>`;
  }

  function leaderCards(detail){
    const rows=arr(detail?.leaders);const selected=[];
    const tests=[/pass/i,/rush/i,/receiv/i];tests.forEach(rx=>{const hit=rows.find(r=>rx.test(`${r.category||''} ${r.display_name||''}`));if(hit&&!selected.includes(hit))selected.push(hit)});
    rows.forEach(r=>{if(selected.length<3&&!selected.includes(r))selected.push(r)});
    if(!selected.length)return'<div class="cast4-empty" style="min-height:150px"><div><strong>Live leaders loading</strong><p>The game feed has not published player leader cards yet.</p></div></div>';
    return `<div class="cast4-leaders">${selected.slice(0,3).map(r=>{const a=r.athlete||{};return `<article class="cast4-leader">${a.headshot?`<img src="${esc(a.headshot)}" alt="${esc(a.name||'NFL player')}">`:''}<div class="cast4-leader-copy"><div class="cast4-leader-label">${esc(r.display_name||r.category||'Leader')}</div><div class="cast4-leader-value">${esc(r.value||'—')}</div><div class="cast4-leader-name">${esc(a.name||'Player')}</div><div class="cast4-leader-team">${esc([a.team,a.position].filter(Boolean).join(' · '))}</div></div></article>`}).join('')}</div>`;
  }

  function playHtml(p){return `<div class="cast4-play ${p?.scoring_play?'scoring':''}"><div class="cast4-play-clock">Q${esc(p?.period||'—')}<br>${esc(p?.clock||'')}</div><div class="cast4-play-copy"><b>${esc(p?.type||'PLAY')}</b><p>${esc(p?.text||'Play detail unavailable')}</p></div><div class="cast4-play-score">${p?.away_score!=null&&p?.home_score!=null?`${esc(p.away_score)}–${esc(p.home_score)}`:''}</div></div>`;}
  function recentPlays(detail){const rows=arr(detail?.last_five_plays);return rows.length?rows.map(playHtml).join(''):'<div class="cast4-empty" style="min-height:170px"><div><strong>No plays yet</strong><p>Play-by-play will populate as the source publishes game actions.</p></div></div>'}
  function driveRows(detail){const rows=arr(detail?.drives).slice(-8).reverse();return rows.length?rows.map(d=>`<div class="cast4-drive-row">${d?.team?.logo?`<img src="${esc(d.team.logo)}" alt="">`:'<div></div>'}<div><b>${esc(d?.team?.abbreviation||'NFL')} · ${esc(d?.result||d?.description||'Drive')}</b><span>${esc([d?.offensive_plays!=null?`${d.offensive_plays} plays`:null,d?.yards!=null?`${d.yards} yds`:null,d?.time_elapsed].filter(Boolean).join(' · '))}</span></div><strong>${d?.is_current?'NOW':''}</strong></div>`).join(''):'<div class="cast4-empty" style="min-height:170px"><div><strong>Drive history loading</strong></div></div>'}

  function statForMarket(detail,player,market){
    const p=String(player||'').toLowerCase();let targetGroup='',label='';
    if(market==='player_pass_yds'){targetGroup='pass';label='YDS'}
    if(market==='player_rush_yds'){targetGroup='rush';label='YDS'}
    if(market==='player_reception_yds'){targetGroup='receiv';label='YDS'}
    if(market==='player_receptions'){targetGroup='receiv';label='REC'}
    for(const tb of arr(detail?.player_stats))for(const group of arr(tb?.groups)){
      if(targetGroup&&!String(group?.name||group?.display_name||'').toLowerCase().includes(targetGroup))continue;
      const row=arr(group?.athletes).find(r=>String(r?.athlete?.name||'').toLowerCase()===p);if(!row)continue;
      const hit=arr(row.values).find(v=>String(v?.label||'').toUpperCase()===label);if(hit)return hit.value;
    }
    return null;
  }
  function marketName(m){return({player_pass_yds:'Pass yards',player_rush_yds:'Rush yards',player_reception_yds:'Receiving yards',player_receptions:'Receptions'})[m]||m}
  function livePropsHtml(detail){
    if(!state.market)return `<div class="cast4-empty" style="min-height:190px"><div><strong>Market link unavailable</strong><p>PBEcast will never attach sportsbook lines to the wrong game. Live stats remain available while the odds-event match is unavailable.</p></div></div>`;
    const summaries=arr(state.market.market_summary).slice(0,8);if(!summaries.length)return `<div class="cast4-empty" style="min-height:190px"><div><strong>No player props returned</strong><p>The matched sportsbook event has no supported live player markets right now.</p></div></div>`;
    return `<div class="cast4-play-list">${summaries.map(s=>{const live=statForMarket(detail,s.player,s.market);const line=s.consensus_line??s.line??'—';return `<div class="cast4-play"><div class="cast4-play-clock">${live!=null?`LIVE<br><strong style="color:var(--cast-live)">${esc(live)}</strong>`:'STAT<br>—'}</div><div class="cast4-play-copy"><b>${esc(s.player||'Player')} · ${esc(marketName(s.market))}</b><p>Consensus line ${esc(line)}${live!=null?` · current progress ${esc(live)}`:''}</p></div><div class="cast4-play-score">${esc(line)}</div></div>`}).join('')}</div>`;
  }

  function rail(){
    const rows=games();return `<section class="cast4-rail-wrap"><div class="cast4-rail-head"><strong>Tonight · Cast up to 4 games</strong><span>Click a game to cast / focus · actual scoreboard states only</span></div><div class="cast4-rail">${rows.map(g=>{const a=g.teams?.away||{},h=g.teams?.home||{},active=String(g.id)===String(state.activeId),casting=state.castIds.includes(String(g.id)),live=g.status?.semantics==='LIVE';return `<button type="button" class="cast4-game-chip ${active?'active':''} ${casting?'casting':''}" data-game="${esc(g.id)}"><div class="cast4-chip-state ${live?'live':''}">${esc(g.status?.semantics||'UNAVAILABLE')} · ${esc(statusLabel(g))}</div><div class="cast4-chip-score"><span>${esc(a.abbreviation||a.display_name||'AWY')}</span><b>${esc(score(a,g.status?.semantics))}</b></div><div class="cast4-chip-score"><span>${esc(h.abbreviation||h.display_name||'HME')}</span><b>${esc(score(h,g.status?.semantics))}</b></div><div class="cast4-chip-meta">${esc(g.venue?.name||fmtDate(g.date)||'Venue unavailable')}</div></button>`}).join('')}</div></section>`;}
  function currentDriveHtml(detail){const d=detail?.current_drive;if(!d)return `<div class="cast4-drive-card"><div class="cast4-drive-result" style="color:#7d8997">No active drive</div><div class="cast4-drive-desc">The source is not reporting an active possession.</div></div>`;return `<div class="cast4-drive-card"><div class="cast4-drive-team">${d.team?.logo?`<img src="${esc(d.team.logo)}" alt="">`:''}<b>${esc(d.team?.abbreviation||d.team?.display_name||'Possession')}</b></div><div class="cast4-drive-result">${esc(d.result||'Drive in progress')}</div><div class="cast4-drive-desc">${esc(d.description||'Current drive')}</div><div class="cast4-drive-stats"><div class="cast4-drive-stat"><b>${esc(d.offensive_plays??'—')}</b><span>Plays</span></div><div class="cast4-drive-stat"><b>${esc(d.yards??'—')}</b><span>Yards</span></div><div class="cast4-drive-stat"><b>${esc(d.time_elapsed||'—')}</b><span>Time</span></div></div></div>`;}

  function hero(detail){
    const g=detail?.game||{},sem=semantics(detail),a=g.teams?.away||{},h=g.teams?.home||{},sit=g.situation||{},p=detail?.current_play||sit.last_play||{},idx=indexPlayers(detail),participants=arr(p.participants).slice(0,4);
    const scoreReady=sem==='LIVE'||sem==='FINAL';const period=g.status?.short_detail||g.status?.detail||`${g.status?.period?`Q${g.status.period}`:''} ${g.status?.clock||''}`.trim()||sem;
    return `<section class="cast4-hero" style="--away-wash:${hexWash(a.color,.38)};--home-wash:${hexWash(h.color,.38)}"><div class="cast4-ghost-logo away">${teamImage(a,300)}</div><div class="cast4-ghost-logo home">${teamImage(h,300)}</div><div class="cast4-hero-inner"><div class="cast4-status-row"><span class="cast4-live-tag ${sem==='LIVE'?'live':''}">${esc(sem)} · PBECAST</span><span class="cast4-source">${esc(detail?.source?.provider||'source unavailable')} · ${esc(detail?.source?.transport||'poll')} · refreshed ${esc(detail?.source?.fetched_at?new Date(detail.source.fetched_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'}):'—')}</span></div><div class="cast4-scoreboard"><div class="cast4-team"><div class="cast4-team-logo">${teamImage(a,112)}</div><div><div class="cast4-team-abbr">${esc(a.abbreviation||'AWY')}</div><div class="cast4-team-name">${esc(a.display_name||'Away')}</div><div class="cast4-record">${esc(teamRecord(a))}</div></div></div><div class="cast4-center"><div class="cast4-score"><span>${esc(scoreReady?a.score:'—')}</span><i>:</i><span>${esc(scoreReady?h.score:'—')}</span></div><div class="cast4-period"><span>${esc(period)}</span></div><div class="cast4-venue">${esc([g.venue?.name,[g.venue?.city,g.venue?.state].filter(Boolean).join(', '),arr(g.broadcast).join(' / ')].filter(Boolean).join(' · ')||fmtDate(g.date)||'Game context')}</div></div><div class="cast4-team home"><div><div class="cast4-team-abbr">${esc(h.abbreviation||'HME')}</div><div class="cast4-team-name">${esc(h.display_name||'Home')}</div><div class="cast4-record">${esc(teamRecord(h))}</div></div><div class="cast4-team-logo">${teamImage(h,112)}</div></div></div><div class="cast4-situation"><div class="cast4-sit"><b class="gold">${esc(sit.down_distance_text||p?.end?.down_distance_text||p?.start?.down_distance_text||'—')}</b><span>Down & distance</span></div><div class="cast4-sit"><b>${esc(sit.possession_text||p?.end?.possession_text||p?.start?.possession_text||'—')}</b><span>Ball position</span></div><div class="cast4-sit"><b class="${sit.red_zone?'live':''}">${sit.red_zone?'YES':'NO'}</b><span>Red zone</span></div><div class="cast4-sit"><b>${esc(`${sit.away_timeouts??'—'} / ${sit.home_timeouts??'—'}`)}</b><span>Timeouts A / H</span></div></div></div>${fieldHtml(detail)}</section>${alertHtml(p)}<div class="cast4-action-grid"><section class="cast4-panel"><div class="cast4-panel-head"><strong>Current Play</strong><span>${esc(p?.type||'LIVE ACTION')}</span></div><div class="cast4-current"><div class="cast4-current-kicker">${sem==='LIVE'?'● LIVE SNAPSHOT':'GAME FEED'} · Q${esc(p?.period||g.status?.period||'—')} ${esc(p?.clock||g.status?.clock||'')}</div><div class="cast4-current-type">${esc(p?.type||detailedState(sem))}</div><div class="cast4-current-text">${esc(p?.text||'Waiting for the next published play.')}</div>${participants.length?`<div class="cast4-participants">${participants.map(x=>personHtml(x,idx)).join('')}</div>`:''}</div></section><section class="cast4-panel"><div class="cast4-panel-head"><strong>Current Drive</strong><span>${esc(detail?.current_drive?.team?.abbreviation||'POSSESSION')}</span></div>${currentDriveHtml(detail)}</section></div>`;}
  function detailedState(sem){return sem==='SCHEDULE'?'PREGAME':sem==='FINAL'?'GAME COMPLETE':sem==='LIVE'?'LIVE GAME':'FEED UNAVAILABLE'}

  function lower(detail){return `<section class="cast4-panel" style="margin-top:10px"><div class="cast4-panel-head"><strong>Live Player Leaders</strong><span>HEADSHOTS + CURRENT GAME OUTPUT</span></div>${leaderCards(detail)}</section><div class="cast4-lower"><section class="cast4-panel"><div class="cast4-panel-head"><strong>Recent Plays</strong><button class="cast4-btn" id="cast4-open-pbp">Full play-by-play · ${esc(detail?.play_count||0)} plays</button></div><div class="cast4-play-list">${recentPlays(detail)}</div></section><section class="cast4-panel"><div class="cast4-panel-head"><strong>Live Prop Tracker</strong><span>${state.market?'SPORTSBOOK + LIVE STAT':'NO MATCHED MARKET'}</span></div>${livePropsHtml(detail)}</section></div><div class="cast4-lower"><section class="cast4-panel"><div class="cast4-panel-head"><strong>Drive History</strong><span>${esc(detail?.drive_count||0)} drives</span></div><div class="cast4-drive-list">${driveRows(detail)}</div></section><section class="cast4-panel"><div class="cast4-panel-head"><strong>Source Win Probability</strong><span>NOT PBE MODEL</span></div>${probabilityHtml(detail)}</section></div>`;}
  function probabilityHtml(detail){const rows=arr(detail?.win_probability).filter(r=>Number.isFinite(Number(r.home_win_percentage)));if(!rows.length)return'<div class="cast4-empty" style="min-height:190px"><div><strong>Probability unavailable</strong><p>No source win-probability series was returned for this game.</p></div></div>';const pts=rows.map((r,i)=>`${rows.length===1?50:(i/(rows.length-1))*100},${100-clamp(Number(r.home_win_percentage)*100,0,100)}`).join(' ');const latest=clamp(Number(rows.at(-1).home_win_percentage)*100,0,100);return `<div style="padding:14px"><div style="display:flex;justify-content:space-between;align-items:end;margin-bottom:9px"><div><div style="color:#65717e;font:800 5.8px 'DM Mono',monospace;text-transform:uppercase">Home win probability</div><div style="color:#fff;font:900 34px/.9 'Barlow Condensed',sans-serif;margin-top:4px">${latest.toFixed(1)}%</div></div><div style="color:#64717f;font-size:6.5px">Source series · not PBE projection</div></div><svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:130px;display:block;background:rgba(255,255,255,.015);border-radius:8px"><line x1="0" y1="50" x2="100" y2="50" stroke="rgba(255,255,255,.08)" stroke-width=".8"/><polyline points="${pts}" fill="none" stroke="currentColor" style="color:var(--cast-gold)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg></div>`;}

  function render(){
    const vc=document.getElementById('view-container');if(!vc)return;
    if(state.loading&&!state.scoreboard){vc.innerHTML=`<section class="pbecast4"><div class="cast4-empty"><div><div class="cast4-spinner"></div><strong>Opening PBEcast</strong><p>Connecting to the live NFL game transport, current drives and play-by-play.</p></div></div></section>`;return}
    if(state.error&&!games().length){vc.innerHTML=`<section class="pbecast4"><div class="cast4-topbar"><div class="cast4-brand"><div class="cast4-bolt">⚡</div><div><h1>PBE<em>cast</em> NFL</h1><p>Live football command center</p></div></div></div><div class="cast4-empty"><div><strong>Live feed unavailable</strong><p>${esc(state.error)}. No synthetic game state is substituted.</p><button class="cast4-btn primary" id="cast4-retry" style="margin-top:13px">Retry live feed</button></div></div></section>`;document.getElementById('cast4-retry')?.addEventListener('click',load);return}
    const detail=state.details[state.activeId]||null;
    vc.innerHTML=`<section class="pbecast4"><div class="cast4-topbar"><div class="cast4-brand"><div class="cast4-bolt">⚡</div><div><h1>PBE<em>cast</em> NFL</h1><p>Full game · possession · play-by-play · props</p></div></div><div class="cast4-actions"><button class="cast4-btn cast4-sound ${state.sound?'on':''}" id="cast4-sound">${state.sound?'🔊 Sound On':'🔇 Sound Off'}</button><button class="cast4-btn" id="cast4-refresh">↻ Refresh</button>${state.activeId?`<button class="cast4-btn" id="cast4-remove">Remove Cast</button>`:''}</div></div>${rail()}${detail?`${hero(detail)}${lower(detail)}`:`<div class="cast4-empty"><div><div class="cast4-spinner"></div><strong>Loading game package</strong><p>Fetching drives, players and play-by-play for the selected game.</p></div></div>`}</section>`;
    wire();
  }

  function openPbp(){const detail=state.details[state.activeId];if(!detail)return;let overlay=document.getElementById('cast4-overlay');if(!overlay){overlay=document.createElement('div');overlay.id='cast4-overlay';overlay.className='cast4-overlay';document.body.appendChild(overlay)}const g=detail.game||{},plays=arr(detail.plays);const groups=new Map();plays.forEach(p=>{const q=p.period||0;if(!groups.has(q))groups.set(q,[]);groups.get(q).push(p)});overlay.innerHTML=`<div class="cast4-drawer"><header class="cast4-drawer-head"><div><h2>Full Play-by-Play</h2><p>${esc(g.teams?.away?.abbreviation||'AWY')} @ ${esc(g.teams?.home?.abbreviation||'HME')} · ${plays.length} published plays · ${esc(detail.source?.provider||'source')}</p></div><button class="cast4-close" id="cast4-close-pbp">×</button></header><div class="cast4-pbp">${[...groups.entries()].sort((a,b)=>a[0]-b[0]).map(([q,rows])=>`<div class="cast4-quarter">Quarter ${esc(q||'—')}</div>${rows.map(playHtml).join('')}`).join('')}</div></div>`;overlay.classList.add('open');overlay.onclick=e=>{if(e.target===overlay)closePbp()};document.getElementById('cast4-close-pbp')?.addEventListener('click',closePbp);document.body.style.overflow='hidden';}
  function closePbp(){document.getElementById('cast4-overlay')?.classList.remove('open');document.body.style.overflow=''}

  function soundEvent(play){if(!state.sound||!play)return;try{const C=window.AudioContext||window.webkitAudioContext;if(!C)return;const ctx=new C();const osc=ctx.createOscillator(),gain=ctx.createGain();osc.connect(gain);gain.connect(ctx.destination);osc.type='triangle';osc.frequency.value=play.scoring_play?740:turnover(play)?260:520;gain.gain.setValueAtTime(.09,ctx.currentTime);gain.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+.32);osc.start();osc.stop(ctx.currentTime+.34)}catch(_){}}

  async function fetchDetail(id,quiet=false){
    try{const before=state.details[id]?.current_play?.id;const detail=await getJson(`${LIVE_API}?event=${encodeURIComponent(id)}`);state.details[id]=detail;const after=detail?.current_play?.id;if(quiet&&before&&after&&before!==after&&(detail.current_play?.scoring_play||turnover(detail.current_play)))soundEvent(detail.current_play);state.lastPlay[id]=after||null;return detail}catch(error){if(!quiet&&String(id)===String(state.activeId))state.error=error.message;return null}
  }
  function namesMatch(a,b){const x=String(a||'').toLowerCase(),y=String(b||'').toLowerCase();if(!x||!y)return false;const ax=x.split(' ').pop(),by=y.split(' ').pop();return x===y||x.includes(y)||y.includes(x)||ax===by}
  function oddsRows(payload){if(Array.isArray(payload))return payload;for(const k of ['events','games','data','results','odds'])if(Array.isArray(payload?.[k]))return payload[k];return[]}
  function oddsEvent(raw){return{id:String(raw?.id||raw?.event_id||raw?.eventId||''),away:String(raw?.away_team||raw?.away||raw?.awayTeam||''),home:String(raw?.home_team||raw?.home||raw?.homeTeam||'')};}
  async function loadMarket(detail){
    state.market=null;state.marketEvent=null;if(!detail?.game)return;
    const a=detail.game.teams?.away||{},h=detail.game.teams?.home||{};
    try{const payload=await getJson(`${NFL_API}/api/odds`);const hit=oddsRows(payload).map(oddsEvent).find(e=>e.id&&((namesMatch(e.away,a.display_name)||namesMatch(e.away,a.abbreviation))&&(namesMatch(e.home,h.display_name)||namesMatch(e.home,h.abbreviation))));if(!hit)return;state.marketEvent=hit;state.market=await getJson(`${NFL_API}/api/odds/board?event_id=${encodeURIComponent(hit.id)}&markets=${MARKETS.join(',')}`)}catch(_){state.market=null;state.marketEvent=null}
  }
  async function focus(id){
    id=String(id);if(!state.castIds.includes(id)){if(state.castIds.length>=4){window.alert('PBEcast supports up to 4 games at once. Remove one before casting another.');return}state.castIds.push(id);saveCast()}state.activeId=id;render();const detail=await fetchDetail(id);if(detail)await loadMarket(detail);render();startPoll();
  }
  function removeActive(){const id=String(state.activeId||'');state.castIds=state.castIds.filter(x=>x!==id);delete state.details[id];state.activeId=state.castIds[0]||games().find(g=>g.status?.semantics==='LIVE')?.id||games()[0]?.id||null;saveCast();if(state.activeId&&!state.castIds.includes(String(state.activeId))){state.castIds.push(String(state.activeId));saveCast()}render();if(state.activeId)focus(state.activeId)}

  function wire(){
    document.querySelectorAll('.cast4-game-chip[data-game]').forEach(btn=>btn.addEventListener('click',()=>focus(btn.dataset.game)));
    document.getElementById('cast4-refresh')?.addEventListener('click',()=>refresh(true));
    document.getElementById('cast4-remove')?.addEventListener('click',removeActive);
    document.getElementById('cast4-open-pbp')?.addEventListener('click',openPbp);
    document.getElementById('cast4-sound')?.addEventListener('click',()=>{state.sound=!state.sound;render()});
  }

  async function refresh(manual=false){
    try{state.scoreboard=await getJson(`${LIVE_API}?date=${encodeURIComponent(state.date)}`);state.error=null}catch(error){state.error=error.message;if(manual)render();return}
    const valid=new Set(games().map(g=>String(g.id)));state.castIds=state.castIds.filter(id=>valid.has(String(id))||state.details[id]);
    await Promise.all(state.castIds.map(id=>fetchDetail(id,!manual)));
    if(state.activeId&&state.details[state.activeId])await loadMarket(state.details[state.activeId]);render();startPoll();
  }
  function startPoll(){if(state.poll)clearTimeout(state.poll);const detail=state.details[state.activeId];const delay=isLive(detail)?5000:15000;state.poll=setTimeout(async()=>{if(!document.querySelector('.pbecast4')){state.poll=null;return}await refresh(false)},delay)}
  async function load(){
    if(state.loading)return;state.loading=true;state.error=null;state.date=sportsDay();restoreCast();render();
    try{state.scoreboard=await getJson(`${LIVE_API}?date=${encodeURIComponent(state.date)}`);const valid=new Set(games().map(g=>String(g.id)));state.castIds=state.castIds.filter(id=>valid.has(id));if(!state.castIds.length){const first=games().find(g=>g.status?.semantics==='LIVE')||games()[0];if(first)state.castIds=[String(first.id)]}state.activeId=state.castIds[0]||null;saveCast();if(state.activeId){const detail=await fetchDetail(state.activeId);if(detail)await loadMarket(detail)}state.error=null}catch(error){state.error=error instanceof Error?error.message:String(error)}finally{state.loading=false;render();startPoll()}
  }
  function install(){if(!window.App?.VIEWS)return false;App.VIEWS.pbecast=load;const nav=document.getElementById('nav-pbecast');if(nav)nav.innerHTML='<span class="ni-icon">⚡</span> PBEcast <span class="nav-badge" style="color:#f0c45b;background:rgba(240,196,91,.08)">LIVE</span>';return true}
  window.PBEcastV4={load,focus,refresh,openPbp,closePbp,state};install();document.addEventListener('DOMContentLoaded',install,{once:true});document.addEventListener('keydown',e=>{if(e.key==='Escape')closePbp()});
})();
