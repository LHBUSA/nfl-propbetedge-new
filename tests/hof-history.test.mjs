import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT, SOURCE_ID, SOURCE_PROPERTY, HOF_QUERY, normalizeBindings } from '../api/hof-history.js';

test('Hall contract is pinned to the approved Wikidata membership identifier', () => {
  assert.equal(CONTRACT, 'pbe-nfl-hof-v1');
  assert.equal(SOURCE_ID, 'src_wikidata');
  assert.equal(SOURCE_PROPERTY, 'P6930');
  assert.match(HOF_QUERY, /wdt:P6930/);
  assert.doesNotMatch(HOF_QUERY, /induct|class|year/i, 'the source query must not invent induction metadata');
});

test('Hall bindings normalize identity and optional context without name joins', () => {
  const rows = normalizeBindings([
    {
      person: { value: 'http://www.wikidata.org/entity/Q123' },
      personLabel: { value: 'Example Player' },
      hofId: { value: 'example-player' },
      positions: { value: 'quarterback|Quarterback' },
      teams: { value: 'Example Team|Example Team' },
    },
    {
      person: { value: 'http://www.wikidata.org/entity/Q123' },
      personLabel: { value: 'Example Player' },
      hofId: { value: 'example-player' },
      positions: { value: 'Quarterback' },
      teams: { value: 'Second Team' },
    },
    {
      person: { value: 'not-a-wikidata-entity' },
      personLabel: { value: 'Bad Identity' },
      hofId: { value: 'bad' },
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].qid, 'Q123');
  assert.equal(rows[0].hof_id, 'example-player');
  assert.deepEqual(rows[0].teams, ['Example Team', 'Second Team']);
  assert.deepEqual(rows[0].positions, ['Quarterback', 'quarterback']);
});

test('Hall normalization sorts people deterministically', () => {
  const rows = normalizeBindings([
    { person: { value: 'http://www.wikidata.org/entity/Q2' }, personLabel: { value: 'Zed Player' }, hofId: { value: 'zed' } },
    { person: { value: 'http://www.wikidata.org/entity/Q1' }, personLabel: { value: 'Alpha Player' }, hofId: { value: 'alpha' } },
  ]);
  assert.deepEqual(rows.map(row => row.name), ['Alpha Player', 'Zed Player']);
});
