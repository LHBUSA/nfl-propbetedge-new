/* PropBetEdge NFL — checkout continuation safeguard.
   If a verified auth return still contains ?plan=season|weekly, continue that plan once. */
(() => {
  'use strict';
  const PRICE={season:'price_1U9oVzF3CaVzg4ORnk5NiJFA',weekly:'price_1U9QUZF3CaVzg4OR3QNfwWCS'};
  const ONCE='pbe_nfl_checkout_continuation_v1';
  let running=false;
  function planFromUrl(){try{const p=new URLSearchParams(location.search).get('plan');return PRICE[p]?p:''}catch{return''}}
  function clearPlan(){try{const u=new URL(location.href);u.searchParams.delete('plan');history.replaceState({},'',u.pathname+(u.search?u.search:'')+u.hash)}catch(_){}}
  async function maybeContinue(){
    if(running)return;
    const plan=planFromUrl(),state=window.PBEPro?.state;
    if(!plan||!state?.user||state?.pro)return;
    let used='';try{used=sessionStorage.getItem(ONCE)||''}catch(_){}
    const key=`${state.user.email||'user'}|${plan}`;if(used===key)return;
    running=true;try{sessionStorage.setItem(ONCE,key)}catch(_){}
    clearPlan();
    try{await window.PBEPro?.checkout?.(PRICE[plan])}finally{running=false}
  }
  function install(){window.addEventListener('pbe:pro-state',()=>setTimeout(maybeContinue,60));setTimeout(maybeContinue,350)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();