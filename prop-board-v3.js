/* PropBetEdge NFL — Prop Board v3
 * Flagship market workspace.
 * LIVE = provider semantics only. MODEL = NFL Pro server-gated PBE output only.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const DEFAULT_EVENT = '8c94552d022acec4a0458d70c19d3da9';
  const BATCH_SIZE = 5;
  const MARKETS = [
    'player_pass_yds',
    'player_pass_completions',
    'player_pass_attempts',
    'player_pass_tds',
    'player_pass_interceptions',
    'player_reception_yds',
    'player_receptions',
    'player_rush_yds',
    'player_rush_attempts',
    'player_anytime_td'
  ];

  const MARKET_META = {
    player_pass_yds: { label:'Passing Yards', family:'passing', short:'Pass Yds' },
    player_pass_completions: { label:'Pass Completions', family:'passing', short:'Completions' },
    player_pass_attempts: { label:'Pass Attempts', family:'passing', short:'Attempts' },
    player_pass_tds: { label:'Passing TDs', family:'passing', short:'Pass TDs' },
    player_pass_interceptions: { label:'Interceptions', family:'passing', short:'INTs' },
    player_reception_yds: { label:'Receiving Yards', family:'receiving', short:'Rec Yds' },
    player_receptions: { label:'Receptions', family:'receiving', short:'Receptions' },
    player_rush_yds: { label:'Rushing Yards', family:'rushing', short:'Rush Yds' },
    player_rush_attempts: { label:'Rush Attempts', family:'rushing', short:'Carries' },
    player_anytime_td: { label:'Anytime Touchdown', family:'td', short:'Anytime TD' }
  };

  const state = {
    eventId: new URLSearchParams(location.search).get('event') || localStorage.getItem('pbe_nfl_event') || DEFAULT_EVENT,
    board: null,
    model: null,
    rows: [],
    missingMarkets: [],
    failedBatches: [],
    selectedFamily: 'all',
    search: '',
    book: '',
    sort: 'default',
    drawerRow: null,
    loading: false
  };

  const esc = value => String(value ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');

  const num = value => {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  };

  const fmt = (value,digits=1) => {
    const n = num(value);
    return Number.isFinite(n) ? n.toFixed(digits).replace(/\.0$/,'') : '—';
  };

  const odds = value => {
    const n = num(value);
    return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${Math.round(n)}` : '—';
  };

  const dateTime = value => {
    if (!value) return 'Time unavailable';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  };

  const age = value => {
    if (!value) return 'freshness unavailable';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return 'freshness unavailable';
    const seconds = Math.max(0,Math.round((Date.now()-d.getTime())/1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds/60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes/60);
    return `${hours}h ago`;
  };

  const median = values => {
    const clean = values.map(num).filter(Number.isFinite).sort((a,b)=>a-b);
    if (!clean.length) return NaN;
    const i = Math.floor(clean.length/2);
    return clean.length % 2 ? clean[i] : (clean[i-1]+clean[i])/2;
  };

  const chunk = (values,size) => {
    const out = [];
    for (let i=0;i<values.length;i+=size) out.push(values.slice(i,i+size));
    return out;
  };

  const marketMeta = market => MARKET_META[market] || {
    label:String(market || '').replace(/^player_/,'').replace(/_/g,' '),
    family:'other',
    short:String(market || '').replace(/^player_/,'').replace(/_/g,' ')
  };

  const playerOf = item => item?.player || item?.player_name || item?.description || '';
  const bookOf = q => q?.book || q?.book_title || q?.sportsbook || q?.book_key || '';
  const priceOf = q => num(q?.price ?? q?.american_odds ?? q?.odds);
  const pointOf = q => num(q?.point ?? q?.line);
  const updatedOf = q => q?.last_update || q?.book_last_update || q?.updated_at || q?.provider_last_update || null;
  const sideOf = q => {
    const raw = String(q?.direction || q?.outcome || q?.side || q?.name || '').trim().toUpperCase();
    if (raw === 'OVER' || raw === 'YES') return 'OVER';
    if (raw === 'UNDER' || raw === 'NO') return 'UNDER';
    if (raw.includes('OVER')) return 'OVER';
    if (raw.includes('UNDER')) return 'UNDER';
    return raw;
  };

  function isPro() {
    return Boolean(window.PBEPro?.state?.pro);
  }

  async function fetchJson(url) {
    const response = await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});
    if (!response.ok) {
      const detail = await response.text().catch(()=> '');
      const err = new Error(`${response.status}${detail ? ` · ${detail.slice(0,180)}` : ''}`);
      err.status = response.status;
      throw err;
    }
    return response.json();
  }

  function boardUrl(eventId,markets) {
    return `${API}/api/odds/board?event_id=${encodeURIComponent(eventId)}&markets=${encodeURIComponent(markets.join(','))}`;
  }

  async function loadMarketBatch(eventId,markets,index) {
    try {
      const board = await fetchJson(boardUrl(eventId,markets));
      return { parts:[board], missing:[], failed:false, index };
    } catch (batchError) {
      const settled = await Promise.allSettled(markets.map(market => fetchJson(boardUrl(eventId,[market]))));
      const parts = [];
      const missing = [];
      settled.forEach((result,i) => {
        if (result.status === 'fulfilled') parts.push(result.value);
        else missing.push(markets[i]);
      });
      return { parts, missing, failed:true, index, error:batchError.message };
    }
  }

  function mergeBoards(parts) {
    if (!parts.length) throw new Error('No supported live player markets returned for this event.');
    const merged = {...parts[0],quotes:[],market_summary:[]};
    const qSeen = new Set();
    const sSeen = new Set();

    parts.forEach(part => {
      (Array.isArray(part?.quotes) ? part.quotes : []).forEach(q => {
        const key = [bookOf(q),q.market,playerOf(q),sideOf(q),q.point ?? q.line,q.price ?? q.american_odds ?? q.odds].join('|');
        if (!qSeen.has(key)) { qSeen.add(key); merged.quotes.push(q); }
      });
      (Array.isArray(part?.market_summary) ? part.market_summary : []).forEach(s => {
        const key = `${playerOf(s)}|${s.market || ''}`;
        if (!sSeen.has(key)) { sSeen.add(key); merged.market_summary.push(s); }
      });
    });

    const playerMarkets = new Set();
    [...merged.quotes,...merged.market_summary].forEach(item => {
      const player = playerOf(item);
      if (player && item.market) playerMarkets.add(`${player}|${item.market}`);
    });
    merged.quote_count = merged.quotes.length;
    merged.player_market_count = playerMarkets.size;

    const updates = parts
      .map(p => p.provider_last_update || p.last_update || p.updated_at)
      .filter(Boolean)
      .sort();
    if (updates.length) merged.provider_last_update = updates[updates.length-1];
    return merged;
  }

  async function loadBoard(eventId) {
    const results = await Promise.all(chunk(MARKETS,BATCH_SIZE).map((markets,index)=>loadMarketBatch(eventId,markets,index)));
    const parts = results.flatMap(result => result.parts);
    state.missingMarkets = [...new Set(results.flatMap(result => result.missing))];
    state.failedBatches = results.filter(result => result.failed).map(result => ({index:result.index,error:result.error}));
    const merged = mergeBoards(parts);
    merged.request_batch_count = results.length;
    merged.requested_markets = [...MARKETS];
    merged.missing_markets = [...state.missingMarkets];
    return merged;
  }

  async function loadModel(eventId) {
    if (!isPro()) return null;
    try {
      return await fetchJson(`${API}/api/picks/pass?event_id=${encodeURIComponent(eventId)}`);
    } catch (error) {
      if (error.status === 401 || error.status === 403) return null;
      throw error;
    }
  }

  function bestQuote(quotes,direction) {
    const rows = quotes.filter(q => sideOf(q) === direction);
    if (!rows.length) return null;
    return [...rows].sort((a,b) => {
      const ap = pointOf(a), bp = pointOf(b);
      if (Number.isFinite(ap) && Number.isFinite(bp) && ap !== bp) {
        return direction === 'OVER' ? ap - bp : bp - ap;
      }
      return priceOf(b)-priceOf(a);
    })[0];
  }

  function buildRows(board,model) {
    const groups = new Map();
    const ensure = (player,market) => {
      const key = `${player}||${market}`;
      if (!groups.has(key)) groups.set(key,{key,player,market,summary:null,quotes:[]});
      return groups.get(key);
    };

    (board?.market_summary || []).forEach(summary => {
      const player = playerOf(summary);
      if (player && summary.market) ensure(player,summary.market).summary = summary;
    });
    (board?.quotes || []).forEach(q => {
      const player = playerOf(q);
      if (player && q.market) ensure(player,q.market).quotes.push(q);
    });

    const modelRows = model?.models || model?.picks || model?.data || [];
    const models = new Map();
    (Array.isArray(modelRows) ? modelRows : []).forEach(m => {
      const player = playerOf(m);
      if (player) models.set(player.toLowerCase(),m);
    });

    return [...groups.values()].map(group => {
      const points = group.quotes.map(pointOf).filter(Number.isFinite);
      let consensus = num(group.summary?.consensus_line ?? group.summary?.line);
      if (!Number.isFinite(consensus)) consensus = median(points);
      const books = [...new Set(group.quotes.map(bookOf).filter(Boolean))].sort();
      const updates = group.quotes.map(updatedOf).filter(Boolean).sort();
      const modelRow = group.market === 'player_pass_yds' ? (models.get(group.player.toLowerCase()) || null) : null;
      return {
        ...group,
        consensus,
        minLine: points.length ? Math.min(...points) : NaN,
        maxLine: points.length ? Math.max(...points) : NaN,
        books,
        bookCount:books.length,
        updated:updates.length ? updates[updates.length-1] : null,
        bestOver:bestQuote(group.quotes,'OVER'),
        bestUnder:bestQuote(group.quotes,'UNDER'),
        model:modelRow,
        family:marketMeta(group.market).family
      };
    });
  }

  function modelGap(row) {
    return num(row.model?.fair_line_gap_yards ?? row.model?.model_gap ?? row.model?.gap);
  }

  function modelFair(row) {
    return num(row.model?.fair_line ?? row.model?.projected_line);
  }

  function modelProb(row) {
    return num(row.model?.model_over_at_consensus_pct ?? row.model?.over_probability_pct ?? row.model?.probability);
  }

  function quoteCell(q) {
    if (!q) return '<span class="pbe3-sub">No quote</span>';
    return `<div class="pbe3-side"><span class="pbe3-line">${esc(fmt(pointOf(q),1))}</span><span class="pbe3-price">${esc(odds(priceOf(q)))}</span></div><div class="pbe3-book">${esc(bookOf(q) || 'Book')}</div>`;
  }

  function rangeCell(row) {
    if (!Number.isFinite(row.minLine) || !Number.isFinite(row.maxLine)) return '<span class="pbe3-sub">Binary / no line range</span>';
    const spread = row.maxLine-row.minLine;
    const pos = spread > 0 && Number.isFinite(row.consensus) ? Math.max(0,Math.min(100,((row.consensus-row.minLine)/spread)*100)) : 50;
    return `<div class="pbe3-range"><div class="pbe3-range-label"><span>${esc(fmt(row.minLine,1))}</span><span>${esc(fmt(row.maxLine,1))}</span></div><div class="pbe3-range-track"><div class="pbe3-range-fill"></div><span class="pbe3-range-dot" style="left:${pos.toFixed(1)}%"></span></div></div>`;
  }

  function modelCell(row,type) {
    /* A free user was shown 210 identical gold "NFL Pro" buttons -- three
       columns times seventy rows -- which is an advertisement repeated inside
       the data rather than a view of what exists. The columns keep their
       headers, which now carry the PRO mark once each, and the cells show an
       obscured value. The single call to action for the surface lives above
       the table. */
    if (!isPro()) return '<span class="pbe-locked-value" aria-label="NFL Pro"></span>';
    if (!row.model) return '<span class="pbe3-sub">Not modeled</span>';
    if (type === 'fair') return `<span class="pbe3-model-fair">${esc(fmt(modelFair(row),1))}</span>`;
    if (type === 'prob') return `<span class="pbe3-model-prob">${esc(fmt(modelProb(row),1))}%</span>`;
    const gap = modelGap(row);
    if (!Number.isFinite(gap)) return '<span class="pbe3-sub">—</span>';
    return `<span class="pbe3-model-gap ${gap >= 0 ? 'pos' : 'neg'}">${gap > 0 ? '+' : ''}${esc(fmt(gap,1))}</span>`;
  }

  function rowStatus(row) {
    if (row.model && isPro()) {
      const value = row.model.decision_status || row.model.confidence || 'MODEL';
      return `<span class="pbe3-row-status model">${esc(String(value).replace(/_/g,' '))}</span>`;
    }
    return `<span class="pbe3-row-status">MARKET ONLY</span>`;
  }

  function sortRows(rows) {
    const copy = [...rows];
    if (state.sort === 'player') return copy.sort((a,b)=>a.player.localeCompare(b.player));
    if (state.sort === 'consensus') return copy.sort((a,b)=>(num(b.consensus)||0)-(num(a.consensus)||0));
    if (state.sort === 'books') return copy.sort((a,b)=>b.bookCount-a.bookCount || a.player.localeCompare(b.player));
    if (state.sort === 'gap' && isPro()) return copy.sort((a,b)=>Math.abs(modelGap(b)||0)-Math.abs(modelGap(a)||0));
    return copy.sort((a,b) => {
      if (Boolean(a.model) !== Boolean(b.model)) return a.model ? -1 : 1;
      if (a.family !== b.family) return a.family.localeCompare(b.family);
      if (a.market !== b.market) return a.market.localeCompare(b.market);
      return a.player.localeCompare(b.player);
    });
  }

  function visibleRows() {
    const q = state.search.trim().toLowerCase();
    const filtered = state.rows.filter(row => {
      const familyOk = state.selectedFamily === 'all' || row.family === state.selectedFamily;
      const searchOk = !q || row.player.toLowerCase().includes(q) || marketMeta(row.market).label.toLowerCase().includes(q);
      const bookOk = !state.book || row.books.includes(state.book);
      return familyOk && searchOk && bookOk;
    });
    return sortRows(filtered);
  }

  function signalCards() {
    if (!isPro()) {
      return `<div class="pbe3-pro-locked"><div><strong>Pro Signal Board</strong><p>Unlock the largest current model gaps, PBE fair lines and model probabilities without hiding the sportsbook market beneath them.</p><button class="pbe3-button gold" type="button" onclick="PBEPro.open('upgrade')">Unlock NFL Pro · $9.99/week</button></div></div>`;
    }
    const modeled = state.rows
      .filter(row => row.model && Number.isFinite(modelGap(row)))
      .sort((a,b)=>Math.abs(modelGap(b))-Math.abs(modelGap(a)))
      .slice(0,3);
    if (!modeled.length) return `<div class="pbe3-pro-locked"><div><strong>No modeled signal available</strong><p>The current PBE model only appears where its required factual inputs and supported market are available. Missing model output is not replaced with synthetic picks.</p></div></div>`;
    return `<div class="pbe3-signal-grid">${modeled.map(row => {
      const gap = modelGap(row);
      return `<article class="pbe3-signal-card" data-row-key="${esc(row.key)}"><div class="pbe3-signal-player">${esc(row.player)}</div><div class="pbe3-signal-market">${esc(marketMeta(row.market).label)} · market ${esc(fmt(row.consensus,1))} · fair ${esc(fmt(modelFair(row),1))}</div><div class="pbe3-signal-gap">${gap > 0 ? '+' : ''}${esc(fmt(gap,1))}</div><div class="pbe3-signal-foot">Fair-line gap${Number.isFinite(modelProb(row)) ? ` · ${esc(fmt(modelProb(row),1))}% model over` : ''}</div></article>`;
    }).join('')}</div>`;
  }

  function healthRows(board) {
    const semantics = board?.source?.semantics || 'UNAVAILABLE';
    const provider = board?.source?.provider || 'unknown';
    const partial = state.missingMarkets.length > 0;
    return `<div class="pbe3-health-body">
      <div class="pbe3-health-row"><span>Market semantics</span><strong class="${semantics === 'LIVE' ? 'live' : ''}">${esc(semantics)}</strong></div>
      <div class="pbe3-health-row"><span>Provider</span><strong>${esc(provider)}</strong></div>
      <div class="pbe3-health-row"><span>Provider freshness</span><strong>${esc(age(board?.provider_last_update || board?.updated_at))}</strong></div>
      <div class="pbe3-health-row"><span>Requested markets</span><strong>${MARKETS.length}</strong></div>
      <div class="pbe3-health-row"><span>Unavailable markets</span><strong class="${partial ? 'partial' : 'live'}">${partial ? state.missingMarkets.length : 0}</strong></div>
    </div>`;
  }

  function tableRowsHtml(rows) {
    if (!rows.length) return `<tr><td colspan="11" style="height:190px;text-align:center;color:#677382">No rows match the current filters.</td></tr>`;
    return rows.map(row => `<tr data-row-key="${esc(row.key)}">
      <td><div class="pbe3-player-name">${esc(row.player)}</div><div class="pbe3-sub">${esc(marketMeta(row.market).family)} · ${row.bookCount} book${row.bookCount===1?'':'s'}</div></td>
      <td><div class="pbe3-market-name">${esc(marketMeta(row.market).label)}</div><div class="pbe3-sub">Updated ${esc(age(row.updated))}</div></td>
      <td>${quoteCell(row.bestOver)}</td>
      <td>${quoteCell(row.bestUnder)}</td>
      <td><span class="pbe3-consensus">${esc(fmt(row.consensus,1))}</span></td>
      <td>${rangeCell(row)}</td>
      <td>${modelCell(row,'fair')}</td>
      <td>${modelCell(row,'prob')}</td>
      <td>${modelCell(row,'gap')}</td>
      <td><span class="pbe3-sub">${row.bookCount} BOOK${row.bookCount===1?'':'S'}</span></td>
      <td>${rowStatus(row)}</td>
    </tr>`).join('');
  }

  function tabsHtml() {
    const tabs = [
      ['all','All Props'],
      ['passing','Passing'],
      ['receiving','Receiving'],
      ['rushing','Rushing'],
      ['td','Touchdowns']
    ];
    return tabs.map(([id,label])=>`<button class="pbe3-tab ${state.selectedFamily===id?'active':''}" type="button" data-family="${id}">${label}</button>`).join('');
  }

  function deskHtml() {
    const rows = visibleRows();
    const books = [...new Set(state.rows.flatMap(row=>row.books))].sort();
    return `<section class="pbe3-desk">
      <div class="pbe3-tabsbar">
        <div class="pbe3-tabs" id="pbe3-tabs">${tabsHtml()}</div>
        <div class="pbe3-tools">
          <input id="pbe3-search" class="pbe3-input" type="search" placeholder="Search player or prop…" value="${esc(state.search)}">
          <select id="pbe3-book" class="pbe3-select"><option value="">All sportsbooks</option>${books.map(book=>`<option value="${esc(book)}" ${state.book===book?'selected':''}>${esc(book)}</option>`).join('')}</select>
          <select id="pbe3-sort" class="pbe3-select">
            <option value="default" ${state.sort==='default'?'selected':''}>Desk priority</option>
            <option value="player" ${state.sort==='player'?'selected':''}>Player A–Z</option>
            <option value="books" ${state.sort==='books'?'selected':''}>Most books</option>
            <option value="consensus" ${state.sort==='consensus'?'selected':''}>Highest line</option>
            ${isPro()?`<option value="gap" ${state.sort==='gap'?'selected':''}>Largest model gap</option>`:''}
          </select>
        </div>
      </div>
      <div class="pbe3-table-scroll">
        <table class="pbe3-table">
          <thead><tr><th>Player</th><th>Prop</th><th>Best Over</th><th>Best Under</th><th>Consensus</th><th>Book Range</th><th class="pbe3-th-locked">PBE Fair</th><th class="pbe3-th-locked">PBE Over</th><th class="pbe3-th-locked">Model Gap</th><th>Depth</th><th>Status</th></tr></thead>
          <tbody id="pbe3-table-body">${tableRowsHtml(rows)}</tbody>
        </table>
      </div>
      <footer class="pbe3-foot"><span>Market values are provider quotes. PBE fair line / probability / gap are separate MODEL outputs and never sportsbook prices.</span><span>${state.missingMarkets.length ? `PARTIAL MARKET · ${state.missingMarkets.map(m=>marketMeta(m).short).join(', ')} unavailable` : 'ALL SUPPORTED REQUESTED MARKETS RETURNED'}</span></footer>
    </section>`;
  }

  function shellHtml(board) {
    const event = board?.event || {};
    const away = event.away_team || event.away || 'Away';
    const home = event.home_team || event.home || 'Home';
    const kickoff = event.commence_time || event.start_time || event.game_time;
    const semantics = board?.source?.semantics || 'UNAVAILABLE';
    const provider = board?.source?.provider || 'unknown';
    const books = new Set((board?.quotes || []).map(bookOf).filter(Boolean));
    const modeled = state.rows.filter(row=>row.model).length;
    const partial = state.missingMarkets.length>0;
    const currentCount = state.rows.length;

    return `<section class="pbe3-propboard">
      <header class="pbe3-top">
        <div><div class="pbe3-kicker">NFL PROP INTELLIGENCE · MARKET DESK</div><h1 class="pbe3-title">Find the number.<br><em>Interrogate the market.</em></h1><div class="pbe3-copy">Live sportsbook pricing stays visible. The premium PBE layer adds independently modeled fair line, probability and model gap only when the model actually supports the prop.</div></div>
        <div class="pbe3-top-actions"><button class="pbe3-button" id="pbe3-change-event" type="button">Change event</button>${isPro()?'<span class="pbe-pro-active-badge">◆ NFL PRO ACTIVE</span>':'<button class="pbe3-button gold" type="button" onclick="PBEPro.open(\'upgrade\')">Unlock NFL Pro</button>'}<button class="pbe3-button primary" type="button" onclick="App.nav('propboard')">Refresh desk</button></div>
      </header>

      <section class="pbe3-event-bar">
        <div class="pbe3-event-main"><div class="pbe3-event-shield">NFL</div><div><div class="pbe3-event-label">Current market event</div><div class="pbe3-event-title">${esc(away)} @ ${esc(home)}</div><div class="pbe3-event-meta">${esc(dateTime(kickoff))} · Event ${esc(state.eventId.slice(0,12))}…</div></div></div>
        <div class="pbe3-feed-state ${partial?'partial':semantics==='LIVE'?'live':''}">${partial?'LIVE · PARTIAL MARKET':`MARKET ${esc(semantics)}`} · ${esc(provider)} · ${esc(age(board?.provider_last_update || board?.updated_at))}</div>
      </section>

      <div class="pbe3-kpis">
        <div class="pbe3-kpi"><div class="pbe3-kpi-value">${esc(board?.quote_count ?? board?.quotes?.length ?? 0)}</div><div class="pbe3-kpi-label">Sportsbook quotes</div></div>
        <div class="pbe3-kpi"><div class="pbe3-kpi-value">${currentCount}</div><div class="pbe3-kpi-label">Player / market rows</div></div>
        <div class="pbe3-kpi"><div class="pbe3-kpi-value">${books.size}</div><div class="pbe3-kpi-label">Sportsbooks represented</div></div>
        <div class="pbe3-kpi"><div class="pbe3-kpi-value ${isPro()?'green':'gold'}">${isPro()?modeled:'PRO'}</div><div class="pbe3-kpi-label">Modeled props unlocked</div></div>
        <div class="pbe3-kpi"><div class="pbe3-kpi-value ${partial?'gold':'green'}">${partial?state.missingMarkets.length:'0'}</div><div class="pbe3-kpi-label">Unavailable requested markets</div></div>
      </div>

      <div class="pbe3-signals">
        <section class="pbe3-panel"><div class="pbe3-panel-head"><strong>PBE Signal Board</strong><span>${isPro()?'Model gaps ranked by magnitude':'NFL Pro premium intelligence'}</span></div>${signalCards()}</section>
        <section class="pbe3-panel"><div class="pbe3-panel-head"><strong>Feed Health</strong><span>Truth + freshness</span></div>${healthRows(board)}</section>
      </div>

      ${deskHtml()}
    </section>`;
  }

  function loadingHtml() {
    return `<section class="pbe3-propboard"><div class="pbe3-empty"><div><strong>Building the live market desk</strong><p>Requesting player markets in provider-safe batches, recovering valid markets individually if a batch fails, and checking NFL Pro model access.</p><div class="pbe3-loader"></div></div></div></section>`;
  }

  function errorHtml(error) {
    return `<section class="pbe3-propboard"><div class="pbe3-empty"><div><strong>Market desk unavailable</strong><p>${esc(error?.message || 'The live provider did not return a usable Prop Board for this event.')}</p><div style="display:flex;gap:7px;justify-content:center;margin-top:14px;flex-wrap:wrap"><button class="pbe3-button primary" type="button" onclick="App.nav('propboard')">Retry</button><button class="pbe3-button" type="button" onclick="window.PBEPropBoardV3.changeEvent()">Change event</button></div></div></div></section>`;
  }

  async function render() {
    if (state.loading) return;
    state.loading = true;
    const vc = document.getElementById('view-container');
    if (!vc) { state.loading=false; return; }
    vc.innerHTML = loadingHtml();

    try {
      const board = await loadBoard(state.eventId);
      let model = null;
      if (isPro()) model = await loadModel(state.eventId).catch(()=>null);
      state.board = board;
      state.model = model;
      state.rows = buildRows(board,model);
      vc.innerHTML = shellHtml(board);
      wire();
    } catch (error) {
      vc.innerHTML = errorHtml(error);
    } finally {
      state.loading = false;
    }
  }

  function rerenderDesk() {
    const desk = document.querySelector('.pbe3-desk');
    if (!desk) return;
    desk.outerHTML = deskHtml();
    wireDesk();
  }

  function wireDesk() {
    document.querySelectorAll('.pbe3-tab').forEach(tab => tab.addEventListener('click',() => {
      state.selectedFamily = tab.dataset.family || 'all';
      rerenderDesk();
    }));
    document.getElementById('pbe3-search')?.addEventListener('input',event => {
      state.search = event.currentTarget.value || '';
      const body = document.getElementById('pbe3-table-body');
      if (body) body.innerHTML = tableRowsHtml(visibleRows());
      wireRows();
    });
    document.getElementById('pbe3-book')?.addEventListener('change',event => { state.book=event.currentTarget.value || ''; rerenderDesk(); });
    document.getElementById('pbe3-sort')?.addEventListener('change',event => { state.sort=event.currentTarget.value || 'default'; rerenderDesk(); });
    wireRows();
  }

  function wireRows() {
    document.querySelectorAll('.pbe3-table tbody tr[data-row-key],.pbe3-signal-card[data-row-key]').forEach(el => {
      el.addEventListener('click',() => openDrawer(el.dataset.rowKey));
    });
  }

  function wire() {
    document.getElementById('pbe3-change-event')?.addEventListener('click',changeEvent);
    wireDesk();
    document.querySelectorAll('.pbe3-signal-card[data-row-key]').forEach(el => el.addEventListener('click',()=>openDrawer(el.dataset.rowKey)));
  }

  function changeEvent() {
    const next = window.prompt('Enter the live sportsbook event ID',state.eventId);
    if (!next || !next.trim() || next.trim()===state.eventId) return;
    state.eventId = next.trim();
    localStorage.setItem('pbe_nfl_event',state.eventId);
    state.selectedFamily='all'; state.search=''; state.book=''; state.sort='default';
    try {
      const url = new URL(location.href);
      url.searchParams.set('event',state.eventId);
      history.replaceState({},'',url.pathname+url.search+url.hash);
    } catch (_) {}
    render();
  }

  function quoteRows(row) {
    const quotes = [...row.quotes].sort((a,b) => {
      const book = bookOf(a).localeCompare(bookOf(b));
      if (book) return book;
      return sideOf(a).localeCompare(sideOf(b));
    });
    if (!quotes.length) return '<div class="pbe3-pro-locked"><div><strong>No raw quotes</strong><p>The provider returned a market summary without individual book quotes for this row.</p></div></div>';
    return quotes.map(q => `<div class="pbe3-quote-row"><div><div class="pbe3-quote-book">${esc(bookOf(q)||'Sportsbook')}</div><div class="pbe3-quote-time">${esc(updatedOf(q)?`Updated ${age(updatedOf(q))}`:'Quote freshness unavailable')}</div></div><div class="pbe3-quote-side"><strong>${esc(sideOf(q)||'—')}</strong><span>${esc(fmt(pointOf(q),1))}</span></div><div class="pbe3-quote-side"><strong>${esc(odds(priceOf(q)))}</strong><span>American</span></div></div>`).join('');
  }

  function drawerModel(row) {
    if (!isPro()) return `<div class="pbe3-pro-locked"><div><strong>NFL Pro model layer</strong><p>Unlock PBE fair line, model probability and fair-line gap for supported props. Sportsbook quotes above stay visible.</p><button class="pbe3-button gold" type="button" onclick="PBEPro.open('upgrade')">Unlock NFL Pro</button></div></div>`;
    if (!row.model) return `<div class="pbe3-pro-locked"><div><strong>Model unavailable for this prop</strong><p>The current production model does not support this market or does not have the required inputs. No synthetic model output is substituted.</p></div></div>`;
    const missing = Array.isArray(row.model.missing_inputs) ? row.model.missing_inputs : [];
    return `<div class="pbe3-model-card"><div class="pbe3-model-grid"><div class="pbe3-model-stat"><b class="blue">${esc(fmt(modelFair(row),1))}</b><span>PBE fair line</span></div><div class="pbe3-model-stat"><b class="green">${esc(fmt(modelProb(row),1))}%</b><span>Model over @ consensus</span></div><div class="pbe3-model-stat"><b class="${modelGap(row)>=0?'green':''}">${modelGap(row)>0?'+':''}${esc(fmt(modelGap(row),1))}</b><span>Fair-line gap</span></div><div class="pbe3-model-stat"><b>${esc(fmt(row.model.predictive_sd,1))}</b><span>Predictive SD</span></div><div class="pbe3-model-stat"><b>${esc(fmt(row.model.projected_attempts,1))}</b><span>Projected attempts</span></div><div class="pbe3-model-stat"><b>${esc(row.model.effective_games ?? row.model.raw_games ?? '—')}</b><span>Effective sample</span></div></div><div class="pbe3-model-note">Status: ${esc(String(row.model.decision_status || row.model.confidence || 'MODEL').replace(/_/g,' '))}.${missing.length?` Missing inputs: ${esc(missing.join(', '))}.`:''} Model output is contextual analysis, not a guarantee or sportsbook quote.</div></div>`;
  }

  function openDrawer(key) {
    const row = state.rows.find(item=>item.key===key);
    if (!row) return;
    state.drawerRow=row;
    let backdrop=document.getElementById('pbe3-drawer-backdrop');
    if (!backdrop) {
      backdrop=document.createElement('div');
      backdrop.id='pbe3-drawer-backdrop';
      backdrop.className='pbe3-drawer-backdrop';
      backdrop.addEventListener('click',event=>{ if(event.target===backdrop) closeDrawer(); });
      document.body.appendChild(backdrop);
    }
    backdrop.innerHTML=`<aside class="pbe3-drawer"><header class="pbe3-drawer-head"><button class="pbe3-drawer-close" type="button" onclick="PBEPropBoardV3.closeDrawer()">×</button><div class="pbe3-drawer-kicker">PLAYER MARKET DETAIL</div><div class="pbe3-drawer-title">${esc(row.player)}</div><div class="pbe3-drawer-meta">${esc(marketMeta(row.market).label)} · consensus ${esc(fmt(row.consensus,1))} · ${row.bookCount} books · updated ${esc(age(row.updated))}</div></header><div class="pbe3-drawer-body"><section class="pbe3-drawer-section"><div class="pbe3-drawer-section-head"><strong>Sportsbook Matrix</strong><span>${row.quotes.length} quotes</span></div>${quoteRows(row)}</section><section class="pbe3-drawer-section"><div class="pbe3-drawer-section-head"><strong>PBE Model Context</strong><span>${isPro()?'NFL PRO':'LOCKED'}</span></div>${drawerModel(row)}</section></div></aside>`;
    backdrop.classList.add('open');
    document.body.style.overflow='hidden';
  }

  function closeDrawer() {
    document.getElementById('pbe3-drawer-backdrop')?.classList.remove('open');
    document.body.style.overflow='';
    state.drawerRow=null;
  }

  function install() {
    if (!window.App?.VIEWS) return false;
    App.VIEWS.propboard = render;
    const nav = document.getElementById('nav-propboard');
    if (nav) nav.innerHTML='<span class="ni-icon">↗</span> Prop Board <span class="nav-badge" style="color:#55d68c;background:rgba(85,214,140,.08)">LIVE</span>';
    return true;
  }

  window.PBEPropBoardV3 = { render,changeEvent,openDrawer,closeDrawer,state };

  install();
  document.addEventListener('DOMContentLoaded',install,{once:true});
  document.addEventListener('keydown',event=>{ if(event.key==='Escape') closeDrawer(); });
  window.addEventListener('pbe:pro-state',event => {
    if (!document.querySelector('.pbe3-propboard')) return;
    const becamePro = Boolean(event.detail?.pro);
    const hasModel = Boolean(state.model);
    if (becamePro && !hasModel && !state.loading) render();
    else if (!becamePro && hasModel && !state.loading) { state.model=null; state.rows=buildRows(state.board,null); render(); }
  });
})();
