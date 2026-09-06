import { TEAM_NAME_TO_CODE } from '../workers/nfl-picks-engine-shared/odds-normalize.mjs';

const NFL_GATEWAY=process.env.NFL_GATEWAY||'https://nfl-api.propbetedge.ai';
const CORE_MARKETS=['h2h','spreads','totals'];
/* LAST VERIFIED MARKET. When the live provider path is down, the Dashboard's
   core market (spread / total / moneyline ONLY) may fall back to the most
   recent snapshot the nfl-odds-snapshot pipeline verified and stored. It is
   returned under its own semantics, with its capture time, and the UI is
   required to label it STALE. It is never called LIVE, never used for player
   props, and never served once it is older than this window. */
const SNAPSHOT_MAX_AGE_MS=72*3600000;
const SUPABASE_URL=String(process.env.SUPABASE_URL||'').replace(/\/$/,'');
const SUPABASE_KEY=String(process.env.SUPABASE_SERVICE_ROLE_KEY||'').trim();

function send(res,status,body,ttl=0){
  res.statusCode=status;
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control',status===200&&ttl>0?`public, s-maxage=${ttl}, stale-while-revalidate=${Math.max(10,ttl*3)}`:'no-store');
  res.setHeader('x-content-type-options','nosniff');
  res.end(JSON.stringify(body));
}
const arr=v=>Array.isArray(v)?v:[];
const num=v=>{if(v===null||v===undefined||v==='')return NaN;const n=Number(v);return Number.isFinite(n)?n:NaN};
const norm=v=>String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
function namesMatch(a,b){const x=norm(a),y=norm(b);if(!x||!y)return false;const ax=x.split(' ').at(-1),by=y.split(' ').at(-1);return x===y||x.includes(y)||y.includes(x)||ax===by}
function median(values){const xs=values.map(num).filter(Number.isFinite).sort((a,b)=>a-b);if(!xs.length)return null;const i=Math.floor(xs.length/2);return xs.length%2?xs[i]:(xs[i-1]+xs[i])/2}
function implied(v){const a=num(v);if(!Number.isFinite(a)||a===0)return null;return a<0?Math.abs(a)/(Math.abs(a)+100):100/(a+100)}
function oddsRows(payload){if(Array.isArray(payload))return payload;for(const k of ['events','games','data','results','odds'])if(Array.isArray(payload?.[k]))return payload[k];return[]}
function oddsEvent(raw){return{id:String(raw?.id||raw?.event_id||raw?.eventId||''),away:String(raw?.away_team||raw?.away||raw?.awayTeam||''),home:String(raw?.home_team||raw?.home||raw?.homeTeam||'')}}
const marketOf=q=>String(q?.market||q?.market_key||q?.key||'').toLowerCase();
const selectionOf=q=>String(q?.selection||q?.team||q?.participant||q?.description||q?.outcome||q?.name||'');
const sideOf=q=>String(q?.direction||q?.side||q?.outcome||q?.name||'').toUpperCase();
const pointOf=q=>num(q?.point??q?.line);
const priceOf=q=>num(q?.price??q?.american_odds??q?.odds);
const bookOf=q=>q?.book||q?.book_title||q?.sportsbook||q?.book_key||'';

async function upstream(path){
  const response=await fetch(`${NFL_GATEWAY}${path}`,{headers:{accept:'application/json'},cache:'no-store'});
  const text=await response.text();
  if(!response.ok)throw new Error(`gateway_${response.status}:${text.slice(0,120)}`);
  try{return JSON.parse(text)}catch{throw new Error('gateway_non_json')}
}
function flattenEventQuotes(raw){
  const out=[];
  const books=arr(raw?.bookmakers||raw?.books||raw?.sportsbooks);
  for(const book of books){
    const bookName=book?.title||book?.name||book?.key||book?.book||'Sportsbook';
    const updated=book?.last_update||book?.lastUpdate||book?.updated_at||null;
    for(const market of arr(book?.markets||book?.market_data)){
      const key=String(market?.key||market?.market||market?.name||'').toLowerCase();
      if(!CORE_MARKETS.some(m=>key===m||key.includes(m==='spreads'?'spread':m==='totals'?'total':m)))continue;
      for(const outcome of arr(market?.outcomes||market?.prices||market?.selections)){
        out.push({
          market:key,
          selection:outcome?.name||outcome?.selection||outcome?.team||outcome?.description||'',
          name:outcome?.name||outcome?.side||'',
          side:outcome?.side||outcome?.direction||outcome?.name||'',
          point:outcome?.point??outcome?.line??null,
          price:outcome?.price??outcome?.odds??outcome?.american_odds??null,
          book:bookName,
          book_last_update:updated
        });
      }
    }
  }
  return out;
}
async function loadBoard(eventId){
  try{return await upstream(`/api/odds/board?event_id=${encodeURIComponent(eventId)}&markets=${encodeURIComponent(CORE_MARKETS.join(','))}`)}catch(_){
    const settled=await Promise.allSettled(CORE_MARKETS.map(m=>upstream(`/api/odds/board?event_id=${encodeURIComponent(eventId)}&markets=${encodeURIComponent(m)}`)));
    const parts=settled.filter(x=>x.status==='fulfilled').map(x=>x.value);
    if(!parts.length)throw new Error('core_market_unavailable');
    const merged={...parts[0],quotes:[]},seen=new Set();
    for(const p of parts)for(const q of arr(p?.quotes)){
      const key=[bookOf(q),marketOf(q),selectionOf(q),pointOf(q),priceOf(q)].join('|');
      if(!seen.has(key)){seen.add(key);merged.quotes.push(q)}
    }
    merged.provider_last_update=parts.map(p=>p?.provider_last_update||p?.last_update||p?.updated_at).filter(Boolean).sort().at(-1)||null;
    return merged;
  }
}
function teamQuotes(rows,team){return rows.filter(q=>namesMatch(selectionOf(q),team))}
function summarize(event,quotes,updated){
  const h2h=quotes.filter(q=>marketOf(q)==='h2h'||marketOf(q).includes('h2h'));
  const spreads=quotes.filter(q=>marketOf(q)==='spreads'||marketOf(q).includes('spread'));
  const totals=quotes.filter(q=>marketOf(q)==='totals'||marketOf(q).includes('total'));
  const awayMl=teamQuotes(h2h,event.away),homeMl=teamQuotes(h2h,event.home),awaySp=teamQuotes(spreads,event.away),homeSp=teamQuotes(spreads,event.home);
  const over=totals.filter(q=>sideOf(q).includes('OVER')),under=totals.filter(q=>sideOf(q).includes('UNDER'));
  const awayPrice=median(awayMl.map(priceOf)),homePrice=median(homeMl.map(priceOf));
  const rawAway=implied(awayPrice),rawHome=implied(homePrice),sum=(rawAway??0)+(rawHome??0);
  const books=[...new Set(quotes.map(bookOf).filter(Boolean))];
  return{
    ok:true,
    semantics:'CURRENT_CROSS_BOOK_CONSENSUS',
    event,
    books:books.length,
    quote_count:quotes.length,
    provider_last_update:updated||quotes.map(q=>q.book_last_update||q.last_update||q.updated_at).filter(Boolean).sort().at(-1)||null,
    spread:{away:median(awaySp.map(pointOf)),home:median(homeSp.map(pointOf))},
    total:{line:median([...over,...under].map(pointOf)),over_price:median(over.map(priceOf)),under_price:median(under.map(priceOf))},
    moneyline:{away:awayPrice,home:homePrice},
    vig_free_probability:{away:sum>0&&rawAway!==null?rawAway/sum:null,home:sum>0&&rawHome!==null?rawHome/sum:null},
    coverage:{h2h_quotes:h2h.length,spread_quotes:spreads.length,total_quotes:totals.length}
  };
}

/* ---- last verified snapshot ------------------------------------------- */
function supabaseHeaders(){const h={apikey:SUPABASE_KEY,accept:'application/json'};if(SUPABASE_KEY.startsWith('eyJ'))h.authorization=`Bearer ${SUPABASE_KEY}`;return h}
async function scheduleGame(awayCode,homeCode,now=Date.now()){
  const sched=await upstream('/api/schedule');
  const games=arr(sched?.games).filter(g=>g?.away_team===awayCode&&g?.home_team===homeCode&&g?.gameday);
  if(!games.length)return null;
  /* the game nearest to now that has not been over for more than a day */
  const scored=games.map(g=>{const t=Date.parse(`${g.gameday}T${g.gametime||'00:00'}:00Z`);return{g,t,dist:Math.abs(t-now)}}).filter(x=>Number.isFinite(x.t)&&now-x.t<86400000).sort((a,b)=>a.dist-b.dist);
  return scored.length?scored[0].g:null;
}
async function latestSnapshotRows(gameId){
  if(!SUPABASE_URL||!SUPABASE_KEY)throw new Error('snapshot_store_not_configured');
  const q=`nfl_odds_snapshots?game_id=eq.${encodeURIComponent(gameId)}&select=market,side,team,over_under,is_home,line,price,book,captured_at,is_closing&order=captured_at.desc&limit=120`;
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${q}`,{headers:supabaseHeaders(),cache:'no-store'});
  if(!r.ok)throw new Error(`snapshot_store_${r.status}`);
  const rows=await r.json();
  if(!Array.isArray(rows)||!rows.length)return [];
  const latest=rows[0].captured_at;
  return rows.filter(x=>x.captured_at===latest);
}
/** The Dashboard summary built from ONE captured batch of snapshot rows. Pure. */
export function summarizeSnapshot(rows,event,liveError){
  const batch=arr(rows);if(!batch.length)return null;
  const capturedAt=batch[0].captured_at;
  const by=(market,pick)=>batch.filter(x=>x.market===market&&pick(x));
  const val=(list,f)=>{const v=list.map(f).map(num).filter(Number.isFinite);return v.length?median(v):null};
  const awaySp=by('spread',x=>x.is_home===false),homeSp=by('spread',x=>x.is_home===true);
  const awayMl=by('moneyline',x=>x.is_home===false),homeMl=by('moneyline',x=>x.is_home===true);
  const over=by('total',x=>String(x.over_under||'').toLowerCase()==='over'),under=by('total',x=>String(x.over_under||'').toLowerCase()==='under');
  const awayPrice=val(awayMl,x=>x.price),homePrice=val(homeMl,x=>x.price);
  const rawAway=implied(awayPrice),rawHome=implied(homePrice),sum=(rawAway??0)+(rawHome??0);
  const books=Math.max(0,...batch.map(x=>{const m=/^consensus:(\d+)$/.exec(String(x.book||''));return m?Number(m[1]):(x.book?1:0)}));
  return{
    ok:true,
    semantics:'LAST_VERIFIED_SNAPSHOT',
    stale:true,
    live_feed:{status:'UNAVAILABLE',error:String(liveError||'').slice(0,160)},
    captured_at:capturedAt,
    age_minutes:Math.max(0,Math.round((Date.now()-Date.parse(capturedAt))/60000)),
    event,
    books,
    quote_count:batch.length,
    provider_last_update:capturedAt,
    spread:{away:val(awaySp,x=>x.line),home:val(homeSp,x=>x.line)},
    total:{line:val([...over,...under],x=>x.line),over_price:val(over,x=>x.price),under_price:val(under,x=>x.price)},
    moneyline:{away:awayPrice,home:homePrice},
    vig_free_probability:{away:sum>0&&rawAway!==null?rawAway/sum:null,home:sum>0&&rawHome!==null?rawHome/sum:null},
    coverage:{h2h_quotes:awayMl.length+homeMl.length,spread_quotes:awaySp.length+homeSp.length,total_quotes:over.length+under.length},
    source:{provider:'nfl-odds-snapshot',store:'nfl_odds_snapshots',semantics:'LAST VERIFIED MARKET — a stored observation, not the live feed'}
  };
}
async function lastVerified(away,home,liveError){
  const awayCode=TEAM_NAME_TO_CODE[away],homeCode=TEAM_NAME_TO_CODE[home];
  if(!awayCode||!homeCode)return null;                         // no guessing at identity
  const game=await scheduleGame(awayCode,homeCode);
  if(!game)return null;
  const rows=await latestSnapshotRows(game.game_id);
  if(!rows.length)return null;
  if(Date.now()-Date.parse(rows[0].captured_at)>SNAPSHOT_MAX_AGE_MS)return null;   // too old to stand in
  return summarizeSnapshot(rows,{id:game.game_id,away,home,away_code:awayCode,home_code:homeCode},liveError);
}

export default async function handler(req,res){
  if(req.method!=='GET')return send(res,405,{ok:false,error:'method_not_allowed'});
  const away=String(req.query?.away||'').trim(),home=String(req.query?.home||'').trim();
  if(!away||!home)return send(res,400,{ok:false,error:'away_and_home_required'});
  try{
    const payload=await upstream('/api/odds'),rawEvents=oddsRows(payload);
    const rawEvent=rawEvents.find(raw=>{const e=oddsEvent(raw);return e.id&&namesMatch(e.away,away)&&namesMatch(e.home,home)});
    if(!rawEvent)return send(res,404,{ok:false,error:'market_event_not_found',away,home});
    const event=oddsEvent(rawEvent);
    let quotes=flattenEventQuotes(rawEvent),updated=rawEvent?.last_update||rawEvent?.updated_at||payload?.last_update||payload?.updated_at||null;
    if(!quotes.length){
      const board=await loadBoard(event.id);quotes=arr(board?.quotes);updated=board?.provider_last_update||board?.last_update||board?.updated_at||updated;
    }
    if(!quotes.length)return send(res,404,{ok:false,error:'core_market_quotes_not_found',event});
    return send(res,200,summarize(event,quotes,updated),8);
  }catch(error){
    const detail=error instanceof Error?error.message:String(error);
    /* the live path failed: offer the last verified snapshot, labelled as such */
    try{
      const stale=await lastVerified(away,home,detail);
      if(stale){res.setHeader('x-pbe-market-semantics','LAST_VERIFIED_SNAPSHOT');return send(res,200,stale,0)}
    }catch(fallbackError){
      return send(res,503,{ok:false,error:'core_market_unavailable',detail,fallback:fallbackError instanceof Error?fallbackError.message:String(fallbackError)});
    }
    return send(res,503,{ok:false,error:'core_market_unavailable',detail,fallback:'no_verified_snapshot'});
  }
}
