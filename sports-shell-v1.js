/* PropBetEdge NFL — sports shell v1 */
(() => {
  'use strict';
  const LIVE_API='/api/nfl-live';
  const NEWS_API='/api/news-feed?limit=24';
  const PBE_LOGO='https://propbetedge.ai/logo/pbe-full-200.png';
  const state={scoreboard:null,news:[],route:'home',poll:null};
  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const arr=v=>Array.isArray(v)?v:[];
  function sportsDay(){const d=new Date(Date.now()-3*3600000);return d.toLocaleDateString('en-CA',{timeZone:'America/New_York'}).replaceAll('-','');}
  async function json(url){const r=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});if(!r.ok)throw new Error(String(r.status));return r.json()}
  function allGames(){return arr(state.scoreboard?.games)}
  function liveGames(){return allGames().filter(g=>g?.status?.semantics==='LIVE')}
  function dateParts(){const d=new Date();return{day:d.toLocaleDateString('en-US',{weekday:'short',timeZone:'America/New_York'}).toUpperCase(),date:d.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'America/New_York'}).toUpperCase()}}
  function newsItems(payload){if(Array.isArray(payload))return payload;for(const key of ['items','articles','news','data','results'])if(Array.isArray(payload?.[key]))return payload[key];return[]}
  function titleOf(item){return item?.title||item?.headline||item?.name||item?.article_title||''}
  function urlOf(item){return item?.url||item?.canonical_url||item?.article_url||item?.link||''}
  function sourceOf(item){return item?.source_name||item?.source||item?.provider||'PBE'}
  function statusText(g){const s=g?.status||{};if(s.semantics==='LIVE')return s.short_detail||s.detail||`Q${s.period||''} ${s.clock||''}`;if(s.semantics==='FINAL')return s.short_detail||'FINAL';return s.short_detail||'SCHEDULED'}
  function teamLogo(t){const label=t?.abbreviation||t?.display_name||'NFL';return t?.logo?`<img src="${esc(t.logo)}" alt="${esc(label)} logo" loading="lazy">`:`<span class="pbes-score-logo-fallback">${esc(String(label).slice(0,3))}</span>`}
  function scoreValue(t,sem){return sem==='SCHEDULE'?'—':(t?.score??'—')}
  const PRIMARY=[
    ['pbecast','⚡ PBEcast','cast'],
    ['propboard','Props',''],
    ['marketwatch','Market Watch',''],
    ['picks','Model Lab',''],
    ['simulator','Simulator',''],
    ['sgplab','SGP Lab',''],
    ['usage','Usage',''],
    ['games','Games',''],
    ['newsintel','News','']
  ];
  const RESEARCH=[
    ['matchups','Matchups'],['injuries','Injuries'],['trades','Transactions'],['teams','Teams'],['stats','2025 Stats'],['standings','2025 Standings'],['seasonhistory','Seasons'],['hof','Hall of Fame'],['records','Records'],['sb','Super Bowls'],['prospects','Draft Review']
  ];
  function shellHtml(){const d=dateParts();return `<div id="pbe-sports-shell"><div class="pbes-top"><div class="pbes-brand" data-route="home"><img class="pbes-brand-logo" src="${PBE_LOGO}" alt="PropBetEdge" width="126" height="49"><div class="pbes-brand-copy"><div class="pbes-brand-name">NFL Intelligence <span class="pbes-brand-pill">PBE</span></div><div class="pbes-brand-sub">Sports News · Prop-Bet Intelligence</div></div></div><div class="pbes-center"><div id="pbes-live-pill" class="pbes-live-pill">Connecting to NFL slate…</div></div><div class="pbes-right"><div class="pbes-date"><strong>${d.day}</strong><span>${d.date} · ET</span></div><button class="pbes-head-btn" type="button" id="pbes-search">⌘ K · Search</button><button class="pbes-head-btn pro" type="button" id="pbes-account">NFL Pro</button></div></div><div class="pbes-news"><div class="pbes-news-badge">PBE NEWS</div><div class="pbes-news-vp"><div class="pbes-news-track" id="pbes-news-track"><div class="pbes-news-empty">Loading current NFL headlines…</div></div></div><div class="pbes-scorebar"><div class="pbes-score-label" id="pbes-score-label">NFL</div><div class="pbes-scores" id="pbes-scores"><div class="pbes-news-empty">Loading tonight's games…</div></div></div><div class="pbes-primary"><span class="pbes-nav-label">NFL</span>${PRIMARY.map(([r,l,c])=>`<button type="button" class="pbes-nav-btn ${c}" data-route="${r}">${l}${r==='pbecast'?'<span class="badge" id="pbes-cast-badge">CAST</span>':''}</button>`).join('')}<a class="pbes-nav-btn" style="display:inline-flex;align-items:center;text-decoration:none" href="https://propbetedge.ai/news/nfl">News Site ↗</a></div><div class="pbes-research"><span class="pbes-nav-label">Research</span>${RESEARCH.map(([r,l])=>`<button type="button" class="pbes-nav-btn" data-route="${r}">${l}</button>`).join('')}</div></div>`;}
  function ensure(){if(document.getElementById('pbe-sports-shell'))return;const target=document.querySelector('.shell')||document.body.firstChild;target.insertAdjacentHTML('beforebegin',shellHtml());wire();syncActive();}
  function wire(){
    document.querySelectorAll('#pbe-sports-shell [data-route]').forEach(el=>el.addEventListener('click',()=>go(el.dataset.route)));
    document.getElementById('pbes-account')?.addEventListener('click',()=>{if(window.PBEPro?.open)window.PBEPro.open('account');else document.getElementById('pbe-pro-account')?.click()});
    document.getElementById('pbes-search')?.addEventListener('click',()=>{const input=document.getElementById('global-search');if(input){input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))}else document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))});
  }
  function go(route){state.route=route;syncActive();if(window.App?.nav)App.nav(route)}
  function syncActive(){document.querySelectorAll('#pbe-sports-shell [data-route]').forEach(el=>el.classList.toggle('active',el.dataset.route===state.route))}
  function renderScores(){const games=allGames(),live=liveGames(),label=document.getElementById('pbes-score-label'),host=document.getElementById('pbes-scores'),pill=document.getElementById('pbes-live-pill'),cast=document.querySelector('.pbes-nav-btn.cast'),castBadge=document.getElementById('pbes-cast-badge');if(!host)return;
    if(label){label.textContent=live.length?'LIVE':'NFL';label.classList.toggle('live',live.length>0)}
    if(pill){pill.className=`pbes-live-pill ${live.length?'is-live':''}`;pill.textContent=live.length?`${live.length} GAME${live.length===1?'':'S'} LIVE · ${games.length} ON SLATE`:`${games.length} GAMES · NO LIVE GAMES`}
    if(cast){cast.classList.toggle('is-live',live.length>0)}if(castBadge)castBadge.textContent=live.length?`${live.length} LIVE`:'CAST';
    if(!games.length){host.innerHTML='<div class="pbes-news-empty">No NFL games returned for the current sports day.</div>';return}
    const ordered=[...games].sort((a,b)=>{const rank=s=>s==='LIVE'?0:s==='SCHEDULE'?1:2;return rank(a.status?.semantics)-rank(b.status?.semantics)||new Date(a.date)-new Date(b.date)});
    host.innerHTML=ordered.map(g=>{const a=g.teams?.away||{},h=g.teams?.home||{},sem=g.status?.semantics||'UNAVAILABLE';return `<button type="button" class="pbes-score ${sem==='LIVE'?'live':''}" data-cast-game="${esc(g.id)}"><span class="pbes-score-teamrow">${teamLogo(a)}<span class="pbes-score-team">${esc(a.abbreviation||a.display_name||'AWY')}</span><b class="pbes-score-num">${esc(scoreValue(a,sem))}</b></span><span class="pbes-score-teamrow">${teamLogo(h)}<span class="pbes-score-team">${esc(h.abbreviation||h.display_name||'HME')}</span><b class="pbes-score-num">${esc(scoreValue(h,sem))}</b></span><span class="pbes-score-meta">${esc(sem)} · ${esc(statusText(g))}</span></button>`}).join('');
    host.querySelectorAll('[data-cast-game]').forEach(btn=>btn.addEventListener('click',()=>{const id=btn.dataset.castGame;go('pbecast');setTimeout(()=>window.PBEcastV4?.focus?.(id),180)}));
  }
  function renderNews(){const host=document.getElementById('pbes-news-track');if(!host)return;const items=state.news.filter(x=>titleOf(x)).slice(0,16);if(!items.length){host.innerHTML='<div class="pbes-news-empty">Current NFL newsroom feed unavailable.</div>';return}const one=items.map(x=>{const title=titleOf(x),url=urlOf(x),source=sourceOf(x);const tag=x?.topic_kind||x?.kind||x?.category||'NFL';return `<a class="pbes-news-item" ${url?`href="${esc(url)}" target="_blank" rel="noopener"`:'href="javascript:void(0)"'}><span>${esc(tag)}</span><strong>${esc(title)}</strong><span>${esc(source)}</span></a>`}).join('');host.innerHTML=one+one;}
  async function load(){ensure();await Promise.allSettled([json(`${LIVE_API}?date=${sportsDay()}`).then(x=>state.scoreboard=x),json(NEWS_API).then(x=>state.news=newsItems(x))]);renderScores();renderNews();schedule();}
  function schedule(){clearTimeout(state.poll);state.poll=setTimeout(async()=>{try{state.scoreboard=await json(`${LIVE_API}?date=${sportsDay()}`);renderScores()}catch(_){}schedule()},10000)}
  function patchRouter(){if(!window.App?.nav||window.__pbesRouterPatched)return;window.__pbesRouterPatched=true;const native=App.nav.bind(App);App.nav=function(route,...rest){state.route=route;syncActive();return native(route,...rest)}}
  function boot(){ensure();patchRouter();load();setTimeout(patchRouter,800);setTimeout(patchRouter,2000)}
  window.PBESportsShell={load,go,state};boot();
})();