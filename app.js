(() => {
  'use strict';

  const API = 'https://nfl-api.propbetedge.ai';
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

  const state = {
    eventId: new URLSearchParams(location.search).get('event') || localStorage.getItem('pbe_nfl_event') || DEFAULT_EVENT,
    board: null,
    model: null,
    modelError: null,
    view: 'props'
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = v => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const num = v => Number.isFinite(Number(v)) ? Number(v) : NaN;
  const money = v => Number.isFinite(num(v)) ? `${num(v) > 0 ? '+' : ''}${Math.round(num(v))}` : '—';
  const when = v => {
    if (!v) return 'Time unavailable';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  };
  const median = values => {
    const a = values.map(num).filter(Number.isFinite).sort((x,y)=>x-y);
    if (!a.length) return NaN;
    const i = Math.floor(a.length / 2);
    return a.length % 2 ? a[i] : (a[i-1] + a[i]) / 2;
  };
  const marketLabel = m => ({
    player_pass_yds:'Passing Yards',
    player_pass_completions:'Pass Completions',
    player_pass_attempts:'Pass Attempts',
    player_pass_tds:'Passing TDs',
    player_pass_interceptions:'Interceptions',
    player_reception_yds:'Receiving Yards',
    player_receptions:'Receptions',
    player_rush_yds:'Rushing Yards',
    player_rush_attempts:'Rush Attempts',
    player_anytime_td:'Anytime TD'
  }[m] || String(m || '').replace(/^player_/,'').replace(/_/g,' '));

  async function getJSON(url) {
    const res = await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});
    if (!res.ok) {
      const body = await res.text().catch(()=> '');
      throw new Error(`${res.status}${body ? ` · ${body.slice(0,220)}` : ''}`);
    }
    return res.json();
  }

  function chunks(values,size) {
    const out = [];
    for (let i = 0; i < values.length; i += size) out.push(values.slice(i,i+size));
    return out;
  }

  async function getBoard(eventId) {
    const parts = await Promise.all(chunks(MARKETS,BATCH_SIZE).map(markets =>
      getJSON(`${API}/api/odds/board?event_id=${encodeURIComponent(eventId)}&markets=${encodeURIComponent(markets.join(','))}`)
    ));
    if (!parts.length) throw new Error('No Prop Board responses returned');

    const board = {...parts[0],quotes:[],market_summary:[]};
    const qSeen = new Set();
    const sSeen = new Set();

    for (const part of parts) {
      for (const q of Array.isArray(part.quotes) ? part.quotes : []) {
        const key = [book(q),q.market,q.player || q.player_name,direction(q),q.point,q.price ?? q.american_odds ?? q.odds].join('|');
        if (!qSeen.has(key)) { qSeen.add(key); board.quotes.push(q); }
      }
      for (const s of Array.isArray(part.market_summary) ? part.market_summary : []) {
        const key = `${s.player || s.player_name || ''}|${s.market || ''}`;
        if (!sSeen.has(key)) { sSeen.add(key); board.market_summary.push(s); }
      }
    }

    const pm = new Set();
    [...board.quotes,...board.market_summary].forEach(x => {
      const p = x.player || x.player_name || '';
      if (p && x.market) pm.add(`${p}|${x.market}`);
    });
    board.quote_count = board.quotes.length;
    board.player_market_count = pm.size;
    board.request_batch_count = parts.length;

    const updates = parts.map(p => p.provider_last_update || p.last_update || p.updated_at).filter(Boolean).sort();
    if (updates.length) board.provider_last_update = updates.at(-1);
    return board;
  }

  async function getModel(eventId) {
    return getJSON(`${API}/api/picks/pass?event_id=${encodeURIComponent(eventId)}`);
  }

  function book(q) { return q?.book || q?.book_title || q?.sportsbook || q?.book_key || ''; }
  function price(q) { return num(q?.price ?? q?.american_odds ?? q?.odds); }
  function direction(q) { return String(q?.direction || q?.outcome || q?.name || '').toUpperCase(); }

  function bestQuote(quotes,side) {
    return quotes
      .filter(q => direction(q) === side && Number.isFinite(num(q.point)))
      .sort((a,b) => {
        const ap = num(a.point), bp = num(b.point);
        if (ap !== bp) return side === 'OVER' ? ap - bp : bp - ap;
        return price(b) - price(a);
      })[0] || null;
  }

  function rowsFor(board,model) {
    const groups = new Map();
    const ensure = (player,market) => {
      const key = `${player}||${market}`;
      if (!groups.has(key)) groups.set(key,{player,market,summary:null,quotes:[]});
      return groups.get(key);
    };

    for (const s of board.market_summary || []) {
      const p = s.player || s.player_name || '';
      if (p && s.market) ensure(p,s.market).summary = s;
    }
    for (const q of board.quotes || []) {
      const p = q.player || q.player_name || '';
      if (p && q.market) ensure(p,q.market).quotes.push(q);
    }

    const models = new Map((model?.models || []).filter(m=>m.player).map(m=>[m.player,m]));
    return [...groups.values()].map(g => {
      let consensus = num(g.summary?.consensus_line);
      if (!Number.isFinite(consensus)) consensus = median(g.quotes.map(q=>q.point));
      return {
        ...g,
        consensus,
        bestOver:bestQuote(g.quotes,'OVER'),
        bestUnder:bestQuote(g.quotes,'UNDER'),
        bookCount:new Set(g.quotes.map(book).filter(Boolean)).size,
        model:g.market === 'player_pass_yds' ? models.get(g.player) || null : null
      };
    }).sort((a,b) => {
      if (!!a.model !== !!b.model) return a.model ? -1 : 1;
      return a.market.localeCompare(b.market) || a.player.localeCompare(b.player);
    });
  }

  function quoteHTML(q) {
    if (!q) return '—';
    return `<div class="price-line">${esc(q.point)}<span class="odds">${esc(money(price(q)))}</span></div><div class="book">${esc(book(q) || 'Book')}</div>`;
  }

  function modelVersion() {
    return state.model?.model_version || state.model?.source?.model_version || state.model?.models?.find(m=>m.model_version)?.model_version || 'PBE PASS MODEL';
  }

  function renderEdges(rows) {
    const edges = rows.filter(r=>r.model && Number.isFinite(num(r.model.fair_line_gap_yards)))
      .sort((a,b)=>Math.abs(num(b.model.fair_line_gap_yards))-Math.abs(num(a.model.fair_line_gap_yards))).slice(0,2);
    if (!edges.length) return '';
    return `<div class="edge-strip">${edges.map(r=>{
      const gap = num(r.model.fair_line_gap_yards);
      const prob = num(r.model.model_over_at_consensus_pct);
      return `<article class="edge-card"><div class="player">${esc(r.player)}</div><div class="edge-market">Passing Yards · market ${Number.isFinite(r.consensus)?esc(r.consensus):'—'} · fair ${esc(num(r.model.fair_line).toFixed(1))}</div><div class="edge-main"><strong>${gap>0?'+':''}${esc(gap.toFixed(1))}</strong><span>Model gap<br>${Number.isFinite(prob)?`${esc(prob.toFixed(1))}% model over`:'Probability unavailable'}</span></div></article>`;
    }).join('')}</div>`;
  }

  function renderTable(rows,board) {
    const markets = [...new Set(rows.map(r=>r.market))].sort();
    const body = rows.map(r=>{
      const m = r.model;
      const fair = num(m?.fair_line), prob = num(m?.model_over_at_consensus_pct), gap = num(m?.fair_line_gap_yards);
      const missing = Array.isArray(m?.missing_inputs) ? m.missing_inputs : [];
      const status = m ? (m.decision_status || m.confidence || 'MODEL') : 'MARKET ONLY';
      return `<tr data-player="${esc(r.player.toLowerCase())}" data-market="${esc(r.market)}"><td><div class="player-name">${esc(r.player)}</div>${m?.confidence?`<div class="sub">${esc(m.confidence)}</div>`:''}</td><td><div class="market-name">${esc(marketLabel(r.market))}</div><div class="sub">${r.bookCount} BOOK${r.bookCount===1?'':'S'}</div></td><td>${quoteHTML(r.bestOver)}</td><td>${quoteHTML(r.bestUnder)}</td><td class="mono">${Number.isFinite(r.consensus)?esc(r.consensus):'—'}</td><td>${Number.isFinite(fair)?`<span class="model-value">${esc(fair.toFixed(1))}</span>`:'—'}</td><td>${Number.isFinite(prob)?`<span class="prob">${esc(prob.toFixed(1))}%</span>`:'—'}</td><td>${Number.isFinite(gap)?`<span class="${gap>=0?'gap-pos':'gap-neg'}">${gap>0?'+':''}${esc(gap.toFixed(1))}</span>`:'—'}</td><td><span class="status-pill ${m?'model':''}">${esc(String(status).replace(/_/g,' '))}</span>${missing.length?`<div class="sub">${missing.length} INPUT${missing.length===1?'':'S'} PENDING</div>`:''}</td></tr>`;
    }).join('');

    return `<section class="board-shell"><div class="board-toolbar"><div class="board-title">NFL PROP BOARD <span>${rows.length} PLAYER / MARKET ROWS</span></div><input id="player-search" class="input" type="search" placeholder="Search player…"><select id="market-filter" class="select"><option value="">All markets</option>${markets.map(m=>`<option value="${esc(m)}">${esc(marketLabel(m))}</option>`).join('')}</select></div><div class="board-scroll"><table><thead><tr><th>Player</th><th>Prop</th><th>Best Over</th><th>Best Under</th><th>Market</th><th>PBE Fair</th><th>PBE Over</th><th>Model Gap</th><th>Status</th></tr></thead><tbody id="board-body">${body}</tbody></table></div><div class="board-footer"><span>MARKET: ${esc(board?.source?.semantics || 'UNAVAILABLE')} / ${esc(board?.source?.provider || 'unknown')} · PBE fair line is MODEL output, not a sportsbook quote.</span><span>${state.modelError?`MODEL PARTIAL · ${esc(state.modelError)}`:'MARKET AND MODEL SOURCES KEPT SEPARATE'}</span></div></section>`;
  }

  function eventTitle(board) {
    const e = board?.event || {};
    return `${e.away_team || e.away || 'Away'} @ ${e.home_team || e.home || 'Home'}`;
  }

  function kpi(value,label) { return `<div class="kpi"><div class="kpi-value">${esc(value)}</div><div class="kpi-label">${esc(label)}</div></div>`; }

  function renderProps() {
    const board = state.board;
    const rows = rowsFor(board,state.model);
    const books = new Set((board.quotes || []).map(book).filter(Boolean));
    const semantics = board?.source?.semantics || 'UNAVAILABLE';
    const provider = board?.source?.provider || 'unknown';
    const e = board?.event || {};
    const kickoff = e.commence_time || e.start_time || e.game_time;

    $('#app').innerHTML = `<section class="hero"><div><div class="eyebrow">NFL PROP INTELLIGENCE</div><h1>Find the number.<br><span>See the model gap.</span></h1><div class="hero-copy">Current sportsbook pricing and PropBetEdge fair-line context in one desk. LIVE is reserved for the provider feed. MODEL is reserved for PBE calculations. Missing inputs stay explicit.</div><div class="badges"><span class="badge ${semantics==='LIVE'?'live':'warn'}">MARKET ${esc(semantics)}</span><span class="badge model">MODEL ${esc(modelVersion())}</span>${state.modelError?'<span class="badge warn">MODEL PARTIAL</span>':''}<span class="badge">NO SYNTHETIC FALLBACK</span></div><div id="event-editor" class="event-editor hidden"><input id="event-id-input" class="input" value="${esc(state.eventId)}"><button id="event-apply" class="button primary">Load event</button></div></div><div class="hero-actions"><button id="refresh" class="button">Refresh market</button><button id="change-event" class="button">Change event</button><a class="button primary" href="https://propbetedge.ai/news/nfl">NFL News ↗</a></div></section><section class="event-bar"><div><div class="event-kicker">Current board</div><div class="event-title">${esc(eventTitle(board))}</div><div class="event-meta">${esc(when(kickoff))} · event ${esc(state.eventId.slice(0,12))}…</div></div><div class="provider"><strong>${esc(provider)}</strong><span>${board.provider_last_update?`Updated ${esc(when(board.provider_last_update))}`:'Provider update time unavailable'}<br>${esc(board.request_batch_count || 1)} request batches</span></div></section><section class="kpis">${kpi(board.quote_count ?? board.quotes?.length ?? 0,'Sportsbook quotes')}${kpi(board.player_market_count ?? rows.length,'Player markets')}${kpi(books.size,'Books')}${kpi(state.model?.models?.length || 0,'Modeled props')}</section>${renderEdges(rows)}${renderTable(rows,board)}`;

    $('#refresh').onclick = loadProps;
    $('#change-event').onclick = () => $('#event-editor').classList.toggle('hidden');
    $('#event-apply').onclick = () => {
      const next = $('#event-id-input').value.trim();
      if (!next) return;
      state.eventId = next;
      localStorage.setItem('pbe_nfl_event',next);
      const u = new URL(location.href); u.searchParams.set('event',next); history.replaceState({},'',u);
      loadProps();
    };
    const filter = () => {
      const search = ($('#player-search').value || '').trim().toLowerCase();
      const market = $('#market-filter').value || '';
      $$('#board-body tr').forEach(row => row.classList.toggle('hidden',!!((search && !row.dataset.player.includes(search)) || (market && row.dataset.market !== market))));
    };
    $('#player-search').oninput = filter;
    $('#market-filter').onchange = filter;
  }

  function renderUnavailable(title,detail) {
    $('#app').innerHTML = `<section class="state-card"><div><div class="eyebrow" style="color:var(--red)">UNAVAILABLE</div><h2>${esc(title)}</h2><p>${esc(detail)}</p><button id="retry" class="button primary" style="margin-top:18px">Retry</button></div></section>`;
    $('#retry').onclick = loadProps;
  }

  const featureCopy = {
    matchups:['Matchups','Opponent and scheme context stays closed until the rebuilt matchup service is revalidated against factual inputs.'],
    usage:['Usage','Target share and role certainty stay unavailable until the old hardcoded usage layer is replaced with factual data.'],
    simulator:['Simulator','Scenario simulation stays staged behind verified player, market, injury and game-context inputs.'],
    sgp:['SGP Lab','Correlation tooling will not manufacture legs or probabilities. It comes online after the factual prop layer is complete.'],
    market:['Market','The live Prop Board is the current market surface. Cross-event movement and historical snapshots are next.'],
    live:['Live','Verified live play-by-play is not connected to this new desk yet, so this surface is intentionally closed.'],
    injuries:['Injuries','Structured injury intelligence is being wired to verified newsroom and official-status inputs. No synthetic injury feed is shown.']
  };

  function renderFeature(view) {
    const copy = featureCopy[view] || ['NFL Intelligence','This module is not available yet.'];
    $('#app').innerHTML = `<section class="hero"><div><div class="eyebrow">NFL INTELLIGENCE MODULE</div><h1>${esc(copy[0])}</h1><div class="hero-copy">${esc(copy[1])}</div></div><div class="hero-actions"><button class="button primary" id="back-props">Back to Props</button></div></section><div class="feature-grid"><article class="feature-card"><div class="feature-state">TRUTH CONTRACT</div><h3>No fake LIVE</h3><p>Missing or unverified data remains unavailable instead of being silently filled with demo values.</p></article><article class="feature-card"><div class="feature-state">DATA PLANE</div><h3>Modular workers</h3><p>The UI stays separate from schedule, odds, model, injury and live-game services.</p></article><article class="feature-card"><div class="feature-state">LAUNCH ORDER</div><h3>Props first</h3><p>Sportsbook market quality and transparent model context take priority over decorative feature count.</p></article></div>`;
    $('#back-props').onclick = () => setView('props');
  }

  async function loadProps() {
    $('#app').innerHTML = `<section class="boot-card"><div><div class="status-dot"></div><div class="eyebrow">CONNECTING</div><h1>Loading NFL market intelligence.</h1><p>Fetching the 10 launch markets as two provider-safe batches of five, then loading the PBE passing model independently.</p></div></section>`;
    try { state.board = await getBoard(state.eventId); }
    catch (e) { renderUnavailable('Live market unavailable',`The NFL gateway rejected or could not load this event: ${e.message}`); return; }
    state.model = null; state.modelError = null;
    try { state.model = await getModel(state.eventId); }
    catch (e) { state.modelError = e.message; }
    renderProps();
  }

  function setView(view) {
    state.view = view;
    $$('.desk-tab').forEach(t=>t.classList.toggle('active',t.dataset.view===view));
    view === 'props' ? loadProps() : renderFeature(view);
  }

  $$('.desk-tab').forEach(t=>t.onclick=()=>setView(t.dataset.view));
  loadProps();
})();
