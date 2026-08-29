/* PropBetEdge NFL — plan-first checkout funnel v2
 * Pricing is public. Auth is a verification step inside checkout, never a blind wall.
 */
(() => {
  'use strict';

  const WEEKLY = 'price_1U9QUZF3CaVzg4OR3QNfwWCS';
  const SEASON = 'price_1U9oVzF3CaVzg4ORnk5NiJFA';
  const STORAGE = 'pbe_nfl_pending_plan_v2';
  const PLANS = {
    season: { priceId: SEASON, label: 'Season Pass', price: '$99', detail: 'one time', term: 'Access through February 14, 2027 · no recurring billing' },
    weekly: { priceId: WEEKLY, label: 'Weekly', price: '$9.99', detail: '/ week', term: 'Renews weekly · no trial · cancel anytime' }
  };

  let queued = false;
  let checkoutStarted = false;

  function state() { return window.PBEPro?.state || {}; }
  function selectedKey() {
    try { return localStorage.getItem(STORAGE) || 'season'; } catch (_) { return 'season'; }
  }
  function setSelected(key) {
    if (!PLANS[key]) return;
    try { localStorage.setItem(STORAGE,key); } catch (_) {}
    paintSelection();
  }
  function clearSelected() { try { localStorage.removeItem(STORAGE); } catch (_) {} }

  function signedOutMarkup() {
    const selected = selectedKey();
    return `<div class="pbe-funnel-head">
      <span>CHOOSE YOUR NFL PRO ACCESS</span>
      <strong>Pick the plan first.</strong>
      <p>Your price and terms are visible before sign-in. We verify your email only so Stripe can attach the purchase to the correct NFL Pro account.</p>
    </div>
    <div class="pbe-pro-plans pbe-funnel-plans">
      ${planCard('season',selected)}
      ${planCard('weekly',selected)}
    </div>
    <div class="pbe-funnel-step"><span>2</span><div><b>Verify the email that will own this purchase</b><small>One secure link. No password. After verification we continue the plan you selected.</small></div></div>
    <div class="pbe-pro-auth-state pbe-funnel-auth">
      <input class="pbe-pro-email" id="pbe-funnel-email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" aria-label="Email address">
      <button class="pbe-pro-cta" id="pbe-funnel-continue" type="button"></button>
      <div class="pbe-pro-message" id="pbe-funnel-message"></div>
    </div>
    <div class="pbe-pro-secure">◆ PropBetEdge verified email · Stripe checkout · entitlement auto-linked</div>`;
  }

  function planCard(key,selected) {
    const p=PLANS[key];
    return `<button type="button" class="pbe-pro-price-card pbe-funnel-plan ${selected===key?'selected':''}" data-funnel-plan="${key}" aria-pressed="${selected===key?'true':'false'}">
      <div class="pbe-funnel-check">${selected===key?'✓':'○'}</div>
      <div class="pbe-pro-plan-label">NFL PRO · ${key==='season'?'SEASON PASS':'WEEKLY'}</div>
      <div class="pbe-pro-price"><strong>${p.price}</strong><span>${p.detail}</span></div>
      <div class="pbe-pro-renew">${p.term}</div>
      <div class="pbe-funnel-select-copy">${selected===key?'Selected':'Choose plan'}</div>
    </button>`;
  }

  function message(text,type='') {
    const el=document.getElementById('pbe-funnel-message');
    if(!el)return;
    el.className=`pbe-pro-message ${type}`.trim();
    el.textContent=text||'';
  }

  function paintSelection() {
    const selected=selectedKey();
    document.querySelectorAll('[data-funnel-plan]').forEach(card=>{
      const on=card.dataset.funnelPlan===selected;
      card.classList.toggle('selected',on);
      card.setAttribute('aria-pressed',on?'true':'false');
      const check=card.querySelector('.pbe-funnel-check'); if(check)check.textContent=on?'✓':'○';
      const copy=card.querySelector('.pbe-funnel-select-copy'); if(copy)copy.textContent=on?'Selected':'Choose plan';
    });
    const btn=document.getElementById('pbe-funnel-continue');
    const p=PLANS[selected]||PLANS.season;
    if(btn)btn.textContent=`Verify email & continue · ${p.price}${selected==='weekly'?' / week':''}`;
  }

  async function requestEmail() {
    const email=String(document.getElementById('pbe-funnel-email')?.value||'').trim().toLowerCase();
    if(!/^\S+@\S+\.\S+$/.test(email))return message('Enter the email you want tied to NFL Pro.','error');
    const btn=document.getElementById('pbe-funnel-continue');
    if(btn)btn.disabled=true;
    const p=PLANS[selectedKey()]||PLANS.season;
    message(`Sending a secure link to continue ${p.label} checkout…`);
    try{
      const r=await fetch('/api/auth-email',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({email})});
      const body=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(body?.error||'Could not send the verification email.');
      message(`Check ${email}. Click the secure link and we’ll continue your ${p.label} checkout.`, 'success');
    }catch(error){message(error?.message||'Could not send the verification email.','error')}
    finally{if(btn)btn.disabled=false}
  }

  function mountSignedOut() {
    const s=state();
    if(s.loading||s.user)return;
    const host=document.getElementById('pbe-pro-checkout');
    if(!host)return;
    if(!host.querySelector('.pbe-funnel-head'))host.innerHTML=signedOutMarkup();
    host.querySelectorAll('[data-funnel-plan]').forEach(card=>{card.onclick=()=>setSelected(card.dataset.funnelPlan)});
    const btn=document.getElementById('pbe-funnel-continue'); if(btn)btn.onclick=requestEmail;
    const input=document.getElementById('pbe-funnel-email'); if(input)input.onkeydown=e=>{if(e.key==='Enter')requestEmail()};
    paintSelection();
  }

  async function continuePendingCheckout() {
    const s=state();
    if(!s.user||s.pro||checkoutStarted)return;
    const key=selectedKey();
    const plan=PLANS[key];
    if(!plan)return;
    const params=new URLSearchParams(location.search);
    if(params.get('auth')!=='complete' && !sessionStorage.getItem('pbe_nfl_auth_just_completed'))return;
    checkoutStarted=true;
    sessionStorage.removeItem('pbe_nfl_auth_just_completed');
    setTimeout(async()=>{
      try{await window.PBEPro?.checkout?.(plan.priceId);clearSelected()}
      finally{checkoutStarted=false}
    },350);
  }

  function routeAuthMarker() {
    try{if(new URLSearchParams(location.search).get('auth')==='complete')sessionStorage.setItem('pbe_nfl_auth_just_completed','1')}catch(_){}
  }

  function apply(){queued=false;mountSignedOut();continuePendingCheckout()}
  function queue(){if(queued)return;queued=true;requestAnimationFrame(apply)}
  function install(){
    routeAuthMarker();
    window.addEventListener('pbe:pro-state',queue);
    document.addEventListener('click',e=>{if(e.target?.closest?.('.pbe-pro-account,[data-pbe-open-pro],[data-pro]'))setTimeout(queue,20)});
    const modal=document.getElementById('pbe-pro-backdrop')||document.body;
    const observer=new MutationObserver(queue);observer.observe(modal,{childList:true,subtree:true});
    queue();
    window.PBECheckoutFunnel={apply,setSelected,plans:PLANS};
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();