/* PropBetEdge NFL — truthful shell account state */
(() => {
  'use strict';

  function isDegraded(s){
    return Boolean(
      s?.user?.email && !s?.pro && (
        s?.stage === 'entitlement_lookup_failed' ||
        s?.stage === 'secret_missing' ||
        s?.degraded === true ||
        String(s?.error || '').toLowerCase().includes('degraded')
      )
    );
  }

  function sync(){
    const btn=document.getElementById('pbes-account');
    if(!btn)return;
    const s=window.PBEPro?.state||{};
    const loading=Boolean(s.loading);
    const pro=Boolean(s.pro===true);
    const signedIn=Boolean(s.user?.email);
    const degraded=isDegraded(s);

    btn.textContent=loading?'Account':pro?'NFL Pro':degraded?'Access Check':signedIn?'Upgrade':'Sign In';
    btn.classList.toggle('pro',pro);
    btn.classList.toggle('signed-in',signedIn);
    btn.classList.toggle('auth-degraded',degraded);
    btn.dataset.entitlement=pro?'pro':degraded?'degraded':signedIn?'signed-in-free':'signed-out';
    btn.title=pro?'NFL Pro active':degraded?'Signed in — subscription verification temporarily unavailable':signedIn?'Signed in — NFL Pro not active':'Sign in to NFL Pro';

    const duplicate=document.getElementById('pbe-pro-account');
    if(duplicate&&duplicate!==btn)duplicate.style.display='none';
  }

  window.addEventListener('pbe:pro-state',sync);
  window.addEventListener('pbe:upgrades-ready',sync);
  document.addEventListener('DOMContentLoaded',sync,{once:true});
  setTimeout(sync,0);
  setTimeout(sync,250);
  setTimeout(sync,1000);
})();