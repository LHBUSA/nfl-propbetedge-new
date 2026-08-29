/* PropBetEdge NFL — brand/media/auth integration v2
 * Route-safe media hydration for real NFL team logos and player headshots.
 * All fallbacks are deterministic: official ESPN team marks, PBE mark for unresolved players.
 */
(() => {
  'use strict';

  const PBE_MARK='https://propbetedge.ai/logo/pbe-mark-160.png';
  const PBE_FULL='https://propbetedge.ai/logo/pbe-full-400.png';
  const playerCache=new Map();
  let scanTimer=null;

  const TEAM_ABBR=new Map(Object.entries({
    'arizona cardinals':'ARI','atlanta falcons':'ATL','baltimore ravens':'BAL','buffalo bills':'BUF',
    'carolina panthers':'CAR','chicago bears':'CHI','cincinnati bengals':'CIN','cleveland browns':'CLE',
    'dallas cowboys':'DAL','denver broncos':'DEN','detroit lions':'DET','green bay packers':'GB',
    'houston texans':'HOU','indianapolis colts':'IND','jacksonville jaguars':'JAX','kansas city chiefs':'KC',
    'las vegas raiders':'LV','los angeles chargers':'LAC','los angeles rams':'LAR','miami dolphins':'MIA',
    'minnesota vikings':'MIN','new england patriots':'NE','new orleans saints':'NO','new york giants':'NYG',
    'new york jets':'NYJ','philadelphia eagles':'PHI','pittsburgh steelers':'PIT','san francisco 49ers':'SF',
    'seattle seahawks':'SEA','tampa bay buccaneers':'TB','tennessee titans':'TEN','washington commanders':'WSH'
  }));
  const TEAM_PATH_ALIAS={WAS:'wsh'};

  const normalize=value=>String(value||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();

  function teamLogo(abbr){
    const raw=String(abbr||'').replace(/[^A-Za-z]/g,'').toUpperCase();
    const clean=(TEAM_PATH_ALIAS[raw]||raw).toLowerCase();
    return clean?`https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${clean}.png`:'';
  }
  function resolveAbbr(nameOrAbbr){
    const raw=String(nameOrAbbr||'').trim();
    if(/^[A-Za-z]{2,4}$/.test(raw))return raw.toUpperCase();
    const key=normalize(raw);
    if(TEAM_ABBR.has(key))return TEAM_ABBR.get(key);
    for(const [name,abbr] of TEAM_ABBR.entries())if(key&&(name.includes(key)||key.includes(name)))return abbr;
    return'';
  }

  function brandPaywall(){
    const modal=document.querySelector('.pbe-pro-modal');
    if(!modal||modal.dataset.pbeBranded==='2')return;
    modal.dataset.pbeBranded='2';
    const kicker=modal.querySelector('.pbe-pro-kicker');
    if(kicker)kicker.innerHTML=`<img class="pbe-paywall-logo" src="${PBE_FULL}" alt="PropBetEdge"><span class="pbe-paywall-label">NFL Pro</span>`;
  }

  function logoImg(abbr,label,eager=false){
    const img=document.createElement('img');
    img.className='pbe-official-team-logo';
    img.dataset.pbeOfficial='1';
    img.dataset.teamAbbr=abbr;
    img.src=teamLogo(abbr);
    img.alt=`${label||abbr} logo`;
    img.loading=eager?'eager':'lazy';
    img.decoding='async';
    img.addEventListener('error',()=>{
      const fallback=document.createElement('strong');
      fallback.className='pbe-team-logo-fallback';
      fallback.textContent=abbr;
      img.replaceWith(fallback);
    },{once:true});
    return img;
  }

  function fillLogo(holder,nameOrAbbr,eager=false){
    if(!holder)return;
    const abbr=resolveAbbr(nameOrAbbr);
    if(!abbr)return;
    const existing=holder.querySelector('img');
    if(existing){
      if(existing.dataset.pbeFallbackBound!=='1'){
        existing.dataset.pbeFallbackBound='1';
        existing.loading=eager?'eager':'lazy';
        existing.decoding='async';
        existing.addEventListener('error',()=>{
          if(!existing.isConnected)return;
          const fallback=logoImg(abbr,nameOrAbbr,eager);
          if(fallback.src===existing.src){
            const text=document.createElement('strong');text.className='pbe-team-logo-fallback';text.textContent=abbr;existing.replaceWith(text);
          }else existing.replaceWith(fallback);
        },{once:true});
      }
      return;
    }
    holder.replaceChildren(logoImg(abbr,nameOrAbbr,eager));
  }

  function repairScheduleLogos(){
    document.querySelectorAll('.pbe25-team').forEach(row=>{
      const name=row.querySelector('.pbe25-team-name')?.textContent?.trim()||'';
      fillLogo(row.querySelector('.pbe25-crest'),name,false);
    });
  }

  function repairPrimaryGameLogos(){
    document.querySelectorAll('.cast4-team,.home5-team').forEach(team=>{
      const abbr=team.querySelector('.cast4-team-abbr,.home5-abbr')?.textContent?.trim()||'';
      fillLogo(team.querySelector('.cast4-team-logo,.home5-logo'),abbr,true);
    });
  }

  function repairDashboardSlate(){
    document.querySelectorAll('.home5-card-row').forEach(row=>{
      const abbr=row.querySelector('b')?.textContent?.trim()||'';
      const resolved=resolveAbbr(abbr);
      if(!resolved)return;
      const existing=row.querySelector('img');
      if(existing){
        if(existing.dataset.pbeFallbackBound==='1')return;
        existing.dataset.pbeFallbackBound='1';existing.loading='lazy';existing.decoding='async';
        existing.addEventListener('error',()=>{if(existing.isConnected)existing.replaceWith(logoImg(resolved,abbr,false))},{once:true});
        return;
      }
      const placeholder=row.querySelector(':scope > span');
      if(placeholder)placeholder.replaceWith(logoImg(resolved,abbr,false));
      else row.prepend(logoImg(resolved,abbr,false));
    });
  }

  function repairNamedTeamLogos(){
    const configs=[
      ['.pbe16-team','.pbe16-team-name','.pbe16-crest',true],
      ['.pbe26-card','.pbe26-card-name','.pbe26-crest',false],
      ['.pbe26-brandline','.pbe26-drawer-name','.pbe26-drawer-crest',true]
    ];
    configs.forEach(([rootSel,nameSel,holderSel,eager])=>{
      document.querySelectorAll(rootSel).forEach(root=>{
        const name=root.querySelector(nameSel)?.textContent?.trim()||'';
        fillLogo(root.querySelector(holderSel),name,eager);
      });
    });
  }

  function repairArchiveCrests(){
    document.querySelectorAll('.pbe6-podium svg,.pbe6-table svg,.pbe7-standings svg,.pbe11-sb svg').forEach(svg=>{
      if(svg.dataset.pbeArchiveLogo==='1')return;
      const abbr=String(svg.querySelector('text')?.textContent||'').trim().toUpperCase();
      if(!/^[A-Z]{2,4}$/.test(abbr))return;
      if(['OAK','STL','SD'].includes(abbr))return;
      svg.dataset.pbeArchiveLogo='1';
      svg.replaceWith(logoImg(abbr,abbr,false));
    });
  }

  function repairDirectPlayerImages(){
    document.querySelectorAll('.home5-player > img').forEach(img=>{
      if(img.dataset.pbeFallbackBound==='1')return;
      img.dataset.pbeFallbackBound='1';img.loading='lazy';img.decoding='async';
      img.addEventListener('error',()=>{if(img.isConnected){img.classList.add('is-fallback');img.src=PBE_MARK}}, {once:true});
    });
  }

  async function resolvePlayerImage(name){
    const key=normalize(name);
    if(!key)return null;
    if(playerCache.has(key))return playerCache.get(key);
    const promise=fetch(`/api/nfl-media?kind=player&name=${encodeURIComponent(name)}`,{cache:'force-cache'})
      .then(r=>r.ok?r.json():null)
      .then(data=>data?.image||null)
      .catch(()=>null);
    playerCache.set(key,promise);
    return promise;
  }

  function cleanPlayerName(el){
    if(el.dataset.pbePlayerName)return el.dataset.pbePlayerName;
    const explicit=el.dataset.player||el.closest?.('[data-player]')?.dataset?.player||'';
    if(explicit){el.dataset.pbePlayerName=explicit;return explicit}
    const clone=el.cloneNode(true);
    clone.querySelectorAll('img,.pbe-player-media').forEach(node=>node.remove());
    const name=clone.textContent?.replace(/\s+/g,' ').trim()||'';
    if(name)el.dataset.pbePlayerName=name;
    return name;
  }

  function mediaImage(name,src){
    const img=document.createElement('img');
    img.className='pbe-player-headshot';
    img.src=src||PBE_MARK;
    img.alt=src?`${name} headshot`:'PropBetEdge';
    img.loading='lazy';
    img.decoding='async';
    if(!src)img.classList.add('is-fallback');
    img.addEventListener('error',()=>{
      if(img.classList.contains('is-fallback'))return;
      img.classList.add('is-fallback');
      img.alt='PropBetEdge';
      img.src=PBE_MARK;
    },{once:true});
    return img;
  }

  function playerTargets(){
    return [...document.querySelectorAll([
      '.pbe3-player-name',
      '.pbe3-signal-player',
      '.pbe3-drawer-title',
      '.pbe16-model-player',
      '.pbe17-name',
      '.pbe26-leader-name',
      '.pbe6-name',
      '.pbe6-table td.player',
      '.pbe9-member-name',
      '.pbe10-feature-holder',
      '.pbe10-card-holder',
      '.pbe11-mvp [data-player]'
    ].join(','))];
  }

  async function hydratePlayer(el){
    if(!el||!el.isConnected||el.dataset.pbeMedia==='loading'||el.dataset.pbeMedia==='ready')return;
    const name=cleanPlayerName(el);
    if(!name)return;
    el.dataset.pbeMedia='loading';
    const src=await resolvePlayerImage(name);
    if(!el.isConnected)return;
    el.dataset.pbeMedia='ready';
    el.classList.add('pbe-player-name-enhanced');
    if(!el.querySelector(':scope > .pbe-player-headshot'))el.prepend(mediaImage(name,src));
  }

  const playerObserver='IntersectionObserver' in window?new IntersectionObserver(entries=>{
    entries.forEach(entry=>{
      if(!entry.isIntersecting)return;
      playerObserver.unobserve(entry.target);
      hydratePlayer(entry.target);
    });
  },{rootMargin:'220px 0px'}):null;

  function enhancePlayerMedia(){
    playerTargets().forEach(el=>{
      if(el.dataset.pbeMedia==='loading'||el.dataset.pbeMedia==='ready'||el.dataset.pbeMedia==='queued')return;
      if(playerObserver){el.dataset.pbeMedia='queued';playerObserver.observe(el)}
      else hydratePlayer(el);
    });
  }

  function setPaywallMessage(text,type=''){
    const el=document.getElementById('pbe-pro-message');
    if(!el)return;
    const cls=`pbe-pro-message ${type}`.trim();
    if(el.className!==cls)el.className=cls;
    if(el.textContent!==text)el.textContent=text||'';
  }
  async function brandedSignIn(button){
    const input=document.getElementById('pbe-pro-email');
    const email=String(input?.value||'').trim().toLowerCase();
    if(!/^\S+@\S+\.\S+$/.test(email)){setPaywallMessage('Enter a valid email address.','error');return}
    button.disabled=true;
    setPaywallMessage('Sending your secure PropBetEdge sign-in link with Resend…');
    try{
      const response=await fetch('/api/auth-email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(payload?.error||'Resend email delivery is unavailable.');
      if(payload?.provider!=='resend')throw new Error('Resend email transport is not active.');
      setPaywallMessage('Check your inbox. Your PropBetEdge NFL sign-in link was sent with Resend.','success');
    }catch(error){
      setPaywallMessage(error?.message||'Unable to send the Resend sign-in email.','error');
    }finally{button.disabled=false}
  }
  function installAuthIntercept(){
    if(document.documentElement.dataset.pbeAuthInterceptV2==='1')return;
    document.documentElement.dataset.pbeAuthInterceptV2='1';
    document.addEventListener('click',event=>{
      const button=event.target?.closest?.('#pbe-pro-signin');
      if(!button)return;
      event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();brandedSignIn(button);
    },true);
  }

  function scan(){
    brandPaywall();
    repairScheduleLogos();
    repairPrimaryGameLogos();
    repairDashboardSlate();
    repairNamedTeamLogos();
    repairArchiveCrests();
    repairDirectPlayerImages();
    enhancePlayerMedia();
  }
  function scheduleScan(){clearTimeout(scanTimer);scanTimer=setTimeout(scan,35)}
  function burstScan(){[0,120,420,1100,2400].forEach(delay=>setTimeout(scan,delay))}
  function init(){
    installAuthIntercept();
    burstScan();
    new MutationObserver(scheduleScan).observe(document.getElementById('view-container')||document.documentElement,{childList:true,subtree:true});
    window.addEventListener('pbe:upgrades-ready',burstScan);
    window.addEventListener('pbe:route-changed',burstScan);
    window.addEventListener('pbe:pro-state',scheduleScan);
  }

  window.PBENFLMediaV2={scan,resolvePlayerImage,teamLogo,resolveAbbr};
  init();
})();