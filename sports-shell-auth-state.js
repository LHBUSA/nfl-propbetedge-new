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

  /* Signed in, entitlement check failed: identity is shown, membership is
   * NOT assumed lost, and no price or upgrade prompt is rendered. Wears the
   * v3 account shell (nfl-account-v3.css); the stadium column reads "access
   * check" (paywall-funnel-v2.js paintVisual). */
  function degradedMarkup(s){
    const email=esc(s?.user?.email || 'Signed-in account');
    return `<div class="pbe-acct-panel pbe-acct-degraded" data-pbe-auth-degraded="1">
      <div class="pbe-acct-identity is-check"><i aria-hidden="true"></i><span>SIGNED IN</span><strong>${email}</strong></div>
      <div class="pbe-funnel-head"><span>NFL PRO · ACCESS CHECK</span><strong>Signed in — access check temporarily unavailable</strong><p>We can verify your identity, but membership verification is temporarily unavailable.</p></div>
      <div class="pbe-acct-protect"><b>Your account is <em>not</em> being treated as unsubscribed.</b><span>Pricing and upgrade prompts stay hidden until the entitlement backend answers cleanly.</span></div>
      <div class="pbe-acct-actions">
        <button class="pbe-pro-cta" type="button" data-pbe-auth-retry>Retry access check</button>
        <button class="pbe-pro-cta secondary" type="button" data-pbe-auth-signout>Sign out</button>
        <div class="pbe-pro-message" data-pbe-auth-message role="status" aria-live="polite">${esc(s?.error || 'NFL Pro verification is temporarily unavailable.')}</div>
      </div>
      <div class="pbe-pro-secure">◆ Identity verified · subscription state protected during backend degradation</div>
    </div>`;
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
        if(msg&&msg.isConnected&&isDegraded(window.PBEPro?.state||{}))msg.textContent='Access check is still unavailable. Your membership has not changed; try again shortly.';
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

  /* Members show the shared membership label (NFL PRO ACTIVE / ALL ACCESS
   * ACTIVE / OWNER) the server derived; free readers keep Sign In / Upgrade.
   * Nothing here decides entitlement: `pro` is the access verdict, the label
   * is read from the contract object carried with it. */
  function memberLabel(s){
    const m=s?.membership;
    /* Display only: ◆ PLATINUM for all_access, NFL PRO MEMBER, VERIFIED OWNER. */
    const d=s?.pro===true?window.PBENflMember?.display?.(m?.entitled?m:null,s?.role==='owner'?'owner':null):null;
    if(d)return d.header;
    return m?.entitled&&m.label?m.label:'NFL Pro';
  }
  function accountLabel(s){
    const loading=Boolean(s?.loading);
    const pro=Boolean(s?.pro===true);
    const signedIn=Boolean(s?.user?.email);
    if(loading)return 'Account';
    if(pro)return memberLabel(s);
    if(isDegraded(s))return 'Access Check';
    /* A signed-in reader whose NFL access ended reads Renew (never FREE). */
    if(signedIn&&s?.access==='no_entitlement')return 'Renew';
    return signedIn?'Upgrade':'Sign In';
  }

  function sync(){
    const s=window.PBEPro?.state||{};
    const loading=Boolean(s.loading);
    const pro=Boolean(s.pro===true);
    const signedIn=Boolean(s.user?.email);
    const degraded=isDegraded(s);
    const btn=document.getElementById('pbes-account');

    if(btn){
      btn.textContent=accountLabel(s);
      btn.classList.toggle('pro',pro);
      btn.classList.toggle('signed-in',signedIn);
      btn.classList.toggle('auth-degraded',degraded);
      btn.dataset.entitlement=pro?'pro':degraded?'degraded':signedIn?'signed-in-free':'signed-out';
      btn.dataset.membership=pro?(s.membership?.state||'sport_pro'):'free';
      btn.title=pro?`${memberLabel(s)} · open your account`:degraded?'Signed in — subscription verification temporarily unavailable':signedIn?'Signed in — NFL Pro not active':'Sign in to NFL Pro';
    }

    const duplicate=document.getElementById('pbe-pro-account');
    if(duplicate&&duplicate!==btn)duplicate.style.display='none';
    renderDegraded();
  }

  function installObserver(){
    const root=document.body||document.documentElement;
    if(!root)return;
    /* Coalesced onto a macrotask rather than a microtask. renderDegraded is
     * already idempotent, but scheduling observer work as a microtask means any
     * future feedback loop could never yield to the event loop — exactly the
     * failure mode that wedged the main thread in dashboard-v8-enhance. */
    let queued=0;
    const observer=new MutationObserver(()=>{
      if(queued||!isDegraded(window.PBEPro?.state||{}))return;
      queued=setTimeout(()=>{queued=0;renderDegraded()},50);
    });
    observer.observe(root,{childList:true,subtree:true});
  }

  window.PBEShellAuthState={accountLabel,memberLabel,isDegraded,degradedMarkup};
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