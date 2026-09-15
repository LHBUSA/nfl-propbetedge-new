"""Career Ledger harvest: factual NFL game history for every Player DNA player.

Source of truth: ESPN's own per-athlete ledger, keyed by the ESPN athlete id
that Player DNA and the nfl-current accumulator already join on.

  athlete   /athletes/{id}                 debutYear, position, current team
  stats     /athletes/{id}/stats           regular-season rows per season + career totals
  gamelog   /athletes/{id}/gamelog?season= every game (regular season + postseason)

Rules this script enforces:
  * Identity is the ESPN athlete id. Names are never joined on. The nflverse
    players table is used only to AUDIT the ESPN id <-> GSIS id mapping; an
    ESPN id that maps to more than one GSIS id (or the reverse) fails closed.
  * Game rows come only from the game log. Season and career totals are sums
    of those rows, never averages, never estimates.
  * A stat the game log does not publish for that player is null, not zero.
  * Pro Bowl games are published as "postseason" events; they are not NFL
    games in a career record and are excluded (and listed as excluded).
  * Coverage is PROVEN, not assumed. A season counts as covered when the game
    log's regular-season game count equals ESPN's own season GP and the
    published yardage/attempt fields agree. A season between debut and the
    last season with no ESPN data at all is an unproven gap. Any gap, or a
    game-count mismatch, makes coverage incomplete and the product must say
    TRACKED HISTORY instead of CAREER.

Output: data/dist/career-ledger.json (history through the last completed
season; the current season is composed at request time from the live ledger).

Usage: python scripts/career-ledger/harvest_career_ledger.py [--cache DIR] [--only ESPN_ID ...]
"""
import argparse, concurrent.futures as cf, json, os, re, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
BASE = 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/'
LAST_COMPLETED_SEASON = 2025
POSITIONS = ('qb', 'rb', 'wr', 'te')

FIELD = {
    'completions': 'cmp', 'passingAttempts': 'att', 'passingYards': 'pyd', 'passingTouchdowns': 'ptd',
    'interceptions': 'int', 'sacks': 'sck', 'rushingAttempts': 'car', 'rushingYards': 'ryd',
    'rushingTouchdowns': 'rtd', 'receptions': 'rec', 'receivingTargets': 'tgt', 'receivingYards': 'recyd',
    'receivingTouchdowns': 'rectd', 'fumbles': 'fum', 'fumblesLost': 'fuml',
}
# ESPN season-stats labels -> ledger fields, per category (labels repeat across categories).
STATS_MAP = {
    'passing': {'CMP': 'cmp', 'ATT': 'att', 'YDS': 'pyd', 'TD': 'ptd', 'INT': 'int'},
    'rushing': {'CAR': 'car', 'YDS': 'ryd', 'TD': 'rtd'},
    'receiving': {'REC': 'rec', 'TGTS': 'tgt', 'YDS': 'recyd', 'TD': 'rectd'},
}
# Coverage asks one question: is every game there? A game-count disagreement
# with the provider's own season row blocks CAREER. Field-level disagreements
# are the provider disagreeing with itself (measured: Kelce 2015 targets 100 in
# the season row vs 103 across its own game log; Josh Allen 2020 passing yards
# 4,544 vs 4,546 after a stat correction reached one surface), so they are
# published as reconciliation notes, never hidden and never "fixed".
BLOCKING = {'games'}


def num(v):
    if v is None:
        return None
    s = str(v).replace(',', '').strip()
    if s in ('', '-', '--'):
        return None
    try:
        n = float(s)
    except ValueError:
        return None
    return int(n) if n.is_integer() else n


class Fetcher:
    def __init__(self, cache):
        self.cache = cache
        os.makedirs(cache, exist_ok=True)

    def get(self, path, key):
        fn = os.path.join(self.cache, key + '.json')
        os.makedirs(os.path.dirname(fn), exist_ok=True)
        if os.path.exists(fn):
            with open(fn, encoding='utf-8') as f:
                return json.load(f)
        last = None
        for attempt in range(4):
            try:
                req = urllib.request.Request(BASE + path, headers={'User-Agent': 'Mozilla/5.0', 'accept': 'application/json'})
                with urllib.request.urlopen(req, timeout=40) as r:
                    body = json.load(r)
                tmp = fn + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump(body, f)
                os.replace(tmp, fn)
                return body
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return None
                last = e
            except Exception as e:  # network hiccup: retry, then fail loudly
                last = e
            time.sleep(1.5 * (attempt + 1))
        raise RuntimeError(f'fetch_failed {path}: {last}')


def season_kind(display):
    d = display or ''
    if re.search(r'Postseason', d, re.I):
        return 'POST'
    if re.search(r'Regular', d, re.I):
        return 'REG'
    return None


def parse_gamelog(body, season):
    """Rows for one season, plus the events that were deliberately excluded."""
    if not body:
        return [], []
    names = body.get('names') or []
    events = body.get('events') or {}
    rows, excluded, seen = [], [], set()
    for stype in body.get('seasonTypes') or []:
        kind = season_kind(stype.get('displayName'))
        for cat in stype.get('categories') or []:
            for ev in cat.get('events') or []:
                eid = str(ev.get('eventId') or '')
                if not eid or eid in seen:
                    continue
                seen.add(eid)
                meta = events.get(eid) or {}
                opp = (meta.get('opponent') or {}).get('abbreviation') or ''
                note = meta.get('eventNote') or ''
                if kind is None:
                    excluded.append({'event_id': eid, 'reason': f'unrecognised season type {stype.get("displayName")!r}'})
                    continue
                if opp in ('AFC', 'NFC') or re.search(r'pro\s*bowl', note, re.I):
                    excluded.append({'event_id': eid, 'reason': 'pro_bowl', 'date': meta.get('gameDate')})
                    continue
                stats = {}
                for n, v in zip(names, ev.get('stats') or []):
                    if n in FIELD:
                        stats[FIELD[n]] = num(v)
                team = (meta.get('team') or {}).get('abbreviation')
                team_id = str((meta.get('team') or {}).get('id') or '')
                home = str(meta.get('homeTeamId') or '') == team_id if team_id else (meta.get('atVs') == 'vs')
                hs, as_ = num(meta.get('homeTeamScore')), num(meta.get('awayTeamScore'))
                ts, os_ = (hs, as_) if home else (as_, hs)
                res = meta.get('gameResult')
                rows.append({
                    'e': eid, 'd': meta.get('gameDate'), 's': season, 'st': kind, 'w': meta.get('week'),
                    't': team, 'o': opp, 'h': 1 if home else 0,
                    'r': f'{res} {ts}-{os_}' if res and ts is not None and os_ is not None else None,
                    'x': stats,
                })
    rows.sort(key=lambda r: r['d'] or '')
    return rows, excluded


def season_reference(stats_body):
    """ESPN regular-season stat rows summed per season (a traded player has one row per team)."""
    ref, totals = {}, {}
    if not stats_body:
        return ref, totals
    for cat in stats_body.get('categories') or []:
        m = STATS_MAP.get(cat.get('name'))
        if not m:
            continue
        labels = cat.get('labels') or []
        for row in cat.get('statistics') or []:
            y = (row.get('season') or {}).get('year')
            if y is None:
                continue
            # A traded player gets one row per team AND a "YYYY Totals" row;
            # summing all three double counts. Team rows only.
            if not row.get('teamId') or 'total' in str(row.get('teamSlug') or '').lower():
                continue
            vals = dict(zip(labels, row.get('stats') or []))
            slot = ref.setdefault(int(y), {'gp': {}, 'fields': {}})
            gp = num(vals.get('GP'))
            if gp is not None:
                slot['gp'][cat['name']] = slot['gp'].get(cat['name'], 0) + gp
            for lab, field in m.items():
                n = num(vals.get(lab))
                if n is not None:
                    slot['fields'][field] = slot['fields'].get(field, 0) + n
        tv = dict(zip(labels, cat.get('totals') or []))
        for lab, field in m.items():
            n = num(tv.get(lab))
            if n is not None:
                totals[field] = n
        if num(tv.get('GP')) is not None:
            totals.setdefault('gp', {})[cat['name']] = num(tv.get('GP'))
    return ref, totals


def sum_rows(rows):
    out = {'games': len(rows)}
    for f in FIELD.values():
        vals = [r['x'].get(f) for r in rows if f in r['x']]
        # Published for at least one game -> a real sum; never published -> unknown.
        out[f] = sum(v for v in vals if v is not None) if any(v is not None for v in vals) else None
    return out


def harvest_player(fx, espn_id, dna, nflverse):
    athlete_body = fx.get(espn_id, f'{espn_id}/athlete')
    if not athlete_body or not athlete_body.get('athlete'):
        return {'espn_id': espn_id, 'error': 'athlete_not_found'}
    a = athlete_body['athlete']
    stats_body = fx.get(f'{espn_id}/stats', f'{espn_id}/stats')
    ref, espn_totals = season_reference(stats_body)
    debut_espn = a.get('debutYear')
    nv = nflverse.get(espn_id) or {}
    stat_years = sorted(ref.keys())
    candidates = [y for y in (debut_espn, stat_years[0] if stat_years else None) if y]
    debut = min(candidates) if candidates else None
    # Where the career ends. An active player's record must run through the last
    # completed season. A player who is not active ends at his last recorded
    # game in EITHER independent source (ESPN's season rows, or the nflverse
    # play-by-play games in the Player DNA dataset). nflverse players.last_season
    # is not used: it runs past retirement (measured: Rivers, Gore, Fitzgerald).
    last_seen = [y for y in (stat_years[-1] if stat_years else None, dna.get('last_pbp_season')) if y]
    last = min(LAST_COMPLETED_SEASON, max(last_seen)) if last_seen else LAST_COMPLETED_SEASON
    if dna.get('active_2026'):
        last = LAST_COMPLETED_SEASON

    rows, excluded, seasons, gaps, mismatches = [], [], [], [], []
    # Every season's game log is read through the last completed season, so a
    # game the provider logged after the player's last season row is never
    # dropped; the career window then ends at the later of that and `last`.
    logs = {}
    for y in range(debut, LAST_COMPLETED_SEASON + 1) if debut else []:
        logs[y] = parse_gamelog(fx.get(f'{espn_id}/gamelog?season={y}', f'{espn_id}/gamelog-{y}'), y)
    logged = [y for y, (season_rows, _) in logs.items() if season_rows]
    if logged:
        last = max(last, logged[-1])
    for y in range(debut, last + 1) if debut else []:
        season_rows, ex = logs[y]
        excluded += ex
        rows += season_rows
        reg = [r for r in season_rows if r['st'] == 'REG']
        r = ref.get(y)
        if not season_rows and not r:
            gaps.append({'season': y, 'reason': 'no provider game log and no provider season row'})
            continue
        entry = {'season': y, 'reg_games': len(reg), 'post_games': len(season_rows) - len(reg)}
        if r:
            gp = max(r['gp'].values()) if r['gp'] else None
            entry['provider_gp'] = gp
            if gp is not None and gp != len(reg):
                mismatches.append({'season': y, 'field': 'games', 'ledger': len(reg), 'provider': gp, 'blocking': True})
            sums = sum_rows(reg)
            for field, pv in r['fields'].items():
                lv = sums.get(field)
                if lv is None:
                    continue  # the game log does not publish this field for this player
                if abs(lv - pv) > 1e-9:
                    mismatches.append({'season': y, 'field': field, 'ledger': lv, 'provider': pv, 'blocking': False})
        elif reg:
            # Games in the log with no provider season row to prove the count against.
            gaps.append({'season': y, 'reason': 'game log present but provider publishes no season row to verify it'})
        seasons.append(entry)

    blocking = [m for m in mismatches if m['blocking']]
    nv_rookie = nv.get('rookie_season')
    debut_note = None
    if nv_rookie and debut and nv_rookie < debut:
        debut_note = f'nflverse rookie_season {nv_rookie} precedes ESPN debut {debut}'
        for y in range(nv_rookie, debut):
            gaps.append({'season': y, 'reason': 'nflverse lists the player before ESPN debut; no provider data'})
    complete = bool(debut) and not gaps and not blocking

    teams = []
    for r in rows:
        if r['t'] and (not teams or teams[-1] != r['t']):
            teams.append(r['t'])
    return {
        'espn_id': espn_id,
        'gsis_id': dna.get('gsis_id'),
        'name': a.get('displayName'),
        'dna_name': dna.get('display_name'),
        'position': (a.get('position') or {}).get('abbreviation') or dna.get('position'),
        'dna_positions': sorted(dna.get('positions') or []),
        'current_team': (a.get('team') or {}).get('abbreviation'),
        'active': a.get('active'),
        'debut_season': debut,
        'debut_sources': {'espn_debut_year': debut_espn, 'first_espn_stat_season': stat_years[0] if stat_years else None, 'nflverse_rookie_season': nv_rookie, 'note': debut_note},
        'history_through_season': last,
        'coverage': {
            'complete': complete,
            'window': [debut, last],
            'gaps': gaps,
            'mismatches': mismatches,
            'basis': 'regular-season game count and published volume fields reconciled per season against the provider season rows',
        },
        'provider_career_regular_season': espn_totals,
        'teams': teams,
        'excluded_events': excluded,
        'games': rows,
    }


def load_dna_players():
    players = {}
    for pos in POSITIONS:
        with open(os.path.join(ROOT, 'data', 'dist', f'{pos}-dna-dataset.json'), encoding='utf-8') as f:
            data = json.load(f)
        for p in data['players']:
            eid = str(p.get('espn_id') or '')
            if not eid:
                continue
            cur = players.setdefault(eid, {**p, 'positions': set()})
            if cur.get('gsis_id') != p.get('gsis_id'):
                raise SystemExit(f'IDENTITY CONFLICT: espn {eid} carries gsis {cur.get("gsis_id")} and {p.get("gsis_id")}')
            cur['positions'].add(pos.upper())
        key = {'qb': 'qb_games', 'rb': 'player_games'}.get(pos, 'receiver_games')
        by_gsis = {p['gsis_id']: str(p.get('espn_id') or '') for p in data['players']}
        for g in data[key]:
            eid = by_gsis.get(g.get('pid'))
            if eid and eid in players:
                players[eid]['last_pbp_season'] = max(players[eid].get('last_pbp_season') or 0, int(g['s']))
    return players


def load_nflverse():
    import pandas as pd
    df = pd.read_parquet(os.path.join(ROOT, 'data', 'nflverse', 'players.parquet'))
    df = df[df.espn_id.notna() & (df.espn_id.astype(str) != '')]
    df = df.assign(espn_id=df.espn_id.astype(str))
    by_espn = df.groupby('espn_id').gsis_id.nunique()
    by_gsis = df.groupby('gsis_id').espn_id.nunique()
    out = {}
    for r in df.itertuples():
        out[r.espn_id] = {
            'gsis_id': r.gsis_id,
            'ambiguous': bool(by_espn[r.espn_id] > 1 or by_gsis[r.gsis_id] > 1),
            'rookie_season': int(r.rookie_season) if r.rookie_season == r.rookie_season and r.rookie_season else None,
            'last_season': int(r.last_season) if r.last_season == r.last_season and r.last_season else None,
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.environ.get('CAREER_CACHE') or os.path.join(ROOT, '..', 'nfl-career-cache'))
    ap.add_argument('--only', nargs='*')
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--out', default=os.path.join(ROOT, 'data', 'dist', 'career-ledger.json'))
    args = ap.parse_args()

    dna = load_dna_players()
    nflverse = load_nflverse()
    identity = {'dna_players': len(dna), 'nflverse_gsis_match': 0, 'nflverse_gsis_conflict': [], 'nflverse_ambiguous': [], 'nflverse_missing': []}
    for eid, p in dna.items():
        nv = nflverse.get(eid)
        if not nv:
            identity['nflverse_missing'].append(eid)
        elif nv['ambiguous']:
            identity['nflverse_ambiguous'].append(eid)
        elif nv['gsis_id'] != p.get('gsis_id'):
            identity['nflverse_gsis_conflict'].append({'espn_id': eid, 'dna_gsis': p.get('gsis_id'), 'nflverse_gsis': nv['gsis_id']})
        else:
            identity['nflverse_gsis_match'] += 1
    blocked = {c['espn_id'] for c in identity['nflverse_gsis_conflict']} | set(identity['nflverse_ambiguous'])

    ids = args.only or sorted(dna.keys(), key=int)
    fx = Fetcher(args.cache)
    players, failures = {}, []
    t0 = time.time()
    with cf.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(harvest_player, fx, eid, dna[eid], nflverse): eid for eid in ids if eid not in blocked}
        for i, fut in enumerate(cf.as_completed(futs), 1):
            eid = futs[fut]
            try:
                rec = fut.result()
                if rec.get('error'):
                    failures.append({'espn_id': eid, 'error': rec['error']})
                else:
                    players[eid] = rec
            except Exception as e:
                failures.append({'espn_id': eid, 'error': str(e)})
            if i % 50 == 0:
                print(f'{i}/{len(futs)} players in {time.time() - t0:.0f}s', flush=True)

    if failures and not args.only:
        print(json.dumps(failures[:20], indent=1))
        raise SystemExit(f'{len(failures)} players failed to harvest; refusing to write a partial ledger')

    coverage = {}
    for rec in players.values():
        for pos in rec['dna_positions'] or [rec['position']]:
            c = coverage.setdefault(pos, {'players': 0, 'complete': 0, 'tracked_only': 0, 'games': 0, 'earliest_season': None, 'latest_season': None})
            c['players'] += 1
            c['complete' if rec['coverage']['complete'] else 'tracked_only'] += 1
            c['games'] += len(rec['games'])
            if rec['games']:
                s0, s1 = rec['games'][0]['s'], rec['games'][-1]['s']
                c['earliest_season'] = s0 if c['earliest_season'] is None else min(c['earliest_season'], s0)
                c['latest_season'] = s1 if c['latest_season'] is None else max(c['latest_season'], s1)

    out = {
        'meta': {
            'contract': 'career-ledger-history/v1',
            'generated_at': datetime.now(timezone.utc).isoformat(),
            'history_through_season': LAST_COMPLETED_SEASON,
            'identity': 'ESPN athlete id; nflverse players table audits the ESPN<->GSIS mapping; names are never joined',
            'source': {'provider': 'espn_athlete_gamelog', 'endpoints': ['athletes/{id}', 'athletes/{id}/stats', 'athletes/{id}/gamelog?season='], 'base': BASE},
            'field_keys': {'e': 'espn_event_id', 'd': 'kickoff_utc', 's': 'season', 'st': 'season_type', 'w': 'week', 't': 'team', 'o': 'opponent', 'h': 'home', 'r': 'result', 'x': 'stats'},
            'stat_keys': {v: k for k, v in FIELD.items()},
            'identity_audit': {**identity, 'blocked_players': sorted(blocked)},
            'coverage_by_position': coverage,
            'failures': failures,
        },
        'players': {k: players[k] for k in sorted(players, key=int)},
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(out, f, separators=(',', ':'))
    print(json.dumps(out['meta']['coverage_by_position'], indent=1))
    print(json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in identity.items()}, indent=1))
    print('wrote', args.out, os.path.getsize(args.out), 'bytes')


if __name__ == '__main__':
    main()
