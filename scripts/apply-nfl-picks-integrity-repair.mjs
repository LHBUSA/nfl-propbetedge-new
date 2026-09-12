import { readFileSync, writeFileSync } from 'node:fs';

function read(path) { return readFileSync(path, 'utf8'); }
function write(path, text) { writeFileSync(path, text, 'utf8'); }
function replaceOnce(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`missing marker: ${label}`);
  return text.replace(from, to);
}
function replaceBetween(text, start, end, replacement, label) {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0 || b <= a) throw new Error(`missing range: ${label}`);
  return text.slice(0, a) + replacement + text.slice(b);
}

const orchestratorPath = 'workers/nfl-game-picks-orchestrator/src/index.js';
let orchestrator = read(orchestratorPath);
if (orchestrator.includes("const VERSION = 'v1.2.0';")) {
  console.log('NFL picks integrity repair already applied');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Shared probability math: one latent margin distribution for ML + spread.
// ---------------------------------------------------------------------------
const mathPath = 'workers/nfl-picks-engine-shared/pick-math.mjs';
let math = read(mathPath);
math = replaceOnce(
  math,
  "export const TOTAL_SIGMA = 10.5;\n",
  `export const TOTAL_SIGMA = 10.5;\n\n/* Integrity v2: ML and spread must come from one latent margin distribution.\n * A selected team's cover probability is therefore monotone with its straight-\n * up win probability by construction, not by a UI-level patch. */\nexport const EDGE_ANOMALY_WARN = 0.08;\nexport const EDGE_ANOMALY_HARD = 0.15;\n\nexport function normalCdf(x) {\n  const z = Number(x);\n  if (!Number.isFinite(z)) throw new Error('bad_z');\n  const sign = z < 0 ? -1 : 1;\n  const a = Math.abs(z) / Math.sqrt(2);\n  const t = 1 / (1 + 0.3275911 * a);\n  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-a * a);\n  return 0.5 * (1 + sign * erf);\n}\n\nexport function shrinkProbability(prob, factor = 1) {\n  const p = Number(prob), f = Number(factor);\n  if (!(p > 0 && p < 1) || !Number.isFinite(f) || f < 0 || f > 1) throw new Error('bad_shrink');\n  return 0.5 + (p - 0.5) * f;\n}\n\nexport function expectedMarginFromWinProbability(homeWinProb, sigma = SPREAD_SIGMA) {\n  const p = Math.max(1e-6, Math.min(1 - 1e-6, Number(homeWinProb)));\n  if (!Number.isFinite(p)) throw new Error('bad_prob');\n  return normalQuantile(p) * sigma;\n}\n\nexport function selectedWinProbability(homeWinProb, selectedIsHome) {\n  const p = Number(homeWinProb);\n  if (!(p > 0 && p < 1)) throw new Error('bad_prob');\n  return selectedIsHome ? p : 1 - p;\n}\n\nexport function spreadCoverProbability({ homeWinProb, selectedIsHome, line, sigma = SPREAD_SIGMA }) {\n  const l = Number(line);\n  if (!Number.isFinite(l)) throw new Error('bad_line');\n  const homeMargin = expectedMarginFromWinProbability(homeWinProb, sigma);\n  const selectedMargin = selectedIsHome ? homeMargin : -homeMargin;\n  return normalCdf((selectedMargin + l) / sigma);\n}\n\nexport function fairSpreadFromMargin({ homeWinProb, selectedIsHome, sigma = SPREAD_SIGMA }) {\n  const homeMargin = expectedMarginFromWinProbability(homeWinProb, sigma);\n  const selectedMargin = selectedIsHome ? homeMargin : -homeMargin;\n  return -selectedMargin;\n}\n\nexport function edgeAnomaly(edge) {\n  const e = Number(edge);\n  if (!Number.isFinite(e)) return { hard: true, warn: true, reason: 'edge_not_finite' };\n  if (e > EDGE_ANOMALY_HARD) return { hard: true, warn: true, reason: 'edge_above_15pp' };\n  if (e > EDGE_ANOMALY_WARN) return { hard: false, warn: true, reason: 'edge_above_8pp' };\n  return { hard: false, warn: false, reason: null };\n}\n\nexport function monotonicityValid({ winProb, coverProb, line, tolerance = 1e-6 }) {\n  const w = Number(winProb), c = Number(coverProb), l = Number(line);\n  if (![w, c, l].every(Number.isFinite)) return false;\n  if (l < 0) return c <= w + tolerance;\n  if (l > 0) return c + tolerance >= w;\n  return Math.abs(c - w) <= tolerance;\n}\n`,
  'pick-math integrity helpers'
);
write(mathPath, math);

// ---------------------------------------------------------------------------
// Orchestrator: coherent ML/spread, totals fail-closed, anomaly queue.
// ---------------------------------------------------------------------------
orchestrator = replaceOnce(
  orchestrator,
  `  confidenceBucket, qualifies, quarterKellyUnits, edgeThreshold,\n  probToFairSpread, probToAmerican, KILL_THRESHOLD,\n`,
  `  confidenceBucket, qualifies, quarterKellyUnits, edgeThreshold,\n  probToAmerican, KILL_THRESHOLD, shrinkProbability, selectedWinProbability,\n  spreadCoverProbability, fairSpreadFromMargin, edgeAnomaly, monotonicityValid,\n`,
  'orchestrator imports'
);
orchestrator = replaceOnce(orchestrator, "const VERSION = 'v1.1.0';", "const VERSION = 'v1.2.0';\nconst BOOTSTRAP_PROBABILITY_SHRINK = 0.20;", 'orchestrator version');
orchestrator = replaceOnce(
  orchestrator,
  `    emitted: 0, kept: 0, killed: 0, superseded: 0, pass: 0, ratings_blocked: 0, scope_drain: 0,\n`,
  `    emitted: 0, kept: 0, killed: 0, superseded: 0, pass: 0, ratings_blocked: 0, scope_drain: 0,\n    anomaly_review: 0, totals_disabled: 0,\n`,
  'orchestrator counts'
);

const newMarketLoop = `      for (const market of ['spread', 'moneyline', 'total']) {\n        const quotes = odds.get(market);\n        if (!quotes || !quotes.length) { record.markets.push({ market, outcome: 'no_quote' }); continue; }\n\n        const evaluated = quotes.map(quote =>\n          evaluate({ game, market, quote, ratings, weather, champion, season, week }));\n\n        const disabled = evaluated.find(d => d.integrity_status === 'MODEL_DISABLED');\n        if (disabled) {\n          counts.totals_disabled += 1;\n          record.markets.push({ market, outcome: 'model_disabled', reason: disabled.integrity_reason });\n          continue;\n        }\n\n        const anomalies = evaluated.filter(d => d.integrity_status === 'ANOMALY_REVIEW');\n        if (anomalies.length) {\n          counts.anomaly_review += 1;\n          await queueAnomaly(env, { game, market, champion, decisions: anomalies, season, week });\n          const worst = anomalies.slice().sort((a, b) => Number(b.edge_pct || 0) - Number(a.edge_pct || 0))[0];\n          record.markets.push({\n            market, outcome: 'anomaly_review', side: worst?.side || null,\n            edge_pct: worst?.edge_pct ?? null, reason: worst?.integrity_reason || 'decision_integrity_failure',\n          });\n          continue;\n        }\n\n        const decision = evaluated\n          .slice()\n          .sort((a, b) => Number(b.qualifies) - Number(a.qualifies) || Number(b.edge_pct || -99) - Number(a.edge_pct || -99))[0];\n\n        if (decision.ratings_available === false) {\n          counts.ratings_blocked += 1;\n          blockedReasons.add(decision.unavailable_reason);\n          record.markets.push({ market, outcome: 'ratings_unavailable', reason: decision.unavailable_reason });\n          continue;\n        }\n\n        const open = await openPickFor(env, game.game_id, market);\n        const result = await reconcile(env, {\n          open, decision, champion, game, market, season, week,\n          scope: issuance.scope,\n        });\n\n        counts.emitted += result.emitted;\n        counts.killed += result.killed;\n        counts.superseded += result.superseded;\n        counts.kept += result.kept;\n        counts.scope_drain += result.scope_drain || 0;\n        const outcome = result.superseded ? 'superseded'\n          : result.emitted ? 'emitted'\n            : result.killed ? 'killed'\n              : result.kept ? 'kept'\n                : result.scope_drain ? 'scope_drain' : 'pass';\n        if (outcome === 'pass') counts.pass += 1;\n        record.markets.push({\n          market,\n          outcome,\n          side: decision.side,\n          edge_pct: decision.edge_pct,\n          threshold: edgeThreshold(market),\n          qualifies: decision.qualifies,\n          stake_units: decision.stake_units,\n          confidence_bucket: decision.confidence_bucket,\n          integrity_warning: decision.integrity_warning || null,\n          pass_reason: outcome === 'pass'\n            ? (decision.qualifies ? 'stake_zero' : \`edge_\${decision.edge_pct}_below_threshold_\${edgeThreshold(market)}\`)\n            : null,\n        });\n      }\n    }\n\n`;
orchestrator = replaceBetween(
  orchestrator,
  "      for (const market of ['spread', 'total', 'moneyline']) {",
  '    /* Three distinct internal truths',
  newMarketLoop,
  'market evaluation loop'
);

const newEvaluate = `export function evaluate({ game, market, quote, ratings, weather, champion, season, week }) {\n  const selectedIsHome = quote.selected_is_home === true;\n\n  /* Totals are intentionally unavailable until they have a dedicated expected-\n   * total model. The former implementation scored OVER and UNDER from the same\n   * feature vector, which made opposite sides receive identical probabilities. */\n  if (market === 'total') {\n    return {\n      qualifies: false, ratings_available: true, unavailable_reason: null,\n      integrity_status: 'MODEL_DISABLED', integrity_reason: 'dedicated_total_model_required',\n      integrity_warning: null, side: quote.side, market_line: quote.line ?? null,\n      market_price: quote.price, model_line: null, model_prob: null, market_prob: null,\n      edge_pct: 0, confidence_bucket: null, stake_units: 0, features: null,\n      selection_team: null, selection_over_under: quote.over_under ?? null, side_is_home: null,\n      kickoff_ts: game.kickoff_ts, season, week,\n    };\n  }\n\n  const homeRating = ratings.get(game.home_team);\n  const awayRating = ratings.get(game.away_team);\n  const homeCheck = ratingUsable(homeRating);\n  const awayCheck = ratingUsable(awayRating);\n  if (!homeCheck.usable || !awayCheck.usable) {\n    return {\n      qualifies: false, ratings_available: false,\n      unavailable_reason: !homeCheck.usable ? \`\${game.home_team}:\${homeCheck.reason}\` : \`\${game.away_team}:\${awayCheck.reason}\`,\n      integrity_status: 'INPUT_UNAVAILABLE', integrity_reason: 'ratings_unavailable', integrity_warning: null,\n      side: quote.side, edge_pct: 0, stake_units: 0, confidence_bucket: null, features: null,\n      selection_team: quote.team ?? null, selection_over_under: null, side_is_home: selectedIsHome,\n    };\n  }\n\n  const integrityVersion = Number(champion?.weights?.meta?.integrity_version || 0);\n  const dome = isIndoor(game.home_team);\n  /* One canonical HOME-perspective vector drives both moneyline and spread.\n   * No quote direction or current market tick is allowed to change the latent\n   * team-strength projection, which prevents paired-market contradictions. */\n  const features = buildFeatureVector({\n    off_epa_diff: num(homeRating.off_epa_play) - num(awayRating.def_epa_play),\n    def_epa_diff: num(awayRating.off_epa_play) - num(homeRating.def_epa_play),\n    qb_tier_diff: num(awayRating.qb_tier) - num(homeRating.qb_tier),\n    rest_diff: num(game.rest_home) - num(game.rest_away),\n    home: true,\n    dome,\n    wind15: !dome && weather?.wind_mph >= 15,\n    cold25: !dome && weather?.temp_f <= 25,\n    proe_diff: num(homeRating.proe) - num(awayRating.proe),\n    pace_sum: num(homeRating.pace) + num(awayRating.pace),\n    line_move: 0,\n    week,\n  });\n\n  const rawHomeWin = modelProbability(champion.weights, features);\n  const homeWin = isTrainedChampion(champion)\n    ? rawHomeWin\n    : shrinkProbability(rawHomeWin, BOOTSTRAP_PROBABILITY_SHRINK);\n  const selectedWin = selectedWinProbability(homeWin, selectedIsHome);\n\n  let modelProb;\n  let modelLine;\n  if (market === 'moneyline') {\n    modelProb = selectedWin;\n    modelLine = Number(probToAmerican(modelProb));\n  } else if (market === 'spread') {\n    const line = Number(quote.line);\n    if (!Number.isFinite(line)) {\n      return {\n        qualifies: false, ratings_available: true, integrity_status: 'ANOMALY_REVIEW',\n        integrity_reason: 'spread_line_missing', integrity_warning: null, side: quote.side,\n        market_line: quote.line ?? null, market_price: quote.price, model_line: null, model_prob: null,\n        market_prob: null, edge_pct: 0, confidence_bucket: null, stake_units: 0, features,\n        selection_team: quote.team ?? null, selection_over_under: null, side_is_home: selectedIsHome,\n        kickoff_ts: game.kickoff_ts, season, week,\n      };\n    }\n    modelProb = spreadCoverProbability({ homeWinProb: homeWin, selectedIsHome, line });\n    modelLine = Number(fairSpreadFromMargin({ homeWinProb: homeWin, selectedIsHome }).toFixed(2));\n  } else {\n    throw new Error(\`bad_market:\${market}\`);\n  }\n\n  const marketProb = devigTwoWay(quote.price, quote.opposite_price);\n  const edge = Number((modelProb - marketProb).toFixed(6));\n  const edgeState = edgeAnomaly(edge);\n  const coherent = market !== 'spread' || monotonicityValid({\n    winProb: selectedWin, coverProb: modelProb, line: Number(quote.line),\n  });\n\n  let integrityStatus = 'ELIGIBLE';\n  let integrityReason = null;\n  if (integrityVersion < 2) { integrityStatus = 'ANOMALY_REVIEW'; integrityReason = 'model_integrity_version_lt_2'; }\n  else if (!coherent) { integrityStatus = 'ANOMALY_REVIEW'; integrityReason = 'spread_moneyline_monotonicity_failure'; }\n  else if (edgeState.hard) { integrityStatus = 'ANOMALY_REVIEW'; integrityReason = edgeState.reason; }\n\n  const bucket = integrityStatus === 'ELIGIBLE' ? confidenceBucket(edge, market) : null;\n  const doesQualify = integrityStatus === 'ELIGIBLE' && qualifies(edge, market) && bucket !== null;\n\n  return {\n    qualifies: doesQualify, ratings_available: true, unavailable_reason: null,\n    integrity_status: integrityStatus, integrity_reason: integrityReason,\n    integrity_warning: edgeState.warn && !edgeState.hard ? edgeState.reason : null,\n    side: quote.side, selection_team: quote.team ?? null, selection_over_under: null,\n    side_is_home: selectedIsHome, market_line: quote.line ?? null, market_price: quote.price,\n    model_line: modelLine, model_prob: Number(modelProb.toFixed(6)),\n    market_prob: Number(marketProb.toFixed(6)), edge_pct: edge, confidence_bucket: bucket,\n    stake_units: bucket ? quarterKellyUnits(modelProb, quote.price) : 0, features,\n    kickoff_ts: game.kickoff_ts, season, week,\n  };\n}\n\n`;
orchestrator = replaceBetween(
  orchestrator,
  'export function evaluate({ game, market, quote, ratings, weather, champion, season, week }) {',
  '/* Lifecycle. This is the only place a pick',
  newEvaluate,
  'evaluate function'
);

orchestrator = replaceOnce(
  orchestrator,
  `  const tally = { emitted: 0, killed: 0, superseded: 0, kept: 0, scope_drain: 0 };\n\n  const issuanceRow = {\n`,
  `  const tally = { emitted: 0, killed: 0, superseded: 0, kept: 0, scope_drain: 0 };\n\n  /* Defence in depth: anomaly/model-disabled outputs can never reach the pick ledger. */\n  if (decision.integrity_status && decision.integrity_status !== 'ELIGIBLE') return tally;\n\n  const issuanceRow = {\n`,
  'reconcile fail closed'
);
orchestrator = replaceOnce(
  orchestrator,
  `    publication_scope: scope,\n    /* Canonical attribution, persisted at issuance and frozen by the database.\n`,
  `    publication_scope: scope,\n    integrity_status: 'eligible',\n    integrity_reason: null,\n    /* Canonical attribution, persisted at issuance and frozen by the database.\n`,
  'issuance integrity fields'
);

const anomalyHelper = `async function queueAnomaly(env, { game, market, champion, decisions, season, week }) {\n  const first = decisions[0] || {};\n  const type = first.integrity_reason || 'decision_integrity_failure';\n  try {\n    const existing = await select(\n      env, 'nfl_pick_anomalies',\n      \`game_id=eq.\${encodeURIComponent(game.game_id)}&market=eq.\${market}&model_version=eq.\${champion.version}&anomaly_type=eq.\${encodeURIComponent(type)}&status=eq.open&select=id&limit=1\`,\n    ) || [];\n    if (existing.length) return;\n    await insert(env, 'nfl_pick_anomalies', {\n      game_id: game.game_id, season, week, market, model_version: champion.version,\n      anomaly_type: type, status: 'open',\n      detail: {\n        matchup: \`\${game.away_team} @ \${game.home_team}\`,\n        candidates: decisions.map(d => ({\n          side: d.side, line: d.market_line, model_prob: d.model_prob, market_prob: d.market_prob,\n          edge_pct: d.edge_pct, reason: d.integrity_reason, warning: d.integrity_warning || null,\n        })),\n      },\n    });\n  } catch (error) {\n    console.error(\`[\${SERVICE}] anomaly queue failed class=\${errorClass(error)}\`);\n  }\n}\n\n`;
orchestrator = replaceOnce(orchestrator, '/* ---------------------------------------------------------------------------\n * Inputs', anomalyHelper + '/* ---------------------------------------------------------------------------\n * Inputs', 'anomaly queue helper');
orchestrator = replaceOnce(orchestrator,
  `      env, 'nfl_learning_observations', 'select=week,season,publication_scope&limit=5000',`,
  `      env, 'nfl_learning_observations', 'integrity_status=eq.eligible&select=week,season,publication_scope&limit=5000',`,
  'engine state eligible observations');
write(orchestratorPath, orchestrator);

// ---------------------------------------------------------------------------
// Publication contract: quarantined rows never reach card/history.
// ---------------------------------------------------------------------------
const publicationPath = 'workers/nfl-picks-engine-shared/publication.mjs';
let publication = read(publicationPath);
publication = replaceOnce(
  publication,
  `  const excluded = { superseded: 0, withdrawn: 0, stale_final: 0, attribution: 0, receipt_unverified: 0, scope: 0, duplicate_open: 0, other_season: 0 };\n`,
  `  const excluded = { superseded: 0, withdrawn: 0, stale_final: 0, attribution: 0, receipt_unverified: 0, scope: 0, duplicate_open: 0, other_season: 0, integrity: 0 };\n`,
  'publication excluded counts'
);
publication = replaceOnce(
  publication,
  `  for (const row of Array.isArray(rows) ? rows : []) {\n    if (row.publication_scope !== SCOPE_TRACKING && row.publication_scope !== SCOPE_OFFICIAL) { excluded.scope += 1; continue; }\n`,
  `  for (const row of Array.isArray(rows) ? rows : []) {\n    if ((row.integrity_status || 'eligible') !== 'eligible') { excluded.integrity += 1; continue; }\n    if (row.publication_scope !== SCOPE_TRACKING && row.publication_scope !== SCOPE_OFFICIAL) { excluded.scope += 1; continue; }\n`,
  'publication integrity filter'
);
write(publicationPath, publication);

// ---------------------------------------------------------------------------
// Read APIs: reset validation sample and hide quarantined v1 decisions.
// ---------------------------------------------------------------------------
const apiPath = 'api/pbe-picks.js';
let api = read(apiPath);
api = replaceOnce(api,
  `    sb('nfl_learning_observations', 'select=season,week,publication_scope&order=finalized_at.desc&limit=5000', secret),`,
  `    sb('nfl_learning_observations', 'integrity_status=eq.eligible&select=season,week,publication_scope&order=finalized_at.desc&limit=5000', secret),`,
  'governance eligible observations');
api = replaceOnce(api,
  `    sb('nfl_game_picks', 'select=season,status,publication_scope,created_at&order=created_at.desc&limit=5000', secret)`,
  `    sb('nfl_game_picks', 'integrity_status=eq.eligible&select=season,status,publication_scope,created_at&order=created_at.desc&limit=5000', secret)`,
  'governance eligible decisions');
api = replaceOnce(api,
  `  'publication_scope','features','created_text:created_at::text'\n`,
  `  'publication_scope','integrity_status','integrity_reason','features','created_text:created_at::text'\n`,
  'PICK_COLUMNS integrity');
api = replaceOnce(api,
  `    \`publication_scope=eq.tracking&season=eq.\${schedule.season}&status=in.(graded,killed,superseded)&select=\${PICK_COLUMNS}&order=kickoff_ts.desc&limit=2000\`,`,
  `    \`publication_scope=eq.tracking&integrity_status=eq.eligible&season=eq.\${schedule.season}&status=in.(graded,killed,superseded)&select=\${PICK_COLUMNS}&order=kickoff_ts.desc&limit=2000\`,`,
  'validation history integrity filter');
write(apiPath, api);

const validationPath = 'api/pbe-validation.js';
let validation = read(validationPath);
validation = replaceOnce(validation,
  `      sb('nfl_learning_observations', 'publication_scope=eq.tracking&is_final=eq.true&select=finalized_at,season,week,clv_beat,result,units_delta,brier&order=finalized_at.desc&limit=5000', key),`,
  `      sb('nfl_learning_observations', 'publication_scope=eq.tracking&integrity_status=eq.eligible&is_final=eq.true&select=finalized_at,season,week,clv_beat,result,units_delta,brier&order=finalized_at.desc&limit=5000', key),`,
  'validation telemetry integrity filter');
write(validationPath, validation);

// ---------------------------------------------------------------------------
// Tuner: quarantined rows are invisible; auto-training remains held until the
// clean v2 all-games training corpus is implemented.
// ---------------------------------------------------------------------------
const tunerPath = 'workers/nfl-weight-tuner/src/index.js';
let tuner = read(tunerPath);
tuner = replaceOnce(tuner, "const VERSION = 'v1.0.0';", "const VERSION = 'v1.1.0';\nconst INTEGRITY_TUNER_HOLD = true;", 'tuner version/hold');
tuner = replaceOnce(tuner,
  `async function runTuning(env) {\n  health.last_cron_run = new Date().toISOString();\n  try {\n    const observations = await select(\n      env, 'nfl_learning_observations',\n      'is_final=is.true&select=*&order=season.desc,week.desc&limit=5000',\n    ) || [];\n`,
  `async function runTuning(env) {\n  health.last_cron_run = new Date().toISOString();\n  try {\n    if (INTEGRITY_TUNER_HOLD) {\n      health.gate = { graded: 0, distinct_weeks: 0, open: false, reason: 'integrity_v2_training_corpus_pending' };\n      health.last_result = 'gated:integrity_v2_training_corpus_pending';\n      health.last_error_class = null;\n      return;\n    }\n    const observations = await select(\n      env, 'nfl_learning_observations',\n      'integrity_status=eq.eligible&is_final=is.true&select=*&order=season.desc,week.desc&limit=5000',\n    ) || [];\n`,
  'tuner integrity hold');
write(tunerPath, tuner);

// Grader explicitly carries integrity status; DB trigger independently enforces it.
const graderPath = 'workers/nfl-game-grader/src/index.js';
let grader = read(graderPath);
grader = replaceOnce(grader,
  `    publication_scope: pick.publication_scope || 'tracking',\n    model_prob: pick.model_prob,\n`,
  `    publication_scope: pick.publication_scope || 'tracking',\n    integrity_status: pick.integrity_status || 'eligible',\n    integrity_reason: pick.integrity_reason || null,\n    model_prob: pick.model_prob,\n`,
  'grader integrity propagation');
write(graderPath, grader);

console.log('NFL picks integrity repair applied');
