/* Verify the deep-link contract against the working tree + live APIs. */
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,extname} from 'node:path';
const REPO=process.cwd(), TARGET='https://nfl.propbetedge.ai', ORIGIN=new URL(TARGET).origin;
const PORT=9950+Math.floor(Math.random()*40);
const CHROME=process.env.PBE_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dir=mkdtempSync(join(tmpdir(),'pbe-dl-'));
const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'--headless=new','--no-first-run','--disable-extensions','--hide-scrollbars','about:blank'],{stdio:'ignore'});
function finish(c){try{chrome.kill()}catch{}setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}process.exit(c)},200)}
setTimeout(()=>{console.error('DEADLINE');finish(3)},240000).unref?.();
async function wsUrl(){for(let i=0;i<100;i++){try{const l=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl}catch{}await sleep(200)}throw new Error('devtools')}
const ws=new WebSocket(await wsUrl());await new Promise(r=>{ws.onopen=r});
let id=1;const pending=new Map();
const send=(m,p={})=>{const n=id++;ws.send(JSON.stringify({id:n,method:m,params:p}));return new Promise((res,rej)=>pending.set(n,{resolve:res,reject:rej}))};
const MIME={'.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.json':'application/json; charset=utf-8'};
function localFile(url){let u;try{u=new URL(url)}catch{return null}if(u.origin!==ORIGIN||u.pathname.startsWith('/api/'))return null;const rel=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname.slice(1));if(!rel||rel.includes('..')||!MIME[extname(rel)])return null;const fp=join(REPO,rel);try{if(!existsSync(fp)||!statSync(fp).isFile())return null;return{body:readFileSync(fp),type:MIME[extname(rel)]}}catch{return null}}
const errors=[];
ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return}
if(m.method==='Fetch.requestPaused'){const l=localFile(m.params.request.url);if(l)send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'content-type',value:l.type},{name:'cache-control',value:'no-store'}],body:l.body.toString('base64')}).catch(()=>{});else send('Fetch.continueRequest',{requestId:m.params.requestId}).catch(()=>{})}
if(m.method==='Runtime.exceptionThrown')errors.push(String(m.params.exceptionDetails?.exception?.description||'').slice(0,140))};
await send('Runtime.enable');await send('Page.enable');await send('Fetch.enable',{patterns:[{urlPattern:`${ORIGIN}/*`,requestStage:'Request'}]});
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
const probe=async(e,ms=20000)=>{try{const r=await Promise.race([send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true}),sleep(ms).then(()=>{throw new Error('WEDGED')})]);return r.result?.value}catch(err){return{__error:err.message}}};

const cases=[
  {name:'player deep link',url:`${TARGET}/?player=Drake%20Maye#propboard`,
   check:`(()=>({route:App.current,param:App.params.player,drawerOpen:!!document.querySelector('.pbe17-player'),drawerName:document.querySelector('.pbe17-name')?.textContent?.trim()||null}))()`},
  {name:'event deep link',url:`${TARGET}/?event=401772936#marketwatch`,
   check:`(()=>({route:App.current,param:App.params.event,rows:document.querySelectorAll('.pbe22-table tbody tr').length}))()`},
  {name:'hash-borne params',url:`${TARGET}/#propboard?player=Sam%20Darnold`,
   check:`(()=>({route:App.current,param:App.params.player}))()`},
  {name:'plain route still works',url:`${TARGET}/#games`,
   check:`(()=>({route:App.current,params:Object.keys(App.params).length,chars:(document.getElementById('view-container')?.textContent||'').trim().length}))()`},
  {name:'link() builder',url:`${TARGET}/`,
   check:`App.link('marketwatch',{event:'abc',player:'X Y'})`},
];
let pass=true;
for(const c of cases){
  errors.length=0;
  await send('Page.navigate',{url:c.url});
  await sleep(15000);
  const out=await probe(c.check);
  const ok=!out?.__error && errors.length===0;
  if(!ok)pass=false;
  console.log(`${ok?'PASS':'FAIL'}  ${c.name.padEnd(24)} ${JSON.stringify(out)}${errors.length?'  errors='+JSON.stringify(errors.slice(0,2)):''}`);
}
console.log(pass?'\nALL DEEP-LINK CASES PASS':'\nFAILURES PRESENT');
ws.close();finish(pass?0:1);
