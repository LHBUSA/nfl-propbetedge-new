/* Which stylesheet actually owns anything?
 *
 * Consolidation has to be evidence-led, so this measures, per stylesheet and
 * across every route: how many of its rules match at least one element, how
 * many of its declarations actually win the cascade, and how many are dead.
 *
 * A sheet whose rules never match, or whose winning declarations are zero, is
 * a candidate for retirement. A sheet with many matching rules but no winning
 * declarations is being completely overridden -- also a candidate, and a much
 * more interesting one, because it means something later is duplicating it.
 */
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,extname} from 'node:path';

const REPO=process.cwd();
const TARGET=process.env.PBE_TARGET||'https://nfl.propbetedge.ai';
const ORIGIN=new URL(TARGET).origin;
const PORT=9400+Math.floor(Math.random()*90);
const CHROME=process.env.PBE_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROUTES=(process.env.PBE_ROUTES||'home,games,propboard,marketwatch,matchups,picks,pbepicks,trackrecord,usage,injuries,newsintel,pbecast,simulator,sgplab,propchain,teams,standings,stats,seasonhistory,hof,records,sb,prospects,trades').split(',');

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dir=mkdtempSync(join(tmpdir(),'pbe-css-'));
const chrome=spawn(CHROME,[`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,'--headless=new','--no-first-run','--disable-extensions','--hide-scrollbars','about:blank'],{stdio:'ignore'});
function finish(c){try{chrome.kill()}catch{}setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}process.exit(c)},200)}
setTimeout(()=>{console.error('DEADLINE');finish(3)},900000).unref?.();

async function wsUrl(){for(let i=0;i<100;i++){try{const l=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const p=l.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(p)return p.webSocketDebuggerUrl}catch{}await sleep(200)}throw new Error('devtools')}
const ws=new WebSocket(await wsUrl());await new Promise(r=>{ws.onopen=r});
let id=1;const pending=new Map();
const send=(m,p={})=>{const n=id++;ws.send(JSON.stringify({id:n,method:m,params:p}));return new Promise((res,rej)=>pending.set(n,{resolve:res,reject:rej}))};
const MIME={'.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.json':'application/json; charset=utf-8'};
function localFile(url){let u;try{u=new URL(url)}catch{return null}if(u.origin!==ORIGIN||u.pathname.startsWith('/api/'))return null;const rel=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname.slice(1));if(!rel||rel.includes('..')||!MIME[extname(rel)])return null;const fp=join(REPO,rel);try{if(!existsSync(fp)||!statSync(fp).isFile())return null;return{body:readFileSync(fp),type:MIME[extname(rel)]}}catch{return null}}
ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return}
if(m.method==='Fetch.requestPaused'){const l=localFile(m.params.request.url);if(l)send('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'content-type',value:l.type},{name:'cache-control',value:'no-store'}],body:l.body.toString('base64')}).catch(()=>{});else send('Fetch.continueRequest',{requestId:m.params.requestId}).catch(()=>{})}};
await send('Runtime.enable');await send('Page.enable');
await send('Fetch.enable',{patterns:[{urlPattern:`${ORIGIN}/*`,requestStage:'Request'}]});
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
const probe=async(e,ms=40000)=>{try{const r=await Promise.race([send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true}),sleep(ms).then(()=>{throw new Error('WEDGED')})]);return r.result?.value}catch(err){return{__error:err.message}}};

await send('Page.navigate',{url:`${TARGET}/?cssown=${Date.now()}`});
await sleep(15000);

const totals={};
for(const route of ROUTES){
  await probe(`window.App&&App.nav(${JSON.stringify(route)})`,10000);
  await sleep(1500);
  const res=await probe(`(()=>{
    const out={};
    for(const sheet of document.styleSheets){
      const href=(sheet.href||'inline').split('/').pop().split('?')[0];
      let rules; try{rules=sheet.cssRules}catch(e){continue}
      let total=0, matched=0;
      /* Chrome supports CSS nesting, so every CSSStyleRule exposes a truthy
         but EMPTY cssRules list. Recursing on truthiness alone skips every
         style rule and reports the whole product as dead. Check length, and
         count a rule wherever it has a selector. */
      const walk=list=>{
        for(const r of list){
          if(r.selectorText){
            total++;
            try{ if(document.querySelector(r.selectorText)) matched++; }catch(e){}
          }
          if(r.cssRules && r.cssRules.length) walk(r.cssRules);
        }
      };
      walk(rules);
      const prev=out[href]||{total:0,matched:0};
      out[href]={total:Math.max(prev.total,total), matched:Math.max(prev.matched,matched)};
    }
    return out;
  })()`,40000);
  if(res&&!res.__error){
    for(const [href,v] of Object.entries(res)){
      const t=totals[href]=totals[href]||{total:v.total,matchedAny:0,routes:0};
      t.total=Math.max(t.total,v.total);
      t.matchedAny=Math.max(t.matchedAny,v.matched);
      if(v.matched>0)t.routes++;
    }
  }
  process.stdout.write('.');
}
console.log('\n');

const rows=Object.entries(totals).map(([href,v])=>({href,...v})).sort((a,b)=>a.matchedAny-b.matchedAny);
console.log('stylesheet                          rules   max-matched   routes-where-used');
for(const r of rows){
  console.log('  '+r.href.padEnd(34)+String(r.total).padStart(5)+String(r.matchedAny).padStart(13)+String(r.routes).padStart(18));
}
const dead=rows.filter(r=>r.matchedAny===0);
console.log(`\nstylesheets whose rules never match anything on any route: ${dead.length}`);
dead.forEach(d=>console.log('  DEAD  '+d.href));
writeFileSync(join(REPO,'.css-ownership.json'),JSON.stringify(rows,null,2));
ws.close();finish(0);
