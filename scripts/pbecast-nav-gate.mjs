/* PBEcast navigation-lifecycle + regression gate.
 *
 * One page session, driven through the navigation cases the PBEcast refresh
 * work has to survive, then a sweep of every route on the regression bar.
 * Emits a per-route signature (root element, text volume, route markers) so
 * the same run on two trees can be diffed rather than eyeballed.
 *
 * node scripts/pbecast-nav-gate.mjs [--width=1440]
 */
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,extname} from 'node:path';

const REPO=process.cwd();
const TARGET=process.env.PBE_GATE_TARGET||'https://nfl.propbetedge.ai';
const ORIGIN=new URL(TARGET).origin;
const WIDTH=Number((process.argv.find(a=>a.startsWith('--width='))||'--width=1440').split('=')[1]);
const OUT=process.env.PBE_GATE_OUT||join(REPO,'.gate','pbecast');
const LABEL=process.env.PBE_GATE_LABEL||'nav';
const LIVE=process.env.PBE_GATE_LIVE==='1';
const DELAY=Number(process.env.PBE_GATE_DELAY||0);
const CHROME=process.env.PBE_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT=9760+Math.floor(Math.random()*90);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dir=mkdtempSync(join(tmpdir(),'pbe-nav-'));
mkdirSync(OUT,{recursive:true});
const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'--headless=new','--no-first-run','--disable-extensions','--hide-scrollbars','about:blank'],{stdio:'ignore'});
function finish(c){try{chrome.kill()}catch{}setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}process.exit(c)},250)}
setTimeout(()=>{console.error('DEADLINE');finish(3)},420000).unref?.();

async function wsUrl(){for(let i=0;i<120;i++){try{const l=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl}catch{}await sleep(200)}throw new Error('devtools_unreachable')}
const ws=new WebSocket(await wsUrl());
await new Promise(r=>{ws.onopen=r});
let id=1;const pending=new Map();
const send=(m,p={})=>{const n=id++;ws.send(JSON.stringify({id:n,method:m,params:p}));return new Promise((res,rej)=>pending.set(n,{resolve:res,reject:rej}))};

const MIME={'.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2'};
function localFile(url){
  if(LIVE)return null;
  let u;try{u=new URL(url)}catch{return null}
  if(u.origin!==ORIGIN||u.pathname.startsWith('/api/'))return null;
  const rel=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname.slice(1));
  if(!rel||rel.includes('..')||!MIME[extname(rel)])return null;
  const fp=join(REPO,rel);
  try{if(!existsSync(fp)||!statSync(fp).isFile())return null;return{body:readFileSync(fp),type:MIME[extname(rel)]}}catch{return null}
}
let exceptions=[];
ws.onmessage=ev=>{
  const m=JSON.parse(ev.data);
  if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return}
  if(m.method==='Fetch.requestPaused'){
    const l=localFile(m.params.request.url);
    if(l){const f=()=>send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'content-type',value:l.type},{name:'cache-control',value:'no-store'}],body:l.body.toString('base64')}).catch(()=>{});DELAY?setTimeout(f,DELAY):f()}
    else send('Fetch.continueRequest',{requestId:m.params.requestId}).catch(()=>{});
    return;
  }
  if(m.method==='Runtime.exceptionThrown')exceptions.push(String(m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text||'').slice(0,200));
};

const PROBE=[
  '(()=>{',
  '  const T=window.__pbeNav={live:[],start:Date.now()};',
  '  const of=window.fetch;',
  '  window.fetch=function(input){',
  '    try{const u=String(typeof input==="string"?input:(input&&input.url)||"");',
  '      if(u.indexOf("/api/nfl-live")>-1){const st=(new Error().stack||"").replace(/https?:\\/\\/[^/]+\\//g,"");',
  '        T.live.push({t:Date.now()-T.start,owner:/pbecast-v6\\.js/.test(st)?"v6":/pbecast-v5[.-]/.test(st)?"v5":/pbecast-v4\\.js/.test(st)?"v4":/pbe-breaking/.test(st)?"breaking-rail":/sports-shell/.test(st)?"sports-shell":"other"})}',
  '    }catch(e){}',
  '    return of.apply(this,arguments);',
  '  };',
  '})();'
].join('\n');

await send('Runtime.enable');
await send('Page.enable');
await send('Fetch.enable',{patterns:[{urlPattern:`${ORIGIN}/*`,requestStage:'Request'}]});
await send('Page.addScriptToEvaluateOnNewDocument',{source:PROBE});
/* A protected Vercel preview hands out its auth by cookie, so visit the
   share URL once before the run and the rest of the session is authorised. */
const BOOTSTRAP=process.env.PBE_GATE_BOOTSTRAP||'';
if(BOOTSTRAP){
  await send('Page.navigate',{url:BOOTSTRAP});await sleep(4000);
  /* Park on a blank page afterwards. The share URL redirects to '/', so
     navigating straight from there to '/#pbecast' is only a hash change —
     a same-document navigation that never reloads, which would make the
     first pass record an in-app route change instead of a cold load. */
  await send('Page.navigate',{url:'about:blank'});await sleep(500);
}
await send('Emulation.setDeviceMetricsOverride',{width:WIDTH,height:WIDTH<600?844:900,deviceScaleFactor:1,mobile:WIDTH<600});

const evalIn=async(expr,ms=25000)=>{
  try{const r=await Promise.race([send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true}),sleep(ms).then(()=>{throw new Error('WEDGED')})]);return r.result?.value}
  catch(e){return{__error:e.message}}
};

const SIG=[
  '(()=>{',
  '  const vc=document.getElementById("view-container");',
  '  const el=vc&&vc.firstElementChild;',
  '  const txt=(vc&&vc.textContent||"").trim();',
  '  return {',
  '    route:(window.App&&App.current)||null, hash:location.hash,',
  '    root:el?(el.tagName.toLowerCase()+"."+String(el.className||"").split(/\\s+/).filter(Boolean).slice(0,2).join(".")):null,',
  '    loading:!!(vc&&vc.querySelector(".view-loading")),',
  '    chars:txt.length,',
  '    cast4:document.querySelectorAll(".pbecast4").length,',
  '    cast5layer:document.querySelectorAll(".cast5-live-layer").length,',
  '    cast6:document.querySelectorAll(".pbecast6").length,',
  '    cast7:document.querySelectorAll("#pbecast7-trading").length,',
  '    mobileNav:!!document.querySelector("#mobile-bottom-nav .mbn-item"),',
  '    shell:!!document.querySelector(".pbe-sports-shell,[class*=\'sports-shell\'],#pbe-v2-network"),',
  '    paywall:typeof window.PBEPro==="object"',
  '  };',
  '})()'
].join('\n');

const results=[];
const step=async(name,action,waitMs=2600)=>{
  exceptions=[];
  if(action)await evalIn(action);
  await sleep(waitMs);
  const sig=await evalIn(SIG);
  const row={step:name,sig,exceptions:[...exceptions]};
  results.push(row);
  const flags=[];
  if(sig.loading)flags.push('STUCK-LOADING');
  if(sig.chars<200)flags.push('EMPTY('+sig.chars+')');
  if(row.exceptions.length)flags.push('EX='+row.exceptions.length);
  console.log(`${name.padEnd(34)} route=${String(sig.route).padEnd(12)} root=${String(sig.root).slice(0,34).padEnd(34)} chars=${String(sig.chars).padStart(6)} c4=${sig.cast4} c5=${sig.cast5layer} c6=${sig.cast6} c7=${sig.cast7}${flags.length?'  << '+flags.join(','):''}`);
  return sig;
};

/* ---- 1. cold boot on the dashboard, then enter PBEcast from it ---- */
await send('Page.navigate',{url:`${TARGET}/`});
await sleep(9000);
await step('cold boot: dashboard');
await step('dashboard -> pbecast',"App.nav('pbecast')",5200);

/* ---- 2. PBEcast -> another route -> PBEcast ---- */
await step('pbecast -> games',"App.nav('games')",4200);
const idle=await evalIn('JSON.stringify((window.__pbeNav.live||[]).filter(x=>x.owner==="v6").length)');
await sleep(12000);
const idle2=await evalIn('JSON.stringify((window.__pbeNav.live||[]).filter(x=>x.owner==="v6").length)');
console.log(`v6 /api/nfl-live while OFF the route for 12s: ${Number(idle2)-Number(idle)} (expected 0)`);
await step('games -> pbecast (return)',"App.nav('pbecast')",5200);

/* ---- 3. hash navigation and history ---- */
await step('hash -> #propboard',"location.hash='propboard'",4200);
await step('hash -> #pbecast',"location.hash='pbecast'",5200);
await send('Page.navigate',{url:`${TARGET}/#propboard`});
await sleep(6000);
await send('Page.navigate',{url:`${TARGET}/#pbecast`});
await sleep(6000);
await step('history.back()','history.back()',5200);
await step('history.forward()','history.forward()',5200);

/* ---- 4. in-place refresh while PBEcast is active ---- */
await send('Page.reload',{ignoreCache:true});
await sleep(9000);
await step('hard refresh while on pbecast');

/* ---- 5. a scheduled (non-live) game must not be dressed as LIVE ---- */
const sched=await evalIn('(()=>{const g=(PBEcastV6.state.scoreboard&&PBEcastV6.state.scoreboard.games||[]).find(x=>x.status&&x.status.semantics!=="LIVE");return g?String(g.id):null})()');
if(sched&&typeof sched==='string'){
  await step('focus scheduled game',`PBEcastV6.focus(${JSON.stringify(sched)})`,5200);
  const s=await evalIn('(()=>{const d=PBEcastV6.state.detail||{};const root=document.querySelector(".pbecast6");return{semantics:(d.source&&d.source.semantics)||null,livePill:!!(root&&/LIVE\\s*.\\s*PBECAST/i.test(root.textContent||"")),plays:((d.plays||[]).length)}})()');
  console.log(`scheduled game -> semantics=${s.semantics} livePillShown=${s.livePill} publishedPlays=${s.plays}`);
  results.push({step:'scheduled-game-semantics',detail:s});
}else console.log('scheduled game: none on the slate to test');

/* ---- 6. regression bar ---- */
console.log('\n--- regression bar ---');
for(const route of ['home','games','propboard','picks','qbdna','wrdna','rbdna','tedna','marketwatch','matchups','pbepicks','trackrecord','newsintel','injuries','usage','propchain','teams','standings','stats']){
  await step(`route ${route}`,`App.nav('${route}')`,3000);
}
await step('back to pbecast last',"App.nav('pbecast')",5200);

writeFileSync(join(OUT,`${LABEL}-${WIDTH}px.json`),JSON.stringify({target:TARGET,width:WIDTH,results},null,2));
const bad=results.filter(r=>r.sig&&(r.sig.loading||r.sig.chars<200||(r.exceptions||[]).length));
const castBad=results.filter(r=>r.sig&&r.sig.route==='pbecast'&&(r.sig.cast6!==1||r.sig.cast4||r.sig.cast5layer));
console.log(`\n[${LABEL} @${WIDTH}px] steps=${results.length} problem-steps=${bad.length} pbecast-shape-violations=${castBad.length}`);
if(bad.length)bad.forEach(b=>console.log('  PROBLEM',b.step,JSON.stringify(b.sig),b.exceptions));
console.log(`report: ${join(OUT,`${LABEL}-${WIDTH}px.json`)}`);
finish(bad.length||castBad.length?1:0);
