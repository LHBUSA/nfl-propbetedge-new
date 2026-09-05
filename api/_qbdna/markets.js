/* Current QB prop markets — read from the EXISTING PropBetEdge market source.
 * =============================================================================
 * There is no second odds source here. This module calls the same NFL odds
 * gateway the Prop Board, Market Watch and Model Lab already use:
 *
 *     GET {NFL_GATEWAY}/api/odds/events
 *     GET {NFL_GATEWAY}/api/odds/board?event_id=...&markets=...
 *
 * The hierarchy the product depends on:
 *
 *     CURRENT MARKET LINE  →  QB DNA historical threshold calculation
 *
 * A market that is not offered is reported as CURRENT MARKET UNAVAILABLE.
 * A default line is NEVER inserted — a fabricated line would produce a real,
 * confident-looking hit rate for a number nobody is actually offering.
 * ========================================================================== */

import { dataset } from './engine.js';

const GATEWAY = process.env.NFL_GATEWAY || 'https://nfl-api.propbetedge.ai';

/** Gateway market key ↔ our market key. Only these five are supported. */
export const MARKET_MAP = {
  player_pass_yds:            'passing_yards',
  player_pass_attempts:       'passing_attempts',
  player_pass_completions:    'completions',
  player_pass_tds:            'passing_touchdowns',
  player_pass_interceptions:  'interceptions'
};
export const GATEWAY_MARKETS = Object.keys(MARKET_MAP);
export const OUR_TO_GATEWAY = Object.fromEntries(
  Object.entries(MARKET_MAP).map(([g, o]) => [o, g]));

export const MARKET_UNAVAILABLE = 'CURRENT MARKET UNAVAILABLE';

async function getJSON(url, ms = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`gateway_${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

export async function events() {
  const j = await getJSON(`${GATEWAY}/api/odds/events`);
  const rows = Array.isArray(j) ? j : (j.events || j.data || []);
  return rows.map(r => ({
    event_id: String(r.id),
    commence_time: r.commence_time,
    home_team: r.home_team, away_team: r.away_team
  })).sort((a, b) => String(a.commence_time).localeCompare(String(b.commence_time)));
}

/* The market gives a NAME, not an id. An exact name match against our identity
   spine is the only resolution used; an ambiguous or unknown name resolves to
   nothing and says so. A fuzzy match here would attach one quarterback's
   history to another quarterback's line, which is the worst error available. */
function resolveByName(name) {
  const D = dataset();
  const want = String(name || '').toLowerCase().trim();
  if (!want) return { gsis_id: null, reason: 'no name on the quote' };
  const hits = D.players.filter(p => String(p.display_name).toLowerCase() === want);
  if (hits.length === 1) return { gsis_id: hits[0].gsis_id, matched_by: 'exact_name', player: hits[0] };
  if (hits.length > 1) {
    return { gsis_id: null, reason: 'ambiguous name in our identity spine',
             candidates: hits.map(h => h.gsis_id) };
  }
  return { gsis_id: null, reason: 'no quarterback in our dataset carries this exact name' };
}

/**
 * Current QB prop markets for one event, grouped by player.
 * Returns `{ available, event, players[], markets_offered, source }`.
 */
export async function eventMarkets(eventId) {
  const url = `${GATEWAY}/api/odds/board?event_id=${encodeURIComponent(eventId)}`
            + `&markets=${GATEWAY_MARKETS.join(',')}`;
  let board;
  try {
    board = await getJSON(url, 15000);
  } catch (e) {
    return {
      available: false, state: MARKET_UNAVAILABLE,
      reason: `market source unreachable: ${e.message}`,
      event_id: String(eventId), source: { gateway: GATEWAY, url }
    };
  }

  const summary = Array.isArray(board.market_summary) ? board.market_summary : [];
  if (!summary.length) {
    return {
      available: false, state: MARKET_UNAVAILABLE,
      reason: 'the market source returned no quarterback passing markets for this event',
      event_id: String(eventId), event: board.event || null,
      source: { gateway: GATEWAY, url, provider: board.source, provider_last_update: board.provider_last_update }
    };
  }

  const byPlayer = new Map();
  for (const s of summary) {
    const our = MARKET_MAP[s.market];
    if (!our) continue;                     // a market we cannot count is ignored
    if (!byPlayer.has(s.player)) {
      const r = resolveByName(s.player);
      byPlayer.set(s.player, {
        player_name: s.player,
        gsis_id: r.gsis_id, matched_by: r.matched_by || null,
        resolution_note: r.gsis_id ? null : r.reason,
        candidates: r.candidates,
        markets: {}
      });
    }
    byPlayer.get(s.player).markets[our] = {
      market: our, gateway_market: s.market,
      // the consensus line is the market's own number. we never round or adjust it.
      line: s.consensus_line ?? null,
      line_low: s.line_low ?? null, line_high: s.line_high ?? null,
      book_count: s.book_count ?? null,
      books: s.books || []
    };
  }

  // every supported market, with the unavailable ones stated rather than absent
  for (const p of byPlayer.values()) {
    p.unavailable_markets = Object.values(MARKET_MAP)
      .filter(m => !p.markets[m])
      .map(m => ({ market: m, state: MARKET_UNAVAILABLE,
                   reason: 'no book in the current market is offering this market for this player' }));
  }

  return {
    available: true,
    event_id: String(eventId),
    event: board.event || null,
    players: [...byPlayer.values()],
    markets_offered: [...new Set(summary.map(s => MARKET_MAP[s.market]).filter(Boolean))],
    quote_count: board.quote_count ?? null,
    source: {
      gateway: GATEWAY, url,
      provider: board.source || null,
      provider_last_update: board.provider_last_update || null,
      note: 'Current markets come from the existing PropBetEdge market source. '
          + 'QB DNA does not operate a second odds source.'
    }
  };
}

/** One player's markets for one event, or an explicit unavailable state. */
export async function playerMarkets(eventId, gsisId) {
  const m = await eventMarkets(eventId);
  if (!m.available) return m;
  const hit = m.players.find(p => p.gsis_id === gsisId);
  if (!hit) {
    return {
      available: false, state: MARKET_UNAVAILABLE,
      reason: 'the current market does not price this quarterback for this event',
      event_id: m.event_id, event: m.event, source: m.source,
      priced_players: m.players.map(p => p.player_name)
    };
  }
  return { available: true, event_id: m.event_id, event: m.event, source: m.source, ...hit };
}
