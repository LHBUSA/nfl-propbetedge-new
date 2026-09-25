"""Mutation check for the opportunity contract tests: each mutation breaks one
rule the tests claim to guard; a surviving mutation means a vacuous test.

    python scripts/opportunity-mutations.py
"""
import subprocess, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'workers' / 'nfl-replay' / 'src' / 'opportunity.js'
MUTATIONS = [
    ('averaged shares instead of ratio of sums',
     "out.target_share = ratio(P.t, T.targets);",
     "out.target_share = apps.length ? apps.reduce((s, a) => s + (a.tt.targets ? a.p.t / a.tt.targets : 0), 0) / apps.length : null;"),
    ('scramble counted as a carry',
     "if (p.qb_scramble) return { universe: 'dropback', kind: 'scramble',",
     "if (p.qb_scramble) return { universe: 'designed_run', kind: 'scramble',"),
    ('missing latest game scored instead of flagged',
     "if (!latestIsTeamLatest && latestTeamGame) {",
     "if (false) {"),
    ('sacks treated as attempts',
     "if (p.sack) return { universe: 'dropback', kind: 'sack' };",
     "if (false) return null;"),
    ('other-season aggregates merged',
     "if (g?.game_id && Number(g.season) === Number(season)) byId.set(g.game_id, g);",
     "if (g?.game_id) byId.set(g.game_id, g);"),
    ('insight emitted without a real move',
     "if (!j || !['EXPANDING', 'DECLINING'].includes(j.label)) continue;\n    const key",
     "if (!j) continue;\n    const key"),
]

original = SRC.read_text(encoding='utf-8')
survivors = 0
try:
    for name, old, new in MUTATIONS:
        assert original.count(old) == 1, f'mutation anchor not unique: {name}'
        SRC.write_text(original.replace(old, new, 1), encoding='utf-8', newline='\n')
        r = subprocess.run(['node', '--test', 'tests/nfl-opportunity.test.mjs'], cwd=ROOT, capture_output=True, text=True)
        killed = r.returncode != 0
        survivors += 0 if killed else 1
        print(('KILLED   ' if killed else 'SURVIVED ') + name)
finally:
    SRC.write_text(original, encoding='utf-8', newline='\n')
print(f'{len(MUTATIONS) - survivors}/{len(MUTATIONS)} killed')
sys.exit(1 if survivors else 0)
