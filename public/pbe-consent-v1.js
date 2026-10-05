(function(){
  'use strict';
  if(window.PBEConsent)return;

  var COOKIE='pbe_privacy_v1';
  var DOMAIN='.propbetedge.ai';
  var MAX_AGE=15552000;
  var host=String(location.hostname||'').toLowerCase();
  var production=host==='propbetedge.ai'||host.endsWith('.propbetedge.ai');

  function read(){
    var parts=String(document.cookie||'').split(';');
    for(var i=0;i<parts.length;i++){
      var p=parts[i].trim();
      if(p.indexOf(COOKIE+'=')===0)return decodeURIComponent(p.slice(COOKIE.length+1));
    }
    return '';
  }
  function state(){
    var v=read();
    return v==='v1.granted'?'granted':v==='v1.denied'?'denied':'unset';
  }
  function gtag(){
    window.dataLayer=window.dataLayer||[];
    window.dataLayer.push(arguments);
  }
  function apply(value){
    gtag('consent','default',{
      analytics_storage:value==='granted'?'granted':'denied',
      ad_storage:'denied',
      ad_user_data:'denied',
      ad_personalization:'denied',
      functionality_storage:'granted',
      security_storage:'granted'
    });
  }

  apply(state());

  function write(value){
    if(!production)return;
    document.cookie=COOKIE+'=v1.'+value+'; Max-Age='+MAX_AGE+'; Path=/; Domain='+DOMAIN+'; Secure; SameSite=Lax';
  }
  function clearGa(){
    String(document.cookie||'').split(';').forEach(function(part){
      var name=part.split('=')[0].trim();
      if(name==='_ga'||name==='_gid'||name==='_gat'||name.indexOf('_ga_')===0){
        document.cookie=name+'=; Max-Age=0; Path=/; SameSite=Lax';
        document.cookie=name+'=; Max-Age=0; Path=/; Domain='+DOMAIN+'; Secure; SameSite=Lax';
      }
    });
  }
  function set(value){
    write(value);
    gtag('consent','update',{
      analytics_storage:value==='granted'?'granted':'denied',
      ad_storage:'denied',
      ad_user_data:'denied',
      ad_personalization:'denied'
    });
    if(value==='denied')clearGa();
    closeBanner();
    renderChoice();
    window.dispatchEvent(new CustomEvent('pbe:consentchange',{detail:{analytics:value}}));
  }

  function css(){
    if(document.getElementById('pbe-consent-style'))return;
    var s=document.createElement('style');
    s.id='pbe-consent-style';
    s.textContent=
      '#pbe-consent{position:fixed;z-index:2147483000;left:12px;right:12px;bottom:12px;margin:auto;max-width:720px;padding:16px;border:1px solid #50482f;border-radius:14px;background:#11130f;color:#f5f2e8;box-shadow:0 24px 70px rgba(0,0,0,.55);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}'+
      '#pbe-consent *{box-sizing:border-box}#pbe-consent h2{margin:0 0 7px;font-size:17px;line-height:1.2;color:#fff}'+
      '#pbe-consent p{margin:0;color:#c8cdc7;font-size:13px;line-height:1.5}#pbe-consent a{color:#e1c65d}'+
      '.pbe-consent-actions{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:14px}'+
      '.pbe-consent-btn{min-height:42px;padding:10px 14px;border:1px solid #6e6547;border-radius:9px;background:#191c17;color:#f5f2e8;font:700 13px/1 Arial,sans-serif;cursor:pointer}'+
      '.pbe-consent-btn.primary{background:#d4af37;color:#0b0d0b;border-color:#e4c963}'+
      '#pbe-privacy-choice{position:fixed;z-index:2147482999;left:10px;bottom:10px;border:1px solid rgba(212,175,55,.45);border-radius:999px;background:rgba(17,19,15,.94);color:#e8dfc4;padding:8px 11px;font:700 11px/1 Arial,sans-serif;cursor:pointer;box-shadow:0 8px 26px rgba(0,0,0,.32)}'+
      '@media(max-width:560px){.pbe-consent-actions{display:grid;grid-template-columns:1fr 1fr}.pbe-consent-btn{width:100%;min-height:46px}}';
    document.head.appendChild(s);
  }
  function closeBanner(){
    var el=document.getElementById('pbe-consent');
    if(el)el.remove();
  }
  function openBanner(){
    closeBanner();
    var choice=document.getElementById('pbe-privacy-choice');
    if(choice)choice.remove();
    css();
    var el=document.createElement('aside');
    el.id='pbe-consent';
    el.setAttribute('role','dialog');
    el.setAttribute('aria-label','Privacy choices');
    el.innerHTML='<h2>Your privacy choices</h2>'+
      '<p>Necessary cookies keep sign-in, security and paid access working. With your permission, we also use analytics to understand how PropBetEdge is used. You can decline analytics without losing site access. <a href="https://propbetedge.ai/privacy">Privacy Policy</a></p>'+
      '<div class="pbe-consent-actions"><button type="button" class="pbe-consent-btn" data-pbe-deny>Decline analytics</button><button type="button" class="pbe-consent-btn primary" data-pbe-allow>Accept analytics</button></div>';
    el.querySelector('[data-pbe-deny]').onclick=function(){set('denied');};
    el.querySelector('[data-pbe-allow]').onclick=function(){set('granted');};
    document.body.appendChild(el);
  }
  function renderChoice(){
    if(!production||document.getElementById('pbe-privacy-choice'))return;
    css();
    var b=document.createElement('button');
    b.id='pbe-privacy-choice';
    b.type='button';
    b.textContent='Privacy choices';
    b.onclick=openBanner;
    document.body.appendChild(b);
  }
  function ready(){
    if(!production)return;
    if(state()==='unset')openBanner();
    else renderChoice();
  }

  window.PBEConsent={version:1,state:state,set:set,open:openBanner};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});
  else ready();
})();