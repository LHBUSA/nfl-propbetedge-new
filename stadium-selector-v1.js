/* PropBetEdge NFL — selectable real NFL stadium atmosphere.
 *
 * Venue photography is self-hosted under /stadiums. Every image is Creative
 * Commons and every licence in the set requires attribution, so the credit for
 * the active venue renders inside the control. Desktop and mobile variants are
 * driven separately because the mobile background is a narrower crop.
 *
 * Public API: window.PBEStadiums.apply(key) — also aliased as .set(key).
 */
(() => {
  'use strict';
  const STORAGE='pbe_nfl_stadium_v1';
  const DEFAULT='sofi';
  const STADIUMS={
    sofi:{
      name:'SoFi Stadium', team:'Los Angeles · Rams & Chargers',
      file:'sofi', pos:'center', posSm:'center', credit:'PontiacAurora', licence:'CC BY-SA 4.0',
      source:'https://commons.wikimedia.org/wiki/File:SofistadiumSept2022.jpg'
    },
    lucas:{
      name:'Lucas Oil Stadium', team:'Indianapolis Colts',
      file:'lucas', pos:'center', posSm:'center', credit:'Josh Hallett', licence:'CC BY-SA 2.0',
      source:'https://commons.wikimedia.org/wiki/File:LucasOilStadiumTheLuke.jpg'
    },
    lambeau:{
      name:'Lambeau Field', team:'Green Bay Packers',
      file:'lambeau', pos:'center', posSm:'center', credit:'Mtyson84', licence:'CC0',
      source:'https://commons.wikimedia.org/wiki/File:Lambeau_Field_in_December_2016_during_a_game_versus_the_Seattle_Seahawks.jpg'
    },
    allegiant:{
      name:'Allegiant Stadium', team:'Las Vegas Raiders',
      file:'allegiant', pos:'center', posSm:'center', credit:'Ken Lund', licence:'CC BY-SA 2.0',
      source:'https://commons.wikimedia.org/wiki/File:Vegas_Kickoff_Classic,_Brigham_Young_University_(BYU)_Cougars_24,_University_of_Arizona_Wildcats_16,_Allegiant_Stadium,_Las_Vegas,_Nevada_(52675078445).jpg'
    },
    mercedes:{
      name:'Mercedes-Benz Stadium', team:'Atlanta Falcons',
      file:'mercedes', pos:'center', posSm:'center', credit:'elisfkc', licence:'CC BY-SA 2.0',
      source:'https://commons.wikimedia.org/wiki/File:Peach_Bowl_Pre-game_(38723446434).jpg'
    }
  };
  /* Responsive, display-aware assets. The originals were 1920x1080 and
     1200x1600 JPEGs of 217-450 KB, and the picker was using the full portrait
     file as a menu swatch -- so a page load pulled the active background plus
     four more full-size images, about 1,965 KB. These are encoded for how the
     layer is actually shown: opacity .18 behind a blur, where fine detail is
     destroyed before a viewer sees it. */
  const full=s=>`url("/stadiums/${s.file}-bg.webp")`;
  const small=s=>`url("/stadiums/${s.file}-bgsm.webp")`;
  const thumb=s=>`/stadiums/${s.file}-thumb.webp`;

  function saved(){
    try{const key=localStorage.getItem(STORAGE);return STADIUMS[key]?key:DEFAULT}catch(_){return DEFAULT}
  }

  function apply(key){
    if(!STADIUMS[key])key=DEFAULT;
    const stadium=STADIUMS[key];
    const root=document.documentElement.style;
    root.setProperty('--pbe-stadium-image',full(stadium));
    root.setProperty('--pbe-stadium-image-sm',small(stadium));
    root.setProperty('--pbe-stadium-pos',stadium.pos);
    root.setProperty('--pbe-stadium-pos-sm',stadium.posSm);
    root.setProperty('--pbe-stadium-filter',stadium.filter||'none');
    try{localStorage.setItem(STORAGE,key)}catch(_){}
    document.querySelectorAll('[data-stadium-choice]').forEach(btn=>{
      const on=btn.dataset.stadiumChoice===key;
      btn.classList.toggle('active',on);
      btn.setAttribute('aria-checked',on?'true':'false');
      const tick=btn.querySelector('em');
      if(tick)tick.textContent=on?'✓':'';
    });
    const label=document.querySelector('.pbe-stadium-current');
    if(label)label.textContent=stadium.name;
    const credit=document.querySelector('.pbe-stadium-credit');
    if(credit)credit.innerHTML=creditHtml(stadium);
    return key;
  }

  const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  function creditHtml(s){
    return `${esc(s.name)} photograph © <a href="${esc(s.source)}" target="_blank" rel="noopener noreferrer">${esc(s.credit)}</a> · ${esc(s.licence)}`;
  }

  function markup(){
    const current=saved();
    const options=Object.entries(STADIUMS).map(([key,s])=>`
      <button type="button" role="radio" aria-checked="${key===current?'true':'false'}"
        class="pbe-stadium-option ${key===current?'active':''}" data-stadium-choice="${key}"
        style="--thumb:url('${thumb(s)}')">
        <i></i><span><b>${esc(s.name)}</b><small>${esc(s.team)}</small></span><em>${key===current?'✓':''}</em>
      </button>`).join('');
    return `<div class="pbe-stadium-control">
      <button class="pbe-stadium-toggle" type="button" aria-expanded="false" aria-haspopup="true" aria-label="Choose stadium background">
        🏟 <span>Stadium</span><b class="pbe-stadium-current">${esc(STADIUMS[current].name)}</b>
      </button>
      <div class="pbe-stadium-menu" role="radiogroup" aria-label="Stadium background" aria-hidden="true">
        <div class="pbe-stadium-menu-head">
          <span>BACKGROUND</span><strong>Choose your stadium</strong>
          <small>Real NFL venues · preference saved on this device</small>
        </div>
        <div class="pbe-stadium-grid">${options}</div>
        <p class="pbe-stadium-credit">${creditHtml(STADIUMS[current])}</p>
      </div>
    </div>`;
  }

  /* DOCKING
     This control used to be position:fixed at right:18px/bottom:18px with
     z-index 4950, so on every route it floated over whatever happened to be in
     the lower-right of the page -- the featured game's action buttons on the
     Dashboard, the majors column and wire rows on News Intelligence, the
     availability board on Injury Intelligence, and the model output on Model
     Lab. Nudging it or raising its z-index does not help: a fixed element over
     a scrolling document overlaps something at some scroll position by
     definition.

     It is an environment control for the whole product, exactly like the search
     and account buttons, so it now lives where those live: the shell's top-bar
     right cluster. There it occupies reserved layout space at every width and
     can never cover content. The floating position is kept only as a fallback
     for the case where the shell has not mounted. */
  function dockTarget(){
    return document.querySelector('#pbe-sports-shell .pbes-right');
  }
  function dock(control){
    const host=dockTarget();
    if(!host||!control||control.dataset.pbeDocked==='1')return false;
    const search=host.querySelector('#pbes-search');
    if(search)search.insertAdjacentElement('beforebegin',control);
    else host.insertAdjacentElement('afterbegin',control);
    control.dataset.pbeDocked='1';
    return true;
  }

  function install(){
    const existing=document.querySelector('.pbe-stadium-control');
    if(existing){dock(existing);return}
    document.body.insertAdjacentHTML('beforeend',markup());
    const control=document.querySelector('.pbe-stadium-control');
    dock(control);
    /* The shell mounts from its own loader step, which may land after this
       module. A short bounded retry re-homes the control without an observer. */
    [120,400,900,1800,3200].forEach(delay=>setTimeout(()=>dock(document.querySelector('.pbe-stadium-control')),delay));
    window.addEventListener('pbe:upgrades-ready',()=>dock(document.querySelector('.pbe-stadium-control')));
    const toggle=control?.querySelector('.pbe-stadium-toggle');
    const menu=control?.querySelector('.pbe-stadium-menu');

    /* THE MENU IS PORTALLED WHILE OPEN.
       Measured on the docked control: .pbes-top carries overflow:hidden from a
       later polish sheet, so a menu positioned absolutely inside the control
       was clipped to nothing at every width -- nine of nine hit-test points
       over the "open" menu answered with the scoreboard or the hero. Below
       620px it was position:fixed, but the shell's backdrop-filter makes the
       shell the containing block for fixed descendants, so the menu resolved
       against the shell and rendered at y = -482.

       Neither is fixable from inside the shell: a stacking context or a
       clipping ancestor cannot be escaped by a descendant however it is
       styled. This is the same lesson as the Player DNA switcher, and the same
       answer: while open the menu is a child of BODY, positioned with fixed
       coordinates computed from the toggle, flipped or clamped to stay inside
       the viewport, and scrollable internally when the room is short. It is
       returned to the control on close so the markup and the radiogroup stay
       exactly where the rest of this module expects them.

       It does not use the Player DNA modal root: that root is rewritten with
       innerHTML whenever a modal opens and would destroy a menu parked in it.
       z-index 4950 is the control's documented place in the product ladder --
       above the shell (2500), the drawer (2700), every research panel and the
       command palette (4900); below the switcher (4980) and the paywall
       (5000), both of which are modal and close this menu on the way in. */
    const home=document.createComment('pbe-stadium-menu-home');
    const EDGE=8, GAP=8;
    function bottomReserve(){
      /* the phone tab bar is fixed chrome; the menu must not open under it */
      const bar=document.querySelector('.mobile-bottom-nav');
      if(!bar)return 0;
      const cs=getComputedStyle(bar);if(cs.display==='none'||cs.visibility==='hidden')return 0;
      const r=bar.getBoundingClientRect();return r.height>0?Math.max(0,innerHeight-r.top):0;
    }
    function place(){
      if(!menu||menu.dataset.pbePortal!=='1'||!toggle)return;
      const vw=innerWidth,vh=innerHeight,r=toggle.getBoundingClientRect();
      const width=Math.min(440,vw-EDGE*2);
      let left=Math.round(r.right-width);
      if(left<EDGE)left=EDGE;
      if(left+width>vw-EDGE)left=Math.max(EDGE,vw-EDGE-width);
      const reserve=bottomReserve();
      const below=vh-reserve-EDGE-(r.bottom+GAP);
      const above=r.top-GAP-EDGE;
      const want=menu.scrollHeight||420;
      let top,room;
      if(below>=Math.min(want,320)||below>=above){top=Math.round(r.bottom+GAP);room=below}
      else{room=above;top=Math.round(Math.max(EDGE,r.top-GAP-Math.min(want,above)))}
      menu.style.left=left+'px';
      menu.style.top=top+'px';
      menu.style.width=width+'px';
      menu.style.maxHeight=Math.max(160,Math.floor(room))+'px';
    }
    let raf=0;
    const onMove=()=>{if(raf)return;raf=requestAnimationFrame(()=>{raf=0;place()})};
    function portalOut(){
      if(!menu||menu.dataset.pbePortal==='1')return;
      menu.parentNode.insertBefore(home,menu);
      document.body.appendChild(menu);
      menu.dataset.pbePortal='1';
      place();
      addEventListener('resize',onMove);
      addEventListener('scroll',onMove,{passive:true});
      window.visualViewport?.addEventListener('resize',onMove);
    }
    function portalBack(){
      if(!menu||menu.dataset.pbePortal!=='1')return;
      removeEventListener('resize',onMove);
      removeEventListener('scroll',onMove);
      window.visualViewport?.removeEventListener('resize',onMove);
      menu.removeAttribute('style');
      delete menu.dataset.pbePortal;
      if(home.parentNode)home.parentNode.replaceChild(menu,home);else control.appendChild(menu);
    }
    const isOpen=()=>control.classList.contains('open');
    const setOpen=open=>{
      control.classList.toggle('open',open);
      toggle?.setAttribute('aria-expanded',open?'true':'false');
      menu?.setAttribute('aria-hidden',open?'false':'true');
      if(open){portalOut();menu?.classList.add('is-open');
        /* keyboard users land on the current choice, not on nothing */
        setTimeout(()=>{try{(menu.querySelector('[aria-checked="true"]')||menu.querySelector('[data-stadium-choice]'))?.focus({preventScroll:true})}catch(_){}},0);}
      else{menu?.classList.remove('is-open');portalBack()}
    };
    toggle?.addEventListener('click',()=>setOpen(!isOpen()));
    control?.querySelectorAll('[data-stadium-choice]').forEach(btn=>{
      btn.addEventListener('click',()=>{apply(btn.dataset.stadiumChoice);setOpen(false);toggle?.focus()});
    });
    document.addEventListener('click',e=>{
      if(!control||!isOpen())return;
      if(control.contains(e.target)||(menu&&menu.contains(e.target)))return;
      setOpen(false);
    });
    document.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&isOpen()){setOpen(false);toggle?.focus()}
    });
    /* a modal surface (the Player DNA switcher, the weather drawer, the
       paywall) takes the page; a popover has no business staying open under it */
    new MutationObserver(()=>{if(isOpen()&&document.body.classList.contains('pdna-modal-open'))setOpen(false)})
      .observe(document.body,{attributes:true,attributeFilter:['class']});
    apply(saved());
    window.PBEStadiums={apply,set:apply,current:saved,stadiums:STADIUMS,open:()=>setOpen(true),close:()=>setOpen(false),isOpen,place,dock:()=>dock(document.querySelector('.pbe-stadium-control'))};
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});
  else install();
})();
