/* NFL paywall — live negative-access canary.
 *
 *   node scripts/nfl-paywall-live-canary.mjs https://nfl.propbetedge.ai [--gateway-locked]
 *
 * Read-only GETs with NO session, plus client-side claims a tamperer would try
 * (a `subscribed` cookie, `pro` query flags). Never signs in, never sends a real
 * cookie, spends no provider credits (every paid route refuses before reading).
 *
 * Pass = every paid route answers 401 with x-pbe-access: anonymous and a
 * private, non-cacheable response carrying no data; public routes stay public.
 * --gateway-locked additionally requires nfl-api.propbetedge.ai to refuse a
 * direct read (rollout step 4).
 */
const ORIGIN = (process.argv[2] || 'https://nfl.propbetedge.ai').replace(/\/$/, '');
const GATEWAY_LOCKED = process.argv.includes('--gateway-locked');
const GATEWAY = 'https://nfl-api.propbetedge.ai';

const PAID = [
  '/api/gw/api/best-line', '/api/gw/api/odds/board?event_id=canary&markets=player_reception_yds', '/api/gw/api/odds/prop-coverage', '/api/gw/api/changes',
  '/api/pro-model?event_id=canary', '/api/home-market?away=Chicago%20Bears&home=Carolina%20Panthers', '/api/game-intel?event_id=canary',
  '/api/qb-dna?list=1', '/api/wr-dna?list=1', '/api/rb-dna?list=1', '/api/te-dna?list=1', '/api/qb-dna/prop-lab?player_id=canary', '/api/qb-dna/game-context',
  '/api/pbe-picks?view=state', '/api/pbe-picks?view=current', '/api/pbe-picks?view=trackrecord', '/api/pbe-prop-picks?view=trackrecord', '/api/pbe-validation', '/api/weather-watch',
];
const PUBLIC = ['/api/auth-session', '/api/pbe-picks?view=preview', '/api/news-feed?limit=1'];

let failed = 0;
const line = (ok, name, detail) => { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`); };

for (const path of PAID) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${ORIGIN}${path}${sep}subscribed=true&pro=1`, { headers: { accept: 'application/json', cookie: 'subscribed=true; pbe_pro=1' }, redirect: 'manual' });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch (_) { /* not json */ }
  const ok = r.status === 401 && r.headers.get('x-pbe-access') === 'anonymous'
    && /private/.test(r.headers.get('cache-control') || '') && /no-store/.test(r.headers.get('cache-control') || '')
    && body && Object.keys(body).sort().join(',') === 'access,entitlement,error,product';
  line(ok, `anonymous ${path}`, `${r.status} x-pbe-access=${r.headers.get('x-pbe-access')} cache=${r.headers.get('cache-control')} bytes=${text.length}`);
}
for (const path of PUBLIC) {
  const r = await fetch(`${ORIGIN}${path}`, { headers: { accept: 'application/json' } });
  /* public = not refused for lack of a subscription (a harness without the picks tables answers 503) */
  line(![401, 403].includes(r.status) && !r.headers.get('x-pbe-access'), `public ${path}`, String(r.status));
}
{
  const r = await fetch(`${ORIGIN}/api/auth-session`, { headers: { accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  line(j.access === 'anonymous' && j.pro === false, 'auth-session reports access=anonymous without a session', JSON.stringify({ access: j.access, pro: j.pro }));
}
{
  const html = await (await fetch(`${ORIGIN}/`)).text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1].split('?')[0]);
  line(scripts.join(',') === './paywall.js,./paywall-funnel-v2.js,./nfl-access-gate-v1.js', 'index.html loads no workspace code statically', scripts.join(','));
}
{
  const r = await fetch(`${GATEWAY}/api/best-line`, { headers: { accept: 'application/json' } });
  const note = `${r.status} (${GATEWAY_LOCKED ? 'must be locked' : 'lock not required until rollout step 4'})`;
  line(GATEWAY_LOCKED ? r.status === 401 : true, 'gateway direct read', note);
}

console.log(`\n${failed ? `FAIL: ${failed} check(s)` : 'PASS'}`);
process.exit(failed ? 1 : 0);
