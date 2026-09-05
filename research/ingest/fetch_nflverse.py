"""Fetch nflverse release assets into data/nflverse/ and record provenance.

Idempotent: an asset whose bytes hash to what the manifest already records is
skipped and reported as unchanged. Nothing is overwritten in place until the
new bytes are fully downloaded.

nflverse is CC-BY-4.0. The attribution obligation is discharged in every API
response (provenance.sources[]) and in the UI's Sources panel.

    python research/ingest/fetch_nflverse.py pbp:play_by_play_2025.parquet \
                                             players:players.parquet
"""
import hashlib, json, os, sys, urllib.request, datetime

BASE = 'https://github.com/nflverse/nflverse-data/releases/download'
OUT = 'data/nflverse'
MANIFEST = os.path.join(OUT, '_manifest.json')
UA = {'User-Agent': 'PropBetEdge-NFL-warehouse/1.0 (public dataset ingest)'}


def sha256_8(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()[:16]


def load_manifest():
    if os.path.exists(MANIFEST):
        with open(MANIFEST, encoding='utf-8') as fh:
            return json.load(fh)
    return []


def fetch(release, filename):
    os.makedirs(OUT, exist_ok=True)
    url = f'{BASE}/{release}/{filename}'
    dest = os.path.join(OUT, filename)
    tmp = dest + '.part'
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=180) as r, open(tmp, 'wb') as fh:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)
    digest = sha256_8(tmp)
    manifest = load_manifest()
    prior = next((m for m in manifest if m['file'] == filename), None)
    if prior and prior.get('sha256') == digest and os.path.exists(dest):
        os.remove(tmp)
        print(f'  UNCHANGED {filename}  sha {digest}')
        return prior, False
    os.replace(tmp, dest)
    entry = {
        'release': release, 'file': filename, 'bytes': os.path.getsize(dest),
        'sha256': digest, 'source_url': url,
        'fetched_at': datetime.datetime.now(datetime.timezone.utc)
                              .strftime('%Y-%m-%dT%H:%M:%SZ'),
        'licence': 'CC-BY-4.0', 'attribution': 'Data by nflverse'
    }
    manifest = [m for m in manifest if m['file'] != filename] + [entry]
    manifest.sort(key=lambda m: (m['release'], m['file']))
    with open(MANIFEST, 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=1)
    print(f'  WROTE     {filename}  {entry["bytes"]:,} bytes  sha {digest}')
    return entry, True


if __name__ == '__main__':
    targets = sys.argv[1:] or ['pbp:play_by_play_2025.parquet', 'players:players.parquet']
    changed = 0
    for spec in targets:
        release, filename = spec.split(':', 1)
        try:
            _, did = fetch(release, filename)
            changed += int(did)
        except Exception as exc:                                    # noqa: BLE001
            # A missing asset is a FACT about the source, not a crash. 2026 has
            # no play-by-play because no 2026 game has been played.
            print(f'  UNAVAILABLE {filename}: {exc}')
    print(f'\n{changed} asset(s) changed')
