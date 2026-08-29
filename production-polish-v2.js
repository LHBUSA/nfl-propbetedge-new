/* PropBetEdge NFL — final production polish + entitlement synchronization */
(() => {
  'use strict';

  const LABELS=new Map([
    ['ESPN_CDN_GAMEPACKAGE','ESPN LIVE'],
    ['ESPN CDN GAMEPACKAGE','ESPN LIVE'],
    ['ESPN_CDN_SCOREBOARD','ESPN SCOREBOARD'],
    ['ESPN CDN SCOREBOARD','ESPN SCOREBOARD'],
    ['espn_cdn_gamepackage','ESPN LIVE'],
    ['espn_cdn_scoreboard','ESPN SCOREBOARD']
  ]);

  const PRO_MODULES=[
    {selector:'.pbe22-watch',global:'PBEMarketWatch'},
    {selector:'.pbe20-sim',global:'PBELineSimulator'},
    {selector:'.pbe23-sgp',global:'PBESGPLab'},
    {selector:'.pbe4-model-lab',global:'PBEModelLab'}
  ];

  let syncGeneration=0;

  function clean(root=document){
    root.querySelectorAll('.pbe7-source,.cast4-source,.cast5-telemetry-title small').forEach(el=>{
      const text=String(el.textContent||'').trim();
      for(const [raw,label] of LABELS){
        if(text.includes(raw)){
          el.textContent=text.replace(raw,label);
          break;
        }
      }
    });
  }

  /*
   * Premium modules can begin their own data load before /api/auth-session
   * finishes. Historically their pbe:pro-state listeners discarded the event
   * whenever module.state.loading === true. That left a stale paywall rendered
   * even after the global account state had become NFL Pro.
   *
   * This late production authority never invents entitlement. It only asks the
   * currently visible module to rerender from window.PBEPro.state after that
   * module has finished loading. The server-backed PBEPro state remains the one
   * source of truth.
   */
  function syncVisibleProModules(){
    const generation=++syncGeneration;
    let attempts=0;

    const run=()=>{
      if(generation!==syncGeneration)return;
      attempts+=1;
      let waiting=false;

      for(const spec of PRO_MODULES){
        if(!document.querySelector(spec.selector))continue;
        const module=window[spec.global];
        if(!module||typeof module.render!=='function')continue;
        if(module.state?.loading){
          waiting=true;
          continue;
        }
        try{module.render();}catch(error){console.error('[pbe-pro-sync]',spec.global,error?.message||error)}
      }

      if(waiting&&attempts<40)setTimeout(run,100);
    };

    queueMicrotask(run);
  }

  function install(){
    clean();
    const host=document.getElementById('view-container');
    if(host){
      let queued=false;
      const observer=new MutationObserver(()=>{
        if(queued)return;
        queued=true;
        requestAnimationFrame(()=>{
          queued=false;
          clean(host);
        });
      });
      observer.observe(host,{childList:true,subtree:true});
      window.PBEProductionPolish={clean,observer,syncVisibleProModules};
    }else{
      window.PBEProductionPolish={clean,syncVisibleProModules};
    }

    window.addEventListener('pbe:pro-state',syncVisibleProModules);
    window.addEventListener('pbe:upgrades-ready',syncVisibleProModules);

    /* Repair a stale premium wall if auth resolved before this late module loaded. */
    if(window.PBEPro?.state)setTimeout(syncVisibleProModules,0);
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});
  else install();
})();