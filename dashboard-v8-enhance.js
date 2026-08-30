/* PropBetEdge NFL — dashboard v8 command-center enhancement
 * Additive to dashboard v7. Uses the existing persistent left sidebar as the
 * tool authority, injects factual core-market context into the featured game,
 * and turns the newsroom into a filterable market-impact wire.
 */
(() => {
  'use strict';

  const API=typeof NFL_API_GATEWAY!=='undefined'?NFL_API_GATEWAY:'https://nfl-api.propbetedge.ai';
  const CORE_MARKETS=['h2h','spreads','totals'];
  const local={eventId:null,board:null,loading:false,marketError:null,filter:'all',timer:null};
  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const arr=v=>Array.isArray(v)?v:[];
  const num=v=>{if(v===null||v===undefined||v==='')return NaN;const n=Number(v);return Number.isFinite(n)?n:NaN};
  const state=()=>window.PBEDashboardV7?.state||{};
  const active=()=>window.App?.current==='home'&&Boolean(document.querySelector('.pbehome7'));

  async function json(url){const r=await fetch(url,{cache:'no-store',headers:{accept:'application/json'}});if(!r.ok){const t=await r.text().catch(()=> '');throw new Error(`${r.status}${t?`:${t.slice(0,90)}`:''}`)}return r.json()}
  function oddsRows(payload){if(Array.isArray(payload))return payload;for(const k of ['events','games','data','results','odds'])if(Array.isArray(payload?.[k]))return payload[k];return[]}
  function oddsEvent(raw){return{id:String(raw?.id||raw?.event_id||raw?.eventId||''),away:String(raw?.away_team||raw?.away||raw?.awayTeam||''),home:String(raw?.home_team||raw?.home||raw?.homeTeam||'')}}
  function norm(v){return String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()}
  function namesMatch(a,b){const x=norm(a),y=norm(b);if(!x||!y)return false;const ax=x.split(' ').at(-1),by=y.split(' ').at(-1);return x===y||x.includes(y)||y.includes(x)||ax===by}
  function featured(){return state()?.featured||null}
  function featuredTeams(){const g=featured(),a=g?.teams?.away||{},h=g?.teams?.home||{};return{away:a,home:h,awayName:a.display_name||a.name||a.abbreviation||'',homeName:h.display_name||h.name||h.abbreviation||''}}

  function quoteRows(){return arr(local.board?.quotes)}
  const marketOf=q=>String(q?.market||q?.market_key||q?.key||'').toLowerCase();
  const selectionOf=q=>String(q?.selection||q?.team||q?.participant||q?.description||q?.outcome||q?.name||'');
  const pointOf=q=>num(q?.point??q?.line);
  const priceOf=q=>num(q?.price??q?.american_odds??q?.odds);
  const sideOf=q=>String(q?.direction||q?.side||q?.outcome||q?.name||'').toUpperCase();
  const bookOf=q=>q?.book||q?.book_title||q?.sportsbook||q?.book_key||'';
  function median(values){const xs=values.map(num).filter(Number.isFinite).sort((a,b)=>a-b);if(!xs.length)return NaN;const i=Math.floor(xs.length/2);return xs.length%2?xs[i]:(xs[i-1]+xs[i])/2}
  function american(v){const n=num(v);return Number.isFinite(n)?`${n>0?'+':''}${Math.round(n)}`:'—'}
  function implied(v){const a=num(v);if(!Number.isFinite(a)||a===0)return NaN;return a<0?Math.abs(a)/(Math.abs(a)+100):100/(a+100)}
  function fmtLine(v){const n=num(v);if(!Number.isFinite(n))return'—';return`${n>0?'+':''}${n.toFixed(1).replace(/\.0$/,'')}`}

  function byMarket(name){return quoteRows().filter(q=>marketOf(q)===name||marketOf(q).includes(name))}
  function teamQuotes(rows,team){return rows.filter(q=>namesMatch(selectionOf(q),team.display_name||team.name||team.abbreviation)||namesMatch(selectionOf(q),team.abbreviation))}
  function marketSnapshot(){
    const {away,home}=featuredTeams();
    const h2h=byMarket('h2h'),spreads=byMarket('spreads'),totals=byMarket('totals');
    const awayMl=teamQuotes(h2h,away),homeMl=teamQuotes(h2h,home);
    const awaySp=teamQuotes(spreads,away),homeSp=teamQuotes(spreads,home);
    const over=totals.filter(q=>sideOf(q).includes('OVER')),under=totals.filter(q=>sideOf(q).includes('UNDER'));
    const awayPrice=median(awayMl.map(priceOf)),homePrice=median(homeMl.map(priceOf));
    const rawAway=implied(awayPrice),rawHome=implied(homePrice),sum=rawAway+rawHome;
    const marketAway=Number.isFinite(sum)&&sum>0?rawAway/sum:NaN,marketHome=Number.isFinite(sum)&&sum>0?rawHome/sum:NaN;
    const totalLine=median([...over,...under].map(pointOf));
    return{
      awaySpread:median(awaySp.map(pointOf)),homeSpread:median(homeSp.map(pointOf)),
      awayPrice,homePrice,marketAway,marketHome,totalLine,
      overPrice:median(over.map(priceOf)),underPrice:median(under.map(priceOf)),
      books:new Set(quoteRows().map(bookOf).filter(Boolean)).size,
      quoteCount:quoteRows().length,
      updated:local.board?.provider_last_update||local.board?.last_update||local.board?.updated_at||null
    }
  }

  function latestLiveWp(){const rows=arr(state()?.detail?.win_probability).filter(x=>Number.isFinite(num(x?.home_win_percentage)));if(!rows.length)return null;const home=num(rows.at(-1).home_win_percentage);return{home,away:1-home}}
  function probabilitySnapshot(market){const live=latestLiveWp();return live?{away:live.away,home:live.home,label:'LIVE WIN PROB'}:{away:market.marketAway,home:market.marketHome,label:'MARKET-IMPLIED · VIG FREE'}}

  async function resolveOddsEvent(){
    const {awayName,homeName}=featuredTeams();if(!awayName||!homeName)return null;
    const payload=await json(`${API}/api/odds`);
    return oddsRows(payload).map(oddsEvent).find(e=>e.id&&namesMatch(e.away,awayName)&&namesMatch(e.home,homeName))||null;
  }
  async function loadBoardForEvent(eventId){
    try{return await json(`${API}/api/odds/board?event_id=${encodeURIComponent(eventId)}&markets=${encodeURIComponent(CORE_MARKETS.join(','))}`)}catch(_){
      const settled=await Promise.allSettled(CORE_MARKETS.map(m=>json(`${API}/api/odds/board?event_id=${encodeURIComponent(eventId)}&markets=${encodeURIComponent(m)}`)));
      const parts=settled.filter(x=>x.status==='fulfilled').map(x=>x.value);if(!parts.length)throw new Error('core_market_unavailable');
      const merged={...parts[0],quotes:[],market_summary:[]},seen=new Set();
      for(const p of parts)for(const q of arr(p?.quotes)){const key=[bookOf(q),marketOf(q),selectionOf(q),pointOf(q),priceOf(q)].join('|');if(!seen.has(key)){seen.add(key);merged.quotes.push(q)}}
      merged.provider_last_update=parts.map(p=>p?.provider_last_update||p?.last_update||p?.updated_at).filter(Boolean).sort().at(-1)||null;
      return merged;
    }
  }
  async function syncMarket(){
    const game=featured();if(!game?.id||local.loading)return;
    if(local.eventId===String(game.id)&&local.board)return;
    local.loading=true;local.marketError=null;
    try{const evt=await resolveOddsEvent();if(!evt?.id)throw new Error('featured_game_market_not_found');local.eventId=String(game.id);local.board=await loadBoardForEvent(evt.id)}
    catch(error){local.board=null;local.eventId=String(game.id);local.marketError=error instanceof Error?error.message:String(error)}
    finally{local.loading=false;renderMarket()}
  }

  function probabilityBar(value){const p=Number.isFinite(value)?Math.max(0,Math.min(1,value)):null;return p===null?'<span class="pbe8-prob-na">—</span>':`<div class="pbe8-prob"><strong>${(p*100).toFixed(1)}%</strong><span><i style="width:${(p*100).toFixed(1)}%"></i></span></div>`}
  function marketHtml(){
    if(local.loading)return'<div class="pbe8-market-loading"><i></i><span>Connecting core market…</span></div>';
    if(!local.board||!quoteRows().length)return`<div class="pbe8-market-unavailable"><span>CORE MARKET</span><strong>Unavailable</strong><small>No current spread / total / moneyline board is being returned for this event.</small></div>`;
    const m=marketSnapshot(),{away,home}=featuredTeams(),p=probabilitySnapshot(m),awayLabel=away.abbreviation||'AWY',homeLabel=home.abbreviation||'HME';
    return`<div class="pbe8-market-head"><span>CORE MARKET · CURRENT CROSS-BOOK CONSENSUS</span><small>${m.books} books · ${m.quoteCount} quotes${m.updated?` · ${esc(new Date(m.updated).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}))}`:''}</small></div><div class="pbe8-market-grid"><div><span>SPREAD</span><strong>${esc(awayLabel)} ${fmtLine(m.awaySpread)}</strong><small>${esc(homeLabel)} ${fmtLine(m.homeSpread)}</small></div><div><span>TOTAL</span><strong>${Number.isFinite(m.totalLine)?m.totalLine.toFixed(1):'—'}</strong><small>O ${american(m.overPrice)} · U ${american(m.underPrice)}</small></div><div><span>MONEYLINE</span><strong>${esc(awayLabel)} ${american(m.awayPrice)}</strong><small>${esc(homeLabel)} ${american(m.homePrice)}</small></div></div><div class="pbe8-prob-grid"><div><span>${esc(awayLabel)} · ${p.label}</span>${probabilityBar(p.away)}</div><div><span>${esc(homeLabel)} · ${p.label}</span>${probabilityBar(p.home)}</div></div>`
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
