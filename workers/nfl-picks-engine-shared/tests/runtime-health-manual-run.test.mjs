/* Runtime health is not decision integrity.
 *
 * The orchestrator used to record `status: 'degraded'` when there was no
 * promoted champion. laneHealth() maps a degraded work record to DEGRADED, so
 * a correctly-gated engine — bindings resolved, Supabase answered, champion
 * read, publication intentionally withheld — reported as broken forever, and
 * was indistinguishable from a real Supabase outage.
 *
 * These two vocabularies stay separate:
 *
 *   RUNTIME HEALTH        HEALTHY | DEGRADED | STALE | UNKNOWN
 *   DECISION/PUBLICATION  GATED | VALIDATION | ANOMALY_REVIEW | MODEL_DISABLED | READY
 *
 * Nothing here loosens a gate. A gated run still issues zero picks; the only
 * change is that the runtime reports the truth about itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { laneHealth, recordRun } from '../runs.mjs';
import {
  issuanceScope, championPublishable, GATED_NO_CHAMPION_STATE, DEGRADED_STATE,
} from '../champion.mjs';
import { latestPromotedWeights } from '../supabase.mjs';
import { EDGE_ANOMALY_HARD, FEATURE_ORDER, edgeAnomaly, monotonicityValid } from '../pick-math.mjs';
import { evaluate } from '../../nfl-game-picks-orchestrator/src/index.js';

const SRC = readFileSync(new URL('../../nfl-game-picks-orchestrator/src/index.js', import.meta.url), 'utf8');
const TOML = readFileSync(new URL('../../nfl-game-picks-orchestrator/wrangler.toml', import.meta.url), 'utf8');

const LANE = 'nfl-game-picks-orchestrator';
const NOW = Date.parse('2026-09-12T16:00:00.000Z');
const iso = msAgo => new Date(NOW - msAgo).toISOString();

/* A run that reached Supabase, read the champion, and correctly gated. */
const gatedRun = {
  status: 'ok',
  reason: 'decision_gated:no_promoted_champion',
  finished_at: iso(60_000),
  version: 'v1.2.0',
  counts: { emitted: 0, evaluated_games: 0, anomaly_review: 0, totals_disabled: 0 },
  detail: { public: { decision_state: 'GATED', decision_reason: 'no_promoted_champion', publication: 'GATED' } },
};

/* --------------------------------------------------------------------------
 * 1. No promoted champion => runtime work record is ok, lane is HEALTHY
 * ----------------------------------------------------------------------- */

test('no promoted champion is a decision gate, not a runtime failure', () => {
  const gate = issuanceScope(null);
  assert.equal(gate.canIssue, false);
  assert.equal(gate.reason, 'no_promoted_champion');

  /* The orchestrator records this outcome as a SUCCESSFUL run. */
  assert.match(SRC, /status: 'ok', reason: `decision_gated:\$\{issuance\.reason\}`/);
  assert.doesNotMatch(SRC, /issuance_blocked/);
});

test('laneHealth becomes HEALTHY after a successful gated run', () => {
  const health = laneHealth(LANE, { tick: gatedRun, work: gatedRun, ok: gatedRun }, NOW);
  assert.equal(health.state, 'HEALTHY');
  assert.equal(health.reason, null);
});

test('the gated run carries the publication state in detail.public, not in runtime status', () => {
  assert.equal(gatedRun.detail.public.decision_state, 'GATED');
  assert.equal(gatedRun.detail.public.publication, 'GATED');
  assert.equal(gatedRun.status, 'ok');
  /* The source writes exactly these decision fields on the gated path. */
  for (const field of ['decision_state', 'decision_reason', 'publication', 'issuance_mode']) {
    assert.ok(SRC.includes(`${field}:`), `gated record must carry ${field}`);
  }
});

test('a gated run issues zero picks', () => {
  assert.equal(gatedRun.counts.emitted, 0);
  /* The gated branch returns before any slate work, so nothing can be issued. */
  const branch = SRC.slice(SRC.indexOf('if (!issuance.canIssue)'));
  const body = branch.slice(0, branch.indexOf('persistRun(env, record)'));
  assert.doesNotMatch(body, /reconcile\(/);
  assert.doesNotMatch(body, /insert\(/);
});

/* --------------------------------------------------------------------------
 * 2. Real failures must STILL be DEGRADED — the fix must not blanket-green
 * ----------------------------------------------------------------------- */

test('a Supabase failure still reports DEGRADED', () => {
  const failed = { status: 'failed', error_class: 'supabase_522', finished_at: iso(60_000) };
  const health = laneHealth(LANE, { tick: failed, work: failed, err: failed }, NOW);
  assert.equal(health.state, 'DEGRADED');
  assert.equal(health.reason, 'supabase_522');
});

test('a degraded work record still reports DEGRADED', () => {
  const degraded = { status: 'degraded', reason: 'current_state_unavailable', finished_at: iso(60_000) };
  const health = laneHealth(LANE, { tick: degraded, work: degraded }, NOW);
  assert.equal(health.state, 'DEGRADED');
});

test('a missing input (ratings/tape) still degrades the run, not just the decision', () => {
  /* couldNotLook keeps its degraded status — an engine that cannot see the
   * market is a runtime problem, unlike an intentional publication gate. */
  assert.match(SRC, /status: couldNotLook \? 'degraded' : 'ok'/);
});

test('a stale cron still reports STALE and a never-run lane UNKNOWN', () => {
  const old = { status: 'ok', finished_at: iso(4 * 3600_000) };
  assert.equal(laneHealth(LANE, { tick: old, work: old, ok: old }, NOW).state, 'STALE');
  assert.equal(laneHealth(LANE, {}, NOW).state, 'UNKNOWN');
});

test('an overdue successful run is still DEGRADED by SLA', () => {
  const stale = { status: 'ok', reason: 'decision_gated:no_promoted_champion', finished_at: iso(14 * 3600_000) };
  const fresh = { status: 'ok', finished_at: iso(60_000) };
  const health = laneHealth(LANE, { tick: fresh, work: stale, ok: stale }, NOW);
  assert.equal(health.state, 'DEGRADED');
  assert.match(health.reason, /exceeds/);
});

/* --------------------------------------------------------------------------
 * 3. ANOMALY_REVIEW and MODEL_DISABLED are decision states, not runtime faults
 * ----------------------------------------------------------------------- */

const CHAMPION_V2 = {
  version: 2,
  promoted: true,
  weights: {
    intercept: 0,
    coef: Object.fromEntries(FEATURE_ORDER.map(f => [f, f === 'home' ? 0.16 : 0])),
    calib: { A: 1, B: 1, C: 1 },
    meta: { feature_order: [...FEATURE_ORDER], trained: true, integrity_version: 2 },
  },
};
const GAME = {
  game_id: '2026_01_NE_SEA', home_team: 'SEA', away_team: 'NE',
  kickoff_ts: '2026-09-13T17:00:00.000Z', rest_home: 7, rest_away: 7,
};
const RATINGS = new Map([
  ['SEA', { status: 'ok', off_epa_play: 0.12, def_epa_play: -0.05, proe: 0.03, pace: 64, qb_tier: 1 }],
  ['NE', { status: 'ok', off_epa_play: -0.04, def_epa_play: 0.02, proe: -0.01, pace: 61, qb_tier: 2 }],
]);

test('totals stay MODEL_DISABLED with dedicated_total_model_required', () => {
  const out = evaluate({
    game: GAME, market: 'total', season: 2026, week: 1, champion: CHAMPION_V2, ratings: RATINGS,
    quote: { side: 'Over 44.5', line: 44.5, price: -110, opposite_price: -110, over_under: 'over' },
  });
  assert.equal(out.integrity_status, 'MODEL_DISABLED');
  assert.equal(out.integrity_reason, 'dedicated_total_model_required');
  assert.equal(out.qualifies, false);
  assert.equal(out.stake_units, 0);
  /* MODEL_DISABLED is a decision state: it does not set a runtime error. */
  assert.equal(out.ratings_available, true);
  assert.equal(out.unavailable_reason, null);
});

test('the >15pp hard threshold classifies as an anomaly, 8pp only warns', () => {
  assert.equal(EDGE_ANOMALY_HARD, 0.15);
  assert.deepEqual(edgeAnomaly(0.2001), { hard: true, warn: true, reason: 'edge_above_15pp' });
  assert.equal(edgeAnomaly(0.1501).hard, true);
  assert.equal(edgeAnomaly(0.09).hard, false);
  assert.equal(edgeAnomaly(0.09).warn, true);
  assert.equal(edgeAnomaly(0.01).warn, false);
  /* A non-finite edge is treated as an anomaly, never as a zero edge. */
  assert.equal(edgeAnomaly(NaN).hard, true);
});

test('a hard edge anomaly is wired to ANOMALY_REVIEW and blocks qualification', () => {
  /* edgeState.hard is the third and last integrity branch in evaluate(). */
  assert.match(SRC, /else if \(edgeState\.hard\) \{ integrityStatus = 'ANOMALY_REVIEW'; integrityReason = edgeState\.reason; \}/);
  /* Nothing but ELIGIBLE may size a stake or earn a confidence bucket. */
  assert.match(SRC, /const bucket = integrityStatus === 'ELIGIBLE' \? confidenceBucket\(edge, market\) : null;/);
  assert.match(SRC, /const doesQualify = integrityStatus === 'ELIGIBLE' && qualifies\(edge, market\) && bucket !== null;/);
});

test('the market anchor keeps model probability near the market, which is what makes >15pp rare', () => {
  /* Regression guard for the market-anchored coherence repair: a wildly skewed
   * price must NOT drag the model to the opposite extreme. If this ever starts
   * producing a >15pp edge again, the anchor has been lost. */
  const out = evaluate({
    game: GAME, market: 'moneyline', season: 2026, week: 1, champion: CHAMPION_V2, ratings: RATINGS,
    quote: { side: 'SEA', price: 900, opposite_price: -2000, selected_is_home: true, team: 'SEA' },
  });
  assert.ok(Math.abs(out.edge_pct) <= EDGE_ANOMALY_HARD, `anchored edge ${out.edge_pct} must stay within ${EDGE_ANOMALY_HARD}`);
  assert.equal(out.integrity_status, 'ELIGIBLE');
});

test('spread/moneyline monotonicity is asserted in both directions', () => {
  /* A favourite (negative line) can never cover more often than it wins. */
  assert.equal(monotonicityValid({ winProb: 0.70, coverProb: 0.62, line: -3.5 }), true);
  assert.equal(monotonicityValid({ winProb: 0.70, coverProb: 0.78, line: -3.5 }), false);
  /* An underdog (positive line) can never win more often than it covers. */
  assert.equal(monotonicityValid({ winProb: 0.30, coverProb: 0.38, line: 3.5 }), true);
  assert.equal(monotonicityValid({ winProb: 0.30, coverProb: 0.22, line: 3.5 }), false);
  /* A pick'em must agree. */
  assert.equal(monotonicityValid({ winProb: 0.5, coverProb: 0.5, line: 0 }), true);
  assert.equal(monotonicityValid({ winProb: 0.5, coverProb: 0.6, line: 0 }), false);
  /* And it is wired to the quarantine, not merely computed. */
  assert.match(SRC, /integrityReason = 'spread_moneyline_monotonicity_failure'/);
});

test('anomaly and model-disabled output can never reach the pick ledger', () => {
  assert.match(SRC, /if \(decision\.integrity_status && decision\.integrity_status !== 'ELIGIBLE'\) return tally;/);
});

test('an un-upgraded champion is quarantined as ANOMALY_REVIEW, not silently trusted', () => {
  const v1 = { ...CHAMPION_V2, weights: { ...CHAMPION_V2.weights, meta: { ...CHAMPION_V2.weights.meta, integrity_version: 1 } } };
  const out = evaluate({
    game: GAME, market: 'moneyline', season: 2026, week: 1, champion: v1, ratings: RATINGS,
    quote: { side: 'SEA', price: -140, opposite_price: 120, selected_is_home: true, team: 'SEA' },
  });
  assert.equal(out.integrity_status, 'ANOMALY_REVIEW');
  assert.equal(out.integrity_reason, 'model_integrity_version_lt_2');
});

/* --------------------------------------------------------------------------
 * 4. Manual run endpoint — bypasses cadence ONLY, and fails closed
 * ----------------------------------------------------------------------- */

test('run-now is POST only and rejects every other method', () => {
  assert.match(SRC, /url\.pathname === '\/v1\/engine\/run-now'/);
  assert.match(SRC, /if \(req\.method !== 'POST'\)[\s\S]{0,160}405/);
});

test('an unset PICKS_ADMIN_TOKEN fails closed, it does not mean open', () => {
  assert.match(SRC, /if \(!token\) return \{ ok: false, status: 503, error: 'admin_token_not_configured' \}/);
});

test('a missing or wrong bearer token is rejected 401/403 and the token is never echoed', () => {
  assert.match(SRC, /status: 401, error: 'missing_bearer_token'/);
  assert.match(SRC, /status: 403, error: 'invalid_token'/);
  /* No response body may interpolate the secret. */
  assert.doesNotMatch(SRC, /PICKS_ADMIN_TOKEN[^\n]*json\(/);
  const runNow = SRC.slice(SRC.indexOf('async function runNow'));
  assert.doesNotMatch(runNow.slice(0, runNow.indexOf('\n}\n')), /env\.PICKS_ADMIN_TOKEN/);
});

test('the manual run bypasses cadence and NOTHING else', () => {
  const runNow = SRC.slice(SRC.indexOf('async function runNow'), SRC.indexOf('* Read contract'));
  /* It calls the same orchestration the cron calls... */
  assert.match(runNow, /runOrchestration\(env, slate, base\)/);
  /* ...loads the slate from the nfl-current authority... */
  assert.match(runNow, /loadSlate\(env\)/);
  /* ...and never consults or overrides the cadence decision. */
  assert.doesNotMatch(runNow, /cadenceDecision/);
  /* It must not touch any gate. */
  for (const forbidden of ['issuanceScope', 'championPublishable', 'promoted', 'integrity_status', 'MODEL_DISABLED']) {
    assert.ok(!runNow.includes(forbidden), `run-now must not touch ${forbidden}`);
  }
});

test('the manual run is marked as manual in the durable ledger', () => {
  const runNow = SRC.slice(SRC.indexOf('async function runNow'), SRC.indexOf('* Read contract'));
  assert.match(runNow, /trigger: 'manual_admin'/);
  assert.match(runNow, /tier: 'manual'/);
  assert.match(runNow, /cadence_reason: 'manual_admin'/);
});

test('duplicate rapid runs are locked out through PICKS_KV', () => {
  const runNow = SRC.slice(SRC.indexOf('async function runNow'), SRC.indexOf('* Read contract'));
  assert.match(runNow, /PICKS_KV\.get\(RUN_NOW_LOCK_KEY\)/);
  assert.match(runNow, /error: 'run_already_in_progress'[\s\S]{0,120}429/);
  assert.match(runNow, /expirationTtl: RUN_NOW_LOCK_TTL_S/);
  /* Cooldown must respect the 60s KV minimum. */
  assert.match(SRC, /RUN_NOW_COOLDOWN_S = 60/);
});

test('the ops secret is documented but never committed', () => {
  assert.match(TOML, /PICKS_ADMIN_TOKEN/);
  assert.match(TOML, /wrangler secret put PICKS_ADMIN_TOKEN/);
  /* No assignment of the secret anywhere in config. */
  assert.doesNotMatch(TOML, /^\s*PICKS_ADMIN_TOKEN\s*=/m);
  assert.doesNotMatch(TOML, /^\s*PICKS_INTERNAL_TOKEN\s*=/m);
});

test('run-now returns only public-safe execution metadata', () => {
  const runNow = SRC.slice(SRC.indexOf('async function runNow'), SRC.indexOf('* Read contract'));
  /* Only the `public` block of the run detail is returned. */
  assert.match(runNow, /detail: record\?\.detail\?\.public \?\? null/);
});

/* --------------------------------------------------------------------------
 * 5. no_promoted_model is a GATE, every other Supabase error is a FAILURE
 *
 * latestPromotedWeights() throws 'no_promoted_model' when the table holds no
 * promoted row. The orchestrator converts THAT EXACT message to a null
 * champion at its own call site; anything else must propagate so a real outage
 * still reports runtime DEGRADED/FAILED. Driven through a stubbed global fetch
 * so the real supabase.mjs code path runs, offline.
 * ----------------------------------------------------------------------- */

const STUB_ENV = { SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'stub-key' };

async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

/* The exact narrow conversion the orchestrator performs, applied to a real
 * latestPromotedWeights() call. */
async function championOrGate(env) {
  try {
    return { champion: await latestPromotedWeights(env), threw: null };
  } catch (error) {
    if (String(error?.message || error) !== 'no_promoted_model') throw error;
    return { champion: null, threw: 'no_promoted_model' };
  }
}

test('an empty promoted-model table really does throw no_promoted_model', async () => {
  await withFetch(
    async () => new Response('[]', { status: 200 }),
    async () => {
      await assert.rejects(() => latestPromotedWeights(STUB_ENV), /no_promoted_model/);
    },
  );
});

test('no_promoted_model is converted to a null champion, and gates as GATED', async () => {
  await withFetch(
    async () => new Response('[]', { status: 200 }),
    async () => {
      const { champion, threw } = await championOrGate(STUB_ENV);
      assert.equal(threw, 'no_promoted_model');
      assert.equal(champion, null);

      const gate = issuanceScope(champion);
      assert.equal(gate.canIssue, false);
      assert.equal(gate.scope, null);
      assert.equal(gate.mode, 'GATED');
      assert.equal(gate.state, GATED_NO_CHAMPION_STATE);
      assert.equal(gate.reason, 'no_promoted_champion');

      const pub = championPublishable(champion);
      assert.equal(pub.publishable, false);
      assert.equal(pub.state, GATED_NO_CHAMPION_STATE);
      assert.equal(pub.reason, 'no_promoted_champion');
    },
  );
});

test('a real Supabase failure is NOT swallowed by the gate conversion', async () => {
  await withFetch(
    async () => new Response('upstream boom', { status: 522 }),
    async () => {
      /* It must propagate, not become a null champion. */
      await assert.rejects(() => championOrGate(STUB_ENV), /supabase_522/);
    },
  );
});

test('a network-level failure also propagates rather than gating', async () => {
  await withFetch(
    async () => { throw new Error('network_unreachable'); },
    async () => {
      await assert.rejects(() => championOrGate(STUB_ENV), /network_unreachable/);
    },
  );
});

test('the orchestrator work path uses the narrow catch, never a blanket one', () => {
  const work = SRC.slice(SRC.indexOf('async function runOrchestration'), SRC.indexOf('export function evaluate'));
  /* Exactly the narrow rethrow. */
  assert.match(work, /if \(String\(error\?\.message \|\| error\) !== 'no_promoted_model'\) throw error;/);
  /* And no blanket swallow of the champion read in the work path. */
  assert.doesNotMatch(work, /latestPromotedWeights\(env\)\.catch\(\(\) => null\)/);
});

test('latestPromotedWeights itself is unchanged and still throws for every caller', () => {
  const supa = readFileSync(new URL('../supabase.mjs', import.meta.url), 'utf8');
  assert.match(supa, /if \(!row\) throw new Error\('no_promoted_model'\);/);
});

test('a null champion never reports "source unavailable"', () => {
  assert.notEqual(GATED_NO_CHAMPION_STATE, DEGRADED_STATE);
  assert.match(GATED_NO_CHAMPION_STATE, /GATED/);
  assert.doesNotMatch(GATED_NO_CHAMPION_STATE, /source unavailable/);
  assert.notEqual(issuanceScope(null).state, DEGRADED_STATE);
  assert.notEqual(championPublishable(null).state, DEGRADED_STATE);
  /* An explicitly un-promoted row is a gate too, not a source failure. */
  const withdrawn = issuanceScope({ version: 3, promoted: false });
  assert.equal(withdrawn.mode, 'GATED');
  assert.equal(withdrawn.state, GATED_NO_CHAMPION_STATE);
  assert.equal(withdrawn.reason, 'not_promoted:v3');
});

test('DEGRADED_STATE stays reserved for genuine source failures', () => {
  /* The orchestrator sets it only in the catch that handles thrown errors. */
  const catchBlock = SRC.slice(SRC.indexOf('} catch (error) {', SRC.indexOf('async function runOrchestration')));
  assert.match(catchBlock, /ENGINE DEGRADED — source unavailable/);
  assert.match(catchBlock, /status: 'failed'/);
});

test('the gated run is HEALTHY end to end: ok status, GATED state, zero issued', () => {
  const gate = issuanceScope(null);
  const run = {
    status: 'ok',
    reason: `decision_gated:${gate.reason}`,
    finished_at: iso(30_000),
    counts: { emitted: 0, evaluated_games: 0, anomaly_review: 0, totals_disabled: 0 },
    detail: { public: { engine_state: gate.state, issuance_mode: gate.mode, publication: 'GATED' } },
  };
  assert.equal(run.reason, 'decision_gated:no_promoted_champion');
  assert.equal(run.detail.public.engine_state, 'ENGINE GATED — NO PROMOTED CHAMPION');
  assert.equal(run.detail.public.issuance_mode, 'GATED');
  assert.equal(run.counts.emitted, 0);
  assert.equal(laneHealth(LANE, { tick: run, work: run, ok: run }, NOW).state, 'HEALTHY');
});

/* --------------------------------------------------------------------------
 * 6. The manual-run response and the durable ledger report the SAME completion
 *
 * safeRecord() mints finished_at inside recordRun, so a caller that persisted
 * a record and then returned its own copy reported finished_at: null for a run
 * that had plainly finished. persistRun() stamps it once, on the object that is
 * both written and returned, so the two cannot drift.
 * ----------------------------------------------------------------------- */

test('persistRun stamps finished_at once, on the object it persists and returns', () => {
  const src = SRC.slice(SRC.indexOf('async function persistRun'), SRC.indexOf('async function runOrchestration'));
  assert.match(src, /record\.finished_at = record\.finished_at \|\| new Date\(\)\.toISOString\(\);/);
  assert.match(src, /await recordRun\(env, SERVICE, record\);/);
  assert.match(src, /return record;/);
  /* Every orchestration exit goes through it — none may persist directly and
   * hand back an unstamped copy. */
  const work = SRC.slice(SRC.indexOf('async function runOrchestration'), SRC.indexOf('export function evaluate'));
  assert.equal((work.match(/persistRun\(env, record\)/g) || []).length, 4);
  assert.doesNotMatch(work, /await recordRun\(env, SERVICE, record\);/);
});

test('the run-now response carries finished_at straight from the persisted record', () => {
  const runNow = SRC.slice(SRC.indexOf('async function runNow'), SRC.indexOf('* Read contract'));
  /* Not a second `new Date()` — the same record the ledger received. */
  assert.match(runNow, /finished_at: record\?\.finished_at \?\? null/);
  assert.doesNotMatch(runNow, /finished_at: new Date\(\)/);
});

test('a stamped record yields a valid ISO finished_at that the ledger echoes back', () => {
  /* Mirrors persistRun against a fake KV, then reads the record back exactly as
   * laneHealth would, and asserts the response copy and the stored copy agree. */
  const stored = {};
  const fakeKv = {
    put: async (k, v) => { stored[k] = v; },
    get: async (k, opts) => (opts?.type === 'json' ? JSON.parse(stored[k] ?? 'null') : (stored[k] ?? null)),
  };
  const record = {
    version: 'v1.2.0', trigger: 'manual_admin', tier: 'manual',
    started_at: new Date(NOW).toISOString(), status: 'ok',
    reason: 'decision_gated:no_promoted_champion',
    counts: { emitted: 0, anomaly_review: 0, totals_disabled: 0 },
    detail: { public: { publication: 'GATED' } },
  };
  record.finished_at = record.finished_at || new Date(NOW + 200).toISOString();

  assert.notEqual(record.finished_at, null);
  assert.ok(Number.isFinite(Date.parse(record.finished_at)), 'finished_at must parse as a date');
  assert.equal(new Date(record.finished_at).toISOString(), record.finished_at, 'must be canonical ISO');

  return recordRun({ PICKS_KV: fakeKv }, LANE, record).then(async ok => {
    assert.equal(ok, true);
    const persisted = JSON.parse(stored[`run:work:${LANE}`]);
    /* The response copy and the durable ledger agree, because they are one object. */
    assert.equal(persisted.finished_at, record.finished_at);
    assert.equal(persisted.status, 'ok');
    assert.equal(persisted.reason, 'decision_gated:no_promoted_champion');
    assert.equal(persisted.trigger, 'manual_admin');

    /* And the gated run is still HEALTHY with nothing issued. */
    const health = laneHealth(LANE, { tick: persisted, work: persisted, ok: persisted }, NOW + 1000);
    assert.equal(health.state, 'HEALTHY');
    assert.equal(health.reason, null);
    assert.equal(persisted.counts.emitted, 0);
    assert.equal(persisted.detail.public.publication, 'GATED');
  });
});
