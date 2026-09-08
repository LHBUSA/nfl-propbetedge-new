/* PropBetEdge NFL — brand/media/auth integration v2.2
 * Global real-logo authority for active NFL surfaces.
 * Real NFL/team/book/PropBetEdge marks only: no synthetic shield, initials,
 * letter-badge, or hand-drawn logo fallbacks. No page-wide MutationObserver.
 */
(() => {
  'use strict';

  const PBE_MARK='https://propbetedge.ai/logo/pbe-mark-160.png';
  const PBE_FULL='https://propbetedge.ai/logo/pbe-full-400.png';
  const playerCache=new Map();
  let scanTimer=null;
  let burstToken=0;

  const TEAM_ABBR=new Map(Object.entries({
    'arizona cardinals':'ARI','atlanta falcons':'ATL','baltimore ravens':'BAL','buffalo bills':'BUF',
    'carolina panthers':'CAR','chicago bears':'CHI','cincinnati bengals':'CIN','cleveland browns':'CLE',
    'dallas cowboys':'DAL','denver broncos':'DEN','detroit lions':'DET','green bay packers':'GB',
    'houston texans':'HOU','indianapolis colts':'IND','jacksonville jaguars':'JAX','kansas city chiefs':'KC',
    'las vegas raiders':'LV','los angeles chargers':'LAC','los angeles rams':'LAR','miami dolphins':'MIA',
    'minnesota vikings':'MIN','new england patriots':'NE','new orleans saints':'NO','new york giants':'NYG',
    'new york jets':'NYJ','philadelphia eagles':'PHI','pittsburgh steelers':'PIT','san francisco 49ers':'SF',
    'seattle seahawks':'SEA','tampa bay buccaneers':'TB','tennessee titans':'TEN','washington commanders':'WSH',
    'washington football team':'WSH','oakland raiders':'OAK','st louis rams':'STL','san diego chargers':'SD'
  }));
  const TEAM_PATH_ALIAS={WAS:'wsh',WSH:'wsh'};

  const BOOK_BRANDS=[
    [/draftkings/i,'draftkings.com'],[/fanduel/i,'fanduel.com'],[/betmgm|mgm/i,'betmgm.com'],
    [/caesars/i,'caesars.com'],[/betrivers/i,'betrivers.com'],[/bet365/i,'bet365.com'],
    [/fanatics/i,'fanatics.com'],[/espn\s*bet/i,'espnbet.com'],[/hard\s*rock/i,'hardrock.bet'],
    [/bally/i,'ballybet.com'],[/bovada/i,'bovada.lv'],[/betonline/i,'betonline.ag'],
    [/betus/i,'betus.com.pa'],[/mybookie/i,'mybookie.ag'],[/fliff/i,'getfliff.com'],
    [/lowvig/i,'lowvig.ag'],[/betanysports/i,'betanysports.eu']
  ];

  const normalize=value=>String(value||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
  const teamSlug=abbr=>{
    const raw=String(abbr||'').replace(/[^A-Za-z]/g,'').toUpperCase();
    return String(TEAM_PATH_ALIAS[raw]||raw).toLowerCase();
  };
  function teamLogo(abbr){const key=teamSlug(abbr);return key?`https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${key}.png`:''}
  function alternateTeamLogo(abbr){const key=teamSlug(abbr);return key?`https://a.espncdn.com/i/teamlogos/nfl/500/${key}.png`:''}
  function resolveAbbr(nameOrAbbr){
    const raw=String(nameOrAbbr||'').trim();
    if(/^[A-Za-z]{2,4}$/.test(raw))return raw.toUpperCase();
    const key=normalize(raw);
    if(TEAM_ABBR.has(key))return TEAM_ABBR.get(key);
    for(const [name,abbr] of TEAM_ABBR.entries())if(key&&(name.includes(key)||key.includes(name)))return abbr;
    return'';
  }
  function bookDomain(name){const raw=String(name||'');return BOOK_BRANDS.find(([re])=>re.test(raw))?.[1]||''}

  function ensureLogoGuardStyles(){
    if(document.getElementById('pbe-real-logo-guard-v1'))return;
    const style=document.createElement('style');
    style.id='pbe-real-logo-guard-v1';
    style.textContent=`
      .pbes-score-logo-fallback,.pbe25-logo-fallback,.pbe-team-logo-fallback,.pbe2-team-fallback{visibility:hidden!important}
      .sidebar-logo>svg,.pbe-v2-brand>svg{visibility:hidden!important}
      .pbe22-bookmark>span{display:none!important}
      i.pbe5-mark{visibility:hidden!important}
      img.pbe-official-book-logo{display:inline-block;object-fit:contain;vertical-align:middle;border:0;background:transparent}
      img.pbe-official-brand-logo{display:block;object-fit:contain;border:0;background:transparent}
    `;
    document.head.appendChild(style);
  }

  function bindRealTeamFallback(img,abbr,{removeOnFinal=true}={}){
    if(!img||img.dataset.pbeRealTeamBound==='1')return img;
    img.dataset.pbeRealTeamBound='1';
    const alternate=alternateTeamLogo(abbr);
    img.addEventListener('error',()=>{
      if(img.dataset.pbeRealTeamRetry!=='1'&&alternate&&img.src!==alternate){
        img.dataset.pbeRealTeamRetry='1';
        img.src=alternate;
        return;
      }
      if(removeOnFinal&&img.isConnected)img.remove();
    });
    if(img.complete&&!img.naturalWidth){
      if(alternate&&img.src!==alternate){img.dataset.pbeRealTeamRetry='1';img.src=alternate}
      else if(removeOnFinal&&img.isConnected)img.remove();
    }
    return img;
  }

  function logoImg(abbr,label,eager=false){
    const resolved=resolveAbbr(abbr)||String(abbr||'').toUpperCase();
    const src=teamLogo(resolved);
    if(!src)return null;
    const img=document.createElement('img');
    img.className='pbe-official-team-logo';
    img.dataset.pbeOfficial='1';
    img.dataset.teamAbbr=resolved;
    img.src=src;
    img.alt=`${label||resolved} logo`;
    img.loading=eager?'eager':'lazy';
    img.decoding='async';
    return bindRealTeamFallback(img,resolved);
  }

  function replaceWithRealTeamLogo(node,nameOrAbbr,eager=false,extraClass=''){
    if(!node||!node.isConnected)return;
    const abbr=resolveAbbr(nameOrAbbr)||String(nameOrAbbr||'').trim().toUpperCase();
    if(!/^[A-Z]{2,4}$/.test(abbr))return;
    const img=logoImg(abbr,nameOrAbbr,eager);
    if(!img)return;
    if(extraClass)img.classList.add(extraClass);
    node.replaceWith(img);
  }

  function fillLogo(holder,nameOrAbbr,eager=false){
    if(!holder)return;
    const abbr=resolveAbbr(nameOrAbbr);
    if(!abbr)return;
    const existing=holder.querySelector('img');
    if(existing){
      existing.loading=eager?'eager':'lazy';
      existing.decoding='async';
      existing.dataset.teamAbbr=existing.dataset.teamAbbr||abbr;
      bindRealTeamFallback(existing,abbr);
      return;
    }
    const img=logoImg(abbr,nameOrAbbr,eager);
    if(img)holder.replaceChildren(img);
  }

  function officialBrandLogo(size=24){
    const img=document.createElement('img');
    img.className='pbe-official-brand-logo';
    img.src=PBE_MARK;
    img.alt='PropBetEdge';
    img.width=size;img.height=size;
    img.loading='eager';img.decoding='async';
    img.addEventListener('error',()=>{if(img.isConnected)img.remove()},{once:true});
    return img;
  }

  function officialBookLogo(name,size=18){
    const domain=bookDomain(name);
    if(!domain)return null;
    const img=document.createElement('img');
    img.className='pbe-official-book-logo';
    img.dataset.bookDomain=domain;
    img.alt=`${String(name||'Sportsbook').trim()} logo`;
    img.width=size;img.height=size;
    img.loading='lazy';img.decoding='async';
    img.src=`https://${domain}/favicon.ico`;
    img.addEventListener('error',()=>{
      if(img.dataset.pbeBookRetry!=='1'){
        img.dataset.pbeBookRetry='1';
        img.src=`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
        return;
      }
      if(img.isConnected)img.remove();
    });
    return img;
  }

  function brandPaywall(){
    const modal=document.querySelector('.pbe-pro-modal');
    if(!modal||modal.dataset.pbeBranded==='2')return;
    modal.dataset.pbeBranded='2';
    const kicker=modal.querySelector('.pbe-pro-kicker');
    if(kicker)kicker.innerHTML=`<img class="pbe-paywall-logo" src="${PBE_FULL}" alt="PropBetEdge"><span class="pbe-paywall-label">NFL Pro</span>`;
  }

  function repairStaticBrandMarks(){
    document.querySelectorAll('.sidebar-logo,.pbe-v2-brand').forEach(holder=>{
      const fake=holder.querySelector(':scope > svg');
      if(!fake)return;
      const size=Math.max(22,Math.min(32,Math.round(fake.getBoundingClientRect().width)||24));
      fake.replaceWith(officialBrandLogo(size));
    });
  }

  function repairScheduleLogos(){document.querySelectorAll('.pbe25-team').forEach(row=>{const name=row.querySelector('.pbe25-team-name')?.textContent?.trim()||'';fillLogo(row.querySelector('.pbe25-crest'),name,false)})}
  function repairPrimaryGameLogos(){document.querySelectorAll('.cast4-team,.home5-team').forEach(team=>{const abbr=team.querySelector('.cast4-team-abbr,.home5-abbr')?.textContent?.trim()||'';fillLogo(team.querySelector('.cast4-team-logo,.home5-logo'),abbr,true)})}
  function repairDashboardSlate(){
    document.querySelectorAll('.home5-card-row').forEach(row=>{
      const abbr=row.querySelector('b')?.textContent?.trim()||'';
      const resolved=resolveAbbr(abbr);if(!resolved)return;
      const existing=row.querySelector('img');
      if(existing){existing.dataset.teamAbbr=existing.dataset.teamAbbr||resolved;bindRealTeamFallback(existing,resolved);return}
      const img=logoImg(resolved,abbr,false);if(!img)return;
      const placeholder=row.querySelector(':scope > span');if(placeholder)placeholder.replaceWith(img);else row.prepend(img);
    });
  }
  function repairNamedTeamLogos(){[['.pbe16-team','.pbe16-team-name','.pbe16-crest',true],['.pbe26-card','.pbe26-card-name','.pbe26-crest',false],['.pbe26-brandline','.pbe26-drawer-name','.pbe26-drawer-crest',true],['.pbe7-team','.pbe7-team-copy strong','.pbe7-team-logo',true]].forEach(([rootSel,nameSel,holderSel,eager])=>{document.querySelectorAll(rootSel).forEach(root=>{const name=root.querySelector(nameSel)?.textContent?.trim()||'';fillLogo(root.querySelector(holderSel),name,eager)})})}

  function repairSyntheticTeamMarks(){
    document.querySelectorAll('.pbes-score-logo-fallback,.pbe25-logo-fallback,.pbe-team-logo-fallback,.pbe2-team-fallback').forEach(node=>replaceWithRealTeamLogo(node,node.textContent?.trim()||'',false));
    document.querySelectorAll('.pbe-team-img').forEach(node=>{
      if(node.tagName==='IMG'){
        const abbr=node.dataset.teamAbbr||node.alt?.replace(/\s+logo$/i,'')||'';
        const resolved=resolveAbbr(abbr);if(resolved)bindRealTeamFallback(node,resolved);
        return;
      }
      const abbr=node.querySelector('b')?.textContent?.trim()||node.textContent?.trim()||'';
      replaceWithRealTeamLogo(node,abbr,false,'pbe-team-img');
    });
    document.querySelectorAll('svg.team-crest,.pbe6-podium svg,.pbe6-table svg,.pbe7-standings svg,.pbe11-sb svg').forEach(svg=>{
      const abbr=String(svg.querySelector('text')?.textContent||'').trim().toUpperCase();
      if(/^[A-Z]{2,4}$/.test(abbr))replaceWithRealTeamLogo(svg,abbr,false,'team-crest');
    });
  }

  function repairExistingTeamImages(){
    document.querySelectorAll('img.pbe-official-team-logo,img.team-crest,img.pbes-team-logo').forEach(img=>{
      const abbr=img.dataset.teamAbbr||img.getAttribute('data-team-abbr')||img.alt?.replace(/\s+logo$/i,'')||'';
      const resolved=resolveAbbr(abbr);
      if(resolved)bindRealTeamFallback(img,resolved);
    });
  }

  function repairSportsbookMarks(){
    document.querySelectorAll('.pbe22-bookmark').forEach(mark=>{
      const name=mark.getAttribute('title')||mark.parentElement?.textContent||'';
      const logo=officialBookLogo(name,18);if(!logo)return;
      mark.replaceChildren(logo);
      mark.setAttribute('aria-label',`${String(name).trim()} logo`);
    });
    document.querySelectorAll('i.pbe5-mark').forEach(mark=>{
      const code=String(mark.textContent||'').trim();
      const parent=mark.parentElement;
      let name=String(parent?.textContent||'').trim();
      if(code&&name.startsWith(code))name=name.slice(code.length).trim();
      const logo=officialBookLogo(name,16);if(!logo)return;
      logo.classList.add('pbe5-mark');
      logo.style.padding='2px';
      mark.replaceWith(logo);
    });
  }

  function repairDirectPlayerImages(){document.querySelectorAll('.home5-player > img').forEach(img=>{if(img.dataset.pbeFallbackBound==='1')return;img.dataset.pbeFallbackBound='1';img.loading='lazy';img.decoding='async';img.addEventListener('error',()=>{if(img.isConnected){img.classList.add('is-fallback');img.src=PBE_MARK}},{once:true})})}

  async function resolvePlayerImage(name){const key=normalize(name);if(!key)return null;if(playerCache.has(key))return playerCache.get(key);const promise=fetch(`/api/nfl-media?kind=player&name=${encodeURIComponent(name)}`,{cache:'force-cache'}).then(r=>r.ok?r.json():null).then(data=>data?.image||null).catch(()=>null);playerCache.set(key,promise);return promise}
  function cleanPlayerName(el){if(el.dataset.pbePlayerName)return el.dataset.pbePlayerName;const explicit=el.dataset.player||el.closest?.('[data-player]')?.dataset?.player||'';if(explicit){el.dataset.pbePlayerName=explicit;return explicit}const clone=el.cloneNode(true);clone.querySelectorAll('img,.pbe-player-media').forEach(node=>node.remove());const name=clone.textContent?.replace(/\s+/g,' ').trim()||'';if(name)el.dataset.pbePlayerName=name;return name}
  function mediaImage(name,src){const img=document.createElement('img');img.className='pbe-player-headshot';img.src=src||PBE_MARK;img.alt=src?`${name} headshot`:'PropBetEdge';img.loading='lazy';img.decoding='async';if(!src)img.classList.add('is-fallback');img.addEventListener('error',()=>{if(img.classList.contains('is-fallback'))return;img.classList.add('is-fallback');img.alt='PropBetEdge';img.src=PBE_MARK},{once:true});return img}
  function playerTargets(){return[...document.querySelectorAll(['.pbe3-player-name','.pbe3-signal-player','.pbe3-drawer-title','.pbe22-player','.pbe16-model-player','.pbe17-name','.pbe26-leader-name','.pbe6-name','.pbe6-table td.player','.pbe9-member-name','.pbe10-feature-holder','.pbe10-card-holder','.pbe11-mvp [data-player]'].join(','))]}
  async function hydratePlayer(el){if(!el||!el.isConnected||el.dataset.pbeMedia==='loading'||el.dataset.pbeMedia==='ready')return;const name=cleanPlayerName(el);if(!name)return;el.dataset.pbeMedia='loading';const src=await resolvePlayerImage(name);if(!el.isConnected)return;el.dataset.pbeMedia='ready';el.classList.add('pbe-player-name-enhanced');if(!el.querySelector(':scope > .pbe-player-headshot'))el.prepend(mediaImage(name,src))}

  const playerObserver='IntersectionObserver' in window?new IntersectionObserver(entries=>{entries.forEach(entry=>{if(!entry.isIntersecting)return;playerObserver.unobserve(entry.target);hydratePlayer(entry.target)})},{rootMargin:'220px 0px'}):null;
  function enhancePlayerMedia(){playerTargets().forEach(el=>{if(el.dataset.pbeMedia==='loading'||el.dataset.pbeMedia==='ready'||el.dataset.pbeMedia==='queued')return;if(playerObserver){el.dataset.pbeMedia='queued';playerObserver.observe(el)}else hydratePlayer(el)})}

  function scan(){
    ensureLogoGuardStyles();
    brandPaywall();
    repairStaticBrandMarks();
    repairScheduleLogos();
    repairPrimaryGameLogos();
    repairDashboardSlate();
    repairNamedTeamLogos();
    repairSyntheticTeamMarks();
    repairExistingTeamImages();
    repairSportsbookMarks();
    repairDirectPlayerImages();
    enhancePlayerMedia();
  }
  function scheduleScan(){clearTimeout(scanTimer);scanTimer=setTimeout(scan,35)}
  function burstScan(){const token=++burstToken;[0,75,200,500,1000,1800,3500,6500].forEach(delay=>setTimeout(()=>{if(token===burstToken)scan()},delay))}
  function init(){
    ensureLogoGuardStyles();
    burstScan();
    ['pbe:upgrades-ready','pbe:route-changed','pbe:pro-state','pbe:event-changed'].forEach(name=>window.addEventListener(name,burstScan));
    document.addEventListener('DOMContentLoaded',burstScan,{once:true});
    window.addEventListener('load',burstScan,{once:true});
    setInterval(scan,15000);
  }

  window.PBENFLMediaV2={scan,scheduleScan,resolvePlayerImage,teamLogo,alternateTeamLogo,resolveAbbr,bookDomain};
  init();
})();
