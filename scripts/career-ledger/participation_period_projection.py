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

Usage: python scripts/career-ledger/participation_period_projection.py --schedule <games.csv> --out <dir> [--ftn-only]

--ftn-only (owner decision 2026-09-15): reads ONLY FTN-origin seasons 2023-2025
(2023 from the held file, 2024-2025 from the *_min.parquet files written by
fetch_ftn_participation_minimal.py, two columns each). No NGS-origin file is read.
Output is aggregate counts only; no player-level rows are written.
"""
import pandas as pd
import argparse, collections, importlib.util, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('ra', os.path.join(HERE, 'reconciliation_audit.py'))
ra = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ra)

PERIODS = {'NGS_2016_2022': range(2016, 2023), 'FTN_2023_plus': range(2023, 2026)}
HELD = {'NGS_2016_2022': range(2019, 2023), 'FTN_2023_plus': range(2023, 2024)}


def ftn_index():
    """gsis -> {game_id} from FTN-origin seasons only, two columns only."""
    root = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'data', 'nflverse')
    idx, held = collections.defaultdict(set), []
    for season in (2023, 2024, 2025):
        fp = os.path.join(root, f'pbp_participation_{season}_min.parquet')
        if not os.path.exists(fp):
            fp = os.path.join(root, f'pbp_participation_{season}.parquet')
        if not os.path.exists(fp):
            continue
        held.append(season)
        t = pd.read_parquet(fp, columns=['nflverse_game_id', 'players_on_play'])
        for gid, ids in zip(t.nflverse_game_id, t.players_on_play):
            if isinstance(ids, str):
                for pid in ids.split(';'):
                    if pid.startswith('00-'):
                        idx[pid].add(gid)
    return idx, held


def period_of(season):
    for name, r in PERIODS.items():
        if season in r:
            return name
    return 'outside_participation'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--schedule', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--ftn-only', action='store_true')
    args = ap.parse_args()

    ledger, _ = ra.load()
    players = ledger['players']
    by_espn, dup, _ = ra.schedule_maps(args.schedule)
    if args.ftn_only:
        part, held = ftn_index()
        HELD['NGS_2016_2022'] = range(0)
        HELD['FTN_2023_plus'] = range(2023, 2026)
    else:
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
    resolved = collections.defaultdict(dict)  # espn_id -> {(season, kind): bool}; kept in memory only
    for eid, season, kind, delta in cases:
        per = period_of(season)
        if per == 'outside_participation' or season not in HELD[per]:
            continue
        p = players[eid]
        logged = {gid(r) for r in p['games'] if r['s'] == season} - {None}
        pg = {g for g in part.get(p['gsis_id'], ()) if g.startswith(f'{season}_')}
        measured[(per, kind, 'held')] += 1
        if kind == 'espn_undercount':
            ok = len(pg - logged) >= delta
            measured[(per, kind, 'all_missing_games_explained')] += int(ok)
        elif kind == 'espn_overcount':
            ok = len(logged - pg) >= -delta
            measured[(per, kind, 'extra_rows_shown_not_played')] += int(ok)
        elif kind in ('entire_season_missing', 'pre_debut_roster_season'):
            ok = not pg  # an appeared season still needs an approved stat source
            measured[(per, kind, 'proven_no_appearance')] += int(ok)
            measured[(per, kind, 'appeared_needs_stat_source')] += int(bool(pg))
        else:
            ok = len(pg) == len(logged)
            measured[(per, kind, 'appearance_count_equals_log')] += int(ok)
        resolved[eid][(season, kind)] = ok

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
            fn[(f"season_{r['s']}", 'logged_games')] += 1
            if g not in part.get(p['gsis_id'], ()):
                fn[(per, 'missing_zero_stat' if zero else 'missing_with_stats')] += 1
                fn[(f"season_{r['s']}", 'missing_zero_stat' if zero else 'missing_with_stats')] += 1

    # ---- player-level reach ---------------------------------------------------
    def reach(allowed):
        return sum(1 for cs in per_player.values() if all(period_of(s) in allowed for _, s, _, _ in cs))
    def measured_reach(allowed):
        n = 0
        for eid, cs in per_player.items():
            if all(period_of(s) in allowed and resolved[eid].get((s, k)) is True for _, s, k, _ in cs):
                n += 1
        return n
    touches = {per: sum(1 for cs in per_player.values() if any(period_of(s) == per for _, s, _, _ in cs)) for per in PERIODS}

    rookies = [k for k in no_history if players[k]['debut_sources']['nflverse_rookie_season'] == 2026]
    rookie_prior = collections.Counter()
    for k in rookies:
        p = players[k]
        prior = [g for g in part.get(p['gsis_id'], ()) if int(g[:4]) < 2026]
        rookie_prior['prior_ftn_appearance' if prior else 'no_prior_ftn_appearance'] += 1
        rookie_prior['active_2026' if p.get('active_2026') else 'not_active_2026'] += 1
        rookie_prior['ledger_games_prior_seasons_' + ('zero' if not p['games'] else 'nonzero')] += 1

    report = {
        'tracked_players': len(per_player) + len(no_history),
        'players_with_named_failing_seasons': len(per_player),
        'players_with_no_espn_history': len(no_history),
        'failing_seasons_by_period_and_kind': {f'{a}|{b}': n for (a, b), n in sorted(inventory.items())},
        'held_seasons': {k: list(v) for k, v in HELD.items()},
        'measured_on_held_seasons': {f'{a}|{b}|{c}': n for (a, b, c), n in sorted(measured.items())},
        'false_negatives_on_career_players': {f'{a}|{b}': n for (a, b), n in sorted(fn.items())},
        'players_touching_period': touches,
        'players_every_failing_season_resolved_by_measurement': {
            'FTN_only': measured_reach({'FTN_2023_plus'}),
            **({} if args.ftn_only else {'NGS_only': measured_reach({'NGS_2016_2022'}), 'NGS_or_FTN': measured_reach({'NGS_2016_2022', 'FTN_2023_plus'})}),
        },
        'players_fully_in_reach': {
            'NGS_only': reach({'NGS_2016_2022'}),
            'FTN_only': reach({'FTN_2023_plus'}),
            'NGS_or_FTN': reach({'NGS_2016_2022', 'FTN_2023_plus'}),
        },
        'rookies_2026_no_prior_history': {'players': len(rookies), 'checks_on_held_participation_seasons': dict(rookie_prior)},
        'no_history_players_by_nflverse_rookie_season_period': dict(collections.Counter(
            period_of(players[k]['debut_sources']['nflverse_rookie_season'] or 0) for k in no_history)),
    }
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, 'participation-period-projection.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=1)
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
