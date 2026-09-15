"""Career Ledger reconciliation audit (READ-ONLY).

Projects how many TRACKED HISTORY cases each candidate second source could
resolve, validates the identity joins on a 40-player cohort, and measures what
data the repository ALREADY holds (nflverse play-by-play-derived DNA rows and
pbp_participation 2019-2023) says about the missing games.

It never fetches historical stats, never writes data/dist, never regenerates the
ledger. Inputs:
  data/dist/career-ledger.json                    production ledger (read only)
  data/dist/{qb,rb,wr,te}-dna-dataset.json        pbp-derived player-game rows (held)
  data/nflverse/players.parquet                   id crosswalk (held)
  data/nflverse/pbp_participation_{2019..2023}    on-field participation (held)
  --schedule games.csv                            nflverse schedule id file (factual ids only)
snap_counts files present locally are deliberately NOT read: the rights audit
marks PFR-derived snap counts DO NOT USE.

Usage: python scripts/career-ledger/reconciliation_audit.py --schedule <games.csv> --out <dir>
"""
import argparse, collections, json, os, random
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ESPN_TO_NFLVERSE_TEAM = {'WSH': 'WAS', 'LAR': 'LA'}
POST_TYPE = {1: 'WC', 2: 'DIV', 3: 'CON', 5: 'SB'}  # ESPN postseason week -> nflverse game_type (4 = Pro Bowl, excluded upstream)


def era(season):
    if season < 2012: return '1999-2011'
    if season < 2016: return '2012-2015'
    if season < 2019: return '2016-2018'
    return '2019-2025'


def load():
    ledger = json.load(open(os.path.join(ROOT, 'data', 'dist', 'career-ledger.json'), encoding='utf-8'))
    dna_rows = collections.defaultdict(set)  # gsis -> {nflverse game_id}
    for pos, key in (('qb', 'qb_games'), ('rb', 'player_games'), ('wr', 'receiver_games'), ('te', 'receiver_games')):
        d = json.load(open(os.path.join(ROOT, 'data', 'dist', f'{pos}-dna-dataset.json'), encoding='utf-8'))
        for g in d[key]:
            dna_rows[g['pid']].add(g['g'])
    return ledger, dna_rows


def participation_index(seasons):
    """gsis -> {nflverse game_id with >=1 play on field}.

    2019-2022 files carry NFL numeric ids (players.parquet nfl_id), 2023 carries
    GSIS ids. The numeric ids are mapped through the typed nfl_id column only
    (they also collide with unrelated PFF ids); an id that does not map is
    counted and dropped, never guessed."""
    pl = pd.read_parquet(os.path.join(ROOT, 'data', 'nflverse', 'players.parquet'), columns=['gsis_id', 'nfl_id'])
    pl = pl.dropna(subset=['nfl_id']).assign(nfl_id=lambda d: d.nfl_id.astype(str).str.replace(r'\.0$', '', regex=True))
    amb = set(pl.nfl_id[pl.nfl_id.duplicated(keep=False)])
    nfl_to_gsis = {n: g for n, g in zip(pl.nfl_id, pl.gsis_id) if n not in amb}
    idx = collections.defaultdict(set)
    held = []
    unmapped = collections.Counter()
    for s in seasons:
        fp = os.path.join(ROOT, 'data', 'nflverse', f'pbp_participation_{s}.parquet')
        if not os.path.exists(fp):
            continue
        held.append(s)
        p = pd.read_parquet(fp, columns=['nflverse_game_id', 'players_on_play'])
        for gid, ids in zip(p.nflverse_game_id, p.players_on_play):
            if isinstance(ids, str) and ids:
                for pid in ids.split(';'):
                    if not pid:
                        continue
                    g = pid if pid.startswith('00-') else nfl_to_gsis.get(pid)
                    if g is None:
                        unmapped[s] += 1
                        continue
                    idx[g].add(gid)
    participation_index.unmapped = dict(unmapped)
    return idx, held


def schedule_maps(path):
    g = pd.read_csv(path, dtype={'espn': 'string'})
    g = g[g.espn.notna()]
    dup = set(g.espn[g.espn.duplicated(keep=False)])
    by_espn = {}
    for r in g.itertuples():
        if r.espn in dup:
            continue  # ambiguous ESPN id -> fails closed
        by_espn[str(r.espn)] = r
    return by_espn, dup, g


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--schedule', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    ledger, dna_rows = load()
    players = ledger['players']
    by_espn, dup_espn, sched = schedule_maps(args.schedule)
    part, part_held = participation_index(range(2019, 2024))

    # ---- 1. inventory of failing seasons ------------------------------------
    tracked = {k: p for k, p in players.items() if not p['coverage']['complete']}
    cases = []
    for eid, p in tracked.items():
        for gap in p['coverage']['gaps']:
            r = gap['reason']
            kind = ('entire_season_missing' if r.startswith('no provider game log')
                    else 'season_row_missing' if r.startswith('game log present')
                    else 'pre_debut_roster_season')
            cases.append({'espn_id': eid, 'gsis': p['gsis_id'], 'name': p['name'], 'season': gap['season'], 'kind': kind, 'delta': None})
        for m in p['coverage']['mismatches']:
            if m['blocking']:
                kind = 'espn_undercount' if m['ledger'] < m['provider'] else 'espn_overcount'
                cases.append({'espn_id': eid, 'gsis': p['gsis_id'], 'name': p['name'], 'season': m['season'], 'kind': kind, 'delta': m['provider'] - m['ledger']})

    # ---- 2. theoretical resolvability by source ------------------------------
    #   snap_counts   2012+  appearance / non-appearance incl. special teams   (DO NOT USE)
    #   participation 2016+  appearance / non-appearance on every play          (REVIEW REQUIRED)
    #   stats_player  1999+  games WITH a recorded stat only; cannot prove a
    #                        zero-stat appearance or a non-appearance            (REVIEW REQUIRED)
    #   espn_core     all    played flag + per-event stats, reliability unproven (DO NOT USE)
    def can(source, c):
        s, k = c['season'], c['kind']
        if source == 'snap_counts':
            return s >= 2012
        if source == 'participation':
            return s >= 2016
        if source == 'stats_player_week':
            # can add stat games; resolves a case only if every missing game had a stat
            return k in ('espn_undercount', 'entire_season_missing', 'season_row_missing') and s >= 1999
        if source == 'espn_core':
            return True
        return False

    proj = {}
    for src in ('snap_counts', 'participation', 'stats_player_week', 'espn_core'):
        t = collections.Counter()
        for c in cases:
            t[(c['kind'], 'possible' if can(src, c) else 'not_possible')] += 1
        proj[src] = {f'{k}|{v}': n for (k, v), n in sorted(t.items())}
    by_kind_era = collections.Counter((c['kind'], era(c['season'])) for c in cases)

    # ---- 3. measured with data already held (2019-2025) -----------------------
    def nflverse_game_id(row):
        """ESPN ledger row -> nflverse game_id via the schedule ESPN id (exact)."""
        hit = by_espn.get(str(row['e']))
        return (hit.game_id if hit is not None else None), ('ambiguous_espn_id' if str(row['e']) in dup_espn else None)

    measured = collections.Counter()
    join_audit = collections.Counter()
    # Identity join check over every ledger game 1999+: schedule-espn game_id must equal the deterministic key.
    for eid, p in players.items():
        for row in p['games']:
            gid, why = nflverse_game_id(row)
            if gid is None:
                join_audit['no_schedule_match' if why is None else why] += 1
                continue
            hit = by_espn[str(row['e'])]
            team = ESPN_TO_NFLVERSE_TEAM.get(row['t'], row['t'])
            opp = ESPN_TO_NFLVERSE_TEAM.get(row['o'], row['o'])
            home, away = (team, opp) if row['h'] else (opp, team)
            type_ok = (row['st'] == 'REG' and hit.game_type == 'REG') or (row['st'] == 'POST' and hit.game_type == POST_TYPE.get(row['w']))
            teams_ok = hit.home_team == home and hit.away_team == away
            join_audit['exact' if type_ok and teams_ok and int(hit.season) == int(row['s']) else 'espn_id_matches_but_fields_disagree'] += 1

    for c in cases:
        if c['season'] < 2019:
            continue
        p = players[c['espn_id']]
        logged = set()
        for row in p['games']:
            if row['s'] == c['season']:
                gid, _ = nflverse_game_id(row)
                if gid: logged.add(gid)
        season_prefix = f"{c['season']}_"
        dna_games = {g for g in dna_rows.get(c['gsis'], ()) if g.startswith(season_prefix)}
        part_games = {g for g in part.get(c['gsis'], ()) if g.startswith(season_prefix)} if c['season'] in part_held else None
        extra_dna = dna_games - logged
        extra_part = (part_games - logged) if part_games is not None else None
        key = c['kind']
        measured[(key, 'cases')] += 1
        if key == 'espn_undercount':
            measured[(key, 'pbp_rows_explain_all_missing')] += int(len(extra_dna) >= c['delta'])
            if extra_part is not None:
                measured[(key, 'participation_held')] += 1
                measured[(key, 'participation_explains_all_missing')] += int(len(extra_part) >= c['delta'])
        elif key == 'espn_overcount':
            if part_games is not None:
                measured[(key, 'participation_held')] += 1
                measured[(key, 'participation_shows_logged_game_not_played')] += int(len(logged - part_games) >= -c['delta'])
        else:
            measured[(key, 'pbp_rows_in_season')] += int(bool(dna_games))
            if part_games is not None:
                measured[(key, 'participation_held')] += 1
                measured[(key, 'participation_no_appearance')] += int(not part_games)

    # ---- 3b. participation false negatives on games known to be played ----------
    # For CAREER players (game counts reconcile), every logged 2019-2023 game in a
    # game that participation covers should list the player. A miss on a game
    # with a recorded stat would make "no participation = did not play" unsafe.
    games_with_part = {g for gs in part.values() for g in gs}
    fn = collections.Counter()
    fn_examples = []
    for eid, p in players.items():
        if not p['coverage']['complete']:
            continue
        for row in p['games']:
            if row['s'] not in part_held:
                continue
            gid, _ = nflverse_game_id(row)
            if gid is None or gid not in games_with_part:
                continue
            zero = all(v in (0, None) for v in row['x'].values())
            fn['logged_games'] += 1
            fn['logged_zero_stat_games'] += int(zero)
            if gid not in part.get(p['gsis_id'], ()):
                fn['missing_participation'] += 1
                fn['missing_participation_zero_stat'] += int(zero)
                fn['missing_participation_with_stats'] += int(not zero)
                if len(fn_examples) < 8:
                    fn_examples.append({'player': p['name'], 'game': gid, 'stats': row['x']})

    # ---- 4. identity audit ----------------------------------------------------
    pl = pd.read_parquet(os.path.join(ROOT, 'data', 'nflverse', 'players.parquet'), columns=['gsis_id', 'espn_id', 'pfr_id'])
    pl = pl[pl.espn_id.notna()].assign(espn_id=lambda d: d.espn_id.astype(str))
    id_audit = {
        'ledger_players': len(players),
        'espn_to_gsis_unique': int((pl.groupby('espn_id').gsis_id.nunique() == 1).all()),
        'gsis_to_espn_conflicts': int((pl.groupby('gsis_id').espn_id.nunique() > 1).sum()),
        'ledger_gsis_matches_crosswalk': sum(1 for k, p in players.items() if ((pl.espn_id == k) & (pl.gsis_id == p['gsis_id'])).any()),
        'ledger_players_with_pfr_id': sum(1 for k in players if pl.loc[pl.espn_id == k, 'pfr_id'].notna().any()),
    }

    # ---- 5. 40-player dry-run cohort -------------------------------------------
    rng = random.Random(20260915)
    def pick(pred, n, label):
        pool = sorted([c for c in cases if pred(c)], key=lambda c: (c['espn_id'], c['season']))
        seen, out = set(), []
        rng.shuffle(pool)
        for c in pool:
            if c['espn_id'] in seen: continue
            seen.add(c['espn_id']); out.append({**c, 'bucket': label, 'positions': players[c['espn_id']]['dna_positions']})
            if len(out) >= n: break
        return out
    named = {'15847': 'Kelce 2013 entire season missing (debut year, 1 ST game)', '4527': 'Witten 2003 undercount', '16800': 'Adams 2014 undercount (ESPN core returned 1 event)'}
    cohort = [{'espn_id': k, 'name': players[k]['name'], 'bucket': 'named', 'note': v, 'positions': players[k]['dna_positions']} for k, v in named.items() if k in players]
    taken = set(named)
    for pred, n, label in (
        (lambda c: c['kind'] == 'espn_undercount' and c['season'] >= 2019, 7, 'undercount 2019+ (participation + pbp held)'),
        (lambda c: c['kind'] == 'espn_undercount' and 2012 <= c['season'] < 2019, 5, 'undercount 2012-2018'),
        (lambda c: c['kind'] == 'espn_undercount' and c['season'] < 2012, 4, 'undercount pre-2012 (zero-stat risk)'),
        (lambda c: c['kind'] == 'espn_overcount', 5, 'ESPN overcount (possible DNP rows)'),
        (lambda c: c['kind'] == 'entire_season_missing' and c['season'] >= 2019, 5, 'entire season missing 2019+ (IR / no appearance?)'),
        (lambda c: c['kind'] == 'entire_season_missing' and c['season'] < 2019, 3, 'entire season missing pre-2019'),
        (lambda c: c['kind'] == 'season_row_missing', 3, 'game log without provider season row'),
        (lambda c: c['kind'] == 'pre_debut_roster_season', 3, 'nflverse roster season before ESPN debut'),
        (lambda c: 'QB' in players[c['espn_id']]['dna_positions'] and c['kind'] in ('espn_undercount', 'espn_overcount'), 4, 'QB game-count mismatch (backup QB DNP rows)'),
        (lambda c: 'QB' in players[c['espn_id']]['dna_positions'] and c['kind'] == 'entire_season_missing', 2, 'QB entire season missing'),
    ):
        for c in pick(lambda c, pred=pred: pred(c) and c['espn_id'] not in taken, n, label):
            taken.add(c['espn_id']); cohort.append(c)
    # position balance check
    pos_count = collections.Counter(pp for c in cohort for pp in c['positions'])

    report = {
        'tracked_players': len(tracked), 'failing_seasons': len(cases),
        'cases_by_kind': dict(collections.Counter(c['kind'] for c in cases)),
        'cases_by_kind_and_era': {f'{k}|{e}': n for (k, e), n in sorted(by_kind_era.items())},
        'undercount_missing_games_total': sum(c['delta'] for c in cases if c['kind'] == 'espn_undercount'),
        'overcount_extra_rows_total': -sum(c['delta'] for c in cases if c['kind'] == 'espn_overcount'),
        'theoretical_by_source': proj,
        'measured_with_held_data_2019_plus': {f'{k}|{m}': n for (k, m), n in sorted(measured.items())},
        'participation_seasons_held': part_held,
        'participation_unmapped_player_slots': getattr(participation_index, 'unmapped', {}),
        'participation_false_negatives_on_career_players': dict(fn),
        'participation_false_negative_examples': fn_examples,
        'game_identity_join_audit': dict(join_audit),
        'schedule_duplicate_espn_ids': sorted(dup_espn),
        'identity_audit': id_audit,
        'cohort_size': len(cohort), 'cohort_positions': dict(pos_count), 'cohort': cohort,
    }
    with open(os.path.join(args.out, 'reconciliation-audit.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=1, default=str)
    print(json.dumps({k: v for k, v in report.items() if k != 'cohort'}, indent=1, default=str))


if __name__ == '__main__':
    main()
