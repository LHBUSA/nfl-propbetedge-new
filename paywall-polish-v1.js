/* PropBetEdge NFL Pro — production conversion + member polish */
(() => {
  'use strict';
  const BILLING_PORTAL='https://billing.stripe.com/p/login/cNi3cv2vY7em3lr4oj7wA00';
  let timers=[];

  function setText(el,text){if(el&&el.textContent!==text)el.textContent=text}
  function setHtml(el,html){if(el&&el.innerHTML!==html)el.innerHTML=html}

  function installStyles(){
    if(document.getElementById('pbe-pro-member-worldclass'))return;
    const style=document.createElement('style');
    style.id='pbe-pro-member-worldclass';
    style.textContent=`
      .pbeprosell-member{display:grid!important;grid-template-columns:minmax(0,1.22fr) minmax(320px,.78fr)!important;align-items:stretch!important;gap:0!important;padding:0!important;border-color:rgba(85,214,140,.38)!important;background:radial-gradient(circle at 90% 0,rgba(85,214,140,.17),transparent 30%),radial-gradient(circle at 8% 118%,rgba(212,175,55,.12),transparent 34%),linear-gradient(145deg,#121a16 0%,#11130f 48%,#0b0d0b 100%)!important;box-shadow:0 28px 70px rgba(0,0,0,.38),0 0 0 1px rgba(85,214,140,.035),inset 0 1px 0 rgba(255,255,255,.04)!important}
      .pbeprosell-member:before{background:linear-gradient(90deg,transparent,#55d68c 28%,var(--pbe-gold) 70%,transparent)!important}
      .pbeprosell-member-main{padding:31px 32px 30px!important;border-right:1px solid rgba(255,255,255,.07)!important}
      .pbeprosell-member-kicker{display:flex;align-items:center;gap:9px;flex-wrap:wrap;color:var(--pbe-paper-2);font:800 9px/1 var(--pbe-font-data);letter-spacing:.12em}
      .pbeprosell-member-status{display:inline-flex;align-items:center;padding:6px 9px;border:1px solid rgba(85,214,140,.38);border-radius:999px;background:rgba(85,214,140,.08);color:#6ee6a5!important;box-shadow:0 0 20px rgba(85,214,140,.06)}
      .pbeprosell-member h2{max-width:720px!important;margin:14px 0 10px!important;color:#fff!important;font:900 clamp(35px,4.5vw,58px)/.93 var(--pbe-font-display)!important;letter-spacing:-.04em!important}
      .pbeprosell-member h2 em{color:#70e8a8!important;font-style:normal!important}
      .pbeprosell-member-main>p{max-width:760px!important;margin:0!important;color:var(--pbe-paper-2)!important;font:500 13px/1.67 var(--pbe-font-ui)!important}
      .pbeprosell-member-actions{display:flex!important;align-items:center!important;gap:8px!important;flex-wrap:wrap!important;margin-top:21px!important}
      .pbeprosell-manage{display:inline-flex!important;align-items:center!important;justify-content:center!important;min-height:43px!important;padding:0 14px!important;border:1px solid rgba(212,175,55,.48)!important;border-radius:8px!important;background:rgba(212,175,55,.055)!important;color:var(--pbe-gold-bright)!important;font:800 11px/1 var(--pbe-font-ui)!important;text-decoration:none!important;transition:transform .15s ease,background .15s ease,border-color .15s ease!important}
      .pbeprosell-manage:hover{transform:translateY(-1px);background:rgba(212,175,55,.10)!important;border-color:var(--pbe-gold)!important}
      .pbeprosell-member-side{padding:25px 24px 23px!important;background:linear-gradient(180deg,rgba(85,214,140,.045),rgba(0,0,0,.10))!important;display:flex!important;flex-direction:column!important;justify-content:center!important}
      .pbeprosell-member-badge{display:grid;justify-items:start;gap:3px;padding-bottom:15px;border-bottom:1px solid rgba(255,255,255,.07)}
      .pbeprosell-member-badge span{color:#6ee6a5;font:800 9px/1 var(--pbe-font-data);letter-spacing:.14em}.pbeprosell-member-badge strong{color:#fff;font:900 29px/.95 var(--pbe-font-display);letter-spacing:-.035em}.pbeprosell-member-badge small{color:var(--pbe-dim);font:700 9px/1.3 var(--pbe-font-data)}
      .pbeprosell-member-grid{display:grid!important;grid-template-columns:1fr 1fr!important;gap:8px!important;margin-top:15px!important}.pbeprosell-member-grid>div{min-width:0;padding:10px;border:1px solid rgba(255,255,255,.06);border-radius:8px;background:rgba(255,255,255,.018)}.pbeprosell-member-grid b{display:block;color:#fff;font-size:10px}.pbeprosell-member-grid span{display:block;margin-top:3px;color:var(--pbe-dim);font-size:8px;line-height:1.35}
      .pbeprosell-member-track{appearance:none;width:100%;min-height:39px;margin-top:13px;border:1px solid rgba(85,214,140,.22);border-radius:8px;background:rgba(85,214,140,.045);color:#8cebb5;font:800 9px/1 var(--pbe-font-ui);cursor:pointer}
      .pbe-funnel-member .pbe-funnel-head>span{color:#6ee6a5!important}.pbe-funnel-member .pbe-funnel-head>strong{max-width:440px!important;font-size:clamp(31px,3.1vw,43px)!important;line-height:.95!important;letter-spacing:-.035em!important}.pbe-funnel-member .pbe-funnel-head>p{font-size:12px!important;line-height:1.6!important}
      .pbe-member-status-card{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:13px;margin-top:18px;padding:14px;border:1px solid rgba(85,214,140,.22);border-radius:13px;background:radial-gradient(circle at 100% 0,rgba(85,214,140,.12),transparent 48%),rgba(85,214,140,.035);box-shadow:inset 0 1px 0 rgba(255,255,255,.025)}
      .pbe-member-seal{display:grid;place-items:center;align-content:center;width:58px;height:58px;border:1px solid rgba(85,214,140,.42);border-radius:50%;background:rgba(85,214,140,.08);box-shadow:0 0 28px rgba(85,214,140,.08)}.pbe-member-seal span{color:#6ee6a5;font:800 8px/1 'JetBrains Mono',monospace;letter-spacing:.12em}.pbe-member-seal b{margin-top:3px;color:#fff;font:900 11px/1 'Inter',sans-serif}
      .pbe-member-account{display:grid;gap:4px;min-width:0}.pbe-member-account small{color:#6ee6a5;font:800 8px/1 'JetBrains Mono',monospace;letter-spacing:.11em}.pbe-member-account strong{overflow:hidden;color:#fff;font:800 13px/1.2 'Inter',sans-serif;text-overflow:ellipsis;white-space:nowrap}.pbe-member-account span{color:var(--pbe-paper-2);font-size:10px;line-height:1.35}
      .pbe-member-access-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.pbe-member-access-grid>div{padding:11px;border:1px solid rgba(255,255,255,.06);border-radius:9px;background:rgba(255,255,255,.018)}.pbe-member-access-grid b{display:block;color:#fff;font-size:11px}.pbe-member-access-grid span{display:block;margin-top:3px;color:var(--pbe-paper-2);font-size:9px;line-height:1.35}
      .pbe-member-manage{display:flex!important;align-items:center!important;justify-content:center!important;text-decoration:none!important;min-height:45px!important;margin-top:8px!important;border-color:rgba(216,183,91,.36)!important;color:var(--pbe-gold-bright)!important}
      .pbe-funnel-member .pbe-pro-secure{color:rgba(110,230,165,.78)!important}
      @media(max-width:1080px){.pbeprosell-member{grid-template-columns:1fr!important}.pbeprosell-member-main{border-right:0!important;border-bottom:1px solid rgba(255,255,255,.07)!important}}
      @media(max-width:620px){.pbeprosell-member-main,.pbeprosell-member-side{padding:20px 17px!important}.pbeprosell-member h2{font-size:clamp(34px,10vw,46px)!important}.pbeprosell-member-actions>*{width:100%!important;text-align:center!important}.pbe-member-access-grid,.pbeprosell-member-grid{grid-template-columns:1fr 1fr!important}}
      @media(prefers-reduced-motion:reduce){.pbeprosell-manage{transition:none!important}.pbeprosell-manage:hover{transform:none!important}}
    `;
    document.head.appendChild(style);
  }

  function applyPitch(){
    const pitch=document.querySelector('.pbe-pro-pitch');
    if(!pitch)return;

    setText(pitch.querySelector('.pbe-pro-kicker'),'PROPBETEDGE NFL PRO · PBE ALGO · AUTOMATED LEARNING PICKER');
    setHtml(pitch.querySelector('h2'),'PBE Algo makes the pick.<br><em>Then the grade becomes evidence.</em>');

    const intro=pitch.querySelector(':scope > p');
    setText(intro,'PBE Algo is built as an automated NFL picking system, not a static tip sheet. It evaluates eligible games, publishes only qualified production-champion calls, freezes the decision and market state before the result, then grades the outcome into an auditable record.');

    const features=[...pitch.querySelectorAll('.pbe-pro-feature')];
    if(features[0]){setText(features[0].querySelector('strong'),'Automated Learning Architecture');setText(features[0].querySelector('span'),'Finalized grades can become learning observations for challenger models. Integrity gates can stop training entirely, and a challenger cannot replace the live champion unless it clears the promotion rules.')}
    if(features[1]){setText(features[1].querySelector('strong'),'Official PBE Picks');setText(features[1].querySelector('span'),'The production champion evaluates eligible games and publishes only qualified calls. No edge means no forced pick.')}
    if(features[2]){setText(features[2].querySelector('strong'),'Locked Decision Receipt');setText(features[2].querySelector('span'),'Model probability, issued line and odds, market context, model version and provenance stay attached to the call made before the outcome.')}
    if(features[3]){setText(features[3].querySelector('strong'),'Verified Track Record + Pro Desk');setText(features[3].querySelector('span'),'Wins and losses stay on the record. NFL Pro also unlocks the supported model, market, Best Line, simulation and research surfaces around the pick.')}

    let today=pitch.querySelector('.pbe-pro-today');
    if(!today){today=document.createElement('div');today.className='pbe-pro-today';pitch.querySelector('.pbe-pro-feature-list')?.before(today)}
    setHtml(today,'<b>WHY THIS IS DIFFERENT</b><span>The picker and the learning system are separated by design: official calls come only from the promoted champion; finalized outcomes feed the governed challenger pipeline; promotion requires evidence instead of silently changing the live model.</span>');

    setText(document.getElementById('pbe-pro-signin'),'Continue with email');
    setText(document.getElementById('pbe-pro-upgrade'),`Unlock PBE Algo${window.PBEPricing?` · ${window.PBEPricing.ctaSuffix}`:''}`);
  }

  /* The shared membership contract (window.PBEPro.state.membership, read from
     /api/auth-session through pbe-membership.js). The polish layer never decides
     who is a member; it only words the member screen for the state the server
     named: sport_pro · all_access · owner. */
  function membership(){
    const s=window.PBEPro?.state||{};
    const m=s.membership;
    if(m&&m.entitled&&(m.state==='sport_pro'||m.state==='all_access'||m.state==='owner'))return m;
    const owner=s.role==='owner';
    return {state:owner?'owner':'sport_pro',label:owner?'OWNER':'NFL PRO ACTIVE',entitled:true,show_manage:!owner,sport:'nfl'};
  }
  function activePeriod(m){
    return window.PBEMembership?.planText?.(m)||(m.state==='owner'?'Owner access':'Verified NFL PropBetEdge Pro access.');
  }
  const MEMBER_COPY={
    sport_pro:{kicker:'NFL PROPBETEDGE PRO · VERIFIED MEMBER',title:'You have NFL PropBetEdge Pro.',seal:['PRO','ACTIVE'],
      lede:'A national-scale NFL sports analytics platform is fully unlocked on this verified account: PBE Algo, official PBE Picks, model + market intelligence, Player DNA, team research, simulation, Game Center and the permanent Track Record.'},
    all_access:{kicker:'PROPBETEDGE ALL ACCESS · VERIFIED MEMBER',title:'You have PropBetEdge All Access.',seal:['ALL','ACCESS'],
      lede:'Every current and future PropBetEdge Pro sport is unlocked on this verified account, NFL included: PBE Algo, official PBE Picks, model + market intelligence, Player DNA, team research, simulation, Game Center and the permanent Track Record.'},
    owner:{kicker:'NFL PROPBETEDGE PRO · OWNER',title:'Owner access is active.',seal:['PBE','OWNER'],
      lede:'Every NFL Pro surface is unlocked on this verified owner account: PBE Algo, official PBE Picks, model + market intelligence, Player DNA, team research, simulation, Game Center and the permanent Track Record.'},
  };

  function applyActiveMember(root,head){
    const state=root.dataset.funnelState||'';
    if(state!=='active-pro'&&state!=='active-owner')return false;

    const m=membership();
    const copy=MEMBER_COPY[m.state]||MEMBER_COPY.sport_pro;
    const email=root.querySelector('.pbe-funnel-user strong')?.textContent?.trim()||'NFL Pro member';
    const period=activePeriod(m);
    root.classList.add('pbe-funnel-member');
    root.dataset.membership=m.state;

    setText(head.querySelector('span'),copy.kicker);
    setText(head.querySelector('strong'),copy.title);
    setText(head.querySelector('p'),copy.lede);

    let status=root.querySelector('.pbe-member-status-card');
    if(!status){
      status=document.createElement('div');
      status.className='pbe-member-status-card';
      head.insertAdjacentElement('afterend',status);
    }
    const badge=window.PBEMembership?.membershipBadgeHtml?.(m)||'';
    const next=`<div class="pbe-member-seal"><span>${copy.seal[0]}</span><b>${copy.seal[1]}</b></div><div class="pbe-member-account"><small>VERIFIED ACCOUNT</small><strong></strong><span></span>${badge}</div>`;
    if(status.dataset.membership!==m.state){status.innerHTML=next;status.dataset.membership=m.state}
    setText(status.querySelector('strong'),email);
    setText(status.querySelector('.pbe-member-account span'),period);

    let grid=root.querySelector('.pbe-member-access-grid');
    if(!grid){
      grid=document.createElement('div');
      grid.className='pbe-member-access-grid';
      status.insertAdjacentElement('afterend',grid);
    }
    grid.innerHTML='<div><b>PBE Algo</b><span>Automated learning picker</span></div><div><b>PBE Picks</b><span>Official qualified calls</span></div><div><b>Track Record</b><span>Permanent graded history</span></div><div><b>Model + Market Desk</b><span>Probability, lines + research</span></div>';

    const user=root.querySelector('.pbe-funnel-user');
    if(user)user.style.display='none';
    const card=root.querySelector('.pbe-funnel-active-card');
    if(card)card.style.display='none';
    const caps=root.querySelector('.pbe-funnel-capabilities');
    if(caps)settledHide(caps);

    /* Manage subscription only for members with a subscription (sport_pro,
       all_access); the owner has none. The funnel may already have rendered
       the shared manage link, in which case nothing is added. */
    const auth=root.querySelector('.pbe-funnel-auth');
    if(auth){
      const existing=auth.querySelector('.pbe-member-manage');
      if(!m.show_manage){existing?.remove()}
      else if(!existing&&!auth.querySelector('.pbe-mbr-manage')){
        const a=document.createElement('a');
        a.className='pbe-pro-cta secondary pbe-member-manage';
        a.href=BILLING_PORTAL;
        a.target='_blank';
        a.rel='noopener noreferrer';
        a.textContent='Manage subscription ↗';
        const refresh=auth.querySelector('#pbe-funnel-refresh');
        if(refresh)refresh.before(a);else auth.appendChild(a);
      }
    }
    setText(root.querySelector('#pbe-funnel-open-board'),'Open Pro Prop Board');
    setText(root.querySelector('.pbe-pro-secure'),`◆ ${m.label} · verified access`);
    return true;
  }

  function settledHide(el){if(el)el.style.display='none'}

  function applyFunnel(){
    const root=document.querySelector('.pbe-funnel-root');
    const head=root?.querySelector('.pbe-funnel-head');
    if(!root||!head)return;
    if(applyActiveMember(root,head))return;
    const state=root.dataset.funnelState||'';
    if(state==='signed-out'||state==='signed-in-free'){
      setText(head.querySelector('span'),'NFL PRO · PBE ALGO · AUTOMATED LEARNING PICKER');
      setText(head.querySelector('strong'),state==='signed-out'?'Unlock the picker built to learn from its grades.':'Your account is ready. Unlock PBE Algo.');
      setText(head.querySelector('p'),'Official qualified PBE Picks, locked decision receipts, an auditable Track Record, and a governed champion/challenger learning architecture under one NFL Pro account.');
    }
  }

  function apply(){installStyles();applyPitch();applyFunnel()}

  function schedule(){
    timers.forEach(clearTimeout);
    timers=[0,40,100,240,700,1600].map(delay=>setTimeout(apply,delay));
  }

  function install(){
    installStyles();
    schedule();
    window.addEventListener('pbe:route-changed',schedule);
    window.addEventListener('pbe:upgrades-ready',schedule);
    window.addEventListener('pbe:pro-state',schedule);
  }

  window.PBEProPolish={apply,schedule,membership,MEMBER_COPY};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();