"""Fetch the CC0 Wikidata seed for the NFL history slice.

Writes history/.out/seed/wikidata_*.json (gitignored), each with the exact
SPARQL text, retrieval time and a sha256 of the result, so every downstream row
can cite a snapshot. Wikidata structured data is CC0; attribution is courteous,
not required, but we record the QID and property of every statement we use.

    python history/pipeline/fetch_wikidata_seed.py
"""
from __future__ import annotations
import hashlib, json, os, urllib.parse, urllib.request
from datetime import datetime, timezone

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SEED = os.path.join(REPO, 'history', '.out', 'seed')
UA = 'PropBetEdgeFootballHistory/0.1 (https://nfl.propbetedge.ai; sales@localhomebuyersusa.com)'
CROSSWALK = json.load(open(os.path.join(REPO, 'history', 'registry', 'nfl_team_crosswalk.v1.json'), encoding='utf-8'))
QID_TO_ABBR = {t['qid']: t['abbr'] for t in CROSSWALK['teams']}
VALUES = ' '.join(f'wd:{t["qid"]}' for t in CROSSWALK['teams'])

QUERIES = {
    'teams': f"""
SELECT ?team ?teamLabel ?inception WHERE {{
  VALUES ?team {{ {VALUES} }}
  OPTIONAL {{ ?team wdt:P571 ?inception }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}""",
    'divisions': f"""
SELECT ?team ?divLabel ?confLabel WHERE {{
  VALUES ?team {{ {VALUES} }}
  OPTIONAL {{ ?team wdt:P361 ?div . OPTIONAL {{ ?div wdt:P361 ?conf }} }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}""",
    'name_history': f"""
SELECT ?team ?name ?start ?end WHERE {{
  VALUES ?team {{ {VALUES} }}
  ?team p:P1448 ?st . ?st ps:P1448 ?name .
  OPTIONAL {{ ?st pq:P580 ?start }} OPTIONAL {{ ?st pq:P582 ?end }}
}} ORDER BY ?team ?start""",
    'superbowl': """
SELECT ?game ?gameLabel ?date ?winnerLabel ?venueLabel WHERE {
  ?game rdfs:label "Super Bowl LVIII"@en .
  OPTIONAL { ?game wdt:P585 ?date } OPTIONAL { ?game wdt:P1346 ?winner } OPTIONAL { ?game wdt:P276 ?venue }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}""",
}

def sparql(query: str):
    url = 'https://query.wikidata.org/sparql?format=json&query=' + urllib.parse.quote(query)
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/sparql-results+json'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)['results']['bindings']

def value(binding, key):
    v = binding.get(key)
    return v['value'].replace('http://www.wikidata.org/entity/', '') if v else None

def shape(name, rows):
    out = []
    for b in rows:
        qid = value(b, 'team')
        abbr = QID_TO_ABBR.get(qid)
        if name == 'teams':
            out.append({'abbr': abbr, 'qid': qid, 'label': value(b, 'teamLabel'), 'inception': value(b, 'inception')})
        elif name == 'divisions':
            out.append({'abbr': abbr, 'qid': qid, 'division': value(b, 'divLabel'), 'conference': value(b, 'confLabel')})
        elif name == 'name_history':
            out.append({'abbr': abbr, 'qid': qid, 'name': value(b, 'name'), 'start': value(b, 'start'), 'end': value(b, 'end')})
        else:
            out.append({k: value(b, k) for k in b})
    return out

os.makedirs(SEED, exist_ok=True)
for name, query in QUERIES.items():
    rows = shape(name, sparql(query))
    payload = {
        'dataset': f'wikidata_{name}', 'source_id': 'src_wikidata', 'licence': 'CC0-1.0',
        'endpoint': 'https://query.wikidata.org/sparql', 'query': query.strip(),
        'retrieved_at': datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
        'row_count': len(rows), 'rows': rows,
    }
    payload['content_sha256'] = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()
    json.dump(payload, open(os.path.join(SEED, f'wikidata_{name}.json'), 'w', encoding='utf-8'), indent=1)
    print(f'{name}: {len(rows)} rows')
