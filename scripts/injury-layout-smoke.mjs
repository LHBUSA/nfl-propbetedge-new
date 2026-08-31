/* Injury Editorial focused browser gate.
 * Uses production origin/APIs while substituting checked-out branch static
 * files. Verifies the injuries route is a photo-led PropBetEdge article desk
 * with source-disciplined player availability, reported return windows, and a
 * high-contrast readable availability surface on desktop + mobile.
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
  const board=root.querySelector('.pbe13-availability-board');
  const columns=board?.querySelector('.pbe13-availability-columns');
  const availabilityRows=[...root.querySelectorAll('.pbe13-availability-row')];
  const firstRow=availabilityRows[0];
  const playerName=firstRow?.querySelector('.pbe13-availability-player strong');
  const teamCell=firstRow?.querySelector(':scope > .pbe13-availability-team .team-code');
  const injuryValue=firstRow?.querySelector(':scope > .pbe13-availability-cell:nth-child(3)>strong');
  const statusValue=firstRow?.querySelector(':scope > .pbe13-availability-cell:nth-child(4) .pbe13-avail-status');
  const timelineValue=firstRow?.querySelector('.pbe13-availability-cell.timeline>strong');
  const foot=board?.querySelector('.pbe13-availability-foot');
  const px=el=>el?parseFloat(getComputedStyle(el).fontSize)||0:0;
  const timelineValues=availabilityRows.map(row=>row.querySelector('.pbe13-availability-cell.timeline>strong')?.textContent?.trim()||'');
  const reportedTimelines=timelineValues.filter(value=>value&&value!=='Timeline not reported');
  const isPbeArticle=href=>{try{const u=new URL(href);return u.hostname==='propbetedge.ai'&&u.pathname.startsWith('/news/nfl/')}catch{return false}};
  const links=[...root.querySelectorAll('a[href]')].map(a=>a.href).filter(isPbeArticle);
  const badLinks=[...root.querySelectorAll('.pbe13-editorial-lead a[href],.pbe13-editorial-card[href],.pbe13-availability-row[href]')].map(a=>a.href).filter(h=>!isPbeArticle(h));
  const imgs=[...root.querySelectorAll('.pbe13-editorial-lead img,.pbe13-editorial-card img')];
  const loaded=imgs.filter(i=>i.complete&&i.naturalWidth>0);
  const broken=imgs.filter(i=>i.complete&&!i.naturalWidth);
  const controls=root.querySelectorAll('#pbe13-summary,.pbe13-controls,.pbe13-side,.pbe13-story-player,.pbe13-impact');
  const boardStyle=board?getComputedStyle(board):null;
  const rowCells=firstRow?[...firstRow.children].slice(0,5):[];
  const rowLefts=rowCells.map(el=>Math.round(el.getBoundingClientRect().left));
  const renderedColumns=new Set(rowLefts).size;
  const orderedColumns=rowLefts.every((left,index)=>index===0||left>rowLefts[index-1]);
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
    availabilityBoard:!!board,
    availabilityRows:availabilityRows.length,
    reportedTimelines:reportedTimelines.length,
    availabilityText:/who's out & how long/i.test(root.textContent||''),
    readabilityAuthority:root.dataset.pbeInjuryReadability||null,
    columnCount:columns?.children?.length||0,
    columnDisplay:columns?getComputedStyle(columns).display:null,
    columnFont:px(columns?.querySelector('span')),
    teamColumn:!!teamCell,
    renderedColumns,
    orderedColumns,
    rowLefts,
    playerFont:px(playerName),
    teamFont:px(teamCell),
    injuryFont:px(injuryValue),
    statusFont:px(statusValue),
    timelineFont:px(timelineValue),
    footFont:px(foot),
    boardBg:boardStyle?.backgroundColor||null,
    text:(root.textContent||'').trim().length
  };
})()`);
out(`desktop ${JSON.stringify(desktop)}`);
if(!desktop||typeof desktop!=='object'||desktop.root!==true||desktop.heroHeight>255||desktop.lead!==true||desktop.leadImage!==true||desktop.leadMediaWidth<500||desktop.cards<5||desktop.articleLinks<6||desktop.badLinks!==0||desktop.images<6||desktop.loadedImages<1||desktop.broken>0||desktop.telemetryNodes!==0||desktop.impactText!==false||desktop.editorialText!==true||desktop.availabilityBoard!==true||desktop.availabilityRows<3||desktop.reportedTimelines<2||desktop.availabilityText!==true||desktop.readabilityAuthority!=='5'||desktop.columnCount!==5||desktop.columnDisplay!=='grid'||desktop.columnFont<9.5||desktop.teamColumn!==true||desktop.renderedColumns!==5||desktop.orderedColumns!==true||desktop.playerFont<18||desktop.teamFont<11||desktop.injuryFont<12||desktop.statusFont<10||desktop.timelineFont<13||desktop.footFont<9.5||!desktop.boardBg||desktop.boardBg==='rgba(0, 0, 0, 0)'||desktop.text<1500)pass=false;

const binding=await probe(`(()=>{
  const api=window.PBEInjuryIntelV2;
  if(!api?.factForArticle)return{ready:false};
  const er=api.factForArticle({
    title:'Eagles Face Tight End Depth Crisis Before Week 1; Ertz Reunion Unlikely to Move Receiving Props',
    summary:"Philadelphia's hamstring injury to rookie Eli Stowers has forced a pass-catching look, but a Zach Ertz return would address depth, not production.",
    slug:'synthetic-ertz',topic_kind:'injury',teams:['PHI'],players:['Zach Ertz','Dallas Goedert','Eli Stowers']
  });
  const bad=api.factForArticle({
    title:'Aaron Donald takes part in Rams practice Sunday',
    summary:"Twenty months after tearing his ACL, Dell remains unavailable for Houston's opener, forcing the Texans to lean harder on secondary receiving targets.",
    slug:'synthetic-bad',topic_kind:'general',teams:['HOU'],players:['Tank Dell','C.J. Stroud']
  });
  const timed=api.factForArticle({
    title:"Charbonnet Out Through Week 4: Seattle's Backfield Pivot Opens Price's Path",
    summary:"The Seahawks' co-starter remains sidelined until Week 5, handing a rookie first-rounder the early-season lead role.",
    slug:'synthetic-timeline',topic_kind:'transaction',teams:['SEA'],players:['Zach Charbonnet','Jadarian Price']
  });
  return{ready:true,ertzPlayer:er?.player||null,ertzInjury:er?.injury||null,badIsNull:bad===null,timeline:timed?.timeline||null};
})()`);
out(`binding ${JSON.stringify(binding)}`);
if(!binding||typeof binding!=='object'||binding.ready!==true||binding.ertzPlayer!=='Eli Stowers'||binding.ertzInjury!=='Hamstring'||binding.badIsNull!==true||!/week 4/i.test(binding.timeline||''))pass=false;
await shot('injury-editorial-desktop.png');

await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
await probe(`window.scrollTo(0,0)`);await sleep(900);
const mobile=await probe(`(()=>{
  const root=document.querySelector('.pbe13-news.pbe13-injury-editorial');
  const hero=root?.querySelector('.pbe13-editorial-hero');
  const lead=root?.querySelector('.pbe13-editorial-lead');
  const leadImg=root?.querySelector('.pbe13-editorial-lead-media img');
  const board=root?.querySelector('.pbe13-availability-board');
  const columns=board?.querySelector('.pbe13-availability-columns');
  const firstAvailability=root?.querySelector('.pbe13-availability-row');
  const player=firstAvailability?.querySelector('.pbe13-availability-player strong');
  const team=firstAvailability?.querySelector('.pbe13-availability-team .team-code');
  const injury=firstAvailability?.querySelector(':scope > .pbe13-availability-cell:nth-child(3)>strong');
  const timeline=firstAvailability?.querySelector('.pbe13-availability-cell.timeline>strong');
  const px=el=>el?parseFloat(getComputedStyle(el).fontSize)||0:0;
  return{
    root:!!root,
    heroHeight:+(hero?.getBoundingClientRect().height||0).toFixed(1),
    leadWidth:+(lead?.getBoundingClientRect().width||0).toFixed(1),
    leadImgWidth:+(leadImg?.getBoundingClientRect().width||0).toFixed(1),
    boardWidth:+(board?.getBoundingClientRect().width||0).toFixed(1),
    availabilityWidth:+(firstAvailability?.getBoundingClientRect().width||0).toFixed(1),
    columnDisplay:columns?getComputedStyle(columns).display:null,
    playerFont:px(player),
    teamFont:px(team),
    injuryFont:px(injury),
    timelineFont:px(timeline),
    overflow:document.documentElement.scrollWidth-window.innerWidth,
    route:window.App?.current
  };
})()`);
out(`mobile ${JSON.stringify(mobile)}`);
if(!mobile||typeof mobile!=='object'||mobile.root!==true||mobile.route!=='injuries'||mobile.heroHeight>330||mobile.leadWidth>390||mobile.leadImgWidth>390||mobile.boardWidth>390||mobile.availabilityWidth>390||mobile.columnDisplay!=='none'||mobile.playerFont<18||mobile.teamFont<11||mobile.injuryFont<12||mobile.timelineFont<13||mobile.overflow>2)pass=false;
await shot('injury-editorial-mobile.png');

out(`RESULT ${pass?'PASS':'FAIL'}`);
ws.close();finish(pass?0:1);
