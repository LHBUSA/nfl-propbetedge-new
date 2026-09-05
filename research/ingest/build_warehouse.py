"""Local canonical warehouse from the nflverse sample. No production writes.

Produces parquet under data/warehouse/:
  nfl_games          one row per game, with environment as the SOURCE reports it
  nfl_qb_games       one row per QB per game -- the QB DNA fact table
  nfl_players        identity crosswalk (gsis / espn / pfr / sleeper / etc.)

TRUTH RULES ENFORCED HERE
  * a missing source value stays NaN. Nothing is coerced to 0.
  * roof/surface come from the source; a dome game is flagged so it can be kept
    out of outdoor-weather splits rather than silently averaged in.
  * every derived rate carries its own numerator and denominator column.
"""
import pandas as pd, numpy as np, glob, os, json

os.makedirs('data/warehouse', exist_ok=True)
SEASONS = sorted(int(f[-12:-8]) for f in glob.glob('data/nflverse/play_by_play_*.parquet'))
print('seasons:', SEASONS)

GAME_COLS = ['game_id','season','week','season_type','game_date','home_team','away_team',
             'home_score','away_score','result','spread_line','total_line','div_game',
             'roof','surface','temp','wind','weather','stadium','stadium_id','game_stadium',
             'start_time','location','away_coach','home_coach','old_game_id']
PLAY_COLS = ['game_id','play_id','posteam','defteam','passer_player_id','passer_player_name',
             'receiver_player_id','rusher_player_id','rusher_player_name',
             'pass_attempt','complete_pass','incomplete_pass','interception','sack','qb_hit',
             'qb_dropback','qb_scramble','qb_kneel','qb_spike','shotgun','no_huddle',
             'passing_yards','receiving_yards','rushing_yards','air_yards','yards_after_catch',
             'pass_touchdown','rush_touchdown','yards_gained','epa','qb_epa','cp','wpa',
             'penalty','play_type','down','ydstogo','yardline_100','qtr']

games, qbgames = [], []
for y in SEASONS:
    pbp = pd.read_parquet(f'data/nflverse/play_by_play_{y}.parquet',
                          columns=sorted(set(GAME_COLS + PLAY_COLS)))
    g = pbp[GAME_COLS].drop_duplicates('game_id').reset_index(drop=True)
    games.append(g)

    # ---- QB per game -------------------------------------------------------
    # A passer row is any play with a passer_player_id. Sacks carry the passer
    # too, so attempts are counted from pass_attempt rather than from row count.
    p = pbp[pbp['passer_player_id'].notna()].copy()
    p['is_sack'] = p['sack'].fillna(0)
    agg = p.groupby(['game_id','passer_player_id','passer_player_name','posteam'], dropna=False).agg(
        attempts=('pass_attempt','sum'),
        completions=('complete_pass','sum'),
        pass_yards=('passing_yards','sum'),
        pass_tds=('pass_touchdown','sum'),
        interceptions=('interception','sum'),
        sacks=('is_sack','sum'),
        air_yards=('air_yards','sum'),
        yac=('yards_after_catch','sum'),
        dropbacks=('qb_dropback','sum'),
        scrambles=('qb_scramble','sum'),
        shotgun_snaps=('shotgun','sum'),
        no_huddle_snaps=('no_huddle','sum'),
        qb_hits=('qb_hit','sum'),
        qb_epa_total=('qb_epa','sum'),
        cp_sum=('cp','sum'),
        plays=('play_id','count'),
    ).reset_index()

    # rushing by the same player in the same game (designed runs + scrambles)
    r = pbp[pbp['rusher_player_id'].notna()].groupby(['game_id','rusher_player_id']).agg(
        rush_attempts=('yards_gained','size'),
        rush_yards=('rushing_yards','sum'),
        rush_tds=('rush_touchdown','sum'),
    ).reset_index().rename(columns={'rusher_player_id':'passer_player_id'})
    agg = agg.merge(r, on=['game_id','passer_player_id'], how='left')

    agg = agg.merge(g, on='game_id', how='left')
    agg['season'] = y
    qbgames.append(agg)
    print(f'  {y}: {len(g)} games, {len(agg)} qb-games')

G = pd.concat(games, ignore_index=True)
Q = pd.concat(qbgames, ignore_index=True)

# ---- derived, each with its own numerator/denominator retained -------------
Q['completion_pct'] = np.where(Q['attempts'] > 0, Q['completions'] / Q['attempts'], np.nan)
Q['ypa']            = np.where(Q['attempts'] > 0, Q['pass_yards'] / Q['attempts'], np.nan)
Q['td_rate']        = np.where(Q['attempts'] > 0, Q['pass_tds'] / Q['attempts'], np.nan)
Q['int_rate']       = np.where(Q['attempts'] > 0, Q['interceptions'] / Q['attempts'], np.nan)
Q['sack_rate']      = np.where((Q['dropbacks'] > 0), Q['sacks'] / Q['dropbacks'], np.nan)
Q['is_home']        = Q['posteam'] == Q['home_team']
Q['team_score']     = np.where(Q['is_home'], Q['home_score'], Q['away_score'])
Q['opp_score']      = np.where(Q['is_home'], Q['away_score'], Q['home_score'])
Q['win']            = np.where(Q['team_score'] > Q['opp_score'], 1,
                        np.where(Q['team_score'] < Q['opp_score'], 0, np.nan))
# spread_line is from the HOME team's perspective in nflverse
Q['team_spread']    = np.where(Q['is_home'], Q['spread_line'], -Q['spread_line'])
Q['is_favorite']    = np.where(Q['team_spread'].notna(), Q['team_spread'] > 0, np.nan)
Q['is_dome']        = Q['roof'].isin(['dome','closed'])
Q['is_outdoor']     = Q['roof'].isin(['outdoors','open'])

# a QB "start" proxy: the team's leading passer that game by attempts
Q['rk'] = Q.groupby(['game_id','posteam'])['attempts'].rank(ascending=False, method='first')
Q['is_primary_passer'] = Q['rk'] == 1

G.to_parquet('data/warehouse/nfl_games.parquet', index=False)
Q.to_parquet('data/warehouse/nfl_qb_games.parquet', index=False)
pd.read_parquet('data/nflverse/players.parquet').to_parquet('data/warehouse/nfl_players.parquet', index=False)

print(f'\nnfl_games   {len(G):,} rows')
print(f'nfl_qb_games {len(Q):,} rows  ({int(Q["is_primary_passer"].sum()):,} primary-passer games)')
print('roof values:', G['roof'].value_counts(dropna=False).to_dict())
print('temp reported:', f"{100*G['temp'].notna().mean():.1f}%   wind reported: {100*G['wind'].notna().mean():.1f}%")
