/* Player DNA two-layer gate.
 *
 * Asserts, on all four DNA products, that:
 *   - both layers render and are visually separate
 *   - each product's current-season leader (chosen at run time) shows real 2026
 *     observations, and the card's totals equal the sum of its completed games
 *   - an active player with a missing sample (chosen at run time) shows NO
 *     SAMPLE, never zeroes
 *   - every active hero's NEXT agrees with the schedule authority; a retired
 *     player gets no NEXT, no market chip and "Last team"
 *   - the historical baseline is labelled as prior-season, never as 2026
 *   - a rookie/no-history player is not given manufactured DNA
 *
 * node scripts/dna-layers-gate.mjs [--width=1440] [--shots]
 */
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,extname} from 'node:path';
import {currentPlayerInvariants} from './lib/nfl-state-invariants.mjs';

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
 const nx=document.querySelector('.q2-hero-next');
 const mod2={qbdna:'PBEQBDna',wrdna:'PBEWRDna',rbdna:'PBERBDna',tedna:'PBETEDna'}[App.current];
 const g2=window[mod2]&&window[mod2].state&&window[mod2].state.ctx&&window[mod2].state.ctx.game;
 const meta=document.querySelector('.q2-hero-meta');
 return {present:true, player:p&&p.name, espn_id:p&&p.espn_id, team:p&&((p.team&&p.team.abbreviation)||p.current_team), active2026:p&&p.active_2026,
   nextPresent:!!nx, marketChip:!!document.querySelector('.q2-hero-next-mkt, .q2-hero-lines'), heroMeta:meta?meta.textContent.replace(/\\s+/g,' ').trim():'',
   nextText:nx?nx.textContent.replace(/\\s+/g,' ').trim():'', nextStatus:g2?String(g2.status||''):null,
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
    await evalIn(`(async()=>{const m=window.${mod};m.state.playerId=${JSON.stringify(playerId)};m.state.dna=null;m.state.cmp=null;m.state.lab=null;m.state.ctx=null;m.state.ctxCmp=null;m.state.eventId=null;await m.load();return true})()`);
    await sleep(3500);
    for(let i=0;i<20;i++){const ok=await evalIn(`(()=>{const e=document.querySelector('.q2-hero-next');return !e||!!e.querySelector('.q2-hero-next-mkt')||e.classList.contains('is-none')})()`);if(ok===true)break;await sleep(500)}
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

/* Players are chosen by what they ARE, from authoritative data at run time,
   never pinned to one day's game. The old fixtures (players from the Sept 10
   NE @ SEA game, Josh Allen as "not played") became false the next Sunday. */
const GW='https://nfl-api.propbetedge.ai';
const getJ=async u=>{const r=await fetch(u,{headers:{accept:'application/json'}});if(!r.ok)throw new Error(`${u} ${r.status}`);return r.json()};
const SEASON=await getJ(`${GW}/api/season`);
const CSTATS=await getJ(`${GW}/api/current-stats?season=${SEASON.season}`);
const PRODUCT={qbdna:['qb','passing'],rbdna:['rb','rushing'],wrdna:['wr','receiving'],tedna:['te','receiving']};
const LISTS={};
for(const [route,[pos]] of Object.entries(PRODUCT))LISTS[route]=(await getJ(`${ORIGIN}/api/${pos}-dna?list=1`)).players||[];
const byEspn=route=>new Map(LISTS[route].map(p=>[String(p.espn_id),p]));

/* PLAYED: the top current-season producer in each product's category. */
const PLAYED=[];
for(const [route,[,cat]] of Object.entries(PRODUCT)){
  const m=byEspn(route);
  const lead=(CSTATS.categories?.[cat]?.leaders||[]).find(l=>m.has(String(l.id)));
  if(lead)PLAYED.push([route,m.get(String(lead.id)).gsis_id,`${lead.player} (${lead.team}) · ${cat} leader`,lead]);
}
/* UNOBSERVED: an active QB whose current-player verdict is a missing sample. */
let UNOBS=null;
for(const p of LISTS.qbdna.filter(x=>x.active_2026&&x.team_2026).slice(0,80)){
  const r=await getJ(`${GW}/api/current-player?espn_id=${p.espn_id}&team=${p.team_2026}`).catch(()=>null);
  if(r&&r.ok!==false&&r.available===false){UNOBS={p,api:r};break}
}
/* ROOKIE: an active player with no prior NFL sample. */
const ROOKIE_ROW=Object.entries(LISTS).flatMap(([route,list])=>list.filter(p=>p.active_2026&&p.history_available===false).map(p=>[route,p]))[0]||null;
/* RETIRED: a player the 2026 roster audit does not carry (Tom Brady when listed). */
const RETIRED_ROW=LISTS.qbdna.find(p=>String(p.espn_id)==='2330'&&p.active_2026===false)||LISTS.qbdna.find(p=>p.active_2026===false&&p.games>30)||null;
console.log('selected:',JSON.stringify({played:PLAYED.map(x=>x[2]),unobserved:UNOBS&&`${UNOBS.p.name} (${UNOBS.api.reason})`,rookie:ROOKIE_ROW&&ROOKIE_ROW[1].name,retired:RETIRED_ROW&&RETIRED_ROW.name}));

for(const [r,pid,l] of PLAYED) await check(r,pid,l,'played');
const NOTPLAYED=UNOBS?await check('qbdna',UNOBS.p.gsis_id,`${UNOBS.p.name} (${UNOBS.p.team_2026}) unobserved`,'not_played'):{};
const ROOKIE=ROOKIE_ROW?await check(ROOKIE_ROW[0],ROOKIE_ROW[1].gsis_id,`${ROOKIE_ROW[1].name} rookie`,'rookie'):{};
const RETIRED=RETIRED_ROW?await check('qbdna',RETIRED_ROW.gsis_id,`${RETIRED_ROW.name} retired`,'retired'):{};

/* current-season totals equal completed-game truth, straight from the API the card renders */
const apiRows=[];
for(const [,,l,lead] of PLAYED){const api=await getJ(`${GW}/api/current-player?espn_id=${lead.id}&team=${lead.team}`);apiRows.push({label:l,lead,api,inv:currentPlayerInvariants(api)})}

console.log('\n--- gates ---');
const played=rows.filter(r=>r.expect==='played');
const active=rows.filter(r=>r.present&&r.expect!=='retired');
const nextAgrees=r=>{
  const t=SEASON.team_schedule&&SEASON.team_schedule[r.team];
  if(!SEASON.team_schedule)return false;
  if(!t||!t.next)return /no scheduled game/i.test(r.nextText)||r.nextText==='';
  const [aw,hm]=t.next.name.split(' @ ');
  const day=new Date(t.next.kickoff_utc).toLocaleDateString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric'}).toUpperCase();
  return r.nextText.includes(aw)&&r.nextText.includes(hm)&&r.nextText.includes(day)&&!/no (upcoming|scheduled) game/i.test(r.nextText)&&/Market (open|unavailable)/.test(r.nextText);
};
const checks=[
  ['a played player was found for every product',PLAYED.length===4,PLAYED.map(x=>x[0])],
  ['an unobserved active player was found (missing-sample case exists)',!!UNOBS],
  ['layer present on every DNA product',['qbdna','wrdna','rbdna','tedna'].every(rt=>rows.some(r=>r.route===rt&&r.present))],
  ['played players show 2026 CURRENT',played.length>0&&played.every(r=>/2026 CURRENT/.test(r.current)&&!r.currentIsNone)],
  ['played players show real production',played.length>0&&played.every(r=>/\d/.test(r.current)&&/yds|rec|car/.test(r.current))],
  ...apiRows.flatMap(x=>x.inv.map(i=>[`${x.label}: ${i.name}`,i.ok,i.detail])),
  ['played cards print the API totals (card = completed-game truth)',apiRows.length>0&&apiRows.every(x=>{const row=played.find(r=>String(r.espn_id)===String(x.lead.id));const s=x.api.stats||{};const cat=Object.keys(s)[0];return row&&cat&&row.current.includes(String(s[cat].yards))}),apiRows.map(x=>({label:x.label,stats:x.api.stats&&Object.fromEntries(Object.entries(x.api.stats).map(([k,v])=>[k,v.yards]))}))],
  ...(UNOBS?currentPlayerInvariants(UNOBS.api).map(i=>[`unobserved ${UNOBS.p.name}: ${i.name}`,i.ok,i.detail]):[]),
  ['missing sample renders as NO SAMPLE, never a figure',!!UNOBS&&/2026 CURRENT SAMPLE/.test(NOTPLAYED.current)&&NOTPLAYED.currentIsNone],
  ['missing sample says why (no completed game / no recorded participation)',!!UNOBS&&/No completed 2026 regular-season game yet|No recorded participation/i.test(NOTPLAYED.current)],
  ['missing sample prints no zero figures',!!UNOBS&&!/\b0 ?(yds|rec|car|tgt|att|TD|INT)\b/i.test(NOTPLAYED.current)&&!/\b0%/.test(NOTPLAYED.current)],
  ['baseline labelled historical everywhere',rows.filter(r=>r.present).every(r=>/HISTORICAL BASELINE/.test(r.baseline))],
  ['baseline card is not tagged 2026 CURRENT',rows.filter(r=>r.present).every(r=>!/^\s*2026 CURRENT/.test(String(r.baseline)))],
  ['baseline states prior-season basis',rows.filter(r=>r.present&&!r.baselineIsNone).every(r=>/Prior-season and career facts/i.test(r.baseline))],
  ['layers are separate cards',rows.filter(r=>r.present).every(r=>r.current&&r.baseline&&r.current!==r.baseline)],
  ['no horizontal overflow',rows.every(r=>(r.overflow||0)<=0)],
  ['rookie baseline says sample unavailable',!ROOKIE_ROW||(ROOKIE.baselineIsNone&&/Historical sample unavailable/i.test(ROOKIE.baseline))],
  ['rookie baseline manufactures nothing',!ROOKIE_ROW||!/STRONG SAMPLE|Sample \d+\s*games/i.test(ROOKIE.baseline)],
  ['a finished game is never shown as Next',rows.every(r=>!/FINAL|POST/i.test(String(r.nextStatus||'')))],
  ['hero NEXT agrees with the schedule authority for every active player',active.length>0&&active.every(nextAgrees),active.filter(r=>!nextAgrees(r)).map(r=>({label:r.label,team:r.team,next:r.nextText}))],
  ['retired player: no NEXT matchup and no market chip',!!RETIRED_ROW&&RETIRED.present&&!RETIRED.nextPresent&&!RETIRED.marketChip,RETIRED_ROW&&{next:RETIRED.nextText,chip:RETIRED.marketChip}],
  ['retired player: Last team, not current team',!!RETIRED_ROW&&/Last team/.test(RETIRED.heroMeta||''),RETIRED.heroMeta],
  ['no uncaught exceptions',rows.every(r=>!r.exceptions.length),rows.filter(r=>r.exceptions.length).map(r=>[r.label,r.exceptions[0]])]
];
let failed=0;
for(const [n,ok,detail] of checks){if(!ok)failed++;console.log(`  ${ok?'PASS':'FAIL'}  ${n}${!ok&&detail!=null?'  — '+JSON.stringify(detail).slice(0,300):''}`)}

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
