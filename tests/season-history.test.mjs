import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT, SNAPSHOT_VERSION, SOURCE_ID, NFL_QID,
  SEASONS_QUERY, SUPER_BOWL_QUERY,
  normalizeSeasons, normalizeChampionships, validateSnapshot,
} from '../api/season-history.js';

const entity = qid => ({ value: `http://www.wikidata.org/entity/${qid}` });
const literal = value => ({ value: String(value) });

test('season history contract is pinned to the approved CC0 Wikidata lanes', () => {
  assert.equal(CONTRACT, 'pbe-nfl-season-history-v1');
  assert.equal(SNAPSHOT_VERSION, '1.0.0');
  assert.equal(SOURCE_ID, 'src_wikidata');
  assert.equal(NFL_QID, 'Q1215884');
  assert.match(SEASONS_QUERY, /wdt:P3450/);
  assert.match(SUPER_BOWL_QUERY, /Q32096/);
  assert.match(SUPER_BOWL_QUERY, /wdt:P1346/);
  assert.doesNotMatch(SUPER_BOWL_QUERY, /score|runner|mvp/i);
});

test('NFL season normalization filters other leagues and keeps source identity', () => {
  const rows = normalizeSeasons([
    {
      season: entity('Q1001'), seasonLabel: literal('2025 NFL season'),
      league: entity('Q1215884'), start: literal('2025-09-01T00:00:00Z'), end: literal('2026-02-08T00:00:00Z'),
    },
    {
      season: entity('Q1002'), seasonLabel: literal('2025 AFL season'),
      league: entity('Q464508'),
    },
    {
      season: entity('Q1003'), seasonLabel: literal('1920 APFA season'),
      league: entity('Q1215884'),
    },
  ]);

  assert.deepEqual(rows.map(r => r.year), [1920, 2025]);
  assert.equal(rows[1].qid, 'Q1001');
  assert.equal(rows[1].starts_on, '2025-09-01');
  assert.equal(rows[1].ends_on, '2026-02-08');
});

test('championship normalization maps a February Super Bowl to the prior NFL season', () => {
  const rows = normalizeChampionships([
    {
      game: entity('Q2001'),
      gameLabel: literal('Super Bowl LX'),
      date: literal('2026-02-08T00:00:00Z'),
      winner: entity('Q3001'),
      winnerLabel: literal('Example Champions'),
      venue: entity('Q4001'),
      venueLabel: literal('Example Stadium'),
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].season_year, 2025);
  assert.equal(rows[0].winner, 'Example Champions');
  assert.equal(rows[0].decided_on, '2026-02-08');
  assert.equal(rows[0].qid, 'Q2001');
});

test('snapshot validator refuses duplicate years, bad source and invented-shaped rows', () => {
  const baseSeason = year => ({
    year,
    qid: `Q${100000 + year}`,
    label: `${year} NFL season`,
    championship: null,
  });
  const seasons = Array.from({ length: 107 }, (_, i) => baseSeason(1920 + i));
  const good = {
    contract: CONTRACT,
    version: SNAPSHOT_VERSION,
    season_count: seasons.length,
    source: { source_id: SOURCE_ID, licence: 'CC0-1.0' },
    seasons,
  };
  assert.equal(validateSnapshot(good), good);

  assert.throws(() => validateSnapshot({ ...good, source: { source_id: 'bad', licence: 'CC0-1.0' } }), /source/);
  assert.throws(() => validateSnapshot({ ...good, seasons: [...seasons.slice(0,-1), seasons[0]] }), /duplicate/);
  assert.throws(() => validateSnapshot({ ...good, season_count: 1 }), /count/);
});

test('restored consumer renderers carry no authority from legacy history globals', async () => {
  const { readFile } = await import('node:fs/promises');
  const files = ['season-archive-v2.js', 'super-bowls-v2.js', 'records-v2.js'];
  const legacy = ['NFL_SEASONS', 'MVP_HISTORY', 'SUPER_BOWLS', 'NFL_RECORDS', 'NFL_MILESTONES'];
  for (const file of files) {
    const src = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(src, /\/api\/season-history/);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const symbol of legacy) {
      assert.equal(new RegExp(`\\b${symbol}\\b`).test(code), false, `${file} leaked ${symbol}`);
    }
    assert.equal(/being re-sourced|PROVENANCE REVIEW/i.test(src), false, file);
  }
});
