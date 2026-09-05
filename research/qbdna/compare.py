"""QB vs QB, and today-vs-history, expressed as each quarterback's movement
FROM HIS OWN BASELINE.

Comparing QB A's raw yards to QB B's raw yards mostly measures offensive volume.
Comparing each man's change from his own baseline under a condition measures the
thing we actually want to know.

Every figure is counted from the warehouse. Nothing is modelled or inferred.
"""
import sys, json, pandas as pd, numpy as np
sys.path.insert(0, 'research/qbdna')
from engine import load, conditions, baseline, prop, label, describe


def series(df, metric='pass_yards'):
    return pd.to_numeric(df[metric], errors='coerce').dropna()


def delta_profile(sel, metric='pass_yards', min_n=3):
    """Per-condition mean vs the player's own overall mean, with N on every row."""
    base = series(sel, metric)
    if not len(base):
        return None
    bmean = float(base.mean())
    rows = []
    for k, (mask, note) in conditions(sel).items():
        if mask is None:
            rows.append({'condition': k, 'available': False, 'reason': note})
            continue
        sub = sel[mask]
        s = series(sub, metric)
        if len(s) < min_n:
            rows.append({'condition': k, 'available': True, 'n': int(len(s)),
                         'suppressed': f'n<{min_n}'})
            continue
        m = float(s.mean())
        rows.append({'condition': k, 'available': True, 'n': int(len(s)),
                     'mean': round(m, 1), 'median': round(float(s.median()), 1),
                     'baseline_mean': round(bmean, 1),
                     'delta_abs': round(m - bmean, 1),
                     'delta_pct': round(100 * (m - bmean) / bmean, 1) if bmean else None,
                     'sample': label(len(s))})
    return {'baseline_mean': round(bmean, 1), 'baseline_n': int(len(base)), 'conditions': rows}


def one_qb(name, metric='pass_yards', seasons=None, min_attempts=1):
    q = load()
    q = q[(q['attempts'] >= min_attempts) & (q['passer_player_name'] == name)]
    if seasons:
        q = q[q['season'].isin(seasons)]
    return q.sort_values('game_date')


def today_vs_history(name, line, metric='pass_yards', condition=None, seasons=None):
    """CURRENT LINE vs SEASON BASELINE vs SIMILAR HISTORICAL CONDITIONS."""
    sel = one_qb(name, metric, seasons)
    if not len(sel):
        return {'error': 'no games', 'player': name}
    latest = int(sel['season'].max())
    season_df = sel[sel['season'] == latest]
    out = {
        'player': name, 'metric': metric, 'current_line': line,
        'source': 'nflverse play_by_play + ESPN venue + Open-Meteo archive',
        'career_window': {'seasons': sorted(int(s) for s in set(sel['season'])),
                          'games': int(len(sel))},
        'season_baseline': {'season': latest, **(describe(season_df, metric) or {})},
        'career_baseline': describe(sel, metric),
        'prop_season': prop(season_df, metric, line),
        'prop_career': prop(sel, metric, line),
    }
    if condition:
        C = conditions(sel)
        mask, note = C.get(condition, (None, f'unknown condition {condition}'))
        if mask is None:
            out['similar_conditions'] = {'condition': condition, 'available': False, 'reason': note}
        else:
            sub = sel[mask]
            d = describe(sub, metric)
            out['similar_conditions'] = {
                'condition': condition, 'available': True, 'n': int(len(sub)),
                **(d or {}),
                'prop': prop(sub, metric, line) if len(sub) else None,
                'delta_vs_season_pct': (round(100 * (d['mean'] - out['season_baseline']['mean'])
                                              / out['season_baseline']['mean'], 1)
                                        if d and out['season_baseline'].get('mean') else None),
                'sample': label(len(sub))}
    return out


def head_to_head(a, b, metric='pass_yards', line=None, seasons=None):
    A, B = one_qb(a, metric, seasons), one_qb(b, metric, seasons)
    if not len(A) or not len(B):
        return {'error': 'one or both QBs have no games', 'a': a, 'b': b}
    out = {'metric': metric, 'line': line,
           'source': 'nflverse play_by_play + ESPN venue + Open-Meteo archive',
           'a': {'name': a, 'games': int(len(A)), 'baseline': describe(A, metric),
                 'profile': delta_profile(A, metric)},
           'b': {'name': b, 'games': int(len(B)), 'baseline': describe(B, metric),
                 'profile': delta_profile(B, metric)}}
    if line is not None:
        out['a']['prop'] = prop(A, metric, line)
        out['b']['prop'] = prop(B, metric, line)
    # side-by-side movement from each man's own baseline
    ia = {r['condition']: r for r in out['a']['profile']['conditions']}
    ib = {r['condition']: r for r in out['b']['profile']['conditions']}
    rows = []
    for k in ia:
        ra, rb = ia[k], ib.get(k, {})
        if 'delta_pct' in ra and 'delta_pct' in rb:
            rows.append({'condition': k,
                         'a_n': ra['n'], 'a_mean': ra['mean'], 'a_delta_pct': ra['delta_pct'],
                         'b_n': rb['n'], 'b_mean': rb['mean'], 'b_delta_pct': rb['delta_pct'],
                         'edge_to': a if ra['delta_pct'] > rb['delta_pct'] else b,
                         'sample': f"{ra['sample']} / {rb['sample']}"})
    out['condition_comparison'] = rows
    return out


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'h2h'
    if mode == 'today':
        print(json.dumps(today_vs_history(sys.argv[2], float(sys.argv[3]),
                                          condition=sys.argv[4] if len(sys.argv) > 4 else None),
                         indent=1, default=str))
    else:
        line = float(sys.argv[4]) if len(sys.argv) > 4 else None
        print(json.dumps(head_to_head(sys.argv[2], sys.argv[3], line=line), indent=1, default=str))
