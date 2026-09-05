/* Render the isolated prototype from a local file server and capture frames. */
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,extname} from 'node:path';
import http from 'node:http';
const ROOT='C:/Workers/nfl-propbetedge-new/prototype/arcade';
const OUT=process.argv[2]||'./review/arcade';
const WIDTHS=(process.argv[3]||'1280,390').split(',').map(Number);
mkdirSync(OUT,{recursive:true});
const MIME={'.html':'text/html','.js':'application/javascript','.json':'application/json','.css':'text/css'};
const server=http.createServer((req,res)=>{
  let p=decodeURIComponent(req.url.split('?')[0]); if(p==='/')p='/index.html';
  const fp=join(ROOT,p.slice(1));
  if(!existsSync(fp)||!statSync(fp).isFile()){res.writeHead(404);res.end('nf');return}
  res.writeHead(200,{'content-type':MIME[extname(fp)]||'text/plain','cache-control':'no-store'});
  res.end(readFileSync(fp));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const PORT=server.address().port;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dir=mkdtempSync(join(tmpdir(),'pbe-arc-'));
const PORTD=9930+Math.floor(Math.random()*50);
const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
  [`--remote-debugging-port=${PORTD}`,`--user-data-dir=${dir}`,'--headless=new','--no-first-run','--hide-scrollbars','--force-device-scale-factor=1','about:blank'],{stdio:'ignore'});
async function ws(){for(let i=0;i<100;i++){try{const l=await(await fetch(`http://127.0.0.1:${PORTD}/json/list`)).json();const p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl}catch{}await sleep(200)}throw new Error('nodevtools')}
const sock=new WebSocket(await ws());await new Promise(r=>{sock.onopen=r});
let id=1;const pend=new Map();
const send=(m,p={})=>{const n=id++;sock.send(JSON.stringify({id:n,method:m,params:p}));return new Promise((res,rej)=>pend.set(n,{res,rej}))};
const errs=[];
sock.onmessage=e=>{const m=JSON.parse(e.data);
 if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result);return}
 if(m.method==='Runtime.exceptionThrown')errs.push(String(m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text||'').slice(0,200));};
await send('Runtime.enable');await send('Page.enable');
const evalx=async(e,ms=15000)=>{try{const r=await Promise.race([send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true}),sleep(ms).then(()=>{throw new Error('WEDGED')})]);return r.result?.value}catch(x){return{__error:x.message}}};
const PLAYS=(process.env.ARC_PLAYS||'COMPLETED PASS,RUSH,TOUCHDOWN,TURNOVER,INCOMPLETE').split(',');
if(process.env.ARC_REDUCED){await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});}
for(const w of WIDTHS){
  await send('Emulation.setDeviceMetricsOverride',{width:w,height:w<600?844:900,deviceScaleFactor:1,mobile:w<600,screenWidth:w,screenHeight:w<600?844:900});
  await send('Emulation.setTouchEmulationEnabled',{enabled:w<600,maxTouchPoints:w<600?5:1});
  await send('Page.navigate',{url:`http://127.0.0.1:${PORT}/index.html`});
  await sleep(3000);
  for(const label of PLAYS){
    await evalx(`(()=>{const b=[...document.querySelectorAll('#picker button')].find(x=>x.dataset.label===${JSON.stringify(label)});b.click();return !!b})()`);
    await sleep(1400);                       // mid-animation frame
    let s=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(join(OUT,`${label.replace(/\s+/g,'-').toLowerCase()}-${w}-mid.png`),Buffer.from(s.data,'base64'));
    await evalx(`document.getElementById('btn-skip').click()`);
    await sleep(500);
    s=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(join(OUT,`${label.replace(/\s+/g,'-').toLowerCase()}-${w}-end.png`),Buffer.from(s.data,'base64'));
  }
  const state=await evalx(`(()=>({exceptions:0,overflow:Math.round(document.documentElement.scrollWidth-document.documentElement.clientWidth),canvasW:document.getElementById('field').width,canvasH:document.getElementById('field').height,rows:document.querySelectorAll('#prov tr').length}))()`);
  console.log(w,JSON.stringify(state),'exceptions',errs.length,errs.slice(0,2));
}
try{chrome.kill()}catch{};server.close();
console.log('wrote',OUT);
process.exit(0);
