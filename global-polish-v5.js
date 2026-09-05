/* PropBetEdge NFL — global OS polish v5.1 */
(() => {
  'use strict';

  const META = {
    home:['Dashboard','Market pulse · products · research'],
    games:['Games & Schedule','2026 factual schedule · event handoff · score semantics'],
    propboard:['Prop Board','Current sportsbook pricing · free market layer'],
    marketwatch:['Market Watch','Cross-book dispersion · local baseline movement · NFL Pro'],
    matchups:['Matchup Research','Selected-event market · news · historical context'],
    picks:['Model Lab','Production PBE model audit · NFL Pro'],
    pbepicks:['PBE Picks','Governed production decisions · NFL Pro'],
    trackrecord:['Track Record','Public verified publication record · official decisions only'],
    simulator:['Line Simulator','Model-derived threshold sensitivity · NFL Pro'],
    sgplab:['SGP Lab','Same-game leg research · no fake correlation · NFL Pro'],
    usage:['Usage Research','2025 final role baseline · current NEWS context'],
    propchain:['PropChain','Factual news → entity → market → model evidence map'],
    pbecast:['Game Center','Selected event · score state · market · news'],
    newsintel:['News Intelligence','Current NFL newsroom · impact · affected teams and players'],
    injuries:['Injury Editorial','PropBetEdge reporting · analysis · latest injury coverage'],
    trades:['Transactions','Current trades · signings · roster movement'],
    teams:['Team Research','Current team news · selected game · 2025 final context'],
    stats:['2025 Stats Archive','Historical final statistical leaders'],
    standings:['2025 Final Standings','Historical playoff picture · division results'],
    seasonhistory:['Season Archive','Champions · MVPs · awards · leaders'],
    'season-history':['Season Archive','Champions · MVPs · awards · leaders'],
    hof:['Hall of Fame','Canton induction archive'],
    records:['Records & Milestones','NFL all-time record book'],
    sb:['Super Bowl History','Championship archive'],
    prospects:['Draft Research','Source review · no stale live board']
  };

  const QUICK_NAV=[
    ['home','Dashboard'],['games','Games'],['propboard','Props'],['marketwatch','Watch'],
    ['matchups','Matchups'],['picks','Model'],['pbepicks','PBE Picks'],['trackrecord','Record'],
    ['simulator','Sim'],['sgplab','SGP'],['usage','Usage'],['propchain','PropChain'],
    ['pbecast','Game Center'],['newsintel','News'],['injuries','Injuries'],['trades','Transactions']
  ];

  function normalizeRoute(route){const raw=String(route||'home').replace(/^#/,'').toLowerCase();return raw==='season-history'?'seasonhistory':raw||'home';}
  function setCommandMeta(route){const key=normalizeRoute(route),meta=META[key]||[key.replace(/-/g,' '),'NFL intelligence workspace'];const name=document.getElementById('pbe-v2-view-name'),detail=document.getElementById('pbe-v2-view-meta');if(name)name.textContent=meta[0];if(detail)detail.textContent=meta[1];}

  function addIntelligenceNav(route,label,badge){
    const group=document.getElementById('intelligence-nav-group');if(!group||document.getElementById(`nav-${route}`))return;
    const el=document.createElement('a');el.className='nav-item';el.id=`nav-${route}`;el.href='javascript:void(0)';el.setAttribute('onclick',`App.nav('${route}')`);
    el.innerHTML=`<span class="ni-icon">${route==='pbepicks'?'◆':'✓'}</span> ${label}${badge?` <span class="nav-badge" style="color:${badge==='PUBLIC'?'#55d68c':'#d8b75b'};background:${badge==='PUBLIC'?'rgba(85,214,140,.06)':'rgba(216,183,91,.06)'}">${badge}</span>`:''}`;
    group.appendChild(el);
  }

  function ensureProductNav(){addIntelligenceNav('pbepicks','PBE Picks','PRO');addIntelligenceNav('trackrecord','Track Record','PUBLIC');}
  function reorderIntelligence(){const group=document.getElementById('intelligence-nav-group');if(!group)return;['nav-home','nav-games','nav-propboard','nav-marketwatch','nav-matchups','nav-picks','nav-qbdna','nav-pbepicks','nav-trackrecord','nav-simulator','nav-sgplab','nav-usage','nav-propchain','nav-pbecast','nav-newsintel','nav-injuries','nav-trades'].forEach(id=>{const el=document.getElementById(id);if(el)group.appendChild(el)});}
  function renameGroups(){document.querySelectorAll('.nav-group-label').forEach(label=>{const text=label.textContent.trim();if(text==='2025 Archive')label.textContent='Season Archive';if(text==='Research')label.textContent='History & Research';});const foot=document.querySelector('.sf-season');if(foot)foot.textContent='NFL Intelligence OS';const status=document.querySelector('.sf-status');if(status)status.textContent='Games · market · model · picks · usage · news · archive';const api=document.querySelector('.sf-api');if(api)api.innerHTML='NFL Pro · $9.99/week <span class="pbe-os-shortcut"><kbd>Ctrl K</kbd> search</span> <span class="pbe-os-shortcut"><kbd>Shift E</kbd> event</span>';}

  function syncQuickNav(route){const key=normalizeRoute(route||window.App?.current);document.querySelectorAll('.pbe-v2-quicknav [data-route]').forEach(el=>{const active=el.dataset.route===key;el.classList.toggle('primary',active);el.setAttribute('aria-current',active?'page':'false')});}
  function rebuildQuickNav(){const nav=document.querySelector('.pbe-v2-quicknav');if(!nav)return;nav.innerHTML=QUICK_NAV.map(([route,label])=>`<button type="button" data-route="${route}" onclick="App.nav('${route}')">${label}</button>`).join('');syncQuickNav(window.App?.current||'home');}

  function rebuildMobile(){const teams=document.getElementById('mbn-teams');if(teams){teams.id='mbn-matchups';teams.setAttribute('onclick',"App.nav('matchups');pbeMbnActive('matchups')");const icon=teams.querySelector('.mbn-icon'),label=teams.querySelector('span');if(icon)icon.textContent='◫';if(label)label.textContent='Matchup';}const news=document.getElementById('mbn-news');if(news){news.id='mbn-game';news.setAttribute('onclick',"App.nav('pbecast');pbeMbnActive('game')");const icon=news.querySelector('.mbn-icon'),label=news.querySelector('span');if(icon)icon.textContent='◉';if(label)label.textContent='Game';}}
  function wrapNav(){if(!window.App?.nav||App.__pbeOsPolishV51Wrapped)return;const previous=App.nav.bind(App);App.nav=function(route,...rest){const result=previous(route,...rest);setCommandMeta(route);syncQuickNav(route);setTimeout(()=>{setCommandMeta(route);syncQuickNav(route)},0);setTimeout(()=>{setCommandMeta(route);syncQuickNav(route)},120);return result;};App.__pbeOsPolishV51Wrapped=true;}
  function install(){ensureProductNav();reorderIntelligence();renameGroups();rebuildQuickNav();rebuildMobile();wrapNav();const active=window.App?.current||document.querySelector('.nav-item.active')?.id?.replace(/^nav-/,'')||'home';setCommandMeta(active);syncQuickNav(active);}

  install();document.addEventListener('DOMContentLoaded',install,{once:true});window.addEventListener('pbe:upgrades-ready',install);window.addEventListener('pbe:route-changed',event=>syncQuickNav(event?.detail?.route||window.App?.current));setTimeout(install,250);setTimeout(install,800);
})();