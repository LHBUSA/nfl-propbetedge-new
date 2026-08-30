/* PropBetEdge NFL — truthful shell account state */
(() => {
  'use strict';

  function isDegraded(s){
    return Boolean(
      s?.user?.email && !s?.pro && (
        s?.stage === 'entitlement_lookup_failed' ||
        s?.stage === 'entitlement_secret_missing' ||
        s?.stage === 'secret_missing' ||
        s?.degraded === true ||
        String(s?.error || '').toLowerCase().includes('degraded')
      )
    );
  }

  function esc(v){
    return String(v ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function degradedMarkup(s){
    const email=esc(s?.user?.email || 'Signed-in account');
    return `<div class="pbe-pro-price-card pbe-auth-degraded-card" data-pbe-auth-degraded="1">
      <div class="pbe-pro-plan-label">NFL PRO · ACCESS CHECK</div>
      <div class="pbe-pro-price"><strong style="font-size:34px">SIGNED IN</strong></div>
      <div class="pbe-pro-renew">We can verify your identity, but subscription verification is temporarily unavailable.</div>
    </div>
    <div class="pbe-pro-user-card"><strong>${email}</strong><span>Signed in · entitlement check pending</span></div>
    <div class="pbe-pro-auth-copy">Your account is <strong>not</strong> being treated as unsubscribed. Pricing and upgrade prompts are hidden until the entitlement backend answers cleanly.</div>
    <button class="pbe-pro-cta" type="button" data-pbe-auth-retry>Retry access check</button>
    <button class="pbe-pro-cta secondary" type="button" data-pbe-auth-signout>Sign out</button>
    <div class="pbe-pro-message" data-pbe-auth-message>${esc(s?.error || 'NFL Pro verification is temporarily unavailable.')}</div>
    <div class="pbe-pro-secure">◆ Identity verified · subscription state protected during backend degradation</div>`;
  }

  function wireDegraded(host){
    host.querySelector('[data-pbe-auth-retry]')?.addEventListener('click',async event=>{
      const button=event.currentTarget;
      button.disabled=true;
      const msg=host.querySelector('[data-pbe-auth-message]');
      if(msg)msg.textContent='Retrying NFL Pro access verification…';
      try{
        await window.PBEPro?.refreshAccess?.({preserveOnError:true});
      }finally{
        button.disabled=false;
        sync();
      }
    });
    host.querySelector('[data-pbe-auth-signout]')?.addEventListener('click',async event=>{
      event.currentTarget.disabled=true;
      try{
        await fetch('/api/auth-logout',{method:'POST',headers:{accept:'application/json'},cache:'no-store',credentials:'same-origin'});
      }catch(_){}
      location.reload();
    });
  }

  function renderDegraded(){
    const s=window.PBEPro?.state||{};
    if(!isDegraded(s))return;
    const host=document.querySelector('#pbe-pro-backdrop #pbe-pro-checkout');
    if(!host||host.querySelector('[data-pbe-auth-degraded="1"]'))return;
    host.innerHTML=degradedMarkup(s);
    wireDegraded(host);
  }

  function sync(){
    const s=window.PBEPro?.state||{};
    const loading=Boolean(s.loading);
    const pro=Boolean(s.pro===true);
    const signedIn=Boolean(s.user?.email);
    const degraded=isDegraded(s);
    const btn=document.getElementById('pbes-account');

    if(btn){
      btn.textContent=loading?'Account':pro?'NFL Pro':degraded?'Access Check':signedIn?'Upgrade':'Sign In';
      btn.classList.toggle('pro',pro);
      btn.classList.toggle('signed-in',signedIn);
      btn.classList.toggle('auth-degraded',degraded);
      btn.dataset.entitlement=pro?'pro':degraded?'degraded':signedIn?'signed-in-free':'signed-out';
      btn.title=pro?'NFL Pro active':degraded?'Signed in — subscription verification temporarily unavailable':signedIn?'Signed in — NFL Pro not active':'Sign in to NFL Pro';
    }

    const duplicate=document.getElementById('pbe-pro-account');
    if(duplicate&&duplicate!==btn)duplicate.style.display='none';
    renderDegraded();
  }

  function installObserver(){
    const root=document.body||document.documentElement;
    if(!root)return;
    const observer=new MutationObserver(()=>{
      if(isDegraded(window.PBEPro?.state||{}))queueMicrotask(renderDegraded);
    });
    observer.observe(root,{childList:true,subtree:true});
  }

  window.addEventListener('pbe:pro-state',sync);
  window.addEventListener('pbe:upgrades-ready',sync);
  document.addEventListener('click',event=>{
    if(event.target?.closest?.('#pbes-account,#pbe-pro-account,[data-pbe-open-pro],[data-pro]'))setTimeout(renderDegraded,0);
  },true);
  document.addEventListener('DOMContentLoaded',()=>{sync();installObserver()},{once:true});
  if(document.readyState!=='loading')installObserver();
  setTimeout(sync,0);
  setTimeout(sync,250);
  setTimeout(sync,1000);
})();