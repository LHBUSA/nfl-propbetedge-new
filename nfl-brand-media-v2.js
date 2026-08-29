/* PropBetEdge NFL — brand/media/auth integration v2
 * Media hydration is route-safe and rerender-safe. Player headshots are applied to
 * the Prop Board table, signal cards and player detail drawer. Team logos are
 * repaired anywhere a supported NFL abbreviation is visible.
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

  const normalize=value=>String(value||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
  const esc=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  function teamLogo(abbr){
    const clean=String(abbr||'').replace(/[^A-Za-z]/g,'').toLowerCase();
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

  function repairScheduleLogos(){
    document.querySelectorAll('.pbe25-team').forEach(row=>{
      const name=row.querySelector('.pbe25-team-name')?.textContent?.trim()||'';
      const abbr=resolveAbbr(name);
      const crest=row.querySelector('.pbe25-crest');
      if(!crest||!abbr)return;
      const current=crest.querySelector('img');
      if(current?.dataset?.pbeOfficial==='1')return;
      const src=teamLogo(abbr);
      crest.innerHTML=`<img class="pbe-official-team-logo" data-pbe-official="1" src="${src}" alt="${esc(name||abbr)} logo" loading="eager">`;
      crest.querySelector('img')?.addEventListener('error',()=>{crest.innerHTML=`<strong>${esc(abbr)}</strong>`},{once:true});
    });
  }

  function repairGameLogos(){
    document.querySelectorAll('.cast4-team,.home5-team').forEach(team=>{
      const abbr=team.querySelector('.cast4-team-abbr,.home5-abbr')?.textContent?.trim()||'';
      const holder=team.querySelector('.cast4-team-logo,.home5-logo');
      if(!holder||!abbr)return;
      const img=holder.querySelector('img');
      if(img&&img.getAttribute('src'))return;
      const src=teamLogo(resolveAbbr(abbr));
      if(src)holder.innerHTML=`<img src="${src}" alt="${esc(abbr)} logo" loading="eager">`;
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
    img.alt=src?`${name} headshot`:'';
    img.loading='eager';
    if(!src)img.classList.add('is-fallback');
    img.addEventListener('error',()=>{
      if(img.classList.contains('is-fallback'))return;
      img.classList.add('is-fallback');
      img.src=PBE_MARK;
    },{once:true});
    return img;
  }

  function playerTargets(){
    return [...document.querySelectorAll('.pbe3-player-name,.pbe3-signal-player,.pbe3-drawer-title')];
  }
  function enhancePlayerMedia(){
    playerTargets().forEach(async el=>{
      if(el.dataset.pbeMedia==='loading'||el.dataset.pbeMedia==='ready')return;
      const name=cleanPlayerName(el);
      if(!name)return;
      el.dataset.pbeMedia='loading';
      const src=await resolvePlayerImage(name);
      if(!el.isConnected)return;
      el.dataset.pbeMedia='ready';
      el.classList.add('pbe-player-name-enhanced');
      if(!el.querySelector(':scope > .pbe-player-headshot'))el.prepend(mediaImage(name,src));
    });
  }

  function setPaywallMessage(text,type=''){
    const el=document.getElementById('pbe-pro-message');
    if(!el)return;
    el.className=`pbe-pro-message ${type}`.trim();
    el.textContent=text||'';
  }
  async function supabaseFallback(email){
    const client=window.PBEPro?.state?.client;
    if(!client)throw new Error('Account service is unavailable.');
    const {error}=await client.auth.signInWithOtp({email,options:{shouldCreateUser:true,emailRedirectTo:`${location.origin}/?auth=complete`}});
    if(error)throw error;
  }
  async function brandedSignIn(button){
    const input=document.getElementById('pbe-pro-email');
    const email=String(input?.value||'').trim().toLowerCase();
    if(!/^\S+@\S+\.\S+$/.test(email)){setPaywallMessage('Enter a valid email address.','error');return}
    button.disabled=true;
    setPaywallMessage('Sending your secure PropBetEdge sign-in link…');
    try{
      const response=await fetch('/api/auth-email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});
      if(response.ok){setPaywallMessage('Check your inbox. Your PropBetEdge NFL sign-in link is on the way.','success');return}
      await supabaseFallback(email);
      setPaywallMessage('Check your inbox. Your secure NFL sign-in link is on the way.','success');
    }catch(error){
      try{await supabaseFallback(email);setPaywallMessage('Check your inbox. Your secure NFL sign-in link is on the way.','success')}
      catch(fallbackError){setPaywallMessage(fallbackError?.message||error?.message||'Unable to send the sign-in link.','error')}
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

  function scan(){brandPaywall();repairScheduleLogos();repairGameLogos();enhancePlayerMedia()}
  function scheduleScan(){clearTimeout(scanTimer);scanTimer=setTimeout(scan,25)}
  function init(){
    installAuthIntercept();
    scheduleScan();
    new MutationObserver(scheduleScan).observe(document.documentElement,{childList:true,subtree:true});
    window.addEventListener('pbe:upgrades-ready',scheduleScan);
    window.addEventListener('pbe:pro-state',scheduleScan);
  }

  window.PBENFLMediaV2={scan,resolvePlayerImage};
  init();
})();