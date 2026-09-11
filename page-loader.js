/* PropBetEdge NFL - ordered page/product upgrade loader v45 recovery */
(() => {
  'use strict';
  const VERSION='20260911productdepth1';
  const upgrades=[
    /* Establish the final homepage authority first. v6 replaces the v5 DOM with
       .pbehome6; v7 historically registered itself after that without repainting
       until the next navigation. The loader explicitly invokes v7 after install. */
    {js:'./team-globals-v1.js'},
    /* The one place that knows what season, week and game state it is. Loaded
       early because standings, stats and the dashboard all read it, and
       because it repoints a stale default event before the market surfaces
       resolve one. */
    {css:'./season-state-v1.css',js:'./season-state-v1.js'},
    /* Trust guard must be installed before any surface renders news copy. */
    {js:'./pbe-news-trust.js'},
    /* Dashboard v5 and v6 are out of the runtime. Both registered
       App.VIEWS.home and both ran a full scoreboard + event + news round on
       every boot of the home route, before v7 replaced them: three dashboards
       fetching for one screen (measured: 28 /api/nfl-live and 14
       /api/news-feed requests in a cold dashboard's first 12 seconds). v7
       never needed them — it only seeded its state from theirs.

       The Sunday Command Center loads before v7 because v7 calls into it
       after every paint; What Changed and Best Line share its sources. */
    {css:'./nfl-command-center-v1.css',js:'./nfl-command-center-v1.js'},
    {css:'./what-changed-v1.css',js:'./what-changed-v1.js'},
    {css:'./best-line-v1.css',js:'./best-line-v1.js'},
    {css:'./dashboard-v7.css',js:'./dashboard-v7.js'},
    {css:'./dashboard-v8-enhance.css',js:'./dashboard-v8-enhance.js'},
    {js:'./dashboard-v7-sanitize.js'},

    /* Current additive product surfaces. Both are event-driven and do not own
       page-wide mutation observers. */
    {css:'./pbe-engine-story-v1.css',js:'./pbe-engine-story-v1.js'},
    {css:'./pbe-prop-engine-v1.css',js:'./pbe-prop-engine-v1.js'},

    {css:'./games-v2.css',js:'./games-v2.js'},
    {css:'./team-research-v3.css',js:'./team-research-v3.js'},
    {css:'./stats-v2.css',js:'./stats-v2.js'},
    /* 2025 archives. These no longer own the standings/stats routes; they
       register standings2025 / stats2025 and are reached from Archives. */
    {css:'./standings-v2.css',js:'./standings-v2.js'},
    {css:'./season-archive-v2.css',js:'./season-archive-v2.js'},
    {css:'./hof-v2.css',js:'./hof-v2.js'},
    {css:'./records-v2.css',js:'./records-v2.js'},
    {css:'./super-bowls-v2.css',js:'./super-bowls-v2.js'},
    {css:'./draft-review-v2.css',js:'./draft-review-v2.js'},
    {css:'./newsroom-v2.css',js:'./newsroom-v2.js'},
    {css:'./news-intelligence-v2.css',js:'./news-intelligence-v2.js'},

    /* PBEcast v4, v5 and the v5 renderer are retired from the production
       runtime. All three registered App.VIEWS.pbecast and all three painted
       before v6 replaced them on every deep link, and v4/v5 ran a second
       /api/nfl-live transport against the same route. v6 below is the one
       authority; see TERMINAL_AUTHORITIES. The files are kept on disk so the
       rollback is a one-line revert here, not a restore. */

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

    /* Keep the known-good global media cascade. */
    {css:'./nfl-brand-media-v1.css'},
    {css:'./nfl-player-media-v2.css',js:'./nfl-brand-media-v2.js'},
    {css:'./nfl-player-media-v3.css',js:'./nfl-player-media-v3.js'},
    {css:'./sports-shell-v3.css'},

    /* Global network identity + subscriber controls. */
    {css:'./network-footer-v1.css',js:'./network-footer-v1.js'},

    /* Production authorities. */
    {css:'./paywall-funnel-v2.css',js:'./paywall-funnel-v2.js'},
    /* PBEcast v6 is the sole route authority: #pbecast -> PBEcastV6.load ->
       .pbecast6. v7 is additive only — it decorates v6's DOM and state and
       never registers a route or renders the container itself. */
    {css:'./pbecast-v6.css',js:'./pbecast-v6.js'},
    {css:'./pbecast-v7-enhance.css',js:'./pbecast-v7-enhance.js'},
    /* Additive like v7: the Sunday board, around-the-league feed, key
       moments / replay v0 and before-kickoff context. No transport, no timer,
       no route registration. */
    {css:'./pbecast-command-v1.css',js:'./pbecast-command-v1.js'},
    {css:'./stadium-selector-v1.css',js:'./stadium-selector-v1.js'},
    {css:'./production-polish-v2.css',js:'./production-polish-v2.js'},

    /* Injury Editorial terminal authority. It converts the factual newsroom
       injury feed into a canonical PropBetEdge article desk with story art and
       source-disciplined player availability / reported return windows. */
    {css:'./injury-intel-v2.css',js:'./injury-intel-v2.js'},
    /* Presentation-only terminal layer: converts the availability rows into a
       high-contrast five-column desktop surface and readable mobile cards. */
    {css:'./injury-readability-v5.css',js:'./injury-readability-v5.js'},

    /* Games is a primary NFL conversion surface. v5 adds edge-cached market
       readiness / variance / environment context without changing schedule truth. */
    {css:'./games-worldclass-v3.css'},
    {css:'./games-command-v4.css',js:'./games-command-v4.js'},
    {css:'./games-intel-v5.css',js:'./games-intel-v5.js'},

    /* Prop Board: v3 remains the data authority (PBEPropBoardV3.load), and
       v5 is the ONE presentation authority for the route. The v4 signal
       layer and the responsive-v5 patch are superseded and deliberately
       NOT loaded: they mutated v3's table after render and repaired each
       other's layout, which is the layering this replaces. */
    /* Current-season authorities for the standings and stats routes. They
       load after the archives so the live view is the last registrant, and
       they fail closed rather than showing a previous season. */
    {js:'./standings-2026-v1.js'},
    {js:'./stats-2026-v1.js'},

    {css:'./prop-board-v5.css',js:'./prop-board-v5.js'},

    /* PBE Picks + Verified Track Record v2 is the sole UI authority. */
    {css:'./pbe-picks-v2.css',js:'./pbe-picks-v2.js'},

    /* Gated validation telemetry is aggregate/public-safe. */
    {css:'./pbe-validation-v1.css',js:'./pbe-validation-v1.js'},

    /* Last by design: scrollbar policy may style true scrollers, but it must
       never conceal overflow or substitute for responsive component layout. */
    {css:'./scrollbar-clean-v1.css'},

    /* PLAYER DNA — four products, one design system.
       player-dna-v1.css is the sole design authority for all four and
       player-dna-shared.js the sole behaviour layer: the portalled player
       switcher, the charts and the formatting grammar live there and nowhere
       else. Each product then loads only what its own position needs.
       QB DNA v2 is the sole UI authority for the qbdna route; v1 is retired
       and deliberately NOT loaded, because stacking it would leave two
       renderers fighting over the same view container. */
    /* PBE BREAKING — the one global alert rail. Loaded before the Player DNA
       products because its weather drawer reuses their body-level modal root,
       and after the news trust guard, which it depends on absolutely. */
    {css:'./pbe-breaking-v1.css',js:'./pbe-breaking-v1.js'},

    {css:'./player-dna-v1.css'},
    {js:'./player-dna-shared.js'},
    {js:'./qb-dna-v2.js'},
    {css:'./wr-dna-v1.css',js:'./wr-dna-v1.js'},
    {css:'./rb-dna-v1.css',js:'./rb-dna-v1.js'},
    /* TE reuses the receiver layer above it, then adds only the red zone. */
    {css:'./te-dna-v1.css',js:'./te-dna-v1.js'},

    /* The two intelligence layers, shared by all four DNA products. Loaded
       after them because it attaches to whichever one is on screen and reads
       its state; it edits none of them. */
    {css:'./player-current-layer-v1.css',js:'./player-current-layer-v1.js'}
  ];

  /* ---- Terminal route authorities ----------------------------------------
     A route belongs here when more than one module in this manifest registers
     its App.VIEWS key, so that painting it before the last one lands would
     show a generation that is about to be replaced. app-core reads this
     contract: it will not paint, and will not boot into, a declared route
     until that route's module has installed — and once installed, that module
     owns the key and no later module can reassign it.

     Add a route here only if you have checked that the named module really is
     the last registrant for it. Everything absent from this map behaves
     exactly as it always has. */
  const TERMINAL_AUTHORITIES=[
    {route:'pbecast',js:'./pbecast-v6.js',installed:()=>typeof window.PBEcastV6?.load==='function'},
    /* standings-v2 and stats-v2 register the 2025 archive routes now, but both
       owned the live route names for a long time; declaring the current-season
       modules terminal keeps a cached copy of either archive from painting the
       live route during a load. */
    {route:'standings',js:'./standings-2026-v1.js',installed:()=>typeof window.PBEStandings2026?.load==='function'},
    {route:'stats',js:'./stats-2026-v1.js',installed:()=>typeof window.PBEStats2026?.load==='function'}
  ];

  const pendingRoutes=new Set(TERMINAL_AUTHORITIES.map(a=>a.route));
  const declaredRoutes=new Set(pendingRoutes);
  /* Published synchronously, before the first await below, so that app-core's
     DOMContentLoaded fallback can tell "a loader is running" from "no loader
     is present" without guessing at a delay. */
  window.PBEUpgrades={
    version:VERSION,
    loading:true,
    failed:false,
    declares:route=>declaredRoutes.has(String(route)),
    ready:route=>!pendingRoutes.has(String(route)),
    pending:()=>[...pendingRoutes]
  };

  function settleAuthorities(js){
    for(const spec of TERMINAL_AUTHORITIES){
      if(spec.js!==js||!pendingRoutes.has(spec.route))continue;
      pendingRoutes.delete(spec.route);
      if(!spec.installed())console.warn('[pbe-route-authority]',spec.route,'module loaded without installing; route falls back to whatever is registered');
      window.dispatchEvent(new CustomEvent('pbe:route-authority-ready',{detail:{route:spec.route,js:spec.js}}));
    }
  }
  function releaseAuthorities(failed){
    window.PBEUpgrades.loading=false;
    if(failed)window.PBEUpgrades.failed=true;
    if(!pendingRoutes.size)return;
    /* Nothing further is coming: stop holding routes that never arrived. */
    const stranded=[...pendingRoutes];
    pendingRoutes.clear();
    stranded.forEach(route=>window.dispatchEvent(new CustomEvent('pbe:route-authority-ready',{detail:{route,stranded:true}})));
  }

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

  function addScript(src,attempt=0){
    return new Promise((resolve,reject)=>{
      if(!src)return resolve();
      if(document.querySelector(`script[data-pbe-upgrade="${src}"]`))return resolve();
      const script=document.createElement('script');
      script.src=`${src}?v=${VERSION}${attempt?`&retry=${attempt}`:''}`;
      script.async=false;
      script.dataset.pbeUpgrade=src;
      script.onload=resolve;
      script.onerror=()=>{
        script.remove();
        if(attempt<1){
          console.warn('PBE product module retry',src);
          addScript(src,attempt+1).then(resolve,reject);
        }else reject(new Error(`module_load_failed:${src}`));
      };
      document.body.appendChild(script);
    });
  }

  function replayPendingRoute(){
    const route=window.App?.current;
    if(!route||typeof window.App?.VIEWS?.[route]!=='function')return false;
    /* Never replay a route whose terminal authority is still in flight: that
       replay-after-every-module is what walked PBEcast through four
       generations on a single load. */
    if(!window.PBEUpgrades.ready(route))return false;
    const pending=document.querySelector(`[data-pbe-pending-route="${CSS.escape(String(route))}"]`);
    if(!pending&&window.App?.pendingRoute!==route)return false;
    try{window.App.nav(route,{history:false});return true}catch(error){console.error('[pbe-route-replay]',route,error?.message||error);return false}
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
    try{
      for(const item of upgrades){
        await addScript(item.js);
        /* v7 is authoritative, but its legacy install check did not include the
           transient .pbehome6 DOM. Force the handoff immediately on initial home. */
        /* App.current is still its 'home' default here on every route, because
           App.boot() does not run until pbe:upgrades-ready. Keying the handoff
           to the hash stops a deep link to another route from spending three
           API calls loading a dashboard nobody asked for. */
        const bootRoute=window.App?.normalize?window.App.normalize(String(location.hash||'').replace(/^#/,'')):'home';
        if(item.js==='./dashboard-v7.js'&&bootRoute==='home'&&typeof window.PBEDashboardV7?.load==='function'){
          await window.PBEDashboardV7.load();
        }
        settleAuthorities(item.js);
        replayPendingRoute();
      }
      installProSync();
      releaseAuthorities(false);
      window.dispatchEvent(new CustomEvent('pbe:upgrades-ready',{detail:{version:VERSION}}));
      replayPendingRoute();
      window.App?.replayCurrent?.();
      forceVisibleProRender();
    }catch(error){
      console.error('[pbe-loader-fatal]',error?.message||error);
      /* The manifest genuinely failed. Release every held route so the app
         boots on whatever did install rather than sitting on a loading state
         forever, and say so rather than pretending the load completed. */
      releaseAuthorities(true);
      window.dispatchEvent(new CustomEvent('pbe:upgrades-failed',{detail:{version:VERSION,error:String(error?.message||error)}}));
      const route=window.App?.current||'home';
      const vc=document.getElementById('view-container');
      if(vc&&document.querySelector('[data-pbe-pending-route]'))vc.innerHTML=`<section class="pbe-v2-dashboard"><div class="pbe-v2-market-empty">Workspace failed to load. Refresh to retry ${String(route).replace(/-/g,' ')}.</div></section>`;
    }
  }

  load();
})();
