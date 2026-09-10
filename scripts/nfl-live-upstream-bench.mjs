/* Which ESPN upstream publishes a live NFL play first?
 *
 * Polls the candidate endpoints side by side against one live event and
 * records, per sample, the newest play each one is willing to show and how
 * old that play already was when we got it. The answer decides which source
 * owns live state in api/nfl-live.js — measured during a real game, not
 * guessed from the endpoint name.
 *
 * node scripts/nfl-live-upstream-bench.mjs <eventId> [minutes] [intervalMs]
 */
import {writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';

const EVENT=String(process.argv[2]||'').trim();
const MINUTES=Number(process.argv[3]||8);
const INTERVAL=Number(process.argv[4]||3000);
const OUT=process.env.PBE_BENCH_OUT||join(process.cwd(),'.gate','pbecast');
if(!/^\d+$/.test(EVENT)){console.error('usage: nfl-live-upstream-bench.mjs <eventId> [minutes] [intervalMs]');process.exit(2)}
mkdirSync(OUT,{recursive:true});

const dateET=(()=>{const p=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const g=t=>p.find(x=>x.type===t).value;return `${g('year')}${g('month')}${g('day')}`})();

const SOURCES=[
  {key:'cdn_gamepackage', url:`https://cdn.espn.com/core/nfl/game?xhr=1&gameId=${EVENT}`},
  {key:'site_summary',    url:`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${EVENT}`},
  {key:'cdn_scoreboard',  url:`https://cdn.espn.com/core/nfl/scoreboard?xhr=1&limit=100&dates=${dateET}`},
  {key:'site_scoreboard', url:`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${dateET}`},
  {key:'core_plays',      url:`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${EVENT}/competitions/${EVENT}/plays?limit=1000`},
  {key:'pbe_api',         url:`https://nfl.propbetedge.ai/api/nfl-live?event=${EVENT}`}
];

const A=v=>Array.isArray(v)?v:[];
const S=v=>v==null?'':String(v);
const pkgOf=r=>r?.gamepackageJSON||r?.content?.gamepackageJSON||r?.page?.content?.gamepackageJSON||r;

function eventFromScoreboard(root){
  const seen=new Set();
  const walk=(n,d=0)=>{
    if(!n||typeof n!=='object'||d>6||seen.has(n))return null;
    seen.add(n);
    if(Array.isArray(n.events)&&n.events.some(e=>e?.competitions))return n.events;
    for(const v of Object.values(n))if(v&&typeof v==='object'){const h=walk(v,d+1);if(h)return h}
    return null;
  };
  return (walk(root)||[]).find(e=>S(e?.id)===EVENT)||null;
}

function readPlay(p){
  if(!p)return null;
  return {
    id:S(p.id||p.sequenceNumber||''),
    seq:Number(p.sequenceNumber||p.id||0)||null,
    text:S(p.text||p.shortText||p.type?.text||'').slice(0,90),
    wallclock:p.wallclock||null,
    period:p.period?.number??p.period??null,
    clock:p.clock?.displayValue||p.displayClock||null
  };
}

/* Newest play a payload is prepared to show, wherever that shape keeps it. */
function newestPlay(sourceKey,body){
  if(sourceKey==='pbe_api'){
    const cp=body?.current_play;
    if(!cp)return null;
    return {id:S(cp.id),seq:cp.sequence??null,text:S(cp.text||'').slice(0,90),wallclock:cp.wallclock||null,period:cp.period,clock:cp.clock};
  }
  if(sourceKey==='core_plays'){
    const items=A(body?.items).filter(p=>p?.wallclock);
    if(!items.length)return null;
    const best=items.reduce((a,b)=>Date.parse(b.wallclock)>Date.parse(a.wallclock)?b:a);
    return readPlay(best);
  }
  if(sourceKey==='cdn_scoreboard'||sourceKey==='site_scoreboard'){
    const ev=eventFromScoreboard(body);
    const comp=A(ev?.competitions)[0]||{};
    return readPlay(comp?.situation?.lastPlay);
  }
  const pkg=pkgOf(body);
  const cands=[];
  const cur=pkg?.drives?.current;
  if(cur)A(cur.plays).forEach(p=>cands.push(p));
  A(pkg?.drives?.previous).forEach(d=>A(d.plays).forEach(p=>cands.push(p)));
  A(pkg?.plays).forEach(p=>cands.push(p));
  const sit=A(pkg?.header?.competitions)[0]?.situation?.lastPlay;
  if(sit)cands.push(sit);
  if(!cands.length)return null;
  /* Prefer the latest wallclock; fall back to sequence. */
  let best=null;
  for(const raw of cands){
    const p=readPlay(raw);if(!p)continue;
    const t=p.wallclock?Date.parse(p.wallclock):NaN;
    const bt=best?.wallclock?Date.parse(best.wallclock):NaN;
    if(!best)best=p;
    else if(Number.isFinite(t)&&Number.isFinite(bt)){if(t>bt)best=p}
    else if((p.seq||0)>(best.seq||0))best=p;
  }
  return best;
}

function gameState(sourceKey,body){
  if(sourceKey==='core_plays'){
    const p=newestPlay('core_plays',body)||{};
    return {period:p.period??null,clock:p.clock??null,score:'',possession:null,semantics:'LIVE'};
  }
  if(sourceKey==='pbe_api'){
    const g=body?.game||{};
    return {period:g.status?.period??null,clock:g.status?.clock??null,
      score:`${g.teams?.away?.score??''}-${g.teams?.home?.score??''}`,
      possession:g.situation?.possession_id??null,semantics:g.status?.semantics??null};
  }
  let comp;
  if(sourceKey==='cdn_scoreboard'||sourceKey==='site_scoreboard')comp=A(eventFromScoreboard(body)?.competitions)[0]||{};
  else comp=A(pkgOf(body)?.header?.competitions)[0]||{};
  const st=comp.status||{};
  const away=A(comp.competitors).find(c=>c.homeAway==='away')||{};
  const home=A(comp.competitors).find(c=>c.homeAway==='home')||{};
  return {period:st.period??null,clock:st.displayClock??null,
    score:`${away.score??''}-${home.score??''}`,
    possession:comp.situation?.possession??null,
    semantics:S(st.type?.state)==='in'?'LIVE':S(st.type?.state)};
}

async function sample(src){
  const t0=Date.now();
  try{
    const r=await fetch(src.url,{headers:{accept:'application/json,text/plain,*/*','cache-control':'no-cache'},cache:'no-store'});
    const age=r.headers.get('age'), xv=r.headers.get('x-vercel-cache');
    const body=await r.json();
    const t1=Date.now();
    const play=newestPlay(src.key,body);
    const wall=play?.wallclock?Date.parse(play.wallclock):NaN;
    return {ok:r.ok,status:r.status,rtt:t1-t0,fetched_at:new Date(t1).toISOString(),
      edge_age:age,edge_cache:xv,...gameState(src.key,body),
      play_id:play?.id||null,play_seq:play?.seq??null,play_text:play?.text||null,
      play_wallclock:play?.wallclock||null,
      play_age_s:Number.isFinite(wall)?Math.round((t1-wall)/100)/10:null};
  }catch(e){return {ok:false,error:String(e?.message||e).slice(0,120),fetched_at:new Date().toISOString()}}
}

const rows=[];
const until=Date.now()+MINUTES*60000;
console.log(`event=${EVENT} date=${dateET} for ${MINUTES}m @ ${INTERVAL}ms`);
console.log(`sources: ${SOURCES.map(s=>s.key).join(', ')}\n`);
let n=0;
while(Date.now()<until){
  const t=new Date().toISOString();
  const res=await Promise.all(SOURCES.map(sample));
  const row={t,samples:Object.fromEntries(SOURCES.map((s,i)=>[s.key,res[i]]))};
  rows.push(row);
  if(++n%5===1){
    console.log(t.slice(11,19)+'  '+SOURCES.map((s,i)=>{
      const r=res[i];
      return `${s.key}=${r.ok?`Q${r.period ?? '-'} ${String(r.clock??'-').padStart(5)} ${String(r.score).padEnd(5)} age=${r.play_age_s==null?'  n/a':String(r.play_age_s).padStart(5)}s seq=${String(r.play_seq??'-').slice(-6)}`:'ERR'}`;
    }).join('\n          '));
    console.log('');
  }
  await new Promise(r=>setTimeout(r,INTERVAL));
}

/* Latency summary per source, over samples where the game was actually LIVE. */
const pct=(a,p)=>{if(!a.length)return null;const s=a.slice().sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p/100*s.length))]};
const summary={};
for(const s of SOURCES){
  const ages=rows.map(r=>r.samples[s.key]).filter(x=>x?.ok&&x.semantics==='LIVE'&&x.play_age_s!=null).map(x=>x.play_age_s);
  const errs=rows.filter(r=>!r.samples[s.key]?.ok).length;
  summary[s.key]={samples:ages.length,errors:errs,
    median:pct(ages,50),p95:pct(ages,95),min:ages.length?Math.min(...ages):null,max:ages.length?Math.max(...ages):null,
    rtt_median:pct(rows.map(r=>r.samples[s.key]?.rtt).filter(Number.isFinite),50)};
}

/* Who saw each play first? */
const firstSeen=new Map();
for(const r of rows)for(const s of SOURCES){
  const x=r.samples[s.key];if(!x?.ok||!x.play_id)continue;
  if(!firstSeen.has(x.play_id))firstSeen.set(x.play_id,{t:r.t,by:[s.key]});
  else if(firstSeen.get(x.play_id).t===r.t&&!firstSeen.get(x.play_id).by.includes(s.key))firstSeen.get(x.play_id).by.push(s.key);
}
const wins={};
for(const [,v] of firstSeen)v.by.forEach(k=>{wins[k]=(wins[k]||0)+1});

const file=join(OUT,`upstream-bench-${EVENT}.json`);
writeFileSync(file,JSON.stringify({event:EVENT,dateET,minutes:MINUTES,intervalMs:INTERVAL,summary,firstPlayWins:wins,distinctPlays:firstSeen.size,rows},null,2));
console.log('\n=== latest-play age while LIVE (seconds) ===');
for(const [k,v] of Object.entries(summary))console.log(`${k.padEnd(16)} n=${String(v.samples).padStart(4)} median=${String(v.median).padStart(6)} p95=${String(v.p95).padStart(6)} min=${String(v.min).padStart(6)} max=${String(v.max).padStart(6)} rtt~${v.rtt_median}ms errors=${v.errors}`);
console.log(`\n=== first to publish a play (of ${firstSeen.size} distinct plays) ===`);
Object.entries(wins).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`${k.padEnd(16)} ${v}`));
console.log(`\nreport: ${file}`);
