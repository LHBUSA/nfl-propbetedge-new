const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const SUMMARY_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary';

function send(res,status,body,ttl=0){
  res.statusCode=status;
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin','*');
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('cache-control',status===200 && ttl>0 ? `public, s-maxage=${ttl}, stale-while-revalidate=${Math.max(ttl*2,10)}` : 'no-store');
  res.end(JSON.stringify(body));
}

function arr(value){ return Array.isArray(value) ? value : []; }
function str(value){ return value == null ? '' : String(value); }
function num(value){ const n=Number(value); return Number.isFinite(n) ? n : null; }
function first(...values){ for(const value of values){ if(value!==undefined && value!==null && value!=='') return value; } return null; }
function imageOf(value){
  if(!value) return null;
  if(typeof value==='string') return value;
  return value.href || value.url || value.src || null;
}
function logoOf(team){
  return imageOf(arr(team?.logos)[0]) || imageOf(team?.logo) || null;
}
function athleteImage(athlete){
  return imageOf(athlete?.headshot) || imageOf(arr(athlete?.images)[0]) || null;
}
function statusContract(status){
  const state=str(status?.type?.state).toLowerCase();
  const completed=Boolean(status?.type?.completed);
  if(state==='in') return 'LIVE';
  if(state==='post' || completed) return 'FINAL';
  if(state==='pre') return 'SCHEDULE';
  return 'UNAVAILABLE';
}
function formatDateQuery(raw){
  const value=str(raw).replace(/[^0-9]/g,'');
  if(/^\d{8}$/.test(value)) return value;
  const d=new Date();
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
  const get=type=>parts.find(p=>p.type===type)?.value || '';
  return `${get('year')}${get('month')}${get('day')}`;
}

async function upstream(url){
  const response=await fetch(url,{
    headers:{
      accept:'application/json,text/plain,*/*',
      'user-agent':'Mozilla/5.0 (compatible; PropBetEdge-NFL-Live/1.0; +https://propbetedge.ai)'
    },
    cache:'no-store'
  });
  const text=await response.text();
  if(!response.ok) throw new Error(`upstream_${response.status}:${text.slice(0,140)}`);
  try { return JSON.parse(text); }
  catch { throw new Error('upstream_non_json'); }
}

function teamSide(competition,homeAway){
  const competitor=arr(competition?.competitors).find(c=>c?.homeAway===homeAway) || {};
  const team=competitor.team || {};
  return {
    id:first(team.id,competitor.id),
    uid:first(team.uid,competitor.uid),
    abbreviation:first(team.abbreviation,team.shortDisplayName),
    display_name:first(team.displayName,team.name,team.shortDisplayName),
    short_name:first(team.shortDisplayName,team.name),
    location:first(team.location),
    color:first(team.color),
    alternate_color:first(team.alternateColor),
    logo:logoOf(team),
    score:num(competitor.score),
    winner:Boolean(competitor.winner),
    possession:Boolean(competitor.possession),
    records:arr(competitor.records).map(r=>({name:r.name,summary:r.summary,type:r.type}))
  };
}

function competitionOfEvent(event){ return arr(event?.competitions)[0] || {}; }
function normalizedGame(event){
  const competition=competitionOfEvent(event);
  const status=competition.status || event.status || {};
  const situation=competition.situation || {};
  const away=teamSide(competition,'away');
  const home=teamSide(competition,'home');
  const possessionId=first(situation.possession, away.possession?away.id:null, home.possession?home.id:null);
  return {
    id:str(event?.id || competition?.id),
    date:first(event?.date,competition?.date),
    name:first(event?.name,event?.shortName),
    short_name:first(event?.shortName,event?.name),
    season:{year:num(event?.season?.year),type:num(event?.season?.type),slug:first(event?.season?.slug)},
    week:num(event?.week?.number),
    status:{
      semantics:statusContract(status),
      state:first(status?.type?.state),
      name:first(status?.type?.name),
      detail:first(status?.type?.detail,status?.type?.shortDetail),
      short_detail:first(status?.type?.shortDetail,status?.type?.detail),
      period:num(status?.period),
      clock:first(status?.displayClock,status?.clock),
      completed:Boolean(status?.type?.completed)
    },
    venue:{
      id:first(competition?.venue?.id),
      name:first(competition?.venue?.fullName,competition?.venue?.shortName),
      city:first(competition?.venue?.address?.city),
      state:first(competition?.venue?.address?.state)
    },
    broadcast:arr(competition?.broadcasts).flatMap(b=>arr(b?.names)).filter(Boolean),
    neutral_site:Boolean(competition?.neutralSite),
    conference_competition:Boolean(competition?.conferenceCompetition),
    attendance:num(competition?.attendance),
    teams:{away,home},
    situation:{
      possession_id:possessionId,
      down:num(situation?.down),
      distance:num(situation?.distance),
      yard_line:num(situation?.yardLine),
      down_distance_text:first(situation?.shortDownDistanceText,situation?.downDistanceText),
      possession_text:first(situation?.possessionText),
      red_zone:Boolean(situation?.isRedZone),
      home_timeouts:num(situation?.homeTimeouts),
      away_timeouts:num(situation?.awayTimeouts),
      last_play:situation?.lastPlay ? normalizePlay(situation.lastPlay) : null
    }
  };
}

function normalizePlay(play){
  const participants=arr(play?.participants).map(p=>({
    id:first(p?.athlete?.id,p?.id),
    name:first(p?.athlete?.displayName,p?.athlete?.fullName,p?.displayName),
    short_name:first(p?.athlete?.shortName),
    headshot:athleteImage(p?.athlete),
    position:first(p?.athlete?.position?.abbreviation,p?.position?.abbreviation)
  })).filter(p=>p.id||p.name);
  return {
    id:str(first(play?.id,play?.sequenceNumber,play?.text)),
    sequence:num(first(play?.sequenceNumber,play?.id)),
    text:first(play?.text,play?.shortText,play?.type?.text),
    short_text:first(play?.shortText,play?.text),
    type:first(play?.type?.text,play?.type?.abbreviation),
    type_id:first(play?.type?.id),
    period:num(first(play?.period?.number,play?.period)),
    clock:first(play?.clock?.displayValue,play?.displayClock),
    wallclock:first(play?.wallclock),
    scoring_play:Boolean(play?.scoringPlay),
    score_value:num(play?.scoreValue),
    modified:first(play?.modified),
    team:{
      id:first(play?.team?.id),
      abbreviation:first(play?.team?.abbreviation),
      display_name:first(play?.team?.displayName,play?.team?.name),
      logo:logoOf(play?.team)
    },
    start:{
      down:num(play?.start?.down),
      distance:num(play?.start?.distance),
      yard_line:num(play?.start?.yardLine),
      yards_to_endzone:num(play?.start?.yardsToEndzone),
      possession_text:first(play?.start?.possessionText),
      down_distance_text:first(play?.start?.shortDownDistanceText,play?.start?.downDistanceText)
    },
    end:{
      down:num(play?.end?.down),
      distance:num(play?.end?.distance),
      yard_line:num(play?.end?.yardLine),
      yards_to_endzone:num(play?.end?.yardsToEndzone),
      possession_text:first(play?.end?.possessionText),
      down_distance_text:first(play?.end?.shortDownDistanceText,play?.end?.downDistanceText)
    },
    home_score:num(first(play?.homeScore,play?.home_score)),
    away_score:num(first(play?.awayScore,play?.away_score)),
    participants
  };
}

function normalizeDrive(drive,isCurrent=false){
  const plays=arr(drive?.plays).map(normalizePlay);
  return {
    id:str(first(drive?.id,drive?.sequenceNumber,`${drive?.team?.id||''}-${drive?.start?.clock?.displayValue||''}`)),
    sequence:num(drive?.sequenceNumber),
    is_current:Boolean(isCurrent),
    team:{
      id:first(drive?.team?.id),
      abbreviation:first(drive?.team?.abbreviation),
      display_name:first(drive?.team?.displayName,drive?.team?.name),
      logo:logoOf(drive?.team)
    },
    description:first(drive?.description,drive?.displayResult,drive?.result),
    result:first(drive?.displayResult,drive?.result,drive?.description),
    yards:num(first(drive?.yards,drive?.netYards)),
    offensive_plays:num(first(drive?.offensivePlays,drive?.playCount,plays.length)),
    time_elapsed:first(drive?.timeElapsed?.displayValue,drive?.timeElapsed),
    start:{
      period:num(drive?.start?.period?.number),
      clock:first(drive?.start?.clock?.displayValue),
      yard_line:num(drive?.start?.yardLine),
      text:first(drive?.start?.text)
    },
    end:{
      period:num(drive?.end?.period?.number),
      clock:first(drive?.end?.clock?.displayValue),
      yard_line:num(drive?.end?.yardLine),
      text:first(drive?.end?.text)
    },
    plays
  };
}

function normalizeLeaders(summary){
  const rows=[];
  arr(summary?.leaders).forEach(category=>{
    arr(category?.leaders).forEach(leader=>{
      const athlete=leader?.athlete || {};
      rows.push({
        category:first(category?.name,category?.displayName),
        display_name:first(category?.displayName,category?.name),
        value:first(leader?.displayValue,leader?.value),
        athlete:{
          id:first(athlete?.id),
          name:first(athlete?.displayName,athlete?.fullName,athlete?.shortName),
          short_name:first(athlete?.shortName),
          headshot:athleteImage(athlete),
          position:first(athlete?.position?.abbreviation),
          team:first(athlete?.team?.abbreviation,athlete?.team?.displayName)
        }
      });
    });
  });
  return rows;
}

function normalizePlayerStats(summary){
  const teams=[];
  arr(summary?.boxscore?.players).forEach(teamBlock=>{
    const team=teamBlock?.team || {};
    const groups=arr(teamBlock?.statistics).map(group=>({
      name:first(group?.name),
      display_name:first(group?.displayName,group?.name),
      labels:arr(group?.labels),
      descriptions:arr(group?.descriptions),
      athletes:arr(group?.athletes).map(row=>{
        const athlete=row?.athlete || {};
        return {
          athlete:{
            id:first(athlete?.id),
            name:first(athlete?.displayName,athlete?.fullName,athlete?.shortName),
            short_name:first(athlete?.shortName),
            jersey:first(athlete?.jersey),
            headshot:athleteImage(athlete),
            position:first(athlete?.position?.abbreviation),
            team:first(athlete?.team?.abbreviation,team?.abbreviation)
          },
          starter:Boolean(row?.starter),
          did_not_play:Boolean(row?.didNotPlay),
          stats:arr(row?.stats),
          values:arr(row?.stats).map((value,index)=>({label:arr(group?.labels)[index]||String(index),value}))
        };
      })
    }));
    teams.push({
      team:{id:first(team?.id),abbreviation:first(team?.abbreviation),display_name:first(team?.displayName,team?.name),logo:logoOf(team)},
      groups
    });
  });
  return teams;
}

function normalizeSummary(raw,eventId){
  const headerEvent={
    id:eventId,
    date:first(raw?.header?.competitions?.[0]?.date,raw?.header?.season?.year ? null : null),
    name:first(raw?.header?.competitions?.[0]?.notes?.[0]?.headline),
    season:raw?.header?.season || {},
    week:raw?.header?.week,
    competitions:arr(raw?.header?.competitions)
  };
  const game=normalizedGame(headerEvent);
  const previous=arr(raw?.drives?.previous).map(d=>normalizeDrive(d,false));
  const currentRaw=raw?.drives?.current;
  const current=currentRaw ? normalizeDrive(currentRaw,true) : null;
  const drives=current ? [...previous,current] : previous;
  const playMap=new Map();
  drives.forEach(d=>d.plays.forEach(play=>{ if(play.id) playMap.set(play.id,play); }));
  const plays=[...playMap.values()];
  const situation=game.situation || {};
  const currentPlay=current?.plays?.[current.plays.length-1] || situation.last_play || plays[plays.length-1] || null;
  return {
    ok:true,
    source:{provider:'espn_site_api',semantics:game.status.semantics,fetched_at:new Date().toISOString(),transport:'poll'},
    game,
    current_drive:current,
    current_play:currentPlay,
    drives,
    plays,
    leaders:normalizeLeaders(raw),
    player_stats:normalizePlayerStats(raw),
    win_probability:arr(raw?.winprobability).slice(-40).map(row=>({
      play_id:first(row?.playId,row?.play?.id),
      home_win_percentage:num(row?.homeWinPercentage),
      tie_percentage:num(row?.tiePercentage)
    })),
    last_five_plays:plays.slice(-5).reverse(),
    play_count:plays.length,
    drive_count:drives.length
  };
}

async function scoreboard(date){
  const raw=await upstream(`${SCOREBOARD_URL}?dates=${encodeURIComponent(date)}&limit=100`);
  const games=arr(raw?.events).map(normalizedGame);
  return {
    ok:true,
    source:{provider:'espn_site_api',semantics:'SCOREBOARD',fetched_at:new Date().toISOString(),transport:'poll'},
    date,
    count:games.length,
    games
  };
}

export default async function handler(req,res){
  if(req.method==='OPTIONS'){
    res.statusCode=204;
    res.setHeader('access-control-allow-origin','*');
    res.setHeader('access-control-allow-methods','GET,OPTIONS');
    res.setHeader('access-control-allow-headers','content-type');
    return res.end();
  }
  if(req.method!=='GET') return send(res,405,{ok:false,error:'method_not_allowed'});
  const event=str(req.query?.event).trim();
  const date=formatDateQuery(req.query?.date);
  try{
    if(event){
      if(!/^\d+$/.test(event)) return send(res,400,{ok:false,error:'invalid_event'});
      const raw=await upstream(`${SUMMARY_URL}?event=${encodeURIComponent(event)}`);
      const normalized=normalizeSummary(raw,event);
      const ttl=normalized?.source?.semantics==='LIVE' ? 2 : normalized?.source?.semantics==='FINAL' ? 30 : 10;
      return send(res,200,normalized,ttl);
    }
    const normalized=await scoreboard(date);
    const hasLive=normalized.games.some(g=>g?.status?.semantics==='LIVE');
    return send(res,200,normalized,hasLive?3:15);
  }catch(error){
    return send(res,503,{
      ok:false,
      error:'nfl_live_unavailable',
      detail:error instanceof Error ? error.message : String(error),
      semantics:'UNAVAILABLE',
      fetched_at:new Date().toISOString()
    });
  }
}
