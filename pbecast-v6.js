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
    loading:false,poll:null,lastPlayId:null,lastMarketAt:0,sound:false,audioCtx:null,statFilter:'all',installed:false,
    /* live-sync bookkeeping: see the synchronisation block below */
    syncing:false,lastSyncAt:0,playAnchor:null,rejected:0,
    /* the two lanes keep separate views of the game; promoteGame() merges */
    fastGame:null,detailGame:null,fastSource:null,fastAt:0,detailAt:0,
    lastFastChangeAt:0,lastDetailChangeAt:0
  };

  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const arr=v=>Array.isArray(v)?v:[];
  const clean=v=>{const s=String(v??'').trim();return !s||BAD.test(s)?'':s};
  const num=v=>v===null||v===undefined||v===''?null:(Number.isFinite(Number(v))?Number(v):null);

  function sportsDay(){const d=new Date(Date.now()-3*3600000);return d.toLocaleDateString('en-CA',{timeZone:'America/New_York'}).replaceAll('-','')}
  async function getJson(url,signal){const r=await fetch(url,{cache:'no-store',headers:{accept:'application/json'},signal});const text=await r.text();if(!r.ok)throw new Error(`${r.status} ${text.slice(0,140)}`);try{return JSON.parse(text)}catch{throw new Error('non_json_response')}}
  function games(){return arr(state.scoreboard?.games)}
  function semantics(d=state.detail){return String(d?.source?.semantics||d?.game?.status?.semantics||'UNAVAILABLE').toUpperCase()}
  function isLive(d=state.detail){return semantics(d)==='LIVE'}
  function fmtDate(v){if(!v)return'';const d=new Date(v);if(Number.isNaN(d.getTime()))return'';return d.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/New_York'})+' ET'}
  function sourceLabel(d){const provider=String(d?.source?.provider||'').toLowerCase();return provider.includes('espn')?'ESPN LIVE':clean(d?.source?.provider)||'LIVE SOURCE'}
  function statusLabel(g){const s=g?.status||{};if(s.semantics==='LIVE')return clean(s.short_detail)||clean(s.detail)||`Q${s.period||''} ${s.clock||''}`.trim();if(s.semantics==='FINAL')return clean(s.short_detail)||'FINAL';return clean(s.short_detail)||fmtDate(g?.date)||'SCHEDULED'}
  /* A game that has not kicked off has no score. A dash in a 84px score slot
     read as a broken feed; the slot is empty and the kickoff carries the fact. */
  function score(team,sem){return sem==='SCHEDULE'?'':(team?.score??'—')}
  function kickoffParts(v){if(!v)return null;const d=new Date(v);if(Number.isNaN(d.getTime()))return null;
    return{time:d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}),
      day:d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'America/New_York'})}}
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

  /* Freshness is reported, never hidden. But play age on its own cannot tell a
     slow feed from a stopped game: a timeout, the two-minute warning or a
     replay review legitimately leaves the newest play minutes old with nothing
     wrong upstream. So we only call it a source delay when the game clock has
     moved on since that play landed — proof the game continued without the
     feed telling us. */
  function freshnessBadge(){
    const sem=semantics(state.detail);
    if(sem!=='LIVE')return {label:`${sem} · PBECAST`,cls:''};
    const age=num(state.detail?.source?.play_age_seconds);
    if(age==null||!clockMovedSincePlay())return {label:'LIVE · PBECAST',cls:'on'};
    if(age<=FRESH_OK)return {label:'LIVE · LOW LATENCY',cls:'on is-fresh'};
    if(age<=FRESH_BAD)return {label:`LIVE · SOURCE DELAY ${Math.round(age)}s`,cls:'on is-lagging'};
    return {label:'LIVE · FEED DELAYED',cls:'on is-delayed'};
  }
  function syncNote(){
    const d=state.detail;
    const stamp=clean(d?.source?.fetched_at)?`UPDATED ${new Date(d.source.fetched_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit',second:'2-digit'})}`:'';
    if(state.error){
      const age=state.lastSyncAt?Math.round((Date.now()-state.lastSyncAt)/1000):null;
      return `${stamp}${stamp?' · ':''}STALE${age!=null?` ${age}s`:''}`;
    }
    return `${stamp}${state.syncing?' · SYNCING':''}`;
  }

  function heroHtml(){
    const d=state.detail,g=d?.game||{},a=g?.teams?.away||{},h=g?.teams?.home||{},sem=semantics(d),facts=situationFacts(d);
    const fresh=freshnessBadge();
    return `<section class="cast6-hero"><div class="cast6-hero-head"><div><span class="cast6-live ${fresh.cls}">${sem==='LIVE'?'<i></i>':''}${esc(fresh.label)}</span><b>${esc(sourceLabel(d))}</b></div><small data-cast6-stamp></small></div><div class="cast6-score"><div class="cast6-team">${teamLogo(a)}<span><b>${esc(a.abbreviation||'AWY')}</b><small>${esc(a.display_name||'Away')}${teamRecord(a)?` · ${esc(teamRecord(a))}`:''}</small></span></div><div class="cast6-score-center">${sem==='SCHEDULE'&&kickoffParts(g?.date)?`<strong class="is-kickoff">${esc(kickoffParts(g.date).time)}<small>ET</small></strong><span><em class="cast6-kick-k">Kickoff · </em>${esc(kickoffParts(g.date).day)}</span>`:`<strong>${esc(score(a,sem))}<i>:</i>${esc(score(h,sem))}</strong><span>${esc(statusLabel(g))}</span>`}<small>${esc([g?.venue?.name,[g?.venue?.city,g?.venue?.state].filter(Boolean).join(', ')].filter(Boolean).join(' · '))}</small></div><div class="cast6-team home"><span><b>${esc(h.abbreviation||'HME')}</b><small>${esc(h.display_name||'Home')}${teamRecord(h)?` · ${esc(teamRecord(h))}`:''}</small></span>${teamLogo(h)}</div></div>${facts.length?`<div class="cast6-facts">${facts.map(([k,v])=>`<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>`:''}</section>`;
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
  function playRow(p){const meta=playMeta(p);const score=p?.away_score!=null&&p?.home_score!=null?`${p.away_score}–${p.home_score}`:'';return `<article class="cast6-play ${p?.scoring_play?'scoring':''} ${turnover(p)?'turnover':''}"><div class="cast6-play-meta">${meta.map((m,i)=>`<span class="${i===2?'down':''}">${esc(m)}</span>`).join('')}</div><div class="cast6-play-copy"><b>${esc(clean(p?.type)||'PLAY')}</b><p>${esc(clean(p?.text)||'Play detail unavailable')}</p></div>${score?`<strong>${esc(score)}</strong>`:''}</article>`}
  function liveFeedHtml(){const rows=[...arr(state.detail?.plays)].reverse();return `<section class="cast6-module cast6-feed"><header><div><span>FULL GAME LOG</span><h2>Live Play-by-Play</h2></div><small>${rows.length} published plays · latest first</small></header><div class="cast6-feed-scroll">${rows.length?rows.map(playRow).join(''):`<div class="cast6-empty"><b>Play-by-play unavailable</b><span>No published plays are available for this game.</span></div>`}</div></section>`}

  function driveModuleHtml(){const d=state.detail?.current_drive,plays=arr(d?.plays);return `<section class="cast6-module cast6-possession"><header><div><span>CURRENT POSSESSION</span><h2>Drive-by-Drive</h2></div><small>${esc(clean(d?.description))}</small></header><div class="cast6-drive-scroll">${d?`${d?.team?`<div class="cast6-possession-head">${d.team.logo?`<img src="${esc(d.team.logo)}" alt="" decoding="async">`:''}<div><b>${esc(d.team.abbreviation||d.team.display_name||'POSSESSION')}</b><span>${esc(clean(d.result)||'Drive in progress')}</span></div></div>`:''}${plays.length?plays.map(playRow).join(''):`<div class="cast6-empty compact"><span>Waiting for the first published snap of this drive.</span></div>`}`:`<div class="cast6-empty"><b>No active possession</b><span>The panel collapses its empty telemetry instead of inventing values.</span></div>`}</div></section>`}

  function workspaceHtml(){return `<div class="cast6-workspace"><div>${driveModuleHtml()}${liveFeedHtml()}</div><div>${playerOutputHtml()}</div></div>`}

  function railHtml(){return `<div class="cast6-rail">${games().map(g=>{const a=g?.teams?.away||{},h=g?.teams?.home||{},active=String(g.id)===String(state.activeId);return `<button data-game="${esc(g.id)}" class="${active?'active':''} ${g?.status?.semantics==='SCHEDULE'?'is-scheduled':''}"><span>${esc(g?.status?.semantics==='SCHEDULE'?'SCHEDULED':g?.status?.semantics||'NFL')} · ${esc(g?.status?.semantics==='SCHEDULE'&&kickoffParts(g?.date)?`${kickoffParts(g.date).day} · ${kickoffParts(g.date).time} ET`:statusLabel(g))}</span><div><b>${esc(a.abbreviation||'AWY')}</b><strong>${esc(score(a,g?.status?.semantics))}</strong><i>at</i><b>${esc(h.abbreviation||'HME')}</b><strong>${esc(score(h,g?.status?.semantics))}</strong></div><small>${esc(g?.venue?.name||fmtDate(g?.date)||'NFL game')}</small></button>`}).join('')}</div>`}

  function toolbarHtml(){return `<div class="cast6-top"><div class="cast6-brand"><span>⚡</span><div><h1>PBE<em>cast</em> NFL</h1><p>Live football command center</p></div></div><div class="cast6-actions"><button data-sound class="${state.sound?'on':''}">${state.sound?'🔊 Audio Alerts On':'🔇 Audio Alerts Off'}</button><button data-refresh>↻ Refresh</button></div></div>`}

  function ensureRoot(){
    const vc=document.getElementById('view-container');if(!vc)return null;
    let root=vc.querySelector('.pbecast6');
    if(!root){vc.innerHTML=`<section class="pbecast6" data-stale="false"><div data-cast6-toolbar></div><div data-cast6-rail></div><div data-cast6-hero></div><div data-cast6-action></div><div data-cast6-telemetry></div><div data-cast6-workspace></div></section>`;root=vc.querySelector('.pbecast6');wireRoot(root)}
    return root;
  }
  function patch(root,selector,html){const host=root?.querySelector(selector);if(!host)return;const sig=String(html);if(host.dataset.sig===sig)return;const scroll=host.scrollTop;host.innerHTML=html;host.dataset.sig=sig;if(scroll)host.scrollTop=scroll}
  function patchToolbar(){const root=document.querySelector('.pbecast6');if(root)patch(root,'[data-cast6-toolbar]',toolbarHtml())}
  /* Targeted patches for the fast lane: the sections a live frame can actually
     change, and nothing else. patch() already no-ops on an identical
     signature, so an unchanged play does not touch the DOM at all. */
  function patchLive(){
    const root=document.querySelector('.pbecast6');if(!root||!state.detail)return;
    root.dataset.stale=state.error?'true':'false';
    patch(root,'[data-cast6-hero]',heroHtml());
    patch(root,'[data-cast6-action]',currentActionHtml());
    patch(root,'[data-cast6-workspace]',workspaceHtml());
    patchStamp();
  }
  function patchRail(){const root=document.querySelector('.pbecast6');if(root)patch(root,'[data-cast6-rail]',railHtml())}
  /* The "updated at" stamp and the SYNCING flag change on every tick. Left
     inside the hero's markup they would rewrite the whole hero — team logos
     included — twice a cycle, which is the flicker this work exists to remove.
     They live in their own node and are written as text, never innerHTML, so a
     background sync touches one text node and nothing else. */
  function patchStamp(){
    const el=document.querySelector('.pbecast6 [data-cast6-stamp]');if(!el)return;
    const next=syncNote();
    if(el.textContent!==next)el.textContent=next;
    el.classList.toggle('is-stale',!!state.error);
    el.classList.toggle('is-syncing',!!state.syncing&&!state.error);
  }
  function patchFreshness(){
    const root=document.querySelector('.pbecast6');if(!root||!state.detail)return;
    root.dataset.stale=state.error?'true':'false';
    patch(root,'[data-cast6-hero]',heroHtml());
    patchStamp();
  }
  function patchAll(){const root=ensureRoot();if(!root)return;root.dataset.stale=state.error?'true':'false';patch(root,'[data-cast6-toolbar]',toolbarHtml());patch(root,'[data-cast6-rail]',railHtml());if(state.detail){patch(root,'[data-cast6-hero]',heroHtml());patch(root,'[data-cast6-action]',currentActionHtml());patch(root,'[data-cast6-telemetry]',coverageHtml());patch(root,'[data-cast6-workspace]',workspaceHtml())}else{patch(root,'[data-cast6-hero]',`<div class="cast6-empty"><b>Loading game package</b><span>Connecting to live drives, player output and play-by-play.</span></div>`);patch(root,'[data-cast6-action]','');patch(root,'[data-cast6-telemetry]','');patch(root,'[data-cast6-workspace]','')}patchStamp()}
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
    /* the market is read once per game, not on the play-by-play cadence: it is a scheduled snapshot served by the odds authority */
    const d=state.detail;if(!d?.game)return;const gameKey=String(d.game.id||d.game.game_id||'');if(!force&&state.marketGameKey===gameKey)return;state.marketGameKey=gameKey;state.lastMarketAt=Date.now();state.market=null;state.marketEvent=null;
    const a=d.game.teams?.away||{},h=d.game.teams?.home||{};
    try{const payload=await getJson(`${NFL_API}/api/odds`);const hit=oddsRows(payload).map(oddsEvent).find(e=>e.id&&((namesMatch(e.away,a.display_name)||namesMatch(e.away,a.abbreviation))&&(namesMatch(e.home,h.display_name)||namesMatch(e.home,h.abbreviation))));if(!hit)return;state.marketEvent=hit;state.market=await getJson(`${NFL_API}/api/odds/board?event_id=${encodeURIComponent(hit.id)}&markets=${MARKETS.join(',')}`)}catch(_){state.market=null;state.marketEvent=null}
  }

  /* ---- Live synchronisation -----------------------------------------------
     Three independent lanes, because they change at three different speeds and
     nothing here should wait on anything slower than itself. The old loop
     fetched the whole day's scoreboard, then serially the active game, then
     scheduled the next round — so the active game could only ever be as fresh
     as a scoreboard request it did not need.

       live    the active game's state and current play   ~2.5s while LIVE
       detail  box score, leaders, win probability, log     ~12s while LIVE
       board   the day's game rail                          ~12s while LIVE

     Every lane is background work: it patches values in place and never
     clears .pbecast6, never nulls state.detail, and never re-mounts the route.
     Only the first visit to an unpainted game shows a skeleton. */
  const CADENCE={state:{on:2000,off:15000},live:{on:3000,off:15000},detail:{on:12000,off:30000},board:{on:12000,off:30000}};
  const FRESH_OK=30,FRESH_BAD=120;
  const lanes={state:{gen:0,timer:null,busy:false,ctrl:null},live:{gen:0,timer:null,busy:false,ctrl:null},detail:{gen:0,timer:null,busy:false,ctrl:null},board:{gen:0,timer:null,busy:false,ctrl:null}};

  const mounted=()=>!!document.querySelector('.pbecast6');
  const visible=()=>document.visibilityState!=='hidden';

  function clockSeconds(v){const m=/^(\d+):(\d{2})$/.exec(String(v??'').trim());return m?Number(m[1])*60+Number(m[2]):null}
  function playStamp(d){const w=Date.parse(d?.source?.latest_play_wallclock||d?.current_play?.wallclock||'');return Number.isFinite(w)?w:null}
  function totalScore(d){return (num(d?.game?.teams?.away?.score)??0)+(num(d?.game?.teams?.home?.score)??0)}

  /* ---- Two lanes, two clocks ----------------------------------------------
     The scoreboard reaches Q4 while the summary is still finishing Q3, so the
     two lanes genuinely disagree about the present and each has to be judged
     against its own history. A summary response is not "backwards" because
     the fast lane has already moved on — it is simply the slower lane doing
     its job — but it must not be allowed to drag score, clock or possession
     back when it lands. So each lane keeps its own last-known game, each is
     guarded against its own past, and promoteGame() decides which one the
     screen actually shows. */
  function progressOf(g){
    const st=g?.status||{};
    const p=num(st.period);if(p==null)return -1;
    const l=clockSeconds(st.clock);
    return p*10000+(l==null?0:(900-Math.min(900,l)));
  }
  function scoreOf(g){return (num(g?.teams?.away?.score)??0)+(num(g?.teams?.home?.score)??0)}
  function aheadOf(a,b){                       // is a strictly later than b?
    if(!b)return true; if(!a)return false;
    const pa=progressOf(a),pb=progressOf(b);
    if(pa!==pb)return pa>pb;
    return scoreOf(a)>scoreOf(b);
  }
  function laneRegresses(g,prev){
    if(!g||!prev)return false;
    if(String(g.id||'')!==String(prev.id||''))return false;
    const pg=progressOf(g),pp=progressOf(prev);
    if(pg<pp)return true;
    if(pg===pp&&scoreOf(g)<scoreOf(prev))return true;
    return false;
  }
  /* The screen shows whichever lane is further into the game. */
  function promoteGame(){
    const winner=aheadOf(state.fastGame,state.detailGame)?state.fastGame:(state.detailGame||state.fastGame);
    if(!winner)return;
    if(!state.detail)state.detail={};
    state.detail.game=winner;
    if(!state.detail.source&&state.fastSource)state.detail.source=state.fastSource;
  }

  function regresses(next){
    const cur=state.detail;
    if(!cur||!next?.game)return false;
    if(String(next.game.id||'')!==String(cur?.game?.id||''))return false;   // different game entirely
    const nw=playStamp(next),cw=playStamp(cur);
    if(nw!=null&&cw!=null&&nw<cw)return true;
    const np=num(next?.game?.status?.period),cp=num(cur?.game?.status?.period);
    if(np!=null&&cp!=null){
      if(np<cp)return true;
      if(np===cp){
        const nl=clockSeconds(next?.game?.status?.clock),cl=clockSeconds(cur?.game?.status?.clock);
        if(nl!=null&&cl!=null&&nl>cl)return true;                            // more time left = earlier
      }
    }
    if(totalScore(next)<totalScore(cur))return true;
    return false;
  }

  /* Later views of a play may be thinner than the one already held — a lane
     that carries no participants must not strip the actors off a play the
     richer lane already described. */
  function mergePlay(prev,next){
    if(!prev)return next;
    const merged={...prev,...next};
    if(!arr(next?.participants).length&&arr(prev?.participants).length)merged.participants=prev.participants;
    return merged;
  }
  function mergePlays(...groups){
    const map=new Map(arr(state.detail?.plays).map(p=>[String(p.id),p]));
    groups.forEach(g=>arr(g).forEach(p=>{if(p?.id)map.set(String(p.id),mergePlay(map.get(String(p.id)),p))}));
    return [...map.values()].sort((a,b)=>(num(a.sequence)??0)-(num(b.sequence)??0));
  }

  /* Remember where the game clock stood when the newest play landed, so the
     freshness badge can tell a slow feed from a stopped game. */
  function anchorPlay(d){
    const id=d?.current_play?.id||null;
    if(!id||state.playAnchor?.id===id)return;
    const st=d?.game?.status||{};
    state.playAnchor={id,period:num(st.period),left:clockSeconds(st.clock)};
  }
  function clockMovedSincePlay(){
    const a=state.playAnchor;if(!a||a.period==null||a.left==null)return false;
    const st=state.detail?.game?.status||{};
    const p=num(st.period),l=clockSeconds(st.clock);
    if(p==null||l==null)return false;
    /* A period boundary is not evidence of a slow feed — halftime leaves the
       last Q2 play ten minutes old with nothing wrong. Only game time actually
       running on within the same period counts. */
    if(p!==a.period)return false;
    return (a.left-l)>=20;
  }

  /* The fast lane: score, period, clock, possession, down, distance, yard
     line, timeouts. Nothing here waits on the summary. */
  function applyFast(d){
    const g=d?.game;
    if(!g){state.rejected=(state.rejected||0)+1;return false}
    if(state.activeId&&String(g.id||'')!==String(state.activeId)){state.rejected=(state.rejected||0)+1;return false}
    if(laneRegresses(g,state.fastGame)){state.rejected=(state.rejected||0)+1;return false}
    const moved=!state.fastGame||progressOf(g)!==progressOf(state.fastGame)||scoreOf(g)!==scoreOf(state.fastGame);
    state.fastGame=g;
    state.fastSource=d.source||null;
    state.fastAt=Date.now();
    if(moved)state.lastFastChangeAt=Date.now();
    promoteGame();
    state.error=null;
    return true;
  }

  /* ---- Freshness telemetry ------------------------------------------------
     Two lanes means two different answers, and collapsing them into one number
     is what let a four-minute lag hide behind a current fetched_at. The fast
     lane cannot date itself — the scoreboard's lastPlay carries no wallclock —
     so its age is recovered by joining its play id against the plays lane,
     which does. When that id is not in the play log yet, the fast lane is
     simply ahead of anything we can date, and that is what it reports. */
  function telemetry(){
    const now=Date.now();
    const plays=arr(state.detail?.plays);
    const fastPlayId=state.fastSource?.last_play_id||null;
    const hit=fastPlayId?plays.find(p=>String(p.id)===String(fastPlayId)):null;
    const hitWall=hit?.wallclock?Date.parse(hit.wallclock):NaN;
    const playWall=Date.parse(state.detail?.source?.latest_play_wallclock||state.detail?.current_play?.wallclock||'');
    const age=t=>Number.isFinite(t)?Math.max(0,Math.round((now-t)/100)/10):null;
    return {
      fast_state_age_seconds:age(hitWall),
      fast_state_ahead_of_detail:!!(fastPlayId&&!hit),
      latest_play_age_seconds:age(playWall),
      fast_provider:state.fastSource?.provider||null,
      detail_provider:state.detail?.source?.provider||null,
      fast_fetched_at:state.fastSource?.fetched_at||null,
      detail_fetched_at:state.detail?.source?.fetched_at||null,
      latest_play_wallclock:state.detail?.source?.latest_play_wallclock||null,
      last_fast_change_at:state.lastFastChangeAt||null,
      last_detail_change_at:state.lastDetailChangeAt||null,
      rejected_stale_responses:state.rejected||0
    };
  }

  function applyLive(d,{sound=true}={}){
    if(!d?.game){state.rejected=(state.rejected||0)+1;return false}
    /* A response for a game we have since navigated away from must never land:
       switching games leaves the previous game's requests in flight, and they
       resolve after the new game's have already painted. */
    if(state.activeId&&String(d.game.id||'')!==String(state.activeId)){state.rejected=(state.rejected||0)+1;return false}
    const base=state.detail||{};
    const before=state.lastPlayId;

    /* Two different things arrive in these payloads and they need different
       rules. Accumulated history — the box score, leaders, win probability,
       the play log — is additive and stays valid even when it arrives from a
       slower lane, so it always merges. Live state is a claim about the
       current moment, so it only moves forward.

       Keeping them together is a bug: the detail lane fetches a payload an
       order of magnitude larger than the live lane, so it routinely resolves
       after a newer live frame has painted. Rejecting the whole response as a
       regression would mean the box score simply stopped updating. */
    const next={...base,
      plays:mergePlays(d.last_five_plays,d.current_drive?.plays,d.plays),
      player_stats:d.player_stats||base.player_stats,
      leaders:d.leaders||base.leaders,
      win_probability:d.win_probability||base.win_probability,
      drives:d.drives||base.drives};

    /* Judged against the DETAIL lane's own past, not against the merged screen.
       The fast lane is routinely a quarter ahead; treating that as this lane's
       regression would reject every summary response it ever made. */
    const forward=!laneRegresses(d.game,state.detailGame)&&!playRegresses(d);
    if(forward){
      const movedPlay=(d.current_play?.id||null)!==(base.current_play?.id||null);
      next.source=d.source||base.source;
      next.current_play=d.current_play??base.current_play;
      next.current_drive=d.current_drive||base.current_drive;
      next.last_five_plays=d.last_five_plays||base.last_five_plays;
      state.detailGame=d.game;
      state.detailAt=Date.now();
      if(movedPlay)state.lastDetailChangeAt=Date.now();
    }else state.rejected=(state.rejected||0)+1;

    state.detail=next;
    promoteGame();                      // fast vs detail decides what is painted
    if(forward){
      const after=next.current_play?.id||null;
      state.lastPlayId=after;
      anchorPlay(next);
      state.lastSyncAt=Date.now();
      if(sound&&before&&after&&before!==after&&state.sound)playCue(cueFor(next.current_play));
    }
    state.error=null;
    return forward;
  }

  /* The plays half of the detail lane has its own arrow of time. */
  function playRegresses(d){
    const nw=Date.parse(d?.source?.latest_play_wallclock||d?.current_play?.wallclock||'');
    const cw=Date.parse(state.detail?.source?.latest_play_wallclock||state.detail?.current_play?.wallclock||'');
    return Number.isFinite(nw)&&Number.isFinite(cw)&&nw<cw;
  }

  async function laneJson(name,url){
    const l=lanes[name];
    const gen=++l.gen;
    try{l.ctrl?.abort()}catch(_){}
    const ctrl=typeof AbortController==='function'?new AbortController():null;
    l.ctrl=ctrl;
    const body=await getJson(url,ctrl?.signal);
    if(gen!==l.gen)return null;                 // a newer request for this lane already went out
    return body;
  }

  function scheduleLane(name,fn){
    const l=lanes[name];
    clearTimeout(l.timer);
    /* A hidden tab holds no timers at all. Clearing them on visibilitychange
       is not enough on its own: a request already in flight when the tab is
       hidden re-arms its lane as it settles. */
    if(!mounted()||!visible())return;
    l.timer=setTimeout(()=>{if(mounted()&&visible())fn()},isLive()?CADENCE[name].on:CADENCE[name].off);
  }

  /* Fast state. Deliberately the smallest request PBEcast makes (~2KB) and the
     only one on the 2s cadence, so score, clock and possession never queue
     behind a box score. */
  async function syncState(){
    const l=lanes.state;
    if(l.busy||!state.activeId){scheduleLane('state',syncState);return}
    l.busy=true;
    try{
      const d=await laneJson('state',`${LIVE_API}?event=${encodeURIComponent(state.activeId)}&layer=state`);
      if(d&&applyFast(d))patchLive();
    }catch(error){
      if(error?.name!=='AbortError'){state.error=error instanceof Error?error.message:String(error);patchFreshness()}
    }finally{l.busy=false;scheduleLane('state',syncState)}
  }

  async function syncLive(){
    const l=lanes.live;
    if(l.busy||!state.activeId){scheduleLane('live',syncLive);return}
    l.busy=true;state.syncing=true;patchFreshness();
    try{
      const d=await laneJson('live',`${LIVE_API}?event=${encodeURIComponent(state.activeId)}&layer=live`);
      if(d){applyLive(d);patchLive()}
    }catch(error){
      if(error?.name!=='AbortError'){state.error=error instanceof Error?error.message:String(error);patchFreshness()}
    }finally{l.busy=false;state.syncing=false;patchFreshness();scheduleLane('live',syncLive)}
  }

  async function syncDetail(){
    const l=lanes.detail;
    if(l.busy||!state.activeId){scheduleLane('detail',syncDetail);return}
    l.busy=true;
    try{
      const d=await laneJson('detail',`${LIVE_API}?event=${encodeURIComponent(state.activeId)}`);
      if(d){applyLive(d,{sound:false});await loadMarket(false);patchAll()}
    }catch(error){
      if(error?.name!=='AbortError')state.error=error instanceof Error?error.message:String(error);
    }finally{l.busy=false;scheduleLane('detail',syncDetail)}
  }

  async function syncBoard(){
    const l=lanes.board;
    if(l.busy){scheduleLane('board',syncBoard);return}
    l.busy=true;
    try{
      const board=await laneJson('board',`${LIVE_API}?date=${encodeURIComponent(state.date||sportsDay())}`);
      if(board){
        state.scoreboard=board;
        const next=chooseActive();
        if(next&&next!==state.activeId){state.activeId=next;persist();resetGame();syncState();syncLive();syncDetail()}
        else{state.activeId=next||state.activeId;persist()}
        patchRail();
      }
    }catch(error){
      if(error?.name!=='AbortError')state.error=error instanceof Error?error.message:String(error);
    }finally{l.busy=false;scheduleLane('board',syncBoard)}
  }

  function stopLanes(){Object.values(lanes).forEach(l=>{clearTimeout(l.timer);l.timer=null;try{l.ctrl?.abort()}catch(_){}})}

  /* Manual refresh and first mount both want everything now, in parallel. */
  async function refresh(manual=false){
    state.date=state.date||sportsDay();
    await Promise.all([syncBoard(),
      state.activeId?syncState():Promise.resolve(),
      state.activeId?syncLive():Promise.resolve(),
      state.activeId?syncDetail():Promise.resolve()]);
    if(!state.activeId&&state.scoreboard){state.activeId=chooseActive();persist();if(state.activeId)await Promise.all([syncState(),syncLive(),syncDetail()])}
    patchAll();
    return manual;
  }

  function resetGame(){
    state.detail=null;state.market=null;state.marketEvent=null;state.lastMarketAt=0;state.marketGameKey=null;
    state.lastPlayId=null;state.playAnchor=null;state.error=null;
    /* both lanes forget the previous game, or its progress would look like the
       new game's future and reject every real update */
    state.fastGame=null;state.detailGame=null;state.fastSource=null;
    state.fastAt=0;state.detailAt=0;state.lastFastChangeAt=0;state.lastDetailChangeAt=0;
  }

  /* Switching games is a deliberate act, not background polling: the previous
     game's score must not sit under the new game's name while it loads. */
  async function focus(id){
    if(String(id)===String(state.activeId))return;
    stopLanes();                       // drop the previous game's in-flight work
    state.activeId=String(id);
    resetGame();persist();patchAll();
    /* Restart every lane, the board included — it is what keeps the rail and
       the active-game choice in step, and dropping it here used to leave it
       stopped for the rest of the session. */
    await Promise.all([syncState(),syncLive(),syncDetail()]);
    syncBoard();
    patchAll();
  }
  /* GAME BREAK -> PBEcast. The breaking rail leaves a one-shot focus request
     in session storage before navigating here; it is consumed exactly once so
     a later visit to PBEcast is not dragged back to an old touchdown. The play
     id travels with it for a future play-level focus; today the GAME is
     focused, which is the correct game rather than whatever chooseActive would
     otherwise pick. */
  const FOCUS_KEY='pbe.pbecast.focus';
  function takeFocus(){
    try{
      const raw=sessionStorage.getItem(FOCUS_KEY);if(!raw)return null;
      sessionStorage.removeItem(FOCUS_KEY);
      const f=JSON.parse(raw);if(!f||!f.game_id)return null;
      state.activeId=String(f.game_id);state.focusPlayId=f.play_id?String(f.play_id):null;persist();
      return state.activeId;
    }catch(_){return null}
  }
  /* Mounting the route. state.detail survives a trip to another route, so
     returning to PBEcast repaints the last known game immediately and the
     lanes update it in place — the skeleton is only ever for a game we have
     never painted. */
  async function load(){
    stopLegacyTransports();stopLanes();
    state.date=sportsDay();restore();takeFocus();ensureRoot();patchAll();
    await refresh(true);
  }

  /* A hidden tab should not hold a 2.5s loop open against the live feed, and a
     tab coming back must not show a minutes-old score while it waits for the
     next tick. Sync once, immediately, on the way back in. */
  document.addEventListener('visibilitychange',()=>{
    if(!mounted())return;
    if(!visible()){stopLanes();return}
    syncState();syncLive();syncDetail();syncBoard();
  });

  /* v4 and v5 are out of the production runtime. If a stale cached copy of
     either is still executing in someone's tab, silence its transport and its
     observer rather than letting a second /api/nfl-live loop and a second
     renderer run against this route. A no-op in the normal case. */
  function stopLegacyTransports(){
    try{
      const v4=window.PBEcastV4;
      if(v4?.state?.poll){clearTimeout(v4.state.poll);v4.state.poll=null}
      window.PBEcastV5?.stop?.();
    }catch(_){}
  }

  /* The nav entry belongs to whichever module owns the route; it was v5's
     last, and v5 is retired. */
  function labelNav(){
    const nav=document.getElementById('nav-pbecast');
    if(nav)nav.innerHTML='<span class="ni-icon">⚡</span> PBEcast <span class="nav-badge" style="color:#62e2a1;background:rgba(98,226,161,.10)">LIVE DATA</span>';
  }

  function install(){
    if(!window.App?.VIEWS)return false;
    stopLegacyTransports();
    App.VIEWS.pbecast=load;
    state.installed=true;
    labelNav();
    document.addEventListener('DOMContentLoaded',labelNav,{once:true});
    if(document.querySelector('.pbecast4,.pbecast6'))setTimeout(load,20);
    return true;
  }

  window.PBEcastV6={state,load,refresh,focus,toggleSound,takeFocus,stopLegacyTransports,telemetry};
  if(!install())document.addEventListener('DOMContentLoaded',install,{once:true});
})();