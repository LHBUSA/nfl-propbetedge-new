/* PropBetEdge NFL — ordered page/product upgrade loader v14 */
(() => {
  'use strict';
  const VERSION='20260829nflfix3';
  const upgrades=[
    {css:'./dashboard-v5.css',js:'./dashboard-v5.js'},
    {css:'./games-v2.css',js:'./games-v2.js'},
    {css:'./team-research-v3.css',js:'./team-research-v3.js'},
    {css:'./stats-v2.css',js:'./stats-v2.js'},
    {css:'./standings-v2.css',js:'./standings-v2.js'},
    {css:'./season-archive-v2.css',js:'./season-archive-v2.js'},
    {css:'./hof-v2.css',js:'./hof-v2.js'},
    {css:'./records-v2.css',js:'./records-v2.js'},
    {css:'./super-bowls-v2.css',js:'./super-bowls-v2.js'},
    {css:'./draft-review-v2.css',js:'./draft-review-v2.js'},
    {css:'./newsroom-v2.css',js:'./newsroom-v2.js'},
    {css:'./news-intelligence-v2.css',js:'./news-intelligence-v2.js'},
    {css:'./pbecast-v4.css',js:'./pbecast-v4.js'},
    {css:'./pbecast-v5.css',js:'./pbecast-v5.js'},
    {js:'./pbecast-v5-renderer.js'},
    {css:'./propchain-v2.css',js:'./propchain-v2.js'},
    {css:'./matchups-v2.css',js:'./matchups-v2.js'},
    {css:'./simulator-v2.css',js:'./simulator-v2.js'},
    {css:'./sgp-lab-v2.css',js:'./sgp-lab-v2.js'},
    {css:'./usage-v2.css',js:'./usage-v2.js'},
    {css:'./market-watch-v2.css',js:'./market-watch-v2.js'},
    {css:'./player-research-v2.css',js:'./player-research-v2.js'},
    {css:'./command-palette-v2.css',js:'./command-palette-v3.js'},
    {css:'./event-selector-v2.css',js:'./event-selector-v2.js'},
    {css:'./global-polish-v2.css',js:'./global-polish-v5.js'},
    {css:'./sports-shell-v1.css',js:'./sports-shell-v2.js'},
    {css:'./sports-shell-v2.css'},
    {css:'./world-class-v1.css'},
    {css:'./readability-v1.css'},
    {css:'./paywall-polish-v1.css',js:'./paywall-polish-v1.js'},
    {css:'./nfl-brand-media-v1.css'},
    {css:'./nfl-player-media-v2.css',js:'./nfl-brand-media-v2.js'}
  ];
  function addCss(href){if(document.querySelector(`link[data-pbe-upgrade="${href}"]`))return;const link=document.createElement('link');link.rel='stylesheet';link.href=`${href}?v=${VERSION}`;link.dataset.pbeUpgrade=href;document.head.appendChild(link)}
  function addScript(src){return new Promise(resolve=>{if(!src)return resolve();if(document.querySelector(`script[data-pbe-upgrade="${src}"]`))return resolve();const script=document.createElement('script');script.src=`${src}?v=${VERSION}`;script.async=false;script.dataset.pbeUpgrade=src;script.onload=resolve;script.onerror=()=>{console.error('PBE product module failed to load',src);resolve()};document.body.appendChild(script)})}
  async function load(){upgrades.forEach(item=>{if(item.css)addCss(item.css)});for(const item of upgrades)await addScript(item.js);window.dispatchEvent(new CustomEvent('pbe:upgrades-ready',{detail:{version:VERSION}}))}
  load();
})();
