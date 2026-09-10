/* Player DNA two-layer gate.
 *
 * Asserts, on all four DNA products, that:
 *   - both layers render and are visually separate
 *   - a player from the completed NE @ SEA game shows real 2026 observations
 *   - a player whose team has not kicked off shows NO SAMPLE, never zeroes
 *   - the historical baseline is labelled as prior-season, never as 2026
 *   - a rookie/no-history player is not given manufactured DNA
 *
 * node scripts/dna-layers-gate.mjs [--width=1440] [--shots]
 */
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,extname} from 'node:path';

const REPO=process.cwd();
const TARGET=process.env.PBE_GATE_TARGET||'https://nfl.propbetedge.ai';
const ORIGIN=new URL(TARGET).origin;
const WIDTH=Number((process.argv.find(a=>a.startsWith('--width='))||'--width=1440').split('=')[1]);
const SHOTS=process.argv.includes('--shots');
const OUT=process.env.PBE_GATE_OUT||join(REPO,'.gate','dna');
const LABEL=process.env.PBE_GATE_LABEL||'dna';
const LIVE=process.env.PBE_GATE_LIVE==='1';
const CHROME=process.env.PBE_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT=9280+Math.floor(Math.random()*90);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dir=mkdtempSync(join(tmpdir(),'pbe-dna-'));
mkdirSync(OUT,{recursive:true});
const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'--headless=new','--no-first-run','--disable-extensions','--hide-scrollbars','about:blank'],{stdio:'ignore'});
function finish(c){try{chrome.kill()}catch{}setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}process.exit(c)},250)}
setTimeout(()=>{console.error('DEADLINE');finish(3)},600000).unref?.();

async function wsUrl(){for(let i=0;i<120;i++){try{const l=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl}catch{}await sleep(200)}throw new Error('devtools_unreachable')}
const ws=new WebSocket(await wsUrl());
await new Promise(r=>{ws.onopen=r});
let id=1;const pending=new Map();
const send=(m,p={})=>{const n=id++;ws.send(JSON.stringify({id:n,method:m,params:p}));return new Promise((res,rej)=>pending.set(n,{resolve:res,reject:rej}))};

const MIME={'.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2','.webmanifest':'application/manifest+json; charset=utf-8'};
function localFile(url){
  if(LIVE)return null;
  let u;try{u=new URL(url)}catch{return null}
  if(u.origin!==ORIGIN||u.pathname.startsWith('/api/'))return null;
  const rel=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname.slice(1));
  if(!rel||rel.includes('..')||!MIME[extname(rel)])return null;
  const fp=join(REPO,rel);
  try{if(!existsSync(fp)||!statSync(fp).isFile())return null;return{body:readFileSync(fp),type:MIME[extname(rel)]}}catch{return null}
}
let exceptions=[];
ws.onmessage=ev=>{
  const m=JSON.parse(ev.data);
  if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return}
  if(m.method==='Fetch.requestPaused'){
    const l=localFile(m.params.request.url);
    if(l)send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'content-type',value:l.type},{name:'cache-control',value:'no-store'}],body:l.body.toString('base64')}).catch(()=>{});
    else send('Fetch.continueRequest',{requestId:m.params.requestId}).catch(()=>{});
    return;
  }
  if(m.method==='Runtime.exceptionThrown')exceptions.push(String(m.params.exceptionDetails?.exception?.description||'').slice(0,180));
};
await send('Runtime.enable');await send('Page.enable');
await send('Fetch.enable',{patterns:[{urlPattern:`${ORIGIN}/*`,requestStage:'Request'}]});
await send('Emulation.setDeviceMetricsOverride',{width:WIDTH,height:WIDTH<600?900:1000,deviceScaleFactor:1,mobile:WIDTH<600});

const evalIn=async(expr,ms=40000)=>{
  try{const r=await Promise.race([send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true}),sleep(ms).then(()=>{throw new Error('WEDGED')})]);return r.result?.value}
  catch(e){return{__error:e.message}}
};

const READ=`(()=>{const b=document.querySelector('[data-pbe-current-layer]');
 if(!b)return {present:false};
 const cur=b.querySelector('.pbe-cl-card.is-current'), base=b.querySelector('.pbe-cl-card.is-baseline');
 const t=el=>el?el.textContent.replace(/\\s+/g,' ').trim():'';
 const g=(window.PBEQBDna||window.PBEWRDna||window.PBERBDna||window.PBETEDna);
 const p=(function(){const m={qbdna:'PBEQBDna',wrdna:'PBEWRDna',rbdna:'PBERBDna',tedna:'PBETEDna'}[App.current];const s=window[m]&&window[m].state&&window[m].state.dna;return s&&s.player||null})();
 return {present:true, player:p&&p.name, espn_id:p&&p.espn_id, team:p&&p.current_team,
   current:t(cur), baseline:t(base),
   currentIsNone:!!(cur&&cur.classList.contains('is-none')),
   baselineIsNone:!!(base&&base.classList.contains('is-none')),
   overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}})()`;

console.log(`DNA layers gate -> ${TARGET} @${WIDTH}px\n`);
await send('Page.navigate',{url:`${TARGET}/#qbdna`});
await sleep(13000);

const rows=[];
async function check(route,playerId,label,expect){
  exceptions=[];
  await evalIn(`App.nav('${route}')`);
  await sleep(2500);
  if(playerId){
    const mod={qbdna:'PBEQBDna',wrdna:'PBEWRDna',rbdna:'PBERBDna',tedna:'PBETEDna'}[route];
    await evalIn(`(async()=>{const m=window.${mod};m.state.playerId=${JSON.stringify(playerId)};m.state.dna=null;m.state.cmp=null;m.state.lab=null;await m.load();return true})()`);
    await sleep(3500);
    await evalIn(`window.PBECurrentLayer&&PBECurrentLayer.sync(true)`);
    await sleep(2500);
  }
  const r=await evalIn(READ);
  rows.push({route,label,expect,...r,exceptions:[...exceptions]});
  const cur=String(r.current||'').slice(0,110);
  console.log(`${route.padEnd(7)} ${String(label).padEnd(26)} present=${r.present} none=${r.currentIsNone} ovf=${r.overflow}`);
  console.log(`         current : ${cur}`);
  if(r.baseline)console.log(`         baseline: ${String(r.baseline).slice(0,100)}`);
  return r;
}

/* Players from the completed NE @ SEA game, one per product. */
const PLAYED=[
  ['qbdna','00-0039851','Drake Maye (NE)'],
  ['qbdna','00-0035704','Drew Lock (SEA)'],
  ['wrdna','00-0038543','Jaxon Smith-Njigba (SEA)'],
  ['rbdna','00-0036875','Rhamondre Stevenson (NE)'],
  ['tedna','00-0039793','AJ Barner (SEA)']
];
for(const [r,pid,l] of PLAYED) await check(r,pid,l,'played');

/* The critical rule: a team that has not kicked off must show no sample. */
const NOTPLAYED=await check('qbdna','00-0034857','Josh Allen (BUF)','not_played');

/* A rookie with no prior NFL sample: the baseline must say so rather than
   manufacture DNA, while the current layer stays free to accumulate. */
const ROOKIE=await check('qbdna','00-0041123','Behren Morton (NE) rookie','rookie');

console.log('\n--- gates ---');
const played=rows.filter(r=>r.expect==='played');
const checks=[
  ['layer present on every DNA product',['qbdna','wrdna','rbdna','tedna'].every(rt=>rows.some(r=>r.route===rt&&r.present))],
  ['played players show 2026 CURRENT',played.every(r=>/2026 CURRENT/.test(r.current)&&!r.currentIsNone)],
  ['played players show real production',played.every(r=>/\d/.test(r.current)&&/yds|rec|car/.test(r.current))],
  ['not-played shows NO SAMPLE',/2026 CURRENT SAMPLE/.test(NOTPLAYED.current)&&NOTPLAYED.currentIsNone],
  ['not-played says no completed game',/No completed 2026 regular-season game yet/i.test(NOTPLAYED.current)],
  ['not-played prints no zero figures',!/\b0 ?(yds|rec|car|tgt|att|TD|INT)\b/i.test(NOTPLAYED.current)&&!/\\b0%/.test(NOTPLAYED.current)],
  ['baseline labelled historical everywhere',rows.filter(r=>r.present).every(r=>/HISTORICAL BASELINE/.test(r.baseline))],
  ['baseline card is not tagged 2026 CURRENT',rows.filter(r=>r.present).every(r=>!/^\s*2026 CURRENT/.test(String(r.baseline)))],
  ['baseline states prior-season basis',rows.filter(r=>r.present&&!r.baselineIsNone).every(r=>/Prior-season and career facts/i.test(r.baseline))],
  ['layers are separate cards',rows.filter(r=>r.present).every(r=>r.current&&r.baseline&&r.current!==r.baseline)],
  ['no horizontal overflow',rows.every(r=>(r.overflow||0)<=0)],
  ['rookie baseline says sample unavailable',ROOKIE.baselineIsNone&&/Historical sample unavailable/i.test(ROOKIE.baseline)],
  ['rookie baseline manufactures nothing',!/STRONG SAMPLE|Sample \d+games/i.test(ROOKIE.baseline)],
  ['no uncaught exceptions',rows.every(r=>!r.exceptions.length)]
];
let failed=0;
for(const [n,ok] of checks){if(!ok)failed++;console.log(`  ${ok?'PASS':'FAIL'}  ${n}`)}

if(SHOTS){
  for(const r of ['qbdna','wrdna','rbdna','tedna']){
    await evalIn(`App.nav('${r}')`);await sleep(3500);
    await evalIn(`window.PBECurrentLayer&&PBECurrentLayer.sync(true)`);await sleep(2000);
    const shot=await send('Page.captureScreenshot',{format:'png'});
    writeFileSync(join(OUT,`${LABEL}-${r}-${WIDTH}px.png`),Buffer.from(shot.data,'base64'));
  }
}
writeFileSync(join(OUT,`${LABEL}-${WIDTH}px.json`),JSON.stringify({target:TARGET,width:WIDTH,rows,checks},null,2));
console.log(`\n[${LABEL} @${WIDTH}px] failures=${failed}`);
console.log(`report: ${join(OUT,`${LABEL}-${WIDTH}px.json`)}`);
finish(failed?1:0);
