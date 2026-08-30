/* PropBetEdge NFL — dashboard v8 command-center enhancement
 * Additive to dashboard v7. Uses the existing persistent left sidebar as the
 * tool authority, injects factual core-market context into the featured game,
 * and turns the newsroom into a filterable market-impact wire.
 */
(() => {
  'use strict';

  const local={eventId:null,market:null,loading:false,marketError:null,filter:'all',timer:null};
  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const arr=v=>Array.isArray(v)?v:[];
  const num=v=>{if(v===null||v===undefined||v==='')return NaN;const n=Number(v);return Number.isFinite(n)?n:NaN};
  const norm=v=>String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const state=()=>window.PBEDashboardV7?.state||{};
  const active=()=>window.App?.current==='home'&&Boolean(document.querySelector('.pbehome7'));
  const featured=()=>state()?.featured||null;
  function featuredTeams(){const g=featured(),a=g?.teams?.away||{},h=g?.teams?.home||{};return{away:a,home:h,awayName:a.display_name||a.name||a.abbreviation||'',homeName:h.display_name||h.name||h.abbreviation||''}}

  async function json(url){const r=await fetch(url,{cache:'no-store',headers:{accept:'application/json'}});const text=await r.text();if(!r.ok)throw new Error(`${r.status}${text?`:${text.slice(0,100)}`:''}`);try{return JSON.parse(text)}catch{throw new Error('non_json_response')}}
  function american(v){const n=num(v);return Number.isFinite(n)?`${n>0?'+':''}${Math.round(n)}`:'—'}
  function fmtLine(v){const n=num(v);if(!Number.isFinite(n))return'—';return`${n>0?'+':''}${n.toFixed(1).replace(/\.0$/,'')}`}
  function latestLiveWp(){const rows=arr(state()?.detail?.win_probability).filter(x=>Number.isFinite(num(x?.home_win_percentage)));if(!rows.length)return null;const home=num(rows.at(-1).home_win_percentage);return{home,away:1-home}}
  function probabilitySnapshot(market){const live=latestLiveWp();return live?{away:live.away,home:live.home,label:'LIVE WIN PROB'}:{away:num(market?.vig_free_probability?.away),home:num(market?.vig_free_probability?.home),label:'MARKET-IMPLIED · VIG FREE'}}

  async function syncMarket(){
    const game=featured();if(!game?.id||local.loading)return;
    if(local.eventId===String(game.id)&&local.market)return;
    const {awayName,homeName}=featuredTeams();if(!awayName||!homeName)return;
    local.loading=true;local.marketError=null;
    try{
      const out=await json(`/api/home-market?away=${encodeURIComponent(awayName)}&home=${encodeURIComponent(homeName)}`);
      local.eventId=String(game.id);local.market=out;
    }catch(error){
      local.eventId=String(game.id);local.market=null;local.marketError=error instanceof Error?error.message:String(error);
    }finally{local.loading=false;renderMarket()}
  }

  function probabilityBar(value){const p=Number.isFinite(value)?Math.max(0,Math.min(1,value)):null;return p===null?'<span class="pbe8-prob-na">—</span>':`<div class="pbe8-prob"><strong>${(p*100).toFixed(1)}%</strong><span><i style="width:${(p*100).toFixed(1)}%"></i></span></div>`}
  function marketHtml(){
    if(local.loading)return'<div class="pbe8-market-loading"><i></i><span>Connecting core market…</span></div>';
    const m=local.market;
    if(!m?.ok)return`<div class="pbe8-market-unavailable"><span>CORE MARKET</span><strong>Unavailable</strong><small>No current spread / total / moneyline board is being returned for this event.</small></div>`;
    const {away,home}=featuredTeams(),p=probabilitySnapshot(m),awayLabel=away.abbreviation||'AWY',homeLabel=home.abbreviation||'HME';
    const updated=m.provider_last_update?new Date(m.provider_last_update):null;
    const time=updated&&!Number.isNaN(updated.getTime())?updated.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'';
    return`<div class="pbe8-market-head"><span>CORE MARKET · CURRENT CROSS-BOOK CONSENSUS</span><small>${m.books||0} books · ${m.quote_count||0} quotes${time?` · ${esc(time)}`:''}</small></div><div class="pbe8-market-grid"><div><span>SPREAD</span><strong>${esc(awayLabel)} ${fmtLine(m.spread?.away)}</strong><small>${esc(homeLabel)} ${fmtLine(m.spread?.home)}</small></div><div><span>TOTAL</span><strong>${Number.isFinite(num(m.total?.line))?num(m.total.line).toFixed(1):'—'}</strong><small>O ${american(m.total?.over_price)} · U ${american(m.total?.under_price)}</small></div><div><span>MONEYLINE</span><strong>${esc(awayLabel)} ${american(m.moneyline?.away)}</strong><small>${esc(homeLabel)} ${american(m.moneyline?.home)}</small></div></div><div class="pbe8-prob-grid"><div><span>${esc(awayLabel)} · ${p.label}</span>${probabilityBar(p.away)}</div><div><span>${esc(homeLabel)} · ${p.label}</span>${probabilityBar(p.home)}</div></div>`
  }
  function renderMarket(){if(!active())return;const scorebox=document.querySelector('.pbe7-scorebox');if(!scorebox)return;let host=document.getElementById('pbe8-core-market');if(!host){host=document.createElement('section');host.id='pbe8-core-market';host.className='pbe8-core-market';const actions=scorebox.querySelector('.pbe7-actions');if(actions)scorebox.insertBefore(host,actions);else scorebox.appendChild(host)}host.innerHTML=marketHtml()}

  function category(item){const t=String(item?.topic_kind||'').toLowerCase();if(t==='injury'||/injur|inactive/.test(t))return'injury';if(['trade','signing','transaction'].includes(t))return'transaction';if(['lineup','return','depth_chart','depth chart'].includes(t))return'lineup';return'other'}
  function impact(item){const m=item?.market_impact||{};return{band:String(m.band||'CONTEXT').toUpperCase(),text:m.text||'Contextual NFL information. No verified sportsbook price movement is being claimed.',scope:m.scope||'',score:Number.isFinite(Number(m.score))?Number(m.score):null}}
  function findItem(title){const key=norm(title);return arr(state()?.news).find(x=>norm(x?.title||x?.headline||'')===key)||null}
  function decorateStory(node){
    const title=node.querySelector('h3,h4')?.textContent||'';const item=findItem(title);if(!item)return;
    node.dataset.newsCategory=category(item);const meta=node.querySelector('.pbe7-story-meta');if(meta){const topic=meta.querySelector('span');if(topic)topic.classList.add(`pbe8-topic-${category(item)}`)}
    const copy=node.querySelector('.pbe7-lead-copy,.pbe7-news-copy');if(!copy||copy.querySelector('.pbe8-impact'))return;const m=impact(item);const div=document.createElement('div');div.className=`pbe8-impact ${m.band.toLowerCase()}`;div.innerHTML=`<span>MARKET IMPACT · ${esc(m.band)}${m.score!==null?` · ${m.score}`:''}</span><p>${esc(m.text)}</p>${m.scope?`<small>${esc(m.scope)}</small>`:''}`;copy.appendChild(div)
  }
  function filterNews(){const panel=document.querySelector('.pbe7-news-panel');if(!panel)return;let visible=0;panel.querySelectorAll('.pbe7-lead-story,.pbe7-news-item').forEach(node=>{const show=local.filter==='all'||node.dataset.newsCategory===local.filter;node.hidden=!show;if(show)visible++});const layout=panel.querySelector('.pbe7-news-layout');layout?.classList.toggle('pbe8-list-only',Boolean(panel.querySelector('.pbe7-lead-story')?.hidden));let empty=panel.querySelector('.pbe8-filter-empty');if(!visible){if(!empty){empty=document.createElement('div');empty.className='pbe8-filter-empty';empty.textContent='No current stories match this impact filter.';layout?.appendChild(empty)}}else empty?.remove();panel.querySelectorAll('[data-pbe8-filter]').forEach(b=>b.classList.toggle('active',b.dataset.pbe8Filter===local.filter))}
  function renderNewsControls(){
    if(!active())return;const panel=document.querySelector('.pbe7-news-panel');if(!panel)return;panel.querySelectorAll('.pbe7-lead-story,.pbe7-news-item').forEach(decorateStory);
    const header=panel.querySelector(':scope > header');if(header&&!header.querySelector('.pbe8-news-filters')){const controls=document.createElement('div');controls.className='pbe8-news-filters';controls.innerHTML=`<button data-pbe8-filter="all">All</button><button data-pbe8-filter="injury">Injury</button><button data-pbe8-filter="transaction">Transaction</button><button data-pbe8-filter="lineup">Lineup</button>`;header.appendChild(controls);controls.addEventListener('click',e=>{const b=e.target.closest('[data-pbe8-filter]');if(!b)return;local.filter=b.dataset.pbe8Filter;filterNews()})}filterNews()
  }

  function syncRoute(){const home=window.App?.current==='home';document.documentElement.dataset.pbeHome=home?'1':'0';if(home){setTimeout(()=>{renderMarket();renderNewsControls();syncMarket()},40)}}
  function tick(){clearTimeout(local.timer);if(active()){renderMarket();renderNewsControls();syncMarket()}local.timer=setTimeout(tick,2500)}

  window.addEventListener('pbe:route-changed',syncRoute);
  window.addEventListener('pbe:upgrades-ready',syncRoute);
  window.addEventListener('pbe:pro-state',()=>setTimeout(renderNewsControls,30));
  const observer=new MutationObserver(()=>{if(active())queueMicrotask(()=>{renderMarket();renderNewsControls()})});
  document.addEventListener('DOMContentLoaded',()=>{observer.observe(document.body,{childList:true,subtree:true});syncRoute();tick()},{once:true});
  if(document.readyState!=='loading'){observer.observe(document.body,{childList:true,subtree:true});syncRoute();tick()}
  window.PBEDashboardV8={syncMarket,renderMarket,renderNewsControls,local};
})();
