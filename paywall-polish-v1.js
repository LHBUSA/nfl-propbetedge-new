/* PropBetEdge NFL Pro — production conversion polish */
(() => {
  'use strict';
  let observer=null;
  function apply(){
    const pitch=document.querySelector('.pbe-pro-pitch');
    if(!pitch)return;
    const intro=pitch.querySelector(':scope > p');
    if(intro)intro.textContent='NFL Pro unlocks the proprietary PBE research layer across supported markets: fair lines, model probability, model gap, Market Watch, Line Simulator and SGP construction tools. Unsupported inputs stay explicitly unavailable instead of being filled with synthetic data.';
    const features=[...pitch.querySelectorAll('.pbe-pro-feature')];
    if(features[0]){features[0].querySelector('strong').textContent='PBE Fair Line';features[0].querySelector('span').textContent='Compare the sportsbook consensus with the current PBE passing-model fair line wherever model coverage is supported.'}
    if(features[1]){features[1].querySelector('strong').textContent='Model Probability';features[1].querySelector('span').textContent='See the model-over probability at the current line with model status, uncertainty and provenance kept visible.'}
    if(features[2]){features[2].querySelector('strong').textContent='Market + Model Gap';features[2].querySelector('span').textContent='See best numbers, consensus pricing and the distance between market and model without relabeling that distance as guaranteed edge.'}
    if(features[3]){features[3].querySelector('strong').textContent='NFL Pro Research Suite';features[3].querySelector('span').textContent='Model Lab, Market Watch, Line Simulator and SGP construction in one entitlement. Correlation and unsupported current-role inputs remain unavailable until validated.'}
    let today=pitch.querySelector('.pbe-pro-today');
    if(!today){today=document.createElement('div');today.className='pbe-pro-today';today.innerHTML='<b>WHAT YOU UNLOCK TODAY</b><span>Current market intelligence stays visible. NFL Pro unlocks the proprietary model and premium research layer where coverage is production-ready.</span>';pitch.querySelector('.pbe-pro-feature-list')?.before(today)}
    document.querySelectorAll('.pbe-pro-renew').forEach(el=>el.textContent='$9.99/week · no trial · auto-renews weekly · cancel anytime.');
    const sign=document.getElementById('pbe-pro-signin');if(sign)sign.textContent='Continue with email';
    const up=document.getElementById('pbe-pro-upgrade');if(up)up.textContent='Unlock NFL Pro · $9.99/week';
  }
  function install(){apply();const root=document.getElementById('pbe-pro-backdrop')||document.body;if(!observer){observer=new MutationObserver(()=>apply());observer.observe(root,{subtree:true,childList:true})}}
  window.PBEProPolish={apply};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
