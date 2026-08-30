/* PropBetEdge NFL — Games Command Layer v4
 * Restores official team marks after the v3 markup change and turns each
 * provider-linked matchup into a launchpad for the NFL Intelligence OS.
 */
(() => {
  'use strict';

  const TEAM_NAMES = new Map(Object.entries({
    'arizona cardinals':'ARI','atlanta falcons':'ATL','baltimore ravens':'BAL','buffalo bills':'BUF',
    'carolina panthers':'CAR','chicago bears':'CHI','cincinnati bengals':'CIN','cleveland browns':'CLE',
    'dallas cowboys':'DAL','denver broncos':'DEN','detroit lions':'DET','green bay packers':'GB',
    'houston texans':'HOU','indianapolis colts':'IND','jacksonville jaguars':'JAX','kansas city chiefs':'KC',
    'las vegas raiders':'LV','los angeles chargers':'LAC','los angeles rams':'LAR','miami dolphins':'MIA',
    'minnesota vikings':'MIN','new england patriots':'NE','new orleans saints':'NO','new york giants':'NYG',
    'new york jets':'NYJ','philadelphia eagles':'PHI','pittsburgh steelers':'PIT','san francisco 49ers':'SF',
    'seattle seahawks':'SEA','tampa bay buccaneers':'TB','tennessee titans':'TEN','washington commanders':'WAS'
  }));
  const PATH_ALIAS={WAS:'wsh',WSH:'wsh'};
  let timer=null;

  const normalize=value=>String(value||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
  const esc=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  function resolveAbbr(value){
    const media=window.PBENFLMediaV2;
    const viaMedia=media?.resolveAbbr?.(value);
    if(viaMedia)return viaMedia==='WSH'?'WAS':viaMedia;
    const raw=String(value||'').trim().toUpperCase();
    if(/^[A-Z]{2,4}$/.test(raw))return raw==='WSH'?'WAS':raw;
    const key=normalize(value);
    if(TEAM_NAMES.has(key))return TEAM_NAMES.get(key);
    for(const [name,abbr] of TEAM_NAMES.entries())if(key&&(name.includes(key)||key.includes(name)))return abbr;
    return'';
  }

  function logoUrl(abbr){
    const clean=String(PATH_ALIAS[abbr]||abbr||'').toLowerCase();
    return clean?`https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${clean}.png`:'';
  }

  function teamColor(abbr){
    return window.NFL_TEAMS?.[abbr]?.color||window.TEAM_VISUALS?.[abbr]?.c1||'#68bfff';
  }

  function rgba(hex,alpha){
    const value=String(hex||'').replace('#','');
    if(!/^[0-9a-f]{6}$/i.test(value))return `rgba(104,191,255,${alpha})`;
    const n=parseInt(value,16);
    return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${alpha})`;
  }

  function officialLogo(holder,abbr,label,eager=false){
    if(!holder||!abbr)return;
    const src=logoUrl(abbr);
    if(!src)return;
    const current=holder.querySelector('img[data-pbe-game-logo="1"]');
    if(current&&current.dataset.teamAbbr===abbr)return;
    const img=document.createElement('img');
    img.className='pbe25-official-logo';
    img.dataset.pbeGameLogo='1';
    img.dataset.teamAbbr=abbr;
    img.src=src;
    img.alt=`${label||abbr} logo`;
    img.loading=eager?'eager':'lazy';
    img.decoding='async';
    img.addEventListener('error',()=>{
      if(!img.isConnected)return;
      const fallback=document.createElement('strong');
      fallback.className='pbe25-logo-fallback';
      fallback.textContent=abbr;
      img.replaceWith(fallback);
    },{once:true});
    holder.replaceChildren(img);
  }

  function repairCardLogos(){
    document.querySelectorAll('.pbe25-card').forEach(card=>{
      const buttons=[...card.querySelectorAll('.pbe25-team-btn')];
      buttons.forEach((btn,index)=>{
        const name=btn.querySelector('.pbe25-team-name')?.textContent?.trim()||btn.dataset.team||'';
        const abbr=resolveAbbr(btn.dataset.team||name);
        if(!abbr)return;
        btn.dataset.team=abbr;
        officialLogo(btn.querySelector('.pbe25-crest'),abbr,name,false);
        if(index===0)card.style.setProperty('--pbe-away-glow',rgba(teamColor(abbr),.16));
        if(index===buttons.length-1)card.style.setProperty('--pbe-home-glow',rgba(teamColor(abbr),.16));
      });
    });

    document.querySelectorAll('.pbe25-feature-team').forEach(team=>{
      const short=team.querySelector('strong')?.textContent?.trim()||'';
      const name=team.querySelector('span')?.textContent?.trim()||short;
      const abbr=resolveAbbr(short)||resolveAbbr(name);
      officialLogo(team.querySelector('.pbe25-feature-crest'),abbr,name,true);
    });
  }

  const TOOLS=[
    ['propboard','Props','Core markets'],
    ['matchups','Matchup','Defense context'],
    ['usage','Usage','Role + volume'],
    ['sgplab','SGP Lab','Correlation'],
    ['marketwatch','Market','Line movement'],
    ['pbecast','Game Center','Live context']
  ];

  function toolGrid(providerId){
    return TOOLS.map(([route,label,note],index)=>`<button type="button" class="pbe25-tool ${index===0?'primary':''} ${route==='pbecast'?'live-tool':''}" data-pbe-game-provider="${esc(providerId)}" data-pbe-game-route="${esc(route)}"><span>${esc(label)}</span><small>${esc(note)}</small></button>`).join('');
  }

  function chooseAndGo(providerId,route){
    if(!providerId||!route)return;
    if(window.PBEEventSelector?.choose)window.PBEEventSelector.choose(providerId);
    else localStorage.setItem('pbe_nfl_event',providerId);
    setTimeout(()=>window.App?.nav?.(route),70);
  }

  function enhanceCardActions(){
    document.querySelectorAll('.pbe25-card .pbe25-actions').forEach(actions=>{
      if(actions.dataset.pbeCommand==='4')return;
      const provider=actions.querySelector('[data-provider]')?.dataset.provider||'';
      if(!provider){
        actions.classList.add('pbe25-actions-no-market');
        const existing=actions.innerHTML;
        actions.innerHTML=`<div class="pbe25-market-wait"><strong>MARKET NOT POSTED</strong><span>Team research stays available until player props are listed.</span></div>${existing}`;
        actions.dataset.pbeCommand='4';
        return;
      }
      actions.classList.add('pbe25-intel-grid');
      actions.innerHTML=toolGrid(provider);
      actions.dataset.pbeCommand='4';
    });

    document.querySelectorAll('.pbe25-feature-actions').forEach(actions=>{
      if(actions.dataset.pbeCommand==='4')return;
      const provider=actions.querySelector('[data-provider]')?.dataset.provider||'';
      if(!provider)return;
      actions.classList.add('pbe25-intel-grid','featured');
      actions.innerHTML=toolGrid(provider);
      actions.dataset.pbeCommand='4';
    });

    document.querySelectorAll('[data-pbe-game-provider][data-pbe-game-route]').forEach(btn=>{
      if(btn.dataset.pbeWired==='1')return;
      btn.dataset.pbeWired='1';
      btn.addEventListener('click',event=>{
        event.preventDefault();event.stopPropagation();
        chooseAndGo(btn.dataset.pbeGameProvider,btn.dataset.pbeGameRoute);
      });
    });
  }

  function wireTeamButtons(){
    document.querySelectorAll('.pbe25-team-btn[data-team]').forEach(btn=>{
      if(btn.dataset.pbeTeamWired==='4')return;
      btn.dataset.pbeTeamWired='4';
      btn.addEventListener('click',event=>{
        event.preventDefault();event.stopPropagation();
        const abbr=btn.dataset.team;
        if(!abbr)return;
        if(window.PBETeamsV2?.openTeam)window.PBETeamsV2.openTeam(abbr);
        else window.App?.nav?.('teams');
      });
    });
  }

  function injectMarketUniverse(){
    const games=document.querySelector('.pbe25-games');
    const summary=games?.querySelector('.pbe25-summary');
    if(!games||!summary||games.querySelector('.pbe25-market-universe'))return;
    const section=document.createElement('section');
    section.className='pbe25-market-universe';
    section.innerHTML=`
      <div class="pbe25-market-universe-copy">
        <span class="pbe25-universe-kicker">NFL PROP COVERAGE</span>
        <strong>The board starts with the markets bettors actually use.</strong>
        <p>Choose a matchup once, then carry the same event through pricing, matchup, usage, SGP, line movement and live-game context.</p>
      </div>
      <div class="pbe25-market-groups">
        <div class="pbe25-market-group live"><span>BOARD REQUESTS</span><b>QB</b><small>Pass yds · completions · attempts · pass TD · INT</small></div>
        <div class="pbe25-market-group live"><span>BOARD REQUESTS</span><b>Receiving</b><small>Rec yds · receptions</small></div>
        <div class="pbe25-market-group live"><span>BOARD REQUESTS</span><b>Rushing</b><small>Rush yds · attempts</small></div>
        <div class="pbe25-market-group live"><span>BOARD REQUESTS</span><b>Touchdown</b><small>Anytime TD</small></div>
        <div class="pbe25-market-group next"><span>PROVIDER-SUPPORTED EXPANSION</span><b>Sharp markets</b><small>Longest completion · first TD · sacks · defensive INT</small></div>
      </div>`;
    summary.insertAdjacentElement('afterend',section);
  }

  function injectCommandLegend(){
    const controls=document.querySelector('.pbe25-games .pbe25-controls');
    if(!controls||document.querySelector('.pbe25-command-legend'))return;
    const legend=document.createElement('div');
    legend.className='pbe25-command-legend';
    legend.innerHTML='<span><i></i> MARKET LINKED = six intelligence workspaces unlock from the matchup card</span><span>Schedule-only games stay research-safe until props are posted.</span>';
    controls.insertAdjacentElement('afterend',legend);
  }

  function enhance(){
    if(!document.querySelector('.pbe25-games'))return;
    repairCardLogos();
    enhanceCardActions();
    wireTeamButtons();
    injectMarketUniverse();
    injectCommandLegend();
  }

  function schedule(){clearTimeout(timer);timer=setTimeout(enhance,30)}
  function burst(){[0,80,220,650,1400].forEach(delay=>setTimeout(enhance,delay))}

  new MutationObserver(schedule).observe(document.getElementById('view-container')||document.documentElement,{childList:true,subtree:true});
  ['pbe:route-changed','pbe:event-changed','pbe:events-loaded','pbe:upgrades-ready'].forEach(name=>window.addEventListener(name,burst));
  document.addEventListener('DOMContentLoaded',burst,{once:true});
  window.PBEGamesCommandV4={enhance,resolveAbbr,logoUrl};
  burst();
})();