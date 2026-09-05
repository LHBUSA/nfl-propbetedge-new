"""Audit rushing and tight-end coverage in the play-by-play we actually hold.

    python research/ingest/audit_backs_tes.py

Nothing is assumed. A metric is only reported as supportable when its inputs
are present on enough plays to mean something; anything thin is named so it
can be WITHHELD rather than shipped and quietly wrong.
"""
import glob, json
import pandas as pd

SEASONS = sorted(int(f[-12:-8]) for f in glob.glob('data/nflverse/play_by_play_*.parquet'))
out = {}
print(f'seasons: {SEASONS}\n')

for y in SEASONS:
    df = pd.read_parquet(f'data/nflverse/play_by_play_{y}.parquet')
    row = {'plays': int(len(df)), 'missing_columns': []}
    for c in ['rusher_player_id', 'rushing_yards', 'rush_touchdown', 'yards_gained',
              'yardline_100', 'receiver_player_id', 'two_point_attempt', 'qb_kneel',
              'qb_scramble', 'fumble_lost']:
        if c not in df.columns:
            row['missing_columns'].append(c)

    # A CARRY is a rushing play with a source-supplied rusher id, excluding
    # two-point tries and quarterback kneels — a kneel is a clock event, not a
    # carry, and counting it would understate every back's average.
    ru = df[(df.get('rush_attempt') == 1)] if 'rush_attempt' in df.columns else df.iloc[0:0]
    reg = ru
    for col, val in (('two_point_attempt', 1), ('qb_kneel', 1)):
        if col in reg.columns:
            reg = reg[reg[col] != val]
    car = reg[reg['rusher_player_id'].notna()] if 'rusher_player_id' in reg.columns else reg.iloc[0:0]
    row['rush_attempts'] = int(len(ru))
    row['rush_attempts_excl_2pt_kneel'] = int(len(reg))
    row['carries_with_rusher_id'] = int(len(car))
    row['rusher_id_coverage_pct'] = round(100 * len(car) / len(reg), 1) if len(reg) else None
    row['field_coverage_on_carries_pct'] = {}
    for c in ['rushing_yards', 'rush_touchdown', 'yards_gained', 'yardline_100', 'epa']:
        row['field_coverage_on_carries_pct'][c] = (
            round(100 * float(car[c].notna().mean()), 1) if c in car.columns and len(car) else None)

    # RED ZONE: yardline_100 is yards to the opponent goal line, so <= 20 is
    # inside the opponent twenty. Measured on TARGETED plays, since that is
    # where the tight-end product needs it.
    tg = df[(df.get('pass_attempt') == 1) & (df['receiver_player_id'].notna())] \
        if {'pass_attempt', 'receiver_player_id'} <= set(df.columns) else df.iloc[0:0]
    if len(tg) and 'yardline_100' in tg.columns:
        row['targets'] = int(len(tg))
        row['targets_with_yardline'] = int(tg['yardline_100'].notna().sum())
        row['yardline_coverage_on_targets_pct'] = round(100 * float(tg['yardline_100'].notna().mean()), 1)
        row['red_zone_targets'] = int((tg['yardline_100'] <= 20).sum())
    out[str(y)] = row
    print(f'{y}: carries {row["carries_with_rusher_id"]:,}/{row["rush_attempts_excl_2pt_kneel"]:,} '
          f'({row["rusher_id_coverage_pct"]}%)  ·  red-zone targets {row.get("red_zone_targets")}  '
          f'·  yardline coverage {row.get("yardline_coverage_on_targets_pct")}%')

# ---- position metadata -----------------------------------------------------
P = pd.read_parquet('data/nflverse/players.parquet')
meta = {}
for pos in ['RB', 'FB', 'TE', 'WR', 'QB']:
    sub = P[P['position'] == pos]
    meta[pos] = {
        'rows': int(len(sub)),
        'with_gsis': int(sub['gsis_id'].notna().sum()),
        'with_espn_id': int(sub['espn_id'].notna().sum()),
        'active_2025_plus': int((sub['last_season'] >= 2025).sum())
            if 'last_season' in sub.columns else None,
    }
print('\nposition metadata:')
for k, v in meta.items():
    print(f'  {k}: {v}')

with open('data/dist/backs-tes-coverage-audit.json', 'w', encoding='utf-8') as fh:
    json.dump({'by_season': out, 'position_metadata': meta}, fh, indent=1)
print('\nwrote data/dist/backs-tes-coverage-audit.json')
