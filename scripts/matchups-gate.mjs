/* Matchups visual gate.
 *
 *   node scripts/matchups-gate.mjs [--width=1440] [--label=x] [--event=<odds id>]
 *
 * Opens the live page, asserts the v3 section rendered, reports the section
 * order, horizontal overflow and any console/page error, and writes a
 * screenshot to .gate/matchups/. Development only.
 */
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const WIDTH=Number((process.argv.find(a=>a.startsWith('--width='))||'--width=1440').split('=')[1]);
const LABEL=(process.argv.find(a=>a.startsWith('--label='))||'--label=desktop').split('=')[1];
const EVENT=(process.argv.find(a=>a.startsWith('--event='))||'').split('=')[1]||'';
const OUT=join(process.cwd(),'.gate','matchups'); mkdirSync(OUT,{recursive:true});
const PORT=9600+Math.floor(Math.random()*90);
const dir=mkdtempSync(join(tmpdir(),'pbe-mq-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const chrome=spawn(process.env.PBE_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe',
 [`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'--headless=new','--no-first-run','--hide-scrollbars','about:blank'],{stdio:'ignore'});
function fin(c){try{chrome.kill()}catch{};setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{};process.exit(c)},250)}
setTimeout(()=>{console.error('DEADLINE');fin(3)},180000).unref?.();
async function wsUrl(){for(let i=0;i<120;i++){try{const l=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl}catch{}await sleep(200)}throw new Error('no devtools')}
const ws=new WebSocket(await wsUrl());await new Promise(r=>{ws.onopen=r});
let id=1;const pending=new Map();const errs=[];
const send=(m,p={})=>{const n=id++;ws.send(JSON.stringify({id:n,method:m,params:p}));return new Promise((res,rej)=>pending.set(n,{resolve:res,reject:rej}))};
ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return}
 if(m.method==='Runtime.exceptionThrown')errs.push(String(m.params.exceptionDetails?.exception?.description||'').slice(0,160));
 if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')errs.push('console: '+(m.params.args||[]).map(a=>String(a.value||a.description||'')).join(' ').slice(0,160));};
const ev=async e=>(await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result?.value;
await send('Runtime.enable');await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride',{width:WIDTH,height:WIDTH<600?880:1200,deviceScaleFactor:1,mobile:WIDTH<600});
await send('Page.navigate',{url:`https://nfl.propbetedge.ai/#matchups${EVENT?`?event=${EVENT}`:''}`});
await sleep(11000);
const info=await ev(`(()=>{const el=document.querySelector('[data-pbe-matchups-v3]');if(!el)return null;
 return {text:el.innerText.slice(0,1400), overflow: document.documentElement.scrollWidth>document.documentElement.clientWidth,
         sections:[...el.querySelectorAll('.pbe17m-head strong')].map(x=>x.textContent)};})()`);
if(!info){console.error('FAIL: matchups v3 did not render');console.error('errors:',errs.slice(0,5));fin(1)}
else{
 const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
 const f=join(OUT,`matchups-${LABEL}-${WIDTH}.png`); writeFileSync(f,Buffer.from(shot.data,'base64'));
 console.log('PASS ->',f); console.log('sections:',info.sections.join(' | '));
 console.log('horizontal overflow:',info.overflow);
 console.log('console/page errors:',errs.length? errs.slice(0,4):'none');
 console.log('---- text ----'); console.log(info.text);
 fin(0);
}
