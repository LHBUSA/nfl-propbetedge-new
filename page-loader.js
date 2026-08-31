/* PropBetEdge NFL - route-on-demand production loader v49 */
(() => {
  'use strict';
  const VERSION='20260830routeload1';

  /* Styles are cheap and parallel. JavaScript is intentionally NOT all executed
   * at startup anymore. Each workspace initializes only when the user opens it. */
  const CSS=[
    './dashboard-v5.css','./games-v2.css','./team-research-v3.css','./stats-v2.css','./standings-v2.css',
    './season-archive-v2.css','./hof-v2.css','./records-v2.css','./super-bowls-v2.css','./draft-review-v2.css',
    './newsroom-v2.css','./news-intelligence-v2.css','./propchain-v2.css','./matchups-v2.css','./simulator-v2.css',
    './simulator-v3-enhance.css','./sgp-lab-v2.css','./usage-v2.css','./market-watch-v2.css','./market-watch-v3.css',
    './player-research-v2.css','./model-lab-v2-enhance.css','./command-palette-v2.css','./event-selector-v2.css',
    './global-polish-v2.css','./sports-shell-v1.css','./sports-shell-v2.css','./world-class-v1.css','./readability-v1.css',
    './paywall-polish-v1.css','./nfl-brand-media-v1.css','./nfl-player-media-v2.css','./dashboard-v6.css','./dashboard-v7.css',
    './dashboard-v8-enhance.css','./sports-shell-v3.css','./nfl-stadium-bg-v3.css','./network-footer-v1.css',
    './paywall-funnel-v2.css','./pbecast-v6.css','./pbecast-v7-enhance.css','./stadium-selector-v1.css',
    './production-polish-v2.css','./games-worldclass-v3.css','./games-command-v4.css','./prop-board-v4.css',
    './prop-board-responsive-v5.css','./pbe-picks-v2.css','./scrollbar-clean-v1.css'
  ];

  const CORE=[
    './team-globals-v1.js',
    './dashboard-v5.js',
    './command-palette-v3.js',
    './event-selector-v2.js',
    './global-polish-v5.js',
    './sports-shell-v2.js',
    './sports-shell-auth-state.js',
    './paywall-polish-v1.js',
    './nfl-brand-media-v2.js',
    './dashboard-v6.js',
    './dashboard-v7.js',
    './dashboard-v8-enhance.js',
    './dashboard-v7-sanitize.js',
    './network-footer-v1.js',
    './paywall-funnel-v2.js',
    './stadium-selector-v1.js',
    './production-polish-v2.js'
  ];

  const ROUTES={
    home:[],
    games:['./games-v2.js','./games-command-v4.js'],
    teams:['./team-research-v3.js'],
    stats:['./stats-v2.js'],
    standings:['./standings-v2.js'],
    seasonhistory:['./season-archive-v2.js'],
    hof:['./hof-v2.js'],
    records:['./records-v2.js'],
    sb:['./super-bowls-v2.js'],
    prospects:['./draft-review-v2.js'],
    news:['./newsroom-v2.js'],
    newsintel:['./newsroom-v2.js','./news-intelligence-v2.js'],
    injuries:['./newsroom-v2.js'],
    trades:['./newsroom-v2.js'],
    propchain:['./propchain-v2.js'],
    matchups:['./matchups-v2.js'],
    simulator:['./simulator-v2.js','./simulator-v3-enhance.js'],
    sgplab:['./sgp-lab-v2.js'],
    usage:['./usage-v2.js'],
    marketwatch:['./market-watch-v3.js'],
    player:['./player-research-v2.js'],
    players:['./player-research-v2.js'],
    picks:['./model-lab-v2-enhance.js'],
    propboard:['./prop-board-v4.js'],
    pbecast:['./pbecast-v6.js','./pbecast-v7-enhance.js'],
    pbepicks:['./pbe-picks-v2.js'],
    trackrecord:['./pbe-picks-v2.js']
  };

  const PRO_MODULES=[
    {selector:'.pbe22-watch',global:'PBEMarketWatch'},
    {selector:'.pbe20-sim',global:'PBELineSimulator'},
    {selector:'.pbe23-sgp',global:'PBESGPLab'},
    {selector:'.pbe4-model-lab',global:'PBEModelLab'}
  ];

  const scriptPromises=new Map();
  const routePromises=new Map();
  let proSyncRun=0;

  window.PBELoaderState={version:VERSION,phase:'starting',currentRoute:null,lastError:null,loaded:[]};

  function addCss(href){
    if(document.querySelector(`link[data-pbe-upgrade="${href}"]`))return;
    const link=document.createElement('link');
    link.rel='stylesheet';
    link.href=`${href}?v=${VERSION}`;
    link.dataset.pbeUpgrade=href;
    document.head.appendChild(link);
  }

  function addScript(src){
    if(!src)return Promise.resolve();
    if(scriptPromises.has(src))return scriptPromises.get(src);
    if(document.querySelector(`script[data-pbe-upgrade="${src}"]`))return Promise.resolve();

    const promise=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      const timer=setTimeout(()=>{
        script.remove();
        reject(new Error(`module_timeout:${src}`));
      },12000);
      script.src=`${src}?v=${VERSION}`;
      script.async=false;
      script.dataset.pbeUpgrade=src;
      script.onload=()=>{
        clearTimeout(timer);
        window.PBELoaderState.loaded.push(src);
        resolve();
      };
      script.onerror=()=>{
        clearTimeout(timer);
        reject(new Error(`module_load_failed:${src}`));
      };
      document.body.appendChild(script);
    });
    scriptPromises.set(src,promise);
    return promise;
  }

  async function loadSequence(files){
    for(const file of files)await addScript(file);
  }

  function normalizedRoute(route){
    const raw=String(route||'home').replace(/^#/,'').trim().toLowerCase();
    if(raw==='season-history'||raw==='season_history')return'seasonhistory';
    if(raw==='superbowls'||raw==='super_bowls')return'sb';
    return raw||'home';
  }

  async function ensureRoute(route){
    const key=normalizedRoute(route);
    if(routePromises.has(key))return routePromises.get(key);
    const files=ROUTES[key]||[];
    const promise=(async()=>{
      window.PBELoaderState.phase='route';
      window.PBELoaderState.currentRoute=key;
      await loadSequence(files);
      return true;
    })().catch(error=>{
      window.PBELoaderState.lastError=String(error?.message||error);
      routePromises.delete(key);
      throw error;
    });
    routePromises.set(key,promise);
    return promise;
  }

  function currentRoute(){
    return normalizedRoute(String(location.hash||'').replace(/^#/,'')||window.App?.current||'home');
  }

  function forceVisibleProRender(){
    const runId=++proSyncRun;
    let attempt=0;
    const run=()=>{
      if(runId!==proSyncRun)return;
      attempt+=1;
      let waiting=false;
      document.documentElement.dataset.pbePro=window.PBEPro?.state?.pro===true?'1':'0';
      for(const spec of PRO_MODULES){
        if(!document.querySelector(spec.selector))continue;
        const module=window[spec.global];
        if(!module||typeof module.render!=='function')continue;
        if(module.state?.loading){waiting=true;continue}
        try{module.render()}catch(error){console.error('[pbe-loader-pro-sync]',spec.global,error?.message||error)}
      }
      if(waiting&&attempt<20)setTimeout(run,150);
    };
    queueMicrotask(run);
  }

  function installRouteLoading(){
    window.addEventListener('pbe:route-missing',event=>{
      const route=normalizedRoute(event?.detail?.route||window.App?.current||'home');
      ensureRoute(route)
        .then(()=>{
          if(window.App?.current===route)window.App.nav(route,{history:false});
        })
        .catch(error=>{
          console.error('[pbe-route-load]',route,error);
          window.PBEAppCore?.renderFailure?.(route,'Workspace failed to load.');
        });
    });
  }

  function installProSync(){
    window.addEventListener('pbe:pro-state',forceVisibleProRender);
    window.addEventListener('pbe:route-changed',forceVisibleProRender);
    setTimeout(forceVisibleProRender,0);
    setTimeout(forceVisibleProRender,400);
  }

  async function boot(){
    CSS.forEach(addCss);
    installRouteLoading();
    try{
      window.PBELoaderState.phase='core';
      await loadSequence(CORE);
      await ensureRoute(currentRoute());
      installProSync();
      window.PBELoaderState.phase='ready';
      window.dispatchEvent(new CustomEvent('pbe:upgrades-ready',{detail:{version:VERSION}}));
      forceVisibleProRender();
    }catch(error){
      window.PBELoaderState.phase='failed';
      window.PBELoaderState.lastError=String(error?.message||error);
      console.error('[pbe-loader-fatal]',error);
      const route=currentRoute();
      window.PBEAppCore?.renderFailure?.(route,'Core workspace failed to load.');
    }
  }

  boot();
})();
