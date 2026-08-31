/* PropBetEdge NFL - full product, route-scoped runtime v51 */
(() => {
  'use strict';
  const VERSION='20260830freezefix1';

  const MEDIA_CSS=['./nfl-brand-media-v1.css','./nfl-player-media-v2.css','./nfl-player-media-v3.css'];
  const MEDIA_JS=['./nfl-brand-media-v2.js','./nfl-player-media-v3.js'];

  /* Global shell only. No page-specific market/news/model runtime initializes here. */
  const GLOBAL={
    css:[
      './command-palette-v2.css','./global-polish-v2.css','./sports-shell-v1.css','./sports-shell-v2.css','./sports-shell-v3.css',
      './world-class-v1.css','./readability-v1.css','./paywall-polish-v1.css','./network-footer-v1.css','./paywall-funnel-v2.css',
      './stadium-selector-v1.css','./production-polish-v2.css','./scrollbar-clean-v1.css'
    ],
    js:[
      './team-globals-v1.js','./command-palette-v3.js','./global-polish-v5.js','./sports-shell-v2.js','./sports-shell-auth-state.js',
      './paywall-polish-v1.js','./network-footer-v1.js','./paywall-funnel-v2.js','./stadium-selector-v1.js','./production-polish-v2.js'
    ]
  };

  const ROUTES={
    home:{
      css:['./dashboard-v5.css','./dashboard-v6.css','./dashboard-v7.css','./dashboard-v8-enhance.css','./nfl-stadium-bg-v3.css','./pbe-engine-story-v1.css','./pbe-prop-engine-v1.css'],
      js:['./dashboard-v5.js','./dashboard-v6.js','./dashboard-v7.js','./dashboard-v8-enhance.js','./dashboard-v7-sanitize.js','./pbe-engine-story-v1.js','./pbe-prop-engine-v1.js']
    },
    games:{
      css:['./games-v2.css','./games-worldclass-v3.css','./games-command-v4.css','./games-intel-v5.css'],
      js:['./games-v2.js','./games-command-v4.js','./games-intel-v5.js']
    },
    teams:{css:['./team-research-v3.css',...MEDIA_CSS],js:['./team-research-v3.js',...MEDIA_JS]},
    stats:{css:['./stats-v2.css',...MEDIA_CSS],js:['./stats-v2.js',...MEDIA_JS]},
    standings:{css:['./standings-v2.css'],js:['./standings-v2.js']},
    seasonhistory:{css:['./season-archive-v2.css'],js:['./season-archive-v2.js']},
    hof:{css:['./hof-v2.css',...MEDIA_CSS],js:['./hof-v2.js',...MEDIA_JS]},
    records:{css:['./records-v2.css'],js:['./records-v2.js']},
    sb:{css:['./super-bowls-v2.css'],js:['./super-bowls-v2.js']},
    prospects:{css:['./draft-review-v2.css',...MEDIA_CSS],js:['./draft-review-v2.js',...MEDIA_JS]},

    news:{css:['./newsroom-v2.css',...MEDIA_CSS],js:['./newsroom-v2.js',...MEDIA_JS]},
    newsintel:{css:['./newsroom-v2.css','./news-intelligence-v2.css',...MEDIA_CSS],js:['./newsroom-v2.js','./news-intelligence-v2.js',...MEDIA_JS]},
    injuries:{css:['./newsroom-v2.css',...MEDIA_CSS],js:['./newsroom-v2.js',...MEDIA_JS]},
    trades:{css:['./newsroom-v2.css',...MEDIA_CSS],js:['./newsroom-v2.js',...MEDIA_JS]},

    propchain:{css:['./propchain-v2.css',...MEDIA_CSS],js:['./propchain-v2.js',...MEDIA_JS]},
    matchups:{css:['./matchups-v2.css',...MEDIA_CSS],js:['./event-selector-v2.js','./matchups-v2.js',...MEDIA_JS]},
    simulator:{css:['./simulator-v2.css','./simulator-v3-enhance.css',...MEDIA_CSS],js:['./event-selector-v2.js','./simulator-v2.js','./simulator-v3-enhance.js',...MEDIA_JS]},
    sgplab:{css:['./sgp-lab-v2.css',...MEDIA_CSS],js:['./event-selector-v2.js','./sgp-lab-v2.js',...MEDIA_JS]},
    usage:{css:['./usage-v2.css',...MEDIA_CSS],js:['./event-selector-v2.js','./usage-v2.js',...MEDIA_JS]},
    marketwatch:{css:['./market-watch-v2.css','./market-watch-v3.css',...MEDIA_CSS],js:['./event-selector-v2.js','./market-watch-v3.js',...MEDIA_JS]},
    player:{css:['./player-research-v2.css',...MEDIA_CSS],js:['./player-research-v2.js',...MEDIA_JS]},
    players:{css:['./player-research-v2.css',...MEDIA_CSS],js:['./player-research-v2.js',...MEDIA_JS]},

    picks:{
      css:['./model-lab-v2-enhance.css',...MEDIA_CSS],
      js:['./event-selector-v2.js','./model-lab-v2-enhance.js',...MEDIA_JS]
    },
    propboard:{
      css:['./prop-board-v4.css','./prop-board-responsive-v5.css',...MEDIA_CSS],
      js:['./event-selector-v2.js','./prop-board-v4.js',...MEDIA_JS]
    },
    pbecast:{
      css:['./pbecast-v6.css','./pbecast-v7-enhance.css',...MEDIA_CSS],
      js:['./event-selector-v2.js','./pbecast-v6.js','./pbecast-v7-enhance.js',...MEDIA_JS]
    },
    pbepicks:{
      css:['./pbe-picks-v2.css','./pbe-validation-v1.css','./pbe-engine-story-v1.css','./pbe-prop-engine-v1.css',...MEDIA_CSS],
      js:['./pbe-picks-v2.js','./pbe-validation-v1.js','./pbe-engine-story-v1.js','./pbe-prop-engine-v1.js',...MEDIA_JS]
    },
    trackrecord:{
      css:['./pbe-picks-v2.css','./pbe-validation-v1.css','./pbe-engine-story-v1.css','./pbe-prop-engine-v1.css',...MEDIA_CSS],
      js:['./pbe-picks-v2.js','./pbe-validation-v1.js','./pbe-engine-story-v1.js','./pbe-prop-engine-v1.js',...MEDIA_JS]
    }
  };

  const PRO_MODULES=[
    {selector:'.pbe22-watch',global:'PBEMarketWatch'},
    {selector:'.pbe20-sim',global:'PBELineSimulator'},
    {selector:'.pbe23-sgp',global:'PBESGPLab'},
    {selector:'.pbe4-model-lab',global:'PBEModelLab'}
  ];

  const cssLoaded=new Set();
  const scriptPromises=new Map();
  const routePromises=new Map();
  const routeReady=new Set();
  let proSyncRun=0;

  window.PBELoaderState={version:VERSION,phase:'starting',currentRoute:null,lastError:null,loadedScripts:[],loadedCss:[],readyRoutes:[]};

  function normalizedRoute(route){
    const raw=String(route||'home').replace(/^#/,'').trim().toLowerCase();
    if(raw==='season-history'||raw==='season_history')return'seasonhistory';
    if(raw==='superbowls'||raw==='super_bowls')return'sb';
    return raw||'home';
  }
  function currentRoute(){return normalizedRoute(String(location.hash||'').replace(/^#/,'')||window.App?.current||'home')}

  function addCss(href){
    if(!href||cssLoaded.has(href)||document.querySelector(`link[data-pbe-route-css="${href}"]`))return;
    cssLoaded.add(href);
    const link=document.createElement('link');
    link.rel='stylesheet';
    link.href=`${href}?v=${VERSION}`;
    link.dataset.pbeRouteCss=href;
    link.onload=()=>window.PBELoaderState.loadedCss.push(href);
    document.head.appendChild(link);
  }

  function addScript(src){
    if(!src)return Promise.resolve();
    if(scriptPromises.has(src))return scriptPromises.get(src);
    if(document.querySelector(`script[data-pbe-route-js="${src}"]`))return Promise.resolve();
    const promise=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      const timer=setTimeout(()=>{script.remove();reject(new Error(`module_timeout:${src}`))},12000);
      script.src=`${src}?v=${VERSION}`;
      script.async=false;
      script.dataset.pbeRouteJs=src;
      script.onload=()=>{clearTimeout(timer);window.PBELoaderState.loadedScripts.push(src);resolve()};
      script.onerror=()=>{clearTimeout(timer);reject(new Error(`module_load_failed:${src}`))};
      document.body.appendChild(script);
    });
    scriptPromises.set(src,promise);
    return promise;
  }
  async function loadSequence(files){for(const file of files||[])await addScript(file)}

  function forceVisibleProRender(){
    const runId=++proSyncRun;let attempt=0;
    const run=()=>{
      if(runId!==proSyncRun)return;
      attempt+=1;let waiting=false;
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

  async function ensureRoute(route){
    const key=normalizedRoute(route);
    if(routeReady.has(key))return true;
    if(routePromises.has(key))return routePromises.get(key);
    const assets=ROUTES[key]||{css:[],js:[]};
    const promise=(async()=>{
      window.PBELoaderState.phase='route';
      window.PBELoaderState.currentRoute=key;
      (assets.css||[]).forEach(addCss);
      await loadSequence(assets.js||[]);
      routeReady.add(key);
      window.PBELoaderState.readyRoutes=[...routeReady];
      return true;
    })().catch(error=>{window.PBELoaderState.lastError=String(error?.message||error);routePromises.delete(key);throw error});
    routePromises.set(key,promise);
    return promise;
  }

  function loadRouteAndRender(route){
    const key=normalizedRoute(route);
    const wasReady=routeReady.has(key);
    return ensureRoute(key).then(()=>{
      if(!wasReady&&window.App?.current===key)window.App.nav(key,{history:false});
      forceVisibleProRender();
      return true;
    }).catch(error=>{
      console.error('[pbe-route-load]',key,error);
      window.PBEAppCore?.renderFailure?.(key,'Workspace failed to load.');
      return false;
    });
  }

  function installRouteLoading(){
    window.addEventListener('pbe:route-missing',event=>loadRouteAndRender(event?.detail?.route||window.App?.current||'home'));
    window.addEventListener('pbe:route-changed',event=>{
      const route=normalizedRoute(event?.detail?.route||window.App?.current||'home');
      if(!routeReady.has(route))loadRouteAndRender(route); else forceVisibleProRender();
    });
  }

  function installProSync(){
    window.addEventListener('pbe:pro-state',forceVisibleProRender);
    setTimeout(forceVisibleProRender,0);
    setTimeout(forceVisibleProRender,400);
  }

  async function boot(){
    installRouteLoading();
    (GLOBAL.css||[]).forEach(addCss);
    try{
      window.PBELoaderState.phase='global';
      await loadSequence(GLOBAL.js||[]);
      await ensureRoute(currentRoute());
      installProSync();
      window.PBELoaderState.phase='ready';
      window.dispatchEvent(new CustomEvent('pbe:upgrades-ready',{detail:{version:VERSION}}));
      forceVisibleProRender();
    }catch(error){
      window.PBELoaderState.phase='failed';
      window.PBELoaderState.lastError=String(error?.message||error);
      console.error('[pbe-loader-fatal]',error);
      window.PBEAppCore?.renderFailure?.(currentRoute(),'Core workspace failed to load.');
    }
  }

  boot();
})();
