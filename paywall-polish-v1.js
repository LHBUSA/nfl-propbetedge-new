/* PropBetEdge NFL Pro — production conversion polish */
(() => {
  'use strict';
  let timers=[];
  function setText(el,text){if(el&&el.textContent!==text)el.textContent=text}
  function setHtml(el,html){if(el&&el.innerHTML!==html)el.innerHTML=html}

  function applyPitch(){
    const pitch=document.querySelector('.pbe-pro-pitch');
    if(!pitch)return;

    setText(pitch.querySelector('.pbe-pro-kicker'),'PROPBETEDGE NFL PRO · PBE ALGO · AUTOMATED LEARNING PICKER');
    setHtml(pitch.querySelector('h2'),'PBE Algo makes the pick.<br><em>Then the grade becomes evidence.</em>');

    const intro=pitch.querySelector(':scope > p');
    setText(intro,'PBE Algo is built as an automated NFL picking system, not a static tip sheet. It evaluates eligible games, publishes only qualified production-champion calls, freezes the decision and market state before the result, then grades the outcome into an auditable record.');

    const features=[...pitch.querySelectorAll('.pbe-pro-feature')];
    if(features[0]){
      setText(features[0].querySelector('strong'),'Automated Learning Architecture');
      setText(features[0].querySelector('span'),'Finalized grades can become learning observations for challenger models. Integrity gates can stop training entirely, and a challenger cannot replace the live champion unless it clears the promotion rules.');
    }
    if(features[1]){
      setText(features[1].querySelector('strong'),'Official PBE Picks');
      setText(features[1].querySelector('span'),'The production champion evaluates eligible games and publishes only qualified calls. No edge means no forced pick.');
    }
    if(features[2]){
      setText(features[2].querySelector('strong'),'Locked Decision Receipt');
      setText(features[2].querySelector('span'),'Model probability, issued line and odds, market context, model version and provenance stay attached to the call made before the outcome.');
    }
    if(features[3]){
      setText(features[3].querySelector('strong'),'Verified Track Record + Pro Desk');
      setText(features[3].querySelector('span'),'Wins and losses stay on the record. NFL Pro also unlocks the supported model, market, Best Line, simulation and research surfaces around the pick.');
    }

    let today=pitch.querySelector('.pbe-pro-today');
    if(!today){
      today=document.createElement('div');
      today.className='pbe-pro-today';
      pitch.querySelector('.pbe-pro-feature-list')?.before(today);
    }
    setHtml(today,'<b>WHY THIS IS DIFFERENT</b><span>The picker and the learning system are separated by design: official calls come only from the promoted champion; finalized outcomes feed the governed challenger pipeline; promotion requires evidence instead of silently changing the live model.</span>');

    setText(document.getElementById('pbe-pro-signin'),'Continue with email');
    setText(document.getElementById('pbe-pro-upgrade'),`Unlock PBE Algo${window.PBEPricing?` · ${window.PBEPricing.ctaSuffix}`:''}`);
  }

  function applyFunnel(){
    const root=document.querySelector('.pbe-funnel-root');
    const head=root?.querySelector('.pbe-funnel-head');
    if(!root||!head)return;
    const state=root.dataset.funnelState||'';
    if(state==='signed-out'||state==='signed-in-free'){
      setText(head.querySelector('span'),'NFL PRO · PBE ALGO · AUTOMATED LEARNING PICKER');
      setText(head.querySelector('strong'),state==='signed-out'?'Unlock the picker built to learn from its grades.':'Your account is ready. Unlock PBE Algo.');
      setText(head.querySelector('p'),'Official qualified PBE Picks, locked decision receipts, an auditable Track Record, and a governed champion/challenger learning architecture under one NFL Pro account.');
    }
  }

  function apply(){
    applyPitch();
    applyFunnel();
  }

  function schedule(){
    timers.forEach(clearTimeout);
    timers=[0,80,240,700,1600].map(delay=>setTimeout(apply,delay));
  }

  function install(){
    schedule();
    window.addEventListener('pbe:route-changed',schedule);
    window.addEventListener('pbe:upgrades-ready',schedule);
    window.addEventListener('pbe:pro-state',schedule);
  }

  window.PBEProPolish={apply,schedule};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
