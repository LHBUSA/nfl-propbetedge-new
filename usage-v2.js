/* PropBetEdge NFL — Usage Research v3
 * Immutable 2025 role baselines paint first from the bundled archive.
 * Current news hydrates separately. Unsupported live usage telemetry stays OFF.
 */
(() => {
  'use strict';

  const API=typeof NFL_API_GATEWAY!=='undefined'?NFL_API_GATEWAY:'https://nfl-api.propbetedge.ai';
  const DEFAULT_EVENT='8c94552d022acec4a0458d70c19d3da9';
  const state={loading:false,board:null,news:[],newsReady:false,newsError:null};
  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const num=v=>{const n=Number(String(v??'').replace(/,/g,''));return Number.isFinite(n)?n:NaN};
  const currentEvent=()=>new URLSearchParams(location.search).get('event')||localStorage.getItem('pbe_nfl_event')||DEFAULT_EVENT;
  async function fetchJson(url,cache='no-store'){const r=await fetch(url,{cache,headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json()}

  function event(){return state.board?.event||{}}
  function teamByName(name){const text=String(name||'').toLowerCase();return Object.values(window.NFL_TEAMS||{}).find(t=>text===String(t.name||'').toLowerCase()||text===String(t.abbr||'').toLowerCase()||text.includes(String(t.city||'').toLowerCase())||text.includes(String(t.name||'').toLowerCase().split(' ').pop()))||null}
  function selectedTeams(){const e=event();return[teamByName(e.away_team||e.away),teamByName(e.home_team||e.home)].filter(Boolean)}
  function crest(t,size=30){try{if(t?.abbr&&typeof teamCrest==='function')return teamCrest(t.abbr,size)}catch(_){}return`<strong style="color:#fff;font:900 13px 'Inter',sans-serif">${esc(t?.abbr||'NFL')}</strong>`}

  function statsSource(key){return window.StatsView?.STATS?.[key]||null}
  function rowsAsObjects(key){const cat=statsSource(key);if(!cat)return[];const headers=cat.headers||[];return(cat.rows||[]).map(row=>{const obj={};headers.forEach((h,i)=>obj[String(h).toUpperCase()]=row[i]);obj.__row=row;return obj})}
  function value(obj,...names){for(const n of names){const key=String(n).toUpperCase();if(obj[key]!=null)return obj[key]}return'—'}
  function allTeamRows(team,key){if(!team)return[];return rowsAsObjects(key).filter(r=>String(value(r,'TEAM')).toUpperCase()===team.abbr)}
  function categoryRows(team,key){return allTeamRows(team,key).slice(0,5)}
  function roleConfig(key){return{
    passing:{title:'Passing Volume',primary:['ATT','ATT'],secondary:['YDS','YDS'],third:['TD','TD']},
    rushing:{title:'Rushing Volume',primary:['ATT','ATT'],secondary:['YDS','YDS'],third:['TD','TD']},
    receiving:{title:'Receiving Volume',primary:['REC','REC'],secondary:['YDS','YDS'],third:['TD','TD']}
  }[key]}
  function volumeTotal(team,key){const cfg=roleConfig(key);return allTeamRows(team,key).map(r=>num(value(r,cfg.primary[0]))).filter(Number.isFinite).reduce((a,b)=>a+b,0)}

  function teamNews(teams){const abbrs=new Set(teams.map(t=>t.abbr));const names=teams.map(t=>String(t.name).toLowerCase());return state.news.filter(a=>(a.teams||[]).some(x=>abbrs.has(String(x).toUpperCase()))||names.some(n=>`${a.title||''} ${a.summary||''}`.toLowerCase().includes(n))).sort((a,b)=>new Date(b.published_at||0)-new Date(a.published_at||0)).slice(0,12)}
  function playerNews(player,teams){const full=String(player||'').toLowerCase(),last=full.split(/\s+/).pop();return teamNews(teams).find(a=>(a.players||[]).some(p=>{const x=String(p).toLowerCase();return x===full||x.includes(full)||full.includes(x)})||`${a.title||''} ${a.summary||''}`.toLowerCase().includes(full)||(last&&last.length>3&&`${a.title||''} ${a.summary||''}`.toLowerCase().includes(last)))||null}
  function articleId(a){return`pbe21-news-${String(a?.id||a?.slug||a?.title||'story').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').slice(0,72)}`}
  function isInjury(a){return String(a.topic_kind||'').toLowerCase()==='injury'||/injur|ankle|knee|hamstring|concussion|sidelined|out for/i.test(`${a.title||''} ${a.summary||''}`)}
  function isRole(a){const topic=String(a.topic_kind||'').toLowerCase();return['lineup','trade','signing','transaction','return'].includes(topic)||/starter|starting|depth chart|role|rotation|signed|trade|activated|return/i.test(`${a.title||''} ${a.summary||''}`)}
  function impact(a){const n=num(a.impact_score);return Number.isFinite(n)?n:0}

  function roleRows(team,key,teams){
    const cfg=roleConfig(key),rows=categoryRows(team,key),total=volumeTotal(team,key);
    if(!rows.length)return'';
    return`<div class="pbe21-role-list">${rows.map((r,i)=>{
      const primary=num(value(r,cfg.primary[0])),share=Number.isFinite(primary)&&total>0?Math.max(0,Math.min(100,primary/total*100)):null;
      const story=playerNews(value(r,'PLAYER'),teams);
      return`<div class="pbe21-role" data-player="${esc(value(r,'PLAYER'))}"><div class="pbe21-rank">${i+1}</div><div class="pbe21-player-cell"><div class="pbe21-player">${esc(value(r,'PLAYER'))}${story?`<button type="button" class="pbe21-news-dot" data-news-jump="${esc(articleId(story))}" title="Jump to current role context" aria-label="Jump to current news for ${esc(value(r,'PLAYER'))}"></button>`:''}</div><div class="pbe21-player-team">${esc(team.abbr)} · 2025 final</div>${share!==null?`<div class="pbe21-volume-track"><i style="width:${share.toFixed(1)}%"></i></div><div class="pbe21-volume-share">${share.toFixed(1)}% of listed team ${cfg.primary[1].toLowerCase()} volume</div>`:''}</div><div class="pbe21-role-stat"><b>${esc(value(r,cfg.primary[0]))}</b><span>${cfg.primary[1]}</span></div><div class="pbe21-role-stat"><b>${esc(value(r,cfg.secondary[0]))}</b><span>${cfg.secondary[1]}</span></div><div class="pbe21-role-stat mobile-hide"><b>${esc(value(r,cfg.third[0]))}</b><span>${cfg.third[1]}</span></div></div>`
    }).join('')}</div>`
  }

  function teamPanel(team,teams){
    const cats=['passing','rushing','receiving'].filter(key=>categoryRows(team,key).length);
    return`<section class="pbe21-team"><header class="pbe21-team-head"><div class="pbe21-crest">${crest(team,31)}</div><div><div class="pbe21-team-name">${esc(team.name)}</div><div class="pbe21-team-sub">2025 FINAL · HISTORICAL ROLE BASELINE</div></div></header>${cats.length?cats.map(key=>`<section class="pbe21-category"><div class="pbe21-category-head"><strong>${roleConfig(key).title}</strong><span>FINAL VOLUME · NOT CURRENT SHARE</span></div>${roleRows(team,key,teams)}</section>`).join(''):'<div class="pbe21-no-volume">NO RETAINED 2025 VOLUME FOR THIS TEAM</div>'}</section>`
  }

  function newsPanel(teams){
    if(!state.newsReady&&!state.newsError)return`<section class="pbe21-current"><div class="pbe21-panel-head"><strong>Current Role Context</strong><span>NEWS HYDRATING</span></div><div class="pbe21-news-loading"><i></i><span>Loading current verified newsroom context…</span></div></section>`;
    if(state.newsError)return`<section class="pbe21-current"><div class="pbe21-panel-head"><strong>Current Role Context</strong><span>NEWS UNAVAILABLE</span></div><div class="pbe21-no-volume">CURRENT NEWS CONTEXT TEMPORARILY UNAVAILABLE</div></section>`;
    const rows=teamNews(teams);
    return`<section class="pbe21-current"><div class="pbe21-panel-head"><strong>Current Role Context</strong><span>NEWS · NOT USAGE TELEMETRY</span></div><div class="pbe21-news-grid">${rows.length?rows.map(a=>`<article class="pbe21-news" id="${esc(articleId(a))}"><div class="pbe21-news-top"><span class="pbe21-news-topic">${esc(String(a.topic_kind||'news').toUpperCase())}</span><span class="pbe21-impact">${impact(a)||'—'}</span></div><a href="${esc(a.url||'#')}" target="_blank" rel="noopener">${esc(a.title)}</a>${a.summary?`<div class="pbe21-news-copy">${esc(a.summary)}</div>`:''}<div class="pbe21-tags">${(a.teams||[]).slice(0,3).map(t=>`<span class="pbe21-tag">${esc(t)}</span>`).join('')}${(a.players||[]).slice(0,3).map(p=>`<span class="pbe21-tag">${esc(p)}</span>`).join('')}</div></article>`).join(''):'<div class="pbe21-no-volume" style="grid-column:1/-1">NO CURRENT NEWS CONTEXT MATCHED THIS EVENT</div>'}</div></section>`
  }

  function statusBar(teams){
    const baselinePlayers=new Set();teams.forEach(t=>['passing','rushing','receiving'].forEach(key=>categoryRows(t,key).forEach(r=>baselinePlayers.add(String(value(r,'PLAYER'))))));
    const news=state.newsReady?teamNews(teams):[];
    return`<div class="pbe21-statusbar"><div><span>BASELINE PLAYERS</span><b>${baselinePlayers.size}</b></div><div><span>CURRENT NEWS</span><b class="green">${state.newsReady?news.length:'—'}</b></div><div><span>INJURY CONTEXT</span><b>${state.newsReady?news.filter(isInjury).length:'—'}</b></div><div><span>ROLE / ROSTER</span><b>${state.newsReady?news.filter(isRole).length:'—'}</b></div><div class="off"><span>LIVE USAGE TELEMETRY</span><b>OFF</b></div></div>`
  }

  function shell(){
    const teams=selectedTeams(),e=event(),away=e.away_team||e.away||'Away',home=e.home_team||e.home||'Home';
    return`<section class="pbe21-usage"><header class="pbe21-hero"><div><div class="pbe21-kicker">USAGE RESEARCH · VERIFIED ROLE BASELINE</div><h1 class="pbe21-title">Volume first.<br><em>Role context second.</em></h1><div class="pbe21-copy">Historical volume is rendered from the retained 2025 final archive. Current news context hydrates separately. Live target share, route participation, personnel splits and role certainty remain offline until verified play-by-play usage telemetry is available.</div></div><aside class="pbe21-status"><b>${esc(away)} @ ${esc(home)}</b><span>2025 FINAL VOLUME · CURRENT NEWS · LIVE OPERATIONAL USAGE OFFLINE</span></aside></header><div class="pbe21-telemetry-note"><span class="pbe21-off-dot"></span><strong>Live operational usage telemetry: offline.</strong><span>System awaiting verified play-by-play usage integration. No hardcoded or randomized share estimates are displayed.</span></div>${statusBar(teams)}<div class="pbe21-grid">${teams.length?teams.map(t=>teamPanel(t,teams)).join(''):'<div class="pbe21-no-volume" style="grid-column:1/-1">SELECTED EVENT TEAMS COULD NOT BE RESOLVED</div>'}</div>${newsPanel(teams)}<div class="pbe21-boundary"><div class="pbe21-bound ready"><b>2025 final volume</b><span>Immutable archived passing, rushing and receiving totals render locally with no live API dependency.</span></div><div class="pbe21-bound ready"><b>Current news context</b><span>Current newsroom context hydrates independently and is edge-cached by the NFL news adapter.</span></div><div class="pbe21-bound blocked"><b>Live target / route share</b><span>Offline until verified snap, route and target telemetry is available.</span></div><div class="pbe21-bound blocked"><b>Personnel + PROE</b><span>Not inferred from incomplete play text. These stay unavailable rather than synthetic.</span></div></div></section>`
  }

  function wire(){
    document.querySelectorAll('.pbe21-role[data-player]').forEach(row=>row.addEventListener('click',()=>window.PBEPlayerResearch?.show(row.dataset.player)));
    document.querySelectorAll('[data-news-jump]').forEach(btn=>btn.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();const el=document.getElementById(btn.dataset.newsJump);el?.scrollIntoView({behavior:'smooth',block:'center'});el?.classList.add('flash');setTimeout(()=>el?.classList.remove('flash'),1300)}));
  }
  function paint(){const vc=document.getElementById('view-container');if(!vc)return;vc.innerHTML=shell();wire()}

  async function render(){
    if(state.loading)return;state.loading=true;state.news=[];state.newsReady=false;state.newsError=null;
    const vc=document.getElementById('view-container');if(!vc){state.loading=false;return}
    vc.innerHTML='<section class="pbe21-usage"><div class="pbe21-no-volume">OPENING VERIFIED USAGE BASELINE…</div></section>';
    try{
      const eventId=currentEvent();
      state.board=await fetchJson(`${API}/api/odds/board?event_id=${encodeURIComponent(eventId)}&markets=player_pass_yds`,'no-store');
      paint();
      state.loading=false;
      try{
        const news=await fetchJson('/api/news-feed?limit=100','default');
        state.news=Array.isArray(news?.articles)?news.articles:[];state.newsReady=true;state.newsError=null;
      }catch(error){state.news=[];state.newsReady=true;state.newsError=error instanceof Error?error.message:String(error)}
      if(document.querySelector('.pbe21-usage'))paint();
    }catch(error){state.loading=false;vc.innerHTML=`<section class="pbe21-usage"><div class="pbe21-no-volume">USAGE RESEARCH UNAVAILABLE · ${esc(error instanceof Error?error.message:String(error))}</div></section>`}
  }
  function install(){if(!window.App?.VIEWS)return false;App.VIEWS.usage=render;return true}
  window.PBEUsageV2={render,state};install();document.addEventListener('DOMContentLoaded',install,{once:true});window.addEventListener('pbe:event-changed',()=>{if(document.querySelector('.pbe21-usage')&&!state.loading)render()});
})();