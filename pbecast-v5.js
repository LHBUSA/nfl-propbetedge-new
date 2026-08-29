/* PropBetEdge NFL — PBEcast v5 production hardening
 * Enhances the truthful v4 transport with a low-latency live presentation.
 * The underlying feed is polling, not websocket push. LIVE is never inferred.
 */
(() => {
  'use strict';

  const V4=()=>window.PBEcastV4;
  let timer=null;
  let observer=null;
  let enhanceQueued=false;
  let takeoverRunning=false;

  const arr=v=>Array.isArray(v)?v:[];
  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  function activeDetail(){const v4=V4();const s=v4?.state;return s?.activeId?s.details?.[s.activeId]||null:null}
  function semantics(detail){return String(detail?.source?.semantics||detail?.game?.status?.semantics||'UNAVAILABLE').toUpperCase()}
  function delayFor(detail){const sem=semantics(detail);return sem==='LIVE'?2500:sem==='FINAL'?30000:sem==='SCHEDULE'?15000:10000}
  function freshness(detail){
    const raw=detail?.source?.fetched_at;if(!raw)return{age:null,label:'Freshness unavailable'};
    const t=new Date(raw).getTime();if(!Number.isFinite(t))return{age:null,label:'Freshness unavailable'};
    const age=Math.max(0,Math.round((Date.now()-t)/1000));
    return{age,label:age<2?'just now':age<60?`${age}s ago`:`${Math.floor(age/60)}m ago`};
  }
  function playerCount(detail){
    const ids=new Set();arr(detail?.player_stats).forEach((tb,tbi)=>arr(tb?.groups).forEach((g,gi)=>arr(g?.athletes).forEach((r,ri)=>{const a=r?.athlete||{};ids.add(String(a.id||a.name||`${tbi}:${gi}:${ri}`))})));
    return [...ids].filter(x=>x&&x!=='undefined').length;
  }
  function coverage(detail){
    const s=V4()?.state||{};
    return [
      ['PLAYS',detail?.play_count??arr(detail?.plays).length,arr(detail?.plays).length>0],
      ['DRIVES',detail?.drive_count??arr(detail?.drives).length,arr(detail?.drives).length>0],
      ['PLAYERS',playerCount(detail),arr(detail?.player_stats).length>0],
      ['WIN PROB',arr(detail?.win_probability).length,arr(detail?.win_probability).length>0],
      ['PROP MARKET',s.market?'LINKED':'—',Boolean(s.market)]
    ];
  }
  function playRow(play,compact=false){
    const score=play?.away_score!=null&&play?.home_score!=null?`${play.away_score}–${play.home_score}`:'';
    const scoring=play?.scoring_play?' scoring':'';
    const turnover=/intercept|fumble|turnover|downs/i.test(`${play?.type||''} ${play?.text||''}`)?' turnover':'';
    return `<article class="cast5-play${scoring}${turnover}${compact?' compact':''}">
      <div class="cast5-play-time"><b>Q${esc(play?.period||'—')}</b><span>${esc(play?.clock||'')}</span></div>
      <div class="cast5-play-main"><div class="cast5-play-type">${esc(play?.type||'PLAY')}</div><p>${esc(play?.text||'Play detail unavailable')}</p><small>${esc(play?.end?.down_distance_text||play?.start?.down_distance_text||play?.end?.possession_text||play?.start?.possession_text||'')}</small></div>
      <div class="cast5-play-score">${esc(score)}</div>
    </article>`;
  }
  function driveTimeline(detail){
    const drive=detail?.current_drive;const plays=arr(drive?.plays);
    if(!drive)return `<div class="cast5-empty"><strong>No active drive</strong><span>The source is not currently publishing an active possession.</span></div>`;
    return `<div class="cast5-drive-head"><div>${drive?.team?.logo?`<img src="${esc(drive.team.logo)}" alt="">`:''}<span><b>${esc(drive?.team?.abbreviation||drive?.team?.display_name||'POSSESSION')}</b><small>${esc(drive?.result||'Drive in progress')}</small></span></div><div class="cast5-drive-kpis"><b>${esc(drive?.offensive_plays??plays.length)} plays</b><b>${esc(drive?.yards??'—')} yds</b><b>${esc(drive?.time_elapsed||'—')}</b></div></div><div class="cast5-drive-plays">${plays.length?plays.map(p=>playRow(p,true)).join(''):`<div class="cast5-empty"><span>Waiting for the first published snap of this drive.</span></div>`}</div>`;
  }
  function fullTimeline(detail){
    const plays=arr(detail?.plays);if(!plays.length)return `<div class="cast5-empty"><strong>Play-by-play unavailable</strong><span>The source has not published any plays for this game yet.</span></div>`;
    const reversed=[...plays].reverse();let lastPeriod=null;const html=[];
    reversed.forEach(p=>{const q=p?.period||'—';if(q!==lastPeriod){html.push(`<div class="cast5-quarter">Quarter ${esc(q)}</div>`);lastPeriod=q}html.push(playRow(p))});
    return html.join('');
  }
  function statCell(label,value){return `<span><small>${esc(label)}</small><b>${esc(value??'—')}</b></span>`}
  function playerStats(detail){
    const blocks=[];
    arr(detail?.player_stats).forEach(teamBlock=>{
      const team=teamBlock?.team||{};
      arr(teamBlock?.groups).forEach(group=>{
        const rows=arr(group?.athletes).filter(r=>!r?.did_not_play).slice(0,8);
        if(!rows.length)return;
        const labels=arr(group?.labels);
        blocks.push(`<section class="cast5-stat-group"><header>${team?.logo?`<img src="${esc(team.logo)}" alt="">`:''}<div><b>${esc(team?.abbreviation||team?.display_name||'NFL')}</b><span>${esc(group?.display_name||group?.name||'Player stats')}</span></div></header><div class="cast5-stat-rows">${rows.map(row=>{const a=row?.athlete||{};const vals=arr(row?.stats);return `<div class="cast5-stat-row"><div class="cast5-stat-player">${a?.headshot?`<img src="${esc(a.headshot)}" alt="${esc(a.name||'Player')}">`:''}<span><b>${esc(a?.name||'Player')}</b><small>${esc([a?.position,row?.starter?'Starter':null].filter(Boolean).join(' · '))}</small></span></div><div class="cast5-stat-values">${vals.slice(0,6).map((v,i)=>statCell(labels[i]||String(i+1),v)).join('')}</div></div>`}).join('')}</div></section>`);
      });
    });
    return blocks.length?blocks.slice(0,8).join(''):`<div class="cast5-empty"><strong>Player box score unavailable</strong><span>No player-stat groups were published for this game package.</span></div>`;
  }
  function telemetry(detail){
    const sem=semantics(detail),fresh=freshness(detail),poll=delayFor(detail)/1000,g=detail?.game||{},sit=g?.situation||{},source=detail?.source||{};
    const possession=[g?.teams?.away,g?.teams?.home].find(t=>String(t?.id)===String(sit?.possession_id));
    return `<section class="cast5-telemetry"><div class="cast5-telemetry-title"><div><span class="cast5-pulse ${sem==='LIVE'?'live':''}"></span><strong>${sem==='LIVE'?'LIVE GAME FEED':esc(sem)}</strong><small>${sem==='LIVE'?`Low-latency ${poll}s polling`:`${poll}s refresh cadence`} · ${esc(source?.provider||'source unavailable')} · ${esc(source?.transport||'poll')}</small></div><div class="cast5-fresh"><b>${esc(fresh.label)}</b><span>source refresh</span></div></div><div class="cast5-telemetry-grid"><div><span>Possession</span><b>${esc(possession?.abbreviation||sit?.possession_text||'—')}</b></div><div><span>Down & distance</span><b>${esc(sit?.down_distance_text||'—')}</b></div><div><span>Ball</span><b>${esc(sit?.possession_text||'—')}</b></div><div><span>Red zone</span><b class="${sit?.red_zone?'hot':''}">${sit?.red_zone?'YES':'NO'}</b></div><div><span>Published plays</span><b>${esc(detail?.play_count??arr(detail?.plays).length)}</b></div><div><span>Published drives</span><b>${esc(detail?.drive_count??arr(detail?.drives).length)}</b></div></div><div class="cast5-coverage">${coverage(detail).map(([name,value,ok])=>`<div class="${ok?'ok':'missing'}"><span>${esc(name)}</span><b>${esc(value)}</b></div>`).join('')}</div></section>`;
  }
  function liveLayer(detail){return `<section class="cast5-live-layer" data-cast5="1">${telemetry(detail)}<div class="cast5-primary-grid"><section class="cast5-module cast5-current-drive"><header><div><span>CURRENT POSSESSION</span><h2>Drive-by-drive live action</h2></div><small>${esc(detail?.current_drive?.description||'')}</small></header>${driveTimeline(detail)}</section><section class="cast5-module cast5-box-preview"><header><div><span>GAME PACKAGE</span><h2>Player output</h2></div><small>Source-published box score</small></header><div class="cast5-mini-stats">${playerStats(detail)}</div></section></div><section class="cast5-module cast5-pbp-main"><header><div><span>FULL GAME LOG</span><h2>Live Play-by-Play</h2></div><div><small>${esc(detail?.play_count??arr(detail?.plays).length)} published plays · latest first</small><button type="button" class="cast5-open-drawer">Open focused drawer</button></div></header><div class="cast5-pbp-scroll">${fullTimeline(detail)}</div></section></section>`}

  function enhance(){
    enhanceQueued=false;if(takeoverRunning)return;
    const root=document.querySelector('.pbecast4');const detail=activeDetail();if(!root||!detail)return;
    root.querySelectorAll('.cast5-live-layer').forEach(x=>x.remove());
    const anchor=root.querySelector('.cast4-action-grid');if(!anchor)return;
    anchor.insertAdjacentHTML('afterend',liveLayer(detail));
    root.querySelector('.cast5-open-drawer')?.addEventListener('click',()=>V4()?.openPbp?.());
    const scroller=root.querySelector('.cast5-pbp-scroll');if(scroller&&semantics(detail)==='LIVE')scroller.scrollTop=0;
  }
  function queueEnhance(){if(enhanceQueued)return;enhanceQueued=true;requestAnimationFrame(enhance)}

  async function takeoverPoll(){
    if(takeoverRunning)return;takeoverRunning=true;
    try{
      clearTimeout(timer);const v4=V4();if(!v4?.state)return;
      if(v4.state.poll){clearTimeout(v4.state.poll);v4.state.poll=null}
      if(!document.querySelector('.pbecast4'))return;
      const wait=delayFor(activeDetail());
      timer=setTimeout(async()=>{
        if(!document.querySelector('.pbecast4'))return;
        try{await v4.refresh?.(false)}catch(_){ }
        if(v4.state?.poll){clearTimeout(v4.state.poll);v4.state.poll=null}
        queueEnhance();takeoverRunning=false;takeoverPoll();
      },wait);
    }finally{if(!timer)takeoverRunning=false}
  }
  function stop(){clearTimeout(timer);timer=null;const v4=V4();if(v4?.state?.poll){clearTimeout(v4.state.poll);v4.state.poll=null}takeoverRunning=false}

  async function load(){
    const v4=V4();if(!v4?.load)return;
    stop();await v4.load();
    if(v4.state?.poll){clearTimeout(v4.state.poll);v4.state.poll=null}
    queueEnhance();takeoverPoll();
  }
  function install(){
    const v4=V4();if(!v4||!window.App?.VIEWS)return false;
    App.VIEWS.pbecast=load;
    const nav=document.getElementById('nav-pbecast');if(nav)nav.innerHTML='<span class="ni-icon">⚡</span> PBEcast <span class="nav-badge" style="color:#62e2a1;background:rgba(98,226,161,.10)">LIVE DATA</span>';
    if(!observer){observer=new MutationObserver(mutations=>{if(mutations.some(m=>m.type==='childList')&&document.querySelector('.pbecast4')){const v=V4();if(v?.state?.poll){clearTimeout(v.state.poll);v.state.poll=null}queueEnhance();if(!takeoverRunning)takeoverPoll()}else if(!document.querySelector('.pbecast4'))stop()});const host=document.getElementById('view-container');if(host)observer.observe(host,{childList:true,subtree:true})}
    if(document.querySelector('.pbecast4')){queueEnhance();takeoverPoll()}
    return true;
  }

  window.PBEcastV5={load,enhance,takeoverPoll,stop,delayFor};
  install();document.addEventListener('DOMContentLoaded',install,{once:true});
})();
