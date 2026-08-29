const NEWS_UPSTREAM = 'https://propbet-news-api.sales-fd3.workers.dev';

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

function article(row){
  const take=row?.take || row?.analysis || row?.ai_take || {};
  const teams=arr(row?.take_teams ?? row?.affected_teams ?? row?.teams ?? take?.teams);
  const players=arr(row?.take_players ?? row?.affected_players ?? row?.players ?? take?.players);
  const props=arr(row?.take_props ?? row?.affected_props ?? row?.props ?? take?.props);
  const topic=String(row?.topic_kind ?? row?.topic ?? row?.category ?? row?.type ?? take?.topic_kind ?? '').toLowerCase();
  const title=row?.title ?? row?.headline ?? row?.name ?? '';
  const summary=row?.summary ?? row?.description ?? row?.dek ?? row?.excerpt ?? row?.take_summary ?? take?.summary ?? '';
  const slug=row?.slug ?? null;
  const url=row?.url ?? row?.article_url ?? row?.link ?? (slug?`https://propbetedge.ai/news/nfl/${slug}`:null);
  return {
    id: row?.id ?? row?.news_id ?? slug ?? url ?? `${title}|${row?.published_at||''}`,
    title,
    summary,
    url,
    slug,
    source: row?.source ?? row?.publisher ?? row?.source_name ?? null,
    author: row?.author ?? null,
    published_at: row?.published_at ?? row?.publishedAt ?? row?.date ?? row?.created_at ?? null,
    updated_at: row?.updated_at ?? row?.updatedAt ?? null,
    topic_kind: topic || null,
    teams,
    players,
    props,
    impact_score: row?.prop_impact_score ?? row?.impact_score ?? row?.take_impact ?? take?.impact_score ?? null,
    relevance_score: row?.relevance_score ?? row?.homepage_score ?? row?.recency_score ?? null,
    is_breaking: Boolean(row?.is_breaking ?? row?.breaking ?? false),
    provenance: {
      semantics: 'NEWS',
      upstream: 'propbet-news-api',
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
        articles:rows,
        fetched_at:new Date().toISOString()
      });
    }catch(error){lastError=error instanceof Error?error.message:String(error)}
  }
  return send(res,503,{ok:false,error:'news_unavailable',detail:lastError,semantics:'UNAVAILABLE'});
}
