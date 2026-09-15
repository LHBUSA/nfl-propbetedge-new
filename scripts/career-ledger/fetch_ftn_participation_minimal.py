"""Fetch FTN-origin participation (2024, 2025) for LOCAL MEASUREMENT ONLY.

Owner decision 2026-09-15: 2023+ FTN-origin participation is approved for read-only
coverage measurement. Nothing derived from it may enter career-ledger.json or any
public/shareable output. 2016-2022 NGS-origin participation is not approved for
production use and is not fetched here.

Minimum columns only (as defined in docs/career-ledger/PARTICIPATION_DERIVATION_AND_SHAREALIKE.md):
    nflverse_game_id, players_on_play
The Parquet file is read over HTTP Range requests: the footer, then only the column
chunks of those two columns. The other columns are never downloaded. Output goes to
data/nflverse/ (gitignored) as a two-column file named *_min.parquet, with a sidecar
provenance note carrying the required credit.

Credit: FTN Data via nflverse, CC-BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).

Usage: python scripts/career-ledger/fetch_ftn_participation_minimal.py 2024 2025
"""
import io, json, os, sys, urllib.request
from datetime import datetime, timezone
import pyarrow.parquet as pq

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
URL = 'https://github.com/nflverse/nflverse-data/releases/download/pbp_participation/pbp_participation_{season}.parquet'
COLUMNS = ['nflverse_game_id', 'players_on_play']
FTN_FIRST_SEASON = 2023


class RangeFile(io.RawIOBase):
    """Seekable read-only file over HTTP Range requests; counts bytes actually transferred."""

    def __init__(self, url):
        req = urllib.request.Request(url, method='HEAD', headers={'User-Agent': 'propbetedge-measurement'})
        with urllib.request.urlopen(req, timeout=60) as r:
            self.url = r.geturl()  # follow the release redirect once
            self.size = int(r.headers['Content-Length'])
        self.pos = 0
        self.transferred = 0

    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        if n == 0 or self.pos >= self.size:
            return b''
        end = min(self.size, self.pos + n) - 1
        req = urllib.request.Request(self.url, headers={'Range': f'bytes={self.pos}-{end}', 'User-Agent': 'propbetedge-measurement'})
        with urllib.request.urlopen(req, timeout=120) as r:
            if r.status != 206:
                raise RuntimeError(f'server ignored Range (HTTP {r.status}); refusing to download the full file')
            data = r.read()
        self.pos += len(data)
        self.transferred += len(data)
        return data

    def readinto(self, b):
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)


def fetch(season):
    if season < FTN_FIRST_SEASON:
        raise SystemExit(f'{season} is NGS-origin participation: not approved')
    f = RangeFile(URL.format(season=season))
    pf = pq.ParquetFile(f)
    missing = [c for c in COLUMNS if c not in pf.schema_arrow.names]
    if missing:
        raise SystemExit(f'{season}: columns missing {missing}')
    table = pf.read(columns=COLUMNS)
    out = os.path.join(ROOT, 'data', 'nflverse', f'pbp_participation_{season}_min.parquet')
    pq.write_table(table, out)
    ids = [x for v in table.column('players_on_play').to_pylist() if v for x in v.split(';') if x]
    note = {
        'season': season, 'origin': 'FTN Data', 'credit': 'FTN Data via nflverse', 'licence': 'CC-BY-SA 4.0',
        'licence_url': 'https://creativecommons.org/licenses/by-sa/4.0/', 'source_url': URL.format(season=season),
        'columns': COLUMNS, 'rows': table.num_rows, 'file_bytes': f.size, 'bytes_transferred': f.transferred,
        'id_format': 'gsis' if ids and all(i.startswith('00-') for i in ids[:5000]) else 'other',
        'fetched_at': datetime.now(timezone.utc).isoformat(),
        'use': 'local read-only coverage measurement only; not for career-ledger.json or any public/shareable output',
    }
    with open(out.replace('.parquet', '.provenance.json'), 'w', encoding='utf-8') as fh:
        json.dump(note, fh, indent=1)
    print(json.dumps(note))


if __name__ == '__main__':
    for s in sys.argv[1:]:
        fetch(int(s))
