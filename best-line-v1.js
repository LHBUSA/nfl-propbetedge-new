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
 *   PBE FAIR VALUE        the model's number — not published on this surface
 *   MODEL EDGE            exists only against a published fair value
 *
 * Game lines come from the nfl-intel Worker's /api/best-line (the nfl-odds snapshot, reshaped
 * side). Player props come from the gateway board for the one game the reader
 * opens; nothing polls. Every price is a scheduled capture and says so.
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
  const state = { tab: 'games', event: null, market: 'player_pass_yds', props: new Map(), propBusy: false, propError: null };
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
      ${t('fair', 'PBE fair value', 'The PropBetEdge model’s own number. Not published on Best Line and never estimated from consensus — see Model Lab (Pro).', 'is-model')}
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
  function propKey() { return `${state.event}|${state.market}`; }
  async function loadProps() {
    if (!state.event || state.props.has(propKey()) || state.propBusy) return;
    state.propBusy = true; state.propError = null; paint();
    const key = propKey();
    try {
      const r = await fetch(`${API}/api/odds/board?event_id=${encodeURIComponent(state.event)}&markets=${encodeURIComponent(state.market)}`, { cache: 'no-store', headers: { accept: 'application/json' } });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error || String(r.status));
      state.props.set(key, body);
    } catch (e) { state.propError = e instanceof Error ? e.message : String(e); }
    finally { state.propBusy = false; if (mounted()) paint(); }
  }
  function propRows(board) {
    const groups = new Map();
    for (const q of arr(board?.quotes)) {
      if (!q?.player) continue;
      const k = q.player;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(q);
    }
    const summary = new Map(arr(board?.market_summary).map(s => [s.player, s]));
    const best = (rows, side) => rows.filter(q => String(q.direction).toUpperCase() === side)
      .sort((a, b) => (side === 'OVER' ? num(a.point) - num(b.point) : num(b.point) - num(a.point)) || (payout(b.price) - payout(a.price)))[0] || null;
    return [...groups.entries()].map(([player, rows]) => ({ player, over: best(rows, 'OVER'), under: best(rows, 'UNDER'), yes: best(rows, 'YES'), s: summary.get(player), books: new Set(rows.map(q => q.book)).size }))
      .sort((a, b) => b.books - a.books || a.player.localeCompare(b.player));
  }
  function propsHtml(d) {
    const events = arr(d?.events).filter(e => !e.started);
    if (!state.event && events.length) state.event = events[0].id;
    const ev = events.find(e => e.id === state.event);
    const picker = `<div class="pbebl-propbar"><label><span>Game</span><select data-bl-event>${events.map(e => `<option value="${esc(e.id)}"${e.id === state.event ? ' selected' : ''}>${esc(abbr(e.away))} @ ${esc(abbr(e.home))} · ${esc(when(e.kickoff))}</option>`).join('')}</select></label>
      <label><span>Market</span><select data-bl-market>${PROP_MARKETS.map(([k, l]) => `<option value="${k}"${k === state.market ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label></div>`;
    if (!ev) return `${picker}<div class="pbebl-unavailable"><b>No open games in the snapshot</b><span>Player prices appear once a game is in the ingest window.</span></div>`;
    const board = state.props.get(propKey());
    if (!board) {
      if (state.propError) return `${picker}<div class="pbebl-unavailable"><b>Player market unavailable</b><span>${esc(state.propError)} — the snapshot has no board for this game and market.</span></div>`;
      queueMicrotask(loadProps);
      return `${picker}<div class="pbebl-empty"><b>Reading the player board…</b></div>`;
    }
    const avail = board.market_availability?.[state.market];
    const rows = propRows(board);
    if (!rows.length) return `${picker}<div class="pbebl-unavailable"><b>No ${esc(PROP_MARKETS.find(m => m[0] === state.market)?.[1] || 'player')} prices</b><span>${avail === 'NOT_OFFERED_AT_INGEST' ? 'Books were not offering this market when the snapshot was captured.' : avail === 'NOT_REQUESTED_BY_INGEST' ? 'This market is not part of the scheduled ingest.' : 'The snapshot carries no quotes for this market.'}</span></div>`;
    const yesNo = state.market === 'player_anytime_td';
    return `${picker}${freshness(board)}
      <div class="pbebl-scroll"><table class="pbebl-table pbebl-props"><thead><tr><th scope="col">Player</th>${yesNo ? '<th scope="col">Best price · Yes</th>' : '<th scope="col">Best over</th><th scope="col">Best under</th>'}<th scope="col">Consensus line</th><th scope="col">Books</th><th scope="col" class="pbebl-model">PBE fair</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="pbebl-row"><th scope="row">${esc(r.player)}</th>${yesNo
        ? `<td data-label="Best · Yes">${r.yes ? `<span class="pbebl-price">${american(r.yes.price)}</span><small>${esc(r.yes.book)}</small>` : '<span class="pbebl-na">—</span>'}</td>`
        : `<td data-label="Best over">${r.over ? `<b>${esc(r.over.point)}</b> <span class="pbebl-price">${american(r.over.price)}</span><small>${esc(r.over.book)}</small>` : '<span class="pbebl-na">—</span>'}</td><td data-label="Best under">${r.under ? `<b>${esc(r.under.point)}</b> <span class="pbebl-price">${american(r.under.price)}</span><small>${esc(r.under.book)}</small>` : '<span class="pbebl-na">—</span>'}</td>`}
        <td data-label="Consensus">${r.s?.consensus_line != null ? `<b>${esc(r.s.consensus_line)}</b>${r.s.line_low !== r.s.line_high ? `<small>${esc(r.s.line_low)}–${esc(r.s.line_high)}</small>` : ''}` : '<span class="pbebl-na">—</span>'}</td>
        <td data-label="Books">${esc(r.books)}</td><td data-label="PBE fair" class="pbebl-model"><span class="pbebl-na">—</span></td></tr>`).join('')}
      </tbody></table></div>
      <p class="pbebl-note">Best over = the lowest line on offer, then the best price at it; best under = the highest. Prices are raw bookmaker quotes, not vig-free. Open Prop Board for the full cross-book table with PBE model columns (Pro).</p>`;
  }

  /* ---- page ---------------------------------------------------------------- */
  function markup() {
    const s = lines(), d = s.data;
    const head = `<header class="pbebl-hero"><span class="pbebl-eyebrow">BEST LINE · PRICE SHOPPING</span><h1>Shop every number before you bet</h1><p>The best spread, total, moneyline and player prices across every book in the PropBetEdge market snapshot — useful with or without the model.</p>${freshness(d)}</header>`;
    if (!d) return `<section class="pbebl">${head}${legend()}<div class="${s.error ? 'pbebl-unavailable' : 'pbebl-empty'}"><b>${s.error ? 'Market snapshot unavailable' : 'Reading the market snapshot…'}</b><span>${s.error ? `${esc(s.error)}. No price is shown rather than a stale one presented as current.` : ''}</span>${s.error ? '<button type="button" data-bl-retry>Retry</button>' : ''}</div></section>`;
    return `<section class="pbebl">${head}${legend()}${tabs()}${state.tab === 'games' ? gamesHtml(d) : propsHtml(d)}</section>`;
  }
  function paint() {
    const vc = document.getElementById('view-container'); if (!vc || window.App?.current !== 'bestline') return;
    const html = markup();
    const root = vc.querySelector('.pbebl');
    if (root && root.dataset.sig === html) return;
    const open = [...(root?.querySelectorAll('.pbebl-books[open]') || [])].map(x => x.closest('.pbebl-game')?.id);
    const y = window.scrollY;
    vc.innerHTML = html;
    const next = vc.querySelector('.pbebl'); next.dataset.sig = html;
    open.forEach(id => { if (id) next.querySelector(`#${CSS.escape(id)} .pbebl-books`)?.setAttribute('open', ''); });
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
    if (e.target.closest('[data-bl-retry]')) { cc()?.refresh?.('bestline', true).then(paint); }
  });
  document.addEventListener('toggle', e => {
    const d = e.target; if (!d?.matches?.('.pbebl [data-bl-game]')) return;
    if (d.open) openGames.add(d.dataset.blGame); else openGames.delete(d.dataset.blGame);
  }, true);
  document.addEventListener('change', e => {
    if (!e.target.closest?.('.pbebl')) return;
    if (e.target.matches('[data-bl-event]')) { state.event = e.target.value; state.propError = null; paint(); }
    if (e.target.matches('[data-bl-market]')) { state.market = e.target.value; state.propError = null; paint(); }
  });

  function install() { if (!window.App?.VIEWS) return false; window.App.VIEWS.bestline = load; return true; }
  window.PBEBestLine = { load, paint, state };
  if (!install()) document.addEventListener('DOMContentLoaded', install, { once: true });
})();
