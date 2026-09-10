/* PBEcast single-authority refresh gate.
 *
 * Serves the WORKING TREE at the production origin over CDP request
 * interception, lets /api/** reach real production, and hard-refreshes
 * #pbecast N times. Each pass records, from document-start:
 *   - every distinct PBEcast render generation the user could actually see
 *   - the terminal DOM (one .pbecast6, one #pbecast7-trading, no v4/v5)
 *   - which module owns App.VIEWS.pbecast at settle
 *   - /api/nfl-live traffic in a fixed post-settle window (poll-loop proof)
 *   - console errors / uncaught exceptions
 *
 * node scripts/pbecast-refresh-gate.mjs [passes] [--shots] [--width=1440]
 */
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,extname} from 'node:path';

const REPO=process.cwd();
const TARGET=process.env.PBE_GATE_TARGET||'https://nfl.propbetedge.ai';
const ORIGIN=new URL(TARGET).origin;
const PASSES=Number(process.argv[2]||20);
const SHOTS=process.argv.includes('--shots');
const WIDTH=Number((process.argv.find(a=>a.startsWith('--width='))||'--width=1440').split('=')[1]);
const HEIGHT=WIDTH<600?844:900;
const OUT=process.env.PBE_GATE_OUT||join(REPO,'.gate','pbecast');
const LABEL=process.env.PBE_GATE_LABEL||'run';
const SETTLE_MS=Number(process.env.PBE_GATE_SETTLE||9000);
const WINDOW_MS=Number(process.env.PBE_GATE_WINDOW||20000);
/* LIVE=1 serves nothing locally: the gate then measures deployed production
   exactly as a browser sees it. DELAY adds per-asset latency to the working
   tree so a local run reproduces production's script-arrival ordering rather
   than the unrealistically fast disk path. */
const LIVE=process.env.PBE_GATE_LIVE==='1';
const DELAY=Number(process.env.PBE_GATE_DELAY||0);

const CHROME=process.env.PBE_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT=9860+Math.floor(Math.random()*90);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dir=mkdtempSync(join(tmpdir(),'pbe-cast-'));
mkdirSync(OUT,{recursive:true});
const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'--headless=new','--no-first-run','--disable-extensions','--hide-scrollbars','--autoplay-policy=no-user-gesture-required','about:blank'],{stdio:'ignore'});
function finish(c){try{chrome.kill()}catch{}setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}process.exit(c)},250)}
const deadline=setTimeout(()=>{console.error('DEADLINE');finish(3)},60000+PASSES*(SETTLE_MS+WINDOW_MS+5000));
deadline.unref?.();

async function wsUrl(){
  for(let i=0;i<120;i++){
    try{const l=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl}catch{}
    await sleep(200);
  }
  throw new Error('devtools_unreachable');
}
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

let exceptions=[],consoleErrors=[];
const served=new Set(),missedLocal=new Set();
ws.onmessage=ev=>{
  const m=JSON.parse(ev.data);
  if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return}
  if(m.method==='Fetch.requestPaused'){
    const url=m.params.request.url;
    const l=localFile(url);
    if(l){
      served.add(new URL(url).pathname);
      const fulfil=()=>send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'content-type',value:l.type},{name:'cache-control',value:'no-store'}],body:l.body.toString('base64')}).catch(()=>{});
      DELAY?setTimeout(fulfil,DELAY):fulfil();
    }else{
      try{const u=new URL(url);if(u.origin===ORIGIN&&!u.pathname.startsWith('/api/'))missedLocal.add(u.pathname)}catch{}
      send('Fetch.continueRequest',{requestId:m.params.requestId}).catch(()=>{});
    }
    return;
  }
  if(m.method==='Runtime.exceptionThrown')exceptions.push(String(m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text||'').slice(0,220));
  if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')consoleErrors.push((m.params.args||[]).map(a=>String(a.value??a.description??'')).join(' ').slice(0,220));
};

/* Instrumentation installed before ANY page script runs. It samples the view
   container every animation frame and records each distinct PBEcast render
   generation that was actually painted, plus every /api/nfl-live call. */
const PROBE = [
  '(()=>{',
  '  const T=window.__pbeGate={gens:[],live:[],start:Date.now()};',
  '  const sig=()=>{',
  '    const vc=document.getElementById("view-container");',
  '    if(!vc)return "no-container";',
  '    if(vc.querySelector(".pbecast6"))return vc.querySelector(".cast5-live-layer")?"v6+v5layer":"v6";',
  '    if(vc.querySelector(".pbecast4"))return vc.querySelector(".cast5-live-layer")?"v4+v5layer":"v4";',
  '    const t=vc.textContent||"";',
  '    if(/Built truth-first|will not label game data LIVE/i.test(t))return "placeholder";',
  '    if(vc.querySelector(".view-loading"))return "loading";',
  '    if(vc.querySelector(".pbehome6,.pbehome7,.pbe-v2-dashboard,.pbe8-home,.pbe-home7"))return "dashboard";',
  '    return t.trim().length?("other:"+t.trim().slice(0,44).replace(/\\s+/g," ")):"empty";',
  '  };',
  '  const push=()=>{const s=sig();const last=T.gens[T.gens.length-1];if(!last||last.sig!==s)T.gens.push({sig:s,t:Date.now()-T.start})};',
  '  const tick=()=>{push();requestAnimationFrame(tick)};',
  '  requestAnimationFrame(tick);',
  '  const of=window.fetch;',
  '  window.fetch=function(input){',
  '    try{const u=String(typeof input==="string"?input:(input&&input.url)||"");',
  '      if(u.indexOf("/api/nfl-live")>-1){',
  '        const st=(new Error().stack||"").replace(/https?:\\/\\/[^/]+\\//g,"");',
  '        const owner=/pbecast-v6\\.js/.test(st)?"v6":/pbecast-v5[.-]/.test(st)?"v5":/pbecast-v4\\.js/.test(st)?"v4":/pbe-breaking/.test(st)?"breaking-rail":/sports-shell/.test(st)?"sports-shell":"other";',
  '        T.live.push({t:Date.now()-T.start,owner:owner,url:u.replace(/^https?:\\/\\/[^/]+/,""),stack:st.split("\\n").slice(2,5).join(" | ")});',
  '      }',
  '    }catch(e){}',
  '    return of.apply(this,arguments);',
  '  };',
  '  window.__pbeGateOwner=()=>{',
  '    const v=window.App&&window.App.VIEWS&&window.App.VIEWS.pbecast;',
  '    if(typeof v!=="function")return "none";',
  '    if(window.PBEcastV6&&v===window.PBEcastV6.load)return "v6";',
  '    if(window.PBEcastV5&&v===window.PBEcastV5.load)return "v5";',
  '    if(window.PBEcastV4&&v===window.PBEcastV4.load)return "v4";',
  '    return "other/placeholder";',
  '  };',
  '})();'
].join('\n');

await send('Runtime.enable');
await send('Page.enable');
await send('Fetch.enable',{patterns:[{urlPattern:`${ORIGIN}/*`,requestStage:'Request'}]});
await send('Page.addScriptToEvaluateOnNewDocument',{source:PROBE});
await send('Emulation.setDeviceMetricsOverride',{width:WIDTH,height:HEIGHT,deviceScaleFactor:1,mobile:WIDTH<600});

const evalIn=async(expr,ms=25000)=>{
  try{const r=await Promise.race([send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true}),sleep(ms).then(()=>{throw new Error('WEDGED')})]);return r.result?.value}
  catch(e){return{__error:e.message}}
};

const REPORT = [
  '(()=>{',
  '  const vc=document.getElementById("view-container")||document.body;',
  '  const T=window.__pbeGate||{gens:[],live:[]};',
  '  const seen=[];T.gens.forEach(g=>{if(seen.indexOf(g.sig)<0)seen.push(g.sig)});',
  '  const s6=window.PBEcastV6&&PBEcastV6.state||{};',
  '  const hero=document.querySelector(".pbecast6 [data-cast6-hero]");',
  '  return {',
  '    hash:location.hash, route:(window.App&&App.current)||null,',
  '    owner:window.__pbeGateOwner?window.__pbeGateOwner():"n/a",',
  '    cast4:document.querySelectorAll(".pbecast4").length,',
  '    cast5layer:document.querySelectorAll(".cast5-live-layer").length,',
  '    cast6:document.querySelectorAll(".pbecast6").length,',
  '    cast7:document.querySelectorAll("#pbecast7-trading").length,',
  '    globals:{v4:!!window.PBEcastV4,v5:!!window.PBEcastV5,v5r:!!window.PBEcastV5Renderer,v6:!!window.PBEcastV6},',
  '    placeholder:/Built truth-first|will not label game data LIVE/i.test(vc.textContent||""),',
  '    semantics:(s6.detail&&s6.detail.source&&s6.detail.source.semantics)||null,',
  '    activeId:s6.activeId||null,',
  '    navLabel:(document.getElementById("nav-pbecast")||{}).textContent?document.getElementById("nav-pbecast").textContent.trim().replace(/\\s+/g," "):null,',
  '    hero:hero?hero.textContent.trim().replace(/\\s+/g," ").slice(0,110):null,',
  '    genPath:seen, liveCalls:T.live.length,',
  '    byOwner:T.live.reduce((a,c)=>{a[c.owner]=(a[c.owner]||0)+1;return a},{})',
  '  };',
  '})()'
].join('\n');

const rows=[];
for(let pass=1;pass<=PASSES;pass++){
  exceptions=[];consoleErrors=[];
  if(pass===1)await send('Page.navigate',{url:`${TARGET}/#pbecast`});
  else await send('Page.reload',{ignoreCache:true});
  await sleep(SETTLE_MS);
  const settle=await evalIn(REPORT);
  const t0=await evalIn('(window.__pbeGate.live||[]).length');
  await sleep(WINDOW_MS);
  const after=await evalIn(REPORT);
  const windowCalls=(after.liveCalls||0)-(Number(t0)||0);
  /* PBEcast-owned polling only. The breaking rail and the global sports shell
     also read /api/nfl-live on every route; they are not this route's loops. */
  const windowByOwner=await evalIn(`JSON.stringify((window.__pbeGate.live||[]).slice(${Number(t0)||0}).reduce((a,c)=>{a[c.owner]=(a[c.owner]||0)+1;return a},{}))`);
  const castCalls=(()=>{try{const o=JSON.parse(windowByOwner);return (o.v4||0)+(o.v5||0)+(o.v6||0)}catch{return -1}})();
  const stacks=await evalIn('JSON.stringify((window.__pbeGate.live||[]).slice(-6))');
  rows.push({pass,settle,after,windowCalls,windowByOwner,castCalls,exceptions:[...exceptions],consoleErrors:[...consoleErrors],stacks});

  const bad=[];
  if(settle.route!=='pbecast'||String(settle.hash).indexOf('pbecast')<0)bad.push('route='+settle.route);
  if(settle.cast4)bad.push('cast4='+settle.cast4);
  if(settle.cast5layer)bad.push('v5layer='+settle.cast5layer);
  if(settle.cast6!==1)bad.push('cast6='+settle.cast6);
  if(settle.placeholder)bad.push('placeholder');
  if(settle.owner!=='v6')bad.push('owner='+settle.owner);
  if((settle.genPath||[]).some(g=>g==='placeholder'||g.indexOf('v4')===0||g==='dashboard'))bad.push('flash');
  if(exceptions.length)bad.push('exceptions='+exceptions.length);
  console.log(`pass ${String(pass).padStart(2)} ${bad.length?'FAIL':'ok  '} owner=${settle.owner} gens=[${(settle.genPath||[]).join(' > ')}] c6=${settle.cast6} c7=${settle.cast7} sem=${settle.semantics} cast-poll/${WINDOW_MS/1000}s=${castCalls} all=${windowCalls} ${windowByOwner}${bad.length?'  << '+bad.join(','):''}`);

  if(SHOTS&&pass===1){
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(join(OUT,`${LABEL}-${WIDTH}px.png`),Buffer.from(shot.data,'base64'));
  }
}

writeFileSync(join(OUT,`${LABEL}-${WIDTH}px.json`),JSON.stringify({target:TARGET,passes:PASSES,width:WIDTH,settleMs:SETTLE_MS,windowMs:WINDOW_MS,servedLocal:[...served].sort(),missedLocal:[...missedLocal].sort(),rows},null,2));
const fails=rows.filter(r=>{const s=r.settle;return s.route!=='pbecast'||s.cast4||s.cast5layer||s.cast6!==1||s.placeholder||s.owner!=='v6'||(s.genPath||[]).some(g=>g==='placeholder'||g.indexOf('v4')===0||g==='dashboard')||r.exceptions.length});
const calls=rows.map(r=>r.castCalls).sort((a,b)=>a-b);
const all=rows.map(r=>r.windowCalls).sort((a,b)=>a-b);
console.log(`\n[${LABEL} @${WIDTH}px] passes=${PASSES} clean=${PASSES-fails.length} failed=${fails.length}`);
console.log(`PBEcast-owned /api/nfl-live per ${WINDOW_MS/1000}s: min=${calls[0]} max=${calls[calls.length-1]} median=${calls[Math.floor(calls.length/2)]}  (one 5s loop = 2 calls/cycle)`);
console.log(`all /api/nfl-live per ${WINDOW_MS/1000}s (incl. global shell + breaking rail): min=${all[0]} max=${all[all.length-1]}`);
console.log(`report: ${join(OUT,`${LABEL}-${WIDTH}px.json`)}`);
finish(fails.length?1:0);
