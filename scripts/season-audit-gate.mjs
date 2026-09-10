/* Current-season audit gate.
 *
 * Walks every production route and asserts the two things that matter after a
 * season rolls over: the live surfaces describe the current season, and the
 * archive surfaces still describe the season they are an archive of. It also
 * checks the factual proof cases, so a wrong record fails the build rather
 * than a screenshot.
 *
 * node scripts/season-audit-gate.mjs [--width=1440] [--shots]
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
const OUT=process.env.PBE_GATE_OUT||join(REPO,'.gate','season');
const LABEL=process.env.PBE_GATE_LABEL||'season';
const LIVE=process.env.PBE_GATE_LIVE==='1';
const CHROME=process.env.PBE_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT=9380+Math.floor(Math.random()*90);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dir=mkdtempSync(join(tmpdir(),'pbe-season-'));
mkdirSync(OUT,{recursive:true});
const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'--headless=new','--no-first-run','--disable-extensions','--hide-scrollbars','about:blank'],{stdio:'ignore'});
function finish(c){try{chrome.kill()}catch{}setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}process.exit(c)},250)}
setTimeout(()=>{console.error('DEADLINE');finish(3)},600000).unref?.();

async function wsUrl(){for(let i=0;i<120;i++){try{const l=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl}catch{}await sleep(200)}throw new Error('devtools_unreachable')}
const ws=new WebSocket(await wsUrl());
await new Promise(r=>{ws.onopen=r});
let id=1;const pending=new Map();
const send=(m,p={})=>{const n=id++;ws.send(JSON.stringify({id:n,method:m,params:p}));return new Promise((res,rej)=>pending.set(n,{resolve:res,reject:rej}))};

const MIME={'.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2'};
function localFile(url){
  if(LIVE)return null;
  let u;try{u=new URL(url)}catch{return null}
  if(u.origin!==ORIGIN||u.pathname.startsWith('/api/'))return null;
  const rel=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname.slice(1));
  if(!rel||rel.includes('..')||!MIME[extname(rel)])return null;
  const fp=join(REPO,rel);
  try{if(!existsSync(fp)||!statSync(fp).isFile())return null;return{body:readFileSync(fp),type:MIME[extname(rel)]}}catch{return null}
}
let exceptions=[],consoleErrors=[];
ws.onmessage=ev=>{
  const m=JSON.parse(ev.data);
  if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return}
  if(m.method==='Fetch.requestPaused'){
    const l=localFile(m.params.request.url);
    if(l)send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'content-type',value:l.type},{name:'cache-control',value:'no-store'}],body:l.body.toString('base64')}).catch(()=>{});
    else send('Fetch.continueRequest',{requestId:m.params.requestId}).catch(()=>{});
    return;
  }
  if(m.method==='Runtime.exceptionThrown')exceptions.push(String(m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text||'').slice(0,200));
  if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')consoleErrors.push((m.params.args||[]).map(a=>String(a.value??a.description??'')).join(' ').slice(0,200));
};

await send('Runtime.enable');await send('Page.enable');
await send('Fetch.enable',{patterns:[{urlPattern:`${ORIGIN}/*`,requestStage:'Request'}]});
await send('Emulation.setDeviceMetricsOverride',{width:WIDTH,height:WIDTH<600?844:900,deviceScaleFactor:1,mobile:WIDTH<600});

const evalIn=async(expr,ms=30000)=>{
  try{const r=await Promise.race([send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true}),sleep(ms).then(()=>{throw new Error('WEDGED')})]);return r.result?.value}
  catch(e){return{__error:e.message}}
};

const SIG=`(()=>{const vc=document.getElementById('view-container');const el=vc&&vc.firstElementChild;const txt=(vc&&vc.textContent||'');
 return {route:(window.App&&App.current)||null,
  root:el?el.tagName.toLowerCase()+'.'+String(el.className||'').split(/\\s+/).filter(Boolean).slice(0,2).join('.'):null,
  chars:txt.trim().length, loading:!!(vc&&vc.querySelector('.view-loading')),
  has2025:/\\b2025\\b/.test(txt), has2026:/\\b2026\\b/.test(txt),
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  txt: txt.replace(/\\s+/g,' ').slice(0,260)}})()`;

console.log(`season audit -> ${TARGET} @${WIDTH}px${LIVE?' (deployed)':' (working tree)'}\n`);
await send('Page.navigate',{url:`${TARGET}/`});
await sleep(11000);

const results=[];
const visit=async(route,wait=3500)=>{
  exceptions=[];consoleErrors=[];
  if(route!=='home')await evalIn(`App.nav('${route}')`);
  await sleep(wait);
  const sig=await evalIn(SIG);
  results.push({route,...sig,exceptions:[...exceptions],consoleErrors:[...consoleErrors]});
  return sig;
};

/* Every production view on the regression bar. */
const ROUTES=['home','games','propboard','marketwatch','matchups','picks','pbepicks','trackrecord','simulator','sgplab','usage','propchain','pbecast','newsintel','injuries','trades','qbdna','wrdna','rbdna','tedna','standings','stats','teams','standings2025','stats2025','seasonhistory'];
for(const r of ROUTES){
  const s=await visit(r);
  const flag=[];
  if(s.loading)flag.push('STUCK');
  if((s.chars||0)<120)flag.push('EMPTY('+s.chars+')');
  if(s.exceptions?.length)flag.push('EX'+s.exceptions.length);
  if(s.overflow>0)flag.push('OVERFLOW+'+s.overflow);
  console.log(`${r.padEnd(15)} root=${String(s.root).slice(0,30).padEnd(30)} chars=${String(s.chars).padStart(6)} 2026=${s.has2026?'Y':'n'} 2025=${s.has2025?'Y':'n'} ovf=${s.overflow}${flag.length?'  << '+flag.join(','):''}`);
}

/* ---- factual gates ---------------------------------------------------- */
console.log('\n--- factual gates ---');
const facts=await evalIn(`(async()=>{
  const A=window.PBESeason&&PBESeason.data;
  const g='https://nfl-api.propbetedge.ai';
  const st=await fetch(g+'/api/standings?season='+(A&&A.season)).then(r=>r.json()).catch(()=>null);
  const sx=await fetch(g+'/api/current-stats?season='+(A&&A.season)).then(r=>r.json()).catch(()=>null);
  const find=(ab)=>{for(const d of (st&&st.divisions)||[])for(const t of d.teams)if(t.abbreviation===ab)return t;return null};
  return {season:A&&A.season, type:A&&A.season_type, week:A&&A.current_week, started:A&&A.season_started,
    latest:A&&A.latest_final&&(A.latest_final.away.abbreviation+' '+A.latest_final.away.score+'-'+A.latest_final.home.score+' '+A.latest_final.home.abbreviation+' '+A.latest_final.semantics),
    next:A&&A.next_game&&A.next_game.name, sea:find('SEA')&&find('SEA').record, ne:find('NE')&&find('NE').record,
    completed:st&&st.completed_games, statsAvail:sx&&sx.available, statsGames:sx&&sx.completed_games,
    topPass:sx&&sx.categories&&sx.categories.passing.leaders[0]&&(sx.categories.passing.leaders[0].player+' '+sx.categories.passing.leaders[0].yards+'yd'),
    storedEvent:localStorage.getItem('pbe_nfl_event')};
})()`,45000);
const checks=[
  ['season is 2026',facts.season===2026],
  ['season_type is REG',facts.type==='REG'],
  ['season_started true',facts.started===true],
  ['current_week is 1',facts.week===1],
  ['latest final is NE 10-13 SEA FINAL',/NE 10-13 SEA FINAL/.test(String(facts.latest))],
  ['standings SEA 1-0',facts.sea==='1-0'],
  ['standings NE 0-1',facts.ne==='0-1'],
  ['standings rest on 1 completed game',facts.completed===1],
  ['current stats available',facts.statsAvail===true],
  ['current stats from 1 game',facts.statsGames===1],
  ['top passer is a week-1 line (<400 yds)',/(\d+)yd/.test(String(facts.topPass))&&Number(String(facts.topPass).match(/(\d+)yd/)[1])<400],
  ['default event repointed off the dead id',facts.storedEvent&&facts.storedEvent!=='8c94552d022acec4a0458d70c19d3da9']
];
let failed=0;
for(const [n,ok] of checks){if(!ok)failed++;console.log(`  ${ok?'PASS':'FAIL'}  ${n}`)}
console.log('  facts:',JSON.stringify(facts));

/* live surfaces must not be describing 2025; archives must still be 2025 */
console.log('\n--- season labelling ---');
const byRoute=Object.fromEntries(results.map(r=>[r.route,r]));
const label=[
  ['standings shows 2026',byRoute.standings?.has2026===true],
  ['standings is not a 2025 table',!/2025 NFL REGULAR SEASON|VERIFIED · 2025 FINAL/.test(byRoute.standings?.txt||'')],
  ['stats shows 2026',byRoute.stats?.has2026===true],
  ['stats is not a 2025 table',!/2025 NFL REGULAR SEASON|VERIFIED · 2025 FINAL/.test(byRoute.stats?.txt||'')],
  ['2025 standings archive still 2025',byRoute.standings2025?.has2025===true],
  ['2025 stats archive still 2025',byRoute.stats2025?.has2025===true]
];
for(const [n,ok] of label){if(!ok)failed++;console.log(`  ${ok?'PASS':'FAIL'}  ${n}`)}

const stuck=results.filter(r=>r.loading||(r.chars||0)<120||r.exceptions.length);
const ovf=results.filter(r=>r.overflow>0);
console.log(`\nroutes=${results.length} problem=${stuck.length} horizontal-overflow=${ovf.length}`);
if(stuck.length)stuck.forEach(r=>console.log('  PROBLEM',r.route,r.chars,r.exceptions));
if(ovf.length)ovf.forEach(r=>console.log('  OVERFLOW',r.route,r.overflow));
failed+=stuck.length+ovf.length;

if(SHOTS){
  for(const r of ['home','standings','stats']){
    await evalIn(`App.nav('${r}')`);await sleep(4000);
    const shot=await send('Page.captureScreenshot',{format:'png'});
    writeFileSync(join(OUT,`${LABEL}-${r}-${WIDTH}px.png`),Buffer.from(shot.data,'base64'));
  }
}
writeFileSync(join(OUT,`${LABEL}-${WIDTH}px.json`),JSON.stringify({target:TARGET,width:WIDTH,facts,checks,label,results},null,2));
console.log(`\n[${LABEL} @${WIDTH}px] failures=${failed}`);
console.log(`report: ${join(OUT,`${LABEL}-${WIDTH}px.json`)}`);
finish(failed?1:0);
