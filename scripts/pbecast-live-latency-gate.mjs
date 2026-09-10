/* PBEcast live-latency + quiet-refresh gate.
 *
 * Mounts #pbecast against a real live game with the working tree served at the
 * production origin, then watches for N minutes and reports:
 *
 *   END-TO-END PLAY LATENCY  when the screen first showed a play, minus that
 *                            play's own wallclock. This is the number the
 *                            <=30s P95 target is about. Raw "age of newest
 *                            play" is reported too, but it conflates feed lag
 *                            with the game simply not running a play, so it is
 *                            not the pass/fail metric.
 *   POLL SHAPE               one active-game loop, at the intended cadence,
 *                            split across the live / detail / board lanes.
 *   QUIET REFRESH            .pbecast6 is never replaced, no loading state
 *                            returns after mount, no route remount.
 *   MONOTONIC                the displayed play/clock/score never goes back.
 *
 * node scripts/pbecast-live-latency-gate.mjs [minutes] [--width=1440]
 */
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,extname} from 'node:path';

const REPO=process.cwd();
const TARGET=process.env.PBE_GATE_TARGET||'https://nfl.propbetedge.ai';
const ORIGIN=new URL(TARGET).origin;
const MINUTES=Number(process.argv[2]||10);
const WIDTH=Number((process.argv.find(a=>a.startsWith('--width='))||'--width=1440').split('=')[1]);
const OUT=process.env.PBE_GATE_OUT||join(REPO,'.gate','pbecast');
const LABEL=process.env.PBE_GATE_LABEL||'latency';
const LIVE=process.env.PBE_GATE_LIVE==='1';
const DELAY=Number(process.env.PBE_GATE_DELAY||0);
const CHROME=process.env.PBE_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT=9660+Math.floor(Math.random()*90);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dir=mkdtempSync(join(tmpdir(),'pbe-lat-'));
mkdirSync(OUT,{recursive:true});
const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'--headless=new','--no-first-run','--disable-extensions','--hide-scrollbars','about:blank'],{stdio:'ignore'});
function finish(c){try{chrome.kill()}catch{}setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}process.exit(c)},250)}
setTimeout(()=>{console.error('DEADLINE');finish(3)},(MINUTES+6)*60000).unref?.();

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
const exceptions=[],consoleErrors=[];
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
  if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')consoleErrors.push((m.params.args||[]).map(a=>String(a.value??a.description??'')).join(' ').slice(0,200));
};

const PROBE=[
  '(()=>{',
  '  try{',
  '  const T=window.__cast={reqs:[],plays:[],samples:[],tele:[],states:[],lastStateKey:null,rootSwaps:0,loaderAfterMount:0,mounted:false,regressions:[],sampleError:null,start:Date.now()};',
  '  const of=window.fetch;',
  '  window.fetch=function(input){',
  '    try{const u=String(typeof input==="string"?input:(input&&input.url)||"");',
  '      if(u.indexOf("/api/nfl-live")>-1){',
  '        const st=(new Error().stack||"").replace(/https?:\\/\\/[^/]+\\//g,"");',
  '        const lane=u.indexOf("layer=state")>-1?"state":u.indexOf("layer=live")>-1?"live":u.indexOf("event=")>-1?"detail":"board";',
  '        const owner=/pbecast-v6\\.js/.test(st)?"v6":/pbecast-v5[.-]/.test(st)?"v5":/pbecast-v4\\.js/.test(st)?"v4":/pbe-breaking/.test(st)?"breaking-rail":/sports-shell/.test(st)?"sports-shell":"other";',
  '        T.reqs.push({t:Date.now()-T.start,lane:lane,owner:owner});',
  '      }',
  '    }catch(e){}',
  '    return of.apply(this,arguments);',
  '  };',
  '  let rootNode=null;',
  '  const mo=new MutationObserver(()=>{',
  '    const r=document.querySelector(".pbecast6");',
  '    if(r&&rootNode&&r!==rootNode)T.rootSwaps++;',
  '    if(r)rootNode=r;',
  '    if(T.mounted&&document.querySelector("#view-container .view-loading"))T.loaderAfterMount++;',
  '  });',
  /* At document-start there is no documentElement yet, so the observer is
     attached to the document itself; a subtree watch there sees the whole
     page as it is built and for the rest of the session. */
  '  mo.observe(document,{childList:true,subtree:true});',
  '  const clockSec=v=>{const m=/^(\\d+):(\\d{2})$/.exec(String(v||"").trim());return m?+m[1]*60+ +m[2]:null};',
  '  let last=null;',
  '  setInterval(()=>{',
  '    try{',
  '    const s=(window.PBEcastV6&&PBEcastV6.state)||{};',
  '    const d=s.detail;if(!d||!d.game)return;',
  '    if(document.querySelector(".pbecast6"))T.mounted=true;',
  '    const p=d.current_play||{};',
  '    const st=d.game.status||{};',
  '    const now=Date.now();',
  '    const cur={id:String(p.id||""),wall:p.wallclock||d.source&&d.source.latest_play_wallclock||null,',
  '      period:st.period==null?null:+st.period,left:clockSec(st.clock),',
  '      score:(+(d.game.teams&&d.game.teams.away&&d.game.teams.away.score)||0)+(+(d.game.teams&&d.game.teams.home&&d.game.teams.home.score)||0),',
  '      age:d.source?d.source.play_age_seconds:null,provider:d.source?d.source.provider:null};',
  '    T.samples.push({t:now-T.start,age:cur.age,period:cur.period,left:cur.left,score:cur.score});',
  '    if(last){',
  '      const bw=last.wall?Date.parse(last.wall):NaN, nw=cur.wall?Date.parse(cur.wall):NaN;',
  '      if(Number.isFinite(bw)&&Number.isFinite(nw)&&nw<bw)T.regressions.push({t:now-T.start,kind:"wallclock",from:last.wall,to:cur.wall});',
  '      if(cur.score<last.score)T.regressions.push({t:now-T.start,kind:"score",from:last.score,to:cur.score});',
  '      if(cur.period!=null&&last.period!=null){',
  '        if(cur.period<last.period)T.regressions.push({t:now-T.start,kind:"period",from:last.period,to:cur.period});',
  '        else if(cur.period===last.period&&cur.left!=null&&last.left!=null&&cur.left>last.left)T.regressions.push({t:now-T.start,kind:"clock",from:last.left,to:cur.left});',
  '      }',
  '    }',
  '    if(cur.id&&(!last||last.id!==cur.id)){',
  '      T.plays.push({id:cur.id,wall:cur.wall,shownAt:now,',
  '        latency:cur.wall&&Number.isFinite(Date.parse(cur.wall))?Math.round((now-Date.parse(cur.wall))/100)/10:null,',
  '        provider:cur.provider});',
  '    }',
  '    try{',
  '      const tl=(window.PBEcastV6&&PBEcastV6.telemetry)?PBEcastV6.telemetry():null;',
  '      if(tl){',
  '        T.tele.push({t:now-T.start,fastAge:tl.fast_state_age_seconds,playAge:tl.latest_play_age_seconds,ahead:tl.fast_state_ahead_of_detail,fastProv:tl.fast_provider,detailProv:tl.detail_provider,rejected:tl.rejected_stale_responses});',
  '        const key=cur.period+"|"+cur.left+"|"+cur.score;',
  '        if(key!==T.lastStateKey){',
  '          const first=T.lastStateKey===null;',
  '          T.lastStateKey=key;',
  '          if(!first)T.states.push({t:now-T.start,key:key,age:tl.fast_state_age_seconds,ahead:tl.fast_state_ahead_of_detail,provider:tl.fast_provider});',
  '        }',
  '      }else{T.teleMissing=(T.teleMissing||0)+1}',
  '    }catch(e){T.teleError=String(e&&e.message||e).slice(0,160)}',
  '    last=cur;',
  '    }catch(e){T.sampleError=String(e&&e.stack||e).slice(0,300)}',
  '  },500);',
  '  }catch(e){window.__castBoot=String(e&&e.stack||e).slice(0,300)}',
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

console.log(`mounting ${TARGET}/#pbecast  (${MINUTES}m, ${WIDTH}px, ${LIVE?'deployed production':'working tree'})`);
await send('Page.navigate',{url:`${TARGET}/#pbecast`});
await sleep(10000);

const boot=await evalIn(`(()=>{const s=PBEcastV6.state;return{game:s.detail&&s.detail.game&&s.detail.game.short_name,semantics:s.detail&&s.detail.source&&s.detail.source.semantics,provider:s.detail&&s.detail.source&&s.detail.source.provider,cast6:document.querySelectorAll(".pbecast6").length,cast7:document.querySelectorAll("#pbecast7-trading").length}})()`);
console.log(`mounted: ${boot.game} · ${boot.semantics} · ${boot.provider} · .pbecast6=${boot.cast6} #pbecast7-trading=${boot.cast7}\n`);
if(boot.semantics!=='LIVE')console.log('NOTE: the focused game is not LIVE; latency figures below will not be meaningful.\n');

const until=Date.now()+MINUTES*60000;
let tick=0;
while(Date.now()<until){
  await sleep(30000);
  const s=await evalIn(`(()=>{const T=window.__cast;const s=PBEcastV6.state;const st=(s.detail&&s.detail.game&&s.detail.game.status)||{};return{plays:T.plays.length,samples:T.samples.length,probeErr:(window.__castBoot||T.sampleError||null),reqs:T.reqs.length,swaps:T.rootSwaps,loader:T.loaderAfterMount,regr:T.regressions.length,age:s.detail&&s.detail.source&&s.detail.source.play_age_seconds,period:st.period,clock:st.clock,badge:(document.querySelector(".pbecast6 .cast6-live")||{}).textContent||null,cast6:document.querySelectorAll(".pbecast6").length}})()`);
  if(s.probeErr)console.log('PROBE ERROR:',s.probeErr);
  console.log(`+${String(++tick*0.5).padStart(4)}m  Q${s.period} ${String(s.clock).padStart(5)}  plays=${String(s.plays).padStart(3)} samples=${String(s.samples).padStart(4)}  age=${String(s.age).padStart(6)}s  badge="${String(s.badge).trim()}"  reqs=${s.reqs} rootSwaps=${s.swaps} loaderAfterMount=${s.loader} regressions=${s.regr} cast6=${s.cast6}`);
}

/* tab hidden -> visible must pause and then resync immediately */
console.log('\n--- tab visibility ---');
const castReqs="(window.__cast.reqs||[]).filter(r=>r.owner==='v6').length";
const beforeHide=await evalIn(castReqs);
await send('Emulation.setPageScaleFactor',{pageScaleFactor:1}).catch(()=>{});
await evalIn(`(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'});document.dispatchEvent(new Event('visibilitychange'));return true})()`);
await sleep(15000);
const duringHide=await evalIn(castReqs);
await evalIn(`(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'visible'});document.dispatchEvent(new Event('visibilitychange'));return true})()`);
await sleep(2500);
const afterShow=await evalIn(castReqs);
console.log(`PBEcast requests while hidden for 15s: ${duringHide-beforeHide} (expected 0; the global shell and breaking rail poll independently of this route)`);
console.log(`PBEcast requests within 2.5s of becoming visible: ${afterShow-duringHide} (expected >=1 immediate resync)`);

const T=await evalIn('JSON.stringify({plays:window.__cast.plays,reqs:window.__cast.reqs,samples:window.__cast.samples,tele:window.__cast.tele,states:window.__cast.states,teleMissing:window.__cast.teleMissing||0,teleError:window.__cast.teleError||null,rootSwaps:window.__cast.rootSwaps,loaderAfterMount:window.__cast.loaderAfterMount,regressions:window.__cast.regressions})');
const data=JSON.parse(T);
const pctl=(a,p)=>{if(!a.length)return null;const s=a.slice().sort((x,y)=>x-y);return Math.round(s[Math.min(s.length-1,Math.ceil(p/100*s.length)-1)]*10)/10};

/* The play already on screen at mount was published before we started
   watching, so its "latency" is just how long ago it happened. Drop it, the
   same way the upstream benchmark drops everything in flight at start-up. */
const scored=data.plays.slice(1);
const lat=scored.map(p=>p.latency).filter(x=>typeof x==='number'&&x>=0);
const ages=data.samples.map(s=>s.age).filter(x=>typeof x==='number');
const lanes={};data.reqs.forEach(r=>{if(r.owner==='v6')lanes[r.lane]=(lanes[r.lane]||0)+1});
const legacy=data.reqs.filter(r=>r.owner==='v4'||r.owner==='v5').length;
const mins=MINUTES;

const stateRows=data.states||[];
const stateAges=stateRows.map(x=>x.age).filter(x=>typeof x==='number'&&x>=0);
const aheadPct=stateRows.length?Math.round(100*stateRows.filter(x=>x.ahead).length/stateRows.length):0;
console.log('\n=== FAST GAME STATE LATENCY (age of the play behind each score/clock/possession change) ===');
console.log(`state changes=${stateRows.length}  dated=${stateAges.length}  median=${pctl(stateAges,50)}s  p95=${pctl(stateAges,95)}s  min=${stateAges.length?Math.min(...stateAges):null}s  max=${stateAges.length?Math.max(...stateAges):null}s`);
console.log(`  fast lane ahead of the datable play log on ${aheadPct}% of changes`);
if(data.teleError)console.log(`  TELEMETRY ERROR: ${data.teleError}`);
if(data.teleMissing)console.log(`  telemetry unavailable on ${data.teleMissing} samples`);
console.log('\n=== END-TO-END PLAY LATENCY (screen first showed the play, minus its wallclock) ===');
console.log(`plays scored=${lat.length} (of ${data.plays.length} seen; the one current at mount is excluded)`);
console.log(`    median=${pctl(lat,50)}s  p95=${pctl(lat,95)}s  min=${lat.length?Math.min(...lat):null}s  max=${lat.length?Math.max(...lat):null}s`);
console.log('\n=== raw newest-play age (includes stoppages; not the pass/fail metric) ===');
console.log(`samples=${ages.length}  median=${pctl(ages,50)}s  p95=${pctl(ages,95)}s  max=${ages.length?Math.max(...ages):null}s`);
console.log('\n=== poll shape (PBEcast-owned /api/nfl-live over the run) ===');
Object.entries(lanes).forEach(([k,v])=>console.log(`  ${k.padEnd(7)} ${String(v).padStart(4)} requests  = ${(v/mins).toFixed(1)}/min  (~${(mins*60/v).toFixed(1)}s apart)`));
console.log(`  legacy v4/v5 requests: ${legacy}`);
console.log('\n=== quiet refresh ===');
console.log(`  .pbecast6 replaced during the run: ${data.rootSwaps} (must be 0)`);
console.log(`  loading state after mount:         ${data.loaderAfterMount} (must be 0)`);
console.log(`  backwards state accepted:          ${data.regressions.length} (must be 0)`);
if(data.regressions.length)console.log('   '+JSON.stringify(data.regressions.slice(0,5)));
console.log(`  uncaught exceptions:               ${exceptions.length}`);
console.log(`  console errors:                    ${consoleErrors.length}`);

writeFileSync(join(OUT,`${LABEL}-${WIDTH}px.json`),JSON.stringify({target:TARGET,minutes:MINUTES,boot,latency:{n:lat.length,median:pctl(lat,50),p95:pctl(lat,95),max:lat.length?Math.max(...lat):null},rawAge:{median:pctl(ages,50),p95:pctl(ages,95)},lanes,legacy,fastState:{n:stateRows.length,median:pctl(stateAges,50),p95:pctl(stateAges,95)},states:stateRows,tele:(data.tele||[]).slice(-60),rootSwaps:data.rootSwaps,loaderAfterMount:data.loaderAfterMount,regressions:data.regressions,exceptions,consoleErrors,plays:data.plays,reqs:data.reqs},null,2));
console.log(`\nreport: ${join(OUT,`${LABEL}-${WIDTH}px.json`)}`);
const pass=data.rootSwaps===0&&data.loaderAfterMount===0&&data.regressions.length===0&&legacy===0&&!exceptions.length;
finish(pass?0:1);
