/* PBEcast page-flow + Game Pulse acceptance gate. Finite by construction.
 *
 * Mounts #pbecast in headless Chrome (working tree served at the production
 * origin, or the deployed site with PBE_GATE_LIVE=1), focuses each requested
 * game and asserts, at every width:
 *
 *   NESTED SCROLL   no element inside .pbecast6 scrolls vertically; the
 *                   document is the only vertical scroller (collapsed and
 *                   with a drive expanded).
 *   CLIPPING        no element hides vertical content behind overflow hidden.
 *   PAGE OVERFLOW   documentElement.scrollWidth <= clientWidth.
 *   GAME PULSE      present for live and final games with a valid series,
 *                   absent for scheduled games; in-page fail-closed cases;
 *                   a tapped swing opens and focuses its Key Moment.
 *   POLLING         no request initiated from pbecast-pulse-v1.js and no
 *                   timer armed from it; per-lane request counts over one
 *                   bounded quiet window on the first game, for comparison.
 *
 * PBEcast polls continuously, so nothing here waits for network idle or for a
 * live game to change. Every wait is a bounded poll with a named timeout, and
 * the whole run has a hard ceiling (PBE_GATE_CEILING_S, default 120) that
 * closes Chrome, kills its process tree and exits 3 naming the phase it was in.
 * A game whose state cannot be observed in its bound is reported UNAVAILABLE
 * and fails the gate; it never hangs it.
 *
 * node scripts/pbecast-pulse-gate.mjs --games=401872931:live,401872923:final,401872932:scheduled@20260917 [--widths=1440,390] [--window=15]
 *   label is live|final|scheduled (the expected state); @YYYYMMDD moves v6's
 *   board lane to that slate first so a later day's game can be focused.
 *   PBE_GATE_LIVE=1        measure the deployed site instead of the working tree
 *   PBE_GATE_LOCAL_API=1   answer /api/nfl-live from this checkout's handler
 *   PBE_GATE_OUT=dir       screenshots + JSON report
 */
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,extname} from 'node:path';

const REPO=process.cwd();
const TARGET=process.env.PBE_GATE_TARGET||'https://nfl.propbetedge.ai';
const ORIGIN=new URL(TARGET).origin;
const LIVE=process.env.PBE_GATE_LIVE==='1';
const LOCAL_API=process.env.PBE_GATE_LOCAL_API==='1';
const arg=k=>process.argv.find(a=>a.startsWith(`--${k}=`))?.slice(k.length+3);
const GAMES=(arg('games')||'').split(',').filter(Boolean).map(x=>{const [id,rest]=x.split(':');const [label,date]=String(rest||'').split('@');return{id,label:label||id,date:date||null}});
const WIDTHS=(arg('widths')||'1440,390').split(',').map(Number);
const WINDOW_S=Number(arg('window')||15);
/* --feed: FULL GAME LOG collapse checks on the first game (a second game in
   --games is used for the switch check). Run one width per invocation to stay
   inside the ceiling. */
const FEED=process.argv.includes('--feed');
const CEILING_S=Number(process.env.PBE_GATE_CEILING_S||120);
const OUT=process.env.PBE_GATE_OUT||join(REPO,'.gate','pbecast-pulse');
const LABEL=process.env.PBE_GATE_LABEL||(LIVE?'deployed':'tree');
const CHROME=process.env.PBE_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT=9760+Math.floor(Math.random()*90);
const T0=Date.now();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const elapsed=()=>`${((Date.now()-T0)/1000).toFixed(1)}s`;
if(!GAMES.length){console.error('usage: --games=id:live,id:final,id:scheduled@YYYYMMDD');process.exit(2)}
mkdirSync(OUT,{recursive:true});

let phase='launch';
const dir=mkdtempSync(join(tmpdir(),'pbe-pulse-'));
const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'--headless=new','--no-first-run','--disable-extensions','--disable-background-timer-throttling','about:blank'],{stdio:'ignore'});
let ws=null,finishing=false;
async function finish(code){
  if(finishing)return;finishing=true;
  try{if(ws?.readyState===1){ws.send(JSON.stringify({id:999999,method:'Browser.close'}));await sleep(400)}}catch{}
  try{ws?.close()}catch{}
  /* chrome.kill() only reaches the browser process; take the whole tree */
  if(chrome.pid&&chrome.exitCode===null){
    if(process.platform==='win32')spawnSync('taskkill',['/PID',String(chrome.pid),'/T','/F'],{stdio:'ignore'});
    else try{process.kill(-chrome.pid)}catch{try{chrome.kill('SIGKILL')}catch{}}
  }
  for(let i=0;i<10;i++){try{rmSync(dir,{recursive:true,force:true});break}catch{await sleep(200)}}
  process.exit(code);
}
setTimeout(()=>{console.error(`CEILING ${CEILING_S}s exceeded in phase: ${phase}`);finish(3)},CEILING_S*1000).unref?.();

const handler=LOCAL_API?(await import('../api/nfl-live.js')).default:null;
function localApi(url){
  const query=Object.fromEntries(new URL(url).searchParams);
  return Promise.race([
    new Promise(resolve=>{const res={statusCode:200,setHeader(){},end:body=>resolve({status:res.statusCode,body:Buffer.from(body||'')})};handler({method:'GET',query},res)}),
    sleep(15000).then(()=>({status:504,body:Buffer.from('{"ok":false,"error":"local_api_timeout"}')}))
  ]);
}

phase='devtools';
async function wsUrl(){const until=Date.now()+15000;while(Date.now()<until){try{const l=await(await fetch(`http://127.0.0.1:${PORT}/json/list`,{signal:AbortSignal.timeout(1000)})).json();const p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl}catch{}await sleep(200)}throw new Error('devtools unreachable within 15s')}
try{ws=new WebSocket(await wsUrl());await Promise.race([new Promise(r=>{ws.onopen=r}),sleep(5000).then(()=>{throw new Error('devtools websocket did not open within 5s')})])}
catch(e){console.error(`FAIL ${phase}: ${e.message}`);await finish(3)}

let seq=1;const pending=new Map();
/* every CDP command is bounded too */
const send=(m,p={},ms=10000)=>{const n=seq++;ws.send(JSON.stringify({id:n,method:m,params:p}));return Promise.race([new Promise((res,rej)=>pending.set(n,{resolve:res,reject:rej})),sleep(ms).then(()=>{pending.delete(n);throw new Error(`CDP ${m} timed out after ${ms}ms`)})])};
const MIME={'.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8'};
function localFile(url){
  if(LIVE)return null;
  let u;try{u=new URL(url)}catch{return null}
  if(u.origin!==ORIGIN||u.pathname.startsWith('/api/'))return null;
  const rel=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname.slice(1));
  if(!rel||rel.includes('..')||!MIME[extname(rel)])return null;
  const fp=join(REPO,rel);
  try{if(!existsSync(fp)||!statSync(fp).isFile())return null;return{body:readFileSync(fp),type:MIME[extname(rel)]}}catch{return null}
}
const requests=[],exceptions=[];
ws.onmessage=async ev=>{
  const m=JSON.parse(ev.data);
  if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return}
  if(m.method==='Fetch.requestPaused'){
    const url=m.params.request.url,rid=m.params.requestId;
    const l=localFile(url);
    if(l)return send('Fetch.fulfillRequest',{requestId:rid,responseCode:200,responseHeaders:[{name:'content-type',value:l.type},{name:'cache-control',value:'no-store'}],body:l.body.toString('base64')}).catch(()=>{});
    if(LOCAL_API&&url.startsWith(`${ORIGIN}/api/nfl-live`)){
      const r=await localApi(url).catch(e=>({status:503,body:Buffer.from(JSON.stringify({ok:false,error:String(e)}))}));
      return send('Fetch.fulfillRequest',{requestId:rid,responseCode:r.status,responseHeaders:[{name:'content-type',value:'application/json; charset=utf-8'},{name:'cache-control',value:'no-store'}],body:r.body.toString('base64')}).catch(()=>{});
    }
    return send('Fetch.continueRequest',{requestId:rid}).catch(()=>{});
  }
  if(m.method==='Network.requestWillBeSent'){
    const r=m.params.request;if(/^data:|^blob:/.test(r.url))return;
    const frames=[];for(let s=m.params.initiator?.stack;s;s=s.parent)for(const f of s.callFrames||[])frames.push(f);
    /* with async stack depth enabled, a request scheduled from a click handler
       still carries toggleFeed in its initiator chain */
    requests.push({t:Date.now(),url:r.url,frames:frames.slice(0,8).map(f=>`${f.functionName||'(anon)'}@${String(f.url).split('/').pop()}:${f.lineNumber}`),fromPulse:frames.some(f=>/pbecast-pulse/.test(f.url)),fromToggle:frames.some(f=>f.functionName==='toggleFeed')});
  }
  if(m.method==='Runtime.exceptionThrown'){const d=m.params.exceptionDetails;exceptions.push({text:String(d?.exception?.description||d?.text||'').slice(0,240),url:d?.url||''})}
};

/* Each width starts clean: v6 restores the last focused game from
   localStorage, and the previous width's last game (a scheduled one from
   another day) would otherwise race the board lane on mount. */
const PROBE=`(()=>{try{localStorage.removeItem('pbe_nfl_cast_active_v6')}catch(e){}
  const T=window.__pulseTimers={timeout:0,interval:0,raf:0};
  const from=()=>/pbecast-pulse/.test(new Error().stack||'');
  const st=window.setTimeout,si=window.setInterval,ra=window.requestAnimationFrame;
  window.setTimeout=function(){if(from())T.timeout++;return st.apply(this,arguments)};
  window.setInterval=function(){if(from())T.interval++;return si.apply(this,arguments)};
  if(ra)window.requestAnimationFrame=function(){if(from())T.raf++;return ra.apply(this,arguments)};})();`;

const evalIn=async(expr,ms=5000)=>{
  try{const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true},ms);if(r.exceptionDetails)return{__error:r.exceptionDetails.exception?.description||r.exceptionDetails.text};return r.result?.value}
  catch(e){return{__error:e.message}}
};
/* The only way this gate waits on page state: a bounded poll. */
async function waitFor(what,expr,ms){
  const until=Date.now()+ms;let last;
  while(Date.now()<until){last=await evalIn(expr,Math.min(4000,Math.max(500,until-Date.now())));if(last&&!last.__error)return{ok:true,value:last};await sleep(250)}
  return{ok:false,error:`timed out after ${ms}ms waiting for ${what}${last?.__error?` (last error: ${String(last.__error).slice(0,120)})`:''}`};
}

const results=[];let failures=0;
const check=(scope,name,ok,detail)=>{results.push({scope,name,ok:!!ok,detail});if(!ok)failures++;console.log(`${ok?'PASS':'FAIL'} [${scope}] ${name}${detail!==undefined?` ${typeof detail==='string'?detail:JSON.stringify(detail)}`:''}`)};

const MEASURE=`(()=>{
  const root=document.querySelector('.pbecast6');if(!root)return null;
  const name=el=>el.tagName.toLowerCase()+(typeof el.className==='string'&&el.className.trim()?'.'+el.className.trim().split(/\\s+/).slice(0,2).join('.'):'')+(el.dataset&&el.dataset.pbeccCast?'[data-pbecc-cast='+el.dataset.pbeccCast+']':'');
  const nested=[],clipped=[],capped=[];let hscroll=0;
  for(const el of root.querySelectorAll('*')){
    const cs=getComputedStyle(el),oy=cs.overflowY,ox=cs.overflowX;
    if((oy==='auto'||oy==='scroll')&&el.scrollHeight>el.clientHeight+1)nested.push({el:name(el),client:el.clientHeight,scroll:el.scrollHeight});
    if((oy==='hidden'||oy==='clip')&&el.clientHeight>0&&el.scrollHeight>el.clientHeight+1&&cs.whiteSpace!=='nowrap'&&cs.textOverflow!=='ellipsis')clipped.push({el:name(el),client:el.clientHeight,scroll:el.scrollHeight});
    if(cs.maxHeight!=='none'&&el.getBoundingClientRect().height>60)capped.push({el:name(el),maxHeight:cs.maxHeight});
    if((ox==='auto'||ox==='scroll')&&el.scrollWidth>el.clientWidth+1)hscroll++;
  }
  const de=document.documentElement,pulse=root.querySelector('.pbepulse'),s=PBEcastV6.state;
  return{nested,clipped,capped,hscroll,feed:(()=>{const b=root.querySelector('[data-feed-toggle]');return b?{expanded:b.getAttribute('aria-expanded'),game:String(s.activeId),rows:root.querySelectorAll('#cast6-feed-plays .cast6-play').length}:null})(),page:{scrollWidth:de.scrollWidth,clientWidth:de.clientWidth,scrollHeight:de.scrollHeight},
    pulse:pulse?{kind:pulse.classList.contains('is-final')?'final':'live',text:pulse.innerText.replace(/\\s+/g,' ').slice(0,420),head:(pulse.querySelector('header')||{}).innerText||'',foot:(pulse.querySelector('.pbepulse-foot')||{}).innerText||'',all:pulse.innerText,swings:pulse.querySelectorAll('[data-pulse-play]').length,top:Math.round(pulse.getBoundingClientRect().top+scrollY),height:Math.round(pulse.getBoundingClientRect().height)}:null,
    facts:[...root.querySelectorAll('.cast6-facts>div,.cast6-telemetry-grid>div')].map(d=>{const k=d.querySelector('span'),v=d.querySelector('b');return[k?k.innerText.trim():'',v?v.innerText.trim():'']}),
    heroTop:Math.round((root.querySelector('[data-cast6-hero]')||root).getBoundingClientRect().top+scrollY),
    sit:(()=>{const g=s.detail&&s.detail.game||{},t=g.situation||{},f=(s.fastGame&&String(s.fastGame.id)===String(g.id)&&s.fastGame.situation)||{};return{possession_id:t.possession_id??null,possession_text:t.possession_text??null,yard_line:t.yard_line??null,published_spot:PBEcastV6.fieldPositionText?PBEcastV6.fieldPositionText(s.fastGame):null,published_raw:f.possession_text??null,fast_same_moment:!!(s.fastGame&&s.fastGame.status&&g.status&&s.fastGame.status.period===g.status.period&&s.fastGame.status.clock===g.status.clock),away:g.teams&&g.teams.away&&g.teams.away.abbreviation,home:g.teams&&g.teams.home&&g.teams.home.abbreviation}})(),
    order:[...root.children].map(c=>c.dataset.pbeccCast||Object.keys(c.dataset).find(k=>k.startsWith('cast6'))||c.id).filter(Boolean),
    wp:(s.detail&&Array.isArray(s.detail.win_probability))?s.detail.win_probability.length:0};
})()`;
/* the in-page fail-closed cases run the shipped module against the live state */
const FAIL_CLOSED=`(()=>{const P=window.PBEcastPulse,s=PBEcastV6.state,d=s.detail;if(!P||!d)return null;
  const host=document.createElement('div');host.dataset.sig='x';
  const run=det=>{P.mount(host,{activeId:s.activeId,detail:det});return host.innerHTML.trim()};
  return{empty:run({...d,win_probability:[]}),missing:run({...d,win_probability:undefined}),malformed:run({...d,win_probability:[{play_id:'1',home_win_percentage:'x'},{play_id:'2',home_win_percentage:4}]}),
    otherGame:(P.mount(host,{activeId:'0',detail:d}),host.innerHTML.trim()),
    scheduled:run({...d,source:{...(d.source||{}),semantics:'SCHEDULE'},game:{...d.game,status:{...(d.game.status||{}),semantics:'SCHEDULE'}}})};
})()`;

async function shot(file){
  const r=await send('Page.captureScreenshot',{format:'png'},15000).catch(e=>({error:e.message}));
  if(r?.data)writeFileSync(join(OUT,file),Buffer.from(r.data,'base64'));
}

/* ---- FULL GAME LOG ---------------------------------------------------------- */
const FEED_STATE=`(()=>{const mod=document.querySelector('.pbecast6 .cast6-feed');if(!mod)return null;
  const b=mod.querySelector('[data-feed-toggle]'),l=b&&document.getElementById(b.getAttribute('aria-controls'));
  const d=PBEcastV6.state.detail||{},cs=l?getComputedStyle(l):null,a=document.activeElement;
  return{expanded:b?b.getAttribute('aria-expanded'):null,controls:!!l,isButton:!!b&&b.tagName==='BUTTON',listShown:!!(l&&l.offsetParent!==null),hiddenAttr:!!(l&&l.hidden),
    rows:l?l.querySelectorAll('.cast6-play').length:0,plays:(d.plays||[]).length,count:((mod.querySelector('[data-feed-count]')||{}).textContent||'').trim(),
    label:b?b.textContent.replace(/\\s+/g,' ').trim():'',focusKey:a&&a.getAttribute?a.getAttribute('data-focus-key'):null,outline:b?getComputedStyle(b).outlineStyle:'',
    listOverflowY:cs?cs.overflowY:'',listMaxH:cs?cs.maxHeight:'',docH:document.documentElement.scrollHeight,top:Math.round(mod.getBoundingClientRect().top+scrollY),game:String(PBEcastV6.state.activeId)}})()`;
function laneCounts(win){const lanes={};for(const r of win){let k;try{const u=new URL(r.url);k=u.pathname==='/api/nfl-live'?`nfl-live:${u.searchParams.get('layer')||(u.searchParams.get('event')?'detail':'board')}`:(u.host.endsWith('propbetedge.ai')?u.host.split('.')[0]+u.pathname:'media')}catch{k='other'}lanes[k]=(lanes[k]||0)+1}return lanes}
async function pressKey(k){
  const def=k==='Enter'?{key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'}:{key:' ',code:'Space',windowsVirtualKeyCode:32,text:' '};
  await send('Input.dispatchKeyEvent',{type:'keyDown',...def});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:def.key,code:def.code,windowsVirtualKeyCode:def.windowsVirtualKeyCode});
}
async function feedChecks(scope,width,g){
  const file=`${LABEL}-${g.label}-${width}`;
  phase=`${scope} log default`;
  /* v6 paints the detail package after its market read, so the DOM can lag
     state by one await; wait (bounded) for the painted log to match state */
  const painted=await waitFor('the painted log to match state',`(()=>{const d=PBEcastV6.state.detail||{},n=(d.plays||[]).length,l=document.getElementById('cast6-feed-plays');return n>0&&l&&l.querySelectorAll('.cast6-play').length===n?n:null})()`,15000);
  if(!painted.ok)check(scope,'log: painted play history matches state',false,painted.error);
  const f0=await evalIn(FEED_STATE);
  if(!f0||f0.__error){check(scope,'FULL GAME LOG module present',false,f0?.__error||'missing');return}
  check(scope,'log: collapsed by default, header + count + real button with aria-controls',f0.expanded==='false'&&f0.isButton&&f0.controls&&f0.hiddenAttr&&!f0.listShown&&/^Show plays/.test(f0.label)&&f0.count.startsWith(`${f0.plays} published plays`),{expanded:f0.expanded,label:f0.label,count:f0.count});
  check(scope,'log: already-loaded history is in the DOM while collapsed',f0.rows===f0.plays,{rows:f0.rows,plays:f0.plays});
  await evalIn(`scrollTo(0,${Math.max(0,f0.top-80)})`);await sleep(300);await shot(`${file}-log-collapsed.png`);

  phase=`${scope} log expand`;
  const r0=requests.length;
  await evalIn(`document.querySelector('.pbecast6 [data-feed-toggle]').click()`);
  const f1=await evalIn(FEED_STATE);
  check(scope,'log: button expands immediately; list grows the document; no internal scroll or cap',f1.expanded==='true'&&f1.listShown&&!f1.hiddenAttr&&/^Hide plays/.test(f1.label)&&f1.rows===f1.plays&&!['auto','scroll','hidden','clip'].includes(f1.listOverflowY)&&f1.listMaxH==='none'&&f1.docH>f0.docH,{expanded:f1.expanded,label:f1.label,overflowY:f1.listOverflowY,maxHeight:f1.listMaxH,docHeight:`${f0.docH} -> ${f1.docH}`});
  await evalIn(`scrollTo(0,${Math.max(0,f1.top-80)})`);await sleep(300);await shot(`${file}-log-expanded.png`);

  phase=`${scope} log header click`;
  await evalIn(`document.querySelector('.pbecast6 .cast6-feed>header h2').click()`);
  const f2=await evalIn(FEED_STATE);
  check(scope,'log: clicking the header collapses it',f2.expanded==='false'&&!f2.listShown,f2.expanded);

  phase=`${scope} log keyboard`;
  await evalIn(`document.querySelector('.pbecast6 [data-feed-toggle]').focus({focusVisible:true})`);
  await pressKey('Enter');
  const f3=await evalIn(FEED_STATE);
  check(scope,'log: Enter on the focused button expands; focus stays; visible focus ring',f3.expanded==='true'&&f3.listShown&&f3.focusKey==='feed-toggle'&&f3.outline==='solid',{expanded:f3.expanded,focus:f3.focusKey,outline:f3.outline});
  await pressKey(' ');
  const f4=await evalIn(FEED_STATE);
  check(scope,'log: Space toggles it back',f4.expanded==='false',f4.expanded);
  await pressKey('Enter');

  /* A real polling re-render: invalidate the workspace signature and wait for
     v6's own lanes to rewrite it. The gate triggers no fetch here. */
  phase=`${scope} log survives polling`;
  await evalIn(`document.querySelector('.pbecast6 [data-cast6-workspace]').dataset.sig='__gate_stale__'`);
  const rer=await waitFor('a polling cycle to re-render the workspace',`document.querySelector('.pbecast6 [data-cast6-workspace]').dataset.sig!=='__gate_stale__'||null`,25000);
  const f5=await evalIn(FEED_STATE);
  check(scope,'log: expanded state and keyboard focus survive a polling re-render',rer.ok&&f5.expanded==='true'&&f5.listShown&&f5.focusKey==='feed-toggle'&&f5.rows===f5.plays,rer.ok?{expanded:f5.expanded,focus:f5.focusKey}:rer.error);

  phase=`${scope} log request proof`;
  const a0=Date.now();await sleep(WINDOW_S*1000);const a1=Date.now();
  const toggles=Math.max(2,Math.floor(WINDOW_S*1000/400));
  const b0=Date.now();
  for(let i=0;i<toggles;i++){await evalIn(`document.querySelector('.pbecast6 [data-feed-toggle]').click()`);await sleep(400)}
  const b1=Date.now();
  const idle=laneCounts(requests.filter(r=>r.t>=a0&&r.t<a1)),toggling=laneCounts(requests.filter(r=>r.t>=b0&&r.t<b1));
  const fromToggle=requests.slice(r0).filter(r=>r.fromToggle);
  check(scope,`log: ${toggles+4} toggles initiated 0 requests (initiator stacks incl. async)`,!fromToggle.length,fromToggle.map(r=>r.url).slice(0,3));
  /* Every PBEcast request while toggling must trace to a lane timer
     (syncState/syncLive/syncDetail/syncBoard) and none to the toggle. Lane
     counts per window are reported, not compared: with 15-30s cadences a tick
     falling either side of a window edge moves a count by one or two. */
  const castReqs=requests.filter(r=>r.t>=b0&&r.t<b1&&/\/api\/nfl-live\?(event|date)=/.test(r.url)&&r.frames.some(f=>/pbecast-v6/.test(f)));
  const offLane=castReqs.filter(r=>!r.frames.some(f=>/^sync(State|Live|Detail|Board)@/.test(f))||r.fromToggle);
  check(scope,`log: while toggling for ${WINDOW_S}s every PBEcast request came from its lane timer (${castReqs.length} requests)`,castReqs.length>0&&!offLane.length,{offLane:offLane.map(r=>({url:r.url,frames:r.frames.slice(0,4)})),idle,toggling});
  const f6=await evalIn(FEED_STATE);
  if(f6.expanded==='false')await evalIn(`document.querySelector('.pbecast6 [data-feed-toggle]').click()`);

  const other=GAMES.find(x=>x.id!==g.id);
  if(other){
    phase=`${scope} log game switch`;
    await evalIn(`(()=>{${other.date?`PBEcastV6.state.date=${JSON.stringify(other.date)};`:''}PBEcastV6.focus(${JSON.stringify(other.id)});return true})()`);
    const sw=await waitFor(`${other.id} painted`,`(()=>{const d=PBEcastV6.state.detail;return d&&d.game&&String(d.game.id)===${JSON.stringify(other.id)}&&Array.isArray(d.win_probability)&&document.querySelector('.pbecast6 .cast6-feed')?true:null})()`,20000);
    const f7=sw.ok?await evalIn(FEED_STATE):null;
    check(scope,'log: another game starts collapsed',sw.ok&&f7.expanded==='false'&&f7.game===other.id,sw.ok?f7.expanded:sw.error);
    await evalIn(`(()=>{PBEcastV6.focus(${JSON.stringify(g.id)});return true})()`);
    const back=await waitFor(`${g.id} painted again`,`(()=>{const d=PBEcastV6.state.detail;return d&&d.game&&String(d.game.id)===${JSON.stringify(g.id)}&&Array.isArray(d.win_probability)&&document.querySelector('.pbecast6 .cast6-feed')?true:null})()`,20000);
    const f8=back.ok?await evalIn(FEED_STATE):null;
    check(scope,'log: returning to the game keeps its expanded choice (in memory)',back.ok&&f8.expanded==='true',back.ok?f8.expanded:back.error);
  }
  const trace=(a,b)=>requests.filter(r=>r.t>=a&&r.t<b&&/nfl-live/.test(r.url)).map(r=>({dt:r.t-a,url:r.url.replace(/^https?:\/\/[^/]+/,''),frames:r.frames}));
  report.feed=report.feed||[];report.feed.push({width,game:g.id,default:f0,expanded:f1,idle,toggling,toggles,idleTrace:trace(a0,a1),togglingTrace:trace(b0,b1)});
}

const report={target:TARGET,deployed:LIVE,localApi:LOCAL_API,windowSeconds:WINDOW_S,ceilingSeconds:CEILING_S,runs:[]};
try{
  phase='cdp-setup';
  await send('Runtime.enable');await send('Page.enable');await send('Network.enable');
  if(FEED){await send('Debugger.enable');await send('Debugger.setAsyncCallStackDepth',{maxDepth:32})}
  await send('Fetch.enable',{patterns:[{urlPattern:`${ORIGIN}/*`,requestStage:'Request'}]});
  await send('Page.addScriptToEvaluateOnNewDocument',{source:PROBE});

  for(const width of WIDTHS){
    const scopeW=`${width}px`;
    phase=`${scopeW} mount`;
    await send('Emulation.setDeviceMetricsOverride',{width,height:width<600?844:900,deviceScaleFactor:1,mobile:width<600});
    await send('Page.navigate',{url:'about:blank'});
    await send('Page.navigate',{url:`${TARGET}/#pbecast`});
    const mounted=await waitFor('PBEcast v6 to mount with a game package',`!!(window.PBEcastV6&&PBEcastV6.state.detail&&PBEcastV6.state.detail.game&&document.querySelector('.pbecast6'))||null`,25000);
    check(scopeW,'PBEcast mounted',mounted.ok,mounted.ok?`at ${elapsed()}`:mounted.error);
    if(!mounted.ok)continue;
    await evalIn(`(()=>{const c=document.createElement('style');c.textContent='html,body{scroll-behavior:auto!important}';document.head.appendChild(c);return true})()`);

    for(const [gi,g] of GAMES.entries()){
      const scope=`${width}px ${g.label}`;
      phase=`${scope} focus`;
      await evalIn(`(()=>{${g.date?`PBEcastV6.state.date=${JSON.stringify(g.date)};`:''}PBEcastV6.focus(${JSON.stringify(g.id)});return true})()`);
      const expect=g.label==='live'?'LIVE':g.label==='final'?'FINAL':g.label==='scheduled'?'SCHEDULE':null;
      /* the fast lane paints the game within ~2s but carries no win
         probability; wait for the detail lane's payload (array, maybe empty).
         Bound: one detail cadence (12s while live) plus a fetch. */
      const focused=await waitFor(`${g.id} detail-lane payload`,`(()=>{const d=PBEcastV6.state.detail;return d&&d.game&&String(d.game.id)===${JSON.stringify(g.id)}&&Array.isArray(d.win_probability)&&d.source&&d.source.semantics?String(d.source.semantics):null})()`,20000);
      if(!focused.ok){check(scope,`fixture UNAVAILABLE: game ${g.id} not observed`,false,focused.error);continue}
      const sem=focused.value;
      if(expect&&sem!==expect){check(scope,`fixture UNAVAILABLE: game ${g.id} is ${sem}, not ${expect}`,false);continue}

      phase=`${scope} pulse`;
      const wantPulse=sem==='LIVE'||sem==='FINAL';
      const validWp=await evalIn(`(()=>{const d=PBEcastV6.state.detail;return (d.win_probability||[]).filter(r=>Number.isFinite(Number(r&&r.home_win_percentage))&&r.home_win_percentage!==null&&r.home_win_percentage>=0&&r.home_win_percentage<=1).length})()`);
      if(wantPulse&&validWp>0){
        const w=await waitFor('.pbepulse to render',`document.querySelector('.pbecast6 [data-pbecc-cast=pulse] .pbepulse')?true:null`,6000);
        check(scope,'Game Pulse renders from v6 win_probability',w.ok,w.ok?`${validWp} observations`:w.error);
      }else if(wantPulse){
        check(scope,'win_probability not yet published: Game Pulse stays hidden',!(await evalIn(`!!document.querySelector('.pbepulse')`)),`${validWp} valid observations`);
      }
      const m=await evalIn(MEASURE,8000);
      if(!m||m.__error){check(scope,'measure',false,m?.__error||'no .pbecast6');continue}
      if(sem==='SCHEDULE')check(scope,'scheduled game: no Game Pulse, no probability',!m.pulse);
      if(sem==='FINAL'&&m.pulse)check(scope,'final game: Game Pulse is part of PBE Replay',m.pulse.kind==='final'&&/PBE REPLAY/.test(m.pulse.head));
      if(m.pulse){
        const iPulse=m.order.indexOf('pulse'),iMoments=m.order.indexOf('moments'),iAction=m.order.indexOf('cast6Action');
        check(scope,'order: selected game -> Game Pulse -> Key Moments',iAction>=0&&iAction<iPulse&&iPulse<iMoments,m.order);
        check(scope,'labelled source probability, never a PBE model',/Live win probability/i.test(m.pulse.foot)&&/not a PropBetEdge model/.test(m.pulse.foot)&&!/PBE model|PBE Algo|our prediction|betting edge/i.test(m.pulse.all));
      }
      if(sem==='LIVE'){
        /* field-position semantics on the live fixture: possession is a team,
           field position is published text, the 0-100 coordinate never shows.
           Halftime, timeouts and reviews publish no possession; a check over
           an empty situation proves nothing, so it waits (bounded) for one and
           otherwise reports the state UNAVAILABLE instead of passing. */
        phase=`${scope} live situation`;
        const sitReady=await waitFor('a live situation with possession or field position',`(()=>{const t=(PBEcastV6.state.detail&&PBEcastV6.state.detail.game&&PBEcastV6.state.detail.game.situation)||{};return (t.possession_id!=null&&t.possession_id!=='')||t.possession_text?true:null})()`,20000);
        if(!sitReady.ok){
          const st=await evalIn(`(PBEcastV6.state.detail.game.status||{}).short_detail||''`);
          check(scope,`live situation UNAVAILABLE (${st}): field-position semantics not verified`,false,sitReady.error);
        }else{
        Object.assign(m,await evalIn(MEASURE,8000));
        await sleep(300);
        }
      }
      if(sem==='LIVE'&&m.sit&&(m.sit.possession_id!=null||m.sit.possession_text)){
        const labels=m.facts.map(([k])=>k);
        const bad=m.facts.filter(([k,v])=>k==='BALL'||(k==='POSSESSION'&&!/^[A-Z]{2,4}$/.test(v))||(k==='FIELD POSITION'&&!/^(?:[A-Z]{2,4} (?:[1-9]|[1-4]\d)|50)$/.test(v))||(m.sit.yard_line!=null&&v===String(m.sit.yard_line)&&k!=='PUBLISHED PLAYS'&&k!=='PUBLISHED DRIVES'));
        const hasTeam=m.facts.some(([k])=>k==='POSSESSION');
        /* when the scoreboard lane publishes a verifiable spot for the painted
           moment, FIELD POSITION must show exactly that text */
        const spots=m.facts.filter(([k])=>k==='FIELD POSITION').map(([,v])=>v);
        if(m.sit.published_spot&&m.sit.fast_same_moment)check(scope,`FIELD POSITION shows the published spot (${m.sit.published_spot}, raw coordinate ${m.sit.yard_line})`,spots.length>0&&spots.every(v=>v===m.sit.published_spot),{spots,situation:m.sit});
        check(scope,'facts: POSSESSION is a team, FIELD POSITION is published text, no BALL coordinate',(m.sit.possession_id==null||hasTeam)&&!bad.length&&!labels.includes('BALL'),{facts:m.facts.filter(([k])=>!/PUBLISHED/.test(k)),situation:m.sit,bad});
      }
      const fc=await evalIn(FAIL_CLOSED);
      if(fc&&!fc.__error)check(scope,'fail closed in page: empty / missing / malformed / other game / scheduled render nothing',Object.values(fc).every(v=>v===''),fc);

      if(FEED&&gi===0)await feedChecks(scope,width,g);

      phase=`${scope} expanded`;
      await evalIn(`(()=>{const t=document.querySelector('.pbekm [data-km-tab="drives"]');if(t)t.click();const d=document.querySelector('.pbekm [data-km-drive]');if(d)d.click();const b=document.querySelector('.pbecast6 [data-feed-toggle]');if(b&&b.getAttribute('aria-expanded')==='false')b.click();return true})()`);
      const x=await evalIn(MEASURE,8000);
      const nested=[...(m.nested||[]),...(x?.nested||[])];
      check(scope,'no nested vertical scroller (collapsed + drive and full game log expanded)',!nested.length,nested.slice(0,4));
      check(scope,'no vertical clipping',!(m.clipped?.length||x?.clipped?.length),[...(m.clipped||[]),...(x?.clipped||[])].slice(0,4));
      check(scope,'no max-height cap on a tall PBEcast node',!(x?.capped?.length),(x?.capped||[]).slice(0,4));
      check(scope,'no horizontal page overflow',x&&x.page.scrollWidth<=x.page.clientWidth,{...(x?.page||{}),feed:x?.feed});
      await evalIn(`(()=>{const t=document.querySelector('.pbekm [data-km-tab="scoring"]');if(t)t.click();return true})()`);

      phase=`${scope} screenshots`;
      const file=`${LABEL}-${g.label}-${width}`;
      await evalIn('scrollTo(0,0)');await sleep(250);await shot(`${file}-top.png`);
      await evalIn(`scrollTo(0,${Math.max(0,m.heroTop-70)})`);await sleep(300);await shot(`${file}-hero.png`);
      if(m.pulse){await evalIn(`scrollTo(0,${Math.max(0,m.pulse.top-70)})`);await sleep(350);await shot(`${file}-pulse.png`)}

      let swing=null;
      if(m.pulse&&m.pulse.swings){
        phase=`${scope} swing click`;
        const id=await evalIn(`(()=>{const b=document.querySelector('.pbepulse .pbepulse-swings [data-pulse-play]')||document.querySelector('.pbepulse [data-pulse-play]');b.click();return b.dataset.pulsePlay})()`);
        const w=await waitFor('the swing\'s Key Moment to be focused and in view',`(()=>{const el=document.querySelector('.pbekm [data-km-play="'+CSS.escape(${JSON.stringify(String(id))})+'"]');if(!el||!el.classList.contains('is-focus'))return null;const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight?{tab:(document.querySelector('.pbekm [data-km-tab].is-on')||{}).dataset?.kmTab||null}:null})()`,3000);
        swing={id,...(w.ok?w.value:{error:w.error})};
        check(scope,'tapping a swing focuses its play in Key Moments',w.ok,w.ok?`play ${id} in ${w.value.tab}`:w.error);
        await shot(`${file}-swing-focus.png`);
      }

      /* One bounded quiet window per width, on the first game: which requests
         PBEcast makes while nobody touches it, and whether any came from Game
         Pulse. It is a sample for comparison, not a wait for anything. */
      let window=null;
      if(gi===0){
        phase=`${scope} quiet window ${WINDOW_S}s`;
        await evalIn('scrollTo(0,0)');
        const t0=Date.now();await sleep(WINDOW_S*1000);const t1=Date.now();
        const win=requests.filter(r=>r.t>=t0&&r.t<t1);
        const lanes={};for(const r of win){let k;try{const u=new URL(r.url);k=u.pathname==='/api/nfl-live'?`nfl-live:${u.searchParams.get('layer')||(u.searchParams.get('event')?'detail':'board')}`:(u.host.endsWith('propbetedge.ai')?u.host.split('.')[0]+u.pathname:'media')}catch{k='other'}lanes[k]=(lanes[k]||0)+1}
        window={seconds:WINDOW_S,total:win.length,lanes};
        console.log(`INFO [${scope}] requests in ${WINDOW_S}s quiet window: ${win.length} ${JSON.stringify(lanes)}`);
      }
      report.runs.push({width,game:g,semantics:sem,measure:m,expanded:x,failClosed:fc,swing,window});
    }
    phase=`${scopeW} attribution`;
    const timers=await evalIn('window.__pulseTimers');
    check(scopeW,'no timer armed from pbecast-pulse-v1.js',timers&&!timers.__error&&timers.timeout+timers.interval+timers.raf===0,timers);
    check(scopeW,'no request initiated from pbecast-pulse-v1.js',!requests.some(r=>r.fromPulse),requests.filter(r=>r.fromPulse).map(r=>r.url).slice(0,3));
    requests.length=0;
  }
  const pulseErrors=exceptions.filter(e=>/pbecast-pulse|pbecast-command|pbecast-v6/.test(e.url+e.text));
  check('all','no uncaught exception from PBEcast modules',!pulseErrors.length,pulseErrors.slice(0,3));
}catch(e){
  check('gate',`aborted in phase ${phase}`,false,e.message);
}
report.results=results;report.exceptions=exceptions;report.elapsed=elapsed();
writeFileSync(join(OUT,`${LABEL}.json`),JSON.stringify(report,null,2));
console.log(`\n${failures?'FAIL':'PASS'}  ${results.length-failures}/${results.length} checks  elapsed ${elapsed()}  report ${join(OUT,`${LABEL}.json`)}`);
await finish(failures?1:0);
