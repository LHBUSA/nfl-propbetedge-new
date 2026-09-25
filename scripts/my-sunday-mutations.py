"""Mutation check for tests/nfl-my-sunday.test.mjs: each mutation removes one
security or data rule; the suite must fail for every one.

    python scripts/my-sunday-mutations.py
"""
import subprocess, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
W = 'workers/nfl-my-sunday/src/index.js'
C = 'workers/nfl-my-sunday/src/core.js'
A = 'api/my-sunday.js'
MUTATIONS = [
    ('delete not scoped to owner', W,
     "'DELETE FROM saved_items WHERE owner_key = ?1 AND item_key = ?2').bind(owner, itemKey)",
     "'DELETE FROM saved_items WHERE item_key = ?1').bind(itemKey)"),
    ('list not scoped to owner', W,
     "'SELECT * FROM saved_items WHERE owner_key = ?1 ORDER BY saved_at DESC LIMIT ?2').bind(owner, MAX_ITEMS)",
     "'SELECT * FROM saved_items ORDER BY saved_at DESC LIMIT ?1').bind(MAX_ITEMS)"),
    ('CSRF origin not checked', A,
     "try { return new URL(origin).host.toLowerCase() === host; } catch (_) { return false; }",
     "return true;"),
    ('paywalled email granted', A,
     "if (session.access === 'granted' && verifiedEmail(session)) return null;",
     "if (verifiedEmail(session)) return null;"),
    ('owner claim from body trusted', A,
     [("delete payload.owner; delete payload.owner_key; delete payload.email; delete payload.account_id;", ""),
      ("'x-pbe-owner': ownerKey(verifiedEmail(s), secret)", "'x-pbe-owner': payload?.owner_key || ownerKey(verifiedEmail(s), secret)")], None),
    ('save overwrites the snapshot', W,
     "if (existing) return { created: false, item: publicItem(existing) };",
     "if (existing) { await db.prepare('DELETE FROM saved_items WHERE owner_key = ?1 AND item_key = ?2').bind(owner, item.item_key).run(); }"),
    ('unavailable lane still alerts', C,
     "if (!lanes[c.kind]) continue;",
     ""),
    ('pre-save designations alert', C,
     "if (!after(when, it.saved_at)) continue;",
     ""),
    ('vanished quote treated as a move', C,
     "  if (!quote) return null;\n  const line",
     "  if (!quote) return { alert_id: 'gone', item_key: item.item_key, kind: 'PROP_LINE', observed_at: 'x', payload: {} };\n  const line"),
    ('private cache header dropped', A,
     "res.setHeader('cache-control', 'private, no-store, max-age=0');",
     "res.setHeader('cache-control', 'public, max-age=60');"),
]
survivors = 0
for name, rel, old, new in MUTATIONS:
    p = ROOT / rel
    orig = p.read_bytes()
    text = orig.decode('utf-8')
    pairs = old if isinstance(old, list) else [(old, new)]
    mutated = text
    for o, n in pairs:
        assert mutated.count(o) == 1, f'anchor not unique: {name}'
        mutated = mutated.replace(o, n, 1)
    try:
        p.write_bytes(mutated.encode('utf-8'))
        r = subprocess.run(['node', '--test', 'tests/nfl-my-sunday.test.mjs'], cwd=ROOT, capture_output=True, text=True)
        killed = r.returncode != 0
    finally:
        p.write_bytes(orig)
    survivors += 0 if killed else 1
    print(('KILLED   ' if killed else 'SURVIVED ') + name)
print(f'{len(MUTATIONS) - survivors}/{len(MUTATIONS)} killed')
sys.exit(1 if survivors else 0)
