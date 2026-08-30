/* PropBetEdge NFL — Global Event Selector */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const DEFAULT_EVENT='8c94552d022acec4a0458d70c19d3da9';
  const state={events:[],loading:false,error:null,query:'',selectedId:localStorage.getItem('pbe_nfl_event')||DEFAULT_EVENT,current:null};
  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  async function fetchJson(url){const r=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();}
  function arrayOf(payload){if(Array.isArray(payload))return payload;for(const key of ['events','games','data','results','schedule','odds'])if(Array.isArray(payload?.[key]))return payload[key];return[];}
  function normalize(raw){
    const id=raw?.id||raw?.event_id||raw?.eventId||raw?.key||raw?.provider_event_id;
    const away=raw?.away_team||raw?.away||raw?.awayTeam||raw?.visitor||raw?.visitor_team;
    const home=raw?.home_team||raw?.home||raw?.homeTeam||raw?.host||raw?.home_team_name;
    const start=raw?.commence_time||raw?.start_time||raw?.game_time||raw?.kickoff||raw?.date;
    if(!id||!away||!home)return null;
    return{id:String(id),away:String(away),home:String(home),start:start||null,sport_key:raw?.sport_key||raw?.sport||'americanfootball_nfl'};
  }
  function selected(){return state.events.find(e=>e.id===state.selectedId)||state.current||null;}
  function fmtDate(value){if(!value)return'Time unavailable';const d=new Date(value);if(Number.isNaN(d.getTime()))return String(value);return d.toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}
  function dayKey(value){const d=new Date(value);if(Number.isNaN(d.getTime()))return'Upcoming';return d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});}
  function timeOnly(value){const d=new Date(value);if(Number.isNaN(d.getTime()))return'—';return d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});}

  async function loadCurrent(){
    try{const board=await fetchJson(`${API}/api/odds/board?event_id=${encodeURIComponent(state.selectedId)}&markets=player_pass_yds`);const e=board?.event||{};state.current=normalize({id:state.selectedId,away_team:e.away_team||e.away,home_team:e.home_team||e.home,commence_time:e.commence_time||e.start_time||e.game_time});}catch(_){state.current=null;}
  }

  async function discover(){
    if(state.loading)return;state.loading=true;state.error=null;
    try{
      let rows=[];
      for(const path of ['/api/odds?season_type=regular','/api/odds']){
        try{const payload=await fetchJson(`${API}${path}`);rows=arrayOf(payload).map(normalize).filter(Boolean);if(rows.length)break;}catch(_){}
      }
      const seen=new Set();state.events=rows.filter(e=>{if(seen.has(e.id))return false;seen.add(e.id);return true;}).sort((a,b)=>new Date(a.start||0)-new Date(b.start||0));
      if(!state.events.some(e=>e.id===state.selectedId)&&state.current)state.events.push(state.current);
    }catch(error){
      state.error=error instanceof Error?error.message:String(error);
    }finally{
      state.loading=false;
      updateButton();
      window.dispatchEvent(new CustomEvent('pbe:events-loaded',{detail:{count:state.events.length,error:state.error||null}}));
    }
  }

  function buttonHtml(){const e=selected();return `<button class="pbe19-event-button" id="pbe19-event-button" type="button"><span class="pbe19-event-dot"></span><span class="pbe19-event-copy"><span class="pbe19-event-title">${esc(e?`${e.away} @ ${e.home}`:'Selected NFL Event')}</span><span class="pbe19-event-sub">${esc(e?.start?fmtDate(e.start):state.selectedId.slice(0,12))}</span></span><span class="pbe19-event-chevron">⌄</span></button>`;}
  function installButton(){const bar=document.querySelector('.pbe-v2-commandbar');if(!bar||document.getElementById('pbe19-event-button'))return;const quick=bar.querySelector('.pbe-v2-quicknav');if(quick)quick.insertAdjacentHTML('beforebegin',buttonHtml());else bar.insertAdjacentHTML('beforeend',buttonHtml());document.getElementById('pbe19-event-button')?.addEventListener('click',open);}
  function updateButton(){const old=document.getElementById('pbe19-event-button');if(!old){installButton();return;}const holder=document.createElement('div');holder.innerHTML=buttonHtml();const next=holder.firstElementChild;if(next){old.replaceWith(next);next.addEventListener('click',open);}}

  function filtered(){const q=state.query.trim().toLowerCase(),now=Date.now()-6*3600000;let rows=state.events.filter(e=>!e.start||new Date(e.start).getTime()>=now);if(q)rows=rows.filter(e=>`${e.away} ${e.home} ${e.id}`.toLowerCase().includes(q));return rows.slice(0,80);}
  function listHtml(){const rows=filtered();if(!rows.length)return `<div class="pbe19-empty"><div><strong>No discovered games</strong>${state.error?`Event discovery failed: ${esc(state.error)}.`:'No upcoming provider events matched the current search.'} You can still enter a known provider event ID manually.</div></div>`;const groups=new Map();rows.forEach(e=>{const key=dayKey(e.start);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);});return [...groups.entries()].map(([day,events])=>`<section><div class="pbe19-date-label">${esc(day)}</div>${events.map(e=>`<button class="pbe19-game ${e.id===state.selectedId?'selected':''}" data-event-id="${esc(e.id)}"><span class="pbe19-time">${esc(timeOnly(e.start))}</span><span><span class="pbe19-matchup">${esc(e.away)} @ ${esc(e.home)}</span><span class="pbe19-game-meta">Provider event · ${esc(e.id.slice(0,16))}${e.start?` · ${esc(fmtDate(e.start))}`:''}</span></span><span class="pbe19-select-tag">${e.id===state.selectedId?'Selected':'Choose'}</span></button>`).join('')}</section>`).join('');}
  function modalHtml(){return `<div class="pbe19-modal"><header class="pbe19-head"><button class="pbe19-close" onclick="PBEEventSelector.close()">×</button><div class="pbe19-kicker">GLOBAL NFL EVENT CONTEXT</div><h2>Choose the game that drives the OS.</h2><p>The selected provider event is shared by Prop Board, Matchups, Model Lab, Game Center, Player Research and PropChain. Event discovery comes from the NFL odds service; a known provider event ID can also be entered manually.</p></header><div class="pbe19-tools"><input id="pbe19-search" class="pbe19-search" type="search" placeholder="Search team or provider event ID…" value="${esc(state.query)}"><button id="pbe19-manual" class="pbe19-manual">Enter event ID</button></div><div class="pbe19-list" id="pbe19-list">${state.loading?'<div class="pbe19-empty"><div><strong>Discovering 2026 events</strong>Loading the current provider event list…</div></div>':listHtml()}</div><footer class="pbe19-foot">Changing the selected event refreshes the active intelligence page. Games with no current player-prop market may correctly show MARKET UNAVAILABLE.</footer></div>`;}
  function backdrop(){let el=document.getElementById('pbe19-backdrop');if(!el){el=document.createElement('div');el.id='pbe19-backdrop';el.className='pbe19-backdrop';el.addEventListener('mousedown',e=>{if(e.target===el)close();});document.body.appendChild(el);}return el;}
  async function open(){const el=backdrop();el.innerHTML=modalHtml();el.classList.add('open');wire();if(!state.events.length){await discover();if(el.classList.contains('open')){el.innerHTML=modalHtml();wire();}}}
  function close(){document.getElementById('pbe19-backdrop')?.classList.remove('open');}
  function activeRoute(){const active=document.querySelector('.nav-item.active')?.id?.replace(/^nav-/,'');return active||'home';}
  function choose(id){state.selectedId=id;localStorage.setItem('pbe_nfl_event',id);const chosen=state.events.find(e=>e.id===id);if(chosen)state.current=chosen;const url=new URL(location.href);url.searchParams.set('event',id);history.replaceState({},'',url);updateButton();close();window.dispatchEvent(new CustomEvent('pbe:event-changed',{detail:{eventId:id,event:chosen||null}}));const route=activeRoute();setTimeout(()=>window.App?.nav(route),0);}
  function manual(){const id=window.prompt('NFL provider event ID',state.selectedId);if(id&&id.trim())choose(id.trim());}
  function wire(){document.getElementById('pbe19-search')?.addEventListener('input',e=>{state.query=e.currentTarget.value||'';const list=document.getElementById('pbe19-list');if(list)list.innerHTML=listHtml();wireGames();});document.getElementById('pbe19-manual')?.addEventListener('click',manual);wireGames();}
  function wireGames(){document.querySelectorAll('.pbe19-game[data-event-id]').forEach(btn=>btn.addEventListener('click',()=>choose(btn.dataset.eventId)));}
  async function install(){installButton();await loadCurrent();updateButton();discover();}
  window.PBEEventSelector={open,close,choose,discover,state};install();document.addEventListener('DOMContentLoaded',install,{once:true});document.addEventListener('keydown',e=>{if(e.shiftKey&&e.key.toLowerCase()==='e'&&!['INPUT','TEXTAREA'].includes(e.target?.tagName)){e.preventDefault();open();}if(e.key==='Escape')close();});
})();
