/* PropBetEdge NFL additive enhancement layer.
 * Base product: exact live v5.5.33 visual/runtime assets.
 * This file adds real market/model capability without replacing the existing product.
 */
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
    modelError: null
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

  const formatOdds = value => {
    const n = num(value);
    return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${Math.round(n)}` : '—';
  };

  const formatTime = value => {
    if (!value) return 'Update time unavailable';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  };

  const median = values => {
    const clean = values.map(num).filter(Number.isFinite).sort((a,b)=>a-b);
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
  }[market] || String(market || '').replace(/^player_/,'').replace(/_/g,' '));

  function batch(values,size) {
    const result = [];
    for (let i = 0; i < values.length; i += size) result.push(values.slice(i,i+size));
    return result;
  }

  async function fetchJson(url) {
    const response = await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});
    if (!response.ok) {
      const detail = await response.text().catch(()=> '');
      throw new Error(`${response.status}${detail ? ` · ${detail.slice(0,180)}` : ''}`);
    }
    return response.json();
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

  function bestQuote(quotes,direction) {
    const rows = quotes.filter(q => quoteDirection(q) === direction);
    if (!rows.length) return null;

    rows.sort((a,b) => {
      const ap = num(a.point), bp = num(b.point);
      if (Number.isFinite(ap) && Number.isFinite(bp) && ap !== bp) {
        return direction === 'OVER' ? ap - bp : bp - ap;
      }
      return quotePrice(b) - quotePrice(a);
    });

    return rows[0];
  }

  function mergeBoards(parts) {
    if (!parts.length) throw new Error('No market batches returned');
    const merged = {...parts[0],quotes:[],market_summary:[]};
    const qSeen = new Set();
    const sSeen = new Set();

    parts.forEach(part => {
      (Array.isArray(part.quotes) ? part.quotes : []).forEach(q => {
        const key = [quoteBook(q),q.market,q.player || q.player_name,quoteDirection(q),q.point,q.price ?? q.american_odds ?? q.odds].join('|');
        if (!qSeen.has(key)) { qSeen.add(key); merged.quotes.push(q); }
      });
      (Array.isArray(part.market_summary) ? part.market_summary : []).forEach(s => {
        const key = `${s.player || s.player_name || ''}|${s.market || ''}`;
        if (!sSeen.has(key)) { sSeen.add(key); merged.market_summary.push(s); }
      });
    });

    const playerMarkets = new Set();
    [...merged.quotes,...merged.market_summary].forEach(item => {
      const player = item.player || item.player_name || '';
      if (player && item.market) playerMarkets.add(`${player}|${item.market}`);
    });

    merged.quote_count = merged.quotes.length;
    merged.player_market_count = playerMarkets.size;
    merged.request_batch_count = parts.length;
    const updates = parts.map(p=>p.provider_last_update || p.last_update || p.updated_at).filter(Boolean).sort();
    if (updates.length) merged.provider_last_update = updates[updates.length - 1];
    return merged;
  }

  async function loadBoard(eventId) {
    const parts = await Promise.all(batch(MARKETS,BATCH_SIZE).map(markets => {
      const url = `${API}/api/odds/board?event_id=${encodeURIComponent(eventId)}&markets=${encodeURIComponent(markets.join(','))}`;
      return fetchJson(url);
    }));
    return mergeBoards(parts);
  }

  async function loadModel(eventId) {
    return fetchJson(`${API}/api/picks/pass?event_id=${encodeURIComponent(eventId)}`);
  }

  function buildRows(board,model) {
    const groups = new Map();
    const ensure = (player,market) => {
      const key = `${player}||${market}`;
      if (!groups.has(key)) groups.set(key,{player,market,summary:null,quotes:[]});
      return groups.get(key);
    };

    (board.market_summary || []).forEach(s => {
      const player = s.player || s.player_name || '';
      if (player && s.market) ensure(player,s.market).summary = s;
    });

    (board.quotes || []).forEach(q => {
      const player = q.player || q.player_name || '';
      if (player && q.market) ensure(player,q.market).quotes.push(q);
    });

    const models = new Map();
    (model?.models || []).forEach(m => { if (m.player) models.set(m.player,m); });

    return [...groups.values()].map(group => {
      let consensus = num(group.summary?.consensus_line);
      if (!Number.isFinite(consensus)) consensus = median(group.quotes.map(q=>q.point));
      const books = new Set(group.quotes.map(quoteBook).filter(Boolean));
      return {
        ...group,
        consensus,
        books: books.size,
        bestOver: bestQuote(group.quotes,'OVER'),
        bestUnder: bestQuote(group.quotes,'UNDER'),
        model: group.market === 'player_pass_yds' ? (models.get(group.player) || null) : null
      };
    }).sort((a,b) => {
      if (!!a.model !== !!b.model) return a.model ? -1 : 1;
      if (a.market !== b.market) return a.market.localeCompare(b.market);
      return a.player.localeCompare(b.player);
    });
  }

  function renderQuote(q) {
    if (!q) return '—';
    const point = num(q.point);
    return `<div class="pbe2-price">${Number.isFinite(point) ? esc(point) : '—'} <span class="pbe2-odds">${esc(formatOdds(quotePrice(q)))}</span></div><div class="pbe2-book">${esc(quoteBook(q) || 'Book')}</div>`;
  }

  function renderEdges(rows) {
    const edges = rows
      .filter(r => r.model && Number.isFinite(num(r.model.fair_line_gap_yards)))
      .sort((a,b)=>Math.abs(num(b.model.fair_line_gap_yards)) - Math.abs(num(a.model.fair_line_gap_yards)))
      .slice(0,2);

    if (!edges.length) return '';

    return `<div class="pbe2-edge-grid">${edges.map(row => {
      const m = row.model;
      const gap = num(m.fair_line_gap_yards);
      const pct = num(m.model_over_at_consensus_pct);
      return `<article class="pbe2-edge"><div class="pbe2-edge-player">${esc(row.player)}</div><div class="pbe2-edge-meta">${esc(marketLabel(row.market))} · market ${Number.isFinite(row.consensus) ? esc(row.consensus) : '—'} · fair ${Number.isFinite(num(m.fair_line)) ? esc(num(m.fair_line).toFixed(1)) : '—'}</div><div class="pbe2-edge-gap">${gap > 0 ? '+' : ''}${esc(gap.toFixed(1))}</div><div class="pbe2-edge-foot">Fair-line gap${Number.isFinite(pct) ? ` · ${esc(pct.toFixed(1))}% model over` : ''}</div></article>`;
    }).join('')}</div>`;
  }

  function renderBoard(rows,board,modelError) {
    const marketOptions = [...new Set(rows.map(r=>r.market))].sort();
    const body = rows.map(row => {
      const m = row.model;
      const fair = num(m?.fair_line);
      const pct = num(m?.model_over_at_consensus_pct);
      const gap = num(m?.fair_line_gap_yards);
      const status = m ? (m.decision_status || m.confidence || 'MODEL') : 'MARKET ONLY';
      return `<tr data-player="${esc(row.player.toLowerCase())}" data-market="${esc(row.market)}"><td><div class="pbe2-player">${esc(row.player)}</div>${m?.confidence ? `<div class="pbe2-sub">${esc(m.confidence)}</div>` : ''}</td><td><div class="pbe2-market">${esc(marketLabel(row.market))}</div><div class="pbe2-sub">${row.books} BOOK${row.books === 1 ? '' : 'S'}</div></td><td>${renderQuote(row.bestOver)}</td><td>${renderQuote(row.bestUnder)}</td><td class="pbe2-mono">${Number.isFinite(row.consensus) ? esc(row.consensus) : '—'}</td><td>${Number.isFinite(fair) ? `<span class="pbe2-fair">${esc(fair.toFixed(1))}</span>` : '—'}</td><td>${Number.isFinite(pct) ? `<span class="pbe2-prob">${esc(pct.toFixed(1))}%</span>` : '—'}</td><td>${Number.isFinite(gap) ? `<span class="${gap >= 0 ? 'pbe2-gap-pos' : 'pbe2-gap-neg'}">${gap > 0 ? '+' : ''}${esc(gap.toFixed(1))}</span>` : '—'}</td><td><span class="pbe2-status ${m ? 'model' : ''}">${esc(String(status).replace(/_/g,' '))}</span></td></tr>`;
    }).join('');

    return `<section class="pbe2-board"><div class="pbe2-toolbar"><div class="pbe2-board-title">NFL Prop Board <span>${rows.length} PLAYER / MARKET ROWS</span></div><input id="pbe2-search" class="pbe2-input" type="search" placeholder="Search player..."><select id="pbe2-market" class="pbe2-select"><option value="">All markets</option>${marketOptions.map(m=>`<option value="${esc(m)}">${esc(marketLabel(m))}</option>`).join('')}</select></div><div class="pbe2-scroll"><table class="pbe2-table"><thead><tr><th>Player</th><th>Prop</th><th>Best Over</th><th>Best Under</th><th>Market</th><th>PBE Fair</th><th>PBE Over</th><th>Model Gap</th><th>Status</th></tr></thead><tbody id="pbe2-body">${body}</tbody></table></div><div class="pbe2-board-foot"><span>MARKET: ${esc(board?.source?.semantics || 'UNAVAILABLE')} / ${esc(board?.source?.provider || 'unknown')} · Model values are not sportsbook quotes.</span><span>${modelError ? `MODEL PARTIAL · ${esc(modelError)}` : 'LIVE MARKET AND MODEL OUTPUT KEPT SEPARATE'}</span></div></section>`;
  }

  function wireFilters() {
    const search = document.getElementById('pbe2-search');
    const market = document.getElementById('pbe2-market');
    const apply = () => {
      const q = (search?.value || '').trim().toLowerCase();
      const m = market?.value || '';
      document.querySelectorAll('#pbe2-body tr').forEach(row => {
        const visible = (!q || (row.dataset.player || '').includes(q)) && (!m || row.dataset.market === m);
        row.style.display = visible ? '' : 'none';
      });
    };
    search?.addEventListener('input',apply);
    market?.addEventListener('change',apply);
  }

  const PropBoardView = {
    async render() {
      const vc = document.getElementById('view-container');
      if (!vc) return;
      vc.innerHTML = `<div class="pbe2-propboard"><div class="pbe2-state"><div><strong>Connecting to live NFL markets</strong><p>Loading sportsbook quotes and the PBE passing model from the rebuilt NFL gateway.</p><div class="pbe2-loading"></div></div></div></div>`;

      try {
        state.board = await loadBoard(state.eventId);
      } catch (error) {
        vc.innerHTML = `<div class="pbe2-propboard"><div class="pbe2-state"><div><strong>Market unavailable</strong><p>${esc(error.message)}</p><button class="pbe2-btn" onclick="App.nav('propboard')" style="margin-top:14px">Retry</button></div></div></div>`;
        return;
      }

      state.model = null;
      state.modelError = null;
      try { state.model = await loadModel(state.eventId); }
      catch (error) { state.modelError = error.message; }

      const board = state.board;
      const rows = buildRows(board,state.model);
      const event = board.event || {};
      const away = event.away_team || event.away || 'Away';
      const home = event.home_team || event.home || 'Home';
      const kickoff = event.commence_time || event.start_time || event.game_time;
      const books = new Set((board.quotes || []).map(quoteBook).filter(Boolean));
      const modelCount = (state.model?.models || []).filter(m=>m.available !== false).length;
      const semantics = board?.source?.semantics || 'UNAVAILABLE';
      const provider = board?.source?.provider || 'unknown';
      const modelVersion = state.model?.model_version || state.model?.source?.model_version || 'PBE passing model';

      vc.innerHTML = `<div class="pbe2-propboard"><header class="pbe2-head"><div><div class="pbe2-kicker">NFL Prop Intelligence</div><h1 class="pbe2-title">Find the number. <em>See the model gap.</em></h1><div class="pbe2-subtitle">The existing NFL product stays intact. This desk adds current sportsbook pricing and PBE fair-line context on top of it, with market and model provenance kept explicit.</div><div class="pbe2-pills"><span class="pbe2-pill ${semantics === 'LIVE' ? 'live' : 'warn'}">MARKET ${esc(semantics)}</span><span class="pbe2-pill model">MODEL ${esc(modelVersion)}</span><span class="pbe2-pill">NO SYNTHETIC FALLBACK</span></div></div><div class="pbe2-actions"><button class="pbe2-btn secondary" id="pbe2-change-event">Change event</button><button class="pbe2-btn" onclick="App.nav('propboard')">Refresh</button></div></header><section class="pbe2-event"><div><div class="pbe2-event-label">Current board</div><div class="pbe2-event-title">${esc(away)} @ ${esc(home)}</div><div class="pbe2-event-meta">${esc(formatTime(kickoff))}</div></div><div class="pbe2-provider"><strong>${esc(provider)}</strong><span>${esc(formatTime(board.provider_last_update || board.updated_at))}</span></div></section><div class="pbe2-kpis"><div class="pbe2-kpi"><div class="pbe2-kpi-value">${esc(board.quote_count ?? (board.quotes || []).length)}</div><div class="pbe2-kpi-label">Sportsbook quotes</div></div><div class="pbe2-kpi"><div class="pbe2-kpi-value">${esc(board.player_market_count ?? rows.length)}</div><div class="pbe2-kpi-label">Player markets</div></div><div class="pbe2-kpi"><div class="pbe2-kpi-value">${books.size}</div><div class="pbe2-kpi-label">Sportsbooks</div></div><div class="pbe2-kpi"><div class="pbe2-kpi-value">${modelCount}</div><div class="pbe2-kpi-label">Modeled props</div></div></div>${renderEdges(rows)}${renderBoard(rows,board,state.modelError)}</div>`;

      document.getElementById('pbe2-change-event')?.addEventListener('click',() => {
        const next = window.prompt('NFL event ID',state.eventId);
        if (next && next.trim()) {
          state.eventId = next.trim();
          localStorage.setItem('pbe_nfl_event',state.eventId);
          App.nav('propboard');
        }
      });
      wireFilters();
    }
  };

  function installNav() {
    if (!window.App) return;
    App.VIEWS.propboard = () => PropBoardView.render();

    const picks = document.getElementById('nav-picks');
    if (picks && !document.getElementById('nav-propboard')) {
      const a = document.createElement('a');
      a.className = 'nav-item';
      a.id = 'nav-propboard';
      a.href = 'javascript:void(0)';
      a.onclick = () => App.nav('propboard');
      a.innerHTML = '<span class="ni-icon">📈</span> Prop Board <span class="pbe2-new-badge">LIVE</span>';
      picks.insertAdjacentElement('afterend',a);
    }

    const pbecastBadge = document.querySelector('#nav-pbecast .nav-badge.live');
    if (pbecastBadge) {
      pbecastBadge.textContent = 'BETA';
      pbecastBadge.classList.remove('live');
      pbecastBadge.classList.add('pbe2-legacy');
    }
  }

  function installDashboardCard() {
    if (!window.HomeView || typeof HomeView.render !== 'function' || HomeView.__pbe2Wrapped) return;
    const original = HomeView.render.bind(HomeView);
    HomeView.render = function() {
      const result = original();
      setTimeout(() => {
        const vc = document.getElementById('view-container');
        if (!vc || vc.querySelector('.pbe2-launch-card')) return;
        const card = document.createElement('section');
        card.className = 'pbe2-launch-card';
        card.innerHTML = `<div><div class="pbe2-launch-kicker">NEW · LIVE MARKET LAYER</div><div class="pbe2-launch-title">The NFL product now has a real sportsbook Prop Board.</div><div class="pbe2-launch-copy">Keep the dashboard, Picks Engine, PropChain, team pages, season encyclopedia and history. Add live book comparison and PBE fair-line context as a new intelligence layer.</div></div><button class="pbe2-launch-btn" onclick="App.nav('propboard')">Open Prop Board</button>`;
        vc.insertBefore(card,vc.firstChild);
      },0);
      return result;
    };
    HomeView.__pbe2Wrapped = true;
  }

  function install() {
    installNav();
    installDashboardCard();
  }

  install();
  document.addEventListener('DOMContentLoaded',install,{once:true});
})();
