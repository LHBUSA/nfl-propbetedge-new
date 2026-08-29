/* PropBetEdge NFL — Command Palette v3
 * Pages are indexed from the actual live nav so the palette grows with the product.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const DEFAULT_EVENT='8c94552d022acec4a0458d70c19d3da9';
  const MARKET_SET=['player_pass_yds','player_reception_yds','player_receptions','player_rush_yds'];
  const state={open:false,query:'',active:0,marketPlayers:[],marketLabel:'',marketFetchedAt:0};
  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const currentEvent=()=>new URLSearchParams(location.search).get('event')||localStorage.getItem('pbe_nfl_event')||DEFAULT_EVENT;
  const playerOf=item=>item?.player||item?.player_name||'';
  async function fetchJson(url){const r=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();}
  function marketLabel(m){return({player_pass_yds:'Passing Yards',player_reception_yds:'Receiving Yards',player_receptions:'Receptions',player_rush_yds:'Rushing Yards'}[m]||String(m||'').replace(/^player_/,'').replace(/_/g,' '));}
  function crest(abbr,size=25){try{if(typeof teamCrest==='function')return teamCrest(abbr,size)}catch(_){}return `<strong>${esc(abbr)}</strong>`;}

  function pageMeta(route,title){
    const map={
      home:['NFL Intelligence OS overview','⌂'],propboard:['Current sportsbook market desk','↗'],matchups:['Selected-event market + news + archive context','◫'],picks:['Production PBE model audit','◈'],simulator:['Model-derived line sensitivity · NFL Pro','⌁'],usage:['2025 role baseline + current news','▥'],propchain:['News → entity → market → model evidence map','◇'],pbecast:['Selected event score state + market + news','◉'],injuries:['Current NEWS injury developments','＋'],trades:['Current transactions + roster movement','⇄'],teams:['32 NFL franchise research directory','⬡'],stats:['2025 final statistical archive','▦'],standings:['2025 final standings archive','▥'],seasonhistory:['Champions, MVPs, awards and leaders','▤'],hof:['Canton induction archive','★'],records:['NFL all-time record book','↗'],prospects:['Draft data review state','⌖'],sb:['Championship archive','◆']
    };
    return map[route]||['NFL intelligence workspace','•'];
  }

  function navPages(){
    const seen=new Set(),rows=[];
    document.querySelectorAll('.sidebar-nav .nav-item[id^="nav-"]').forEach(el=>{
      const route=el.id.replace(/^nav-/,'');if(!route||seen.has(route))return;seen.add(route);
      const title=(el.textContent||route).replace(/\s+(LIVE|PRO|BETA|NEWS|BASELINE|REVIEW|EVENT)\s*$/i,'').trim();
      const [sub,icon]=pageMeta(route,title);
      const archive=['stats','standings','seasonhistory','hof','records','sb'].includes(route);
      const live=['propboard','injuries','trades','pbecast'].includes(route);
      rows.push({kind:'page',route,title,sub,icon,type:archive?'ARCHIVE':live?'CURRENT':'PAGE',archive,live});
    });
    return rows;
  }

  async function refreshMarketIndex(){
    if(Date.now()-state.marketFetchedAt<60000&&state.marketPlayers.length)return;
    try{
      const board=await fetchJson(`${API}/api/odds/board?event_id=${encodeURIComponent(currentEvent())}&markets=${encodeURIComponent(MARKET_SET.join(','))}`);
      const map=new Map();[...(board.market_summary||[]),...(board.quotes||[])].forEach(item=>{const player=playerOf(item);if(!player)return;const key=player.toLowerCase();if(!map.has(key))map.set(key,{name:player,markets:new Set()});if(item.market)map.get(key).markets.add(item.market);});
      state.marketPlayers=[...map.values()].map(p=>({name:p.name,markets:[...p.markets]}));const e=board.event||{},away=e.away_team||e.away,home=e.home_team||e.home;state.marketLabel=away&&home?`${away} @ ${home}`:'selected event';
    }catch(_){state.marketPlayers=[];state.marketLabel='market unavailable';}finally{state.marketFetchedAt=Date.now();}
  }

  function archivePlayers(){
    const map=new Map();const add=(name,source)=>{const n=String(name||'').trim();if(!n)return;const key=n.toLowerCase();if(!map.has(key))map.set(key,{name:n,sources:new Set()});map.get(key).sources.add(source);};
    Object.values(window.StatsView?.STATS||{}).forEach(cat=>(cat?.rows||[]).forEach(row=>add(row?.[1],'2025 Stats')));(window.HOF_MEMBERS||[]).forEach(m=>add(m.name,'Hall of Fame'));(window.MVP_HISTORY||[]).forEach(m=>add(m.player,'MVP History'));Object.values(window.NFL_RECORDS||{}).flat().forEach(r=>add(r?.holder,'NFL Records'));(window.SUPER_BOWLS||[]).forEach(sb=>add(String(sb.mvp||'').split(',')[0].trim(),'Super Bowl MVP'));
    return [...map.values()].map(p=>({name:p.name,sources:[...p.sources]}));
  }
  function teams(){return Object.values(window.NFL_TEAMS||{}).map(t=>({abbr:t.abbr,name:t.name,city:t.city,conf:t.conf,div:t.div}));}
  function score(text,q){const t=String(text||'').toLowerCase(),n=q.toLowerCase();if(!n)return 1;if(t===n)return 100;if(t.startsWith(n))return 80;if(t.split(/\s+/).some(w=>w.startsWith(n)))return 60;if(t.includes(n))return 40;return 0;}

  function resultData(){
    const q=state.query.trim().toLowerCase(),groups=[];
    const pages=navPages().map(p=>({...p,_score:Math.max(score(p.title,q),score(p.sub,q))})).filter(p=>!q||p._score).sort((a,b)=>b._score-a._score).slice(0,q?10:8);if(pages.length)groups.push({label:q?'Pages & tools':'Quick actions',items:pages});
    const current=state.marketPlayers.map(p=>({...p,_score:score(p.name,q)})).filter(p=>!q||p._score).sort((a,b)=>b._score-a._score||a.name.localeCompare(b.name)).slice(0,q?8:5);if(current.length)groups.push({label:`Current market players · ${state.marketLabel}`,items:current.map(p=>({kind:'player',title:p.name,sub:p.markets.map(marketLabel).join(' · '),icon:'P',type:'CURRENT MARKET',live:true}))});
    const teamRows=teams().map(t=>({...t,_score:Math.max(score(t.name,q),score(t.city,q),score(t.abbr,q))})).filter(t=>q&&t._score).sort((a,b)=>b._score-a._score).slice(0,7);if(teamRows.length)groups.push({label:'NFL teams',items:teamRows.map(t=>({kind:'team',title:t.name,sub:`${t.city} · ${t.conf} ${t.div}`,icon:t.abbr,type:'TEAM',abbr:t.abbr}))});
    if(q){const currentNames=new Set(state.marketPlayers.map(p=>p.name.toLowerCase()));const archived=archivePlayers().map(p=>({...p,_score:score(p.name,q)})).filter(p=>p._score&&!currentNames.has(p.name.toLowerCase())).sort((a,b)=>b._score-a._score||a.name.localeCompare(b.name)).slice(0,9);if(archived.length)groups.push({label:'Historical players',items:archived.map(p=>({kind:'player',title:p.name,sub:p.sources.join(' · '),icon:'P',type:'ARCHIVE',archive:true}))});}
    return groups;
  }

  function resultIcon(item){return item.kind==='team'?crest(item.abbr,25):esc(item.icon||'•');}
  function html(){const groups=resultData();let flat=0;const body=groups.length?groups.map(group=>`<section class="pbe18-group"><div class="pbe18-group-label">${esc(group.label)}</div>${group.items.map(item=>{const i=flat++;return `<button class="pbe18-result ${i===state.active?'active':''}" data-index="${i}" data-kind="${esc(item.kind)}" data-title="${esc(item.title)}" data-route="${esc(item.route||'')}" data-abbr="${esc(item.abbr||'')}"><span class="pbe18-result-icon">${resultIcon(item)}</span><span><span class="pbe18-result-title">${esc(item.title)}</span><span class="pbe18-result-sub">${esc(item.sub||'')}</span></span><span class="pbe18-result-type ${item.live?'live':item.archive?'archive':''}">${esc(item.type||item.kind)}</span></button>`}).join('')}</section>`).join(''):`<div class="pbe18-empty"><div><strong>No matching research object</strong>Try a player surname, team, product page, record holder or archive topic.</div></div>`;return `<div class="pbe18-command"><div class="pbe18-searchbar"><div class="pbe18-search-icon">⌕</div><input id="pbe18-query" type="search" autocomplete="off" placeholder="Search NFL intelligence…" value="${esc(state.query)}"><span class="pbe18-esc">ESC</span></div><div class="pbe18-context">Live product routes · current market players · 32 teams · 2025 leaders · Hall of Fame · MVPs · record holders</div><div class="pbe18-results" id="pbe18-results">${body}</div><footer class="pbe18-foot"><span><span class="pbe18-key">↑↓</span> move</span><span><span class="pbe18-key">ENTER</span> open</span><span><span class="pbe18-key">ESC</span> close</span></footer></div>`;}
  function backdrop(){let el=document.getElementById('pbe18-command-backdrop');if(!el){el=document.createElement('div');el.id='pbe18-command-backdrop';el.className='pbe18-command-backdrop';el.addEventListener('mousedown',e=>{if(e.target===el)close();});document.body.appendChild(el);}return el;}
  function render(){const el=backdrop();el.innerHTML=html();el.classList.add('open');state.open=true;wire();requestAnimationFrame(()=>{const input=document.getElementById('pbe18-query');input?.focus();input?.setSelectionRange(input.value.length,input.value.length);});}
  async function open(initial=''){state.query=initial;state.active=0;render();await refreshMarketIndex();if(state.open)render();}
  function close(){state.open=false;state.query='';state.active=0;document.getElementById('pbe18-command-backdrop')?.classList.remove('open');}
  function activate(button){const kind=button.dataset.kind,title=button.dataset.title,route=button.dataset.route,abbr=button.dataset.abbr;close();if(kind==='page'&&route){window.App?.nav(route);return;}if(kind==='team'&&abbr){if(window.PBETeamsV2)PBETeamsV2.openTeam(abbr);else window.App?.nav('teams');return;}if(kind==='player'&&title){window.PBEPlayerResearch?.show(title);}}
  function move(delta){const buttons=[...document.querySelectorAll('.pbe18-result')];if(!buttons.length)return;state.active=(state.active+delta+buttons.length)%buttons.length;buttons.forEach((b,i)=>b.classList.toggle('active',i===state.active));buttons[state.active]?.scrollIntoView({block:'nearest'});}
  function wire(){const input=document.getElementById('pbe18-query');input?.addEventListener('input',e=>{state.query=e.currentTarget.value||'';state.active=0;const results=document.getElementById('pbe18-results');if(results){const holder=document.createElement('div');holder.innerHTML=html();const next=holder.querySelector('#pbe18-results');results.innerHTML=next?next.innerHTML:'';wireResults();}});input?.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();move(1)}else if(e.key==='ArrowUp'){e.preventDefault();move(-1)}else if(e.key==='Enter'){e.preventDefault();document.querySelector('.pbe18-result.active')?.click()}else if(e.key==='Escape'){e.preventDefault();close();}});wireResults();}
  function wireResults(){document.querySelectorAll('.pbe18-result').forEach(button=>{button.addEventListener('mouseenter',()=>{state.active=Number(button.dataset.index)||0;document.querySelectorAll('.pbe18-result').forEach((b,i)=>b.classList.toggle('active',i===state.active));});button.addEventListener('click',()=>activate(button));});}
  function installSidebar(){const input=document.getElementById('global-search');if(!input)return;input.readOnly=true;input.value='';input.placeholder='Search everything…  Ctrl K';input.setAttribute('aria-label','Open NFL command palette');const old=document.getElementById('search-results');if(old)old.style.display='none';input.addEventListener('focus',()=>{input.blur();open();},true);input.addEventListener('click',e=>{e.preventDefault();open();},true);}
  function install(){installSidebar();return true;}
  window.PBECommandPalette={open,close,state};install();document.addEventListener('DOMContentLoaded',install,{once:true});document.addEventListener('keydown',e=>{const tag=String(e.target?.tagName||'').toLowerCase(),typing=tag==='input'||tag==='textarea'||e.target?.isContentEditable;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();state.open?close():open();return;}if(e.key==='/'&&!typing&&!state.open){e.preventDefault();open();return;}if(e.key==='Escape'&&state.open)close();});window.addEventListener('pbe:event-changed',()=>{state.marketFetchedAt=0;state.marketPlayers=[];});
})();
