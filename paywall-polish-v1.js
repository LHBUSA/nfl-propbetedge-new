/* PropBetEdge NFL Pro — production conversion polish */
(() => {
  'use strict';
  let timers=[];
  function setText(el,text){if(el&&el.textContent!==text)el.textContent=text}
  function apply(){
    const pitch=document.querySelector('.pbe-pro-pitch');
    if(!pitch)return;
    const intro=pitch.querySelector(':scope > p');
    setText(intro,'NFL Pro unlocks the proprietary PBE research layer across supported markets: fair lines, model probability, model gap, Market Watch, Line Simulator and SGP construction tools. Unsupported inputs stay explicitly unavailable instead of being filled with synthetic data.');
    const features=[...pitch.querySelectorAll('.pbe-pro-feature')];
    if(features[0]){setText(features[0].querySelector('strong'),'PBE Fair Line');setText(features[0].querySelector('span'),'Compare the sportsbook consensus with the current PBE passing-model fair line wherever model coverage is supported.')}
    if(features[1]){setText(features[1].querySelector('strong'),'Model Probability');setText(features[1].querySelector('span'),'See the model-over probability at the current line with model status, uncertainty and provenance kept visible.')}
    if(features[2]){setText(features[2].querySelector('strong'),'Market + Model Gap');setText(features[2].querySelector('span'),'See best numbers, consensus pricing and the distance between market and model without relabeling that distance as guaranteed edge.')}
    if(features[3]){setText(features[3].querySelector('strong'),'NFL Pro Research Suite');setText(features[3].querySelector('span'),'Model Lab, Market Watch, Line Simulator and SGP construction in one entitlement. Correlation and unsupported current-role inputs remain unavailable until validated.')}
    let today=pitch.querySelector('.pbe-pro-today');
    if(!today){today=document.createElement('div');today.className='pbe-pro-today';today.innerHTML='<b>WHAT YOU UNLOCK TODAY</b><span>Current market intelligence stays visible. NFL Pro unlocks the proprietary model and premium research layer where coverage is production-ready.</span>';pitch.querySelector('.pbe-pro-feature-list')?.before(today)}
    document.querySelectorAll('.pbe-pro-price-card:not([data-plan]) .pbe-pro-renew,.pbe-pro-price-card[data-plan="weekly"] .pbe-pro-renew').forEach(el=>setText(el,'$9.99/week · no trial · auto-renews weekly · cancel anytime.'));
    setText(document.getElementById('pbe-pro-signin'),'Continue with email');
    setText(document.getElementById('pbe-pro-upgrade'),'Unlock NFL Pro · $9.99/week');
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