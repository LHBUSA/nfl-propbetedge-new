/* PropBetEdge NFL — Market Watch v3
 * Institutional cross-book monitor.
 *
 * Truth contract:
 * - CURRENT is the live provider cross-section returned by the NFL odds gateway.
 * - LOCAL Δ is only the explicit browser baseline captured by the user.
 * - Auto refresh is a 30-second provider refresh, not a WebSocket claim.
 * - Cell flashes compare successive provider refreshes in this browser only.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const DEFAULT_EVENT = '8c94552d022acec4a0458d70c19d3da9';
  const BATCH_SIZE = 5;
  const AUTO_REFRESH_MS = 30000;
  const MARKETS = [
    'player_pass_yds','player_pass_completions','player_pass_attempts','player_pass_tds','player_pass_interceptions',
    'player_reception_yds','player_receptions','player_rush_yds','player_rush_attempts','player_anytime_td'
  ];

  const BOOK_BRANDS = [
    {re:/draftkings/i,code:'DK',domain:'draftkings.com'},
    {re:/fanduel/i,code:'FD',domain:'fanduel.com'},
    {re:/betmgm|mgm/i,code:'MGM',domain:'betmgm.com'},
    {re:/caesars/i,code:'CZR',domain:'caesars.com'},
    {re:/betrivers|bet rivers/i,code:'BR',domain:'betrivers.com'},
    {re:/bet365/i,code:'365',domain:'bet365.com'},
    {re:/fanatics/i,code:'FAN',domain:'sportsbook.fanatics.com'},
    {re:/espn\s*bet/i,code:'ESPN',domain:'espnbet.com'},
    {re:/hard\s*rock/i,code:'HR',domain:'hardrock.bet'},
    {re:/bally/i,code:'BLY',domain:'ballybet.com'},
    {re:/bovada/i,code:'BOV',domain:'bovada.lv'},
    {re:/betonline/i,code:'BOL',domain:'betonline.ag'},
    {re:/betus/i,code:'BUS',domain:'betus.com.pa'},
    {re:/mybookie/i,code:'MB',domain:'mybookie.ag'},
    {re:/fliff/i,code:'FLF',domain:'getfliff.com'}
  ];

  const state = {
    loading:false,
    refreshing:false,
    board:null,
    rows:[],
    search:'',
    market:'all',
    filter:'all',
    sort:'dispersion',
    watch:new Set(),
    baseline:null,
    lastRefresh:0,
    lastRefreshError:null
  };

  let autoTimer = null;
  let clockTimer = null;

  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const num=v=>{const n=Number(v);return Number.isFinite(n)?n:NaN};
  const fmt=(v,d=1)=>{const n=num(v);return Number.isFinite(n)?n.toFixed(d).replace(/\.0$/,''):'—'};
  const price=v=>{const n=num(v);return Number.isFinite(n)?`${n>0?'+':''}${Math.round(n)}`:'—'};
  const currentEvent=()=>new URLSearchParams(location.search).get('event')||localStorage.getItem('pbe_nfl_event')||DEFAULT_EVENT;
  const isPro=()=>Boolean(window.PBEPro?.state?.pro);
  const playerOf=x=>x?.player||x?.player_name||'';
  const bookOf=q=>q?.book||q?.book_title||q?.sportsbook||q?.book_key||'';
  const sideOf=q=>String(q?.direction||q?.outcome||q?.side||q?.name||'').toUpperCase();
  const pointOf=q=>num(q?.point??q?.line);
  const priceOf=q=>num(q?.price??q?.american_odds??q?.odds);
  const eventKey=()=>`pbe_market_watch_${currentEvent()}`;
  const baselineKey=()=>`pbe_market_baseline_${currentEvent()}`;
  const marketLabel=m=>({player_pass_yds:'Passing Yards',player_pass_completions:'Pass Completions',player_pass_attempts:'Pass Attempts',player_pass_tds:'Passing TDs',player_pass_interceptions:'Interceptions',player_reception_yds:'Receiving Yards',player_receptions:'Receptions',player_rush_yds:'Rushing Yards',player_rush_attempts:'Rush Attempts',player_anytime_td:'Anytime TD'}[m]||String(m||'').replace(/^player_/,'').replace(/_/g,' '));

  async function fetchJson(url){
    const r=await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});
    if(!r.ok){const text=await r.text().catch(()=> '');throw new Error(`${r.status}${text?` · ${text.slice(0,120)}`:''}`);}
    return r.json();
  }

  function batch(values,size){const out=[];for(let i=0;i<values.length;i+=size)out.push(values.slice(i,i+size));return out;}
  function median(values){const a=values.map(num).filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return NaN;const i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2;}
  function bestQuote(quotes,side){const rows=quotes.filter(q=>sideOf(q).includes(side));if(!rows.length)return null;return [...rows].sort((a,b)=>{const ap=pointOf(a),bp=pointOf(b);if(Number.isFinite(ap)&&Number.isFinite(bp)&&ap!==bp)return side==='OVER'?ap-bp:bp-ap;return priceOf(b)-priceOf(a);})[0];}

  function mergeBoards(parts){
    const valid=parts.filter(Boolean);if(!valid.length)throw new Error('No Prop Board batches returned');
    const merged={...valid[0],quotes:[],market_summary:[]},qSeen=new Set(),sSeen=new Set();
    valid.forEach(part=>{
      (part.quotes||[]).forEach(q=>{const key=[bookOf(q),q.market,playerOf(q),sideOf(q),q.point??q.line,q.price??q.odds??q.american_odds].join('|');if(!qSeen.has(key)){qSeen.add(key);merged.quotes.push(q);}});
      (part.market_summary||[]).forEach(s=>{const key=`${playerOf(s)}|${s.market}`;if(!sSeen.has(key)){sSeen.add(key);merged.market_summary.push(s);}});
    });
    merged.quote_count=merged.quotes.length;
    const pm=new Set();[...merged.quotes,...merged.market_summary].forEach(x=>{const p=playerOf(x);if(p&&x.market)pm.add(`${p}|${x.market}`)});merged.player_market_count=pm.size;
    const updates=valid.map(p=>p.provider_last_update||p.last_update||p.updated_at).filter(Boolean).sort();if(updates.length)merged.provider_last_update=updates[updates.length-1];
    return merged;
  }

  async function loadMarketGroup(group){
    try{return [await fetchJson(`${API}/api/odds/board?event_id=${encodeURIComponent(currentEvent())}&markets=${encodeURIComponent(group.join(','))}`)];}
    catch(_){
      const settled=await Promise.allSettled(group.map(m=>fetchJson(`${API}/api/odds/board?event_id=${encodeURIComponent(currentEvent())}&markets=${encodeURIComponent(m)}`)));
      return settled.filter(r=>r.status==='fulfilled').map(r=>r.value);
    }
  }

  async function loadBoard(){
    const groups=batch(MARKETS,BATCH_SIZE);
    const results=await Promise.all(groups.map(loadMarketGroup));
    return mergeBoards(results.flat());
  }

  function buildRows(board){
    const map=new Map();
    const ensure=(player,market)=>{const key=`${player.toLowerCase()}|${market}`;if(!map.has(key))map.set(key,{key,player,market,summary:null,quotes:[]});return map.get(key)};
    (board.market_summary||[]).forEach(s=>{const p=playerOf(s);if(p&&s.market)ensure(p,s.market).summary=s;});
    (board.quotes||[]).forEach(q=>{const p=playerOf(q);if(p&&q.market)ensure(p,q.market).quotes.push(q);});
    return [...map.values()].map(row=>{
      const points=row.quotes.map(pointOf).filter(Number.isFinite),lo=points.length?Math.min(...points):NaN,hi=points.length?Math.max(...points):NaN;
      let consensus=num(row.summary?.consensus_line??row.summary?.line);if(!Number.isFinite(consensus))consensus=median(points);
      const books=[...new Set(row.quotes.map(bookOf).filter(Boolean))];
      return {...row,consensus,lo,hi,spread:Number.isFinite(lo)&&Number.isFinite(hi)?hi-lo:NaN,books,bestOver:bestQuote(row.quotes,'OVER'),bestUnder:bestQuote(row.quotes,'UNDER')};
    });
  }

  function loadLocal(){
    try{state.watch=new Set(JSON.parse(localStorage.getItem(eventKey())||'[]'));}catch(_){state.watch=new Set();}
    try{state.baseline=JSON.parse(localStorage.getItem(baselineKey())||'null');}catch(_){state.baseline=null;}
  }
  function saveWatch(){localStorage.setItem(eventKey(),JSON.stringify([...state.watch]));}
  function captureBaseline(){
    const rows={};state.rows.forEach(r=>{rows[r.key]={consensus:r.consensus,lo:r.lo,hi:r.hi,books:r.books.length};});
    state.baseline={captured_at:new Date().toISOString(),event_id:currentEvent(),rows};
    localStorage.setItem(baselineKey(),JSON.stringify(state.baseline));
    renderShell();
  }
  function clearBaseline(){state.baseline=null;localStorage.removeItem(baselineKey());renderShell();}
  function delta(row){const base=state.baseline?.rows?.[row.key];if(!base)return NaN;const now=num(row.consensus),before=num(base.consensus);return Number.isFinite(now)&&Number.isFinite(before)?now-before:NaN;}

  function visible(){
    const q=state.search.trim().toLowerCase();
    let rows=state.rows.filter(r=>(!q||`${r.player} ${marketLabel(r.market)}`.toLowerCase().includes(q))&&(state.market==='all'||r.market===state.market)&&(state.filter!=='watch'||state.watch.has(r.key)));
    if(state.sort==='spread')rows.sort((a,b)=>(num(b.spread)||0)-(num(a.spread)||0));
    else if(state.sort==='movement'&&state.baseline)rows.sort((a,b)=>Math.abs(num(delta(b))||0)-Math.abs(num(delta(a))||0));
    else if(state.sort==='books')rows.sort((a,b)=>b.books.length-a.books.length);
    else rows.sort((a,b)=>(num(b.spread)||0)-(num(a.spread)||0)||b.books.length-a.books.length);
    return rows;
  }

  function eventLabel(){const e=state.board?.event||{},a=e.away_team||e.away,h=e.home_team||e.home;return a&&h?`${a} @ ${h}`:'Selected NFL event';}
  function timeLabel(v){if(!v)return'unknown';const d=new Date(v);return Number.isNaN(d.getTime())?String(v):d.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}
  function ageLabel(ts){if(!ts)return'—';const s=Math.max(0,Math.round((Date.now()-ts)/1000));if(s<60)return`${s}s`;return`${Math.round(s/60)}m`;}

  function brandFor(name){return BOOK_BRANDS.find(item=>item.re.test(String(name||'')))||null;}
  function bookMark(name){
    const raw=String(name||'Sportsbook');
    const brand=brandFor(raw);
    const code=brand?.code||raw.replace(/[^A-Za-z0-9]/g,'').slice(0,3).toUpperCase()||'BK';
    const img=brand?`<img loading="lazy" decoding="async" referrerpolicy="no-referrer" src="https://${esc(brand.domain)}/favicon.ico" alt="" onerror="this.style.display='none'">`:'';
    return `<span class="pbe22-bookmark" title="${esc(raw)}">${img}<span>${esc(code)}</span></span>`;
  }

  function bestMarkup(q){
    if(!q)return'<span class="pbe22-best-empty">—</span>';
    return `<span class="pbe22-best"><strong>${esc(fmt(pointOf(q),1))}</strong><em>${esc(price(priceOf(q)))}</em>${bookMark(bookOf(q))}</span>`;
  }

  function heatClass(spread){
    const d=num(spread);if(!Number.isFinite(d)||d<=0)return'cool';if(d>=5)return'extreme';if(d>=3)return'hot';if(d>=1.5)return'warm';return'cool';
  }

  function rowHtml(r,max){
    const d=delta(r),disp=Number.isFinite(r.spread)?r.spread:0,pct=Math.min(100,disp/Math.max(max,1)*100),heat=heatClass(disp);
    const deltaHtml=state.baseline&&Number.isFinite(d)?`<span class="pbe22-delta ${d>0?'up':d<0?'down':'flat'}" title="Consensus change vs local baseline">${d>0?'+':''}${esc(fmt(d,1))}</span>`:'';
    return `<tr data-row-key="${esc(r.key)}" class="pbe22-heat-${heat}">
      <td><button class="pbe22-star ${state.watch.has(r.key)?'on':''}" data-watch="${esc(r.key)}" aria-label="${state.watch.has(r.key)?'Remove from':'Add to'} watchlist">${state.watch.has(r.key)?'★':'☆'}</button></td>
      <td><div class="pbe22-player" data-player="${esc(r.player)}">${esc(r.player)}</div><div class="pbe22-sub">${esc(r.books.length)} books</div></td>
      <td><div class="pbe22-market">${esc(marketLabel(r.market))}</div><div class="pbe22-sub">${esc(r.market)}</div></td>
      <td class="pbe22-num" data-field="consensus"><span class="pbe22-line">${esc(fmt(r.consensus,1))}</span></td>
      <td class="pbe22-num" data-field="range"><span class="pbe22-range">${esc(Number.isFinite(r.lo)&&Number.isFinite(r.hi)?`${fmt(r.lo,1)} – ${fmt(r.hi,1)}`:'—')}</span></td>
      <td class="pbe22-num" data-field="dispersion"><div class="pbe22-dispersion ${heat}"><b>${esc(fmt(r.spread,1))}</b><span class="pbe22-meter"><span style="width:${pct.toFixed(0)}%"></span></span></div></td>
      <td class="pbe22-num" data-field="best-over">${bestMarkup(r.bestOver)}</td>
      <td class="pbe22-num" data-field="best-under">${bestMarkup(r.bestUnder)}</td>
      <td class="pbe22-num pbe22-local-cell ${state.baseline?'has-baseline':'empty'}" data-field="delta">${deltaHtml}</td>
    </tr>`;
  }

  /* Free-tier Market Watch used to replace the entire terminal with one box and
     a button -- 869 characters of rendered text on a 2,500px page. A user cannot
     want a tool they have never seen. The rows, the columns and the real players
     are all shown; only the four premium columns are obscured, and there is one
     call to action for the whole surface rather than one per row. Consensus and
     book range stay visible because the free Prop Board already shows them. */
  function lockedRowHtml(r){
    return `<tr data-row-key="${esc(r.key)}">
      <td><span class="pbe22-star locked" aria-hidden="true">☆</span></td>
      <td><div class="pbe22-player" data-player="${esc(r.player)}">${esc(r.player)}</div><div class="pbe22-sub">${esc(r.books.length)} books</div></td>
      <td><div class="pbe22-market">${esc(marketLabel(r.market))}</div><div class="pbe22-sub">${esc(r.market)}</div></td>
      <td class="pbe22-num"><span class="pbe22-line">${esc(fmt(r.consensus,1))}</span></td>
      <td class="pbe22-num"><span class="pbe22-range">${esc(Number.isFinite(r.lo)&&Number.isFinite(r.hi)?`${fmt(r.lo,1)} – ${fmt(r.hi,1)}`:'—')}</span></td>
      <td class="pbe22-num pbe22-locked-cell"><span class="pbe-locked-value" aria-label="NFL Pro"></span></td>
      <td class="pbe22-num pbe22-locked-cell"><span class="pbe-locked-value" aria-label="NFL Pro"></span></td>
      <td class="pbe22-num pbe22-locked-cell"><span class="pbe-locked-value" aria-label="NFL Pro"></span></td>
      <td class="pbe22-num pbe22-locked-cell"><span class="pbe-locked-value" aria-label="NFL Pro"></span></td>
    </tr>`;
  }

  function lockedBody(){
    const rows=state.rows.slice(0,24);
    return rows.length?rows.map(lockedRowHtml).join(''):`<tr><td colspan="9"><div class="pbe22-empty compact">No current provider market rows for this event.</div></td></tr>`;
  }

  function lockedShell(){
    const rows=state.rows;
    const books=new Set(rows.flatMap(r=>r.books)).size;
    return `
      <div class="pbe22-summary"><div class="pbe22-stat"><b>${rows.length}</b><span>Player / market rows</span></div><div class="pbe22-stat"><b>${books}</b><span>Sportsbooks priced</span></div><div class="pbe22-stat"><b class="gold">4</b><span>Pro columns locked</span></div><div class="pbe22-stat"><b>30s</b><span>Provider refresh</span></div></div>
      <div class="pbe-lock-cta">
        <div class="pbe-lock-copy">
          <h3>Dispersion, best executable price and Local &Delta; are NFL Pro</h3>
          <p>You are seeing every row and the live cross-book consensus. NFL Pro adds dispersion ranking across all ${rows.length} rows, the best over/under price with its book, a personal watchlist, and Local &Delta; against a baseline you capture yourself.</p>
        </div>
        <button class="pbe22-btn gold" onclick="PBEPro.open('upgrade')">Unlock NFL Pro &middot; $9.99/week</button>
      </div>
      <section class="pbe22-table-wrap pbe22-locked"><div class="pbe22-scroll"><table class="pbe22-table"><thead><tr><th>Watch</th><th>Player</th><th>Prop</th><th>Consensus</th><th>Book Range</th><th class="pbe22-th-locked">Dispersion</th><th class="pbe22-th-locked">Best Over</th><th class="pbe22-th-locked">Best Under</th><th class="pbe22-th-locked">Local &Delta;</th></tr></thead><tbody>${lockedBody()}</tbody></table></div><div class="pbe22-foot"><span>CURRENT = provider cross-section</span><span>${rows.length>24?`Showing 24 of ${rows.length} rows`:''}</span></div></section>`;
  }

  function body(){
    const rows=visible();
    const max=Math.max(...state.rows.map(x=>num(x.spread)).filter(Number.isFinite),1);
    return rows.length?rows.map(row=>rowHtml(row,max)).join(''):`<tr><td colspan="9"><div class="pbe22-empty compact">No market rows match the current watch/filter settings.</div></td></tr>`;
  }

  function baselineControl(){
    if(!state.baseline){
      return `<button class="pbe22-baseline-float" id="pbe22-capture" type="button"><span>＋</span><div><strong>Capture Baseline</strong><small>Enable Local Δ from this exact board</small></div></button>`;
    }
    return `<div class="pbe22-baseline compact"><div><strong>Baseline · ${esc(timeLabel(state.baseline.captured_at))}</strong><span>Local Δ compares current consensus with this browser snapshot. It is not provider history.</span></div><div class="pbe22-baseline-actions"><button class="pbe22-btn green" id="pbe22-capture" type="button">Reset now</button><button class="pbe22-btn" id="pbe22-clear" type="button">Clear</button></div></div>`;
  }

  function shell(){
    const rows=state.rows,watched=state.watch.size,withSpread=rows.filter(r=>num(r.spread)>0),maxSpread=withSpread.length?Math.max(...withSpread.map(r=>r.spread)):0,markets=[...new Set(rows.map(r=>r.market))].sort();
    const refreshText=state.lastRefresh?`${ageLabel(state.lastRefresh)} AGO`:'NOW';
    return `<section class="pbe22-watch pbe22-watch-v3">
      <header class="pbe22-hero"><div><div class="pbe22-kicker">NFL PRO · MARKET TERMINAL</div><h1 class="pbe22-title">Watch the market.<br><em>Spot the inefficiency.</em></h1><div class="pbe22-copy">Current cross-book pricing, best executable numbers, dispersion heat and a personal watchlist — structured for rapid line shopping without pretending a browser snapshot is provider history.</div></div><aside class="pbe22-status"><div class="pbe22-status-top"><b>${esc(eventLabel())}</b><span class="pbe22-auto">AUTO 30S</span></div><span id="pbe22-status-meta">${esc(state.board?.source?.semantics||'UNAVAILABLE')} · ${esc(rows.length)} rows · provider ${esc(timeLabel(state.board?.provider_last_update||state.board?.updated_at))} · refreshed ${refreshText}</span></aside></header>
      <div class="pbe22-contract"><strong>Market contract:</strong> cross-book range and dispersion are current provider data. Local Δ appears only after you explicitly capture a browser baseline. Successive refresh flashes are local comparisons between live provider responses, not a claim of stored 24-hour movement.</div>
      ${!isPro()?lockedShell():`
      <div class="pbe22-summary"><div class="pbe22-stat"><b id="pbe22-stat-rows">${rows.length}</b><span>Player / market rows</span></div><div class="pbe22-stat"><b class="green" id="pbe22-stat-watch">${watched}</b><span>Watched rows</span></div><div class="pbe22-stat"><b id="pbe22-stat-books">${new Set(rows.flatMap(r=>r.books)).size}</b><span>Sportsbooks</span></div><div class="pbe22-stat hot"><b id="pbe22-stat-spread">${esc(fmt(maxSpread,1))}</b><span>Largest line spread</span></div><div class="pbe22-stat"><b class="gold" id="pbe22-stat-baseline">${state.baseline?'SET':'—'}</b><span>Local baseline</span></div></div>
      ${baselineControl()}
      <div class="pbe22-toolbar"><input id="pbe22-search" class="pbe22-input" placeholder="Search player or prop…" value="${esc(state.search)}"><select id="pbe22-market" class="pbe22-select"><option value="all">All markets</option>${markets.map(m=>`<option value="${esc(m)}" ${state.market===m?'selected':''}>${esc(marketLabel(m))}</option>`).join('')}</select><select id="pbe22-filter" class="pbe22-select"><option value="all" ${state.filter==='all'?'selected':''}>All rows</option><option value="watch" ${state.filter==='watch'?'selected':''}>Watchlist only</option></select><select id="pbe22-sort" class="pbe22-select"><option value="dispersion" ${state.sort==='dispersion'?'selected':''}>Largest dispersion</option><option value="movement" ${state.sort==='movement'?'selected':''} ${state.baseline?'':'disabled'}>Largest Local Δ</option><option value="books" ${state.sort==='books'?'selected':''}>Most books</option></select><button class="pbe22-refresh" id="pbe22-refresh" type="button" title="Refresh provider market now">↻ <span>Refresh</span></button></div>
      <section class="pbe22-table-wrap"><div class="pbe22-scroll"><table class="pbe22-table"><thead><tr><th>Watch</th><th>Player</th><th>Prop</th><th>Consensus</th><th>Book Range</th><th>Dispersion</th><th>Best Over</th><th>Best Under</th><th title="Blank until you capture a browser-local baseline">Local Δ</th></tr></thead><tbody id="pbe22-body">${body()}</tbody></table></div><div class="pbe22-foot"><span>CURRENT = provider cross-section</span><span>FLASH = change since previous live refresh in this browser</span><span>LOCAL Δ = explicit browser baseline</span></div></section>`}
    </section>`;
  }

  function snapshotQuote(q){return q?{line:pointOf(q),price:priceOf(q),book:bookOf(q)}:null;}
  function snapshotRows(rows){const map=new Map();rows.forEach(r=>map.set(r.key,{consensus:num(r.consensus),lo:num(r.lo),hi:num(r.hi),over:snapshotQuote(r.bestOver),under:snapshotQuote(r.bestUnder),delta:num(delta(r))}));return map;}
  function changed(a,b){return Number.isFinite(a)||Number.isFinite(b)?a!==b:String(a??'')!==String(b??'');}

  function quoteDirection(prev,next,side){
    if(!prev||!next)return'neutral';
    if(Number.isFinite(prev.line)&&Number.isFinite(next.line)&&prev.line!==next.line){
      if(side==='OVER')return next.line<prev.line?'better':'worse';
      return next.line>prev.line?'better':'worse';
    }
    if(Number.isFinite(prev.price)&&Number.isFinite(next.price)&&prev.price!==next.price)return next.price>prev.price?'better':'worse';
    if(prev.book!==next.book)return'neutral';
    return'';
  }

  function flashCell(cell,kind){
    if(!cell||!kind)return;
    cell.classList.remove('pbe22-flash-better','pbe22-flash-worse','pbe22-flash-neutral');
    void cell.offsetWidth;
    cell.classList.add(`pbe22-flash-${kind}`);
    setTimeout(()=>cell.classList.remove(`pbe22-flash-${kind}`),1350);
  }

  function applyFlashes(before){
    if(!before?.size)return;
    state.rows.forEach(row=>{
      const prev=before.get(row.key);if(!prev)return;
      const tr=document.querySelector(`.pbe22-table tr[data-row-key="${CSS.escape(row.key)}"]`);if(!tr)return;
      if(changed(prev.consensus,num(row.consensus)))flashCell(tr.querySelector('[data-field="consensus"]'),'neutral');
      if(changed(prev.lo,num(row.lo))||changed(prev.hi,num(row.hi)))flashCell(tr.querySelector('[data-field="range"]'),'neutral');
      const over=quoteDirection(prev.over,snapshotQuote(row.bestOver),'OVER');if(over)flashCell(tr.querySelector('[data-field="best-over"]'),over);
      const under=quoteDirection(prev.under,snapshotQuote(row.bestUnder),'UNDER');if(under)flashCell(tr.querySelector('[data-field="best-under"]'),under);
      const nowDelta=num(delta(row));if(state.baseline&&changed(prev.delta,nowDelta))flashCell(tr.querySelector('[data-field="delta"]'),nowDelta>prev.delta?'better':'worse');
    });
  }

  function updateSummary(){
    const rows=state.rows,withSpread=rows.filter(r=>num(r.spread)>0),maxSpread=withSpread.length?Math.max(...withSpread.map(r=>r.spread)):0;
    const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=String(value)};
    set('pbe22-stat-rows',rows.length);set('pbe22-stat-watch',state.watch.size);set('pbe22-stat-books',new Set(rows.flatMap(r=>r.books)).size);set('pbe22-stat-spread',fmt(maxSpread,1));set('pbe22-stat-baseline',state.baseline?'SET':'—');
    const meta=document.getElementById('pbe22-status-meta');
    if(meta)meta.textContent=`${state.board?.source?.semantics||'UNAVAILABLE'} · ${rows.length} rows · provider ${timeLabel(state.board?.provider_last_update||state.board?.updated_at)} · refreshed ${state.lastRefresh?`${ageLabel(state.lastRefresh)} ago`:'now'}${state.lastRefreshError?' · last refresh degraded':''}`;
  }

  function refreshTable(before=null){
    const tbody=document.getElementById('pbe22-body');if(!tbody)return;
    const scroller=document.querySelector('.pbe22-scroll');const top=scroller?.scrollTop||0,left=scroller?.scrollLeft||0;
    tbody.innerHTML=body();wireRows();
    if(scroller){scroller.scrollTop=top;scroller.scrollLeft=left;}
    updateSummary();
    if(before)requestAnimationFrame(()=>applyFlashes(before));
  }

  function wireRows(){
    document.querySelectorAll('[data-watch]').forEach(btn=>btn.addEventListener('click',event=>{event.stopPropagation();const key=btn.dataset.watch;if(state.watch.has(key))state.watch.delete(key);else state.watch.add(key);saveWatch();refreshTable();}));
    document.querySelectorAll('.pbe22-player[data-player]').forEach(el=>el.addEventListener('click',()=>window.PBEPlayerResearch?.show(el.dataset.player)));
  }

  function renderShell(){const vc=document.getElementById('view-container');if(!vc)return;vc.innerHTML=shell();wire();}

  function wire(){
    document.getElementById('pbe22-search')?.addEventListener('input',e=>{state.search=e.currentTarget.value||'';refreshTable();});
    document.getElementById('pbe22-market')?.addEventListener('change',e=>{state.market=e.currentTarget.value||'all';refreshTable();});
    document.getElementById('pbe22-filter')?.addEventListener('change',e=>{state.filter=e.currentTarget.value||'all';refreshTable();});
    document.getElementById('pbe22-sort')?.addEventListener('change',e=>{state.sort=e.currentTarget.value||'dispersion';refreshTable();});
    document.getElementById('pbe22-capture')?.addEventListener('click',captureBaseline);
    document.getElementById('pbe22-clear')?.addEventListener('click',clearBaseline);
    document.getElementById('pbe22-refresh')?.addEventListener('click',()=>silentRefresh(true));
    wireRows();
  }

  async function silentRefresh(force=false){
    if(state.loading||state.refreshing||!isPro())return;
    if(!document.querySelector('.pbe22-watch')||document.visibilityState!=='visible')return;
    if(!force&&state.lastRefresh&&Date.now()-state.lastRefresh<AUTO_REFRESH_MS-1000)return;
    const before=snapshotRows(state.rows);
    state.refreshing=true;state.lastRefreshError=null;
    const button=document.getElementById('pbe22-refresh');if(button)button.classList.add('spinning');
    try{
      const board=await loadBoard();
      state.board=board;state.rows=buildRows(board);state.lastRefresh=Date.now();
      refreshTable(before);
    }catch(error){state.lastRefreshError=error instanceof Error?error.message:String(error);updateSummary();}
    finally{state.refreshing=false;if(button)button.classList.remove('spinning');}
  }

  async function render(){
    if(state.loading)return;
    state.loading=true;
    const vc=document.getElementById('view-container');if(!vc){state.loading=false;return;}
    vc.innerHTML='<section class="pbe22-watch pbe22-watch-v3"><div class="pbe22-empty">Loading current NFL market terminal…</div></section>';
    try{loadLocal();state.board=await loadBoard();state.rows=buildRows(state.board);state.lastRefresh=Date.now();state.lastRefreshError=null;vc.innerHTML=shell();wire();}
    catch(error){vc.innerHTML=`<section class="pbe22-watch pbe22-watch-v3"><div class="pbe22-empty">Market Watch unavailable: ${esc(error instanceof Error?error.message:String(error))}</div></section>`;}
    finally{state.loading=false;}
  }

  function install(){
    if(!window.App?.VIEWS)return false;
    App.VIEWS.marketwatch=render;
    const prop=document.getElementById('nav-propboard');
    if(prop&&!document.getElementById('nav-marketwatch')){const a=document.createElement('a');a.className='nav-item';a.id='nav-marketwatch';a.href='javascript:void(0)';a.onclick=()=>App.nav('marketwatch');a.innerHTML='<span class="ni-icon">◌</span> Market Watch <span class="nav-badge" style="color:#d8b75b;background:rgba(216,183,91,.06)">PRO</span>';prop.insertAdjacentElement('afterend',a);}
    return true;
  }

  function startTimers(){
    if(!autoTimer)autoTimer=setInterval(()=>silentRefresh(false),AUTO_REFRESH_MS);
    if(!clockTimer)clockTimer=setInterval(()=>{if(document.querySelector('.pbe22-watch'))updateSummary();},1000);
  }

  window.PBEMarketWatch={render,state,refresh:()=>silentRefresh(true),captureBaseline,clearBaseline};
  install();startTimers();
  document.addEventListener('DOMContentLoaded',()=>{install();startTimers();},{once:true});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&document.querySelector('.pbe22-watch')&&Date.now()-state.lastRefresh>AUTO_REFRESH_MS)silentRefresh(false);});
  window.addEventListener('pbe:event-changed',()=>{state.board=null;state.rows=[];state.watch=new Set();state.baseline=null;state.lastRefresh=0;state.lastRefreshError=null;if(document.querySelector('.pbe22-watch')&&!state.loading)render();});
  window.addEventListener('pbe:pro-state',()=>{if(document.querySelector('.pbe22-watch')&&!state.loading)renderShell();});
})();