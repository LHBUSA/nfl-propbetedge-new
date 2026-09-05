"""Build the public RB DNA dataset the APIs serve.

    python research/ingest/build_rbdna_dataset.py

COMPACT KEYS
  g game_id  pid player  s season  w week  st season type  d date  t team
  h home  a away  ha is home  opp opponent
  car carries      ry rush yards   rtd rush TDs   rzc red-zone carries
  rztd red-zone rush TDs           fd rush first downs        fum fumbles lost
  tg targets  rec receptions  recy rec yards  rectd rec TDs  ay air yards  yac
  tc team carries  tt team targets
  win  spr team spread  rf roof  sf surface  div divisional  ind indoor
  tf temp F  wd wind mph  sn snow cm  rn rain in  ws env status
  kh kickoff local hour  v venue  lead team carry leader
"""
import hashlib, json, os, time
import numpy as np
import pandas as pd

OUT = 'data/dist/rb-dna-dataset.json'
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
    R = pd.read_parquet('data/warehouse/nfl_running_back_games.parquet')
    E = pd.read_parquet('data/warehouse/nfl_game_environment.parquet')
    P = pd.read_parquet('data/warehouse/nfl_players.parquet')
    env = E.set_index('game_id').to_dict('index')

    # RB ONLY. Position comes from player metadata, never from how a player was
    # used: a quarterback with a scramble is not a running back, and including
    # him would wreck every carry-share denominator's meaning.
    rb_ids = set(P[P['position'] == 'RB']['gsis_id'].dropna())
    R = R[R['player_id'].isin(rb_ids)].copy()
    print(f'RB-only player-games: {len(R):,}')

    counts = R.groupby('player_id').size()
    qualified = set(counts[counts >= MIN_GAMES].index)

    active = {}
    apath = 'data/dist/active-rbs-2026.json'
    if os.path.exists(apath):
        with open(apath, encoding='utf-8') as fh:
            aud = json.load(fh)
        for r in (aud.get('players') or []):
            if not r.get('gsis_id'):
                continue
            prev = active.get(r['gsis_id'], {})
            active[r['gsis_id']] = {
                'team': r.get('team') or prev.get('team'),
                'market_priced': bool(r.get('market_priced')) or prev.get('market_priced', False),
                'espn_id': r.get('espn_id') or prev.get('espn_id'),
                'experience_years': r.get('experience_years', prev.get('experience_years')),
            }
    include = (qualified | set(active)) & (rb_ids | set(active))
    print(f'qualified by history: {len(qualified)}   active 2026 RBs: {len(active)}   '
          f'union: {len(include)}')

    sel = R[R['player_id'].isin(include)]
    rows = []
    for _, r in sel.iterrows():
        e = env.get(r['game_id'], {})
        indoor = bool(e.get('is_indoor_game')) if e else bool(r.get('is_dome'))
        rows.append({
            'g': r['game_id'], 'pid': r['player_id'],
            's': int(r['season']), 'w': jnum(r['week']), 'st': r.get('season_type'),
            'd': str(r['game_date'])[:10], 't': r['posteam'],
            'h': r['home_team'], 'a': r['away_team'],
            'ha': 1 if r['is_home'] else 0, 'opp': r['opponent'],
            'car': jnum(r['carries']), 'ry': jnum(r['rush_yards']), 'rtd': jnum(r['rush_tds']),
            'rzc': jnum(r['rz_carries']), 'rztd': jnum(r['rz_rush_tds']),
            'fd': jnum(r['rush_first_downs']), 'fum': jnum(r['fumbles_lost']),
            'tg': jnum(r['targets']), 'rec': jnum(r['receptions']),
            'recy': jnum(r['rec_yards']), 'rectd': jnum(r['rec_tds']),
            'ay': jnum(r['air_yards']), 'yac': jnum(r['yac']),
            'tc': jnum(r['team_carries']), 'tt': jnum(r['team_targets']),
            'win': jnum(r['win']), 'spr': jnum(r['team_spread']),
            'rf': r.get('roof'), 'sf': r.get('surface'),
            'div': jnum(r.get('div_game')), 'ind': 1 if indoor else 0,
            'tf': jnum(e.get('om_temp_f'), 1), 'wd': jnum(e.get('om_wind_mph'), 1),
            'sn': jnum(e.get('om_snow_cm'), 2), 'rn': jnum(e.get('om_rain_in'), 3),
            'ws': e.get('om_status') or 'not_resolved',
            'kh': jnum(e.get('kick_hour_local')), 'v': e.get('venue_name'),
            'lead': 1 if r.get('is_team_carry_leader') else 0,
        })
    rows.sort(key=lambda x: (x['pid'], x['d'], x['g']))

    played = {r['pid'] for r in rows}
    pmap = P.set_index('gsis_id').to_dict('index')
    players = []
    for gsis in sorted(include):
        p = pmap.get(gsis, {})
        a = active.get(gsis, {})
        n = len([r for r in rows if r['pid'] == gsis])
        players.append({
            'gsis_id': gsis,
            'display_name': p.get('display_name') or gsis,
            'espn_id': (str(p['espn_id']).split('.')[0]
                        if p.get('espn_id') and pd.notna(p.get('espn_id'))
                        else (a.get('espn_id') or None)),
            'pfr_id': p.get('pfr_id') if p.get('pfr_id') and pd.notna(p.get('pfr_id')) else None,
            'position': p.get('position') or 'RB',
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
        'product': 'RB DNA',
        'position_scope': 'RB only. Fullbacks, receivers and quarterbacks are excluded '
                          'from the product but remain in the team denominators, so '
                          'carry share means share of all of a team\'s carries.',
        'seasons': seasons,
        'data_through': latest['d'],
        'latest_completed_game': {
            'game_id': latest['g'], 'date': latest['d'], 'season': latest['s'],
            'week': latest['w'], 'season_type': latest['st'],
            'matchup': f"{latest['a']} @ {latest['h']}"},
        'latest_season': seasons[-1],
        'player_games': len(rows),
        'players': len(players),
        'players_with_history': len(played),
        'players_zero_history': len(players) - len(played),
        'inclusion_rule': f'>= {MIN_GAMES} games in the window, OR on a current 2026 RB '
                          'roster / priced by the current market',
        'seasons_without_play_by_play': [
            y for y in (2026,) if not os.path.exists(f'data/nflverse/play_by_play_{y}.parquet')],
        'count_rules': {
            'carry': 'a rush attempt with a source-supplied rusher id, excluding '
                     'two-point tries and quarterback kneels. A kneel is a clock event, '
                     'not a carry. Measured rusher-id coverage: 100%.',
            'touch': 'carries plus receptions. Not carries plus targets — an uncaught '
                     'pass is not a touch.',
            'carry_share': 'player carries over that team\'s carries in the same game; '
                           'both numbers are retained',
            'target_share': 'player targets over that team\'s targets in the same game',
            'red_zone_carry': 'a carry whose source-supplied yardline is inside the '
                              'opponent twenty',
        },
        'withheld_fields': [
            {'field': 'snap share',
             'reason': 'requires the nflverse participation file, which is ~37% covered '
                       'for 2019-2022 and NOT PUBLISHED for 2024-2025. A snap share on '
                       'that would describe whichever plays were charted.'},
            {'field': 'routes run',
             'reason': 'same participation file, withheld for the same reason'},
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
    blob = json.dumps({'meta': meta, 'players': players, 'player_games': rows},
                      separators=(',', ':'))
    with open(OUT, 'w', encoding='utf-8') as fh:
        fh.write(blob)
    print(f'\n{OUT}: {len(blob):,} bytes')
    print(f'  seasons        {seasons}')
    print(f'  data_through   {meta["data_through"]}')
    print(f'  player-games   {len(rows):,}')
    print(f'  players        {len(players)} ({meta["players_with_history"]} with history, '
          f'{meta["players_zero_history"]} zero-history)')
    print(f'  sha256         {hashlib.sha256(blob.encode()).hexdigest()[:16]}')


if __name__ == '__main__':
    main()
