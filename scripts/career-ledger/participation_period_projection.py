"""Participation coverage by licence period (READ-ONLY).

Splits what nflverse `pbp_participation` could reconcile into its two origins:
  NGS  2016-2022  "NFL NextGenStats via nflverse"  (held locally: 2019-2022)
  FTN  2023+      "FTN Data via nflverse"          (held locally: 2023; 2024-2025 not held)

Reads only: data/dist/career-ledger.json, data/nflverse/players.parquet (approved id
columns gsis_id/nfl_id), data/nflverse/pbp_participation_{2019..2023}.parquet (columns
nflverse_game_id, players_on_play ONLY), and the schedule id columns
(game_id, season, game_type, away_team, home_team, espn). Nothing is written except the
report JSON under --out. No source data is copied into the report: it holds counts and
the booleans' tallies, never player-game rows.

Usage: python scripts/career-ledger/participation_period_projection.py --schedule <games.csv> --out <dir>
"""
import argparse, collections, importlib.util, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('ra', os.path.join(HERE, 'reconciliation_audit.py'))
ra = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ra)

PERIODS = {'NGS_2016_2022': range(2016, 2023), 'FTN_2023_plus': range(2023, 2026)}
HELD = {'NGS_2016_2022': range(2019, 2023), 'FTN_2023_plus': range(2023, 2024)}


def period_of(season):
    for name, r in PERIODS.items():
        if season in r:
            return name
    return 'outside_participation'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--schedule', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    ledger, _ = ra.load()
    players = ledger['players']
    by_espn, dup, _ = ra.schedule_maps(args.schedule)
    part, held = ra.participation_index(range(2019, 2024))
    games_with_part = {g for gs in part.values() for g in gs}

    def gid(row):
        h = by_espn.get(str(row['e']))
        return h.game_id if h is not None else None

    # ---- inventory by period -------------------------------------------------
    cases, per_player = [], collections.defaultdict(list)
    for eid, p in players.items():
        if p['coverage']['complete']:
            continue
        for g in p['coverage']['gaps']:
            r = g['reason']
            kind = 'entire_season_missing' if r.startswith('no provider game log') else 'season_row_missing' if r.startswith('game log present') else 'pre_debut_roster_season'
            cases.append((eid, g['season'], kind, None))
        for m in p['coverage']['mismatches']:
            if m['blocking']:
                cases.append((eid, m['season'], 'espn_undercount' if m['ledger'] < m['provider'] else 'espn_overcount', m['provider'] - m['ledger']))
    for c in cases:
        per_player[c[0]].append(c)
    no_history = [k for k, p in players.items() if not p['coverage']['complete'] and k not in per_player]

    inventory = collections.Counter((period_of(s), k) for _, s, k, _ in cases)

    # ---- measured on held seasons, per period ----------------------------------
    measured = collections.Counter()
    for eid, season, kind, delta in cases:
        per = period_of(season)
        if per == 'outside_participation' or season not in HELD[per]:
            continue
        p = players[eid]
        logged = {gid(r) for r in p['games'] if r['s'] == season} - {None}
        pg = {g for g in part.get(p['gsis_id'], ()) if g.startswith(f'{season}_')}
        measured[(per, kind, 'held')] += 1
        if kind == 'espn_undercount':
            measured[(per, kind, 'all_missing_games_explained')] += int(len(pg - logged) >= delta)
        elif kind == 'espn_overcount':
            measured[(per, kind, 'extra_rows_shown_not_played')] += int(len(logged - pg) >= -delta)
        elif kind in ('entire_season_missing', 'pre_debut_roster_season'):
            measured[(per, kind, 'proven_no_appearance')] += int(not pg)
            measured[(per, kind, 'appeared_needs_stat_source')] += int(bool(pg))
        elif kind == 'season_row_missing':
            measured[(per, kind, 'appearance_count_equals_log')] += int(len(pg) == len(logged))

    # false negatives on CAREER players, per period
    fn = collections.Counter()
    for eid, p in players.items():
        if not p['coverage']['complete']:
            continue
        for r in p['games']:
            if r['s'] not in held:
                continue
            g = gid(r)
            if g is None or g not in games_with_part:
                continue
            per = period_of(r['s'])
            zero = all(v in (0, None) for v in r['x'].values())
            fn[(per, 'logged_games')] += 1
            if g not in part.get(p['gsis_id'], ()):
                fn[(per, 'missing_zero_stat' if zero else 'missing_with_stats')] += 1

    # ---- player-level reach ---------------------------------------------------
    def reach(allowed):
        return sum(1 for cs in per_player.values() if all(period_of(s) in allowed for _, s, _, _ in cs))
    touches = {per: sum(1 for cs in per_player.values() if any(period_of(s) == per for _, s, _, _ in cs)) for per in PERIODS}

    report = {
        'tracked_players': len(per_player) + len(no_history),
        'players_with_named_failing_seasons': len(per_player),
        'players_with_no_espn_history': len(no_history),
        'failing_seasons_by_period_and_kind': {f'{a}|{b}': n for (a, b), n in sorted(inventory.items())},
        'held_seasons': {k: list(v) for k, v in HELD.items()},
        'measured_on_held_seasons': {f'{a}|{b}|{c}': n for (a, b, c), n in sorted(measured.items())},
        'false_negatives_on_career_players': {f'{a}|{b}': n for (a, b), n in sorted(fn.items())},
        'players_touching_period': touches,
        'players_fully_in_reach': {
            'NGS_only': reach({'NGS_2016_2022'}),
            'FTN_only': reach({'FTN_2023_plus'}),
            'NGS_or_FTN': reach({'NGS_2016_2022', 'FTN_2023_plus'}),
        },
        'no_history_players_by_nflverse_rookie_season_period': dict(collections.Counter(
            period_of(players[k]['debut_sources']['nflverse_rookie_season'] or 0) for k in no_history)),
    }
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, 'participation-period-projection.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=1)
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
