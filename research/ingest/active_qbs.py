"""Audit every active 2026 quarterback against our identity spine and warehouse.

Two populations, kept separate because they answer different questions:

  ROSTER POOL     every QB on a current ESPN 53-man/active roster. This is
                  "who could play".
  MARKET STARTERS the QBs the current prop market actually prices for the
                  upcoming slate. Books price the expected starter, so this is
                  the best available public signal for "who is expected to
                  play". It is NOT a confirmed depth chart, and it is labelled
                  as market-derived everywhere it appears.

ESPN's /depthchart endpoint returns an empty object, so no depth chart is
claimed. We do not guess a starter.

Every QB is resolved to a GSIS identity by STABLE ESPN ID ONLY. A name is never
used to force a match. A QB with no NFL history is reported as exactly that —
zero games — and never backfilled with college numbers.

    python research/ingest/active_qbs.py
"""
import json, os, time, urllib.request, urllib.error
import pandas as pd

ESPN_TEAMS = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams'
ESPN_ROSTER = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{}/roster'
# Fallback when the site roster 404s (observed for ARI on 2026-09-05). The core
# API is authoritative for STABLE ATHLETE IDS, which is the only thing we need —
# it means an upstream roster outage never forces us into a name match.
ESPN_CORE_ATHLETES = ('https://sports.core.api.espn.com/v2/sports/football/leagues/nfl'
                      '/seasons/{season}/teams/{team}/athletes?limit=200')
SEASON = 2026
GATEWAY = os.environ.get('NFL_GATEWAY', 'https://nfl-api.propbetedge.ai')
MARKETS = ['player_pass_yds', 'player_pass_attempts', 'player_pass_completions',
           'player_pass_tds', 'player_pass_interceptions']
UA = {'User-Agent': 'PropBetEdge-NFL-warehouse/1.0', 'accept': 'application/json'}
OUT = 'data/dist/active-qbs-2026.json'


def get(url, timeout=30, attempts=4):
    """Retry with backoff. A transient 404/5xx from ESPN is common and is not
       evidence that a team has no roster."""
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except Exception as exc:                                    # noqa: BLE001
            last = exc
            time.sleep(0.5 * (2 ** i))
    raise last


def espn_teams():
    j = get(ESPN_TEAMS)
    out = []
    for g in j['sports'][0]['leagues'][0]['teams']:
        t = g['team']
        out.append({'espn_team_id': t['id'], 'abbr': t['abbreviation'],
                    'name': t['displayName']})
    return out


def roster_qbs(team):
    j = get(ESPN_ROSTER.format(team['espn_team_id']))
    out = []
    for group in j.get('athletes', []):
        # practice squad and IR are excluded from the ACTIVE pool but recorded
        bucket = group.get('position') or ''
        for a in group.get('items', []):
            pos = ((a.get('position') or {}).get('abbreviation') or '')
            if pos != 'QB':
                continue
            out.append({
                'espn_id': str(a.get('id')), 'name': a.get('displayName'),
                'jersey': a.get('jersey'),
                'experience_years': ((a.get('experience') or {}).get('years')),
                'team': team['abbr'], 'espn_team_id': team['espn_team_id'],
                'roster_bucket': bucket
            })
    return out


def roster_qbs_core(team):
    """Stable-id fallback. Costs one request per athlete, so it is used only
       for a team whose site roster failed."""
    j = get(ESPN_CORE_ATHLETES.format(season=SEASON, team=team['espn_team_id']))
    out = []
    for item in j.get('items', []):
        ref = item.get('$ref')
        if not ref:
            continue
        try:
            a = get(ref.replace('http://', 'https://'), timeout=20, attempts=2)
        except Exception:                                           # noqa: BLE001
            continue
        pos = ((a.get('position') or {}).get('abbreviation') or '')
        if pos != 'QB':
            continue
        out.append({
            'espn_id': str(a.get('id')), 'name': a.get('displayName'),
            'jersey': a.get('jersey'),
            'experience_years': ((a.get('experience') or {}).get('years')),
            'team': team['abbr'], 'espn_team_id': team['espn_team_id'],
            'roster_bucket': 'offense', 'roster_source': 'espn_core_api'
        })
        time.sleep(0.05)
    return out


def market_starters():
    """QBs the current market prices for the upcoming slate."""
    events = get(f'{GATEWAY}/api/odds/events')
    rows = events if isinstance(events, list) else events.get('events', [])
    # the next slate: everything inside 10 days of the earliest upcoming kickoff
    rows = sorted(rows, key=lambda r: r.get('commence_time') or '')
    if not rows:
        return {}, []
    first = rows[0]['commence_time'][:10]
    slate = [r for r in rows if (r.get('commence_time') or '')[:10] <= _plus_days(first, 10)]
    found, seen_events = {}, []
    for ev in slate:
        try:
            board = get(f'{GATEWAY}/api/odds/board?event_id={ev["id"]}'
                        f'&markets={",".join(MARKETS)}', timeout=40)
        except Exception as exc:                                    # noqa: BLE001
            seen_events.append({'event_id': ev['id'], 'error': str(exc)[:80]})
            continue
        players = {}
        for s in board.get('market_summary', []):
            players.setdefault(s['player'], set()).add(s['market'])
        for name, markets in players.items():
            found.setdefault(name, {'name': name, 'markets': set(), 'events': []})
            found[name]['markets'] |= markets
            found[name]['events'].append(ev['id'])
        seen_events.append({'event_id': ev['id'], 'players': len(players),
                            'away': ev.get('away_team'), 'home': ev.get('home_team'),
                            'commence_time': ev.get('commence_time')})
        time.sleep(0.15)                              # polite rate limiting
    for v in found.values():
        v['markets'] = sorted(v['markets'])
    return found, seen_events


def _plus_days(d, n):
    import datetime
    return (datetime.date.fromisoformat(d) + datetime.timedelta(days=n)).isoformat()


def main():
    players = pd.read_parquet('data/nflverse/players.parquet')
    players['espn_id'] = players['espn_id'].astype('string')
    # STABLE ID ONLY. one row per espn_id; a duplicate espn_id is a conflict,
    # not something to pick a winner from.
    by_espn, dupe_espn = {}, set()
    for _, p in players[players['espn_id'].notna()].iterrows():
        k = str(p['espn_id']).split('.')[0]
        if k in by_espn:
            dupe_espn.add(k)
        by_espn[k] = p
    by_name = {}
    for _, p in players.iterrows():
        by_name.setdefault(str(p['display_name']).lower(), []).append(p)

    qb = pd.read_parquet('data/warehouse/nfl_qb_games.parquet')
    hist = qb.groupby('passer_player_id').agg(
        games=('game_id', 'nunique'),
        primary=('is_primary_passer', 'sum'),
        last_game=('game_date', 'max'),
        last_season=('season', 'max')).to_dict('index')

    teams = espn_teams()
    print(f'ESPN teams: {len(teams)}')
    pool, failed_rosters = [], []
    for t in teams:
        try:
            pool += roster_qbs(t)
        except Exception as exc:                                    # noqa: BLE001
            try:
                got = roster_qbs_core(t)
                pool += got
                failed_rosters.append({'team': t['abbr'], 'error': str(exc)[:120],
                                       'recovered_via': 'espn_core_api', 'qbs': len(got)})
                print(f'  roster fallback {t["abbr"]}: core API gave {len(got)} QB(s)')
            except Exception as exc2:                               # noqa: BLE001
                failed_rosters.append({'team': t['abbr'], 'error': str(exc)[:120],
                                       'fallback_error': str(exc2)[:120]})
                print(f'  roster FAILED {t["abbr"]}: {exc} / fallback {exc2}')
        time.sleep(0.1)
    print(f'roster QBs: {len(pool)}')

    starters, slate = market_starters()
    print(f'market-priced QBs on the upcoming slate: {len(starters)}')

    def resolve(espn_id, name):
        """A stable id match, or nothing. Names never force a match."""
        if espn_id and espn_id in by_espn:
            if espn_id in dupe_espn:
                return None, 'espn_id_ambiguous'
            return by_espn[espn_id], 'espn_id'
        return None, 'no_stable_id_match'

    rows = []
    for q in pool:
        p, how = resolve(q['espn_id'], q['name'])
        gsis = str(p['gsis_id']) if p is not None and pd.notna(p.get('gsis_id')) else None
        h = hist.get(gsis) if gsis else None
        m = starters.get(q['name'])
        rows.append({
            **q,
            'gsis_id': gsis, 'matched_by': how if gsis else None,
            'resolution': 'resolved' if gsis else how,
            'nfl_games': int(h['games']) if h else 0,
            'primary_passer_games': int(h['primary']) if h else 0,
            'last_game': str(h['last_game'])[:10] if h else None,
            'last_season': int(h['last_season']) if h else None,
            'market_priced': bool(m),
            'markets': m['markets'] if m else []
        })

    # a market-priced QB who is on NO active roster we read is still a fact
    known = {r['name'] for r in rows}
    for name, m in starters.items():
        if name in known:
            continue
        cands = by_name.get(name.lower(), [])
        rows.append({
            'espn_id': None, 'name': name, 'jersey': None, 'experience_years': None,
            'team': None, 'espn_team_id': None, 'roster_bucket': 'market_only',
            'gsis_id': None, 'matched_by': None,
            'resolution': 'market_priced_but_not_on_a_read_roster',
            'nfl_games': 0, 'primary_passer_games': 0,
            'last_game': None, 'last_season': None,
            'market_priced': True, 'markets': m['markets'],
            'name_candidates_in_spine': [str(c['gsis_id']) for c in cands]
        })

    active = [r for r in rows if r['roster_bucket'] in ('offense', 'injuredReserveOrOut',
                                                        'suspended', 'market_only')]
    summary = {
        'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'teams_read': len(teams),
        'roster_qbs_total': len(pool),
        'active_qbs': len(active),
        'practice_squad_qbs': len([r for r in rows if r['roster_bucket'] == 'practiceSquad']),
        'resolved_to_gsis': len([r for r in rows if r['gsis_id']]),
        'unresolved': len([r for r in rows if not r['gsis_id']]),
        'with_nfl_history': len([r for r in rows if r['nfl_games'] > 0]),
        'zero_nfl_history': len([r for r in rows if r['gsis_id'] and r['nfl_games'] == 0]),
        'market_priced': len([r for r in rows if r['market_priced']]),
        'ambiguous_espn_ids': sorted(dupe_espn & {r['espn_id'] for r in rows if r['espn_id']}),
        'failed_rosters': failed_rosters,
        'slate_events': slate,
        'notes': [
            'Resolution is by STABLE ESPN ID only. No fuzzy name match is used.',
            'Market-priced means the current prop market lists a passing market for '
            'this player on the upcoming slate. It is not a confirmed depth chart.',
            'ESPN /depthchart returns an empty object, so no starter is claimed.',
            'A QB with zero NFL games is reported as zero. College statistics are '
            'never substituted.'
        ]
    }
    os.makedirs('data/dist', exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump({'summary': summary, 'quarterbacks': rows}, fh, indent=1)

    print(f'\nwrote {OUT}')
    for k, v in summary.items():
        if k not in ('slate_events', 'notes'):
            print(f'  {k}: {v}')


if __name__ == '__main__':
    main()
