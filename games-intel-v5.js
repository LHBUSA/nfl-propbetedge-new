/* PropBetEdge NFL — Games Intelligence Layer v5
 *
 * Truth contract:
 * - Edge Readiness = availability of four representative quoted prop families,
 *   not a model score and not a claim about sharp action.
 * - Prop Variance = current cross-book relative line range, not historical
 *   movement and not model edge.
 * - High Total = current cross-book total > 48.5 when a core market exists.
 * - Prime Time = schedule timing (TNF/SNF/MNF), independent of market status.
 * - Weather never invents a forecast. Roof/exposure is venue context only until
 *   a licensed live-weather feed is wired.
 */
(() => {
  'use strict';

  const FILTER_KEY='pbe_games_ops_filter_v5';
  const cache=new Map();
  const queue=[];
  const queued=new Set();
  let active=0,timer=null,filter='all';
  const MAX_CONCURRENCY=4;

  const ROOF_BY_HOME={
    'arizona cardinals':'RETRACTABLE','atlanta falcons':'RETRACTABLE','baltimore ravens':'OUTDOOR','buffalo bills':'OUTDOOR',
    'carolina panthers':'OUTDOOR','chicago bears':'OUTDOOR','cincinnati bengals':'OUTDOOR','cleveland browns':'OUTDOOR',
    'dallas cowboys':'RETRACTABLE','denver broncos':'OUTDOOR','detroit lions':'DOME','green bay packers':'OUTDOOR',
    'houston texans':'RETRACTABLE','indianapolis colts':'RETRACTABLE','jacksonville jaguars':'OUTDOOR','kansas city chiefs':'OUTDOOR',
    'las vegas raiders':'DOME','los angeles chargers':'CANOPY','los angeles rams':'CANOPY','miami dolphins':'CANOPY',
    'minnesota vikings':'DOME','new england patriots':'OUTDOOR','new orleans saints':'DOME','new york giants':'OUTDOOR',
    'new york jets':'OUTDOOR','philadelphia eagles':'OUTDOOR','pittsburgh steelers':'OUTDOOR','san francisco 49ers':'OUTDOOR',
    'seattle seahawks':'OUTDOOR','tampa bay buccaneers':'OUTDOOR','tennessee titans':'OUTDOOR','washington commanders':'OUTDOOR'
  };

  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
  const fmt=(v,d=1)=>num(v)===null?'—':Number(v).toFixed(d).replace(/\.0$/,'');
  const normalize=v=>String(v||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();

  function restore(){try{const saved=localStorage.getItem(FILTER_KEY);if(['all','prime','high-total','high-variance','markets-live'].includes(saved))filter=saved}catch(_){}}
  function persist(){try{localStorage.setItem(FILTER_KEY,filter)}catch(_){}}

  function providerId(root){
    return root?.querySelector('[data-pbe-game-provider]')?.dataset?.pbeGameProvider
      ||root?.querySelector('[data-provider]')?.dataset?.provider||'';
  }
  function teamNames(root,featured=false){
    if(featured){const rows=[...root.querySelectorAll('.pbe25-feature-team')];return{away:rows[0]?.querySelector('span')?.textContent?.trim()||'',home:rows[1]?.querySelector('span')?.textContent?.trim()||''}}
    const rows=[...root.querySelectorAll('.pbe25-team-name')];return{away:rows[0]?.textContent?.trim()||'',home:rows[1]?.textContent?.trim()||''};
  }
  function roof(home){return ROOF_BY_HOME[normalize(home)]||'UNKNOWN'}
  function environmentText(home){
    const r=roof(home);
    if(r==='DOME')return'DOME · WEATHER NEUTRALIZED';
    if(r==='RETRACTABLE')return'RETRACTABLE ROOF · STATUS TBD';
    if(r==='CANOPY')return'COVERED OPEN AIR · WEATHER EXPOSURE';
    if(r==='OUTDOOR')return'OUTDOOR · LIVE WEATHER UNAVAILABLE';
    return'ENVIRONMENT STATUS UNAVAILABLE';
  }

  function cardMeta(card){
    const teams=teamNames(card,false),id=providerId(card);
    const day=card.closest('.pbe25-day')?.querySelector('.pbe25-date strong')?.textContent?.trim()||'';
    const time=card.querySelector('.pbe25-time strong')?.textContent?.trim()||'';
    const small=card.querySelector('.pbe25-time small')?.textContent?.trim()||'';
    return{root:card,id,away:teams.away,home:teams.home,day,time,small,featured:false};
  }
  function featureMeta(feature){const teams=teamNames(feature,true);return{root:feature,id:providerId(feature),away:teams.away,home:teams.home,featured:true}}

  async function load(meta){
    if(!meta.id)return null;
    if(cache.has(meta.id))return cache.get(meta.id);
    const promise=fetch(`/api/game-intel?event_id=${encodeURIComponent(meta.id)}&away=${encodeURIComponent(meta.away)}&home=${encodeURIComponent(meta.home)}`,{cache:'default',headers:{accept:'application/json'}})
      .then(async r=>{if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json()})
      .catch(()=>null);
    cache.set(meta.id,promise);
    return promise;
  }

  function queueMeta(meta,priority=false){
    if(!meta.id||queued.has(meta.id)||cache.has(meta.id))return;
    queued.add(meta.id);priority?queue.unshift(meta):queue.push(meta);pump();
  }
  function pump(){
    while(active<MAX_CONCURRENCY&&queue.length){
      const meta=queue.shift();active++;
      load(meta).then(data=>{
        if(data)paintId(meta.id,data);
      }).finally(()=>{active--;pump();applyFilter()});
    }
  }

  function family(label,data){
    const live=Boolean(data?.live),books=Number(data?.books||0);
    return`<span class="pbe25-ready-pill ${live?'live':'pending'}"><b>${esc(label)}</b>${live?`${books} BOOK${books===1?'':'S'}`:'PENDING'}</span>`;
  }
  function variance(data){
    const pct=num(data?.dispersion?.max?.relative_pct),range=num(data?.dispersion?.max?.range),player=data?.dispersion?.max?.player;
    if(pct===null)return'<span class="pbe25-intel-chip"><b>PROP VARIANCE</b>—</span>';
    return`<span class="pbe25-intel-chip ${data?.dispersion?.high?'hot':''}" title="${esc(player?`${player} · current cross-book line range ${fmt(range,1)}`:'Current cross-book relative line range')}"><b>${data?.dispersion?.high?'HIGH PROP VARIANCE':'PROP VARIANCE'}</b>${esc(fmt(pct,1))}%</span>`;
  }
  function totalChip(data){
    const line=num(data?.core?.total?.line);
    return line===null?'<span class="pbe25-intel-chip"><b>GAME TOTAL</b>—</span>':`<span class="pbe25-intel-chip ${data?.core?.high_total?'hot':''}"><b>GAME TOTAL</b>${esc(fmt(line,1))}</span>`;
  }
  function marketIntel(data,home,featured=false){
    const readiness=data?.readiness||{},f=readiness.families||{},score=Number(readiness.score_pct||0);
    const env=data?.environment?.roof?(
      data.environment.roof==='DOME'?'DOME · WEATHER NEUTRALIZED':
      data.environment.roof==='RETRACTABLE'?'RETRACTABLE ROOF · STATUS TBD':
      data.environment.roof==='CANOPY'?'COVERED OPEN AIR · WEATHER EXPOSURE':
      data.environment.roof==='OUTDOOR'?'OUTDOOR · LIVE WEATHER UNAVAILABLE':environmentText(home)
    ):environmentText(home);
    return`<section class="pbe25-game-intel ${featured?'featured':''}">
      <div class="pbe25-readiness"><div class="pbe25-readiness-head"><span>EDGE READINESS <small>QUOTED-MARKET AVAILABILITY</small></span><b>${score}%</b></div><div class="pbe25-readiness-track"><i style="width:${Math.max(0,Math.min(100,score))}%"></i></div><div class="pbe25-ready-families">${family('PASS',f.passing)}${family('REC',f.receiving)}${family('RUSH',f.rushing)}${family('TD',f.touchdown)}</div></div>
      <div class="pbe25-intel-chips">${variance(data)}${totalChip(data)}<span class="pbe25-intel-chip environment"><b>ENVIRONMENT</b>${esc(env)}</span></div>
    </section>`;
  }
  function waitingIntel(home){return`<section class="pbe25-game-intel loading"><div class="pbe25-intel-loading"><i></i><span>Reading current market availability</span></div><span class="pbe25-intel-chip environment"><b>ENVIRONMENT</b>${esc(environmentText(home))}</span></section>`}
  function scheduleOnlyIntel(home){return`<section class="pbe25-game-intel schedule-only"><div class="pbe25-readiness"><div class="pbe25-readiness-head"><span>EDGE READINESS <small>QUOTED-MARKET AVAILABILITY</small></span><b>0%</b></div><div class="pbe25-readiness-track"><i style="width:0%"></i></div><div class="pbe25-ready-families"><span class="pbe25-ready-pill pending"><b>PROP MARKETS</b>PENDING</span></div></div><div class="pbe25-intel-chips"><span class="pbe25-intel-chip environment"><b>ENVIRONMENT</b>${esc(environmentText(home))}</span></div></section>`}

  function setDataFlags(root,data){
    root.dataset.pbeIntelReady=String(Number(data?.readiness?.score_pct||0));
    root.dataset.pbeIntelHighTotal=data?.core?.high_total?'1':'0';
    root.dataset.pbeIntelHighVariance=data?.dispersion?.high?'1':'0';
  }
  function insertIntel(meta,data=null){
    const root=meta.root;if(!root?.isConnected)return;
    let section=root.querySelector(':scope > .pbe25-game-intel');
    const html=data?marketIntel(data,meta.home,meta.featured):(meta.id?waitingIntel(meta.home):scheduleOnlyIntel(meta.home));
    if(section){section.outerHTML=html}else{
      const anchor=meta.featured?root.querySelector('.pbe25-feature-actions'):root.querySelector('.pbe25-actions');
      anchor?.insertAdjacentHTML('beforebegin',html);
    }
    if(data)setDataFlags(root,data);
    else if(!meta.id){root.dataset.pbeIntelReady='0';root.dataset.pbeIntelHighTotal='0';root.dataset.pbeIntelHighVariance='0'}
  }
  function paintId(id,data){
    document.querySelectorAll('.pbe25-card').forEach(card=>{const meta=cardMeta(card);if(meta.id===id)insertIntel(meta,data)});
    const feature=document.querySelector('.pbe25-feature');if(feature){const meta=featureMeta(feature);if(meta.id===id)insertIntel(meta,data)}
  }

  function parseHour(text){
    const m=String(text||'').match(/(\d{1,2})(?::(\d{2}))?\s*([AP]M)/i);if(!m)return null;
    let h=Number(m[1]);const ap=m[3].toUpperCase();if(ap==='PM'&&h!==12)h+=12;if(ap==='AM'&&h===12)h=0;return h;
  }
  function isPrime(card){
    const meta=cardMeta(card),day=meta.day.toLowerCase(),hour=parseHour(meta.time);
    if(hour===null)return false;
    if(day.includes('thursday')&&hour>=19)return true;
    if(day.includes('sunday')&&hour>=19)return true;
    if(day.includes('monday')&&hour>=19)return true;
    return false;
  }

  function controls(){
    const host=document.querySelector('.pbe25-games .pbe25-controls');if(!host)return;
    let bar=host.querySelector('.pbe25-quickfilters');
    const html=`<div class="pbe25-quickfilters"><span>SLATE LENS</span>${[
      ['all','All slate'],['prime','Prime Time'],['high-total','High total > 48.5'],['high-variance','High prop variance'],['markets-live','Props available']
    ].map(([key,label])=>`<button type="button" class="${filter===key?'active':''}" data-pbe25-ops="${key}">${label}</button>`).join('')}<small>High-total and variance lenses use currently quoted provider-linked events only.</small></div>`;
    if(bar)bar.outerHTML=html;else host.querySelector('.pbe25-control-top')?.insertAdjacentHTML('afterend',html);
    document.querySelectorAll('[data-pbe25-ops]').forEach(btn=>{if(btn.dataset.pbeIntelWired==='1')return;btn.dataset.pbeIntelWired='1';btn.addEventListener('click',()=>{filter=btn.dataset.pbe25Ops||'all';persist();if(['high-total','high-variance','markets-live'].includes(filter))forceHydrate();controls();applyFilter()})});
  }

  function matches(card){
    if(filter==='all')return true;
    if(filter==='prime')return isPrime(card);
    if(filter==='high-total')return card.dataset.pbeIntelHighTotal==='1';
    if(filter==='high-variance')return card.dataset.pbeIntelHighVariance==='1';
    if(filter==='markets-live')return Number(card.dataset.pbeIntelReady||0)>0;
    return true;
  }
  function applyFilter(){
    const cards=[...document.querySelectorAll('.pbe25-card')];
    cards.forEach(card=>card.classList.toggle('pbe25-ops-hidden',!matches(card)));
    document.querySelectorAll('.pbe25-day').forEach(day=>{const visible=[...day.querySelectorAll('.pbe25-card')].some(card=>!card.classList.contains('pbe25-ops-hidden'));day.classList.toggle('pbe25-day-hidden',!visible)});
    const list=document.querySelector('.pbe25-list');if(!list)return;
    let empty=list.querySelector(':scope > .pbe25-intel-empty');
    const any=cards.some(card=>!card.classList.contains('pbe25-ops-hidden'));
    if(!any&&!empty){empty=document.createElement('div');empty.className='pbe25-intel-empty';empty.textContent=['high-total','high-variance','markets-live'].includes(filter)?'No currently quoted games match this slate lens.':'No scheduled games match this slate lens.';list.prepend(empty)}
    if(any&&empty)empty.remove();
  }

  const io='IntersectionObserver' in window?new IntersectionObserver(entries=>{
    for(const entry of entries){if(!entry.isIntersecting)continue;io.unobserve(entry.target);const meta=cardMeta(entry.target);queueMeta(meta)}
  },{rootMargin:'700px 0px'}):null;

  function hydrateCards(){
    document.querySelectorAll('.pbe25-card').forEach(card=>{
      const meta=cardMeta(card);
      if(!card.querySelector(':scope > .pbe25-game-intel'))insertIntel(meta,null);
      card.dataset.pbePrime=isPrime(card)?'1':'0';
      if(meta.id&&!cache.has(meta.id)&&!queued.has(meta.id)){if(io)io.observe(card);else queueMeta(meta)}
    });
    const feature=document.querySelector('.pbe25-feature');
    if(feature){const meta=featureMeta(feature);if(!feature.querySelector(':scope > .pbe25-game-intel'))insertIntel(meta,null);if(meta.id)queueMeta(meta,true)}
  }
  function forceHydrate(){document.querySelectorAll('.pbe25-card').forEach(card=>{const meta=cardMeta(card);if(meta.id)queueMeta(meta,true)})}

  function enhance(){
    if(!document.querySelector('.pbe25-games'))return;
    controls();hydrateCards();applyFilter();
  }
  function schedule(){clearTimeout(timer);timer=setTimeout(enhance,45)}
  function burst(){[0,100,320,900].forEach(delay=>setTimeout(enhance,delay))}

  restore();
  new MutationObserver(schedule).observe(document.getElementById('view-container')||document.documentElement,{childList:true,subtree:true});
  ['pbe:route-changed','pbe:event-changed','pbe:events-loaded','pbe:upgrades-ready'].forEach(name=>window.addEventListener(name,burst));
  document.addEventListener('DOMContentLoaded',burst,{once:true});
  window.PBEGamesIntelV5={enhance:burst,filter:()=>filter,cache};
  burst();
})();
