/* Turn an upstream-bench capture into the number that actually matters.
 *
 * "Age of the newest play" conflates two unrelated things: how long ESPN sat
 * on a play before publishing it, and how long the game itself went without
 * running one. A two-minute warning, a timeout or a TV break makes the newest
 * play three minutes old with zero feed latency involved.
 *
 * The honest measure is per-play PUBLISH DELAY: for each distinct play, the
 * first sample in which a source showed it, minus that play's own wallclock.
 * That is what a viewer waits, and it is what the <=30s P95 target is about.
 *
 * node scripts/nfl-live-bench-report.mjs <bench json> [...more]
 */
import {readFileSync} from 'node:fs';

const files=process.argv.slice(2);
if(!files.length){console.error('usage: nfl-live-bench-report.mjs <bench json> [...]');process.exit(2)}

const pct=(a,p)=>{if(!a.length)return null;const s=a.slice().sort((x,y)=>x-y);return Math.round(s[Math.min(s.length-1,Math.ceil(p/100*s.length)-1)]*10)/10};
const med=a=>pct(a,50);

const merged={rows:[],sources:new Set()};
for(const f of files){
  const d=JSON.parse(readFileSync(f,'utf8'));
  merged.rows.push(...d.rows);
  Object.keys(d.rows[0]?.samples||{}).forEach(k=>merged.sources.add(k));
}
merged.rows.sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
const SOURCES=[...merged.sources];

/* first time each source showed each play id, and that play's own wallclock */
const seen=new Map();   // playId -> {wallclock, bySource:{src:firstSeenMs}, seq}
for(const row of merged.rows){
  for(const src of SOURCES){
    const s=row.samples[src];
    if(!s?.ok||!s.play_id)continue;
    const t=Date.parse(s.fetched_at);
    if(!seen.has(s.play_id))seen.set(s.play_id,{wallclock:s.play_wallclock||null,seq:s.play_seq??null,text:s.play_text||'',bySource:{}});
    const rec=seen.get(s.play_id);
    if(!rec.wallclock&&s.play_wallclock)rec.wallclock=s.play_wallclock;
    if(rec.bySource[src]===undefined)rec.bySource[src]=t;
  }
}

/* A play only counts for a source's latency if that source ever showed it AND
   we were already polling when it landed — otherwise the very first sample of
   the run would score an arbitrarily large "delay" for a play published before
   we started watching. */
const runStart=Date.parse(merged.rows[0].t);
const WARMUP_MS=20000;

const delays={},misses={};
for(const src of SOURCES){delays[src]=[];misses[src]=0}
let counted=0;
for(const [id,rec] of seen){
  if(!rec.wallclock)continue;
  const wall=Date.parse(rec.wallclock);
  if(!Number.isFinite(wall))continue;
  const firstAnywhere=Math.min(...Object.values(rec.bySource));
  if(firstAnywhere<runStart+WARMUP_MS)continue;      // already in flight when we started
  counted++;
  for(const src of SOURCES){
    const t=rec.bySource[src];
    if(t===undefined){misses[src]++;continue}
    delays[src].push(Math.round((t-wall)/100)/10);
  }
}

console.log(`samples=${merged.rows.length}  window=${merged.rows[0].t.slice(11,19)}..${merged.rows.at(-1).t.slice(11,19)}  distinct plays=${seen.size}  scored plays=${counted}\n`);

console.log('=== PUBLISH DELAY: first time the source showed a play, minus that play\'s wallclock (seconds) ===');
console.log('source            n  median     p95     max   never-showed');
for(const src of SOURCES){
  const a=delays[src];
  console.log(`${src.padEnd(16)} ${String(a.length).padStart(3)}  ${String(med(a)).padStart(6)}  ${String(pct(a,95)).padStart(6)}  ${String(a.length?Math.max(...a):null).padStart(6)}   ${misses[src]}`);
}

/* head-to-head: how much earlier did each source show a play than gamepackage */
const BASE='cdn_gamepackage';
if(SOURCES.includes(BASE)){
  console.log(`\n=== LEAD OVER ${BASE} (seconds earlier; negative = later) ===`);
  for(const src of SOURCES){
    if(src===BASE)continue;
    const leads=[];
    for(const [,rec] of seen){
      const a=rec.bySource[src],b=rec.bySource[BASE];
      if(a===undefined||b===undefined)continue;
      if(Math.min(a,b)<runStart+WARMUP_MS)continue;
      leads.push(Math.round((b-a)/100)/10);
    }
    if(leads.length)console.log(`${src.padEnd(16)} n=${String(leads.length).padStart(3)} median=${String(med(leads)).padStart(6)}  p95=${String(pct(leads,95)).padStart(6)}  max=${String(Math.max(...leads)).padStart(6)}`);
  }
}

/* who was first, counting ties */
const wins={};
for(const [,rec] of seen){
  const entries=Object.entries(rec.bySource);
  if(!entries.length)continue;
  const first=Math.min(...entries.map(e=>e[1]));
  entries.filter(e=>e[1]===first).forEach(([k])=>{wins[k]=(wins[k]||0)+1});
}
console.log('\n=== first to publish (ties shared) ===');
Object.entries(wins).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`${k.padEnd(16)} ${v}`));

/* observed game-clock staleness: how often was a source showing an older
   period/clock than the freshest source at the same instant */
console.log('\n=== state agreement: samples where the source trailed the freshest seq at that instant ===');
const trail={};for(const s of SOURCES)trail[s]={behind:0,total:0};
for(const row of merged.rows){
  const seqs=SOURCES.map(s=>({s,q:row.samples[s]?.ok?row.samples[s].play_seq:null})).filter(x=>Number.isFinite(x.q));
  if(seqs.length<2)continue;
  const best=Math.max(...seqs.map(x=>x.q));
  seqs.forEach(x=>{trail[x.s].total++;if(x.q<best)trail[x.s].behind++});
}
for(const s of SOURCES){const t=trail[s];if(t.total)console.log(`${s.padEnd(16)} behind on ${t.behind}/${t.total} samples (${Math.round(100*t.behind/t.total)}%)`)}
