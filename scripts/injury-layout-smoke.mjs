/* Injury Editorial focused browser gate.
 * Uses production origin/APIs while substituting checked-out branch static
 * files. Verifies the injuries route is a photo-led PropBetEdge article desk.
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
const dir=mkdtempSync(join(tmpdir(),'pbe-injury-editorial-'));
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
const probe=async(expr,ms=7000)=>{try{const r=await Promise.race([send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true}),sleep(ms).then(()=>{throw new Error('WEDGED')})]);if(r.exceptionDetails)return`<EVAL ${r.exceptionDetails.text||'ERROR'}>`;return r.result?.value}catch(e){return`<${e.message}>`}};
async function shot(name){const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(name,Buffer.from(r.data,'base64'));out(`screenshot ${name}`)}

await send('Page.navigate',{url:`${TARGET}/?injury-editorial=${Date.now()}`});
await sleep(11000);
if(await probe('1+1')!==2){out('RESULT FAIL main_thread');ws.close();finish(1)}
await probe(`window.App&&App.nav('injuries')`,8000);
await sleep(3300);

let pass=true;
let desktop=await probe(`(()=>{
  const root=document.querySelector('.pbe13-news.pbe13-injury-editorial');
  if(!root)return{root:false};
  const hero=root.querySelector('.pbe13-editorial-hero');
  const lead=root.querySelector('.pbe13-editorial-lead');
  const leadImg=lead?.querySelector('.pbe13-editorial-lead-media img');
  const cards=[...root.querySelectorAll('.pbe13-editorial-card')];
  const isPbeArticle=href=>{try{const u=new URL(href);return u.hostname==='propbetedge.ai'&&u.pathname.startsWith('/news/nfl/')}catch{return false}};
  const links=[...root.querySelectorAll('a[href]')].map(a=>a.href).filter(isPbeArticle);
  const badLinks=[...root.querySelectorAll('.pbe13-editorial-lead a[href],.pbe13-editorial-card[href]')].map(a=>a.href).filter(h=>!isPbeArticle(h));
  const imgs=[...root.querySelectorAll('.pbe13-editorial-lead img,.pbe13-editorial-card img')];
  const loaded=imgs.filter(i=>i.complete&&i.naturalWidth>0);
  const broken=imgs.filter(i=>i.complete&&!i.naturalWidth);
  const controls=root.querySelectorAll('#pbe13-summary,.pbe13-controls,.pbe13-side,.pbe13-story-player,.pbe13-impact');
  return{
    root:true,
    heroHeight:+(hero?.getBoundingClientRect().height||0).toFixed(1),
    lead:!!lead,
    leadImage:!!leadImg&&leadImg.complete&&leadImg.naturalWidth>0,
    leadMediaWidth:+(leadImg?.getBoundingClientRect().width||0).toFixed(1),
    cards:cards.length,
    articleLinks:links.length,
    badLinks:badLinks.length,
    images:imgs.length,
    loadedImages:loaded.length,
    broken:broken.length,
    telemetryNodes:controls.length,
    impactText:/impact score|selected-event team stories|affected players/i.test(root.textContent||''),
    editorialText:/PropBetEdge Editorial/i.test(root.textContent||''),
    text:(root.textContent||'').trim().length
  };
})()`);
out(`desktop ${JSON.stringify(desktop)}`);
if(!desktop||typeof desktop!=='object'||desktop.root!==true||desktop.heroHeight>255||desktop.lead!==true||desktop.leadImage!==true||desktop.leadMediaWidth<500||desktop.cards<5||desktop.articleLinks<6||desktop.badLinks!==0||desktop.images<6||desktop.loadedImages<5||desktop.broken>0||desktop.telemetryNodes!==0||desktop.impactText!==false||desktop.editorialText!==true||desktop.text<1200)pass=false;
await shot('injury-editorial-desktop.png');

await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
await probe(`window.scrollTo(0,0)`);await sleep(900);
const mobile=await probe(`(()=>{
  const root=document.querySelector('.pbe13-news.pbe13-injury-editorial');
  const hero=root?.querySelector('.pbe13-editorial-hero');
  const lead=root?.querySelector('.pbe13-editorial-lead');
  const leadImg=root?.querySelector('.pbe13-editorial-lead-media img');
  return{
    root:!!root,
    heroHeight:+(hero?.getBoundingClientRect().height||0).toFixed(1),
    leadWidth:+(lead?.getBoundingClientRect().width||0).toFixed(1),
    leadImgWidth:+(leadImg?.getBoundingClientRect().width||0).toFixed(1),
    overflow:document.documentElement.scrollWidth-window.innerWidth,
    route:window.App?.current
  };
})()`);
out(`mobile ${JSON.stringify(mobile)}`);
if(!mobile||typeof mobile!=='object'||mobile.root!==true||mobile.route!=='injuries'||mobile.heroHeight>330||mobile.leadWidth>390||mobile.leadImgWidth>390||mobile.overflow>2)pass=false;
await shot('injury-editorial-mobile.png');

out(`RESULT ${pass?'PASS':'FAIL'}`);
ws.close();finish(pass?0:1);
