"""Build the rights-clean college->NFL development spine.

Institutions, football programmes, conferences, college head coaches, the
player->college association, and how a player entered professional football —
from CC0 Wikidata and the federal EADA filing, and from nothing else.

    python history/pipeline/fetch_college_seed.py      # CC0 Wikidata
    python history/pipeline/fetch_eada.py              # US Dept of Education
    python history/pipeline/build_college_spine.py

Writes CSV to history/.out/college-spine/ (gitignored) plus a coverage report.

WHAT IS NOT HERE, and will not be added quietly
-----------------------------------------------
No college statistics. Not because they are missing — because the D3 audit found
we hold no rights to any of them. This spine answers "who went where, and what
happened next". It cannot answer "how good were they in college", and the read
contract in history/api/college-pipeline.mjs refuses fields that would imply it.

Draft round and pick come only from Wikidata's own P647 statements, which are
sparse (273 across the whole database). They are NOT backfilled from
Pro-Football-Reference or nflverse: the registry marks every draft-detail source
we hold do_not_use, and a fact being widely known is not a licence to hold it.
A null here is the honest state.

IDENTITY
--------
Nothing merges on a name. Every person is keyed on a Wikidata QID, every
institution on a QID, and the EADA join is on the IPEDS unit id (P1771) rather
than on the institution's name — "Miami" would otherwise merge Florida with Ohio.

SAMPLING BIAS
-------------
Wikidata holds items for people notable enough to have one. Anchoring on a
Pro-Football-Reference id means every player here reached professional football,
so this dataset has no denominator: absence is not a negative outcome. The lane
policy (src_wikidata / college_affiliation) records that as
sampling_bias='notability_survivorship' and refuses the model purposes it would
corrupt. The refusal is enforced in code, not in this docstring.
"""
from __future__ import annotations
import csv, hashlib, json, os, re, sys
from collections import defaultdict
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding='utf-8')
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SEED = os.path.join(REPO, 'history', '.out', 'college-seed')
EADA = os.path.join(REPO, 'history', '.out', 'eada')
OUT = os.path.join(REPO, 'history', '.out', 'college-spine')
NOW = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
PARSER = ('pbe-history-college-spine', '0.1.0')

PRECISION_NAME = {'11': 'day', '10': 'month', '9': 'year'}

tables: dict[str, list[dict]] = defaultdict(list)
seen: set = set()


def row(table, **kw):
    tables[table].append(kw)


def once(table, key, **kw):
    """Write a row at most once. The key is explicit so that two seed files
    describing the same institution produce one row, not a silent duplicate."""
    if (table, key) in seen:
        return False
    seen.add((table, key))
    tables[table].append(kw)
    return True


def gid(prefix, *parts):
    return f'{prefix}_{hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:20]}'


def load(name, directory=SEED):
    path = os.path.join(directory, f'{name}.json')
    if not os.path.exists(path):
        raise SystemExit(f'missing seed {path} — run the fetch scripts first')
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def date_of(value, precision=None):
    """A Wikidata date at its stated precision. A year-precision fact becomes
    1 January ONLY as a storage convention, and the precision travels with it so
    a reader is never told we know the day."""
    if not value:
        return None, 'unknown'
    m = re.match(r'^(-?\d{4})-(\d{2})-(\d{2})', str(value))
    if not m or m.group(1).startswith('-'):
        return None, 'unknown'
    y, mo, d = m.groups()
    name = PRECISION_NAME.get(str(precision), 'day' if precision is None else 'unknown')
    if name == 'year':
        return f'{y}-01-01', 'year'
    if name == 'month':
        return f'{y}-{mo}-01', 'month'
    return f'{y}-{mo}-{d}', name


def season_of(value, precision=None):
    iso, prec = date_of(value, precision)
    return (int(iso[:4]) if iso else None), prec


def snapshot(seed, lane, dataset=None):
    """One snapshot row per seed file, carrying the LANE. The lane is what the
    rights engine resolves; a snapshot without one, on a source that requires
    lanes, is invisible everywhere."""
    sid = gid('snp', seed['source_id'], seed['dataset'], seed['content_sha256'])
    once('football_src.source_snapshot', sid,
         source_snapshot_id=sid, source_id=seed['source_id'], lane=lane,
         dataset=dataset or seed['dataset'],
         retrieved_from=seed.get('endpoint') or seed.get('landing_page') or '',
         retrieved_at=seed['retrieved_at'], content_sha256=seed['content_sha256'],
         parser_name=PARSER[0], parser_version=PARSER[1], row_count=seed['row_count'])
    return sid


def cite(entity_type, entity_id, snap, key, role='supports'):
    once('football_src.entity_source_record', (entity_type, entity_id, snap, key),
         entity_type=entity_type, entity_id=entity_id, source_snapshot_id=snap,
         source_record_key=key, role=role, observed_at=NOW)


def external(entity_type, entity_id, system, value, snap, confidence=1.0):
    if value in (None, ''):
        return
    once('football_src.external_id', (entity_type, system, str(value), entity_id),
         entity_type=entity_type, entity_id=entity_id, id_system=system, id_value=str(value),
         source_snapshot_id=snap, confidence=confidence, observed_at=NOW)


def main():
    os.makedirs(OUT, exist_ok=True)
    report = {'built_at': NOW, 'gaps': [], 'counts': {}}

    players_seed = load('players')
    played_seed = load('played')
    programs_seed = load('programs')
    schools_seed = load('schools')
    conferences_seed = load('conferences')
    coaches_seed = load('college_coaches')
    draft_seed = load('draft')
    eada_seed = load('football_sponsorship', EADA)

    # The CC0 college lane is public. Proprietary identifiers (PFR, ESPN,
    # NFL.com, Sports-Reference college) are CC0 as VALUES but name third-party
    # systems, so they go on their own snapshot in the internal-only
    # 'identifiers' lane. Holding a PFR id is not permission to hold PFR data.
    snap_players = snapshot(players_seed, 'college_affiliation')
    snap_played = snapshot(played_seed, 'college_affiliation')
    snap_programs = snapshot(programs_seed, 'college_affiliation')
    snap_schools = snapshot(schools_seed, 'college_affiliation')
    snap_conf = snapshot(conferences_seed, 'college_affiliation')
    snap_coaches = snapshot(coaches_seed, 'college_affiliation')
    snap_draft = snapshot(draft_seed, 'college_affiliation')
    snap_eada = snapshot(eada_seed, 'institution_program_year')
    snap_ids = snapshot({**players_seed, 'dataset': 'wikidata_college_identifiers',
                         'content_sha256': players_seed['content_sha256'] + ':ids'},
                        'identifiers', dataset='wikidata_college_identifiers')

    # ---------------------------------------------------------------- schools
    school_by_qid, school_by_ipeds = {}, {}
    for r in schools_seed['rows']:
        qid = r['school']
        sid = gid('gsc', qid)
        if once('football.school', sid, global_school_id=sid, name=r.get('schoolLabel') or qid,
                kind='college', city=r.get('locationLabel'), region=None, country_code='US',
                source_snapshot_id=snap_schools):
            cite('school', sid, snap_schools, qid)
            external('school', sid, 'wikidata_qid', qid, snap_schools)
        school_by_qid[qid] = sid
        if r.get('ipeds'):
            external('school', sid, 'ipeds_unitid', r['ipeds'], snap_schools)
            school_by_ipeds[str(r['ipeds']).strip()] = sid
        if r.get('ncaaOrg'):
            external('school', sid, 'ncaa_organization_code', r['ncaaOrg'], snap_ids)

    # ------------------------------------------------------------ conferences
    conf_by_qid = {}
    for r in conferences_seed['rows']:
        qid = r['conference']
        cid = gid('gcc', qid)
        start, _ = date_of(r.get('inception'))
        end, _ = date_of(r.get('dissolved'))
        if once('football.college_conference', cid, global_college_conference_id=cid,
                name=r.get('conferenceLabel') or qid, short_name=r.get('shortName'),
                governing_body=None, effective_from=start, effective_to=end,
                source_snapshot_id=snap_conf, observed_at=NOW):
            cite('college_conference', cid, snap_conf, qid)
            external('college_conference', cid, 'wikidata_qid', qid, snap_conf)
        conf_by_qid[qid] = cid

    # --------------------------------------------------------------- programmes
    program_by_qid, program_by_school = {}, {}
    orphan_programs = []
    for r in programs_seed['rows']:
        qid = r['team']
        pid = gid('gct', qid)
        # r['school'] is already the UNIVERSITY, reached as P831/P1268: the
        # programme's parent club, then the institution that club represents.
        # P831 alone is the athletics club and matches no P69 target at all.
        school_qid = r.get('school')
        school_id = school_by_qid.get(school_qid) if school_qid else None
        if school_id is None:
            # A programme whose institution cannot be reached keeps no invented
            # school. It is a gap, not a guess.
            orphan_programs.append({'program': qid, 'label': r.get('teamLabel'),
                                    'club': r.get('clubLabel')})
            continue
        if once('football.college_team', pid, global_college_team_id=pid, global_school_id=school_id,
                nickname=r.get('teamLabel'), source_snapshot_id=snap_programs):
            cite('college_team', pid, snap_programs, qid)
            external('college_team', pid, 'wikidata_qid', qid, snap_programs)
            if r.get('srcfbSchool'):
                external('college_team', pid, 'sports_reference_cfb_school_id', r['srcfbSchool'], snap_ids)
        program_by_qid[qid] = pid
        program_by_school.setdefault(school_id, pid)

        # The programme's own conference wins; the club's is the fallback. Both
        # exist in Wikidata and neither is present for every programme.
        conf_qid = r.get('conference') or r.get('clubConference')
        if conf_qid and conf_qid in conf_by_qid:
            mid = gid('gcm', qid, conf_qid)
            # Wikidata's P118 carries no season bounds here, so the membership is
            # recorded as current-with-unknown-bounds rather than given dates we
            # do not have.
            once('football.college_conference_membership', mid,
                 college_conference_membership_id=mid, global_college_team_id=pid,
                 global_college_conference_id=conf_by_qid[conf_qid],
                 first_season=None, last_season=None, sport_scope='football',
                 source_snapshot_id=snap_programs, observed_at=NOW)

    if orphan_programs:
        report['gaps'].append({
            'gap': 'programme without a parent institution',
            'count': len(orphan_programs),
            'detail': 'Wikidata P831 parent club is missing, so the programme cannot be attached to a school. '
                      'It is skipped rather than attached to a guess.',
            'examples': orphan_programs[:5]})

    # ------------------------------------------------------ programme seasons (EADA)
    eada_matched, eada_unmatched = 0, defaultdict(int)
    for r in eada_seed['rows']:
        school_id = school_by_ipeds.get(str(r['unitid']).strip())
        if not school_id:
            eada_unmatched[r['institution_name']] += 1
            continue
        pid = program_by_school.get(school_id)
        if not pid:
            # The institution is known but has no programme entity in Wikidata.
            # Create the programme from the federal filing, which is the source
            # that actually establishes the programme existed.
            pid = gid('gct_eada', school_id)
            if once('football.college_team', pid, global_college_team_id=pid, global_school_id=school_id,
                    nickname=None, source_snapshot_id=snap_eada):
                cite('college_team', pid, snap_eada, f'unitid:{r["unitid"]}')
            program_by_school[school_id] = pid
        rid = gid('gps', pid, r['season_year'], r['survey_year'])
        if once('football.college_program_season', rid,
                college_program_season_id=rid, global_college_team_id=pid,
                season_year=r['season_year'],
                sponsored='true' if r.get('sponsored') else 'false',
                squad_size_reported=r.get('squad_size_reported'),
                classification=r.get('classification'), survey_year=r['survey_year'],
                reporting_basis='institution_self_report',
                source_snapshot_id=snap_eada, observed_at=NOW):
            eada_matched += 1

    if eada_unmatched:
        report['gaps'].append({
            'gap': 'EADA institution with no CC0 counterpart',
            'count': sum(eada_unmatched.values()),
            'distinct_institutions': len(eada_unmatched),
            'detail': 'No Wikidata item carries this IPEDS unit id (P1771). The row is skipped rather than '
                      'matched on institution name, which would merge same-named institutions.',
            'examples': sorted(eada_unmatched)[:5]})

    # ------------------------------------------------------------------ people
    played_pfr = {r['pfr'] for r in played_seed['rows']}
    players_by_qid = {}
    affiliations = 0
    no_school_link = defaultdict(int)

    for r in players_seed['rows']:
        qid = r['item']
        person = gid('gpe', qid)
        player = gid('gpl', qid)
        if once('football.person', person, global_football_person_id=person, status='active',
                merged_into_person_id=None, created_at=NOW):
            once('football.player', player, global_football_player_id=player, global_football_person_id=person)
            cite('person', person, snap_players, qid)
            cite('player', player, snap_players, qid)
            external('person', person, 'wikidata_qid', qid, snap_players)
            external('player', player, 'wikidata_qid', qid, snap_players)
            # Proprietary identifier systems: internal lane only.
            external('player', player, 'pfr_player_id', r.get('pfr'), snap_ids)
            external('player', player, 'nfl_com_player_id', r.get('nflcom'), snap_ids)
            external('player', player, 'espn_athlete_id', r.get('espn'), snap_ids)
            external('player', player, 'sports_reference_cfb_player_id', r.get('srcfb'), snap_ids)
            label = r.get('itemLabel') or qid
            parts = label.split()
            once('football.person_name', (person, label),
                 global_football_person_id=person, name_kind='canonical', display_name=label,
                 given_name=parts[0] if len(parts) > 1 else None,
                 family_name=parts[-1] if parts else None, generational_suffix=None,
                 normalized_key=re.sub(r'[^a-z ]', '', label.lower()).strip(),
                 effective_from=None, effective_to=None,
                 source_snapshot_id=snap_players, observed_at=NOW)
        players_by_qid[qid] = player

        college_qid = r.get('college')
        if not college_qid:
            continue
        school_id = school_by_qid.get(college_qid)
        if not school_id:
            # A P69 target that is not a US university — a high school, a
            # foreign institution. Not a college football association.
            no_school_link[college_qid] += 1
            continue

        start_iso, start_prec = date_of(r.get('start'), r.get('startPrec'))
        end_iso, end_prec = date_of(r.get('end'), r.get('endPrec'))
        precision = start_prec if start_iso else (end_prec if end_iso else 'unknown')
        aid = gid('gpca', qid, college_qid, 'educated_at')
        if once('football.player_college_affiliation', aid,
                player_college_affiliation_id=aid, global_football_player_id=player,
                global_school_id=school_id,
                global_college_team_id=program_by_school.get(school_id),
                basis='educated_at',
                # P69 establishes attendance. It does NOT establish that they
                # played football there, and the two are not combined to invent one.
                played_football=None,
                effective_from=start_iso, effective_to=end_iso, date_precision=precision,
                first_season=int(start_iso[:4]) if start_iso else None,
                last_season=int(end_iso[:4]) if end_iso else None,
                source_snapshot_id=snap_players, observed_at=NOW):
            affiliations += 1
            cite('player_college_affiliation', aid, snap_players, f'{qid}/P69/{college_qid}')

    if no_school_link:
        report['gaps'].append({
            'gap': 'P69 target that is not a US university',
            'count': sum(no_school_link.values()),
            'distinct_items': len(no_school_link),
            'detail': 'Educated-at points at a high school or a non-US institution. Not written as a college '
                      'association.'})

    # ------------------------------------------------------------ college coaches
    coach_tenures = 0
    for r in coaches_seed['rows']:
        team_qid, coach_qid = r['team'], r['coach']
        pid = program_by_qid.get(team_qid)
        if not pid:
            continue
        person = gid('gpe', coach_qid)
        coach = gid('gco', coach_qid)
        if once('football.person', person, global_football_person_id=person, status='active',
                merged_into_person_id=None, created_at=NOW):
            cite('person', person, snap_coaches, coach_qid)
            external('person', person, 'wikidata_qid', coach_qid, snap_coaches)
            label = r.get('coachLabel') or coach_qid
            parts = label.split()
            once('football.person_name', (person, label),
                 global_football_person_id=person, name_kind='canonical', display_name=label,
                 given_name=parts[0] if len(parts) > 1 else None,
                 family_name=parts[-1] if parts else None, generational_suffix=None,
                 normalized_key=re.sub(r'[^a-z ]', '', label.lower()).strip(),
                 effective_from=None, effective_to=None,
                 source_snapshot_id=snap_coaches, observed_at=NOW)
        if once('football.coach', coach, global_football_coach_id=coach, global_football_person_id=person):
            cite('coach', coach, snap_coaches, coach_qid)
            if r.get('ncaaCoach'):
                external('coach', coach, 'ncaa_statistics_coach_id', r['ncaaCoach'], snap_ids)
        start_iso, _ = date_of(r.get('start'), r.get('startPrec'))
        end_iso, _ = date_of(r.get('end'), r.get('endPrec'))
        tid = gid('gctn', coach_qid, team_qid, start_iso or 'unknown')
        if once('football.coaching_tenure', tid, coaching_tenure_id=tid,
                global_football_coach_id=coach, global_football_team_identity_id=None,
                global_college_team_id=pid, role='head coach', role_class='head_coach',
                play_caller=None, effective_from=start_iso, effective_to=end_iso,
                source_snapshot_id=snap_coaches, observed_at=NOW):
            coach_tenures += 1

    # -------------------------------------------------------------- the transition
    transitions, with_detail = 0, 0
    for r in draft_seed['rows']:
        qid = r['item']
        player = players_by_qid.get(qid)
        if not player:
            continue
        year = None
        if r.get('draftYear'):
            iso, _ = date_of(r['draftYear'])
            year = int(iso[:4]) if iso else None

        def as_int(v):
            try:
                return int(str(v).strip())
            except (TypeError, ValueError):
                return None

        rnd, pick = as_int(r.get('round')), as_int(r.get('pick'))
        tid = gid('gc2p', qid, r['team'], year or 'unknown')
        if once('football.college_to_pro_transition', tid,
                college_to_pro_transition_id=tid, global_football_player_id=player,
                global_school_id=None, global_college_team_id=None, league_id=None,
                entry_route='draft', entry_year=year, entering_team_identity_id=None,
                draft_round=rnd, draft_overall_pick=pick,
                # The constraint in the schema refuses a draft detail with no
                # snapshot to justify it, so the citation is not optional.
                draft_detail_source_snapshot_id=snap_draft if (rnd or pick) else None,
                source_snapshot_id=snap_draft, observed_at=NOW):
            transitions += 1
            if rnd or pick:
                with_detail += 1
            cite('college_to_pro_transition', tid, snap_draft, f'{qid}/P647/{r["team"]}')

    # ------------------------------------------------------------------ write
    for table, rows in sorted(tables.items()):
        if not rows:
            continue
        columns = list({k: None for r in rows for k in r})
        path = os.path.join(OUT, table.replace('.', '__') + '.csv')
        with open(path, 'w', newline='', encoding='utf-8') as f:
            w = csv.DictWriter(f, fieldnames=columns)
            w.writeheader()
            for r in rows:
                w.writerow({c: ('' if r.get(c) is None else r.get(c)) for c in columns})
        report['counts'][table] = len(rows)

    report['coverage'] = {
        'players_with_a_pfr_anchor': len(players_by_qid),
        'player_college_affiliations': affiliations,
        'players_with_at_least_one_affiliation': len({r['global_football_player_id']
                                                      for r in tables['football.player_college_affiliation']}),
        'players_recorded_as_playing_college_football': len(played_pfr),
        'institutions': len(school_by_qid),
        'institutions_with_ipeds_id': len(school_by_ipeds),
        'programmes': len({r['global_college_team_id'] for r in tables['football.college_team']}),
        'programmes_from_wikidata': len(program_by_qid),
        'conferences': len(conf_by_qid),
        'conference_memberships': len(tables['football.college_conference_membership']),
        'college_coaching_tenures': coach_tenures,
        'eada_programme_seasons': eada_matched,
        'eada_seasons_covered': sorted({r['season_year'] for r in eada_seed['rows']}),
        'transitions': transitions,
        'transitions_with_round_or_pick': with_detail,
    }
    report['sampling_bias'] = {
        'lane': 'src_wikidata/college_affiliation',
        'bias': 'notability_survivorship',
        'why': 'Every player here is anchored on a Pro-Football-Reference id, so every player here reached '
               'professional football. There is no denominator: the college players who did not are absent, '
               'and their absence is not a negative label.',
        'enforced_by': 'football_src.source_lane_policy.prohibited_model_uses and lib/rights.mjs assertModelUse',
    }
    report['not_included'] = [
        'college statistics of any kind (no rights — see history/docs/COLLEGE_DATA_RIGHTS.md)',
        'recruiting ratings, stars or rankings',
        'talent composite, SP+, FPI, scouting grades',
        'draft round and pick beyond Wikidata P647 (every other draft-detail source is do_not_use)',
    ]
    with open(os.path.join(OUT, '_report.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)

    print(f'college spine -> {OUT}')
    for table, n in sorted(report['counts'].items()):
        print(f'  {table:48s} {n:7d}')
    print()
    for k, v in report['coverage'].items():
        print(f'  {k:48s} {v if not isinstance(v, list) else str(v[:3]) + "..."}')
    print()
    for gap in report['gaps']:
        print(f'  GAP  {gap["gap"]}: {gap["count"]}')


if __name__ == '__main__':
    main()
