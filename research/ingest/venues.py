"""Venue table: ESPN public team/venue records + Open-Meteo geocoding of the
venue CITY (Open-Meteo's geocoder is place-based, so stadium names do not
resolve -- geocoding "Green Bay, WI" does). Every row keeps what was queried,
what matched and when, so a bad match is auditable rather than silent."""
import pandas as pd, urllib.request, urllib.parse, json, time

UA={'accept':'application/json','user-agent':'PropBetEdge-research/1.0'}
def get(u):
    r=urllib.request.Request(u,headers=UA)
    with urllib.request.urlopen(r,timeout=45) as f: return json.loads(f.read())

teams=get('https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=40')['sports'][0]['leagues'][0]['teams']
rows=[]
for t in teams:
    tid=t['team']['id']; abbr=t['team']['abbreviation']
    try: full=get(f'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{tid}')['team']
    except Exception as e: print('skip',abbr,e); continue
    v=(full.get('franchise') or {}).get('venue') or full.get('venue') or {}
    a=v.get('address') or {}
    rows.append({'espn_team_id':tid,'team_abbr':abbr,'team_name':full.get('displayName'),
                 'espn_venue_id':v.get('id'),'venue_guid':v.get('guid'),'venue_name':v.get('fullName'),
                 'city':a.get('city'),'state':a.get('state'),'zip':a.get('zipCode'),'country':a.get('country'),
                 'grass':v.get('grass'),'indoor':v.get('indoor'),
                 'venue_source':f'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{tid}'})
    time.sleep(0.25)
V=pd.DataFrame(rows)

def geocode(city,state):
    if not city: return {}
    q=urllib.parse.quote(f'{city}')
    u=f'https://geocoding-api.open-meteo.com/v1/search?name={q}&count=10&language=en&format=json'
    try:
        j=get(u); res=j.get('results') or []
        pick=next((r for r in res if r.get('admin1_id') and state and
                   str(r.get('admin1','')).lower()[:2]==str(state).lower()[:2]), None)
        pick=pick or next((r for r in res if r.get('country_code')=='US'), None) or (res[0] if res else None)
        if not pick: return {'geocode_url':u,'geocode_status':'no_result'}
        return {'lat':pick['latitude'],'lon':pick['longitude'],'tz':pick.get('timezone'),
                'geo_matched':pick.get('name'),'geo_admin1':pick.get('admin1'),
                'geocode_url':u,'geocode_status':'ok'}
    except Exception as e:
        return {'geocode_url':u,'geocode_status':f'error:{str(e)[:40]}'}

out=[]
for _,r in V.iterrows():
    out.append({**r.to_dict(), **geocode(r['city'], r['state']),
                'fetched_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())})
    time.sleep(0.35)
V=pd.DataFrame(out)
V.to_parquet('data/warehouse/nfl_venues.parquet',index=False)
print(f'venues: {len(V)}   geocoded: {V["lat"].notna().sum()}   indoor: {int(V["indoor"].fillna(False).sum())}')
print(V[['team_abbr','venue_name','city','state','indoor','grass','lat','lon']].head(12).to_string(index=False))
