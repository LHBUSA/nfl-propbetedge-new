"""Vertical slice: NFL 2023 into the canonical football history schema.

TECHNICAL VALIDATION ONLY. Reads data already held locally plus Wikidata (CC0).
Writes CSV under history/.out/slice2023/ (gitignored). Nothing is published,
deployed, or written to any database. Sources whose commercial verdict is not
`clear` are loaded with display_policy=internal_only so the API layer filters
them out of public/pro surfaces; that is what makes this provable end to end.

    python history/pipeline/build_slice_2023.py

Inputs (already on disk, no downloads):
  data/nflverse/play_by_play_2023.parquet   REVIEW (NFL-origin via nflfastR)
  data/nflverse/roster_2023.parquet         REVIEW (NFL Shield v2)
  data/nflverse/players.parquet             id columns only (owner: internal reconciliation)
  history/.out/seed/wikidata_*.json         CC0 (fetch_wikidata_seed.py)
Never read: snap_counts (rejected), participation / ftn_charting (hold).
"""
from __future__ import annotations
import csv, hashlib, json, os, re, sys
from collections import defaultdict
from datetime import datetime, timezone

import pandas as pd
import pyarrow.parquet as pq

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NFLVERSE = os.path.join(REPO, 'data', 'nflverse')
OUT = os.path.join(REPO, 'history', '.out', 'slice2023')
SEED = os.path.join(REPO, 'history', '.out', 'seed')
PARSER = ('pbe-history-slice', '0.1.0')
SEASON_YEAR = 2023
LEAGUE_ID = 'glg_nfl'

# The all-era skeleton (build_skeleton.py) owns leagues, franchises, identities,
# venues and seasons. One 2023 NFL season exists, so this slice adopts the
# skeleton's season row rather than minting a second one that the
# unique (league_id, season_year) constraint would rightly reject.
SKELETON = os.path.join(REPO, 'history', '.out', 'skeleton')
def read_skeleton_csv(name):
    path = os.path.join(SKELETON, name)
    if not os.path.exists(path): return []
    with open(path, newline='', encoding='utf-8') as fh:
        return list(csv.DictReader(fh))

SKELETON_SEASON = next((r for r in read_skeleton_csv('football__season.csv')
                        if r.get('league_id') == LEAGUE_ID and r.get('season_year') == str(SEASON_YEAR)), None)
SEASON_ID = SKELETON_SEASON['season_id'] if SKELETON_SEASON else f'gss_nfl_{SEASON_YEAR}'
NOW = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')

tables: dict[str, list[dict]] = defaultdict(list)
def row(table: str, **kw): tables[table].append(kw)

def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

def ulid_like(*parts: str) -> str:
    return hashlib.sha1('|'.join(str(p) for p in parts).encode()).hexdigest()[:20]

# ---------------------------------------------------------------- sources
MANIFEST = {m['file']: m for m in json.load(open(os.path.join(NFLVERSE, '_manifest.json'), encoding='utf-8'))}
REGISTRY = {s['source_id']: s for s in json.load(open(os.path.join(REPO, 'history', 'registry', 'sources.v1.json'), encoding='utf-8'))['sources']}

def add_source(source_id: str):
    s = REGISTRY[source_id]
    row('football_src.source', source_id=source_id, name=s['name'], governing_org=s.get('governing_org') or s.get('origin'),
        origin_source_id=None, licence_class=s['licence_class'], commercial_verdict=s['commercial_verdict'],
        obligations=s.get('obligations'), terms_url=s.get('terms_url'), terms_quote=s.get('terms_quote'),
        decided_by=('owner' if s.get('owner_decision') else None), decided_at=('2026-09-15T00:00:00Z' if s.get('owner_decision') else None),
        display_policy=s['display_policy'], model_use_allowed=s['model_use_allowed'], notes=s.get('notes'))

def add_snapshot(source_id: str, dataset: str, path: str | None, *, url: str | None = None, rows: int | None = None,
                 season_min=SEASON_YEAR, season_max=SEASON_YEAR) -> str:
    digest = sha256(path) if path else hashlib.sha256(url.encode()).hexdigest()
    snap = f'snp_{ulid_like(source_id, dataset, digest)}'
    m = MANIFEST.get(os.path.basename(path)) if path else None
    row('football_src.source_snapshot', source_snapshot_id=snap, source_id=source_id, dataset=dataset,
        retrieved_from=(m or {}).get('source_url') or url or path, retrieved_at=(m or {}).get('fetched_at') or NOW,
        content_sha256=digest, bytes=(os.path.getsize(path) if path else None), r2_object_key=None,
        parser_name=PARSER[0], parser_version=PARSER[1], row_count=rows, season_min=season_min, season_max=season_max)
    return snap

for sid in ('src_nflverse_pbp', 'src_nflverse_rosters_weekly', 'src_nflverse_players_ids', 'src_wikidata'):
    add_source(sid)

PBP_PATH = os.path.join(NFLVERSE, 'play_by_play_2023.parquet')
ROSTER_PATH = os.path.join(NFLVERSE, 'roster_2023.parquet')
PLAYERS_PATH = os.path.join(NFLVERSE, 'players.parquet')

# ---------------------------------------------------------------- load inputs
PBP_COLS = ['game_id','old_game_id','nfl_api_id','season_type','week','game_date','start_time','home_team','away_team',
 'stadium','game_stadium','stadium_id','roof','surface','temp','wind','weather','home_coach','away_coach','location','div_game','result','total',
 'play_id','order_sequence','drive','fixed_drive','fixed_drive_result','drive_start_yard_line','drive_end_yard_line','drive_play_count',
 'drive_time_of_possession','drive_first_downs','drive_quarter_start','drive_quarter_end','drive_game_clock_start','drive_game_clock_end',
 'qtr','quarter_seconds_remaining','game_seconds_remaining','down','ydstogo','yardline_100','posteam','defteam','play_type','desc','yards_gained',
 'air_yards','yards_after_catch','first_down','touchdown','interception','fumble_lost','sack','penalty','penalty_team','penalty_player_id',
 'penalty_type','penalty_yards','total_home_score','total_away_score','posteam_score','defteam_score','play_deleted','aborted_play','qb_kneel','qb_spike',
 'passer_player_id','passer_player_name','rusher_player_id','rusher_player_name','receiver_player_id','receiver_player_name',
 'complete_pass','pass_attempt','rush_attempt','passing_yards','receiving_yards','rushing_yards','pass_touchdown','rush_touchdown',
 'extra_point_result','two_point_conv_result','field_goal_result','kick_distance','safety','td_team','td_player_id','td_player_name',
 'kicker_player_id','punter_player_id','kickoff_returner_player_id','punt_returner_player_id',
 'solo_tackle_1_player_id','solo_tackle_2_player_id','assist_tackle_1_player_id','assist_tackle_2_player_id',
 'sack_player_id','half_sack_1_player_id','half_sack_2_player_id','interception_player_id','fumbled_1_player_id',
 'forced_fumble_player_1_player_id','fumble_recovery_1_player_id','pass_defense_1_player_id','fumble_recovery_1_team',
 'lateral_receiver_player_id','lateral_receiver_player_name','lateral_receiving_yards',
 'lateral_rusher_player_id','lateral_rusher_player_name','lateral_rushing_yards']
pbp = pq.read_table(PBP_PATH, columns=PBP_COLS).to_pandas()
pbp = pbp.sort_values(['game_id', 'play_id']).reset_index(drop=True)
roster = pq.read_table(ROSTER_PATH).to_pandas()
players_ids = pq.read_table(PLAYERS_PATH, columns=['gsis_id','espn_id','pfr_id','esb_id','smart_id','nfl_id']).to_pandas()

SNAP_PBP = add_snapshot('src_nflverse_pbp', 'play_by_play_2023', PBP_PATH, rows=len(pbp))
SNAP_ROSTER = add_snapshot('src_nflverse_rosters_weekly', 'roster_2023', ROSTER_PATH, rows=len(roster))
SNAP_IDS = add_snapshot('src_nflverse_players_ids', 'players_id_columns', PLAYERS_PATH, rows=len(players_ids), season_min=None, season_max=None)

wd = {}
for name in ('teams', 'divisions', 'name_history', 'superbowl'):
    p = os.path.join(SEED, f'wikidata_{name}.json')
    wd[name] = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {'rows': [], 'query': '', 'retrieved_at': NOW}
SNAP_WD = add_snapshot('src_wikidata', 'nfl_franchise_seed', None,
                       url='https://query.wikidata.org/sparql (see history/.out/seed/wikidata_*.json)',
                       rows=sum(len(v['rows']) for v in wd.values()), season_min=None, season_max=None)

# ---------------------------------------------------------------- competition graph
row('football.organization', organization_id='gorg_nfl', name='National Football League', kind='league_body',
    country_code='US', founded_on=None, dissolved_on=None, source_snapshot_id=SNAP_WD)
row('football.league', league_id=LEAGUE_ID, organization_id='gorg_nfl', name='National Football League',
    short_name='NFL', level='professional', country_code='US', effective_from=None, effective_to=None, source_snapshot_id=SNAP_WD)
row('football_src.external_id', entity_type='league', entity_id=LEAGUE_ID, id_system='wikidata_qid', id_value='Q1215884',
    source_snapshot_id=SNAP_WD, confidence=1.0, effective_from=None, effective_to=None, observed_at=NOW)

# Era/rules facts are NOT asserted from memory: the profile exists, is marked
# unverified, and derivations that need a verified rule must refuse.
row('football.rules_profile', rules_profile_id='grp_nfl_2023', league_id=LEAGUE_ID, effective_from_season=2023,
    effective_to_season=2023, regular_season_games=17, playoff_teams=14,
    overtime_rule='UNVERIFIED - needs primary citation (NFL rulebook / Record & Fact Book)',
    two_point_conversion=None, pat_line_of_scrimmage_yards=None, kickoff_rule=None, sacks_official_stat=True,
    roster_limit=None, citation='regular_season_games and playoff_teams derived from the 2023 schedule and postseason bracket in this dataset',
    verification_status='unverified', source_snapshot_id=SNAP_PBP)
# The rules profile is keyed by league and season range, so it stays resolvable
# for the skeleton's season row without this slice rewriting that row.
if not SKELETON_SEASON:
    row('football.season', season_id=SEASON_ID, league_id=LEAGUE_ID, season_year=SEASON_YEAR, label='2023',
        rules_profile_id='grp_nfl_2023', starts_on=str(pbp.game_date.min()), ends_on=str(pbp.game_date.max()),
        source_snapshot_id=SNAP_PBP)

COMPETITIONS = {
    'REG': ('gcm_nfl_2023_reg', 'regular_season', '2023 NFL regular season', 'regular'),
    'WC':  ('gcm_nfl_2023_post', 'postseason', '2023 NFL playoffs', 'postseason'),
    'SB':  ('gcm_nfl_2023_sb', 'super_bowl', 'Super Bowl LVIII', 'postseason'),
}
for key, (cid, kind, name, counts) in COMPETITIONS.items():
    if key == 'WC' and cid in {c['competition_id'] for c in tables['football.competition']}: continue
    row('football.competition', competition_id=cid, season_id=SEASON_ID, kind=kind, name=name,
        counts_toward_records=counts, source_snapshot_id=SNAP_PBP)

# ---------------------------------------------------------------- franchises and identities
CROSSWALK = json.load(open(os.path.join(REPO, 'history', 'registry', 'nfl_team_crosswalk.v1.json'), encoding='utf-8'))
add_source('src_pbe_curated_crosswalk') if 'src_pbe_curated_crosswalk' in REGISTRY else None
teams_wd = {r['abbr']: r for r in wd['teams']['rows'] if r.get('abbr')}
divisions_wd = {r['abbr']: r for r in wd['divisions']['rows']} if wd['divisions']['rows'] else {}
name_hist = defaultdict(list)
for r in wd['name_history']['rows']:
    name_hist[r['abbr']].append(r)

game_dates = pbp.groupby(pbp.home_team)['game_date'].agg(['min', 'max'])
season_first = str(pbp.game_date.min()); season_last = str(pbp.game_date.max())
teams_in_data = sorted(set(pbp.home_team.dropna()) | set(pbp.away_team.dropna()))

conf_units, div_units = {}, {}
for abbr, d in divisions_wd.items():
    conf, div = d.get('conference'), d.get('division')
    if conf and conf not in conf_units:
        cid = f'gou_{re.sub(r"[^a-z0-9]+", "_", conf.lower())}'
        conf_units[conf] = cid
        row('football.org_unit', org_unit_id=cid, league_id=LEAGUE_ID, kind='conference', parent_org_unit_id=None,
            name=conf, effective_from_season=SEASON_YEAR, effective_to_season=SEASON_YEAR, source_snapshot_id=SNAP_WD)
    if div and div not in div_units:
        did = f'gou_{re.sub(r"[^a-z0-9]+", "_", div.lower())}'
        div_units[div] = did
        row('football.org_unit', org_unit_id=did, league_id=LEAGUE_ID, kind='division', parent_org_unit_id=conf_units.get(conf),
            name=div, effective_from_season=SEASON_YEAR, effective_to_season=SEASON_YEAR, source_snapshot_id=SNAP_WD)

# The all-era skeleton (history/pipeline/build_skeleton.py) owns franchises and
# their identities through time. When it is present this season attaches to it
# instead of inventing a second franchise for the same club — which is the whole
# point of separating franchise from time-bounded identity.
skeleton_franchise_of_qid = {
    r['id_value']: r['entity_id'] for r in read_skeleton_csv('football_src__external_id.csv')
    if r.get('entity_type') == 'franchise' and r.get('id_system') == 'wikidata_qid'
}
skeleton_identities = {r['global_football_team_identity_id']: r for r in read_skeleton_csv('football__team_identity.csv')}
skeleton_identities_of_qid: dict[str, list] = defaultdict(list)
for x in read_skeleton_csv('football_src__external_id.csv'):
    if x.get('entity_type') == 'team_identity' and x.get('id_system') == 'wikidata_qid':
        identity = skeleton_identities.get(x['entity_id'])
        if identity: skeleton_identities_of_qid[x['id_value']].append(identity)

def skeleton_identity_for(qid, date):
    """The skeleton identity this season's team is, resolved through the Wikidata
    item the crosswalk names rather than through a date window: many historical
    identities have no documented bounds, and a date window would silently pick
    one of them. Ambiguity is returned, not resolved by guessing."""
    candidates = skeleton_identities_of_qid.get(qid or '', [])
    dated = [i for i in candidates
             if (i.get('effective_from') and i['effective_from'] <= date)
             and (not i.get('effective_to') or date < i['effective_to'])]
    if len(dated) == 1: return dated[0], None
    if len(dated) > 1: return None, f'{len(dated)} dated identities in force'
    undated = [i for i in candidates if not i.get('effective_from')]
    if len(undated) == 1: return undated[0], None
    if not candidates: return None, 'no skeleton identity cites this item'
    return None, f'{len(candidates)} candidate identities, none decidable'

QID_OF_ABBR = {t['abbr']: t['qid'] for t in CROSSWALK['teams']}

identity_of_team: dict[str, str] = {}
unattached_reasons: list[str] = []
lineage_report = []
for abbr in teams_in_data:
    t = teams_wd.get(abbr)
    label = (t or {}).get('label') or abbr
    qid = QID_OF_ABBR.get(abbr, '')
    skeleton_franchise = skeleton_franchise_of_qid.get(qid)
    attached, why_not = skeleton_identity_for(qid, season_first)
    if attached:
        identity_of_team[abbr] = attached['global_football_team_identity_id']
        d = divisions_wd.get(abbr) or {}
        row('football.team_alignment', global_football_team_identity_id=attached['global_football_team_identity_id'],
            season_id=SEASON_ID, conference_org_unit_id=conf_units.get(d.get('conference')),
            division_org_unit_id=div_units.get(d.get('division')), source_snapshot_id=SNAP_WD)
        # The abbreviation is a provider's code for this identity, not a property
        # of the club, so it is recorded as an external identifier from the file
        # that uses it.
        row('football_src.external_id', entity_type='team_identity',
            entity_id=attached['global_football_team_identity_id'], id_system='nflverse_team_abbr',
            id_value=abbr, source_snapshot_id=SNAP_PBP, confidence=1.0,
            effective_from=season_first, effective_to=None, observed_at=NOW)
        lineage_report.append({'team': abbr, 'identity_bounds': 'attached_to_skeleton',
                               'documented_identities': 1, 'franchise_id': skeleton_franchise,
                               'identity': attached['full_name']})
        continue
    if skeleton_identities and why_not:
        unattached_reasons.append(f'{abbr}: {why_not}')
    franchise_id = f'gfr_{abbr.lower()}'
    row('football.franchise', global_football_franchise_id=franchise_id, canonical_label=f'{label} (franchise)',
        founded_on=(t or {}).get('inception'), terminated_on=None, source_snapshot_id=SNAP_WD)
    if t and t.get('qid'):
        row('football_src.external_id', entity_type='franchise', entity_id=franchise_id, id_system='wikidata_qid',
            id_value=t['qid'], source_snapshot_id=SNAP_WD, confidence=1.0, effective_from=None, effective_to=None, observed_at=NOW)
    if t and t.get('inception'):
        row('football.franchise_lineage_event', lineage_event_id=f'gle_{ulid_like(franchise_id, "founded")}',
            global_football_franchise_id=franchise_id, event_type='founded', effective_on=t['inception'][:10],
            from_team_identity_id=None, to_team_identity_id=None, from_league_id=None, to_league_id=None,
            description='Wikidata P571 inception', source_snapshot_id=SNAP_WD)

    # Documented historical identities (Wikidata P1448 official name with dates), plus the identity in force in 2023.
    documented = sorted([n for n in name_hist.get(abbr, []) if n.get('start')], key=lambda n: n['start'])
    current_identity_id = None
    for n in documented:
        start, end = n['start'][:10], (n['end'][:10] if n.get('end') else None)
        iid = f'gti_{ulid_like(abbr, n["name"], start)}'
        row('football.team_identity', global_football_team_identity_id=iid, league_id=LEAGUE_ID,
            location_name=n['name'].rsplit(' ', 1)[0], nickname=n['name'].rsplit(' ', 1)[-1], full_name=n['name'],
            abbreviation=(abbr if end is None else None), is_temporary_combined=False,
            effective_from=start, effective_to=end, source_snapshot_id=SNAP_WD)
        row('football.team_identity_franchise', global_football_team_identity_id=iid, global_football_franchise_id=franchise_id,
            effective_from=start, effective_to=end, source_snapshot_id=SNAP_WD)
        if end is None or end >= season_first:
            if end is None or (end > season_last and (n['start'][:10] <= season_first)):
                current_identity_id = iid
        if len(documented) > 1:
            row('football.franchise_lineage_event', lineage_event_id=f'gle_{ulid_like(franchise_id, "renamed", start)}',
                global_football_franchise_id=franchise_id, event_type='renamed', effective_on=start,
                from_team_identity_id=None, to_team_identity_id=iid, from_league_id=None, to_league_id=None,
                description=f'Wikidata P1448 official name from {start}', source_snapshot_id=SNAP_WD)

    if current_identity_id is None:
        # No dated name evidence covering 2023: bound the identity by the evidence
        # window (its first and last game in this dataset) and say so.
        iid = f'gti_{ulid_like(abbr, label, "evidence", str(SEASON_YEAR))}'
        row('football.team_identity', global_football_team_identity_id=iid, league_id=LEAGUE_ID,
            location_name=label.rsplit(' ', 1)[0], nickname=label.rsplit(' ', 1)[-1], full_name=label,
            abbreviation=abbr, is_temporary_combined=False, effective_from=season_first, effective_to=None,
            source_snapshot_id=SNAP_WD)
        row('football.team_identity_franchise', global_football_team_identity_id=iid, global_football_franchise_id=franchise_id,
            effective_from=season_first, effective_to=None, source_snapshot_id=SNAP_WD)
        current_identity_id = iid
        lineage_report.append({'team': abbr, 'identity_bounds': 'evidence_window', 'documented_identities': len(documented)})
    else:
        lineage_report.append({'team': abbr, 'identity_bounds': 'documented', 'documented_identities': len(documented)})

    identity_of_team[abbr] = current_identity_id
    d = divisions_wd.get(abbr) or {}
    row('football.team_alignment', global_football_team_identity_id=current_identity_id, season_id=SEASON_ID,
        conference_org_unit_id=conf_units.get(d.get('conference')), division_org_unit_id=div_units.get(d.get('division')),
        source_snapshot_id=SNAP_WD)

# ---------------------------------------------------------------- venues (as played)
venue_ids = {}
for sid_, grp in pbp.dropna(subset=['stadium_id']).groupby('stadium_id'):
    name = str(grp.game_stadium.dropna().iloc[0]) if grp.game_stadium.notna().any() else str(sid_)
    vid = f'gvn_{re.sub(r"[^a-z0-9]+", "_", str(sid_).lower())}'
    venue_ids[str(sid_)] = vid
    row('football.venue', global_venue_id=vid, latitude=None, longitude=None, elevation_m=None, city=None, region=None,
        country_code=None, opened_on=None, closed_on=None, source_snapshot_id=SNAP_PBP)
    row('football.venue_name', global_venue_id=vid, name=name, effective_from=season_first, effective_to=None, source_snapshot_id=SNAP_PBP)
    for attr, col in (('roof', 'roof'), ('surface', 'surface')):
        vals = sorted({v for v in grp[col].dropna().astype(str) if v.strip() and v.strip().lower() != 'nan'})
        if len(vals) == 1:
            row('football.venue_attribute_period', global_venue_id=vid, attribute=attr, value=vals[0],
                effective_from=season_first, effective_to=None, source_snapshot_id=SNAP_PBP)

# ---------------------------------------------------------------- people
person_of_gsis: dict[str, str] = {}
def ensure_player(gsis: str, name: str | None, snap: str) -> str:
    if gsis in person_of_gsis: return person_of_gsis[gsis]
    pid = f'gpe_{ulid_like("person", gsis)}'
    player_id = f'gpl_{ulid_like("player", gsis)}'
    person_of_gsis[gsis] = player_id
    row('football.person', global_football_person_id=pid, status='active', merged_into_person_id=None, created_at=NOW)
    row('football.player', global_football_player_id=player_id, global_football_person_id=pid)
    if name:
        parts = str(name).strip().split()
        suffix = parts[-1].rstrip('.').title() if parts and parts[-1].rstrip('.').lower() in ('jr', 'sr', 'ii', 'iii', 'iv', 'v') else None
        core = parts[:-1] if suffix else parts
        row('football.person_name', global_football_person_id=pid, name_kind='canonical', display_name=str(name),
            given_name=(' '.join(core[:-1]) or None), family_name=(core[-1] if core else None),
            generational_suffix=({'Jr': 'Jr.', 'Sr': 'Sr.'}.get(suffix, suffix.upper() if suffix else None) if suffix else None),
            normalized_key=' '.join(w.lower() for w in core), effective_from=None, effective_to=None,
            source_snapshot_id=snap, observed_at=NOW)
    row('football_src.external_id', entity_type='player', entity_id=player_id, id_system='nfl_gsis_id', id_value=gsis,
        source_snapshot_id=snap, confidence=1.0, effective_from=None, effective_to=None, observed_at=NOW)
    return player_id

roster_2023 = roster.dropna(subset=['gsis_id'])
first_seen = roster_2023.sort_values('week').drop_duplicates('gsis_id')
for r in first_seen.itertuples():
    pl = ensure_player(r.gsis_id, r.full_name, SNAP_ROSTER)
    pid = f'gpe_{ulid_like("person", r.gsis_id)}'
    if isinstance(r.birth_date, str) and re.match(r'^\d{4}-\d{2}-\d{2}$', r.birth_date):
        row('football.person_attribute_observation', global_football_person_id=pid, attribute='date_of_birth',
            value=r.birth_date, measured_context='nflverse weekly roster', measured_on=None, source_snapshot_id=SNAP_ROSTER, observed_at=NOW)
    for attr, val in (('height_in', r.height), ('weight_lb', r.weight)):
        if pd.notna(val):
            row('football.person_attribute_observation', global_football_person_id=pid, attribute=attr, value=str(val),
                measured_context=f'nflverse weekly roster {SEASON_YEAR}', measured_on=None, source_snapshot_id=SNAP_ROSTER, observed_at=NOW)

# approved id-column crosswalk (internal reconciliation only)
ID_SYSTEMS = {'espn_id': 'espn_athlete_id', 'pfr_id': 'pfr_player_id', 'esb_id': 'nfl_esb_id'}
idx = players_ids.dropna(subset=['gsis_id']).drop_duplicates('gsis_id').set_index('gsis_id')
for gsis, player_id in person_of_gsis.items():
    if gsis not in idx.index: continue
    rec = idx.loc[gsis]
    for col, system in ID_SYSTEMS.items():
        val = rec.get(col)
        if pd.notna(val) and str(val).strip():
            row('football_src.external_id', entity_type='player', entity_id=player_id, id_system=system,
                id_value=str(val).strip(), source_snapshot_id=SNAP_IDS, confidence=0.95,
                effective_from=None, effective_to=None, observed_at=NOW)

# positions + jersey + roster status periods from weekly snapshots
ONTOLOGY = json.load(open(os.path.join(REPO, 'history', 'ontology', 'positions.v1.json'), encoding='utf-8'))
LABEL_MAP = {l['label'].upper(): l for l in ONTOLOGY['source_labels']}
week_dates = pbp.groupby(['week', 'season_type'])['game_date'].min().to_dict()
def week_date(week, season_type='REG'):
    return str(week_dates.get((week, season_type)) or week_dates.get((week, 'REG')) or season_first)

# roster_2023 is a SEASON roster (one row per player, `week` = last week seen),
# not a weekly one: nflverse publishes week-level squads in `weekly_rosters`,
# which is not held locally. So one period per player-team for the season,
# basis roster_snapshot, and week-level roster reconstruction is a known gap.
for r in roster_2023.drop_duplicates('gsis_id').itertuples():
    if r.gsis_id not in person_of_gsis: continue
    player_id = person_of_gsis[r.gsis_id]
    identity = identity_of_team.get(r.team)
    if not identity: continue
    mapped = {'ACT': 'active', 'RES': 'injured_reserve', 'CUT': 'active', 'DEV': 'practice_squad',
              'EXE': 'exempt', 'RET': 'reserve_other', 'TRD': 'active', 'PUP': 'pup', 'NON': 'nfi', 'SUS': 'suspended'}
    canon = mapped.get(str(r.status).upper()[:3], 'reserve_other')
    row('football.roster_status_period', global_football_player_id=player_id,
        global_football_team_identity_id=identity, status=canon, effective_from=season_first,
        effective_to=None, basis='roster_snapshot', basis_ids='{' + SNAP_ROSTER + '}',
        observed_at=NOW, source_snapshot_id=SNAP_ROSTER)
    if pd.notna(r.position):
        entry = LABEL_MAP.get(str(r.position).upper())
        row('football.player_position_observation', global_football_player_id=player_id, source_label=str(r.position),
            canonical_code=(entry or {}).get('canonical', 'UNKNOWN'), ambiguous=bool((entry or {}).get('ambiguous', True)),
            ontology_version=ONTOLOGY['version'], context='roster', season_id=SEASON_ID,
            effective_from=season_first, effective_to=None, source_snapshot_id=SNAP_ROSTER, observed_at=NOW)
    if pd.notna(r.jersey_number):
        row('football.jersey_number_period', global_football_player_id=player_id, global_football_team_identity_id=identity,
            jersey_number=str(r.jersey_number).split('.')[0], effective_from=season_first, effective_to=None,
            source_snapshot_id=SNAP_ROSTER, observed_at=NOW)

# coaches (head coach per game, from the play-by-play game header)
coach_ids: dict[str, str] = {}
def ensure_coach(name: str) -> str:
    if name in coach_ids: return coach_ids[name]
    pid = f'gpe_{ulid_like("person", "coach", name)}'
    cid = f'gco_{ulid_like("coach", name)}'
    coach_ids[name] = cid
    row('football.person', global_football_person_id=pid, status='active', merged_into_person_id=None, created_at=NOW)
    row('football.coach', global_football_coach_id=cid, global_football_person_id=pid)
    parts = name.split()
    row('football.person_name', global_football_person_id=pid, name_kind='canonical', display_name=name,
        given_name=' '.join(parts[:-1]) or None, family_name=parts[-1] if parts else None, generational_suffix=None,
        normalized_key=name.lower(), effective_from=None, effective_to=None, source_snapshot_id=SNAP_PBP, observed_at=NOW)
    return cid

games = pbp.drop_duplicates('game_id').set_index('game_id')
coach_span: dict[tuple[str, str], list[str]] = defaultdict(list)
for g in games.itertuples():
    for team, coach in ((g.home_team, g.home_coach), (g.away_team, g.away_coach)):
        if isinstance(coach, str) and coach.strip():
            coach_span[(coach.strip(), team)].append(str(g.game_date))
for (coach, team), dates in coach_span.items():
    cid = ensure_coach(coach)
    identity = identity_of_team.get(team)
    if not identity: continue
    row('football.coaching_tenure', coaching_tenure_id=f'gct_{ulid_like(cid, team, SEASON_YEAR)}',
        global_football_coach_id=cid, global_football_team_identity_id=identity, global_college_team_id=None,
        role='Head Coach', role_class='head_coach', play_caller=None, effective_from=min(dates), effective_to=max(dates),
        source_snapshot_id=SNAP_PBP, observed_at=NOW)

# ---------------------------------------------------------------- games, drives, plays
DRIVE_RESULT = {
    'Touchdown': 'touchdown', 'Field goal': 'field_goal', 'Punt': 'punt', 'Turnover': 'turnover',
    'Turnover on downs': 'turnover_on_downs', 'Safety': 'safety', 'Opp touchdown': 'turnover',
    'End of half': 'end_of_half', 'End of game': 'end_of_game', 'Missed field goal': 'missed_field_goal'}
POST_ROUND = {19: 'Wild Card', 20: 'Divisional', 21: 'Conference Championship', 22: 'Super Bowl'}
def yardline_100(text, posteam):
    if not isinstance(text, str) or not text.strip(): return None
    parts = text.split()
    if len(parts) != 2 or not parts[1].isdigit(): return None
    side, yd = parts[0], int(parts[1])
    return yd if side != posteam else 100 - yd

SB_WEEK = int(pbp[pbp.season_type == 'POST'].week.max())
game_rows = []
for gid, grp in pbp.groupby('game_id', sort=True):
    head = grp.iloc[0]
    season_type = str(head.season_type)
    week = int(head.week)
    is_sb = season_type == 'POST' and week == SB_WEEK
    competition = COMPETITIONS['SB'][0] if is_sb else (COMPETITIONS['REG'][0] if season_type == 'REG' else COMPETITIONS['WC'][0])
    home_id, away_id = identity_of_team[head.home_team], identity_of_team[head.away_team]
    game_id = f'gga_{ulid_like(gid)}'
    final_home = int(grp.total_home_score.max()); final_away = int(grp.total_away_score.max())
    last_q = int(grp.qtr.max())
    neutral = bool(str(head.location).lower() == 'neutral') if pd.notna(head.location) else False
    game_rows.append((gid, game_id, head, grp, final_home, final_away))
    row('football.game', global_football_game_id=game_id, competition_id=competition, season_id=SEASON_ID,
        week_label=(POST_ROUND.get(week, f'Week {week}') if season_type == 'POST' else f'Week {week}'),
        week_number=week, game_date=str(head.game_date),
        # The source's start_time carries no timezone and is not a clean time
        # ("9/10/23, 13:02:43"), so kickoff instant is recorded as unknown
        # rather than guessed. A source with a real kickoff timestamp fills it.
        kickoff_at=None, kickoff_precision='date_only',
        global_venue_id=venue_ids.get(str(head.stadium_id)), venue_name_as_played=head.game_stadium,
        neutral_site=neutral, international=False, home_team_identity_id=home_id, away_team_identity_id=away_id,
        status=('final_overtime' if last_q > 4 else 'final'), overtime_periods=max(0, last_q - 4),
        overtime_rule_key='grp_nfl_2023:unverified', attendance=None, source_snapshot_id=SNAP_PBP)
    for identity, score, opp in ((home_id, final_home, final_away), (away_id, final_away, final_home)):
        quarters = []
        for q in range(1, last_q + 1):
            sub = grp[grp.qtr <= q]
            col = 'total_home_score' if identity == home_id else 'total_away_score'
            quarters.append(int(sub[col].max()) if len(sub) else 0)
        per_q = [quarters[0]] + [quarters[i] - quarters[i - 1] for i in range(1, len(quarters))]
        row('football.game_team_score', global_football_game_id=game_id, global_football_team_identity_id=identity,
            final_score=score, period_scores='{' + ','.join(str(x) for x in per_q) + '}',
            result=('win' if score > opp else 'loss' if score < opp else 'tie'), source_snapshot_id=SNAP_PBP)
    if isinstance(head.weather, str) and head.weather.strip():
        row('football.game_weather_observation', global_football_game_id=game_id, method='reported_in_game_record',
            station_id=None, station_distance_km=None, observed_for=None,
            temperature_c=(round((float(head.temp) - 32) * 5 / 9, 2) if pd.notna(head.temp) else None),
            wind_speed_kmh=(round(float(head.wind) * 1.609344, 2) if pd.notna(head.wind) else None),
            wind_direction_deg=None, precipitation_mm=None, relative_humidity_pct=None,
            conditions_reported=head.weather, source_snapshot_id=SNAP_PBP)

# drives + plays + participants + penalties + derived stat lines
STAT_DEF_VERSION = 'pbe_pbp_derived_v1'
STAT_KEYS = ['passing_yards','pass_attempts','completions','passing_touchdowns','interceptions_thrown','sacks_taken',
             'rushing_yards','rush_attempts','rushing_touchdowns','receptions','targets','receiving_yards','receiving_touchdowns',
             'solo_tackles','sacks','interceptions','points']
for key in STAT_KEYS:
    row('football.stat_definition', stat_key=key, definition_version=STAT_DEF_VERSION, scope=('team' if key == 'points' else 'player'),
        description=f'{key} derived by PropBetEdge from nflverse play-by-play; not an official league box score',
        official_from_season=None, official_to_season=None, league_id=LEAGUE_ID, citation='history/pipeline/build_slice_2023.py')
for key in ('points','passing_yards','rushing_yards','receiving_yards','pass_attempts','rush_attempts','completions'):
    if key != 'points':
        row('football.stat_definition', stat_key=key, definition_version=STAT_DEF_VERSION + '_team', scope='team',
            description=f'team {key} derived from nflverse play-by-play', official_from_season=None, official_to_season=None,
            league_id=LEAGUE_ID, citation='history/pipeline/build_slice_2023.py')

player_game = defaultdict(lambda: defaultdict(float))
team_game = defaultdict(lambda: defaultdict(float))
appearance = defaultdict(set)

def add_stat(game_id, player, team_identity, key, value):
    if not player or not value: return
    player_game[(game_id, player, team_identity)][key] += float(value)

for gid, game_id, head, grp, final_home, final_away in game_rows:
    identity_by_abbr = {head.home_team: identity_of_team[head.home_team], head.away_team: identity_of_team[head.away_team]}
    drive_ids = {}
    for drive_no, dgrp in grp.dropna(subset=['fixed_drive']).groupby('fixed_drive'):
        first, last = dgrp.iloc[0], dgrp.iloc[-1]
        posteam = first.posteam if pd.notna(first.posteam) else None
        if not posteam or posteam not in identity_by_abbr: continue
        did = f'gdr_{ulid_like(gid, int(drive_no))}'
        drive_ids[int(drive_no)] = did
        row('football.drive', global_football_drive_id=did, global_football_game_id=game_id, sequence=int(drive_no),
            offense_team_identity_id=identity_by_abbr[posteam],
            start_period=(int(first.drive_quarter_start) if pd.notna(first.drive_quarter_start) else None),
            start_clock_seconds=None,
            end_period=(int(last.drive_quarter_end) if pd.notna(last.drive_quarter_end) else None), end_clock_seconds=None,
            start_yardline_100=yardline_100(first.drive_start_yard_line, posteam),
            end_yardline_100=yardline_100(last.drive_end_yard_line, posteam),
            plays=(int(first.drive_play_count) if pd.notna(first.drive_play_count) else len(dgrp)),
            yards=None, duration_seconds=None,
            first_downs=(int(first.drive_first_downs) if pd.notna(first.drive_first_downs) else None),
            result=DRIVE_RESULT.get(str(first.fixed_drive_result), 'other'),
            result_source_label=str(first.fixed_drive_result) if pd.notna(first.fixed_drive_result) else None,
            source_snapshot_id=SNAP_PBP)

    for seq, p in enumerate(grp.itertuples(), start=1):
        play_id = f'gpy_{ulid_like(gid, int(p.play_id))}'
        posteam_identity = identity_by_abbr.get(p.posteam) if pd.notna(p.posteam) else None
        defteam_identity = identity_by_abbr.get(p.defteam) if pd.notna(p.defteam) else None
        confidence = {
            'air_yards': 'source_structured' if pd.notna(p.air_yards) else 'absent',
            'yards_after_catch': 'source_structured' if pd.notna(p.yards_after_catch) else 'absent',
            'down': 'source_structured' if pd.notna(p.down) else 'absent',
            'formation': 'absent', 'personnel': 'absent', 'pressure': 'absent',
        }
        # The source carries one lateral per play. A play with two or more
        # laterals cannot have its yards fully attributed from it, so the play
        # says so instead of the pipeline silently losing or inventing yards.
        if isinstance(p.desc, str) and p.desc.count('Lateral to') > 1:
            confidence['receiving_attribution'] = 'incomplete_multi_lateral'
        row('football.play', global_football_play_id=play_id, global_football_game_id=game_id,
            global_football_drive_id=drive_ids.get(int(p.fixed_drive)) if pd.notna(p.fixed_drive) else None,
            sequence=seq, source_play_key=str(int(p.play_id)),
            period=(int(p.qtr) if pd.notna(p.qtr) else None),
            clock_seconds_remaining=(int(p.quarter_seconds_remaining) if pd.notna(p.quarter_seconds_remaining) else None),
            down=(int(p.down) if pd.notna(p.down) else None), distance=(int(p.ydstogo) if pd.notna(p.ydstogo) else None),
            yardline_100=(int(p.yardline_100) if pd.notna(p.yardline_100) else None),
            possession_team_identity_id=posteam_identity, defense_team_identity_id=defteam_identity,
            play_type=(str(p.play_type) if pd.notna(p.play_type) else None),
            play_type_source_label=(str(p.play_type) if pd.notna(p.play_type) else None),
            description=(str(p.desc) if pd.notna(p.desc) else ''),
            yards_gained=(int(p.yards_gained) if pd.notna(p.yards_gained) else None),
            air_yards=(int(p.air_yards) if pd.notna(p.air_yards) else None),
            yards_after_catch=(int(p.yards_after_catch) if pd.notna(p.yards_after_catch) else None),
            first_down=((p.first_down == 1) if pd.notna(p.first_down) else None),
            touchdown=(p.touchdown == 1) if pd.notna(p.touchdown) else None,
            turnover=bool((p.interception == 1) or (p.fumble_lost == 1)),
            sack=(p.sack == 1) if pd.notna(p.sack) else None,
            score_home_before=(int(p.total_home_score) if pd.notna(p.total_home_score) else None),
            score_away_before=(int(p.total_away_score) if pd.notna(p.total_away_score) else None),
            field_confidence=json.dumps(confidence), source_snapshot_id=SNAP_PBP)

        def participant(pid_val, name_val, role, team_abbr):
            if not isinstance(pid_val, str) or not pid_val.strip(): return
            player_id = person_of_gsis.get(pid_val) or ensure_player(pid_val, name_val, SNAP_PBP)
            row('football.play_participant', global_football_play_id=play_id, global_football_player_id=player_id,
                source_player_ref=pid_val, team_identity_id=identity_by_abbr.get(team_abbr), role=role, source_snapshot_id=SNAP_PBP)
            if team_abbr in identity_by_abbr:
                appearance[(game_id, player_id, identity_by_abbr[team_abbr])].add(role)
            return player_id

        off, deff = p.posteam, p.defteam
        # On kicking plays the source's posteam/defteam describe ball possession,
        # not which side a coverage tackler played for, so team is left unknown
        # for those roles rather than guessed.
        special = str(p.play_type) in ('kickoff', 'punt', 'field_goal', 'extra_point')
        passer = participant(p.passer_player_id, p.passer_player_name, 'passer', off)
        rusher = participant(p.rusher_player_id, p.rusher_player_name, 'rusher', off)
        receiver = participant(p.receiver_player_id, p.receiver_player_name, 'receiver', off)
        participant(p.kicker_player_id, None, 'kicker', off)
        participant(p.punter_player_id, None, 'punter', off)
        # On kicking plays nflverse posteam is the KICKING team, so the
        # returner belongs to the defensive team of that play.
        participant(p.kickoff_returner_player_id, None, 'returner', deff)
        participant(p.punt_returner_player_id, None, 'returner', deff)
        for col, role in (('solo_tackle_1_player_id', 'tackler_solo'), ('solo_tackle_2_player_id', 'tackler_solo'),
                          ('assist_tackle_1_player_id', 'tackler_assist'), ('assist_tackle_2_player_id', 'tackler_assist'),
                          ('sack_player_id', 'sacker'), ('half_sack_1_player_id', 'sack_half'), ('half_sack_2_player_id', 'sack_half'),
                          ('interception_player_id', 'interceptor'), ('pass_defense_1_player_id', 'pass_defender'),
                          ('forced_fumble_player_1_player_id', 'fumble_forcer')):
            participant(getattr(p, col), None, role, None if special else deff)
        # A fumble can be recovered by either side: use the team the source names.
        participant(p.fumble_recovery_1_player_id, None, 'fumble_recoverer',
                    p.fumble_recovery_1_team if isinstance(p.fumble_recovery_1_team, str) else None)
        participant(p.fumbled_1_player_id, None, 'fumbler', off)

        if pd.notna(p.penalty) and p.penalty == 1:
            pen_player = p.penalty_player_id if isinstance(p.penalty_player_id, str) else None
            row('football.play_penalty', global_football_play_id=play_id,
                penalty_type_source=(str(p.penalty_type) if pd.notna(p.penalty_type) else 'unspecified'),
                team_identity_id=identity_by_abbr.get(p.penalty_team) if pd.notna(p.penalty_team) else None,
                penalized_player_id=(person_of_gsis.get(pen_player) if pen_player else None),
                yards=(int(p.penalty_yards) if pd.notna(p.penalty_yards) else None),
                enforcement='accepted', source_snapshot_id=SNAP_PBP)

        oi = identity_by_abbr.get(off)
        add_stat(game_id, passer, oi, 'passing_yards', p.passing_yards if pd.notna(p.passing_yards) else 0)
        sacked = pd.notna(p.sack) and p.sack == 1
        add_stat(game_id, passer, oi, 'pass_attempts', 1 if p.pass_attempt == 1 and not sacked else 0)
        add_stat(game_id, passer, oi, 'completions', 1 if p.complete_pass == 1 else 0)
        add_stat(game_id, passer, oi, 'passing_touchdowns', 1 if p.pass_touchdown == 1 else 0)
        add_stat(game_id, passer, oi, 'interceptions_thrown', 1 if p.interception == 1 else 0)
        add_stat(game_id, passer, oi, 'sacks_taken', 1 if sacked else 0)
        add_stat(game_id, rusher, oi, 'rushing_yards', p.rushing_yards if pd.notna(p.rushing_yards) else 0)
        add_stat(game_id, rusher, oi, 'rush_attempts', 1 if p.rush_attempt == 1 else 0)
        add_stat(game_id, rusher, oi, 'rushing_touchdowns', 1 if p.rush_touchdown == 1 else 0)
        add_stat(game_id, receiver, oi, 'receiving_yards', p.receiving_yards if pd.notna(p.receiving_yards) else 0)
        add_stat(game_id, receiver, oi, 'targets', 1 if p.pass_attempt == 1 and not sacked else 0)
        add_stat(game_id, receiver, oi, 'receptions', 1 if p.complete_pass == 1 else 0)
        add_stat(game_id, receiver, oi, 'receiving_touchdowns', 1 if p.pass_touchdown == 1 else 0)
        # A lateral splits the play's yards between two carriers in the source;
        # crediting only the first would lose them from the team total.
        if pd.notna(p.lateral_receiving_yards) and isinstance(p.lateral_receiver_player_id, str):
            lat = participant(p.lateral_receiver_player_id, p.lateral_receiver_player_name, 'receiver', off)
            add_stat(game_id, lat, oi, 'receiving_yards', p.lateral_receiving_yards)
        if pd.notna(p.lateral_rushing_yards) and isinstance(p.lateral_rusher_player_id, str):
            lat = participant(p.lateral_rusher_player_id, p.lateral_rusher_player_name, 'rusher', off)
            add_stat(game_id, lat, oi, 'rushing_yards', p.lateral_rushing_yards)

    team_game[(game_id, identity_of_team[head.home_team])]['points'] = final_home
    team_game[(game_id, identity_of_team[head.away_team])]['points'] = final_away

for (game_id, player_id, identity), stats in player_game.items():
    for key, value in stats.items():
        if not value: continue
        row('football.player_game_stat', global_football_game_id=game_id, global_football_player_id=player_id,
            global_football_team_identity_id=identity, stat_key=key, definition_version=STAT_DEF_VERSION,
            value=value, source_snapshot_id=SNAP_PBP)
for (game_id, identity), stats in team_game.items():
    for key, value in stats.items():
        row('football.team_game_stat', global_football_game_id=game_id, global_football_team_identity_id=identity,
            stat_key=key, definition_version=STAT_DEF_VERSION, value=value, source_snapshot_id=SNAP_PBP)
# One appearance row per game+player: keep the identity with the most roles and
# report any player credited to two identities in one game (a source defect).
best_appearance, appearance_conflicts = {}, 0
for (game_id, player_id, identity), roles in appearance.items():
    key = (game_id, player_id)
    if key in best_appearance:
        appearance_conflicts += 1
        if len(roles) <= len(best_appearance[key][1]): continue
    best_appearance[key] = (identity, roles)
for (game_id, player_id), (identity, roles) in best_appearance.items():
    row('football.player_game_appearance', global_football_game_id=game_id, global_football_player_id=player_id,
        global_football_team_identity_id=identity, active=True, appeared=True, started=None,
        basis='play_role_present', source_snapshot_id=SNAP_PBP)

# ---------------------------------------------------------------- write CSV
os.makedirs(OUT, exist_ok=True)
# A table that no longer produces rows must not leave last run's CSV behind for
# the loader to pick up as if it were current.
for stale in os.listdir(OUT):
    if stale.endswith('.csv'): os.remove(os.path.join(OUT, stale))
manifest = {}
for table, rows in tables.items():
    if not rows: continue
    cols = list({k: None for r in rows for k in r}.keys())
    path = os.path.join(OUT, table.replace('.', '__') + '.csv')
    with open(path, 'w', newline='', encoding='utf-8') as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction='ignore')
        w.writeheader()
        for r in rows:
            w.writerow({c: ('' if r.get(c) is None or (isinstance(r.get(c), float) and pd.isna(r.get(c))) else r.get(c)) for c in cols})
    manifest[table] = {'rows': len(rows), 'file': os.path.basename(path), 'columns': cols}

json.dump({'built_at': NOW, 'season': SEASON_YEAR, 'mode': 'technical_validation_only',
           'tables': manifest, 'lineage_report': lineage_report,
           'snapshots': {'pbp': SNAP_PBP, 'roster': SNAP_ROSTER, 'players_ids': SNAP_IDS, 'wikidata': SNAP_WD}},
          open(os.path.join(OUT, '_manifest.json'), 'w', encoding='utf-8'), indent=1)
print(json.dumps({t: m['rows'] for t, m in sorted(manifest.items())}, indent=1))
print('season:', SEASON_ID, '(skeleton)' if SKELETON_SEASON else '(slice-local, skeleton absent)')
if unattached_reasons: print('NOT attached to the skeleton:', '; '.join(unattached_reasons))
attached = sum(1 for r in lineage_report if r['identity_bounds'] == 'attached_to_skeleton')
print(f'attached to the all-era skeleton: {attached}/{len(teams_in_data)} teams')
print('appearance identity conflicts:', appearance_conflicts)
print('identity bounds:', pd.Series([r['identity_bounds'] for r in lineage_report]).value_counts().to_dict())
