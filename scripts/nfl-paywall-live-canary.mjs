/* NFL access unlock — live negative-access canary.
 *
 *   node scripts/nfl-paywall-live-canary.mjs https://nfl.propbetedge.ai [--gateway-locked]
 *
 * Read-only GETs with NO session, plus client-side claims a tamperer would try
 * (a `subscribed` cookie, `pro` / owner flags, a typed owner email). Never signs
 * in, never sends a real cookie, spends no provider credits (every premium route
 * refuses before reading).
 *
 * Pass = every premium route answers 401 with x-pbe-access: anonymous and a
 * private, non-cacheable response carrying no data; public routes are never
 * refused for lack of a subscription; the page ships no site-wide lock.
 * --gateway-locked additionally requires nfl-api.propbetedge.ai to refuse a
 * direct read.
 */
const ORIGIN = (process.argv[2] || 'https://nfl.propbetedge.ai').replace(/\/$/, '');
const GATEWAY_LOCKED = process.argv.includes('--gateway-locked');
const GATEWAY = 'https://nfl-api.propbetedge.ai';

/* api/_nfl-route-policy.js: premium = proprietary PBE model output */
const PREMIUM = [
  '/api/gw/api/picks/pass', '/api/pro-model?event_id=canary',
  '/api/pbe-picks?view=current', '/api/pbe-picks?view=decision', '/api/pbe-picks?view=validation-history', '/api/pbe-prop-picks?view=current',
];
const PUBLIC = ['/api/auth-session', '/api/pbe-picks?view=preview', '/api/pbe-picks?view=state', '/api/pbe-picks?view=trackrecord', '/api/news-feed?limit=1',
  '/api/gw/api/best-line', '/api/qb-dna?list=1', '/api/pbe-validation'];

let failed = 0;
const line = (ok, name, detail) => { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`); };

for (const path of PREMIUM) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${ORIGIN}${path}${sep}subscribed=true&pro=1&role=owner&email=justin%40proptechusa.ai`, {
    headers: { accept: 'application/json', cookie: 'subscribed=true; pbe_pro=1; pbe_role=owner', 'x-pbe-role': 'owner', 'x-user-email': 'justin@proptechusa.ai' },
    redirect: 'manual',
  });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch (_) { /* not json */ }
  const ok = r.status === 401 && r.headers.get('x-pbe-access') === 'anonymous'
    && /private/.test(r.headers.get('cache-control') || '') && /no-store/.test(r.headers.get('cache-control') || '')
    && body && Object.keys(body).sort().join(',') === 'access,entitlement,error,product';
  line(ok, `premium, anonymous + forged owner claims ${path}`, `${r.status} x-pbe-access=${r.headers.get('x-pbe-access')} cache=${r.headers.get('cache-control')} bytes=${text.length}`);
}
for (const path of PUBLIC) {
  const r = await fetch(`${ORIGIN}${path}`, { headers: { accept: 'application/json' } });
  /* public = not refused for lack of a subscription (a harness without the picks tables answers 503) */
  line(![401, 403].includes(r.status) && !r.headers.get('x-pbe-access'), `public ${path}`, String(r.status));
}
{
  const r = await fetch(`${ORIGIN}/api/auth-session`, { headers: { accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  line(j.access === 'anonymous' && j.pro === false && !j.role, 'auth-session reports access=anonymous without a session', JSON.stringify({ access: j.access, pro: j.pro, role: j.role }));
}
{
  const html = await (await fetch(`${ORIGIN}/`)).text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1].split('?')[0]);
  line(scripts.join(',') === './paywall.js,./paywall-funnel-v2.js,./nfl-access-gate-v1.js', 'index.html loads session + funnel + site loader', scripts.join(','));
  line(!/html:not\(\[data-pbe-access="granted"\]\)/.test(html) && !html.includes('pbe-access-checking'), 'index.html ships no site-wide lock', '');
}
{
  const r = await fetch(`${GATEWAY}/api/best-line`, { headers: { accept: 'application/json' } });
  const note = `${r.status} (${GATEWAY_LOCKED ? 'must be locked' : 'lock not required'})`;
  line(GATEWAY_LOCKED ? r.status === 401 : true, 'gateway direct read', note);
}

console.log(`\n${failed ? `FAIL: ${failed} check(s)` : 'PASS'}`);
process.exit(failed ? 1 : 0);
