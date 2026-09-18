/* Game identity: the postseason week defect, and the crosswalk that lets an
 * already-issued id keep resolving.
 *
 * The expected numbering is measured from nflverse's own data
 * (data/warehouse/nfl_games.parquet): postseason week = regular-season weeks +
 * round, i.e. 17 + round for 1999-2020 and 18 + round for 2021+.
 *
 *   node --test tests/nfl-game-identity.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  providerGameId, legacyPropBetEdgeGameId, resolve, alias, isProviderSpelling,
  postseasonWeek, regularSeasonWeeks, roundFromEspnWeek, GameIdentityError,
} from '../history/lib/game-identity.mjs';
import { nflverseGameId } from '../workers/nfl-picks-engine-shared/current-slate.mjs';

test('postseason weeks match the provider, per era', () => {
  assert.equal(regularSeasonWeeks(2019), 17);
  assert.equal(regularSeasonWeeks(2023), 18);
  assert.deepEqual([1, 2, 3, 4].map(r => postseasonWeek(2019, r)), [18, 19, 20, 21]);
  assert.deepEqual([1, 2, 3, 4].map(r => postseasonWeek(2023, r)), [19, 20, 21, 22]);
  assert.throws(() => regularSeasonWeeks(1975), GameIdentityError, 'pre-1999 is unknown, not guessed');
});

test('the Super Bowl is week 22 in 2021+, and week 21 in 2019-20', () => {
  assert.equal(providerGameId({ season: 2023, seasonType: 'POST', round: 4, away: 'SF', home: 'KC' }), '2023_22_SF_KC');
  assert.equal(providerGameId({ season: 2019, seasonType: 'POST', round: 4, away: 'SF', home: 'KC' }), '2019_21_SF_KC');
  /* the defect: our live producer puts it in week 23, which does not exist */
  assert.equal(nflverseGameId({ season: 2023, seasonType: 'POST', week: 5, away: 'SF', home: 'KC' }), '2023_23_SF_KC');
});

test('ESPN postseason weeks map to rounds, and the Pro Bowl is refused', () => {
  assert.deepEqual([1, 2, 3, 5].map(roundFromEspnWeek), [1, 2, 3, 4]);
  assert.throws(() => roundFromEspnWeek(4), /pro_bowl_is_not_a_league_game/);
  /* the legacy producer silently accepted it and emitted the Super Bowl slot */
  assert.equal(nflverseGameId({ season: 2023, seasonType: 'POST', week: 4, away: 'AFC', home: 'NFC' }), '2023_22_AFC_NFC');
});

test('regular-season ids are unchanged: every issued id keeps its spelling', () => {
  for (const [season, week] of [[2026, 1], [2026, 18], [2023, 17], [2019, 17]]) {
    const ours = providerGameId({ season, seasonType: 'REG', week, away: 'SF', home: 'LA' });
    assert.equal(ours, nflverseGameId({ season, seasonType: 'REG', week, away: 'SF', home: 'LA' }),
      `regular-season week ${week} in ${season} must not move`);
    assert.equal(isProviderSpelling(ours), true);
  }
  assert.throws(() => providerGameId({ season: 2019, seasonType: 'REG', week: 18, away: 'SF', home: 'LA' }),
    /bad_regular_week/, '2019 had 17 regular-season weeks');
});

test('an id of either spelling can be read back', () => {
  const provider = resolve('2023_22_SF_KC');
  assert.deepEqual([provider.season_type, provider.round_key, provider.spelling], ['POST', 'super_bowl', 'provider']);

  const legacy = resolve('2023_23_SF_KC');
  assert.deepEqual([legacy.season_type, legacy.round_key, legacy.spelling], ['POST', 'super_bowl', 'legacy']);

  const reg = resolve('2026_01_SF_LA');
  assert.deepEqual([reg.season_type, reg.week, reg.spelling], ['REG', 1, 'provider']);

  const wildCard = resolve('2023_19_CLE_HOU');
  assert.deepEqual([wildCard.round_key, wildCard.spelling], ['wild_card', 'provider']);
  assert.throws(() => resolve('nonsense'), /unparseable_game_id/);
});

test('the crosswalk maps a legacy id to the provider id without rewriting it', () => {
  const row = alias('2023_23_SF_KC');
  assert.deepEqual(row, {
    issued_id: '2023_23_SF_KC', provider_id: '2023_22_SF_KC',
    reason: 'legacy_postseason_week_offset', season: 2023, round_key: 'super_bowl', ambiguous: false,
  });
  assert.equal(alias('2026_01_SF_LA'), null, 'an id already in the provider spelling needs no alias');
  /* A legacy Pro Bowl id is byte-identical to a provider Super Bowl id; the
     conference team codes are the only thing that tells them apart. */
  assert.equal(alias('2023_22_AFC_NFC').provider_id, null, 'a Pro Bowl id maps to no league game');
  assert.equal(alias('2023_22_AFC_NFC').reason, 'pro_bowl_is_not_a_league_game');
  assert.equal(isProviderSpelling('2023_22_AFC_NFC'), false);
});

test('a 2019-20 legacy id is ambiguous with a provider id for another round, and says so', () => {
  /* legacy week = ESPN week + 18, so a 2019 Wild Card was issued as week 19 —
     exactly the provider's Divisional week that season. The string cannot
     decide; the caller states which system issued it. */
  assert.equal(legacyPropBetEdgeGameId({ season: 2019, seasonType: 'POST', week: 1, away: 'BUF', home: 'HOU' }), '2019_19_BUF_HOU');
  const asProvider = resolve('2019_19_BUF_HOU');
  assert.equal(asProvider.round_key, 'divisional');
  assert.equal(asProvider.ambiguous, true);
  assert.deepEqual(asProvider.interpretations.map(i => i.round_key), ['divisional', 'wild_card']);

  const row = alias('2019_19_BUF_HOU', { spelling: 'legacy' });
  assert.equal(row.provider_id, '2019_18_BUF_HOU');
  assert.equal(row.ambiguous, true, 'the crosswalk must be trusted over the string');

  /* 2019 week 23 is not a provider week at all, so it is unambiguous. */
  const sb = alias('2019_23_SF_KC');
  assert.equal(sb.provider_id, '2019_21_SF_KC');
  assert.equal(sb.ambiguous, false);
});

test('round trip: provider id -> read -> same id', () => {
  for (const season of [2019, 2021, 2023, 2026]) {
    for (const round of [1, 2, 3, 4]) {
      const id = providerGameId({ season, seasonType: 'POST', round, away: 'AA', home: 'BB' });
      const read = resolve(id);
      assert.equal(read.round, round, id);
      assert.equal(providerGameId({ season: read.season, seasonType: 'POST', round: read.round, away: read.away, home: read.home }), id);
    }
  }
});

test('no stored identifier needs rewriting: the measured blast radius is zero', () => {
  /* Measured 2026-09-18 against Supabase, KV and R2: every stored game id is a
     2026 regular-season week (01-02). The crosswalk exists for the day a
     postseason id is issued, and for 2019-20 ids if history is ever loaded. */
  const schedule = readFileSync(new URL('../workers/nfl-schedule/schedule-2026.js', import.meta.url), 'utf8');
  const ids = [...schedule.matchAll(/"game_id":\s*"(\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3})"/g)].map(m => m[1]);
  assert.ok(ids.length >= 272, `expected the full committed schedule, found ${ids.length}`);
  const postseason = ids.filter(id => resolve(id).season_type === 'POST');
  assert.deepEqual(postseason, [], 'the committed schedule carries no postseason ids');
  for (const id of ids) assert.equal(isProviderSpelling(id), true, `${id} is already the provider spelling`);
});
