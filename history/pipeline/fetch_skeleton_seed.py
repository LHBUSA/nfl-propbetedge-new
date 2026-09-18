"""Fetch the CC0 Wikidata seed for the all-era rights-clean skeleton.

Leagues, franchises, team identities over time, relocations and renames,
conferences and divisions, venues and their names over time, championships, and
head coaches — for the NFL, the AFL (1960-69) and the AAFC.

Writes history/.out/skeleton-seed/*.json (gitignored), each with the exact
SPARQL text, the retrieval time and a sha256 of the result so every downstream
row can cite a snapshot. A query that fails is recorded as a gap, never as an
empty truth.

    python history/pipeline/fetch_skeleton_seed.py
"""
from __future__ import annotations
import hashlib, json, os, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding='utf-8')
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(REPO, 'history', '.out', 'skeleton-seed')
UA = {'User-Agent': 'PropBetEdgeFootballHistory/0.1 (https://nfl.propbetedge.ai; sales@localhomebuyersusa.com)',
      'Accept': 'application/sparql-results+json'}

LEAGUES = {'Q1215884': 'NFL', 'Q464508': 'AFL', 'Q389307': 'AAFC'}
TEAM_CLASSES = ['wd:Q17156793', 'wd:Q9275911']          # American football team, defunct American football team
NOW = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def sparql(query: str, attempts: int = 3):
    last = None
    for i in range(attempts):
        try:
            url = 'https://query.wikidata.org/sparql?format=json&query=' + urllib.parse.quote(query)
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=240) as r:
                return json.load(r)['results']['bindings']
        except Exception as e:                            # noqa: BLE001 - recorded, not swallowed
            last = e
            time.sleep(3 * (i + 1))
    raise last


def flat(rows):
    return [{k: v['value'].replace('http://www.wikidata.org/entity/', '') for k, v in r.items()} for r in rows]


def chunks(items, size):
    for i in range(0, len(items), size):
        yield items[i:i + size]


# Wikidata dates carry a precision (9 year, 10 month, 11 day). Fetching the
# bare wdt:/pq: value hides it, and a year-precision fact then masquerades as
# 1 January. Every interval bound is read through its value node instead.
DATED = """
  OPTIONAL { ?st pqv:P580 ?startNode . ?startNode wikibase:timeValue ?start ; wikibase:timePrecision ?startPrecision }
  OPTIONAL { ?st pqv:P582 ?endNode . ?endNode wikibase:timeValue ?end ; wikibase:timePrecision ?endPrecision }"""


def values(qids):
    return ' '.join(f'wd:{q}' for q in qids)


def save(name, rows, query, note=None, failures=None):
    payload = {
        'dataset': f'wikidata_{name}', 'source_id': 'src_wikidata', 'licence': 'CC0-1.0',
        'endpoint': 'https://query.wikidata.org/sparql', 'query': query.strip(),
        'retrieved_at': NOW, 'row_count': len(rows), 'note': note,
        'failed_chunks': failures or [], 'rows': rows,
    }
    payload['content_sha256'] = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()
    os.makedirs(OUT, exist_ok=True)
    json.dump(payload, open(os.path.join(OUT, f'{name}.json'), 'w', encoding='utf-8'), indent=1)
    print(f'{name}: {len(rows)} rows' + (f' ({len(failures)} failed chunks)' if failures else ''))
    return payload


# ---------------------------------------------------------------- 1. teams in the three leagues
TEAMS_Q = f"""
SELECT ?team ?teamLabel ?league ?class ?inception ?inceptionPrecision ?dissolved ?dissolvedPrecision ?replaces ?replacedBy WHERE {{
  VALUES ?league {{ {values(LEAGUES)} }}
  VALUES ?class {{ {' '.join(TEAM_CLASSES)} }}
  ?team wdt:P118 ?league ; wdt:P31 ?class .
  OPTIONAL {{ ?team p:P571/psv:P571 ?inceptionNode .
              ?inceptionNode wikibase:timeValue ?inception ; wikibase:timePrecision ?inceptionPrecision }}
  OPTIONAL {{ ?team p:P576/psv:P576 ?dissolvedNode .
              ?dissolvedNode wikibase:timeValue ?dissolved ; wikibase:timePrecision ?dissolvedPrecision }}
  OPTIONAL {{ ?team wdt:P1365 ?replaces }} OPTIONAL {{ ?team wdt:P1366 ?replacedBy }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}"""
teams = flat(sparql(TEAMS_Q))
save('teams', teams, TEAMS_Q)

# lineage expansion: pull in items named by replaces/replaced-by that are not in the set
known = {t['team'] for t in teams}
frontier = {q for t in teams for q in (t.get('replaces'), t.get('replacedBy')) if q and q not in known}
expanded, hops = [], 0
while frontier and hops < 3:
    hops += 1
    q = f"""
SELECT ?team ?teamLabel ?league ?class ?inception ?inceptionPrecision ?dissolved ?dissolvedPrecision ?replaces ?replacedBy WHERE {{
  VALUES ?team {{ {values(sorted(frontier))} }}
  OPTIONAL {{ ?team wdt:P118 ?league }} OPTIONAL {{ ?team wdt:P31 ?class }}
  OPTIONAL {{ ?team p:P571/psv:P571 ?inceptionNode .
              ?inceptionNode wikibase:timeValue ?inception ; wikibase:timePrecision ?inceptionPrecision }}
  OPTIONAL {{ ?team p:P576/psv:P576 ?dissolvedNode .
              ?dissolvedNode wikibase:timeValue ?dissolved ; wikibase:timePrecision ?dissolvedPrecision }}
  OPTIONAL {{ ?team wdt:P1365 ?replaces }} OPTIONAL {{ ?team wdt:P1366 ?replacedBy }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}"""
    rows = flat(sparql(q))
    expanded += rows
    known |= frontier
    frontier = {x for r in rows for x in (r.get('replaces'), r.get('replacedBy')) if x and x not in known}
save('teams_lineage_expansion', expanded, 'see teams.json query; expanded over P1365/P1366', note=f'{hops} hops')

ALL_TEAMS = sorted(known)

# ---------------------------------------------------------------- 2. per-team detail (chunked)
def chunked_query(name, template, qids, size=25, note=None):
    template = template.replace('%DATED%', DATED)
    rows, failures = [], []
    for chunk in chunks(qids, size):
        q = template.replace('%DATED%', DATED).replace('%VALUES%', values(chunk))
        try:
            rows += flat(sparql(q))
        except Exception as e:                            # noqa: BLE001
            failures.append({'qids': chunk, 'error': f'{type(e).__name__}: {str(e)[:120]}'})
    return save(name, rows, template, note=note, failures=failures)


chunked_query('team_names', """
SELECT ?team ?name ?start ?startPrecision ?end ?endPrecision WHERE {
  VALUES ?team { %VALUES% }
  ?team p:P1448 ?st . ?st ps:P1448 ?name .%DATED%
}""", ALL_TEAMS, note='official name (P1448) with start/end qualifiers')

chunked_query('team_locations', """
SELECT ?team ?locationLabel ?start ?startPrecision ?end ?endPrecision WHERE {
  VALUES ?team { %VALUES% }
  ?team p:P159 ?st . ?st ps:P159 ?location .%DATED%
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}""", ALL_TEAMS, note='headquarters location (P159) with dates')

chunked_query('team_venues', """
SELECT ?team ?venue ?venueLabel ?start ?startPrecision ?end ?endPrecision WHERE {
  VALUES ?team { %VALUES% }
  ?team p:P115 ?st . ?st ps:P115 ?venue .%DATED%
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}""", ALL_TEAMS, note='home venue (P115) with dates')

chunked_query('team_divisions', """
SELECT ?team ?div ?divLabel ?conf ?confLabel WHERE {
  VALUES ?team { %VALUES% }
  ?team wdt:P361 ?div .
  OPTIONAL { ?div wdt:P361 ?conf }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}""", ALL_TEAMS, note='part-of (P361); undated on Wikidata, so current membership only')

coaches = chunked_query('team_coaches', """
SELECT ?team ?coach ?coachLabel ?start ?startPrecision ?end ?endPrecision WHERE {
  VALUES ?team { %VALUES% }
  ?team p:P286 ?st . ?st ps:P286 ?coach .%DATED%
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}""", ALL_TEAMS, size=15, note='head coach (P286) with dates')

# ---------------------------------------------------------------- 3. venues
venue_qids = sorted({r['venue'] for r in json.load(open(os.path.join(OUT, 'team_venues.json'), encoding='utf-8'))['rows'] if r.get('venue')})
chunked_query('venues', """
SELECT ?venue ?venueLabel ?lat ?lon ?cityLabel ?countryLabel ?opened ?closed WHERE {
  VALUES ?venue { %VALUES% }
  OPTIONAL { ?venue p:P625 ?coord . ?coord psv:P625 ?cv . ?cv wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lon }
  OPTIONAL { ?venue wdt:P131 ?city } OPTIONAL { ?venue wdt:P17 ?country }
  OPTIONAL { ?venue wdt:P1619 ?opened } OPTIONAL { ?venue wdt:P3999 ?closed }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}""", venue_qids, size=20, note='venue core facts')

chunked_query('venue_names', """
SELECT ?venue ?name ?start ?startPrecision ?end ?endPrecision WHERE {
  VALUES ?venue { %VALUES% }
  ?venue p:P1448 ?st . ?st ps:P1448 ?name .%DATED%
}""", venue_qids, size=20, note='venue official name over time (naming rights do not create a new venue)')

# ---------------------------------------------------------------- 4. championships
CHAMP_Q = """
SELECT ?game ?gameLabel ?class ?date ?winner ?winnerLabel ?venue ?venueLabel WHERE {
  ?game wdt:P31 ?class .
  VALUES ?class { wd:Q32096 }
  OPTIONAL { ?game wdt:P585 ?date } OPTIONAL { ?game wdt:P1346 ?winner } OPTIONAL { ?game wdt:P276 ?venue }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY ?date"""
save('championships_super_bowl', flat(sparql(CHAMP_Q)), CHAMP_Q, note='Super Bowl items; Wikidata carries winners but no participants (measured: 0 of 64)')

# Pre-merger championship games are modelled per item rather than by one class.
PRE_MERGER_Q = """
SELECT ?game ?gameLabel ?class ?classLabel ?date ?winnerLabel ?venueLabel WHERE {
  ?game wdt:P31 ?class .
  ?class rdfs:label ?cl . FILTER(LANG(?cl) = "en" && CONTAINS(LCASE(?cl), "championship game"))
  OPTIONAL { ?game wdt:P585 ?date } OPTIONAL { ?game wdt:P1346 ?winner } OPTIONAL { ?game wdt:P276 ?venue }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY ?date LIMIT 400"""
try:
    save('championships_pre_merger', flat(sparql(PRE_MERGER_Q)), PRE_MERGER_Q, note='NFL/AFL/AAFC championship games where a championship-game class exists')
except Exception as e:                                    # noqa: BLE001
    save('championships_pre_merger', [], PRE_MERGER_Q, note=f'query failed: {type(e).__name__}', failures=[{'error': str(e)[:160]}])

# ---------------------------------------------------------------- 5. league seasons
SEASONS_Q = """
SELECT ?season ?seasonLabel ?league ?date ?start ?end WHERE {
  VALUES ?league { wd:Q1215884 wd:Q464508 wd:Q389307 }
  ?season wdt:P3450 ?league .
  OPTIONAL { ?season wdt:P585 ?date } OPTIONAL { ?season wdt:P580 ?start } OPTIONAL { ?season wdt:P582 ?end }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY ?date"""
save('league_seasons', flat(sparql(SEASONS_Q)), SEASONS_Q, note='season of league (P3450): the season ontology across eras')

print('\nseed written to', OUT)
