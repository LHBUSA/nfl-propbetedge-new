/* PBE Touchdown Targets — the same-origin read contract.
 *
 * WHAT IS GATED AND WHY
 *   state        public.  Governance and engine health. Counts only: how many
 *                games were evaluated, how many carry a target, how many the
 *                model abstained on. No player, no probability, no price.
 *   current      NFL PRO. This week's game cards: the named target, the PBE
 *                probability, the market it is measured against, the drivers.
 *   week         NFL PRO. The same, for a given season and week.
 *   trackrecord  public.  GRADED history only. A settled result is a record,
 *                not a prediction, and publishing it is the entire point of
 *                the product. Open targets are excluded by the query itself.
 *   model        public.  The committed artefact's provenance, fitted weights
 *                and HISTORICAL BACKTEST. Never the per-player baselines.
 *
 * A free browser cannot receive a live target in JSON and have it hidden by
 * JavaScript afterwards: `current` and `week` refuse before they read a row.
 * The entitlement authority is the existing one (getNflSession), so a session
 * that is good for Prop Board is good for this and nothing else has to know.
 *
 * SOURCE FAILURE IS NEVER "NO TARGETS". The engine state comes from the
 * durable run ledger and the champion row, and a degraded upstream is reported
 * as ENGINE DEGRADED — not as a quiet slate.
 */
import { getNflSession, verifiedEmail, supabaseAdminHeaders } from './_nfl-auth.js';
import { currentSeason, engineRuntime } from './_pbe-engine-runtime.js';

const DEFAULT_SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const MARKET = 'player_anytime_td';
const MARKET_LABEL = 'Anytime Touchdown';
const MODEL_VERSION = 'pbe-td-hazard-v1';
const RESULT_DEFINITION = 'pbe_offensive_td_from_final_box_score';
const MIN_FINALIZED = 100;
const MIN_WEEKS = 4;
const TD_LANES = [
  'nfl-touchdown-targets-orchestrator',
  'nfl-odds-snapshot',
  'nfl-touchdown-targets-grader',
  'nfl-touchdown-targets-tuner',
];

/* Fields a Pro reader may see on a live target. `model_snapshot` is never in
 * this list: the drivers are derived from it server-side and the raw snapshot
 * — which carries the whole ranked pool and every component — stays here. */
const TARGET_FIELDS = [
  'id', 'event_id', 'season', 'week', 'kickoff_ts', 'player_name', 'player_key',
  'market', 'side', 'book', 'book_key', 'market_price', 'opposite_price',
  'model_prob', 'market_prob', 'edge_pct', 'ev_pct', 'confidence_bucket',
  'target_rank', 'projection_model_version', 'selector_version', 'phase',
  'publication_scope', 'status', 'created_at', 'closed_at', 'model_snapshot',
].join(',');

function send(res, status, body, cacheControl = 'private, no-store, max-age=0') {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cacheControl);
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(body));
}
const baseUrl = () => String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
const serviceSecret = () => String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

async function sb(path, query, secret) {
  const response = await fetch(`${baseUrl()}/rest/v1/${path}?${query}`, {
    headers: supabaseAdminHeaders(secret), cache: 'no-store',
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`supabase_${response.status}${detail ? `:${detail.slice(0, 160)}` : ''}`);
  }
  return response.json();
}
const arr = value => (Array.isArray(value) ? value : []);
const num = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
function chunks(values, size = 100) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}
const inList = values => values.map(value => `"${String(value).replace(/"/g, '')}"`).join(',');

/* ------------------------------------------------------------ governance */

async function governance(secret) {
  const [models, observations, runtime, current, latestAudit] = await Promise.all([
    sb('nfl_prop_selector_models', `market=eq.${MARKET}&promoted=is.true&select=version,market,projection_model,config,trained,promoted,training_rows,trained_through_week,backtest_brier,backtest_units,notes,created_at,promoted_at&order=version.desc&limit=1`, secret),
    sb('nfl_prop_learning_observations', `market=eq.${MARKET}&is_final=eq.true&select=season,week,publication_scope,outcome,units_delta,brier,finalized_at&order=finalized_at.desc&limit=5000`, secret),
    engineRuntime(TD_LANES),
    currentSeason().catch(() => null),
    sb('nfl_prop_pick_audit_events', `event_type=like.td_%25&select=event_type,occurred_at&order=occurred_at.desc&limit=1`, secret).catch(() => []),
  ]);

  const selector = arr(models)[0] || null;
  const obs = arr(observations);
  const weeks = new Set(obs.map(row => `${row.season}-${row.week}`));
  const trained = selector?.trained === true;
  const briers = obs.map(row => num(row.brier)).filter(value => value !== null);
  const decided = obs.filter(row => row.outcome === 0 || row.outcome === 1);

  const health = String(runtime?.health || 'UNKNOWN').toUpperCase();
  return {
    engine: 'PBE Touchdown Targets',
    market: MARKET,
    market_label: MARKET_LABEL,
    model_version: selector?.projection_model || MODEL_VERSION,
    selector_version: selector?.version ?? null,
    selector_trained: trained,
    selector_promoted: selector?.promoted === true,
    selector_notes: selector?.notes ?? null,
    /* Thresholds are publishable; a trained override's coefficients are not. */
    selector_config_public: selector?.config ? {
      primary_min_prob: selector.config.primary_min_prob ?? null,
      secondary_min_prob: selector.config.secondary_min_prob ?? null,
      secondary_min_edge: selector.config.secondary_min_edge ?? null,
      min_books: selector.config.min_books ?? null,
      max_publishable_prob: selector.config.max_publishable_prob ?? null,
      availability_abstain_share: selector.config.availability_abstain_share ?? null,
      replace_min_prob_gap: selector.config.replace_min_prob_gap ?? null,
      probability_override_promoted: Boolean(selector.config.probability_override) && trained,
    } : null,
    publication: trained ? 'ALLOWED' : 'GATED',
    publication_blocked_reason: trained ? null
      : selector ? `untrained_td_selector:v${selector.version}` : 'no_promoted_td_selector',
    issuance_mode: trained ? 'OFFICIAL' : 'TRACKING_BOOTSTRAP',
    /* What tracking means, stated wherever the state is served, because the
     * word invites the wrong assumption. */
    scope_note: trained
      ? 'Targets are issued at official publication scope.'
      : 'Targets are issued at TRACKING scope while the learning gate is closed. '
        + 'A tracking target is still named before kickoff, frozen, graded from the official '
        + 'result and kept forever — it is a verified live record, kept separately from the '
        + 'official record and never merged into it.',
    finalized_sample: obs.length,
    finalized_required: MIN_FINALIZED,
    distinct_weeks: weeks.size,
    distinct_weeks_required: MIN_WEEKS,
    gate_open: obs.length >= MIN_FINALIZED && weeks.size >= MIN_WEEKS,
    validation_performance: {
      decided: decided.length,
      hit_rate: decided.length ? decided.filter(row => row.outcome === 1).length / decided.length : null,
      brier: briers.length ? briers.reduce((a, b) => a + b, 0) / briers.length : null,
      units: obs.length ? Number(obs.reduce((sum, row) => sum + (num(row.units_delta) || 0), 0).toFixed(4)) : null,
      scope: 'verified live, from persisted graded targets only',
    },
    engine_health: health,
    engine_runtime: runtime,
    current,
    grading: {
      result_definition: RESULT_DEFINITION,
      pbe_target_result: 'at least one rushing or receiving touchdown credited to the selected player '
        + 'in the official final box score',
      passing_touchdowns_excluded: true,
      non_offensive_touchdowns: 'observed and recorded on the grade, never part of the PBE result; '
        + 'a book whose anytime-touchdown rule includes return or defensive scores may settle differently',
      roi_basis: 'one unit risked at the persisted issuance price. A target with no persisted '
        + 'executable price contributes no units and no ROI.',
    },
    verification: {
      receipt_scheme: 'pbe-td-target-issuance-v1',
      hash: 'SHA-256',
      chained: true,
      third_party_notarized: false,
    },
    runtime_evidence: {
      latest_audit_event: arr(latestAudit)[0]?.event_type ?? null,
      latest_audit_at: arr(latestAudit)[0]?.occurred_at ?? null,
    },
    truth: 'one_primary_target_per_game_locked_pregame_never_rewritten',
  };
}

/* The customer-facing engine state. Health dominates publication: an engine
 * that is not running must never say "the model evaluated the slate". */
function engineState({ state, evaluations, targets }) {
  if (String(state.engine_health).toUpperCase() !== 'HEALTHY') return 'ENGINE DEGRADED — SOURCE UNAVAILABLE';
  if (targets.length) return 'ENGINE LIVE — TARGETS AVAILABLE';
  if (evaluations.length) {
    return evaluations.every(row => row.outcome === 'degraded')
      ? 'ENGINE DEGRADED — SOURCE UNAVAILABLE'
      : 'ENGINE LIVE — SLATE EVALUATED';
  }
  return 'ENGINE WAITING — UPCOMING SLATE NOT READY';
}

/* --------------------------------------------------------------- shaping */

/* Model drivers, derived server-side from the frozen snapshot. A driver is
 * offered only when its component was available AND moved the probability by
 * more than a rounding artefact, so a card can never show a chip for a feature
 * the champion does not actually use. */
const DRIVER_FLOOR = 0.02;

function driversFrom(snapshot) {
  const components = snapshot?.probability?.components || {};
  const out = [];
  const push = (key, label, factor, detail) => {
    const value = Number(factor);
    if (!Number.isFinite(value) || Math.abs(value - 1) < DRIVER_FLOOR) return;
    out.push({ key, label, direction: value > 1 ? 'up' : 'down', factor: Number(value.toFixed(4)), detail });
  };
  const round2 = value => (num(value) === null ? null : Number(Number(value).toFixed(2)));

  const role = components.red_zone_role;
  if (role?.available === true) {
    push('red_zone_role', Number(role.factor) > 1 ? 'RED-ZONE ROLE' : 'LIGHT RED-ZONE ROLE', role.factor,
      role.player_rz_opportunities_per_game === null ? null
        : `${round2(role.player_rz_opportunities_per_game)} red-zone opportunities per game against ${round2(role.position_rz_opportunities_per_game)} for the position`);
  }
  const script = components.game_script;
  if (script?.available === true) {
    push('game_script', Number(script.factor) > 1 ? 'FAVOURABLE SCRIPT' : 'AGAINST THE SCRIPT', script.factor,
      `${SCRIPT_COPY[script.bucket] || script.bucket} · measured on ${script.sample_rows} player-games`);
  }
  const team = components.team_environment;
  if (team?.available === true) {
    push('team_environment', Number(team.factor) > 1 ? 'HIGH TEAM TD ENVIRONMENT' : 'LOW TEAM TD ENVIRONMENT', team.factor,
      `${round2(team.team_offensive_td_per_game)} offensive touchdowns per game against ${round2(team.league_offensive_td_per_game)} league`);
  }
  const opponent = components.opponent;
  if (opponent?.available === true) {
    push('opponent', Number(opponent.factor) > 1 ? 'SOFT TD MATCHUP' : 'HARD TD MATCHUP', opponent.factor,
      `allows ${round2(opponent.opponent_rushing_td_allowed_per_game)} rushing and ${round2(opponent.opponent_receiving_td_allowed_per_game)} receiving touchdowns per game`);
  }
  const weather = components.weather;
  if (weather?.available === true) {
    push('weather', Number(weather.factor) > 1 ? 'CONDITIONS HELP' : 'CONDITIONS SUPPRESS', weather.factor,
      `${WEATHER_COPY[weather.bucket] || weather.bucket} · measured on ${weather.sample_rows} player-games`);
  }

  /* Not a model driver: a fact about the price the target is measured against,
   * and labelled as one. */
  const modelProb = num(snapshot?.probability?.published);
  const marketProb = num(snapshot?.market?.probability);
  if (modelProb !== null && marketProb !== null && Math.abs(modelProb - marketProb) >= 0.03) {
    const books = num(snapshot?.market?.books) || 0;
    out.push({
      key: 'market',
      label: modelProb > marketProb ? 'MARKET UNDERRATES' : 'MARKET OVERRATES',
      direction: modelProb > marketProb ? 'up' : 'down',
      factor: null,
      detail: `PBE ${(modelProb * 100).toFixed(1)}% against a market ${(marketProb * 100).toFixed(1)}% over `
        + `${books} book${books === 1 ? '' : 's'}${snapshot?.market?.vig_removed ? '' : ' (one-sided prices; vig not removed)'}`,
    });
  }
  const availability = snapshot?.availability;
  if (availability?.warned === true) {
    out.push({
      key: 'availability', label: 'QUESTIONABLE', direction: 'down', factor: null,
      detail: availability.detail || 'listed questionable on the reported availability board',
    });
  }
  /* The current-season layer is a fact about the sample, not a multiplier. */
  const currentLayer = snapshot?.probability?.base?.current_season;
  if (currentLayer?.available === true && num(currentLayer.rate) !== null) {
    out.push({
      key: 'current_season', label: 'CURRENT-SEASON FORM', direction: Number(currentLayer.rate) > 0 ? 'up' : 'down', factor: null,
      detail: `${Number(currentLayer.rate).toFixed(2)} offensive touchdowns per game over ${currentLayer.weight} game${Number(currentLayer.weight) === 1 ? '' : 's'} this season`,
    });
  }
  return out;
}

const SCRIPT_COPY = {
  heavy_favourite: 'favored by seven or more',
  favourite: 'favored by three to seven',
  pickem: 'within three points',
  underdog: 'underdog by three to seven',
  heavy_underdog: 'underdog by seven or more',
};
const WEATHER_COPY = {
  wind_15_plus: 'wind at or above 15 mph',
  cold_32_or_below: 'temperature at or below freezing',
  benign_outdoor: 'open air, no wind or cold flag',
};

/* One target, shaped for the card. The proprietary interior — the ranked pool,
 * the raw components, the selector config — is reduced to what the card
 * renders and what the audit panel is allowed to state. */
function shapeTarget(row, { grade = null, receipt = null } = {}) {
  const snapshot = row?.model_snapshot || {};
  const player = snapshot.player || {};
  const market = snapshot.market || {};
  const environment = snapshot.game_context?.environment || null;
  return {
    id: row.id,
    event_id: row.event_id,
    game_id: snapshot.event?.game_id ?? null,
    espn_id: snapshot.event?.espn_id ?? null,
    season: row.season,
    week: row.week,
    kickoff_ts: row.kickoff_ts,
    away_team: snapshot.event?.away_team ?? null,
    home_team: snapshot.event?.home_team ?? null,
    target_rank: row.target_rank,
    status: row.status,
    publication_scope: row.publication_scope,
    player: {
      name: row.player_name,
      key: row.player_key,
      espn_id: player.espn_id ?? null,
      gsis_id: player.gsis_id ?? null,
      position: player.position ?? null,
      team: player.team ?? null,
      opponent: player.opponent ?? null,
      at_home: player.at_home ?? null,
    },
    model: {
      probability: num(row.model_prob),
      version: row.projection_model_version,
      source: snapshot.probability?.source ?? 'committed_artefact',
      artefact_probability: num(snapshot.probability?.artefact_calibrated),
      lambda: num(snapshot.probability?.lambda),
      selector_version: row.selector_version,
      confidence: row.confidence_bucket,
      label: snapshot.model?.label ?? null,
    },
    market: {
      probability: num(row.market_prob),
      books: num(market.books),
      two_way_books: num(market.two_way_books),
      vig_removed: market.vig_removed === true,
      disagreement_pp: num(market.disagreement_pp),
      best_price: num(row.market_price),
      best_book: row.book,
      opposite_price: num(row.opposite_price),
    },
    edge_pp: num(row.edge_pct) === null ? null : Number((num(row.edge_pct) * 100).toFixed(2)),
    ev_pct: num(row.ev_pct),
    environment: environment ? {
      roof_state: environment.roof_state ?? null,
      weather_applies: environment.weather_applies ?? null,
      temp_f: num(environment.temp_f),
      wind_mph: num(environment.wind_mph),
      condition: environment.condition ?? null,
      precip_probability_pct: num(environment.precip_probability_pct),
      venue: environment.venue ?? null,
    } : null,
    game_market: snapshot.game_context ? {
      spread_points: snapshot.game_context.spread_points ?? null,
      total: num(snapshot.game_context.total),
      implied_team_total: snapshot.game_context.implied_team_total ?? null,
      implied_team_total_consumed_by_champion: false,
    } : null,
    drivers: driversFrom(snapshot),
    availability: snapshot.availability ? {
      reported: snapshot.availability.available === true,
      status: snapshot.availability.status ?? null,
      detail: snapshot.availability.detail ?? null,
      questionable: snapshot.availability.warned === true,
    } : null,
    locked: {
      at: row.created_at,
      phase: row.phase,
      hours_to_kickoff: num(snapshot.phase?.hours_to_kickoff),
      before_kickoff: Date.parse(row.created_at) < Date.parse(row.kickoff_ts),
    },
    grade: grade ? {
      result: grade.result,
      offensive_td: num(grade.final_value),
      units: num(grade.units_delta),
      brier: num(grade.brier),
      clv_prob: num(grade.clv_prob),
      clv_beat: typeof grade.clv_beat === 'boolean' ? grade.clv_beat : null,
      graded_at: grade.graded_at,
      result_definition: grade.result_definition ?? RESULT_DEFINITION,
      non_offensive_td: typeof grade.non_offensive_td === 'boolean' ? grade.non_offensive_td : null,
      settlement_note: grade.settlement_note ?? null,
      source: grade.source,
    } : null,
    receipt: receipt ? {
      seq: receipt.seq,
      issued_at: receipt.issued_at,
      version: receipt.receipt_version,
      payload_sha256: receipt.payload_sha256,
      chain_hash: receipt.chain_hash,
      previous_chain_hash: receipt.previous_chain_hash,
    } : null,
  };
}

const ABSTAIN_COPY = {
  no_credible_scorer_probability: 'PBE evaluated the eligible scoring pool and no player reached the publication threshold.',
  identity_unresolved: 'The scoring pool for this game could not be resolved to known players safely.',
  widespread_availability_uncertainty: 'Reported availability removed too much of this game’s scoring pool to publish a target.',
  extreme_low_scoring_environment: 'The expected scoring environment held every eligible player below the publication threshold.',
  model_integrity_guard: 'A model integrity guard fired on this game and no target was published.',
  no_eligible_scoring_pool: 'No eligible scoring pool was available for this game.',
};
const DEGRADED_COPY = {
  market_snapshot_unavailable: 'The anytime-touchdown market for this game was not available to measure a target against.',
  market_snapshot_stale: 'The anytime-touchdown market snapshot for this game was too old to decide from.',
  model_artefact_unavailable: 'The model artefact was unavailable for this game.',
  current_slate_unavailable: 'The current-slate authority did not answer for this game.',
};
const ABSTAIN_LABEL = {
  no_credible_scorer_probability: 'NO CREDIBLE SCORER',
  identity_unresolved: 'SCORING POOL UNRESOLVED',
  widespread_availability_uncertainty: 'AVAILABILITY UNCERTAIN',
  extreme_low_scoring_environment: 'EXTREME LOW-SCORING ENVIRONMENT',
  model_integrity_guard: 'MODEL INTEGRITY GUARD',
  no_eligible_scoring_pool: 'NO ELIGIBLE POOL',
};

/* One evaluated game, whatever it produced. A game is a card either way, so
 * the page can never quietly drop one. */
function shapeGame(evaluation, targets) {
  const primary = targets.find(target => target.id === evaluation.primary_pick_id) || null;
  const secondary = targets.find(target => target.id === evaluation.secondary_pick_id) || null;
  return {
    game_id: evaluation.game_id,
    event_id: evaluation.event_id,
    espn_id: evaluation.espn_id,
    season: evaluation.season,
    week: evaluation.week,
    kickoff_ts: evaluation.kickoff_ts,
    away_team: evaluation.away_team,
    home_team: evaluation.home_team,
    outcome: evaluation.outcome,
    state: evaluation.outcome === 'target_issued' ? 'PRIMARY TARGET'
      : evaluation.outcome === 'abstained' ? 'MODEL ABSTAIN' : 'SOURCE DEGRADED',
    reason: evaluation.reason,
    reason_label: evaluation.outcome === 'abstained'
      ? (ABSTAIN_LABEL[evaluation.reason] || String(evaluation.reason || '').toUpperCase().replace(/_/g, ' '))
      : evaluation.outcome === 'degraded' ? 'SOURCE UNAVAILABLE' : null,
    reason_copy: evaluation.outcome === 'abstained'
      ? (ABSTAIN_COPY[evaluation.reason] || null)
      : evaluation.outcome === 'degraded' ? (DEGRADED_COPY[evaluation.reason] || null) : null,
    evaluated: {
      market_selections: evaluation.market_selections,
      eligible_pool: evaluation.eligible_pool,
      top_probability: num(evaluation.top_probability),
      floor: num(evaluation.detail?.floor),
      decided_at: evaluation.decided_at,
      publication_scope: evaluation.publication_scope,
      selector_version: evaluation.selector_version,
    },
    environment: evaluation.detail?.game_context?.environment ?? null,
    primary,
    secondary,
  };
}

/* ------------------------------------------------------------- the views */

async function stateView(res, secret) {
  const state = await governance(secret);
  const coverage = await coverageSummary(secret, state.current?.season ?? null);
  return send(res, 200, { ...state, coverage }, 'public, max-age=15, s-maxage=15, stale-while-revalidate=60');
}

/* Coverage and abstention are the two numbers that keep the product honest, so
 * they are public and are computed from the evaluation ledger rather than from
 * the targets — a rate whose denominator is only the games that produced a
 * target would always read 100%. */
async function coverageSummary(secret, season) {
  const query = season ? `season=eq.${season}&select=outcome,reason,week` : 'select=outcome,reason,week';
  const rows = arr(await sb('nfl_td_final_pregame_evaluation', `${query}&limit=2000`, secret).catch(() => []));
  const counts = { games_evaluated: rows.length, target_issued: 0, abstained: 0, degraded: 0 };
  const abstainReasons = {};
  for (const row of rows) {
    if (row.outcome === 'target_issued') counts.target_issued += 1;
    else if (row.outcome === 'abstained') {
      counts.abstained += 1;
      abstainReasons[row.reason] = (abstainReasons[row.reason] || 0) + 1;
    } else counts.degraded += 1;
  }
  const decidable = counts.target_issued + counts.abstained;
  return {
    season,
    ...counts,
    /* Abstention is measured against the games the model could actually decide.
     * A degraded source is not an abstention and is reported separately. */
    abstention_rate: decidable ? Number((counts.abstained / decidable).toFixed(4)) : null,
    abstention_denominator: 'games with a final pregame decision, excluding games whose sources failed',
    coverage_rate: decidable ? Number((counts.target_issued / decidable).toFixed(4)) : null,
    abstain_reasons: abstainReasons,
  };
}

async function requirePro(req, res) {
  const auth = await getNflSession(req);
  const email = verifiedEmail(auth);
  if (!email) {
    if (auth?.degraded) { send(res, 503, { error: 'entitlement_unavailable', stage: auth.stage }); return null; }
    send(res, 401, { error: 'sign_in_required', entitlement: 'nfl_pro' });
    return null;
  }
  if (auth.degraded) { send(res, 503, { error: 'entitlement_unavailable', stage: auth.stage }); return null; }
  if (auth.pro !== true) { send(res, 403, { error: 'nfl_pro_required', entitlement: 'nfl_pro' }); return null; }
  return auth;
}

async function slateView(req, res, secret, { season, week }) {
  if (!(await requirePro(req, res))) return undefined;
  const state = await governance(secret);
  const resolvedSeason = season ?? state.current?.season ?? null;
  const resolvedWeek = week ?? state.current?.week ?? null;
  if (!resolvedSeason) {
    return send(res, 503, { error: 'season_unresolved', engine_state: 'ENGINE DEGRADED — SOURCE UNAVAILABLE' });
  }

  const weekFilter = resolvedWeek === null ? '' : `&week=eq.${resolvedWeek}`;
  const [evaluations, targets] = await Promise.all([
    sb('nfl_td_final_pregame_evaluation', `season=eq.${resolvedSeason}${weekFilter}&select=*&order=kickoff_ts.asc&limit=64`, secret),
    sb('nfl_prop_picks', `market=eq.${MARKET}&season=eq.${resolvedSeason}${weekFilter}&status=in.(open,graded)&select=${TARGET_FIELDS}&order=kickoff_ts.asc&limit=128`, secret),
  ]);

  const rows = arr(targets);
  const receipts = await receiptsFor(secret, rows.map(row => row.id));
  const grades = await gradesFor(secret, rows.filter(row => row.status === 'graded').map(row => row.id));
  const shaped = rows.map(row => shapeTarget(row, { grade: grades.get(row.id) || null, receipt: receipts.get(row.id) || null }));
  const games = arr(evaluations).map(evaluation => shapeGame(evaluation, shaped));

  const primaries = shaped.filter(target => target.target_rank === 'primary');
  return send(res, 200, {
    ...state,
    entitlement: 'pro',
    season: resolvedSeason,
    week: resolvedWeek,
    engine_state: engineState({ state, evaluations: arr(evaluations), targets: shaped }),
    counts: {
      games_analyzed: games.length,
      primary_targets: primaries.length,
      secondary_targets: shaped.filter(target => target.target_rank === 'secondary').length,
      abstained: games.filter(game => game.outcome === 'abstained').length,
      degraded: games.filter(game => game.outcome === 'degraded').length,
      pending: primaries.filter(target => !target.grade).length,
      hit: primaries.filter(target => target.grade?.result === 'win').length,
      missed: primaries.filter(target => target.grade?.result === 'loss').length,
    },
    games,
  });
}

/* GRADED history only. The query excludes open targets, so a live prediction
 * cannot leave through this door however the view is called. */
async function trackRecordView(res, secret, { season }) {
  const state = await governance(secret);
  const filter = season ? `&season=eq.${season}` : '';
  const rows = arr(await sb(
    'nfl_prop_picks',
    `market=eq.${MARKET}&status=in.(graded,killed,superseded)${filter}`
      + `&select=${TARGET_FIELDS}&order=kickoff_ts.desc&limit=2000`,
    secret,
  ));
  const ids = rows.map(row => row.id);
  const [grades, receipts] = await Promise.all([gradesFor(secret, ids), receiptsFor(secret, ids)]);
  const shaped = rows.map(row => shapeTarget(row, { grade: grades.get(row.id) || null, receipt: receipts.get(row.id) || null }));
  const coverage = await coverageSummary(secret, season ?? state.current?.season ?? null);
  return send(res, 200, {
    ...state,
    scope: 'VERIFIED LIVE TRACK RECORD',
    scope_note_backtest: 'The model artefact carries a HISTORICAL BACKTEST. It is served at view=model '
      + 'and is never part of this record.',
    coverage,
    count: shaped.length,
    targets: shaped,
  }, 'public, max-age=30, s-maxage=30, stale-while-revalidate=120');
}

function modelView(res) {
  /* The artefact's public face is served by the orchestrator, which holds it.
   * Duplicating it here would be a second copy to drift. */
  return send(res, 200, {
    engine: 'PBE Touchdown Targets',
    model_version: MODEL_VERSION,
    label: 'at least one rushing or receiving touchdown credited to the player in the official final box score',
    served_by: '/v1/engine/model on nfl-touchdown-targets-orchestrator',
    note: 'the calibration block in the artefact is a HISTORICAL BACKTEST and is never the verified live record',
  }, 'public, max-age=300, s-maxage=300');
}

async function gradesFor(secret, ids) {
  if (!ids.length) return new Map();
  const batches = await Promise.all(chunks(ids).map(group => sb(
    'nfl_prop_pick_grades',
    `pick_id=in.(${inList(group)})&select=pick_id,final_value,result,units_delta,clv_prob,clv_beat,brier,source,graded_at,result_definition,non_offensive_td,settlement_note`,
    secret,
  )));
  return new Map(batches.flat().filter(Boolean).map(row => [row.pick_id, row]));
}
async function receiptsFor(secret, ids) {
  if (!ids.length) return new Map();
  const batches = await Promise.all(chunks(ids).map(group => sb(
    'nfl_prop_pick_receipts',
    `pick_id=in.(${inList(group)})&select=seq,pick_id,issued_at,receipt_version,payload_sha256,previous_chain_hash,chain_hash`,
    secret,
  )));
  return new Map(batches.flat().filter(Boolean).map(row => [row.pick_id, row]));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const secret = serviceSecret();
  if (!secret) return send(res, 503, { error: 'touchdown_targets_backend_unavailable', stage: 'service_secret_missing' });

  const view = typeof req.query?.view === 'string' ? req.query.view.trim().toLowerCase() : 'state';
  const season = num(req.query?.season);
  const week = num(req.query?.week);

  try {
    if (view === 'state') return await stateView(res, secret);
    if (view === 'model') return modelView(res);
    if (view === 'current') return await slateView(req, res, secret, { season: null, week: null });
    if (view === 'week') return await slateView(req, res, secret, { season, week });
    if (view === 'trackrecord' || view === 'history') return await trackRecordView(res, secret, { season });
    return send(res, 404, { error: 'view_not_found', views: ['state', 'current', 'week', 'trackrecord', 'model'] });
  } catch (error) {
    /* A backend failure is reported as a backend failure. It is never allowed
     * to reach the browser as an empty slate. */
    console.error('PBE touchdown targets read contract failed', error instanceof Error ? error.message : String(error));
    return send(res, 503, {
      error: 'touchdown_targets_backend_unavailable',
      engine_state: 'ENGINE DEGRADED — SOURCE UNAVAILABLE',
    });
  }
}

export { shapeTarget, shapeGame, driversFrom, coverageSummary, engineState, ABSTAIN_COPY, DEGRADED_COPY };
