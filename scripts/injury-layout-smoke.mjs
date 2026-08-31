/* Injury Intelligence focused browser gate.
 * Uses the production origin and APIs while substituting same-origin static
 * HTML/JS/CSS with the checked-out branch, so no deployment is required.
 */
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,extname} from 'node:path';

const REPO=process.cwd();
const TARGET='https://nfl.propbetedge.ai';
const ORIGIN=new URL(TARGET).origin;
const PORT=9810+Math.floor(Math.random()*70);
const CHROME=process.env.PBE_CHROME||'/usr/bin/google-chrome';
const dir=mkdtempSync(join(tmpdir(),'pbe-injury-layout-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const out=s=>console.log(s);
const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-timer-throttling','--window-size=1440,900','about:blank'],{stdio:'ignore'});
function finish(code){try{chrome.kill()}catch{}setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}process.exit(code)},200)}
const hard=setTimeout(()=>{out('HARD_DEADLINE');finish(3)},120000);hard.unref?.();
async function wsUrl(){for(let i=0;i<80;i++){try{const list=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const p=list.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl}catch{}await sleep(200)}throw new Error('devtools_unavailable')}
const ws=new WebSocket(await wsUrl());await new Promise(r=>{ws.onopen=r});
let id=1;const pending=new Map();
const send=(method,params={})=>{const n=id++;ws.send(JSON.stringify({id:n,method,params}));return new Promise((resolve,reject)=>pending.set(n,{resolve,reject}))};
const mime=p=>({'.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.json':'application/json; charset=utf-8'}[extname(p)]||'application/octet-stream');
function localFile(url){let u;try{u=new URL(url)}catch{return null}if(u.origin!==ORIGIN||u.pathname.startsWith('/api/'))return null;let rel=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname.slice(1));if(!rel||rel.includes('..'))return null;const ext=extname(rel);if(!['.js','.mjs','.css','.html','.webmanifest','.json'].includes(ext))return null;const fp=join(REPO,rel);try{if(!existsSync(fp)||!statSync(fp).isFile())return null;return{body:readFileSync(fp),type:mime(rel)}}catch{return null}}
ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return}if(m.method==='Fetch.requestPaused'){const local=localFile(m.params.request.url);if(local)send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'content-type',value:local.type},{name:'cache-control',value:'no-store'}],body:local.body.toString('base64')}).catch(()=>{});else send('Fetch.continueRequest',{requestId:m.params.requestId}).catch(()=>{})}};
await send('Runtime.enable');await send('Page.enable');await send('Fetch.enable',{patterns:[{urlPattern:`${ORIGIN}/*`,requestStage:'Request'}]});
const probe=async(expr,ms=7000)=>{try{const r=await Promise.race([send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true}),sleep(ms).then(()=>{throw new Error('WEDGED')})]);return r.result?.value}catch(e){return`<${e.message}>`}};
async function shot(name){const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(name,Buffer.from(r.data,'base64'));out(`screenshot ${name}`)}

await send('Page.navigate',{url:`${TARGET}/?injury-layout=${Date.now()}`});
await sleep(11000);
if(await probe('1+1')!==2){out('RESULT FAIL main_thread');ws.close();finish(1)}
await probe(`window.App&&App.nav('injuries')`,8000);
await sleep(2800);

let pass=true;
let desktop=await probe(`(()=>{
  const root=document.querySelector('.pbe13-news.pbe13-injury-v2');
  if(!root)return{root:false};
  const hero=root.querySelector('.pbe13-hero');
  const featured=root.querySelector('.pbe13-featured');
  const summary=root.querySelector('#pbe13-summary');
  const lead=root.querySelector('.pbe13-lead');
  const leadImg=lead?.querySelector('.pbe13-story-player-lead > .pbe-player-headshot-v3');
  const aff=[...root.querySelectorAll('.pbe13-aff-name > .pbe-player-headshot-v3')];
  const storyBlocks=[...root.querySelectorAll('.pbe13-story-player-card')];
  const allImgs=[...root.querySelectorAll('img')];
  const maxImg=Math.max(0,...allImgs.map(i=>Math.max(i.getBoundingClientRect().width,i.getBoundingClientRect().height)));
  return{
    root:true,
    heroHeight:+(hero?.getBoundingClientRect().height||0).toFixed(1),
    featuredBeforeSummary:!!featured&&!!summary&&featured.getBoundingClientRect().top<summary.getBoundingClientRect().top,
    leadPhoto:!!leadImg,
    leadPhotoWidth:+(leadImg?.getBoundingClientRect().width||0).toFixed(1),
    affectedPhotos:aff.length,
    maxAffected:+Math.max(0,...aff.map(i=>i.getBoundingClientRect().width)).toFixed(1),
    storyBlocks:storyBlocks.length,
    maxImg:+maxImg.toFixed(1),
    feedColumns:getComputedStyle(root.querySelector('.pbe13-feed')).gridTemplateColumns,
    broken:allImgs.filter(i=>i.complete&&!i.naturalWidth).length,
    text:(root.textContent||'').trim().length
  };
})()`);
out(`desktop ${JSON.stringify(desktop)}`);
if(!desktop||desktop.root!==true||desktop.heroHeight>225||desktop.featuredBeforeSummary!==true||desktop.leadPhoto!==true||desktop.leadPhotoWidth<64||desktop.leadPhotoWidth>82||desktop.affectedPhotos<1||desktop.maxAffected>38||desktop.storyBlocks<3||desktop.maxImg>84||desktop.broken>0||desktop.text<1000)pass=false;
await shot('injury-layout-desktop.png');

await probe(`(()=>{const card=document.querySelector('.pbe13-card .pbe13-story-player-card');card?.scrollIntoView({block:'center'});window.PBENFLPlayerMediaV3?.scan?.();return !!card})()`);
await sleep(1200);
const cardPhoto=await probe(`(()=>{const img=document.querySelector('.pbe13-card .pbe13-story-player-card > .pbe-player-headshot-v3');if(!img)return null;const r=img.getBoundingClientRect();return{width:+r.width.toFixed(1),height:+r.height.toFixed(1),loaded:img.complete&&img.naturalWidth>0}})()`);
out(`cardPhoto ${JSON.stringify(cardPhoto)}`);
if(!cardPhoto||cardPhoto.loaded!==true||cardPhoto.width<44||cardPhoto.width>54||cardPhoto.height<44||cardPhoto.height>54)pass=false;

await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
await probe(`window.scrollTo(0,0)`);await sleep(700);
const mobile=await probe(`(()=>{const root=document.querySelector('.pbe13-news.pbe13-injury-v2');const hero=root?.querySelector('.pbe13-hero');const leadImg=root?.querySelector('.pbe13-story-player-lead > .pbe-player-headshot-v3');return{root:!!root,heroHeight:+(hero?.getBoundingClientRect().height||0).toFixed(1),leadPhotoWidth:+(leadImg?.getBoundingClientRect().width||0).toFixed(1),overflow:document.documentElement.scrollWidth-window.innerWidth,route:window.App?.current}})()`);
out(`mobile ${JSON.stringify(mobile)}`);
if(!mobile||mobile.root!==true||mobile.route!=='injuries'||mobile.heroHeight>285||mobile.leadPhotoWidth>66||mobile.overflow>2)pass=false;
await shot('injury-layout-mobile.png');

out(`RESULT ${pass?'PASS':'FAIL'}`);
ws.close();finish(pass?0:1);
