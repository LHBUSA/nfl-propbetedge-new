"""Running-back-per-game facts. No production writes.

    python research/ingest/build_rb_warehouse.py

Produces data/warehouse/nfl_running_back_games.parquet — one row per (game, back),
merging the rushing side with the receiving side, because a modern back is both
and reporting either alone misstates his usage.

COUNT RULES
  CARRY      a rush attempt with a SOURCE-SUPPLIED rusher id, excluding
             two-point tries and quarterback kneels. A kneel is a clock event,
             not a carry; counting it would drag a back's average down and is
             not something a reader would ever mean by "carries".
             Measured rusher-id coverage: 100% of qualifying attempts.
  TARGET     the receiver rule, unchanged from the receiver warehouse: a pass
             attempt with a source-supplied receiver id.
  TOUCH      carries + receptions. Not carries + targets — an uncaught pass is
             not a touch.
  CARRY SHARE   player carries over that team's carries in the same game.
  TARGET SHARE  player targets over that team's targets in the same game.
             Both numerators and denominators are stored.

WITHHELD
  snap share and route participation. The participation file is ~37% covered
  for 2019-2022 and NOT PUBLISHED for 2024-2025, so a snap-share number would
  describe whichever plays happened to be charted.
"""
import glob, os
import numpy as np
import pandas as pd

os.makedirs('data/warehouse', exist_ok=True)
SEASONS = sorted(int(f[-12:-8]) for f in glob.glob('data/nflverse/play_by_play_*.parquet'))
print('seasons:', SEASONS)

GAME_COLS = ['game_id', 'season', 'week', 'season_type', 'game_date', 'home_team',
             'away_team', 'home_score', 'away_score', 'result', 'spread_line',
             'total_line', 'div_game', 'roof', 'surface', 'start_time']
PLAY_COLS = ['game_id', 'play_id', 'posteam', 'rush_attempt', 'pass_attempt',
             'two_point_attempt', 'qb_kneel', 'rusher_player_id', 'rusher_player_name',
             'rushing_yards', 'rush_touchdown', 'complete_pass', 'receiver_player_id',
             'receiving_yards', 'yards_after_catch', 'air_yards', 'pass_touchdown',
             'first_down', 'epa', 'yardline_100', 'fumble_lost']

rows = []
for y in SEASONS:
    pbp = pd.read_parquet(f'data/nflverse/play_by_play_{y}.parquet',
                          columns=sorted(set(GAME_COLS + PLAY_COLS)))
    g = pbp[GAME_COLS].drop_duplicates('game_id').reset_index(drop=True)

    # ---- RUSHING ---------------------------------------------------------
    ru = pbp[(pbp['rush_attempt'] == 1)
             & (pbp['two_point_attempt'] != 1)
             & (pbp['qb_kneel'] != 1)
             & (pbp['rusher_player_id'].notna())].copy()
    ru['rz_carry'] = np.where(ru['yardline_100'].notna() & (ru['yardline_100'] <= 20), 1, 0)
    ru['rz_rush_td'] = ru['rz_carry'] * ru['rush_touchdown'].fillna(0)
    rush = ru.groupby(['game_id', 'rusher_player_id', 'posteam'], dropna=False).agg(
        carries=('play_id', 'count'),
        rush_yards=('rushing_yards', 'sum'),
        rush_tds=('rush_touchdown', 'sum'),
        rush_epa=('epa', 'sum'),
        rush_first_downs=('first_down', 'sum'),
        rz_carries=('rz_carry', 'sum'),
        rz_rush_tds=('rz_rush_td', 'sum'),
        fumbles_lost=('fumble_lost', 'sum'),
    ).reset_index().rename(columns={'rusher_player_id': 'player_id'})
    # the display label the source used most often for this id in this game
    names = (ru.groupby(['game_id', 'rusher_player_id', 'posteam'])['rusher_player_name']
               .agg(lambda x: x.value_counts().index[0]).reset_index()
               .rename(columns={'rusher_player_id': 'player_id',
                                'rusher_player_name': 'player_name'}))
    rush = rush.merge(names, on=['game_id', 'player_id', 'posteam'], how='left')

    team_rush = ru.groupby(['game_id', 'posteam']).agg(
        team_carries=('play_id', 'count'),
        team_rush_yards=('rushing_yards', 'sum'),
    ).reset_index()

    # ---- RECEIVING (same rule as the receiver warehouse) ------------------
    tg = pbp[(pbp['pass_attempt'] == 1)
             & (pbp['two_point_attempt'] != 1)
             & (pbp['receiver_player_id'].notna())].copy()
    tg['reception'] = tg['complete_pass'].fillna(0)
    tg['rec_yards'] = np.where(tg['reception'] == 1, tg['receiving_yards'].fillna(0), 0)
    tg['yac'] = np.where(tg['reception'] == 1, tg['yards_after_catch'].fillna(0), 0)
    tg['rec_td'] = np.where(tg['reception'] == 1, tg['pass_touchdown'].fillna(0), 0)
    rec = tg.groupby(['game_id', 'receiver_player_id', 'posteam'], dropna=False).agg(
        targets=('play_id', 'count'),
        receptions=('reception', 'sum'),
        rec_yards=('rec_yards', 'sum'),
        rec_tds=('rec_td', 'sum'),
        air_yards=('air_yards', 'sum'),
        yac=('yac', 'sum'),
    ).reset_index().rename(columns={'receiver_player_id': 'player_id'})
    team_tgt = tg.groupby(['game_id', 'posteam']).agg(
        team_targets=('play_id', 'count')).reset_index()

    # A back who only caught passes in a game still played that game, so the
    # two sides are joined with an OUTER merge rather than a rushing-only base.
    both = rush.merge(rec, on=['game_id', 'player_id', 'posteam'], how='outer')
    both = both.merge(team_rush, on=['game_id', 'posteam'], how='left')
    both = both.merge(team_tgt, on=['game_id', 'posteam'], how='left')
    both = both.merge(g, on='game_id', how='left')
    both['season'] = y
    rows.append(both)
    print(f'  {y}: {len(g)} games, {len(both)} player-games with a carry or a target')

R = pd.concat(rows, ignore_index=True)

# a player with no carries genuinely had zero carries in that game; the same
# for targets. These are real zeros, not missing values.
for c in ['carries', 'rush_yards', 'rush_tds', 'rz_carries', 'rz_rush_tds',
          'rush_first_downs', 'fumbles_lost', 'targets', 'receptions', 'rec_yards',
          'rec_tds', 'air_yards', 'yac']:
    R[c] = R[c].fillna(0)

R['touches'] = R['carries'] + R['receptions']
R['scrimmage_yards'] = R['rush_yards'] + R['rec_yards']
R['total_tds'] = R['rush_tds'] + R['rec_tds']

# every rate keeps its own numerator and denominator; a zero denominator is
# not a zero result
R['yards_per_carry'] = np.where(R['carries'] > 0, R['rush_yards'] / R['carries'], np.nan)
R['yards_per_target'] = np.where(R['targets'] > 0, R['rec_yards'] / R['targets'], np.nan)
R['yards_per_reception'] = np.where(R['receptions'] > 0, R['rec_yards'] / R['receptions'], np.nan)
R['catch_rate'] = np.where(R['targets'] > 0, R['receptions'] / R['targets'], np.nan)
R['carry_share'] = np.where(R['team_carries'] > 0, R['carries'] / R['team_carries'], np.nan)
R['target_share'] = np.where(R['team_targets'] > 0, R['targets'] / R['team_targets'], np.nan)

R['is_home'] = R['posteam'] == R['home_team']
R['opponent'] = np.where(R['is_home'], R['away_team'], R['home_team'])
R['team_score'] = np.where(R['is_home'], R['home_score'], R['away_score'])
R['opp_score'] = np.where(R['is_home'], R['away_score'], R['home_score'])
R['win'] = np.where(R['team_score'] > R['opp_score'], 1,
            np.where(R['team_score'] < R['opp_score'], 0, np.nan))
R['team_spread'] = np.where(R['is_home'], R['spread_line'], -R['spread_line'])
R['is_dome'] = R['roof'].isin(['dome', 'closed'])
R['rk'] = R.groupby(['game_id', 'posteam'])['carries'].rank(ascending=False, method='first')
R['is_team_carry_leader'] = R['rk'] == 1

R.to_parquet('data/warehouse/nfl_running_back_games.parquet', index=False)

print(f'\nnfl_running_back_games  {len(R):,} rows')
print(f'distinct players        {R["player_id"].nunique():,}')
print(f'rows where carries exceed team carries: {int((R["carries"] > R["team_carries"]).sum())}  (must be 0)')
print(f'rows where targets exceed team targets: {int((R["targets"] > R["team_targets"]).sum())}  (must be 0)')
print(f'rows where receptions exceed targets:   {int((R["receptions"] > R["targets"]).sum())}  (must be 0)')
print(f'rows where red-zone carries exceed carries: {int((R["rz_carries"] > R["carries"]).sum())}  (must be 0)')
print(f'rows with neither a carry nor a target: {int(((R["carries"] == 0) & (R["targets"] == 0)).sum())}  (must be 0)')
cs = R['carry_share'].dropna()
print(f'carry_share range: {cs.min():.3f} - {cs.max():.3f}')
