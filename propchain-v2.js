/* PropBetEdge NFL — PropChain v2
 * Factual context graph: NEWS -> affected entity -> current MARKET -> optional MODEL.
 * Does not claim causal probability movement until event snapshots are stored and audited.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const DEFAULT_EVENT = '8c94552d022acec4a0458d70c19d3da9';
  const MARKETS = ['player_pass_yds','player_reception_yds','player_receptions','player_rush_yds'];
  const state = { loading:false, board:null, news:[], model:null, search:'', sort:'impact', chains:[] };

  const esc = value => String(value ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const num = value => { const n=Number(value); return Number.isFinite(n)?n:NaN; };
  const fmt = (value,d=1) => { const n=num(value); return Number.isFinite(n)?n.toFixed(d).replace(/\.0$/,''):'—'; };
  const currentEvent = () => new URLSearchParams(location.search).get('event') || localStorage.getItem('pbe_nfl_event') || DEFAULT_EVENT;
  const isPro = () => Boolean(window.PBEPro?.state?.pro);
  const playerOf = item => item?.player || item?.player_name || '';
  const marketLabel = market => ({player_pass_yds:'Passing Yards',player_reception_yds:'Receiving Yards',player_receptions:'Receptions',player_rush_yds:'Rushing Yards'}[market] || String(market||'').replace(/^player_/,'').replace(/_/g,' '));

  async function fetchJson(url){
    const response=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});
    if(!response.ok){const detail=await response.text().catch(()=> '');const error=new Error(`${response.status}${detail?` · ${detail.slice(0,120)}`:''}`);error.status=response.status;throw error;}
    return response.json();
  }

  function teamAbbrs(board){
    const event=board?.event||{};
    const names=[event.away_team||event.away,event.home_team||event.home].filter(Boolean).map(String);
    const out=new Set();
    Object.values(window.NFL_TEAMS||{}).forEach(team=>{
      if(names.some(name=>name.toLowerCase()===String(team.name||'').toLowerCase() || name.toLowerCase().includes(String(team.city||'').toLowerCase()))) out.add(team.abbr);
    });
    return out;
  }

  function marketRows(board){
    const map=new Map();
    (board?.market_summary||[]).forEach(s=>{
      const player=playerOf(s);if(!player||!s.market)return;
      map.set(`${player.toLowerCase()}|${s.market}`,{player,market:s.market,consensus:num(s.consensus_line??s.line),summary:s});
    });
    if(!map.size){
      const groups=new Map();
      (board?.quotes||[]).forEach(q=>{
        const player=playerOf(q),market=q.market,point=num(q.point??q.line);if(!player||!market||!Number.isFinite(point))return;
        const key=`${player.toLowerCase()}|${market}`;if(!groups.has(key))groups.set(key,{player,market,points:[]});groups.get(key).points.push(point);
      });
      groups.forEach((g,key)=>{const p=[...g.points].sort((a,b)=>a-b),i=Math.floor(p.length/2),m=p.length%2?p[i]:(p[i-1]+p[i])/2;map.set(key,{player:g.player,market:g.market,consensus:m});});
    }
    return [...map.values()];
  }

  function models(model){
    const map=new Map();
    const rows=model?.models||model?.picks||model?.data||[];
    (Array.isArray(rows)?rows:[]).forEach(m=>{const p=playerOf(m);if(p)map.set(p.toLowerCase(),m)});
    return map;
  }

  function impact(a){const n=Number(a?.impact_score);return Number.isFinite(n)?n:0;}
  function timeAgo(value){if(!value)return'time unavailable';const d=new Date(value);if(Number.isNaN(d.getTime()))return'time unavailable';const h=Math.floor((Date.now()-d.getTime())/3600000);if(h<1)return'<1h ago';if(h<48)return`${h}h ago`;return`${Math.floor(h/24)}d ago`;}

  function buildChains(){
    const eventTeams=teamAbbrs(state.board);
    const markets=marketRows(state.board);
    const modelMap=models(state.model);
    const byPlayer=new Map();
    markets.forEach(row=>{const key=row.player.toLowerCase();if(!byPlayer.has(key))byPlayer.set(key,[]);byPlayer.get(key).push(row)});
    const chains=[];

    state.news.forEach(article=>{
      const articleTeams=(article.teams||[]).map(t=>String(t).toUpperCase());
      const selectedTeamHit=articleTeams.some(t=>eventTeams.has(t));
      const affectedPlayers=(article.players||[]).filter(Boolean);
      let linked=false;
      affectedPlayers.forEach(player=>{
        const rows=byPlayer.get(String(player).toLowerCase())||[];
        rows.forEach(row=>{
          linked=true;
          const model=row.market==='player_pass_yds'?modelMap.get(String(player).toLowerCase()):null;
          chains.push({article,entity:player,entityType:'PLAYER',market:row,model,selectedTeamHit});
        });
      });
      if(!linked && selectedTeamHit){
        const entity=articleTeams.find(t=>eventTeams.has(t)) || articleTeams[0] || 'SELECTED TEAM';
        chains.push({article,entity,entityType:'TEAM',market:null,model:null,selectedTeamHit:true});
      }
    });

    const seen=new Set();
    state.chains=chains.filter(c=>{const key=`${c.article.id}|${c.entity}|${c.market?.market||'team'}`;if(seen.has(key))return false;seen.add(key);return true;});
  }

  function visible(){
    const q=state.search.trim().toLowerCase();
    let rows=state.chains.filter(c=>!q || [c.article.title,c.article.summary,c.entity,c.market?.player,marketLabel(c.market?.market),...(c.article.teams||[])].some(v=>String(v||'').toLowerCase().includes(q)));
    if(state.sort==='latest')rows.sort((a,b)=>new Date(b.article.published_at||0)-new Date(a.article.published_at||0));
    else if(state.sort==='market')rows.sort((a,b)=>Number(Boolean(b.market))-Number(Boolean(a.market)) || impact(b.article)-impact(a.article));
    else rows.sort((a,b)=>impact(b.article)-impact(a.article) || new Date(b.article.published_at||0)-new Date(a.article.published_at||0));
    return rows;
  }

  function modelNode(chain){
    if(!chain.market)return `<div class="pbe15-node"><div class="pbe15-node-label">PBE MODEL</div><h3>Not linked</h3><p>No player market was matched for this team-level news event, so no model output is inferred.</p><div class="pbe15-node-foot">MODEL · UNAVAILABLE FOR CHAIN</div></div>`;
    if(!isPro())return `<div class="pbe15-node"><div class="pbe15-node-label">PBE MODEL</div><h3>NFL Pro</h3><p>Model context for supported player markets is entitlement-gated.</p><button class="pbe15-prolock" onclick="PBEPro.open('upgrade')">◆ Unlock model context</button></div>`;
    if(!chain.model)return `<div class="pbe15-node"><div class="pbe15-node-label">PBE MODEL</div><h3>Not modeled</h3><p>The production model does not support this market or does not have required inputs. Nothing synthetic is inserted.</p><div class="pbe15-node-foot">MODEL · UNAVAILABLE</div></div>`;
    const fair=num(chain.model.fair_line),gap=num(chain.model.fair_line_gap_yards),prob=num(chain.model.model_over_at_consensus_pct);
    return `<div class="pbe15-node"><div class="pbe15-node-label">PBE MODEL</div><h3>Fair ${esc(fmt(fair,1))}</h3><div class="pbe15-node-value blue">${Number.isFinite(gap)&&gap>0?'+':''}${esc(fmt(gap,1))}</div><div class="pbe15-node-foot">FAIR-LINE GAP${Number.isFinite(prob)?` · ${esc(fmt(prob,1))}% OVER`:''}</div><p>This is current model context, not evidence that the news event caused the model value.</p></div>`;
  }

  function chainHtml(chain,index){
    const a=chain.article,m=chain.market;
    return `<article class="pbe15-item"><div class="pbe15-item-head"><span>CONTEXT CHAIN ${String(index+1).padStart(2,'0')} · ${esc(String(a.topic_kind||'NEWS').toUpperCase())}</span><span class="pbe15-causal">CONTEXT · CAUSALITY UNPROVEN</span></div><div class="pbe15-flow"><div class="pbe15-node"><div class="pbe15-node-label">SOURCE EVENT · NEWS</div><h3>${esc(a.title)}</h3><p>${esc(a.summary||'No summary available.')}</p><div class="pbe15-node-foot">${esc(a.source||'source unavailable')} · ${esc(timeAgo(a.published_at))} · impact ${esc(impact(a)||'—')}</div></div><div class="pbe15-arrow">→</div><div class="pbe15-node"><div class="pbe15-node-label">AFFECTED ENTITY</div><h3>${esc(chain.entity)}</h3><div class="pbe15-node-value">${esc(chain.entityType)}</div><div class="pbe15-node-foot">${chain.selectedTeamHit?'SELECTED EVENT CONTEXT':'NEWS ENTITY'}</div><p>Entity relationship comes from the newsroom enrichment layer, not a causal probability rule.</p></div><div class="pbe15-arrow">→</div>${m?`<div class="pbe15-node"><div class="pbe15-node-label">CURRENT MARKET · LIVE</div><h3>${esc(marketLabel(m.market))}</h3><div class="pbe15-node-value">${esc(fmt(m.consensus,1))}</div><div class="pbe15-node-foot">SPORTSBOOK CONSENSUS · ${esc(m.player)}</div><p>The market line is current provider context at page load. No claim is made that it moved because of the source event.</p></div>`:`<div class="pbe15-node"><div class="pbe15-node-label">CURRENT MARKET</div><h3>No player match</h3><p>This news item is relevant to a selected-event team but does not map cleanly to a current player market.</p><div class="pbe15-node-foot">MARKET LINK · UNAVAILABLE</div></div>`}<div class="pbe15-arrow">→</div>${modelNode(chain)}</div><div class="pbe15-item-foot"><span>To become a true cascade record this chain still needs stored trigger ID, before/after probability, market line snapshots, correlation rule and timestamps.</span>${a.url?`<a href="${esc(a.url)}">Source article ↗</a>`:''}</div></article>`;
  }

  function shell(){
    const rows=visible();const event=state.board?.event||{};const away=event.away_team||event.away||'Away',home=event.home_team||event.home||'Home';
    const marketLinked=state.chains.filter(c=>c.market).length,modeled=state.chains.filter(c=>c.model).length,newsCount=new Set(state.chains.map(c=>c.article.id)).size;
    return `<section class="pbe15-chain"><header class="pbe15-hero"><div><div class="pbe15-kicker">PROPCHAIN · EVIDENCE MAP BETA</div><h1 class="pbe15-title">Connect the evidence.<br><em>Don’t invent the cause.</em></h1><div class="pbe15-copy">PropChain now joins factual current news enrichment to affected players/teams, the selected event’s current sportsbook markets, and PBE model context where supported. The old scripted cascade engine and random edge windows are retired.</div></div><aside class="pbe15-status"><b>${esc(away)} @ ${esc(home)}</b><span>${newsCount} linked news events · ${marketLinked} player-market links · ${isPro()?modeled:'PRO'} modeled links</span></aside></header><div class="pbe15-warning"><strong>Beta contract:</strong> these are evidence/context chains, not stored causal chains. PropBetEdge will not say “this injury caused this probability move” until trigger IDs, before/after model values and observed market snapshots are persisted and auditable.</div><div class="pbe15-summary"><div class="pbe15-stat"><b>${state.chains.length}</b><span>Context chains</span></div><div class="pbe15-stat"><b class="green">${marketLinked}</b><span>Chains linked to current market</span></div><div class="pbe15-stat"><b>${newsCount}</b><span>Unique current news events</span></div><div class="pbe15-stat"><b class="${isPro()?'green':'gold'}">${isPro()?modeled:'PRO'}</b><span>Production model links</span></div><div class="pbe15-stat"><b class="gold">0</b><span>Claims of proven causality</span></div></div><section class="pbe15-controls"><input id="pbe15-search" class="pbe15-input" type="search" placeholder="Search player, team, headline or market…" value="${esc(state.search)}"><select id="pbe15-sort" class="pbe15-select"><option value="impact" ${state.sort==='impact'?'selected':''}>Highest impact</option><option value="latest" ${state.sort==='latest'?'selected':''}>Latest news</option><option value="market" ${state.sort==='market'?'selected':''}>Market-linked first</option></select></section>${rows.length?`<div class="pbe15-chain-list">${rows.slice(0,18).map(chainHtml).join('')}</div>`:`<div class="pbe15-empty"><div><strong>No factual chain candidates</strong><p>The current selected event and newsroom feed did not produce a clean news-to-market link. PropChain does not fabricate one to fill the screen.</p></div></div>`}<div class="pbe15-roadmap"><div class="pbe15-road ready"><b>Current news events</b><span>Real newsroom source, affected entities and impact metadata are attached.</span></div><div class="pbe15-road ready"><b>Current market snapshot</b><span>Selected event player markets come from the live sportsbook provider.</span></div><div class="pbe15-road ready"><b>Model context</b><span>Supported PBE production model rows are available to NFL Pro.</span></div><div class="pbe15-road pending"><b>Audited cascade ledger</b><span>Next: trigger IDs + before/after probabilities + market snapshots + correlation rule + settled result.</span></div></div></section>`;
  }

  async function render(){
    if(state.loading)return;state.loading=true;
    const vc=document.getElementById('view-container');if(!vc){state.loading=false;return;}
    vc.innerHTML='<section class="pbe15-chain"><div class="pbe15-empty"><div><strong>Building factual evidence chains</strong><p>Joining current newsroom events to selected-event sportsbook markets and optional PBE model context.</p></div></div></section>';
    try{
      const eventId=currentEvent();
      const [board,news,model]=await Promise.all([
        fetchJson(`${API}/api/odds/board?event_id=${encodeURIComponent(eventId)}&markets=${encodeURIComponent(MARKETS.join(','))}`),
        fetchJson('/api/news-feed?limit=100'),
        isPro()?fetchJson(`${API}/api/picks/pass?event_id=${encodeURIComponent(eventId)}`).catch(()=>null):Promise.resolve(null)
      ]);
      state.board=board;state.news=Array.isArray(news?.articles)?news.articles:[];state.model=model;buildChains();vc.innerHTML=shell();wire();
    }catch(error){vc.innerHTML=`<section class="pbe15-chain"><div class="pbe15-empty"><div><strong>PropChain context unavailable</strong><p>${esc(error instanceof Error?error.message:String(error))}</p></div></div></section>`;}
    finally{state.loading=false;}
  }

  function refresh(){const vc=document.getElementById('view-container');if(vc){vc.innerHTML=shell();wire();}}
  function wire(){document.getElementById('pbe15-search')?.addEventListener('input',e=>{state.search=e.currentTarget.value||'';refresh()});document.getElementById('pbe15-sort')?.addEventListener('change',e=>{state.sort=e.currentTarget.value||'impact';refresh()});}
  function install(){if(!window.App?.VIEWS)return false;App.VIEWS.propchain=render;const nav=document.getElementById('nav-propchain');if(nav)nav.innerHTML='<span class="ni-icon">◇</span> PropChain <span class="nav-badge" style="color:#55d68c;background:rgba(85,214,140,.07)">BETA</span>';return true;}
  window.PBEPropChainV2={render,state};install();document.addEventListener('DOMContentLoaded',install,{once:true});window.addEventListener('pbe:pro-state',()=>{if(document.querySelector('.pbe15-chain')&&!state.loading)render();});
})();
