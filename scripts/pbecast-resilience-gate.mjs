/* PBEcast resilience gate: what the terminal does when the network misbehaves.
 *
 * Two failures that a live command center must survive without ever showing a
 * loading screen, and which no amount of happy-path polling will reveal:
 *
 *   1. TRANSIENT 503     every /api/nfl-live call fails for a while. The last
 *                        good game state must stay painted and be marked
 *                        STALE — not replaced by an error or a skeleton — and
 *                        must recover on its own when the API returns.
 *   2. OUT-OF-ORDER      one fast-state response is held back while newer ones
 *                        land, then released. The stale one describes an
 *                        earlier moment and must be rejected, not painted.
 *
 * node scripts/pbecast-resilience-gate.mjs [--width=1440]
 */
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const TARGET=process.env.PBE_GATE_TARGET||'https://nfl.propbetedge.ai';
const ORIGIN=new URL(TARGET).origin;
const BOOTSTRAP=process.env.PBE_GATE_BOOTSTRAP||'';
const WIDTH=Number((process.argv.find(a=>a.startsWith('--width='))||'--width=1440').split('=')[1]);
const OUT=process.env.PBE_GATE_OUT||join(process.cwd(),'.gate','pbecast');
const LABEL=process.env.PBE_GATE_LABEL||'resilience';
const CHROME=process.env.PBE_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT=9560+Math.floor(Math.random()*90);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dir=mkdtempSync(join(tmpdir(),'pbe-res-'));
mkdirSync(OUT,{recursive:true});
const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'--headless=new','--no-first-run','--disable-extensions','--hide-scrollbars','about:blank'],{stdio:'ignore'});
function finish(c){try{chrome.kill()}catch{}setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}process.exit(c)},250)}
setTimeout(()=>{console.error('DEADLINE');finish(3)},300000).unref?.();

async function wsUrl(){for(let i=0;i<120;i++){try{const l=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl}catch{}await sleep(200)}throw new Error('devtools_unreachable')}
const ws=new WebSocket(await wsUrl());
await new Promise(r=>{ws.onopen=r});
let id=1;const pending=new Map();
const send=(m,p={})=>{const n=id++;ws.send(JSON.stringify({id:n,method:m,params:p}));return new Promise((res,rej)=>pending.set(n,{resolve:res,reject:rej}))};

/* Fault injection state, flipped by the phases below. */
let mode='pass';                 // 'pass' | 'fail503' | 'holdState'
const held=[];                   // paused state requests waiting to be released
const exceptions=[],consoleErrors=[];
let served503=0;

ws.onmessage=ev=>{
  const m=JSON.parse(ev.data);
  if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return}
  if(m.method==='Fetch.requestPaused'){
    const {requestId,request}=m.params;
    const url=request.url;
    const isLive=url.includes('/api/nfl-live');
    if(isLive&&mode==='fail503'){
      served503++;
      send('Fetch.fulfillRequest',{requestId,responseCode:503,responseHeaders:[{name:'content-type',value:'application/json'},{name:'cache-control',value:'no-store'}],body:Buffer.from(JSON.stringify({ok:false,error:'injected_outage'})).toString('base64')}).catch(()=>{});
      return;
    }
    if(isLive&&mode==='holdState'&&url.includes('layer=state')&&held.length===0){
      held.push(requestId);        // hold exactly one, let everything after it through
      return;                      // deliberately not continued yet
    }
    send('Fetch.continueRequest',{requestId}).catch(()=>{});
    return;
  }
  if(m.method==='Runtime.exceptionThrown')exceptions.push(String(m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text||'').slice(0,200));
  if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')consoleErrors.push((m.params.args||[]).map(a=>String(a.value??a.description??'')).join(' ').slice(0,200));
};

const PROBE=[
  '(()=>{',
  '  const T=window.__res={rootSwaps:0,loaderAfterMount:0,mounted:false};',
  '  let rootNode=null;',
  '  new MutationObserver(()=>{',
  '    const r=document.querySelector(".pbecast6");',
  '    if(r&&rootNode&&r!==rootNode)T.rootSwaps++;',
  '    if(r){rootNode=r;T.mounted=true}',
  '    if(T.mounted&&document.querySelector("#view-container .view-loading"))T.loaderAfterMount++;',
  '  }).observe(document,{childList:true,subtree:true});',
  '})();'
].join('\n');

await send('Runtime.enable');
await send('Page.enable');
await send('Fetch.enable',{patterns:[{urlPattern:`${ORIGIN}/*`,requestStage:'Request'}]});
await send('Page.addScriptToEvaluateOnNewDocument',{source:PROBE});
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
const SNAP=`(()=>{const s=PBEcastV6.state;const g=(s.detail&&s.detail.game)||{};const root=document.querySelector('.pbecast6');const T=window.__res;return{
  cast6:document.querySelectorAll('.pbecast6').length,
  loading:!!document.querySelector('#view-container .view-loading'),
  q:g.status&&g.status.period, clock:g.status&&g.status.clock,
  score:((g.teams&&g.teams.away&&g.teams.away.score)||0)+'-'+((g.teams&&g.teams.home&&g.teams.home.score)||0),
  chars:(document.getElementById('view-container').textContent||'').trim().length,
  stale:root?root.dataset.stale:null,
  stamp:(document.querySelector('.pbecast6 [data-cast6-stamp]')||{}).textContent||null,
  err:s.error||null, rejected:s.rejected||0,
  rootSwaps:T.rootSwaps, loaderAfterMount:T.loaderAfterMount
}})()`;

const results=[];
const say=(label,s)=>{results.push({label,...s});console.log(`${label.padEnd(30)} Q${s.q} ${String(s.clock).padStart(5)} ${String(s.score).padEnd(6)} c6=${s.cast6} loading=${s.loading} stale=${s.stale} chars=${s.chars} rejected=${s.rejected} swaps=${s.rootSwaps} loaderAfterMount=${s.loaderAfterMount}${s.stamp?`  "${String(s.stamp).trim()}"`:''}`)};

console.log(`resilience gate -> ${TARGET}\n`);
await send('Page.navigate',{url:`${TARGET}/#pbecast`});
await sleep(12000);
const before=await evalIn(SNAP);
say('baseline (healthy)',before);

/* ---- 1. transient 503 ---------------------------------------------------- */
console.log('\n--- injecting 503 on every /api/nfl-live for 25s ---');
mode='fail503';
await sleep(25000);
const during=await evalIn(SNAP);
say('during outage',during);
mode='pass';
await sleep(12000);
const after=await evalIn(SNAP);
say('after recovery',after);

/* ---- 2. out-of-order fast-state response --------------------------------- */
console.log('\n--- holding one layer=state response while newer ones land ---');
const beforeHold=await evalIn(SNAP);
mode='holdState';
await sleep(1500);
mode='pass';                       // everything after the held one flows normally
await sleep(14000);                // let the game move on
const preRelease=await evalIn(SNAP);
say('before release',preRelease);
const rejectedBefore=preRelease.rejected;
for(const rid of held.splice(0)){try{await send('Fetch.continueRequest',{requestId:rid})}catch(e){}}
await sleep(6000);
const postRelease=await evalIn(SNAP);
say('after stale release',postRelease);

const backwards=(()=>{
  const p=preRelease,q=postRelease;
  if(p.q==null||q.q==null)return false;
  if(q.q<p.q)return true;
  const cs=v=>{const m=/^(\d+):(\d{2})$/.exec(String(v||''));return m?+m[1]*60+ +m[2]:null};
  const a=cs(p.clock),b=cs(q.clock);
  if(p.q===q.q&&a!=null&&b!=null&&b>a)return true;
  const t=s=>String(s).split('-').reduce((x,y)=>x+(+y||0),0);
  return t(q.score)<t(p.score);
})();

/* ---- 3. hidden for 60s, then restored ------------------------------------ */
console.log('\n--- hiding the tab for 60s ---');
const castReqs='(window.__res.reqs||[]).length';
await evalIn("(()=>{window.__res.reqs=[];const of=window.fetch;window.fetch=function(i){try{const u=String(typeof i==='string'?i:(i&&i.url)||'');if(u.indexOf('/api/nfl-live')>-1){const st=(new Error().stack||'');if(/pbecast-v6/.test(st))window.__res.reqs.push(Date.now())}}catch(e){}return of.apply(this,arguments)};return true})()");
await sleep(3000);
await evalIn("(()=>{window.__res.reqs=[];Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return 'hidden'}});document.dispatchEvent(new Event('visibilitychange'));return true})()");
await sleep(60000);
const hiddenReqs=await evalIn(castReqs);
const hiddenSnap=await evalIn(SNAP);
say('after 60s hidden',hiddenSnap);
await evalIn("(()=>{window.__res.reqs=[];Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return 'visible'}});document.dispatchEvent(new Event('visibilitychange'));return true})()");
await sleep(3000);
const resumeReqs=await evalIn(castReqs);
await sleep(6000);
const restored=await evalIn(SNAP);
say('after restore',restored);
console.log('PBEcast requests during 60s hidden: '+hiddenReqs+' (expected 0)');
console.log('PBEcast requests within 3s of restore: '+resumeReqs+' (expected >=1)');

console.log('\n=== verdict ===');
const checks=[
  ['503 kept the game painted',        during.cast6===1&&during.chars>500&&!during.loading],
  ['503 showed no loading screen',     during.loaderAfterMount===0],
  ['503 marked the state stale',       during.stale==='true'||/STALE/i.test(String(during.stamp||''))],
  ['503 did not remount the root',     during.rootSwaps===0],
  ['recovered by itself',              after.err===null&&after.cast6===1&&!after.loading],
  ['stale response did not repaint',   !backwards],
  ['stale response was rejected',      postRelease.rejected>=rejectedBefore],
  ['no root swaps at any point',       postRelease.rootSwaps===0],
  ['no loading screen at any point',   postRelease.loaderAfterMount===0],
  ['no uncaught exceptions',           exceptions.length===0],
  ['60s hidden issued no requests',    Number(hiddenReqs)===0],
  ['restore resynced immediately',     Number(resumeReqs)>=1],
  ['restore did not remount',          restored.rootSwaps===0&&restored.loaderAfterMount===0&&restored.cast6===1]
];
let failed=0;
for(const [name,ok] of checks){if(!ok)failed++;console.log(`  ${ok?'PASS':'FAIL'}  ${name}`)}
console.log(`\n503 responses served: ${served503}   exceptions: ${exceptions.length}   console errors: ${consoleErrors.length}`);
writeFileSync(join(OUT,`${LABEL}-${WIDTH}px.json`),JSON.stringify({target:TARGET,results,checks,served503,exceptions,consoleErrors},null,2));
console.log(`report: ${join(OUT,`${LABEL}-${WIDTH}px.json`)}`);
finish(failed?1:0);
