/* Drives the INTEGRATED PBEcast arcade mode through one complete published
   drive and captures each snap, plus replay / return-to-live / mobile. */
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,extname} from 'node:path';
const REPO='C:/Workers/nfl-propbetedge-new';
const TARGET='https://nfl.propbetedge.ai', ORIGIN=TARGET;
const OUT=process.argv[2]||'./review/drive';
const W=Number(process.argv[3]||1280);
const REDUCED=process.env.ARC_REDUCED==='1';
mkdirSync(OUT,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dir=mkdtempSync(join(tmpdir(),'pbe-drive-'));
const PORT=9960+Math.floor(Math.random()*30);
const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
 [`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'--headless=new','--no-first-run',
  '--hide-scrollbars','--force-device-scale-factor=1','about:blank'],{stdio:'ignore'});
async function wsUrl(){for(let i=0;i<100;i++){try{const l=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl}catch{}await sleep(200)}throw new Error('nodevtools')}
const ws=new WebSocket(await wsUrl());await new Promise(r=>{ws.onopen=r});
let id=1;const pend=new Map();
const send=(m,p={})=>{const n=id++;ws.send(JSON.stringify({id:n,method:m,params:p}));return new Promise((res,rej)=>pend.set(n,{res,rej}))};
const MIME={'.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json'};
function localFile(url){let u;try{u=new URL(url)}catch{return null}
 if(u.origin!==ORIGIN||u.pathname.startsWith('/api/'))return null;
 const rel=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname.slice(1));
 if(!rel||rel.includes('..')||!MIME[extname(rel)])return null;
 const fp=join(REPO,rel);
 try{if(!existsSync(fp)||!statSync(fp).isFile())return null;return{body:readFileSync(fp),type:MIME[extname(rel)]}}catch{return null}}
const errs=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);
 if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result);return}
 if(m.method==='Fetch.requestPaused'){const l=localFile(m.params.request.url);
  if(l)send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'content-type',value:l.type},{name:'cache-control',value:'no-store'}],body:l.body.toString('base64')}).catch(()=>{});
  else send('Fetch.continueRequest',{requestId:m.params.requestId}).catch(()=>{})}
 if(m.method==='Runtime.exceptionThrown')errs.push(String(m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text||'').slice(0,200));};
await send('Runtime.enable');await send('Page.enable');
await send('Fetch.enable',{patterns:[{urlPattern:`${ORIGIN}/*`,requestStage:'Request'}]});
if(REDUCED)await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
const mobile=W<600;
await send('Emulation.setDeviceMetricsOverride',{width:W,height:mobile?844:900,deviceScaleFactor:1,mobile,screenWidth:W,screenHeight:mobile?844:900});
await send('Emulation.setTouchEmulationEnabled',{enabled:mobile,maxTouchPoints:mobile?5:1});
const ev=async(e,ms=25000)=>{try{const r=await Promise.race([send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true}),sleep(ms).then(()=>{throw new Error('WEDGED')})]);return r.result?.value}catch(x){return{__error:x.message}}};

await send('Page.navigate',{url:`${TARGET}/#pbecast`});
await sleep(16000);
const drive=JSON.parse(readFileSync(join(REPO,'prototype/arcade/demo-drive.json'),'utf8'));
console.log('loading demo game...');
console.log('  ', JSON.stringify(await ev(`window.PBEcastArcade.__demoGame('401772936')`)));
console.log('  state:', JSON.stringify(await ev(`(()=>{const s=window.PBEcastV6.state;return {activeId:s.activeId,err:s.error,plays:(s.detail&&s.detail.plays||[]).length,hasRoot:!!document.querySelector('.pbecast6'),hasAction:!!document.querySelector('[data-cast6-action]'),hasField:!!document.querySelector('.cast6-field'),hasArc:!!document.querySelector('[data-cast-arc]')}})()`)));
await sleep(1500);
console.log('  mode ->', JSON.stringify(await ev(`window.PBEcastArcade.setMode('arcade').then(()=>'arcade')`)));
await sleep(1200);
const shot=async n=>{const s=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(join(OUT,`${n}.png`),Buffer.from(s.data,'base64'))};
let i=0;
for(const pid of drive.plays){
  i++;
  const a=await ev(`window.PBEcastArcade.__demoPlay(${JSON.stringify(pid)}).then(x=>x&&({kind:x.kind,start:x.startYard,ball:x.ballEndYard,next:x.nextSnapYard,gain:x.yardsGained,pen:x.penaltyYards,down:x.down,dist:x.distance,fd:x.firstDownYard,score:x.scoring,conf:x.confidence.level}))`);
  console.log(String(i).padStart(2),pid,JSON.stringify(a));
  await sleep(REDUCED?450:2100);
  await shot(`drive-${String(i).padStart(2,'0')}-${W}`);
}
/* historical replay from the game log, then return to live */
await ev(`(()=>{const r=document.querySelector('.cast6-play[data-play-id="${drive.plays[0]}"]');r&&r.click();return !!r})()`);
await sleep(1500); await shot(`replay-${W}`);
const bar=await ev(`(()=>{const b=document.querySelector('.cast-arc-replaybar');return {visible:b&&!b.hidden}})()`);
await ev(`document.querySelector('[data-arc-live]')?.click()`);
await sleep(1200); await shot(`return-to-live-${W}`);
/* the trusted view is untouched when switched back */
await ev(`window.PBEcastArcade.setMode('field')`);
await sleep(900); await shot(`field-mode-${W}`);
const check=await ev(`(()=>{const f=document.querySelector('.pbecast6 .cast6-field');return {fieldPresent:!!f,fieldVisible:f?getComputedStyle(f).display!=='none':null,arcadeHidden:document.querySelector('.cast-arc-stage')?.hidden===true,overflow:Math.round(document.documentElement.scrollWidth-document.documentElement.clientWidth)}})()`);
console.log('replay bar:',JSON.stringify(bar),' field-mode check:',JSON.stringify(check),' exceptions:',errs.length,errs.slice(0,2));
try{chrome.kill()}catch{};console.log('wrote',OUT);process.exit(0);
