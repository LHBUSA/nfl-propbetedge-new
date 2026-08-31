const NEWS_UPSTREAM = 'https://propbet-news-api.sales-fd3.workers.dev';
const IMG_PROXY = 'https://propbet-img-proxy.sales-fd3.workers.dev/?url=';

function send(res,status,body){
  res.statusCode=status;
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control',status===200?'public, s-maxage=60, stale-while-revalidate=120':'no-store');
  res.setHeader('x-content-type-options','nosniff');
  res.end(JSON.stringify(body));
}

function asArray(value){
  if(Array.isArray(value))return value;
  if(Array.isArray(value?.data))return value.data;
  if(Array.isArray(value?.news))return value.news;
  if(Array.isArray(value?.articles))return value.articles;
  if(Array.isArray(value?.items))return value.items;
  if(Array.isArray(value?.results))return value.results;
  if(Array.isArray(value?.rows))return value.rows;
  return [];
}

function arr(value){
  if(Array.isArray(value))return value.filter(Boolean);
  if(value==null)return[];
  return [value].filter(Boolean);
}

function firstText(...values){
  for(const value of values){
    if(value===null||value===undefined)continue;
    if(typeof value==='string'||typeof value==='number'){
      const text=String(value).trim();
      if(text)return text;
      continue;
    }
    if(typeof value==='object'){
      const nested=value.display_name ?? value.displayName ?? value.name ?? value.text ?? value.description ?? value.detail ?? value.value ?? value.label;
      if(nested!==null&&nested!==undefined){
        const text=String(nested).trim();
        if(text)return text;
      }
    }
  }
  return null;
}

function proxiedImage(raw){
  const value=String(raw||'').trim();
  if(!value)return null;
  if(value.startsWith(IMG_PROXY)||value.startsWith('/')||value.includes('propbetedge.ai'))return value;
  if(!/^https?:\/\//i.test(value))return null;
  return IMG_PROXY+encodeURIComponent(value);
}

function canonicalArticleUrl(row,slug){
  const cleanSlug=String(slug||'').trim().replace(/^\/+|\/+$/g,'');
  if(cleanSlug)return `https://propbetedge.ai/news/nfl/${cleanSlug}`;
  const candidates=[row?.url,row?.article_url,row?.link].filter(Boolean);
  for(const candidate of candidates){
    try{
      const url=new URL(String(candidate),'https://propbetedge.ai');
      if(/(^|\.)propbetedge\.ai$/i.test(url.hostname)&&/^\/news\/nfl\//i.test(url.pathname))return url.href;
    }catch{}
  }
  return null;
}

function impactBand(score){
  const n=Number(score);
  if(!Number.isFinite(n)||n<=0)return'CONTEXT';
  if(n>=80)return'HIGH';
  if(n>=55)return'ELEVATED';
  if(n>=30)return'MONITOR';
  return'CONTEXT';
}

function marketImpact({topic,score,teams,players,props,isBreaking}){
  const kind=String(topic||'').toLowerCase();
  const band=impactBand(score);
  let copy='Contextual NFL information. No verified sportsbook price movement is being claimed.';

  if(kind==='injury'||/injur|inactive|questionable|doubtful/.test(kind)){
    copy='Availability can change usage assumptions, player derivatives and team pricing. Monitor confirmation and related markets.';
  }else if(['lineup','depth_chart','depth chart','return'].includes(kind)){
    copy='Role confirmation can reprice opportunity-driven player markets and team-level assumptions.';
  }else if(['trade','signing','transaction'].includes(kind)){
    copy='Roster movement can alter depth-chart assumptions, player opportunity and broader team-market expectations.';
  }else if(['weather'].includes(kind)){
    copy='Weather can affect passing, kicking and scoring distributions. Monitor verified venue conditions before repricing.';
  }else if(['suspension','discipline'].includes(kind)){
    copy='Availability risk may affect lineup expectations and related player or team markets.';
  }else if(isBreaking){
    copy='Fresh information with potential market sensitivity. Monitor related prices for confirmed repricing.';
  }

  const scope=[];
  if(players.length)scope.push(players.slice(0,2).join(', '));
  else if(teams.length)scope.push(teams.slice(0,2).join(', '));
  if(props.length)scope.push(`markets: ${props.slice(0,2).join(', ')}`);

  return {
    band,
    score:Number.isFinite(Number(score))?Number(score):null,
    text:copy,
    scope:scope.join(' · ')||null,
    semantics:'CONTEXT_NOT_PRICE_MOVE'
  };
}

function structuredAvailability(row,take){
  const availability=row?.availability||take?.availability||{};
  const injury=firstText(
    row?.injury_type,row?.injuryType,row?.injury_detail,row?.injuryDetail,row?.injury,
    availability?.injury,availability?.injury_type,availability?.injuryType,
    take?.injury_type,take?.injuryType,take?.injury
  );
  const status=firstText(
    row?.injury_status,row?.injuryStatus,row?.availability_status,row?.availabilityStatus,
    row?.injury_designation,row?.injuryDesignation,row?.designation,
    availability?.status,availability?.designation,availability?.injury_status,
    take?.injury_status,take?.availability_status,take?.designation
  );
  const expectedReturn=firstText(
    row?.expected_return,row?.expectedReturn,row?.return_timeline,row?.returnTimeline,
    row?.return_window,row?.returnWindow,row?.out_until,row?.outUntil,
    availability?.expected_return,availability?.expectedReturn,availability?.return_timeline,
    availability?.returnTimeline,availability?.return_window,availability?.out_until,
    take?.expected_return,take?.return_timeline,take?.return_window,take?.out_until
  );
  if(!injury&&!status&&!expectedReturn)return null;
  return {
    injury:injury||null,
    status:status||null,
    expected_return:expectedReturn||null,
    semantics:'REPORTED_AVAILABILITY'
  };
}

function article(row){
  const take=row?.take || row?.analysis || row?.ai_take || {};
  const teams=arr(row?.take_teams ?? row?.affected_teams ?? row?.teams ?? take?.teams);
  const players=arr(row?.take_players ?? row?.affected_players ?? row?.players ?? take?.players);
  const props=arr(row?.take_props ?? row?.affected_props ?? row?.props ?? take?.props);
  const topic=String(row?.topic_kind ?? row?.topic ?? row?.category ?? row?.type ?? take?.topic_kind ?? '').toLowerCase();
  const title=row?.title ?? row?.headline ?? row?.name ?? '';
  const summary=row?.summary ?? row?.description ?? row?.dek ?? row?.excerpt ?? row?.take_summary ?? take?.summary ?? '';
  const slug=row?.slug ?? null;
  const url=canonicalArticleUrl(row,slug);
  const rawImage=row?.image_url ?? row?.imageUrl ?? row?.featured_image ?? row?.featuredImage ?? row?.thumbnail_url ?? row?.thumbnail ?? row?.image?.url ?? row?.image?.href ?? take?.image_url ?? null;
  const impactScore=row?.prop_impact_score ?? row?.impact_score ?? row?.take_impact ?? take?.impact_score ?? null;
  const isBreaking=Boolean(row?.is_breaking ?? row?.breaking ?? false);
  const availability=structuredAvailability(row,take);
  return {
    id: row?.id ?? row?.news_id ?? slug ?? url ?? `${title}|${row?.published_at||''}`,
    title,
    summary,
    url,
    slug,
    image_url: proxiedImage(rawImage),
    original_image_url: rawImage || null,
    image_alt: row?.image_alt ?? row?.imageAlt ?? title ?? null,
    image_credit: row?.image_credit ?? row?.imageCredit ?? row?.photo_credit ?? row?.photoCredit ?? null,
    source: row?.source ?? row?.publisher ?? row?.source_name ?? null,
    author: row?.author ?? null,
    published_at: row?.published_at ?? row?.publishedAt ?? row?.date ?? row?.created_at ?? null,
    updated_at: row?.updated_at ?? row?.updatedAt ?? null,
    topic_kind: topic || null,
    teams,
    players,
    props,
    availability,
    impact_score: impactScore,
    market_impact: marketImpact({topic,score:impactScore,teams,players,props,isBreaking}),
    relevance_score: row?.relevance_score ?? row?.homepage_score ?? row?.recency_score ?? null,
    is_breaking:isBreaking,
    provenance: {
      semantics: 'NEWS',
      upstream: 'propbet-news-api',
      canonical_host: url ? 'propbetedge.ai' : null,
      image_transport: rawImage ? 'propbet-img-proxy' : null,
      availability_transport: availability ? 'upstream_structured' : null,
      sport: row?.sport ?? 'nfl'
    }
  };
}

async function upstream(path){
  const response=await fetch(`${NEWS_UPSTREAM}${path}`,{
    headers:{
      accept:'application/json',
      origin:'https://nfl.propbetedge.ai',
      referer:'https://nfl.propbetedge.ai/'
    },
    cache:'no-store'
  });
  const text=await response.text();
  if(!response.ok)throw new Error(`${response.status} ${text.slice(0,160)}`);
  let data;
  try{data=JSON.parse(text)}catch{throw new Error('news_upstream_non_json')}
  return data;
}

export default async function handler(req,res){
  if(req.method!=='GET')return send(res,405,{error:'method_not_allowed'});
  const limit=Math.max(1,Math.min(100,Number(req.query?.limit)||50));
  const paths=[
    `/news?sport=nfl&limit=${limit}&page=1`,
    `/news/by-sport/nfl?limit=${limit}`
  ];
  let lastError='news_unavailable';
  for(const path of paths){
    try{
      const raw=await upstream(path);
      const rows=asArray(raw).map(article).filter(a=>a.title);
      return send(res,200,{
        ok:true,
        sport:'nfl',
        semantics:'NEWS',
        source:'propbet-news-api',
        count:rows.length,
        image_count:rows.filter(row=>row.image_url).length,
        canonical_count:rows.filter(row=>row.url&&/^https:\/\/propbetedge\.ai\/news\/nfl\//i.test(row.url)).length,
        availability_count:rows.filter(row=>row.availability).length,
        articles:rows,
        fetched_at:new Date().toISOString()
      });
    }catch(error){lastError=error instanceof Error?error.message:String(error)}
  }
  return send(res,503,{ok:false,error:'news_unavailable',detail:lastError,semantics:'UNAVAILABLE'});
}
