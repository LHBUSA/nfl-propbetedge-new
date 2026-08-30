/* PropBetEdge NFL Player Prop Engine — deterministic selector math.
 *
 * Projection authority stays upstream. This module never invents a player
 * projection; it converts a supplied fair-line distribution + an executable
 * two-way sportsbook quote into probability, fair odds, edge, EV and sizing.
 */
import { americanToDecimal, devigTwoWay } from '../nfl-picks-engine-shared/pick-math.mjs';

export const PROP_MARKET = 'player_pass_yds';
export const PROP_KILL_EDGE_DEFAULT = 0.02;

export function playerKey(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalCdf(z) {
  const x = Number(z);
  if (!Number.isFinite(x)) throw new Error('bad_z');
  // Abramowitz & Stegun 7.1.26 erf approximation. Deterministic and more than
  // sufficient for sportsbook probability precision at displayed 0.1% levels.
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * a);
  const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t)
    + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
  return 0.5 * (1 + erf);
}

export function modelSideProbability({ fairLine, predictiveSd, line, side }) {
  const mean = Number(fairLine), sd = Number(predictiveSd), threshold = Number(line);
  if (!Number.isFinite(mean) || !Number.isFinite(sd) || !(sd > 0) || !Number.isFinite(threshold)) {
    throw new Error('bad_projection');
  }
  const over = 1 - normalCdf((threshold - mean) / sd);
  const s = String(side || '').toUpperCase();
  if (s === 'OVER') return over;
  if (s === 'UNDER') return 1 - over;
  throw new Error('unsupported_side');
}

export function expectedValuePct(modelProb, americanPrice) {
  const p = Number(modelProb);
  if (!(p > 0 && p < 1)) throw new Error('bad_prob');
  const decimal = americanToDecimal(americanPrice);
  return Number(((p * decimal - 1) * 100).toFixed(4));
}

export function kellyUnits(modelProb, americanPrice, config = {}) {
  const p = Number(modelProb);
  if (!(p > 0 && p < 1)) throw new Error('bad_prob');
  const b = americanToDecimal(americanPrice) - 1;
  if (!(b > 0)) throw new Error('bad_price');
  const full = (b * p - (1 - p)) / b;
  if (!(full > 0)) return 0;
  const fraction = finite(config.kelly_fraction, 0.25);
  const floor = finite(config.stake_floor_units, 0.5);
  const cap = finite(config.stake_cap_units, 2.0);
  // 1 unit = 1% of bankroll, matching the governed game picker.
  const units = full * fraction * 100;
  return Math.min(cap, Math.max(floor, Number(units.toFixed(4))));
}

export function confidenceBucket(edge, config = {}) {
  const e = Number(edge);
  const min = finite(config.min_edge, 0.04);
  if (!Number.isFinite(e) || e < min) return null;
  if (e >= finite(config.confidence_a_edge, 0.075)) return 'A';
  if (e >= finite(config.confidence_b_edge, 0.055)) return 'B';
  return 'C';
}

export function issuancePhase(kickoffTs, nowMs = Date.now(), config = {}) {
  const kickoff = Date.parse(kickoffTs);
  if (!Number.isFinite(kickoff)) return null;
  const hours = (kickoff - nowMs) / 3600000;
  if (hours < 0) return null;
  const lockedMax = finite(config.locked_max_hours, 4);
  const earlyMin = finite(config.early_bird_min_hours, 12);
  if (hours <= lockedMax) return { phase: 'locked', hours_to_kickoff: hours };
  if (hours >= earlyMin) return { phase: 'early_bird', hours_to_kickoff: hours };
  // Deliberate quiet zone: do not churn an early decision just because kickoff
  // is approaching. The next governed re-check is the locked window.
  return { phase: null, hours_to_kickoff: hours };
}

export function pairCurrentQuotes(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const player = row?.player || row?.player_name || '';
    const book = row?.book || '';
    const side = String(row?.side || row?.direction || '').toUpperCase();
    const current = row?.current || row;
    const point = finiteOrNull(current?.point ?? row?.point);
    const price = finiteOrNull(current?.price ?? row?.price);
    if (!player || !book || !['OVER', 'UNDER'].includes(side) || point === null || price === null || price === 0) continue;
    const key = `${playerKey(player)}|${String(book).toLowerCase()}|${point}`;
    if (!groups.has(key)) groups.set(key, { player, player_key: playerKey(player), book, point, rows: {} });
    const group = groups.get(key);
    group.rows[side] = {
      player, player_key: group.player_key, book, side, point, price: Math.round(price),
      captured_at: current?.captured_at || row?.captured_at || null,
      open_point: finiteOrNull(row?.open?.point),
      open_price: finiteOrNull(row?.open?.price),
    };
  }

  const paired = [];
  for (const group of groups.values()) {
    const over = group.rows.OVER, under = group.rows.UNDER;
    if (!over || !under) continue;
    paired.push({ ...over, opposite_price: under.price });
    paired.push({ ...under, opposite_price: over.price });
  }
  return paired;
}

export function evaluatePropQuote({ projection, quote, bookCount, selector, kickoffTs, nowMs = Date.now() }) {
  const config = selector?.config || {};
  const fairLine = finiteOrNull(projection?.fair_line ?? projection?.projected_line);
  const predictiveSd = finiteOrNull(projection?.predictive_sd);
  const line = finiteOrNull(quote?.point);
  const price = finiteOrNull(quote?.price);
  const opposite = finiteOrNull(quote?.opposite_price);
  const phase = issuancePhase(kickoffTs, nowMs, config);

  if (projection?.available === false) return unavailable('projection_unavailable', quote, phase);
  if (fairLine === null || predictiveSd === null || !(predictiveSd > 0)) return unavailable('projection_distribution_unavailable', quote, phase);
  if (line === null || price === null || opposite === null) return unavailable('two_way_quote_unavailable', quote, phase);
  if (!phase?.phase) return unavailable('between_issuance_windows', quote, phase);

  const modelProb = modelSideProbability({ fairLine, predictiveSd, line, side: quote.side });
  const marketProb = devigTwoWay(price, opposite);
  const edge = Number((modelProb - marketProb).toFixed(6));
  const evPct = expectedValuePct(modelProb, price);
  const bucket = confidenceBucket(edge, config);
  const stake = bucket ? kellyUnits(modelProb, price, config) : 0;
  const enoughBooks = Number(bookCount || 0) >= finite(config.min_books, 4);
  const qualifies = enoughBooks
    && edge >= finite(config.min_edge, 0.04)
    && evPct >= finite(config.min_ev_pct, 5.0)
    && bucket !== null
    && stake > 0;

  const signedGapZ = quote.side === 'OVER'
    ? (fairLine - line) / predictiveSd
    : (line - fairLine) / predictiveSd;

  return {
    qualifies,
    available: true,
    unavailable_reason: null,
    phase: phase.phase,
    hours_to_kickoff: Number(phase.hours_to_kickoff.toFixed(4)),
    player_name: quote.player,
    player_key: quote.player_key,
    side: quote.side,
    book: quote.book,
    market_line: line,
    market_price: Math.round(price),
    opposite_price: Math.round(opposite),
    model_fair_line: fairLine,
    predictive_sd: predictiveSd,
    model_prob: Number(modelProb.toFixed(6)),
    market_prob: Number(marketProb.toFixed(6)),
    edge_pct: edge,
    ev_pct: evPct,
    stake_units: stake,
    confidence_bucket: bucket,
    book_count: Number(bookCount || 0),
    signed_gap_z: Number(signedGapZ.toFixed(6)),
    quote_captured_at: quote.captured_at || null,
    open_point: quote.open_point ?? null,
    open_price: quote.open_price ?? null,
  };
}

export function selectorFeatures(decision) {
  return {
    model_prob: finite(decision?.model_prob, 0),
    market_prob: finite(decision?.market_prob, 0),
    edge_pct: finite(decision?.edge_pct, 0),
    ev_pct: finite(decision?.ev_pct, 0) / 100,
    signed_gap_z: finite(decision?.signed_gap_z, 0),
    book_count_scaled: Math.min(1, Math.max(0, finite(decision?.book_count, 0) / 10)),
    hours_to_kickoff_scaled: Math.min(1, Math.max(0, finite(decision?.hours_to_kickoff, 0) / 36)),
    locked: decision?.phase === 'locked' ? 1 : 0,
  };
}

export const SELECTOR_FEATURE_ORDER = Object.freeze([
  'model_prob', 'market_prob', 'edge_pct', 'ev_pct', 'signed_gap_z',
  'book_count_scaled', 'hours_to_kickoff_scaled', 'locked',
]);

function unavailable(reason, quote, phase) {
  return {
    qualifies: false, available: false, unavailable_reason: reason,
    phase: phase?.phase || null,
    hours_to_kickoff: phase?.hours_to_kickoff ?? null,
    player_name: quote?.player || null,
    player_key: quote?.player_key || playerKey(quote?.player),
    side: quote?.side || null,
    book: quote?.book || null,
    edge_pct: 0, ev_pct: 0, stake_units: 0, confidence_bucket: null,
  };
}

function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
