/* My Sunday — pure core (no I/O): item validation, canonical identity, and
 * the alert rules. The Worker (index.js) persists; this file decides.
 *
 * WHAT A SAVED ITEM IS. A reader's own research bookmark: a game, a player, a
 * prop at the line/price/book they saw, a published PBE pick (by reference
 * only), a Touchdown Target, or a Game Script Lab scenario. The saved
 * snapshot is written once and never overwritten — a repeated save of the
 * same canonical item is a no-op that returns the original. It is personal
 * research tracking: no stake, no bet, no settlement, and nothing here ever
 * enters official PBE accounting.
 *
 * WHAT AN ALERT IS. A change a shared source published AFTER the item was
 * saved, attached to that item:
 *   AVAILABILITY  nfl-intel INJURY_STATUS for the saved player
 *   GAME_STATUS   nfl-intel GAME_STATUS (delay / postponement / cancellation)
 *   MARKET_MOVE   nfl-intel cross-book consensus move on a saved game
 *   PROP_LINE / PROP_PRICE  the same provider + event + market + book + side +
 *                 player as a saved prop, now quoting a different line, or the
 *                 same line at a price at least PRICE_STEP cents away
 * Alerts are built only from positive change records. A source that failed,
 * a book that stopped quoting, a player missing from a partial feed: none of
 * these is a change, and none produces an alert.
 */

export const VERSION = 'nfl-my-sunday/1.0.0';
export const CONTRACT = 'pbe-my-sunday/v1';
export const MAX_ITEMS = 200;
export const MAX_IMPORT = 50;
export const PRICE_STEP = 15;

export const TYPES = ['game', 'player', 'prop', 'pick', 'td_target', 'scenario'];
export const MARKETS = ['player_pass_yds', 'player_pass_completions', 'player_pass_attempts', 'player_pass_tds', 'player_pass_interceptions', 'player_reception_yds', 'player_receptions', 'player_rush_yds', 'player_rush_attempts', 'player_anytime_td'];
export const SCENARIO_STATES = ['baseline', 'leading', 'trailing', 'balanced'];

const RX = {
  espnEvent: /^\d{6,12}$/,
  oddsEvent: /^[a-f0-9]{32}$/,
  espnPlayer: /^\d{1,12}$/,
  gsis: /^00-\d{7}$/,
  team: /^[A-Z]{2,3}$/,
  ref: /^[A-Za-z0-9:_.-]{1,80}$/,
  book: /^[A-Za-z0-9 .&'()+-]{1,40}$/,
  version: /^[A-Za-z0-9:_./"-]{1,80}$/
};

const clean = (v, max = 80) => {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
  return s ? s.slice(0, max) : null;
};
const iso = v => {
  if (v === undefined || v === null || v === '') return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};
const finite = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : undefined);

/* A short stable hash for scenario identity (FNV-1a, 32-bit, hex). */
export function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/* Only plain JSON (depth <= 3, <= 2 KB) survives into the stored context. */
function safeContext(ctx) {
  if (ctx === undefined || ctx === null) return {};
  if (typeof ctx !== 'object' || Array.isArray(ctx)) return undefined;
  const walk = (v, d) => {
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') return clean(v, 200);
    if (d >= 3) return null;
    if (Array.isArray(v)) return v.slice(0, 20).map(x => walk(x, d + 1));
    if (typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v).slice(0, 30)) if (/^[A-Za-z0-9_]{1,40}$/.test(k)) o[k] = walk(x, d + 1); return o; }
    return null;
  };
  const out = walk(ctx, 0);
  return JSON.stringify(out).length <= 2048 ? out : undefined;
}

/* Validate one item from the browser and derive its canonical key. The key is
   always computed here — a client-supplied key or owner is never read. */
export function validateItem(input) {
  const bad = error => ({ ok: false, error });
  if (!input || typeof input !== 'object') return bad('item_required');
  const type = String(input.type || input.item_type || '');
  if (!TYPES.includes(type)) return bad('unknown_type');
  const item = {
    item_type: type,
    season: finite(input.season),
    event_id: input.event_id ? String(input.event_id) : null,
    odds_event_id: input.odds_event_id ? String(input.odds_event_id) : null,
    player_espn_id: input.espn_id ? String(input.espn_id) : null,
    player_gsis_id: input.gsis_id ? String(input.gsis_id) : null,
    team: input.team ? String(input.team).toUpperCase() : null,
    market: input.market ? String(input.market) : null,
    side: input.side ? String(input.side).toLowerCase() : null,
    saved_line: finite(input.line),
    saved_price: finite(input.price),
    saved_book: clean(input.book, 40),
    market_captured_at: iso(input.captured_at),
    pick_ref: input.pick_ref ? String(input.pick_ref) : null,
    label: clean(input.label, 80),
    context: safeContext(input.context)
  };
  if (item.season !== null && (item.season === undefined || !Number.isInteger(item.season) || item.season < 2020 || item.season > 2100)) return bad('bad_season');
  if (item.event_id && !RX.espnEvent.test(item.event_id)) return bad('bad_event_id');
  if (item.odds_event_id && !RX.oddsEvent.test(item.odds_event_id)) return bad('bad_odds_event_id');
  if (item.player_espn_id && !RX.espnPlayer.test(item.player_espn_id)) return bad('bad_espn_id');
  if (item.player_gsis_id && !RX.gsis.test(item.player_gsis_id)) return bad('bad_gsis_id');
  if (item.team && !RX.team.test(item.team)) return bad('bad_team');
  if (item.saved_line === undefined || (item.saved_line !== null && Math.abs(item.saved_line) > 10000)) return bad('bad_line');
  if (item.saved_price === undefined || (item.saved_price !== null && (!Number.isInteger(item.saved_price) || Math.abs(item.saved_price) < 100 || Math.abs(item.saved_price) > 100000))) return bad('bad_price');
  if (input.book && (!item.saved_book || !RX.book.test(item.saved_book))) return bad('bad_book');
  if (item.market_captured_at === undefined) return bad('bad_captured_at');
  if (item.pick_ref && !RX.ref.test(item.pick_ref)) return bad('bad_pick_ref');
  if (item.context === undefined) return bad('bad_context');
  if (!item.label) return bad('label_required');
  const player = item.player_espn_id ? `e${item.player_espn_id}` : item.player_gsis_id ? `g${item.player_gsis_id}` : null;

  switch (type) {
    case 'game':
      if (!item.event_id) return bad('event_id_required');
      item.item_key = `game:${item.event_id}`;
      break;
    case 'player':
      if (!player) return bad('player_id_required');
      item.item_key = `player:${player}`;
      break;
    case 'prop': {
      if (!MARKETS.includes(item.market)) return bad('bad_market');
      if (item.side === 'yes') item.side = 'over';
      if (item.side === 'no') item.side = 'under';
      if (!['over', 'under'].includes(item.side)) return bad('bad_side');
      if (!item.event_id && !item.odds_event_id) return bad('event_required');
      if (item.market !== 'player_anytime_td' && item.saved_line === null) return bad('line_required');
      const provider = clean(input.provider_player, 80);
      if (!player && !provider) return bad('player_required');
      item.context = { ...item.context, provider_player: provider };
      item.item_key = `prop:${item.event_id || item.odds_event_id}:${player || `n${fnv(provider.toLowerCase())}`}:${item.market}:${item.side}`;
      break;
    }
    case 'pick':
      if (!item.pick_ref) return bad('pick_ref_required');
      item.item_key = `pick:${item.pick_ref}`;
      break;
    case 'td_target':
      if (!item.event_id || !player) return bad('event_and_player_required');
      item.item_key = `td:${item.event_id}:${player}`;
      break;
    case 'scenario': {
      const s = item.context?.scenario;
      if (!s || typeof s !== 'object') return bad('scenario_required');
      if (!item.team || !item.season) return bad('team_and_season_required');
      if (!SCENARIO_STATES.includes(s.state)) return bad('bad_scenario_state');
      if (!(Number.isFinite(s.volume) && s.volume >= 40 && s.volume <= 90)) return bad('bad_scenario_volume');
      if (!(s.pass_rate === null || (Number.isFinite(s.pass_rate) && s.pass_rate >= 0.2 && s.pass_rate <= 0.85))) return bad('bad_scenario_pass_rate');
      if (!RX.version.test(String(s.data_revision || '')) || !RX.version.test(String(s.calc_version || ''))) return bad('scenario_versions_required');
      const canon = JSON.stringify([item.team, item.season, s.state, s.volume, s.pass_rate, s.data_revision, s.calc_version]);
      item.item_key = `scenario:${item.team}:${item.season}:${fnv(canon)}`;
      break;
    }
  }
  return { ok: true, item };
}

/* ---- alerts ------------------------------------------------------------------ */

const after = (a, b) => { const x = Date.parse(a || ''), y = Date.parse(b || ''); return Number.isFinite(x) && Number.isFinite(y) && x > y; };

/* Match nfl-intel's /api/changes payload to saved items. Returns alert rows
   (without owner). `changes` is trusted only as far as its own `sources`
   say: an unavailable lane contributes nothing. */
export function matchIntel(items, payload) {
  const out = [];
  if (!payload || !Array.isArray(payload.changes)) return out;
  const src = payload.sources || {};
  const lanes = { INJURY_STATUS: src.injuries?.available === true, GAME_STATUS: src.scoreboard?.available === true, MARKET_MOVE: src.market?.available === true };
  for (const c of payload.changes) {
    if (!lanes[c.kind]) continue;
    for (const it of items) {
      if (c.kind === 'INJURY_STATUS') {
        if (!it.player_espn_id || String(c.player?.espn_id || '') !== it.player_espn_id) continue;
        /* A designation counts only if it was published, or its transition
           observed, after the save. */
        const when = c.transition?.observed_at || c.observed_at;
        if (!after(when, it.saved_at)) continue;
        out.push({
          alert_id: String(c.id), item_key: it.item_key, kind: 'AVAILABILITY', observed_at: when,
          payload: { headline: c.headline, previous: c.transition?.from || null, current: c.status, basis: c.transition ? 'PBE_LEDGER_TRANSITION' : 'SOURCE_UPDATE', source: c.source?.label || c.source?.provider || null, source_time: c.observed_at || null, detail: c.detail || null, game: c.game?.matchup || null, return_date: c.injury?.return_date || null }
        });
      } else if (c.kind === 'GAME_STATUS') {
        const gid = String(c.game?.id || '');
        if (!gid || gid !== it.event_id) continue;
        if (!after(c.observed_at, it.saved_at)) continue;
        out.push({ alert_id: String(c.id), item_key: it.item_key, kind: 'GAME_STATUS', observed_at: c.observed_at, payload: { headline: c.headline, current: c.status || null, detail: c.detail || null, source: c.source?.label || null } });
      } else if (c.kind === 'MARKET_MOVE') {
        if (it.item_type !== 'game' && it.item_type !== 'pick') continue;
        const gid = String(c.game?.id || '');
        if (!gid || gid !== it.event_id) continue;
        const m = c.market || {};
        if (!after(m.to?.captured_at || c.observed_at, it.saved_at)) continue;
        const lineMoved = m.from?.line !== m.to?.line, priceMoved = m.from?.price !== m.to?.price;
        out.push({
          alert_id: String(c.id), item_key: it.item_key, kind: 'MARKET_MOVE', observed_at: m.to?.captured_at || c.observed_at,
          payload: { headline: c.headline, market: m.market, selection: m.selection, movement: lineMoved && priceMoved ? 'line_and_price' : lineMoved ? 'line' : 'price', line_from: m.from?.line ?? null, line_to: m.to?.line ?? null, price_from: m.from?.price ?? null, price_to: m.to?.price ?? null, from_captured_at: m.from?.captured_at || null, to_captured_at: m.to?.captured_at || null, basis: 'CROSS_BOOK_CONSENSUS', books: m.to?.books ?? null }
        });
      }
    }
  }
  return out;
}

/* Quote accessors, identical to the Prop Board's own. */
export const q = {
  player: x => x?.player || x?.player_name || x?.description || '',
  book: x => x?.book || x?.book_title || x?.sportsbook || x?.book_key || '',
  price: x => { const n = Number(x?.price ?? x?.american_odds ?? x?.odds); return Number.isFinite(n) ? n : null; },
  point: x => { const n = Number(x?.point ?? x?.line); return Number.isFinite(n) ? n : null; },
  updated: x => x?.last_update || x?.book_last_update || x?.updated_at || x?.provider_last_update || null,
  side: x => { const r = String(x?.direction || x?.outcome || x?.side || x?.name || '').trim().toUpperCase(); return r === 'OVER' || r === 'YES' ? 'over' : r === 'UNDER' || r === 'NO' ? 'under' : null; }
};

/* The quote equivalent to a saved prop in a board snapshot: same provider
   player string, market, book and side. Null when there is none — which is
   "no current quote", never a change. */
export function equivalentQuote(item, board) {
  const who = String(item.context?.provider_player || '').toLowerCase();
  if (!who || !item.saved_book) return null;
  const quotes = Array.isArray(board?.quotes) ? board.quotes : [];
  return quotes.find(x => String(q.player(x)).toLowerCase() === who && x.market === item.market && q.book(x) === item.saved_book && q.side(x) === item.side) || null;
}

/* Saved prop vs the current snapshot of the same quote. Line and price are
   separate facts: a line move is PROP_LINE; the same line at a price PRICE_STEP+
   cents away is PROP_PRICE. The dedupe id names the exact new value, so the
   same observation delivered twice is one alert. */
export function propAlert(item, board) {
  const quote = equivalentQuote(item, board);
  if (!quote) return null;
  const line = q.point(quote), price = q.price(quote);
  const captured = board?.captured_at || q.updated(quote) || null;
  if (captured && !after(captured, item.saved_at)) return null;
  const lineMoved = item.saved_line !== null && line !== null && line !== item.saved_line;
  const priceMoved = !lineMoved && item.saved_price !== null && price !== null && priceDistance(item.saved_price, price) >= PRICE_STEP;
  if (!lineMoved && !priceMoved) return null;
  const kind = lineMoved ? 'PROP_LINE' : 'PROP_PRICE';
  return {
    alert_id: `${kind.toLowerCase()}:${item.item_key}:${line}:${price}`, item_key: item.item_key, kind, observed_at: captured || new Date().toISOString(),
    payload: { book: item.saved_book, side: item.side, market: item.market, line_from: item.saved_line, line_to: line, price_from: item.saved_price, price_to: price, captured_at: captured, basis: 'SAME_BOOK_SAME_SIDE' }
  };
}

/* American odds are not linear around even money: -110 to +110 is 20 cents,
   not 220. Distance in cents on the implied-payout scale. */
export function priceDistance(a, b) {
  const cents = p => (p >= 100 ? p - 100 : p + 100);
  return Math.abs(cents(a) - cents(b));
}

/* Items as the browser sees them: stored columns + parsed context. */
export function publicItem(row) {
  let context = {};
  try { context = JSON.parse(row.context || '{}'); } catch (_) {}
  return {
    item_key: row.item_key, item_type: row.item_type, season: row.season, event_id: row.event_id, odds_event_id: row.odds_event_id,
    espn_id: row.player_espn_id, gsis_id: row.player_gsis_id, team: row.team, market: row.market, side: row.side,
    saved_line: row.saved_line, saved_price: row.saved_price, saved_book: row.saved_book, market_captured_at: row.market_captured_at,
    pick_ref: row.pick_ref, label: row.label, context, saved_at: row.saved_at
  };
}
