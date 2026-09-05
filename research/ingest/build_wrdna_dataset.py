"""Build the public WR DNA dataset the APIs serve.

    python research/ingest/build_wrdna_dataset.py

Same shape and discipline as the quarterback artifact: compact keys, measured
coverage, explicit window, and nothing inferred.

INCLUSION
  a receiver appears if he has >= 8 games in the window, OR he is on a current
  2026 WR roster / priced by the current receiving market. The second rule is
  what puts a rookie with no NFL history into the product at all; he appears
  with zero games and the surface renders NFL SAMPLE UNAVAILABLE.

COMPACT KEYS
  g game_id   pid receiver gsis   s season   w week   st season type
  d date      t team        h home  a away   ha is home  opp opponent
  tg targets  rec receptions  ry rec yards  rtd rec TDs  fd first downs
  ay air yards  yac yards after catch  epa target EPA
  tt team targets  tay team air yards
  win 1/0/null  spr team spread  rf roof  sf surface  div divisional
  ind indoor   tf temp F  wd wind mph  sn snow cm  rn rain in
  ws environment status  kh kickoff local hour  v venue  lead team target leader
"""
import json, os, time, hashlib
import numpy as np
import pandas as pd

OUT = 'data/dist/wr-dna-dataset.json'
MIN_GAMES = 8


def jnum(v, nd=None):
    """A missing value stays None. It never becomes 0."""
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    f = float(v)
    if not np.isfinite(f):
        return None
    if nd is not None:
        return round(f, nd)
    return int(f) if f.is_integer() else f


def main():
    R = pd.read_parquet('data/warehouse/nfl_receiver_games.parquet')
    PP = pd.read_parquet('data/warehouse/nfl_receiver_passer_games.parquet')
    E = pd.read_parquet('data/warehouse/nfl_game_environment.parquet')
    P = pd.read_parquet('data/warehouse/nfl_players.parquet')
    env = E.set_index('game_id').to_dict('index')

    # ---- WR ONLY -----------------------------------------------------------
    # Position comes from player metadata, not from how a player was used. A
    # tight end with receptions is still a tight end, and mixing him in would
    # silently change what every target-share number means.
    wr_ids = set(P[P['position'] == 'WR']['gsis_id'].dropna())
    R = R[R['receiver_player_id'].isin(wr_ids)].copy()
    print(f'WR-only receiver-games: {len(R):,}')

    counts = R.groupby('receiver_player_id').size()
    qualified = set(counts[counts >= MIN_GAMES].index)

    active = {}
    apath = 'data/dist/active-wrs-2026.json'
    if os.path.exists(apath):
        with open(apath, encoding='utf-8') as fh:
            aud = json.load(fh)
        for r in aud['receivers']:
            if not r.get('gsis_id'):
                continue
            prev = active.get(r['gsis_id'], {})
            active[r['gsis_id']] = {
                'team': r.get('team') or prev.get('team'),
                'market_priced': bool(r.get('market_priced')) or prev.get('market_priced', False),
                'espn_id': r.get('espn_id') or prev.get('espn_id'),
                'experience_years': r.get('experience_years', prev.get('experience_years')),
            }
    include = (qualified | set(active)) & (wr_ids | set(active))
    print(f'qualified by history: {len(qualified)}   active 2026 WRs: {len(active)}   '
          f'union: {len(include)}')

    sel = R[R['receiver_player_id'].isin(include)]
    rows = []
    for _, r in sel.iterrows():
        e = env.get(r['game_id'], {})
        indoor = bool(e.get('is_indoor_game')) if e else bool(r.get('is_dome'))
        rows.append({
            'g': r['game_id'], 'pid': r['receiver_player_id'],
            's': int(r['season']), 'w': jnum(r['week']), 'st': r.get('season_type'),
            'd': str(r['game_date'])[:10], 't': r['posteam'],
            'h': r['home_team'], 'a': r['away_team'],
            'ha': 1 if r['is_home'] else 0, 'opp': r['opponent'],
            'tg': jnum(r['targets']), 'rec': jnum(r['receptions']),
            'ry': jnum(r['rec_yards']), 'rtd': jnum(r['rec_tds']),
            'fd': jnum(r['first_downs']),
            'ay': jnum(r['air_yards']), 'yac': jnum(r['yac']),
            'epa': jnum(r['target_epa'], 2),
            'tt': jnum(r['team_targets']), 'tay': jnum(r['team_air_yards']),
            'win': jnum(r['win']), 'spr': jnum(r['team_spread']),
            'rf': r.get('roof'), 'sf': r.get('surface'),
            'div': jnum(r.get('div_game')), 'ind': 1 if indoor else 0,
            'tf': jnum(e.get('om_temp_f'), 1), 'wd': jnum(e.get('om_wind_mph'), 1),
            'sn': jnum(e.get('om_snow_cm'), 2), 'rn': jnum(e.get('om_rain_in'), 3),
            'ws': e.get('om_status') or 'not_resolved',
            'kh': jnum(e.get('kick_hour_local')), 'v': e.get('venue_name'),
            'lead': 1 if r.get('is_team_target_leader') else 0,
        })
    rows.sort(key=lambda x: (x['pid'], x['d'], x['g']))

    # ---- receiver x passer pairings ----------------------------------------
    PPs = PP[PP['receiver_player_id'].isin(include)]
    pmap_all = P.set_index('gsis_id').to_dict('index')
    pairs = []
    for _, r in PPs.iterrows():
        passer = pmap_all.get(r['passer_player_id'], {})
        pairs.append({
            'g': r['game_id'], 'pid': r['receiver_player_id'],
            'qb': r['passer_player_id'],
            'qbn': passer.get('display_name') or r['passer_player_id'],
            'qbe': (str(passer['espn_id']).split('.')[0]
                    if passer.get('espn_id') and pd.notna(passer.get('espn_id')) else None),
            's': int(r['season']), 'd': str(r['game_date'])[:10], 't': r['posteam'],
            'tg': jnum(r['targets']), 'rec': jnum(r['receptions']),
            'ry': jnum(r['rec_yards']), 'rtd': jnum(r['rec_tds']),
            'ay': jnum(r['air_yards']), 'yac': jnum(r['yac']),
        })
    pairs.sort(key=lambda x: (x['pid'], x['d']))

    played = {r['pid'] for r in rows}
    players = []
    for gsis in sorted(include):
        p = pmap_all.get(gsis, {})
        a = active.get(gsis, {})
        n = len([r for r in rows if r['pid'] == gsis])
        players.append({
            'gsis_id': gsis,
            'display_name': p.get('display_name') or gsis,
            'espn_id': (str(p['espn_id']).split('.')[0]
                        if p.get('espn_id') and pd.notna(p.get('espn_id'))
                        else (a.get('espn_id') or None)),
            'pfr_id': p.get('pfr_id') if p.get('pfr_id') and pd.notna(p.get('pfr_id')) else None,
            'position': p.get('position') or 'WR',
            'games_in_dataset': n,
            'active_2026': gsis in active,
            'team_2026': a.get('team'),
            'market_priced_2026': a.get('market_priced', False),
            'experience_years': a.get('experience_years'),
        })

    seasons = sorted({r['s'] for r in rows})
    latest = max(rows, key=lambda r: r['d'])
    meta = {
        'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'product': 'WR DNA',
        'position_scope': 'WR only. Tight ends and running backs are excluded, so '
                          'target share always means share among a team\'s targeted '
                          'players as counted here.',
        'seasons': seasons,
        'data_through': latest['d'],
        'latest_completed_game': {
            'game_id': latest['g'], 'date': latest['d'], 'season': latest['s'],
            'week': latest['w'], 'season_type': latest['st'],
            'matchup': f"{latest['a']} @ {latest['h']}"},
        'latest_season': seasons[-1],
        'receiver_games': len(rows),
        'receiver_passer_rows': len(pairs),
        'players': len(players),
        'players_with_history': len(played),
        'players_zero_history': len(players) - len(played),
        'inclusion_rule': f'>= {MIN_GAMES} games in the window, OR on a current 2026 '
                          'WR roster / priced by the current receiving market',
        'seasons_without_play_by_play': [
            y for y in (2026,) if not os.path.exists(f'data/nflverse/play_by_play_{y}.parquet')],
        'count_rules': {
            'target': 'a pass attempt, excluding two-point tries, carrying a '
                      'source-supplied receiver id. Never inferred from play text.',
            'reception': 'a target with complete_pass = 1',
            'target_share': 'player targets over that team\'s targets in the same game; '
                            'both numbers are retained',
            'receiving_yards': 'null on an incompletion by construction, so per-game '
                               'totals sum only over completions',
        },
        'withheld_fields': [
            {'field': 'routes / route participation',
             'reason': 'coverage is ~37% for 2019-2022, 100% for 2023, and the '
                       'participation file is NOT PUBLISHED for 2024-2025. A route '
                       'metric on that would describe whichever plays were charted.'},
            {'field': 'snap share',
             'reason': 'requires the same participation file; withheld for the same reason'},
        ],
        'sources': [
            {'name': 'nflverse play-by-play, schedules and players',
             'url': 'https://github.com/nflverse/nflverse-data', 'licence': 'CC-BY-4.0',
             'attribution': 'Data by nflverse, licensed CC BY 4.0'},
            {'name': 'Open-Meteo historical weather archive',
             'url': 'https://archive-api.open-meteo.com/', 'licence': 'CC-BY-4.0',
             'attribution': 'Weather data by Open-Meteo.com, licensed CC BY 4.0'},
            {'name': 'ESPN public team, venue and schedule endpoints',
             'url': 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/',
             'licence': 'public endpoint',
             'attribution': 'Schedule and venue context from ESPN public endpoints'},
        ],
    }

    os.makedirs('data/dist', exist_ok=True)
    payload = {'meta': meta, 'players': players, 'receiver_games': rows, 'pairings': pairs}
    blob = json.dumps(payload, separators=(',', ':'))
    with open(OUT, 'w', encoding='utf-8') as fh:
        fh.write(blob)
    print(f'\n{OUT}: {len(blob):,} bytes')
    print(f'  seasons        {seasons}')
    print(f'  data_through   {meta["data_through"]}')
    print(f'  receiver-games {len(rows):,}')
    print(f'  pairings       {len(pairs):,}')
    print(f'  players        {len(players)} ({meta["players_with_history"]} with history, '
          f'{meta["players_zero_history"]} zero-history)')
    print(f'  sha256         {hashlib.sha256(blob.encode()).hexdigest()[:16]}')


if __name__ == '__main__':
    main()
