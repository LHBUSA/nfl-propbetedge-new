const CDN = 'https://cdn.espn.com/core/nfl';

function send(res,status,body,ttl=0){
  res.statusCode=status;
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin','*');
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('cache-control',status===200&&ttl>0?`public, s-maxage=${ttl}, stale-while-revalidate=${Math.max(10,ttl*2)}`:'no-store');
  res.end(JSON.stringify(body));
}
const A=v=>Array.isArray(v)?v:[];
const S=v=>v==null?'':String(v);
const N=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null};
const F=(...v)=>v.find(x=>x!==undefined&&x!==null&&x!=='')??null;
const image=v=>typeof v==='string'?v:(v?.href||v?.url||v?.src||null);
const logo=t=>image(A(t?.logos)[0])||image(t?.logo)||null;
const headshot=a=>image(a?.headshot)||image(A(a?.images)[0])||null;

function todayET(raw){
  const value=S(raw).replace(/\D/g,'');
  if(/^\d{8}$/.test(value))return value;
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const get=t=>parts.find(p=>p.type===t)?.value||'';
  return `${get('year')}${get('month')}${get('day')}`;
}
function semantics(status){
  const state=S(status?.type?.state).toLowerCase();
  if(state==='in')return'LIVE';
  if(state==='post'||status?.type?.completed)return'FINAL';
  if(state==='pre')return'SCHEDULE';
  return'UNAVAILABLE';
}
async function upstream(url){
  const r=await fetch(url,{headers:{accept:'application/json,text/plain,*/*'},cache:'no-store'});
  const text=await r.text();
  if(!r.ok)throw new Error(`upstream_${r.status}:${text.slice(0,140)}`);
  try{return JSON.parse(text)}catch{throw new Error('upstream_non_json')}
}
function findEvents(root){
  const seen=new Set();
  function walk(node,depth=0){
    if(!node||typeof node!=='object'||depth>6||seen.has(node))return null;
    seen.add(node);
    if(Array.isArray(node.events)&&node.events.some(e=>e?.competitions))return node.events;
    for(const value of Object.values(node)){
      if(value&&typeof value==='object'){
        const hit=walk(value,depth+1);if(hit)return hit;
      }
    }
    return null;
  }
  return walk(root)||[];
}
function packageOf(raw){return raw?.gamepackageJSON||raw?.content?.gamepackageJSON||raw?.page?.content?.gamepackageJSON||raw}
function competition(event){return A(event?.competitions)[0]||{}}
function side(comp,where){
  const c=A(comp?.competitors).find(x=>x?.homeAway===where)||{};const t=c.team||{};
  return {id:F(t.id,c.id),abbreviation:F(t.abbreviation,t.shortDisplayName),display_name:F(t.displayName,t.name,t.shortDisplayName),short_name:F(t.shortDisplayName,t.name),location:F(t.location),color:F(t.color),alternate_color:F(t.alternateColor),logo:logo(t),score:N(c.score),winner:Boolean(c.winner),possession:Boolean(c.possession),records:A(c.records).map(r=>({name:r.name,summary:r.summary,type:r.type}))};
}
function play(p){
  return {id:S(F(p?.id,p?.sequenceNumber,p?.text)),sequence:N(F(p?.sequenceNumber,p?.id)),text:F(p?.text,p?.shortText,p?.type?.text),short_text:F(p?.shortText,p?.text),type:F(p?.type?.text,p?.type?.abbreviation),type_id:F(p?.type?.id),period:N(F(p?.period?.number,p?.period)),clock:F(p?.clock?.displayValue,p?.displayClock),wallclock:F(p?.wallclock),scoring_play:Boolean(p?.scoringPlay),score_value:N(p?.scoreValue),team:{id:F(p?.team?.id),abbreviation:F(p?.team?.abbreviation),display_name:F(p?.team?.displayName,p?.team?.name),logo:logo(p?.team)},start:{down:N(p?.start?.down),distance:N(p?.start?.distance),yard_line:N(p?.start?.yardLine),yards_to_endzone:N(p?.start?.yardsToEndzone),possession_text:F(p?.start?.possessionText),down_distance_text:F(p?.start?.shortDownDistanceText,p?.start?.downDistanceText)},end:{down:N(p?.end?.down),distance:N(p?.end?.distance),yard_line:N(p?.end?.yardLine),yards_to_endzone:N(p?.end?.yardsToEndzone),possession_text:F(p?.end?.possessionText),down_distance_text:F(p?.end?.shortDownDistanceText,p?.end?.downDistanceText)},home_score:N(p?.homeScore),away_score:N(p?.awayScore),participants:A(p?.participants).map(x=>({id:F(x?.athlete?.id,x?.id),name:F(x?.athlete?.displayName,x?.athlete?.fullName,x?.displayName),short_name:F(x?.athlete?.shortName),headshot:headshot(x?.athlete),position:F(x?.athlete?.position?.abbreviation,x?.position?.abbreviation),role:F(x?.type?.text,x?.type?.abbreviation,typeof x?.type==='string'?x.type:null)})).filter(x=>x.id||x.name)};
}
function game(event){
  const c=competition(event),status=c.status||event?.status||{},sit=c.situation||{},away=side(c,'away'),home=side(c,'home');
  return {id:S(F(event?.id,c?.id)),date:F(event?.date,c?.date),name:F(event?.name,event?.shortName),short_name:F(event?.shortName,event?.name),season:{year:N(event?.season?.year),type:N(event?.season?.type),slug:F(event?.season?.slug)},week:N(event?.week?.number),status:{semantics:semantics(status),state:F(status?.type?.state),name:F(status?.type?.name),detail:F(status?.type?.detail,status?.type?.shortDetail),short_detail:F(status?.type?.shortDetail,status?.type?.detail),period:N(status?.period),clock:F(status?.displayClock,status?.clock),completed:Boolean(status?.type?.completed)},venue:{id:F(c?.venue?.id),name:F(c?.venue?.fullName,c?.venue?.shortName),city:F(c?.venue?.address?.city),state:F(c?.venue?.address?.state)},broadcast:A(c?.broadcasts).flatMap(b=>A(b?.names)).filter(Boolean),attendance:N(c?.attendance),teams:{away,home},situation:{possession_id:F(sit?.possession,away.possession?away.id:null,home.possession?home.id:null),down:N(sit?.down),distance:N(sit?.distance),yard_line:N(sit?.yardLine),down_distance_text:F(sit?.shortDownDistanceText,sit?.downDistanceText),possession_text:F(sit?.possessionText),red_zone:sit?.isRedZone===undefined||sit?.isRedZone===null?null:Boolean(sit.isRedZone),home_timeouts:N(sit?.homeTimeouts),away_timeouts:N(sit?.awayTimeouts),last_play:sit?.lastPlay?play(sit.lastPlay):null}};
}
function drive(d,current=false){
  const plays=A(d?.plays).map(play);return {id:S(F(d?.id,d?.sequenceNumber,`${d?.team?.id||''}-${d?.start?.clock?.displayValue||''}`)),sequence:N(d?.sequenceNumber),is_current:current,team:{id:F(d?.team?.id),abbreviation:F(d?.team?.abbreviation),display_name:F(d?.team?.displayName,d?.team?.name),logo:logo(d?.team)},description:F(d?.description,d?.displayResult,d?.result),result:F(d?.displayResult,d?.result,d?.description),yards:N(F(d?.yards,d?.netYards)),offensive_plays:N(F(d?.offensivePlays,d?.playCount,plays.length)),time_elapsed:F(d?.timeElapsed?.displayValue,d?.timeElapsed),start:{period:N(d?.start?.period?.number),clock:F(d?.start?.clock?.displayValue),yard_line:N(d?.start?.yardLine),text:F(d?.start?.text)},end:{period:N(d?.end?.period?.number),clock:F(d?.end?.clock?.displayValue),yard_line:N(d?.end?.yardLine),text:F(d?.end?.text)},plays};
}
function stats(pkg){
  return A(pkg?.boxscore?.players).map(tb=>{const t=tb?.team||{};return{team:{id:F(t?.id),abbreviation:F(t?.abbreviation),display_name:F(t?.displayName,t?.name),logo:logo(t)},groups:A(tb?.statistics).map(group=>({name:F(group?.name),display_name:F(group?.displayName,group?.name),labels:A(group?.labels),athletes:A(group?.athletes).map(row=>{const a=row?.athlete||{};return{athlete:{id:F(a?.id),name:F(a?.displayName,a?.fullName,a?.shortName),short_name:F(a?.shortName),jersey:F(a?.jersey),headshot:headshot(a),position:F(a?.position?.abbreviation),team:F(a?.team?.abbreviation,t?.abbreviation)},starter:Boolean(row?.starter),did_not_play:Boolean(row?.didNotPlay),stats:A(row?.stats),values:A(row?.stats).map((value,i)=>({label:A(group?.labels)[i]||String(i),value}))}})}))}});
}
function numberFromStat(value){
  const match=String(value??'').replace(/,/g,'').match(/-?\d+(?:\.\d+)?/);
  return match?Number(match[0]):null;
}
function derivedLeaders(playerStats){
  const wanted=[['pass','Passing'],['rush','Rushing'],['receiv','Receiving']];
  const out=[];
  for(const [needle,label] of wanted){
    let best=null;
    for(const tb of A(playerStats))for(const group of A(tb?.groups)){
      const groupName=S(F(group?.name,group?.display_name)).toLowerCase();
      if(!groupName.includes(needle))continue;
      const labels=A(group?.labels).map(x=>S(x).toUpperCase());
      const ydsIndex=labels.findIndex(x=>x==='YDS'||x.includes('YDS'));
      if(ydsIndex<0)continue;
      for(const row of A(group?.athletes)){
        if(row?.did_not_play)continue;
        const raw=A(row?.stats)[ydsIndex];
        const yards=numberFromStat(raw);
        if(yards==null)continue;
        if(!best||yards>best.yards)best={yards,raw,athlete:row?.athlete||{}};
      }
    }
    if(best)out.push({category:needle,display_name:`${label} leader`,value:`${best.raw} YDS`,athlete:best.athlete});
  }
  return out;
}
function leaders(pkg,playerStats){
  const out=[];
  A(pkg?.leaders).forEach(cat=>A(cat?.leaders).forEach(l=>{const a=l?.athlete||{};const row={category:F(cat?.name,cat?.displayName),display_name:F(cat?.displayName,cat?.name),value:F(l?.displayValue,l?.value),athlete:{id:F(a?.id),name:F(a?.displayName,a?.fullName,a?.shortName),short_name:F(a?.shortName),headshot:headshot(a),position:F(a?.position?.abbreviation),team:F(a?.team?.abbreviation,a?.team?.displayName)}};if(row.athlete.name&&row.value!=null)out.push(row)}));
  return out.length?out:derivedLeaders(playerStats);
}
function detail(pkg,eventId){
  const hc=A(pkg?.header?.competitions)[0]||{};
  const headerEvent={id:eventId,date:F(hc?.date),name:F(pkg?.header?.shortName,pkg?.header?.name),shortName:F(pkg?.header?.shortName),season:pkg?.header?.season||{},week:pkg?.header?.week,competitions:A(pkg?.header?.competitions)};
  const g=game(headerEvent);
  const previous=A(pkg?.drives?.previous).map(d=>drive(d,false));
  const curRaw=pkg?.drives?.current;
  const current=curRaw?drive(curRaw,true):null;
  const driveMap=new Map();
  previous.forEach(d=>{if(d.id)driveMap.set(d.id,d)});
  if(current?.id)driveMap.set(current.id,current);
  const drives=[...driveMap.values()];
  const playMap=new Map();
  drives.forEach(d=>d.plays.forEach(p=>{if(p.id)playMap.set(p.id,p)}));
  const plays=[...playMap.values()];
  const currentPlay=current?.plays?.at(-1)||g?.situation?.last_play||plays.at(-1)||null;
  const playerStats=stats(pkg);
  return {ok:true,source:{provider:'espn_cdn_gamepackage',semantics:g.status.semantics,fetched_at:new Date().toISOString(),transport:'poll'},game:g,current_drive:current,current_play:currentPlay,drives,plays,last_five_plays:plays.slice(-5).reverse(),leaders:leaders(pkg,playerStats),player_stats:playerStats,win_probability:A(pkg?.winprobability).slice(-80).map(x=>({play_id:F(x?.playId,x?.play?.id),home_win_percentage:N(x?.homeWinPercentage),tie_percentage:N(x?.tiePercentage)})),play_count:plays.length,drive_count:drives.length};
}
async function scoreboard(date){
  const raw=await upstream(`${CDN}/scoreboard?xhr=1&limit=100&dates=${encodeURIComponent(date)}`);const games=findEvents(raw).map(game);return {ok:true,source:{provider:'espn_cdn_scoreboard',semantics:'SCOREBOARD',fetched_at:new Date().toISOString(),transport:'poll'},date,count:games.length,games};
}
export default async function handler(req,res){
  if(req.method==='OPTIONS'){res.statusCode=204;res.setHeader('access-control-allow-origin','*');res.setHeader('access-control-allow-methods','GET,OPTIONS');return res.end()}
  if(req.method!=='GET')return send(res,405,{ok:false,error:'method_not_allowed'});
  const event=S(req.query?.event).trim(),date=todayET(req.query?.date);
  try{
    if(event){if(!/^\d+$/.test(event))return send(res,400,{ok:false,error:'invalid_event'});const raw=await upstream(`${CDN}/game?xhr=1&gameId=${encodeURIComponent(event)}`);const out=detail(packageOf(raw),event);const ttl=out.source.semantics==='LIVE'?2:out.source.semantics==='FINAL'?30:10;return send(res,200,out,ttl)}
    const out=await scoreboard(date);return send(res,200,out,out.games.some(g=>g.status.semantics==='LIVE')?3:15);
  }catch(error){return send(res,503,{ok:false,error:'nfl_live_unavailable',detail:error instanceof Error?error.message:String(error),semantics:'UNAVAILABLE',fetched_at:new Date().toISOString()})}
}