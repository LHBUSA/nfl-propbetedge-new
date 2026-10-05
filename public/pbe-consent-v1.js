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

  function css(){}

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