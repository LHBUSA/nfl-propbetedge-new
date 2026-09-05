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
    const setOpen=open=>{
      control.classList.toggle('open',open);
      toggle?.setAttribute('aria-expanded',open?'true':'false');
      menu?.setAttribute('aria-hidden',open?'false':'true');
    };
    toggle?.addEventListener('click',()=>setOpen(!control.classList.contains('open')));
    control?.querySelectorAll('[data-stadium-choice]').forEach(btn=>{
      btn.addEventListener('click',()=>{apply(btn.dataset.stadiumChoice);setOpen(false)});
    });
    document.addEventListener('click',e=>{if(control&&!control.contains(e.target))setOpen(false)});
    document.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&control?.classList.contains('open')){setOpen(false);toggle?.focus()}
    });
    apply(saved());
    window.PBEStadiums={apply,set:apply,current:saved,stadiums:STADIUMS,dock:()=>dock(document.querySelector('.pbe-stadium-control'))};
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});
  else install();
})();
