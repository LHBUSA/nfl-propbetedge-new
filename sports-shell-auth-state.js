/* PropBetEdge NFL — truthful shell account state */
(() => {
  'use strict';

  function sync(){
    const btn=document.getElementById('pbes-account');
    if(!btn)return;
    const s=window.PBEPro?.state||{};
    const loading=Boolean(s.loading);
    const pro=Boolean(s.pro===true);
    const signedIn=Boolean(s.user?.email);

    btn.textContent=loading?'Account':pro?'NFL Pro':signedIn?'Upgrade':'Sign In';
    btn.classList.toggle('pro',pro);
    btn.classList.toggle('signed-in',signedIn);
    btn.dataset.entitlement=pro?'pro':signedIn?'signed-in-free':'signed-out';
    btn.title=pro?'NFL Pro active':signedIn?'Signed in — NFL Pro not active':'Sign in to NFL Pro';

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