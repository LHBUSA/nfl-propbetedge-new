(() => {
  'use strict';

  const API = 'https://nfl-api.propbetedge.ai';
  const DEFAULT_EVENT_ID = '8c94552d022acec4a0458d70c19d3da9';
  const MARKET_BATCH_SIZE = 8;
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
    eventId: new URLSearchParams(location.search).get('event') || localStorage.getItem('pbe_nfl_event') || DEFAULT_EVENT_ID,
    board: null,
    model: null,
    modelError: null,
    view: 'props'
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const num = value => {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  };
  const fmtOdds = value => {
    const n = num(value);
    if (!Number.isFinite(n)) return '—';
    return `${n > 0 ? '+' : ''}${Math.round(n)}`;
  };
  const fmtTime = value => {
    if (!value) return 'Time unavailable';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const median = values => {
    const clean = values.filter(Number.isFinite).sort((a,b) => a-b);
    if (!clean.length) return NaN;
    const i = Math.floor(clean.length / 2);
    return clean.length % 2 ? clean[i] : (clean[i-1] + clean[i]) / 2;
  };

  const marketLabel = market => ({
    player_pass_yds: 'Passing Yards',
    player_pass_completions: 'Pass Completions',
    player_pass_attempts: 'Pass Attempts',
    player_pass_tds: 'Passing TDs',
    player_pass_interceptions: 'Interceptions',
    player_reception_yds: 'Receiving Yards',
    player_receptions: 'Receptions',
    player_rush_yds: 'Rushing Yards',
    player_rush_attempts: 'Rush Attempts',
    player_anytime_td: 'Anytime TD'
  }[market] || String(market || '').replace(/^player_/, '').replace(/_/g, ' '));

  function batches(values, size) {
    const out = [];
    for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
    return out;
  }

  async function jsonFetch(url) {
    const response = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`${response.status}${text ? ` · ${text.slice(0, 220)}` : ''}`);
    }
    return response.json();
  }

  async function fetchBoard(eventId) {
    const marketBatches = batches(MARKETS, MARKET_BATCH_SIZE);
    const parts = await Promise.all(marketBatches.map(markets => {
      const url = `${API}/api/odds/board?event_id=${encodeURIComponent(eventId)}&markets=${encodeURIComponent(markets.join(','))}`;
      return jsonFetch(url);
    }));
    return mergeBoards(parts);
  }

  function quoteBook(q) {
    return q?.book || q?.book_title || q?.sportsbook || q?.book_key || '';
  }

  function quotePrice(q) {
    return num(q?.price ?? q?.american_odds ?? q?.odds);
  }

  function quoteDirection(q) {
    return String(q?.direction || q?.outcome || q?.name || '').toUpperCase();
  }

  function mergeBoards(parts) {
    if (!parts.length) throw new Error('No market batches returned');
    const merged = { ...parts[0], quotes: [], market_summary: [] };
    const quoteSeen = new Set();
    const summarySeen = new Set();

    for (const part of parts) {
      for (const q of Array.isArray(part.quotes) ? part.quotes : []) {
        const key = [quoteBook(q), q.market, q.player || q.player_name, quoteDirection(q), q.point, q.price ?? q.american_odds ?? q.odds].join('|');
        if (!quoteSeen.has(key)) {
          quoteSeen.add(key);
          merged.quotes.push(q);
        }
      }
      for (const s of Array.isArray(part.market_summary) ? part.market_summary : []) {
        const key = `${s.player || s.player_name || ''}|${s.market || ''}`;
        if (!summarySeen.has(key)) {
          summarySeen.add(key);
          merged.market_summary.push(s);
        }
      }
    }

    const pm = new Set();
    [...merged.quotes, ...merged.market_summary].forEach(item => {
      const player = item.player || item.player_name || '';
      const market = item.market || '';
      if (player && market) pm.add(`${player}|${market}`);
    });

    merged.quote_count = merged.quotes.length;
    merged.player_market_count = pm.size;
    merged.request_batch_count = parts.length;
    merged.requested_markets = [...MARKETS];

    const updates = parts.map(p => p.provider_last_update || p.last_update || p.updated_at).filter(Boolean).sort();
    if (updates.length) merged.provider_last_update = updates[updates.length - 1];
    return merged;
  }

  async function fetchModel(eventId) {
    return jsonFetch(`${API}/api/picks/pass?event_id=${encodeURIComponent(eventId)}`);
  }

  function bestQuote(quotes, direction) {
    const matches = quotes
      .filter(q => quoteDirection(q) === direction)
      .filter(q => Number.isFinite(quotePrice(q)))
      .sort((a,b) => quotePrice(b) - quotePrice(a));
    return matches[0] || null;
  }

  function buildRows(board, model) {
    const groups = new Map();
    const ensure = (player, market) => {
      const key = `${player}||${market}`;
      if (!groups.has(key)) groups.set(key, { player, market, summary: null, quotes: [] });
      return groups.get(key);
    };

    for (const s of Array.isArray(board.market_summary) ? board.market_summary : []) {
      const player = s.player || s.player_name || '';
      if (player && s.market) ensure(player, s.market).summary = s;
    }
    for (const q of Array.isArray(board.quotes) ? board.quotes : []) {
      const player = q.player || q.player_name || '';
      if (player && q.market) ensure(player, q.market).quotes.push(q);
    }

    const modelsByPlayer = new Map();
    for (const m of Array.isArray(model?.models) ? model.models : []) {
      if (m.player) modelsByPlayer.set(m.player, m);
    }

    const rows = [...groups.values()].map(group => {
      const points = group.quotes.map(q => num(q.point)).filter(Number.isFinite);
      let consensus = num(group.summary?.consensus_line);
      if (!Number.isFinite(consensus)) consensus = median(points);
      const books = new Set(group.quotes.map(quoteBook).filter(Boolean));
      return {
        ...group,
        consensus,
        bestOver: bestQuote(group.quotes, 'OVER'),
        bestUnder: bestQuote(group.quotes, 'UNDER'),
        bookCount: books.size,
        model: group.market === 'player_pass_yds' ? (modelsByPlayer.get(group.player) || null) : null
      };
    });

    return rows.sort((a,b) => {
      if (!!a.model !== !!b.model) return a.model ? -1 : 1;
      if (a.market !== b.market) return a.market.localeCompare(b.market);
      return a.player.localeCompare(b.player);
    });
  }

  function renderQuote(q) {
    if (!q) return '—';
    const point = num(q.point);
    const price = quotePrice(q);
    return `<div class="price-line">${Number.isFinite(point) ? esc(point) : '—'}${Number.isFinite(price) ? `<span class="odds">${esc(fmtOdds(price))}</span>` : ''}</div><div class="book">${esc(quoteBook(q) || 'Book')}</div>`;
  }

  function topEdges(rows) {
    return rows
      .filter(r => r.model && Number.isFinite(num(r.model.fair_line_gap_yards)))
      .sort((a,b) => Math.abs(num(b.model.fair_line_gap_yards)) - Math.abs(num(a.model.fair_line_gap_yards)))
      .slice(0, 2);
  }

  function renderEdgeCards(rows) {
    const edges = topEdges(rows);
    if (!edges.length) return '';
    return `<div class="edge-strip">${edges.map(row => {
      const m = row.model;
      const gap = num(m.fair_line_gap_yards);
      const pct = num(m.model_over_at_consensus_pct);
      return `<article class="edge-card">
        <div class="player">${esc(row.player)}</div>
        <div class="edge-market">${esc(marketLabel(row.market))} · market ${Number.isFinite(row.consensus) ? esc(row.consensus) : '—'} · fair ${esc(num(m.fair_line).toFixed(1))}</div>
        <div class="edge-main"><strong>${gap > 0 ? '+' : ''}${esc(gap.toFixed(1))}</strong><span>Fair-line gap<br>${Number.isFinite(pct) ? `${esc(pct.toFixed(1))}% model over` : 'Probability unavailable'}</span></div>
      </article>`;
    }).join('')}</div>`;
  }

  function renderBoard(rows, board) {
    const markets = [...new Set(rows.map(r => r.market))].sort();
    const body = rows.map(row => {
      const m = row.model;
      const fair = num(m?.fair_line);
      const pct = num(m?.model_over_at_consensus_pct);
      const gap = num(m?.fair_line_gap_yards);
      const missing = Array.isArray(m?.missing_inputs) ? m.missing_inputs : [];
      const status = m ? (m.decision_status || m.confidence || 'MODEL') : 'MARKET ONLY';
      return `<tr data-player="${esc(row.player.toLowerCase())}" data-market="${esc(row.market)}">
        <td><div class="player-name">${esc(row.player)}</div>${m?.confidence ? `<div class="sub">${esc(m.confidence)}</div>` : ''}</td>
        <td><div class="market-name">${esc(marketLabel(row.market))}</div><div class="sub">${row.bookCount} BOOK${row.bookCount === 1 ? '' : 'S'}</div></td>
        <td>${renderQuote(row.bestOver)}</td>
        <td>${renderQuote(row.bestUnder)}</td>
        <td><span class="mono">${Number.isFinite(row.consensus) ? esc(row.consensus) : '—'}</span></td>
        <td>${Number.isFinite(fair) ? `<span class="model-value">${esc(fair.toFixed(1))}</span>` : '—'}</td>
        <td>${Number.isFinite(pct) ? `<span class="prob">${esc(pct.toFixed(1))}%</span>` : '—'}</td>
        <td>${Number.isFinite(gap) ? `<span class="${gap >= 0 ? 'gap-pos' : 'gap-neg'}">${gap > 0 ? '+' : ''}${esc(gap.toFixed(1))}</span>` : '—'}</td>
        <td><span class="status-pill ${m ? 'model' : ''}">${esc(String(status).replace(/_/g,' '))}</span>${missing.length ? `<div class="sub">${missing.length} INPUT${missing.length === 1 ? '' : 'S'} PENDING</div>` : ''}</td>
      </tr>`;
    }).join('');

    return `<section class="board-shell">
      <div class="board-toolbar">
        <div class="board-title">NFL PROP BOARD <span>${rows.length} PLAYER / MARKET ROWS</span></div>
        <input id="player-search" class="input" type="search" placeholder="Search player…">
        <select id="market-filter" class="select"><option value="">All markets</option>${markets.map(m => `<option value="${esc(m)}">${esc(marketLabel(m))}</option>`).join('')}</select>
      </div>
      <div class="board-scroll">
        <table>
          <thead><tr><th>Player</th><th>Prop</th><th>Best Over</th><th>Best Under</th><th>Market</th><th>PBE Fair</th><th>PBE Over</th><th>Model Gap</th><th>Status</th></tr></thead>
          <tbody id="board-body">${body}</tbody>
        </table>
      </div>
      <div class="board-footer">
        <span>MARKET: ${esc(board?.source?.semantics || 'UNAVAILABLE')} / ${esc(board?.source?.provider || 'unknown')} · PBE fair line is MODEL output, not a sportsbook quote.</span>
        <span>${state.modelError ? `MODEL PARTIAL · ${esc(state.modelError)}` : 'MARKET AND MODEL SOURCES KEPT SEPARATE'}</span>
      </div>
    </section>`;
  }

  function filterBoard() {
    const search = ($('#player-search')?.value || '').trim().toLowerCase();
    const market = $('#market-filter')?.value || '';
    $$('#board-body tr').forEach(row => {
      const okPlayer = !search || (row.dataset.player || '').includes(search);
      const okMarket = !market || row.dataset.market === market;
      row.classList.toggle('hidden', !(okPlayer && okMarket));
    });
  }

  function kpi(value, label) {
    return `<div class="kpi"><div class="kpi-value">${esc(value)}</div><div class="kpi-label">${esc(label)}</div></div>`;
  }

  function eventName(board) {
    const e = board?.event || {};
    const away = e.away_team || e.away || 'Away';
    const home = e.home_team || e.home || 'Home';
    return `${away} @ ${home}`;
  }

  function renderProps() {
    const board = state.board;
    const rows = buildRows(board, state.model);
    const books = new Set((board.quotes || []).map(quoteBook).filter(Boolean));
    const semantics = board?.source?.semantics || 'UNAVAILABLE';
    const provider = board?.source?.provider || 'unknown';
    const modelVersion = state.model?.model_version || state.model?.source?.model_version || 'PBE PASS MODEL';
    const e = board?.event || {};
    const kickoff = e.commence_time || e.start_time || e.game_time;

    $('#app').innerHTML = `<section class="hero">
      <div>
        <div class="eyebrow">NFL PROP INTELLIGENCE</div>
        <h1>Find the number.<br><span>See the model gap.</span></h1>
        <div class="hero-copy">Current sportsbook pricing and PropBetEdge fair-line context in one desk. LIVE is reserved for the provider feed. MODEL is reserved for PBE calculations. Missing inputs stay explicit.</div>
        <div class="badges">
          <span class="badge ${semantics === 'LIVE' ? 'live' : 'warn'}">MARKET ${esc(semantics)}</span>
          <span class="badge model">MODEL ${esc(modelVersion)}</span>
          ${state.modelError ? '<span class="badge warn">MODEL PARTIAL</span>' : ''}
          <span class="badge">NO SYNTHETIC FALLBACK</span>
        </div>
        <div id="event-editor" class="event-editor hidden">
          <input id="event-id-input" class="input" value="${esc(state.eventId)}" aria-label="Odds provider event id">
          <button id="event-apply" class="button primary">Load event</button>
        </div>
      </div>
      <div class="hero-actions">
        <button id="refresh" class="button">Refresh market</button>
        <button id="change-event" class="button">Change event</button>
        <a class="button primary" href="https://propbetedge.ai/news/nfl">NFL News ↗</a>
      </div>
    </section>

    <section class="event-bar">
      <div><div class="event-kicker">Current board</div><div class="event-title">${esc(eventName(board))}</div><div class="event-meta">${esc(fmtTime(kickoff))} · event ${esc(state.eventId.slice(0,12))}…</div></div>
      <div class="provider"><strong>${esc(provider)}</strong><span>${board.provider_last_update ? `Updated ${esc(fmtTime(board.provider_last_update))}` : 'Provider update time unavailable'}<br>${esc(board.request_batch_count || 1)} market request batch${board.request_batch_count === 1 ? '' : 'es'}</span></div>
    </section>

    <section class="kpis">
      ${kpi(board.quote_count ?? (board.quotes || []).length, 'Sportsbook quotes')}
      ${kpi(board.player_market_count ?? rows.length, 'Player markets')}
      ${kpi(books.size, 'Books')}
      ${kpi(Array.isArray(state.model?.models) ? state.model.models.length : 0, 'Modeled props')}
    </section>

    ${renderEdgeCards(rows)}
    ${renderBoard(rows, board)}`;

    $('#refresh').addEventListener('click', loadProps);
    $('#change-event').addEventListener('click', () => $('#event-editor').classList.toggle('hidden'));
    $('#event-apply').addEventListener('click', () => {
      const next = $('#event-id-input').value.trim();
      if (!next) return;
      state.eventId = next;
      localStorage.setItem('pbe_nfl_event', next);
      const url = new URL(location.href);
      url.searchParams.set('event', next);
      history.replaceState({}, '', url);
      loadProps();
    });
    $('#player-search').addEventListener('input', filterBoard);
    $('#market-filter').addEventListener('change', filterBoard);
  }

  function renderUnavailable(title, detail) {
    $('#app').innerHTML = `<section class="state-card"><div><div class="eyebrow" style="color:var(--red)">UNAVAILABLE</div><h2>${esc(title)}</h2><p>${esc(detail)}</p><button id="retry" class="button primary" style="margin-top:18px">Retry</button></div></section>`;
    $('#retry')?.addEventListener('click', loadProps);
  }

  function renderFeature(view) {
    const copy = {
      matchups: ['Matchups', 'Opponent and scheme context will only surface after the rebuilt matchup service is revalidated against factual inputs.'],
      usage: ['Usage', 'Target share and role certainty stay unavailable until the old hardcoded usage layer is replaced with factual data.'],
      simulator: ['Simulator', 'Scenario simulation is staged behind verified player, market, injury and game-context inputs.'],
      sgp: ['SGP Lab', 'Correlation tooling will not manufacture legs or probabilities. It comes online after the factual prop layer is complete.'],
      market: ['Market', 'The live Prop Board is the current market surface. Cross-event movement and historical snapshots are next.'],
      live: ['Live', 'Verified live play-by-play is not connected to this new desk yet, so this surface is intentionally closed.'],
      injuries: ['Injuries', 'Structured injury intelligence is being wired to verified newsroom and official-status inputs. No synthetic injury feed is shown.']
    }[view] || ['NFL Intelligence', 'This module is not available yet.'];

    $('#app').innerHTML = `<section class="hero"><div><div class="eyebrow">NFL INTELLIGENCE MODULE</div><h1>${esc(copy[0])}</h1><div class="hero-copy">${esc(copy[1])}</div></div><div class="hero-actions"><button class="button primary" id="back-props">Back to Props</button></div></section>
      <div class="feature-grid">
        <article class="feature-card"><div class="feature-state">TRUTH CONTRACT</div><h3>No fake LIVE</h3><p>Missing or unverified data remains unavailable instead of being silently filled with demo values.</p></article>
        <article class="feature-card"><div class="feature-state">DATA PLANE</div><h3>Modular workers</h3><p>The UI stays separate from schedule, odds, model, injury and live-game services.</p></article>
        <article class="feature-card"><div class="feature-state">LAUNCH ORDER</div><h3>Props first</h3><p>Sportsbook market quality and transparent model context take priority over decorative feature count.</p></article>
      </div>`;
    $('#back-props').addEventListener('click', () => setView('props'));
  }

  async function loadProps() {
    $('#app').innerHTML = `<section class="boot-card"><div><div class="status-dot"></div><div class="eyebrow">CONNECTING</div><h1>Loading NFL market intelligence.</h1><p>Fetching current sportsbook quotes in provider-safe market batches, then loading the PBE passing model independently.</p></div></section>`;
    try {
      state.board = await fetchBoard(state.eventId);
    } catch (error) {
      renderUnavailable('Live market unavailable', `The NFL gateway rejected or could not load this event: ${error.message}`);
      return;
    }

    state.model = null;
    state.modelError = null;
    try {
      state.model = await fetchModel(state.eventId);
    } catch (error) {
      state.modelError = error.message;
    }
    renderProps();
  }

  function setView(view) {
    state.view = view;
    $$('.desk-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
    if (view === 'props') loadProps(); else renderFeature(view);
  }

  $$('.desk-tab').forEach(tab => tab.addEventListener('click', () => setView(tab.dataset.view)));
  loadProps();
})();
