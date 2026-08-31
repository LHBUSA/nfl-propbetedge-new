/* Recovery browser smoke.
 * Loads https://nfl.propbetedge.ai in real Chrome while substituting every
 * same-origin static HTML/JS/CSS request with the checked-out recovery branch.
 * API requests continue to live production unchanged. Nothing is deployed.
 *
 * This gate checks more than liveness. A prior recovery rendered successfully
 * while silently regressing navigation and CSS authority, so we also require
 * the complete product map, synchronized active state, terminal visual-layer
 * ordering, route content and visual captures of the major workspaces.
 */
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync,appendFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,extname} from 'node:path';

const REPO=process.cwd();
const TARGET='https://nfl.propbetedge.ai';
const ORIGIN=new URL(TARGET).origin;
const PORT=9700+Math.floor(Math.random()*90);
const LOG='recovery-smoke.log';
const CHROME=process.env.PBE_CHROME||'/usr/bin/google-chrome';
const served=new Set();
const exceptions=[];
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
ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return}if(m.method==='Fetch.requestPaused'){const local=localFile(m.params.request.url);if(local){served.add(local.rel);send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'content-type',value:local.type},{name:'cache-control',value:'no-store'}],body:local.body.toString('base64')}).catch(()=>{})}else send('Fetch.continueRequest',{requestId:m.params.requestId}).catch(()=>{});return}if(m.method==='Runtime.exceptionThrown')exceptions.push(String(m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text||'').slice(0,240))};
await send('Runtime.enable');await send('Page.enable');await send('Fetch.enable',{patterns:[{urlPattern:`${ORIGIN}/*`,requestStage:'Request'}]});
const probe=async(expr,ms=7000)=>{try{const r=await Promise.race([send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true}),sleep(ms).then(()=>{throw new Error('WEDGED')})]);return r.result?.value}catch(e){return`<${e.message}>`}};
async function shot(name){const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const file=`recovery-${name}.png`;writeFileSync(file,Buffer.from(r.data,'base64'));out(`screenshot             : ${file}`)}
async function mediaStats(){return probe(`(()=>{const all=[...document.images],loaded=all.filter(i=>i.complete&&i.naturalWidth>0),broken=all.filter(i=>i.complete&&!i.naturalWidth),team=loaded.filter(i=>/teamlogos\\/nfl/i.test(i.src)),players=loaded.filter(i=>/headshots\\/nfl/i.test(i.src));return{all:all.length,loaded:loaded.length,broken:broken.length,team:team.length,players:players.length}})()`)}
async function navStats(){return probe(`(()=>{const buttons=[...document.querySelectorAll('.pbe-v2-quicknav [data-route]')];return{count:buttons.length,routes:buttons.map(x=>x.dataset.route),active:buttons.filter(x=>x.classList.contains('primary')).map(x=>x.dataset.route),picks:!!document.getElementById('nav-pbepicks'),record:!!document.getElementById('nav-trackrecord'),width:Math.round(document.querySelector('.pbe-v2-quicknav')?.getBoundingClientRect().width||0),scrollWidth:Math.round(document.querySelector('.pbe-v2-quicknav')?.scrollWidth||0)}})()`)}
async function activeNav(route){return probe(`(()=>{const all=[...document.querySelectorAll('.pbe-v2-quicknav [data-route].primary')];const target=document.querySelector('.pbe-v2-quicknav [data-route=${JSON.stringify(route)}]');return{target:!!target,active:!!target?.classList.contains('primary'),current:target?.getAttribute('aria-current')||'',activeCount:all.length,activeRoutes:all.map(x=>x.dataset.route)}})()`)}

const requiredNav=['home','games','propboard','marketwatch','matchups','picks','pbepicks','trackrecord','simulator','sgplab','usage','propchain','pbecast','newsintel','injuries','trades'];
const routes=[...requiredNav.slice(1),'home'];
const captureRoutes=new Set(['games','propboard','marketwatch','picks','pbepicks','trackrecord','usage','propchain','pbecast','newsintel','matchups','home']);

out(`TARGET ${TARGET}`);out('MODE recovery branch static files + live production APIs');
await send('Page.navigate',{url:`${TARGET}/?recovery=${Date.now()}`});await sleep(11000);
if(await probe('1+1')!==2){out('RESULT MAIN THREAD WEDGED');ws.close();finish(1)}
let pass=true;
out('\n=== HOME LIVENESS ===');
const text=await probe(`(document.querySelector('#view-container')?.textContent||'').trim()`);const spinner=typeof text==='string'&&text.length>200&&!/Loading NFL Intelligence OS/.test(text);out(`spinner cleared        : ${spinner}`);out(`view chars             : ${typeof text==='string'?text.length:text}`);if(!spinner)pass=false;
const features=[['.pbehome7','Dashboard v7'],['#pbe8-core-market','Dashboard v8 market'],['.pbe8-news-filters','Dashboard v8 filters'],['.pbes-scorebar,.pbes-shell','Sports shell'],['#pbe-network-footer','Network footer'],['.pbe-engine-story','Engine Story'],['#pbe-prop-engine-home,.pbe-prop-engine','Player Prop Engine']];
for(const [sel,label] of features){const v=await probe(`!!document.querySelector(${JSON.stringify(sel)})`);out(`${label.padEnd(24)}: ${v}`);if(v!==true)pass=false}
let media=await mediaStats();out(`home media             : ${JSON.stringify(media)}`);if(!media||typeof media!=='object'||media.loaded<4||media.team<2||media.broken>0)pass=false;

out('\n=== NAVIGATION CONTRACT ===');
const nav=await navStats();out(`quick nav              : ${JSON.stringify(nav)}`);
if(!nav||typeof nav!=='object'||nav.count!==requiredNav.length||!nav.picks||!nav.record||nav.active.length!==1||nav.active[0]!=='home'||requiredNav.some(r=>!nav.routes.includes(r)))pass=false;
const cssOrder=await probe(`(()=>{const files=[...document.querySelectorAll('link[data-pbe-upgrade]')].map(x=>(new URL(x.href)).pathname.split('/').pop());const terminal=files.indexOf('world-class-v1.css');const structural=['dashboard-v7.css','games-intel-v5.css','prop-board-v4.css','model-lab-v2-enhance.css','pbecast-v6.css'];return{terminal,structural:Object.fromEntries(structural.map(f=>[f,files.indexOf(f)])),ok:terminal>=0&&structural.every(f=>files.indexOf(f)>=0&&files.indexOf(f)<terminal)}})()`);
out(`visual CSS authority   : ${JSON.stringify(cssOrder)}`);if(!cssOrder||typeof cssOrder!=='object'||cssOrder.ok!==true)pass=false;
await shot('home-desktop');

out('\n=== ROUTES + ACTIVE NAV ===');
for(const route of routes){
  await probe(`window.App&&App.nav(${JSON.stringify(route)})`,8000);await sleep(1900);
  const alive=await probe('1+1')===2,cur=await probe('window.App?.current??null'),chars=await probe(`(document.querySelector('#view-container')?.textContent||'').trim().length`),active=await activeNav(route);media=await mediaStats();
  out(`${route.padEnd(12)} alive=${alive?'YES':'NO '} route=${String(cur).padEnd(12)} chars=${chars} active=${JSON.stringify(active)} media=${JSON.stringify(media)}`);
  if(!alive||cur!==route||!(Number(chars)>80)||!active||active.active!==true||active.current!=='page'||active.activeCount!==1||Number(media?.broken||0)>0){pass=false;break}
  if(captureRoutes.has(route))await shot(`${route}-desktop`);
}

out('\n=== SOAK ===');for(let i=0;i<32;i++){await probe(`window.App&&App.nav(${JSON.stringify(routes[i%routes.length])})`,6000);await sleep(300)}const soak=await probe('1+1',10000)===2;out(`32-nav responsive      : ${soak}`);if(!soak)pass=false;
await probe(`window.App&&App.nav('home')`);await sleep(1700);await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(600);const mobile=await probe(`(()=>({header:getComputedStyle(document.getElementById('mobile-header')).display,bottom:getComputedStyle(document.getElementById('mobile-bottom-nav')).display,route:window.App?.current}))()`);out(`mobile navigation       : ${JSON.stringify(mobile)}`);if(!mobile||typeof mobile!=='object'||mobile.route!=='home')pass=false;await shot('home-mobile');
out(`served recovery files : ${served.size}`);out(`exceptions             : ${exceptions.length}${exceptions.length?' | '+exceptions.slice(0,4).join(' | '):''}`);if(exceptions.length)pass=false;out(`RESULT ${pass?'PASS':'FAIL'}`);ws.close();finish(pass?0:1);
