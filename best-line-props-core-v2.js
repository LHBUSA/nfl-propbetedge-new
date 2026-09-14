/* PropBetEdge NFL — Best Line player-props core v2.
 *
 * Pure decisions, no I/O and no DOM. best-line-v1.js owns fetching and
 * rendering; this file decides what a player-prop board may say:
 *
 *   · BEST OVER / UNDER / YES   price shopping only, never a recommendation.
 *                               Over: the lowest line on offer, then the best
 *                               price at it. Under: the highest line, then the
 *                               best price. Yes: the best price.
 *   · QUOTE LADDER              every quote the board carries, one row per book
 *                               and line; a side a book did not quote stays empty
 *   · IDENTITY                  a board name becomes an athlete only through an
 *                               exact name match against the Player DNA 2026
 *                               rosters, on one of the two teams in this game,
 *                               with exactly one candidate. Anything else has no
 *                               face, no team and no position.
 *   · PBE MODEL                 Passing Yards only, from the production passing
 *                               model object Model Lab reads (/api/picks/pass),
 *                               for NFL Pro. Nothing is derived from consensus.
 */
(function (root) {
  'use strict';

  const AVAILABILITY = Object.freeze({
    current: 'IN_SNAPSHOT',
    verified: 'LAST_VERIFIED_PREGAME_SNAPSHOT',
    never: 'NOT_OFFERED_AT_INGEST',
    notRequested: 'NOT_REQUESTED_BY_INGEST',
  });
  const MODELED_MARKET = 'player_pass_yds';
  const YES_NO = new Set(['player_anytime_td']);

  const TEAM_CODES = {
    'arizona cardinals': 'ARI', 'atlanta falcons': 'ATL', 'baltimore ravens': 'BAL', 'buffalo bills': 'BUF',
    'carolina panthers': 'CAR', 'chicago bears': 'CHI', 'cincinnati bengals': 'CIN', 'cleveland browns': 'CLE',
    'dallas cowboys': 'DAL', 'denver broncos': 'DEN', 'detroit lions': 'DET', 'green bay packers': 'GB',
    'houston texans': 'HOU', 'indianapolis colts': 'IND', 'jacksonville jaguars': 'JAX', 'kansas city chiefs': 'KC',
    'las vegas raiders': 'LV', 'los angeles chargers': 'LAC', 'los angeles rams': 'LAR', 'miami dolphins': 'MIA',
    'minnesota vikings': 'MIN', 'new england patriots': 'NE', 'new orleans saints': 'NO', 'new york giants': 'NYG',
    'new york jets': 'NYJ', 'philadelphia eagles': 'PHI', 'pittsburgh steelers': 'PIT', 'san francisco 49ers': 'SF',
    'seattle seahawks': 'SEA', 'tampa bay buccaneers': 'TB', 'tennessee titans': 'TEN', 'washington commanders': 'WSH'
  };
  /* nflverse and ESPN disagree on a handful of abbreviations (api/_playerdna/media.js). */
  const ALIAS = { LA: 'LAR', WAS: 'WSH', JAC: 'JAX', OAK: 'LV', SD: 'LAC', STL: 'LAR' };

  /* The Player DNA products a resolved athlete can open, by roster position. */
  const POSITIONS = Object.freeze([
    { position: 'QB', route: 'qbdna', api: '/api/qb-dna?list=1' },
    { position: 'WR', route: 'wrdna', api: '/api/wr-dna?list=1' },
    { position: 'RB', route: 'rbdna', api: '/api/rb-dna?list=1' },
    { position: 'TE', route: 'tedna', api: '/api/te-dna?list=1' },
  ]);

  const arr = v => (Array.isArray(v) ? v : []);
  const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const ms = v => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : NaN; };
  const payout = a => { const n = num(a); return Number.isFinite(n) && n !== 0 ? (n > 0 ? n / 100 : 100 / -n) : NaN; };

  /* Case and whitespace only. "J.K. Dobbins" never becomes "JK Dobbins" and a
     suffix is never dropped: equality, not similarity. */
  const nameKey = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

  function teamCode(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    const named = TEAM_CODES[raw.toLowerCase()];
    if (named) return named;
    const upper = raw.toUpperCase().replace(/[^A-Z]/g, '');
    return /^[A-Z]{2,3}$/.test(upper) ? (ALIAS[upper] || upper) : '';
  }

  /* ---- the market ---------------------------------------------------------- */

  function side(q) { return String(q?.direction ?? '').toUpperCase(); }

  /* The deterministic Best Line definition. Ties on number and price keep
     board order, which is the gateway's own stable order. */
  function bestQuote(quotes, want) {
    const rows = arr(quotes).filter(q => side(q) === want && Number.isFinite(num(q.price)));
    if (!rows.length) return null;
    const byNumber = (a, b) => {
      if (want === 'YES') return 0;
      const ap = num(a.point), bp = num(b.point);
      if (!Number.isFinite(ap) || !Number.isFinite(bp) || ap === bp) return 0;
      return want === 'OVER' ? ap - bp : bp - ap;
    };
    return rows.map((q, i) => [q, i])
      .sort(([a, ai], [b, bi]) => byNumber(a, b) || (payout(b.price) - payout(a.price)) || ai - bi)[0][0];
  }

  /* Not a player: team defence and "No Scorer" outcomes the anytime-TD market
     carries. Named for what they are; never given a face. */
  function outcomeKind(player, event) {
    const key = nameKey(player);
    if (key === 'no scorer') return { kind: 'no_scorer', team: '' };
    const m = /^(.*)\s+(d\/st|defense)$/.exec(key);
    if (m) {
      const team = teamCode(m[1]);
      const inGame = team && [teamCode(event?.away), teamCode(event?.home)].includes(team);
      return { kind: 'team_defense', team: inGame ? team : '' };
    }
    return null;
  }

  /* Every player the board quotes for one market, with the numbers each row
     needs. A player absent from the quotes is absent here: no empty rows. */
  function playerRows(board, market) {
    const groups = new Map();
    for (const q of arr(board?.quotes)) {
      if (q?.market !== market || !q.player) continue;
      if (!groups.has(q.player)) groups.set(q.player, []);
      groups.get(q.player).push(q);
    }
    const summary = new Map(arr(board?.market_summary).filter(s => s?.market === market).map(s => [s.player, s]));
    const event = { away: board?.event?.away_team, home: board?.event?.home_team };
    return [...groups.entries()].map(([player, quotes]) => {
      const s = summary.get(player) || null;
      const prices = quotes.map(q => num(q.price)).filter(Number.isFinite);
      const yes = YES_NO.has(market);
      return {
        player,
        market,
        quotes,
        outcome: outcomeKind(player, event),
        over: yes ? null : bestQuote(quotes, 'OVER'),
        under: yes ? null : bestQuote(quotes, 'UNDER'),
        yes: yes ? bestQuote(quotes, 'YES') : null,
        books: [...new Set(quotes.map(q => q.book).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
        consensus: yes ? null : (Number.isFinite(num(s?.consensus_line)) ? num(s.consensus_line) : null),
        lineLow: yes ? null : (Number.isFinite(num(s?.line_low)) ? num(s.line_low) : null),
        lineHigh: yes ? null : (Number.isFinite(num(s?.line_high)) ? num(s.line_high) : null),
        /* American odds are not averaged: a YES market states its real range */
        priceLow: yes && prices.length ? Math.min(...prices) : null,
        priceHigh: yes && prices.length ? Math.max(...prices) : null,
        captured: quotes.map(q => q.captured_at).filter(Boolean).sort()[0] || null,
      };
    });
  }

  /* Object.is: a yes quote has no point, and NaN must equal NaN here */
  const sameQuote = (a, b) => Boolean(a && b && a.book === b.book && Object.is(num(a.point), num(b.point)) && num(a.price) === num(b.price) && side(a) === side(b));

  /* One ladder row per book and line. A book that quoted only one side at a
     line keeps the other side empty rather than borrowing a price. */
  function ladder(row) {
    if (YES_NO.has(row.market)) {
      return row.quotes.filter(q => side(q) === 'YES')
        .map(q => ({ book: q.book, yes: q, bestYes: sameQuote(q, row.yes) }))
        .sort((a, b) => payout(b.yes.price) - payout(a.yes.price) || a.book.localeCompare(b.book));
    }
    const lines = new Map();
    for (const q of row.quotes) {
      const s = side(q);
      if (s !== 'OVER' && s !== 'UNDER') continue;
      const key = `${q.book}|${num(q.point)}`;
      if (!lines.has(key)) lines.set(key, { book: q.book, line: num(q.point), over: null, under: null });
      lines.get(key)[s === 'OVER' ? 'over' : 'under'] = q;
    }
    return [...lines.values()]
      .map(l => ({ ...l, bestOver: sameQuote(l.over, row.over), bestUnder: sameQuote(l.under, row.under) }))
      .sort((a, b) => a.book.localeCompare(b.book) || a.line - b.line);
  }

  /* Books carrying this market in the snapshot that did not quote this player. */
  function booksNotQuoting(board, row) {
    const offered = arr(board?.market_provenance?.[row.market]?.books);
    return offered.filter(b => !row.books.includes(b)).sort((a, b) => a.localeCompare(b));
  }

  function marketState(board, market, nowMs) {
    const availability = board?.market_availability?.[market] || null;
    const provenance = board?.market_provenance?.[market] || null;
    const kickoff = ms(board?.event?.commence_time);
    const started = board?.event?.started === true || (Number.isFinite(kickoff) && kickoff <= nowMs);
    const served = availability === AVAILABILITY.current || availability === AVAILABILITY.verified;
    return {
      availability,
      served,
      started,
      retained: availability === AVAILABILITY.verified,
      captured_at: served ? (provenance?.captured_at || board?.captured_at || null) : null,
      captured_at_et: served ? (provenance?.captured_at_et || (provenance ? null : board?.captured_at_et) || null) : null,
      snapshot_books: arr(provenance?.books),
      ingest_failed: board?.ingest?.status === 'LATEST_INGEST_UNAVAILABLE',
      live: false,
    };
  }

  function sortRows(rows, sort) {
    const copy = [...rows];
    const byName = (a, b) => a.player.localeCompare(b.player);
    /* outcomes that are not players sit after the athletes whatever the sort */
    const people = (a, b) => Number(Boolean(a.outcome)) - Number(Boolean(b.outcome));
    if (sort === 'name') return copy.sort((a, b) => people(a, b) || byName(a, b));
    if (sort === 'consensus') return copy.sort((a, b) => people(a, b) || ((b.consensus ?? -Infinity) - (a.consensus ?? -Infinity)) || byName(a, b));
    return copy.sort((a, b) => people(a, b) || b.books.length - a.books.length || byName(a, b));
  }

  function filterRows(rows, query) {
    const q = nameKey(query);
    return q ? rows.filter(r => nameKey(r.player).includes(q)) : rows;
  }

  /* ---- identity ------------------------------------------------------------ */

  /* lists: [{ position, route, body }] where body is a /api/<pos>-dna?list=1
     response. Only 2026 roster players with a stable ESPN athlete id count. */
  function identityIndex(lists) {
    const index = new Map();
    const loaded = [];
    for (const list of arr(lists)) {
      if (!list?.body || !Array.isArray(list.body.players)) continue;
      loaded.push(list.position);
      for (const p of list.body.players) {
        if (!p?.active_2026 || !/^\d+$/.test(String(p.espn_id || '')) || !p.name) continue;
        const key = nameKey(p.name);
        if (!index.has(key)) index.set(key, []);
        index.get(key).push({
          name: p.name,
          espn_id: String(p.espn_id),
          gsis_id: p.gsis_id || null,
          team: teamCode(p.team_2026),
          position: list.position,
          route: list.route,
          headshot_url: p.media?.resolved_by === 'espn_athlete_id' ? (p.media.headshot_url || null) : null,
        });
      }
    }
    return { index, loaded };
  }

  function resolveIdentity(identity, player, event) {
    const teams = [teamCode(event?.away), teamCode(event?.home)].filter(Boolean);
    const all = identity?.index?.get(nameKey(player)) || [];
    const inGame = all.filter(c => teams.includes(c.team));
    if (inGame.length === 1) return { status: 'verified', ...inGame[0] };
    if (inGame.length > 1) return { status: 'ambiguous', candidates: inGame.length };
    return { status: all.length ? 'not_on_event_roster' : 'unresolved' };
  }

  /* ---- PBE model ------------------------------------------------------------ */

  /* input.pro: window.PBEPro.state; input.load: { status, body } for this event
     from /api/picks/pass (undefined before any read). */
  function modelState(market, input, player, eventId) {
    if (market !== MODELED_MARKET) return { kind: 'not_modeled' };
    const pro = input?.pro || {};
    if (pro.pro !== true) return { kind: pro.loading ? 'checking' : 'locked' };
    const load = input?.load;
    if (!load || load.status === 'loading') return { kind: 'loading' };
    if (load.status === 401 || load.status === 403) return { kind: 'locked' };
    if (load.status !== 200 || !load.body) return { kind: 'service_unavailable' };
    const body = load.body;
    if (String(body.event?.id || '') !== String(eventId)) return { kind: 'service_unavailable' };
    if (body.market && body.market !== MODELED_MARKET) return { kind: 'service_unavailable' };
    if (body.semantics !== 'MODEL') return { kind: 'not_published' };
    const rows = arr(body.models).filter(m => nameKey(m?.player) === nameKey(player));
    if (rows.length !== 1) return { kind: 'not_evaluated' };
    const m = rows[0];
    if (m.available === false) return { kind: 'inputs_unavailable', reason: m.reason || null };
    if (m.semantics && m.semantics !== 'MODEL') return { kind: 'not_published' };
    const fair = num(m.fair_line);
    if (!Number.isFinite(fair)) return { kind: 'inputs_unavailable', reason: 'fair_line_missing' };
    const opt = v => (Number.isFinite(num(v)) ? num(v) : null);
    return {
      kind: 'ready',
      player: m.player,
      event_id: String(body.event.id),
      fair_line: fair,
      gap: opt(m.fair_line_gap_yards),
      over_pct: opt(m.model_over_at_consensus_pct),
      consensus: opt(m.market_consensus_line),
      predictive_sd: opt(m.predictive_sd),
      model_version: m.model_version || body.model_version || null,
      decision_status: m.decision_status || body.decision_status || null,
      missing_inputs: arr(m.missing_inputs),
    };
  }

  root.PBEBestLinePropsCore = {
    version: 2, AVAILABILITY, MODELED_MARKET, POSITIONS,
    nameKey, teamCode, bestQuote, outcomeKind, playerRows, ladder, booksNotQuoting,
    marketState, sortRows, filterRows, identityIndex, resolveIdentity, modelState,
  };
})(typeof window !== 'undefined' ? window : globalThis);
