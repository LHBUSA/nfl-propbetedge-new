/**
 * Matchup intelligence — the composition rules.
 *
 *   node --test tests/matchup-intel.test.mjs
 *
 * The assertions that matter are the ones about orientation and about absence:
 * a defensive metric must not be read as though lower were worse, and nothing
 * that is unknown may arrive as a zero.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT, STATE, LIMITED_SAMPLE_PLAYS, STRENGTH_PERCENTILE, WEAKNESS_PERCENTILE,
  ratingUsable, ratingLabel, priorWeight, metric, percentileOf, classify,
  collisions, orderAvailability, whatMattersMost, toFreePayload,
} from '../api/_matchup/intel-core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const rating = over => ({
  team: 'ATL', season: 2026, as_of_week: 2, status: 'ok',
  off_epa_play: 0.05, def_epa_play: -0.02, proe: 1.5, pace: 63,
  plays_sample: 130, games_sample: 2, ...over,
});

/* ------------------------------------------------------------ availability */

test('a rating is usable only when it is ok/prior_only AND carries real numbers', () => {
  assert.equal(ratingUsable(rating()).usable, true);
  assert.equal(ratingUsable(null).usable, false);
  assert.equal(ratingUsable(null).reason, 'no_rating_row');
  assert.equal(ratingUsable(rating({ status: 'unavailable' })).usable, false);
  assert.equal(ratingUsable(rating({ status: 'stale' })).usable, false);
  /* The case the whole rule exists for: a present row with a null metric. */
  assert.equal(ratingUsable(rating({ off_epa_play: null })).usable, false);
  assert.match(ratingUsable(rating({ off_epa_play: null })).reason, /missing_metric/);
  assert.equal(ratingUsable(rating({ def_epa_play: '' })).usable, false);
  /* A genuine 0.0 is a real value and must stay usable. */
  assert.equal(ratingUsable(rating({ off_epa_play: 0 })).usable, true);
});

test('prior_only is labelled a prior-season baseline, never as current', () => {
  const label = ratingLabel(rating({ status: 'prior_only' }), 2);
  assert.equal(label.state, STATE.PRIOR_BASELINE);
  assert.match(label.label, /PRIOR-SEASON BASELINE/);
  assert.equal(label.prior_weight, 1);
  assert.match(label.note, /not 2026 form/);
});

test('an early-season blend says how much prior weight it still carries', () => {
  const label = ratingLabel(rating(), 2);
  assert.equal(label.state, STATE.OK);
  assert.match(label.label, /PRIOR BASELINE/);
  assert.ok(label.prior_weight > 0);
  assert.match(label.note, /prior season still carries/);
});

test('from week 8 the rating is fully current', () => {
  const label = ratingLabel(rating({ as_of_week: 9 }), 9);
  assert.equal(label.prior_weight, 0);
  assert.match(label.label, /CURRENT/);
  assert.equal(label.note, undefined);
});

test('an unusable rating is labelled unavailable, not league average', () => {
  const label = ratingLabel(null, 3);
  assert.equal(label.state, STATE.UNAVAILABLE);
  assert.match(label.label, /UNAVAILABLE/);
  assert.equal(label.prior_weight, null);
});

test('the prior-season weight follows the engine formula and fades at week 8', () => {
  assert.equal(priorWeight(1), 0.5);
  assert.ok(priorWeight(2) > priorWeight(4));
  assert.equal(priorWeight(8), 0);
  assert.equal(priorWeight(12), 0);
  assert.equal(priorWeight(null), null, 'an unknown week is unknown, not zero');
});

/* ----------------------------------------------------------------- metrics */

test('a metric with no value is UNAVAILABLE and never zero', () => {
  for (const v of [null, undefined, '']) {
    const m = metric(v, { plays: 200 });
    assert.equal(m.value, null);
    assert.equal(m.state, STATE.UNAVAILABLE);
  }
  const real = metric(0, { plays: 200 });
  assert.equal(real.value, 0, 'a genuine zero survives');
  assert.equal(real.state, STATE.OK);
});

test('a split under the play floor is LIMITED SAMPLE, and says so', () => {
  const small = metric(0.14, { plays: 37 });
  assert.equal(small.state, STATE.LIMITED_SAMPLE);
  assert.equal(small.limited, true);
  assert.equal(small.plays, 37);
  const big = metric(0.14, { plays: LIMITED_SAMPLE_PLAYS });
  assert.equal(big.state, STATE.OK);
  assert.equal(big.limited, false);
});

test('percentile orientation: low EPA allowed is the BEST defence', () => {
  const allowed = [-0.20, -0.10, 0.00, 0.10, 0.20];
  /* The stingiest defence in the pool must come out near the top. */
  assert.ok(percentileOf(-0.20, allowed, 'low') >= 80, 'best defence is a high percentile');
  assert.ok(percentileOf(0.20, allowed, 'low') <= 20, 'worst defence is a low percentile');
  /* Offence runs the other way. */
  assert.ok(percentileOf(0.20, allowed, 'high') >= 80);
  assert.ok(percentileOf(-0.20, allowed, 'high') <= 20);
});

test('a percentile needs a real value and a real pool', () => {
  assert.equal(percentileOf(null, [1, 2, 3, 4]), null);
  assert.equal(percentileOf(0.1, [1, 2]), null, 'too small a pool is no answer');
  assert.equal(percentileOf(0.1, []), null);
});

test('classification thresholds are the documented constants', () => {
  assert.equal(classify(STRENGTH_PERCENTILE).band, 'STRENGTH');
  assert.equal(classify(95).band, 'STRENGTH');
  assert.equal(classify(WEAKNESS_PERCENTILE).band, 'WEAKNESS');
  assert.equal(classify(5).band, 'WEAKNESS');
  assert.equal(classify(50).band, 'NEUTRAL');
  assert.equal(classify(null).band, STATE.UNAVAILABLE);
});

/* -------------------------------------------------------------- collisions */

const dim = (percentile, plays = 90, state = STATE.OK) => ({ percentile, plays, state, limited: plays < LIMITED_SAMPLE_PLAYS });

test('a collision fires only when a strength meets a weakness in the same dimension', () => {
  const out = collisions({
    offense: { pass: dim(82), rush: dim(50), explosive: dim(60) },
    defense: { pass: dim(18), rush: dim(55), explosive: dim(70) },
    offenseTeam: 'CAR', defenseTeam: 'ATL',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].dimension, 'pass');
  assert.equal(out[0].offense_team, 'CAR');
  assert.equal(out[0].defense_team, 'ATL');
  assert.match(out[0].statement, /CAR pass offense ranks 82nd/);
  assert.match(out[0].statement, /ATL pass defense allows at the 18th/);
  /* Descriptive only — never a claim about the result. */
  assert.equal(/will |dominat|lock|guarantee/i.test(out[0].statement), false);
});

test('an unavailable side produces no collision at all', () => {
  const out = collisions({
    offense: { pass: dim(90) },
    defense: { pass: { percentile: null, state: STATE.UNAVAILABLE } },
    offenseTeam: 'CAR', defenseTeam: 'ATL',
  });
  assert.deepEqual(out, [], 'a collision with an unknown is not a finding');
});

test('a collision built on small samples is flagged, not hidden', () => {
  const out = collisions({
    offense: { pass: dim(88, 30) }, defense: { pass: dim(12, 28) },
    offenseTeam: 'CAR', defenseTeam: 'ATL',
  });
  assert.equal(out[0].limited, true);
  assert.equal(out[0].offense_plays, 30);
});

/* ------------------------------------------------------------ availability */

test('availability orders by designation severity, and a missing report is not health', () => {
  const rows = orderAvailability([
    { player: { name: 'Q Player', position: 'WR' }, status: 'Questionable' },
    { player: { name: 'O Player', position: 'CB' }, status: 'Out' },
    { player: { name: 'D Player', position: 'TE' }, status: 'Doubtful' },
    { player: { name: 'No status' } },
  ]);
  assert.deepEqual(rows.map(r => r.status), ['OUT', 'DOUBTFUL', 'QUESTIONABLE']);
  assert.equal(rows.length, 3, 'a row with no designation is not invented into one');
  assert.deepEqual(orderAvailability([]), [], 'an empty board is empty, never "healthy"');
  assert.deepEqual(orderAvailability(null), []);
});

/* -------------------------------------------------------------- statements */

test('every "what matters most" line traces to a state that is displayed', () => {
  const lines = whatMattersMost({
    away: { team: 'CAR', rating: { state: STATE.PRIOR_BASELINE }, availability: [{ status: 'OUT' }] },
    home: { team: 'ATL', rating: { state: STATE.OK, prior_weight: 0.28 }, availability: [] },
    pressurePoints: [{ statement: 'CAR pass offense ranks 82nd percentile; ATL pass defense allows at the 18th percentile.', limited: false }],
    market: { state: STATE.OK },
  });
  const text = lines.map(l => l.text).join(' | ');
  assert.match(text, /82nd percentile/);
  assert.match(text, /prior-season baseline/);
  assert.match(text, /28% prior-season weight/);
  assert.match(text, /1 player ruled out/);
  assert.ok(lines.length <= 6);
  assert.equal(/will win|lock|guarantee|dominate/i.test(text), false, 'no claim the metrics do not support');
});

test('no market produces a stated line rather than a silent gap', () => {
  const lines = whatMattersMost({ away: null, home: null, pressurePoints: [], market: { state: STATE.NO_MARKET } });
  assert.match(lines.map(l => l.text).join(' '), /No current market snapshot/);
});

/* ---------------------------------------------------------------- free/pro */

test('the free payload has Pro values removed, not hidden', () => {
  const full = {
    model: { state: 'OK', rows: [{ fair_line: 245.5, market_consensus_line: 239.5 }] },
    role: { state: 'OK', players: [{ snap_share: 0.82 }] },
    red_zone: { state: 'OK', trips: 7 },
    pressure_points: [{ dimension: 'pass', offense_plays: 84, defense_plays: 79, statement: 'x' }],
  };
  const free = toFreePayload(full);
  const text = JSON.stringify(free);
  assert.equal(text.includes('245.5'), false, 'a fair value must not reach a free browser');
  assert.equal(text.includes('0.82'), false);
  assert.equal(free.model.state, 'PRO_REQUIRED');
  assert.equal(free.role.state, 'PRO_REQUIRED');
  assert.equal(free.red_zone.state, 'PRO_REQUIRED');
  assert.equal(free.entitlement.pro, false);
  /* The free page still gets the matchup advantage itself — it is football, not a price. */
  assert.equal(free.pressure_points[0].statement, 'x');
  assert.equal('offense_plays' in free.pressure_points[0], false);
  /* and the original is untouched */
  assert.equal(full.model.rows[0].fair_line, 245.5);
});

/* --------------------------------------------------- the endpoint contract */

test('no hardcoded event id survives anywhere in the matchup path', () => {
  const FIXTURE = '8c94552d022acec4a0458d70c19d3da9';
  for (const file of ['api/matchup-intel.js', 'api/_matchup/intel-core.js', 'matchups-v3.js']) {
    const source = readFileSync(join(REPO, file), 'utf8');
    assert.equal(source.includes(FIXTURE), false, `${file} must not carry the QA fixture id`);
  }
  const page = readFileSync(join(REPO, 'matchups-v3.js'), 'utf8');
  assert.equal(/DEFAULT_EVENT\s*=/.test(page), false, 'no default-event constant');
  assert.match(page, /\|\| ''/, 'with no event the server resolves the slate');
});

test('the page makes one authoritative request, not a waterfall', () => {
  const page = readFileSync(join(REPO, 'matchups-v3.js'), 'utf8');
  const fetches = page.match(/fetch\(/g) || [];
  assert.equal(fetches.length, 1, `expected one fetch, saw ${fetches.length}`);
  assert.match(page, /\/api\/matchup-intel/);
});

test('the page no longer counts injury-shaped headlines', () => {
  const page = readFileSync(join(REPO, 'matchups-v3.js'), 'utf8');
  /* Comments are stripped first: the header deliberately QUOTES v2's
     "current injury stories" to record what was removed and why, and that
     documentation must not trip the check on the code. */
  const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/injuryCount/.test(code), false, 'no injury-story counter');
  assert.equal(/injury stories/i.test(code), false);
  assert.match(code, /AVAILABILITY WATCH/);
});

test('2025 is not the centerpiece: the hero leads with the current game', () => {
  const page = readFileSync(join(REPO, 'matchups-v3.js'), 'utf8');
  assert.equal(/2025 Final Context/.test(page), false);
  const heroAt = page.indexOf('function hero');
  const formAt = page.indexOf('CURRENT FORM');
  assert.ok(heroAt > 0 && formAt > heroAt, 'current form follows the hero');
});

test('advantage and edge are kept apart in the payload and in the copy', () => {
  const core = readFileSync(join(REPO, 'api', '_matchup', 'intel-core.js'), 'utf8');
  assert.match(core, /MATCHUP ADVANTAGE/);
  assert.match(core, /PBE EDGE/);
  const endpoint = readFileSync(join(REPO, 'api', 'matchup-intel.js'), 'utf8');
  /* pressure_points (advantage) and model (edge) are separate top-level keys. */
  assert.match(endpoint, /pressure_points:/);
  assert.match(endpoint, /model: \{/);
  const page = readFileSync(join(REPO, 'matchups-v3.js'), 'utf8');
  assert.match(page, /MATCHUP ADVANTAGE · NOT A PRICE/);
  assert.match(page, /PBE EDGE · MODEL vs MARKET/);
});

test('the contract is versioned and the thresholds are published', () => {
  assert.equal(CONTRACT, 'matchup-intel/v1');
  const endpoint = readFileSync(join(REPO, 'api', 'matchup-intel.js'), 'utf8');
  assert.match(endpoint, /thresholds:/, 'the page can show how it classified');
});

test('the collision engine fires on the dimension that is actually sourced', async () => {
  const { COLLISION_DIMENSIONS } = await import('../api/_matchup/intel-core.js');
  assert.ok(COLLISION_DIMENSIONS.includes('overall'),
    'the aggregate rating is the only dimension sourced today; if the engine does '
    + 'not iterate it, the centrepiece section is empty for every game forever');

  /* The real PHI @ TEN shape from production: a top-quartile defence meeting a
     bottom-quartile offence, which must produce a pressure point. */
  const out = collisions({
    offense: { overall: { percentile: 81, plays: 140, state: STATE.OK, limited: false } },
    defense: { overall: { percentile: 16, plays: 132, state: STATE.OK, limited: false } },
    offenseTeam: 'PHI', defenseTeam: 'TEN',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].dimension, 'overall');
  assert.match(out[0].statement, /PHI overall offense ranks 81st percentile/);
  assert.match(out[0].statement, /TEN overall defense allows at the 16th percentile/);
  /* 'overall' must read as overall, never as a pass or rush split we do not have. */
  assert.equal(/pass |rush /.test(out[0].statement), false);
});

test('a team profile classifies each dimension independently of the collision', () => {
  /* The collision needs BOTH sides to qualify and is deliberately strict — on
     the week-2 slate measured in production, none of eight games cleared it.
     The profile is what carries the page: it says what each team IS, from the
     same thresholds, and it fires on one side alone. */
  const side = {
    form: {
      offence: { percentile: 97, plays: 130, state: STATE.OK, limited: false },
      defence: { percentile: 6, plays: 130, state: STATE.OK, limited: false },
      proe: { percentile: 50, plays: 130, state: STATE.OK, limited: false },
      pace: { percentile: null, state: STATE.UNAVAILABLE },
    },
  };
  const bands = ['offence', 'defence', 'proe', 'pace']
    .map(k => [k, classify(side.form[k].percentile).band]);
  assert.deepEqual(bands, [
    ['offence', 'STRENGTH'], ['defence', 'WEAKNESS'],
    ['proe', 'NEUTRAL'], ['pace', STATE.UNAVAILABLE],
  ]);
});

test('the page renders the profile above the collision', () => {
  const page = readFileSync(join(REPO, 'matchups-v3.js'), 'utf8');
  assert.match(page, /STRENGTHS &amp; WEAKNESSES/);
  assert.ok(page.indexOf('profilePanel(p)}') < page.indexOf('pressurePanel(p)}'),
    'what each team is comes before where they collide');
  const api = readFileSync(join(REPO, 'api', 'matchup-intel.js'), 'utf8');
  assert.match(api, /profile: \{ away:/);
});

/* ============================================================ the 2026 lab */

import { existsSync } from 'node:fs';
const LAB_PATH = join(REPO, 'data', 'dist', 'matchup-2026.json');
const LAB = existsSync(LAB_PATH) ? JSON.parse(readFileSync(LAB_PATH, 'utf8')) : null;
const lab = (name, fn) => test(name, { skip: LAB ? false : 'matchup-2026.json not built' }, fn);

lab('splits are computed from play-by-play, never from the aggregate rating', () => {
  const build = readFileSync(join(REPO, 'scripts', 'build-matchup-2026.mjs'), 'utf8');
  assert.match(build, /play_by_play_\$\{SEASON\}\.csv\.gz/);
  /* Comments stripped: the header names nfl_team_ratings to say these are the
     same nflverse releases the picks engine streams. The CODE must not read it. */
  const code = build.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/nfl_team_ratings/.test(code), false,
    'the split builder must not read the aggregate rating at all');
  /* and a pass split really is a different number from the rush split */
  const team = Object.values(LAB.teams)[0];
  assert.notEqual(team.offence.pass.epa_per_play, team.offence.rush.epa_per_play);
});

lab('every split carries its own play sample, and the floor is applied per split', () => {
  for (const [abbr, t] of Object.entries(LAB.teams)) {
    for (const side of ['offence', 'defence']) {
      for (const k of ['pass', 'rush', 'all']) {
        const s = t[side][k];
        assert.equal(typeof s.plays, 'number', `${abbr} ${side}.${k}`);
        assert.equal(s.limited, s.plays < 50, `${abbr} ${side}.${k} limited flag must follow its own sample`);
        if (s.plays === 0) assert.equal(s.epa_per_play, null, 'no plays is not 0.0 EPA');
      }
    }
    /* pass + rush must account for every offensive play counted */
    assert.equal(t.offence.pass.plays + t.offence.rush.plays, t.offence.all.plays, `${abbr} offence split total`);
    assert.equal(t.defence.pass.plays + t.defence.rush.plays, t.defence.all.plays, `${abbr} defence split total`);
  }
});

lab('explosive rate uses the documented definition and is a rate, not a count', () => {
  assert.equal(LAB.meta.definitions.explosive_play, 'yards_gained >= 20');
  for (const t of Object.values(LAB.teams)) {
    for (const side of ['offence', 'defence']) {
      const s = t[side].all;
      if (!s.plays) continue;
      assert.ok(s.explosive_rate >= 0 && s.explosive_rate <= 1, 'a rate is between 0 and 1');
      assert.equal(s.explosive_rate, Math.round((s.explosive_plays / s.plays) * 1e4) / 1e4);
    }
  }
});

lab('role rows resolve on a strong id and never on a name', () => {
  const build = readFileSync(join(REPO, 'scripts', 'build-matchup-2026.mjs'), 'utf8');
  assert.match(build, /roster_weekly/, 'the crosswalk is the hub');
  assert.match(LAB.meta.identity, /Names are never joined/i);
  assert.equal(LAB.meta.counts.players_dropped_no_strong_id >= 0, true);
  for (const [gsis, p] of Object.entries(LAB.players)) {
    assert.match(gsis, /^00-\d{7}$/, `${gsis} is not a GSIS id`);
    assert.equal(p.gsis_id, gsis);
    assert.ok(p.team, 'every role row names a team');
    for (const share of ['target_share', 'carry_share']) {
      if (p[share] !== null) assert.ok(p[share] >= 0 && p[share] <= 1, `${p.name} ${share}`);
    }
  }
});

lab('a week-over-week delta appears only when two real weeks exist', () => {
  for (const p of Object.values(LAB.players)) {
    if (p.week_over_week_state === 'ONE_WEEK_ONLY') {
      assert.equal(p.week_over_week, null, `${p.name} must not carry a delta from one week`);
    } else {
      assert.equal(p.week_over_week_state, 'OK');
      assert.ok(p.week_over_week.to_week > p.week_over_week.from_week, 'a delta runs forward');
    }
  }
});

lab('red zone uses the documented field and never invents a conversion', () => {
  assert.equal(LAB.meta.definitions.red_zone, 'yardline_100 <= 20');
  for (const [abbr, t] of Object.entries(LAB.teams)) {
    const z = t.red_zone;
    assert.ok(z.touchdowns <= z.trips || z.trips === 0, `${abbr}: more TDs than trips`);
    if (z.trips === 0) assert.equal(z.touchdown_rate, null, 'no trips is not a 0% rate');
    assert.ok(z.carries_inside_20 >= 0 && z.targets_inside_20 >= 0);
  }
});

lab('nothing unlicensed is computed', () => {
  assert.deepEqual(LAB.meta.not_included, ['routes run', 'pressure rate', 'blitz rate', 'coverage shell']);
  const text = JSON.stringify(LAB).toLowerCase();
  for (const forbidden of ['routes_run', 'pressure_rate', 'blitz_rate', 'coverage_shell']) {
    assert.equal(text.includes(forbidden), false, `${forbidden} must not appear`);
  }
});

lab('the collision engine can now fire on a real split dimension', () => {
  /* Measured live: CHI explosive offence 97th percentile against a Minnesota
     explosive defence at the 6th. The engine must classify that. */
  const out = collisions({
    offense: { explosive: { percentile: 97, plays: 70, state: STATE.OK, limited: false } },
    defense: { explosive: { percentile: 6, plays: 66, state: STATE.OK, limited: false } },
    offenseTeam: 'CHI', defenseTeam: 'MIN',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].dimension, 'explosive');
  assert.match(out[0].statement, /CHI explosive-play offense ranks 97th percentile/);
  assert.match(out[0].statement, /MIN explosive-play defense allows at the 6th percentile/);
});

lab('the endpoint reads the lab artifact rather than recomputing it per request', () => {
  const api = readFileSync(join(REPO, 'api', 'matchup-intel.js'), 'utf8');
  assert.match(api, /matchup-2026\.json/);
  assert.equal(/nflverse-data\/releases/.test(api), false, 'no per-request harvest');
  assert.match(api, /splitsFor/);
  assert.match(api, /roleFor/);
});

/* ---------------------------------------------------- US spelling guard */

/* This is a US football product: the page says OFFENSE and DEFENSE.
 *
 * Internal identifiers are deliberately out of scope — the artifact's `offence`
 * key, `const offence = metric(...)`, the `which === 'offence'` dispatch and
 * `off_epa_play` never reach a screen, and renaming them would be churn with no
 * reader-visible effect.
 *
 * The rule this encodes: the British spelling is COPY when it sits inside a
 * string or in the literal text of a template, and an IDENTIFIER everywhere
 * else. So the check reads the strings rather than trying to subtract every
 * shape an identifier can take — which is also how an aria-label, a title or a
 * generated sentence would leak, since all three are strings.
 */
function visibleStrings(code) {
  const out = [];
  /* Single and double quoted literals. */
  for (const m of code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)) {
    out.push(m[1] ?? m[2] ?? '');
  }
  /* Template literals, with every ${...} expression blanked so a property read
     inside an interpolation is not mistaken for copy. */
  for (const m of code.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
    out.push(m[1].replace(/\$\{[^}]*\}/g, ' '));
  }
  return out;
}

/** The strings from one source that a reader could actually see. */
function copyOf(code) {
  return visibleStrings(code)
    /* A bare key passed as a string argument is an identifier, not copy. */
    .filter(s => !/^(offence|defence)$/.test(s.trim()))
    .filter(s => /offence|defence/i.test(s));
}

test('no user-visible copy ships the British spelling', () => {
  const files = ['matchups-v3.js', 'api/matchup-intel.js', 'api/_matchup/intel-core.js'];
  const offenders = [];
  for (const rel of files) {
    const text = readFileSync(join(REPO, ...rel.split('/')), 'utf8');
    /* Comments are prose for maintainers, not product copy. */
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const s of copyOf(code)) offenders.push(`${rel}: ${JSON.stringify(s)}`);
  }
  assert.deepEqual(offenders, [], `user-visible British spelling found:\n${offenders.join('\n')}`);
});

test('the spelling guard actually catches a leak', () => {
  /* A guard that cannot fail is not a guard: every shape that reaches a reader
     — a label, a template, an aria-label, a title — must be caught. */
  for (const leak of [
    "const label = 'Pass offence';",
    'const t = `${team} pass offence ranks first`;',
    "el.setAttribute('aria-label', 'Rush defence allowed');",
    'const h = \'<b title="Pass offence">x</b>\';',
  ]) {
    assert.ok(copyOf(leak).length > 0, `guard missed: ${leak}`);
  }
  /* and must not fire on an identifier or an interpolated property read */
  for (const ok of [
    'const offence = metric(x);',
    'const t = `${sp.offence?.pass} plays`;',
    "const d = which === 'offence' ? a : b;",
    'push(out.offPass, row.offence?.pass?.epa_per_play);',
  ]) {
    assert.deepEqual(copyOf(ok), [], `guard false-positived on: ${ok}`);
  }
});

test('the collision sentence is generated in US spelling', () => {
  const out = collisions({
    offense: { pass: { percentile: 82, plays: 200, state: STATE.OK, limited: false } },
    defense: { pass: { percentile: 18, plays: 200, state: STATE.OK, limited: false } },
    offenseTeam: 'CAR', defenseTeam: 'ATL',
  });
  assert.equal(/offence|defence/i.test(out[0].statement), false, out[0].statement);
  assert.match(out[0].statement, /offense ranks/);
  assert.match(out[0].statement, /defense allows/);
});
