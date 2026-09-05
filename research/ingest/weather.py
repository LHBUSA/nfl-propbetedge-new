"""Historical game-environment reconstruction from the Open-Meteo ARCHIVE API
(free, keyless, non-commercial-and-commercial use permitted under CC-BY-4.0 for
the data; see the source matrix for the licence note).

RULES
  * roofed/closed games are marked and EXCLUDED from outdoor weather splits.
    They still get a row so the exclusion is explicit rather than a silent gap.
  * the snapshot is stored. Historical weather is never re-queried per request.
  * a failed or missing hour stays null. Nothing is inferred.
  * kickoff is resolved to the venue's local hour; the archive is queried
    hourly and the value AT kickoff is taken, not a daily average.
"""
import pandas as pd, numpy as np, urllib.request, json, time, os, sys

G=pd.read_parquet('data/warehouse/nfl_games.parquet')
V=pd.read_parquet('data/warehouse/nfl_venues.parquet')
vmap=V.set_index('team_abbr')[['lat','lon','tz','venue_name','indoor','espn_venue_id']].to_dict('index')
# nflverse uses LA for the Rams and WAS for Washington; ESPN uses LAR / WSH.
# Aliased explicitly rather than fuzzy-matched, and recorded here so the mapping
# is visible instead of buried.
for src,dst in (('LA','LAR'),('WAS','WSH'),('OAK','LV'),('SD','LAC'),('STL','LAR')):
    if dst in vmap and src not in vmap: vmap[src]=vmap[dst]

LIMIT=int(sys.argv[1]) if len(sys.argv)>1 else 10**9
HOURLY='temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,rain,snowfall,wind_speed_10m,wind_gusts_10m,weather_code'

def kickoff_hour(row):
    """start_time is local venue time in nflverse (e.g. '13:00'); combine with
       game_date. If it is missing the row is left unresolved rather than
       guessed at."""
    # nflverse start_time is "M/D/YY, HH:MM:SS" in the venue's local time
    st=str(row.get('start_time') or '').strip()
    d=str(row.get('game_date') or '')[:10]
    if not d or not st or st.lower()=='nan': return None,None
    try:
        clock=st.split(',')[-1].strip()
        return d,int(clock.split(':')[0])
    except Exception:
        return d,None

# RESUME: a game already settled is never re-queried. Weather for a completed
# game does not change, so re-fetching it is pure waste and needless load on a
# free service. Pass --refetch to force a full rebuild.
PRIOR={}
if '--refetch' not in sys.argv and os.path.exists('data/warehouse/nfl_game_environment.parquet'):
    P=pd.read_parquet('data/warehouse/nfl_game_environment.parquet')
    settled=P[P['om_status'].isin(['ok','skipped_indoor','skipped_no_venue','skipped_no_kickoff'])]
    PRIOR={r['game_id']:r.to_dict() for _,r in settled.iterrows()}
    print(f'resume: {len(PRIOR)} settled, {len(G)-len(PRIOR)} to attempt')

rows=[]; fetched=0; reused=0
for _,g in G.iterrows():
    if g['game_id'] in PRIOR:
        rows.append(PRIOR[g['game_id']]); reused+=1; continue
    home=g['home_team']; v=vmap.get(home)
    roof=str(g.get('roof') or '')
    closed = roof in ('dome','closed')
    d,hr = kickoff_hour(g)
    base={'game_id':g['game_id'],'season':g['season'],'week':g['week'],'home_team':home,
          'venue_name':(v or {}).get('venue_name'),'espn_venue_id':(v or {}).get('espn_venue_id'),
          'roof':g.get('roof'),'surface':g.get('surface'),
          'is_indoor_game':closed,
          'source_temp_f':g.get('temp'),'source_wind_mph':g.get('wind'),'source_weather_text':g.get('weather'),
          'lat':(v or {}).get('lat'),'lon':(v or {}).get('lon'),
          'kick_date':d,'kick_hour_local':hr}
    if closed or not v or d is None or hr is None or fetched>=LIMIT:
        base['om_status']='skipped_indoor' if closed else ('skipped_no_venue' if not v else
                          ('skipped_no_kickoff' if hr is None else 'not_fetched'))
        rows.append(base); continue
    u=(f'https://archive-api.open-meteo.com/v1/archive?latitude={v["lat"]:.4f}&longitude={v["lon"]:.4f}'
       f'&start_date={d}&end_date={d}&hourly={HOURLY}&temperature_unit=fahrenheit'
       f'&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto')
    try:
        r=urllib.request.Request(u,headers={'user-agent':'PropBetEdge-research/1.0'})
        with urllib.request.urlopen(r,timeout=45) as f: j=json.loads(f.read())
        h=j.get('hourly') or {}
        times=h.get('time') or []
        idx=next((i for i,t in enumerate(times) if int(t[11:13])==hr), None)
        if idx is None:
            base['om_status']='no_matching_hour'
        else:
            base.update({
              'om_temp_f':h['temperature_2m'][idx],'om_apparent_f':h['apparent_temperature'][idx],
              'om_humidity_pct':h['relative_humidity_2m'][idx],'om_precip_in':h['precipitation'][idx],
              'om_rain_in':h['rain'][idx],'om_snow_cm':h['snowfall'][idx],
              'om_wind_mph':h['wind_speed_10m'][idx],'om_gust_mph':h['wind_gusts_10m'][idx],
              'om_weather_code':h['weather_code'][idx],'om_status':'ok'})
        base['om_url']=u; base['om_fetched_at']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
        fetched+=1
    except Exception as e:
        base['om_status']=f'error:{str(e)[:50]}'; base['om_url']=u
    rows.append(base)
    time.sleep(0.12)                      # polite rate limiting

E=pd.DataFrame(rows)
E.to_parquet('data/warehouse/nfl_game_environment.parquet',index=False)
print(f'games: {len(E)}   fetched: {fetched}   reused: {reused}')
print(E['om_status'].value_counts(dropna=False).to_dict())
ok=E[E['om_status']=='ok']
if len(ok):
    print(f'\nOpen-Meteo vs source, where BOTH report (outdoor games only):')
    both=ok[ok['source_temp_f'].notna()]
    print(f'  n={len(both)}  temp mean abs diff: {(both["om_temp_f"]-both["source_temp_f"]).abs().mean():.1f} F')
    bw=ok[ok['source_wind_mph'].notna()]
    print(f'  n={len(bw)}  wind mean abs diff: {(bw["om_wind_mph"]-bw["source_wind_mph"]).abs().mean():.1f} mph')
    print(f'\n  outdoor games with NO source temp that Open-Meteo DID resolve: '
          f'{int((ok["source_temp_f"].isna()).sum())}')
