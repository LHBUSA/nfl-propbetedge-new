"""Fetch the CC0 Wikidata seed for the college->NFL development spine.

Institutions, college football programmes, conferences, college head coaches,
and the player->college association for people who reached professional
football, together with the external identifiers needed to reconcile them.

Rights: Wikidata structured data is CC0 (Wikidata:Licensing). This seed is the
'college_affiliation' and 'identifiers' lanes of src_wikidata in
history/registry/lanes.v2.json. It carries a SAMPLING BIAS that the lane policy
enforces and that every downstream consumer must respect: Wikidata holds items
for people notable enough to have one, which over-represents players who
reached the NFL. Absence here is not evidence that someone did not play.

No CollegeFootballData request is made by this script or any other in the
pipeline; CFBD ingestion is disabled.

Writes history/.out/college-seed/*.json (gitignored), each carrying the exact
SPARQL text, the retrieval time and a sha256 so every downstream row can cite a
snapshot. A query that fails is recorded as a gap, never as an empty truth.

    python history/pipeline/fetch_college_seed.py
"""
from __future__ import annotations
import hashlib, json, os, string, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding='utf-8')
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(REPO, 'history', '.out', 'college-seed')
UA = {'User-Agent': 'PropBetEdgeFootballHistory/0.1 (https://nfl.propbetedge.ai; sales@localhomebuyersusa.com)',
      'Accept': 'application/sparql-results+json'}
NOW = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')

ENDPOINT = 'https://query.wikidata.org/sparql'
AMERICAN_FOOTBALL_PLAYER = 'Q19204627'
COLLEGE_FOOTBALL = 'Q1109032'
ATHLETIC_CONFERENCE = 'Q2992826'

# MEASURED, not assumed. Two things about Wikidata's shape decide this whole
# pipeline, and both were found by probing rather than by reading about it:
#
#   * P641 "sport" = college football is a statement on PEOPLE, not on teams.
#     Querying it does not return programmes; it returns 2,893 players. There is
#     no general college-team class to enumerate.
#   * The programme entities that DO exist are the 195 items carrying P8761
#     (Sports-Reference college football school id). They are linked to their
#     university by P831 "parent club" (194 of 195), to their conference by P118,
#     and to a head coach by P286.
#
# So the programme layer is FBS-scale and no larger, and the player edge (P69,
# 24,096 people with a PFR id) reaches the UNIVERSITY item, which is a different
# item from the programme. Joining them is the parent-club edge, and where that
# edge is missing the player keeps a school association with no programme —
# which is the honest state, not a defect to paper over.


def sparql(query: str, attempts: int = 3, timeout: int = 300):
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(
                ENDPOINT, data=urllib.parse.urlencode({'query': query, 'format': 'json'}).encode(),
                headers={**UA, 'Content-Type': 'application/x-www-form-urlencoded'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)['results']['bindings']
        except Exception as e:                            # noqa: BLE001 - recorded, not swallowed
            last = e
            print(f'    retry {i + 1}: {type(e).__name__}')
            time.sleep(5 * (i + 1))
    raise last


def flat(rows):
    out = []
    for r in rows:
        row = {}
        for k, v in r.items():
            val = v['value']
            if v.get('type') == 'uri':
                val = val.replace('http://www.wikidata.org/entity/', '')
            row[k] = val
        out.append(row)
    return out


def save(name, rows, query, note=None, failures=None):
    os.makedirs(OUT, exist_ok=True)
    payload = {
        'dataset': f'wikidata_college_{name}', 'source_id': 'src_wikidata',
        'lane': 'college_affiliation', 'licence': 'CC0-1.0', 'endpoint': ENDPOINT,
        'query': query.strip(), 'retrieved_at': NOW, 'row_count': len(rows),
        'note': note, 'failed_chunks': failures or [], 'rows': rows,
    }
    payload['content_sha256'] = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()
    with open(os.path.join(OUT, f'{name}.json'), 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print(f'  {name:24s} {len(rows):6d} rows' + (f'  ({len(failures)} chunks failed)' if failures else ''))
    return payload


# The player query is the large one. Chunking on the first character of the
# Pro-Football-Reference id keeps each request inside the public endpoint's
# timeout; the id is an identifier VALUE (CC0), not PFR data.
PLAYERS = """
SELECT ?item ?itemLabel ?pfr ?nflcom ?espn ?srcfb ?dob ?college ?collegeLabel ?start ?end ?startPrec ?endPrec WHERE {
  ?item wdt:P3561 ?pfr .
  FILTER(STRSTARTS(?pfr, "%s/"))
  OPTIONAL { ?item wdt:P9338 ?nflcom }
  OPTIONAL { ?item wdt:P3686 ?espn }
  OPTIONAL { ?item wdt:P3697 ?srcfb }
  OPTIONAL { ?item wdt:P569 ?dob }
  OPTIONAL {
    ?item p:P69 ?st .
    ?st ps:P69 ?college .
    OPTIONAL { ?st pqv:P580 ?sNode . ?sNode wikibase:timeValue ?start ; wikibase:timePrecision ?startPrec }
    OPTIONAL { ?st pqv:P582 ?eNode . ?eNode wikibase:timeValue ?end ; wikibase:timePrecision ?endPrec }
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
"""

# Whether a person played college football at all. P641 "sport" on the PERSON is
# how Wikidata records it; it does NOT say where, so this is a person-level fact
# and is never combined with an attendance row to manufacture "played there".
PLAYED = """
SELECT ?item ?pfr WHERE {
  ?item wdt:P3561 ?pfr .
  FILTER(STRSTARTS(?pfr, "%s/"))
  ?item wdt:P641 wd:""" + COLLEGE_FOOTBALL + """ .
}
"""

PROGRAMS = """
SELECT ?team ?teamLabel ?srcfbSchool ?school ?schoolLabel ?conference ?conferenceLabel
       ?venue ?venueLabel ?inception ?coach ?coachLabel WHERE {
  ?team wdt:P8761 ?srcfbSchool .
  OPTIONAL { ?team wdt:P831 ?school }
  OPTIONAL { ?team wdt:P118 ?conference }
  OPTIONAL { ?team wdt:P115 ?venue }
  OPTIONAL { ?team wdt:P571 ?inception }
  OPTIONAL { ?team wdt:P286 ?coach }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
"""

# Institutions that a drafted player is recorded as having attended. Restricted
# to universities so that a high school does not become a "programme".
# P1771 is the IPEDS unit id, which is EADA's `unitid`. It is the clean join
# between the CC0 institution layer and the federal programme-year layer, and it
# is why the two can be combined without matching on institution NAME — which
# would merge "Miami" in Florida with "Miami" in Ohio on its first attempt.
SCHOOLS = """
SELECT DISTINCT ?school ?schoolLabel ?locationLabel ?ncaaOrg ?ipeds ?inception WHERE {
  {
    # anything a programme names as its parent club
    ?prog wdt:P8761 [] ; wdt:P831 ?school .
  } UNION {
    # any P69 target of someone with a PFR id that carries an IPEDS unit id.
    # The IPEDS id is the test, not the class: "university" is applied
    # inconsistently on Wikidata, and a federal postsecondary identifier is a
    # far better signal that the item is a US college than P31 is.
    ?p wdt:P3561 [] ; wdt:P69 ?school .
    ?school wdt:P1771 ?anyIpeds .
  } UNION {
    ?p2 wdt:P3561 [] ; wdt:P69 ?school .
    ?school wdt:P31/wdt:P279* wd:Q38723 .
    ?school wdt:P17 wd:Q30 .
  }
  OPTIONAL { ?school wdt:P131 ?location }
  OPTIONAL { ?school wdt:P8817 ?ncaaOrg }
  OPTIONAL { ?school wdt:P1771 ?ipeds }
  OPTIONAL { ?school wdt:P571 ?inception }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
"""

CONFERENCES = """
SELECT ?conference ?conferenceLabel ?inception ?dissolved ?shortName WHERE {
  ?conference wdt:P31/wdt:P279* wd:%s .
  ?conference wdt:P17 wd:Q30 .
  OPTIONAL { ?conference wdt:P571 ?inception }
  OPTIONAL { ?conference wdt:P576 ?dissolved }
  OPTIONAL { ?conference wdt:P1813 ?shortName }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
""" % ATHLETIC_CONFERENCE

COLLEGE_COACHES = """
SELECT ?team ?teamLabel ?coach ?coachLabel ?start ?end ?startPrec ?endPrec ?ncaaCoach WHERE {
  ?team wdt:P8761 [] .
  ?team p:P286 ?st .
  ?st ps:P286 ?coach .
  OPTIONAL { ?coach wdt:P8777 ?ncaaCoach }
  OPTIONAL { ?st pqv:P580 ?sNode . ?sNode wikibase:timeValue ?start ; wikibase:timePrecision ?startPrec }
  OPTIONAL { ?st pqv:P582 ?eNode . ?eNode wikibase:timeValue ?end ; wikibase:timePrecision ?endPrec }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
"""

# The draft edge, from Wikidata's own statements. It is sparse — the prior audit
# measured 263 "drafted by" claims — and that sparseness is the honest state.
# Nothing fills the gap from Pro-Football-Reference: the registry marks every
# draft-detail source we hold do_not_use, and a widely-known fact is not a licence.
DRAFT = """
SELECT ?item ?pfr ?team ?teamLabel ?draftYear ?pick ?round WHERE {
  ?item wdt:P3561 ?pfr .
  ?item p:P647 ?st .
  ?st ps:P647 ?team .
  OPTIONAL { ?st pq:P585 ?draftYear }
  OPTIONAL { ?st pq:P1352 ?pick }
  OPTIONAL { ?st pq:P1545 ?round }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
"""

PREFIXES = list(string.ascii_uppercase)


def chunked(name, template, prefixes=PREFIXES):
    rows, failures = [], []
    for p in prefixes:
        try:
            got = flat(sparql(template % p))
            rows.extend(got)
            print(f'    {p}: {len(got)}')
        except Exception as e:                            # noqa: BLE001
            failures.append({'chunk': p, 'error': f'{type(e).__name__}: {e}'})
            print(f'    {p}: FAILED {type(e).__name__}')
    return rows, failures


def main():
    os.makedirs(OUT, exist_ok=True)
    print(f'college seed -> {OUT}')

    print('  players (chunked by PFR id initial)')
    rows, failures = chunked('players', PLAYERS)
    save('players', rows, PLAYERS, note='P69 educated at; attendance, not necessarily football', failures=failures)

    print('  played (P54 college football teams)')
    rows, failures = chunked('played', PLAYED)
    save('played', rows, PLAYED, note='P641 sport = college football on the person; says THAT they played, never where', failures=failures)

    for name, query, note in [
        ('programs', PROGRAMS, 'college football programmes and their institutions'),
        ('schools', SCHOOLS, 'US universities attended by someone with a PFR id'),
        ('conferences', CONFERENCES, 'US athletic conferences'),
        ('college_coaches', COLLEGE_COACHES, 'P6087 head coach of college football teams'),
        ('draft', DRAFT, 'P647 drafted by; sparse by nature, and not backfilled from any other source'),
    ]:
        print(f'  {name}')
        try:
            save(name, flat(sparql(query)), query, note=note)
        except Exception as e:                            # noqa: BLE001
            save(name, [], query, note=note, failures=[{'chunk': 'all', 'error': f'{type(e).__name__}: {e}'}])

    print('done')


if __name__ == '__main__':
    main()
