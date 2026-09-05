"""Audit every active 2026 wide receiver against our identity spine, our
receiver warehouse, and the current market.

    python research/ingest/active_wrs.py

Same discipline as the quarterback audit: resolution is by STABLE ESPN ID
only, a name never forces a match, and a receiver with no NFL history is
reported as zero rather than backfilled.

WR ONLY. Tight ends and running backs catch passes too, but mixing them into a
receiver product silently changes what every target-share number means, so they
are excluded until the product explicitly adds them.
"""
import json, os, time, urllib.request
import pandas as pd

ESPN_TEAMS = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams'
ESPN_ROSTER = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{}/roster'
ESPN_CORE = ('https://sports.core.api.espn.com/v2/sports/football/leagues/nfl'
             '/seasons/{season}/teams/{team}/athletes?limit=200')
SEASON = 2026
GATEWAY = os.environ.get('NFL_GATEWAY', 'https://nfl-api.propbetedge.ai')
MARKETS = ['player_reception_yds', 'player_receptions', 'player_anytime_td']
UA = {'User-Agent': 'PropBetEdge-NFL-warehouse/1.0', 'accept': 'application/json'}
OUT = 'data/dist/active-wrs-2026.json'


def get(url, timeout=30, attempts=4):
    last = None
    for i in range(attempts):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return json.loads(r.read())
        except Exception as exc:                                    # noqa: BLE001
            last = exc
            time.sleep(0.5 * (2 ** i))
    raise last


def espn_teams():
    j = get(ESPN_TEAMS)
    return [{'espn_team_id': t['team']['id'], 'abbr': t['team']['abbreviation'],
             'name': t['team']['displayName']}
            for t in j['sports'][0]['leagues'][0]['teams']]


def roster_wrs(team):
    j = get(ESPN_ROSTER.format(team['espn_team_id']))
    out = []
    for group in j.get('athletes', []):
        for a in group.get('items', []):
            if ((a.get('position') or {}).get('abbreviation') or '') != 'WR':
                continue
            out.append({'espn_id': str(a.get('id')), 'name': a.get('displayName'),
                        'jersey': a.get('jersey'),
                        'experience_years': (a.get('experience') or {}).get('years'),
                        'team': team['abbr'], 'roster_bucket': group.get('position') or ''})
    return out


def roster_wrs_core(team):
    """Stable-id fallback when the site roster is unavailable for a team."""
    j = get(ESPN_CORE.format(season=SEASON, team=team['espn_team_id']))
    out = []
    for item in j.get('items', []):
        ref = (item.get('$ref') or '').replace('http://', 'https://')
        if not ref:
            continue
        try:
            a = get(ref, timeout=20, attempts=2)
        except Exception:                                           # noqa: BLE001
            continue
        if ((a.get('position') or {}).get('abbreviation') or '') != 'WR':
            continue
        out.append({'espn_id': str(a.get('id')), 'name': a.get('displayName'),
                    'jersey': a.get('jersey'),
                    'experience_years': (a.get('experience') or {}).get('years'),
                    'team': team['abbr'], 'roster_bucket': 'offense',
                    'roster_source': 'espn_core_api'})
        time.sleep(0.05)
    return out


def market_receivers():
    events = get(f'{GATEWAY}/api/odds/events')
    rows = events if isinstance(events, list) else events.get('events', [])
    rows = sorted(rows, key=lambda r: r.get('commence_time') or '')
    if not rows:
        return {}, []
    import datetime
    first = datetime.date.fromisoformat(rows[0]['commence_time'][:10])
    cutoff = (first + datetime.timedelta(days=10)).isoformat()
    slate = [r for r in rows if (r.get('commence_time') or '')[:10] <= cutoff]
    found, seen = {}, []
    for ev in slate:
        try:
            board = get(f'{GATEWAY}/api/odds/board?event_id={ev["id"]}'
                        f'&markets={",".join(MARKETS)}', timeout=40)
        except Exception as exc:                                    # noqa: BLE001
            seen.append({'event_id': ev['id'], 'error': str(exc)[:80]})
            continue
        players = {}
        for s in board.get('market_summary', []):
            players.setdefault(s['player'], set()).add(s['market'])
        for name, mk in players.items():
            found.setdefault(name, {'name': name, 'markets': set(), 'events': []})
            found[name]['markets'] |= mk
            found[name]['events'].append(ev['id'])
        seen.append({'event_id': ev['id'], 'players': len(players)})
        time.sleep(0.15)
    for v in found.values():
        v['markets'] = sorted(v['markets'])
    return found, seen


def main():
    players = pd.read_parquet('data/nflverse/players.parquet')
    players['espn_id'] = players['espn_id'].astype('string')
    by_espn, dupe = {}, set()
    for _, p in players[players['espn_id'].notna()].iterrows():
        k = str(p['espn_id']).split('.')[0]
        if k in by_espn:
            dupe.add(k)
        by_espn[k] = p

    R = pd.read_parquet('data/warehouse/nfl_receiver_games.parquet')
    hist = R.groupby('receiver_player_id').agg(
        games=('game_id', 'nunique'), targets=('targets', 'sum'),
        rec_yards=('rec_yards', 'sum'), last_game=('game_date', 'max'),
        last_season=('season', 'max')).to_dict('index')

    teams = espn_teams()
    print(f'ESPN teams: {len(teams)}')
    pool, failed = [], []
    for t in teams:
        try:
            pool += roster_wrs(t)
        except Exception as exc:                                    # noqa: BLE001
            try:
                got = roster_wrs_core(t)
                pool += got
                failed.append({'team': t['abbr'], 'error': str(exc)[:100],
                               'recovered_via': 'espn_core_api', 'wrs': len(got)})
                print(f'  roster fallback {t["abbr"]}: core API gave {len(got)} WR(s)')
            except Exception as exc2:                               # noqa: BLE001
                failed.append({'team': t['abbr'], 'error': str(exc)[:100],
                               'fallback_error': str(exc2)[:100]})
                print(f'  roster FAILED {t["abbr"]}: {exc}')
        time.sleep(0.1)
    print(f'roster WRs: {len(pool)}')

    priced, slate = market_receivers()
    print(f'market-priced receiving players on the slate: {len(priced)}')

    rows = []
    for q in pool:
        p = by_espn.get(q['espn_id']) if q['espn_id'] not in dupe else None
        gsis = str(p['gsis_id']) if p is not None and pd.notna(p.get('gsis_id')) else None
        h = hist.get(gsis) if gsis else None
        m = priced.get(q['name'])
        rows.append({
            **q, 'gsis_id': gsis,
            'matched_by': 'espn_id' if gsis else None,
            'resolution': 'resolved' if gsis else 'no_stable_id_match',
            'position_source': 'espn_roster',
            'nfl_games': int(h['games']) if h else 0,
            'career_targets': int(h['targets']) if h else 0,
            'career_rec_yards': int(h['rec_yards']) if h else 0,
            'last_game': str(h['last_game'])[:10] if h else None,
            'last_season': int(h['last_season']) if h else None,
            'market_priced': bool(m), 'markets': m['markets'] if m else []
        })

    active = [r for r in rows if r['roster_bucket'] in
              ('offense', 'injuredReserveOrOut', 'suspended')]
    # a market-priced WR is one our roster read also saw; a priced name we
    # cannot resolve to a WR identity is reported, never guessed at
    known = {r['name'] for r in rows}
    unmatched_market = [n for n in priced if n not in known]

    summary = {
        'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'position_scope': 'WR only — TE and RB are deliberately excluded',
        'teams_read': len(teams),
        'roster_wrs_total': len(pool),
        'active_wrs': len(active),
        'practice_squad_wrs': len([r for r in rows if r['roster_bucket'] == 'practiceSquad']),
        'resolved_to_gsis': len([r for r in rows if r['gsis_id']]),
        'unresolved': len([r for r in rows if not r['gsis_id']]),
        'with_nfl_history': len([r for r in rows if r['nfl_games'] > 0]),
        'zero_nfl_history': len([r for r in rows if r['gsis_id'] and r['nfl_games'] == 0]),
        'market_priced_wrs': len([r for r in rows if r['market_priced']]),
        'market_names_not_matched_to_a_wr': len(unmatched_market),
        'market_names_not_matched_sample': sorted(unmatched_market)[:12],
        'failed_rosters': failed,
        'slate_events': len(slate),
        'notes': [
            'Resolution is by stable ESPN id only. No fuzzy name match is used.',
            'A priced name that does not match a WR on any roster we read is most '
            'often a tight end or running back, which this product excludes.'
        ]
    }
    os.makedirs('data/dist', exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump({'summary': summary, 'receivers': rows}, fh, indent=1)
    print(f'\nwrote {OUT}')
    for k, v in summary.items():
        if k not in ('notes', 'failed_rosters', 'market_names_not_matched_sample'):
            print(f'  {k}: {v}')


if __name__ == '__main__':
    main()
