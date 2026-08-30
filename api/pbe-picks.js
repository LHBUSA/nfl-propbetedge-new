import { getNflSession, verifiedEmail, supabaseAdminHeaders } from './_nfl-auth.js';

const DEFAULT_SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const DEFAULT_NFL_GATEWAY = 'https://nfl-api.propbetedge.ai';
const OFFICIAL = 'official';
const UNTRAINED_STATE = 'ENGINE GATED — MODEL VALIDATION IN PROGRESS';

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

async function governance(secret) {
  const [weights, observations] = await Promise.all([
    sb('nfl_model_weights', 'promoted=eq.true&select=version,weights,notes,created_at,promoted_at,backtest_clv_beat_pct,backtest_brier,backtest_units&order=version.desc&limit=1', secret),
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
    engine_state: trained ? 'ENGINE LIVE' : UNTRAINED_STATE,
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

function decorate(picks, grades, receipts, paths, games, includeContext = false) {
  const byGame = gameMap(games);
  return (Array.isArray(picks) ? picks : []).map(pick => {
    const matchup = byGame.get(String(pick.game_id)) || null;
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
  const ids = (picks || []).map(row => row.id);
  const [grades, receipts] = await Promise.all([gradesFor(secret, ids), receiptsFor(secret, ids)]);
  const rows = decorate(picks, grades, receipts, null, schedule.games);
  const engineState = !state.champion_trained
    ? UNTRAINED_STATE
    : rows.length
      ? 'ENGINE LIVE — PICKS AVAILABLE'
      : 'ENGINE LIVE — NO QUALIFIED PBE PICKS';

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

async function trackRecordView(req, res, secret) {
  const [state, schedule] = await Promise.all([governance(secret), scheduleContext()]);
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
  const rows = decorate(picks, grades, receipts, paths, schedule.games, true);
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
    if (view === 'trackrecord') return await trackRecordView(req, res, secret);
    if (view === 'receipt') return await receiptView(req, res, secret);
    return send(res, 404, { error: 'view_not_found' });
  } catch (error) {
    console.error('PBE picks read contract failed', error instanceof Error ? error.message : String(error));
    return send(res, 503, { error: 'picks_backend_unavailable' });
  }
}
