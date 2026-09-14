/* Recovery browser smoke.
 * Loads https://nfl.propbetedge.ai in real Chrome while substituting every
 * same-origin static HTML/JS/CSS request with the checked-out branch.
 * API requests go to live production unchanged, as an anonymous reader.
 *
 * Access V2: there is no site-wide wall. The shell must boot for an anonymous
 * reader (scripts/nfl-access-contract.mjs), public routes must render, and Pro
 * data must stay behind its own boundary: the Track Record's validation detail
 * is locked, the official record is public, and the Pro action opens the real
 * upgrade surface. No session or entitlement is ever minted here.
 *
 * The gate deliberately fails the first Usage module request. Production must
 * retry it, recover the Usage workspace, keep one desktop nav authority, and
 * remain responsive through a full route soak.
 */
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync,appendFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,extname} from 'node:path';
import {SHELL_PROBE,judgeShell} from './nfl-access-contract.mjs';

const REPO=process.cwd();
const TARGET='https://nfl.propbetedge.ai';
const ORIGIN=new URL(TARGET).origin;
const PORT=9700+Math.floor(Math.random()*90);
const LOG='recovery-smoke.log';
const CHROME=process.env.PBE_CHROME||'/usr/bin/google-chrome';
const served=new Set();
const exceptions=[];
let usageFaultInjected=false;
const out=s=>{console.log(s);try{appendFileSync(LOG,s+'\n')}catch{}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dir=mkdtempSync(join(tmpdir(),'pbe-recovery-'));
const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-timer-throttling','--window-size=1440,900','about:blank'],{stdio:'ignore'});
function finish(code){try{chrome.kill()}catch{}setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}process.exit(code)},250)}
const hard=setTimeout(()=>{out('HARD_DEADLINE');finish(3)},240000);hard.unref?.();
async function wsUrl(){for(let i=0;i<80;i++){try{const list=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const p=list.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl}catch{}await sleep(200)}throw new Error('devtools_unavailable')}
const ws=new WebSocket(await wsUrl());await new Promise(r=>{ws.onopen=r});
let id=1;const pending=new Map();
const send=(method,params={})=>{const n=id++;ws.send(JSON.stringify({id:n,method,params}));return new Promise((resolve,reject)=>pending.set(n,{resolve,reject}))};
const mime=p=>({'.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.json':'application/json; charset=utf-8'}[extname(p)]||'application/octet-stream');
function localFile(url){let u;try{u=new URL(url)}catch{return null}if(u.origin!==ORIGIN||u.pathname.startsWith('/api/'))return null;let rel=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname.slice(1));if(!rel||rel.includes('..'))return null;const ext=extname(rel);if(!['.js','.mjs','.css','.html','.webmanifest','.json'].includes(ext))return null;const fp=join(REPO,rel);try{if(!existsSync(fp)||!statSync(fp).isFile())return null;return{rel,body:readFileSync(fp),type:mime(rel)}}catch{return null}}
ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return}if(m.method==='Fetch.requestPaused'){const local=localFile(m.params.request.url);if(local){if(local.rel==='usage-v2.js'&&!usageFaultInjected){usageFaultInjected=true;out('FAULT injected first usage-v2.js request');send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:503,responseHeaders:[{name:'content-type',value:'text/plain'},{name:'cache-control',value:'no-store'}],body:Buffer.from('intentional browser regression fault').toString('base64')}).catch(()=>{});return}served.add(local.rel);send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'content-type',value:local.type},{name:'cache-control',value:'no-store'}],body:local.body.toString('base64')}).catch(()=>{})}else send('Fetch.continueRequest',{requestId:m.params.requestId}).catch(()=>{});return}if(m.method==='Runtime.exceptionThrown')exceptions.push(String(m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text||'').slice(0,240))};
await send('Runtime.enable');await send('Page.enable');await send('Fetch.enable',{patterns:[{urlPattern:`${ORIGIN}/*`,requestStage:'Request'}]});
const probe=async(expr,ms=7000)=>{try{const r=await Promise.race([send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true}),sleep(ms).then(()=>{throw new Error('WEDGED')})]);return r.result?.value}catch(e){return`<${e.message}>`}};
async function shot(name){const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const file=`recovery-${name}.png`;writeFileSync(file,Buffer.from(r.data,'base64'));out(`screenshot             : ${file}`)}
async function mediaStats(){return probe(`(()=>{const all=[...document.images],loaded=all.filter(i=>i.complete&&i.naturalWidth>0),broken=all.filter(i=>i.complete&&!i.naturalWidth),team=loaded.filter(i=>/teamlogos\\/nfl/i.test(i.src)),players=loaded.filter(i=>/headshots\\/nfl/i.test(i.src));return{all:all.length,loaded:loaded.length,broken:broken.length,team:team.length,players:players.length}})()`)}
/* quickDisplay accepts 'missing' as well as 'none': the legacy .pbe-v2-quicknav
   duplicated the shell's own destinations and had been display:none since
   global-polish-v2, so the visual-finish pass removed it from the markup rather
   than shipping hidden DOM. The invariant being asserted is that a second
   navigation is never VISIBLE, which 'missing' satisfies. */
async function navStats(){return probe(`(()=>{const primary=[...document.querySelectorAll('#pbe-sports-shell .pbes-primary [data-route]')],research=[...document.querySelectorAll('#pbe-sports-shell .pbes-research [data-route]')],all=[...document.querySelectorAll('#pbe-sports-shell [data-route]')],quick=document.querySelector('.pbe-v2-quicknav');return{primary:primary.map(x=>x.dataset.route),research:research.map(x=>x.dataset.route),active:all.filter(x=>x.classList.contains('active')).map(x=>x.dataset.route),quickDisplay:quick?getComputedStyle(quick).display:'missing',primaryWidth:Math.round(document.querySelector('#pbe-sports-shell .pbes-primary')?.getBoundingClientRect().width||0)}})()`)}
async function activeNav(route){return probe(`(()=>{const all=[...document.querySelectorAll('#pbe-sports-shell [data-route].active')];const target=document.querySelector('#pbe-sports-shell [data-route=${JSON.stringify(route)}]:not(.pbes-brand)');return{target:!!target,active:!!target?.classList.contains('active'),activeCount:all.length,activeRoutes:all.map(x=>x.dataset.route)}})()`)}

/* The desktop shell groups its destinations by what the user came to do rather
   than presenting two undifferentiated rows. Row one is TODAY + INTELLIGENCE,
   row two is TOOLS + ARCHIVE. Membership changed with that regrouping; the
   assertion below is unchanged in strength -- every destination must be present,
   in its expected row, with exactly one active. Dashboard is now an explicit
   destination rather than being reachable only by clicking the brand mark.

   The four Player DNA routes are primary destinations too. This list predated
   them and expected 12, so the gate failed exactly when the DNA suite was
   present -- it passed through the Sep 7 rollback because production had lost
   those routes. The assertion is unchanged in strength: every expected primary
   route must still exist, exactly once, with exactly one active. */
/* 2026-09-11: Changes (What Changed) and Best Line joined TODAY as steps of
   the game-day loop. Same assertion strength: each must exist exactly once. */
const primaryRoutes=['home','games','changes','propboard','bestline','pbecast','marketwatch','picks','pbepicks','trackrecord','matchups','usage','injuries','newsintel','qbdna','wrdna','rbdna','tedna'];
/* standings2025 / stats2025 have been in the ARCHIVE row since the 2026 season
   authority shipped; this list predated them, so the gate failed on main too
   (measured 2026-09-11). Same assertion: each exactly once, in its row. */
const researchRoutes=['simulator','sgplab','propchain','teams','standings','stats','seasonhistory','standings2025','stats2025','records','hof','sb','prospects','trades'];
const routes=[...primaryRoutes,...researchRoutes,'home'];
const captureRoutes=new Set(['games','propboard','marketwatch','picks','pbepicks','trackrecord','usage','propchain','pbecast','newsintel','matchups','injuries','home']);

out(`TARGET ${TARGET}`);out('MODE recovery static files + live production APIs + injected Usage fault');
await send('Page.navigate',{url:`${TARGET}/?recovery=${Date.now()}`});await sleep(12000);
let pass=true;
if(await probe('1+1')!==2){out('RESULT MAIN THREAD WEDGED');ws.close();finish(1)}
/* Access V2 shell contract: an anonymous reader gets the whole public app. */
{let shell=null;for(let i=0;i<20;i++){shell=await probe(SHELL_PROBE);if(!judgeShell(shell))break;await sleep(500)}out(`access shell           : ${JSON.stringify(shell)}`);const issue=judgeShell(shell,{expect:'anonymous'});if(issue){out(`RESULT FAIL ${issue}`);ws.close();finish(1)}}

out('\n=== LOAD FAILURE RECOVERY ===');
out(`usage fault injected   : ${usageFaultInjected}`);if(!usageFaultInjected)pass=false;
await probe(`window.App&&App.nav('usage')`,8000);await sleep(2200);
let usage=await probe(`(()=>({route:window.App?.current,registered:typeof window.App?.VIEWS?.usage==='function',pending:!!document.querySelector('[data-pbe-pending-route]'),workspace:!!document.querySelector('.pbe21-usage'),chars:(document.querySelector('#view-container')?.textContent||'').trim().length}))()`);
out(`usage after retry      : ${JSON.stringify(usage)}`);
if(!usage||typeof usage!=='object'||usage.route!=='usage'||usage.registered!==true||usage.pending!==false||usage.workspace!==true||Number(usage.chars)<120)pass=false;
await shot('usage-recovered');

out('\n=== LATE REGISTRATION CONTRACT ===');
const lateStart=await probe(`(()=>{const saved=App.VIEWS.usage;delete App.VIEWS.usage;App.nav('usage',{history:false});window.__pbeSavedUsage=saved;return{pending:!!document.querySelector('[data-pbe-pending-route="usage"]'),route:App.current}})()`);
out(`late registration start: ${JSON.stringify(lateStart)}`);if(!lateStart||lateStart.pending!==true||lateStart.route!=='usage')pass=false;
await probe(`App.VIEWS.usage=window.__pbeSavedUsage;delete window.__pbeSavedUsage;true`);await sleep(900);
usage=await probe(`(()=>({route:App.current,pending:!!document.querySelector('[data-pbe-pending-route]'),workspace:!!document.querySelector('.pbe21-usage')}))()`);
out(`late registration end  : ${JSON.stringify(usage)}`);if(!usage||usage.route!=='usage'||usage.pending!==false||usage.workspace!==true)pass=false;

await probe(`window.App&&App.nav('home')`);await sleep(1800);
out('\n=== HOME LIVENESS ===');
const text=await probe(`(document.querySelector('#view-container')?.textContent||'').trim()`);const spinner=typeof text==='string'&&text.length>200&&!/Loading NFL Intelligence OS/.test(text);out(`spinner cleared        : ${spinner}`);out(`view chars             : ${typeof text==='string'?text.length:text}`);if(!spinner)pass=false;
const features=[['.pbehome7','Dashboard v7'],['#pbe8-core-market','Dashboard v8 market'],['.pbe8-news-filters','Dashboard v8 filters'],['.pbes-scorebar,.pbes-shell','Sports shell'],['#pbe-network-footer','Network footer']];
for(const [sel,label] of features){const v=await probe(`!!document.querySelector(${JSON.stringify(sel)})`);out(`${label.padEnd(24)}: ${v}`);if(v!==true)pass=false}
let media=await mediaStats();out(`home media             : ${JSON.stringify(media)}`);if(!media||typeof media!=='object'||media.loaded<4||media.team<2||media.broken>0)pass=false;
const center=await probe(`(()=>{const hero=document.querySelector('.pbe7-hero'),score=document.querySelector('.pbe7-scorebox');if(!hero||!score)return null;const h=hero.getBoundingClientRect(),s=score.getBoundingClientRect(),heroCenter=h.left+h.width/2,scoreCenter=s.left+s.width/2;return{heroCenter:+heroCenter.toFixed(2),scoreCenter:+scoreCenter.toFixed(2),delta:+Math.abs(heroCenter-scoreCenter).toFixed(2),scoreLeft:+s.left.toFixed(2),scoreWidth:+s.width.toFixed(2)}})()`);
out(`featured center axis   : ${JSON.stringify(center)}`);if(!center||typeof center!=='object'||Number(center.delta)>2)pass=false;

out('\n=== SINGLE NAVIGATION CONTRACT ===');
const nav=await navStats();out(`sports nav             : ${JSON.stringify(nav)}`);
if(!nav||typeof nav!=='object'||!['none','missing'].includes(nav.quickDisplay)||nav.primary.length!==primaryRoutes.length||nav.research.length!==researchRoutes.length||primaryRoutes.some(r=>!nav.primary.includes(r))||researchRoutes.some(r=>!nav.research.includes(r))||nav.active.length!==1||nav.active[0]!=='home'||Number(nav.primaryWidth)<900)pass=false;
const cssOrder=await probe(`(()=>{const files=[...document.querySelectorAll('link[data-pbe-upgrade]')].map(x=>(new URL(x.href)).pathname.split('/').pop()),at=f=>files.indexOf(f),world=at('world-class-v1.css');const foundations=['dashboard-v7.css','dashboard-v8-enhance.css','games-v2.css','model-lab-v2-enhance.css','simulator-v3-enhance.css','usage-v2.css'];const terminal=['pbecast-v6.css','pbecast-v7-enhance.css','games-command-v4.css','games-intel-v5.css','prop-board-v5.css','pbe-picks-v2.css'];return{world,foundations:Object.fromEntries(foundations.map(f=>[f,at(f)])),terminal:Object.fromEntries(terminal.map(f=>[f,at(f)])),ok:world>=0&&foundations.every(f=>at(f)>=0&&at(f)<world)&&terminal.every(f=>at(f)>world)}})()`);
out(`visual CSS authority   : ${JSON.stringify(cssOrder)}`);if(!cssOrder||typeof cssOrder!=='object'||cssOrder.ok!==true)pass=false;
await shot('home-desktop');

out('\n=== ROUTES + ACTIVE NAV ===');
for(const route of routes){
  await probe(`window.App&&App.nav(${JSON.stringify(route)})`,8000);await sleep(1500);
  const alive=await probe('1+1')===2,cur=await probe('window.App?.current??null'),chars=await probe(`(document.querySelector('#view-container')?.textContent||'').trim().length`),active=await activeNav(route);media=await mediaStats();
  out(`${route.padEnd(13)} alive=${alive?'YES':'NO '} route=${String(cur).padEnd(13)} chars=${chars} active=${JSON.stringify(active)} media=${JSON.stringify(media)}`);
  if(!alive||cur!==route||!(Number(chars)>80)||!active||active.active!==true||active.activeCount!==1||Number(media?.broken||0)>0){pass=false;break}
  if(route==='usage'&&await probe(`!!document.querySelector('.pbe21-usage')`)!==true){pass=false;break}
  if(route==='injuries'){
    const injuryLayout=await probe(`(()=>{const root=document.querySelector('.pbe13-news'),affected=[...document.querySelectorAll('.pbe13-aff-name>.pbe-player-headshot-v3')],tagPhotos=[...document.querySelectorAll('.pbe13-tags .pbe-player-headshot-v3')],feed=document.querySelector('.pbe13-coverage-list,.pbe13-feed'),cards=[...document.querySelectorAll('.pbe13-feed>.pbe13-card,.pbe13-coverage-list>.pbe13-coverage-row')];const maxAffected=affected.reduce((m,img)=>Math.max(m,img.getBoundingClientRect().width,img.getBoundingClientRect().height),0);const visibleTagPhotos=tagPhotos.filter(img=>{const s=getComputedStyle(img),r=img.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0}).length;const fcs=feed?getComputedStyle(feed):null;const columns=fcs?(fcs.display.indexOf('grid')>=0?fcs.gridTemplateColumns:'single'):'';return{root:!!root,affected:affected.length,maxAffected:+maxAffected.toFixed(2),tagPhotos:tagPhotos.length,visibleTagPhotos,columns,cards:cards.length}})()`);
    out(`injury layout          : ${JSON.stringify(injuryLayout)}`);
    /* The injury coverage feed must never become a multi-column card grid. The
     visual-finish pass replaced .pbe13-feed's single-column grid with a plain
     .pbe13-coverage-list of rows, which reports display:block rather than a
     track list -- 'single' stands for that, and the invariant is unchanged. */
  const injuryColumns=String(injuryLayout?.columns||'').trim().split(/\s+/).filter(Boolean).length;
    if(!injuryLayout||typeof injuryLayout!=='object'||injuryLayout.root!==true||Number(injuryLayout.maxAffected)>34.5||Number(injuryLayout.visibleTagPhotos)!==0||injuryColumns!==1)pass=false;
  }
  if(captureRoutes.has(route))await shot(`${route}-desktop`);
}

out('\n=== PUBLIC ACCESS SURFACES (anonymous, 1440) ===');
const waitFor=async(expr,ms)=>{const end=Date.now()+ms;while(Date.now()<end){if(await probe(`Boolean(${expr})`)===true)return true;await sleep(250)}return false};
const overflow=()=>probe(`document.documentElement.scrollWidth-innerWidth`);
async function trackSurfaces(label){
  await probe(`window.PBEPro?.close?.();App.nav('trackrecord');true`);
  const ready=await waitFor(`App.current==='trackrecord'&&document.querySelector('.pbetr-head')&&!document.querySelector('.pbe2-loading')`,20000);
  await probe(`document.querySelector('.pbetr-tabs [data-pbetr-tab="validation"]')?.click();true`);await sleep(700);
  const locked=await probe(`(()=>{const vc=document.querySelector('#view-container'),t=vc.innerText;return{ready:${ready},mode:document.querySelector('.pbetr-mode')?.innerText||null,gate:[...document.querySelectorAll('.pbetr-meter-top')].map(m=>m.innerText.replace(/\\s+/g,' ')),locked:!!document.querySelector('.pbetr-locked [data-pbe2-upgrade]'),ledgerRows:document.querySelectorAll('[data-pbetr-expand]').length,ledger:!!document.querySelector('.pbetr-ledger-table'),requestedHistory:performance.getEntriesByType('resource').some(e=>/view=validation-history/.test(e.name)),officialLabel:/OFFICIAL PICK|OFFICIAL PBE PICK/.test(t),overflow:document.documentElement.scrollWidth-innerWidth}})()`);
  out(`track validation ${label.padEnd(7)}: ${JSON.stringify(locked)}`);
  if(!ready||!locked||typeof locked!=='object'||!locked.locked||locked.ledgerRows!==0||locked.ledger||locked.requestedHistory||locked.officialLabel||locked.gate.length!==2||!/\/ 100/.test(locked.gate[0])||!/\/ 4 weeks/.test(locked.gate[1])||Number(locked.overflow)>0)pass=false;
  await shot(`trackrecord-validation-locked-${label}`);
  await probe(`document.querySelector('.pbetr-tabs [data-pbetr-tab="official"]').click();true`);await sleep(900);
  const official=await probe(`(()=>{const vc=document.querySelector('#view-container'),t=vc.innerText.replace(/\\s+/g,' ');return{active:document.querySelector('.pbetr-tabs button.active')?.dataset.pbetrTab,zero:!!document.querySelector('.pbetr-official-zero'),record:!!document.querySelector('.pbe2-track-hero'),zeroCopy:/OFFICIAL PUBLICATION HAS NOT STARTED/i.test(t)&&/0-0/.test(t),ledgerRows:document.querySelectorAll('[data-pbetr-expand]').length,officialLabelOnValidation:/VALIDATION SIGNAL/i.test(t),overflow:document.documentElement.scrollWidth-innerWidth}})()`);
  out(`track official ${label.padEnd(9)}: ${JSON.stringify(official)}`);
  if(!official||typeof official!=='object'||official.active!=='official'||!(official.zero?official.zeroCopy:official.record)||official.ledgerRows!==0||official.officialLabelOnValidation||Number(official.overflow)>0)pass=false;
  await shot(`trackrecord-official-${label}`);
  /* the Pro action at the validation boundary opens the real upgrade surface */
  await probe(`document.querySelector('.pbetr-tabs [data-pbetr-tab="validation"]').click();true`);await sleep(600);
  await probe(`document.querySelector('.pbetr-locked [data-pbe2-upgrade]')?.click();true`);
  const opened=await waitFor(`document.getElementById('pbe-pro-backdrop')?.classList.contains('open')`,6000);await sleep(900);
  const upgrade=await probe(`(()=>{const h=document.getElementById('pbe-pro-checkout'),t=(h?.innerText||'').replace(/\\s+/g,' ');return{state:h?.querySelector('.pbe-funnel-root')?.dataset.funnelState||null,monthly:/\\$9\\.99 \\/ month/i.test(t),weekly:/\\$3\\.99 \\/ week/i.test(t),stale:/\\$\\s*9\\.99\\s*(\\/|per)\\s*(wk|week)|\\$99\\b|\\bseason pass\\b/i.test(t),overflow:document.documentElement.scrollWidth-innerWidth}})()`);
  out(`upgrade boundary ${label.padEnd(7)}: ${JSON.stringify({opened,...(upgrade&&typeof upgrade==='object'?upgrade:{value:upgrade})})}`);
  if(!opened||!upgrade||upgrade.state!=='signed-out'||!upgrade.monthly||!upgrade.weekly||upgrade.stale||Number(upgrade.overflow)>0)pass=false;
  await shot(`upgrade-boundary-${label}`);
  await probe(`window.PBEPro?.close?.();true`);await sleep(500);
  const after=await probe(`({modal:!!document.getElementById('pbe-pro-backdrop')?.classList.contains('open'),route:App.current})`);
  out(`after upgrade close ${label.padEnd(4)}: ${JSON.stringify(after)}`);if(!after||after.modal!==false||after.route!=='trackrecord')pass=false;
}
await trackSurfaces('desktop');
await probe(`App.nav('pbepicks');true`);await waitFor(`App.current==='pbepicks'&&!document.querySelector('.pbe2-loading')&&(document.querySelector('#view-container')?.textContent||'').length>200`,15000);await sleep(1200);
{const picks=await probe(`(()=>{const t=document.querySelector('#view-container').innerText;return{chars:t.length,unlock:[...document.querySelectorAll('#view-container button,#view-container a')].filter(b=>b.offsetParent&&/unlock/i.test(b.textContent)).length,overflow:document.documentElement.scrollWidth-innerWidth}})()`);out(`pbe picks public       : ${JSON.stringify(picks)}`);if(!picks||typeof picks!=='object'||picks.chars<200||picks.unlock<1||Number(picks.overflow)>0)pass=false}

out('\n=== SOAK ===');for(let i=0;i<36;i++){await probe(`window.App&&App.nav(${JSON.stringify(routes[i%routes.length])})`,6000);await sleep(260)}const soak=await probe('1+1',10000)===2;out(`36-nav responsive      : ${soak}`);if(!soak)pass=false;
await probe(`window.App&&App.nav('home')`);await sleep(1500);await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(600);const mobile=await probe(`(()=>({header:getComputedStyle(document.getElementById('mobile-header')).display,bottom:getComputedStyle(document.getElementById('mobile-bottom-nav')).display,route:window.App?.current}))()`);out(`mobile navigation       : ${JSON.stringify(mobile)}`);if(!mobile||typeof mobile!=='object'||mobile.route!=='home')pass=false;await shot('home-mobile');
out('\n=== PUBLIC ACCESS SURFACES (anonymous, 390) ===');
{const dash=await probe(`(()=>{const p=document.querySelector('.pbecc-picks');return{panel:!!p,text:(p?.innerText||'').replace(/\\s+/g,' ').slice(0,260),overflow:document.documentElement.scrollWidth-innerWidth}})()`);out(`dashboard panel mobile : ${JSON.stringify(dash)}`);if(!dash||typeof dash!=='object'||Number(dash.overflow)>0||(dash.panel&&!/validation sample \S+ \/ 100/i.test(dash.text)))pass=false}
await probe(`App.nav('pbepicks');true`);await sleep(2500);
{const o=await overflow();out(`pbe picks mobile       : overflow=${o}`);if(Number(o)>0)pass=false;await shot('pbepicks-mobile')}
await trackSurfaces('mobile');
{const again=await probe(SHELL_PROBE);const issue=judgeShell(again,{expect:'anonymous'});out(`access shell mobile    : ${issue||'ok'}`);if(issue)pass=false}
out(`served recovery files : ${served.size}`);out(`exceptions             : ${exceptions.length}${exceptions.length?' | '+exceptions.slice(0,4).join(' | '):''}`);if(exceptions.length)pass=false;out(`RESULT ${pass?'PASS':'FAIL'}`);ws.close();finish(pass?0:1);
