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

  const PBECAST_LOGO_ALIAS={WAS:'wsh',WSH:'wsh'};

  let syncGeneration=0;

  function ensureCastRailStyles(){
    if(document.getElementById('pbe-cast-rail-polish-v1'))return;
    const style=document.createElement('style');
    style.id='pbe-cast-rail-polish-v1';
    style.textContent=`
      .pbecast6 [data-cast6-rail]{min-width:0;max-width:100%;overflow:hidden}
      .pbecast6 .cast6-rail{
        display:grid;grid-auto-flow:column;grid-auto-columns:calc(16.666667% - 6.667px);
        gap:8px;width:100%;max-width:100%;padding:2px 0 8px;overflow-x:auto;overflow-y:hidden;
        scroll-snap-type:x mandatory;scroll-padding-inline:0;overscroll-behavior-inline:contain;
      }
      .pbecast6 .cast6-rail button{
        width:100%;min-width:0;flex:none;min-height:108px;scroll-snap-align:start;scroll-snap-stop:always;
      }
      .pbecast6 .cast6-rail button>div{
        grid-template-columns:minmax(0,1fr) 28px 22px minmax(0,1fr) 28px;gap:6px;margin-top:8px;
      }
      .pbecast6 .cast6-rail-team{display:flex;align-items:center;gap:7px;min-width:0}
      .pbecast6 .cast6-rail-team.home{justify-content:flex-end}
      .pbecast6 .cast6-rail button.cast6-rail-scheduled>div{grid-template-columns:minmax(0,1fr) 22px minmax(0,1fr)}
      .pbecast6 .cast6-rail button.cast6-rail-scheduled>div>strong{display:none}
      .pbecast6 .cast6-rail-logo{
        width:28px;height:28px;flex:0 0 28px;object-fit:contain;filter:drop-shadow(0 5px 8px rgba(0,0,0,.34));
      }
      .pbecast6 .cast6-rail-team b{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .pbecast6 .cast6-rail button.active{
        box-shadow:inset 0 0 0 1px rgba(216,183,91,.13),0 10px 24px rgba(0,0,0,.18);
      }
      @media(max-width:1600px){.pbecast6 .cast6-rail{grid-auto-columns:calc(20% - 6.4px)}}
      @media(max-width:1320px){.pbecast6 .cast6-rail{grid-auto-columns:calc(25% - 6px)}}
      @media(max-width:1040px){.pbecast6 .cast6-rail{grid-auto-columns:calc(33.333333% - 5.334px)}}
      @media(max-width:760px){
        .pbecast6 .cast6-rail{grid-auto-columns:calc(50% - 4px)}
        .pbecast6 .cast6-rail button{min-height:104px}
        .pbecast6 .cast6-rail-logo{width:25px;height:25px;flex-basis:25px}
      }
      @media(max-width:520px){.pbecast6 .cast6-rail{grid-auto-columns:100%}}
    `;
    document.head.appendChild(style);
  }

  function pbecastLogoUrl(abbr){
    const key=String(PBECAST_LOGO_ALIAS[abbr]||abbr||'').trim().toLowerCase();
    return key?`https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${encodeURIComponent(key)}.png`:'';
  }

  function polishCastRail(root=document){
    root.querySelectorAll('.pbecast6 .cast6-rail button[data-game]').forEach(card=>{
      const matchup=card.querySelector(':scope > div');
      if(!matchup)return;
      const stateText=String(card.querySelector(':scope > span')?.textContent||'').toUpperCase();
      card.classList.toggle('cast6-rail-scheduled',stateText.includes('SCHEDULE'));
      matchup.querySelectorAll(':scope > b').forEach((label,index)=>{
        const abbr=String(label.textContent||'').trim().toUpperCase();
        const src=pbecastLogoUrl(abbr);
        if(!abbr||!src)return;

        const team=document.createElement('span');
        team.className=`cast6-rail-team ${index===0?'away':'home'}`;
        team.dataset.teamAbbr=abbr;

        const img=document.createElement('img');
        img.className='cast6-rail-logo';
        img.src=src;
        img.alt='';
        img.setAttribute('aria-hidden','true');
        img.loading='eager';
        img.decoding='async';
        img.width=28;
        img.height=28;
        img.addEventListener('error',()=>{
          if(!img.isConnected)return;
          img.remove();
          team.classList.add('logo-unavailable');
        },{once:true});

        label.before(team);
        if(index===0)team.append(img,label);
        else team.append(label,img);
      });
    });
  }

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
    polishCastRail(root);
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
    ensureCastRailStyles();
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
      window.PBEProductionPolish={clean,polishCastRail,observer,syncVisibleProModules};
    }else{
      window.PBEProductionPolish={clean,polishCastRail,syncVisibleProModules};
    }

    window.addEventListener('pbe:pro-state',syncVisibleProModules);
    window.addEventListener('pbe:upgrades-ready',syncVisibleProModules);

    /* Repair a stale premium wall if auth resolved before this late module loaded. */
    if(window.PBEPro?.state)setTimeout(syncVisibleProModules,0);
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});
  else install();
})();
