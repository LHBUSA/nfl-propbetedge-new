/* PropBetEdge NFL — global OS polish v5 */
(() => {
  'use strict';

  const META = {
    home:['Dashboard','Market pulse · products · research'],
    games:['Games & Schedule','2026 factual schedule · event handoff · score semantics'],
    propboard:['Prop Board','Current sportsbook pricing · free market layer'],
    marketwatch:['Market Watch','Cross-book dispersion · local baseline movement · NFL Pro'],
    matchups:['Matchup Research','Selected-event market · news · historical context'],
    picks:['Model Lab','Production PBE model audit · NFL Pro'],
    simulator:['Line Simulator','Model-derived threshold sensitivity · NFL Pro'],
    sgplab:['SGP Lab','Same-game leg research · no fake correlation · NFL Pro'],
    usage:['Usage Research','2025 final role baseline · current NEWS context'],
    propchain:['PropChain','Factual news → entity → market → model evidence map'],
    pbecast:['Game Center','Selected event · score state · market · news'],
    newsintel:['News Intelligence','Current NFL newsroom · impact · affected teams and players'],
    injuries:['Injury Intelligence','Current NEWS developments · official-status boundary'],
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

  function setCommandMeta(route){const meta=META[route]||[String(route||'NFL').replace(/-/g,' '),'NFL intelligence workspace'];const name=document.getElementById('pbe-v2-view-name'),detail=document.getElementById('pbe-v2-view-meta');if(name)name.textContent=meta[0];if(detail)detail.textContent=meta[1];}
  function reorderIntelligence(){const group=document.getElementById('intelligence-nav-group');if(!group)return;['nav-home','nav-games','nav-propboard','nav-marketwatch','nav-matchups','nav-picks','nav-simulator','nav-sgplab','nav-usage','nav-propchain','nav-pbecast','nav-newsintel','nav-injuries','nav-trades'].forEach(id=>{const el=document.getElementById(id);if(el)group.appendChild(el)});}
  function renameGroups(){document.querySelectorAll('.nav-group-label').forEach(label=>{const text=label.textContent.trim();if(text==='2025 Archive')label.textContent='Season Archive';if(text==='Research')label.textContent='History & Research';});const foot=document.querySelector('.sf-season');if(foot)foot.textContent='NFL Intelligence OS';const status=document.querySelector('.sf-status');if(status)status.textContent='Games · market · model · SGP · usage · news · archive';const api=document.querySelector('.sf-api');if(api)api.innerHTML='NFL Pro · $9.99/week <span class="pbe-os-shortcut"><kbd>Ctrl K</kbd> search</span> <span class="pbe-os-shortcut"><kbd>Shift E</kbd> event</span>';}
  function rebuildQuickNav(){const nav=document.querySelector('.pbe-v2-quicknav');if(!nav)return;nav.innerHTML=`<button onclick="App.nav('home')">Dashboard</button><button onclick="App.nav('games')">Games</button><button class="primary" onclick="App.nav('propboard')">Props</button><button onclick="App.nav('marketwatch')">Watch</button><button onclick="App.nav('matchups')">Matchups</button><button onclick="App.nav('picks')">Model</button><button onclick="App.nav('simulator')">Sim</button><button onclick="App.nav('sgplab')">SGP</button><button onclick="App.nav('newsintel')">News</button>`;}
  function rebuildMobile(){const teams=document.getElementById('mbn-teams');if(teams){teams.id='mbn-matchups';teams.setAttribute('onclick',"App.nav('matchups');pbeMbnActive('matchups')");const icon=teams.querySelector('.mbn-icon'),label=teams.querySelector('span');if(icon)icon.textContent='◫';if(label)label.textContent='Matchup';}const news=document.getElementById('mbn-news');if(news){news.id='mbn-game';news.setAttribute('onclick',"App.nav('pbecast');pbeMbnActive('game')");const icon=news.querySelector('.mbn-icon'),label=news.querySelector('span');if(icon)icon.textContent='◉';if(label)label.textContent='Game';}}
  function wrapNav(){if(!window.App?.nav||App.__pbeOsPolishV5Wrapped)return;const previous=App.nav.bind(App);App.nav=function(route){const result=previous(route);setCommandMeta(route);setTimeout(()=>setCommandMeta(route),0);setTimeout(()=>setCommandMeta(route),120);return result;};App.__pbeOsPolishV5Wrapped=true;}
  function install(){reorderIntelligence();renameGroups();rebuildQuickNav();rebuildMobile();wrapNav();const active=document.querySelector('.nav-item.active')?.id?.replace(/^nav-/,'')||'home';setCommandMeta(active);}
  install();document.addEventListener('DOMContentLoaded',install,{once:true});window.addEventListener('pbe:upgrades-ready',install);setTimeout(install,250);setTimeout(install,800);
})();
