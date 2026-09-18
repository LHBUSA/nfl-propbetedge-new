"""Build the ESPN -> Pro-Football-Reference identifier crosswalk.

    python history/pipeline/build_college_crosswalk.py

Writes history/.out/college-spine/_crosswalk.json (gitignored).

This is the ONE join key the College Path layer needs and cannot get from the
CC0 spine alone: Wikidata carries a PFR id for 28,896 football people but an
ESPN id for only 2,841, and the product is keyed on the ESPN athlete id. The
nflverse players table carries both.

RIGHTS. nflverse `players` is `review` at source level, and the owner decision
on record is: "APPROVED internal reconciliation only (id columns); attribute
columns not approved". So this reads THREE id columns and nothing else — no
name, no position, no birth date, no attribute of any kind. The output is a
build-time join key that never reaches the product artifact; the artifact is
keyed on the ESPN id the product already uses.

A name is never used to match. Two rows that share no strong identifier are two
different people as far as this file is concerned.
"""
from __future__ import annotations
import json, os, sys
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding='utf-8')
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PLAYERS = os.path.join(REPO, 'data', 'nflverse', 'players.parquet')
OUT = os.path.join(REPO, 'history', '.out', 'college-spine', '_crosswalk.json')

# The only columns this file is permitted to read.
ID_COLUMNS = ['gsis_id', 'pfr_id', 'espn_id']


def main():
    import pandas as pd

    if not os.path.exists(PLAYERS):
        raise SystemExit(f'missing {PLAYERS}')
    frame = pd.read_parquet(PLAYERS, columns=ID_COLUMNS)

    espn_to_pfr, gsis_to_pfr = {}, {}
    for espn, gsis, pfr in zip(frame.espn_id, frame.gsis_id, frame.pfr_id):
        if pd.isna(pfr) or not str(pfr).strip():
            continue
        pfr = str(pfr).strip()
        if pd.notna(espn) and str(espn).strip():
            # espn_id arrives as a float in parquet; the product uses the integer string
            key = str(int(float(espn)))
            espn_to_pfr[key] = pfr
        if pd.notna(gsis) and str(gsis).strip():
            gsis_to_pfr[str(gsis).strip()] = pfr

    # The Career Ledger gives an ESPN id and a GSIS id for every player, so fold
    # the GSIS route into the ESPN key here rather than making the consumer do it.
    ledger_path = os.path.join(REPO, 'data', 'dist', 'career-ledger.json')
    added = 0
    if os.path.exists(ledger_path):
        with open(ledger_path, encoding='utf-8') as f:
            ledger = json.load(f)['players']
        for espn_id, player in ledger.items():
            if espn_id in espn_to_pfr:
                continue
            pfr = gsis_to_pfr.get(player.get('gsis_id') or '')
            if pfr:
                espn_to_pfr[espn_id] = pfr
                added += 1

    payload = {
        'contract': 'college-crosswalk/v1',
        'generated_at': datetime.now(timezone.utc).replace(microsecond=0)
                        .isoformat().replace('+00:00', 'Z'),
        'source': 'nflverse players.parquet (id columns only)',
        'rights': 'internal reconciliation only; never published, never in the product artifact',
        'columns_read': ID_COLUMNS,
        'espn_to_pfr': espn_to_pfr,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f)
    print(f'espn -> pfr: {len(espn_to_pfr)} ({added} of them reached via the gsis route)')
    print(f'wrote {OUT}')


if __name__ == '__main__':
    main()
