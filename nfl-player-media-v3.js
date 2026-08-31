/* PropBetEdge NFL — universal player media v3.2
 * Extends the identity-safe resolver to player-name treatments without observing
 * every DOM mutation. Hydration runs in bounded bursts on route/render events.
 */
(() => {
  'use strict';

  const PBE_MARK='https://propbetedge.ai/logo/pbe-mark-160.png';
  const cache=new Map();
  let timer=null;
  let burstToken=0;

  const TARGETS=[
    '.pbe21-player',
    '.pbe20-player-name',
    '.pbe20-player-tab',
    '.pbe4-model-row .pbe4-player',
    '.pbe23-market-row .pbe23-player',
    '.pbe23-leg .pbe23-leg-player',
    '.pbe4-mobile-card > header > div > span:first-child',
    '.pbe27-tag.player',
    '.pbe13-tag.accent',
    '[data-pbe-player-media="1"]'
  ];

  const normalize=value=>String(value||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();

  function cleanName(el){
    const explicit=el.dataset.player||el.dataset.pbePlayer||el.getAttribute('data-player')||'';
    if(explicit)return String(explicit).trim();
    const clone=el.cloneNode(true);
    clone.querySelectorAll('img,.pbe-player-media,.pbe-player-headshot').forEach(node=>node.remove());
    return String(clone.textContent||'').replace(/\s+/g,' ').trim();
  }

  function isInjuryStoryChip(el){
    return Boolean(el?.matches?.('.pbe13-tag.accent')&&el.closest?.('.pbe13-news')?.querySelector?.('.pbe13-note'));
  }

  async function resolve(name){
    const key=normalize(name);if(!key)return null;if(cache.has(key))return cache.get(key);
    const base=window.PBENFLMediaV2?.resolvePlayerImage;
    const promise=(typeof base==='function'?Promise.resolve(base(name)):fetch(`/api/nfl-media?kind=player&name=${encodeURIComponent(name)}`,{cache:'force-cache'}).then(r=>r.ok?r.json():null).then(data=>data?.image||null).catch(()=>null));
    cache.set(key,promise);return promise;
  }

  function image(name,src){
    const img=document.createElement('img');img.className='pbe-player-headshot pbe-player-headshot-v3';img.alt=src?`${name} headshot`:'PropBetEdge';img.src=src||PBE_MARK;img.loading='lazy';img.decoding='async';if(!src)img.classList.add('is-fallback');
    img.addEventListener('error',()=>{if(img.classList.contains('is-fallback'))return;img.classList.add('is-fallback');img.alt='PropBetEdge';img.src=PBE_MARK},{once:true});return img;
  }

  async function hydrate(el){
    if(!el?.isConnected||isInjuryStoryChip(el)||el.dataset.pbeMediaV3==='loading'||el.dataset.pbeMediaV3==='ready')return;
    if(el.querySelector(':scope > .pbe-player-headshot')){el.dataset.pbeMediaV3='ready';return}
    const name=cleanName(el);if(!name)return;el.dataset.pbeMediaV3='loading';
    const src=await resolve(name);if(!el.isConnected)return;
    el.dataset.pbeMediaV3='ready';el.dataset.pbePlayerName=name;el.classList.add('pbe-player-name-enhanced','pbe-player-name-universal');
    if(!el.querySelector(':scope > .pbe-player-headshot'))el.prepend(image(name,src));
  }

  function markSemanticPlayers(){
    document.querySelectorAll('.pbe15-node').forEach(node=>{const type=node.querySelector('.pbe15-node-value')?.textContent?.trim().toUpperCase();const label=node.querySelector('.pbe15-node-label')?.textContent?.trim().toUpperCase();if(type==='PLAYER'&&label?.includes('AFFECTED ENTITY')){const name=node.querySelector('h3');if(name){name.dataset.pbePlayerMedia='1';name.dataset.player=name.textContent.trim()}}});
    const hero=document.querySelector('.pbe13-title')?.textContent?.toLowerCase()||'';
    if(hero.includes('injury intelligence'))document.querySelectorAll('.pbe13-aff-name').forEach(name=>{name.dataset.pbePlayerMedia='1';name.dataset.player=name.textContent.trim()});
  }

  const observer='IntersectionObserver' in window?new IntersectionObserver(entries=>{for(const entry of entries){if(!entry.isIntersecting)continue;observer.unobserve(entry.target);hydrate(entry.target)}},{rootMargin:'320px 0px'}):null;

  function scan(){
    markSemanticPlayers();
    document.querySelectorAll(TARGETS.join(',')).forEach(el=>{if(isInjuryStoryChip(el))return;if(el.dataset.pbeMediaV3==='ready'||el.dataset.pbeMediaV3==='loading'||el.dataset.pbeMediaV3==='queued')return;if(observer){el.dataset.pbeMediaV3='queued';observer.observe(el)}else hydrate(el)});
  }

  function schedule(){clearTimeout(timer);timer=setTimeout(scan,35)}
  function burst(){const token=++burstToken;[0,100,350,900,1800,3500,6500].forEach(delay=>setTimeout(()=>{if(token===burstToken)scan()},delay))}

  ['pbe:upgrades-ready','pbe:route-changed','pbe:pro-state','pbe:event-changed'].forEach(name=>window.addEventListener(name,burst));
  document.addEventListener('DOMContentLoaded',burst,{once:true});
  if(document.readyState!=='loading')burst();
  window.PBENFLPlayerMediaV3={scan,resolve,targets:[...TARGETS],schedule};
})();
