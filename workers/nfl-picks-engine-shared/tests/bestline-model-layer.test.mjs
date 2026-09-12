/* Best Line's model layer (Phase 4).
 *
 * Best Line and PBE Picks are different products. A pick exists only when an
 * edge qualifies for issuance; a model fair value exists whenever the engine
 * evaluated the market successfully. The old overlay joined Best Line to issued
 * cards, so every non-issued market was a bare dash forever.
 *
 * The rule these tests defend: evaluate() stays the ONLY model calculation
 * authority. The KV snapshot reshapes its output and nothing recomputes a
 * probability downstream — least of all from consensus.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { evaluate } from '../../nfl-game-picks-orchestrator/src/index.js';
import { FEATURE_ORDER } from '../pick-math.mjs';

const ORCH = readFileSync(new URL('../../nfl-game-picks-orchestrator/src/index.js', import.meta.url), 'utf8');
const OVERLAY = readFileSync(new URL('../../../best-line-model-overlay-v1.js', import.meta.url), 'utf8');
const PICKS_API = readFileSync(new URL('../../../api/pbe-picks.js', import.meta.url), 'utf8');
const TOML = readFileSync(new URL('../../nfl-game-picks-orchestrator/wrangler.toml', import.meta.url), 'utf8');

const CHAMPION = {
  version: 3, promoted: true,
  weights: {
    intercept: 0,
    coef: Object.fromEntries(FEATURE_ORDER.map(f => [f, f === 'home' ? 0.16 : 0])),
    calib: { A: 1, B: 1, C: 1 },
    meta: { feature_order: [...FEATURE_ORDER], trained: false, integrity_version: 2 },
  },
};
const GAME = {
  game_id: '2026_01_ATL_PIT', home_team: 'PIT', away_team: 'ATL',
  kickoff_ts: '2026-09-13T17:00:00.000Z', rest_home: 7, rest_away: 7,
};
const RATINGS = new Map([
  ['PIT', { status: 'ok', off_epa_play: 0.06, def_epa_play: -0.03, proe: 0.02, pace: 63, qb_tier: 2 }],
  ['ATL', { status: 'ok', off_epa_play: -0.02, def_epa_play: 0.01, proe: -0.01, pace: 62, qb_tier: 3 }],
]);

/* The sanitizer, mirrored from the orchestrator, so the shape is pinned. */
function sanitize(d, { market, tapeAt, evaluatedAt }) {
  const base = {
    market, side: d.side ?? null, team: d.selection_team ?? null,
    over_under: d.selection_over_under ?? null, side_is_home: d.side_is_home ?? null,
    integrity_status: d.integrity_status ?? null, integrity_reason: d.integrity_reason ?? null,
    integrity_warning: d.integrity_warning ?? null,
    market_line: d.market_line ?? null, market_price: d.market_price ?? null,
    evaluated_at: evaluatedAt, tape_captured_at: tapeAt,
  };
  if (d.integrity_status !== 'ELIGIBLE') {
    return { ...base, model_prob: null, model_line: null, market_prob: null, edge_pct: null };
  }
  const f = v => (Number.isFinite(Number(v)) ? Number(v) : null);
  return { ...base, model_prob: f(d.model_prob), model_line: f(d.model_line), market_prob: f(d.market_prob), edge_pct: f(d.edge_pct) };
}
const AT = { market: 'spread', tapeAt: '2026-09-12T12:01:29.852Z', evaluatedAt: '2026-09-12T16:55:09.000Z' };

const spreadQuote = (team, line, price, opp) => ({
  side: team, line, price, opposite_price: opp, selected_is_home: team === 'PIT', team, over_under: null,
});
const mlQuote = (team, price, opp) => ({
  side: team, price, opposite_price: opp, selected_is_home: team === 'PIT', team,
});

/* ------------------------------------------------------------------ 1, 2 */

test('evaluate() remains the ONLY model calculation authority', () => {
  /* The snapshot reshapes evaluate() output; it never computes a probability. */
  const block = ORCH.slice(ORCH.indexOf('function sanitizeEvaluation'), ORCH.indexOf('async function persistRun'));
  for (const forbidden of ['modelProbability(', 'logistic(', 'devigTwoWay(', 'spreadCoverProbability(', 'normalCdf(', 'probToAmerican(']) {
    assert.ok(!block.includes(forbidden), `sanitizer must not compute: ${forbidden}`);
  }
  /* The overlay renders; it must not model either. */
  for (const forbidden of ['modelProbability(', 'devigTwoWay(', 'no_vig_probability', 'consensus.no_vig']) {
    assert.ok(!OVERLAY.includes(forbidden), `overlay must not derive model value: ${forbidden}`);
  }
});

test('the KV snapshot is derived from the evaluate() outputs already computed', () => {
  /* Sides are captured from the same `evaluated` array the loop branches on. */
  assert.match(ORCH, /for \(const d of evaluated\) \{[\s\S]{0,200}sanitizeEvaluation\(d, \{ market, tapeAt, evaluatedAt: evaluatedAtIso \}\)/);
  /* Exactly one evaluate() call site in the orchestration loop. */
  assert.equal((ORCH.match(/quotes\.map\(quote =>\s*evaluate\(/g) || []).length, 1);
});

/* ------------------------------------------------------------------ 3, 4, 5 */

test('an ELIGIBLE spread evaluation carries a fair value', () => {
  const out = evaluate({ game: GAME, market: 'spread', quote: spreadQuote('PIT', -6, -110, -110), ratings: RATINGS, champion: CHAMPION, season: 2026, week: 1 });
  const row = sanitize(out, AT);
  assert.equal(row.integrity_status, 'ELIGIBLE');
  assert.ok(Number.isFinite(row.model_prob), 'model_prob present');
  assert.ok(Number.isFinite(row.model_line), 'fair spread present');
  assert.ok(Number.isFinite(row.edge_pct), 'edge present');
});

test('an ELIGIBLE moneyline evaluation carries a fair value', () => {
  const out = evaluate({ game: GAME, market: 'moneyline', quote: mlQuote('PIT', -240, 200), ratings: RATINGS, champion: CHAMPION, season: 2026, week: 1 });
  const row = sanitize(out, { ...AT, market: 'moneyline' });
  assert.equal(row.integrity_status, 'ELIGIBLE');
  assert.ok(Number.isFinite(row.model_prob));
  assert.ok(Number.isFinite(row.market_prob));
  assert.ok(Number.isFinite(row.edge_pct));
});

test('a market that does NOT qualify for issuance still carries a fair value', () => {
  /* A near-zero edge fails the issuance threshold but is still a valid model
   * evaluation — exactly the case that used to render as a permanent dash. */
  const out = evaluate({ game: GAME, market: 'spread', quote: spreadQuote('PIT', -6, -110, -110), ratings: RATINGS, champion: CHAMPION, season: 2026, week: 1 });
  const row = sanitize(out, AT);
  assert.equal(row.integrity_status, 'ELIGIBLE');
  assert.ok(Number.isFinite(row.model_prob), 'fair value present regardless of qualification');
  /* The overlay must not gate rendering on an issued card. */
  assert.ok(!OVERLAY.includes('if (!card || card.active === false)'), 'overlay must not require an issued card');
  assert.match(OVERLAY, /model_evaluations/);
});

/* ------------------------------------------------------------------ 6, 7, 8 */

test('MODEL_DISABLED totals never carry a fair value or model probability', () => {
  const out = evaluate({ game: GAME, market: 'total', quote: { side: 'Over 41', line: 41, price: -110, opposite_price: -110, over_under: 'over' }, ratings: RATINGS, champion: CHAMPION, season: 2026, week: 1 });
  const row = sanitize(out, { ...AT, market: 'total' });
  assert.equal(row.integrity_status, 'MODEL_DISABLED');
  assert.equal(row.integrity_reason, 'dedicated_total_model_required');
  assert.equal(row.model_prob, null);
  assert.equal(row.model_line, null);
  assert.equal(row.edge_pct, null);
  /* And it renders as an explanation, never a bare dash. */
  assert.match(OVERLAY, /MODEL DISABLED<\/b><small>Dedicated total model required/);
  assert.match(OVERLAY, /NOT MODELED/);
});

test('ANOMALY_REVIEW never exposes a normal fair value or edge', () => {
  const v1 = { ...CHAMPION, weights: { ...CHAMPION.weights, meta: { ...CHAMPION.weights.meta, integrity_version: 1 } } };
  const out = evaluate({ game: GAME, market: 'moneyline', quote: mlQuote('PIT', -240, 200), ratings: RATINGS, champion: v1, season: 2026, week: 1 });
  const row = sanitize(out, { ...AT, market: 'moneyline' });
  assert.equal(row.integrity_status, 'ANOMALY_REVIEW');
  assert.equal(row.model_prob, null);
  assert.equal(row.edge_pct, null);
  assert.match(OVERLAY, /QUARANTINED/);
  assert.ok(!/ANOMALY_REVIEW[\s\S]{0,200}pct\(modelProb\)/.test(OVERLAY));
});

test('INPUT_UNAVAILABLE never exposes a normal fair value', () => {
  const blind = new Map([['PIT', { status: 'unavailable' }], ['ATL', { status: 'unavailable' }]]);
  const out = evaluate({ game: GAME, market: 'spread', quote: spreadQuote('PIT', -6, -110, -110), ratings: blind, champion: CHAMPION, season: 2026, week: 1 });
  const row = sanitize(out, AT);
  assert.equal(row.integrity_status, 'INPUT_UNAVAILABLE');
  assert.equal(row.model_prob, null);
  assert.equal(row.edge_pct, null);
  assert.match(OVERLAY, /UNAVAILABLE<\/b><small>Model input missing/);
});

/* ------------------------------------------------------------------ 9-12 */

test('the PUBLIC PBE Card response carries no model_evaluations', () => {
  /* Attached inside currentView only, which is reached only after requirePro. */
  const current = PICKS_API.slice(PICKS_API.indexOf('async function currentView'), PICKS_API.indexOf('async function previewView'));
  const preview = PICKS_API.slice(PICKS_API.indexOf('async function previewView'));
  assert.match(current, /model_evaluations: evaluations/);
  assert.ok(!preview.includes('model_evaluations'), 'preview (public) must not attach model_evaluations');
  assert.equal((PICKS_API.match(/model_evaluations:/g) || []).length, 1);
});

test('the authenticated NFL Pro response does carry model_evaluations', () => {
  const current = PICKS_API.slice(PICKS_API.indexOf('async function currentView'), PICKS_API.indexOf('async function previewView'));
  assert.match(current, /const auth = await requirePro\(req, res\);/);
  assert.match(current, /const evaluations = await modelEvaluations\(\);/);
  /* requirePro precedes the attachment. */
  assert.ok(current.indexOf('requirePro') < current.indexOf('modelEvaluations()'));
});

test('a wrong or missing internal token cannot read evaluations', () => {
  assert.match(ORCH, /error: 'internal_token_not_configured'[\s\S]{0,40}503/);
  assert.match(ORCH, /presented \? 'invalid_internal_token' : 'missing_internal_token'/);
  assert.match(ORCH, /presented \? 403 : 401/);
  /* GET only. */
  assert.match(ORCH, /url\.pathname === '\/v1\/evaluations\/current'[\s\S]{0,200}req\.method !== 'GET'/);
});

test('the internal token never reaches the browser payload', () => {
  /* Read server-side from process.env and sent as a request header only. */
  assert.match(PICKS_API, /'x-pbe-internal-token': token/);
  /* It is never placed in a response body. */
  const fn = PICKS_API.slice(PICKS_API.indexOf('async function modelEvaluations'), PICKS_API.indexOf('async function currentView'));
  assert.ok(!/send\(res[\s\S]{0,200}token/.test(fn), 'token must never be sent to the client');
  /* And no client-side file references it. */
  assert.ok(!OVERLAY.includes('PICKS_INTERNAL_TOKEN'), 'client JS must not name the secret');
  assert.ok(!OVERLAY.includes('x-pbe-internal-token'), 'client JS must not present the header');
  /* Not committed to config either. */
  assert.doesNotMatch(TOML, /^\s*PICKS_INTERNAL_TOKEN\s*=/m);
});

/* ------------------------------------------------------------------ 13-16 */

test('the official Track Record remains official-only', () => {
  assert.match(PICKS_API, /publication_scope=eq\.\$\{OFFICIAL\}/);
  const overlayScope = OVERLAY.includes("ev?.trained === true ? 'OFFICIAL' : 'VALIDATION'");
  assert.ok(overlayScope, 'Best Line labels an untrained champion VALIDATION, never OFFICIAL');
});

test('an untrained champion labels the model layer VALIDATION, not OFFICIAL', () => {
  assert.equal(CHAMPION.weights.meta.trained, false);
  assert.match(OVERLAY, /const scope = ev\?\.trained === true \? 'OFFICIAL' : 'VALIDATION';/);
});

test('the snapshot never stores features, ratings or coefficients', () => {
  const block = ORCH.slice(ORCH.indexOf('function sanitizeEvaluation'), ORCH.indexOf('function finiteOrNull'));
  for (const forbidden of ['features', 'coef', 'weights', 'intercept', 'calib', 'ratings']) {
    assert.ok(!block.includes(forbidden), `snapshot must not carry ${forbidden}`);
  }
});

test('Best Line anonymous state says NFL PRO, never a bare dash', () => {
  assert.match(OVERLAY, /if \(pro\.pro !== true\) return 'locked';/);
  assert.match(OVERLAY, /locked'\)[\s\S]{0,200}NFL PRO<\/b><small>Model layer locked/);
  /* The old unconditional dash branch is gone. */
  assert.ok(!OVERLAY.includes("fair: '<span class=\"pbebl-na\">—</span>'"), 'bare-dash branch must be gone');
});

/* ------------------------------------------------------------------ 17 */

test('every acceptance matchup produces a renderable spread and moneyline state', () => {
  const MATCHUPS = [
    ['ATL', 'PIT'], ['BAL', 'IND'], ['BUF', 'HOU'], ['CHI', 'CAR'],
    ['TB', 'CIN'], ['CLE', 'JAX'], ['NO', 'DET'], ['ARI', 'LAC'],
  ];
  for (const [away, home] of MATCHUPS) {
    const game = { game_id: `2026_01_${away}_${home}`, home_team: home, away_team: away, kickoff_ts: '2026-09-13T17:00:00.000Z', rest_home: 7, rest_away: 7 };
    const ratings = new Map([
      [home, { status: 'ok', off_epa_play: 0.06, def_epa_play: -0.03, proe: 0.02, pace: 63, qb_tier: 2 }],
      [away, { status: 'ok', off_epa_play: -0.02, def_epa_play: 0.01, proe: -0.01, pace: 62, qb_tier: 3 }],
    ]);
    for (const [market, quote] of [
      ['spread', { side: home, line: -3, price: -110, opposite_price: -110, selected_is_home: true, team: home, over_under: null }],
      ['moneyline', { side: home, price: -160, opposite_price: 140, selected_is_home: true, team: home }],
    ]) {
      const row = sanitize(evaluate({ game, market, quote, ratings, champion: CHAMPION, season: 2026, week: 1 }), { ...AT, market });
      assert.ok(['ELIGIBLE', 'ANOMALY_REVIEW', 'INPUT_UNAVAILABLE'].includes(row.integrity_status),
        `${away}@${home} ${market} must have a renderable status, got ${row.integrity_status}`);
      if (row.integrity_status === 'ELIGIBLE') {
        assert.ok(Number.isFinite(row.model_prob), `${away}@${home} ${market} eligible => fair value`);
      } else {
        assert.equal(row.model_prob, null, `${away}@${home} ${market} non-eligible => no fair value`);
      }
    }
  }
});

/* ------------------------------------------------------------------ 18 */

test('game lookup uses a RAW id — CSS.escape would break every numeric id', () => {
  /* getElementById takes a raw id; CSS.escape is for selectors and escapes a
   * leading digit. Event ids are hex and usually start with one, so escaping
   * silently matched nothing and left every cell as the table's default dash.
   * This was the actual reason Best Line looked permanently blank. */
  assert.match(OVERLAY, /document\.getElementById\(`bl-\$\{String\(event\.id \|\| ''\)\}`\)/);
  assert.ok(!/getElementById\(`bl-\$\{CSS\.escape/.test(OVERLAY), 'must not CSS.escape a getElementById argument');

  /* Demonstrate the failure mode rather than asserting it abstractly. */
  const id = '95c01d1bb797d6df14824b106c5a9130';
  const escaped = id.replace(/^(\d)/, ch => String.fromCharCode(92) + '3' + ch + ' ');
  assert.notEqual(`bl-${escaped}`, `bl-${id}`, 'escaping a leading digit changes the id');
});
