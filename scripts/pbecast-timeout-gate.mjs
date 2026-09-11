/* PBE TIMEOUT BREAK gate.
 *
 * Replays a real live sequence captured from SF @ LAR (2026-09-11, Q2):
 *
 *   A  Pass Reception      7:34   normal play
 *   B  Official Timeout    7:16   stays the current play for 45s (~22 state polls)
 *   C  Pass Incompletion   7:01   the next real snap
 *
 * Every /api/nfl-live request is answered from the fixture, so the gate is
 * deterministic and needs no live game. It proves, from the page itself:
 *
 *   - the break enters exactly once for one Official Timeout play id
 *   - it does not restart on the ~22 polls that repeat that play
 *   - it rotates first-party creatives during a long timeout, with a crossfade
 *   - the next real play removes it on the next live-lane paint
 *   - zero .pbecast6 root swaps, zero loading screens, no duplicate poll loops,
 *     no backward clock
 *   - first-class layout at 1440 and 390 (screenshots written to OUT)
 *
 * node scripts/pbecast-timeout-gate.mjs
 *   PBE_GATE_TARGET    origin to load (default https://nfl.propbetedge.ai)
 *   PBE_GATE_LOCAL=1   serve this checkout's pbecast-v6.js/.css over the target
 *   PBE_GATE_BOOTSTRAP share URL for a protected preview
 */
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const TARGET=process.env.PBE_GATE_TARGET||'https://nfl.propbetedge.ai';
const ORIGIN=new URL(TARGET).origin;
const BOOTSTRAP=process.env.PBE_GATE_BOOTSTRAP||'';
const LOCAL=process.env.PBE_GATE_LOCAL==='1';
const OUT=process.env.PBE_GATE_OUT||join(process.cwd(),'.gate','pbecast');
const CHROME=process.env.PBE_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PHASE_B_MS=Number(process.env.PBE_GATE_TIMEOUT_MS||45000);
const FX=JSON.parse(readFileSync(new URL('../research/fixtures/pbecast/sf-lar-official-timeout.json',import.meta.url),'utf8'));
const PORT=9660+Math.floor(Math.random()*90);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dir=mkdtempSync(join(tmpdir(),'pbe-tb-'));
mkdirSync(OUT,{recursive:true});
const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'--headless=new','--no-first-run','--disable-extensions','--hide-scrollbars','about:blank'],{stdio:'ignore'});
function finish(c){try{chrome.kill()}catch{}setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}process.exit(c)},250)}
setTimeout(()=>{console.error('DEADLINE');finish(3)},240000).unref?.();

async function wsUrl(){for(let i=0;i<120;i++){try{const l=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl}catch{}await sleep(250)}throw new Error('no devtools')}
const ws=new WebSocket(await wsUrl());
await new Promise(r=>{ws.onopen=r});
let id=1;const pending=new Map();
const send=(m,p={})=>{const n=id++;ws.send(JSON.stringify({id:n,method:m,params:p}));return new Promise((res,rej)=>pending.set(n,{resolve:res,reject:rej}))};

/* ---- the scripted feed ---------------------------------------------------- */
let phase='A';
const PLAY={A:FX.plays.before,B:FX.plays.timeout,C:FX.plays.after};
function gameFor(p){
  const g=structuredClone(FX.state.game);
  g.status={...g.status,semantics:'LIVE',state:'in',name:'STATUS_IN_PROGRESS',period:p.period,clock:p.clock,completed:false,
    detail:`${p.clock} - 2nd Quarter`,short_detail:`${p.clock} - 2nd`};
  g.situation={...(g.situation||{}),last_play:p};
  return g;
}
function payload(url){
  const p=PLAY[phase];
  const source=layer=>({...FX.state.source,semantics:'LIVE',fetched_at:new Date().toISOString(),last_play_id:p.id,layer});
  if(url.includes('date=')){const b=structuredClone(FX.board);b.games=b.games.map(x=>({...x,status:gameFor(p).status}));return b}
  if(url.includes('layer=state'))return {ok:true,layer:'state',source:source('state'),game:gameFor(p)};
  const history=[...FX.history.filter(x=>(x.sequence||0)<(p.sequence||0)),p];
  const live={...structuredClone(FX.live),source:{...FX.live.source,semantics:'LIVE',fetched_at:new Date().toISOString(),latest_play_wallclock:p.wallclock},
    game:gameFor(p),current_play:p,last_five_plays:history.slice(-5).reverse()};
  if(url.includes('layer=live'))return live;
  return {...live,plays:history,player_stats:FX.player_stats,drives:[],leaders:[],win_probability:[]};
}

const localFiles={'/pbecast-v6.js':'application/javascript','/pbecast-v6.css':'text/css'};
const exceptions=[];
ws.onmessage=ev=>{
  const m=JSON.parse(ev.data);
  if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return}
  if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params?.exceptionDetails?.exception?.description?.slice(0,200)||'exception');
  if(m.method==='Fetch.requestPaused'){
    const {requestId,request}=m.params;const u=new URL(request.url);
    if(u.origin===ORIGIN&&u.pathname==='/api/nfl-live'){
      send('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'content-type',value:'application/json'},{name:'cache-control',value:'no-store'}],body:Buffer.from(JSON.stringify(payload(request.url))).toString('base64')}).catch(()=>{});
      return;
    }
    if(LOCAL&&u.origin===ORIGIN&&localFiles[u.pathname]){
      send('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'content-type',value:localFiles[u.pathname]},{name:'cache-control',value:'no-store'}],body:readFileSync(join(process.cwd(),u.pathname.slice(1))).toString('base64')}).catch(()=>{});
      return;
    }
    send('Fetch.continueRequest',{requestId}).catch(()=>{});
  }
};

/* ---- in-page instrumentation ---------------------------------------------- */
const PROBE=`(()=>{
  const T=window.__tb={rootRemovals:0,loading:0,samples:[],fetches:[]};
  const of=window.fetch;window.fetch=function(u,...a){try{const s=String(u&&u.url||u);if(s.includes('/api/nfl-live'))T.fetches.push({t:Date.now(),layer:s.includes('layer=state')?'state':s.includes('layer=live')?'live':s.includes('date=')?'board':'detail'})}catch(_){}return of.apply(this,[u,...a])};
  new MutationObserver(ms=>{for(const m of ms)for(const n of m.removedNodes)if(n.nodeType===1&&(n.matches?.('.pbecast6')||n.querySelector?.('.pbecast6')))T.rootRemovals++}).observe(document,{childList:true,subtree:true});
  setInterval(()=>{const root=document.querySelector('.pbecast6');if(!root)return;if(!T.root)T.root=root;
    const q=s=>root.querySelector(s),tx=el=>el?el.textContent.replace(/\\s+/g,' ').trim():null;
    const loading=/Loading game package/i.test(tx(q('[data-cast6-hero]'))||'');if(loading&&T.painted)T.loading++;
    if(q('.cast6-score'))T.painted=true;
    const tb=window.PBEcastV6?.state?.timeoutBreak||{};
    T.samples.push({t:Date.now(),sameRoot:T.root===root,break:!!q('.cast6-tb'),creative:q('.cast6-tb-card:not(.is-leaving)')?.dataset.creativeId||null,leaving:!!q('.cast6-tb-card.is-leaving'),entering:!!q('.cast6-tb-card.is-entering'),
      status:tx(q('.cast6-current>header')),curType:tx(q('.cast6-current h2')),clock:tx(q('.cast6-score-center>span')),score:tx(q('.cast6-score-center>strong')),entries:tb.entries||0,rotations:tb.rotations||0,active:!!tb.active,playId:tb.playId||null});
  },150);
})()`;

await send('Page.enable');await send('Runtime.enable');
await send('Fetch.enable',{patterns:[{urlPattern:`${ORIGIN}/*`,requestStage:'Request'}]});
await send('Page.addScriptToEvaluateOnNewDocument',{source:PROBE});
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
if(BOOTSTRAP){await send('Page.navigate',{url:BOOTSTRAP});await sleep(3500)}
try{localStorage}catch{}
await send('Page.navigate',{url:`${TARGET}/#pbecast`});
const evalv=async e=>(await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result.value;
/* make sure the fixture game is the focused one */
for(let i=0;i<40;i++){if(await evalv(`!!document.querySelector('.pbecast6 .cast6-score')`))break;await sleep(500)}
await evalv(`window.PBEcastV6&&window.PBEcastV6.focus('401872657')`);
await sleep(9000);                                   // phase A: normal play
const mark=async()=>evalv('Date.now()');
const tA=await mark();
phase='B';const tB=await mark();
await sleep(8000);
const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(join(OUT,name),Buffer.from(r.data,'base64'))};
await evalv(`document.querySelector('.cast6-action-grid')?.scrollIntoView({block:'center'})`);await sleep(400);
await shot('timeout-break-1440.png');
await sleep(Math.max(0,PHASE_B_MS/2-8400));
await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
await sleep(900);
await evalv(`document.querySelector('.cast6-current')?.scrollIntoView({block:'center'})`);await sleep(400);
await shot('timeout-break-390.png');
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
await sleep(Math.max(0,PHASE_B_MS/2-1700));
phase='C';const tC=await mark();
await sleep(9000);
const T=await evalv(`(()=>{const T=window.__tb;return {rootRemovals:T.rootRemovals,loading:T.loading,samples:T.samples,fetches:T.fetches,rootStillSame:T.root===document.querySelector('.pbecast6')}})()`);

/* ---- verdicts ------------------------------------------------------------- */
const S=T.samples;
const inB=S.filter(s=>s.t>=tB&&s.t<tC),afterC=S.filter(s=>s.t>=tC),beforeB=S.filter(s=>s.t>=tA-4000&&s.t<tB);
const firstBreak=inB.find(s=>s.break);
const entriesDuringB=inB.length?Math.max(...inB.map(s=>s.entries))-(beforeB.at(-1)?.entries??0):0;
const creativesSeen=[...new Set(inB.map(s=>s.creative).filter(Boolean))];
const rotations=inB.length?Math.max(...inB.map(s=>s.rotations)):0;
const killed=afterC.find(s=>!s.break&&s.curType===PLAY.C.type);
const reEntered=afterC.filter(s=>s.t>(killed?.t||Infinity)).some(s=>s.break);
const stateFetchesB=T.fetches.filter(f=>f.t>=tB&&f.t<tC&&f.layer==='state').length;
const liveFetchesB=T.fetches.filter(f=>f.t>=tB&&f.t<tC&&f.layer==='live').length;
const secs=(tC-tB)/1000;
const clockSec=c=>{const m=/(\d+):(\d{2})/.exec(c||'');return m?Number(m[1])*60+Number(m[2]):null};
const clocks=S.filter(s=>s.t>=tA-4000).map(s=>clockSec(s.clock)).filter(v=>v!=null);
const backward=clocks.some((v,i)=>i&&v>clocks[i-1]);
const statusOk=inB.filter(s=>s.break).every(s=>/OFFICIAL TIMEOUT · PBE TIMEOUT BREAK/.test(s.status||''));
const scoreVisible=inB.every(s=>s.score&&s.clock);
const crossfade=inB.some(s=>s.leaving);

const checks=[
  ['break enters on the Official Timeout',!!firstBreak,firstBreak?`after ${((firstBreak.t-tB)/1000).toFixed(1)}s`:'never'],
  ['break entered exactly once for one timeout id',entriesDuringB===1,`entries=${entriesDuringB} over ${stateFetchesB} state polls`],
  ['no restart while the timeout stays current (>=18 polls)',stateFetchesB>=18&&entriesDuringB===1,`${stateFetchesB} state polls, ${liveFetchesB} live polls`],
  ['rotates first-party creatives in a long timeout',rotations>=2&&creativesSeen.length>=2,`rotations=${rotations} creatives=${creativesSeen.join(',')}`],
  ['rotation crossfades (leaving + entering layers)',crossfade,crossfade?'observed':'not observed'],
  ['status reads OFFICIAL TIMEOUT · PBE TIMEOUT BREAK',statusOk,''],
  ['scoreboard stays visible through the break',scoreVisible,''],
  ['new play removes the break immediately',!!killed&&(killed.t-tC)<=4500,killed?`${((killed.t-tC)/1000).toFixed(1)}s after the snap reached the feed`:'never'],
  ['break never re-enters after the new play',!reEntered,''],
  ['zero .pbecast6 root swaps',T.rootRemovals===0&&T.rootStillSame,`removals=${T.rootRemovals}`],
  ['zero loading screens after first paint',T.loading===0,`loading samples=${T.loading}`],
  ['no duplicate polling loops',stateFetchesB<=Math.ceil(secs/2)+3&&liveFetchesB<=Math.ceil(secs/3)+3,`state ${stateFetchesB}/${Math.ceil(secs/2)} expected, live ${liveFetchesB}/${Math.ceil(secs/3)} expected`],
  ['no backward game clock',!backward,`${clocks.length} clock samples`],
  ['no page exceptions',exceptions.length===0,exceptions.slice(0,2).join(' | ')],
];
let fail=0;
for(const [name,ok,detail] of checks){if(!ok)fail++;console.log(`${ok?'PASS':'FAIL'}  ${name}${detail?`  (${detail})`:''}`)}
writeFileSync(join(OUT,'timeout-gate.json'),JSON.stringify({target:TARGET,local:LOCAL,checks,creativesSeen,rotations,secs},null,1));
console.log(fail?`\n${fail} FAILED`:'\nCLEAN — PBE TIMEOUT BREAK behaves.');
finish(fail?1:0);
