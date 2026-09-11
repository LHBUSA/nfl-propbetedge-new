/* PropBetEdge NFL — product-loop gate.
 *
 * Renders routes of THIS working tree in real headless Chrome against the live
 * production APIs (every same-origin static file is substituted from the
 * checkout, exactly like ui-audit.mjs). API routes that exist only in this
 * branch are executed in-process from ./api so a new server contract can be
 * exercised before it is deployed — they call the same live upstreams the
 * deployed function would.
 *
 * Per route x width it records: request count and transfer, console errors,
 * horizontal overflow, broken images, images without intrinsic dimensions,
 * sub-10px text, route-specific assertions, and a screenshot.
 *
 *   node scripts/product-loop-gate.mjs --out <dir> [--routes home,changes]
 *        [--widths 1440,1280,1024,390,360] [--live] [--full]
 *
 *   --live   screenshot deployed production (no substitution) — the baseline
 *   --full   full-page screenshots (default: first 2 viewports of the page)
 *   PBE_TARGET=<origin>  point at a preview instead of production
 *   PBE_GATE_BOOTSTRAP=<share url>  set the preview auth cookie first (use with --live)
 *
 * Exit code 1 when any assertion fails.
 */
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,extname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const REPO=process.cwd();
const TARGET=process.env.PBE_TARGET||'https://nfl.propbetedge.ai';
const ORIGIN=new URL(TARGET).origin;
const PORT=9700+Math.floor(Math.random()*90);
const CHROME=process.env.PBE_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const argv=process.argv.slice(2);
const flag=n=>argv.includes(`--${n}`);
const arg=(n,f)=>{const i=argv.indexOf(`--${n}`);return i>-1&&argv[i+1]&&!argv[i+1].startsWith('--')?argv[i+1]:f};
const LIVE=flag('live');
const FULL=flag('full');
const OUT=resolve(arg('out',join(REPO,'.product-loop')));
const ROUTES=arg('routes','home,changes,bestline,pbecast,pbepicks,trackrecord,propboard,marketwatch,injuries,matchups').split(',').map(s=>s.trim()).filter(Boolean);
const WIDTHS=arg('widths','1440,390').split(',').map(n=>parseInt(n,10));
const HEIGHTS={360:780,390:844,430:932,768:1024,1024:768,1280:800,1440:900};
const SETTLE=Number(arg('settle','7000'));

/* Branch-only API handlers, executed locally. Everything else under /api goes
   to the target untouched. */
const LOCAL_API={
  '/api/nfl-changes':'api/nfl-changes.js',
  '/api/best-line':'api/best-line.js',
  '/api/replay-enrich':'api/replay-enrich.js'
};

mkdirSync(OUT,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dir=mkdtempSync(join(tmpdir(),'pbe-loopgate-'));
const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'--headless=new','--no-first-run',
  '--no-default-browser-check','--disable-extensions','--hide-scrollbars','--force-device-scale-factor=1','about:blank'],{stdio:'ignore'});
function finish(code){try{chrome.kill()}catch{}setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}process.exit(code)},300)}
setTimeout(()=>{console.error('HARD_DEADLINE');finish(3)},1500000).unref?.();

async function wsUrl(){for(let i=0;i<100;i++){try{const l=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl}catch{}await sleep(200)}throw new Error('devtools_unavailable')}
const ws=new WebSocket(await wsUrl());
await new Promise(r=>{ws.onopen=r});
let seq=1;const pending=new Map();
const send=(method,params={})=>{const n=seq++;ws.send(JSON.stringify({id:n,method,params}));return new Promise((res,rej)=>pending.set(n,{res,rej}))};

const MIME={'.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.html':'text/html; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.json':'application/json; charset=utf-8',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml'};
function localFile(url){
  if(LIVE)return null;let u;try{u=new URL(url)}catch{return null}
  if(u.origin!==ORIGIN||u.pathname.startsWith('/api/'))return null;
  const rel=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname.slice(1));
  if(!rel||rel.includes('..')||!MIME[extname(rel)])return null;
  const fp=join(REPO,rel);
  try{if(!existsSync(fp)||!statSync(fp).isFile())return null;return{body:readFileSync(fp),type:MIME[extname(rel)]}}catch{return null}
}
/* Minimal Vercel req/res shim for a branch-only handler. */
async function runLocalApi(url){
  if(LIVE)return null;let u;try{u=new URL(url)}catch{return null}
  if(u.origin!==ORIGIN)return null;const file=LOCAL_API[u.pathname];if(!file)return null;
  const mod=await import(pathToFileURL(resolve(REPO,file)).href);
  const headers={};let status=200;let body='';
  const res={set statusCode(v){status=v},get statusCode(){return status},setHeader(k,v){headers[String(k).toLowerCase()]=String(v)},end(b){body=b==null?'':String(b)}};
  await mod.default({query:Object.fromEntries(u.searchParams),method:'GET',url:u.pathname+u.search,headers:{}},res);
  return{status,headers,body};
}

const state={requests:0,bytes:0,apiCalls:[],errors:[],failed:[]};
ws.onmessage=async ev=>{
  const m=JSON.parse(ev.data);
  if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result);return}
  if(m.method==='Fetch.requestPaused'){
    const url=m.params.request.url;
    try{
      const api=await runLocalApi(url);
      if(api){await send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:api.status,responseHeaders:Object.entries(api.headers).map(([name,value])=>({name,value})),body:Buffer.from(api.body).toString('base64')});return}
      const local=localFile(url);
      if(local){await send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'content-type',value:local.type},{name:'cache-control',value:'no-store'}],body:local.body.toString('base64')});return}
    }catch(e){state.errors.push(`[gate-local-api] ${url} ${e.message}`)}
    send('Fetch.continueRequest',{requestId:m.params.requestId}).catch(()=>{});return;
  }
  if(m.method==='Network.requestWillBeSent'){state.requests++;const u=m.params.request.url;if(/\/api\//.test(u))state.apiCalls.push({t:Date.now(),u:u.replace(/^https?:\/\/[^/]+/,'')})}
  if(m.method==='Network.loadingFinished')state.bytes+=m.params.encodedDataLength||0;
  if(m.method==='Network.loadingFailed'&&!/net::ERR_ABORTED/.test(m.params.errorText))state.failed.push(`${m.params.type} ${m.params.errorText}`);
  if(m.method==='Runtime.exceptionThrown')state.errors.push(String(m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text||'').slice(0,300));
  if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')state.errors.push(m.params.args.map(a=>String(a.value??a.description??'')).join(' ').slice(0,300));
};
await send('Runtime.enable');await send('Page.enable');await send('Network.enable');
await send('Network.setCacheDisabled',{cacheDisabled:true});
await send('Fetch.enable',{patterns:[{urlPattern:`${ORIGIN}/*`,requestStage:'Request'}]});
const evaluate=async(expr,ms=15000)=>{try{const r=await Promise.race([send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true}),sleep(ms).then(()=>{throw new Error('WEDGED')})]);return r.result?.value}catch(e){return{__error:e.message}}};

/* Generic page measurements. */
const MEASURE=`(() => {
  const de=document.documentElement,vw=de.clientWidth,out={};
  out.overflowX=de.scrollWidth-vw;
  const bleed=[];document.querySelectorAll('#view-container *').forEach(el=>{const r=el.getBoundingClientRect();if(!r.width||!r.height)return;if(r.right>vw+2||r.left<-2){if(getComputedStyle(el).position==='fixed')return;let p=el.parentElement,clipped=false;while(p&&p!==document.body){const o=getComputedStyle(p).overflowX;if(o==='auto'||o==='scroll'||o==='hidden'){clipped=true;break}p=p.parentElement}if(!clipped)bleed.push((el.className&&typeof el.className==='string'?el.className.split(' ')[0]:el.tagName)+'@'+Math.round(r.right))}});
  out.bleeders=[...new Set(bleed)].slice(0,8);
  const imgs=[...document.querySelectorAll('#view-container img')];
  out.images=imgs.length;
  out.brokenImages=imgs.filter(i=>i.complete&&i.naturalWidth===0&&i.getAttribute('src')&&!i.classList.contains('image-failed')&&!i.classList.contains('is-broken')&&getComputedStyle(i).display!=='none').map(i=>i.getAttribute('src').slice(0,80)).slice(0,6);
  out.undimensioned=imgs.filter(i=>!i.getAttribute('width')&&!i.getAttribute('height')&&getComputedStyle(i).aspectRatio==='auto').length;
  let tiny=0;const w=document.createTreeWalker(document.getElementById('view-container')||document.body,NodeFilter.SHOW_TEXT);let n;
  while((n=w.nextNode())){const t=n.nodeValue.trim();if(t.length<2)continue;const el=n.parentElement;const r=el.getBoundingClientRect();if(!r.width||!r.height)continue;const cs=getComputedStyle(el);if(cs.visibility==='hidden')continue;if(parseFloat(cs.fontSize)<9.95)tiny++}
  out.sub10Text=tiny;
  let small=0;if(vw<=768){document.querySelectorAll('#view-container button,#view-container a[href],#view-container [role=button]').forEach(el=>{const r=el.getBoundingClientRect();if(!r.width||!r.height)return;if(getComputedStyle(el).visibility==='hidden')return;if(r.height<30||r.width<30)small++})}
  out.smallTargets=small;
  out.height=de.scrollHeight;
  out.textChars=(document.getElementById('view-container')?.innerText||'').length;
  return out;
})()`;

/* Route-specific assertions: each returns {name, ok, detail}. */
const ASSERT={
  home:`(() => {const r=[];const cc=document.querySelector('.pbecc');r.push({name:'command center mounted',ok:!!cc});
    const slate=document.querySelector('.pbecc-slate');r.push({name:'slate renders games or an honest empty state',ok:!!slate&&(slate.querySelectorAll('.pbecc-game').length>0||!!slate.querySelector('.pbecc-empty'))});
    const ch=document.querySelector('.pbecc-changes');r.push({name:'what changed section present',ok:!!ch,detail:ch?.querySelectorAll('.pbecc-change').length+' items'});
    const pk=document.querySelector('.pbecc-picks');r.push({name:'picks section states engine truth',ok:!!pk&&/ENGINE|PICKS|UNAVAILABLE/i.test(pk.innerText)});
    const loop=document.querySelector('.pbecc-loop');r.push({name:'product loop strip present',ok:!!loop&&loop.querySelectorAll('[data-route]').length>=6});
    const hero=document.querySelector('.pbe7-hero');const s=slate?.getBoundingClientRect(),h=hero?.getBoundingClientRect();r.push({name:'slate sits above the featured hero',ok:!!s&&!!h&&s.top<h.top});
    r.push({name:'no manifesto above the fold',ok:!/WE DON.T PUBLISH OPINIONS/i.test(document.querySelector('.pbehome7')?.innerText?.slice(0,800)||'')});
    return r})()`,
  changes:`(() => {const r=[];const root=document.querySelector('.pbewc');r.push({name:'what changed route mounted',ok:!!root});
    const items=[...document.querySelectorAll('.pbewc-item')];r.push({name:'items or honest empty/unavailable state',ok:items.length>0||!!document.querySelector('.pbewc-empty,.pbewc-unavailable')});
    r.push({name:'every item names its source and time',ok:items.every(i=>i.querySelector('.pbewc-src')&&/ET|ago|UTC/.test(i.querySelector('.pbewc-src').innerText)),detail:items.length+' items'});
    return r})()`,
  bestline:`(() => {const r=[];const root=document.querySelector('.pbebl');r.push({name:'best line route mounted',ok:!!root});
    const heads=[...document.querySelectorAll('.pbebl-legend [data-term]')].map(x=>x.dataset.term);r.push({name:'best price / consensus / fair value / edge defined separately',ok:['best','consensus','fair','edge'].every(t=>heads.includes(t))});
    const rows=document.querySelectorAll('.pbebl-row');r.push({name:'rows or honest unavailable state',ok:rows.length>0||!!document.querySelector('.pbebl-unavailable')});
    r.push({name:'snapshot age shown',ok:/UPDATED|CAPTURED|AGE/i.test(root?.querySelector('.pbebl-fresh')?.innerText||'')});
    return r})()`,
  pbecast:`(() => {const r=[];r.push({name:'v6 is the route authority',ok:!!document.querySelector('.pbecast6')});
    r.push({name:'single .pbecast6 root',ok:document.querySelectorAll('.pbecast6').length===1});
    const board=document.querySelector('.pbecast6 .pbecb');r.push({name:'sunday board mounted',ok:!!board,detail:board?board.querySelectorAll('.pbecb-tile').length+' tiles':''});
    r.push({name:'v6 rail superseded by the board (no duplicate game list)',ok:!board||getComputedStyle(document.querySelector('[data-cast6-rail]')).display==='none'});
    r.push({name:'no fabricated tracking geometry',ok:!document.querySelector('[data-player-x],[data-route-path],.cast-route-path')});
    return r})()`
};

async function setViewport(w){await send('Emulation.setDeviceMetricsOverride',{width:w,height:HEIGHTS[w]||900,deviceScaleFactor:1,mobile:w<=768});}
async function shot(file,full){
  const m=await send('Page.getLayoutMetrics');const H=Math.ceil(m.cssContentSize?.height||m.contentSize.height);
  const w=Math.ceil(m.cssLayoutViewport?.clientWidth||m.layoutViewport.clientWidth);
  const clipH=full?Math.min(H,16000):Math.min(H,(m.cssLayoutViewport?.clientHeight||900)*2);
  const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:w,height:clipH,scale:1}});
  writeFileSync(file,Buffer.from(r.data,'base64'));
}

/* A protected preview: visit its share URL once so the auth cookie is set.
   Use the immutable deployment URL, not the branch alias, which rotates. */
if(process.env.PBE_GATE_BOOTSTRAP){await send('Page.navigate',{url:process.env.PBE_GATE_BOOTSTRAP});await sleep(4000);}

const report=[];let failures=0;
for(const width of WIDTHS){
  await setViewport(width);
  for(const route of ROUTES){
    state.requests=0;state.bytes=0;state.apiCalls=[];state.errors=[];state.failed=[];
    const url=`${TARGET}/${route==='home'?'':`#${route}`}`;
    await send('Page.navigate',{url:'about:blank'});await sleep(150);
    await send('Page.navigate',{url});
    await sleep(SETTLE);
    /* --prep runs an expression after the route settles (e.g. focus a game),
       then waits another settle before measuring. */
    if(arg('prep','')){await evaluate(arg('prep',''));await sleep(SETTLE);}
    const measure=await evaluate(MEASURE);
    if(arg('eval',''))console.log('   eval:',JSON.stringify(await evaluate(arg('eval',''))));
    const checks=ASSERT[route]?await evaluate(ASSERT[route]):[];
    const file=join(OUT,`${route}-${width}.png`);
    await shot(file,FULL);
    const list=Array.isArray(checks)?checks:[{name:'assertions evaluated',ok:false,detail:JSON.stringify(checks)}];
    const generic=[
      {name:'no console errors',ok:state.errors.length===0,detail:state.errors.slice(0,3).join(' | ')},
      {name:'no horizontal overflow',ok:(measure?.overflowX??1)<=0,detail:`${measure?.overflowX}px ${measure?.bleeders?.join(',')||''}`},
      {name:'no broken images',ok:!(measure?.brokenImages||[]).length,detail:(measure?.brokenImages||[]).join(',')},
      {name:'no text under 10px',ok:(measure?.sub10Text??1)===0,detail:String(measure?.sub10Text)}
    ];
    const all=[...generic,...list];
    const bad=all.filter(c=>!c.ok);failures+=bad.length;
    const apiSummary={};state.apiCalls.forEach(c=>{const k=c.u.split('?')[0];apiSummary[k]=(apiSummary[k]||0)+1});
    const row={route,width,requests:state.requests,kb:Math.round(state.bytes/1024),api:state.apiCalls.length,apiSummary,measure,checks:all,shot:file};
    report.push(row);
    console.log(`${bad.length?'FAIL':'PASS'} ${route}@${width} req=${state.requests} ${row.kb}KB api=${row.api} h=${measure?.height} undim=${measure?.undimensioned} small=${measure?.smallTargets}${bad.length?'\n   '+bad.map(b=>`✗ ${b.name}${b.detail?` — ${b.detail}`:''}`).join('\n   '):''}`);
  }
}
writeFileSync(join(OUT,'report.json'),JSON.stringify(report,null,2));
console.log(`\n${failures?`${failures} FAILED CHECK(S)`:'ALL CHECKS PASSED'} · ${report.length} renders · ${OUT}`);
finish(failures?1:0);
