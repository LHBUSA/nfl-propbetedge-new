import { getNflSession, verifiedEmail, supabaseAdminHeaders } from './_nfl-auth.js';
import {
  currentSeason, matchupFromGameId, engineRuntime, composeEngineState,
} from './_pbe-engine-runtime.js';
import {
  LABELS, displayMode, eligibleDecisions, verifyReceipt, lifecycleOf, attributionValid,
  proCard, lockedPreview, withdrawnEvent, marketSinceIssue, cardSummary, assertNoSelection, nflverseTeam,
} from '../workers/nfl-picks-engine-shared/publication.mjs';

const DEFAULT_SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const OFFICIAL = 'official';
const UNTRAINED_STATE = 'ENGINE GATED — MODEL VALIDATION IN PROGRESS';
/* The lanes that make the game engine a closed loop. */
const GAME_LANES = ['nfl-game-picks-orchestrator', 'nfl-odds-snapshot', 'nfl-game-grader', 'nfl-weight-tuner'];

const DIVISION = Object.freeze({
  BUF:'AFC East',MIA:'AFC East',NE:'AFC East',NYJ:'AFC East',
  BAL:'AFC North',CIN:'AFC North',CLE:'AFC North',PIT:'AFC North',
  HOU:'AFC South',IND:'AFC South',JAX:'AFC South',TEN:'AFC South',
  DEN:'AFC West',KC:'AFC West',LV:'AFC West',LAC:'AFC West',
  DAL:'NFC East',NYG:'NFC East',PHI:'NFC East',WAS:'NFC East',WSH:'NFC East',
  CHI:'NFC North',DET:'NFC North',GB:'NFC North',MIN:'NFC North',
  ATL:'NFC South',CAR:'NFC South',NO:'NFC South',TB:'NFC South',
  ARI:'NFC West',LAR:'NFC West',SF:'NFC West',SEA:'NFC West'
});

function send(res, status, body, cacheControl = 'private, no-store, max-age=0') {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cacheControl);
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(body));
}

function baseUrl() {
  return String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
}

function serviceSecret() {
  return String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
}

async function sb(path, query, secret) {
  const response = await fetch(`${baseUrl()}/rest/v1/${path}?${query}`, {
    headers: supabaseAdminHeaders(secret),
    cache: 'no-store'
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`supabase_${response.status}${detail ? `:${detail.slice(0, 160)}` : ''}`);
  }
  return response.json();
}

function isTrained(champion) {
  const value = champion?.weights?.meta?.trained;
  return value === true || value === 'true';
}

/* Decision counts by publication class and lifecycle status. Counts only — a
 * tracking decision's side, line or edge never leaves the server. */
function decisionCounts(rows, season) {
  const blank = () => ({ total: 0, open: 0, graded: 0, killed: 0, superseded: 0 });
  const out = { season, tracking: blank(), official: blank(), latest_issued_at: null };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (season && Number(row.season) !== Number(season)) continue;
    const bucket = row.publication_scope === OFFICIAL ? out.official : out.tracking;
    bucket.total += 1;
    if (bucket[row.status] !== undefined) bucket[row.status] += 1;
    if (!out.latest_issued_at || row.created_at > out.latest_issued_at) out.latest_issued_at = row.created_at;
  }
  return out;
}

async function governance(secret) {
  const [weights, observations, current, runtime, decisionRows] = await Promise.all([
    sb('nfl_model_weights', 'promoted=eq.true&select=version,weights,notes,created_at,promoted_at,backtest_clv_beat_pct,backtest_brier,backtest_units&order=version.desc&limit=1', secret),
    sb('nfl_learning_observations', 'select=season,week,publication_scope&order=finalized_at.desc&limit=5000', secret),
    currentSeason().catch(() => null),
    engineRuntime(GAME_LANES),
    sb('nfl_game_picks', 'select=season,status,publication_scope,created_at&order=created_at.desc&limit=5000', secret)
  ]);
  const champion = Array.isArray(weights) && weights.length ? weights[0] : null;
  const trained = isTrained(champion);
  const obs = Array.isArray(observations) ? observations : [];
  const weeks = new Set(obs.map(row => `${row.season}-${row.week}`));
  const tracking = obs.filter(row => row.publication_scope === 'tracking').length;
  const official = obs.filter(row => row.publication_scope === OFFICIAL).length;
  const gateOpen = obs.length >= 100 && weeks.size >= 4;
  return {
    champion_version: champion?.version ?? null,
    champion_notes: champion?.notes ?? null,
    champion_trained: trained,
    champion_backtest: {
      clv_beat_pct: champion?.backtest_clv_beat_pct ?? null,
      brier: champion?.backtest_brier ?? null,
      units: champion?.backtest_units ?? null
    },
    publication: trained ? 'ALLOWED' : 'GATED',
    publication_blocked_reason: trained ? null : champion ? `untrained_champion:v${champion.version}` : 'no_promoted_champion',
    graded_sample: obs.length,
    graded_sample_required: 100,
    graded_sample_tracking: tracking,
    graded_sample_official: official,
    distinct_weeks: weeks.size,
    distinct_weeks_required: 4,
    auto_tuner: gateOpen ? 'ELIGIBLE' : 'GATED',
    issuance_mode: trained ? 'OFFICIAL' : 'TRACKING_BOOTSTRAP',
    engine_state: composeEngineState({ health: runtime.health, trained, hasPicks: false, gatedState: UNTRAINED_STATE }),
    engine_health: runtime.health,
    engine_runtime: runtime,
    current: current,
    decisions: decisionCounts(decisionRows, current?.season ?? null),
    truth: 'verified_live_official_only',
    verification: {
      receipt_scheme: 'pbe-issuance-v1',
      hash: 'SHA-256',
      chained: true,
      attestation: 'internal_tamper_evidence',
      third_party_notarized: false
    }
  };
}

/* Season and week come from nfl-current; nothing here computes them. */
async function seasonContext() {
  const current = await currentSeason();
  return { season: current.season, week: current.week };
}

function chunks(values, size = 100) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function inList(values) {
  return values.map(value => `"${String(value).replace(/"/g, '')}"`).join(',');
}

async function gradesFor(secret, ids) {
  if (!ids.length) return new Map();
  const batches = await Promise.all(chunks(ids).map(group =>
    sb(
      'nfl_pick_grades',
      `pick_id=in.(${inList(group)})&select=pick_id,graded_at,clv_points,clv_prob,clv_beat,result,units_delta,brier`,
      secret
    )
  ));
  const rows = batches.flat().filter(Boolean);
  return new Map(rows.map(row => [row.pick_id, row]));
}

async function receiptsFor(secret, ids) {
  if (!ids.length) return new Map();
  const batches = await Promise.all(chunks(ids).map(group =>
    sb(
      'nfl_pick_receipts',
      `pick_id=in.(${inList(group)})&publication_scope=eq.${OFFICIAL}`
        + '&select=seq,pick_id,issued_at,receipt_version,payload_sha256,previous_chain_hash,chain_hash',
      secret
    )
  ));
  const rows = batches.flat().filter(Boolean);
  return new Map(rows.map(row => [row.pick_id, row]));
}

function sameSelection(pick, snapshot) {
  if (pick.market !== snapshot.market) return false;
  if (pick.market === 'total') return Boolean(pick.selection_over_under && snapshot.over_under === pick.selection_over_under);
  return Boolean(pick.selection_team && snapshot.team === pick.selection_team);
}

function downsample(rows, max = 12) {
  if (rows.length <= max) return rows;
  const picked = [];
  for (let i = 0; i < max; i += 1) {
    const index = Math.round(i * (rows.length - 1) / (max - 1));
    if (!picked.includes(rows[index])) picked.push(rows[index]);
  }
  return picked;
}

async function marketPathsFor(secret, picks) {
  if (!picks.length) return new Map();
  const gameIds = [...new Set(picks.map(row => row.game_id).filter(Boolean))];
  const batches = await Promise.all(chunks(gameIds, 40).map(group =>
    sb(
      'nfl_odds_snapshots',
      `game_id=in.(${inList(group)})`
        + '&select=game_id,captured_at,book,market,line,price,is_closing,team,over_under,is_home'
        + '&order=captured_at.asc&limit=10000',
      secret
    )
  ));
  const snapshots = batches.flat().filter(Boolean);
  const byGame = new Map();
  for (const row of snapshots) {
    const key = String(row.game_id);
    if (!byGame.has(key)) byGame.set(key, []);
    byGame.get(key).push(row);
  }

  const result = new Map();
  for (const pick of picks) {
    const issued = Date.parse(pick.created_at || pick.kickoff_ts || 0);
    const matching = (byGame.get(String(pick.game_id)) || [])
      .filter(row => sameSelection(pick, row))
      .filter(row => {
        const ts = Date.parse(row.captured_at || 0);
        return !Number.isFinite(issued) || !Number.isFinite(ts) || ts >= issued - 60000;
      });
    const issuePoint = {
      captured_at: pick.created_at,
      line: pick.market_line,
      price: pick.market_price,
      book: null,
      is_closing: false,
      stage: 'issue'
    };
    const sampled = downsample(matching).map(row => ({
      captured_at: row.captured_at,
      line: row.line,
      price: row.price,
      book: row.book,
      is_closing: row.is_closing === true,
      stage: row.is_closing === true ? 'close' : 'market'
    }));
    const close = matching.filter(row => row.is_closing === true).slice(-1)[0];
    if (close && !sampled.some(row => row.captured_at === close.captured_at && row.book === close.book)) {
      sampled.push({
        captured_at: close.captured_at, line: close.line, price: close.price,
        book: close.book, is_closing: true, stage: 'close'
      });
    }
    result.set(pick.id, [issuePoint, ...sampled].sort((a, b) => Date.parse(a.captured_at || 0) - Date.parse(b.captured_at || 0)));
  }
  return result;
}

function contextFor(pick, matchup) {
  const f = pick?.features && typeof pick.features === 'object' ? pick.features : {};
  const weather = f.dome === true ? 'dome' : f.wind15 === true ? 'wind' : f.cold25 === true ? 'cold' : 'standard';
  const away = matchup?.away_team, home = matchup?.home_team;
  const divisional = Boolean(away && home && DIVISION[away] && DIVISION[away] === DIVISION[home]);
  const issued = Date.parse(pick.created_at || 0), kickoff = Date.parse(pick.kickoff_ts || 0);
  const leadHours = Number.isFinite(issued) && Number.isFinite(kickoff) ? Math.max(0, (kickoff - issued) / 3600000) : null;
  const timing = leadHours === null ? null : leadHours < 24 ? 'lt24' : leadHours <= 72 ? '24to72' : 'gt72';
  const timingLabel = leadHours === null ? null : leadHours < 24 ? `${leadHours.toFixed(1)}h before kickoff` : `${(leadHours / 24).toFixed(1)}d before kickoff`;
  return {
    weather,
    divisional,
    division: divisional ? DIVISION[away] : null,
    timing,
    timing_label: timingLabel,
    lead_hours: leadHours,
    side: pick.market === 'total' ? null : pick.side_is_home === true ? 'home' : pick.side_is_home === false ? 'away' : null
  };
}

function decorate(picks, grades, receipts, paths, includeContext = false) {
  return (Array.isArray(picks) ? picks : []).map(pick => {
    const matchup = matchupFromGameId(pick.game_id);
    const row = {
      ...pick,
      grade: grades.get(pick.id) || null,
      receipt: receipts.get(pick.id) || null,
      matchup
    };
    if (paths) row.market_path = paths.get(pick.id) || [];
    if (includeContext) row.context = contextFor(pick, matchup);
    delete row.features;
    return row;
  });
}

function applyTrackFilters(rows, query) {
  const market = String(query?.market || '').toLowerCase();
  const model = Number(query?.model_version);
  const confidence = String(query?.confidence || '').toUpperCase();
  const week = Number(query?.week);
  const weather = String(query?.weather || '').toLowerCase();
  const divisional = String(query?.divisional || '').toLowerCase();
  const timing = String(query?.timing || '').toLowerCase();
  const result = String(query?.result || '').toLowerCase();
  return rows.filter(row => {
    if (market && ['spread','moneyline','total'].includes(market) && row.market !== market) return false;
    if (Number.isFinite(model) && model > 0 && row.model_version !== model) return false;
    if (confidence && ['A','B','C'].includes(confidence) && String(row.confidence_bucket || '').toUpperCase() !== confidence) return false;
    if (Number.isFinite(week) && week > 0 && row.week !== week) return false;
    if (weather && ['standard','dome','wind','cold'].includes(weather) && row?.context?.weather !== weather) return false;
    if (divisional === 'true' && row?.context?.divisional !== true) return false;
    if (divisional === 'false' && row?.context?.divisional !== false) return false;
    if (timing && ['lt24','24to72','gt72'].includes(timing) && row?.context?.timing !== timing) return false;
    if (result && ['win','loss','push'].includes(result) && String(row?.grade?.result || '').toLowerCase() !== result) return false;
    return true;
  });
}

async function stateView(res, secret) {
  const state = await governance(secret);
  return send(res, 200, state, 'public, max-age=10, s-maxage=10, stale-while-revalidate=30');
}

/* ---------------------------------------------------------------------------
 * PBE Card v3 — current decisions.
 *
 * The rules live in workers/nfl-picks-engine-shared/publication.mjs; this
 * function only fetches persisted rows and hands them over. Entitlement is
 * decided here, on the server, before a single decision row is read:
 *
 *   view=preview  anyone     locked previews: game, market, issue time. No
 *                            selection, line, price, probability, edge,
 *                            stake, confidence, receipt or pick id — enforced
 *                            by assertNoSelection() on the finished payload.
 *   view=current  NFL Pro    the full card. tracking rows are labelled PBE
 *                            VALIDATION SIGNAL, official rows OFFICIAL PBE
 *                            PICK — per row, from publication_scope.
 *
 * Every published card has passed: lifecycle (superseded never, withdrawn only
 * as an audit event), canonical attribution, and its own issuance receipt —
 * payload digest recomputed from payload::text and every issued term equal to
 * the row.
 * ------------------------------------------------------------------------ */

const CARD_CONTRACT = 'pbe-card-v3';
/* The engine never decides against a tape older than 28h; a card never calls
 * a tape fresh past the same bound. */
const TAPE_STALE_SECONDS = 28 * 3600;
const PICK_COLUMNS = [
  'id','game_id','season','week','kickoff_ts','market','side','market_line','market_price',
  'model_line','model_prob','market_prob','edge_pct','stake_units','confidence_bucket','model_version',
  'selection_team','selection_over_under','side_is_home','status','superseded_by','created_at',
  'publication_scope','features','created_text:created_at::text'
].join(',');

/* A verified NFL Pro session, or a response already sent. Fails closed: an
 * entitlement system that cannot answer is never read as "Pro". */
async function requirePro(req, res) {
  let auth;
  try {
    auth = await getNflSession(req);
  } catch (_) {
    send(res, 503, { error: 'entitlement_unavailable', stage: 'session_exception' });
    return null;
  }
  const email = verifiedEmail(auth);
  if (!email) {
    if (auth?.degraded) send(res, 503, { error: 'entitlement_unavailable', stage: auth.stage });
    else send(res, 401, { error: 'sign_in_required', entitlement: 'nfl_pro' });
    return null;
  }
  if (auth.degraded) { send(res, 503, { error: 'entitlement_unavailable', stage: auth.stage }); return null; }
  if (auth.pro !== true) { send(res, 403, { error: 'nfl_pro_required', entitlement: 'nfl_pro' }); return null; }
  return auth;
}

async function receiptsWithText(secret, ids) {
  if (!ids.length) return new Map();
  const batches = await Promise.all(chunks(ids).map(group =>
    sb(
      'nfl_pick_receipts',
      `pick_id=in.(${inList(group)})`
        + '&select=seq,pick_id,issued_at,publication_scope,receipt_version,payload_sha256,previous_chain_hash,chain_hash,payload_text:payload::text',
      secret
    )
  ));
  return new Map(batches.flat().filter(Boolean).map(row => [row.pick_id, row]));
}

async function auditsFor(secret, ids) {
  if (!ids.length) return [];
  const batches = await Promise.all(chunks(ids).map(group =>
    sb(
      'nfl_pick_audit_events',
      `pick_id=in.(${inList(group)})&event_type=in.(pick_created,pick_killed,pick_superseded,first_grade)`
        + '&select=pick_id,event_type,occurred_at,detail&order=occurred_at.asc&limit=5000',
      secret
    )
  ));
  /* Only the fields the contract reads leave this function. */
  return batches.flat().filter(Boolean).map(a => ({
    pick_id: a.pick_id, event_type: a.event_type, occurred_at: a.occurred_at,
    detail: a.event_type === 'pick_killed' ? { reason: a?.detail?.reason || null } : null,
  }));
}

/* One request per game: the tape can exceed PostgREST's row cap across a
 * whole slate, and a silently truncated tape would misstate movement. */
async function tapeFor(secret, gameIds) {
  const lists = await Promise.all(gameIds.map(id =>
    sb(
      'nfl_odds_snapshots',
      `game_id=eq.${encodeURIComponent(id)}`
        + '&select=game_id,captured_at,book,market,line,price,is_closing,team,over_under,is_home'
        + '&order=captured_at.asc&limit=1000',
      secret
    ).catch(() => [])
  ));
  return lists.flat().filter(Boolean);
}

/* Live game state from nfl-current (/api/scores via the gateway), keyed by
 * the engine's nflverse game id. Unavailable is null, never a guessed score. */
async function gameStates(season) {
  const base = String(process.env.NFL_GATEWAY || 'https://nfl-api.propbetedge.ai').replace(/\/$/, '');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const response = await fetch(`${base}/api/scores`, { cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return new Map();
    const body = await response.json();
    const out = new Map();
    for (const g of Array.isArray(body?.games) ? body.games : []) {
      if (Number(g.season) !== Number(season) || String(g.game_type || 'REG').toUpperCase() !== 'REG') continue;
      const id = `${g.season}_${String(g.week).padStart(2, '0')}_${nflverseTeam(g.away_team)}_${nflverseTeam(g.home_team)}`;
      out.set(id, {
        espn_id: g.game_id ? String(g.game_id) : null,
        kickoff: g.kickoff || null,
        state: String(g.semantics || '').toUpperCase() || null,
        detail: g.detail || null,
        away_score: g.away_score, home_score: g.home_score,
      });
    }
    return out;
  } catch (_) {
    return new Map();
  }
}

/* Everything the card needs, read once. nowMs is taken once so every
 * lifecycle decision in one response is made against the same instant. */
async function loadCard(secret, { withTape }) {
  const nowMs = Date.now();
  const [state, schedule] = await Promise.all([governance(secret), seasonContext()]);
  const { season, week } = schedule;
  /* Open rows of any week (a Thursday decision stays in play until its final),
   * plus this week's graded, killed and superseded rows so the filter is
   * visible, not assumed. */
  const query = `season=eq.${season}`
    + `&or=(status.eq.open,and(status.in.(graded,killed,superseded),week.eq.${week}))`
    + `&select=${PICK_COLUMNS}&order=kickoff_ts.asc&limit=1000`;
  const rows = (await sb('nfl_game_picks', query, secret)) || [];
  const ids = rows.map(row => row.id);
  const [receipts, audits, grades] = await Promise.all([
    receiptsWithText(secret, ids), auditsFor(secret, ids), gradesFor(secret, ids),
  ]);
  const killedIds = new Set(audits.filter(a => a.event_type === 'pick_killed').map(a => a.pick_id));
  const verified = new Map();
  const [games] = await Promise.all([
    gameStates(season),
    Promise.all(rows.map(async row => { verified.set(row.id, await verifyReceipt(row, receipts.get(row.id))); })),
  ]);
  /* Lifecycle is decided against nfl-current's real kickoff and game state. */
  const eligible = eligibleDecisions(rows, { nowMs, killedIds, verified, season, week, games });
  const gameIds = [...new Set(eligible.current.map(e => e.row.game_id))];
  const tape = withTape ? await tapeFor(secret, gameIds) : [];
  return { nowMs, state, season, week, rows, receipts, audits, grades, verified, eligible, tape, games };
}

function freshnessOf(state, tape, nowMs) {
  const lane = state?.engine_runtime?.lanes?.['nfl-game-picks-orchestrator'] || null;
  const fromLane = lane?.source_freshness?.tape_captured_at || null;
  const fromTape = tape.reduce((max, s) => (!max || Date.parse(s.captured_at) > Date.parse(max) ? s.captured_at : max), null);
  const tapeAt = [fromLane, fromTape].filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
  const age = tapeAt ? Math.max(0, Math.round((nowMs - Date.parse(tapeAt)) / 1000)) : null;
  return {
    tape_captured_at: tapeAt,
    tape_age_seconds: age,
    tape_state: age === null ? 'UNKNOWN' : age > TAPE_STALE_SECONDS ? 'STALE' : 'FRESH',
    tape_cadence: 'scheduled ingest 08:00 / 13:00 / 18:00 ET',
    last_evaluation_at: lane?.last_work_at || null,
    last_tick_at: lane?.last_tick_at || null,
  };
}

/* Aggregate proof of the filter. The public form carries counts only; the Pro
 * form adds the ids of rows whose receipt did not verify. */
function eligibilityReport(ctx, { withIds = false } = {}) {
  const checks = [...ctx.verified.entries()];
  const failures = checks.filter(([, v]) => !v.ok);
  const reasons = {};
  for (const [, v] of failures) reasons[v.reason] = (reasons[v.reason] || 0) + 1;
  const report = {
    rule: 'pbe-card-eligibility-v1',
    considered: ctx.rows.length,
    published: ctx.eligible.current.length,
    withdrawn_events: ctx.eligible.withdrawn.length,
    excluded: ctx.eligible.excluded,
    receipts: {
      checked: checks.length,
      verified: checks.length - failures.length,
      failed: failures.length,
      failure_reasons: reasons,
      chain_links_verified: checks.filter(([, v]) => v.chain === true).length,
    },
  };
  if (withIds) report.receipt_failures = failures.map(([id, v]) => ({ id, reason: v.reason, terms: v.terms })).slice(0, 20);
  return report;
}

async function currentView(req, res, secret) {
  const auth = await requirePro(req, res);
  if (!auth) return;

  const ctx = await loadCard(secret, { withTape: true });
  const mode = displayMode({ health: ctx.state.engine_health, trained: ctx.state.champion_trained });
  const healthy = mode !== 'DEGRADED';
  const cards = ctx.eligible.current.map(({ row, lifecycle }) => proCard({
    row, lifecycle,
    receipt: ctx.receipts.get(row.id),
    verification: ctx.verified.get(row.id),
    grade: lifecycle === 'FINAL' ? ctx.grades.get(row.id) || null : null,
    market: marketSinceIssue(row, ctx.tape, { nowMs: ctx.nowMs }),
    game: ctx.games.get(row.game_id) || null,
    audits: ctx.audits,
    nowMs: ctx.nowMs,
    engineHealthy: healthy,
  }));
  const engineState = composeEngineState({
    health: ctx.state.engine_health, trained: ctx.state.champion_trained, hasPicks: cards.length > 0, gatedState: UNTRAINED_STATE,
  });

  return send(res, 200, {
    ...ctx.state,
    contract: CARD_CONTRACT,
    engine_state: engineState,
    display_mode: mode,
    generated_at: new Date(ctx.nowMs).toISOString(),
    season: ctx.season,
    week: ctx.week,
    entitlement: 'pro',
    publication_scope: 'per_row',
    labels: LABELS,
    summary: cardSummary(cards, { nowMs: ctx.nowMs }),
    freshness: freshnessOf(ctx.state, ctx.tape, ctx.nowMs),
    eligibility: eligibilityReport(ctx, { withIds: true }),
    count: cards.length,
    picks: cards,
    withdrawn: ctx.eligible.withdrawn.map(({ row }) => withdrawnEvent({ row, audits: ctx.audits })),
  });
}

/* Free / public: the same eligible set, locked. */
async function previewView(res, secret) {
  const ctx = await loadCard(secret, { withTape: false });
  const mode = displayMode({ health: ctx.state.engine_health, trained: ctx.state.champion_trained });
  const previews = ctx.eligible.current.map(({ row, lifecycle }) => lockedPreview({ row, lifecycle, game: ctx.games.get(row.game_id) || null }));
  const lane = ctx.state?.engine_runtime?.lanes?.['nfl-game-picks-orchestrator'] || null;
  const body = {
    contract: CARD_CONTRACT,
    display_mode: mode,
    entitlement: 'public',
    generated_at: new Date(ctx.nowMs).toISOString(),
    season: ctx.season,
    week: ctx.week,
    champion_version: ctx.state.champion_version,
    champion_trained: ctx.state.champion_trained,
    engine_health: ctx.state.engine_health,
    engine_state: ctx.state.engine_state,
    last_evaluation_at: lane?.last_work_at || null,
    summary: {
      active: previews.filter(p => p.lifecycle === 'ACTIVE').length,
      locked: previews.filter(p => p.lifecycle === 'LOCKED').length,
      final: previews.filter(p => p.lifecycle === 'FINAL').length,
      total: previews.length,
      next_kickoff: previews.filter(p => p.lifecycle !== 'FINAL' && Date.parse(p.kickoff_ts) > ctx.nowMs)
        .map(p => p.kickoff_ts).sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null,
    },
    eligibility: eligibilityReport(ctx),
    previews,
    unlock: { entitlement: 'nfl_pro', cta: "Unlock today's PBE card" },
  };
  /* Defence in depth: refuse to send if anything actionable slipped in. */
  assertNoSelection(body);
  return send(res, 200, body, 'public, max-age=30, s-maxage=30, stale-while-revalidate=60');
}

/* Pro-only history of graded validation decisions. Separate from, and never
 * merged into, the Official Track Record. */
async function validationHistoryView(req, res, secret) {
  const auth = await requirePro(req, res);
  if (!auth) return;
  const nowMs = Date.now();
  const [state, schedule] = await Promise.all([governance(secret), seasonContext()]);
  const rows = (await sb(
    'nfl_game_picks',
    `publication_scope=eq.tracking&season=eq.${schedule.season}&status=in.(graded,killed)&select=${PICK_COLUMNS}&order=kickoff_ts.desc&limit=1000`,
    secret
  )) || [];
  const ids = rows.map(row => row.id);
  const [receipts, audits, grades] = await Promise.all([
    receiptsWithText(secret, ids), auditsFor(secret, ids), gradesFor(secret, ids),
  ]);
  const killedIds = new Set(audits.filter(a => a.event_type === 'pick_killed').map(a => a.pick_id));
  const decided = [];
  const withdrawn = [];
  let receiptFailures = 0;
  for (const row of rows) {
    const lifecycle = lifecycleOf(row, { nowMs, killedIds });
    if (lifecycle === 'WITHDRAWN') { withdrawn.push(withdrawnEvent({ row, audits })); continue; }
    if (lifecycle !== 'FINAL' || !attributionValid(row)) continue;
    const verification = await verifyReceipt(row, receipts.get(row.id));
    if (!verification.ok) { receiptFailures += 1; continue; }
    decided.push(proCard({
      row, lifecycle, receipt: receipts.get(row.id), verification,
      grade: grades.get(row.id) || null, market: null, game: null, audits, nowMs, engineHealthy: false,
    }));
  }
  const settled = decided.filter(c => ['win', 'loss', 'push'].includes(c.grade?.result));
  const clv = decided.filter(c => typeof c.grade?.clv_beat === 'boolean');
  return send(res, 200, {
    contract: CARD_CONTRACT,
    view: 'validation-history',
    record: 'validation_history',
    disclaimer: 'Validation decisions from a champion still under validation. Not the Official Track Record, never merged into it.',
    entitlement: 'pro',
    season: schedule.season,
    champion_version: state.champion_version,
    summary: {
      decisions: decided.length,
      win: settled.filter(c => c.grade.result === 'win').length,
      loss: settled.filter(c => c.grade.result === 'loss').length,
      push: settled.filter(c => c.grade.result === 'push').length,
      units: settled.length ? Number(settled.reduce((s, c) => s + (c.grade.units_delta ?? 0), 0).toFixed(4)) : null,
      clv_beat_pct: clv.length ? Number((clv.filter(c => c.grade.clv_beat).length / clv.length * 100).toFixed(1)) : null,
      withdrawn: withdrawn.length,
      receipt_failures: receiptFailures,
    },
    picks: decided,
    withdrawn,
  });
}

async function trackRecordView(req, res, secret) {
  const state = await governance(secret);
  const before = encodeURIComponent(new Date().toISOString());
  const select = [
    'id','game_id','season','week','kickoff_ts','market','side','market_line','market_price',
    'confidence_bucket','model_version','selection_team','selection_over_under','side_is_home','status','created_at','features'
  ].join(',');
  const query = `publication_scope=eq.${OFFICIAL}`
    + `&status=in.(graded,killed,superseded)&kickoff_ts=lt.${before}`
    + `&select=${select}&order=kickoff_ts.desc&limit=2000`;
  const picks = await sb('nfl_game_picks', query, secret);
  const ids = (picks || []).map(row => row.id);
  const [grades, receipts, paths] = await Promise.all([
    gradesFor(secret, ids),
    receiptsFor(secret, ids),
    marketPathsFor(secret, picks || [])
  ]);
  const rows = decorate(picks, grades, receipts, paths, true);
  const filtered = applyTrackFilters(rows, req.query || {});

  const availableFilters = {
    markets: [...new Set(rows.map(row => row.market).filter(Boolean))].sort(),
    model_versions: [...new Set(rows.map(row => row.model_version).filter(value => value !== null && value !== undefined))].sort((a,b) => a-b),
    confidence: [...new Set(rows.map(row => row.confidence_bucket).filter(Boolean))].sort(),
    weeks: [...new Set(rows.map(row => row.week).filter(value => Number.isFinite(Number(value))))].sort((a,b) => a-b),
    weather: [...new Set(rows.map(row => row?.context?.weather).filter(Boolean))].sort()
  };

  return send(res, 200, {
    ...state,
    publication_scope: OFFICIAL,
    total_count: rows.length,
    count: filtered.length,
    available_filters: availableFilters,
    picks: filtered
  }, 'public, max-age=30, s-maxage=30, stale-while-revalidate=120');
}

async function receiptView(req, res, secret) {
  const pickId = String(req.query?.pick_id || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pickId)) {
    return send(res, 400, { error: 'invalid_pick_id' });
  }
  const rows = await sb(
    'nfl_pick_receipts',
    `pick_id=eq.${encodeURIComponent(pickId)}&publication_scope=eq.${OFFICIAL}`
      + '&select=seq,pick_id,issued_at,publication_scope,receipt_version,payload_sha256,previous_chain_hash,chain_hash&limit=1',
    secret
  );
  if (!rows?.length) return send(res, 404, { error: 'receipt_not_found' });
  return send(res, 200, {
    ...rows[0],
    verification: {
      hash: 'SHA-256',
      chained: true,
      attestation: 'internal_tamper_evidence',
      third_party_notarized: false
    }
  }, 'public, max-age=300, s-maxage=300');
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const secret = serviceSecret();
  if (!secret) return send(res, 503, { error: 'picks_backend_unavailable', stage: 'service_secret_missing' });

  const view = typeof req.query?.view === 'string' ? req.query.view.trim().toLowerCase() : 'state';
  try {
    if (view === 'state') return await stateView(res, secret);
    if (view === 'current') return await currentView(req, res, secret);
    if (view === 'preview') return await previewView(res, secret);
    if (view === 'validation-history') return await validationHistoryView(req, res, secret);
    if (view === 'trackrecord') return await trackRecordView(req, res, secret);
    if (view === 'receipt') return await receiptView(req, res, secret);
    return send(res, 404, { error: 'view_not_found' });
  } catch (error) {
    console.error('PBE picks read contract failed', error instanceof Error ? error.message : String(error));
    return send(res, 503, { error: 'picks_backend_unavailable' });
  }
}
