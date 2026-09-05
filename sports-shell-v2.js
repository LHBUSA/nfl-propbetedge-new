/* PropBetEdge NFL — sports shell v2
 * Direct replacement for the v1 shell. The scoreboard is a first-class component,
 * not a cosmetic patch: fixed-height clipping is removed, every game renders both
 * team logos, and the strip has explicit navigation plus gentle auto-advance.
 */
(() => {
  'use strict';

  const LIVE_API='/api/nfl-live';
  const PBE_LOGO='https://propbetedge.ai/logo/pbe-full-400.png';
  const state={scoreboard:null,route:'home',poll:null,auto:null,paused:false};
  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const arr=v=>Array.isArray(v)?v:[];

  function sportsDay(){
    const d=new Date(Date.now()-3*3600000);
    return d.toLocaleDateString('en-CA',{timeZone:'America/New_York'}).replaceAll('-','');
  }
  async function json(url){
    const r=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});
    if(!r.ok)throw new Error(String(r.status));
    return r.json();
  }
  function allGames(){return arr(state.scoreboard?.games)}
  function liveGames(){return allGames().filter(g=>g?.status?.semantics==='LIVE')}
  function dateParts(){
    const d=new Date();
    return{
      day:d.toLocaleDateString('en-US',{weekday:'short',timeZone:'America/New_York'}).toUpperCase(),
      date:d.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'America/New_York'}).toUpperCase()
    };
  }
  function statusText(g){
    const s=g?.status||{};
    if(s.semantics==='LIVE')return s.short_detail||s.detail||`Q${s.period||''} ${s.clock||''}`;
    if(s.semantics==='FINAL')return s.short_detail||'FINAL';
    return s.short_detail||s.detail||'SCHEDULED';
  }
  /* A game that has not kicked off has no score. Rendering an em-dash in the
     score column made a row of non-values as visually loud as real scores;
     leaving it empty lets the kickoff time in the meta row carry the fact. */
  function scoreValue(t,sem){return sem==='SCHEDULE'?'':(t?.score??'—')}
  function logoFallback(abbr){
    const key=String(abbr||'').replace(/[^A-Za-z]/g,'').toLowerCase();
    return key?`https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${key}.png`:'';
  }
  function teamLogo(t){
    const label=t?.abbreviation||t?.display_name||'NFL';
    const src=t?.logo||logoFallback(label);
    return src
      ? `<img class="pbes-team-logo" src="${esc(src)}" data-team-abbr="${esc(label)}" alt="${esc(label)} logo" loading="eager">`
      : `<span class="pbes-score-logo-fallback">${esc(String(label).slice(0,3))}</span>`;
  }

  /* One authoritative desktop product map. PBE Picks / Track Record are native
     here so late product modules never have to create a second navigation model. */
  /* Twenty-three destinations in two undifferentiated rows read as breadth
     without a model. The same items, grouped by what the user came to do:
     TODAY (what is happening), INTELLIGENCE (what it means), TOOLS (what I can
     build), ARCHIVE (what happened before). Density is unchanged; the mental
     model is not. */
  const NAV_ROWS=[
    [
      ['TODAY',[
        ['home','Dashboard',''],['games','Games',''],
        ['propboard','Props',''],['pbecast','PBEcast','cast']
      ]],
      ['INTELLIGENCE',[
        ['marketwatch','Market Watch',''],['picks','Model Lab',''],
        ['pbepicks','PBE Picks',''],['trackrecord','Track Record',''],
        ['matchups','Matchups',''],['usage','Usage',''],
        ['injuries','Injuries',''],['newsintel','News','']
      ]]
    ],
    [
      ['TOOLS',[
        ['simulator','Simulator',''],['sgplab','SGP Lab',''],['propchain','PropChain','']
      ]],
      ['ARCHIVE',[
        ['teams','Teams',''],['standings','Standings',''],['stats','Stats',''],
        ['seasonhistory','Seasons',''],['records','Records',''],['hof','Hall of Fame',''],
        ['sb','Super Bowls',''],['prospects','Draft',''],['trades','Transactions','']
      ]]
    ]
  ];

  function navGroup([label,items]){
    return `<span class="pbes-nav-group"><span class="pbes-nav-label">${esc(label)}</span>${
      items.map(([r,l,c])=>`<button type="button" class="pbes-nav-btn ${c}" data-route="${r}">${esc(l)}${r==='pbecast'?'<span class="badge" id="pbes-cast-badge">CAST</span>':''}</button>`).join('')
    }</span>`;
  }

  function shellHtml(){
    const d=dateParts();
    return `<div id="pbe-sports-shell" data-shell-version="2">
      <div class="pbes-top">
        <div class="pbes-brand" data-route="home">
          <img class="pbes-brand-logo" src="${PBE_LOGO}" alt="PropBetEdge" width="150" height="58">
          <div class="pbes-brand-copy"><div class="pbes-brand-name">NFL Intelligence</div><div class="pbes-brand-sub">Football intelligence · live market context</div></div>
        </div>
        <div class="pbes-center"><div id="pbes-live-pill" class="pbes-live-pill">Connecting to NFL slate…</div></div>
        <div class="pbes-right"><div class="pbes-date"><strong>${d.day}</strong><span>${d.date} · ET</span></div><button class="pbes-head-btn" type="button" id="pbes-search">⌘ K · Search</button><button class="pbes-head-btn pro" type="button" id="pbes-account">NFL Pro</button></div>
      </div>
      <div class="pbes-scorebar">
        <div class="pbes-score-label" id="pbes-score-label">NFL</div>
        <div class="pbes-score-window">
          <button class="pbes-score-nav prev" id="pbes-score-prev" type="button" aria-label="Previous games">‹</button>
          <div class="pbes-scores" id="pbes-scores"><div class="pbes-news-empty">Loading tonight's games…</div></div>
          <button class="pbes-score-nav next" id="pbes-score-next" type="button" aria-label="Next games">›</button>
        </div>
      </div>
      <nav class="pbes-primary" aria-label="Today and intelligence">${NAV_ROWS[0].map(navGroup).join('')}</nav>
      <nav class="pbes-research" aria-label="Tools and archive">${NAV_ROWS[1].map(navGroup).join('')}<a class="pbes-nav-btn pbes-nav-ext" href="https://propbetedge.ai/news/nfl">PropBetEdge News ↗</a></nav>
    </div>`;
  }

  function ensure(){
    const existing=document.getElementById('pbe-sports-shell');
    if(existing?.dataset?.shellVersion==='2')return;
    existing?.remove();
    /* Mount into the reserved slot so the shell's height is already accounted
       for at first paint; fall back to the historical position if absent. */
    const slot=document.getElementById('pbe-shell-slot');
    if(slot){slot.innerHTML=shellHtml()}
    else{const target=document.querySelector('.shell')||document.body.firstChild;target.insertAdjacentHTML('beforebegin',shellHtml())}
    wire();
    syncActive();
  }

  function wire(){
    document.querySelectorAll('#pbe-sports-shell [data-route]').forEach(el=>el.addEventListener('click',()=>go(el.dataset.route)));
    document.getElementById('pbes-account')?.addEventListener('click',()=>{
      if(window.PBEPro?.open)window.PBEPro.open('account');
      else document.getElementById('pbe-pro-account')?.click();
    });
    document.getElementById('pbes-search')?.addEventListener('click',()=>{
      const input=document.getElementById('global-search');
      if(input){input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))}
      else document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));
    });
    document.getElementById('pbes-score-prev')?.addEventListener('click',()=>stepScores(-1));
    document.getElementById('pbes-score-next')?.addEventListener('click',()=>stepScores(1));
    const scoreWindow=document.querySelector('.pbes-score-window');
    scoreWindow?.addEventListener('mouseenter',()=>{state.paused=true});
    scoreWindow?.addEventListener('mouseleave',()=>{state.paused=false});
    scoreWindow?.addEventListener('pointerdown',()=>{state.paused=true},{passive:true});
    scoreWindow?.addEventListener('pointerup',()=>{setTimeout(()=>{state.paused=false},1500)},{passive:true});
  }

  function go(route){state.route=route;syncActive();if(window.App?.nav)App.nav(route)}
  /* The brand mark also carries data-route="home" so the logo returns you to the
     Dashboard. Once the grouped nav gained an explicit Dashboard button, both
     matched on the home route and two items rendered active at once. The brand
     is a logo, not a nav item, so it is excluded from the active state. */
  /* state.route only ever moved when App.nav was called, so a direct load of
     /#newsintel -- or any boot that renders the route without going through
     nav -- left the shell showing DASHBOARD as the active item on a different
     page. App.current is the router's own answer, so ask it first, and
     normalize both sides so an alias never fails to match. */
  function activeRoute(){
    const raw=window.App?.current||state.route||'home';
    return typeof window.App?.normalize==='function'?window.App.normalize(raw):String(raw).toLowerCase();
  }
  function syncActive(){
    const route=activeRoute();
    document.querySelectorAll('#pbe-sports-shell [data-route]:not(.pbes-brand)')
      .forEach(el=>{
        const own=typeof window.App?.normalize==='function'?window.App.normalize(el.dataset.route):el.dataset.route;
        el.classList.toggle('active',own===route);
      });
    document.querySelector('#pbe-sports-shell .pbes-brand')?.classList.remove('active');
  }
  window.addEventListener('hashchange',syncActive);
  window.addEventListener('pbe:upgrades-ready',syncActive);

  function attachLogoFallbacks(host){
    host?.querySelectorAll('img.pbes-team-logo').forEach(img=>{
      img.addEventListener('error',()=>{
        const abbr=img.dataset.teamAbbr||'NFL';
        const span=document.createElement('span');
        span.className='pbes-score-logo-fallback';
        span.textContent=String(abbr).slice(0,3);
        img.replaceWith(span);
      },{once:true});
    });
  }

  function renderScores(){
    const games=allGames(),live=liveGames();
    const label=document.getElementById('pbes-score-label');
    const host=document.getElementById('pbes-scores');
    const pill=document.getElementById('pbes-live-pill');
    const cast=document.querySelector('.pbes-nav-btn.cast');
    const castBadge=document.getElementById('pbes-cast-badge');
    if(!host)return;
    if(label){label.textContent=live.length?'LIVE':'NFL';label.classList.toggle('live',live.length>0)}
    if(pill){pill.className=`pbes-live-pill ${live.length?'is-live':''}`;pill.textContent=live.length?`${live.length} GAME${live.length===1?'':'S'} LIVE · ${games.length} ON SLATE`:`${games.length} GAMES · CURRENT SLATE`}
    if(cast)cast.classList.toggle('is-live',live.length>0);
    if(castBadge)castBadge.textContent=live.length?`${live.length} LIVE`:'CAST';
    if(!games.length){host.innerHTML='<div class="pbes-news-empty">No NFL games returned for the current sports day.</div>';return}

    const ordered=[...games].sort((a,b)=>{
      const rank=s=>s==='LIVE'?0:s==='SCHEDULE'?1:2;
      return rank(a.status?.semantics)-rank(b.status?.semantics)||new Date(a.date)-new Date(b.date);
    });
    /* One line per game instead of two stacked team rows plus a status row.
       Pre-game the old layout printed nothing but crests and em-dashes down
       96px of permanent chrome on every surface; this reads as a matchup --
       AWY @ HME -- with the state on the same line, in 54px. */
    host.innerHTML=ordered.map(g=>{
      const a=g.teams?.away||{},h=g.teams?.home||{},sem=g.status?.semantics||'UNAVAILABLE';
      const liveClass=sem==='LIVE'?'live':sem==='FINAL'?'final':'';
      const aScore=scoreValue(a,sem), hScore=scoreValue(h,sem);
      const hasScore=aScore!==''&&hScore!=='';
      return `<button type="button" class="pbes-score ${liveClass}" data-cast-game="${esc(g.id)}" aria-label="${esc(a.display_name||a.abbreviation||'Away')} at ${esc(h.display_name||h.abbreviation||'Home')}">
        <span class="pbes-score-matchup">
          ${teamLogo(a)}<span class="pbes-score-team">${esc(a.abbreviation||a.display_name||'AWY')}</span>${hasScore?`<b class="pbes-score-num">${esc(aScore)}</b>`:''}
          <span class="pbes-score-at">@</span>
          ${teamLogo(h)}<span class="pbes-score-team">${esc(h.abbreviation||h.display_name||'HME')}</span>${hasScore?`<b class="pbes-score-num">${esc(hScore)}</b>`:''}
        </span>
        <span class="pbes-score-state">${sem==='LIVE'?'<i class="pbes-score-livedot"></i>':''}${esc(statusText(g))}</span>
      </button>`;
    }).join('');
    attachLogoFallbacks(host);
    host.querySelectorAll('[data-cast-game]').forEach(btn=>btn.addEventListener('click',()=>{
      const id=btn.dataset.castGame;
      go('pbecast');
      setTimeout(()=>window.PBEcastV6?.focus?.(id),180);
    }));
    restartAutoAdvance();
  }

  function scoreStep(){
    const host=document.getElementById('pbes-scores');
    const card=host?.querySelector('.pbes-score');
    if(!host||!card)return 220;
    return card.getBoundingClientRect().width+1;
  }
  function stepScores(direction){
    const host=document.getElementById('pbes-scores');
    if(!host)return;
    const max=Math.max(0,host.scrollWidth-host.clientWidth);
    if(direction>0&&host.scrollLeft>=max-6)host.scrollTo({left:0,behavior:'smooth'});
    else if(direction<0&&host.scrollLeft<=6)host.scrollTo({left:max,behavior:'smooth'});
    else host.scrollBy({left:direction*scoreStep(),behavior:'smooth'});
  }
  function restartAutoAdvance(){
    clearInterval(state.auto);
    state.auto=setInterval(()=>{if(!state.paused&&document.visibilityState==='visible')stepScores(1)},5200);
  }

  async function load(){
    ensure();
    /* The shell no longer runs a headline marquee, so it no longer fetches the
       news feed on every page load. The wire lives on the Dashboard. */
    await Promise.allSettled([
      json(`${LIVE_API}?date=${sportsDay()}`).then(x=>state.scoreboard=x)
    ]);
    renderScores();schedule();
  }
  function schedule(){
    clearTimeout(state.poll);
    state.poll=setTimeout(async()=>{
      try{state.scoreboard=await json(`${LIVE_API}?date=${sportsDay()}`);renderScores()}catch(_){}
      schedule();
    },10000);
  }
  function patchRouter(){
    if(!window.App?.nav||window.__pbesRouterPatchedV2)return;
    window.__pbesRouterPatchedV2=true;
    const native=App.nav.bind(App);
    /* syncActive now asks the router which route is current, so it has to run
       after native() has switched it -- calling it first painted the previous
       route as active. state.route is still set up front as the fallback for
       the case where App.normalize is unavailable. */
    App.nav=function(route,...rest){
      state.route=route;
      const result=native(route,...rest);
      syncActive();
      return result;
    };
  }
  function boot(){ensure();patchRouter();load();setTimeout(patchRouter,500);setTimeout(patchRouter,1800)}

  window.PBESportsShell={load,go,state,stepScores,version:2};
  boot();
})();
