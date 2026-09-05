/* PropBetEdge NFL — dashboard v6
 * Image-first newsroom, truth-first situation tiles, silent background polling.
 */
(() => {
  'use strict';

  const LIVE_API='/api/nfl-live';
  const NEWS_API='/api/news-feed?limit=12';
  const PBE_MARK='https://propbetedge.ai/logo/pbe-mark-160.png';
  const prior=window.PBEDashboardV5?.state||{};
  const state={
    scoreboard:prior.scoreboard||null,
    detail:prior.detail||null,
    news:Array.isArray(prior.news)?prior.news:[],
    featured:prior.featured||null,
    error:null,
    poll:null,
    lastHtml:'',
    installed:false
  };

  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const arr=v=>Array.isArray(v)?v:[];
  const meaningful=v=>v!==undefined&&v!==null&&String(v).trim()!==''&&String(v).trim()!=='—'&&String(v).trim()!=='-';

  function sportsDay(){const d=new Date(Date.now()-3*3600000);return d.toLocaleDateString('en-CA',{timeZone:'America/New_York'}).replaceAll('-','')}
  async function getJson(url){const r=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`${r.status}`);return r.json()}
  function hexWash(hex,a=.36){let s=String(hex||'').replace('#','');if(s.length===3)s=s.split('').map(c=>c+c).join('');if(!/^[0-9a-f]{6}$/i.test(s))return`rgba(70,110,160,${a})`;const n=parseInt(s,16);return`rgba(${n>>16&255},${n>>8&255},${n&255},${a})`}
  function newsItems(p){if(Array.isArray(p))return p;for(const k of ['items','articles','news','data','results'])if(Array.isArray(p?.[k]))return p[k];return[]}
  function titleOf(x){return x?.title||x?.headline||x?.name||''}
  function summaryOf(x){return x?.summary||x?.description||x?.dek||x?.excerpt||''}
  function urlOf(x){return x?.url||x?.canonical_url||x?.article_url||x?.link||''}
  function dateOf(x){return x?.published_at||x?.publishedAt||x?.published||x?.date||x?.created_at||''}
  function topicOf(x){return x?.topic_kind||x?.kind||x?.category||'NFL'}
  function imageOf(x){return x?.image_url||x?.featured_image||x?.thumbnail_url||''}
  function fmtDate(v){if(!v)return'';const d=new Date(v);if(Number.isNaN(d.getTime()))return'';return d.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/New_York'})+' ET'}
  function score(t,sem){return sem==='SCHEDULE'?'—':(t?.score??'—')}
  function statusText(g){const s=g?.status||{};if(s.semantics==='LIVE')return s.short_detail||s.detail||`Q${s.period||''} ${s.clock||''}`;if(s.semantics==='FINAL')return s.short_detail||'FINAL';return s.short_detail||fmtDate(g?.date)||'SCHEDULED'}
  function teamRecord(t){return arr(t?.records).find(r=>r.summary)?.summary||''}
  function teamLogo(t,cls='home5-logo'){return `<div class="${cls}">${t?.logo?`<img src="${esc(t.logo)}" alt="${esc(t.abbreviation||t.display_name||'NFL team')} logo" decoding="async">`:`<strong>${esc(t?.abbreviation||'NFL')}</strong>`}</div>`}
  function chooseFeatured(games){return games.find(g=>g?.status?.semantics==='LIVE')||games.find(g=>g?.status?.semantics==='SCHEDULE')||[...games].reverse().find(g=>g?.status?.semantics==='FINAL')||games[0]||null}

  function leaders(){
    const rows=arr(state.detail?.leaders),selected=[];
    [/pass/i,/rush/i,/receiv/i].forEach(rx=>{const hit=rows.find(r=>rx.test(`${r.category||''} ${r.display_name||''}`));if(hit&&!selected.includes(hit))selected.push(hit)});
    rows.forEach(r=>{if(selected.length<3&&!selected.includes(r))selected.push(r)});
    return selected.slice(0,3);
  }
  function playerStage(){
    const rows=leaders().filter(r=>r?.athlete?.headshot&&r?.athlete?.name);
    if(!rows.length)return'';
    return `<div class="home5-player-stage">${rows.map(r=>`<div class="home5-player"><img src="${esc(r.athlete.headshot)}" alt="${esc(r.athlete.name)}" decoding="async"><div class="home5-player-copy"><span>${esc(r.display_name||r.category||'Leader')}</span><b>${esc(r.athlete.name)}</b><strong>${esc(r.value||'')}</strong></div></div>`).join('')}</div>`;
  }

  function situation(sit,sem){
    if(!sit||sem!=='LIVE')return'';
    const tiles=[];
    if(meaningful(sit.down_distance_text))tiles.push(`<div class="home5-sit"><b class="gold">${esc(sit.down_distance_text)}</b><span>Down & distance</span></div>`);
    if(meaningful(sit.possession_text))tiles.push(`<div class="home5-sit"><b>${esc(sit.possession_text)}</b><span>Ball position</span></div>`);
    if(Object.prototype.hasOwnProperty.call(sit,'red_zone'))tiles.push(`<div class="home5-sit"><b class="${sit.red_zone?'green':''}">${sit.red_zone?'YES':'NO'}</b><span>Red zone</span></div>`);
    const hasAway=Number.isFinite(Number(sit.away_timeouts)),hasHome=Number.isFinite(Number(sit.home_timeouts));
    if(hasAway||hasHome)tiles.push(`<div class="home5-sit"><b>${esc(`${hasAway?sit.away_timeouts:'?'} / ${hasHome?sit.home_timeouts:'?'}`)}</b><span>Timeouts A / H</span></div>`);
    return tiles.length?`<div class="home5-situation count-${tiles.length}">${tiles.join('')}</div>`:'';
  }

  function hero(){
    const g=state.featured;
    if(!g)return `<section class="home5-hero"><div class="home5-empty"><div><strong>No NFL game selected</strong><p>The current sports day did not return a game to feature.</p></div></div></section>`;
    const sem=g.status?.semantics||'UNAVAILABLE',a=g.teams?.away||{},h=g.teams?.home||{},sit=state.detail?.game?.situation||g.situation||{},detail=state.detail;
    const source=detail?.source?.provider||state.scoreboard?.source?.provider||'NFL source';
    return `<section class="home5-hero" style="--h5-away:${hexWash(a.color,.43)};--h5-home:${hexWash(h.color,.43)}"><div class="home5-ghost away">${a.logo?`<img src="${esc(a.logo)}" alt="">`:''}</div><div class="home5-ghost home">${h.logo?`<img src="${esc(h.logo)}" alt="">`:''}</div><div class="home5-inner"><div class="home5-eyebrow"><span class="home5-state ${sem==='LIVE'?'live':''}">${esc(sem)} · ${sem==='LIVE'?'FEATURED GAME':'NFL SLATE'}</span><span class="home5-source">${esc(source)} · ${detail?.source?.transport?'transport '+esc(detail.source.transport):'current game source'}</span></div><div class="home5-game"><div class="home5-team">${teamLogo(a)}<div><div class="home5-abbr">${esc(a.abbreviation||'AWY')}</div><div class="home5-name">${esc(a.display_name||'Away')}</div><div class="home5-record">${esc(teamRecord(a))}</div></div></div><div class="home5-mid"><div class="home5-score"><span>${esc(score(a,sem))}</span><i>:</i><span>${esc(score(h,sem))}</span></div><div class="home5-clock"><em>${esc(statusText(g))}</em></div><div class="home5-venue">${esc([g.venue?.name,[g.venue?.city,g.venue?.state].filter(Boolean).join(', '),arr(g.broadcast).join(' / ')].filter(Boolean).join(' · ')||fmtDate(g.date)||'NFL game')}</div><div class="home5-cta"><button class="home5-btn cast ${sem==='LIVE'?'live':''}" data-cast="${esc(g.id)}">⚡ ${sem==='LIVE'?'Watch Live PBEcast':'Open PBEcast'}</button><button class="home5-btn" data-route="games">Full Slate</button><button class="home5-btn" data-route="propboard">Prop Board</button></div></div><div class="home5-team home"><div><div class="home5-abbr">${esc(h.abbreviation||'HME')}</div><div class="home5-name">${esc(h.display_name||'Home')}</div><div class="home5-record">${esc(teamRecord(h))}</div></div>${teamLogo(h)}</div></div>${situation(sit,sem)}${playerStage()}</div></section>`;
  }

  function slate(){
    const games=arr(state.scoreboard?.games);if(!games.length)return'';
    const ordered=[...games].sort((a,b)=>{const r=s=>s==='LIVE'?0:s==='SCHEDULE'?1:2;return r(a.status?.semantics)-r(b.status?.semantics)||new Date(a.date)-new Date(b.date)});
    return `<section class="home5-section"><div class="home5-head"><strong>Tonight in the NFL</strong><span>${games.filter(g=>g.status?.semantics==='LIVE').length} live · ${games.length} games on sports day</span></div><div class="home5-slate">${ordered.map(g=>{const a=g.teams?.away||{},h=g.teams?.home||{},sem=g.status?.semantics||'UNAVAILABLE';return `<article class="home5-game-card ${sem==='LIVE'?'live':''}" data-cast="${esc(g.id)}"><div class="home5-card-state">${esc(sem)} · ${esc(statusText(g))}</div><div class="home5-card-row">${a.logo?`<img src="${esc(a.logo)}" alt="" decoding="async">`:'<span></span>'}<b>${esc(a.abbreviation||a.display_name||'AWY')}</b><strong>${esc(score(a,sem))}</strong></div><div class="home5-card-row">${h.logo?`<img src="${esc(h.logo)}" alt="" decoding="async">`:'<span></span>'}<b>${esc(h.abbreviation||h.display_name||'HME')}</b><strong>${esc(score(h,sem))}</strong></div><div class="home5-card-meta">${esc(g.venue?.name||fmtDate(g.date)||'NFL game')}</div></article>`}).join('')}</div></section>`;
  }

  function news(){
    const pool=state.news.filter(x=>titleOf(x)).slice(0,10);
    if(!pool.length)return `<section class="home5-section"><div class="home5-head"><strong>NFL Intelligence Wire</strong><span>Current newsroom · source-linked</span></div><div class="home5-empty"><div><strong>News feed unavailable</strong><p>No synthetic headlines are substituted.</p></div></div></section>`;
    const lead=pool.find(x=>imageOf(x))||pool[0];
    const rest=pool.filter(x=>x!==lead).slice(0,6);
    const leadUrl=urlOf(lead),leadImg=imageOf(lead);
    return `<section class="home5-section home5-news-section"><div class="home5-head"><strong>NFL Intelligence Wire</strong><span>Real PropBetEdge newsroom imagery · source-linked</span></div><div class="home5-news-feature-wrap"><a class="home5-news-feature ${leadImg?'has-image':'no-image'}" ${leadUrl?`href="${esc(leadUrl)}" target="_blank" rel="noopener"`:'href="javascript:void(0)"'}><div class="home5-news-feature-media">${leadImg?`<img src="${esc(leadImg)}" alt="${esc(lead.image_alt||titleOf(lead))}" loading="lazy" decoding="async" onerror="this.hidden=true;this.nextElementSibling.hidden=false">`:''}<div class="home5-news-fallback" ${leadImg?'hidden':''}><img src="${PBE_MARK}" alt="PropBetEdge"></div><div class="home5-news-feature-gradient"></div></div><div class="home5-news-feature-copy"><span class="home5-news-tag">${esc(topicOf(lead))}</span><h3>${esc(titleOf(lead))}</h3><p>${esc(summaryOf(lead).slice(0,220))}</p><time>${esc(fmtDate(dateOf(lead)))}</time></div></a><div class="home5-news">${rest.map(x=>{const u=urlOf(x),img=imageOf(x);return `<a class="home5-news-row ${img?'has-image':''}" ${u?`href="${esc(u)}" target="_blank" rel="noopener"`:'href="javascript:void(0)"'}>${img?`<img class="home5-news-thumb" src="${esc(img)}" alt="${esc(x.image_alt||titleOf(x))}" loading="lazy" decoding="async" onerror="this.hidden=true">`:''}<span class="home5-news-tag">${esc(topicOf(x))}</span><div><b>${esc(titleOf(x))}</b><p>${esc(summaryOf(x).slice(0,150))}</p></div><time>${esc(fmtDate(dateOf(x)))}</time></a>`}).join('')}</div></div></section>`;
  }

  function tools(){
    const t=[['pbecast','⚡','PBEcast','Full live game, drives, play-by-play and prop progress.',''],['propboard','↗','Prop Board','Current sportsbook numbers across supported player props.',''],['marketwatch','◌','Market Watch','Cross-book dispersion and local movement baselines.','pro'],['picks','◈','Model Lab','PBE fair line, probability and model-gap analysis.','pro'],['simulator','⌁','Line Simulator','Move the market number and inspect model sensitivity.','pro'],['sgplab','⎇','SGP Lab','Build same-game legs without fake correlation math.','pro']];
    return `<section class="home5-section"><div class="home5-head"><strong>PBE Intelligence</strong><span>Live game first · analytics when you want them</span></div><div class="home5-tools">${t.map(([r,i,n,d,c])=>`<button class="home5-tool ${c}" data-route="${r}"><div class="home5-tool-icon">${i}</div><b>${esc(n)}</b><span>${esc(d)}</span></button>`).join('')}</div></section>`;
  }

  function wire(root){
    root.querySelectorAll('[data-route]').forEach(el=>el.addEventListener('click',()=>window.App?.nav?.(el.dataset.route)));
    root.querySelectorAll('[data-cast]').forEach(el=>el.addEventListener('click',()=>{const id=el.dataset.cast;window.App?.nav?.('pbecast');setTimeout(()=>window.PBEcastV5?.focus?.(id)||window.PBEcastV4?.focus?.(id),180)}));
  }

  function render(){
    /* Same route guard as dashboard-v7: this generation is superseded on the
       home route but still boots, and its load() writes into #view-container
       synchronously and again on resolve. Without the guard a cold load of a
       different route -- /#injuries reproduced it -- gets the dashboard's
       markup written over whatever that route rendered. The hash is
       authoritative from the first byte; App.current is not, because App.boot
       does not run until pbe:upgrades-ready. */
    const pbeRaw=String(location.hash||'').replace(/^#/,'');
    const pbeRoute=window.App?.normalize?window.App.normalize(pbeRaw):(pbeRaw.split('?')[0]||'home');
    if(pbeRoute!=='home')return;
    const vc=document.getElementById('view-container');if(!vc)return;
    if(state.error&&!state.scoreboard){
      const fatal=`<section class="pbehome5" data-stale="true"><div class="home5-empty"><div><strong>NFL live layer unavailable</strong><p>${esc(state.error)}. No demo game is substituted.</p></div></div></section>`;
      if(fatal!==state.lastHtml){vc.innerHTML=fatal;state.lastHtml=fatal}
      return;
    }
    const html=`<section class="pbehome5" data-stale="${state.error?'true':'false'}">${hero()}${slate()}<div class="home5-grid">${news()}${tools()}</div></section>`;
    const current=vc.querySelector('.pbehome5');
    if(html===state.lastHtml&&current){current.dataset.stale=state.error?'true':'false';return}
    vc.innerHTML=html;state.lastHtml=html;wire(vc.querySelector('.pbehome5'));
  }

  async function load(){
    clearTimeout(state.poll);
    const hasSnapshot=Boolean(state.scoreboard);
    state.error=null;
    /* Same route guard as dashboard-v7: this generation is superseded on the
       home route but still boots, and its load() writes into #view-container
       synchronously and again on resolve. Without the guard a cold load of a
       different route -- /#injuries reproduced it -- gets the dashboard's
       markup written over whatever that route rendered. The hash is
       authoritative from the first byte; App.current is not, because App.boot
       does not run until pbe:upgrades-ready. */
    const pbeRaw=String(location.hash||'').replace(/^#/,'');
    const pbeRoute=window.App?.normalize?window.App.normalize(pbeRaw):(pbeRaw.split('?')[0]||'home');
    if(pbeRoute!=='home')return;
    const vc=document.getElementById('view-container');
    if(!hasSnapshot&&vc&&!vc.querySelector('.pbehome5'))vc.innerHTML='<section class="pbehome5"><div class="home5-empty"><div><div style="font-size:35px;margin-bottom:9px">🏈</div><strong>Loading NFL Intelligence</strong><p>Connecting to the live scoreboard, game package and newsroom.</p></div></div></section>';
    try{
      const scoreboard=await getJson(`${LIVE_API}?date=${sportsDay()}`);
      const featured=chooseFeatured(arr(scoreboard?.games));
      const [detailResult,newsResult]=await Promise.allSettled([
        featured?.id?getJson(`${LIVE_API}?event=${encodeURIComponent(featured.id)}`):Promise.resolve(null),
        getJson(NEWS_API)
      ]);
      state.scoreboard=scoreboard;
      state.featured=featured;
      if(detailResult.status==='fulfilled')state.detail=detailResult.value;
      if(newsResult.status==='fulfilled')state.news=newsItems(newsResult.value);
      render();
    }catch(error){
      state.error=error instanceof Error?error.message:String(error);
      render();
    }
    state.poll=setTimeout(()=>{if(document.querySelector('.pbehome5'))load()},15000);
  }

  function install(){
    if(!window.App?.VIEWS)return false;
    if(window.PBEDashboardV5?.state?.poll)clearTimeout(window.PBEDashboardV5.state.poll);
    App.VIEWS.home=load;
    state.installed=true;
    if(document.querySelector('.pbehome5')){render();setTimeout(load,30)}
    return true;
  }

  window.PBEDashboardV6={load,state};
  if(!install())document.addEventListener('DOMContentLoaded',()=>install(),{once:true});
})();
