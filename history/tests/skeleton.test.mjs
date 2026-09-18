/**
 * Invariants introduced by the all-era rights-clean skeleton (Phase 2).
 *
 * The subject of most of these is not "does the code run" but "does the model
 * keep saying only what a source said": a bound stated to the year must not be
 * read as a day, an end must not swallow the final season, and an overlap must
 * be attributed to whoever caused it.
 *
 *   node --test history/tests/skeleton.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLineage } from '../lib/lineage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const identity = (id, over) => ({
  team_identity_id: id, league_id: 'glg_nfl', source_snapshot_id: 'snp_x',
  effective_from: null, effective_to: null, from_basis: 'unknown', to_basis: 'unknown',
  from_precision: 'unknown', to_precision: 'unknown', ...over,
});
const link = (id, franchise = 'gfr_1') => ({
  team_identity_id: id, franchise_id: franchise, effective_from: null, effective_to: null, source_snapshot_id: 'snp_x',
});
const run = (identities) => validateLineage({
  team_identities: identities,
  identity_franchise: identities.map(i => link(i.team_identity_id)),
});
const rules = (problems, severity) => problems.filter(p => p.severity === severity).map(p => p.rule);

test('a bound the source never gave is a gap, not a contradiction', () => {
  const problems = run([
    identity('a', { effective_from: '1960-01-01', effective_to: '1982-01-01', from_basis: 'documented', to_basis: 'documented', from_precision: 'year', to_precision: 'year' }),
    identity('b'),                                   // Las Vegas Raiders: bounds unknown
  ]);
  assert.deepEqual(rules(problems, 'contradiction'), []);
  assert.deepEqual(rules(problems, 'unknown'), ['identity_bounds_unknown']);
});

test('two year-precision names that change mid-year overlap by precision, not by claim', () => {
  const problems = run([
    identity('braves', { effective_from: '1932-01-01', effective_to: '1934-01-01', from_basis: 'documented', to_basis: 'documented', from_precision: 'year', to_precision: 'year' }),
    identity('redskins', { effective_from: '1933-01-01', effective_to: '1938-01-01', from_basis: 'documented', to_basis: 'documented', from_precision: 'year', to_precision: 'year' }),
  ]);
  assert.deepEqual(rules(problems, 'contradiction'), []);
  assert.deepEqual(rules(problems, 'unknown'), ['overlap_within_stated_precision']);
});

test('a day-precision overlap between two documented bounds is reported as the source\'s conflict', () => {
  const problems = run([
    identity('wr', { effective_from: '1937-01-01', effective_to: '2020-07-24', from_basis: 'documented', to_basis: 'documented', from_precision: 'year', to_precision: 'day' }),
    identity('wft', { effective_from: '2020-07-23', effective_to: '2022-02-03', from_basis: 'documented', to_basis: 'documented', from_precision: 'day', to_precision: 'day' }),
  ]);
  const conflict = problems.find(p => p.severity === 'source_conflict');
  assert.equal(conflict.rule, 'source_states_overlapping_names');
  assert.equal(conflict.days, 1);
  assert.deepEqual(rules(problems, 'contradiction'), []);
});

test('an overlap caused by a bound WE derived stays a blocking contradiction', () => {
  const problems = run([
    identity('older', { effective_from: '1950-01-01', effective_to: '1990-01-01', from_basis: 'documented', to_basis: 'derived_from_dissolution', from_precision: 'day', to_precision: 'day' }),
    identity('newer', { effective_from: '1970-01-01', effective_to: '1999-01-01', from_basis: 'documented', to_basis: 'documented', from_precision: 'day', to_precision: 'day' }),
  ]);
  assert.deepEqual(rules(problems, 'contradiction'), ['franchise_identity_overlap']);
});

test('an inverted interval is still a contradiction', () => {
  const problems = run([
    identity('x', { effective_from: '1918-01-01', effective_to: '1918-01-01', from_basis: 'documented', to_basis: 'documented', from_precision: 'year', to_precision: 'year' }),
  ]);
  assert.ok(rules(problems, 'contradiction').includes('identity_interval_inverted'));
});

/* The bound arithmetic itself lives in the Python builder; these assert the
   behaviour that made the 2023 slice lose a team's final season. */
const py = (expr) => execFileSync('python', ['-c', `
import sys; sys.path.insert(0, r'${join(REPO, 'history', 'pipeline').replace(/\\/g, '\\\\')}')
import importlib.util, os
spec = importlib.util.spec_from_file_location('bs', r'${join(REPO, 'history', 'pipeline', 'build_skeleton.py').replace(/\\/g, '\\\\')}')
src = open(spec.origin, encoding='utf-8').read()
head = src[:src.index('# ---------------------------------------------------------------- seed')]
ns = {'__file__': spec.origin}
exec(compile(head, 'build_skeleton.py', 'exec'), ns)
print(${expr})
`], { encoding: 'utf8' }).trim();

test('a year-precision date claims only the year', () => {
  assert.equal(py("ns['day']('1918-01-01T00:00:00Z', '9')"), '1918-01-01');
  assert.equal(py("ns['precision_of']('1918-01-01T00:00:00Z', '9')"), 'year');
  assert.equal(py("ns['precision_of']('2022-02-02T00:00:00Z', '11')"), 'day');
});

test('an end stated as a year keeps that whole year inside the interval', () => {
  // Wikidata: the Houston Oilers name ended 1996. They played the 1996 season.
  assert.equal(py("ns['end_bound']('1996-01-01T00:00:00Z', '9')"), '1997-01-01');
  assert.equal(py("ns['end_bound']('2020-07-23T00:00:00Z', '11')"), '2020-07-24');
  assert.equal(py("ns['end_bound']('1996-06-01T00:00:00Z', '10')"), '1996-07-01');
  assert.equal(py("ns['end_bound']('1996-12-01T00:00:00Z', '10')"), '1997-01-01');
});

test('a same-year start and end describe a season, not an empty interval', () => {
  // Buffalo Niagaras: P1448 start 1918, end 1918.
  assert.equal(py("ns['day']('1918-01-01T00:00:00Z', '9')"), '1918-01-01');
  assert.equal(py("ns['end_bound']('1918-01-01T00:00:00Z', '9')"), '1919-01-01');
  assert.ok(py("ns['end_bound']('1918-01-01T00:00:00Z', '9') > ns['day']('1918-01-01T00:00:00Z', '9')") === 'True');
});

test('a date the source does not carry stays unknown', () => {
  assert.equal(py("repr(ns['day'](None, '9'))"), 'None');
  assert.equal(py("repr(ns['end_bound']('', '11'))"), 'None');
  assert.equal(py("ns['precision_of'](None, None)"), 'unknown');
});
