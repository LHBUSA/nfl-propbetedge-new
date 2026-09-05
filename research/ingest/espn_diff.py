"""Structural diff: everything the ESPN gamepackage carries vs what /api/nfl-live emits."""
import json,sys,re,urllib.request,collections

def paths(o,pre='',out=None,maxd=6,d=0):
    """Schema paths. A list contributes its FIRST element's shape as [] so the
       output is a schema, not a per-row dump."""
    if out is None: out=set()
    if d>maxd: return out
    if isinstance(o,dict):
        for k,v in o.items():
            p=f'{pre}.{k}' if pre else k
            if isinstance(v,(dict,list)): paths(v,p,out,maxd,d+1)
            else: out.add((p,type(v).__name__))
    elif isinstance(o,list):
        if o: paths(o[0],pre+'[]',out,maxd,d+1)
        else: out.add((pre+'[]','empty'))
    return out

def get(u):
    r=urllib.request.Request(u,headers={'accept':'application/json','user-agent':'Mozilla/5.0'})
    with urllib.request.urlopen(r,timeout=60) as f: return json.loads(f.read())

G=sys.argv[1] if len(sys.argv)>1 else '401772936'
up=json.load(open('research/sources/espn-game.json'))['gamepackageJSON']
ours=get(f'https://nfl.propbetedge.ai/api/nfl-live?event={G}')

UP=paths(up); OURS=paths(ours)
def snake(n):
    n=n.replace('[]','')
    return re.sub(r'(?<!^)(?=[A-Z])','_',n).lower()
# our API renames camelCase to snake_case, so compare on a normalized leaf name
# or the comparison invents "dropped" fields that are simply spelled differently
our_leaf={snake(p.split('.')[-1]) for p,_ in OURS}
missing=sorted(p for p,_ in UP if snake(p.split('.')[-1]) not in our_leaf)

# value ranking, assigned by what each field would unlock downstream
HIGH={'grass','attendance','officials','zipCode','city','state','country','guid','adjQBR','QBRating',
 'statYardage','isTurnover','isPenalty','athletes','stats','keys','headshot','jersey','shortDisplayName',
 'homeWinPercentage','playByPlaySource','boxscoreSource','neutralSite','conferenceCompetition',
 'thirdDownEff','fourthDownEff','totalDrives','possessionTime','turnovers','redZoneAttempts',
 'seed','record','summary','probablePitcher','odds','spread','overUnder','details','week','type'}
MED={'displayOrder','order','position','fullName','abbreviation','shortName','logo','logos','venue',
 'address','images','broadcasts','media','shortText','alternateColor','color','uid','links','name'}
def rank(p):
    leaf=p.split('.')[-1].replace('[]','')
    if leaf in HIGH: return 'HIGH'
    if any(x in p for x in ('.links','.logos','.images','videos','news','article','.href','.rel','.alt','.text.','shortLinkText')): return 'NOISE'
    if leaf in MED: return 'MEDIUM'
    return 'MEDIUM'
buckets=collections.defaultdict(list)
for p in missing: buckets[rank(p)].append(p)
print(f'UPSTREAM leaf paths: {len(UP)}    OUR API leaf paths: {len(OURS)}')
print(f'UPSTREAM paths whose leaf name never appears in our output: {len(missing)}\n')
for b in ('HIGH','MEDIUM','NOISE'):
    print(f'--- {b} ({len(buckets[b])}) ---')
    for p in buckets[b][:120 if b=='HIGH' else 40]: print('   ',p)
    print()
json.dump({b:buckets[b] for b in buckets},open('research/out/espn-dropped.json','w'),indent=1)
