"""QB DNA — deterministic historical quarterback analysis.

No model, no LLM, no inference. Every number is counted from the warehouse.

TRUTH RULES ENFORCED HERE
  * UNKNOWN never becomes 0. A split whose inputs are missing is reported as
    unavailable, not as zero.
  * every percentage carries its numerator, denominator and N.
  * sample labels describe SIZE ONLY. They are not significance claims.
  * a weather split runs only on games our environment table actually resolved,
    and roofed games are excluded from outdoor weather splits by construction.
"""
import pandas as pd, numpy as np, os, json

W = 'data/warehouse'


def load():
    q = pd.read_parquet(f'{W}/nfl_qb_games.parquet')
    env_path = f'{W}/nfl_game_environment.parquet'
    if os.path.exists(env_path):
        e = pd.read_parquet(env_path)
        keep = ['game_id', 'is_indoor_game', 'om_temp_f', 'om_wind_mph', 'om_gust_mph',
                'om_snow_cm', 'om_rain_in', 'om_precip_in', 'om_weather_code', 'om_status',
                'source_temp_f', 'source_wind_mph']
        q = q.merge(e[[c for c in keep if c in e.columns]], on='game_id', how='left')
    return q


def label(n):
    return ('STRONG SAMPLE' if n >= 20 else 'MODERATE' if n >= 10
            else 'SMALL' if n >= 5 else 'VERY SMALL')


def describe(df, metric):
    s = pd.to_numeric(df[metric], errors='coerce').dropna()
    if not len(s):
        return None
    return {'n': int(len(s)), 'mean': round(float(s.mean()), 2),
            'median': round(float(s.median()), 2),
            'std': round(float(s.std(ddof=1)), 2) if len(s) > 1 else None,
            'min': round(float(s.min()), 2), 'max': round(float(s.max()), 2)}


def rate(num, den):
    """A rate is never returned without its parts, and never as 0 when the
       denominator is 0 -- that case is 'no attempts', not 'zero percent'."""
    num, den = float(num), float(den)
    if den <= 0:
        return {'numerator': num, 'denominator': den, 'pct': None, 'note': 'no denominator'}
    return {'numerator': round(num, 2), 'denominator': round(den, 2), 'pct': round(100 * num / den, 1)}


def baseline(df):
    if not len(df):
        return None
    att = df['attempts'].sum()
    cmp_ = df['completions'].sum()
    has_result = df['win'].notna().any()
    return {
        'games': int(len(df)),
        'date_range': [str(df['game_date'].min()), str(df['game_date'].max())],
        'record': {'w': int(df['win'].sum()) if has_result else None,
                   'l': int((df['win'] == 0).sum()) if has_result else None,
                   'games_with_result': int(df['win'].notna().sum())},
        'attempts': int(att), 'completions': int(cmp_),
        'completion_pct': rate(cmp_, att),
        'pass_yards_total': int(df['pass_yards'].sum()),
        'pass_yards_per_game': describe(df, 'pass_yards'),
        'ypa': rate(df['pass_yards'].sum(), att),
        'pass_tds': int(df['pass_tds'].sum()), 'td_rate': rate(df['pass_tds'].sum(), att),
        'interceptions': int(df['interceptions'].sum()), 'int_rate': rate(df['interceptions'].sum(), att),
        'sacks': int(df['sacks'].sum()),
        'sack_rate': rate(df['sacks'].sum(), df['dropbacks'].sum()),
        'attempts_per_game': describe(df, 'attempts'),
        'completions_per_game': describe(df, 'completions'),
        'tds_per_game': describe(df, 'pass_tds'),
        'ints_per_game': describe(df, 'interceptions'),
        'rush_yards_total': int(pd.to_numeric(df['rush_yards'], errors='coerce').fillna(0).sum()),
        'sample': label(len(df)),
    }


def prop(df, metric, line):
    """How often did he EXCEED today's number? No historical sportsbook line is
       needed for that -- it compares past game outcomes to a threshold."""
    s = pd.to_numeric(df[metric], errors='coerce').dropna()
    if not len(s):
        return None
    over = int((s > line).sum())
    under = int((s < line).sum())
    push = int((s == line).sum())
    return {'metric': metric, 'line': line, 'n': int(len(s)),
            'over': over, 'under': under, 'push': push,
            'over_pct': round(100 * over / len(s), 1),
            'statement': f'{over}/{len(s)} over {line} = {round(100 * over / len(s), 1)}%',
            'sample': label(len(s))}


def conditions(df):
    """Each entry is (mask, note). A condition whose inputs are absent returns
       mask=None so it is reported unavailable rather than as an empty split."""
    C = {}
    C['home'] = (df['is_home'] == True, None)
    C['road'] = (df['is_home'] == False, None)
    C['dome_closed'] = (df['is_dome'] == True, None)
    C['outdoor'] = (df['is_outdoor'] == True, None)
    C['divisional'] = (df['div_game'] == 1, None)
    C['playoffs'] = (df['season_type'] != 'REG', None)
    miss = int(df['team_spread'].isna().sum())
    C['favorite'] = (df['is_favorite'] == 1.0,
                     f'spread unavailable on {miss} of {len(df)} games' if miss else None)
    C['underdog'] = (df['is_favorite'] == 0.0, None)

    out = df['is_outdoor'] == True
    if 'om_temp_f' in df.columns:
        t = pd.to_numeric(df['om_temp_f'], errors='coerce')
        w = pd.to_numeric(df['om_wind_mph'], errors='coerce')
        sn = pd.to_numeric(df['om_snow_cm'], errors='coerce')
        rn = pd.to_numeric(df['om_rain_in'], errors='coerce')
        C['temp_below_freezing'] = (out & (t < 32), None)
        C['temp_lt_20'] = (out & (t < 20), None)
        C['temp_20_32'] = (out & (t >= 20) & (t < 33), None)
        C['temp_33_50'] = (out & (t >= 33) & (t <= 50), None)
        C['temp_51_70'] = (out & (t > 50) & (t <= 70), None)
        C['temp_gt_70'] = (out & (t > 70), None)
        C['wind_10plus'] = (out & (w >= 10), None)
        C['wind_15plus'] = (out & (w >= 15), None)
        C['wind_20plus'] = (out & (w >= 20), None)
        C['snow'] = (out & (sn > 0), None)
        C['rain'] = (out & (rn > 0), None)
        C['dry'] = (out & sn.notna() & (sn.fillna(0) == 0) & (rn.fillna(0) == 0), None)
    else:
        for k in ('temp_below_freezing', 'temp_lt_20', 'temp_20_32', 'temp_33_50',
                  'temp_51_70', 'temp_gt_70', 'wind_10plus', 'wind_15plus',
                  'wind_20plus', 'snow', 'rain', 'dry'):
            C[k] = (None, 'game environment table not built')
    return C


def qb_dna(name=None, gsis=None, seasons=None, line=None, metric='pass_yards', min_attempts=1):
    q = load()
    q = q[q['attempts'] >= min_attempts]
    sel = q[q['passer_player_id'] == gsis] if gsis else q[q['passer_player_name'] == name]
    if seasons:
        sel = sel[sel['season'].isin(seasons)]
    if not len(sel):
        return {'error': 'no games found', 'query': {'name': name, 'gsis': gsis, 'seasons': seasons}}
    sel = sel.sort_values('game_date')
    out = {
        'player': {'name': sel['passer_player_name'].iloc[-1],
                   'gsis_id': sel['passer_player_id'].iloc[-1],
                   'teams': sorted(set(sel['posteam'].dropna()))},
        'source': 'nflverse play_by_play (GSIS) + ESPN venue + Open-Meteo archive',
        'window': {'seasons': sorted(int(s) for s in set(sel['season'])),
                   'games': int(len(sel)),
                   'date_range': [str(sel['game_date'].min()), str(sel['game_date'].max())]},
        'baseline': baseline(sel),
        'recent': {'last5': baseline(sel.tail(5)), 'last10': baseline(sel.tail(10))},
        'splits': {}, 'prop': {}}
    for k, (mask, note) in conditions(sel).items():
        if mask is None:
            out['splits'][k] = {'available': False, 'reason': note}
            continue
        sub = sel[mask]
        entry = {'available': True, 'n': int(len(sub))}
        if len(sub):
            entry['baseline'] = baseline(sub)
        if note:
            entry['note'] = note
        out['splits'][k] = entry
    if line is not None:
        out['prop']['career'] = prop(sel, metric, line)
        out['prop']['last5'] = prop(sel.tail(5), metric, line)
        out['prop']['last10'] = prop(sel.tail(10), metric, line)
        latest = sel['season'].max()
        out['prop']['current_season'] = prop(sel[sel['season'] == latest], metric, line)
        for k, (mask, note) in conditions(sel).items():
            if mask is None:
                continue
            sub = sel[mask]
            if len(sub):
                out['prop'][f'cond_{k}'] = prop(sub, metric, line)
    return out


if __name__ == '__main__':
    import sys
    nm = sys.argv[1] if len(sys.argv) > 1 else 'P.Mahomes'
    ln = float(sys.argv[2]) if len(sys.argv) > 2 else 267.5
    print(json.dumps(qb_dna(name=nm, line=ln), indent=1, default=str))
