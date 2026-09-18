"""Build the rights-clean historical skeleton from the CC0 Wikidata seed.

Leagues, franchises, team identities through time, relocations and renames,
conferences and divisions, venues and their names, league seasons, head coaches
and championship results — NFL, AFL (1960-69) and AAFC.

Rights: Wikidata structured data is CC0, so every row here may be published.
Nothing is inferred to fill a gap: an unknown bound is null with a stated basis,
and a fact Wikidata does not carry simply is not written.

    python history/pipeline/build_skeleton.py      (after fetch_skeleton_seed.py)

Writes CSV to history/.out/skeleton/ (gitignored) plus a coverage report.
"""
from __future__ import annotations
import csv, hashlib, json, os, re, sys
from collections import defaultdict
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding='utf-8')
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SEED = os.path.join(REPO, 'history', '.out', 'skeleton-seed')
OUT = os.path.join(REPO, 'history', '.out', 'skeleton')
NOW = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
PARSER = ('pbe-history-skeleton', '0.1.0')

LEAGUES = {
    'Q1215884': ('glg_nfl', 'National Football League', 'NFL'),
    'Q464508': ('glg_afl_1960', 'American Football League', 'AFL'),
    'Q389307': ('glg_aafc', 'All-America Football Conference', 'AAFC'),
}

tables: dict[str, list[dict]] = defaultdict(list)
def row(table, **kw): tables[table].append(kw)
def gid(prefix, *parts): return f'{prefix}_{hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:20]}'
PRECISION_NAME = {'11': 'day', '10': 'month', '9': 'year'}

def date_parts(value):
    if not value or not isinstance(value, str): return None
    m = re.match(r'^(-?\d{4})-(\d{2})-(\d{2})', value)
    if not m: return None
    if m.group(1).startswith('-'): return None            # BCE never occurs here; refuse rather than mangle
    return int(m.group(1)), int(m.group(2)), int(m.group(3))

def day(value, precision=None):
    """A point in time, placed no more precisely than the source stated it.

    Wikidata returns 1918-01-01 for a fact known only to the year, so the
    precision that came with the value decides what the date may claim.
    """
    pt = date_parts(value)
    if not pt: return None
    y, mo, d = pt
    name = PRECISION_NAME.get(str(precision), 'day')
    if name == 'year': return f'{y:04d}-01-01'
    if name == 'month': return f'{y:04d}-{mo:02d}-01'
    return f'{y:04d}-{mo:02d}-{d:02d}'

def end_bound(value, precision=None):
    """Wikidata's end time (P582) is the last moment a fact held; our intervals
    are half-open, so the stored bound is the first instant after it. A name
    ending "1996" held through all of 1996 and the bound is 1997-01-01 — the
    old code stored 1996-01-01 and silently deleted that team's last season.
    """
    pt = date_parts(value)
    if not pt: return None
    y, mo, d = pt
    name = PRECISION_NAME.get(str(precision), 'day')
    if name == 'year': return f'{y + 1:04d}-01-01'
    if name == 'month':
        return f'{y + 1:04d}-01-01' if mo == 12 else f'{y:04d}-{mo + 1:02d}-01'
    from datetime import date as _date, timedelta as _td
    return str(_date(y, mo, d) + _td(days=1))

def precision_of(value, precision):
    if not date_parts(value): return 'unknown'
    return PRECISION_NAME.get(str(precision), 'day')

# ---------------------------------------------------------------- seed + snapshots
seed = {}
for name in ('teams', 'teams_lineage_expansion', 'team_names', 'team_locations', 'team_venues',
             'team_divisions', 'team_coaches', 'venues', 'venue_names',
             'championships_super_bowl', 'championships_pre_merger', 'league_seasons'):
    path = os.path.join(SEED, f'{name}.json')
    seed[name] = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else {'rows': [], 'content_sha256': 'absent', 'retrieved_at': NOW, 'failed_chunks': [{'error': 'seed file missing'}]}

registry = {s['source_id']: s for s in json.load(open(os.path.join(REPO, 'history', 'registry', 'sources.v1.json'), encoding='utf-8'))['sources']}
for source_id in ('src_wikidata', 'src_pbe_curated_crosswalk'):
    s = registry[source_id]
    row('football_src.source', source_id=source_id, name=s['name'], governing_org=s.get('governing_org') or s.get('origin'),
        origin_source_id=None, licence_class=s['licence_class'], commercial_verdict=s['commercial_verdict'],
        obligations=s.get('obligations'), terms_url=s.get('terms_url'), terms_quote=s.get('terms_quote'),
        decided_by=None, decided_at=None, display_policy=s['display_policy'],
        model_use_allowed=s['model_use_allowed'], notes=s.get('notes'))

SNAP = {}
for name, payload in seed.items():
    snap = gid('snp', 'wikidata', name, payload.get('content_sha256', ''))
    SNAP[name] = snap
    row('football_src.source_snapshot', source_snapshot_id=snap, source_id='src_wikidata',
        dataset=f'wikidata_{name}', retrieved_from='https://query.wikidata.org/sparql',
        retrieved_at=payload.get('retrieved_at', NOW), content_sha256=payload.get('content_sha256', 'absent'),
        bytes=None, r2_object_key=None, parser_name=PARSER[0], parser_version=PARSER[1],
        row_count=len(payload.get('rows', [])), season_min=None, season_max=None)

def cite(entity_type, entity_id, seed_name, key, role='supports'):
    row('football_src.entity_source_record', entity_type=entity_type, entity_id=entity_id,
        source_snapshot_id=SNAP[seed_name], source_record_key=key, role=role, observed_at=NOW)

# ---------------------------------------------------------------- leagues
row('football.organization', organization_id='gorg_nfl', name='National Football League', kind='league_body',
    country_code='US', founded_on=None, dissolved_on=None, source_snapshot_id=SNAP['teams'])
for qid, (league_id, name, short) in LEAGUES.items():
    row('football.league', league_id=league_id, organization_id=('gorg_nfl' if short == 'NFL' else None),
        name=name, short_name=short, level='professional', country_code='US',
        effective_from=None, effective_to=None, source_snapshot_id=SNAP['teams'])
    row('football_src.external_id', entity_type='league', entity_id=league_id, id_system='wikidata_qid',
        id_value=qid, source_snapshot_id=SNAP['teams'], confidence=1.0, effective_from=None, effective_to=None, observed_at=NOW)

# ---------------------------------------------------------------- team items and franchise clustering
items: dict[str, dict] = {}
leagues_of: dict[str, set] = defaultdict(set)
edges: list[tuple[str, str]] = []
for seed_name in ('teams', 'teams_lineage_expansion'):
    for r in seed[seed_name]['rows']:
        qid = r.get('team')
        if not qid: continue
        it = items.setdefault(qid, {'qid': qid, 'label': r.get('teamLabel') or qid, 'inception': None, 'dissolved': None, 'seed': seed_name})
        it['inception'] = it['inception'] or day(r.get('inception'), r.get('inceptionPrecision'))
        it['inception_precision'] = it.get('inception_precision') or precision_of(r.get('inception'), r.get('inceptionPrecision'))
        it['dissolved'] = it['dissolved'] or end_bound(r.get('dissolved'), r.get('dissolvedPrecision'))
        it['dissolved_precision'] = it.get('dissolved_precision') or precision_of(r.get('dissolved'), r.get('dissolvedPrecision'))
        if r.get('league') in LEAGUES: leagues_of[qid].add(r['league'])
        for other in (r.get('replaces'), r.get('replacedBy')):
            if other: edges.append((qid, other))

# union-find over lineage edges: one franchise per connected component
parent = {q: q for q in items}
def find(x):
    parent.setdefault(x, x)
    while parent[x] != x:
        parent[x] = parent[parent[x]]; x = parent[x]
    return x
def union(a, b):
    ra, rb = find(a), find(b)
    if ra != rb: parent[ra] = rb
for a, b in edges:
    if a in items and b in items: union(a, b)

components: dict[str, list[str]] = defaultdict(list)
for qid in items: components[find(qid)].append(qid)

franchise_of_item: dict[str, str] = {}
for rootq, members in components.items():
    members.sort(key=lambda q: (items[q]['inception'] or '9999', items[q]['label']))
    oldest = members[0]
    franchise_id = gid('gfr', 'wikidata', rootq)
    label = items[members[-1]]['label']
    row('football.franchise', global_football_franchise_id=franchise_id,
        canonical_label=f'{label} (franchise lineage)',
        founded_on=items[oldest]['inception'], terminated_on=None, source_snapshot_id=SNAP['teams'])
    for q in members:
        franchise_of_item[q] = franchise_id
        row('football_src.external_id', entity_type='franchise', entity_id=franchise_id, id_system='wikidata_qid',
            id_value=q, source_snapshot_id=SNAP['teams'], confidence=0.9, effective_from=None, effective_to=None, observed_at=NOW)
        cite('franchise', franchise_id, 'teams', f'{q}/P118')

# ---------------------------------------------------------------- identities
names_by_team: dict[str, list[dict]] = defaultdict(list)
for r in seed['team_names']['rows']:
    if r.get('team') and r.get('name'):
        names_by_team[r['team']].append({
            'name': r['name'],
            'start': day(r.get('start'), r.get('startPrecision')),
            'start_precision': precision_of(r.get('start'), r.get('startPrecision')),
            'end': end_bound(r.get('end'), r.get('endPrecision')),
            'end_precision': precision_of(r.get('end'), r.get('endPrecision')),
        })

def split_name(full: str):
    parts_ = str(full).split()
    return (' '.join(parts_[:-1]) or full, parts_[-1] if parts_ else full)

items_of_franchise: dict[str, list[str]] = defaultdict(list)
for qid in items: items_of_franchise[franchise_of_item[qid]].append(qid)

identities_of_item: dict[str, list[dict]] = defaultdict(list)
identity_rows_by_id: dict[str, dict] = {}

def emit_identity(franchise_id, qids, full_name, start, start_precision, end, end_precision,
                  from_basis, to_basis, league_id, snapshot_key, cite_key):
    """One identity per (franchise, name, start) however many Wikidata items
    state it. Two items stating the same name with different ends do not make
    two identities; they make one identity whose end is disputed."""
    identity_id = gid('gti', franchise_id, full_name, start or 'unknown')
    existing = identity_rows_by_id.get(identity_id)
    if existing:
        if (existing['effective_to'] or None) != (end or None):
            # The sources disagree about when this name stopped being used.
            existing['effective_to'], existing['to_basis'], existing['to_precision'] = None, 'unknown', 'unknown'
        for qid in qids:
            if qid not in existing['_qids']:
                existing['_qids'].append(qid)
                row('football_src.external_id', entity_type='team_identity', entity_id=identity_id,
                    id_system='wikidata_qid', id_value=qid, source_snapshot_id=SNAP[snapshot_key],
                    confidence=0.9, effective_from=None, effective_to=None, observed_at=NOW)
        return identity_id
    location, nickname = split_name(full_name)
    record = dict(global_football_team_identity_id=identity_id, league_id=league_id,
                  location_name=location, nickname=nickname, full_name=full_name, abbreviation=None,
                  is_temporary_combined=False, effective_from=start, effective_to=end,
                  from_basis=from_basis, to_basis=to_basis,
                  from_precision=start_precision, to_precision=end_precision,
                  source_snapshot_id=SNAP[snapshot_key])
    record['_qids'] = list(qids)
    identity_rows_by_id[identity_id] = record
    row('football.team_identity', **record)
    row('football.team_identity_franchise', global_football_team_identity_id=identity_id,
        global_football_franchise_id=franchise_id, effective_from=start, effective_to=end,
        source_snapshot_id=SNAP[snapshot_key])
    cite('team_identity', identity_id, snapshot_key, cite_key)
    for qid in qids:
        row('football_src.external_id', entity_type='team_identity', entity_id=identity_id,
            id_system='wikidata_qid', id_value=qid, source_snapshot_id=SNAP[snapshot_key],
            confidence=0.9, effective_from=None, effective_to=None, observed_at=NOW)
        identities_of_item[qid].append({'id': identity_id, 'start': start, 'end': end, 'name': full_name})
    return identity_id

for franchise_id, member_qids in items_of_franchise.items():
    member_qids = sorted(member_qids, key=lambda q: (items[q]['inception'] or '9999', items[q]['label']))
    multi_item = len(member_qids) > 1
    for qid in member_qids:
        it = items[qid]
        league_qid = sorted(leagues_of.get(qid) or [])
        league_id = LEAGUES[league_qid[0]][0] if league_qid else 'glg_nfl'
        dated = sorted([n for n in names_by_team.get(qid, []) if n['start']], key=lambda n: n['start'])

        if dated:
            for i, n in enumerate(dated):
                following = dated[i + 1]['start'] if i + 1 < len(dated) else None
                if n['end']:
                    end, to_basis, to_precision = n['end'], 'documented', n['end_precision']
                elif following:
                    end, to_basis, to_precision = following, 'documented', dated[i + 1]['start_precision']
                elif it['dissolved']:
                    end, to_basis, to_precision = it['dissolved'], 'derived_from_dissolution', it.get('dissolved_precision', 'unknown')
                else:
                    end, to_basis, to_precision = None, 'still_in_force', 'unknown'
                identity_id = emit_identity(franchise_id, [qid], n['name'], n['start'], n['start_precision'],
                                            end, to_precision, 'documented', to_basis, league_id,
                                            'team_names', f'{qid}/P1448')
                if i > 0:
                    row('football.franchise_lineage_event', lineage_event_id=gid('gle', qid, 'renamed', n['start']),
                        global_football_franchise_id=franchise_id, event_type='renamed', effective_on=n['start'],
                        from_team_identity_id=None, to_team_identity_id=identity_id, from_league_id=None, to_league_id=None,
                        description=f'official name from {n["start"]} (Wikidata P1448)', source_snapshot_id=SNAP['team_names'])
        elif multi_item:
            # The item's inception is the FRANCHISE's inception — the Las Vegas
            # Raiders item carries 1960. Using it as this identity's start would
            # assert something no source says, so the bounds stay unknown.
            emit_identity(franchise_id, [qid], it['label'], None, 'unknown', None, 'unknown',
                          'unknown', 'unknown', league_id, 'teams', f'{qid}/rdfs:label')
        else:
            emit_identity(franchise_id, [qid], it['label'], it['inception'], it.get('inception_precision', 'unknown'),
                          it['dissolved'], it.get('dissolved_precision', 'unknown'),
                          'derived_from_inception' if it['inception'] else 'unknown',
                          'derived_from_dissolution' if it['dissolved'] else ('still_in_force' if it['inception'] else 'unknown'),
                          league_id, 'teams', f'{qid}/rdfs:label')

for qid, it in items.items():
    franchise_id = franchise_of_item[qid]
    league_qid = sorted(leagues_of.get(qid) or [])
    if it['inception']:
        row('football.franchise_lineage_event', lineage_event_id=gid('gle', qid, 'founded'),
            global_football_franchise_id=franchise_id, event_type='founded', effective_on=it['inception'],
            from_team_identity_id=None, to_team_identity_id=None, from_league_id=None, to_league_id=None,
            description='Wikidata P571 inception', source_snapshot_id=SNAP['teams'])
    if it['dissolved']:
        row('football.franchise_lineage_event', lineage_event_id=gid('gle', qid, 'folded'),
            global_football_franchise_id=franchise_id, event_type='folded', effective_on=it['dissolved'],
            from_team_identity_id=None, to_team_identity_id=None, from_league_id=None, to_league_id=None,
            description='Wikidata P576 dissolved', source_snapshot_id=SNAP['teams'])
    if len(league_qid) > 1 and it['inception']:
        row('football.franchise_lineage_event', lineage_event_id=gid('gle', qid, 'league_transfer'),
            global_football_franchise_id=franchise_id, event_type='league_absorbed',
            effective_on=it['inception'],
            from_team_identity_id=None, to_team_identity_id=None,
            from_league_id=LEAGUES[league_qid[1]][0], to_league_id=LEAGUES[league_qid[0]][0],
            description='team item carries more than one league (P118); the transfer date is not stated by the source',
            source_snapshot_id=SNAP['teams'])

def identity_on(qid, date):
    """The identity in force for a team item on a date, or its only identity."""
    spans = identities_of_item.get(qid) or []
    if not spans: return None
    if date:
        for s in spans:
            if (not s['start'] or s['start'] <= date) and (not s['end'] or date < s['end']):
                return s['id']
    return spans[-1]['id']

# ---------------------------------------------------------------- relocations (P159 with dates)
for r in seed['team_locations']['rows']:
    qid, start = r.get('team'), day(r.get('start'), r.get('startPrecision'))
    if not qid or qid not in items or not start: continue
    row('football.franchise_lineage_event', lineage_event_id=gid('gle', qid, 'relocated', start, r.get('locationLabel') or ''),
        global_football_franchise_id=franchise_of_item[qid], event_type='relocated', effective_on=start,
        from_team_identity_id=None, to_team_identity_id=identity_on(qid, start), from_league_id=None, to_league_id=None,
        description=f'headquarters {r.get("locationLabel")} from {start} (Wikidata P159)', source_snapshot_id=SNAP['team_locations'])

# ---------------------------------------------------------------- seasons
season_of = {}
for r in seed['league_seasons']['rows']:
    label = r.get('seasonLabel') or ''
    m = re.match(r'^(\d{4})', label)
    league_qid = r.get('league')
    if not m or league_qid not in LEAGUES: continue
    year = int(m.group(1))
    league_id = LEAGUES[league_qid][0]
    season_id = gid('gss', league_id, year)
    if (league_id, year) in season_of: continue
    season_of[(league_id, year)] = season_id
    row('football.season', season_id=season_id, league_id=league_id, season_year=year, label=label,
        rules_profile_id=None, starts_on=day(r.get('start')), ends_on=day(r.get('end')), source_snapshot_id=SNAP['league_seasons'])
    row('football_src.external_id', entity_type='season', entity_id=season_id, id_system='wikidata_qid',
        id_value=r.get('season'), source_snapshot_id=SNAP['league_seasons'], confidence=1.0,
        effective_from=None, effective_to=None, observed_at=NOW)

# ---------------------------------------------------------------- conferences and divisions (undated on Wikidata)
latest_nfl_year = max((y for (lg, y) in season_of if lg == 'glg_nfl'), default=None)
conf_units, div_units = {}, {}
for r in seed['team_divisions']['rows']:
    conf, div = r.get('confLabel'), r.get('divLabel')
    if conf and conf not in conf_units:
        conf_units[conf] = gid('gou', 'conf', conf)
        row('football.org_unit', org_unit_id=conf_units[conf], league_id='glg_nfl', kind='conference',
            parent_org_unit_id=None, name=conf, effective_from_season=latest_nfl_year, effective_to_season=None,
            source_snapshot_id=SNAP['team_divisions'])
    if div and div not in div_units:
        div_units[div] = gid('gou', 'div', div)
        row('football.org_unit', org_unit_id=div_units[div], league_id='glg_nfl', kind='division',
            parent_org_unit_id=conf_units.get(conf), name=div, effective_from_season=latest_nfl_year,
            effective_to_season=None, source_snapshot_id=SNAP['team_divisions'])
alignment_written = set()
for r in seed['team_divisions']['rows']:
    qid = r.get('team')
    season_id = season_of.get(('glg_nfl', latest_nfl_year))
    identity = identity_on(qid, None) if qid in items else None
    if not identity or not season_id or identity in alignment_written: continue
    alignment_written.add(identity)
    row('football.team_alignment', global_football_team_identity_id=identity, season_id=season_id,
        conference_org_unit_id=conf_units.get(r.get('confLabel')), division_org_unit_id=div_units.get(r.get('divLabel')),
        source_snapshot_id=SNAP['team_divisions'])

# ---------------------------------------------------------------- venues
venue_id_of = {}
for r in seed['venues']['rows']:
    qid = r.get('venue')
    if not qid or qid in venue_id_of: continue
    venue_id = gid('gvn', qid)
    venue_id_of[qid] = venue_id
    row('football.venue', global_venue_id=venue_id,
        latitude=r.get('lat'), longitude=r.get('lon'), elevation_m=None,
        city=r.get('cityLabel'), region=None, country_code=(r.get('countryLabel') or None),
        opened_on=day(r.get('opened')), closed_on=day(r.get('closed')), source_snapshot_id=SNAP['venues'])
    row('football_src.external_id', entity_type='venue', entity_id=venue_id, id_system='wikidata_qid',
        id_value=qid, source_snapshot_id=SNAP['venues'], confidence=1.0, effective_from=None, effective_to=None, observed_at=NOW)
    if r.get('venueLabel'):
        # The label is the venue's current name; Wikidata does not say when it
        # took that name, so the start stays unknown rather than invented.
        row('football.venue_name', global_venue_id=venue_id, name=r['venueLabel'],
            effective_from=None, effective_to=None, source_snapshot_id=SNAP['venues'])

for r in seed['venue_names']['rows']:
    qid, start = r.get('venue'), day(r.get('start'), r.get('startPrecision'))
    if not qid or qid not in venue_id_of or not start or not r.get('name'): continue
    row('football.venue_name', global_venue_id=venue_id_of[qid], name=r['name'],
        effective_from=start, effective_to=end_bound(r.get('end'), r.get('endPrecision')), source_snapshot_id=SNAP['venue_names'])

home_written = set()
for r in seed['team_venues']['rows']:
    qid, vq = r.get('team'), r.get('venue')
    if qid not in items or vq not in venue_id_of: continue
    start, end = day(r.get('start'), r.get('startPrecision')), end_bound(r.get('end'), r.get('endPrecision'))
    if not start: continue
    # end is exclusive: a tenancy ending 1996 covers seasons through 1996.
    last_year = int(end[:4]) - 1 if end else int(start[:4])
    for year in range(int(start[:4]), max(last_year, int(start[:4])) + 1):
        for league_id in ('glg_nfl', 'glg_afl_1960', 'glg_aafc'):
            season_id = season_of.get((league_id, year))
            identity = identity_on(qid, f'{year}-09-01')
            if not season_id or not identity: continue
            key = (identity, venue_id_of[vq], season_id)
            if key in home_written: continue
            home_written.add(key)
            row('football.team_home_venue', global_football_team_identity_id=identity,
                global_venue_id=venue_id_of[vq], season_id=season_id, is_primary=True,
                source_snapshot_id=SNAP['team_venues'])

# ---------------------------------------------------------------- coaches
coach_ids = {}
for r in seed['team_coaches']['rows']:
    qid, coach_qid = r.get('team'), r.get('coach')
    if qid not in items or not coach_qid: continue
    start, end = day(r.get('start')), day(r.get('end'))
    if coach_qid not in coach_ids:
        person_id = gid('gpe', coach_qid)
        coach_id = gid('gco', coach_qid)
        coach_ids[coach_qid] = coach_id
        row('football.person', global_football_person_id=person_id, status='active', merged_into_person_id=None, created_at=NOW)
        row('football.coach', global_football_coach_id=coach_id, global_football_person_id=person_id)
        name = r.get('coachLabel') or coach_qid
        parts = str(name).split()
        row('football.person_name', global_football_person_id=person_id, name_kind='canonical', display_name=name,
            given_name=' '.join(parts[:-1]) or None, family_name=parts[-1] if parts else None,
            generational_suffix=None, normalized_key=name.lower(), effective_from=None, effective_to=None,
            source_snapshot_id=SNAP['team_coaches'], observed_at=NOW)
        row('football_src.external_id', entity_type='coach', entity_id=coach_id, id_system='wikidata_qid',
            id_value=coach_qid, source_snapshot_id=SNAP['team_coaches'], confidence=1.0,
            effective_from=None, effective_to=None, observed_at=NOW)
    identity = identity_on(qid, start)
    row('football.coaching_tenure', coaching_tenure_id=gid('gct', coach_qid, qid, start or 'unknown'),
        global_football_coach_id=coach_ids[coach_qid], global_football_team_identity_id=identity,
        global_college_team_id=None, role='Head Coach', role_class='head_coach', play_caller=None,
        effective_from=start, effective_to=end, source_snapshot_id=SNAP['team_coaches'], observed_at=NOW)

# ---------------------------------------------------------------- championships
franchise_of_qid = {q: f for q, f in franchise_of_item.items()}
unresolved_champions = []
for r in seed['championships_super_bowl']['rows']:
    name = r.get('gameLabel')
    date = day(r.get('date'))
    if not name: continue
    season_year = (int(date[:4]) - 1) if date else None
    season_id = season_of.get(('glg_nfl', season_year)) if season_year else None
    competition_id = gid('gcm', 'sb', name)
    row('football.competition', competition_id=competition_id, season_id=season_id or season_of.get(('glg_nfl', 2026)),
        kind='super_bowl', name=name, counts_toward_records='postseason', source_snapshot_id=SNAP['championships_super_bowl'])
    winner_qid = r.get('winner')
    franchise_id = franchise_of_qid.get(winner_qid)
    if winner_qid and not franchise_id: unresolved_champions.append({'game': name, 'winner': r.get('winnerLabel'), 'qid': winner_qid})
    row('football.championship_result', championship_result_id=gid('gch', name),
        competition_id=competition_id, league_id='glg_nfl', season_id=season_id, name=name, decided_on=date,
        winning_franchise_id=franchise_id,
        winning_team_identity_id=(identity_on(winner_qid, date) if winner_qid in items else None),
        runner_up_franchise_id=None,
        global_venue_id=venue_id_of.get(r.get('venue')), venue_name_as_played=r.get('venueLabel'),
        global_football_game_id=None, source_snapshot_id=SNAP['championships_super_bowl'], observed_at=NOW)

# ---------------------------------------------------------------- write
os.makedirs(OUT, exist_ok=True)
# A table that no longer produces rows must not leave last run's CSV behind for
# the loader to pick up as if it were current.
for stale in os.listdir(OUT):
    if stale.endswith('.csv'): os.remove(os.path.join(OUT, stale))
manifest = {}
for table, rows in tables.items():
    if not rows: continue
    cols = [c for c in {k: None for r in rows for k in r}.keys() if not c.startswith('_')]
    path = os.path.join(OUT, table.replace('.', '__') + '.csv')
    with open(path, 'w', newline='', encoding='utf-8') as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction='ignore')
        w.writeheader()
        for r in rows:
            w.writerow({c: ('' if r.get(c) is None else r.get(c)) for c in cols})
    manifest[table] = {'rows': len(rows), 'file': os.path.basename(path)}

identity_rows = tables['football.team_identity']
coverage = {
    'franchises': len(tables['football.franchise']),
    'team_identities': len(identity_rows),
    'identities_with_documented_start': sum(1 for r in identity_rows if r['from_basis'] == 'documented'),
    'identities_from_inception': sum(1 for r in identity_rows if r['from_basis'] == 'derived_from_inception'),
    'identities_with_unknown_start': sum(1 for r in identity_rows if r['from_basis'] == 'unknown'),
    'franchises_with_multiple_identities': sum(1 for f, n in
        __import__('collections').Counter(r['global_football_franchise_id'] for r in tables['football.team_identity_franchise']).items() if n > 1),
    'seasons': len(tables['football.season']),
    'season_year_min': min((r['season_year'] for r in tables['football.season']), default=None),
    'season_year_max': max((r['season_year'] for r in tables['football.season']), default=None),
    'venues': len(tables['football.venue']),
    'venue_names': len(tables['football.venue_name']),
    'coaching_tenures': len(tables['football.coaching_tenure']),
    'coaching_tenures_dated': sum(1 for r in tables['football.coaching_tenure'] if r['effective_from']),
    'championships': len(tables['football.championship_result']),
    'championships_with_winner': sum(1 for r in tables['football.championship_result'] if r['winning_franchise_id']),
    'unresolved_champions': unresolved_champions,
    'seed_failures': {name: seed[name].get('failed_chunks') for name in seed if seed[name].get('failed_chunks')},
}
json.dump({'built_at': NOW, 'mode': 'rights_clean_cc0', 'tables': manifest, 'coverage': coverage},
          open(os.path.join(OUT, '_manifest.json'), 'w', encoding='utf-8'), indent=1)
print(json.dumps({t: m['rows'] for t, m in sorted(manifest.items())}, indent=1))
print('\ncoverage:', json.dumps({k: v for k, v in coverage.items() if k not in ('unresolved_champions', 'seed_failures')}, indent=1))
print('unresolved champions:', len(unresolved_champions))
