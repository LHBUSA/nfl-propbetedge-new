const NFL_GATEWAY = process.env.NFL_GATEWAY || 'https://nfl-api.propbetedge.ai';
const PROP_ANCHORS = [
  ['player_pass_yds','passing'],
  ['player_reception_yds','receiving'],
  ['player_rush_yds','rushing'],
  ['player_anytime_td','touchdown']
];
const CORE_MARKETS = ['h2h','spreads','totals'];

const HOME = {
  ARI:{names:['arizona cardinals','cardinals'],roof:'RETRACTABLE'},
  ATL:{names:['atlanta falcons','falcons'],roof:'RETRACTABLE'},
  BAL:{names:['baltimore ravens','ravens'],roof:'OUTDOOR'},
  BUF:{names:['buffalo bills','bills'],roof:'OUTDOOR'},
  CAR:{names:['carolina panthers','panthers'],roof:'OUTDOOR'},
  CHI:{names:['chicago bears','bears'],roof:'OUTDOOR'},
  CIN:{names:['cincinnati bengals','bengals'],roof:'OUTDOOR'},
  CLE:{names:['cleveland browns','browns'],roof:'OUTDOOR'},
  DAL:{names:['dallas cowboys','cowboys'],roof:'RETRACTABLE'},
  DEN:{names:['denver broncos','broncos'],roof:'OUTDOOR'},
  DET:{names:['detroit lions','lions'],roof:'DOME'},
  GB:{names:['green bay packers','packers'],roof:'OUTDOOR'},
  HOU:{names:['houston texans','texans'],roof:'RETRACTABLE'},
  IND:{names:['indianapolis colts','colts'],roof:'RETRACTABLE'},
  JAX:{names:['jacksonville jaguars','jaguars'],roof:'OUTDOOR'},
  KC:{names:['kansas city chiefs','chiefs'],roof:'OUTDOOR'},
  LV:{names:['las vegas raiders','raiders'],roof:'DOME'},
  LAC:{names:['los angeles chargers','chargers'],roof:'CANOPY'},
  LAR:{names:['los angeles rams','rams'],roof:'CANOPY'},
  MIA:{names:['miami dolphins','dolphins'],roof:'CANOPY'},
  MIN:{names:['minnesota vikings','vikings'],roof:'DOME'},
  NE:{names:['new england patriots','patriots'],roof:'OUTDOOR'},
  NO:{names:['new orleans saints','saints'],roof:'DOME'},
  NYG:{names:['new york giants','giants'],roof:'OUTDOOR'},
  NYJ:{names:['new york jets','jets'],roof:'OUTDOOR'},
  PHI:{names:['philadelphia eagles','eagles'],roof:'OUTDOOR'},
  PIT:{names:['pittsburgh steelers','steelers'],roof:'OUTDOOR'},
  SF:{names:['san francisco 49ers','49ers','niners'],roof:'OUTDOOR'},
  SEA:{names:['seattle seahawks','seahawks'],roof:'OUTDOOR'},
  TB:{names:['tampa bay buccaneers','buccaneers','bucs'],roof:'OUTDOOR'},
  TEN:{names:['tennessee titans','titans'],roof:'OUTDOOR'},
  WAS:{names:['washington commanders','commanders'],roof:'OUTDOOR'},
  WSH:{names:['washington commanders','commanders'],roof:'OUTDOOR'}
};

function send(res,status,body,ttl=0){
  res.statusCode=status;
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control',status===200&&ttl>0?`public, s-maxage=${ttl}, stale-while-revalidate=${ttl*3}`:'no-store');
  res.setHeader('x-content-type-options','nosniff');
  res.end(JSON.stringify(body));
}
const arr=v=>Array.isArray(v)?v:[];
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:NaN};
const norm=v=>String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const marketOf=q=>String(q?.market||q?.market_key||q?.key||'').toLowerCase();
const playerOf=q=>q?.player||q?.player_name||q?.description||'';
const sideOf=q=>String(q?.direction||q?.side||q?.outcome||q?.name||'').toUpperCase();
const pointOf=q=>num(q?.point??q?.line);
const priceOf=q=>num(q?.price??q?.american_odds??q?.odds);
const bookOf=q=>q?.book||q?.book_title||q?.sportsbook||q?.book_key||'';
const selectionOf=q=>String(q?.selection||q?.team||q?.participant||q?.description||q?.outcome||q?.name||'');

function median(values){const xs=values.map(num).filter(Number.isFinite).sort((a,b)=>a-b);if(!xs.length)return null;const i=Math.floor(xs.length/2);return xs.length%2?xs[i]:(xs[i-1]+xs[i])/2}
function implied(v){const a=num(v);if(!Number.isFinite(a)||a===0)return null;return a<0?Math.abs(a)/(Math.abs(a)+100):100/(a+100)}
function namesMatch(a,b){const x=norm(a),y=norm(b);if(!x||!y)return false;const ax=x.split(' ').at(-1),by=y.split(' ').at(-1);return x===y||x.includes(y)||y.includes(x)||ax===by}
function homeEnvironment(home){
  const key=norm(home);
  const entry=Object.entries(HOME).find(([,meta])=>meta.names.some(name=>key===norm(name)||key.includes(norm(name))||norm(name).includes(key)));
  if(!entry)return{team:null,roof:'UNKNOWN',weather_exposure:'UNKNOWN',weather_feed:'NOT_CONNECTED'};
  const [team,meta]=entry;
  const exposure=meta.roof==='DOME'?'INDOOR':meta.roof==='RETRACTABLE'?'ROOF_STATUS_TBD':meta.roof==='CANOPY'?'COVERED_OPEN_AIR':'OUTDOOR';
  return{team,roof:meta.roof,weather_exposure:exposure,weather_feed:meta.roof==='DOME'?'NOT_APPLICABLE':'NOT_CONNECTED'};
}

async function upstream(path){
  const response=await fetch(`${NFL_GATEWAY}${path}`,{headers:{accept:'application/json'},cache:'no-store'});
  const text=await response.text();
  if(!response.ok)throw new Error(`gateway_${response.status}:${text.slice(0,120)}`);
  try{return JSON.parse(text)}catch{throw new Error('gateway_non_json')}
}

async function loadBoard(eventId,markets){
  try{return await upstream(`/api/odds/board?event_id=${encodeURIComponent(eventId)}&markets=${encodeURIComponent(markets.join(','))}`)}catch(_){
    const settled=await Promise.allSettled(markets.map(m=>upstream(`/api/odds/board?event_id=${encodeURIComponent(eventId)}&markets=${encodeURIComponent(m)}`)));
    const parts=settled.filter(x=>x.status==='fulfilled').map(x=>x.value);
    if(!parts.length)return null;
    const merged={...parts[0],quotes:[],market_summary:[]},seen=new Set(),summaries=new Set();
    for(const part of parts){
      for(const q of arr(part?.quotes)){
        const k=[bookOf(q),marketOf(q),playerOf(q),sideOf(q),pointOf(q),priceOf(q)].join('|');
        if(!seen.has(k)){seen.add(k);merged.quotes.push(q)}
      }
      for(const s of arr(part?.market_summary)){
        const k=[s?.market,playerOf(s)].join('|');if(!summaries.has(k)){summaries.add(k);merged.market_summary.push(s)}
      }
    }
    merged.provider_last_update=parts.map(p=>p?.provider_last_update||p?.last_update||p?.updated_at).filter(Boolean).sort().at(-1)||null;
    return merged;
  }
}

function readiness(propBoard){
  const quotes=arr(propBoard?.quotes);
  const out={};
  for(const [market,family] of PROP_ANCHORS){
    const rows=quotes.filter(q=>marketOf(q)===market);
    out[family]={
      market,
      live:rows.length>0,
      quotes:rows.length,
      books:new Set(rows.map(bookOf).filter(Boolean)).size,
      players:new Set(rows.map(playerOf).filter(Boolean)).size
    };
  }
  const liveFamilies=Object.values(out).filter(x=>x.live).length;
  return{
    score_pct:Math.round(liveFamilies/PROP_ANCHORS.length*100),
    live_families:liveFamilies,
    total_families:PROP_ANCHORS.length,
    families:out,
    semantics:'ANCHOR_MARKET_AVAILABILITY'
  };
}

function dispersion(propBoard){
  const groups=new Map();
  for(const q of arr(propBoard?.quotes)){
    const market=marketOf(q),player=playerOf(q),point=pointOf(q);
    if(!player||!Number.isFinite(point)||market==='player_anytime_td')continue;
    const key=`${player}|${market}`;
    if(!groups.has(key))groups.set(key,{player,market,points:[],books:new Set()});
    const g=groups.get(key);g.points.push(point);if(bookOf(q))g.books.add(bookOf(q));
  }
  const rows=[];
  for(const g of groups.values()){
    if(g.points.length<2)continue;
    const lo=Math.min(...g.points),hi=Math.max(...g.points),center=median(g.points),range=hi-lo;
    const relative=center!==null&&Math.abs(center)>.001?Math.abs(range/center)*100:null;
    rows.push({player:g.player,market:g.market,low:lo,high:hi,range,relative_pct:relative===null?null:Number(relative.toFixed(2)),books:g.books.size});
  }
  rows.sort((a,b)=>(b.relative_pct??-1)-(a.relative_pct??-1)||b.range-a.range);
  const max=rows[0]||null;
  return{
    max,
    high:Boolean(max&&max.relative_pct!==null&&max.relative_pct>=5),
    threshold_pct:5,
    semantics:'CURRENT_CROSS_BOOK_RELATIVE_LINE_RANGE_NOT_MODEL_EDGE'
  };
}

function coreMarket(coreBoard,away,home){
  const quotes=arr(coreBoard?.quotes);
  const h2h=quotes.filter(q=>marketOf(q)==='h2h'||marketOf(q).includes('h2h'));
  const spreads=quotes.filter(q=>marketOf(q)==='spreads'||marketOf(q).includes('spread'));
  const totals=quotes.filter(q=>marketOf(q)==='totals'||marketOf(q).includes('total'));
  const awayMl=h2h.filter(q=>namesMatch(selectionOf(q),away)),homeMl=h2h.filter(q=>namesMatch(selectionOf(q),home));
  const awaySp=spreads.filter(q=>namesMatch(selectionOf(q),away)),homeSp=spreads.filter(q=>namesMatch(selectionOf(q),home));
  const over=totals.filter(q=>sideOf(q).includes('OVER')),under=totals.filter(q=>sideOf(q).includes('UNDER'));
  const awayPrice=median(awayMl.map(priceOf)),homePrice=median(homeMl.map(priceOf));
  const rawAway=implied(awayPrice),rawHome=implied(homePrice),sum=(rawAway??0)+(rawHome??0);
  const total=median([...over,...under].map(pointOf));
  return{
    books:new Set(quotes.map(bookOf).filter(Boolean)).size,
    spread:{away:median(awaySp.map(pointOf)),home:median(homeSp.map(pointOf))},
    total:{line:total,over_price:median(over.map(priceOf)),under_price:median(under.map(priceOf))},
    moneyline:{away:awayPrice,home:homePrice},
    vig_free_probability:{away:sum>0&&rawAway!==null?rawAway/sum:null,home:sum>0&&rawHome!==null?rawHome/sum:null},
    high_total:Boolean(total!==null&&total>48.5),
    high_total_threshold:48.5,
    semantics:'CURRENT_CROSS_BOOK_CONSENSUS'
  };
}

export default async function handler(req,res){
  if(req.method!=='GET')return send(res,405,{ok:false,error:'method_not_allowed'});
  const eventId=String(req.query?.event_id||'').trim();
  const away=String(req.query?.away||'').trim();
  const home=String(req.query?.home||'').trim();
  if(!eventId)return send(res,400,{ok:false,error:'event_id_required'});
  try{
    const [propBoard,coreBoard]=await Promise.all([
      loadBoard(eventId,PROP_ANCHORS.map(([market])=>market)),
      loadBoard(eventId,CORE_MARKETS)
    ]);
    if(!propBoard&&!coreBoard)return send(res,404,{ok:false,error:'market_not_available',event_id:eventId});
    return send(res,200,{
      ok:true,
      event_id:eventId,
      away:away||propBoard?.event?.away_team||coreBoard?.event?.away_team||null,
      home:home||propBoard?.event?.home_team||coreBoard?.event?.home_team||null,
      provider_last_update:[propBoard?.provider_last_update,coreBoard?.provider_last_update].filter(Boolean).sort().at(-1)||null,
      readiness:readiness(propBoard),
      dispersion:dispersion(propBoard),
      core:coreMarket(coreBoard,away||coreBoard?.event?.away_team||'',home||coreBoard?.event?.home_team||''),
      environment:homeEnvironment(home||coreBoard?.event?.home_team||propBoard?.event?.home_team||''),
      weather:{status:'NOT_CONNECTED',note:'Live wind/temperature intentionally unavailable until a commercially licensed weather feed is configured.'},
      truth:{movement_history:false,sharp_money:false,posting_eta:false}
    },300);
  }catch(error){
    return send(res,503,{ok:false,error:'game_intelligence_unavailable',detail:error instanceof Error?error.message:String(error)});
  }
}
