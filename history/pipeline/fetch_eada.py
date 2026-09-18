"""Fetch the EADA institution-programme-year layer (US Department of Education).

Which institutions reported fielding football in which academic year, and the
squad size they reported. That is all this lane is for, and all it takes.

Rights: src_eada / lane 'institution_program_year' in
history/registry/lanes.v2.json. The dataset is published by a US federal agency
under the Equity in Athletics Disclosure Act; no licence text is printed on the
page, so the public-domain status is INFERRED and the lane records that. Every
row stores the survey year, and the reporting basis is 'institution_self_report'
because that is exactly what EADA is — institutions file it themselves.

FIELD ALLOWLIST. The file carries 129 columns, including revenue, expenses and
coaching salaries. None of those has a lane, so none of them is read. A field
with no rights decision is not persisted, and the narrowness is the point: this
is the only EADA lane, and it fails closed on everything else.

    python history/pipeline/fetch_eada.py [--years 2015 2025]

Writes history/.out/eada/football_sponsorship.json (gitignored).
"""
from __future__ import annotations
import argparse, hashlib, io, json, os, statistics, sys, time, urllib.parse, urllib.request, zipfile
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding='utf-8')
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(REPO, 'history', '.out', 'eada')
CACHE = os.path.join(OUT, 'cache')
UA = {'User-Agent': 'PropBetEdgeFootballHistory/0.1 (https://nfl.propbetedge.ai; sales@localhomebuyersusa.com)'}
NOW = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')

API = 'https://ope.ed.gov/athletics/api'
LANDING = 'https://ope.ed.gov/Athletics/public/html/home/home.html'

# EADA numbers sports rather than naming them in the data file, and the
# numbering is NOT stable across years. Assuming a constant code was wrong:
# SPORTSCODE 7 is football in 2017-18 and 2021-25, absent in 2018-19, and in
# 2019-20 it selects a sport with 1,754 institutions and a median squad of 41,
# which is plainly not football.
#
# So the code is DETECTED per year and then verified, rather than trusted.
# Football is the men's sport with by far the largest squads: roughly 600-1,200
# institutions reporting a median around 110. If no code in a year's file fits
# that shape, or more than one does, the year is refused and recorded as a gap.
# Ingesting the wrong sport as football would be worse than missing a year.
# One further wrinkle, also measured: some years list a football row for EVERY
# institution, including those that do not field the sport, with a squad size of
# zero (2019-20 has 1,754 such rows against roughly 877 real programmes). Those
# rows are not noise — they are the negative case, and they are why
# football.college_program_season carries a `sponsored` boolean rather than
# relying on a row's presence. Detection therefore measures the NON-ZERO rows.
FOOTBALL_MIN_MEDIAN_SQUAD = 80
FOOTBALL_INSTITUTION_RANGE = (400, 1500)
FOOTBALL_RUNNER_UP_MARGIN = 1.25          # the winner must be this much larger


def as_number(value):
    """Participation is a number in most years and a string in some. Neither is
    allowed to become a silent zero: an unparseable value returns None."""
    if value is None or value == '':
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None

# Everything we are permitted to read. The file has 129 columns.
ALLOWED_COLUMNS = [
    'unitid',                # IPEDS institution id — a federal identifier
    'institution_name',
    'state_cd',
    'classification_name',   # 'NCAA Division I-FBS', 'NCAA Division I-FCS', ...
    'SPORTSCODE',
    'SUM_PARTIC_MEN',        # the reported squad size
]

# Permitted but not required: the column is spelled differently in older files,
# and unitid is the key we actually join on. A column we may read and that is
# simply absent is a gap, not a failure; a column we may NOT read is never read
# either way.
OPTIONAL_COLUMNS = ['OPEID', 'ope_id', 'OPE_ID', 'city_txt', 'sector_name']


def get(url, cache_name, attempts=3):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, cache_name)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return open(path, 'rb').read()
    last = None
    for i in range(attempts):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
                body = r.read()
            open(path, 'wb').write(body)
            return body
        except Exception as e:                            # noqa: BLE001
            last = e
            print(f'    retry {i + 1}: {type(e).__name__}')
            time.sleep(4 * (i + 1))
    raise last


def file_list():
    return json.loads(get(f'{API}/dataFiles/fileList', 'fileList.json').decode())


def read_year(entry):
    """Return football rows for one academic-year archive, or raise."""
    import openpyxl                                        # local: only this script needs it

    name = entry['FileName']
    url = f'{API}/dataFiles/file?' + urllib.parse.urlencode({'fileName': name})
    blob = get(url, name)
    zf = zipfile.ZipFile(io.BytesIO(blob))
    member = next((n for n in zf.namelist() if n.lower() == 'schools.xlsx'), None)
    if not member:
        raise FileNotFoundError(f'{name}: no schools.xlsx (has {zf.namelist()})')

    wb = openpyxl.load_workbook(io.BytesIO(zf.read(member)), read_only=True, data_only=True)
    ws = wb[wb.sheetnames[0]]
    it = ws.iter_rows(values_only=True)
    header = list(next(it))
    readable = set(ALLOWED_COLUMNS) | set(OPTIONAL_COLUMNS)
    index = {h: i for i, h in enumerate(header) if h in readable}
    missing = [c for c in ALLOWED_COLUMNS if c not in index]
    if missing:
        raise KeyError(f'{name}: missing allowlisted columns {missing}')

    # Read once, grouped by sport code, so the code can be identified from the
    # data rather than assumed. Only allowlisted columns are read out of a row.
    by_code = {}
    for r in it:
        row = {c: r[index[c]] for c in index}
        by_code.setdefault(row['SPORTSCODE'], []).append(row)

    code, stats = detect_football_code(by_code, name)

    rows = []
    for row in by_code[code]:
        squad = as_number(row['SUM_PARTIC_MEN'])
        rows.append({
            'survey_year': entry['Year'],
            'season_year': entry['Year'] - 1,             # academic year 2023-24 -> the 2023 season
            'unitid': str(row['unitid']),
            'opeid': next((str(row[k]).strip() for k in ('OPEID', 'ope_id', 'OPE_ID')
                           if row.get(k) not in (None, '')), None),
            'institution_name': row['institution_name'],
            'state': row['state_cd'],
            'city': row.get('city_txt'),
            'classification': row['classification_name'],
            'sector': row.get('sector_name'),
            # A reported zero means the institution filed and did not field
            # football. An unreadable value means we do not know, and the two
            # are not the same thing.
            'sponsored': None if squad is None else squad > 0,
            'squad_size_reported': int(squad) if squad else None,
        })

    return rows, stats


def detect_football_code(by_code, name):
    """Identify this year's football sport code from the data, or refuse the year."""
    lo, hi = FOOTBALL_INSTITUTION_RANGE
    scored = []
    for code, rows in by_code.items():
        squads = [n for n in (as_number(r['SUM_PARTIC_MEN']) for r in rows) if n]
        if not squads:
            continue
        median = statistics.median(squads)
        scored.append((median, code, len(squads)))
    scored.sort(reverse=True)
    if not scored:
        raise ValueError(f'{name}: no sport rows at all')

    eligible = [s for s in scored if s[0] >= FOOTBALL_MIN_MEDIAN_SQUAD and lo <= s[2] <= hi]
    if not eligible:
        raise ValueError(f'{name}: no sport code looks like football '
                         f'(best: code {scored[0][1]}, median {scored[0][0]}, n {scored[0][2]})')
    median, code, n = eligible[0]
    runner_up = next((s[0] for s in scored if s[1] != code), 0)
    if runner_up and median < runner_up * FOOTBALL_RUNNER_UP_MARGIN:
        raise ValueError(f'{name}: football code is ambiguous — code {code} median {median} '
                         f'is not clearly larger than the next sport ({runner_up})')
    return code, {'sportscode': code, 'median_squad': median, 'sponsoring_institutions': n,
                  'rows_in_file': len(by_code[code]), 'runner_up_median': runner_up}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--years', nargs=2, type=int, default=[2015, 2025],
                    help='inclusive range of EADA survey years (academic year end)')
    args = ap.parse_args()
    lo, hi = args.years
    os.makedirs(OUT, exist_ok=True)

    entries = [e for e in file_list()
               if e['FileName'].startswith('EADA_') and 'Combined' not in e['FileName']
               and lo <= e['Year'] <= hi]
    entries.sort(key=lambda e: e['Year'])
    print(f'EADA football sponsorship, survey years {lo}-{hi}: {len(entries)} archives')

    rows, verified, failures = [], {}, []
    for e in entries:
        try:
            got, stats = read_year(e)
            rows.extend(got)
            verified[e['Year']] = stats
            print(f'  {e["Year"]}  code {stats["sportscode"]}  {stats["sponsoring_institutions"]:5d} sponsoring '
                  f'of {stats["rows_in_file"]:5d} rows   median squad {stats["median_squad"]}')
        except Exception as ex:                            # noqa: BLE001 - recorded, never swallowed
            failures.append({'year': e['Year'], 'file': e['FileName'], 'error': f'{type(ex).__name__}: {ex}'})
            print(f'  {e["Year"]}  FAILED {type(ex).__name__}: {ex}')

    payload = {
        'dataset': 'eada_football_sponsorship',
        'source_id': 'src_eada',
        'lane': 'institution_program_year',
        'licence': 'US federal agency publication; public domain INFERRED (no licence text on the page)',
        'landing_page': LANDING,
        'endpoint': f'{API}/dataFiles/file',
        'sportscode_detected_per_year': verified,
        'sportscode_note': 'EADA sport codes are not stable across years; the code is detected from squad-size shape and verified, never assumed',
        'allowed_columns': ALLOWED_COLUMNS,
        'optional_columns': OPTIONAL_COLUMNS,
        'columns_in_file_not_read': 'the file carries 129 columns; every column outside allowed_columns has no lane and is not read',
        'reporting_basis': 'institution_self_report',
        'retrieved_at': NOW,
        'row_count': len(rows),
        'failed_years': failures,
        'rows': rows,
    }
    payload['content_sha256'] = hashlib.sha256(json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()
    with open(os.path.join(OUT, 'football_sponsorship.json'), 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=1, default=str)
    print(f'  total {len(rows)} institution-years -> {OUT}')


if __name__ == '__main__':
    main()
