/* PropBetEdge NFL — PropChain v3 core.
 *
 * Pure joins, no I/O and no DOM. propchain-v3.js owns fetching and rendering;
 * this file decides what a chain is, and it is the only place that does.
 *
 * A CHAIN is one sourced change followed as far as real data reaches:
 *
 *   SOURCE   a change a source published (nfl-intel /api/changes: injury
 *            designations, game disruptions, consensus market moves, weather;
 *            the newsroom feed for news)
 *   ENTITY   the player, team or game that change names — resolved by id or
 *            by exact name inside that one game's market board, never fuzzily
 *   TAPE     observed consensus movement for that game, placed in time
 *            relative to the source event (before / spanning / after). Never a
 *            cause. Player props have no stored history, so a player market is
 *            CURRENT ONLY and says so.
 *   MARKET   what the market offers now: consensus, best number, best price
 *   MODEL    only a published PBE value the reader is entitled to, else
 *            MODEL NOT PUBLISHED — never derived from consensus
 *
 * A chain is COMPLETE when it reaches a real market: a player whose props are
 * on the board, or a game market that was observed or is priced now. Changes
 * that stop short stay visible as context; they are never padded into chains.
 */
(function (root) {
  'use strict';

  const arr = v => (Array.isArray(v) ? v : []);
  const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const fin = v => Number.isFinite(num(v));
  const ms = v => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : NaN; };
  const SEV_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

  /* ---- identity ----------------------------------------------------------- */
  const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
  function normName(name) {
    return String(name || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[.'’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
      .split(' ').filter(p => p && !SUFFIX.has(p)).join(' ');
  }
  const normTeam = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  /* ESPN game (nfl-current identity) -> odds event (provider identity). The two
     id spaces never meet, so the join is both full team names plus a kickoff
     within 12 hours. */
  function matchOddsEvent(game, events) {
    const away = normTeam(game?.away?.name), home = normTeam(game?.home?.name), k = ms(game?.kickoff);
    if (!away || !home) return null;
    return arr(events).find(e => normTeam(e?.away) === away && normTeam(e?.home) === home
      && (!Number.isFinite(k) || !Number.isFinite(ms(e?.kickoff)) || Math.abs(ms(e.kickoff) - k) <= 12 * 3600000)) || null;
  }

  /* ---- player markets ----------------------------------------------------- */
  const PROP_MARKETS = {
    player_pass_yds: 'Passing Yards', player_pass_tds: 'Passing TDs', player_pass_completions: 'Completions',
    player_rush_yds: 'Rushing Yards', player_rush_attempts: 'Rush Attempts',
    player_reception_yds: 'Receiving Yards', player_receptions: 'Receptions', player_anytime_td: 'Anytime TD'
  };
  /* The eight markets one board request can carry, in the order a position
     is priced first. */
  const BOARD_MARKETS = Object.keys(PROP_MARKETS);
  const POSITION_MARKETS = {
    QB: ['player_pass_yds', 'player_pass_tds', 'player_pass_completions', 'player_rush_yds', 'player_anytime_td'],
    RB: ['player_rush_yds', 'player_rush_attempts', 'player_receptions', 'player_reception_yds', 'player_anytime_td'],
    FB: ['player_rush_yds', 'player_receptions', 'player_reception_yds', 'player_anytime_td'],
    WR: ['player_reception_yds', 'player_receptions', 'player_rush_yds', 'player_anytime_td'],
    TE: ['player_reception_yds', 'player_receptions', 'player_anytime_td']
  };
  const marketsFor = position => POSITION_MARKETS[String(position || '').toUpperCase()] || BOARD_MARKETS;

  const implied = a => { const n = num(a); return !Number.isFinite(n) || n === 0 ? null : n < 0 ? -n / (-n + 100) : 100 / (n + 100); };
  const payout = a => { const n = num(a); return !Number.isFinite(n) || n === 0 ? null : n > 0 ? n / 100 : 100 / -n; };
  function median(xs) {
    const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* Books quote alternate ladders (24.5 at -230 ... 44.5 at +180), so "the
     lowest over on offer" is usually a different bet. A book's MAIN line is the
     number it prices closest to even — both sides quoted, smallest gap in
     implied probability. */
  function mainLines(quotes) {
    const byBook = new Map();
    for (const q of arr(quotes)) {
      if (!fin(q?.point) || !fin(q?.price)) continue;
      const dir = String(q.direction || '').toUpperCase();
      if (dir !== 'OVER' && dir !== 'UNDER') continue;
      const book = String(q.book || q.book_key || '');
      if (!byBook.has(book)) byBook.set(book, new Map());
      const pts = byBook.get(book);
      const key = num(q.point);
      if (!pts.has(key)) pts.set(key, {});
      const slot = pts.get(key);
      const prev = slot[dir];
      if (!prev || payout(q.price) > payout(prev.price)) slot[dir] = q;
    }
    const out = [];
    for (const [book, pts] of byBook) {
      let best = null;
      for (const [point, s] of pts) {
        if (!s.OVER || !s.UNDER) continue;
        const gap = Math.abs(implied(s.OVER.price) - implied(s.UNDER.price));
        if (!best || gap < best.gap) best = { book, point, over: num(s.OVER.price), under: num(s.UNDER.price), gap, last_update: s.OVER.last_update || s.UNDER.last_update || null };
      }
      if (best) out.push(best);
    }
    return out;
  }

  /* One player's one market, from the board's raw quotes. */
  function propMarket(quotes, market) {
    const qs = arr(quotes).filter(q => q?.market === market);
    if (!qs.length) return null;
    const books = new Set(qs.map(q => q.book)).size;
    const label = PROP_MARKETS[market] || String(market).replace(/^player_/, '').replace(/_/g, ' ');
    const yes = qs.filter(q => String(q.direction).toUpperCase() === 'YES' && fin(q.price));
    if (yes.length && !qs.some(q => fin(q.point))) {
      const best = yes.reduce((b, q) => (!b || payout(q.price) > payout(b.price) ? q : b), null);
      return { market, label, kind: 'YES', books, consensus_price: Math.round(median(yes.map(q => num(q.price)))), best_yes: { price: num(best.price), book: best.book } };
    }
    const mains = mainLines(qs);
    if (!mains.length) return { market, label, kind: 'LADDER_ONLY', books };
    const consensus = median(mains.map(m => m.point));
    const bestNumber = side => [...mains].sort((a, b) => (side === 'OVER' ? a.point - b.point : b.point - a.point)
      || payout(side === 'OVER' ? b.over : b.under) - payout(side === 'OVER' ? a.over : a.under))[0];
    const atCons = mains.filter(m => m.point === consensus);
    const bestPrice = side => atCons.length ? atCons.reduce((b, m) => (!b || payout(side === 'OVER' ? m.over : m.under) > payout(side === 'OVER' ? b.over : b.under) ? m : b), null) : null;
    const bo = bestNumber('OVER'), bu = bestNumber('UNDER'), po = bestPrice('OVER'), pu = bestPrice('UNDER');
    return {
      market, label, kind: 'OU', books, main_books: mains.length,
      consensus_line: consensus,
      line_low: Math.min(...mains.map(m => m.point)), line_high: Math.max(...mains.map(m => m.point)),
      best_over: { point: bo.point, price: bo.over, book: bo.book },
      best_under: { point: bu.point, price: bu.under, book: bu.book },
      at_consensus: {
        books: atCons.length,
        over: po ? { price: po.over, book: po.book } : null,
        under: pu ? { price: pu.under, book: pu.book } : null
      }
    };
  }

  /* Exact name identity inside ONE game's board. A name that normalizes to two
     board names is ambiguous and is not linked. */
  function boardPlayers(board) {
    const idx = new Map();
    for (const q of arr(board?.quotes)) {
      const name = q?.player; if (!name || /\b(d\/st|defense)\b/i.test(name)) continue;
      const k = normName(name);
      if (!idx.has(k)) idx.set(k, new Set());
      idx.get(k).add(name);
    }
    return idx;
  }
  function resolvePlayer(board, name, index = boardPlayers(board)) {
    const hit = index.get(normName(name));
    if (!hit || hit.size !== 1) return null;
    return [...hit][0];
  }
  function playerMarkets(board, boardName, position) {
    const qs = arr(board?.quotes).filter(q => q?.player === boardName);
    const order = marketsFor(position);
    const seen = new Set(qs.map(q => q.market));
    const list = [...order, ...BOARD_MARKETS.filter(m => !order.includes(m))].filter(m => seen.has(m));
    return list.map(m => propMarket(qs, m)).filter(Boolean);
  }

  /* ---- snapshot semantics --------------------------------------------------- */
  function snapshotOf(src, game, now, sourceAt) {
    if (!src) return null;
    const captured = src.captured_at || null;
    const kick = ms(game?.kickoff);
    return {
      /* The market in hand was captured BEFORE the change this chain follows:
         it is the pre-change market, and must never read as a reaction. */
      before_source: Number.isFinite(ms(sourceAt)) && Number.isFinite(ms(captured)) && ms(captured) < ms(sourceAt),
      captured_at: captured,
      captured_at_et: src.captured_at_et || null,
      age_seconds: fin(src.age_seconds) ? num(src.age_seconds) : Number.isFinite(ms(captured)) ? Math.max(0, Math.round((now - ms(captured)) / 1000)) : null,
      ingest_failed: src.ingest?.status === 'LATEST_INGEST_UNAVAILABLE',
      /* A capture at or after kickoff is an in-game price at one moment, not
         the pre-game market; a pre-kick capture for a started game is history. */
      in_game_capture: Number.isFinite(kick) && Number.isFinite(ms(captured)) && ms(captured) >= kick,
      game_started: Number.isFinite(kick) && kick <= now
    };
  }

  /* ---- tape ----------------------------------------------------------------- */
  /* Observed consensus moves for one game, each placed relative to a source
     time: BEFORE (move finished before the change), SPANS (the change falls
     between the two captures), AFTER (both captures after it). */
  function tapeFor(changesData, gameId, sourceAt) {
    const market = changesData?.sources?.market || {};
    const t = ms(sourceAt);
    const moves = arr(changesData?.changes).filter(c => c?.kind === 'MARKET_MOVE' && String(c.game?.id) === String(gameId) && c.market);
    const placed = moves.map(c => {
      const from = ms(c.market.from?.captured_at), to = ms(c.market.to?.captured_at);
      const relation = !Number.isFinite(t) ? 'UNPLACED' : to <= t ? 'BEFORE' : from >= t ? 'AFTER' : 'SPANS';
      return { id: c.id, severity: c.severity, relation, ...c.market, detail: c.detail || null, kind: moveKind(c.market) };
    }).sort((a, b) => Math.abs(num(b.delta)) - Math.abs(num(a.delta)));
    const latest = market.latest_captured_at || null;
    return {
      available: market.available === true,
      reason: market.available === true ? null : (market.reason || 'market_history_unavailable'),
      captures: fin(market.batches) ? num(market.batches) : null,
      latest_captured_at: latest,
      first_captured_at: market.first_captured_at || null,
      /* No capture exists after the change: the market has not been observed
         since, so nothing can be said about how it moved in response. */
      no_capture_after_source: Number.isFinite(t) && Number.isFinite(ms(latest)) && ms(latest) < t,
      thresholds: market.thresholds || null,
      moves: placed
    };
  }
  /* Number move, key number, probability (moneyline price) move — and the
     book count, which is liquidity, not price. */
  function moveKind(m) {
    if (!m) return 'NONE';
    if (m.unit === 'pp') return 'PRICE';
    if (m.key_number !== null && m.key_number !== undefined) return 'KEY_NUMBER';
    return fin(m.delta) && num(m.delta) !== 0 ? 'NUMBER' : 'NONE';
  }
  const bookChange = m => (fin(m?.from?.books) && fin(m?.to?.books) && num(m.from.books) !== num(m.to.books) ? num(m.to.books) - num(m.from.books) : 0);

  /* ---- game lines (nfl-intel /api/best-line) --------------------------------- */
  function gameLine(event, market, side) {
    const s = event?.markets?.[market]?.[side];
    if (!s) return null;
    return {
      market, side,
      consensus: s.consensus || null,
      best: s.best || null,
      books: s.book_count ?? null,
      line_range: s.line_range || null
    };
  }
  const fullName = (game, abbr) => (game?.away?.abbreviation === abbr ? game.away.name : game?.home?.abbreviation === abbr ? game.home.name : null);

  /* ---- news entity trust ---------------------------------------------------- */
  /* Stricter than the shared news guard: the player's SURNAME (or full name)
     must appear in the article's own title or unique summary. The upstream
     enrichment tags unrelated players on many wire stories. */
  function newsNamesPlayer(article, name) {
    const hay = ` ${normName(article?._trust ? `${article.title || ''} ${article._trust.summary || ''}` : `${article?.title || ''} ${article?.summary || ''}`)} `;
    const parts = normName(name).split(' ');
    const surname = parts[parts.length - 1];
    return Boolean(surname && surname.length > 2 && hay.includes(` ${surname} `));
  }

  /* ---- chains ---------------------------------------------------------------- */
  function severityOfNews(a) { return a?.is_breaking ? 'MEDIUM' : 'LOW'; }

  /* inputs: {
       changes     /api/changes payload (possibly 7-day)
       bestline    /api/best-line payload (may be null)
       boards      Map oddsEventId -> {status:'ok'|'error'|'pending', data, error}
       news        news-feed articles (trust-prepared) or null
       cards       ({away,home,espnId}) -> {cards, previews}   (PBECard.forGame)
       passModels  Map oddsEventId -> {status, data}            (Pro only)
       pro         entitlement boolean
       now
     } */
  function build(inputs) {
    const now = inputs.now || Date.now();
    const data = inputs.changes || {};
    const games = arr(data.games);
    const gameById = new Map(games.map(g => [String(g.id), g]));
    const events = arr(inputs.bestline?.events);
    const oddsFor = new Map(games.map(g => [String(g.id), matchOddsEvent(g, events)]));
    const boards = inputs.boards || new Map();
    const chains = [];
    const context = [];

    const gameRef = g => {
      if (!g) return null;
      const full = gameById.get(String(g.id)) || g;
      const ev = oddsFor.get(String(full.id)) || null;
      return {
        id: String(full.id), matchup: full.matchup || g.matchup, kickoff: full.kickoff || g.kickoff,
        semantics: full.semantics || g.semantics || 'SCHEDULE', detail: full.detail || null,
        away: full.away || null, home: full.home || null, week: full.week ?? null,
        odds_event_id: ev?.id || null
      };
    };

    function modelForGame(game, market, side) {
      if (!game) return { state: 'NOT_PUBLISHED', reason: 'no_game' };
      const found = typeof inputs.cards === 'function'
        ? inputs.cards({ away: game.away?.abbreviation, home: game.home?.abbreviation, espnId: game.id }) : { cards: [], previews: [] };
      const card = arr(found.cards).find(c => c.market === market);
      if (card) return { state: 'PUBLISHED', source: 'PBE_CARD', card };
      const preview = arr(found.previews).find(p => p.market === market);
      if (preview) return { state: 'LOCKED', source: 'PBE_CARD', preview };
      return { state: 'NOT_PUBLISHED', reason: 'no_signal_on_market' };
    }
    function modelForPlayer(game, boardName, primary) {
      if (!primary || primary.market !== 'player_pass_yds') return { state: 'NOT_PUBLISHED', reason: 'no_model_for_market' };
      if (!inputs.pro) return { state: 'LOCKED', source: 'PASSING_MODEL' };
      const entry = game?.odds_event_id ? inputs.passModels?.get(game.odds_event_id) : null;
      if (!entry || entry.status === 'pending') return { state: 'PENDING', source: 'PASSING_MODEL' };
      if (entry.status !== 'ok') return { state: 'NOT_PUBLISHED', reason: entry.error || 'model_unavailable' };
      const row = arr(entry.data?.models).find(m => normName(m.player) === normName(boardName));
      if (!row || row.available !== true || !fin(row.fair_line)) return { state: 'NOT_PUBLISHED', reason: 'player_not_modeled' };
      return { state: 'PUBLISHED', source: 'PASSING_MODEL', row, model_version: entry.data.model_version || row.model_version || null, market_updated_at: entry.data.market_updated_at || null };
    }

    function playerMarketLayer(game, player, sourceAt) {
      if (!game?.odds_event_id) return { kind: 'NONE', reason: 'game_not_in_market_snapshot' };
      const entry = boards.get(game.odds_event_id);
      if (!entry || entry.status === 'pending') return { kind: 'PENDING' };
      if (entry.status !== 'ok') return { kind: 'UNAVAILABLE', reason: entry.error || 'board_unavailable' };
      const boardName = resolvePlayer(entry.data, player.name, entry.index || boardPlayers(entry.data));
      if (!boardName) return { kind: 'NONE', reason: 'player_not_on_board', snapshot: snapshotOf(entry.data, game, now, sourceAt) };
      const markets = playerMarkets(entry.data, boardName, player.position);
      if (!markets.length) return { kind: 'NONE', reason: 'player_not_on_board', snapshot: snapshotOf(entry.data, game, now, sourceAt) };
      return { kind: 'PLAYER_PROPS', board_name: boardName, primary: markets[0], markets, snapshot: snapshotOf(entry.data, game, now, sourceAt) };
    }
    const bestlineSnapshot = (game, sourceAt) => snapshotOf(inputs.bestline, game, now, sourceAt);

    /* 1 · injury designations */
    for (const c of arr(data.changes)) {
      if (c.kind !== 'INJURY_STATUS') continue;
      const game = gameRef(c.game);
      const player = c.player || {};
      const base = {
        id: `pc:${c.id}`, kind: 'INJURY', severity: c.severity || 'LOW', actionable: c.actionable !== false && game?.semantics !== 'FINAL',
        time: c.observed_at,
        status: c.status, transition: c.transition || null,
        title: player.name || c.headline, event_label: c.transition ? `${c.transition.from.replace(/_/g, ' ')} → ${c.transition.to.replace(/_/g, ' ')}` : `Status updated: ${String(c.status || '').replace(/_/g, ' ')}`,
        game,
        source: { label: c.source?.label || 'ESPN injury report', provider: c.source?.provider || null, at: c.observed_at, basis: c.observed_basis, note: c.detail || null, injury: c.injury || null,
          url: player.espn_id ? `https://www.espn.com/nfl/player/_/id/${encodeURIComponent(player.espn_id)}` : null, url_label: 'ESPN player page' },
        entity: { type: 'PLAYER', name: player.name, position: player.position || null, team: c.team?.abbreviation || null, espn_id: player.espn_id || null, headshot: player.headshot || null, prop_relevant: player.prop_relevant === true },
        search: [player.name, player.position, c.team?.abbreviation, game?.matchup, c.status].join(' ')
      };
      if (!game) { context.push({ ...base, stop: 'NO_GAME' }); continue; }
      if (!player.prop_relevant) { context.push({ ...base, stop: 'POSITION_NOT_PRICED' }); continue; }
      const market = playerMarketLayer(game, player, c.observed_at);
      const tape = tapeFor(data, game.id, c.observed_at);
      const chain = {
        ...base, market, tape, tape_scope: 'GAME',
        entity: { ...base.entity, link: market.kind === 'PLAYER_PROPS' ? 'ESPN athlete id on the injury report · exact name on this game’s player board' : 'ESPN athlete id on the injury report' },
        model: market.kind === 'PLAYER_PROPS' ? modelForPlayer(game, market.board_name, market.primary) : { state: 'NOT_PUBLISHED', reason: 'no_market' },
        complete: market.kind === 'PLAYER_PROPS' ? true : market.kind === 'PENDING' ? null : false,
        search: `${base.search} ${arr(market.markets).map(m => m.label).join(' ')}`
      };
      if (chain.complete === false) context.push({ ...chain, stop: market.reason === 'player_not_on_board' ? 'NOT_ON_BOARD' : 'MARKET_UNAVAILABLE' });
      else chains.push(chain);
    }

    /* 2 · consensus market moves */
    for (const c of arr(data.changes)) {
      if (c.kind !== 'MARKET_MOVE' || !c.market) continue;
      const game = gameRef(c.game);
      const m = c.market;
      const side = m.market === 'total' ? (m.selection === 'UNDER' ? 'UNDER' : 'OVER') : fullName(game, m.selection);
      const ev = game?.odds_event_id ? events.find(e => e.id === game.odds_event_id) : null;
      const line = ev && side ? gameLine(ev, m.market, side) : null;
      const tape = tapeFor(data, game?.id, m.to?.captured_at);
      const label = m.market === 'total' ? 'Game total' : m.market === 'spread' ? `${m.selection} spread` : `${m.selection} moneyline`;
      chains.push({
        id: `pc:${c.id}`, kind: 'MARKET', severity: c.severity || 'MEDIUM', actionable: game?.semantics !== 'FINAL',
        time: m.to?.captured_at || c.observed_at, status: c.status, transition: null,
        title: label, event_label: c.status === 'KEY_NUMBER' ? `Crossed key number ${m.key_number}` : 'Consensus moved',
        game,
        source: { label: c.source?.label || 'PropBetEdge market history', provider: c.source?.provider || 'pbe_market_history', at: m.to?.captured_at, basis: 'CAPTURE_TIME', note: c.detail || null, from_captured_at: m.from?.captured_at || null },
        entity: { type: m.market === 'total' ? 'GAME' : 'TEAM', name: m.market === 'total' ? game?.matchup : (fullName(game, m.selection) || m.selection), team: m.market === 'total' ? null : m.selection, link: 'Market identity: game + market + side on the consensus tape' },
        move: { ...m, kind: moveKind(m), book_change: bookChange(m) },
        tape: { ...tape, moves: tape.moves.filter(x => x.id !== c.id) }, tape_scope: 'GAME',
        market: line ? { kind: 'GAME_LINE', line, snapshot: bestlineSnapshot(game, m.to?.captured_at) } : { kind: 'NONE', reason: ev ? 'market_not_in_snapshot' : 'game_not_in_market_snapshot' },
        model: modelForGame(game, m.market, side),
        complete: true,
        search: [label, m.selection, game?.matchup, m.market, 'market move line'].join(' ')
      });
    }

    /* 3 · game disruptions */
    for (const c of arr(data.changes)) {
      if (c.kind !== 'GAME_STATUS') continue;
      const game = gameRef(c.game);
      const ev = game?.odds_event_id ? events.find(e => e.id === game.odds_event_id) : null;
      const line = ev ? gameLine(ev, 'spread', game?.home?.name) : null;
      chains.push({
        id: `pc:${c.id}`, kind: 'GAME', severity: c.severity || 'HIGH', actionable: true,
        time: c.observed_at, status: c.status, transition: null,
        title: game?.matchup || c.headline, event_label: `Game ${String(c.status || '').toLowerCase()}`,
        game,
        source: { label: c.source?.label || 'ESPN scoreboard', provider: c.source?.provider || null, at: c.observed_at, basis: c.observed_basis, note: c.detail || null },
        entity: { type: 'GAME', name: game?.matchup, link: 'ESPN event id on the scoreboard' },
        tape: tapeFor(data, game?.id, c.observed_at), tape_scope: 'GAME',
        market: line ? { kind: 'GAME_LINE', line, snapshot: bestlineSnapshot(game, c.observed_at) } : { kind: 'NONE', reason: 'game_not_in_market_snapshot' },
        model: modelForGame(game, 'spread', game?.home?.name),
        complete: Boolean(line),
        search: [game?.matchup, c.status, 'game status'].join(' ')
      });
    }

    /* 4 · weather (alerts and forecast shifts nfl-intel persisted) */
    const wx = data.weather;
    if (wx?.available) {
      /* An alert past its own expiry is no longer a current condition, and the
         same alert headline for one game is one fact however many offices or
         refreshes repeated it. */
      const wxSeen = new Set();
      const wxEvents = arr(wx.events)
        .filter(e => !(Number.isFinite(ms(e?.expires)) && ms(e.expires) <= now))
        .sort((a, b) => (ms(b.effective || b.observed_at) || 0) - (ms(a.effective || a.observed_at) || 0))
        .filter(e => { const k = `${e?.game?.event_id || e?.game?.game_id}|${e?.kind}|${e?.headline}`; if (wxSeen.has(k)) return false; wxSeen.add(k); return true; });
      for (const e of wxEvents) {
        const gid = String(e?.game?.event_id || e?.game?.game_id || '');
        const game = gameRef(gameById.get(gid) || (e.game ? { id: gid, matchup: e.game.matchup, kickoff: e.game.kickoff_utc } : null));
        const indoor = e?.game?.roof?.weather_applies === false;
        const at = e.effective || e.observed_at || wx.fetched_at;
        const ev = game?.odds_event_id ? events.find(x => x.id === game.odds_event_id) : null;
        const line = ev ? gameLine(ev, 'total', 'OVER') : null;
        const chain = {
          id: `pc:wx:${e.event_key || `${gid}:${e.kind}:${at}`}`, kind: 'WEATHER',
          severity: indoor ? 'LOW' : e.official && /severe|extreme/i.test(e.severity || '') ? 'HIGH' : 'MEDIUM',
          actionable: game?.semantics !== 'FINAL', time: at, status: e.kind || 'WEATHER_ALERT', transition: null,
          title: `${game?.matchup || e.game?.matchup || 'Game'} · ${e.headline || 'Weather'}`, event_label: e.official ? 'Official weather alert' : e.kind === 'WEATHER_SHIFT' ? 'Forecast shift' : 'Forecast condition',
          game,
          source: { label: e.provenance?.source || (e.official ? 'National Weather Service' : 'Open-Meteo forecast'), provider: e.official ? 'nws' : 'open_meteo', at, basis: e.effective ? 'SOURCE_TIMESTAMP' : 'OBSERVED_BY_PBE',
            note: [e.detail, e.expires ? `Expires ${e.expires}` : null].filter(Boolean).join(' · ') || null, url: e.cta?.href || null, url_label: e.cta?.label || 'Official alert',
            venue: e.game?.venue || null, roof: e.game?.roof || null, forecast_semantics: wx.semantics?.forecast || null },
          entity: { type: 'GAME', name: game?.matchup, venue: e.game?.venue || null, link: indoor ? 'Venue has a fixed roof: conditions do not reach the field' : 'Venue location of this game' },
          tape: tapeFor(data, game?.id, at), tape_scope: 'GAME',
          market: line ? { kind: 'GAME_LINE', line, snapshot: bestlineSnapshot(game, at) } : { kind: 'NONE', reason: 'game_not_in_market_snapshot' },
          model: modelForGame(game, 'total', 'OVER'),
          search: [game?.matchup, e.headline, 'weather', e.game?.venue].join(' ')
        };
        chain.complete = !indoor && Boolean(line || chain.tape.moves.some(x => x.market === 'total'));
        (chain.complete ? chains : context).push(chain.complete ? chain : { ...chain, stop: indoor ? 'INDOOR' : 'MARKET_UNAVAILABLE' });
      }
    }

    /* 5 · news, only where the article's own text names a player who is on a
       board for a game one of the article's teams plays in */
    if (Array.isArray(inputs.news)) {
      const seen = new Set();
      for (const a of inputs.news) {
        const teams = new Set(arr(a?._trust ? a._trust.teams : a?.teams).map(t => String(t).toUpperCase()));
        const players = arr(a?._trust ? a._trust.players : a?.players);
        if (!teams.size || !players.length || !a.published_at) continue;
        const gs = games.filter(g => teams.has(g.away?.abbreviation) || teams.has(g.home?.abbreviation)).map(gameRef).filter(g => g?.odds_event_id && g.semantics !== 'FINAL');
        for (const name of players) {
          if (!newsNamesPlayer(a, name)) continue;
          for (const game of gs) {
            const entry = boards.get(game.odds_event_id);
            if (!entry || entry.status !== 'ok') continue;
            const boardName = resolvePlayer(entry.data, name, entry.index || boardPlayers(entry.data));
            if (!boardName) continue;
            const key = `${a.id}|${normName(boardName)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const markets = playerMarkets(entry.data, boardName, null);
            if (!markets.length) continue;
            chains.push({
              id: `pc:news:${a.id}:${normName(boardName).replace(/\s+/g, '-')}`, kind: 'NEWS', severity: severityOfNews(a), actionable: true,
              time: a.published_at, status: String(a.topic_kind || 'news').toUpperCase(), transition: null,
              title: boardName, event_label: a.title,
              game,
              source: { label: a.source ? `${String(a.source).replace(/-/g, ' ')}` : 'PropBetEdge newsroom', provider: 'propbetedge_newsroom', at: a.published_at, basis: 'SOURCE_TIMESTAMP',
                note: a._trust ? a._trust.summary : a.summary || null, url: a.url || null, url_label: 'Read article', headline: a.title },
              entity: { type: 'PLAYER', name: boardName, team: null, link: 'Named in the article text · exact name on this game’s player board' },
              tape: tapeFor(data, game.id, a.published_at), tape_scope: 'GAME',
              market: { kind: 'PLAYER_PROPS', board_name: boardName, primary: markets[0], markets, snapshot: snapshotOf(entry.data, game, now, a.published_at) },
              model: modelForPlayer(game, boardName, markets[0]),
              complete: true,
              search: [boardName, a.title, game.matchup, ...markets.map(m => m.label), 'news'].join(' ')
            });
          }
        }
      }
    }

    return { chains, context };
  }

  /* ---- filtering, ranking, counts ------------------------------------------- */
  const KIND_OF_SIGNAL = { injury: 'INJURY', market: 'MARKET', weather: 'WEATHER', news: 'NEWS', game: 'GAME' };
  /* "All open games" is the slate in play: games not yet final in the
     earliest week that still has one. A later week is one selection away. */
  function openWeek(games) {
    const weeks = arr(games).filter(g => g?.semantics !== 'FINAL' && fin(g?.week)).map(g => num(g.week));
    return weeks.length ? Math.min(...weeks) : null;
  }
  function inScope(item, ui, now) {
    if (ui.game !== 'all' && String(item.game?.id) !== String(ui.game)) return false;
    if (ui.game === 'all' && item.game?.semantics === 'FINAL') return false;
    if (ui.game === 'all' && fin(ui.week) && fin(item.game?.week) && num(item.game.week) !== num(ui.week)) return false;
    const hours = Number(ui.window) || 48;
    const t = ms(item.time);
    if (Number.isFinite(t) && t < now - hours * 3600000) return false;
    return true;
  }
  function matches(item, ui, now) {
    if (!inScope(item, ui, now)) return false;
    if (ui.signal !== 'all' && item.kind !== KIND_OF_SIGNAL[ui.signal]) return false;
    if (ui.severity !== 'all' && item.severity !== String(ui.severity).toUpperCase()) return false;
    const q = normName(ui.q);
    if (q && !normName(item.search).includes(q)) return false;
    return true;
  }
  function movementOf(c) {
    if (c.move && fin(c.move.delta)) return Math.abs(num(c.move.delta)) * (c.move.unit === 'pp' ? 0.25 : 1) + (c.move.key_number != null ? 2 : 0);
    return 0;
  }
  /* Market depth breaks ties inside a severity: books pricing a player's
     yardage and volume lines is a fact about his role that the market itself
     published, so a starter whose receiving line is on the board ranks above a
     depth player priced only for an anytime touchdown. Observed game-market
     moves and disruptions carry full depth. */
  function depthOf(c) {
    if (c.kind === 'MARKET' || c.kind === 'GAME') return 5;
    if (c.market?.kind === 'PLAYER_PROPS') return arr(c.market.markets).filter(m => m.kind === 'OU').length;
    if (c.market?.kind === 'GAME_LINE') return 1;
    return 0;
  }
  function rank(list, sort) {
    const out = [...list];
    const time = (a, b) => (ms(b.time) || 0) - (ms(a.time) || 0);
    if (sort === 'latest') return out.sort(time);
    if (sort === 'movement') return out.sort((a, b) => movementOf(b) - movementOf(a) || SEV_RANK[a.severity] - SEV_RANK[b.severity] || time(a, b));
    return out.sort((a, b) => (a.actionable === false) - (b.actionable === false) || SEV_RANK[a.severity] - SEV_RANK[b.severity] || depthOf(b) - depthOf(a) || time(a, b));
  }
  function counts({ chains, context }, changesData, ui, now) {
    const scoped = chains.filter(c => inScope(c, ui, now));
    const done = scoped.filter(c => c.complete === true);
    const pending = scoped.some(c => c.complete === null);
    const sourceItems = [...scoped, ...context.filter(c => inScope(c, ui, now))];
    return {
      pending,
      active: done.length,
      high: sourceItems.filter(c => c.severity === 'HIGH').length,
      moves: scoped.filter(c => c.kind === 'MARKET').length,
      players: new Set(done.filter(c => c.entity?.type === 'PLAYER').map(c => normName(c.entity.name))).size,
      games: new Set(done.map(c => c.game?.id).filter(Boolean)).size,
      transitions: sourceItems.filter(c => c.transition).length
    };
  }

  root.PBEPropChainCore = {
    version: 3,
    normName, matchOddsEvent, mainLines, propMarket, boardPlayers, resolvePlayer, playerMarkets, marketsFor,
    tapeFor, moveKind, bookChange, gameLine, newsNamesPlayer, snapshotOf,
    build, inScope, matches, rank, counts, depthOf, openWeek,
    PROP_MARKETS, BOARD_MARKETS
  };
})(typeof window !== 'undefined' ? window : globalThis);
