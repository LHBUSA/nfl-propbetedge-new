/* PropBetEdge NFL — Intelligence OS UI v2
 * Visual/runtime shell upgrade over the retained product modules.
 * Truth rules: LIVE only from current provider response; MODEL only from PBE model response.
 */
(() => {
  'use strict';

  const API = 'https://nfl-api.propbetedge.ai';
  const DEFAULT_EVENT = '8c94552d022acec4a0458d70c19d3da9';

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

  const formatTime = value => {
    if (!value) return 'update unavailable';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  };

  async function fetchJson(url) {
    const response = await fetch(url,{cache:'no-store',headers:{Accept:'application/json'}});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function currentEventId() {
    return localStorage.getItem('pbe_nfl_event') || DEFAULT_EVENT;
  }

  function networkHtml() {
    return `<header class="pbe-v2-network" id="pbe-v2-network">
      <div class="pbe-v2-network-inner">
        <nav class="pbe-v2-network-links left" aria-label="PropBetEdge network">
          <a href="https://propbetedge.ai">Home</a>
          <a href="https://propbetedge.ai/news">News</a>
          <a href="https://mlb.propbetedge.ai">MLB</a>
        </nav>
        <a class="pbe-v2-brand" href="javascript:void(0)" onclick="App.nav('home')" aria-label="PropBetEdge NFL home">
          <svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden="true">
            <path d="M17 2L30.856 9.75V25.25L17 33L3.144 25.25V9.75L17 2Z" stroke="#55d68c" stroke-width="1.4" opacity=".5"/>
            <path d="M17 7L26.392 12.25V22.75L17 28L7.608 22.75V12.25L17 7Z" fill="#55d68c" opacity=".09"/>
            <circle cx="17" cy="17" r="4" fill="#55d68c"/>
            <circle cx="17" cy="17" r="7" stroke="#55d68c" opacity=".3"/>
          </svg>
          <span class="pbe-v2-brand-copy">
            <span class="pbe-v2-brand-name">PropBet<em>Edge</em> NFL</span>
            <span class="pbe-v2-brand-sub">Football Intelligence Operating System</span>
          </span>
        </a>
        <nav class="pbe-v2-network-links right" aria-label="Sports network">
          <a class="active" href="javascript:void(0)" onclick="App.nav('home')">NFL</a>
          <a href="https://propbetedge.ai/news/nba">NBA</a>
          <a href="https://propbetedge.ai/news/nhl">NHL</a>
          <a href="https://propbetedge.ai/news/nfl">NFL News</a>
        </nav>
      </div>
    </header>`;
  }

  function commandBarHtml() {
    return `<div class="pbe-v2-commandbar" id="pbe-v2-commandbar">
      <div class="pbe-v2-crumbs">
        <span class="pbe-v2-sport-tag">NFL INTELLIGENCE</span>
        <span class="pbe-v2-command-sep"></span>
        <span class="pbe-v2-view-name" id="pbe-v2-view-name">Dashboard</span>
        <span class="pbe-v2-view-meta" id="pbe-v2-view-meta">Football intelligence workspace</span>
      </div>
      <nav class="pbe-v2-quicknav" aria-label="NFL quick navigation">
        <button onclick="App.nav('home')">Overview</button>
        <button class="primary" onclick="App.nav('propboard')">Prop Board</button>
        <button onclick="App.nav('teams')">Teams</button>
        <button onclick="App.nav('seasonhistory')">Archive</button>
        <a href="https://propbetedge.ai/news/nfl">News ↗</a>
      </nav>
    </div>`;
  }

  const viewMeta = {
    home: ['Dashboard','Market pulse · tools · research'],
    propboard: ['Prop Board','Live sportsbook prices + PBE model context'],
    picks: ['Model Lab','PBE model workspace'],
    propchain: ['PropChain','Prop intelligence workflow'],
    pbecast: ['PBEcast','Live-game workspace'],
    injuries: ['Injury Intelligence','Verified player-status workflow'],
    trades: ['Transactions','News and roster movement'],
    teams: ['Teams','32 NFL team profiles'],
    stats: ['Stats Leaders','Season statistical research'],
    standings: ['Standings','Season standings archive'],
    seasonhistory: ['Season Archive','NFL season encyclopedia'],
    'season-history': ['Season Archive','NFL season encyclopedia'],
    hof: ['Hall of Fame','Historical player research'],
    records: ['Records','NFL records and milestones'],
    prospects: ['Draft Research','2026 prospect workspace'],
    sb: ['Super Bowl History','Championship archive']
  };

  function updateCommandBar(view) {
    const meta = viewMeta[view] || [String(view || 'NFL').replace(/-/g,' '),'NFL intelligence workspace'];
    const name = document.getElementById('pbe-v2-view-name');
    const detail = document.getElementById('pbe-v2-view-meta');
    if (name) name.textContent = meta[0];
    if (detail) detail.textContent = meta[1];
  }

  function statusSkeleton() {
    return `<div class="pbe-v2-status-strip">
      <span class="pbe-v2-status-live">Connecting market feed</span>
      <span class="pbe-v2-status-sep"></span>
      <span>NFL Intelligence OS</span>
      <span class="pbe-v2-status-sep"></span>
      <a href="https://propbetedge.ai/news/nfl">Latest NFL news ↗</a>
    </div>`;
  }

  async function refreshStatus(el) {
    if (!el) return;
    try {
      const eventId = currentEventId();
      const board = await fetchJson(`${API}/api/odds/board?event_id=${encodeURIComponent(eventId)}&markets=player_pass_yds`);
      const event = board.event || {};
      const semantics = board?.source?.semantics || 'UNAVAILABLE';
      const provider = board?.source?.provider || 'unknown';
      const away = event.away_team || event.away || 'Away';
      const home = event.home_team || event.home || 'Home';
      const updated = board.provider_last_update || board.updated_at;
      el.innerHTML = `<div class="pbe-v2-status-strip">
        <span class="${semantics === 'LIVE' ? 'pbe-v2-status-live' : ''}">MARKET ${esc(semantics)}</span>
        <span>${esc(provider)}</span>
        <span class="pbe-v2-status-sep"></span>
        <span>${esc(away)} @ ${esc(home)}</span>
        <span>${esc(board.quote_count ?? (board.quotes || []).length)} passing-yard quotes</span>
        <span class="pbe-v2-status-sep"></span>
        <span>Updated ${esc(formatTime(updated))}</span>
        <span class="pbe-v2-status-sep"></span>
        <a href="javascript:void(0)" onclick="App.nav('propboard')">Open Prop Board</a>
        <a href="https://propbetedge.ai/news/nfl">NFL News ↗</a>
      </div>`;
    } catch (_) {
      el.innerHTML = `<div class="pbe-v2-status-strip">
        <span>MARKET UNAVAILABLE</span>
        <span class="pbe-v2-status-sep"></span>
        <span>NFL Intelligence OS remains available</span>
        <span class="pbe-v2-status-sep"></span>
        <a href="javascript:void(0)" onclick="App.nav('propboard')">Retry Prop Board</a>
        <a href="https://propbetedge.ai/news/nfl">NFL News ↗</a>
      </div>`;
    }
  }

  function renderFeatureState(title,copy,actionLabel,action) {
    const vc = document.getElementById('view-container');
    if (!vc) return;
    vc.innerHTML = `<section class="pbe-v2-dashboard">
      <div class="pbe-v2-hero" style="min-height:360px;grid-template-columns:1fr">
        <div class="pbe-v2-hero-copy">
          <div class="pbe-v2-eyebrow">NFL INTELLIGENCE · VERIFIED MODE</div>
          <h1>${esc(title)}.<br><em>Built truth-first.</em></h1>
          <p>${esc(copy)}</p>
          <div class="pbe-v2-hero-actions">
            <button class="pbe-v2-action primary" onclick="${action}">${esc(actionLabel)}</button>
            <button class="pbe-v2-action" onclick="App.nav('home')">Back to Dashboard</button>
          </div>
        </div>
      </div>
    </section>`;
  }

  function moduleCards() {
    const modules = [
      ['📈','Prop Board','LIVE MARKET','Compare current book numbers with PBE fair-line context.','propboard'],
      ['🧠','Model Lab','MODEL','Passing model workspace now; broader prop models as they clear validation.','picks'],
      ['🏈','Teams','32 CLUBS','Team profiles, rosters and franchise research.','teams'],
      ['📊','Stats Leaders','ARCHIVE','Season leaders and player statistical research.','stats'],
      ['🏆','Standings','ARCHIVE','Season standings and conference context.','standings'],
      ['📚','Season Archive','106 SEASONS','Season-by-season encyclopedia and historical context.','seasonhistory'],
      ['📈','Records','ALL TIME','League records, milestones and historical leaders.','records'],
      ['🏅','Hall of Fame','HISTORY','Hall of Fame player research and classes.','hof']
    ];
    return modules.map(m => `<article class="pbe-v2-module" onclick="App.nav('${m[4]}')">
      <span class="pbe-v2-module-tag">${esc(m[2])}</span>
      <div class="pbe-v2-module-icon">${m[0]}</div>
      <h3>${esc(m[1])}</h3>
      <p>${esc(m[3])}</p>
    </article>`).join('');
  }

  function teamWall() {
    if (!window.NFL_TEAMS) return '<div class="pbe-v2-market-empty">Team directory loading.</div>';
    return Object.keys(NFL_TEAMS).map(abbr => {
      let crest = `<strong style="font:900 12px 'Barlow Condensed',sans-serif">${esc(abbr)}</strong>`;
      try { if (typeof teamCrest === 'function') crest = teamCrest(abbr,28); } catch (_) {}
      return `<button class="pbe-v2-team-chip" title="${esc(NFL_TEAMS[abbr]?.name || abbr)}" onclick="if(window.TeamModal){TeamModal.show('${esc(abbr)}')}else{App.nav('teams')}">${crest}</button>`;
    }).join('');
  }

  function dashboardShell() {
    return `<section class="pbe-v2-dashboard">
      <div class="pbe-v2-hero">
        <div class="pbe-v2-hero-copy">
          <div class="pbe-v2-eyebrow">PROPBETEDGE NFL · INTELLIGENCE OS</div>
          <h1>Football intelligence.<br><em>Built for decisions.</em></h1>
          <p>One NFL workspace for current sportsbook pricing, PBE model context, team research and the historical database already inside PropBetEdge. Market data and model output stay clearly separated.</p>
          <div class="pbe-v2-hero-actions">
            <button class="pbe-v2-action primary" onclick="App.nav('propboard')">Open Live Prop Board</button>
            <button class="pbe-v2-action" onclick="App.nav('teams')">Research Teams</button>
            <a class="pbe-v2-action" href="https://propbetedge.ai/news/nfl">NFL News ↗</a>
          </div>
        </div>
        <aside class="pbe-v2-market-card" id="pbe-v2-market-card">
          <div class="pbe-v2-market-card-head"><strong>Market Pulse</strong><span>Loading current feed</span></div>
          <div class="pbe-v2-market-content"><div class="pbe-v2-market-empty">Connecting current sportsbook pricing and PBE model output.</div></div>
        </aside>
      </div>

      <div class="pbe-v2-section-head">
        <div><h2>Intelligence Workspace</h2><p>Market tools first. Research and archive modules remain one click away.</p></div>
        <a href="javascript:void(0)" onclick="App.nav('propboard')">Go to market desk →</a>
      </div>
      <div class="pbe-v2-modules">${moduleCards()}</div>

      <div class="pbe-v2-lower-grid">
        <section class="pbe-v2-panel">
          <div class="pbe-v2-panel-title"><strong>All 32 Teams</strong><a href="javascript:void(0)" onclick="App.nav('teams')">Full profiles →</a></div>
          <div class="pbe-v2-team-wall">${teamWall()}</div>
        </section>
        <section class="pbe-v2-panel">
          <div class="pbe-v2-panel-title"><strong>Network Intelligence</strong><span>Connected products</span></div>
          <div class="pbe-v2-news-links">
            <a class="pbe-v2-news-link" href="https://propbetedge.ai/news/nfl"><span>NFL newsroom and breaking coverage</span><span>NEWS ↗</span></a>
            <a class="pbe-v2-news-link" href="javascript:void(0)" onclick="App.nav('propboard')"><span>Current sportsbook Prop Board</span><span>MARKET</span></a>
            <a class="pbe-v2-news-link" href="https://mlb.propbetedge.ai"><span>PropBetEdge MLB intelligence</span><span>MLB ↗</span></a>
            <a class="pbe-v2-news-link" href="https://propsports.proptechusa.ai"><span>PropSports data infrastructure</span><span>API ↗</span></a>
          </div>
        </section>
      </div>
    </section>`;
  }

  async function hydrateMarketPulse() {
    const card = document.getElementById('pbe-v2-market-card');
    if (!card) return;
    const eventId = currentEventId();
    try {
      const [board,modelResult] = await Promise.all([
        fetchJson(`${API}/api/odds/board?event_id=${encodeURIComponent(eventId)}&markets=player_pass_yds`),
        fetchJson(`${API}/api/picks/pass?event_id=${encodeURIComponent(eventId)}`).catch(error => ({__error:error.message}))
      ]);
      const event = board.event || {};
      const away = event.away_team || event.away || 'Away';
      const home = event.home_team || event.home || 'Home';
      const semantics = board?.source?.semantics || 'UNAVAILABLE';
      const books = new Set((board.quotes || []).map(q => q.book || q.book_title || q.book_key || q.sportsbook).filter(Boolean));
      const models = Array.isArray(modelResult?.models) ? modelResult.models.filter(m => m.available !== false) : [];
      const top = models
        .filter(m => Number.isFinite(num(m.fair_line_gap_yards)))
        .sort((a,b) => Math.abs(num(b.fair_line_gap_yards)) - Math.abs(num(a.fair_line_gap_yards)))
        .slice(0,2);

      card.innerHTML = `<div class="pbe-v2-market-card-head"><strong>Market Pulse</strong><span class="${semantics === 'LIVE' ? 'pbe-v2-status-live' : ''}">${esc(semantics)} · ${esc(board?.source?.provider || 'provider')}</span></div>
        <div class="pbe-v2-market-content">
          <div class="pbe-v2-pulse-event">${esc(away)} @ ${esc(home)}</div>
          <div class="pbe-v2-pulse-meta">Passing-yard market · updated ${esc(formatTime(board.provider_last_update || board.updated_at))}</div>
          <div class="pbe-v2-pulse-grid">
            <div class="pbe-v2-pulse-stat"><b>${esc(board.quote_count ?? (board.quotes || []).length)}</b><span>Quotes</span></div>
            <div class="pbe-v2-pulse-stat"><b>${esc(board.player_market_count ?? (board.market_summary || []).length)}</b><span>Player markets</span></div>
            <div class="pbe-v2-pulse-stat"><b>${books.size}</b><span>Books</span></div>
          </div>
          <div class="pbe-v2-model-list">
            ${top.length ? top.map(m => {
              const gap = num(m.fair_line_gap_yards);
              const fair = num(m.fair_line);
              const market = num(m.market_consensus_line);
              return `<div class="pbe-v2-model-row"><div><div class="pbe-v2-model-player">${esc(m.player)}</div><div class="pbe-v2-model-meta">Market ${Number.isFinite(market) ? esc(market) : '—'} · PBE fair ${Number.isFinite(fair) ? esc(fair.toFixed(1)) : '—'} · MODEL</div></div><div class="pbe-v2-model-gap">${gap > 0 ? '+' : ''}${esc(gap.toFixed(1))}</div></div>`;
            }).join('') : `<div class="pbe-v2-model-row"><div><div class="pbe-v2-model-player">Passing model</div><div class="pbe-v2-model-meta">${modelResult?.__error ? 'Model temporarily unavailable' : 'No modeled props returned for this event'}</div></div><div class="pbe-v2-model-gap">—</div></div>`}
          </div>
        </div>`;
    } catch (_) {
      card.innerHTML = `<div class="pbe-v2-market-card-head"><strong>Market Pulse</strong><span>UNAVAILABLE</span></div><div class="pbe-v2-market-content"><div class="pbe-v2-market-empty">Current sportsbook pricing could not be loaded. No synthetic market data is shown.<br><br><button class="pbe-v2-action primary" onclick="App.nav('propboard')">Open Prop Board</button></div></div>`;
    }
  }

  function renderDashboard() {
    const vc = document.getElementById('view-container');
    if (!vc) return;
    vc.innerHTML = dashboardShell();
    hydrateMarketPulse();
  }

  function retireUnsafeLegacyViews() {
    if (!window.App?.VIEWS) return;
    App.VIEWS.picks = () => renderFeatureState(
      'Model Lab',
      'The legacy hardcoded pick cards are retired in this redesign. Current validated passing-model output is available inside the Prop Board while the broader STE stack is rebuilt against factual inputs.',
      'Open Prop Board',
      "App.nav('propboard')"
    );
    App.VIEWS.pbecast = () => renderFeatureState(
      'PBEcast',
      'The visual concept stays in the product, but this workspace will not label game data LIVE until verified current play-by-play transport is connected.',
      'Open NFL News',
      "window.location.href='https://propbetedge.ai/news/nfl'"
    );
    App.VIEWS.injuries = () => renderFeatureState(
      'Injury Intelligence',
      'Legacy hardcoded injury cards are retired here. Verified NFL injury news remains available in the newsroom; structured official status will populate this workspace from current-season reporting.',
      'Open Injury News',
      "window.location.href='https://propbetedge.ai/news/nfl'"
    );
    App.VIEWS.trades = () => renderFeatureState(
      'Transactions',
      'Legacy rumor cards are retired from the intelligence UI. Current transaction and roster news is handled by the PropBetEdge NFL newsroom.',
      'Open NFL News',
      "window.location.href='https://propbetedge.ai/news/nfl'"
    );
    App.VIEWS.propchain = () => renderFeatureState(
      'PropChain',
      'PropChain remains part of the product roadmap. Until its live transport is fully verified, the production-grade market workflow is the Prop Board.',
      'Open Prop Board',
      "App.nav('propboard')"
    );
  }

  function cleanLegacyNav() {
    const seasonLabel = [...document.querySelectorAll('.nav-group-label')].find(el => el.textContent.trim() === '2025 Season');
    if (seasonLabel) seasonLabel.textContent = '2025 Archive';

    const injuryBadge = document.querySelector('#nav-injuries .nav-badge');
    if (injuryBadge) {
      injuryBadge.textContent = 'NEWS';
      injuryBadge.removeAttribute('style');
    }
    const tradeBadge = document.querySelector('#nav-trades .nav-badge');
    if (tradeBadge) {
      tradeBadge.textContent = 'NEWS';
      tradeBadge.removeAttribute('style');
    }
    const picks = document.getElementById('nav-picks');
    if (picks) {
      const icon = picks.querySelector('.ni-icon');
      picks.innerHTML = `${icon ? icon.outerHTML : '<span class="ni-icon">🧠</span>'} Model Lab`;
    }
  }

  function installFrame() {
    if (!document.getElementById('pbe-v2-network')) document.body.insertAdjacentHTML('afterbegin',networkHtml());
    const main = document.getElementById('main-content');
    const vc = document.getElementById('view-container');
    if (main && vc && !document.getElementById('pbe-v2-commandbar')) vc.insertAdjacentHTML('beforebegin',commandBarHtml());
  }

  function install() {
    if (!window.App || !window.HomeView) return;

    installFrame();
    cleanLegacyNav();

    // Prevent the legacy synthetic/demo ticker from rendering at all.
    if (window.TickerComp) {
      TickerComp.init = function(el) {
        if (!el) return;
        el.innerHTML = statusSkeleton();
        refreshStatus(el);
      };
    }

    // Dashboard is a full redesign; research routes underneath remain available.
    HomeView.render = renderDashboard;
    retireUnsafeLegacyViews();

    if (!App.__v2NavWrapped) {
      const originalNav = App.nav.bind(App);
      App.nav = function(view,updateHash=true) {
        updateCommandBar(view);
        const result = originalNav(view,updateHash);
        setTimeout(() => updateCommandBar(view),100);
        return result;
      };
      App.__v2NavWrapped = true;
    }

    updateCommandBar(App.currentView || 'home');
  }

  install();
  document.addEventListener('DOMContentLoaded',() => {
    install();
    const ticker = document.getElementById('ticker');
    if (ticker) {
      ticker.innerHTML = statusSkeleton();
      refreshStatus(ticker);
    }
  },{once:true});
})();
