"""Mutation proof for the NFL auth entitlement gate (SEV-1 2026-09-15).

Each mutation weakens the gate the way a regression would. The auth test
suites MUST fail for every one; the file is restored afterwards either way.

    python scripts/auth-entitlement-mutations.py
"""
import pathlib, subprocess, sys

sys.stdout.reconfigure(encoding='utf-8')
REPO = pathlib.Path(__file__).resolve().parent.parent
TESTS = ['tests/nfl-all-access-bridge.test.mjs', 'tests/nfl-membership-state.test.mjs', 'tests/nfl-auth-entitlement-gate.test.mjs', 'tests/nfl-auth-access-v2.test.mjs', 'tests/nfl-auth-magic-link-single-use.test.mjs', 'tests/nfl-purchase-delivery.test.mjs', 'tests/nfl-billing-worker.test.mjs']

MUTATIONS = [
    ('All Access outage treated as entitled', 'api/_nfl-entitlement-ledger.js',
     "    return { ...verdict, all_access: 'unavailable', all_access_error: String(error?.message || 'all_access_unavailable') };",
     "    return { entitled: true, reason: 'all_access', product: 'nfl', plan: 'all_access', billing: 'recurring', source: ALL_ACCESS_PRODUCT_KEY, status: 'active', current_period_end: new Date(Date.now() + 864e5).toISOString(), cancel_at_period_end: false, stripe_price_id: null };"),
    ('All Access bridge accepts the billing owner identity exception / any product', 'api/_nfl-entitlement-ledger.js',
     "  if (body.access_source === 'owner' || !sub || sub.product_key !== ALL_ACCESS_PRODUCT_KEY) {",
     "  if (false) {"),
    ('All Access bridge ignores status and period end', 'api/_nfl-entitlement-ledger.js',
     "  if (!ALL_ACCESS_GRANTING_STATUS.has(status)) return { entitled: false, reason: 'all_access_inactive', status, plan: 'all_access' };",
     "  if (false) return { entitled: false, reason: 'all_access_inactive', status, plan: 'all_access' };\n  if (!Number.isFinite(end) || end <= now) return { entitled: true, reason: 'all_access', product: 'nfl', plan: 'all_access', billing: 'recurring', source: ALL_ACCESS_PRODUCT_KEY, status, current_period_end: null, cancel_at_period_end: false, stripe_price_id: null };"),
    ('All Access consulted even when the NFL ledger cannot answer', 'api/_nfl-entitlement-ledger.js',
     "  const verdict = await lookupNflEntitlement(email, ledger);",
     "  const verdict = await lookupNflEntitlement(email, ledger).catch(() => ({ entitled: false, reason: 'no_subscription', status: null, plan: null }));"),
    ('lookup degrades to "any active subscription"', 'api/_nfl-entitlement-ledger.js',
     "  return selectNflEntitlement(rows, verified, nowMs ?? Date.now());",
     "  if (rows.some(r => String(r?.status).toLowerCase() === 'active')) return { entitled: true, reason: 'entitled', plan: 'any', billing: 'recurring', status: 'active', current_period_end: new Date(Date.now() + 864e5).toISOString() };\n  return selectNflEntitlement(rows, verified, nowMs ?? Date.now());"),
    ('predicate accepts any price id', 'api/_nfl-entitlement.js',
     "  const recurring = NFL_RECURRING_PRICES.has(priceId);",
     "  const recurring = NFL_RECURRING_PRICES.has(priceId) || Boolean(priceId);"),
    ('NFL monthly price id changed', 'api/_nfl-entitlement.js',
     "foundingMonthly: 'price_1UEWAXF3CaVzg4ORGlsgboLq',",
     "foundingMonthly: 'price_1UEWAXF3CaVzg4ORGlsgboLX',"),
    ('request gate removed (token + Resend for any email)', 'workers/nfl-auth/src/index-v5.js',
     "  let access=await checkAccess(env,email);",
     "  let access={allowed:true,role:'subscriber',reason:'subscriber'};"),
    ('exchange recheck disabled', 'workers/nfl-auth/src/index-v5.js',
     "    const access=await checkAccess(env,email);\n    const tag=await emailTag(email);",
     "    const access={allowed:true,role:'subscriber'};\n    const tag=await emailTag(email);"),
    ('ledger outage treated as allowed at exchange', 'workers/nfl-auth/src/index-v5.js',
     "    return{allowed:false,role:null,reason:'entitlement_unavailable'};",
     "    return{allowed:true,role:'subscriber',reason:'entitlement_unavailable'};"),
    ('checkout-complete stamps without a confirmed send', 'api/checkout-complete.js',
     "  if(!CONFIRMED.has(result)){",
     "  if(false){"),
    ('internal delivery accepts browser (Origin) calls', 'workers/nfl-auth/src/index-v5.js',
     "if(req.method!=='POST'||expected.length<32||req.headers.get('Origin'))",
     "if(req.method!=='POST'||expected.length<32)"),
    ('internal delivery skips the token check', 'workers/nfl-auth/src/index-v5.js',
     "if(!auth.startsWith('Bearer ')||!(await sameSecret(auth.slice(7).trim(),expected)))",
     "if(false)"),
    ('internal delivery forgets confirmed sends (no idempotency)', 'workers/nfl-auth/src/index-v5.js',
     "    const committed=await deliveryRecord(env,key,'commit',{resend_id:d.resend_id});",
     "    const committed=await deliveryRecord(env,key,'release');"),
    ('internal delivery reports sent without sending', 'workers/nfl-auth/src/index-v5.js',
     "  if(d.result==='sent'){",
     "  if(d.result==='sent'||d.result==='not_entitled'){"),
    # nfl-billing v1.4.0 split the confirmed-send branch (Slack notice) from the
    # already-sent branch; weakening the latter still declares any result sent.
    ('billing treats any delivery result as sent', 'workers/nfl-billing/src/index.js',
     "  if (result === 'already_sent') return true;",
     "  return true;"),
    ('auth-session no longer paywalls no_entitlement', 'api/auth-session.js',
     "    if (session.access === 'no_entitlement') {",
     "    if (false) {"),
]

def run_tests():
    r = subprocess.run(['node', '--test', *TESTS], cwd=REPO, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=300)
    fails = [l for l in r.stdout.splitlines() if l.startswith('ℹ fail')]
    return r.returncode, (fails[0] if fails else '')

code, summary = run_tests()
print(f'baseline: exit={code} {summary}')
if code != 0:
    sys.exit('baseline must pass before mutating')

survivors = 0
for name, rel, old, new in MUTATIONS:
    path = REPO / rel
    original = path.read_bytes()
    text = original.decode('utf-8')
    # Anchors are written with \n; a CRLF checkout (Windows, core.autocrlf) must still match.
    if '\r\n' in text:
        old, new = old.replace('\n', '\r\n'), new.replace('\n', '\r\n')
    assert text.count(old) == 1, f'{name}: anchor not unique in {rel}'
    try:
        path.write_bytes(text.replace(old, new).encode('utf-8'))
        code, summary = run_tests()
    finally:
        path.write_bytes(original)
    killed = code != 0
    survivors += 0 if killed else 1
    print(f"{'KILLED ' if killed else 'SURVIVED'} {name}: exit={code} {summary}")

sys.exit(1 if survivors else 0)
