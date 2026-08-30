import { getNflSession, verifiedEmail, supabaseAdminHeaders } from './_nfl-auth.js';

const DEFAULT_SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const DEFAULT_NFL_GATEWAY = 'https://nfl-api.propbetedge.ai';
const OFFICIAL = 'official';
const UNTRAINED_STATE = 'ENGINE GATED \u2014 MODEL VALIDATION IN PROGRESS';

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
    throw new Error(`supabase_${response.status}${detail ? `:${detail.slice(0,120)}` : ''}`);
  }
  return response.json();
}

function isTrained(champion) {
  const value = champion?.weights?.meta?.trained;
  return value === true || value === 'true';
}

async function governance(secret) {
  const [weights, observations] = await Promise.all([
    sb('nfl_model_weights', 'promoted=eq.true&select=version,weights,notes,created_at,promoted_at&order=version.desc&limit=1', secret),
    sb('nfl_learning_observations', 'select=season,week,publication_scope&order=finalized_at.desc&limit=5000', secret)
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
    engine_state: trained ? 'ENGINE LIVE' : UNTRAINED_STATE,
    truth: 'verified_live_official_only'
  };
}

async function scheduleContext() {
  const base = String(process.env.NFL_GATEWAY || DEFAULT_NFL_GATEWAY).replace(/\/$/, '');
  const response = await fetch(`${base}/api/schedule`, { cache: 'no-store', headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`gateway_${response.status}`);
  const body = await response.json();
  const games = Array.isArray(body?.games) ? body.games : [];
  const now = Date.now();
  const next = games
    .map(game => ({ ...game, ts: Date.parse(`${game.gameday}T${game.gametime || '00:00'}:00Z`) }))
    .filter(game => Number.isFinite(game.ts) && game.ts >= now)
    .sort((a, b) => a.ts - b.ts)[0];
  return {
    season: Number(body?.season || next?.season || new Date().getUTCFullYear()),
    week: Number(next?.week || 1),
    games
  };
}

function gameMap(games) {
  const map = new Map();
  for (const game of Array.isArray(games) ? games : []) {
    if (!game?.game_id) continue;
    map.set(String(game.game_id), {
      game_id: game.game_id,
      away_team: game.away_team || null,
      home_team: game.home_team || null,
      gameday: game.gameday || null,
      gametime: game.gametime || null,
      week: game.week ?? null,
      season: game.season ?? null
    });
  }
  return map;
}

function chunks(values, size = 100) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

async function gradesFor(secret, ids) {
  if (!ids.length) return new Map();
  const batches = await Promise.all(chunks(ids).map(group =>
    sb(
      'nfl_pick_grades',
      `pick_id=in.(${group.join(',')})&select=pick_id,graded_at,clv_beat,result,units_delta`,
      secret
    )
  ));
  const rows = batches.flat().filter(Boolean);
  return new Map(rows.map(row => [row.pick_id, row]));
}

function decorate(picks, grades, games) {
  const byGame = gameMap(games);
  return (Array.isArray(picks) ? picks : []).map(pick => ({
    ...pick,
    grade: grades.get(pick.id) || null,
    matchup: byGame.get(String(pick.game_id)) || null
  }));
}

async function stateView(res, secret) {
  const state = await governance(secret);
  return send(res, 200, state, 'public, max-age=10, s-maxage=10, stale-while-revalidate=30');
}

async function currentView(req, res, secret) {
  const auth = await getNflSession(req);
  const email = verifiedEmail(auth);
  if (!email) {
    if (auth?.degraded) return send(res, 503, { error: 'entitlement_unavailable', stage: auth.stage });
    return send(res, 401, { error: 'sign_in_required', entitlement: 'nfl_pro' });
  }
  if (auth.degraded) return send(res, 503, { error: 'entitlement_unavailable', stage: auth.stage });
  if (auth.pro !== true) return send(res, 403, { error: 'nfl_pro_required', entitlement: 'nfl_pro' });

  const [state, schedule] = await Promise.all([governance(secret), scheduleContext()]);
  const select = [
    'id','game_id','season','week','kickoff_ts','market','side','market_line','market_price',
    'model_line','model_prob','market_prob','edge_pct','stake_units','confidence_bucket','model_version',
    'selection_team','selection_over_under','side_is_home','status','created_at'
  ].join(',');
  const query = `publication_scope=eq.${OFFICIAL}`
    + `&or=(status.eq.open,and(status.eq.graded,season.eq.${schedule.season},week.eq.${schedule.week}))`
    + `&select=${select}&order=kickoff_ts.asc&limit=200`;
  const picks = await sb('nfl_game_picks', query, secret);
  const grades = await gradesFor(secret, (picks || []).map(row => row.id));
  const rows = decorate(picks, grades, schedule.games);
  const engineState = !state.champion_trained
    ? UNTRAINED_STATE
    : rows.length
      ? 'ENGINE LIVE \u2014 PICKS AVAILABLE'
      : 'ENGINE LIVE \u2014 NO QUALIFIED PBE PICKS';

  return send(res, 200, {
    ...state,
    engine_state: engineState,
    season: schedule.season,
    week: schedule.week,
    entitlement: 'pro',
    publication_scope: OFFICIAL,
    count: rows.length,
    picks: rows
  });
}

async function trackRecordView(res, secret) {
  const [state, schedule] = await Promise.all([governance(secret), scheduleContext()]);
  const before = encodeURIComponent(new Date().toISOString());
  const select = [
    'id','game_id','season','week','kickoff_ts','market','side','market_line','market_price',
    'confidence_bucket','model_version','selection_team','selection_over_under','side_is_home','status','created_at'
  ].join(',');
  const query = `publication_scope=eq.${OFFICIAL}`
    + `&status=in.(graded,killed,superseded)&kickoff_ts=lt.${before}`
    + `&select=${select}&order=kickoff_ts.desc&limit=2000`;
  const picks = await sb('nfl_game_picks', query, secret);
  const grades = await gradesFor(secret, (picks || []).map(row => row.id));
  const rows = decorate(picks, grades, schedule.games);

  return send(res, 200, {
    ...state,
    publication_scope: OFFICIAL,
    count: rows.length,
    picks: rows
  }, 'public, max-age=30, s-maxage=30, stale-while-revalidate=120');
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const secret = serviceSecret();
  if (!secret) return send(res, 503, { error: 'picks_backend_unavailable', stage: 'service_secret_missing' });

  const view = typeof req.query?.view === 'string' ? req.query.view.trim().toLowerCase() : 'state';
  try {
    if (view === 'state') return await stateView(res, secret);
    if (view === 'current') return await currentView(req, res, secret);
    if (view === 'trackrecord') return await trackRecordView(res, secret);
    return send(res, 404, { error: 'view_not_found' });
  } catch (error) {
    console.error('PBE picks read contract failed', error instanceof Error ? error.message : String(error));
    return send(res, 503, { error: 'picks_backend_unavailable' });
  }
}
