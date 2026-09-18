/**
 * The rights boundary, proven.
 *
 * The D3 audit is a document. These are the parts of it that a future engineer
 * cannot get wrong by accident, because the build fails instead.
 *
 * Three boundaries are tested, and they are not the same boundary:
 *
 *   INGESTION   a prohibited value must never be written. Not hidden — absent.
 *   READ        a restricted row must not reach a surface that may not see it,
 *               whatever query is written, because the filter is in the database.
 *   MODEL       a lane can be readable and still be unusable for a given model.
 *               A clean licence is not a clean sample.
 *
 *   node --test history/tests/rights-lanes.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import { registrySql, lanePolicySql, REGISTRY_FILE, LANES_FILE } from '../deploy/seed.mjs';
import { CHECKS, runChecks } from '../deploy/checks.mjs';
import {
  effectiveSurfaces, surfaceAllows, compositionSurfaces, compositionVisible,
  modelUseAllowed, assertModelUse, samplingBiases, laneIngestAllowed,
  RightsRefusal, loadPolicy,
} from '../lib/rights.mjs';
import {
  classifyEndpoint, isEndpointAllowed, sanitise, extractCrosswalk, assertClean,
  deniedFieldsFor, RefusedEndpoint, ProhibitedField, loadCfbdPolicy,
} from '../lib/cfbd-policy.mjs';
import {
  createCfbdAdapter, processPayload, AdapterDisabled, isEnabled, normalise,
} from '../ingest/cfbd-adapter.mjs';
import {
  composeCollegePipeline, assertContract, ContractViolation,
  COLLEGE_PIPELINE_SQL, COLLEGE_TRANSITION_SQL, FIELDS,
} from '../api/college-pipeline.mjs';
import { matchDecision } from '../lib/identity.mjs';
import { createHistoryApi } from '../api/history-api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const MIGRATIONS = join(REPO, 'history', 'deploy', 'migrations');
const REGISTRY_DIR = join(REPO, 'history', 'registry');

/* ==================================================================== 1-6
   Lane classification and the refusals. The whole reason a lane exists is that
   "can we use CFBD" was the wrong question: games and plays came through the
   same contract and do not carry the same rights. */

test('1. the games lane is classified independently of the plays lane', () => {
  assert.equal(classifyEndpoint('/games'), 'games');
  assert.equal(classifyEndpoint('/plays'), 'plays');
  assert.notEqual(classifyEndpoint('/games'), classifyEndpoint('/plays'));

  // and they resolve to different surfaces, which is the point of the split
  assert.deepEqual(effectiveSurfaces('src_cfbd', 'games'), ['public', 'pro', 'internal']);
  assert.deepEqual(effectiveSurfaces('src_cfbd', 'plays'), ['internal']);

  // query strings and absolute URLs normalise to the same classification
  assert.equal(classifyEndpoint('https://api.collegefootballdata.com/games?year=2023'), 'games');

  // an endpoint nobody classified is refused rather than inheriting a neighbour's rights
  assert.throws(() => classifyEndpoint('/games/brand-new-thing'),
    e => e instanceof RefusedEndpoint && /not classified/.test(e.message));
});

test('2. recruiting is refused at the endpoint and at the field', () => {
  for (const path of ['/recruiting/players', '/recruiting/teams', '/recruiting/groups', '/recruiting/anything-new']) {
    assert.throws(() => classifyEndpoint(path), e => e instanceof RefusedEndpoint && e.lane === 'recruiting', path);
    assert.equal(isEndpointAllowed(path), false);
  }
  assert.equal(laneIngestAllowed('src_cfbd', 'recruiting'), false);
  assert.deepEqual(effectiveSurfaces('src_cfbd', 'recruiting'), []);
  assert.equal(modelUseAllowed('src_cfbd', 'recruiting', 'anything'), false);
});

test('3. talent ratings are refused — CFBD names 247Sports itself', () => {
  assert.throws(() => classifyEndpoint('/talent'), e => e instanceof RefusedEndpoint && e.lane === 'talent');
  assert.equal(laneIngestAllowed('src_cfbd', 'talent'), false);
  // and the field is denied wherever it appears, not only on that endpoint
  const { value, stripped } = sanitise([{ team: 'Georgia', talent: 987.1 }], 'games');
  assert.deepEqual(value, [{ team: 'Georgia' }]);
  assert.equal(stripped[0].field, 'talent');
});

test('4. FPI is refused', () => {
  assert.throws(() => classifyEndpoint('/ratings/fpi'), e => e instanceof RefusedEndpoint && e.lane === 'fpi');
  assert.equal(laneIngestAllowed('src_cfbd', 'fpi'), false);
  const { stripped } = sanitise([{ team: 'Ohio State', fpi: 22.4 }], 'games');
  assert.equal(stripped.length, 1);
});

test('5. SP+ is refused, and is not in the lane of CFBD-authored models', () => {
  assert.throws(() => classifyEndpoint('/ratings/sp'), e => e instanceof RefusedEndpoint && e.lane === 'sp_plus');
  assert.throws(() => classifyEndpoint('/ratings/sp/conferences'), e => e instanceof RefusedEndpoint);
  // Elo and SRS ARE CFBD's own, and stay usable. The distinction is the finding.
  assert.equal(classifyEndpoint('/ratings/elo'), 'cfbd_models');
  assert.equal(classifyEndpoint('/ratings/srs'), 'cfbd_models');
  assert.equal(laneIngestAllowed('src_cfbd', 'cfbd_models'), true);
  assert.equal(laneIngestAllowed('src_cfbd', 'sp_plus'), false);
});

test('6. betting lines are refused, including the records derived from them', () => {
  assert.throws(() => classifyEndpoint('/lines'), e => e instanceof RefusedEndpoint && e.lane === 'betting_lines');
  assert.throws(() => classifyEndpoint('/teams/ats'), e => e instanceof RefusedEndpoint && e.lane === 'betting_lines');
  const { value, stripped } = sanitise([{ id: 1, spread: -7.5, overUnder: 54.5, homeMoneyline: -280 }], 'games');
  assert.deepEqual(value, [{ id: 1 }]);
  assert.deepEqual(stripped.map(s => s.field).sort(), ['homeMoneyline', 'overUnder', 'spread']);
});

/* ==================================================================== 7-8
   Prohibited fields arrive INSIDE payloads we do want. They leave at the
   boundary, or we are holding them. */

test('7. the pre-draft evaluation fields are stripped before persistence, and refused if they survive', () => {
  const payload = [{
    year: 2024, round: 1, pick: 1, overall: 1, name: 'A Player', position: 'QB',
    collegeTeam: 'Southern California', nflTeam: 'Chicago Bears',
    preDraftGrade: 95, preDraftRanking: 1, preDraftPositionRanking: 1,
    collegeAthleteId: 4432577, nflAthleteId: 4432577,
  }];
  const out = processPayload({ path: '/draft/picks', records: payload, retrievedAt: '2026-09-18T00:00:00Z' });

  const [row] = out.records;
  for (const forbidden of ['preDraftGrade', 'preDraftRanking', 'preDraftPositionRanking']) {
    assert.equal(forbidden in row, false, `${forbidden} must not survive`);
  }
  assert.equal(row.name, 'A Player');
  assert.equal(row.round, 1);

  // and the refusal is provable independently of the strip having been called
  assert.throws(() => assertClean([{ preDraftGrade: 95 }], 'draft_picks'),
    e => e instanceof ProhibitedField && /preDraftGrade/.test(e.message));

  // The allowlist on this lane removes it before the denylist ever sees it, so
  // the refusal is recorded under whichever gate caught it. Both are recorded,
  // because "we never decided to keep this" and "we decided we may not" are
  // different facts about the same absent field.
  assert.ok(out.snapshot.retention.refused_fields.includes('preDraftGrade'));
  assert.ok(out.dropped_by_allowlist.includes('preDraftGrade'));
  // and on a lane with no allowlist, the denylist is what catches it
  const viaDenylist = processPayload({ path: '/roster', records: [{ id: 1, talent: 900 }], retrievedAt: '2026-09-18T00:00:00Z' });
  assert.ok(viaDenylist.snapshot.retention.stripped_fields.includes('talent'));
  assert.equal(out.snapshot.retention.prohibited_values_retained, false);
  assert.equal(JSON.stringify(out.snapshot).includes('95'), false, 'a stripped value must not survive in the snapshot metadata');
});

test('8. transfer portal stars and ratings are stripped; the movement fact survives', () => {
  const payload = [{
    season: 2025, firstName: 'A', lastName: 'Player', position: 'WR',
    origin: 'Team One', destination: 'Team Two', transferDate: '2025-01-05T00:00:00Z',
    eligibility: 'Immediate', rating: 0.9412, stars: 4,
  }];
  const out = processPayload({ path: '/player/portal', records: payload, retrievedAt: '2026-09-18T00:00:00Z' });
  const [row] = out.records;

  assert.equal('rating' in row, false);
  assert.equal('stars' in row, false);
  assert.equal(row.origin, 'Team One');
  assert.equal(row.destination, 'Team Two');
  assert.equal(row.transferDate, '2025-01-05T00:00:00Z');

  assert.throws(() => assertClean([{ stars: 4 }], 'transfer_portal_movement'), ProhibitedField);

  // 'rating' is only prohibited where it means a recruiting composite. It is not
  // a banned word: the denial is conditional on the lane, and that is deliberate.
  assert.equal(deniedFieldsFor('transfer_portal_movement').has('rating'), true);
  assert.equal(deniedFieldsFor('cfbd_models').has('rating'), false);
});

/* ==================================================================== 9
   The crosswalk is the most valuable thing CFBD holds for this product and the
   one we are most clearly barred from surfacing. */

test('9. crosswalk identifiers are lifted to an internal-only lane and cannot reach a surfaced row', () => {
  const { value, identifiers } = extractCrosswalk(
    [{ name: 'A Player', collegeAthleteId: 111, nflAthleteId: 222 }], 'draft_picks');
  assert.deepEqual(value, [{ name: 'A Player' }]);
  assert.deepEqual(identifiers.map(i => i.field).sort(), ['collegeAthleteId', 'nflAthleteId']);
  for (const i of identifiers) assert.equal(i.lane, 'identifier_crosswalk');

  // a row that still carries one is refused before it can be written
  assert.throws(() => assertClean([{ name: 'A Player', nflAthleteId: 222 }], 'draft_picks'),
    e => e instanceof ProhibitedField && /identifier_crosswalk/.test(e.message));

  // and the lane itself reaches no surface but internal, on every axis
  assert.deepEqual(effectiveSurfaces('src_cfbd', 'identifier_crosswalk'), ['internal']);
  assert.equal(surfaceAllows('public', 'src_cfbd', 'identifier_crosswalk'), false);
  assert.equal(surfaceAllows('pro', 'src_cfbd', 'identifier_crosswalk'), false);

  // the public college contract refuses an id-shaped key by name, whatever it is called
  assert.throws(() => assertContract({ player_id: 'gpl_1', espn_athlete_id: 222 }), ContractViolation);
});

/* ==================================================================== 13-15, 18
   The library rules, tested without a database so the pipeline obeys them too. */

test('13. a source that requires lanes fails closed when a snapshot names none, or names one we never decided', () => {
  assert.deepEqual(effectiveSurfaces('src_cfbd', null), [], 'no lane on a lane-requiring source: nothing');
  assert.deepEqual(effectiveSurfaces('src_cfbd', 'a_lane_nobody_decided'), [], 'undecided lane: nothing');
  assert.deepEqual(effectiveSurfaces('src_not_a_source', 'games'), [], 'unknown source: nothing');
  assert.equal(modelUseAllowed('src_cfbd', null, 'anything'), false);
  assert.equal(modelUseAllowed('src_cfbd', 'a_lane_nobody_decided', 'anything'), false);

  // a source with ONE rights decision still works: the lane refines, it is not a tax
  assert.deepEqual(effectiveSurfaces('src_noaa_ghcnh', null), ['public', 'pro', 'internal']);
});

test('13b. a lane can only narrow its source, never widen it', () => {
  const { sources, lanePolicies } = loadPolicy();
  for (const [, lane] of lanePolicies) {
    const parentReach = effectiveSurfaces(lane.source_id, null);
    const src = sources.get(lane.source_id);
    if (!src || src.lane_policy_required) continue;       // parent reach is empty by design
    for (const s of effectiveSurfaces(lane.source_id, lane.lane)) {
      assert.ok(parentReach.includes(s),
        `${lane.source_id}/${lane.lane} reaches ${s} but its source does not`);
    }
  }
});

test('14. a row composed from several sources takes the narrowest of them', () => {
  const clean = { source_id: 'src_wikidata', lane: 'college_affiliation' };
  const restricted = { source_id: 'src_cfbd', lane: 'plays' };

  assert.deepEqual(compositionSurfaces([clean]), ['public', 'pro', 'internal']);
  assert.deepEqual(compositionSurfaces([clean, restricted]), ['internal']);
  assert.equal(compositionVisible('public', [clean, restricted]), false);
  assert.equal(compositionVisible('internal', [clean, restricted]), true);
  assert.deepEqual(compositionSurfaces([]), [], 'a row with no provenance is withheld, not permitted');

  // and the college contract withholds the whole record, rather than serving a
  // partial one that still rests on the restricted component
  const out = composeCollegePipeline({
    player_id: 'gpl_1',
    surface: 'public',
    components: [
      { part: 'school', value: 'Ohio State University', ...clean },
      { part: 'first_season', value: 2019, ...restricted },
    ],
  });
  assert.equal(out.data, null);
  assert.equal(out.withheld[0].lane, 'plays');
});

test('15. the model builder refuses an input whose lane forbids model use', () => {
  assert.throws(
    () => assertModelUse({ purpose: 'game_outcome', inputs: [{ source_id: 'src_cfbd', lane: 'talent' }] }),
    e => e instanceof RightsRefusal && /talent/.test(e.message));

  assert.throws(
    () => assertModelUse({ purpose: 'game_outcome', inputs: [{ source_id: 'src_nflverse_pbp' }] }),
    e => e instanceof RightsRefusal && /model_use_allowed=false/.test(e.message));

  // a run that will not say what it is for cannot be checked at all
  assert.throws(() => assertModelUse({ inputs: [{ source_id: 'src_wikidata', lane: 'skeleton' }] }),
    e => e instanceof RightsRefusal && /name its purpose/.test(e.message));
  assert.throws(() => assertModelUse({ purpose: 'x', inputs: [] }),
    e => e instanceof RightsRefusal && /name its inputs/.test(e.message));

  // and a permitted combination passes, so the gate is not simply "no"
  assert.equal(assertModelUse({
    purpose: 'game_outcome',
    inputs: [{ source_id: 'src_cfbd', lane: 'plays' }, { source_id: 'src_wikidata', lane: 'skeleton' }],
  }), true);
});

test('18. the survivorship-biased college spine cannot become a negative-class training population', () => {
  const spine = { source_id: 'src_wikidata', lane: 'college_affiliation' };

  // It is CC0 and readable everywhere. The licence is not the objection.
  assert.deepEqual(effectiveSurfaces(spine.source_id, spine.lane), ['public', 'pro', 'internal']);
  assert.equal(modelUseAllowed(spine.source_id, spine.lane, 'position_classification'), true);

  // The objection is the sample: Wikidata holds items for people notable enough
  // to have one, so absence is not a negative label.
  for (const purpose of ['reached_nfl_probability', 'draft_likelihood', 'pro_success_prediction',
    'prospect_ranking', 'who_becomes_a_pro', 'negative_class_population']) {
    assert.equal(modelUseAllowed(spine.source_id, spine.lane, purpose), false, purpose);
    assert.throws(() => assertModelUse({ purpose, inputs: [spine] }),
      e => e instanceof RightsRefusal && /notability_survivorship/.test(e.message), purpose);
  }

  // and a run that IS allowed still records the bias it inherited
  assert.deepEqual(samplingBiases([spine]), ['notability_survivorship']);
});

/* ==================================================================== 16-17 */

test('16. the public college spine carries only approved lanes, and only approved fields', () => {
  const out = composeCollegePipeline({
    player_id: 'gpl_1',
    surface: 'public',
    components: [
      { part: 'school', value: 'University of Alabama', source_id: 'src_wikidata', lane: 'college_affiliation', snapshot_id: 'snp_wd' },
      { part: 'conference', value: 'Southeastern Conference', source_id: 'src_wikidata', lane: 'college_affiliation', snapshot_id: 'snp_wd' },
      { part: 'first_season', value: 2017, source_id: 'src_eada', lane: 'institution_program_year', snapshot_id: 'snp_eada' },
    ],
  });
  assert.ok(out.data);
  assert.equal(out.data.school, 'University of Alabama');
  assert.deepEqual(out.withheld, []);
  for (const key of Object.keys(out.data)) {
    assert.ok(FIELDS.includes(key) || key === 'provenance', `${key} is not in the contract`);
  }
  // every part names where it came from
  assert.deepEqual(out.data.provenance.map(p => p.source_id).sort(), ['src_eada', 'src_wikidata', 'src_wikidata']);

  // a field outside the allowlist is dropped rather than passed through
  const sneaky = composeCollegePipeline({
    player_id: 'gpl_1', surface: 'public',
    components: [
      { part: 'school', value: 'X', source_id: 'src_wikidata', lane: 'college_affiliation' },
      { part: 'college_passing_yards', value: 4000, source_id: 'src_wikidata', lane: 'college_affiliation' },
    ],
  });
  assert.equal('college_passing_yards' in sneaky.data, false);

  // and the forbidden-name check is a second gate, independent of the allowlist
  assert.throws(() => assertContract({ player_id: 'x', recruit_stars: 5 }), ContractViolation);
  assert.throws(() => assertContract({ player_id: 'x', nested: { sp_plus: 20 } }), ContractViolation);
  // provenance is exempt: a source id that says 'cfbd' is the disclosure, not a leak
  assert.equal(assertContract({ player_id: 'x', provenance: [{ source_id: 'src_cfbd', lane: 'games' }] }), true);
});

test('17. two college players with the same name never merge without a strong id', () => {
  const a = { name: 'Mike Williams', external_ids: { wikidata_qid: 'Q111' } };
  const b = { name: 'Mike Williams', external_ids: { wikidata_qid: 'Q222' } };
  assert.equal(matchDecision(a, b).decision, 'distinct', 'different strong ids must not merge');

  const noIds1 = { name: 'Mike Williams', external_ids: {} };
  const noIds2 = { name: 'Mike Williams', external_ids: {} };
  assert.notEqual(matchDecision(noIds1, noIds2).decision, 'merge', 'a name is not an identifier');

  // the same person seen twice, sharing a strong id, does merge
  const same1 = { name: 'Mike Williams', external_ids: { wikidata_qid: 'Q111' } };
  const same2 = { name: 'Michael Williams', external_ids: { wikidata_qid: 'Q111' } };
  assert.equal(matchDecision(same1, same2).decision, 'merge');

  // a college affiliation row may only be attached through a strong id: the
  // spine builder must refuse a name-only join, because two players who shared
  // a college and a name are exactly the pair it would silently merge.
  const collegeOnly1 = { name: 'Mike Williams', external_ids: {}, college: 'Q1' };
  const collegeOnly2 = { name: 'Mike Williams', external_ids: {}, college: 'Q1' };
  assert.notEqual(matchDecision(collegeOnly1, collegeOnly2).decision, 'merge',
    'sharing a college is corroboration, not identity');
});

/* ==================================================================== 19-20 */

test('19. the adapter refuses to run without explicit enablement and a secret, and never touches the network', async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; throw new Error('the network must not be reached'); };

  const cases = [
    {},
    { CFBD_ENABLED: 'false' },
    { CFBD_ENABLED: 'TRUE', CFBD_API_KEY: 'k' },     // not exactly 'true'
    { CFBD_ENABLED: '1', CFBD_API_KEY: 'k' },
    { CFBD_ENABLED: 'yes', CFBD_API_KEY: 'k' },
    { CFBD_ENABLED: 'true' },                        // no key
    { CFBD_ENABLED: 'true', CFBD_API_KEY: '' },
    { CFBD_ENABLED: 'true', CFBD_API_KEY: '   ' },
  ];
  for (const env of cases) {
    assert.equal(isEnabled(env), false, JSON.stringify(env));
    const adapter = createCfbdAdapter({ env, fetchImpl });
    assert.equal(adapter.enabled, false);
    await assert.rejects(adapter.fetch('/games', { year: 2023 }), e => e instanceof AdapterDisabled);
  }
  assert.equal(called, 0, 'a disabled adapter must not call fetch at all');

  // the committed policy file itself is disabled, and names the gate
  const policy = loadCfbdPolicy();
  assert.equal(policy.enabled, false);
  assert.equal(policy.enable_flag, 'CFBD_ENABLED');

  // enabled, a refused endpoint is still refused before any request is made
  const armed = createCfbdAdapter({ env: { CFBD_ENABLED: 'true', CFBD_API_KEY: 'k' }, fetchImpl });
  assert.equal(armed.enabled, true);
  await assert.rejects(armed.fetch('/ratings/sp'), e => e instanceof RefusedEndpoint);
  await assert.rejects(armed.fetch('/talent'), e => e instanceof RefusedEndpoint);
  assert.equal(called, 0, 'a refused endpoint must not reach the network either');
});

test('20. there is no substitute CFBD API: no route proxies it and no raw payload is stored', async () => {
  const handle = createHistoryApi({ query: async () => ({ rows: [] }) });
  for (const path of ['/v1/cfbd/games', '/v1/cfbd/plays', '/v1/cfbd/rosters', '/v1/cfbd/players',
    '/v1/history/cfbd/games', '/cfbd/games']) {
    const res = await handle(new Request(`https://example.test${path}`));
    assert.equal(res.status, 404, `${path} must not exist`);
  }

  // no source file declares a passthrough route
  for (const file of ['api/history-api.mjs', 'api/college-pipeline.mjs', 'ingest/cfbd-adapter.mjs']) {
    const src = readFileSync(join(REPO, 'history', file), 'utf8');
    assert.equal(/\/v1\/[^\s'"`]*cfbd/i.test(src), false, `${file} must not route a CFBD path`);
  }

  // and the adapter's own output has no raw-payload escape hatch
  const out = processPayload({ path: '/games', records: [{ id: 1, season: 2023, spread: -3 }], retrievedAt: '2026-09-18T00:00:00Z' });
  for (const key of ['raw', 'raw_payload', 'payload', 'body', 'original']) {
    assert.equal(key in out, false, `adapter output must not carry ${key}`);
    assert.equal(key in out.snapshot, false, `snapshot must not carry ${key}`);
  }
  assert.equal(JSON.stringify(out).includes('-3'), false, 'the stripped betting line must be nowhere in the output');
});

/* ==================================================================== 10-12
   The database is the enforcement point. Everything above is a pipeline rule;
   these are the rules a query cannot get around. */

const db = await PGlite.create();
for (const file of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
}
await db.exec(registrySql(JSON.parse(readFileSync(join(REGISTRY_DIR, REGISTRY_FILE), 'utf8'))));
await db.exec(lanePolicySql(JSON.parse(readFileSync(join(REGISTRY_DIR, LANES_FILE), 'utf8'))));

/* Five snapshots of ONE source, in five lanes, plus a CC0 one. Same contract,
   same provider, five different answers. That is the finding, as fixture data.
   These rows are hypothetical: no CFBD data has been ingested. */
const snap = (id, source, lane) =>
  `('${id}', '${source}', ${lane === null ? 'null' : `'${lane}'`}, '${id}', 'test', now(), '${id}', 'test', '1', 1)`;
await db.exec(`
  insert into football_src.source_snapshot
    (source_snapshot_id, source_id, lane, dataset, retrieved_from, retrieved_at, content_sha256, parser_name, parser_version, row_count)
  values ${[
    snap('snp_cfbd_games', 'src_cfbd', 'games'),
    snap('snp_cfbd_plays', 'src_cfbd', 'plays'),
    snap('snp_cfbd_rosters', 'src_cfbd', 'rosters'),
    snap('snp_cfbd_xwalk', 'src_cfbd', 'identifier_crosswalk'),
    snap('snp_cfbd_nolane', 'src_cfbd', null),
    snap('snp_cfbd_undecided', 'src_cfbd', 'a_lane_nobody_decided'),
    snap('snp_wd_college', 'src_wikidata', 'college_affiliation'),
  ].join(',\n         ')};
  insert into football.league (league_id, name, short_name, level, country_code, source_snapshot_id)
  values ('glg_games', 'From the games lane', 'G', 'college', 'US', 'snp_cfbd_games'),
         ('glg_plays', 'From the plays lane', 'P', 'college', 'US', 'snp_cfbd_plays'),
         ('glg_rosters', 'From the rosters lane', 'R', 'college', 'US', 'snp_cfbd_rosters'),
         ('glg_xwalk', 'From the crosswalk lane', 'X', 'college', 'US', 'snp_cfbd_xwalk'),
         ('glg_nolane', 'No lane named', 'N', 'college', 'US', 'snp_cfbd_nolane'),
         ('glg_undecided', 'Lane never decided', 'U', 'college', 'US', 'snp_cfbd_undecided'),
         ('glg_wd', 'CC0 college affiliation', 'W', 'college', 'US', 'snp_wd_college');`);

const asReader = async (surface, sql) => {
  await db.exec(`set role pbe_history_reader; set app.surface = '${surface}';`);
  try { return (await db.query(sql)).rows; } finally { await db.exec('reset role; reset app.surface;'); }
};
const visibleAt = async surface =>
  (await asReader(surface, `select league_id from football.league order by 1`)).map(r => r.league_id);

test('10. one source, five lanes, five different answers — and raw plays reach no surface but internal', async () => {
  assert.deepEqual(await visibleAt('public'), ['glg_games', 'glg_wd']);
  assert.deepEqual(await visibleAt('pro'), ['glg_games', 'glg_rosters', 'glg_wd']);
  assert.deepEqual(await visibleAt('internal'),
    ['glg_games', 'glg_plays', 'glg_rosters', 'glg_wd', 'glg_xwalk']);

  // the two fail-closed states never appear, on any surface
  for (const surface of ['public', 'pro', 'internal']) {
    const seen = await visibleAt(surface);
    assert.equal(seen.includes('glg_nolane'), false, `no lane named, ${surface}`);
    assert.equal(seen.includes('glg_undecided'), false, `undecided lane, ${surface}`);
  }

  // however the question is asked
  assert.equal((await asReader('public', `select count(*)::int n from football.league where league_id = 'glg_plays'`))[0].n, 0);
  assert.equal((await asReader('pro', `select count(*)::int n from football.league where name like '%plays%'`))[0].n, 0);

  // and the generated policy for the play table is the same predicate, so this
  // result is not specific to the table the fixture happened to use
  const rls = readFileSync(join(MIGRATIONS, '008_rights_row_level_security.sql'), 'utf8');
  assert.match(rls, /create policy football_play_rights on football\.play[\s\S]*?snapshot_visible\(source_snapshot_id\)/);
});

test('11. a restricted row cannot leak through a JSON column or any generic carrier', async () => {
  // Every table that holds a JSON blob is gated like every other table: either by
  // its own snapshot, or explicitly internal-only. A raw payload has nowhere to
  // sit that is not already behind the policy.
  const jsonTables = (await db.query(`
    select c.table_schema || '.' || c.table_name as t
      from information_schema.columns c
     where c.data_type in ('json','jsonb')
       and c.table_schema in ('football','football_src','football_derived')
     group by 1 order by 1`)).rows.map(r => r.t);
  assert.ok(jsonTables.length > 0, 'expected at least one JSON column to exist to make this test meaningful');

  const policies = (await db.query(`
    select schemaname || '.' || tablename as t, qual from pg_policies
     where schemaname in ('football','football_src','football_derived')`)).rows;
  const byTable = Object.fromEntries(policies.map(p => [p.t, p.qual || '']));
  for (const t of jsonTables) {
    const qual = byTable[t];
    assert.ok(qual !== undefined, `${t} holds JSON and has no rights policy`);
    assert.ok(/snapshot_visible|current_surface|entity_visible/.test(qual),
      `${t} holds JSON behind an ungated policy: ${qual}`);
  }

  // and nothing anywhere is readable without a policy
  const { results } = await runChecks(sql => db.query(sql), CHECKS);
  const byName = Object.fromEntries(results.map(r => [r.name, r]));
  assert.equal(byName['rights.rls_on_every_table'].pass, true, byName['rights.rls_on_every_table'].detail);
  assert.equal(byName['rights.refused_lanes_cannot_be_ingested'].pass, true,
    byName['rights.refused_lanes_cannot_be_ingested'].detail);

  // This fixture deliberately plants the two states a deployment must never be
  // in — a CFBD snapshot with no lane, and one naming a lane we never decided —
  // so that the read tests above have something to prove invisible. The deploy
  // check must therefore FAIL here and say exactly which two. A check that
  // passed on this database would be a check that never fires.
  const lanes = byName['rights.lane_policy_present'];
  assert.equal(lanes.pass, false, 'the lane check must detect a planted bad snapshot');
  assert.match(lanes.detail, /1 snapshots naming an undecided lane/);
  assert.match(lanes.detail, /1 snapshots missing a required lane/);

  // likewise the "nothing ingested from CFBD" check: this fixture holds
  // hypothetical CFBD snapshots, and the check must notice.
  const notIngested = byName['rights.cfbd_not_ingested'];
  assert.equal(notIngested.pass, false, 'the CFBD check must detect stored CFBD snapshots');
  assert.match(notIngested.detail, /6 CFBD snapshots stored/);
});

test('12. derived output keeps the lineage of every input, and stays internal until it does', async () => {
  await db.exec(`insert into football_derived.derivation (derivation_id, name, code_version, input_snapshot_ids, computed_at)
                 values ('drv_lane', 'college pathway feature', 'abc1234', array['snp_wd_college','snp_cfbd_plays'], now())`);
  assert.equal((await asReader('public', `select count(*)::int n from football_derived.derivation`))[0].n, 0);

  const rows = await asReader('internal', `select derivation_id, input_snapshot_ids from football_derived.derivation where derivation_id = 'drv_lane'`);
  assert.equal(rows.length, 1);
  assert.deepEqual([...rows[0].input_snapshot_ids].sort(), ['snp_cfbd_plays', 'snp_wd_college']);

  // the lineage resolves to the lanes it was built from, so a later reader can
  // ask what the output inherited rather than guessing from the name
  const lanes = (await db.query(`
    select s.source_id, s.lane
      from football_derived.derivation d
      join football_src.source_snapshot s on s.source_snapshot_id = any (d.input_snapshot_ids)
     where d.derivation_id = 'drv_lane' order by 2`)).rows;
  assert.deepEqual(lanes, [{ source_id: 'src_wikidata', lane: 'college_affiliation' }, { source_id: 'src_cfbd', lane: 'plays' }]);
});

test('the SQL and the JavaScript rights engines agree, lane by lane', async () => {
  const { lanePolicies } = loadPolicy();
  for (const [, lane] of lanePolicies) {
    for (const surface of ['public', 'pro', 'internal']) {
      const sql = (await db.query(
        `select football_rights.surface_allows($1, $2, $3) as ok`,
        [surface, lane.source_id, lane.lane])).rows[0].ok;
      assert.equal(sql, surfaceAllows(surface, lane.source_id, lane.lane),
        `${lane.source_id}/${lane.lane} @ ${surface}: SQL says ${sql}`);
    }
    const sqlModel = (await db.query(
      `select football_rights.model_use_allowed(s.source_snapshot_id, null) as ok
         from football_src.source_snapshot s where s.source_id = $1 and s.lane = $2 limit 1`,
      [lane.source_id, lane.lane])).rows[0];
    if (sqlModel) {
      assert.equal(sqlModel.ok, modelUseAllowed(lane.source_id, lane.lane, null),
        `${lane.source_id}/${lane.lane} model use`);
    }
  }
});

test('the college pipeline SQL touches the spine and no statistics table', () => {
  for (const sql of [COLLEGE_PIPELINE_SQL, COLLEGE_TRANSITION_SQL]) {
    assert.match(sql, /football_rights\.surface_allows/);
    for (const forbidden of ['player_game_stat', 'team_game_stat', 'play', 'drive', 'player_game_snaps']) {
      assert.equal(new RegExp(`football\\.${forbidden}\\b`).test(sql), false,
        `the college contract must not join football.${forbidden}`);
    }
  }
});

test.after(() => db.close());
