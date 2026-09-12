import { readFileSync, writeFileSync } from 'node:fs';

const read = p => readFileSync(p, 'utf8');
const write = (p, s) => writeFileSync(p, s, 'utf8');
function once(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`missing marker: ${label}`);
  return text.replace(from, to);
}
function between(text, start, end, replacement, label) {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0 || b <= a) throw new Error(`missing range: ${label}`);
  return text.slice(0, a) + replacement + text.slice(b);
}

const path = 'workers/nfl-game-picks-orchestrator/src/index.js';
let src = read(path);
if (!src.includes("const VERSION = 'v1.2.0';")) throw new Error('integrity v1 patch must run first');
if (src.includes('MAX_BOOTSTRAP_MARGIN_RESIDUAL')) {
  console.log('market-anchor v2 patch already applied');
  process.exit(0);
}

src = once(src,
  `  probToAmerican, KILL_THRESHOLD, shrinkProbability, selectedWinProbability,\n  spreadCoverProbability, fairSpreadFromMargin, edgeAnomaly, monotonicityValid,\n`,
  `  probToAmerican, KILL_THRESHOLD, selectedWinProbability, normalCdf,\n  spreadCoverProbability, fairSpreadFromMargin, edgeAnomaly, monotonicityValid,\n  expectedMarginFromWinProbability, SPREAD_SIGMA,\n`,
  'coherent math imports');

src = once(src,
  `const BOOTSTRAP_PROBABILITY_SHRINK = 0.20;`,
  `const BOOTSTRAP_PROBABILITY_SHRINK = 0.20;\nconst MAX_BOOTSTRAP_MARGIN_RESIDUAL = 3.0;\nconst SIDE_FLIP_MIN_PROB_SHIFT = 0.05;\nconst SIDE_FLIP_MIN_LINE_SHIFT = 1.5;`,
  'integrity constants');

src = once(src,
  `      const weather = await weatherFor(game);\n      counts.evaluated_games += 1;`,
  `      const weather = await weatherFor(game);\n      /* One market anchor per game. ML is preferred because it directly\n       * prices straight-up win probability; the current spread is the\n       * fallback. Every market then shares the same latent home margin. */\n      const marketAnchor = marketAnchorFor(odds);\n      counts.evaluated_games += 1;`,
  'game market anchor');

src = once(src,
  `          evaluate({ game, market, quote, ratings, weather, champion, season, week }));`,
  `          evaluate({ game, market, quote, ratings, weather, champion, season, week, marketAnchor }));`,
  'evaluate market anchor call');

src = once(src,
  `export function evaluate({ game, market, quote, ratings, weather, champion, season, week }) {\n  const selectedIsHome = quote.selected_is_home === true;`,
  `export function evaluate({ game, market, quote, ratings, weather, champion, season, week, marketAnchor = null }) {\n  const selectedIsHome = quote.selected_is_home === true;`,
  'evaluate signature');

src = once(src,
  `  const integrityVersion = Number(champion?.weights?.meta?.integrity_version || 0);\n  const dome = isIndoor(game.home_team);`,
  `  if (typeof quote.selected_is_home !== 'boolean' || !quote.team) {\n    return {\n      qualifies: false, ratings_available: true, integrity_status: 'ANOMALY_REVIEW',\n      integrity_reason: 'missing_side_attribution', integrity_warning: null, side: quote.side,\n      market_line: quote.line ?? null, market_price: quote.price, model_line: null, model_prob: null,\n      market_prob: null, edge_pct: 0, confidence_bucket: null, stake_units: 0, features: null,\n      selection_team: quote.team ?? null, selection_over_under: null, side_is_home: null,\n      kickoff_ts: game.kickoff_ts, season, week,\n    };\n  }\n\n  const integrityVersion = Number(champion?.weights?.meta?.integrity_version || 0);\n  const dome = isIndoor(game.home_team);`,
  'attribution fail closed');

src = once(src,
  `  const rawHomeWin = modelProbability(champion.weights, features);\n  const homeWin = isTrainedChampion(champion)\n    ? rawHomeWin\n    : shrinkProbability(rawHomeWin, BOOTSTRAP_PROBABILITY_SHRINK);\n  const selectedWin = selectedWinProbability(homeWin, selectedIsHome);`,
  `  const anchor = validAnchor(marketAnchor) ? marketAnchor : quoteMarketAnchor(market, quote);\n  if (!validAnchor(anchor)) {\n    return {\n      qualifies: false, ratings_available: true, integrity_status: 'ANOMALY_REVIEW',\n      integrity_reason: 'market_anchor_unavailable', integrity_warning: null, side: quote.side,\n      market_line: quote.line ?? null, market_price: quote.price, model_line: null, model_prob: null,\n      market_prob: null, edge_pct: 0, confidence_bucket: null, stake_units: 0, features,\n      selection_team: quote.team ?? null, selection_over_under: null, side_is_home: selectedIsHome,\n      kickoff_ts: game.kickoff_ts, season, week,\n    };\n  }\n\n  const rawHomeWin = modelProbability(champion.weights, features);\n  const priorMargin = expectedMarginFromWinProbability(rawHomeWin);\n  const anchorMargin = expectedMarginFromWinProbability(anchor.home_win_prob);\n  const requestedWeight = Number(champion?.weights?.meta?.market_anchor_weight ?? BOOTSTRAP_PROBABILITY_SHRINK);\n  const residualWeight = Number.isFinite(requestedWeight)\n    ? Math.max(0, Math.min(0.50, requestedWeight)) : BOOTSTRAP_PROBABILITY_SHRINK;\n  const requestedCap = Number(champion?.weights?.meta?.max_margin_residual_points ?? MAX_BOOTSTRAP_MARGIN_RESIDUAL);\n  const residualCap = Number.isFinite(requestedCap) ? Math.max(0.5, Math.min(7, requestedCap)) : MAX_BOOTSTRAP_MARGIN_RESIDUAL;\n  const rawResidual = (priorMargin - anchorMargin) * residualWeight;\n  const residual = Math.max(-residualCap, Math.min(residualCap, rawResidual));\n  const modelHomeMargin = anchorMargin + residual;\n  const homeWin = normalCdf(modelHomeMargin / SPREAD_SIGMA);\n  const selectedWin = selectedWinProbability(homeWin, selectedIsHome);`,
  'market anchored latent margin');

src = once(src,
  `    integrity_status: integrityStatus, integrity_reason: integrityReason,\n    integrity_warning: edgeState.warn && !edgeState.hard ? edgeState.reason : null,`,
  `    integrity_status: integrityStatus, integrity_reason: integrityReason,\n    integrity_warning: edgeState.warn && !edgeState.hard ? edgeState.reason : null,\n    integrity_context: { anchor_source: anchor.source, anchor_home_win_prob: Number(anchor.home_win_prob.toFixed(6)), model_home_margin: Number(modelHomeMargin.toFixed(3)), residual_points: Number(residual.toFixed(3)) },`,
  'integrity context');

src = once(src,
  `  const sideFlipped = decision.side && decision.side !== open.side;\n\n  if (sideFlipped && decision.qualifies && decision.stake_units > 0) {`,
  `  const sideFlipped = decision.side && decision.side !== open.side;\n\n  if (sideFlipped && decision.qualifies && decision.stake_units > 0 && !flipAllowed(open, decision, market)) {\n    /* Hysteresis: a one-tick price wobble cannot reverse a frozen decision.\n     * The old side remains until the latent probability meaningfully moves,\n     * or a spread crosses by at least 1.5 points. Totals are disabled. */\n    tally.kept = 1;\n    return tally;\n  }\n\n  if (sideFlipped && decision.qualifies && decision.stake_units > 0) {`,
  'flip hysteresis');

const helpers = `export function marketAnchorFor(odds) {\n  const ml = odds?.get?.('moneyline') || [];\n  const homeMl = ml.find(q => q.selected_is_home === true);\n  if (homeMl) {\n    try {\n      const p = devigTwoWay(homeMl.price, homeMl.opposite_price);\n      if (p > 0 && p < 1) return { home_win_prob: p, source: 'consensus_moneyline' };\n    } catch (_) {}\n  }\n  const spread = odds?.get?.('spread') || [];\n  const homeSpread = spread.find(q => q.selected_is_home === true && Number.isFinite(Number(q.line)));\n  if (homeSpread) {\n    const homeMargin = -Number(homeSpread.line);\n    const p = normalCdf(homeMargin / SPREAD_SIGMA);\n    if (p > 0 && p < 1) return { home_win_prob: p, source: 'consensus_spread' };\n  }\n  return null;\n}\n\nfunction quoteMarketAnchor(market, quote) {\n  try {\n    if (market === 'moneyline') {\n      const selected = devigTwoWay(quote.price, quote.opposite_price);\n      return { home_win_prob: quote.selected_is_home === true ? selected : 1 - selected, source: 'quote_moneyline_fallback' };\n    }\n    if (market === 'spread' && Number.isFinite(Number(quote.line))) {\n      const selectedMargin = -Number(quote.line);\n      const homeMargin = quote.selected_is_home === true ? selectedMargin : -selectedMargin;\n      return { home_win_prob: normalCdf(homeMargin / SPREAD_SIGMA), source: 'quote_spread_fallback' };\n    }\n  } catch (_) {}\n  return null;\n}\n\nfunction validAnchor(anchor) {\n  const p = Number(anchor?.home_win_prob);\n  return Number.isFinite(p) && p > 0.01 && p < 0.99;\n}\n\nexport function flipAllowed(open, decision, market) {\n  if (!open || !decision || market === 'total') return false;\n  const oldProb = Number(open.model_prob);\n  const newProb = Number(decision.model_prob);\n  if (!Number.isFinite(oldProb) || !Number.isFinite(newProb)) return false;\n  /* Compare the new opposite-side probability with the complement of what the\n   * old model believed at issuance. Market-only price noise produces ~0. */\n  const probabilityShift = Math.abs(newProb - (1 - oldProb));\n  let lineShift = 0;\n  if (market === 'spread') {\n    const oldLine = Number(open.market_line), newLine = Number(decision.market_line);\n    if (Number.isFinite(oldLine) && Number.isFinite(newLine)) {\n      lineShift = Math.abs(Math.abs(newLine) - Math.abs(oldLine));\n    }\n  }\n  return probabilityShift >= SIDE_FLIP_MIN_PROB_SHIFT\n    || (probabilityShift >= 0.02 && lineShift >= SIDE_FLIP_MIN_LINE_SHIFT);\n}\n\n`;
src = once(src, 'async function queueAnomaly(env, { game, market, champion, decisions, season, week }) {', helpers + 'async function queueAnomaly(env, { game, market, champion, decisions, season, week }) {', 'anchor/hysteresis helpers');
write(path, src);

// Update outdated unit expectations to the coherent-margin contract.
const testPath = 'workers/nfl-picks-engine-shared/tests/acceptance.test.mjs';
let test = read(testPath);
const oldThresholdTestStart = "test('[2] moneyline needs 3% where spread needs 2% — same edge, different verdict', () => {";
const nextThresholdTest = "test('[2] an issued pick records the market terms it was actually taken at', () => {";
const coherentTest = `test('[2] spread and moneyline come from one coherent latent margin', () => {\n  const anchor = { home_win_prob: 0.60, source: 'fixture' };\n  const common = { game: { ...GAME, rest_home: 7, rest_away: 7 }, ratings: RATINGS, weather: null, champion: CHAMPION, season: 2026, week: 1, marketAnchor: anchor };\n  const ml = evaluate({ ...common, market: 'moneyline', quote: { side: 'SEA ML', line: null, price: -150, opposite_price: 130, selected_is_home: true, team: 'SEA', over_under: null } });\n  const spread = evaluate({ ...common, market: 'spread', quote: { side: 'SEA -3.5', line: -3.5, price: -110, opposite_price: -110, selected_is_home: true, team: 'SEA', over_under: null } });\n  assert.ok(spread.model_prob <= ml.model_prob + 1e-6, 'covering -3.5 cannot exceed winning outright');\n\n  const dogMl = evaluate({ ...common, market: 'moneyline', quote: { side: 'NE ML', line: null, price: 130, opposite_price: -150, selected_is_home: false, team: 'NE', over_under: null } });\n  const dogSpread = evaluate({ ...common, market: 'spread', quote: { side: 'NE +3.5', line: 3.5, price: -110, opposite_price: -110, selected_is_home: false, team: 'NE', over_under: null } });\n  assert.ok(dogSpread.model_prob + 1e-6 >= dogMl.model_prob, 'covering +3.5 cannot be less likely than winning outright');\n  assert.ok(Math.abs((ml.model_prob + dogMl.model_prob) - 1) < 1e-6, 'opposite moneylines must be complements');\n});\n\n`;
test = between(test, oldThresholdTestStart, nextThresholdTest, coherentTest, 'replace obsolete threshold test');

const sideMarker = '/* --------------------------------------------------------------------------\n * Side attribution end-to-end (launch blocker)';
const sideAt = test.indexOf(sideMarker);
if (sideAt < 0) throw new Error('missing side attribution section');
const replacementSide = `/* --------------------------------------------------------------------------\n * Integrity v2 — canonical perspective, total hold, attribution\n * ----------------------------------------------------------------------- */\n\nconst awayQuote = {\n  side: 'NE +2.5', line: 2.5, price: -110, opposite_price: -110, line_move: 0,\n  selected_is_home: false, team: 'NE', over_under: null,\n};\nconst totalQuote = {\n  side: 'OVER 44.5', line: 44.5, price: -110, opposite_price: -110, line_move: 0,\n  selected_is_home: false, team: null, over_under: 'OVER',\n};\n\ntest('[integrity] home and away selections share one canonical HOME feature snapshot', () => {\n  const gameWithRest = { ...GAME, rest_home: 7, rest_away: 4 };\n  const anchor = { home_win_prob: 0.58, source: 'fixture' };\n  const common = { game: gameWithRest, market: 'spread', ratings: RATINGS, weather: null, champion: CHAMPION, season: 2026, week: 2, marketAnchor: anchor };\n  const home = evaluate({ ...common, quote: { ...strongQuote, team: 'SEA', selected_is_home: true } });\n  const away = evaluate({ ...common, quote: awayQuote });\n  assert.deepEqual(home.features, away.features, 'quote direction must not change latent team-strength features');\n  assert.equal(home.features.home, 1);\n  assert.equal(home.features.rest_diff, 3);\n  assert.equal(home.selection_team, 'SEA');\n  assert.equal(away.selection_team, 'NE');\n  assert.equal(away.side_is_home, false);\n});\n\ntest('[integrity] totals fail closed until a dedicated expected-total model exists', () => {\n  const over = evaluate({\n    game: { ...GAME, rest_home: 7, rest_away: 7 }, market: 'total', quote: totalQuote,\n    ratings: RATINGS, weather: null, champion: CHAMPION, season: 2026, week: 2,\n  });\n  const under = evaluate({\n    game: { ...GAME, rest_home: 7, rest_away: 7 }, market: 'total',\n    quote: { ...totalQuote, side: 'UNDER 44.5', over_under: 'UNDER' },\n    ratings: RATINGS, weather: null, champion: CHAMPION, season: 2026, week: 2,\n  });\n  for (const d of [over, under]) {\n    assert.equal(d.qualifies, false);\n    assert.equal(d.integrity_status, 'MODEL_DISABLED');\n    assert.equal(d.integrity_reason, 'dedicated_total_model_required');\n    assert.equal(d.stake_units, 0);\n  }\n});\n\ntest('[integrity] missing team attribution is quarantined, never treated as away', () => {\n  const d = evaluate({\n    game: { ...GAME, rest_home: 7, rest_away: 7 }, market: 'spread',\n    quote: { ...awayQuote, selected_is_home: undefined }, ratings: RATINGS, weather: null,\n    champion: CHAMPION, season: 2026, week: 2, marketAnchor: { home_win_prob: 0.55, source: 'fixture' },\n  });\n  assert.equal(d.integrity_status, 'ANOMALY_REVIEW');\n  assert.equal(d.integrity_reason, 'missing_side_attribution');\n  assert.equal(d.qualifies, false);\n});\n`;
test = test.slice(0, sideAt) + replacementSide;
write(testPath, test);

console.log('NFL market-anchor v2 patch applied');
