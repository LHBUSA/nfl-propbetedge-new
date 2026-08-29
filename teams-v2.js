/* PropBetEdge NFL — Teams v2 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const DEFAULT_EVENT = '8c94552d022acec4a0458d70c19d3da9';
  const state = { search:'', conf:'all', div:'all', sort:'name', activeTeams:new Set(), market:null };

  const esc = value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const currentEvent = () => new URLSearchParams(location.search).get('event') || localStorage.getItem('pbe_nfl_event') || DEFAULT_EVENT;

  async function fetchJson(url) {
    const response=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function crest(abbr,size=30) {
    try { if (typeof teamCrest === 'function') return teamCrest(abbr,size); } catch (_) {}
    return `<strong style="color:#fff;font:900 12px 'Barlow Condensed',sans-serif">${esc(abbr)}</strong>`;
  }

  function allTeams() {
    if (!window.NFL_TEAMS) return [];
    return Object.values(NFL_TEAMS);
  }

  function activeNamesFromMarket(board) {
    const event=board?.event || {};
    const names=[event.away_team||event.away,event.home_team||event.home].filter(Boolean).map(String);
    const out=new Set();
    allTeams().forEach(team => {
      if (names.some(name => name.toLowerCase()===String(team.name).toLowerCase() || name.toLowerCase().includes(String(team.city).toLowerCase()))) out.add(team.abbr);
    });
    return out;
  }

  function filteredTeams() {
    const q=state.search.trim().toLowerCase();
    const rows=allTeams().filter(team => {
      const searchOk=!q || [team.name,team.city,team.abbr,team.stadium].some(v=>String(v||'').toLowerCase().includes(q));
      const confOk=state.conf==='all' || team.conf===state.conf;
      const divOk=state.div==='all' || team.div===state.div;
      return searchOk && confOk && divOk;
    });
    if(state.sort==='founded') return rows.sort((a,b)=>(a.founded||9999)-(b.founded||9999));
    if(state.sort==='titles') return rows.sort((a,b)=>(b.sbWins||0)-(a.sbWins||0) || a.name.localeCompare(b.name));
    return rows.sort((a,b)=>a.name.localeCompare(b.name));
  }

  function teamCard(team) {
    const active=state.activeTeams.has(team.abbr);
    return `<article class="pbe5-team-card" data-team="${esc(team.abbr)}" style="--team:${esc(team.color||'#55d68c')}">${active?'<span class="pbe5-active-market">LIVE MARKET</span>':''}<div class="pbe5-card-top"><div class="pbe5-crest">${crest(team.abbr,31)}</div><div><div class="pbe5-team-abbr">${esc(team.abbr)} · ${esc(team.conf)} ${esc(team.div)}</div><div class="pbe5-team-name">${esc(team.name)}</div></div></div><div class="pbe5-team-meta"><div class="pbe5-meta-box"><b>${esc(team.sbWins ?? 0)}</b><span>Super Bowl wins</span></div><div class="pbe5-meta-box"><b>${esc(team.founded || '—')}</b><span>Founded</span></div></div></article>`;
  }

  function divisionGroups(rows) {
    const groups=[];
    ['AFC','NFC'].forEach(conf => {
      const confRows=rows.filter(team=>team.conf===conf);
      if(!confRows.length) return;
      const divisions=['East','North','South','West'].map(div=>({div,teams:confRows.filter(team=>team.div===div)})).filter(group=>group.teams.length);
      groups.push({conf,divisions});
    });
    return groups;
  }

  function groupsHtml(rows) {
    const groups=divisionGroups(rows);
    if(!groups.length) return '<div class="pbe5-empty">No NFL teams match the current filters.</div>';
    return groups.map(group=>`<section class="pbe5-conference"><div class="pbe5-conf-head"><div><h2>${group.conf}</h2><p>${group.conf==='AFC'?'American Football Conference':'National Football Conference'}</p></div><span class="pbe5-conf-badge">${group.divisions.reduce((sum,d)=>sum+d.teams.length,0)} teams shown</span></div><div class="pbe5-division-grid">${group.divisions.map(div=>`<section class="pbe5-division"><div class="pbe5-division-title">${group.conf} ${div.div}</div><div class="pbe5-team-list">${div.teams.map(teamCard).join('')}</div></section>`).join('')}</div></section>`).join('');
  }

  function marketHtml() {
    const board=state.market;
    if(!board) return `<section class="pbe5-market-context"><div><strong>Current market context unavailable.</strong><span>The franchise directory remains available; no synthetic current matchup is substituted.</span></div><span>MARKET UNAVAILABLE</span></section>`;
    const event=board.event||{};
    const away=event.away_team||event.away||'Away';
    const home=event.home_team||event.home||'Home';
    const semantics=board?.source?.semantics||'UNAVAILABLE';
    return `<section class="pbe5-market-context"><div><strong>${esc(away)} @ ${esc(home)}</strong><span>Teams participating in the selected live Prop Board event are highlighted inside the directory.</span></div><span class="${semantics==='LIVE'?'pbe5-live':''}">MARKET ${esc(semantics)}</span></section>`;
  }

  function summaryHtml(rows) {
    const titles=rows.reduce((sum,t)=>sum+(Number(t.sbWins)||0),0);
    const oldest=rows.length?[...rows].sort((a,b)=>(a.founded||9999)-(b.founded||9999))[0]:null;
    return `<div class="pbe5-summary"><div class="pbe5-stat"><b>${rows.length}</b><span>Teams in current view</span></div><div class="pbe5-stat"><b>${new Set(rows.map(t=>t.stadium).filter(Boolean)).size}</b><span>Stadiums represented</span></div><div class="pbe5-stat"><b class="green">${titles}</b><span>Super Bowl wins in current view</span></div><div class="pbe5-stat"><b>${esc(oldest?.founded||'—')}</b><span>Oldest franchise in current view</span></div></div>`;
  }

  function renderBody() {
    const rows=filteredTeams();
    const host=document.getElementById('pbe5-results');
    const summary=document.getElementById('pbe5-summary');
    if(summary) summary.innerHTML=summaryHtml(rows);
    if(host) host.innerHTML=groupsHtml(rows);
    wireCards();
  }

  function shellHtml() {
    return `<section class="pbe5-teams"><header class="pbe5-hero"><div><div class="pbe5-kicker">NFL FRANCHISE RESEARCH</div><h1 class="pbe5-title">Thirty-two teams.<br><em>One research surface.</em></h1><div class="pbe5-copy">A cleaner franchise layer for division structure, stadium context, founding history and championship record. Older season-specific coach/record snapshots remain out of the headline UI so archive metadata is never mistaken for current 2026 status.</div></div><aside class="pbe5-hero-side"><strong>32</strong><span>NFL franchises · 8 divisions · AFC + NFC</span></aside></header>${marketHtml()}<div class="pbe5-controls"><input id="pbe5-search" class="pbe5-input" type="search" placeholder="Search team, city, stadium…" value="${esc(state.search)}"><select id="pbe5-conf" class="pbe5-select"><option value="all">All conferences</option><option value="AFC" ${state.conf==='AFC'?'selected':''}>AFC</option><option value="NFC" ${state.conf==='NFC'?'selected':''}>NFC</option></select><select id="pbe5-div" class="pbe5-select"><option value="all">All divisions</option>${['East','North','South','West'].map(div=>`<option value="${div}" ${state.div===div?'selected':''}>${div}</option>`).join('')}</select><select id="pbe5-sort" class="pbe5-select"><option value="name">Name A–Z</option><option value="titles" ${state.sort==='titles'?'selected':''}>Most championships</option><option value="founded" ${state.sort==='founded'?'selected':''}>Oldest franchises</option></select></div><div id="pbe5-summary">${summaryHtml(filteredTeams())}</div><div id="pbe5-results">${groupsHtml(filteredTeams())}</div></section>`;
  }

  async function render() {
    const vc=document.getElementById('view-container');
    if(!vc) return;
    vc.innerHTML='<section class="pbe5-teams"><div class="pbe5-empty">Loading NFL franchise directory…</div></section>';
    state.market=null;state.activeTeams=new Set();
    try {
      state.market=await fetchJson(`${API}/api/odds/board?event_id=${encodeURIComponent(currentEvent())}&markets=player_pass_yds`);
      state.activeTeams=activeNamesFromMarket(state.market);
    } catch (_) {}
    vc.innerHTML=shellHtml();
    wire();
  }

  function wire() {
    document.getElementById('pbe5-search')?.addEventListener('input',event=>{state.search=event.currentTarget.value||'';renderBody();});
    document.getElementById('pbe5-conf')?.addEventListener('change',event=>{state.conf=event.currentTarget.value||'all';renderBody();});
    document.getElementById('pbe5-div')?.addEventListener('change',event=>{state.div=event.currentTarget.value||'all';renderBody();});
    document.getElementById('pbe5-sort')?.addEventListener('change',event=>{state.sort=event.currentTarget.value||'name';renderBody();});
    wireCards();
  }

  function wireCards() {
    document.querySelectorAll('.pbe5-team-card[data-team]').forEach(card=>card.addEventListener('click',()=>openTeam(card.dataset.team)));
  }

  function openTeam(abbr) {
    const team=window.NFL_TEAMS?.[abbr];
    if(!team) return;
    let backdrop=document.getElementById('pbe5-drawer-backdrop');
    if(!backdrop){backdrop=document.createElement('div');backdrop.id='pbe5-drawer-backdrop';backdrop.className='pbe5-drawer-backdrop';backdrop.addEventListener('click',event=>{if(event.target===backdrop)closeTeam();});document.body.appendChild(backdrop);}
    const active=state.activeTeams.has(abbr);
    backdrop.innerHTML=`<aside class="pbe5-drawer" style="--team-glow:${esc(team.color||'#55d68c')}18"><header class="pbe5-drawer-head"><button class="pbe5-close" onclick="PBETeamsV2.closeTeam()">×</button><div class="pbe5-drawer-kicker">${esc(team.conf)} ${esc(team.div)} · FRANCHISE PROFILE</div><div class="pbe5-drawer-title">${esc(team.name)}</div><div class="pbe5-drawer-sub">${esc(team.city)} · ${esc(team.stadium||'Stadium unavailable')}${active?' · Current selected market event':''}</div></header><div class="pbe5-drawer-body"><div class="pbe5-profile-grid"><div class="pbe5-profile-stat"><b>${esc(team.founded||'—')}</b><span>Founded</span></div><div class="pbe5-profile-stat"><b>${esc(team.sbWins??0)}</b><span>Super Bowl wins</span></div><div class="pbe5-profile-stat"><b>${esc(team.sb??0)}</b><span>Super Bowl appearances</span></div><div class="pbe5-profile-stat"><b>${esc(team.conf)}</b><span>Conference</span></div><div class="pbe5-profile-stat"><b>${esc(team.div)}</b><span>Division</span></div><div class="pbe5-profile-stat"><b>${esc(team.cap||'—')}</b><span>Listed stadium capacity</span></div></div><section class="pbe5-profile-panel"><strong>Home venue</strong><p>${esc(team.stadium||'Venue unavailable')}. Franchise metadata here is treated as reference data; season-specific coach and 2024 record fields are intentionally not presented as current 2026 status.</p></section><section class="pbe5-profile-panel"><strong>Connected intelligence</strong><p>${active?'This team participates in the currently selected sportsbook market event.':'This team is not part of the currently selected sportsbook event.'} Use the market desk for current player props or the NFL newsroom for current coverage.</p><div class="pbe5-profile-actions">${active?'<button class="pbe5-action primary" onclick="PBETeamsV2.closeTeam();App.nav(\'propboard\')">Open current Prop Board</button>':''}<a class="pbe5-action" href="https://propbetedge.ai/news/nfl">NFL News ↗</a><button class="pbe5-action" onclick="PBETeamsV2.closeTeam();App.nav('seasonhistory')">Season Archive</button></div></section></div></aside>`;
    backdrop.classList.add('open');document.body.style.overflow='hidden';
  }

  function closeTeam(){document.getElementById('pbe5-drawer-backdrop')?.classList.remove('open');document.body.style.overflow='';}
  function install(){if(!window.App?.VIEWS)return false;App.VIEWS.teams=render;return true;}
  window.PBETeamsV2={render,openTeam,closeTeam,state};install();document.addEventListener('DOMContentLoaded',install,{once:true});document.addEventListener('keydown',event=>{if(event.key==='Escape')closeTeam();});
})();
