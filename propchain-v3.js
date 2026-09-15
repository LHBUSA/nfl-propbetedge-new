/* PropBetEdge NFL — PROPCHAIN v3 (#propchain)
 *
 * Follow the change through the market:
 *   WHAT CHANGED -> WHO IT TOUCHES -> WHAT MARKET MOVED -> WHAT THE MARKET SAYS
 *   NOW -> WHAT PBE KNOWS -> WHERE TO GO NEXT
 *
 * ROUTE AUTHORITY. This module is the one renderer for #propchain. It is a
 * terminal authority in page-loader.js, so app-core neither paints nor boots
 * the route before it installs, and nothing may reassign the route after. The
 * ui-v2 roadmap placeholder and propchain-v2 are out of the runtime.
 *
 * DATA. Nothing here contacts a provider. Every read is persisted Cloudflare
 * intelligence or an existing same-origin product API:
 *   /api/changes      nfl-intel — injuries (+ ledger transitions), game
 *                     disruptions, consensus market tape, weather. The 48h read
 *                     is the command center's shared store; 7D is one extra read.
 *   /api/best-line    nfl-intel — game lines, shared store with Best Line
 *   /api/odds/board   nfl-odds KV snapshot — player props, one read per game in
 *                     scope, deduplicated and cached for the snapshot's life
 *   /api/pbe-picks    PBE Card store (PBECard) — entitlement decided server-side
 *   /api/pro-model    passing model, NFL Pro only, per game, on demand
 *   /api/news-feed    newsroom, through the shared news trust guard
 *
 * The chain join lives in propchain-core-v3.js (PBEPropChainCore) and is tested
 * in research/propchain-core-v3.test.mjs. This file fetches, renders and wires.
 *
 * CADENCE. One timer, only while #propchain is on screen and the tab is visible:
 * every 2 minutes it asks the shared stores, which are themselves TTL-guarded.
 * Leaving the route or hiding the tab stops it.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const REFRESH_MS = 120000;
  const TTL = { changes7d: 120000, board: 600000, news: 300000, model: 300000 };
  const PAGE = () => (narrow() ? 12 : 25);
  const MARKET_STALE_S = 15 * 3600;            // scheduled ingests 08/13/18 ET; the overnight gap is 14h
  const DNA = {
    QB: { route: 'qbdna', api: '/api/qb-dna?list=1', global: 'PBEQBDna' },
    WR: { route: 'wrdna', api: '/api/wr-dna?list=1', global: 'PBEWRDna' },
    RB: { route: 'rbdna', api: '/api/rb-dna?list=1', global: 'PBERBDna' },
    TE: { route: 'tedna', api: '/api/te-dna?list=1', global: 'PBETEDna' }
  };
  const BESTLINE_PROP_MARKETS = new Set(['player_pass_yds', 'player_rush_yds', 'player_reception_yds', 'player_receptions', 'player_pass_tds', 'player_rush_attempts', 'player_pass_attempts', 'player_anytime_td']);

  /* One definition, shown wherever PropChain names the number. It is NOT the
     Best Line page's "lowest over on offer": alternates are different bets. */
  const BEST_MAIN_DEF = 'Best available number among each book’s primary/main market offering; alternate ladders are not treated as the same wager.';
  const tip = label => `<button type="button" class="pc3-tip" data-tip="${BEST_MAIN_DEF}" aria-label="${label}: ${BEST_MAIN_DEF}">?</button>`;
  const core = () => window.PBEPropChainCore;
  const cc = () => window.PBECommandCenter;
  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const arr = v => (Array.isArray(v) ? v : []);
  const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const fin = v => Number.isFinite(num(v));
  const narrow = () => window.matchMedia?.('(max-width: 760px)').matches;
  const isPro = () => window.PBEPro?.state?.pro === true;
  const active = () => window.App?.current === 'propchain';

  /* ---- formatting ---------------------------------------------------------- */
  const ET = { timeZone: 'America/New_York' };
  const etTime = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { ...ET, hour: 'numeric', minute: '2-digit' }); };
  const etDay = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { ...ET, weekday: 'short', month: 'short', day: 'numeric' }); };
  const etShortDay = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { ...ET, weekday: 'short' }); };
  const stamp = v => (etTime(v) ? `${etDay(v)} · ${etTime(v)} ET` : '—');
  const sameDay = v => etDay(v) === etDay(Date.now());
  const clock = v => (etTime(v) ? `${sameDay(v) ? '' : `${etShortDay(v)} `}${etTime(v)}` : '—');
  function ago(v) {
    const t = Date.parse(v || ''); if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 90) return 'just now'; if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
  function age(seconds) {
    const s = num(seconds); if (!Number.isFinite(s)) return '—';
    if (s < 90) return 'just now'; if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
    return `${Math.round(s / 86400)}d`;
  }
  const american = v => { const n = num(v); return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${Math.round(n)}` : '—'; };
  const signed = (v, d = 1) => { const n = num(v); if (!Number.isFinite(n)) return '—'; const t = Math.abs(n % 1) > 0 || d > 0 ? n.toFixed(d).replace(/\.0$/, '') : String(n); return `${n > 0 ? '+' : n < 0 ? '−' : ''}${t.replace('-', '')}`; };
  const line = (market, v) => { const n = num(v); if (!Number.isFinite(n)) return '—'; if (market === 'spread') return n === 0 ? 'PK' : signed(n); return String(n); };
  const pct = v => { const n = num(v); return Number.isFinite(n) ? `${(n <= 1 ? n * 100 : n).toFixed(1)}%` : '—'; };
  const words = s => String(s || '').replace(/_/g, ' ');
  const title = s => words(s).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());

  /* ---- state ---------------------------------------------------------------- */
  const ui = { week: null, game: 'all', signal: 'all', severity: 'all', window: '48', q: '', sort: 'impact', open: null, limit: 0, filters: false, method: false };
  const store = {
    changes7d: { data: null, error: null, at: 0, busy: null },
    boards: new Map(),       // odds event id -> { status, data, index, error, at, busy }
    models: new Map(),       // odds event id -> { status, data, error, at, busy }   (NFL Pro passing model)
    news: { data: null, error: null, at: 0, busy: null },
    dna: new Map(),          // position -> Promise<list>
    notice: null
  };
  let timer = null;
  let paintQueued = false;

  async function getJson(url, init = {}) {
    const r = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' }, ...init });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch (_) { body = null; }
    if (!r.ok) { const e = new Error(body?.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
    if (!body) throw new Error('non_json_response');
    return body;
  }
  /* TTL-guarded, one in-flight promise per slot: concurrent callers share it. */
  function cached(slot, ttl, url, init) {
    if (slot.busy) return slot.busy;
    if (slot.at && Date.now() - slot.at < ttl && (slot.data || slot.error)) return Promise.resolve(slot.data);
    slot.busy = getJson(url, init)
      .then(d => { slot.data = d; slot.error = null; slot.status = 'ok'; return d; })
      .catch(e => { slot.error = e?.message || String(e); if (!slot.data) slot.status = 'error'; return slot.data; })
      .finally(() => { slot.at = Date.now(); slot.busy = null; queuePaint(); });
    return slot.busy;
  }

  /* ---- sources ---------------------------------------------------------------- */
  function changesSlot() {
    if (ui.window === '168') return store.changes7d;
    return cc()?.store?.changes || store.changes7d;
  }
  function changesData() {
    const s = changesSlot();
    return s?.data || null;
  }
  const bestline = () => cc()?.store?.bestline?.data || null;
  const bestlineError = () => cc()?.store?.bestline?.error || null;

  function refreshChanges(force = false) {
    if (ui.window === '168') return cached(store.changes7d, force ? 0 : TTL.changes7d, `${API}/api/changes?window_hours=168`);
    if (cc()?.refresh) return cc().refresh('changes', force);
    return cached(store.changes7d, force ? 0 : TTL.changes7d, `${API}/api/changes?window_hours=48`);
  }
  function refreshBestline(force = false) { return cc()?.refresh ? cc().refresh('bestline', force) : Promise.resolve(null); }
  function refreshNews(force = false) {
    const slot = store.news;
    if (slot.busy) return slot.busy;
    if (!force && slot.at && Date.now() - slot.at < TTL.news) return Promise.resolve(slot.data);
    slot.busy = getJson('/api/news-feed?limit=100')
      .then(d => { const list = arr(d?.articles); try { window.PBENewsTrust?.prepare?.(list); } catch (_) {} slot.data = list; slot.error = null; return list; })
      .catch(e => { slot.error = e?.message || String(e); return slot.data; })
      .finally(() => { slot.at = Date.now(); slot.busy = null; queuePaint(); });
    return slot.busy;
  }
  function loadBoard(eventId) {
    let slot = store.boards.get(eventId);
    if (slot?.busy) return slot.busy;
    if (slot && slot.at && Date.now() - slot.at < TTL.board && slot.status !== 'pending') return Promise.resolve(slot);
    if (!slot) { slot = { status: 'pending' }; store.boards.set(eventId, slot); }
    const url = `${API}/api/odds/board?event_id=${encodeURIComponent(eventId)}&markets=${encodeURIComponent(core().BOARD_MARKETS.join(','))}`;
    slot.busy = getJson(url)
      .then(d => { slot.data = d; slot.index = core().boardPlayers(d); slot.status = 'ok'; slot.error = null; })
      .catch(e => { if (!slot.data) { slot.status = 'error'; slot.error = e?.message || String(e); } })
      .finally(() => { slot.at = Date.now(); slot.busy = null; queuePaint(); });
    return slot.busy;
  }
  function loadModel(eventId) {
    if (!isPro()) return Promise.resolve(null);
    let slot = store.models.get(eventId);
    if (slot?.busy) return slot.busy;
    if (slot && slot.at && Date.now() - slot.at < TTL.model) return Promise.resolve(slot);
    if (!slot) { slot = { status: 'pending' }; store.models.set(eventId, slot); }
    slot.busy = getJson(`/api/pro-model?event_id=${encodeURIComponent(eventId)}`, { credentials: 'same-origin' })
      .then(d => { slot.data = d; slot.status = 'ok'; slot.error = null; })
      .catch(e => { slot.status = 'error'; slot.error = e?.status === 403 || e?.status === 401 ? 'not_entitled' : (e?.message || String(e)); })
      .finally(() => { slot.at = Date.now(); slot.busy = null; queuePaint(); });
    return slot.busy;
  }
  /* A tiny promise pool so a full slate never opens more than 4 board reads. */
  async function pool(ids, n, fn) {
    const queue = [...ids];
    await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => { while (queue.length) await fn(queue.shift()); }));
  }

  /* Which games need a player board: open games in scope that have a
     prop-position change or a newsroom mention in the window. Nothing else is
     read. */
  function boardsNeeded(data) {
    const C = core(); const bl = bestline();
    if (!data || !bl) return [];
    const now = Date.now();
    const hours = Number(ui.window) || 48;
    const want = new Set();
    const games = arr(data.games);
    const newsTeams = new Set(arr(store.news.data).filter(a => Date.parse(a.published_at) > now - hours * 3600000).flatMap(a => arr(a?._trust?.teams || a?.teams)));
    const touched = new Set(arr(data.changes).filter(c => c.kind === 'INJURY_STATUS' && c.player?.prop_relevant).map(c => String(c.game?.id)));
    const week = C.openWeek(games);
    for (const g of games) {
      if (ui.game !== 'all' ? String(g.id) !== String(ui.game) : g.semantics === 'FINAL' || (week !== null && Number(g.week) !== week)) continue;
      if (!touched.has(String(g.id)) && !newsTeams.has(g.away?.abbreviation) && !newsTeams.has(g.home?.abbreviation)) continue;
      const ev = C.matchOddsEvent(g, bl.events);
      if (ev) want.add(ev.id);
    }
    return [...want];
  }
  let boardsRun = null;
  function ensureBoards() {
    if (boardsRun) return boardsRun;
    const ids = boardsNeeded(changesData());
    if (!ids.length) return Promise.resolve();
    ids.forEach(id => { if (!store.boards.has(id)) store.boards.set(id, { status: 'pending' }); });
    boardsRun = pool(ids, 4, loadBoard).finally(() => { boardsRun = null; ensureModels(); });
    return boardsRun;
  }
  function ensureModels() {
    if (!isPro() || !lastModel) return;
    const ids = new Set(lastModel.chains.filter(c => c.model?.state === 'PENDING' && c.game?.odds_event_id && core().matches(c, ui, Date.now())).map(c => c.game.odds_event_id));
    ids.forEach(id => loadModel(id));
  }

  /* ---- model ---------------------------------------------------------------- */
  let lastModel = null;
  function compute() {
    const C = core(), data = changesData();
    if (!C || !data) return null;
    ui.week = C.openWeek(data.games);
    const cards = window.PBECard?.forGame ? (g => window.PBECard.forGame(g)) : (() => ({ cards: [], previews: [] }));
    lastModel = C.build({
      changes: data, bestline: bestline(), boards: store.boards, news: store.news.data, cards,
      passModels: store.models, pro: isPro(), now: Date.now()
    });
    return lastModel;
  }

  /* ---- freshness -------------------------------------------------------------- */
  function freshness(data) {
    const s = data?.sources || {};
    const bl = bestline();
    const inj = s.injuries || {};
    const mkt = s.market || {};
    const wx = data?.weather || {};
    const blAge = fin(bl?.age_seconds) ? num(bl.age_seconds) : null;
    return {
      injuries: { ok: inj.available === true, at: inj.fetched_at, age: inj.age_seconds, stale: inj.stale === true, partial: arr(inj.failed_teams).length > 0, reason: inj.reason },
      snapshot: { ok: Boolean(bl), at: bl?.captured_at, label: bl?.captured_at_et, age: blAge, failed: bl?.ingest?.status === 'LATEST_INGEST_UNAVAILABLE', stale: blAge !== null && blAge > MARKET_STALE_S, reason: bestlineError() },
      tape: { ok: mkt.available === true, at: mkt.latest_captured_at, captures: mkt.batches, reason: mkt.reason },
      weather: { ok: wx.available === true, at: wx.fetched_at, reason: wx.reason },
      transitions: { ok: data?.transitions?.available === true, attached: data?.transitions?.attached }
    };
  }
  function statusLine(data) {
    if (!data) return '';
    const f = freshness(data);
    const chip = (label, x, text, extra = '') => `<span class="pc3-chip ${!x.ok ? 'is-off' : x.stale || x.failed ? 'is-stale' : 'is-ok'}"${x.reason ? ` title="${esc(words(x.reason))}"` : ''}><i aria-hidden="true"></i><b>${esc(label)}</b>${esc(text)}${extra}</span>`;
    return `<div class="pc3-status" data-pc3-status>
      ${chip('Injury report', f.injuries, f.injuries.ok ? ` ${clock(f.injuries.at)} ET · ${age(f.injuries.age)}` : ' unavailable', f.injuries.stale ? ' · <em>STALE</em>' : f.injuries.partial ? ' · <em>PARTIAL</em>' : '')}
      ${chip('Market snapshot', f.snapshot, f.snapshot.ok ? ` ${f.snapshot.label || clock(f.snapshot.at)} · ${age(f.snapshot.age)}` : ' unavailable', f.snapshot.failed ? ' · <em>LATEST INGEST UNAVAILABLE</em>' : f.snapshot.stale ? ' · <em>STALE</em>' : '')}
      ${chip('Market tape', f.tape, f.tape.ok ? ` ${fin(f.tape.captures) ? `${f.tape.captures} captures · ` : ''}last ${clock(f.tape.at)} ET` : ` ${words(f.tape.reason || 'unavailable')}`)}
      ${chip('Weather', f.weather, f.weather.ok ? ` ${clock(f.weather.at)} ET` : ' unavailable')}
      <span class="pc3-status-note">Scheduled captures, not a live feed</span>
    </div>`;
  }

  /* ---- header + controls ------------------------------------------------------ */
  function gameOptions(data) {
    const games = arr(data?.games);
    const live = games.filter(g => g.semantics === 'LIVE');
    const next = games.filter(g => g.semantics === 'SCHEDULE').sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
    const done = games.filter(g => g.semantics === 'FINAL').sort((a, b) => Date.parse(b.kickoff) - Date.parse(a.kickoff));
    const opt = g => `<option value="${esc(g.id)}"${String(ui.game) === String(g.id) ? ' selected' : ''}>${esc(g.matchup)} · ${esc(g.semantics === 'LIVE' ? 'LIVE' : g.semantics === 'FINAL' ? 'Final' : `${etShortDay(g.kickoff)} ${etTime(g.kickoff)}`)}</option>`;
    const week = core()?.openWeek(games);
    return `<option value="all"${ui.game === 'all' ? ' selected' : ''}>All open games${week !== null && week !== undefined ? ` · Week ${esc(week)}` : ''}</option>${live.length ? `<optgroup label="Live">${live.map(opt).join('')}</optgroup>` : ''}${next.length ? `<optgroup label="Upcoming">${next.map(opt).join('')}</optgroup>` : ''}${done.length ? `<optgroup label="Final">${done.map(opt).join('')}</optgroup>` : ''}`;
  }
  function seg(key, options, label) {
    return `<div class="pc3-seg" role="group" aria-label="${esc(label)}">${options.map(([v, l]) => `<button type="button" data-pc3-set="${key}:${v}" aria-pressed="${String(ui[key]) === v}" class="${String(ui[key]) === v ? 'is-on' : ''}">${esc(l)}</button>`).join('')}</div>`;
  }
  function activeFilterCount() { return (ui.signal !== 'all') + (ui.severity !== 'all') + (ui.window !== '48') + (ui.sort !== 'impact'); }
  function controls(data) {
    return `<div class="pc3-controls${ui.filters ? ' is-open' : ''}" role="toolbar" aria-label="PropChain filters">
      <label class="pc3-field pc3-game"><span>Game</span><select data-pc3-game aria-label="Game">${gameOptions(data)}</select></label>
      <label class="pc3-field pc3-search"><span>Search</span><input type="search" data-pc3-q value="${esc(ui.q)}" placeholder="Player, team or market" autocomplete="off" spellcheck="false" aria-label="Search player, team or market"></label>
      <button type="button" class="pc3-filter-toggle" data-pc3-filters aria-expanded="${ui.filters}" aria-controls="pc3-more">Filters${activeFilterCount() ? ` · ${activeFilterCount()}` : ''}</button>
      <div class="pc3-more" id="pc3-more">
        <div class="pc3-field"><span>Signal</span>${seg('signal', [['all', 'All'], ['injury', 'Injury'], ['market', 'Market'], ['weather', 'Weather'], ['news', 'News'], ['game', 'Game']], 'Signal')}</div>
        <div class="pc3-field"><span>Severity</span>${seg('severity', [['all', 'All'], ['high', 'High'], ['medium', 'Med'], ['low', 'Low']], 'Severity')}</div>
        <div class="pc3-field"><span>Window</span>${seg('window', [['24', '24H'], ['48', '48H'], ['168', '7D']], 'Window')}</div>
        <label class="pc3-field pc3-sort"><span>Sort</span><select data-pc3-sort aria-label="Sort chains"><option value="impact"${ui.sort === 'impact' ? ' selected' : ''}>Severity</option><option value="latest"${ui.sort === 'latest' ? ' selected' : ''}>Latest</option><option value="movement"${ui.sort === 'movement' ? ' selected' : ''}>Market movement</option></select></label>
      </div>
    </div>`;
  }
  function methodology() {
    return `<div class="pc3-method" id="pc3-method" role="note"${ui.method ? '' : ' hidden'}>
      <b>How PropChain links a change to a market</b>
      <ul>
        <li><strong>Entity.</strong> Players are linked by ESPN athlete id on the injury report, then by exact name on that game’s player board. No fuzzy matching; an ambiguous name is not linked.</li>
        <li><strong>Market tape.</strong> Cross-book median consensus per scheduled capture (08:00 · 13:00 · 18:00 ET). A move is placed before, spanning or after a change in time. PropChain shows what was observed and when — it does not claim a change caused a move.</li>
        <li><strong>Player props</strong> are stored as the latest snapshot only, so a player line shows its current value, never an invented earlier one. Consensus is the median of each book’s main line (the number it prices closest to even); best main line is the best available number among each book’s primary/main offering, then price — alternate ladders are not treated as the same wager.</li>
        <li><strong>Transitions</strong> (e.g. QUESTIONABLE → OUT) appear only when PropBetEdge captured both designations.</li>
        <li><strong>Order.</strong> By severity; within a severity, players the books price more deeply (yardage and volume lines, not only an anytime touchdown) come first, then the most recent change.</li>
        <li><strong>PBE model</strong> values appear only where a model publishes them and your plan includes them. Fair value is never estimated from consensus.</li>
      </ul>
    </div>`;
  }
  function header(data) {
    return `<header class="pc3-head">
      <div class="pc3-title"><span class="pc3-kicker">NFL INTELLIGENCE</span><h1>PropChain</h1><p>Follow the change through the market.</p></div>
      <button type="button" class="pc3-method-toggle" data-pc3-method aria-expanded="${ui.method}" aria-controls="pc3-method"><span aria-hidden="true">i</span>How chains are linked</button>
      ${statusLine(data)}
    </header>${methodology()}`;
  }

  /* ---- strip ------------------------------------------------------------------ */
  function strip(model, data) {
    const C = core();
    const n = model ? C.counts(model, data, ui, Date.now()) : null;
    const f = data ? freshness(data) : null;
    const v = x => (n ? (n.pending && x === 0 ? '…' : String(x)) : '—');
    const cell = (label, value, sub, cls = '') => `<div class="pc3-stat ${cls}"><b>${value}</b><span>${esc(label)}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
    const latest = f ? [f.injuries.ok ? `Injuries ${esc(age(f.injuries.age))}` : null, f.snapshot.ok ? `Market ${esc(age(f.snapshot.age))}` : null].filter(Boolean).join(' · ') : '';
    return `<div class="pc3-strip" data-pc3-strip aria-live="polite">
      ${cell('Active chains', esc(v(n?.active ?? 0)), n?.pending ? 'Reading player boards…' : 'Change → market, in scope')}
      ${cell('High-impact changes', esc(v(n?.high ?? 0)), 'Severity HIGH, in scope', n?.high ? 'is-high' : '')}
      ${cell('Observed market moves', esc(f?.tape.ok ? v(n?.moves ?? 0) : '—'), f?.tape.ok ? 'Material consensus moves' : esc(words(f?.tape.reason || 'Tape unavailable')), n?.moves ? 'is-move' : '')}
      ${cell('Players affected', esc(v(n?.players ?? 0)), n?.transitions ? `${esc(n.transitions)} with observed transition` : 'In complete chains')}
      ${cell('Games affected', esc(v(n?.games ?? 0)), ui.game === 'all' ? 'Open games' : 'Selected game')}
      ${cell('Latest capture', f?.snapshot.ok || f?.injuries.ok ? esc(age(Math.min(...[f.injuries.ok ? num(f.injuries.age) : Infinity, f.snapshot.ok ? num(f.snapshot.age) : Infinity].filter(Number.isFinite)))) : '—', latest, f?.snapshot.stale || f?.injuries.stale ? 'is-stale' : '')}
    </div>`;
  }

  /* ---- chain row ---------------------------------------------------------------- */
  const SEV = { HIGH: 'High', MEDIUM: 'Med', LOW: 'Low' };
  const KIND = { INJURY: 'Injury', MARKET: 'Market', WEATHER: 'Weather', NEWS: 'News', GAME: 'Game' };
  const STATUS_TONE = { OUT: 'neg', SUSPENDED: 'neg', DOUBTFUL: 'neg', INJURED_RESERVE: 'neg', QUESTIONABLE: 'warn', ACTIVE: 'pos', PROBABLE: 'pos', POSTPONED: 'neg', DELAYED: 'neg', CANCELED: 'neg' };
  function gameTag(g) {
    if (!g) return '';
    const state = g.semantics === 'LIVE' ? '<i class="pc3-live">LIVE</i>' : g.semantics === 'FINAL' ? '<i class="pc3-final">FINAL</i>' : `${esc(etShortDay(g.kickoff))} ${esc(etTime(g.kickoff))}`;
    return `<span class="pc3-matchup">${esc(g.matchup)} · ${state}</span>`;
  }
  function eventLabel(c) {
    if (c.kind === 'INJURY' && c.transition) {
      return `<span class="pc3-trans"><em class="tone-${STATUS_TONE[c.transition.from] || 'mute'}">${esc(words(c.transition.from))}</em><i aria-hidden="true">→</i><em class="tone-${STATUS_TONE[c.transition.to] || 'mute'}">${esc(words(c.transition.to))}</em></span>`;
    }
    if (c.kind === 'INJURY') return `<span class="pc3-upd">Status updated: <em class="tone-${STATUS_TONE[c.status] || 'mute'}">${esc(words(c.status))}</em></span>`;
    return `<span class="pc3-upd">${esc(c.event_label)}</span>`;
  }
  function entityCell(c) {
    const e = c.entity || {};
    if (e.type === 'PLAYER') return `<b>${esc([e.position, e.team].filter(Boolean).join(' · ') || 'Player')}</b><small>${esc(e.espn_id ? 'Player · ESPN athlete id' : 'Player · named in article')}</small>`;
    if (e.type === 'TEAM') return `<b>${esc(e.team || e.name)}</b><small>Team market</small>`;
    return `<b>${esc(c.game?.matchup || e.name || 'Game')}</b><small>${esc(c.kind === 'WEATHER' ? (e.venue || 'Game venue') : 'Game')}</small>`;
  }
  function moveChip(m) {
    if (!m) return '';
    const unit = m.unit === 'pp' ? 'pp' : m.market === 'total' || m.market === 'spread' ? 'pts' : '';
    const kind = m.kind || core().moveKind(m);
    return `<span class="pc3-delta k-${esc(kind.toLowerCase())}">${esc(signed(m.delta))}${unit ? ` ${unit}` : ''}${kind === 'KEY_NUMBER' ? ` · key ${esc(m.key_number)}` : ''}</span>`;
  }
  function marketCell(c) {
    const mk = c.market || {};
    if (c.kind === 'MARKET' && c.move) {
      const m = c.move;
      const val = p => (m.market === 'moneyline' ? american(p?.price) : line(m.market, p?.line));
      return `<small>${esc(m.market === 'total' ? 'Total' : m.market === 'spread' ? `${m.selection} spread` : `${m.selection} ML`)}</small><b class="pc3-tape">${esc(val(m.from))}<i aria-hidden="true">→</i>${esc(val(m.to))}</b>${moveChip(m)}`;
    }
    if (mk.kind === 'PENDING') return '<span class="pc3-skel-line" aria-label="Reading player board"></span>';
    if (mk.kind === 'PLAYER_PROPS') {
      const p = mk.primary;
      const value = p.kind === 'OU' ? `O/U ${esc(p.consensus_line)}` : p.kind === 'YES' ? `Yes ${esc(american(p.consensus_price))}` : 'Ladder only';
      const tag = mk.snapshot?.in_game_capture ? 'IN-GAME CAPTURE' : mk.snapshot?.before_source ? 'PRE-CHANGE PRICE' : 'CURRENT';
      return `<small>${esc(p.label)}</small><b>${value}</b><span class="pc3-tag${mk.snapshot?.before_source || mk.snapshot?.in_game_capture ? ' is-warn' : ''}">${tag}</span>`;
    }
    if (mk.kind === 'GAME_LINE') {
      const l = mk.line;
      const moved = arr(c.tape?.moves).find(x => x.market === l.market);
      return `<small>${esc(l.market === 'total' ? 'Game total' : `${l.side.split(' ').slice(-1)[0]} spread`)}</small><b>${esc(line(l.market, l.consensus?.line))}</b>${moved ? moveChip(moved) : `<span class="pc3-tag">${c.tape?.available ? 'NO MATERIAL MOVE' : 'CURRENT'}</span>`}`;
    }
    return `<small>Market</small><b class="pc3-na">—</b>`;
  }
  function bestCell(c) {
    const mk = c.market || {};
    if (mk.kind === 'PENDING') return '<span class="pc3-skel-line"></span>';
    if (mk.kind === 'PLAYER_PROPS') {
      const p = mk.primary;
      if (p.kind === 'YES') return `<b>Yes ${esc(american(p.best_yes.price))}</b><small>${esc(p.best_yes.book)}</small>`;
      if (p.kind !== 'OU') return '<b class="pc3-na">—</b>';
      return `<b>O ${esc(p.best_over.point)} <span>${esc(american(p.best_over.price))}</span></b><small>${esc(p.best_over.book)}</small><b>U ${esc(p.best_under.point)} <span>${esc(american(p.best_under.price))}</span></b><small>${esc(p.best_under.book)}</small>`;
    }
    if (mk.kind === 'GAME_LINE' && mk.line.best) {
      const b = mk.line.best, l = mk.line;
      return `<b>${esc(l.market === 'total' ? `${l.side === 'UNDER' ? 'U' : 'O'} ${b.line}` : l.market === 'moneyline' ? american(b.price) : line(l.market, b.line))} ${l.market === 'moneyline' ? '' : `<span>${esc(american(b.price))}</span>`}</b><small>${esc(b.book)}</small>`;
    }
    return '<b class="pc3-na">—</b>';
  }
  function modelCell(c) {
    const m = c.model || {};
    if (m.state === 'PUBLISHED' && m.source === 'PASSING_MODEL') return `<b class="pc3-model">Fair ${esc(m.row.fair_line)}</b><small>${esc(signed(m.row.fair_line_gap_yards))} vs cons.</small>`;
    if (m.state === 'PUBLISHED' && m.source === 'PBE_CARD') return `<b class="pc3-model">${esc(m.card.publication_scope === 'official' ? 'Official pick' : 'Signal')}</b><small>Fair ${esc(line(m.card.market, m.card.model?.fair_line))}</small>`;
    if (m.state === 'LOCKED') return `<b class="pc3-lock">PRO</b><small>${m.source === 'PBE_CARD' ? 'Signal on market' : 'Passing model'}</small>`;
    if (m.state === 'PENDING') return '<span class="pc3-skel-line"></span>';
    return '<b class="pc3-na">Not published</b>';
  }
  function row(c, i) {
    const open = ui.open === c.id;
    const pid = `pc3-ev-${i}`;
    return `<li class="pc3-row sev-${esc(String(c.severity).toLowerCase())}${open ? ' is-open' : ''}${c.kind === 'MARKET' ? ' has-move' : ''}${c.actionable === false ? ' is-history' : ''}" data-id="${esc(c.id)}">
      <button type="button" class="pc3-row-btn" data-pc3-open="${esc(c.id)}" aria-expanded="${open}" aria-controls="${pid}">
        <span class="pc3-c pc3-c-sig"><span class="pc3-sev">${esc(SEV[c.severity] || c.severity)}</span><span class="pc3-kind">${esc(KIND[c.kind] || c.kind)}</span><time datetime="${esc(c.time || '')}">${esc(clock(c.time))}</time></span>
        <span class="pc3-c pc3-c-change"><b class="pc3-name">${esc(c.title)}</b>${eventLabel(c)}${gameTag(c.game)}</span>
        <span class="pc3-c pc3-c-src"><small>Source</small><b>${esc(c.source?.label)}</b><small>${esc(c.source?.basis === 'CAPTURE_TIME' ? 'captured' : 'updated')} ${esc(clock(c.source?.at))}</small></span>
        <span class="pc3-c pc3-c-ent">${entityCell(c)}</span>
        <span class="pc3-c pc3-c-mkt">${marketCell(c)}</span>
        <span class="pc3-c pc3-c-best"><small class="pc3-lbl">Best main line</small>${bestCell(c)}</span>
        <span class="pc3-c pc3-c-pbe"><small class="pc3-lbl">PBE</small>${modelCell(c)}</span>
        <span class="pc3-chev" aria-hidden="true"></span>
      </button>
      ${open ? evidence(c, pid) : ''}
    </li>`;
  }

  /* ---- evidence ------------------------------------------------------------------ */
  function step(n, label, body, cls = '') { return `<section class="pc3-step ${cls}"><header><i>${n}</i><span>${esc(label)}</span></header>${body}</section>`; }
  function dl(pairs) { return `<dl class="pc3-dl">${pairs.filter(Boolean).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`; }
  function sourceStep(c, data) {
    const s = c.source || {};
    const inj = data?.sources?.injuries;
    let body = '';
    if (c.kind === 'INJURY') {
      const i = s.injury || {};
      const what = [i.type, i.location && i.location !== i.type ? i.location : null, i.detail, i.side].filter(Boolean).join(' · ');
      body += `<p class="pc3-lead">${esc(c.entity.name)} · <strong class="tone-${STATUS_TONE[c.status] || 'mute'}">${esc(words(c.status))}</strong></p>`;
      body += c.transition
        ? `<div class="pc3-transition"><div><small>Last captured as</small><b class="tone-${STATUS_TONE[c.transition.from] || 'mute'}">${esc(words(c.transition.from))}</b><span>${esc(stamp(c.transition.from_observed_at))}</span></div><i aria-hidden="true">→</i><div><small>First captured as</small><b class="tone-${STATUS_TONE[c.transition.to] || 'mute'}">${esc(words(c.transition.to))}</b><span>${esc(stamp(c.transition.observed_at))}</span></div></div><p class="pc3-fine">Both designations were captured by PropBetEdge from the ESPN injury report; the change happened between those two captures.</p>`
        : `<p class="pc3-fine">${data?.transitions?.available ? 'No earlier designation was captured by PropBetEdge for this player, so this is shown as an update, not a change from a prior status.' : 'Designation history is not published for this item, so this is shown as an update, not a change from a prior status.'}</p>`;
      body += dl([
        what ? ['Injury', esc(what)] : null,
        i.return_date ? ['Return date', `${esc(i.return_date)} <small>as reported by ESPN</small>`] : null,
        ['Source', esc(s.label)],
        ['Source time', `${esc(stamp(s.at))} <small>ESPN update time</small>`],
        inj?.fetched_at ? ['Report captured', `${esc(stamp(inj.fetched_at))}`] : null
      ]);
      if (s.note) body += `<blockquote class="pc3-quote"><span>ESPN note</span>${esc(s.note)}</blockquote>`;
    } else if (c.kind === 'MARKET') {
      body += `<p class="pc3-lead">${esc(c.title)} · ${esc(c.event_label)}</p>${dl([
        ['Source', esc(s.label)], ['Earlier capture', esc(stamp(s.from_captured_at))], ['Latest capture', esc(stamp(s.at))], s.note ? ['Note', esc(s.note)] : null
      ])}`;
    } else if (c.kind === 'WEATHER') {
      body += `<p class="pc3-lead">${esc(c.title)}</p>${dl([
        ['Source', esc(s.label)], ['Effective', esc(stamp(s.at))], s.venue ? ['Venue', esc(s.venue)] : null,
        s.roof?.label ? ['Roof', esc(s.roof.label)] : null, s.note ? ['Detail', esc(s.note)] : null
      ])}${s.provider === 'open_meteo' && s.forecast_semantics ? `<p class="pc3-fine">${esc(s.forecast_semantics)}</p>` : ''}`;
    } else if (c.kind === 'NEWS') {
      body += `<p class="pc3-lead">${esc(s.headline || c.event_label)}</p>${s.note ? `<p class="pc3-body">${esc(s.note)}</p>` : ''}${dl([['Source', esc(title(s.label))], ['Published', esc(stamp(s.at))]])}`;
    } else {
      body += `<p class="pc3-lead">${esc(c.event_label)}</p>${dl([['Source', esc(s.label)], ['Observed', esc(stamp(s.at))], s.note ? ['Detail', esc(s.note)] : null])}`;
    }
    return step('01', 'Source event', body);
  }
  function entityStep(c) {
    const e = c.entity || {}, g = c.game || {};
    const pic = (src, cls = '') => `<img class="pc3-face${cls}" src="${esc(src)}" width="56" height="56" alt="" loading="lazy" decoding="async" onerror="this.classList.add('image-failed')">`;
    const teamLogo = abbr => [g.away, g.home].find(t => t?.abbreviation === abbr)?.logo || null;
    const img = e.headshot ? pic(e.headshot)
      : e.type === 'TEAM' && teamLogo(e.team) ? pic(teamLogo(e.team), ' is-logo')
      : e.type === 'GAME' && g.away?.logo && g.home?.logo ? `<span class="pc3-logos">${pic(g.away.logo, ' is-logo')}${pic(g.home.logo, ' is-logo')}</span>`
      : '';
    const body = `<div class="pc3-entity">${img}<div><b>${esc(e.name || g.matchup)}</b><span>${esc([e.position, e.team, e.type === 'GAME' ? 'Game' : e.type === 'TEAM' ? 'Team market' : null].filter(Boolean).join(' · '))}</span></div></div>${dl([
      g.matchup ? ['Game', `${esc(g.matchup)} · ${esc(g.semantics === 'LIVE' ? 'LIVE' : g.semantics === 'FINAL' ? 'Final' : stamp(g.kickoff))}`] : null,
      ['Linked by', esc(e.link || '—')],
      c.market?.board_name && c.market.board_name !== e.name ? ['Board name', esc(c.market.board_name)] : null
    ])}`;
    return step('02', 'Entity', body);
  }
  function tapeStep(c, data) {
    const t = c.tape || {};
    const T = t.thresholds || data?.sources?.market?.thresholds;
    let body = '';
    if (c.kind === 'MARKET' && c.move) {
      const m = c.move;
      const val = p => (m.market === 'moneyline' ? american(p?.price) : line(m.market, p?.line));
      body += `<div class="pc3-bigtape"><div><small>${esc(stamp(m.from?.captured_at))}</small><b>${esc(val(m.from))}</b><span>${esc(m.market === 'moneyline' ? '' : american(m.from?.price))} · ${esc(m.from?.books)} books</span></div><i aria-hidden="true">→</i><div><small>${esc(stamp(m.to?.captured_at))}</small><b>${esc(val(m.to))}</b><span>${esc(m.market === 'moneyline' ? '' : american(m.to?.price))} · ${esc(m.to?.books)} books</span></div>${moveChip(m)}</div>
        ${dl([
          ['Market', esc(`${m.market === 'total' ? 'Game total · Over' : `${m.selection} ${m.market}`}`)],
          ['Measured', esc(m.basis === 'PREVIOUS_BATCH' ? 'Since the previous capture' : 'Since the first capture in the window')],
          ['Captures', esc(m.observations)],
          ['Movement', esc(m.kind === 'KEY_NUMBER' ? `Number move across key number ${m.key_number}` : m.kind === 'PRICE' ? 'Price / implied probability move' : 'Number move')],
          m.book_change ? ['Books', `${esc(m.from?.books)} → ${esc(m.to?.books)} <small>liquidity, not price</small>`] : null
        ])}`;
      const others = arr(t.moves);
      if (others.length) body += `<p class="pc3-sub">Other observed moves in this game</p>${moveList(others)}`;
    } else if (!t.available) {
      body += `<p class="pc3-empty-line">Market history unavailable · ${esc(words(t.reason))}</p>`;
    } else {
      if (t.no_capture_after_source) body += `<p class="pc3-callout">The latest market capture (${esc(stamp(t.latest_captured_at))}) was taken <strong>before</strong> this change. The market has not been observed since.</p>`;
      body += arr(t.moves).length
        ? `<p class="pc3-sub">Observed consensus moves · ${esc(c.game?.matchup || 'this game')}</p>${moveList(t.moves)}`
        : `<p class="pc3-empty-line">No material consensus move recorded for ${esc(c.game?.matchup || 'this game')}${fin(t.captures) ? ` across ${esc(t.captures)} stored captures` : ''}.</p>`;
      if (T) body += `<p class="pc3-fine">Material = spread ≥ ${esc(T.spread_points)} pt or across ${esc(arr(T.key_numbers).join('/'))} · total ≥ ${esc(T.total_points)} · moneyline ≥ ${esc(T.moneyline_prob_pp)}pp.</p>`;
    }
    if (c.market?.kind === 'PLAYER_PROPS') body += `<p class="pc3-callout is-quiet"><strong>Player line: current only.</strong> Player-prop prices are stored as the latest snapshot, so no earlier player line exists to compare. Nothing here is a player-line move.</p>`;
    return step('03', 'Market tape', body);
  }
  function moveList(moves) {
    const REL = { BEFORE: 'Before this change', SPANS: 'Spans this change', AFTER: 'After this change', UNPLACED: 'Time not placed' };
    return `<ul class="pc3-moves">${moves.slice(0, 6).map(m => {
      const val = p => (m.market === 'moneyline' ? american(p?.price) : line(m.market, p?.line));
      return `<li><span class="pc3-rel r-${esc(String(m.relation).toLowerCase())}">${esc(REL[m.relation] || m.relation)}</span><b>${esc(m.market === 'total' ? 'Total' : `${m.selection} ${m.market === 'spread' ? 'spread' : 'ML'}`)}</b><span class="pc3-tape">${esc(val(m.from))} → ${esc(val(m.to))}</span>${moveChip(m)}<small>${esc(clock(m.from?.captured_at))} → ${esc(clock(m.to?.captured_at))} ET</small></li>`;
    }).join('')}</ul>`;
  }
  function snapshotNote(s) {
    if (!s) return '';
    const bits = [`Captured ${s.captured_at_et || stamp(s.captured_at)}`, `${age(s.age_seconds)} old`];
    if (s.in_game_capture) bits.push('captured after kickoff — an in-game price at one moment, not the pre-game market');
    else if (s.game_started) bits.push('game has started — pre-kick capture, not a current price');
    if (s.before_source) bits.push('taken before this change');
    if (s.ingest_failed) bits.push('latest ingest unavailable');
    return `<p class="pc3-snap${s.before_source || s.in_game_capture || s.game_started ? ' is-warn' : ''}">${esc(bits.join(' · '))}</p>`;
  }
  function marketStep(c) {
    const mk = c.market || {};
    let body = '';
    if (mk.kind === 'PLAYER_PROPS') {
      const ou = mk.markets.filter(m => m.kind === 'OU'), yes = mk.markets.filter(m => m.kind === 'YES');
      body += snapshotNote(mk.snapshot);
      if (ou.length) body += `<div class="pc3-scroll"><table class="pc3-table"><thead><tr><th scope="col">Market</th><th scope="col">Consensus</th><th scope="col">Best main over</th><th scope="col">Best main under</th><th scope="col">Books</th></tr></thead><tbody>${ou.map(m => `<tr><th scope="row">${esc(m.label)}</th><td><b>${esc(m.consensus_line)}</b>${m.line_low !== m.line_high ? `<small>${esc(m.line_low)}–${esc(m.line_high)}</small>` : ''}</td><td><b>${esc(m.best_over.point)}</b> ${esc(american(m.best_over.price))}<small>${esc(m.best_over.book)}</small></td><td><b>${esc(m.best_under.point)}</b> ${esc(american(m.best_under.price))}<small>${esc(m.best_under.book)}</small></td><td>${esc(m.main_books)}</td></tr>`).join('')}</tbody></table></div>`;
      if (yes.length) body += `<div class="pc3-yes">${yes.map(m => `<div><small>${esc(m.label)}</small><b>${esc(american(m.best_yes.price))}</b><span>best available · ${esc(m.best_yes.book)} · median ${esc(american(m.consensus_price))} · ${esc(m.books)} books</span></div>`).join('')}</div>`;
      body += `<p class="pc3-fine">Consensus = median of each book’s main line. Best main line: ${BEST_MAIN_DEF} Raw bookmaker prices, not vig-free.</p>`;
    } else if (mk.kind === 'GAME_LINE') {
      const l = mk.line, cons = l.consensus || {}, b = l.best;
      body += snapshotNote(mk.snapshot);
      body += `<div class="pc3-quad">
        <div><small>Consensus</small><b>${esc(l.market === 'moneyline' ? american(cons.price) : line(l.market, cons.line))}</b><span>${l.market === 'moneyline' ? '' : esc(american(cons.price))}${cons.no_vig_probability != null ? ` · ${esc(pct(cons.no_vig_probability))} vig-free` : ''}</span></div>
        <div><small>Best main line ${tip('Best main line')}</small><b>${b ? esc(l.market === 'moneyline' ? american(b.price) : line(l.market, b.line)) : '—'}</b><span>${b ? `${l.market === 'moneyline' ? '' : `${esc(american(b.price))} · `}${esc(b.book)}` : 'No quote'}</span></div>
        <div><small>Books</small><b>${esc(l.books ?? '—')}</b><span>${l.line_range ? `range ${esc(line(l.market, l.line_range.low))} to ${esc(line(l.market, l.line_range.high))}` : ''}</span></div>
      </div><p class="pc3-fine">${esc(l.market === 'total' ? 'Game total, over side.' : `${l.side} ${l.market}.`)} Consensus is the median line; vig-free probability from books quoting both sides at it. Game lines carry one main number per book (no alternate lines in the snapshot).</p>`;
    } else if (mk.kind === 'PENDING') {
      body += '<p class="pc3-empty-line">Reading this game’s player board…</p>';
    } else {
      body += `<p class="pc3-empty-line">${esc({ game_not_in_market_snapshot: 'This game is not in the current market snapshot.', market_not_in_snapshot: 'This market is not in the current snapshot.', player_not_on_board: 'This player is not priced on the board.', board_unavailable: 'The player board is unavailable.' }[mk.reason] || 'No current market.')}</p>`;
    }
    return step('04', 'Marketplace', body);
  }
  function modelStep(c) {
    const m = c.model || {};
    let body = '';
    if (m.state === 'PUBLISHED' && m.source === 'PASSING_MODEL') {
      const r = m.row;
      body += `<div class="pc3-quad is-model">
        <div><small>PBE fair line</small><b>${esc(r.fair_line)}</b><span>${esc(m.model_version || '')}</span></div>
        <div><small>Consensus it was run against</small><b>${esc(r.market_consensus_line ?? '—')}</b><span>gap ${esc(signed(r.fair_line_gap_yards))} yds</span></div>
        <div><small>Model over at consensus</small><b>${esc(pct(r.model_over_at_consensus_pct))}</b><span>${esc(words(r.confidence || ''))}</span></div>
      </div>${arr(r.missing_inputs).length ? `<p class="pc3-callout is-quiet"><strong>Not in this model:</strong> ${esc(arr(r.missing_inputs).map(words).join(' · '))}. It does not adjust for this change.</p>` : ''}${m.market_updated_at ? `<p class="pc3-fine">Model market read ${esc(stamp(m.market_updated_at))}.</p>` : ''}`;
    } else if (m.state === 'PUBLISHED' && m.source === 'PBE_CARD') {
      const k = m.card;
      body += `<div class="pc3-quad is-model">
        <div><small>${esc(k.label || 'PBE signal')}</small><b>${esc(k.selection?.team || k.selection?.over_under || '—')} ${esc(k.market === 'moneyline' ? '' : line(k.market, k.issue?.line))}</b><span>${esc(american(k.issue?.price))} at issue</span></div>
        <div><small>PBE fair value</small><b>${esc(k.market === 'moneyline' ? american(k.model?.fair_line) : line(k.market, k.model?.fair_line))}</b><span>frozen at signal issue</span></div>
        <div><small>PBE vs market</small><b>${esc(pct(k.model?.prob))}</b><span>market ${esc(pct(k.market_prob))}</span></div>
      </div><p class="pc3-fine">From the PBE Card. Values are frozen at issue${k.issued_at ? ` (${esc(stamp(k.issued_at))})` : ''}, not recomputed for this change.</p>`;
    } else if (m.state === 'LOCKED') {
      body += `<p class="pc3-lead is-pro">NFL Pro</p><p class="pc3-body">${m.source === 'PBE_CARD' ? 'A PBE validation signal exists on this market. Its side and value are part of NFL Pro.' : 'The PBE passing model publishes a fair line for this market in NFL Pro.'}</p><button type="button" class="pc3-pro" data-pc3-pro>Unlock NFL Pro</button>`;
    } else if (m.state === 'PENDING') {
      body += '<p class="pc3-empty-line">Reading the passing model…</p>';
    } else {
      body += `<p class="pc3-lead is-none">MODEL NOT PUBLISHED</p><p class="pc3-body">${esc({ no_model_for_market: 'No PBE model publishes this market.', no_signal_on_market: 'No PBE signal is published on this market.', player_not_modeled: 'The passing model does not publish a line for this player.', not_entitled: 'Model output requires NFL Pro.', no_market: 'Without a current market there is nothing to model against.' }[m.reason] || 'No published PBE value for this chain.')} Nothing is estimated from consensus.</p>`;
    }
    return step('05', 'PBE model', body, 'is-model-step');
  }
  function actions(c) {
    const e = c.entity || {}, g = c.game || {};
    const b = [];
    const dna = DNA[String(e.position || '').toUpperCase()];
    if (e.type === 'PLAYER' && dna && e.espn_id) b.push(`<button type="button" data-pc3-act="dna" data-id="${esc(c.id)}">Open ${esc(e.position)} DNA</button>`);
    if (e.type === 'PLAYER') b.push(`<button type="button" data-pc3-act="research" data-id="${esc(c.id)}">Player research</button>`);
    if (g.odds_event_id) b.push(`<button type="button" data-pc3-act="marketwatch" data-id="${esc(c.id)}">Market Watch</button>`);
    if (g.odds_event_id) b.push(`<button type="button" data-pc3-act="bestline" data-id="${esc(c.id)}">Compare on Best Line page</button>`);
    if (g.odds_event_id) b.push(`<button type="button" data-pc3-act="matchup" data-id="${esc(c.id)}">Open matchup</button>`);
    if (g.id) b.push(`<button type="button" data-pc3-act="pbecast" data-id="${esc(c.id)}">${g.semantics === 'LIVE' ? 'Live PBEcast' : 'PBEcast'}</button>`);
    if (c.source?.url) b.push(`<a href="${esc(c.source.url)}" target="_blank" rel="noopener">${esc(c.source.url_label || 'Source')} ↗</a>`);
    const note = store.notice && store.notice.id === c.id ? `<p class="pc3-act-note" role="status">${esc(store.notice.text)}</p>` : '';
    return `<nav class="pc3-actions" aria-label="Next steps">${b.join('')}</nav>${note}`;
  }
  function evidence(c, pid) {
    const data = changesData();
    return `<div class="pc3-evidence" id="${pid}" role="region" aria-label="Evidence for ${esc(c.title)}">
      <div class="pc3-ev-grid"><div class="pc3-ev-record">${sourceStep(c, data)}${entityStep(c)}${tapeStep(c, data)}</div><div class="pc3-ev-market">${marketStep(c)}${modelStep(c)}</div></div>
      ${actions(c)}
    </div>`;
  }

  /* ---- context (the page is never empty) ---------------------------------------- */
  function contextHtml(model, data, visibleCount) {
    const C = core(), now = Date.now();
    const scope = model ? model.context.filter(x => C.inScope(x, ui, now)).sort((a, b) => Date.parse(b.time || 0) - Date.parse(a.time || 0)) : [];
    const STOP = { NOT_ON_BOARD: 'Not priced on the player board', POSITION_NOT_PRICED: 'Position has no player props', MARKET_UNAVAILABLE: 'Market unavailable', NO_GAME: 'No game on the current slate', INDOOR: 'Fixed-roof venue' };
    const selected = ui.game !== 'all' ? arr(data?.games).find(g => String(g.id) === String(ui.game)) : null;
    const latest = scope.filter(x => x.kind === 'INJURY').slice(0, narrow() ? 6 : 10);
    const blocks = [];
    blocks.push(`<section class="pc3-ctx"><header><span>Latest verified changes</span><small>Sourced, but no player market to follow</small></header>${latest.length ? `<ul class="pc3-ctx-list">${latest.map(x => `<li><em class="tone-${STATUS_TONE[x.status] || 'mute'}">${esc(x.transition ? `${words(x.transition.from)} → ${words(x.transition.to)}` : words(x.status))}</em><b>${esc(x.entity?.name)}</b><span>${esc([x.entity?.position, x.entity?.team, x.game?.matchup].filter(Boolean).join(' · '))}</span><small>${esc(STOP[x.stop] || '')} · ${esc(clock(x.time))}</small></li>`).join('')}</ul>` : '<p class="pc3-empty-line">No other sourced changes in this scope.</p>'}</section>`);
    if (selected) {
      const bl = bestline();
      const ev = bl ? C.matchOddsEvent(selected, bl.events) : null;
      const sp = ev ? C.gameLine(ev, 'spread', selected.home?.name) : null;
      const tot = ev ? C.gameLine(ev, 'total', 'OVER') : null;
      const tape = C.tapeFor(data, selected.id, null);
      blocks.push(`<section class="pc3-ctx"><header><span>Current market · ${esc(selected.matchup)}</span><small>${bl ? `Snapshot ${esc(bl.captured_at_et || stamp(bl.captured_at))}` : 'Snapshot unavailable'}</small></header>${ev ? `<div class="pc3-quad">
        <div><small>${esc(selected.home?.abbreviation)} spread</small><b>${esc(line('spread', sp?.consensus?.line))}</b><span>${sp?.best ? `best ${esc(line('spread', sp.best.line))} ${esc(american(sp.best.price))} · ${esc(sp.best.book)}` : 'no quote'}</span></div>
        <div><small>Total</small><b>${esc(tot?.consensus?.line ?? '—')}</b><span>${tot?.best ? `best O ${esc(tot.best.line)} ${esc(american(tot.best.price))} · ${esc(tot.best.book)}` : 'no quote'}</span></div>
        <div><small>Observed moves</small><b>${esc(tape.available ? tape.moves.length : '—')}</b><span>${tape.available ? `${esc(tape.captures ?? '—')} captures stored` : esc(words(tape.reason))}</span></div></div>` : '<p class="pc3-empty-line">This game is not in the current market snapshot.</p>'}</section>`);
      const avail = arr(data?.availability?.[selected.id]);
      blocks.push(`<section class="pc3-ctx"><header><span>Current injuries · ${esc(selected.matchup)}</span><small>Restrictive designations on the ESPN report</small></header>${avail.length ? `<ul class="pc3-ctx-list">${avail.slice(0, 14).map(r => `<li><em class="tone-${STATUS_TONE[r.status] || 'mute'}">${esc(words(r.status))}</em><b>${esc(r.player?.name)}</b><span>${esc([r.player?.position, r.team?.abbreviation].filter(Boolean).join(' · '))}</span><small>updated ${esc(clock(r.updated_at))}</small></li>`).join('')}</ul>` : '<p class="pc3-empty-line">No restrictive designations on the report for this game.</p>'}</section>`);
      const wx = arr(data?.weather?.events).filter(e => String(e?.game?.event_id || e?.game?.game_id) === String(selected.id) && !(Date.parse(e.expires || '') <= now));
      const disrupted = arr(data?.changes).filter(x => x.kind === 'GAME_STATUS' && String(x.game?.id) === String(selected.id));
      blocks.push(`<section class="pc3-ctx"><header><span>Weather & game status</span><small>${data?.weather?.available ? `Weather read ${esc(clock(data.weather.fetched_at))} ET` : 'Weather unavailable'}</small></header>${wx.length || disrupted.length ? `<ul class="pc3-ctx-list">${disrupted.map(x => `<li><em class="tone-neg">${esc(words(x.status))}</em><b>${esc(x.game?.matchup)}</b><span>${esc(x.detail || '')}</span></li>`).join('')}${wx.slice(0, 6).map(e => `<li><em class="tone-warn">${esc(e.official ? 'NWS' : 'FORECAST')}</em><b>${esc(e.headline)}</b><span>${esc(e.game?.roof?.label || '')}</span><small>${esc(e.effective ? clock(e.effective) : '')}</small></li>`).join('')}</ul>` : `<p class="pc3-empty-line">${selected.semantics === 'FINAL' ? 'Game final.' : 'No active weather alert, forecast shift or disruption for this game.'}</p>`}</section>`);
    } else if (!visibleCount && data) {
      const moves = arr(data.changes).filter(x => x.kind === 'MARKET_MOVE');
      blocks.push(`<section class="pc3-ctx"><header><span>Market context</span><small>Consensus tape across open games</small></header><p class="pc3-empty-line">${data.sources?.market?.available ? `${esc(moves.length)} material consensus move${moves.length === 1 ? '' : 's'} across ${esc(data.sources.market.batches)} captures, latest ${esc(stamp(data.sources.market.latest_captured_at))}.` : `Market tape unavailable · ${esc(words(data.sources?.market?.reason))}`}</p></section>`);
    }
    return blocks.join('');
  }

  /* ---- board ---------------------------------------------------------------- */
  function boardHtml(model, data) {
    const C = core(), now = Date.now();
    const visible = C.rank(model.chains.filter(c => c.complete !== false && C.matches(c, ui, now)), ui.sort);
    const shown = visible.slice(0, ui.limit || PAGE());
    const pending = visible.some(c => c.complete === null);
    const head = `<div class="pc3-board-head"><span>Signal</span><span>Change</span><span>Source</span><span>Entity</span><span>Market</span><span>Best main line ${tip('Best main line')}</span><span>PBE</span><span></span></div>`;
    const list = shown.length
      ? `<ol class="pc3-rows">${shown.map(row).join('')}</ol>${visible.length > shown.length ? `<div class="pc3-more-row"><button type="button" data-pc3-more>Show ${Math.min(PAGE(), visible.length - shown.length)} more</button><span>${shown.length} of ${visible.length} chains</span></div>` : `<div class="pc3-more-row"><span>${visible.length} chain${visible.length === 1 ? '' : 's'}${pending ? ' · reading player boards…' : ''}</span></div>`}`
      : `<div class="pc3-none"><b>No complete chains meet these filters</b><span>Every source answered. Nothing in this scope links a sourced change to a current market${ui.q ? ` for “${esc(ui.q)}”` : ''}. The verified context for this scope is below.</span></div>`;
    return `<section class="pc3-board" data-pc3-board aria-label="Intelligence chains">${shown.length ? head : ''}${list}</section>
      <div class="pc3-context" data-pc3-context>${contextHtml(model, data, shown.length)}</div>`;
  }

  /* ---- page states --------------------------------------------------------- */
  function skeleton() {
    return `<div class="pc3-strip is-skel" aria-hidden="true">${'<div class="pc3-stat"><b class="pc3-skel-block"></b><span class="pc3-skel-line"></span></div>'.repeat(6)}</div>
      <section class="pc3-board is-skel" aria-busy="true" aria-label="Loading chains"><ol class="pc3-rows">${'<li class="pc3-row"><div class="pc3-skel-row"><span class="pc3-skel-line"></span><span class="pc3-skel-line"></span><span class="pc3-skel-line"></span><span class="pc3-skel-line"></span></div></li>'.repeat(6)}</ol><p class="pc3-loading-note">Reading injury report, market tape, weather and player boards…</p></section>`;
  }
  function markup() {
    const slot = changesSlot();
    const data = changesData();
    if (!core()) return `<section class="pc3"><div class="pc3-error"><b>PropChain failed to load</b><span>The chain engine did not install. Refresh to retry.</span></div></section>`;
    if (!data) {
      if (slot?.error) return `<section class="pc3">${header(null)}${controls(null)}<div class="pc3-error" role="alert"><b>PropChain is unavailable</b><span>The change feed could not be read (${esc(slot.error)}). A failed read is shown as a failure, never as “nothing changed”.</span><button type="button" data-pc3-retry>Retry</button></div></section>`;
      return `<section class="pc3">${header(null)}${controls(null)}${skeleton()}</section>`;
    }
    const model = compute();
    const stale = slot?.error ? `<p class="pc3-banner" role="status">Showing data read ${esc(clock(data.generated_at))} ET — the latest refresh failed (${esc(slot.error)}).</p>` : '';
    return `<section class="pc3">${header(data)}${controls(data)}${stale}${strip(model, data)}${boardHtml(model, data)}</section>`;
  }

  /* ---- paint --------------------------------------------------------------- */
  function queuePaint() {
    if (paintQueued) return;
    paintQueued = true;
    queueMicrotask(() => { paintQueued = false; paint(); });
  }
  function paint() {
    if (!active()) return;
    const vc = document.getElementById('view-container'); if (!vc) return;
    const html = markup();
    const root = vc.querySelector('.pc3');
    if (root && root.dataset.sig === html) return;
    const focus = document.activeElement;
    const focusKey = focus?.closest?.('.pc3') ? (focus.matches('[data-pc3-q]') ? 'q' : focus.dataset?.pc3Open ? `open:${focus.dataset.pc3Open}` : focus.dataset?.pc3Set ? `set:${focus.dataset.pc3Set}` : focus.matches('[data-pc3-game]') ? 'game' : focus.matches('[data-pc3-sort]') ? 'sort' : null) : null;
    const caret = focusKey === 'q' ? [focus.selectionStart, focus.selectionEnd] : null;
    const y = window.scrollY;
    vc.innerHTML = html;
    const next = vc.querySelector('.pc3');
    if (next) next.dataset.sig = html;
    if (root) window.scrollTo(0, y);
    if (focusKey) {
      const sel = focusKey === 'q' ? '[data-pc3-q]' : focusKey === 'game' ? '[data-pc3-game]' : focusKey === 'sort' ? '[data-pc3-sort]' : focusKey.startsWith('open:') ? `[data-pc3-open="${CSS.escape(focusKey.slice(5))}"]` : `[data-pc3-set="${CSS.escape(focusKey.slice(4))}"]`;
      const el = next?.querySelector(sel);
      if (el) { el.focus({ preventScroll: true }); if (caret && el.setSelectionRange) try { el.setSelectionRange(caret[0], caret[1]); } catch (_) {} }
    }
    ensureBoards();
  }

  /* ---- lifecycle ------------------------------------------------------------ */
  function readParams() {
    const p = window.App?.params || {};
    if (p.game) ui.game = String(p.game);
    if (p.signal && ['all', 'injury', 'market', 'weather', 'news', 'game'].includes(p.signal)) ui.signal = p.signal;
    if (p.q) ui.q = String(p.q).slice(0, 60);
  }
  async function refreshAll(force = false) {
    await Promise.all([refreshChanges(force), refreshBestline(force), refreshNews(force), window.PBECard?.ensure?.()]);
    if (!active()) return;
    queuePaint();
    await ensureBoards();
  }
  function startTimer() {
    stopTimer();
    timer = setInterval(() => { if (active() && document.visibilityState === 'visible') refreshAll(); else stopTimer(); }, REFRESH_MS);
  }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  async function load() {
    readParams();
    paint();
    startTimer();
    await refreshAll();
    paint();
  }

  /* ---- actions -------------------------------------------------------------- */
  function chainById(id) { return lastModel?.chains.find(c => c.id === id) || null; }
  function setEventParam(oddsId, extra = {}) {
    if (!oddsId) return;
    try { localStorage.setItem('pbe_nfl_event', oddsId); } catch (_) {}
    const url = new URL(location.href);
    url.searchParams.set('event', oddsId);
    Object.entries(extra).forEach(([k, v]) => url.searchParams.set(k, v));
    history.replaceState(history.state, '', url);
  }
  function clearParams(keys) {
    const url = new URL(location.href);
    keys.forEach(k => url.searchParams.delete(k));
    history.replaceState(history.state, '', url);
  }
  async function openDna(c, button) {
    const pos = String(c.entity?.position || '').toUpperCase();
    const spec = DNA[pos];
    if (!spec || !c.entity?.espn_id) return;
    button?.setAttribute('aria-busy', 'true');
    try {
      if (!store.dna.has(pos)) store.dna.set(pos, getJson(spec.api).catch(e => { store.dna.delete(pos); throw e; }));
      const list = await store.dna.get(pos);
      const hit = arr(list?.players).find(p => String(p.espn_id) === String(c.entity.espn_id));
      const mod = window[spec.global];
      if (!hit || !mod?.state) { store.notice = { id: c.id, text: `No ${pos} DNA profile is published for ${c.entity.name}.` }; queuePaint(); return; }
      Object.assign(mod.state, { playerId: hit.gsis_id, players: list, dna: null, lab: null, cmp: null, ctxCmp: null, ctx: null, eventId: null, slatePick: null });
      window.App?.nav?.(spec.route);
    } catch (e) {
      store.notice = { id: c.id, text: `Player DNA could not be opened (${e?.message || e}).` }; queuePaint();
    } finally { button?.removeAttribute('aria-busy'); }
  }
  function act(kind, c, button) {
    const g = c.game || {};
    if (kind === 'dna') return openDna(c, button);
    if (kind === 'research') {
      const name = c.market?.board_name || c.entity?.name;
      if (typeof window.PBEPlayerResearch?.show === 'function') window.PBEPlayerResearch.show(name);
      return;
    }
    if (kind === 'marketwatch') {
      setEventParam(g.odds_event_id);
      if (window.PBEMarketWatch?.state) { window.PBEMarketWatch.state.search = c.entity?.type === 'PLAYER' ? (c.market?.board_name || c.entity.name) : ''; window.PBEMarketWatch.state.market = 'all'; }
      return window.App?.nav?.('marketwatch');
    }
    if (kind === 'bestline') {
      const props = c.market?.kind === 'PLAYER_PROPS';
      const market = props && BESTLINE_PROP_MARKETS.has(c.market.primary?.market) ? c.market.primary.market : 'player_pass_yds';
      /* Best Line reads ?event= / ?tab= / ?market= when its route renders, which
         happens synchronously inside nav; the tab and market params are then
         removed so they do not follow the reader to other routes. */
      setEventParam(g.odds_event_id, props ? { tab: 'props', market } : { tab: 'games' });
      window.App?.nav?.('bestline');
      clearParams(['tab', 'market']);
      return;
    }
    if (kind === 'matchup') { setEventParam(g.odds_event_id); return window.App?.nav?.('matchups'); }
    if (kind === 'pbecast') {
      return window.PBEGameHandoff?.open?.(g.id, { kickoff: g.date || g.kickoff || null, source: 'propchain' }) || window.App?.nav?.('pbecast');
    }
  }

  /* ---- events -------------------------------------------------------------- */
  document.addEventListener('click', e => {
    const root = e.target.closest?.('.pc3'); if (!root) return;
    const set = e.target.closest('[data-pc3-set]');
    if (set) {
      const [k, v] = set.dataset.pc3Set.split(':');
      ui[k] = v; ui.limit = 0;
      if (k === 'window') { refreshChanges().then(() => { ensureBoards(); queuePaint(); }); }
      if (k === 'signal' && v === 'news') refreshNews();
      paint(); return;
    }
    const open = e.target.closest('[data-pc3-open]');
    if (open) {
      const id = open.dataset.pc3Open;
      ui.open = ui.open === id ? null : id;
      store.notice = null;
      paint();
      if (ui.open) { const c = chainById(id); if (c?.model?.state === 'PENDING' && c.game?.odds_event_id) loadModel(c.game.odds_event_id); }
      return;
    }
    if (e.target.closest('[data-pc3-more]')) { ui.limit = (ui.limit || PAGE()) + PAGE(); paint(); return; }
    if (e.target.closest('[data-pc3-filters]')) { ui.filters = !ui.filters; paint(); return; }
    if (e.target.closest('[data-pc3-method]')) { ui.method = !ui.method; paint(); return; }
    if (e.target.closest('[data-pc3-retry]')) { refreshAll(true).then(paint); return; }
    if (e.target.closest('[data-pc3-pro]')) { window.PBEPro?.open?.('upgrade'); return; }
    const a = e.target.closest('[data-pc3-act]');
    if (a) { const c = chainById(a.dataset.id); if (c) act(a.dataset.pc3Act, c, a); }
  });
  let qTimer = null;
  document.addEventListener('input', e => {
    if (!e.target.matches?.('.pc3 [data-pc3-q]')) return;
    ui.q = e.target.value || ''; ui.limit = 0;
    clearTimeout(qTimer); qTimer = setTimeout(paint, 140);
  });
  document.addEventListener('change', e => {
    if (!e.target.closest?.('.pc3')) return;
    if (e.target.matches('[data-pc3-game]')) { ui.game = e.target.value; ui.open = null; ui.limit = 0; paint(); }
    if (e.target.matches('[data-pc3-sort]')) { ui.sort = e.target.value; paint(); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && active() && ui.open) {
      const id = ui.open; ui.open = null; paint();
      document.querySelector(`[data-pc3-open="${CSS.escape(id)}"]`)?.focus();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { stopTimer(); return; }
    if (active()) { startTimer(); refreshAll(); }
  });
  window.addEventListener('pbe:route-changed', ev => { if (ev?.detail?.route !== 'propchain') stopTimer(); });
  window.addEventListener('pbe:card-ready', () => { if (active()) queuePaint(); });
  window.addEventListener('pbe:pro-state', () => { store.models.clear(); if (active()) { window.PBECard?.ensure?.(true); queuePaint(); } });
  window.addEventListener('resize', () => { if (active()) queuePaint(); }, { passive: true });

  function install() {
    if (!window.App?.VIEWS) return false;
    window.App.VIEWS.propchain = load;
    return true;
  }
  window.PBEPropChain = { load, paint, ui, store, version: 3, model: () => lastModel, refreshing: () => Boolean(timer) };
  if (!install()) document.addEventListener('DOMContentLoaded', install, { once: true });
})();
