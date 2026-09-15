/* Football history graph — core policy tests.
 * Fixtures are deliberately fictional (FR-A, "Riverport Rams"): these tests
 * prove rules, never historical facts.
 *   node --test history/tests
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, matchDecision } from '../lib/identity.mjs';
import { visibleAsOf, asOf, leakageViolations, TemporalError } from '../lib/temporal.mjs';
import { identitiesOnDate, franchisesForIdentity, lineage, validateLineage, assertIdentityInForce } from '../lib/lineage.mjs';
import { resolveSourceLabel, isWithin, validateOntology } from '../lib/positions.mjs';

/* ------------------------------------------------------------ identity */
test('names: suffixes are parsed, never invented; accents and punctuation fold', () => {
  assert.deepEqual(normalizeName('Pat Example Jr.'), { display: 'Pat Example Jr.', given: 'pat', family: 'example', suffix: 'Jr.', key: 'pat example' });
  assert.equal(normalizeName('Pat Example III').suffix, 'III');
  assert.equal(normalizeName('Pat Example').suffix, null);
  assert.equal(normalizeName('José Ñúñez-Ó’Brien').key, 'jose nunez obrien');
  assert.equal(normalizeName('Jr').suffix, null, 'a lone token is a name, not a suffix');
});

test('identity: an exact name never merges', () => {
  const r = matchDecision({ name: 'Pat Example' }, { name: 'Pat Example' });
  assert.equal(r.decision, 'distinct'); assert.equal(r.rule, 'name_only_never_merges');
});

test('identity: Jr./Sr./II/III are different people without a shared strong id', () => {
  for (const [a, b] of [['Pat Example', 'Pat Example Jr.'], ['Pat Example Sr.', 'Pat Example Jr.'], ['Pat Example II', 'Pat Example III']]) {
    const r = matchDecision({ name: a, dob: '1990-01-01' }, { name: b, dob: '1990-01-01' });
    assert.equal(r.decision, 'distinct', `${a} vs ${b}`); assert.equal(r.rule, 'generational_suffix_differs');
  }
});

test('identity: a shared strong id merges (even across a suffix added later); a conflicting one blocks', () => {
  assert.equal(matchDecision({ name: 'Pat Example', external_ids: { nfl_gsis_id: '00-0000001' } }, { name: 'Pat Example Jr.', external_ids: { nfl_gsis_id: '00-0000001' } }).rule, 'shared_strong_id_suffix_differs');
  const conflict = matchDecision({ name: 'Pat Example', external_ids: { nfl_gsis_id: '00-0000001', espn_athlete_id: '1' } }, { name: 'Pat Example', external_ids: { nfl_gsis_id: '00-0000002', espn_athlete_id: '1' } });
  assert.equal(conflict.decision, 'distinct'); assert.equal(conflict.rule, 'conflicting_strong_id');
});

test('identity: weak ids never merge; DOB conflict blocks; corroborated same-name pairs go to human review only', () => {
  assert.equal(matchDecision({ name: 'Pat Example', external_ids: { jersey: '12' } }, { name: 'Pat Example', external_ids: { jersey: '12' } }).decision, 'distinct');
  assert.equal(matchDecision({ name: 'Pat Example', dob: '1990-01-01' }, { name: 'Pat Example', dob: '1991-01-01' }).rule, 'dob_conflict');
  assert.equal(matchDecision({ name: 'Pat Example', dob: '1990-01-01', external_ids: { espn_athlete_id: '9' } }, { name: 'Pat Example', dob: '1991-01-01', external_ids: { espn_athlete_id: '9' } }).decision, 'review');
  const corroborated = matchDecision({ name: 'Pat Example', dob: '1990-01-01', college_team_id: 'CT1' }, { name: 'Pat Example', dob: '1990-01-01', college_team_id: 'CT1' });
  assert.equal(corroborated.decision, 'review'); assert.notEqual(corroborated.decision, 'merge');
});

/* ------------------------------------------------------------ temporal */
const rows = [
  { subject_id: 'p1', status: 'active', effective_from: '2023-09-01', effective_to: '2023-10-15', observed_at: '2023-09-01T12:00:00Z' },
  { subject_id: 'p1', status: 'injured_reserve', effective_from: '2023-10-15', effective_to: null, observed_at: '2023-10-16T15:00:00Z' },
  /* a retroactive correction published long after the fact */
  { subject_id: 'p1', status: 'reserve_nfi', effective_from: '2023-10-15', effective_to: null, observed_at: '2024-02-01T00:00:00Z' },
];

test('as-of: a fact observed after the knowledge cutoff is invisible even if it describes an earlier date', () => {
  const pregame = asOf(rows, { validAt: '2023-10-15T17:00:00Z', knownAt: '2023-10-15T16:59:00Z' });
  assert.deepEqual(pregame, [], 'IR was not yet announced before this kickoff; nothing valid-and-known remains');
  const nextWeek = asOf(rows, { validAt: '2023-10-22T17:00:00Z', knownAt: '2023-10-22T16:00:00Z' });
  assert.equal(nextWeek[0].status, 'injured_reserve', 'the February correction does not leak into October');
  assert.equal(asOf(rows, { validAt: '2023-10-22T17:00:00Z', knownAt: '2024-03-01T00:00:00Z' })[0].status, 'reserve_nfi', 'with hindsight, the correction wins');
});

test('as-of: half-open intervals, unobserved rows never visible, cutoffs required', () => {
  assert.equal(visibleAsOf(rows[0], { validAt: '2023-10-15', knownAt: '2030-01-01' }), false, 'effective_to is exclusive');
  assert.equal(visibleAsOf({ effective_from: '2000-01-01' }, { validAt: '2023-01-01', knownAt: '2030-01-01' }), false);
  assert.throws(() => visibleAsOf(rows[0], { validAt: '2023-10-01' }), TemporalError);
});

test('leakage audit names every input observed after the prediction cutoff', () => {
  const v = leakageViolations([{ id: 'ok', observed_at: '2023-10-01' }, { id: 'late', observed_at: '2023-10-20' }, { id: 'unknown' }], '2023-10-15T17:00:00Z');
  assert.deepEqual(v.map(x => x.id), ['late', 'unknown']);
});

/* ------------------------------------------------------------ lineage */
const S = 'snap_fixture_1';
const graph = {
  team_identities: [
    { team_identity_id: 'TI-1', league_id: 'LG-X', location: 'Riverport', nickname: 'Rams', effective_from: '1950-01-01', effective_to: '1970-01-01', source_snapshot_id: S },
    { team_identity_id: 'TI-2', league_id: 'LG-X', location: 'Lakeside', nickname: 'Rams', effective_from: '1970-01-01', effective_to: '1990-01-01', source_snapshot_id: S },
    { team_identity_id: 'TI-3', league_id: 'LG-X', location: 'Lakeside', nickname: 'Comets', effective_from: '1990-01-01', effective_to: null, source_snapshot_id: S },
    { team_identity_id: 'TI-M', league_id: 'LG-X', location: 'Riverport-Hilltop', nickname: 'Combined', effective_from: '1960-01-01', effective_to: '1961-01-01', source_snapshot_id: S },
    { team_identity_id: 'TI-H', league_id: 'LG-X', location: 'Hilltop', nickname: 'Hawks', effective_from: '1950-01-01', effective_to: null, source_snapshot_id: S },
  ],
  identity_franchise: [
    { team_identity_id: 'TI-1', franchise_id: 'FR-A', effective_from: '1950-01-01', effective_to: '1960-01-01', source_snapshot_id: S },
    { team_identity_id: 'TI-M', franchise_id: 'FR-A', effective_from: '1960-01-01', effective_to: '1961-01-01', source_snapshot_id: S },
    { team_identity_id: 'TI-1', franchise_id: 'FR-A', effective_from: '1961-01-01', effective_to: '1970-01-01', source_snapshot_id: S },
    { team_identity_id: 'TI-2', franchise_id: 'FR-A', source_snapshot_id: S },
    { team_identity_id: 'TI-3', franchise_id: 'FR-A', source_snapshot_id: S },
    { team_identity_id: 'TI-H', franchise_id: 'FR-H', effective_from: '1950-01-01', effective_to: '1960-01-01', source_snapshot_id: S },
    { team_identity_id: 'TI-M', franchise_id: 'FR-H', effective_from: '1960-01-01', effective_to: '1961-01-01', source_snapshot_id: S },
    { team_identity_id: 'TI-H', franchise_id: 'FR-H', effective_from: '1961-01-01', effective_to: null, source_snapshot_id: S },
  ],
};

test('lineage: a historical date resolves to the identity then in force, never the modern name', () => {
  assert.deepEqual(identitiesOnDate(graph, 'FR-A', '1965-10-01').map(t => t.nickname), ['Rams']);
  assert.equal(identitiesOnDate(graph, 'FR-A', '1965-10-01')[0].location, 'Riverport');
  assert.equal(identitiesOnDate(graph, 'FR-A', '1975-10-01')[0].location, 'Lakeside');
  assert.equal(identitiesOnDate(graph, 'FR-A', '2020-10-01')[0].nickname, 'Comets');
  assert.deepEqual(lineage(graph, 'FR-A').map(t => t.team_identity_id), ['TI-1', 'TI-M', 'TI-2', 'TI-3']);
});

test('lineage: a merged temporary identity represents both franchises only for its season', () => {
  assert.deepEqual(franchisesForIdentity(graph, 'TI-M', '1960-10-01').sort(), ['FR-A', 'FR-H']);
  assert.deepEqual(franchisesForIdentity(graph, 'TI-M', '1962-10-01'), []);
  assert.deepEqual(identitiesOnDate(graph, 'FR-H', '1960-10-01').map(t => t.team_identity_id), ['TI-M']);
});

test('lineage: records must cite the identity in force; validation catches overlaps and missing provenance', () => {
  assert.equal(assertIdentityInForce(graph, { team_identity_id: 'TI-1', date: '1965-10-01' }), true);
  assert.throws(() => assertIdentityInForce(graph, { team_identity_id: 'TI-3', date: '1965-10-01' }), /identity_not_in_force_on_date/);
  assert.deepEqual(validateLineage(graph), []);
  const broken = structuredClone(graph);
  broken.identity_franchise.push({ team_identity_id: 'TI-H', franchise_id: 'FR-A', effective_from: '1980-01-01', effective_to: '1981-01-01' });
  const rules = validateLineage(broken).map(p => p.rule);
  assert.ok(rules.includes('franchise_identity_overlap')); assert.ok(rules.includes('link_without_provenance'));
});

/* ------------------------------------------------------------ positions */
test('positions: the source label is always kept; ambiguous historical labels stay ambiguous', () => {
  assert.deepEqual(resolveSourceLabel('E', { source_id: 'src' }), { source_label: 'E', source_id: 'src', canonical: 'END_TWO_WAY', ambiguous: true, mapping: 'ontology_v1' });
  assert.equal(resolveSourceLabel('T').canonical, 'TACKLE_TWO_WAY');
  assert.equal(resolveSourceLabel('C', { platoon_era: false }).canonical, 'CENTER_TWO_WAY');
  assert.equal(resolveSourceLabel('C', { platoon_era: true }).canonical, 'C');
  assert.equal(resolveSourceLabel('Rover').canonical, 'UNKNOWN');
  assert.equal(resolveSourceLabel('Rover').source_label, 'Rover');
});

test('positions: hierarchy queries and ontology integrity', () => {
  assert.ok(isWithin('LT', 'OL')); assert.ok(isWithin('FS', 'DB')); assert.ok(isWithin('KR', 'SPECIAL'));
  assert.equal(isWithin('TE', 'OL'), false);
  assert.equal(isWithin('END_TWO_WAY', 'OFFENSE'), false, 'an ambiguous two-way end is not assumed to be offense');
  assert.deepEqual(validateOntology(), []);
});
