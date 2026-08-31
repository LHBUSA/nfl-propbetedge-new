/* Recovery browser smoke.
 * Loads https://nfl.propbetedge.ai in real Chrome while substituting every
 * same-origin static HTML/JS/CSS request with the checked-out recovery branch.
 * API requests continue to live production unchanged. Nothing is deployed.
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
const shots=[];
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
async function shot(name){const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const file=`recovery-${name}.png`;writeFileSync(file,Buffer.from(r.data,'base64'));shots.push(file);out(`screenshot             : ${file}`)}
async function mediaStats(){return probe(`(()=>{const all=[...document.images],loaded=all.filter(i=>i.complete&&i.naturalWidth>0),broken=all.filter(i=>i.complete&&!i.naturalWidth),team=loaded.filter(i=>/teamlogos\\/nfl/i.test(i.src)),players=loaded.filter(i=>/headshots\\/nfl/i.test(i.src));return{all:all.length,loaded:loaded.length,broken:broken.length,team:team.length,players:players.length}})()`)}

out(`TARGET ${TARGET}`);out('MODE recovery branch static files + live production APIs');
await send('Page.navigate',{url:`${TARGET}/?recovery=${Date.now()}`});await sleep(11000);
if(await probe('1+1')!==2){out('RESULT MAIN THREAD WEDGED');ws.close();finish(1)}
let pass=true;
out('\n=== HOME LIVENESS ===');
const text=await probe(`(document.querySelector('#view-container')?.textContent||'').trim()`);const spinner=typeof text==='string'&&text.length>200&&!/Loading NFL Intelligence OS/.test(text);out(`spinner cleared        : ${spinner}`);out(`view chars             : ${typeof text==='string'?text.length:text}`);if(!spinner)pass=false;
const features=[['.pbehome7','Dashboard v7'],['#pbe8-core-market','Dashboard v8 market'],['.pbe8-news-filters','Dashboard v8 filters'],['.pbes-scorebar,.pbes-shell','Sports shell'],['#pbe-network-footer','Network footer'],['.pbe-engine-story','Engine Story'],['#pbe-prop-engine-home,.pbe-prop-engine','Player Prop Engine']];
for(const [sel,label] of features){const v=await probe(`!!document.querySelector(${JSON.stringify(sel)})`);out(`${label.padEnd(24)}: ${v}`);if(v!==true)pass=false}
let media=await mediaStats();out(`home media             : ${JSON.stringify(media)}`);if(!media||typeof media!=='object'||media.loaded<4||media.team<2)pass=false;await shot('home-desktop');
const routes=['games','propboard','marketwatch','picks','pbepicks','trackrecord','pbecast','matchups','home'];
out('\n=== ROUTES ===');
for(const route of routes){await probe(`window.App&&App.nav(${JSON.stringify(route)})`,8000);await sleep(2200);const alive=await probe('1+1')===2;const cur=await probe('window.App?.current??null');const chars=await probe(`(document.querySelector('#view-container')?.textContent||'').trim().length`);media=await mediaStats();out(`${route.padEnd(12)} alive=${alive?'YES':'NO '} route=${String(cur).padEnd(12)} chars=${chars} media=${JSON.stringify(media)}`);if(!alive||cur!==route||!(Number(chars)>80)){pass=false;break}if(['games','propboard','pbecast'].includes(route))await shot(`${route}-desktop`)}
out('\n=== SOAK ===');for(let i=0;i<30;i++){await probe(`window.App&&App.nav(${JSON.stringify(routes[i%routes.length])})`,6000);await sleep(350)}const soak=await probe('1+1',10000)===2;out(`30-nav responsive      : ${soak}`);if(!soak)pass=false;
await probe(`window.App&&App.nav('home')`);await sleep(1800);await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(600);await shot('home-mobile');
out(`served recovery files : ${served.size}`);out(`exceptions             : ${exceptions.length}${exceptions.length?' | '+exceptions.slice(0,4).join(' | '):''}`);out(`RESULT ${pass?'PASS':'FAIL'}`);ws.close();finish(pass?0:1);
