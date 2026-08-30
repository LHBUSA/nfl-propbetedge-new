/* PropBetEdge NFL - ordered page/product upgrade loader v41 */
(() => {
  'use strict';
  const VERSION='20260830propfit1';
  const upgrades=[
    /* archive/teams.js is a classic script with lexical const bindings; expose
       the verified directory before newer runtime modules resolve teams. */
    {js:'./team-globals-v1.js'},

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
    {css:'./simulator-v3-enhance.css',js:'./simulator-v3-enhance.js'},
    {css:'./sgp-lab-v2.css',js:'./sgp-lab-v2.js'},
    {css:'./usage-v2.css',js:'./usage-v2.js'},

    /* Market Watch v3 owns runtime behavior, but its terminal stylesheet is an
       override layer on top of the structural v2 stylesheet. Keep v2 CSS only;
       never load the v2 JS authority alongside v3. */
    {css:'./market-watch-v2.css'},
    {css:'./market-watch-v3.css',js:'./market-watch-v3.js'},

    {css:'./player-research-v2.css',js:'./player-research-v2.js'},
    {css:'./model-lab-v2-enhance.css',js:'./model-lab-v2-enhance.js'},
    {css:'./command-palette-v2.css',js:'./command-palette-v3.js'},
    {css:'./event-selector-v2.css',js:'./event-selector-v2.js'},
    {css:'./global-polish-v2.css',js:'./global-polish-v5.js'},
    {css:'./sports-shell-v1.css',js:'./sports-shell-v2.js'},
    {js:'./sports-shell-auth-state.js'},
    {css:'./sports-shell-v2.css'},
    {css:'./world-class-v1.css'},
    {css:'./readability-v1.css'},
    {css:'./paywall-polish-v1.css',js:'./paywall-polish-v1.js'},
    {css:'./nfl-brand-media-v1.css'},
    {css:'./nfl-player-media-v2.css',js:'./nfl-brand-media-v2.js'},
    {css:'./dashboard-v6.css',js:'./dashboard-v6.js'},
    {css:'./dashboard-v7.css',js:'./dashboard-v7.js'},
    {css:'./dashboard-v8-enhance.css',js:'./dashboard-v8-enhance.js'},
    {css:'./sports-shell-v3.css'},
    {css:'./nfl-stadium-bg-v3.css',js:'./dashboard-v7-sanitize.js'},

    /* Global network identity + subscriber controls. */
    {css:'./network-footer-v1.css',js:'./network-footer-v1.js'},

    /* Production authorities. */
    {css:'./paywall-funnel-v2.css',js:'./paywall-funnel-v2.js'},
    {css:'./pbecast-v6.css',js:'./pbecast-v6.js'},
    {css:'./pbecast-v7-enhance.css',js:'./pbecast-v7-enhance.js'},
    {css:'./stadium-selector-v1.css',js:'./stadium-selector-v1.js'},
    {css:'./production-polish-v2.css',js:'./production-polish-v2.js'},

    /* Games is a primary NFL conversion surface. */
    {css:'./games-worldclass-v3.css'},
    {css:'./games-command-v4.css',js:'./games-command-v4.js'},

    /* Prop Board: v3 remains data authority, v4 owns the signal workflow, and
       responsive v5 removes the old 1220px table assumption instead of hiding overflow. */
    {css:'./prop-board-v4.css',js:'./prop-board-v4.js'},
    {css:'./prop-board-responsive-v5.css'},

    /* PBE Picks + Verified Track Record v2 is the sole UI authority. The old
       v1 file remains historical source only and is intentionally not loaded. */
    {css:'./pbe-picks-v2.css',js:'./pbe-picks-v2.js'},

    /* Gated validation telemetry is aggregate/public-safe. */
    {css:'./pbe-validation-v1.css',js:'./pbe-validation-v1.js'},

    /* Last by design: scrollbar policy may style true scrollers, but it must
       never conceal overflow or substitute for responsive component layout. */
    {css:'./scrollbar-clean-v1.css'}
  ];

  const PRO_MODULES=[
    {selector:'.pbe22-watch',global:'PBEMarketWatch'},
    {selector:'.pbe20-sim',global:'PBELineSimulator'},
    {selector:'.pbe23-sgp',global:'PBESGPLab'},
    {selector:'.pbe4-model-lab',global:'PBEModelLab'}
  ];

  let proSyncRun=0;

  function addCss(href){
    if(document.querySelector(`link[data-pbe-upgrade="${href}"]`))return;
    const link=document.createElement('link');
    link.rel='stylesheet';
    link.href=`${href}?v=${VERSION}`;
    link.dataset.pbeUpgrade=href;
    document.head.appendChild(link);
  }

  function addScript(src){
    return new Promise(resolve=>{
      if(!src)return resolve();
      if(document.querySelector(`script[data-pbe-upgrade="${src}"]`))return resolve();
      const script=document.createElement('script');
      script.src=`${src}?v=${VERSION}`;
      script.async=false;
      script.dataset.pbeUpgrade=src;
      script.onload=resolve;
      script.onerror=()=>{console.error('PBE product module failed to load',src);resolve()};
      document.body.appendChild(script);
    });
  }

  function forceVisibleProRender(){
    const runId=++proSyncRun;let attempt=0;
    const run=()=>{
      if(runId!==proSyncRun)return;attempt+=1;let waiting=false;
      document.documentElement.dataset.pbePro=window.PBEPro?.state?.pro===true?'1':'0';
      for(const spec of PRO_MODULES){
        if(!document.querySelector(spec.selector))continue;
        const module=window[spec.global];if(!module||typeof module.render!=='function')continue;
        if(module.state?.loading){waiting=true;continue}
        try{module.render()}catch(error){console.error('[pbe-loader-pro-sync]',spec.global,error?.message||error)}
      }
      if(waiting&&attempt<60)setTimeout(run,100);
    };
    queueMicrotask(run);
  }

  function installProSync(){
    window.addEventListener('pbe:pro-state',forceVisibleProRender);
    window.addEventListener('pbe:route-changed',forceVisibleProRender);
    setTimeout(forceVisibleProRender,0);setTimeout(forceVisibleProRender,250);setTimeout(forceVisibleProRender,1000);
  }

  async function load(){
    upgrades.forEach(item=>{if(item.css)addCss(item.css)});
    for(const item of upgrades)await addScript(item.js);
    installProSync();
    window.dispatchEvent(new CustomEvent('pbe:upgrades-ready',{detail:{version:VERSION}}));
    forceVisibleProRender();
  }

  load();
})();
