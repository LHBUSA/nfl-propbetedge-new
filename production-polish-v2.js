/* PropBetEdge NFL — presentation-only truth labels */
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
  function clean(root=document){
    root.querySelectorAll('.pbe7-source,.cast4-source,.cast5-telemetry-title small').forEach(el=>{
      const text=String(el.textContent||'').trim();
      for(const [raw,label] of LABELS){if(text.includes(raw)){el.textContent=text.replace(raw,label);break}}
    });
  }
  function install(){
    clean();
    const host=document.getElementById('view-container');if(!host)return;
    let queued=false;
    const observer=new MutationObserver(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;clean(host)})});
    observer.observe(host,{childList:true,subtree:true});
    window.PBEProductionPolish={clean,observer};
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();