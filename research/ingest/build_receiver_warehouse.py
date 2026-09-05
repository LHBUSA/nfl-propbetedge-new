"""Receiver-per-game facts from nflverse play-by-play. No production writes.

    python research/ingest/build_receiver_warehouse.py

Produces data/warehouse/:
  nfl_receiver_games.parquet          one row per (game, receiver)
  nfl_receiver_passer_games.parquet   one row per (game, receiver, passer)

COUNT RULES, stated because a receiver product lives or dies on them
  TARGET      a pass attempt, excluding two-point tries, carrying a
              SOURCE-SUPPLIED receiver_player_id. Never inferred from play
              text. Measured coverage is 88.7-90.4% of attempts, and ZERO
              completions lack an id — the uncovered plays are throwaways and
              batted balls, which genuinely have no intended receiver.
  RECEPTION   a target with complete_pass = 1.
  TEAM TARGETS the same rule applied to every receiver on that team in that
              game. It is the denominator for target share and is stored
              alongside it, never folded into a percentage.
  AIR YARDS   present on 100% of targets, including incompletions, which is
              why air-yards share is computable where the team denominator is
              positive.
  RECEIVING YARDS / YAC  null on an incompletion by construction; summed as
              zero-for-absent only across completions.

WITHHELD
  routes and route participation. Coverage is ~37% for 2019-2022, 100% for
  2023, and the file is NOT PUBLISHED for 2024-2025. A route metric built on
  that would describe whichever plays happened to be charted.
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
PLAY_COLS = ['game_id', 'play_id', 'posteam', 'defteam', 'pass_attempt',
             'two_point_attempt', 'complete_pass', 'receiver_player_id',
             'receiver_player_name', 'passer_player_id', 'receiving_yards',
             'air_yards', 'yards_after_catch', 'pass_touchdown', 'epa',
             'first_down', 'interception']

rec_games, pair_games = [], []
for y in SEASONS:
    pbp = pd.read_parquet(f'data/nflverse/play_by_play_{y}.parquet',
                          columns=sorted(set(GAME_COLS + PLAY_COLS)))
    g = pbp[GAME_COLS].drop_duplicates('game_id').reset_index(drop=True)

    # ---- TARGETS ---------------------------------------------------------
    tg = pbp[(pbp['pass_attempt'] == 1)
             & (pbp['two_point_attempt'] != 1)
             & (pbp['receiver_player_id'].notna())].copy()
    tg['reception'] = tg['complete_pass'].fillna(0)
    # receiving yards / YAC are null on an incompletion; that is a real absence,
    # so they are summed only where the pass was completed
    tg['rec_yards'] = np.where(tg['reception'] == 1, tg['receiving_yards'].fillna(0), 0)
    tg['yac'] = np.where(tg['reception'] == 1, tg['yards_after_catch'].fillna(0), 0)
    tg['rec_td'] = np.where(tg['reception'] == 1, tg['pass_touchdown'].fillna(0), 0)
    tg['rec_fd'] = np.where(tg['reception'] == 1, tg['first_down'].fillna(0), 0)

    # Group on the STABLE ID only. nflverse can carry two spellings of the same
    # player in one game ("M.Jones" and "M.Jones Jr." for 00-0029293), and
    # grouping on the name splits one receiver into two rows, understating both.
    # The name is a display label, chosen after the fact.
    agg = tg.groupby(['game_id', 'receiver_player_id', 'posteam'],
                     dropna=False).agg(
        targets=('play_id', 'count'),
        receptions=('reception', 'sum'),
        rec_yards=('rec_yards', 'sum'),
        rec_tds=('rec_td', 'sum'),
        first_downs=('rec_fd', 'sum'),
        air_yards=('air_yards', 'sum'),
        yac=('yac', 'sum'),
        target_epa=('epa', 'sum'),
        interceptions_on_target=('interception', 'sum'),
    ).reset_index()
    # the label the source used most often for this id in this game
    names = (tg.groupby(['game_id', 'receiver_player_id', 'posteam'])['receiver_player_name']
               .agg(lambda x: x.value_counts().index[0]).reset_index())
    agg = agg.merge(names, on=['game_id', 'receiver_player_id', 'posteam'], how='left')

    # ---- TEAM DENOMINATORS ----------------------------------------------
    team = tg.groupby(['game_id', 'posteam']).agg(
        team_targets=('play_id', 'count'),
        team_air_yards=('air_yards', 'sum'),
        team_rec_yards=('rec_yards', 'sum'),
    ).reset_index()
    agg = agg.merge(team, on=['game_id', 'posteam'], how='left')
    agg = agg.merge(g, on='game_id', how='left')
    agg['season'] = y
    rec_games.append(agg)

    # ---- RECEIVER x PASSER ----------------------------------------------
    # A receiver can be targeted by more than one passer in a game, so the
    # pairing is stored per (game, receiver, passer) rather than collapsed to
    # "the team's quarterback".
    pair = tg[tg['passer_player_id'].notna()].groupby(
        ['game_id', 'receiver_player_id', 'passer_player_id', 'posteam'], dropna=False).agg(
        targets=('play_id', 'count'),
        receptions=('reception', 'sum'),
        rec_yards=('rec_yards', 'sum'),
        rec_tds=('rec_td', 'sum'),
        air_yards=('air_yards', 'sum'),
        yac=('yac', 'sum'),
    ).reset_index()
    pair = pair.merge(g[['game_id', 'season', 'week', 'season_type', 'game_date',
                         'home_team', 'away_team']], on='game_id', how='left')
    pair['season'] = y
    pair_games.append(pair)

    print(f'  {y}: {len(g)} games, {len(agg)} receiver-games, {len(pair)} receiver-passer rows')

R = pd.concat(rec_games, ignore_index=True)
PP = pd.concat(pair_games, ignore_index=True)

# ---- derived, every rate keeping its own numerator and denominator --------
R['catch_rate'] = np.where(R['targets'] > 0, R['receptions'] / R['targets'], np.nan)
R['yards_per_target'] = np.where(R['targets'] > 0, R['rec_yards'] / R['targets'], np.nan)
R['yards_per_reception'] = np.where(R['receptions'] > 0, R['rec_yards'] / R['receptions'], np.nan)
R['target_share'] = np.where(R['team_targets'] > 0, R['targets'] / R['team_targets'], np.nan)
# air-yards share only where the team denominator is positive; a team with
# negative or zero aggregate air yards makes the ratio meaningless
R['air_yards_share'] = np.where(R['team_air_yards'] > 0,
                                R['air_yards'] / R['team_air_yards'], np.nan)
R['is_home'] = R['posteam'] == R['home_team']
R['opponent'] = np.where(R['is_home'], R['away_team'], R['home_team'])
R['team_score'] = np.where(R['is_home'], R['home_score'], R['away_score'])
R['opp_score'] = np.where(R['is_home'], R['away_score'], R['home_score'])
R['win'] = np.where(R['team_score'] > R['opp_score'], 1,
             np.where(R['team_score'] < R['opp_score'], 0, np.nan))
R['team_spread'] = np.where(R['is_home'], R['spread_line'], -R['spread_line'])
R['is_dome'] = R['roof'].isin(['dome', 'closed'])

# the team's leading target earner that game, a useful but NOT load-bearing flag
R['rk'] = R.groupby(['game_id', 'posteam'])['targets'].rank(ascending=False, method='first')
R['is_team_target_leader'] = R['rk'] == 1

R.to_parquet('data/warehouse/nfl_receiver_games.parquet', index=False)
PP.to_parquet('data/warehouse/nfl_receiver_passer_games.parquet', index=False)

print(f'\nnfl_receiver_games        {len(R):,} rows')
print(f'nfl_receiver_passer_games {len(PP):,} rows')
print(f'distinct receivers        {R["receiver_player_id"].nunique():,}')
# integrity: a receiver can never out-target his own team
bad = int((R['targets'] > R['team_targets']).sum())
print(f'rows where player targets exceed team targets: {bad}  (must be 0)')
share = R['target_share'].dropna()
print(f'target_share range: {share.min():.3f} - {share.max():.3f}')
# a pairing must never exceed the receiver-game it belongs to
chk = PP.groupby(['game_id', 'receiver_player_id'])['targets'].sum().reset_index()
chk = chk.merge(R[['game_id', 'receiver_player_id', 'targets']],
                on=['game_id', 'receiver_player_id'], how='inner', suffixes=('_pair', '_game'))
over = int((chk['targets_pair'] > chk['targets_game']).sum())
print(f'pairing rows exceeding their receiver-game: {over}  (must be 0)')
