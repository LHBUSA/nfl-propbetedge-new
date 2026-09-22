/* PropBetEdge NFL — PBEcast v6
 * Authoritative live command center. One renderer, silent polling, real audio cues.
 *
 * The selected-game hero carries the same game context as Games: the canonical
 * /api/schedule row for the selected ESPN event id (PBEBroadcast) turned into a
 * game by PBEGameContext.fromSchedule, and its environment row rendered by
 * PBEGameContext.environmentHtml from the one memoized /api/game-weather read.
 * No weather is requested or polled here.
 *
 * GAME IDENTITY. The selected game and the board are separate truths.
 *   selected game  one ESPN event id. An EXPLICIT selection (a click anywhere
 *                  that goes through PBEGameHandoff, or a click on this rail)
 *                  is authoritative: no board, date, persisted game or
 *                  provider week replaces it. It is read directly by id.
 *   board          context for the rail: the season contract's slate that
 *                  holds the selected game (primary, else previous), else the
 *                  selected game's own kickoff date; with nothing selected, the
 *                  primary slate. It may repaint the rail; it never changes an
 *                  explicit selection.
 *   default mode   only when nothing was selected: LIVE -> the next scheduled
 *                  game -> the most recent final. The persisted ACTIVE_KEY is a
 *                  preference inside that order, never above a fresh click.
 *
 * LIFECYCLE. One game id, one route, three presentations, chosen only by the
 * selected game's own semantics (root data-phase):
 *   SCHEDULE  PREGAME PREVIEW: hero with countdown, then the preview row
 *             (pbecast-preview-v1.js). The live-only panels (current play,
 *             drive, telemetry, drive log, box score, play-by-play) are empty by
 *             definition before kickoff and are not rendered.
 *   LIVE      the live command center, unchanged.
 *   FINAL     FINAL · REPLAY: Key Moments / PBE Replay and the game package.
 * When the lanes report the same game LIVE, the next patch renders the live
 * panels; nothing about the selection changes.
 */
(() => {
  'use strict';

  const LIVE_API='/api/nfl-live';
  const NFL_API=typeof NFL_API_GATEWAY!=='undefined'?NFL_API_GATEWAY:'https://nfl-api.propbetedge.ai';
  const PUBLIC_DATA_LABEL='PropSports.PropTechUSA.ai';
  const PUBLIC_DATA_URL='https://propsports.proptechusa.ai';
  const MARKETS=['player_pass_yds','player_rush_yds','player_reception_yds','player_receptions'];
  const SOUND_KEY='pbe_nfl_cast_sound_v6';
  const ACTIVE_KEY='pbe_nfl_cast_active_v6';
  const BAD=/^(?:null|undefined|n\/a|na|—|-|\?)$/i;

  const state={
    date:'',scoreboard:null,activeId:null,explicit:false,activeKickoff:null,preferredId:null,unavailable:null,boardUrl:null,detail:null,market:null,marketEvent:null,error:null,
    loading:false,poll:null,lastPlayId:null,lastMarketAt:0,sound:false,audioCtx:null,statFilter:'all',installed:false,
    /* FULL GAME LOG open/closed, in memory, per game id; absent = collapsed */
    feedOpen:new Map(),
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
  /* ET calendar date of an instant, YYYYMMDD; the provider's dated boards are ET days. */
  function etYmd(v){const t=v instanceof Date?v.getTime():Date.parse(v||'');return Number.isFinite(t)?new Date(t).toLocaleDateString('en-CA',{timeZone:'America/New_York'}).replaceAll('-',''):''}
  async function getJson(url,signal){const r=await fetch(url,{cache:'no-store',headers:{accept:'application/json'},signal});const text=await r.text();if(!r.ok)throw new Error(`${r.status} ${text.slice(0,140)}`);try{return JSON.parse(text)}catch{throw new Error('non_json_response')}}
  function games(){return arr(state.scoreboard?.games)}
  function semantics(d=state.detail){return String(d?.source?.semantics||d?.game?.status?.semantics||'UNAVAILABLE').toUpperCase()}
  function isLive(d=state.detail){return semantics(d)==='LIVE'}
  function fmtDate(v){if(!v)return'';const d=new Date(v);if(Number.isNaN(d.getTime()))return'';return d.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/New_York'})+' ET'}
  /* Public attribution is the PropSports product surface. Raw upstream
     provider identity remains in the response metadata for provenance/debugging. */
  function sourceLabel(){return PUBLIC_DATA_LABEL}
  function statusLabel(g){const s=g?.status||{};if(s.semantics==='LIVE')return clean(s.short_detail)||clean(s.detail)||`Q${s.period||''} ${s.clock||''}`.trim();if(s.semantics==='FINAL')return clean(s.short_detail)||'FINAL';return clean(s.short_detail)||fmtDate(g?.date)||'SCHEDULED'}
  /* A game that has not kicked off has no score. A dash in a 84px score slot
     read as a broken feed; the slot is empty and the kickoff carries the fact. */
  function score(team,sem){return sem==='SCHEDULE'?'':(team?.score??'—')}
  function kickoffParts(v){if(!v)return null;const d=new Date(v);if(Number.isNaN(d.getTime()))return null;
    return{time:d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}),
      day:d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'America/New_York'})}}
  function teamRecord(team){return arr(team?.records).find(r=>clean(r?.summary))?.summary||''}
  function teamLogo(team,size=62){return team?.logo?`<img src="${esc(team.logo)}" width="${size}" height="${size}" alt="${esc(team?.display_name||team?.abbreviation||'NFL')} logo" decoding="async">`:`<b>${esc(team?.abbreviation||'NFL')}</b>`}

  /* ACTIVE_KEY is a preference only: it is read into preferredId, never into
     activeId. The explicit selection of this tab session lives in
     SELECTED_KEY, so a reload or a trip to another route comes back to the
     game the reader chose. */
  const SELECTED_KEY='pbe.pbecast.selected';
  function restore(){
    try{state.sound=localStorage.getItem(SOUND_KEY)==='1';state.preferredId=localStorage.getItem(ACTIVE_KEY)||null}catch(_){}
    if(state.activeId&&state.explicit)return;
    try{const sel=JSON.parse(sessionStorage.getItem(SELECTED_KEY)||'null');
      if(sel&&/^\d+$/.test(String(sel.game_id||''))&&String(sel.game_id)!==String(state.activeId)){dropLanes(Object.keys(lanes));state.activeId=String(sel.game_id);state.activeKickoff=sel.kickoff||null;state.explicit=true;state.unavailable=null;resetGame()}
      else if(sel&&String(sel.game_id)===String(state.activeId))state.explicit=true;
    }catch(_){}
  }
  function persist(){try{localStorage.setItem(SOUND_KEY,state.sound?'1':'0');if(state.activeId&&state.explicit)localStorage.setItem(ACTIVE_KEY,String(state.activeId))}catch(_){}
    try{if(state.activeId&&state.explicit)sessionStorage.setItem(SELECTED_KEY,JSON.stringify({game_id:String(state.activeId),kickoff:state.activeKickoff||null}))}catch(_){}}

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

  /* DEFAULT MODE ONLY. Never called while a selection is explicit. Order:
     LIVE (the preferred game first) -> the game already on screen if it has
     not finished -> the preferred game if scheduled -> the contract's next game
     -> the earliest scheduled game -> a final already on screen -> the most
     recent final -> the contract's next game even when the board lacks it. */
  function chooseActive(){
    if(state.explicit&&state.activeId)return String(state.activeId);
    const rows=games(),by=id=>id?rows.find(g=>String(g.id)===String(id)):null;
    const sem=g=>String(g?.status?.semantics||'').toUpperCase(),kick=g=>Date.parse(g?.date||'')||0;
    const cur=by(state.activeId),pref=by(state.preferredId);
    const live=rows.filter(g=>sem(g)==='LIVE').sort((a,b)=>kick(a)-kick(b));
    if(live.length){if(pref&&sem(pref)==='LIVE')return String(pref.id);if(cur&&sem(cur)==='LIVE')return String(cur.id);return String(live[0].id)}
    if(cur&&sem(cur)==='SCHEDULE')return String(cur.id);
    if(pref&&sem(pref)==='SCHEDULE')return String(pref.id);
    const ng=window.PBESeason?.nextGame?.()||null;const ngRow=by(ng?.id);
    if(ngRow&&sem(ngRow)!=='FINAL')return String(ngRow.id);
    const sched=rows.filter(g=>sem(g)==='SCHEDULE').sort((a,b)=>kick(a)-kick(b))[0];if(sched)return String(sched.id);
    if(cur)return String(cur.id);
    const fin=rows.filter(g=>sem(g)==='FINAL').sort((a,b)=>kick(b)-kick(a))[0];if(fin)return String(fin.id);
    if(ng?.id)return String(ng.id);
    return rows[0]?String(rows[0].id):null;
  }
  /* The rail shows the board; an explicit game that is not on it is still shown, first. */
  function railGames(){const rows=games();const g=state.detail?.game;if(state.activeId&&g&&String(g.id)===String(state.activeId)&&!rows.some(r=>String(r.id)===String(state.activeId)))return [g,...rows];return rows}
  /* Board context. The contract's slates are read by their dates and kept to
     their week key; a selected game outside both is read by its ET kickoff date. */
  function boardContext(){
    const S=window.PBESeason?.data||null;
    const slates=[S?.primary_slate,S?.previous_slate].filter(x=>x?.key&&/^\d{8}-\d{8}$/.test(String(x.dates||'')));
    const slateCtx=x=>({url:`${LIVE_API}?range=${encodeURIComponent(x.dates)}&view=slate`,key:x.key,kind:'slate'});
    const kick=state.activeId?(state.activeKickoff||state.detail?.game?.date||null):null;
    if(state.explicit&&state.activeId){
      const day=etYmd(kick);
      if(day){const hit=slates.find(x=>{const [a,b]=x.dates.split('-');return day>=a&&day<=b});return hit?slateCtx(hit):{url:`${LIVE_API}?date=${day}`,key:null,kind:'date'}}
      if(slates.length)return slateCtx(slates[0]);
    }else if(slates.length)return slateCtx(slates[0]);
    return {url:`${LIVE_API}?date=${encodeURIComponent(state.date||sportsDay())}`,key:null,kind:'day'};
  }

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
  function actorHtml(p){const roles=[...(p.roles||[])];return `<article class="cast6-actor">${p?.headshot?`<img src="${esc(p.headshot)}" width="42" height="42" alt="${esc(p.name)}" decoding="async">`:`<div class="cast6-avatar">${esc(p.name.split(/\s+/).map(x=>x[0]||'').slice(0,2).join('').toUpperCase())}</div>`}<div><b>${esc(p.name)}</b><span>${esc([p?.position,...roles].filter(Boolean).join(' · ')||'NFL PLAYER')}</span></div></article>`}

  /* ---- Field-position semantics -------------------------------------------
     ESPN's situation.possessionText is the SPOT OF THE BALL ("DEN 39", "50"),
     not the team with the ball, and yardLine is a 0-100 coordinate (61 for the
     ball on DEN 39 with DEN in possession). Rendering them as POSSESSION and
     BALL showed "POSSESSION DEN 39 · BALL 61". So:
       possession      situation.possession_id matched to the away/home team
                       id, shown as that team's abbreviation, or nothing
       field position  ESPN's own published text, shown only when it verifies
                       as "<one of this game's two teams> <1-49>" or "50";
                       never derived from yard_line, never 100 - yard_line
       yard_line       internal geometry for the field strip only */
  function possessionTeam(g){
    const id=g?.situation?.possession_id;if(id==null||id==='')return null;
    const a=g?.teams?.away||{},h=g?.teams?.home||{};
    if(a.id!=null&&String(a.id)===String(id))return clean(a.abbreviation)||null;
    if(h.id!=null&&String(h.id)===String(id))return clean(h.abbreviation)||null;
    return null;
  }
  function fieldPositionText(g){
    const raw=String(g?.situation?.possession_text??'').trim().toUpperCase();
    if(raw==='50')return '50';
    const m=/^([A-Z]{2,4}) (\d{1,2})$/.exec(raw);if(!m)return null;
    const n=Number(m[2]);if(n<1||n>49)return null;
    const teams=[g?.teams?.away?.abbreviation,g?.teams?.home?.abbreviation].map(x=>String(x||'').toUpperCase()).filter(Boolean);
    return teams.includes(m[1])?`${m[1]} ${n}`:null;
  }
  function situationFacts(d){
    const g=d?.game||{},s=g?.situation||{},p=d?.current_play||s?.last_play||{};const facts=[];
    const possession=possessionTeam(g);if(possession)facts.push(['POSSESSION',possession]);
    const down=clean(s?.down_distance_text)||clean(p?.end?.down_distance_text)||clean(p?.start?.down_distance_text);if(down)facts.push(['DOWN & DISTANCE',down]);
    const spot=fieldPositionText(g);if(spot)facts.push(['FIELD POSITION',spot]);
    if(typeof s?.red_zone==='boolean')facts.push(['RED ZONE',s.red_zone?'YES':'NO']);
    const at=num(s?.away_timeouts),ht=num(s?.home_timeouts);if(at!==null||ht!==null)facts.push(['TIMEOUTS',`${at!==null?at:'–'} / ${ht!==null?ht:'–'}`]);
    return facts;
  }

  function fieldHtml(d){
    const p=d?.current_play||d?.game?.situation?.last_play||{},s=d?.game?.situation||{};
    const yte=num(p?.end?.yards_to_endzone??p?.start?.yards_to_endzone);const yard=num(s?.yard_line??p?.end?.yard_line??p?.start?.yard_line);
    let pos=yte!==null?100-yte:yard;if(pos===null)return'';pos=Math.max(2,Math.min(98,pos));
    const distance=num(p?.end?.distance??p?.start?.distance??s?.distance);const fd=distance!==null?Math.max(2,Math.min(98,pos+distance)):null;
    return `<div class="cast6-field"><div class="cast6-field-top"><span>${esc(fieldPositionText(d?.game)||'FIELD POSITION')}</span>${clean(s?.down_distance_text)?`<b>${esc(s.down_distance_text)}</b>`:''}</div><div class="cast6-field-surface"><i class="cast6-drive-fill" style="width:${pos}%"></i><i class="cast6-redzone"></i>${fd!==null?`<i class="cast6-first" style="left:${fd}%"></i>`:''}<i class="cast6-ball" style="left:${pos}%"></i></div></div>`;
  }

  /* Freshness is reported, never hidden. But play age on its own cannot tell a
     slow feed from a stopped game: a timeout, the two-minute warning or a
     replay review legitimately leaves the newest play minutes old with nothing
     wrong upstream. So we only call it a source delay when the game clock has
     moved on since that play landed — proof the game continued without the
     feed telling us. */
  function freshnessBadge(){
    const sem=semantics(state.detail);
    if(sem==='SCHEDULE')return {label:'PREGAME PREVIEW',cls:'is-pregame'};
    if(sem==='FINAL')return {label:'FINAL · REPLAY',cls:'is-final'};
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

  function gameContextHtml(g,a,h,sem){
    const B=window.PBEBroadcast,C=window.PBEGameContext;
    const id=g?.id?String(g.id):'';
    const loaded=Boolean(B?.state?.games?.length);
    const row=id&&loaded?B.find({event:id}):null;
    const liveVenue=g?.venue||{};
    const schedVenue=row?.venue?.status==='VERIFIED'?row.venue:null;
    const venueName=clean(liveVenue?.name)||clean(schedVenue?.name);
    const venueCity=clean(liveVenue?.city)||clean(schedVenue?.city);
    const venueState=clean(liveVenue?.state)||clean(schedVenue?.state);
    const venuePlace=[venueCity,venueState].filter(Boolean).join(', ');

    const venue=venueName
      ? `<div class="cast6-context-item is-venue"><span>VENUE</span><b>${esc(venueName)}</b>${venuePlace?`<small>${esc(venuePlace)}</small>`:''}</div>`
      : '';

    const watch=sem!=='FINAL'&&id
      ? `<div class="cast6-context-item is-watch"><span>WATCH</span><b>${B?.slot?.({event:id,away:a?.display_name,home:h?.display_name,mode:'link'})||`<span class="pbe-tv-slot" data-tv-event="${esc(id)}"></span>`}</b></div>`
      : '';

    let weather='';
    if(C&&row&&id){
      const ctx=C.fromSchedule(row,{state:sem,away_name:a?.display_name,home_name:h?.display_name});
      const model=C.environmentModel(ctx,C.state,{selectedEventId:id,scheduleLoading:!loaded&&!B?.state?.error&&!B?.state?.disabled});
      if(model&&model.kind!=='final'&&!['unavailable','pending'].includes(model.kind)){
        const detail=model.kind==='forecast'
          ? (model.lines||[]).join(' · ')
          : (model.detail||'');
        weather=`<div class="cast6-context-item is-weather" data-wx-stale="${model.stale?'true':'false'}"><span>LOCAL WEATHER</span><b>${esc(model.title||'Weather')}</b>${detail?`<small>${esc(detail)}</small>`:''}</div>`;
      }else if(model?.kind==='unavailable'){
        weather=`<div class="cast6-context-item is-weather is-muted"><span>LOCAL WEATHER</span><b>Updating local forecast</b><small>${esc(model.detail||'Weather feed is refreshing')}</small></div>`;
      }
    }

    return venue||watch||weather?`<div class="cast6-contextbar">${venue}${watch}${weather}</div>`:'';
  }

  /* Environment for the SELECTED game only: the schedule row is found by that
     game's ESPN event id (never by team names), and environmentHtml refuses a
     row or forecast for any other event. */
  function envHtml(){
    const C=window.PBEGameContext,B=window.PBEBroadcast;
    const g=state.detail?.game;if(!C||!g?.id)return'';
    const id=String(g.id);
    const loaded=Boolean(B?.state?.games?.length);
    const row=loaded?B.find({event:id}):null;
    const ctx=row?C.fromSchedule(row,{state:semantics(state.detail),away_name:g?.teams?.away?.display_name,home_name:g?.teams?.home?.display_name}):null;
    const opts={selectedEventId:id,scheduleLoading:!loaded&&!B?.state?.error&&!B?.state?.disabled};
    const model=C.environmentModel(ctx,C.state,opts);
    // PBECast is a live command center, not a diagnostics surface. Render only
    // useful game context; stale/missing/pending weather stays in API health.
    if(!['forecast','indoor','retractable'].includes(model?.kind))return'';
    return C.environmentHtml(ctx,C.state,opts);
  }

  function heroHtml(){
    const d=state.detail,g=d?.game||{},a=g?.teams?.away||{},h=g?.teams?.home||{},sem=semantics(d),facts=situationFacts(d);
    const fresh=freshnessBadge();
    const until=sem==='SCHEDULE'?window.PBEcastPreview?.countdown?.(g?.date):null;
    return `<section class="cast6-hero" data-cast6-game="${esc(g?.id||'')}"><div class="cast6-hero-head"><div><span class="cast6-live ${fresh.cls}">${sem==='LIVE'?'<i></i>':''}${esc(fresh.label)}</span>${until?`<em class="cast6-countdown${until.started?' is-due':''}">${esc(until.text)}</em>`:''}<a class="cast6-source-link" href="${esc(PUBLIC_DATA_URL)}" target="_blank" rel="noopener noreferrer" aria-label="Open PropSports.PropTechUSA.ai">${esc(sourceLabel(d))}<span aria-hidden="true">↗</span></a></div><small data-cast6-stamp></small></div><div class="cast6-score"><div class="cast6-team">${teamLogo(a)}<span><b>${esc(a.abbreviation||'AWY')}</b><small>${esc(a.display_name||'Away')}${teamRecord(a)?` · ${esc(teamRecord(a))}`:''}</small></span></div><div class="cast6-score-center">${sem==='SCHEDULE'&&kickoffParts(g?.date)?`<strong class="is-kickoff">${esc(kickoffParts(g.date).time)}<small>ET</small></strong><span><em class="cast6-kick-k">Kickoff · </em>${esc(kickoffParts(g.date).day)}</span>`:`<strong>${esc(score(a,sem))}<i>:</i>${esc(score(h,sem))}</strong><span>${esc(statusLabel(g))}</span>`}</div><div class="cast6-team home"><span><b>${esc(h.abbreviation||'HME')}</b><small>${esc(h.display_name||'Home')}${teamRecord(h)?` · ${esc(teamRecord(h))}`:''}</small></span>${teamLogo(h)}</div></div>${gameContextHtml(g,a,h,sem)}${facts.length?`<div class="cast6-facts">${facts.map(([k,v])=>`<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>`:''}</section>`;
  }

  const pregame=()=>semantics(state.detail)==='SCHEDULE';
  function currentActionHtml(){
    if(pregame())return '';
    const d=state.detail,p=d?.current_play||d?.game?.situation?.last_play||null,actors=dedupeActors(p),drive=d?.current_drive;
    const playBody=p?`<div class="cast6-play-kicker"><span>${semantics(d)==='LIVE'?'● LIVE SNAPSHOT':'GAME FEED'}</span>${p?.period?`<b>Q${esc(p.period)} ${esc(p.clock||'')}</b>`:''}</div><h2>${esc(clean(p?.type)||'CURRENT PLAY')}</h2><p>${esc(clean(p?.text)||'Waiting for the next published play.')}</p>${actors.length?`<div class="cast6-actors">${actors.map(actorHtml).join('')}</div>`:''}`:`<div class="cast6-empty compact"><b>Waiting for the next published play</b><span>The source has not published a current play.</span></div>`;
    const driveBody=drive?`<div class="cast6-drive-team">${drive?.team?.logo?`<img src="${esc(drive.team.logo)}" width="42" height="42" alt="" decoding="async">`:''}<b>${esc(drive?.team?.abbreviation||drive?.team?.display_name||'POSSESSION')}</b></div><strong>${esc(clean(drive?.result)||'Drive in progress')}</strong><p>${esc(clean(drive?.description)||'Current possession')}</p><div class="cast6-drive-kpis">${num(drive?.offensive_plays)!==null?`<span><b>${drive.offensive_plays}</b><small>PLAYS</small></span>`:''}${num(drive?.yards)!==null?`<span><b>${drive.yards}</b><small>YARDS</small></span>`:''}${clean(drive?.time_elapsed)?`<span><b>${esc(drive.time_elapsed)}</b><small>TIME</small></span>`:''}</div>`:`<div class="cast6-empty compact"><b>No active drive</b><span>The source is not reporting an active possession.</span></div>`;
    return `${fieldHtml(d)}<div class="cast6-action-grid"><section class="cast6-module cast6-current"><header><span>CURRENT PLAY</span>${p?.type?`<b>${esc(p.type)}</b>`:''}</header><div class="cast6-current-body">${playBody}</div></section><section class="cast6-module cast6-drive"><header><span>CURRENT DRIVE</span>${drive?.team?.abbreviation?`<b>${esc(drive.team.abbreviation)}</b>`:''}</header><div class="cast6-drive-body">${driveBody}</div></section></div>`;
  }

  function coverageHtml(){
    if(pregame())return '';
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
  function statGroupHtml(x){const labels=arr(x.group?.labels).slice(0,6);return `<section class="cast6-stat-group"><header>${x.team?.logo?`<img src="${esc(x.team.logo)}" width="29" height="29" alt="" loading="lazy" decoding="async">`:''}<div><b>${esc(x.team?.abbreviation||'NFL')}</b><span>${esc(x.group?.display_name||x.group?.name||'Player stats')}</span></div></header><div>${x.rows.map((r,rowIndex)=>{const a=r?.athlete||{},vals=arr(r?.stats).slice(0,6);return `<article class="cast6-stat-row ${rowIndex%2?'alt':''}"><div class="cast6-stat-player">${a?.headshot?`<img src="${esc(a.headshot)}" width="38" height="38" alt="${esc(a.name||'Player')}" loading="lazy" decoding="async">`:''}<span><b>${esc(a?.name||'Player')}</b><small>${esc([a?.position,r?.starter?'Starter':null].filter(Boolean).join(' · '))}</small></span></div><div class="cast6-stat-values">${vals.map((v,i)=>`<span><small>${esc(labels[i]||i+1)}</small><b>${esc(v)}</b></span>`).join('')}</div></article>`}).join('')}</div></section>`}

  function playMeta(p){return [p?.period?`Q${p.period}`:null,clean(p?.clock),clean(p?.end?.down_distance_text)||clean(p?.start?.down_distance_text)].filter(Boolean)}
  function playRow(p){const meta=playMeta(p);const score=p?.away_score!=null&&p?.home_score!=null?`${p.away_score}–${p.home_score}`:'';return `<article class="cast6-play ${p?.scoring_play?'scoring':''} ${turnover(p)?'turnover':''}"><div class="cast6-play-meta">${meta.map((m,i)=>`<span class="${i===2?'down':''}">${esc(m)}</span>`).join('')}</div><div class="cast6-play-copy"><b>${esc(clean(p?.type)||'PLAY')}</b><p>${esc(clean(p?.text)||'Play detail unavailable')}</p></div>${score?`<strong>${esc(score)}</strong>`:''}</article>`}
  /* The full game log is collapsed until asked for. The open state is part of
     the render, keyed by game, so no polling rewrite can close it; the plays
     are always rendered (hidden when collapsed), so the count and the history
     keep up with the feed and opening it needs no request. */
  function feedIsOpen(){return state.feedOpen.get(String(state.activeId||''))===true}
  function feedToggleLabel(open){return open?'Hide plays':'Show plays'}
  function liveFeedHtml(){const rows=[...arr(state.detail?.plays)].reverse();const open=feedIsOpen();return `<section class="cast6-module cast6-feed${open?' is-open':''}"><header data-feed-head><div><span>FULL GAME LOG</span><h2>Live Play-by-Play</h2></div><div class="cast6-feed-meta"><small data-feed-count>${rows.length} published plays${rows.length?' · latest first':''}</small><button type="button" class="cast6-feed-toggle" data-feed-toggle data-focus-key="feed-toggle" aria-expanded="${open}" aria-controls="cast6-feed-plays"><span>${feedToggleLabel(open)}</span><i aria-hidden="true">↓</i></button></div></header><div class="cast6-feed-scroll" id="cast6-feed-plays"${open?'':' hidden'}>${rows.length?rows.map(playRow).join(''):`<div class="cast6-empty"><b>Play-by-play unavailable</b><span>No published plays are available for this game.</span></div>`}</div></section>`}
  /* Immediate, no request, no timer: flip the remembered state and the three
     attributes that express it. The next workspace patch renders the same. */
  function toggleFeed(){
    const id=String(state.activeId||'');if(!id)return;
    const open=!feedIsOpen();state.feedOpen.set(id,open);
    const mod=document.querySelector('.pbecast6 .cast6-feed');if(!mod)return;
    mod.classList.toggle('is-open',open);
    const list=mod.querySelector('#cast6-feed-plays');if(list)list.hidden=!open;
    const btn=mod.querySelector('[data-feed-toggle]');
    if(btn){btn.setAttribute('aria-expanded',String(open));const label=btn.querySelector('span');if(label)label.textContent=feedToggleLabel(open)}
  }

  function driveModuleHtml(){const d=state.detail?.current_drive,plays=arr(d?.plays);return `<section class="cast6-module cast6-possession"><header><div><span>CURRENT POSSESSION</span><h2>Drive-by-Drive</h2></div><small>${esc(clean(d?.description))}</small></header><div class="cast6-drive-scroll">${d?`${d?.team?`<div class="cast6-possession-head">${d.team.logo?`<img src="${esc(d.team.logo)}" width="38" height="38" alt="" decoding="async">`:''}<div><b>${esc(d.team.abbreviation||d.team.display_name||'POSSESSION')}</b><span>${esc(clean(d.result)||'Drive in progress')}</span></div></div>`:''}${plays.length?plays.map(playRow).join(''):`<div class="cast6-empty compact"><span>Waiting for the first published snap of this drive.</span></div>`}`:`<div class="cast6-empty"><b>No active possession</b><span>The panel collapses its empty telemetry instead of inventing values.</span></div>`}</div></section>`}

  /* One column, in reading order: the possession in progress, the box score,
     then the full game log. Nothing here scrolls inside itself — the page
     grows — so the longest module goes last instead of beside a short one. */
  function workspaceHtml(){if(pregame())return '';return `<div class="cast6-workspace"><div>${driveModuleHtml()}${playerOutputHtml()}</div><div>${liveFeedHtml()}</div></div>`}

  function railHtml(){return `<div class="cast6-rail">${railGames().map(g=>{const a=g?.teams?.away||{},h=g?.teams?.home||{},active=String(g.id)===String(state.activeId);return `<button data-game="${esc(g.id)}" class="${active?'active':''} ${g?.status?.semantics==='SCHEDULE'?'is-scheduled':''}"><span>${esc(g?.status?.semantics==='SCHEDULE'?'SCHEDULED':g?.status?.semantics||'NFL')} · ${esc(g?.status?.semantics==='SCHEDULE'&&kickoffParts(g?.date)?`${kickoffParts(g.date).day} · ${kickoffParts(g.date).time} ET`:statusLabel(g))}</span><div><b>${esc(a.abbreviation||'AWY')}</b><strong>${esc(score(a,g?.status?.semantics))}</strong><i>at</i><b>${esc(h.abbreviation||'HME')}</b><strong>${esc(score(h,g?.status?.semantics))}</strong></div><small>${esc(g?.venue?.name||fmtDate(g?.date)||'NFL game')}</small></button>`}).join('')}</div>`}

  function toolbarHtml(){return `<div class="cast6-top"><div class="cast6-brand"><span>⚡</span><div><h1>PBE<em>cast</em> NFL</h1><p>Live football command center</p></div></div><div class="cast6-actions"><button data-sound class="${state.sound?'on':''}">${state.sound?'🔊 Audio Alerts On':'🔇 Audio Alerts Off'}</button><button data-refresh>↻ Refresh</button></div></div>`}

  function ensureRoot(){
    const vc=document.getElementById('view-container');if(!vc)return null;
    let root=vc.querySelector('.pbecast6');
    if(!root){vc.innerHTML=`<section class="pbecast6" data-stale="false"><div data-cast6-toolbar></div><div data-cast6-rail></div><div data-cast6-hero></div><div data-cast6-action></div><div data-cast6-telemetry></div><div data-cast6-workspace></div></section>`;root=vc.querySelector('.pbecast6');wireRoot(root)}
    return root;
  }
  /* A rewrite must not take keyboard focus away: a focused control carrying
     data-focus-key is focused again in the new markup. */
  function patch(root,selector,html){const host=root?.querySelector(selector);if(!host)return;const sig=String(html);if(host.dataset.sig===sig)return;const scroll=host.scrollTop;const active=typeof document!=='undefined'?document.activeElement:null;const key=active&&host.contains?.(active)?active.getAttribute?.('data-focus-key'):null;host.innerHTML=html;host.dataset.sig=sig;if(scroll)host.scrollTop=scroll;if(key)host.querySelector?.(`[data-focus-key="${key}"]`)?.focus?.({preventScroll:true})}
  function patchToolbar(){const root=document.querySelector('.pbecast6');if(root)patch(root,'[data-cast6-toolbar]',toolbarHtml())}
  /* Targeted patches for the fast lane: the sections a live frame can actually
     change, and nothing else. patch() already no-ops on an identical
     signature, so an unchanged play does not touch the DOM at all. */
  function patchLive(){
    const root=document.querySelector('.pbecast6');if(!root||!state.detail)return;
    root.dataset.stale=state.error?'true':'false';
    root.dataset.phase=semantics(state.detail);
    patch(root,'[data-cast6-hero]',heroHtml());
    patch(root,'[data-cast6-action]',currentActionHtml());
    patch(root,'[data-cast6-workspace]',workspaceHtml());
    if(root.dataset.phaseTelemetry!==root.dataset.phase){root.dataset.phaseTelemetry=root.dataset.phase;patch(root,'[data-cast6-telemetry]',coverageHtml())}
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
  function patchAll(){const root=ensureRoot();if(!root)return;root.dataset.stale=state.error?'true':'false';root.dataset.phase=state.detail?semantics(state.detail):'LOADING';patch(root,'[data-cast6-toolbar]',toolbarHtml());patch(root,'[data-cast6-rail]',railHtml());if(state.detail){patch(root,'[data-cast6-hero]',heroHtml());patch(root,'[data-cast6-action]',currentActionHtml());patch(root,'[data-cast6-telemetry]',coverageHtml());patch(root,'[data-cast6-workspace]',workspaceHtml())}else{patch(root,'[data-cast6-hero]',state.unavailable&&String(state.unavailable.id)===String(state.activeId)?`<div class="cast6-empty is-unavailable" data-cast6-unavailable="${esc(state.activeId)}"><b>This game is unavailable right now</b><span>PBEcast could not read game ${esc(state.activeId)} from the source. It stays selected and is retried; no other game is shown in its place.</span></div>`:`<div class="cast6-empty"><b>Loading game package</b><span>Connecting to live drives, player output and play-by-play.</span></div>`);patch(root,'[data-cast6-action]','');patch(root,'[data-cast6-telemetry]','');patch(root,'[data-cast6-workspace]','')}patchStamp()}
  function patchStats(){const root=document.querySelector('.pbecast6');if(!root)return;const host=root.querySelector('[data-cast6-workspace]');if(host)patch(root,'[data-cast6-workspace]',workspaceHtml())}

  function wireRoot(root){
    root.addEventListener('click',event=>{
      /* the whole log header toggles; the button inside it is the keyboard and
         screen-reader control (Enter/Space arrive here as a click) */
      if(event.target.closest('[data-feed-head]')){toggleFeed();return}
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
  /* epoch: a run belongs to the lane only while its epoch is current. When the
     GAME changes (focus, a board-driven switch) the previous game's runs are
     retired, so the new game's sync starts at once instead of finding the lane
     still busy and waiting a full cadence — up to 30s for a game that is not
     live — and a retired run can neither release the lane nor arm a second
     timer when its aborted request settles. Same-game stops (route mount,
     hidden tab) keep stopLanes' behaviour: an in-flight run for this game
     still owns its lane, which is what collapses repeated mounts into one
     request per lane. */
  const lanes={state:{gen:0,epoch:0,timer:null,busy:false,ctrl:null},live:{gen:0,epoch:0,timer:null,busy:false,ctrl:null},detail:{gen:0,epoch:0,timer:null,busy:false,ctrl:null},board:{gen:0,epoch:0,timer:null,busy:false,ctrl:null}};

  const mounted=()=>!!document.querySelector('.pbecast6');
  const anyLive=()=>games().some(g=>String(g?.status?.semantics||'').toUpperCase()==='LIVE');
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
    let winner=aheadOf(state.fastGame,state.detailGame)?state.fastGame:(state.detailGame||state.fastGame);
    if(!winner)return;
    /* The summary header carries possession but not the spot of the ball; the
       scoreboard carries both. When the two lanes stand at the same moment
       the summary game is painted, so the situation is the scoreboard's. A
       summary strictly ahead keeps its own (thinner) situation rather than
       showing a spot from an earlier moment. */
    const fast=state.fastGame;
    if(winner!==fast&&fast&&String(fast.id||'')===String(winner.id||'')&&!aheadOf(winner,fast)&&fast.situation)winner={...winner,situation:fast.situation};
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
      win_probability:winSeries(base.win_probability,d.win_probability),
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

  /* Win probability is a history that only grows within a game. A detail
     response held back in flight carries a shorter, older series; it must not
     shrink the timeline Game Pulse already drew. A series that is not a
     continuation of the held one (a correction) replaces it. */
  function winSeries(held,next){
    if(!Array.isArray(next))return held;
    if(!Array.isArray(held)||next.length>=held.length)return next;
    const tail=next[next.length-1];
    const older=next.length>0&&tail&&held.some(r=>r&&String(r.play_id)===String(tail.play_id)&&r.home_win_percentage===tail.home_win_percentage);
    return older?held:next;
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
    /* The board lane serves the whole slate, so it runs at the live cadence
       while ANY game is live — not only the focused one. A finished featured
       game used to leave eleven live games refreshing every 30s. */
    const hot=name==='board'?(isLive()||anyLive()):isLive();
    l.timer=setTimeout(()=>{if(mounted()&&visible())fn()},hot?CADENCE[name].on:CADENCE[name].off);
  }

  /* Fast state. Deliberately the smallest request PBEcast makes (~2KB) and the
     only one on the 2s cadence, so score, clock and possession never queue
     behind a box score. */
  /* The fast lane reads the scoreboard. A LIVE game or a game today reads the
     same board as before (no date); any other game reads its own ET kickoff
     date, so a scheduled game next Sunday or last week's final is found instead
     of failing against today's board. A game we know nothing about yet waits
     for the detail lane, which reads by id alone. */
  function stateUrl(){
    const id=state.activeId;if(!id)return null;
    const row=games().find(g=>String(g.id)===String(id));
    const kick=state.activeKickoff||row?.date||state.detail?.game?.date||null;
    const live=[row?.status?.semantics,state.fastGame?.status?.semantics,state.detail?.game?.status?.semantics].some(v=>String(v||'').toUpperCase()==='LIVE');
    const base=`${LIVE_API}?event=${encodeURIComponent(id)}&layer=state`;
    if(live)return base;
    if(!kick)return row?base:null;
    const day=etYmd(kick),today=etYmd(new Date());
    return day&&day!==today?`${base}&date=${day}`:base;
  }
  async function syncState(){
    const l=lanes.state;
    const url=stateUrl();
    if(l.busy||!url){scheduleLane('state',syncState);return}
    l.busy=true;const epoch=l.epoch;
    try{
      const d=await laneJson('state',url);
      if(d&&applyFast(d))patchLive();
    }catch(error){
      if(error?.name!=='AbortError'){state.error=error instanceof Error?error.message:String(error);patchFreshness()}
    }finally{if(epoch===l.epoch){l.busy=false;scheduleLane('state',syncState)}}
  }

  async function syncLive(){
    const l=lanes.live;
    if(l.busy||!state.activeId){scheduleLane('live',syncLive);return}
    l.busy=true;const epoch=l.epoch;state.syncing=true;patchFreshness();
    try{
      const d=await laneJson('live',`${LIVE_API}?event=${encodeURIComponent(state.activeId)}&layer=live`);
      if(d){applyLive(d);patchLive()}
    }catch(error){
      if(error?.name!=='AbortError'){state.error=error instanceof Error?error.message:String(error);patchFreshness()}
    }finally{if(epoch===l.epoch){l.busy=false;state.syncing=false;patchFreshness();scheduleLane('live',syncLive)}}
  }

  async function syncDetail(){
    const l=lanes.detail;
    if(l.busy||!state.activeId){scheduleLane('detail',syncDetail);return}
    l.busy=true;const epoch=l.epoch;
    try{
      const d=await laneJson('detail',`${LIVE_API}?event=${encodeURIComponent(state.activeId)}`);
      if(d){
        applyLive(d,{sound:false});
        if(String(d?.game?.id||'')===String(state.activeId)){
          state.unavailable=null;
          /* first time this game's kickoff is known: the board may belong to another week */
          if(!state.activeKickoff&&d.game.date){state.activeKickoff=d.game.date;persist();if(boardContext().url!==state.boardUrl){dropLanes(['board']);syncBoard()}
            /* the fast lane was waiting for this date; the hero's venue and records come from it */
            if(!state.fastGame&&!lanes.state.busy)syncState()}
        }
        await loadMarket(false);patchAll();
      }
    }catch(error){
      if(error?.name!=='AbortError'){
        state.error=error instanceof Error?error.message:String(error);
        /* an honest unavailable state for the SELECTED game; never a substitute */
        if(!state.detail&&state.activeId){state.unavailable={id:String(state.activeId),reason:state.error};patchAll()}
      }
    }finally{if(epoch===l.epoch){l.busy=false;scheduleLane('detail',syncDetail)}}
  }

  async function syncBoard(){
    const l=lanes.board;
    if(l.busy){scheduleLane('board',syncBoard);return}
    l.busy=true;const epoch=l.epoch;
    try{
      const ctx=boardContext();state.boardUrl=ctx.url;
      const board=await laneJson('board',ctx.url);
      if(board){
        let rows=arr(board.games);
        if(ctx.key&&window.PBESlateCore?.forKey){const wk=window.PBESlateCore.forKey(rows,ctx.key);if(wk.length)rows=wk}
        state.scoreboard={...board,games:rows,context:{kind:ctx.kind,key:ctx.key}};
        if(state.explicit&&state.activeId){
          /* the board never changes an explicit selection; it may only tell us its kickoff */
          const row=rows.find(g=>String(g.id)===String(state.activeId));
          if(row?.date&&!state.activeKickoff){state.activeKickoff=row.date;persist();if(!state.fastGame&&!lanes.state.busy)syncState()}
        }else{
          const next=chooseActive();
          if(next&&next!==String(state.activeId)){
            state.activeId=next;state.activeKickoff=rows.find(g=>String(g.id)===next)?.date||null;
            resetGame();dropLanes(['state','live','detail']);syncState();syncLive();syncDetail();
          }
        }
        patchRail();
      }
    }catch(error){
      if(error?.name!=='AbortError')state.error=error instanceof Error?error.message:String(error);
    }finally{if(epoch===l.epoch){l.busy=false;scheduleLane('board',syncBoard)}}
  }

  function stopLanes(){Object.values(lanes).forEach(l=>{clearTimeout(l.timer);l.timer=null;try{l.ctrl?.abort()}catch(_){}})}
  function dropLanes(names){names.forEach(n=>{const l=lanes[n];clearTimeout(l.timer);l.timer=null;try{l.ctrl?.abort()}catch(_){}l.epoch++;l.busy=false})}

  /* Manual refresh and first mount both want everything now, in parallel. */
  async function refresh(manual=false){
    state.date=state.date||sportsDay();
    await Promise.all([syncBoard(),
      state.activeId?syncState():Promise.resolve(),
      state.activeId?syncLive():Promise.resolve(),
      state.activeId?syncDetail():Promise.resolve()]);
    if(!state.activeId){const id=chooseActive()||window.PBESeason?.nextGame?.()?.id||null;if(id){state.activeId=String(id);state.activeKickoff=games().find(g=>String(g.id)===String(id))?.date||window.PBESeason?.nextGame?.()?.kickoff||null;await Promise.all([syncState(),syncLive(),syncDetail()])}}
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
  async function select(id,{explicit=true,kickoff=null,play_id=null}={}){
    const next=String(id??'').trim();if(!/^\d+$/.test(next))return;
    const same=next===String(state.activeId);
    if(explicit)state.explicit=true;
    if(kickoff)state.activeKickoff=kickoff;
    if(play_id)state.focusPlayId=String(play_id);
    if(same){persist();return}
    dropLanes(Object.keys(lanes));     // retire the previous game's in-flight work
    state.activeId=next;
    state.activeKickoff=kickoff||games().find(g=>String(g.id)===next)?.date||null;
    state.unavailable=null;
    resetGame();persist();patchAll();
    /* Restart every lane, the board included — it is what keeps the rail and
       the active-game choice in step, and dropping it here used to leave it
       stopped for the rest of the session. */
    await Promise.all([syncState(),syncLive(),syncDetail()]);
    syncBoard();
    patchAll();
  }
  /* A click on this page's own rail is an explicit selection too. */
  function focus(id){return select(id,{explicit:true})}
  /* GAME BREAK -> PBEcast. The breaking rail leaves a one-shot focus request
     in session storage before navigating here; it is consumed exactly once so
     a later visit to PBEcast is not dragged back to an old touchdown. The play
     id travels with it for a future play-level focus; today the GAME is
     focused, which is the correct game rather than whatever chooseActive would
     otherwise pick. */
  const FOCUS_KEY='pbe.pbecast.focus';
  function takeFocus(){
    let f=null;
    try{
      // Same-origin handoffs remain first priority. For cross-product links
      // (for example propbetedge.ai/games -> nfl.propbetedge.ai), sessionStorage
      // cannot cross the subdomain boundary, so ?event=<ESPN id>#pbecast is the
      // canonical explicit-game handoff.
      f=window.PBEGameHandoff?.take?.()||null;
      if(!f){
        const eventId=String(window.App?.params?.event||new URLSearchParams(location.search).get('event')||'').trim();
        if(/^\d{6,12}$/.test(eventId))f={game_id:eventId,source:'url-deep-link'};
      }
      if(!f){const raw=sessionStorage.getItem(FOCUS_KEY);if(raw){sessionStorage.removeItem(FOCUS_KEY);f=JSON.parse(raw)}}
    }catch(_){f=null}
    if(!f||!/^\d+$/.test(String(f.game_id||'')))return null;
    const id=String(f.game_id);
    if(id!==String(state.activeId)){dropLanes(Object.keys(lanes));state.activeId=id;state.activeKickoff=f.kickoff||null;state.unavailable=null;resetGame()}
    else if(f.kickoff)state.activeKickoff=f.kickoff;
    state.explicit=true;state.focusPlayId=f.play_id?String(f.play_id):null;persist();
    return id;
  }
  /* Mounting the route. state.detail survives a trip to another route, so
     returning to PBEcast repaints the last known game immediately and the
     lanes update it in place — the skeleton is only ever for a game we have
     never painted. */
  async function load(){
    stopLegacyTransports();stopLanes();
    /* the schedule row and the forecast: each one memoized read, shared with Games */
    window.PBEBroadcast?.load?.();window.PBEGameContext?.load?.();
    state.date=sportsDay();restore();takeFocus();ensureRoot();patchAll();
    await refresh(true);
  }

  /* A hidden tab should not hold a 2.5s loop open against the live feed, and a
     tab coming back must not show a minutes-old score while it waits for the
     next tick. Sync once, immediately, on the way back in. */
  /* When the schedule or the forecast lands, only the hero is re-diffed: no
     lane, timer, selection, play or audio state is touched. */
  window.addEventListener('pbe:season-ready',()=>{if(mounted()&&state.boardUrl&&boardContext().url!==state.boardUrl){dropLanes(['board']);syncBoard()}});
  ['pbe:game-weather','pbe:broadcast-ready'].forEach(name=>window.addEventListener(name,()=>{if(mounted())patchFreshness()}));

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

  window.PBEcastV6={state,load,refresh,focus,select,chooseActive,boardContext,stateUrl,toggleSound,takeFocus,stopLegacyTransports,telemetry,envHtml,patchFreshness,lanes,winSeries,situationFacts,possessionTeam,fieldPositionText,heroHtml,promoteGame,toggleFeed,liveFeedHtml};
  if(!install())document.addEventListener('DOMContentLoaded',install,{once:true});
})();