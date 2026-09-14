/* PropBetEdge NFL — BEST LINE (#bestline)
 *
 * Price shopping with standalone value: a reader who never opens the model
 * still leaves knowing where the best number is. Four quantities, four
 * columns, never merged:
 *
 *   BEST AVAILABLE PRICE  one sportsbook's quote — the best number, then the
 *                         best price at it
 *   MARKET CONSENSUS      median line; vig-free probability from books that
 *                         quote both sides at that line
 *   PBE FAIR VALUE        the model's own number, NFL Pro only, never derived
 *                         from consensus
 *   MODEL EDGE            exists only against a published fair value
 *
 * Game lines come from the nfl-intel Worker's /api/best-line (the nfl-odds snapshot, reshaped
 * side); their model columns are filled by best-line-model-overlay-v1.js from
 * the PBE Card evaluations. Player props come from the gateway board for the
 * one game and market the reader opens; nothing polls. Every price is a
 * scheduled capture and says so.
 *
 * Player props publish exactly one model: Passing Yards v1, the production
 * passing model Model Lab reads (/api/picks/pass, served through the NFL Pro
 * gate /api/pro-model). A reader without NFL Pro never requests it. Every other
 * player market is labelled NOT MODELED. Identity, photos and the pure market
 * rules live in best-line-props-core-v2.js.
 */
(() => {
  'use strict';

  const API = typeof NFL_API_GATEWAY !== 'undefined' ? NFL_API_GATEWAY : 'https://nfl-api.propbetedge.ai';
  const PROP_MARKETS = [
    ['player_pass_yds', 'Passing yards'], ['player_rush_yds', 'Rushing yards'], ['player_reception_yds', 'Receiving yards'],
    ['player_receptions', 'Receptions'], ['player_pass_tds', 'Passing TDs'], ['player_rush_attempts', 'Rush attempts'],
    ['player_pass_attempts', 'Pass attempts'], ['player_anytime_td', 'Anytime TD']
  ];
  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const arr = v => (Array.isArray(v) ? v : []);
  const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const american = v => { const n = num(v); return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${Math.round(n)}` : '—'; };
  const signed = v => { const n = num(v); return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n}` : '—'; };
  const pct = v => { const n = num(v); return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—'; };
  const payout = a => { const n = num(a); return Number.isFinite(n) && n !== 0 ? (n > 0 ? n / 100 : 100 / -n) : null; };
  const ET = { timeZone: 'America/New_York' };
  const when = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString('en-US', { ...ET, weekday: 'short', month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString('en-US', { ...ET, hour: 'numeric', minute: '2-digit' })} ET`; };
  function age(sec) { const s = num(sec); if (!Number.isFinite(s)) return ''; if (s < 3600) return `${Math.round(s / 60)}m old`; if (s < 86400) return `${(s / 3600).toFixed(1)}h old`; return `${Math.round(s / 86400)}d old`; }

  const narrow = () => window.matchMedia?.('(max-width: 768px)').matches;
  const openGames = new Set();
  /* The folded line a phone reader scans: consensus spread and total. */
  function summaryLine(e) {
    const sp = Object.values(e.markets?.spread || {}).filter(Boolean).find(s => num(s?.consensus?.line) < 0);
    const tot = e.markets?.total?.OVER?.consensus?.line;
    return [sp ? `${abbr(sp.side)} ${sp.consensus.line}` : null, tot != null ? `O/U ${tot}` : null, 'Tap for best prices'].filter(Boolean).join(' · ');
  }
  const state = {
    tab: 'games', event: null, market: 'player_pass_yds', props: new Map(), propBusy: false, propError: null,
    search: '', sort: 'books', open: new Set(), identity: { status: 'idle' }, models: new Map(), failedPhotos: new Set()
  };
  const cc = () => window.PBECommandCenter;
  const lines = () => cc()?.store?.bestline || { data: null, error: 'command_center_not_loaded' };
  const mounted = () => window.App?.current === 'bestline' && Boolean(document.querySelector('.pbebl'));

  /* ---- shared pieces ------------------------------------------------------ */
  function freshness(d) {
    if (!d) return '';
    const failed = d.ingest?.status === 'LATEST_INGEST_UNAVAILABLE';
    return `<p class="pbebl-fresh ${failed ? 'is-stale' : ''}"><b>${failed ? 'LAST VERIFIED MARKET' : 'MARKET SNAPSHOT'}</b> · CAPTURED ${esc(d.captured_at_et || when(d.captured_at))} · ${esc(age(d.age_seconds))}${failed ? ' · <b>LATEST INGEST UNAVAILABLE</b>' : ''} · SCHEDULED CAPTURE, NOT LIVE</p>`;
  }
  function legend() {
    const t = (key, name, text, cls = '') => `<div data-term="${key}" class="${cls}"><b>${esc(name)}</b><p>${esc(text)}</p></div>`;
    return `<div class="pbebl-legend" aria-label="What each number means">
      ${t('best', 'Best available price', 'The best number a single sportsbook is offering, then the best price at that number. Named book, captured time.')}
      ${t('consensus', 'Market consensus', 'The median line across books, and the vig-free probability from books quoting both sides at that line. A description of the market, not an opinion.')}
      ${t('fair', 'PBE fair value', 'The PropBetEdge model’s own number, for NFL Pro, and never estimated from consensus. Blank wherever the model has no current evaluation.', 'is-model')}
      ${t('edge', 'Model edge', 'Fair value against the price on offer. It exists only where a fair value is published, so it is blank here by design.', 'is-model')}
    </div>`;
  }
  function tabs() {
    const b = (k, l) => `<button type="button" role="tab" aria-selected="${state.tab === k}" class="${state.tab === k ? 'is-on' : ''}" data-bl-tab="${k}">${esc(l)}</button>`;
    return `<div class="pbebl-tabs" role="tablist">${b('games', 'Game lines')}${b('props', 'Player props')}</div>`;
  }

  /* ---- game lines --------------------------------------------------------- */
  function abbr(name) {
    const games = arr(window.PBEDashboardV7?.state?.scoreboard?.games);
    const n = String(name || '').toLowerCase();
    for (const g of games) for (const t of [g?.teams?.away, g?.teams?.home]) if (String(t?.display_name || '').toLowerCase() === n) return t.abbreviation;
    return String(name || '').split(' ').slice(-1)[0];
  }
  function sideLabel(market, s) {
    if (market === 'total') return s.side === 'OVER' ? 'Over' : 'Under';
    return abbr(s.side);
  }
  function bestCell(market, s) {
    if (!s?.best) return '<span class="pbebl-na">—</span>';
    const lineText = market === 'moneyline' ? '' : `<b>${market === 'spread' ? signed(s.best.line) : s.best.line}</b> `;
    return `${lineText}<span class="pbebl-price">${american(s.best.price)}</span><small>${esc(s.best.book)}</small>`;
  }
  function beats(market, s) {
    if (!s?.best || !s.consensus) return false;
    if (market === 'moneyline') return payout(s.best.price) > payout(s.consensus.price);
    const b = num(s.best.line), c = num(s.consensus.line);
    if (market === 'total') return s.side === 'OVER' ? b < c : b > c;
    return b > c;
  }
  function coverageNote(e, market, s) {
    const coverage = s?.coverage || {};
    const eventBooks = Number.isFinite(num(coverage.event_book_count)) ? num(coverage.event_book_count) : num(e?.books);
    const marketBooks = Number.isFinite(num(coverage.market_book_count)) ? num(coverage.market_book_count) : num(s?.book_count);
    if (!Number.isFinite(eventBooks) || !Number.isFinite(marketBooks) || marketBooks >= eventBooks) return '';
    const missing = Math.max(0, eventBooks - marketBooks);
    const pickem = arr(coverage.pickem_spread_books);
    if (market === 'moneyline' && pickem.length) {
      const who = pickem.length <= 4 ? `: ${pickem.join(', ')}` : '';
      return `${pickem.length} ${pickem.length === 1 ? 'book prices' : 'books price'} this matchup as PK/0 spread instead of an explicit moneyline${who}`;
    }
    return `${missing} ${missing === 1 ? 'snapshot book does' : 'snapshot books do'} not quote this market`;
  }
  function row(e, market, s) {
    if (!s) return '';
    const range = s.line_range && s.line_range.low !== s.line_range.high ? `${market === 'spread' ? signed(s.line_range.low) : s.line_range.low} to ${market === 'spread' ? signed(s.line_range.high) : s.line_range.high}` : s.line_range ? 'All books agree' : `${american(s.price_range.low)} to ${american(s.price_range.high)}`;
    const coverage = coverageNote(e, market, s);
    return `<tr class="pbebl-row${beats(market, s) ? ' is-better' : ''}">
      <th scope="row"><span>${esc(market === 'moneyline' ? 'Moneyline' : market === 'spread' ? 'Spread' : 'Total')}</span>${esc(sideLabel(market, s))}</th>
      <td data-label="Best available">${bestCell(market, s)}${beats(market, s) ? '<em class="pbebl-flag">BEATS CONSENSUS</em>' : ''}</td>
      <td data-label="Consensus">${market === 'moneyline' ? american(s.consensus.price) : `<b>${market === 'spread' ? signed(s.consensus.line) : s.consensus.line}</b> <span class="pbebl-price">${american(s.consensus.price)}</span>`}<small>${s.consensus.no_vig_probability != null ? `${pct(s.consensus.no_vig_probability)} vig-free · ${esc(s.consensus.no_vig_books)} bk` : 'no two-sided books at this line'}</small></td>
      <td data-label="Range">${esc(range)}<small>${esc(s.book_count)} books${coverage ? ` · ${esc(coverage)}` : ''}</small></td>
      <td data-label="PBE fair" class="pbebl-model"><span class="pbebl-na">—</span></td>
      <td data-label="Model edge" class="pbebl-model"><span class="pbebl-na">—</span></td>
    </tr>`;
  }
  function gameCard(e) {
    const m = e.markets || {};
    const order = [['spread', m.spread], ['total', m.total], ['moneyline', m.moneyline]];
    const rows = order.flatMap(([k, sides]) => Object.values(sides || {}).filter(Boolean).map(s => row(e, k, s))).join('');
    const ladders = order.map(([k, sides]) => Object.values(sides || {}).filter(Boolean).map(s => `<div class="pbebl-ladder"><h4>${esc(k)} · ${esc(sideLabel(k, s))}</h4><ol>${arr(s.quotes).map((q, i) => `<li class="${i === 0 ? 'is-top' : ''}"><span>${esc(q.book)}</span><b>${k === 'moneyline' ? '' : `${k === 'spread' ? signed(q.line) : q.line} `}${american(q.price)}</b></li>`).join('')}</ol></div>`).join('')).join('');
    return `<article class="pbebl-game${e.started ? ' is-started' : ''}" id="bl-${esc(e.id)}">
      <header><div><b>${esc(abbr(e.away))} @ ${esc(abbr(e.home))}</b><span>${esc(e.away)} at ${esc(e.home)}</span></div><div class="pbebl-game-meta"><span>${esc(when(e.kickoff))}</span><span>${esc(e.books)} books in snapshot</span>${e.started ? '<span class="pbebl-started">KICKED OFF · PRE-GAME CAPTURE, NOT A CURRENT PRICE</span>' : ''}<button type="button" data-bl-props="${esc(e.id)}">Player props →</button></div></header>
      <details class="pbebl-body"${narrow() && !openGames.has(e.id) ? '' : ' open'} data-bl-game="${esc(e.id)}"><summary>${esc(summaryLine(e))}</summary>
      <div class="pbebl-scroll"><table class="pbebl-table"><thead><tr><th scope="col">Market</th><th scope="col">Best available</th><th scope="col">Consensus</th><th scope="col">Line range</th><th scope="col" class="pbebl-model">PBE fair</th><th scope="col" class="pbebl-model">Model edge</th></tr></thead><tbody>${rows}</tbody></table></div>
      <details class="pbebl-books"><summary>Every book, every number</summary><div class="pbebl-ladders">${ladders}</div></details></details>
    </article>`;
  }
  function leaderboard(d) {
    const rows = arr(d?.book_leaderboard).slice(0, 8);
    if (!rows.length) return '';
    const max = rows[0].best_count || 1;
    return `<aside class="pbebl-board"><span class="pbebl-eyebrow">WHO HELD THE BEST PRICE</span><p>Count of spread, total and moneyline sides where the book matched the best available number and price across the open slate. Ties share credit.</p><ol>${rows.map(r => `<li><span>${esc(r.book)}</span><i style="--w:${(r.best_count / max * 100).toFixed(0)}%"></i><b>${esc(r.best_count)}</b></li>`).join('')}</ol></aside>`;
  }
  function gamesHtml(d) {
    const events = arr(d?.events);
    if (!events.length) return '<div class="pbebl-unavailable"><b>No games in the snapshot window</b><span>The market snapshot carries no NFL games in the next eight days.</span></div>';
    const currentWeek = Number.isFinite(num(d?.current_week)) ? num(d.current_week) : null;
    const groups = new Map();
    for (const e of events) {
      const week = Number.isFinite(num(e?.week)) ? num(e.week) : null;
      const key = week === null ? 'snapshot' : String(week);
      if (!groups.has(key)) groups.set(key, { week, events: [] });
      groups.get(key).events.push(e);
    }
    const ordered = [...groups.values()].sort((a, b) => {
      if (a.week === null) return 1;
      if (b.week === null) return -1;
      return a.week - b.week;
    });
    const cards = ordered.map(group => {
      const label = group.week === null ? 'SNAPSHOT' : `WEEK ${group.week}`;
      const context = group.week === null || currentWeek === null ? ''
        : group.week === currentWeek ? 'CURRENT SLATE'
          : group.week > currentWeek ? 'LOOKAHEAD' : 'PREVIOUS WEEK';
      return `<section class="pbebl-week" data-week="${group.week ?? 'unknown'}"><div class="pbebl-week-head"><b>${esc(label)}</b>${context ? `<span>${esc(context)}</span>` : ''}</div>${group.events.map(gameCard).join('')}</section>`;
    }).join('');
    return `<div class="pbebl-layout"><div class="pbebl-games">${cards}</div>${leaderboard(d)}</div>`;
  }

  /* ---- player props ------------------------------------------------------- */
  const core = () => window.PBEBestLinePropsCore;
  const marketLabel = k => PROP_MARKETS.find(m => m[0] === k)?.[1] || 'Player market';
  const one = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const line = v => (Number.isFinite(num(v)) ? String(num(v)) : '—');
  const oneDp = v => { const n = num(v); return Number.isFinite(n) ? `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}` : '—'; };
  const minutesOld = at => { const t = Date.parse(at || ''); return Number.isFinite(t) ? age(Math.max(0, Math.floor((Date.now() - t) / 60000) * 60)) : ''; };
  const kickoffLine = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : [d.toLocaleDateString('en-US', { ...ET, weekday: 'short' }), d.toLocaleDateString('en-US', { ...ET, month: 'short', day: 'numeric' }), `${d.toLocaleTimeString('en-US', { ...ET, hour: 'numeric', minute: '2-digit' })} ET`].join(' · ').toUpperCase(); };
  const teamLogo = code => (code ? window.PBENFLMediaV2?.teamLogo?.(code) || '' : '');
  const proState = () => window.PBEPro?.state || { pro: false, loading: false };
  const rowKey = player => `${state.event}|${state.market}|${player}`;
  function propKey() { return `${state.event}|${state.market}`; }

  async function loadProps() {
    if (!state.event || state.props.has(propKey()) || state.propBusy) return;
    state.propBusy = true; state.propError = null; paint();
    const key = propKey();
    try {
      const r = await fetch(`${API}/api/odds/board?event_id=${encodeURIComponent(state.event)}&markets=${encodeURIComponent(state.market)}`, { cache: 'no-store', headers: { accept: 'application/json' } });
      const body = await r.json().catch(() => null);
      if (!r.ok || !body) throw new Error(body?.error || String(r.status));
      state.props.set(key, body);
    } catch (e) { state.propError = e instanceof Error ? e.message : String(e); }
    finally { state.propBusy = false; if (mounted()) paint(); }
  }

  /* Identity spine: the Player DNA 2026 roster lists, read once per page. Their
     media blocks are built by api/_playerdna/media.js from the stable ESPN
     athlete id, so a face is attached only to the athlete it belongs to. */
  async function loadIdentity() {
    if (state.identity.status !== 'idle' || !core()) return;
    state.identity = { status: 'loading' };
    const lists = await Promise.all(core().POSITIONS.map(async p => {
      try {
        const r = await fetch(p.api, { headers: { accept: 'application/json' } });
        return { ...p, body: r.ok ? await r.json() : null };
      } catch (_) { return { ...p, body: null }; }
    }));
    const built = core().identityIndex(lists);
    state.identity = { status: 'ready', ...built, failed: lists.filter(l => !built.loaded.includes(l.position)).map(l => l.position) };
    if (mounted()) paint();
  }

  /* The production passing model, exactly as Model Lab reads it. paywall.js
     routes this URL through /api/pro-model, which checks NFL Pro on the server;
     a reader without Pro never makes the request, so no model value reaches
     their browser. */
  async function loadModel(eventId) {
    if (!eventId || state.models.has(eventId) || proState().pro !== true) return;
    state.models.set(eventId, { status: 'loading' });
    let result;
    try {
      const r = await fetch(`${API}/api/picks/pass?event_id=${encodeURIComponent(eventId)}`, { cache: 'no-store', headers: { accept: 'application/json' } });
      result = { status: r.status, body: r.ok ? await r.json().catch(() => null) : null };
    } catch (_) { result = { status: 0, body: null }; }
    if (proState().pro !== true) { state.models.delete(eventId); return; }
    state.models.set(eventId, result);
    if (mounted()) paint();
  }

  function venueFor(ev) {
    const away = core().teamCode(ev.away), home = core().teamCode(ev.home), kick = Date.parse(ev.kickoff || '');
    const g = arr(window.PBEDashboardV7?.state?.scoreboard?.games).find(x =>
      core().teamCode(x?.teams?.away?.abbreviation) === away && core().teamCode(x?.teams?.home?.abbreviation) === home
      && Math.abs(Date.parse(x?.date || '') - kick) < 12 * 3600 * 1000);
    return g?.venue?.name ? [g.venue.name, [g.venue.city, g.venue.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') : '';
  }

  function matchStrip(ev, board, m) {
    const team = (name, where) => {
      const code = core().teamCode(name), logo = teamLogo(code);
      return `<div class="pbeblp-team is-${where}">${logo ? `<img src="${esc(logo)}" alt="" width="56" height="56" decoding="async">` : '<span class="pbeblp-crest-gap" aria-hidden="true"></span>'}<span><small>${esc(name)}</small><b>${esc(code || name)}</b></span></div>`;
    };
    const venue = venueFor(ev);
    const at = m?.captured_at || lines().data?.captured_at;
    const atEt = m?.captured_at_et || (m ? '' : lines().data?.captured_at_et);
    const failed = m ? m.ingest_failed : lines().data?.ingest?.status === 'LATEST_INGEST_UNAVAILABLE';
    const head = m?.started ? 'PRE-GAME CAPTURE' : m?.retained ? 'LAST VERIFIED PRE-GAME CAPTURE' : failed ? 'LAST VERIFIED MARKET' : 'MARKET SNAPSHOT';
    const snap = at
      ? `<b>Captured ${esc(atEt || when(at))}</b><span>${esc(minutesOld(at))}${failed ? ' · latest ingest unavailable' : ''}</span><span>Scheduled capture · not live</span>`
      : `<b>${board ? 'Capture time not recorded' : 'Reading capture time…'}</b><span>Scheduled capture · not live</span>`;
    return `<section class="pbeblp-match" aria-label="Selected game">
      ${team(ev.away, 'away')}
      <div class="pbeblp-at"><b aria-label="at">@</b><span>${esc(kickoffLine(ev.kickoff))}</span>${venue ? `<span class="pbeblp-venue">${esc(venue)}</span>` : ''}</div>
      ${team(ev.home, 'home')}
      <div class="pbeblp-snap${failed || m?.started ? ' is-stale' : ''}" data-blp-captured="${esc(at || '')}"><span class="pbebl-eyebrow">${esc(head)}</span>${snap}</div>
    </section>`;
  }

  function controls(events, rowsKnown) {
    const yes = state.market === 'player_anytime_td';
    const chip = ([k, l]) => {
      const b = state.props.get(`${state.event}|${k}`);
      const count = b ? core().playerRows(b, k).length : null;
      return `<button type="button" data-bl-market="${k}" aria-pressed="${k === state.market}" class="${k === state.market ? 'is-on' : ''}">${esc(l)}${count === null ? '' : `<i>${count}</i>`}</button>`;
    };
    const sorts = [['books', 'Most books'], ['name', 'Player A–Z'], ...(yes ? [] : [['consensus', 'Consensus line']])];
    return `<div class="pbeblp-controls">
      <label class="pbeblp-field pbeblp-game"><span>Game</span><select data-bl-event>${events.map(e => `<option value="${esc(e.id)}"${e.id === state.event ? ' selected' : ''}>${esc(core().teamCode(e.away) || e.away)} @ ${esc(core().teamCode(e.home) || e.home)} · ${esc(when(e.kickoff))}</option>`).join('')}</select></label>
      <div class="pbeblp-field pbeblp-market-field" role="group" aria-labelledby="pbeblp-market-label"><span id="pbeblp-market-label">Market</span><div class="pbeblp-chips">${PROP_MARKETS.map(chip).join('')}</div></div>
      <div class="pbeblp-tools"${rowsKnown ? '' : ' aria-disabled="true"'}>
        <label class="pbeblp-field pbeblp-search"><span>Search player</span><input type="search" data-blp-search placeholder="Name" autocomplete="off" value="${esc(state.search)}"></label>
        <label class="pbeblp-field"><span>Sort</span><select data-blp-sort>${sorts.map(([k, l]) => `<option value="${k}"${k === (yes && state.sort === 'consensus' ? 'books' : state.sort) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      </div>
    </div>`;
  }

  function stateBox(kind, title, text, extra = '') {
    return `<div class="pbeblp-state is-${kind}" role="status"><b>${esc(title)}</b><span>${esc(text)}</span>${extra}</div>`;
  }

  /* ---- one player ---------------------------------------------------------- */
  function identityOf(row, ev) {
    if (row.outcome) return { status: 'outcome' };
    if (state.identity.status !== 'ready') return { status: 'loading' };
    return core().resolveIdentity(state.identity, row.player, ev);
  }

  function playerCell(row, id) {
    let photo, meta, intel = '';
    if (row.outcome?.kind === 'team_defense') {
      const logo = teamLogo(row.outcome.team);
      photo = logo ? `<span class="pbeblp-photo is-crest"><img src="${esc(logo)}" alt="" width="56" height="56" loading="lazy" decoding="async"></span>` : '<span class="pbeblp-photo is-outcome" aria-hidden="true"><i>D/ST</i></span>';
      meta = `${row.outcome.team ? `${esc(row.outcome.team)} · ` : ''}Team defense`;
    } else if (row.outcome) {
      photo = '<span class="pbeblp-photo is-outcome" aria-hidden="true"><i>∅</i></span>';
      meta = 'Market outcome · not a player';
    } else if (id.status === 'verified') {
      const ok = id.headshot_url && !state.failedPhotos.has(id.espn_id);
      photo = ok
        ? `<span class="pbeblp-photo"><img src="${esc(id.headshot_url)}" alt="${esc(id.name)} headshot" width="56" height="56" loading="lazy" decoding="async" data-blp-espn="${esc(id.espn_id)}"></span>`
        : '<span class="pbeblp-photo is-missing" role="img" aria-label="Photo unavailable"><i aria-hidden="true">Photo<br>unavailable</i></span>';
      const logo = teamLogo(id.team);
      meta = `${logo ? `<img class="pbeblp-mini-crest" src="${esc(logo)}" alt="" width="16" height="16" loading="lazy" decoding="async">` : ''}${esc(id.team)} · ${esc(id.position)}`;
      if (id.gsis_id && id.route) intel = `<button type="button" class="pbeblp-intel" data-blp-intel="${esc(id.route)}" data-blp-gsis="${esc(id.gsis_id)}">Player intelligence <span aria-hidden="true">→</span></button>`;
    } else {
      photo = '<span class="pbeblp-photo is-missing" role="img" aria-label="Photo unavailable"><i aria-hidden="true">Photo<br>unavailable</i></span>';
      meta = id.status === 'loading' ? 'Verifying identity…'
        : id.status === 'ambiguous' ? 'Identity ambiguous · no photo'
          : id.status === 'not_on_event_roster' ? 'Roster team not confirmed · no photo'
            : state.identity.failed?.length === core().POSITIONS.length ? 'Identity source unavailable'
              : 'Identity not verified · no photo';
    }
    return `<div class="pbeblp-player">${photo}<div class="pbeblp-who"><b class="pbeblp-name">${esc(row.player)}</b><span class="pbeblp-meta${id.status === 'verified' || row.outcome ? '' : ' is-unverified'}">${meta}</span>${intel}</div></div>`;
  }

  function bestCell(label, q, kickedOff, yesNo) {
    const head = `<span class="pbeblp-label">${esc(kickedOff ? `${label} · pre-game` : label)}</span>`;
    if (!q) return `<div class="pbeblp-cell pbeblp-best is-empty">${head}<span class="pbeblp-na">No quote</span></div>`;
    return `<div class="pbeblp-cell pbeblp-best">${head}<span class="pbeblp-num">${yesNo ? '' : `<b class="pbeblp-line">${esc(line(q.point))}</b>`}<span class="pbeblp-price">${esc(american(q.price))}</span></span><span class="pbeblp-book">${esc(q.book)}</span></div>`;
  }

  function modelCell(row, eventId) {
    const s = core().modelState(state.market, { pro: proState(), load: state.models.get(eventId) }, row.player, eventId);
    const box = (kind, title, text, extra = '') => `<div class="pbeblp-cell pbeblp-model is-${kind}" data-blp-model="${kind}"><span class="pbeblp-label">PBE model</span><b>${esc(title)}</b><span>${esc(text)}</span>${extra}</div>`;
    if (row.outcome && s.kind !== 'not_modeled') return box('not_modeled', 'Not modeled', 'Market outcome · pricing only');
    switch (s.kind) {
      case 'not_modeled': return box('not_modeled', 'Not modeled', 'Market pricing only');
      case 'locked': return box('locked', 'NFL Pro', 'PBE fair line · model probability · fair-line gap', '<button type="button" data-blp-unlock>Unlock</button>');
      case 'checking': return box('pending', 'Checking access…', 'NFL Pro model layer');
      case 'loading': return box('pending', 'Reading model…', 'Passing Yards v1');
      case 'service_unavailable': return box('unavailable', 'Model unavailable', 'Model service did not answer · nothing estimated');
      case 'inputs_unavailable': return box('unavailable', 'Model unavailable', s.reason === 'insufficient_history' ? 'Required inputs unavailable · not enough NFL passing history' : 'Required production inputs unavailable');
      case 'not_published': return box('gated', 'Model validation', 'Not published');
      case 'not_evaluated': return box('unavailable', 'Not evaluated', 'No model evaluation for this player');
      default: {
        const moved = s.consensus !== null && row.consensus !== null && s.consensus !== row.consensus;
        return `<div class="pbeblp-cell pbeblp-model is-ready" data-blp-model="ready" data-blp-fair="${esc(s.fair_line)}" data-blp-gap="${esc(s.gap ?? '')}" data-blp-prob="${esc(s.over_pct ?? '')}" data-blp-version="${esc(s.model_version || '')}">
          <span class="pbeblp-label">PBE fair</span><b class="pbeblp-fair">${esc(s.fair_line.toFixed(1))}<small> YDS</small></b>
          <dl><div><dt>Model gap</dt><dd>${esc(oneDp(s.gap))} yds</dd></div><div><dt>Model over</dt><dd>${s.over_pct === null ? '—' : `${esc(s.over_pct.toFixed(1))}%`}${s.consensus === null ? '' : ` at ${esc(line(s.consensus))}`}</dd></div></dl>
          <span class="pbeblp-prov">${esc([s.model_version, s.decision_status && s.decision_status.replace(/_/g, ' ').toLowerCase()].filter(Boolean).join(' · '))}</span>
          ${moved ? `<span class="pbeblp-prov is-warn">Evaluated at consensus ${esc(line(s.consensus))}; board now ${esc(line(row.consensus))}</span>` : ''}
          <button type="button" class="pbeblp-intel" data-blp-modellab="${esc(eventId)}">Model Lab <span aria-hidden="true">→</span></button>
        </div>`;
      }
    }
  }

  function ladderHtml(board, row, panelId, kickedOff) {
    const rungs = core().ladder(row);
    const yesNo = row.market === 'player_anytime_td';
    const missing = core().booksNotQuoting(board, row);
    const tag = t => `<em class="pbeblp-tag"><span class="pbeblp-wide">${esc(kickedOff ? `${t} · pre-game` : t)}</span><span class="pbeblp-narrow">${kickedOff ? 'Best · pre' : 'Best'}</span></em>`;
    /* rows are keyed by book and line, so both line columns carry that row's
       line; a side the book did not quote says so instead of borrowing a price */
    const sideCells = (q, rungLine, best, t, cls) => `<td class="${cls}${best ? ' is-best' : ''}">${esc(line(rungLine))}</td>${q
      ? `<td class="${best ? 'is-best' : ''}"><span class="pbeblp-price">${esc(american(q.price))}</span>${best ? tag(t) : ''}</td>`
      : '<td class="pbeblp-na">Not quoted</td>'}`;
    const body = yesNo
      ? rungs.map(r => `<tr><th scope="row">${esc(r.book)}</th><td class="${r.bestYes ? 'is-best' : ''}"><span class="pbeblp-price">${esc(american(r.yes.price))}</span>${r.bestYes ? tag('Best yes') : ''}</td></tr>`).join('')
      : rungs.map(r => `<tr><th scope="row">${esc(r.book)}</th>${sideCells(r.over, r.line, r.bestOver, 'Best over', 'is-oline')}${sideCells(r.under, r.line, r.bestUnder, 'Best under', 'is-uline')}</tr>`).join('');
    const head = yesNo
      ? '<th scope="col">Book</th><th scope="col">Yes price</th>'
      : '<th scope="col">Book</th><th scope="col" class="is-oline"><span class="pbeblp-wide">Over line</span><span class="pbeblp-narrow">Line</span></th><th scope="col"><span class="pbeblp-wide">Over price</span><span class="pbeblp-narrow">Over</span></th><th scope="col" class="is-uline">Under line</th><th scope="col"><span class="pbeblp-wide">Under price</span><span class="pbeblp-narrow">Under</span></th>';
    return `<div class="pbeblp-ladder" id="${panelId}"${state.open.has(rowKey(row.player)) ? '' : ' hidden'}>
      <p class="pbeblp-ladder-head"><b>Every quote</b><span>${esc(one(row.quotes.length, 'quote'))} from ${esc(one(row.books.length, 'book'))} · raw sportsbook prices, not vig-free</span></p>
      <div class="pbeblp-ladder-scroll"><table><caption class="pbeblp-sr">${esc(`${row.player} · ${marketLabel(row.market)} · every book`)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
      ${missing.length ? `<p class="pbeblp-ladder-foot">Carry ${esc(marketLabel(row.market).toLowerCase())} but did not quote ${esc(row.player)}: ${esc(missing.join(', '))}</p>` : ''}
    </div>`;
  }

  function rowHtml(board, row, ev, i, m) {
    const yesNo = row.market === 'player_anytime_td';
    const id = identityOf(row, ev);
    const panelId = `pbeblp-l-${i}`;
    const open = state.open.has(rowKey(row.player));
    const offered = m.snapshot_books.length;
    const consensus = yesNo
      ? `<div class="pbeblp-cell pbeblp-cons"><span class="pbeblp-label">Price range</span><b>${row.priceLow === null ? '—' : esc(row.priceLow === row.priceHigh ? american(row.priceHigh) : `${american(row.priceLow)} to ${american(row.priceHigh)}`)}</b></div>`
      : `<div class="pbeblp-cell pbeblp-cons"><span class="pbeblp-label">Consensus</span><b>${esc(line(row.consensus))}</b><small>${row.lineLow !== null && row.lineHigh !== null ? (row.lineLow === row.lineHigh ? 'All books agree' : `Range ${esc(line(row.lineLow))}–${esc(line(row.lineHigh))}`) : 'Median line'}</small></div>`;
    return `<li class="pbeblp-row${id.status === 'verified' ? ` is-${esc(id.team.toLowerCase())}` : ''}" data-blp-player="${esc(row.player)}" data-blp-identity="${esc(id.status)}"${id.espn_id ? ` data-blp-espn-id="${esc(id.espn_id)}" data-blp-team="${esc(id.team)}"` : ''}>
      ${playerCell(row, id)}
      ${yesNo ? bestCell('Best yes', row.yes, m.started, true) : `${bestCell('Best over', row.over, m.started, false)}${bestCell('Best under', row.under, m.started, false)}`}
      ${consensus}
      <div class="pbeblp-cell pbeblp-books"><span class="pbeblp-label">Books</span><b>${esc(one(row.books.length, 'book').toUpperCase())}</b>${offered && offered > row.books.length ? `<small>of ${offered} carrying this market</small>` : ''}<button type="button" data-blp-toggle="${panelId}" aria-controls="${panelId}" aria-expanded="${open}">${open ? 'Hide books' : 'View all books'}</button></div>
      ${modelCell(row, ev.id)}
      ${ladderHtml(board, row, panelId, m.started)}
    </li>`;
  }

  function resultsHtml(board, ev, m) {
    const yesNo = state.market === 'player_anytime_td';
    const all = core().playerRows(board, state.market);
    const rows = core().sortRows(core().filterRows(all, state.search), yesNo && state.sort === 'consensus' ? 'books' : state.sort);
    const quotes = all.reduce((n, r) => n + r.quotes.length, 0);
    const summary = `${yesNo ? 'Yes prices only · American odds are not averaged into a consensus · ' : ''}${one(all.filter(r => !r.outcome).length, 'player')}${all.some(r => r.outcome) ? ` + ${one(all.filter(r => r.outcome).length, 'outcome')}` : ''} · ${one(quotes, 'quote')} · ${one(m.snapshot_books.length || new Set(all.flatMap(r => r.books)).size, 'book')} in market`;
    const pre = m.started ? ' · pre-game' : '';
    const cols = yesNo
      ? `<span>Player</span><span>Best yes${pre}</span><span>Price range</span><span>Books</span><span class="is-model">PBE model</span>`
      : `<span>Player</span><span>Best over${pre}</span><span>Best under${pre}</span><span>Consensus</span><span>Books</span><span class="is-model">PBE model</span>`;
    const list = rows.length
      ? `<ol class="pbeblp-list${yesNo ? ' is-yes' : ''}">${rows.map((r, i) => rowHtml(board, r, ev, i, m)).join('')}</ol>`
      : stateBox('empty', 'No player matches', `No quoted player matches “${state.search}”.`);
    return `<div data-blp-results><p class="pbeblp-count" aria-live="polite">${esc(summary)}${state.search ? ` · ${esc(one(rows.length, 'match'))}` : ''}</p>
      <div class="pbeblp-colhead${yesNo ? ' is-yes' : ''}" aria-hidden="true">${cols}</div>${list}</div>`;
  }

  function modelBanner() {
    if (state.market !== core().MODELED_MARKET) return '<p class="pbeblp-modelnote"><b>PBE model</b> Passing Yards is the only modeled player market. This market is sportsbook pricing only.</p>';
    const pro = proState();
    if (pro.pro !== true) return `<div class="pbeblp-modelnote is-locked"><span><b>NFL Pro</b> Unlock the PBE fair line, model probability and fair-line gap from the production Passing Yards model.</span><button type="button" data-blp-unlock>Unlock NFL Pro${window.PBEPricing ? ` · ${esc(window.PBEPricing.ctaSuffix)}` : ''}</button></div>`;
    return '<p class="pbeblp-modelnote is-pro"><b>PBE model · NFL Pro</b> Fair line and model probability come from the production Passing Yards model Model Lab reads. The gap is fair line minus consensus — context, not a pick.</p>';
  }

  function infoHtml() {
    return `<details class="pbeblp-info"><summary>How best prices are chosen</summary><div><p><b>Best over</b> is the lowest line on offer, then the best price at that line. <b>Best under</b> is the highest line, then the best price. <b>Best yes</b> is the best price.</p><p>This is price shopping, not a recommendation to bet either side. Prices are raw sportsbook quotes, not vig-free, and every number is a scheduled capture — never live.</p></div></details>`;
  }

  function propsHtml(d) {
    if (!core()) return `<div class="pbeblp">${stateBox('error', 'Player props unavailable', 'The player-props module did not load. Game lines are unaffected.')}</div>`;
    const now = Date.now();
    const events = arr(d?.events).filter(e => !e.started && !(Date.parse(e.kickoff || '') <= now));
    if ((!state.event || !events.some(e => e.id === state.event)) && events.length) state.event = events[0].id;
    const ev = events.find(e => e.id === state.event);
    if (!ev) return `<div class="pbeblp">${stateBox('empty', 'No open games in the snapshot', 'Player prices appear once a game is inside the scheduled ingest window. Games that have kicked off are not shown as current prices.')}</div>`;
    if (state.identity.status === 'idle') queueMicrotask(loadIdentity);
    if (state.market === core().MODELED_MARKET && proState().pro === true && !state.models.has(ev.id)) queueMicrotask(() => loadModel(ev.id));

    const board = state.props.get(propKey());
    const m = board ? core().marketState(board, state.market, now) : null;
    const rowsKnown = Boolean(board && m?.served && core().playerRows(board, state.market).length);
    let body;
    if (!board) {
      if (state.propError) body = stateBox('error', 'Gateway unavailable', 'The market gateway did not return this board. No price is shown rather than a guess.', '<button type="button" data-blp-retry>Retry</button>');
      else {
        queueMicrotask(loadProps);
        body = `${stateBox('loading', 'Reading player market…', `${marketLabel(state.market)} · ${core().teamCode(ev.away)} @ ${core().teamCode(ev.home)}`)}<ol class="pbeblp-list is-skeleton" aria-hidden="true">${'<li class="pbeblp-row"></li>'.repeat(3)}</ol>`;
      }
    } else if (m.availability === core().AVAILABILITY.never) {
      body = stateBox('empty', 'Market not posted', `Books were not offering ${marketLabel(state.market).toLowerCase()} for this game when the snapshot was captured.`);
    } else if (m.availability === core().AVAILABILITY.notRequested) {
      body = stateBox('empty', 'Market not requested by ingest', 'This market is not part of the scheduled market ingest.');
    } else if (!m.served) {
      body = stateBox('error', 'Market unavailable', 'The snapshot did not describe this market for this game.');
    } else if (!rowsKnown) {
      body = stateBox('empty', 'No players quoted', `The snapshot carries ${marketLabel(state.market).toLowerCase()} for this game but no player quotes.`);
    } else {
      const kicked = m.started ? '<p class="pbeblp-kickoff" role="status"><b>Kicked off · pre-game capture</b><span>These prices were captured before kickoff. They are not current and cannot be taken now.</span></p>' : '';
      const retained = m.retained && !m.started ? '<p class="pbeblp-kickoff is-retained" role="status"><b>Last verified pre-game capture</b><span>Books did not carry this market in the latest scheduled capture; these are the most recent verified prices, with their own capture time.</span></p>' : '';
      body = `${kicked}${retained}<div class="pbeblp-bar"><h2>${esc(marketLabel(state.market))}</h2>${infoHtml()}</div>${modelBanner()}${resultsHtml(board, ev, m)}`;
    }
    return `<div class="pbeblp" data-blp-market="${esc(state.market)}">${matchStrip(ev, board, m)}${controls(events, rowsKnown)}<div class="pbeblp-body">${body}</div></div>`;
  }

  /* Search and sort repaint the results only, so the input keeps its caret. */
  function paintResults() {
    const root = document.querySelector('.pbebl');
    const target = root?.querySelector('[data-blp-results]');
    const d = lines().data;
    const ev = arr(d?.events).find(e => e.id === state.event);
    const board = state.props.get(propKey());
    if (!target || !ev || !board) { paint(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = resultsHtml(board, ev, core().marketState(board, state.market, Date.now()));
    target.replaceWith(tmp.firstElementChild);
    root.dataset.sig = markup();
  }

  /* ---- page ---------------------------------------------------------------- */
  function markup() {
    const s = lines(), d = s.data;
    const head = `<header class="pbebl-hero"><span class="pbebl-eyebrow">BEST LINE · PRICE SHOPPING</span><h1>Shop every number before you bet</h1><p>The best spread, total, moneyline and player prices across every book in the PropBetEdge market snapshot — useful with or without the model.</p>${freshness(d)}</header>`;
    if (!d) return `<section class="pbebl">${head}${legend()}<div class="${s.error ? 'pbebl-unavailable' : 'pbebl-empty'}"><b>${s.error ? 'Market snapshot unavailable' : 'Reading the market snapshot…'}</b><span>${s.error ? `${esc(s.error)}. No price is shown rather than a stale one presented as current.` : ''}</span>${s.error ? '<button type="button" data-bl-retry>Retry</button>' : ''}</div></section>`;
    /* the four-term legend describes the game-line columns; player props carry their own states */
    return `<section class="pbebl${state.tab === 'props' ? ' is-props' : ''}">${head}${state.tab === 'games' ? legend() : ''}${tabs()}${state.tab === 'games' ? gamesHtml(d) : propsHtml(d)}</section>`;
  }
  function paint() {
    const vc = document.getElementById('view-container'); if (!vc || window.App?.current !== 'bestline') return;
    const html = markup();
    const root = vc.querySelector('.pbebl');
    if (root && root.dataset.sig === html) return;
    const open = [...(root?.querySelectorAll('.pbebl-books[open]') || [])].map(x => x.closest('.pbebl-game')?.id);
    const y = window.scrollY;
    const active = document.activeElement;
    const focused = active?.closest?.('.pbebl') ? ['data-blp-search', 'data-blp-sort', 'data-bl-event', 'data-blp-toggle', 'data-bl-market'].find(a => active.hasAttribute(a)) : null;
    const focusValue = focused ? active.getAttribute(focused) : null;
    vc.innerHTML = html;
    const next = vc.querySelector('.pbebl'); next.dataset.sig = html;
    open.forEach(id => { if (id) next.querySelector(`#${CSS.escape(id)} .pbebl-books`)?.setAttribute('open', ''); });
    if (focused) next.querySelector(focusValue ? `[${focused}="${CSS.escape(focusValue)}"]` : `[${focused}]`)?.focus({ preventScroll: true });
    if (root) window.scrollTo(0, y);
  }
  async function load() {
    const p = window.App?.params || {};
    if (p.event) { state.event = String(p.event); state.tab = p.tab === 'games' ? 'games' : 'props'; }
    if (p.market && PROP_MARKETS.some(m => m[0] === p.market)) state.market = p.market;
    paint();
    await cc()?.refresh?.('bestline');
    paint();
  }

  document.addEventListener('click', e => {
    if (!e.target.closest?.('.pbebl')) return;
    const tab = e.target.closest('[data-bl-tab]');
    if (tab) { state.tab = tab.dataset.blTab; paint(); return; }
    const props = e.target.closest('[data-bl-props]');
    if (props) { state.tab = 'props'; state.event = props.dataset.blProps; paint(); window.scrollTo(0, 0); return; }
    if (e.target.closest('[data-bl-retry]')) { cc()?.refresh?.('bestline', true).then(paint); return; }
    const market = e.target.closest('button[data-bl-market]');
    if (market) { if (market.dataset.blMarket !== state.market) { state.market = market.dataset.blMarket; state.propError = null; paint(); } return; }
    const toggle = e.target.closest('[data-blp-toggle]');
    if (toggle) {
      const panel = document.getElementById(toggle.dataset.blpToggle);
      const key = rowKey(toggle.closest('[data-blp-player]')?.dataset.blpPlayer || '');
      const open = !state.open.has(key);
      if (open) state.open.add(key); else state.open.delete(key);
      if (panel) panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'Hide books' : 'View all books';
      const root = document.querySelector('.pbebl'); if (root) root.dataset.sig = markup();
      return;
    }
    if (e.target.closest('[data-blp-retry]')) { state.propError = null; paint(); return; }
    if (e.target.closest('[data-blp-unlock]')) { window.PBEPro?.open?.('upgrade'); return; }
    const intel = e.target.closest('[data-blp-intel]');
    if (intel) {
      /* the Player DNA focus hand-off (player-dna-shared.js): the product opens on
         this athlete and resolves his next game itself, never another team's */
      try { sessionStorage.setItem('pbe.playerdna.focus', JSON.stringify({ route: intel.dataset.blpIntel, player_id: intel.dataset.blpGsis, event_id: null, source: 'bestline' })); } catch (_) {}
      window.App?.nav?.(intel.dataset.blpIntel);
      return;
    }
    const lab = e.target.closest('[data-blp-modellab]');
    if (lab) {
      /* Model Lab reads its event from ?event= or pbe_nfl_event (model-lab.js) */
      try { localStorage.setItem('pbe_nfl_event', lab.dataset.blpModellab); } catch (_) {}
      window.App?.nav?.('picks');
    }
  });
  /* A headshot that fails to load becomes the photo-unavailable treatment in
     place, and is never requested again this session. */
  document.addEventListener('error', e => {
    const img = e.target;
    if (!img?.matches?.('.pbeblp img')) return;
    const holder = img.closest('.pbeblp-photo');
    if (holder && img.dataset.blpEspn) {
      state.failedPhotos.add(img.dataset.blpEspn);
      holder.classList.add('is-missing');
      holder.setAttribute('role', 'img');
      holder.setAttribute('aria-label', 'Photo unavailable');
      holder.innerHTML = '<i aria-hidden="true">Photo<br>unavailable</i>';
    } else img.remove();
  }, true);
  document.addEventListener('input', e => {
    if (!e.target.matches?.('.pbebl [data-blp-search]')) return;
    state.search = e.target.value;
    paintResults();
  });
  window.addEventListener('pbe:pro-state', () => {
    /* model output never outlives the entitlement that fetched it */
    if (proState().pro !== true) state.models.clear();
    if (mounted() && state.tab === 'props') paint();
  });
  document.addEventListener('toggle', e => {
    const d = e.target; if (!d?.matches?.('.pbebl [data-bl-game]')) return;
    if (d.open) openGames.add(d.dataset.blGame); else openGames.delete(d.dataset.blGame);
  }, true);
  document.addEventListener('change', e => {
    if (!e.target.closest?.('.pbebl')) return;
    if (e.target.matches('[data-bl-event]')) { state.event = e.target.value; state.propError = null; state.search = ''; paint(); }
    if (e.target.matches('[data-blp-sort]')) { state.sort = e.target.value; paintResults(); }
  });

  function install() { if (!window.App?.VIEWS) return false; window.App.VIEWS.bestline = load; return true; }
  window.PBEBestLine = { load, paint, state };
  if (!install()) document.addEventListener('DOMContentLoaded', install, { once: true });
})();
