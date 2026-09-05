"""Audit receiver-level coverage in the nflverse play-by-play we actually hold.

    python research/ingest/audit_receivers.py

Nothing is assumed. A column existing is not evidence it is populated, and a
metric is only reported as supportable if its inputs are present on enough
plays to mean something. Anything thin is named so it can be WITHHELD rather
than shipped and quietly wrong.
"""
import glob, json
import pandas as pd

SEASONS = sorted(int(f[-12:-8]) for f in glob.glob('data/nflverse/play_by_play_*.parquet'))

# the fields a receiver product would want, and what each is for
WANT = [
    'receiver_player_id', 'receiver_player_name', 'receiver_id',
    'complete_pass', 'incomplete_pass', 'pass_attempt', 'interception',
    'receiving_yards', 'yards_gained', 'air_yards', 'yards_after_catch',
    'pass_touchdown', 'touchdown', 'epa', 'first_down', 'first_down_pass',
    'posteam', 'defteam', 'play_type', 'season_type', 'week', 'game_date',
    'home_team', 'away_team', 'two_point_attempt', 'sack', 'qb_spike',
    'passer_player_id',
]

out = {}
print(f'seasons: {SEASONS}\n')
for y in SEASONS:
    df = pd.read_parquet(f'data/nflverse/play_by_play_{y}.parquet')
    have = [c for c in WANT if c in df.columns]
    missing = [c for c in WANT if c not in df.columns]

    # A TARGET is a pass attempt with a source-supplied receiver id. Never
    # inferred from play text, and never counted on a spike or a two-point try.
    pa = df[(df.get('pass_attempt') == 1)] if 'pass_attempt' in df.columns else df.iloc[0:0]
    reg = pa[pa.get('two_point_attempt', 0) != 1] if 'two_point_attempt' in pa.columns else pa
    tgt = reg[reg['receiver_player_id'].notna()] if 'receiver_player_id' in reg.columns else reg.iloc[0:0]

    row = {
        'plays': int(len(df)),
        'pass_attempts': int(len(pa)),
        'pass_attempts_excl_2pt': int(len(reg)),
        'targets_with_receiver_id': int(len(tgt)),
        'receiver_id_coverage_on_attempts_pct':
            round(100 * len(tgt) / len(reg), 1) if len(reg) else None,
        'missing_columns': missing,
        'field_coverage_on_targets_pct': {},
    }
    for c in ['receiver_player_name', 'receiving_yards', 'air_yards',
              'yards_after_catch', 'complete_pass', 'pass_touchdown', 'epa',
              'first_down', 'passer_player_id']:
        if c in tgt.columns and len(tgt):
            row['field_coverage_on_targets_pct'][c] = round(100 * float(tgt[c].notna().mean()), 1)
        else:
            row['field_coverage_on_targets_pct'][c] = None

    # completions must be a subset of targets, or our target rule is wrong
    if len(tgt) and 'complete_pass' in tgt.columns:
        row['completions_on_targets'] = int(tgt['complete_pass'].fillna(0).sum())
        comp_all = int(reg['complete_pass'].fillna(0).sum()) if 'complete_pass' in reg.columns else None
        row['completions_on_all_attempts'] = comp_all
        row['completions_without_a_receiver_id'] = (
            comp_all - row['completions_on_targets'] if comp_all is not None else None)

    # receiving_yards should only be non-zero where the pass was completed
    if len(tgt) and {'receiving_yards', 'complete_pass'} <= set(tgt.columns):
        incomp = tgt[tgt['complete_pass'].fillna(0) == 0]
        row['receiving_yards_on_incompletions_nonzero'] = int(
            (incomp['receiving_yards'].fillna(0) != 0).sum())

    out[str(y)] = row
    print(f'{y}: {row["targets_with_receiver_id"]:,} targets on '
          f'{row["pass_attempts_excl_2pt"]:,} attempts '
          f'({row["receiver_id_coverage_on_attempts_pct"]}%)  '
          f'completions w/o receiver id: {row.get("completions_without_a_receiver_id")}')

# ---- player metadata -------------------------------------------------------
P = pd.read_parquet('data/nflverse/players.parquet')
wr = P[P['position'] == 'WR'] if 'position' in P.columns else P.iloc[0:0]
meta = {
    'players_rows': int(len(P)),
    'wr_rows': int(len(wr)),
    'wr_with_gsis': int(wr['gsis_id'].notna().sum()),
    'wr_with_espn_id': int(wr['espn_id'].notna().sum()),
    'wr_with_pfr_id': int(wr['pfr_id'].notna().sum()),
    'wr_last_season_2025_plus': int((wr['last_season'] >= 2025).sum())
        if 'last_season' in wr.columns else None,
    'positions_present': P['position'].value_counts().head(12).to_dict()
        if 'position' in P.columns else None,
}
print('\nWR metadata:', json.dumps({k: v for k, v in meta.items() if k != 'positions_present'}, indent=1))

# ---- what participation/charting would add, if it were covered ------------
part = {}
for y in SEASONS:
    f = f'data/nflverse/pbp_participation_{y}.parquet'
    if not glob.glob(f):
        part[str(y)] = {'file': None, 'note': 'not published for this season'}
        continue
    d = pd.read_parquet(f)
    part[str(y)] = {
        'rows': int(len(d)),
        'route_coverage_pct': round(100 * float(d['route'].notna().mean()), 1)
            if 'route' in d.columns else None,
        'offense_players_coverage_pct': round(100 * float(d['offense_players'].notna().mean()), 1)
            if 'offense_players' in d.columns else None,
    }
print('\nroute / snap participation by season:')
for y, v in part.items():
    print(f'  {y}: {v}')

with open('data/dist/receiver-coverage-audit.json', 'w', encoding='utf-8') as fh:
    json.dump({'by_season': out, 'player_metadata': meta, 'participation': part}, fh, indent=1)
print('\nwrote data/dist/receiver-coverage-audit.json')
