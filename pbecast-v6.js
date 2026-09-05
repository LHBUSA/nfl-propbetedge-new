/* PropBetEdge NFL — PBEcast v6
 * Authoritative live command center. One renderer, silent polling, real audio cues.
 */
(() => {
  'use strict';

  const LIVE_API='/api/nfl-live';
  const NFL_API=typeof NFL_API_GATEWAY!=='undefined'?NFL_API_GATEWAY:'https://nfl-api.propbetedge.ai';
  const MARKETS=['player_pass_yds','player_rush_yds','player_reception_yds','player_receptions'];
  const SOUND_KEY='pbe_nfl_cast_sound_v6';
  const ACTIVE_KEY='pbe_nfl_cast_active_v6';
  const BAD=/^(?:null|undefined|n\/a|na|—|-|\?)$/i;

  const state={
    date:'',scoreboard:null,activeId:null,detail:null,market:null,marketEvent:null,error:null,
    loading:false,poll:null,lastPlayId:null,lastMarketAt:0,sound:false,audioCtx:null,statFilter:'all',installed:false
  };

  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const arr=v=>Array.isArray(v)?v:[];
  const clean=v=>{const s=String(v??'').trim();return !s||BAD.test(s)?'':s};
  const num=v=>v===null||v===undefined||v===''?null:(Number.isFinite(Number(v))?Number(v):null);

  function sportsDay(){const d=new Date(Date.now()-3*3600000);return d.toLocaleDateString('en-CA',{timeZone:'America/New_York'}).replaceAll('-','')}
  async function getJson(url){const r=await fetch(url,{cache:'no-store',headers:{accept:'application/json'}});const text=await r.text();if(!r.ok)throw new Error(`${r.status} ${text.slice(0,140)}`);try{return JSON.parse(text)}catch{throw new Error('non_json_response')}}
  function games(){return arr(state.scoreboard?.games)}
  function semantics(d=state.detail){return String(d?.source?.semantics||d?.game?.status?.semantics||'UNAVAILABLE').toUpperCase()}
  function isLive(d=state.detail){return semantics(d)==='LIVE'}
  function fmtDate(v){if(!v)return'';const d=new Date(v);if(Number.isNaN(d.getTime()))return'';return d.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/New_York'})+' ET'}
  function sourceLabel(d){const provider=String(d?.source?.provider||'').toLowerCase();return provider.includes('espn')?'ESPN LIVE':clean(d?.source?.provider)||'LIVE SOURCE'}
  function statusLabel(g){const s=g?.status||{};if(s.semantics==='LIVE')return clean(s.short_detail)||clean(s.detail)||`Q${s.period||''} ${s.clock||''}`.trim();if(s.semantics==='FINAL')return clean(s.short_detail)||'FINAL';return clean(s.short_detail)||fmtDate(g?.date)||'SCHEDULED'}
  function score(team,sem){return sem==='SCHEDULE'?'—':(team?.score??'—')}
  function teamRecord(team){return arr(team?.records).find(r=>clean(r?.summary))?.summary||''}
  function teamLogo(team,size=62){return team?.logo?`<img src="${esc(team.logo)}" width="${size}" height="${size}" alt="${esc(team?.display_name||team?.abbreviation||'NFL')} logo" decoding="async">`:`<b>${esc(team?.abbreviation||'NFL')}</b>`}

  function restore(){try{state.sound=localStorage.getItem(SOUND_KEY)==='1';state.activeId=localStorage.getItem(ACTIVE_KEY)||null}catch(_){}}
  function persist(){try{localStorage.setItem(SOUND_KEY,state.sound?'1':'0');if(state.activeId)localStorage.setItem(ACTIVE_KEY,String(state.activeId))}catch(_){}}

  function ensureAudio(){
    const C=window.AudioContext||window.webkitAudioContext;if(!C)return null;
    if(!state.audioCtx)state.audioCtx=new C();
    if(state.audioCtx.state==='suspended')state.audioCtx.resume().catch(()=>{});
    return state.audioCtx;
  }
  function tone(freq,start,duration,gain=.045,type='sine'){
    const ctx=ensureAudio();if(!ctx)return;
    const osc=ctx.createOscillator(),vol=ctx.createGain();osc.type=type;osc.frequency.value=freq;osc.connect(vol);vol.connect(ctx.destination);
    vol.gain.setValueAtTime(Math.max(.001,gain),ctx.currentTime+start);vol.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+start+duration);
    osc.start(ctx.currentTime+start);osc.stop(ctx.currentTime+start+duration+.02);
  }
  function playCue(kind='play'){
    if(!state.sound)return;
    if(kind==='score'){tone(660,0,.12,.06,'triangle');tone(880,.12,.18,.055,'triangle');return}
    if(kind==='turnover'){tone(280,0,.13,.055,'sawtooth');tone(210,.12,.18,.04,'triangle');return}
    if(kind==='test'){tone(520,0,.09,.045,'triangle');tone(720,.10,.12,.04,'triangle');return}
    tone(470,0,.07,.022,'sine');
  }
  function toggleSound(){state.sound=!state.sound;persist();if(state.sound){ensureAudio();playCue('test')}patchToolbar()}

  function turnover(play){return /intercept|fumble|turnover|downs/i.test(`${play?.type||''} ${play?.text||''}`)}
  function cueFor(play){if(play?.scoring_play)return'score';if(turnover(play))return'turnover';return'play'}

  function chooseActive(){const rows=games();if(state.activeId&&rows.some(g=>String(g.id)===String(state.activeId)))return String(state.activeId);const pick=rows.find(g=>g?.status?.semantics==='LIVE')||rows.find(g=>g?.status?.semantics==='SCHEDULE')||rows[0];return pick?String(pick.id):null}

  function dedupeActors(play){
    const map=new Map();
    arr(play?.participants).forEach(p=>{
      const name=clean(p?.name)||clean(p?.short_name)||'Player';
      const key=String(p?.id||`${name}|${p?.position||''}`).toLowerCase();
      const role=clean(p?.role)||clean(p?.type);
      if(!map.has(key))map.set(key,{...p,name,roles:new Set()});
      if(role)map.get(key).roles.add(role);
    });
    return [...map.values()].slice(0,4);
  }
  function actorHtml(p){const roles=[...(p.roles||[])];return `<article class="cast6-actor">${p?.headshot?`<img src="${esc(p.headshot)}" alt="${esc(p.name)}" decoding="async">`:`<div class="cast6-avatar">${esc(p.name.split(/\s+/).map(x=>x[0]||'').slice(0,2).join('').toUpperCase())}</div>`}<div><b>${esc(p.name)}</b><span>${esc([p?.position,...roles].filter(Boolean).join(' · ')||'NFL PLAYER')}</span></div></article>`}

  function situationFacts(d){
    const g=d?.game||{},s=g?.situation||{},p=d?.current_play||s?.last_play||{};const facts=[];
    const possession=clean(s?.possession_text)||clean(p?.end?.possession_text)||clean(p?.start?.possession_text);if(possession)facts.push(['POSSESSION',possession]);
    const down=clean(s?.down_distance_text)||clean(p?.end?.down_distance_text)||clean(p?.start?.down_distance_text);if(down)facts.push(['DOWN & DISTANCE',down]);
    const yard=num(s?.yard_line??p?.end?.yard_line??p?.start?.yard_line);if(yard!==null)facts.push(['BALL',String(yard)]);
    if(typeof s?.red_zone==='boolean')facts.push(['RED ZONE',s.red_zone?'YES':'NO']);
    const at=num(s?.away_timeouts),ht=num(s?.home_timeouts);if(at!==null||ht!==null)facts.push(['TIMEOUTS',`${at!==null?at:'–'} / ${ht!==null?ht:'–'}`]);
    return facts;
  }

  function fieldHtml(d){
    const p=d?.current_play||d?.game?.situation?.last_play||{},s=d?.game?.situation||{};
    const yte=num(p?.end?.yards_to_endzone??p?.start?.yards_to_endzone);const yard=num(s?.yard_line??p?.end?.yard_line??p?.start?.yard_line);
    let pos=yte!==null?100-yte:yard;if(pos===null)return'';pos=Math.max(2,Math.min(98,pos));
    const distance=num(p?.end?.distance??p?.start?.distance??s?.distance);const fd=distance!==null?Math.max(2,Math.min(98,pos+distance)):null;
    return `<div class="cast6-field"><div class="cast6-field-top"><span>${esc(clean(s?.possession_text)||'FIELD POSITION')}</span>${clean(s?.down_distance_text)?`<b>${esc(s.down_distance_text)}</b>`:''}</div><div class="cast6-field-surface"><i class="cast6-drive-fill" style="width:${pos}%"></i><i class="cast6-redzone"></i>${fd!==null?`<i class="cast6-first" style="left:${fd}%"></i>`:''}<i class="cast6-ball" style="left:${pos}%"></i></div></div>`;
  }

  function heroHtml(){
    const d=state.detail,g=d?.game||{},a=g?.teams?.away||{},h=g?.teams?.home||{},sem=semantics(d),facts=situationFacts(d);
    return `<section class="cast6-hero"><div class="cast6-hero-head"><div><span class="cast6-live ${sem==='LIVE'?'on':''}">${sem==='LIVE'?'<i></i>':''}${esc(sem)} · PBECAST</span><b>${esc(sourceLabel(d))}</b></div><small>${esc(clean(d?.source?.fetched_at)?`UPDATED ${new Date(d.source.fetched_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit',second:'2-digit'})}`:'')}</small></div><div class="cast6-score"><div class="cast6-team">${teamLogo(a)}<span><b>${esc(a.abbreviation||'AWY')}</b><small>${esc(a.display_name||'Away')}${teamRecord(a)?` · ${esc(teamRecord(a))}`:''}</small></span></div><div class="cast6-score-center"><strong>${esc(score(a,sem))}<i>:</i>${esc(score(h,sem))}</strong><span>${esc(statusLabel(g))}</span><small>${esc([g?.venue?.name,[g?.venue?.city,g?.venue?.state].filter(Boolean).join(', ')].filter(Boolean).join(' · '))}</small></div><div class="cast6-team home"><span><b>${esc(h.abbreviation||'HME')}</b><small>${esc(h.display_name||'Home')}${teamRecord(h)?` · ${esc(teamRecord(h))}`:''}</small></span>${teamLogo(h)}</div></div>${facts.length?`<div class="cast6-facts">${facts.map(([k,v])=>`<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>`:''}</section>`;
  }

  function currentActionHtml(){
    const d=state.detail,p=d?.current_play||d?.game?.situation?.last_play||null,actors=dedupeActors(p),drive=d?.current_drive;
    const playBody=p?`<div class="cast6-play-kicker"><span>${semantics(d)==='LIVE'?'● LIVE SNAPSHOT':'GAME FEED'}</span>${p?.period?`<b>Q${esc(p.period)} ${esc(p.clock||'')}</b>`:''}</div><h2>${esc(clean(p?.type)||'CURRENT PLAY')}</h2><p>${esc(clean(p?.text)||'Waiting for the next published play.')}</p>${actors.length?`<div class="cast6-actors">${actors.map(actorHtml).join('')}</div>`:''}`:`<div class="cast6-empty compact"><b>Waiting for the next published play</b><span>The source has not published a current play.</span></div>`;
    const driveBody=drive?`<div class="cast6-drive-team">${drive?.team?.logo?`<img src="${esc(drive.team.logo)}" alt="" decoding="async">`:''}<b>${esc(drive?.team?.abbreviation||drive?.team?.display_name||'POSSESSION')}</b></div><strong>${esc(clean(drive?.result)||'Drive in progress')}</strong><p>${esc(clean(drive?.description)||'Current possession')}</p><div class="cast6-drive-kpis">${num(drive?.offensive_plays)!==null?`<span><b>${drive.offensive_plays}</b><small>PLAYS</small></span>`:''}${num(drive?.yards)!==null?`<span><b>${drive.yards}</b><small>YARDS</small></span>`:''}${clean(drive?.time_elapsed)?`<span><b>${esc(drive.time_elapsed)}</b><small>TIME</small></span>`:''}</div>`:`<div class="cast6-empty compact"><b>No active drive</b><span>The source is not reporting an active possession.</span></div>`;
    return `${fieldHtml(d)}<div class="cast6-action-grid"><section class="cast6-module cast6-current"><header><span>CURRENT PLAY</span>${p?.type?`<b>${esc(p.type)}</b>`:''}</header><div class="cast6-current-body">${playBody}</div></section><section class="cast6-module cast6-drive"><header><span>CURRENT DRIVE</span>${drive?.team?.abbreviation?`<b>${esc(drive.team.abbreviation)}</b>`:''}</header><div class="cast6-drive-body">${driveBody}</div></section></div>`;
  }

  function coverageHtml(){
    const d=state.detail;const facts=situationFacts(d);const cards=[...facts];
    cards.push(['PUBLISHED PLAYS',String(d?.play_count??arr(d?.plays).length)]);cards.push(['PUBLISHED DRIVES',String(d?.drive_count??arr(d?.drives).length)]);
    const chips=[['PLAY-BY-PLAY',arr(d?.plays).length?`${arr(d.plays).length} PLAYS`:'INACTIVE',Boolean(arr(d?.plays).length)],['PLAYER STATS',arr(d?.player_stats).length?`${countPlayers(d)} PLAYERS`:'INACTIVE',Boolean(arr(d?.player_stats).length)],['WIN PROB',arr(d?.win_probability).length?`${arr(d.win_probability).length} POINTS`:'INACTIVE',Boolean(arr(d?.win_probability).length)],['PROP MARKET',state.market?'LINKED':'NOT LINKED',Boolean(state.market)]];
    return `<section class="cast6-telemetry"><div class="cast6-telemetry-head"><div><span class="cast6-pulse ${isLive(d)?'on':''}"></span><b>${isLive(d)?'LIVE GAME FEED':esc(semantics(d))}</b><small>${esc(sourceLabel(d))} · ${isLive(d)?'5 SEC SILENT REFRESH':'15 SEC STATE REFRESH'}</small></div><strong>${esc(d?.source?.fetched_at?new Date(d.source.fetched_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit',second:'2-digit'}):'')}</strong></div><div class="cast6-telemetry-grid">${cards.filter(([,v])=>clean(v)).map(([k,v])=>`<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div><div class="cast6-coverage">${chips.map(([k,v,ok])=>`<div class="${ok?'ok':'neutral'}"><span>${k}</span><b>${v}</b></div>`).join('')}</div></section>`;
  }

  function countPlayers(d){const set=new Set();arr(d?.player_stats).forEach(tb=>arr(tb?.groups).forEach(g=>arr(g?.athletes).forEach(r=>{const a=r?.athlete||{};if(a.id||a.name)set.add(String(a.id||a.name))})));return set.size}
  function groupKind(name){const n=String(name||'').toLowerCase();if(n.includes('pass'))return'passing';if(n.includes('rush'))return'rushing';if(n.includes('receiv'))return'receiving';if(n.includes('def'))return'defense';return'other'}
  function statGroups(){const d=state.detail,out=[];arr(d?.player_stats).forEach(tb=>{const team=tb?.team||{};arr(tb?.groups).forEach(g=>{const kind=groupKind(g?.display_name||g?.name);if(state.statFilter!=='all'&&kind!==state.statFilter)return;const rows=arr(g?.athletes).filter(r=>!r?.did_not_play).slice(0,8);if(rows.length)out.push({team,group:g,rows,kind})})});return out}
  function playerOutputHtml(){
    const groups=statGroups();const filters=[['all','All'],['passing','Passing'],['rushing','Rushing'],['receiving','Receiving'],['defense','Defense']];
    return `<section class="cast6-module cast6-output"><header><div><span>GAME PACKAGE</span><h2>Player Output</h2></div><div class="cast6-filters">${filters.map(([k,l])=>`<button class="${state.statFilter===k?'active':''}" data-stat-filter="${k}">${l}</button>`).join('')}</div></header><div class="cast6-stat-scroll">${groups.length?groups.map(statGroupHtml).join(''):`<div class="cast6-empty"><b>${state.statFilter==='all'?'Player box score unavailable':`${state.statFilter} stats unavailable`}</b><span>No source-published stat table matches this filter.</span></div>`}</div></section>`;
  }
  function statGroupHtml(x){const labels=arr(x.group?.labels).slice(0,6);return `<section class="cast6-stat-group"><header>${x.team?.logo?`<img src="${esc(x.team.logo)}" alt="" decoding="async">`:''}<div><b>${esc(x.team?.abbreviation||'NFL')}</b><span>${esc(x.group?.display_name||x.group?.name||'Player stats')}</span></div></header><div>${x.rows.map((r,rowIndex)=>{const a=r?.athlete||{},vals=arr(r?.stats).slice(0,6);return `<article class="cast6-stat-row ${rowIndex%2?'alt':''}"><div class="cast6-stat-player">${a?.headshot?`<img src="${esc(a.headshot)}" alt="${esc(a.name||'Player')}" loading="lazy" decoding="async">`:''}<span><b>${esc(a?.name||'Player')}</b><small>${esc([a?.position,r?.starter?'Starter':null].filter(Boolean).join(' · '))}</small></span></div><div class="cast6-stat-values">${vals.map((v,i)=>`<span><small>${esc(labels[i]||i+1)}</small><b>${esc(v)}</b></span>`).join('')}</div></article>`}).join('')}</div></section>`}

  function playMeta(p){return [p?.period?`Q${p.period}`:null,clean(p?.clock),clean(p?.end?.down_distance_text)||clean(p?.start?.down_distance_text)].filter(Boolean)}
  function playRow(p){const meta=playMeta(p);const score=p?.away_score!=null&&p?.home_score!=null?`${p.away_score}–${p.home_score}`:'';return `<article class="cast6-play ${p?.scoring_play?'scoring':''} ${turnover(p)?'turnover':''}" data-play-id="${esc(p?.id||'')}"><div class="cast6-play-meta">${meta.map((m,i)=>`<span class="${i===2?'down':''}">${esc(m)}</span>`).join('')}</div><div class="cast6-play-copy"><b>${esc(clean(p?.type)||'PLAY')}</b><p>${esc(clean(p?.text)||'Play detail unavailable')}</p></div>${score?`<strong>${esc(score)}</strong>`:''}</article>`}
  function liveFeedHtml(){const rows=[...arr(state.detail?.plays)].reverse();return `<section class="cast6-module cast6-feed"><header><div><span>FULL GAME LOG</span><h2>Live Play-by-Play</h2></div><small>${rows.length} published plays · latest first</small></header><div class="cast6-feed-scroll">${rows.length?rows.map(playRow).join(''):`<div class="cast6-empty"><b>Play-by-play unavailable</b><span>No published plays are available for this game.</span></div>`}</div></section>`}

  function driveModuleHtml(){const d=state.detail?.current_drive,plays=arr(d?.plays);return `<section class="cast6-module cast6-possession"><header><div><span>CURRENT POSSESSION</span><h2>Drive-by-Drive</h2></div><small>${esc(clean(d?.description))}</small></header><div class="cast6-drive-scroll">${d?`${d?.team?`<div class="cast6-possession-head">${d.team.logo?`<img src="${esc(d.team.logo)}" alt="" decoding="async">`:''}<div><b>${esc(d.team.abbreviation||d.team.display_name||'POSSESSION')}</b><span>${esc(clean(d.result)||'Drive in progress')}</span></div></div>`:''}${plays.length?plays.map(playRow).join(''):`<div class="cast6-empty compact"><span>Waiting for the first published snap of this drive.</span></div>`}`:`<div class="cast6-empty"><b>No active possession</b><span>The panel collapses its empty telemetry instead of inventing values.</span></div>`}</div></section>`}

  function workspaceHtml(){return `<div class="cast6-workspace"><div>${driveModuleHtml()}${liveFeedHtml()}</div><div>${playerOutputHtml()}</div></div>`}

  function railHtml(){return `<div class="cast6-rail">${games().map(g=>{const a=g?.teams?.away||{},h=g?.teams?.home||{},active=String(g.id)===String(state.activeId);return `<button data-game="${esc(g.id)}" class="${active?'active':''}"><span>${esc(g?.status?.semantics||'NFL')} · ${esc(statusLabel(g))}</span><div><b>${esc(a.abbreviation||'AWY')}</b><strong>${esc(score(a,g?.status?.semantics))}</strong><i>at</i><b>${esc(h.abbreviation||'HME')}</b><strong>${esc(score(h,g?.status?.semantics))}</strong></div><small>${esc(g?.venue?.name||fmtDate(g?.date)||'NFL game')}</small></button>`}).join('')}</div>`}

  function toolbarHtml(){return `<div class="cast6-top"><div class="cast6-brand"><span>⚡</span><div><h1>PBE<em>cast</em> NFL</h1><p>Live football command center</p></div></div><div class="cast6-actions"><button data-sound class="${state.sound?'on':''}">${state.sound?'🔊 Audio Alerts On':'🔇 Audio Alerts Off'}</button><button data-refresh>↻ Refresh</button></div></div>`}

  function ensureRoot(){
    const vc=document.getElementById('view-container');if(!vc)return null;
    let root=vc.querySelector('.pbecast6');
    if(!root){vc.innerHTML=`<section class="pbecast6" data-stale="false"><div data-cast6-toolbar></div><div data-cast6-rail></div><div data-cast6-hero></div><div data-cast6-action></div><div data-cast6-telemetry></div><div data-cast6-workspace></div></section>`;root=vc.querySelector('.pbecast6');wireRoot(root)}
    return root;
  }
  function patch(root,selector,html){const host=root?.querySelector(selector);if(!host)return;const sig=String(html);if(host.dataset.sig===sig)return;const scroll=host.scrollTop;host.innerHTML=html;host.dataset.sig=sig;if(scroll)host.scrollTop=scroll}
  function patchToolbar(){const root=document.querySelector('.pbecast6');if(root)patch(root,'[data-cast6-toolbar]',toolbarHtml())}
  function patchAll(){const root=ensureRoot();if(!root)return;root.dataset.stale=state.error?'true':'false';patch(root,'[data-cast6-toolbar]',toolbarHtml());patch(root,'[data-cast6-rail]',railHtml());if(state.detail){patch(root,'[data-cast6-hero]',heroHtml());patch(root,'[data-cast6-action]',currentActionHtml());patch(root,'[data-cast6-telemetry]',coverageHtml());patch(root,'[data-cast6-workspace]',workspaceHtml())}else{patch(root,'[data-cast6-hero]',`<div class="cast6-empty"><b>Loading game package</b><span>Connecting to live drives, player output and play-by-play.</span></div>`);patch(root,'[data-cast6-action]','');patch(root,'[data-cast6-telemetry]','');patch(root,'[data-cast6-workspace]','')}}
  function patchStats(){const root=document.querySelector('.pbecast6');if(!root)return;const host=root.querySelector('[data-cast6-workspace]');if(host)patch(root,'[data-cast6-workspace]',workspaceHtml())}

  function wireRoot(root){
    root.addEventListener('click',event=>{
      const game=event.target.closest('[data-game]');if(game){focus(game.dataset.game);return}
      if(event.target.closest('[data-sound]')){toggleSound();return}
      if(event.target.closest('[data-refresh]')){refresh(true);return}
      const filter=event.target.closest('[data-stat-filter]');if(filter){state.statFilter=filter.dataset.statFilter;patchStats();return}
    });
  }

  function namesMatch(a,b){const x=String(a||'').toLowerCase(),y=String(b||'').toLowerCase();if(!x||!y)return false;const ax=x.split(' ').pop(),by=y.split(' ').pop();return x===y||x.includes(y)||y.includes(x)||ax===by}
  function oddsRows(payload){if(Array.isArray(payload))return payload;for(const k of ['events','games','data','results','odds'])if(Array.isArray(payload?.[k]))return payload[k];return[]}
  function oddsEvent(raw){return{id:String(raw?.id||raw?.event_id||raw?.eventId||''),away:String(raw?.away_team||raw?.away||raw?.awayTeam||''),home:String(raw?.home_team||raw?.home||raw?.homeTeam||'')}}
  async function loadMarket(force=false){
    const d=state.detail;if(!d?.game)return;if(!force&&Date.now()-state.lastMarketAt<30000)return;state.lastMarketAt=Date.now();state.market=null;state.marketEvent=null;
    const a=d.game.teams?.away||{},h=d.game.teams?.home||{};
    try{const payload=await getJson(`${NFL_API}/api/odds`);const hit=oddsRows(payload).map(oddsEvent).find(e=>e.id&&((namesMatch(e.away,a.display_name)||namesMatch(e.away,a.abbreviation))&&(namesMatch(e.home,h.display_name)||namesMatch(e.home,h.abbreviation))));if(!hit)return;state.marketEvent=hit;state.market=await getJson(`${NFL_API}/api/odds/board?event_id=${encodeURIComponent(hit.id)}&markets=${MARKETS.join(',')}`)}catch(_){state.market=null;state.marketEvent=null}
  }

  async function fetchActive(){if(!state.activeId){state.detail=null;return}const d=await getJson(`${LIVE_API}?event=${encodeURIComponent(state.activeId)}`);const before=state.lastPlayId,after=d?.current_play?.id||null;state.detail=d;state.lastPlayId=after;if(before&&after&&before!==after&&state.sound)playCue(cueFor(d.current_play));await loadMarket(false)}
  function schedule(){clearTimeout(state.poll);const delay=isLive()?5000:15000;state.poll=setTimeout(()=>{if(document.querySelector('.pbecast6'))refresh(false)},delay)}
  async function refresh(manual=false){
    if(state.loading)return;state.loading=true;
    try{const scoreboard=await getJson(`${LIVE_API}?date=${encodeURIComponent(state.date||sportsDay())}`);state.scoreboard=scoreboard;state.activeId=chooseActive();persist();await fetchActive();state.error=null;patchAll()}
    catch(error){state.error=error instanceof Error?error.message:String(error);patchAll()}
    finally{state.loading=false;schedule()}
  }
  async function focus(id){state.activeId=String(id);state.detail=null;state.market=null;state.lastMarketAt=0;persist();patchAll();try{await fetchActive();state.error=null}catch(error){state.error=error instanceof Error?error.message:String(error)}patchAll();schedule()}
  async function load(){
    clearTimeout(window.PBEcastV4?.state?.poll);clearTimeout(state.poll);state.date=sportsDay();restore();ensureRoot();patchAll();await refresh(true)
  }
  function install(){if(!window.App?.VIEWS)return false;clearTimeout(window.PBEcastV4?.state?.poll);App.VIEWS.pbecast=load;state.installed=true;if(document.querySelector('.pbecast4,.pbecast6'))setTimeout(load,20);return true}

  window.PBEcastV6={state,load,refresh,focus,toggleSound};
  if(!install())document.addEventListener('DOMContentLoaded',install,{once:true});
})();