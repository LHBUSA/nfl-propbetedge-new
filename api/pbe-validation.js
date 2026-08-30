import { supabaseAdminHeaders } from './_nfl-auth.js';

const DEFAULT_SUPABASE_URL = 'https://tkmlnhmylqnttmnsnief.supabase.co';
const MIN_GRADED_PICKS = 100;
const MIN_DISTINCT_WEEKS = 4;
const CLV_IMPROVEMENT_POINTS = 1.0;
const CLV_TIE_TOLERANCE = 0.5;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', status === 200 ? 'public, max-age=10, s-maxage=10, stale-while-revalidate=30' : 'private, no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(body));
}

function baseUrl() {
  return String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
}

function secret() {
  return String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
}

async function sb(path, query, key) {
  const response = await fetch(`${baseUrl()}/rest/v1/${path}?${query}`, {
    headers: supabaseAdminHeaders(key),
    cache: 'no-store'
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`supabase_${response.status}${detail ? `:${detail.slice(0, 120)}` : ''}`);
  }
  return response.json();
}

function average(values) {
  const clean = values.map(Number).filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function latestIso(rows, field) {
  const dates = rows.map(row => Date.parse(row?.[field] || '')).filter(Number.isFinite);
  return dates.length ? new Date(Math.max(...dates)).toISOString() : null;
}

function eventLabel(type) {
  return ({
    pick_created: 'decision committed',
    features_locked: 'feature snapshot frozen',
    issuance_market_state: 'issue market state frozen',
    tracking_final_result: 'tracking decision finalized',
    official_final_result: 'official decision finalized',
    first_grade: 'final grade logged',
    correction_regrade: 'authoritative correction regraded',
    training_run: 'challenger training run logged',
    challenger_evaluation: 'challenger evaluated',
    champion_promoted: 'new champion promoted',
    champion_rejected: 'challenger rejected'
  }[type] || String(type || '').replace(/_/g, ' '));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const key = secret();
  if (!key) return send(res, 503, { error: 'validation_backend_unavailable', stage: 'service_secret_missing' });

  try {
    const [observationsRaw, receiptsRaw, auditRaw, oddsRaw, championRaw] = await Promise.all([
      sb('nfl_learning_observations', 'publication_scope=eq.tracking&is_final=eq.true&select=finalized_at,season,week,clv_beat,result,units_delta,brier&order=finalized_at.desc&limit=5000', key),
      sb('nfl_pick_receipts', 'publication_scope=eq.tracking&select=seq,issued_at,receipt_version,chain_hash&order=seq.desc&limit=1000', key),
      sb('nfl_pick_audit_events', 'select=occurred_at,event_type,model_version&order=occurred_at.desc&limit=12', key),
      sb('nfl_odds_snapshots', 'select=captured_at,market,book&order=captured_at.desc&limit=12', key),
      sb('nfl_model_weights', 'promoted=eq.true&select=version,notes,backtest_clv_beat_pct,backtest_brier,backtest_units,weights&order=version.desc&limit=1', key)
    ]);

    const observations = Array.isArray(observationsRaw) ? observationsRaw : [];
    const receipts = Array.isArray(receiptsRaw) ? receiptsRaw : [];
    const audits = Array.isArray(auditRaw) ? auditRaw : [];
    const odds = Array.isArray(oddsRaw) ? oddsRaw : [];
    const champion = Array.isArray(championRaw) && championRaw.length ? championRaw[0] : null;
    const weeks = new Set(observations.map(row => `${row.season}-${row.week}`));
    const clvRows = observations.filter(row => typeof row.clv_beat === 'boolean');
    const clvBeat = clvRows.length ? clvRows.filter(row => row.clv_beat).length / clvRows.length * 100 : null;
    const brier = average(observations.map(row => row.brier));
    const units = observations.map(row => Number(row.units_delta)).filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
    const resultRows = observations.filter(row => ['win', 'loss', 'push'].includes(String(row.result || '').toLowerCase()));
    const wins = resultRows.filter(row => String(row.result).toLowerCase() === 'win').length;
    const losses = resultRows.filter(row => String(row.result).toLowerCase() === 'loss').length;
    const pushes = resultRows.filter(row => String(row.result).toLowerCase() === 'push').length;
    const trained = champion?.weights?.meta?.trained === true || champion?.weights?.meta?.trained === 'true';
    const head = receipts[0] || null;

    const activity = [];
    if (odds.length) {
      activity.push({
        at: odds[0].captured_at,
        kind: 'MARKET',
        message: `odds snapshot captured · ${String(odds[0].market || 'market').toUpperCase()} · ${String(odds[0].book || 'provider')}`
      });
    }
    if (head) {
      activity.push({
        at: head.issued_at,
        kind: 'COMMIT',
        message: `bootstrap commitment #${head.seq} · SHA-256 ${head.chain_hash.slice(0, 12)}…`
      });
    }
    for (const row of audits.slice(0, 8)) {
      activity.push({
        at: row.occurred_at,
        kind: String(row.event_type || '').includes('grade') || String(row.event_type || '').includes('final') ? 'GRADE' : 'ENGINE',
        message: `${eventLabel(row.event_type)}${row.model_version ? ` · v${row.model_version}` : ''}`
      });
    }
    activity.sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));

    return send(res, 200, {
      service: 'pbe-validation-telemetry',
      truth: 'aggregate_tracking_telemetry_no_selection_reveal',
      champion: {
        version: champion?.version ?? null,
        trained,
        notes: champion?.notes ?? null,
        backtest: {
          clv_beat_pct: champion?.backtest_clv_beat_pct ?? null,
          brier: champion?.backtest_brier ?? null,
          units: champion?.backtest_units ?? null
        }
      },
      volume_gate: {
        finalized: observations.length,
        required_finalized: MIN_GRADED_PICKS,
        distinct_weeks: weeks.size,
        required_weeks: MIN_DISTINCT_WEEKS,
        open: observations.length >= MIN_GRADED_PICKS && weeks.size >= MIN_DISTINCT_WEEKS
      },
      bootstrap_performance: {
        clv_beat_pct: clvBeat,
        brier,
        units_delta: observations.length ? Number(units.toFixed(4)) : null,
        wins,
        losses,
        pushes,
        latest_finalized_at: latestIso(observations, 'finalized_at'),
        note: 'descriptive out-of-sample tracking metrics; not by themselves the promotion verdict'
      },
      promotion_contract: {
        train_after_volume_gate: true,
        primary: `challenger CLV-beat% must be at least champion + ${CLV_IMPROVEMENT_POINTS.toFixed(1)} percentage point`,
        tie_break: `if CLV is within ${CLV_TIE_TOLERANCE.toFixed(1)} percentage point, challenger Brier must be lower`,
        clv_improvement_points: CLV_IMPROVEMENT_POINTS,
        clv_tie_tolerance: CLV_TIE_TOLERANCE,
        roi_hurdle: null
      },
      commitments: {
        scheme: 'pbe-issuance-v1',
        hash: 'SHA-256',
        chained: true,
        internal_tamper_evidence: true,
        third_party_notarized: false,
        external_anchor: 'not_configured',
        committed_tracking_count: receipts.length,
        latest: head ? { seq: head.seq, issued_at: head.issued_at, chain_hash: head.chain_hash } : null,
        recent: receipts.slice(0, 8).map(row => ({ seq: row.seq, issued_at: row.issued_at, chain_hash: row.chain_hash }))
      },
      market_heartbeat: {
        latest_snapshot_at: odds[0]?.captured_at ?? null,
        latest_market: odds[0]?.market ?? null,
        latest_book: odds[0]?.book ?? null
      },
      activity: activity.slice(0, 10)
    });
  } catch (error) {
    console.error('PBE validation telemetry failed', error instanceof Error ? error.message : String(error));
    return send(res, 503, { error: 'validation_backend_unavailable' });
  }
}
