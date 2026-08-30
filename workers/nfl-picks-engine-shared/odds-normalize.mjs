/* Canonical odds normalization.
 *
 * Provider contract, verified live against
 * https://nfl-api.propbetedge.ai/api/odds on 2026-08-30:
 *
 *   event   { id, sport_key, commence_time, home_team, away_team, bookmakers[] }
 *           home_team / away_team are FULL NAMES ("Seattle Seahawks").
 *   bookmaker { key, title, last_update, markets[] }
 *   market  { key: 'h2h'|'spreads'|'totals', last_update, outcomes[] }
 *   outcome { name, description, price, point }
 *
 *     h2h     name = full team name, point = null
 *     spreads name = full team name, point = that team's spread (signed)
 *     totals  name = 'Over' | 'Under', point = the total
 *
 * An away-team pick recorded as home is a launch blocker, so team identity is
 * resolved by explicit full-name -> gateway-code mapping. There is no
 * positional guessing and no selected_is_home default anywhere.
 */

/* All 32 names returned by the provider, mapped to the gateway's codes. Both
 * sets were enumerated live and are exactly 32 with a 1:1 correspondence. */
export const TEAM_NAME_TO_CODE = {
  'Arizona Cardinals': 'ARI',
  'Atlanta Falcons': 'ATL',
  'Baltimore Ravens': 'BAL',
  'Buffalo Bills': 'BUF',
  'Carolina Panthers': 'CAR',
  'Chicago Bears': 'CHI',
  'Cincinnati Bengals': 'CIN',
  'Cleveland Browns': 'CLE',
  'Dallas Cowboys': 'DAL',
  'Denver Broncos': 'DEN',
  'Detroit Lions': 'DET',
  'Green Bay Packers': 'GB',
  'Houston Texans': 'HOU',
  'Indianapolis Colts': 'IND',
  'Jacksonville Jaguars': 'JAX',
  'Kansas City Chiefs': 'KC',
  'Las Vegas Raiders': 'LV',
  'Los Angeles Chargers': 'LAC',
  'Los Angeles Rams': 'LA',
  'Miami Dolphins': 'MIA',
  'Minnesota Vikings': 'MIN',
  'New England Patriots': 'NE',
  'New Orleans Saints': 'NO',
  'New York Giants': 'NYG',
  'New York Jets': 'NYJ',
  'Philadelphia Eagles': 'PHI',
  'Pittsburgh Steelers': 'PIT',
  'San Francisco 49ers': 'SF',
  'Seattle Seahawks': 'SEA',
  'Tampa Bay Buccaneers': 'TB',
  'Tennessee Titans': 'TEN',
  'Washington Commanders': 'WAS',
};

export const PROVIDER_MARKET_TO_CANONICAL = {
  h2h: 'moneyline',
  spreads: 'spread',
  totals: 'total',
};

/* Unknown names return null rather than a guess. A rebrand or an expansion
 * team must fail loudly, not silently pick the wrong side. */
export function teamCodeFromName(name) {
  const key = String(name || '').trim();
  return TEAM_NAME_TO_CODE[key] || null;
}

export function isOverUnder(name) {
  const n = String(name || '').trim().toLowerCase();
  if (n === 'over') return 'OVER';
  if (n === 'under') return 'UNDER';
  return null;
}

/* The canonical side string stored on a pick and a snapshot.
 *   moneyline -> 'GB ML'
 *   spread    -> 'MIN -2.5' / 'MIN +2.5'
 *   total     -> 'OVER 44.5' / 'UNDER 44.5'
 */
export function canonicalSide({ market, teamCode, overUnder, point }) {
  /* Number(null) is 0, so a null point would otherwise render as a confident
   * "MIN +0" instead of failing. Require a genuine number. */
  const p = point === null || point === undefined || point === '' ? NaN : Number(point);

  if (market === 'moneyline') {
    if (!teamCode) return null;
    return `${teamCode} ML`;
  }
  if (market === 'spread') {
    if (!teamCode || !Number.isFinite(p)) return null;
    return `${teamCode} ${p > 0 ? '+' : ''}${p}`;
  }
  if (market === 'total') {
    if (!overUnder || !Number.isFinite(p)) return null;
    return `${overUnder} ${p}`;
  }
  return null;
}

/* Normalizes ONE provider outcome into a fully-attributed selection.
 *
 * Every field the handoff requires to be preserved is carried through:
 * provider outcome name, canonical selection, team identity, line, price,
 * bookmaker and the captured timestamp. `is_home` is derived from the event's
 * own home_team, never assumed.
 */
export function normalizeOutcome({ event, bookmaker, marketKey, outcome, capturedAt }) {
  const market = PROVIDER_MARKET_TO_CANONICAL[marketKey];
  if (!market) return null;

  const price = Number(outcome?.price);
  if (!Number.isFinite(price) || price === 0) return null;

  const point = outcome?.point === null || outcome?.point === undefined
    ? null
    : Number(outcome.point);

  const homeCode = teamCodeFromName(event?.home_team);
  const awayCode = teamCodeFromName(event?.away_team);

  let teamCode = null;
  let overUnder = null;
  let isHome = null;

  if (market === 'total') {
    overUnder = isOverUnder(outcome?.name);
    if (!overUnder) return null;
  } else {
    teamCode = teamCodeFromName(outcome?.name);
    if (!teamCode) return null;
    /* Identity is decided by comparing to the event's declared home/away, so
     * an away selection can never be recorded as home. */
    if (teamCode === homeCode) isHome = true;
    else if (teamCode === awayCode) isHome = false;
    else return null;
  }

  if (market === 'spread' && !Number.isFinite(point)) return null;
  if (market === 'total' && !Number.isFinite(point)) return null;

  const side = canonicalSide({ market, teamCode, overUnder, point });
  if (!side) return null;

  return {
    market,
    provider_market: marketKey,
    provider_outcome_name: String(outcome?.name || ''),
    side,
    team: teamCode,
    over_under: overUnder,
    is_home: isHome,
    line: market === 'moneyline' ? null : point,
    price,
    book: String(bookmaker?.key || 'unknown'),
    book_title: String(bookmaker?.title || ''),
    captured_at: capturedAt || bookmaker?.last_update || null,
    home_team: homeCode,
    away_team: awayCode,
  };
}

/* Normalizes an entire event into a flat selection list. */
export function normalizeEvent(event, capturedAt) {
  const out = [];
  for (const bookmaker of event?.bookmakers || []) {
    for (const market of bookmaker?.markets || []) {
      for (const outcome of market?.outcomes || []) {
        const row = normalizeOutcome({
          event, bookmaker, marketKey: market.key, outcome,
          capturedAt: capturedAt || market.last_update || bookmaker.last_update,
        });
        if (row) out.push(row);
      }
    }
  }
  return out;
}

/* Median-consensus across books, per (market, side). Keeps `book` honest:
 * 'consensus:<n>' when several books contribute, otherwise the single book's
 * key. Team identity and is_home are carried from the selections, never
 * recomputed. */
export function consensusByside(selections) {
  /* Group by market + SELECTION IDENTITY (team, or Over/Under) — never by the
   * canonical side string, which embeds the line. Books legitimately quote
   * different numbers (44.5 vs 45); grouping on the side string would split
   * one selection into several and produce four "sides" for a two-sided
   * market. The consensus line is the median across books, and the canonical
   * side is regenerated from it. */
  const groups = new Map();
  for (const row of selections) {
    const identity = row.market === 'total' ? row.over_under : row.team;
    const key = `${row.market}|${identity}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const out = [];
  for (const rows of groups.values()) {
    const prices = rows.map(r => r.price);
    const lines = rows.map(r => r.line).filter(v => Number.isFinite(v));
    const first = rows[0];
    const line = lines.length ? median(lines) : null;
    const side = canonicalSide({
      market: first.market, teamCode: first.team,
      overUnder: first.over_under, point: line,
    }) || first.side;

    out.push({
      ...first,
      side,
      price: Math.round(median(prices)),
      line,
      book: rows.length > 1 ? `consensus:${rows.length}` : first.book,
      book_count: rows.length,
    });
  }
  return out;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* Pairs each selection with its opposite side so a price can be de-vigged.
 * Spreads and moneylines pair by the other team; totals pair OVER with UNDER.
 * A selection with no locatable opposite is returned with opposite_price null
 * and MUST NOT be de-vigged by the caller. */
export function pairOpposites(selections) {
  const byMarket = new Map();
  for (const row of selections) {
    if (!byMarket.has(row.market)) byMarket.set(row.market, []);
    byMarket.get(row.market).push(row);
  }

  const out = [];
  for (const [market, rows] of byMarket) {
    for (const row of rows) {
      let opposite = null;
      if (market === 'total') {
        const want = row.over_under === 'OVER' ? 'UNDER' : 'OVER';
        opposite = rows.find(r => r.over_under === want) || null;
      } else {
        opposite = rows.find(r => r.team && r.team !== row.team) || null;
      }
      out.push({ ...row, opposite_price: opposite ? opposite.price : null });
    }
  }
  return out;
}
