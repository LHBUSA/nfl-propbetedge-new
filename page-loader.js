/* PropBetEdge NFL - isolated route loader v50 */
(() => {
  'use strict';
  const VERSION='20260830isolated1';

  const GLOBAL={
    css:['./scrollbar-clean-v1.css'],
    js:['./team-globals-v1.js']
  };

  /* Recovery contract: a route owns its own additive assets. Nothing here gets
   * to initialize merely because some other page is open. index.html retains
   * the small historical/base authorities (paywall, UI v2, Prop Board v3 and
   * Model Lab base); everything below is demand-loaded. */
  const ROUTES={
    home:{
      css:['./dashboard-v5.css'],
      js:['./dashboard-v5.js']
    },
    games:{
      css:['./games-v2.css','./games-worldclass-v3.css','./games-command-v4.css'],
      js:['./games-v2.js','./games-command-v4.js']
    },
    teams:{css:['./team-research-v3.css'],js:['./team-research-v3.js']},
    stats:{css:['./stats-v2.css'],js:['./stats-v2.js']},
    standings:{css:['./standings-v2.css'],js:['./standings-v2.js']},
    seasonhistory:{css:['./season-archive-v2.css'],js:['./season-archive-v2.js']},
    hof:{css:['./hof-v2.css'],js:['./hof-v2.js']},
    records:{css:['./records-v2.css'],js:['./records-v2.js']},
    sb:{css:['./super-bowls-v2.css'],js:['./super-bowls-v2.js']},
    prospects:{css:['./draft-review-v2.css'],js:['./draft-review-v2.js']},

    news:{css:['./newsroom-v2.css'],js:['./newsroom-v2.js']},
    newsintel:{css:['./newsroom-v2.css','./news-intelligence-v2.css'],js:['./newsroom-v2.js','./news-intelligence-v2.js']},
    injuries:{css:['./newsroom-v2.css'],js:['./newsroom-v2.js']},
    trades:{css:['./newsroom-v2.css'],js:['./newsroom-v2.js']},

    propchain:{css:['./propchain-v2.css'],js:['./propchain-v2.js']},
    matchups:{css:['./matchups-v2.css'],js:['./matchups-v2.js']},
    simulator:{css:['./simulator-v2.css','./simulator-v3-enhance.css'],js:['./simulator-v2.js','./simulator-v3-enhance.js']},
    sgplab:{css:['./sgp-lab-v2.css'],js:['./sgp-lab-v2.js']},
    usage:{css:['./usage-v2.css'],js:['./usage-v2.js']},
    marketwatch:{css:['./market-watch-v2.css','./market-watch-v3.css'],js:['./market-watch-v3.js']},
    player:{css:['./player-research-v2.css'],js:['./player-research-v2.js']},
    players:{css:['./player-research-v2.css'],js:['./player-research-v2.js']},

    /* Base Model Lab / Prop Board renderers are already present from index.html.
       Their richer layers are loaded only when those routes are actually used. */
    picks:{
      css:['./model-lab-v2-enhance.css','./nfl-player-media-v2.css'],
      js:['./event-selector-v2.js','./model-lab-v2-enhance.js','./nfl-brand-media-v2.js']
    },
    propboard:{
      css:['./prop-board-v4.css','./prop-board-responsive-v5.css','./nfl-player-media-v2.css'],
      js:['./event-selector-v2.js','./prop-board-v4.js','./nfl-brand-media-v2.js']
    },
    pbecast:{
      css:['./pbecast-v6.css','./pbecast-v7-enhance.css'],
      js:['./pbecast-v6.js','./pbecast-v7-enhance.js']
    },
    pbepicks:{css:['./pbe-picks-v2.css'],js:['./pbe-picks-v2.js']},
    trackrecord:{css:['./pbe-picks-v2.css'],js:['./pbe-picks-v2.js']}
  };

  const cssLoaded=new Set();
  const scriptPromises=new Map();
  const routePromises=new Map();
  const routeReady=new Set();

  window.PBELoaderState={
    version:VERSION,
    phase:'starting',
    currentRoute:null,
    lastError:null,
    loadedScripts:[],
    loadedCss:[],
    readyRoutes:[]
  };

  function normalizedRoute(route){
    const raw=String(route||'home').replace(/^#/,'').trim().toLowerCase();
    if(raw==='season-history'||raw==='season_history')return'seasonhistory';
    if(raw==='superbowls'||raw==='super_bowls')return'sb';
    return raw||'home';
  }

  function currentRoute(){
    return normalizedRoute(String(location.hash||'').replace(/^#/,'')||window.App?.current||'home');
  }

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
      const timer=setTimeout(()=>{
        script.remove();
        reject(new Error(`module_timeout:${src}`));
      },10000);
      script.src=`${src}?v=${VERSION}`;
      script.async=false;
      script.dataset.pbeRouteJs=src;
      script.onload=()=>{
        clearTimeout(timer);
        window.PBELoaderState.loadedScripts.push(src);
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
    for(const file of files||[])await addScript(file);
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
    })().catch(error=>{
      window.PBELoaderState.lastError=String(error?.message||error);
      routePromises.delete(key);
      throw error;
    });
    routePromises.set(key,promise);
    return promise;
  }

  function loadRouteAndRender(route){
    const key=normalizedRoute(route);
    const wasReady=routeReady.has(key);
    return ensureRoute(key).then(()=>{
      if(!wasReady&&window.App?.current===key)window.App.nav(key,{history:false});
      return true;
    }).catch(error=>{
      console.error('[pbe-route-load]',key,error);
      window.PBEAppCore?.renderFailure?.(key,'Workspace failed to load.');
      return false;
    });
  }

  function installRouteLoading(){
    window.addEventListener('pbe:route-missing',event=>{
      loadRouteAndRender(event?.detail?.route||window.App?.current||'home');
    });
    window.addEventListener('pbe:route-changed',event=>{
      const route=normalizedRoute(event?.detail?.route||window.App?.current||'home');
      if(!routeReady.has(route))loadRouteAndRender(route);
    });
  }

  async function boot(){
    installRouteLoading();
    (GLOBAL.css||[]).forEach(addCss);
    try{
      window.PBELoaderState.phase='global';
      await loadSequence(GLOBAL.js||[]);
      await ensureRoute(currentRoute());
      window.PBELoaderState.phase='ready';
      window.dispatchEvent(new CustomEvent('pbe:upgrades-ready',{detail:{version:VERSION}}));
    }catch(error){
      window.PBELoaderState.phase='failed';
      window.PBELoaderState.lastError=String(error?.message||error);
      console.error('[pbe-loader-fatal]',error);
      window.PBEAppCore?.renderFailure?.(currentRoute(),'Core workspace failed to load.');
    }
  }

  boot();
})();
