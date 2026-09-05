"""Build the public QB DNA dataset artifact the APIs serve.

    python research/ingest/build_qbdna_dataset.py

Deterministic: the same warehouse produces the same bytes, so the artifact can
be hashed and a rebuild that changes nothing is visible as an unchanged hash.

INCLUSION
  A quarterback appears if EITHER
    * he has >= 8 primary-passer games inside the window, OR
    * he is on a current 2026 active roster / priced by the current market.
  The second rule is what puts a rookie with no NFL history into the product at
  all. He appears with zero games and the UI renders NFL SAMPLE UNAVAILABLE.
  College statistics are never substituted.

WINDOW HONESTY
  meta.data_through and meta.latest_completed_game are emitted so that no
  surface can imply a stale season is "current form". They are derived from the
  data, not configured.

COMPACT KEYS  (the artifact ships to the browser, so keys are short)
  g   game_id            pid passer gsis id     s  season        w  week
  st  season type        d   game date          t  team          h  home team
  a   away team          ha  is home (1/0)      att attempts     cmp completions
  py  pass yards         td  pass TDs           int interceptions
  sk  sacks              db  dropbacks          scr scrambles
  ay  air yards          yac yards after catch
  ra  rush attempts      ry  rush yards         rtd rush TDs
  epa qb EPA             win 1/0/null           spr team spread
  rf  roof               sf  surface            div divisional    ind indoor
  tf  temp F             wd  wind mph           sn snow cm        rn rain in
  ws  environment status kh  kickoff local hour v  venue
  ts  team score         os  opponent score     pp is primary passer
"""
import glob, hashlib, json, os, time
import numpy as np
import pandas as pd

OUT = 'data/dist/qb-dna-dataset.json'
MIN_PRIMARY_GAMES = 8

N = lambda v: None if v is None or (isinstance(v, float) and not np.isfinite(v)) else v


def jnum(v, nd=None):
    """A missing value stays None. It never becomes 0."""
    if v is None or (isinstance(v, (float, np.floating)) and not np.isfinite(float(v))):
        return None
    if pd.isna(v):
        return None
    f = float(v)
    if nd is not None:
        return round(f, nd)
    return int(f) if f.is_integer() else f


def field_availability():
    """MEASURED coverage per season, per participation/charting field.
       A season with no published file gets nulls - NOT zeros."""
    fields = ['offense_formation', 'offense_personnel', 'defense_personnel',
              'defenders_in_box', 'number_of_pass_rushers', 'ngs_air_yards',
              'time_to_throw', 'was_pressure', 'route', 'defense_man_zone_type',
              'defense_coverage_type']
    seasons = sorted(int(f[-12:-8]) for f in glob.glob('data/nflverse/play_by_play_*.parquet'))
    out = {}
    for y in seasons:
        row = {f: None for f in fields}
        part = f'data/nflverse/pbp_participation_{y}.parquet'
        ftn = f'data/nflverse/ftn_charting_{y}.parquet'
        for path in (part, ftn):
            if not os.path.exists(path):
                continue
            df = pd.read_parquet(path)
            for f in fields:
                if f in df.columns and len(df):
                    row[f] = round(100 * float(df[f].notna().mean()), 1)
        out[str(y)] = row
    return out


def main():
    Q = pd.read_parquet('data/warehouse/nfl_qb_games.parquet')
    E = pd.read_parquet('data/warehouse/nfl_game_environment.parquet')
    P = pd.read_parquet('data/warehouse/nfl_players.parquet')

    env = E.set_index('game_id').to_dict('index')

    # ---- who is included -------------------------------------------------
    primary = Q[Q['is_primary_passer']].groupby('passer_player_id').size()
    qualified = set(primary[primary >= MIN_PRIMARY_GAMES].index)

    active = {}
    apath = 'data/dist/active-qbs-2026.json'
    if os.path.exists(apath):
        with open(apath, encoding='utf-8') as fh:
            aud = json.load(fh)
        for r in aud['quarterbacks']:
            if not r.get('gsis_id'):
                continue
            prev = active.get(r['gsis_id'], {})
            active[r['gsis_id']] = {
                'team': r.get('team') or prev.get('team'),
                'market_priced': bool(r.get('market_priced')) or prev.get('market_priced', False),
                'roster_bucket': r.get('roster_bucket') or prev.get('roster_bucket'),
                'espn_id': r.get('espn_id') or prev.get('espn_id'),
                'experience_years': r.get('experience_years', prev.get('experience_years'))
            }
    include = qualified | set(active)
    print(f'qualified by history: {len(qualified)}   active 2026: {len(active)}   '
          f'union: {len(include)}')

    rows = []
    sel = Q[Q['passer_player_id'].isin(include)]
    for _, r in sel.iterrows():
        e = env.get(r['game_id'], {})
        indoor = bool(e.get('is_indoor_game')) if e else bool(r.get('is_dome'))
        rows.append({
            'g': r['game_id'], 'pid': r['passer_player_id'],
            's': int(r['season']), 'w': jnum(r['week']), 'st': r.get('season_type'),
            'd': str(r['game_date'])[:10], 't': r['posteam'],
            'h': r['home_team'], 'a': r['away_team'], 'ha': 1 if r['is_home'] else 0,
            'att': jnum(r['attempts']), 'cmp': jnum(r['completions']),
            'py': jnum(r['pass_yards']), 'td': jnum(r['pass_tds']),
            'int': jnum(r['interceptions']), 'sk': jnum(r['sacks']),
            'db': jnum(r['dropbacks']), 'scr': jnum(r['scrambles']),
            'ay': jnum(r['air_yards']), 'yac': jnum(r['yac']),
            'ra': jnum(r.get('rush_attempts')), 'ry': jnum(r.get('rush_yards')),
            'rtd': jnum(r.get('rush_tds')),
            'epa': jnum(r.get('qb_epa_total'), 2),
            'win': jnum(r.get('win')), 'spr': jnum(r.get('team_spread')),
            'rf': r.get('roof'), 'sf': r.get('surface'),
            'div': jnum(r.get('div_game')), 'ind': 1 if indoor else 0,
            'tf': jnum(e.get('om_temp_f'), 1), 'wd': jnum(e.get('om_wind_mph'), 1),
            'sn': jnum(e.get('om_snow_cm'), 2), 'rn': jnum(e.get('om_rain_in'), 3),
            'ws': e.get('om_status') or 'not_resolved',
            'kh': jnum(e.get('kick_hour_local')), 'v': e.get('venue_name'),
            'ts': jnum(r.get('team_score')), 'os': jnum(r.get('opp_score')),
            'pp': 1 if r['is_primary_passer'] else 0
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
            'position': p.get('position'),
            'games_in_dataset': n,
            # 2026 status. active_2026 with games_in_dataset 0 is exactly the
            # case the UI must render as NFL SAMPLE UNAVAILABLE.
            'active_2026': gsis in active,
            'team_2026': a.get('team'),
            'market_priced_2026': a.get('market_priced', False),
            'experience_years': a.get('experience_years')
        })

    seasons = sorted({r['s'] for r in rows})
    latest = max(rows, key=lambda r: r['d'])
    availability = field_availability()

    meta = {
        'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'seasons': seasons,
        # The two fields that stop any surface implying a stale season is current.
        'data_through': latest['d'],
        'latest_completed_game': {
            'game_id': latest['g'], 'date': latest['d'], 'season': latest['s'],
            'week': latest['w'], 'season_type': latest['st'],
            'matchup': f"{latest['a']} @ {latest['h']}"
        },
        'latest_season': seasons[-1],
        'qb_games': len(rows),
        'players': len(players),
        'players_with_history': len(played),
        'players_zero_history': len(players) - len(played),
        'inclusion_rule': (f'>= {MIN_PRIMARY_GAMES} primary-passer games in the window, '
                           'OR on a current 2026 active roster / priced by the current market'),
        'seasons_without_play_by_play': [
            y for y in (2026,) if not os.path.exists(f'data/nflverse/play_by_play_{y}.parquet')],
        'field_availability_by_season': availability,
        'sources': [
            {'name': 'nflverse play-by-play, schedules and players',
             'url': 'https://github.com/nflverse/nflverse-data',
             'licence': 'CC-BY-4.0',
             'attribution': 'Data by nflverse, licensed CC BY 4.0'},
            {'name': 'Open-Meteo historical weather archive',
             'url': 'https://archive-api.open-meteo.com/',
             'licence': 'CC-BY-4.0',
             'attribution': 'Weather data by Open-Meteo.com, licensed CC BY 4.0'},
            {'name': 'ESPN public team, venue and schedule endpoints',
             'url': 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/',
             'licence': 'public endpoint',
             'attribution': 'Schedule and venue context from ESPN public endpoints'}
        ]
    }

    os.makedirs('data/dist', exist_ok=True)
    payload = {'meta': meta, 'players': players, 'qb_games': rows}
    blob = json.dumps(payload, separators=(',', ':'), sort_keys=False)
    with open(OUT, 'w', encoding='utf-8') as fh:
        fh.write(blob)
    digest = hashlib.sha256(blob.encode()).hexdigest()[:16]

    print(f'\n{OUT}: {len(blob):,} bytes')
    print(f'  seasons        {seasons}')
    print(f'  data_through   {meta["data_through"]}  ({meta["latest_completed_game"]["matchup"]}'
          f' {meta["latest_completed_game"]["season_type"]} wk {meta["latest_completed_game"]["week"]})')
    print(f'  qb_games       {len(rows):,}')
    print(f'  players        {len(players)}  '
          f'({meta["players_with_history"]} with history, '
          f'{meta["players_zero_history"]} zero-history)')
    print(f'  no pbp for     {meta["seasons_without_play_by_play"]}')
    print(f'  sha256         {digest}')


if __name__ == '__main__':
    main()
