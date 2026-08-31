import { getNflSession, verifiedEmail, supabaseAdminHeaders } from './_nfl-auth.js';

const DEFAULT_SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const OFFICIAL = 'official';
const MARKET = 'player_pass_yds';
const MIN_FINALIZED = 100;
const MIN_WEEKS = 4;

function send(res, status, body, cacheControl = 'private, no-store, max-age=0') {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cacheControl);
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(body));
}
function baseUrl() { return String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, ''); }
function serviceSecret() { return String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(); }
async function sb(path, query, secret) {
  const response = await fetch(`${baseUrl()}/rest/v1/${path}?${query}`, {
    headers: supabaseAdminHeaders(secret), cache: 'no-store'
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`supabase_${response.status}${detail ? `:${detail.slice(0, 160)}` : ''}`);
  }
  return response.json();
}
function chunks(values, size = 100) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}
function inList(values) { return values.map(value => `"${String(value).replace(/"/g, '')}"`).join(','); }

async function governance(secret) {
  const [models, observations, latestPick, latestAudit] = await Promise.all([
    sb('nfl_prop_selector_models', `market=eq.${MARKET}&promoted=is.true&select=version,market,projection_model,config,trained,promoted,training_rows,trained_through_week,backtest_clv_beat_pct,backtest_brier,backtest_units,notes,created_at,promoted_at&order=version.desc&limit=1`, secret),
    sb('nfl_prop_learning_observations', `market=eq.${MARKET}&is_final=eq.true&select=season,week,publication_scope,clv_beat,units_delta,brier,finalized_at&order=finalized_at.desc&limit=5000`, secret),
    sb('nfl_prop_picks', `market=eq.${MARKET}&select=id,created_at,publication_scope,status&order=created_at.desc&limit=1`, secret),
    sb('nfl_prop_pick_audit_events', 'select=event_type,occurred_at&order=occurred_at.desc&limit=1', secret)
  ]);
  const selector = Array.isArray(models) ? models[0] : null;
  const obs = Array.isArray(observations) ? observations : [];
  const weeks = new Set(obs.map(row => `${row.season}-${row.week}`));
  const clvRows = obs.filter(row => typeof row.clv_beat === 'boolean');
  const clvBeatPct = clvRows.length ? clvRows.filter(row => row.clv_beat).length / clvRows.length * 100 : null;
  const units = obs.length ? obs.reduce((sum, row) => sum + (Number(row.units_delta) || 0), 0) : null;
  const briers = obs.map(row => Number(row.brier)).filter(Number.isFinite);
  const trained = selector?.trained === true;
  return {
    engine: 'PBE Player Props',
    market: MARKET,
    market_label: 'Passing Yards',
    selector_version: selector?.version ?? null,
    projection_model: selector?.projection_model ?? null,
    selector_trained: trained,
    selector_promoted: selector?.promoted === true,
    selector_notes: selector?.notes ?? null,
    selector_config_public: selector?.config ? {
      min_edge: selector.config.min_edge ?? null,
      min_ev_pct: selector.config.min_ev_pct ?? null,
      min_books: selector.config.min_books ?? null,
      kelly_fraction: selector.config.kelly_fraction ?? null,
      stake_floor_units: selector.config.stake_floor_units ?? null,
      stake_cap_units: selector.config.stake_cap_units ?? null,
      early_bird_min_hours: selector.config.early_bird_min_hours ?? null,
      locked_max_hours: selector.config.locked_max_hours ?? null
    } : null,
    publication: trained ? 'ALLOWED' : 'GATED',
    publication_blocked_reason: trained ? null : selector ? `untrained_prop_selector:v${selector.version}` : 'no_promoted_prop_selector',
    issuance_mode: trained ? 'OFFICIAL' : 'TRACKING_BOOTSTRAP',
    finalized_sample: obs.length,
    finalized_required: MIN_FINALIZED,
    distinct_weeks: weeks.size,
    distinct_weeks_required: MIN_WEEKS,
    gate_open: obs.length >= MIN_FINALIZED && weeks.size >= MIN_WEEKS,
    validation_performance: {
      clv_beat_pct: clvBeatPct,
      units_delta: units === null ? null : Number(units.toFixed(4)),
      brier: briers.length ? Number((briers.reduce((a, b) => a + b, 0) / briers.length).toFixed(6)) : null
    },
    runtime_evidence: {
      first_decision_seen: Array.isArray(latestPick) && latestPick.length > 0,
      latest_decision_at: latestPick?.[0]?.created_at ?? null,
      latest_audit_event: latestAudit?.[0]?.event_type ?? null,
      latest_audit_at: latestAudit?.[0]?.occurred_at ?? null
    },
    verification: {
      receipt_scheme: 'pbe-prop-issuance-v1',
      hash: 'SHA-256',
      chained: true,
      attestation: 'internal_tamper_evidence',
      third_party_notarized: false
    },
    truth: 'official_player_props_only_customer_record'
  };
}

async function gradesFor(secret, ids) {
  if (!ids.length) return new Map();
  const batches = await Promise.all(chunks(ids).map(group => sb(
    'nfl_prop_pick_grades',
    `pick_id=in.(${inList(group)})&select=pick_id,final_value,result,units_delta,closing_line,closing_price,closing_market_prob,clv_points,clv_prob,clv_beat,brier,source,graded_at`,
    secret
  )));
  return new Map(batches.flat().filter(Boolean).map(row => [row.pick_id, row]));
}
async function receiptsFor(secret, ids) {
  if (!ids.length) return new Map();
  const batches = await Promise.all(chunks(ids).map(group => sb(
    'nfl_prop_pick_receipts',
    `pick_id=in.(${inList(group)})&publication_scope=eq.${OFFICIAL}&select=seq,pick_id,issued_at,receipt_version,payload_sha256,previous_chain_hash,chain_hash`,
    secret
  )));
  return new Map(batches.flat().filter(Boolean).map(row => [row.pick_id, row]));
}
function decorate(rows, grades, receipts) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    ...row,
    grade: grades.get(row.id) || null,
    receipt: receipts.get(row.id) || null,
    model_snapshot: undefined
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

  const state = await governance(secret);
  const selectFields = [
    'id','event_id','season','week','kickoff_ts','player_name','player_key','market','side','book','book_key',
    'market_line','market_price','opposite_price','model_fair_line','predictive_sd','model_prob','market_prob',
    'edge_pct','ev_pct','stake_units','confidence_bucket','projection_model_version','selector_version','phase','status','created_at'
  ].join(',');
  const rows = await sb('nfl_prop_picks',
    `market=eq.${MARKET}&publication_scope=eq.${OFFICIAL}&status=eq.open&select=${selectFields}&order=kickoff_ts.asc&limit=100`, secret);
  const ids = (rows || []).map(row => row.id);
  const receipts = await receiptsFor(secret, ids);
  return send(res, 200, {
    ...state,
    entitlement: 'pro',
    publication_scope: OFFICIAL,
    count: rows.length,
    picks: decorate(rows, new Map(), receipts)
  });
}

async function trackRecordView(res, secret) {
  const state = await governance(secret);
  const selectFields = [
    'id','event_id','season','week','kickoff_ts','player_name','player_key','market','side','book','market_line','market_price',
    'model_fair_line','predictive_sd','model_prob','market_prob','edge_pct','ev_pct','stake_units','confidence_bucket',
    'projection_model_version','selector_version','phase','status','created_at'
  ].join(',');
  const rows = await sb('nfl_prop_picks',
    `market=eq.${MARKET}&publication_scope=eq.${OFFICIAL}&status=in.(graded,killed,superseded)&select=${selectFields}&order=kickoff_ts.desc&limit=2000`, secret);
  const ids = (rows || []).map(row => row.id);
  const [grades, receipts] = await Promise.all([gradesFor(secret, ids), receiptsFor(secret, ids)]);
  return send(res, 200, {
    ...state,
    publication_scope: OFFICIAL,
    count: rows.length,
    picks: decorate(rows, grades, receipts)
  }, 'public, max-age=30, s-maxage=30, stale-while-revalidate=120');
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const secret = serviceSecret();
  if (!secret) return send(res, 503, { error: 'prop_picks_backend_unavailable', stage: 'service_secret_missing' });
  const view = typeof req.query?.view === 'string' ? req.query.view.trim().toLowerCase() : 'state';
  try {
    if (view === 'state') return await stateView(res, secret);
    if (view === 'current') return await currentView(req, res, secret);
    if (view === 'trackrecord') return await trackRecordView(res, secret);
    return send(res, 404, { error: 'view_not_found' });
  } catch (error) {
    console.error('PBE player prop picks read contract failed', error instanceof Error ? error.message : String(error));
    return send(res, 503, { error: 'prop_picks_backend_unavailable' });
  }
}
