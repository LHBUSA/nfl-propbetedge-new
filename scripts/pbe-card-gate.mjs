/* PropBetEdge NFL — PBE Card v3 render + leak gate.
 *
 * Real headless Chrome, two personas (NFL Pro, free), four surfaces
 * (PBE Picks, Dashboard, Matchup, PBEcast), two widths (1440, 390).
 *
 *   --fixture (default)  static files from THIS checkout; /api/pbe-picks is the
 *                        real handler run in-process against the fixture slate
 *                        (tests/fixtures/pbe-card-v3.fixture.mjs); the Pro
 *                        persona gets a session minted like the auth Worker's.
 *                        Everything else is live production.
 *   --canary             REAL data: production APIs end to end. The Pro
 *                        persona needs a real NFL Pro session cookie in
 *                        PBE_PRO_COOKIE (value of pbe_nfl_session_v2); it is
 *                        only ever sent to the target origin and never printed.
 *                        Static files still come from this checkout unless
 *                        --live is also given.
 *
 * What it proves per persona:
 *   Pro   the first thing on PBE Picks is TODAY'S PBE CARD; every card in the
 *         server response renders; the first card's selection, price, edge,
 *         probabilities, stake and receipt in the DOM equal the response; the
 *         label matches each row's publication_scope; Dashboard, Matchup and
 *         PBEcast render the same decision.
 *   Free  only locked previews render; neither the DOM, the page HTML nor any
 *         response the page received contains a Pro selection value.
 *
 *   node scripts/pbe-card-gate.mjs [--canary] [--live] [--out dir] [--widths 1440,390]
 * Exit 1 on any failed assertion.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.cwd();
const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const arg = (n, f) => { const i = argv.indexOf(`--${n}`); return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : f; };
const CANARY = flag('canary');
/* --free-only: the free + anonymous half of the canary, which needs no session. */
const FREE_ONLY = flag('free-only');
const LIVE = flag('live');
const TARGET = process.env.PBE_TARGET || 'https://nfl.propbetedge.ai';
const ORIGIN = new URL(TARGET).origin;
const OUT = resolve(arg('out', join(REPO, '.pbe-card-gate')));
const WIDTHS = arg('widths', '1440,390').split(',').map(n => parseInt(n, 10));
const HEIGHTS = { 390: 844, 1440: 900 };
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9800 + Math.floor(Math.random() * 90);
const SETTLE = Number(arg('settle', '6500'));
/* The Pro session comes from the environment or from a file the operator
   saved (PBE_PRO_COOKIE_FILE), so it never has to be typed into a chat. */
const cookieFile = process.env.PBE_PRO_COOKIE_FILE ? (() => { try { return readFileSync(process.env.PBE_PRO_COOKIE_FILE, 'utf8'); } catch { return ''; } })() : '';
const PRO_COOKIE = String(process.env.PBE_PRO_COOKIE || cookieFile || '').trim().replace(/^pbe_nfl_session_v2=/, '');
if (CANARY && !PRO_COOKIE && !FREE_ONLY) { console.error('canary needs PBE_PRO_COOKIE (the pbe_nfl_session_v2 value of a real NFL Pro session)'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

/* ---- fixture API (in-process real handler) ------------------------------ */
let fixture = null, handler = null, auth = null;
if (!CANARY) {
  fixture = await import(pathToFileURL(join(REPO, 'tests/fixtures/pbe-card-v3.fixture.mjs')).href);
  Object.assign(process.env, fixture.ENV);
  fixture.installMockFetch();
  handler = (await import(pathToFileURL(join(REPO, 'api/pbe-picks.js')).href)).default;
  auth = await import(pathToFileURL(join(REPO, 'api/_nfl-auth.js')).href);
}
async function fixtureApi(url, persona) {
  const u = new URL(url);
  if (u.origin !== ORIGIN) return null;
  if (u.pathname === '/api/auth-session') {
    const body = persona === 'pro'
      ? { valid: true, pro: true, user: { email: 'pro@propbetedge.test' }, subscription: { status: 'active' }, stage: 'entitlement_active' }
      : { valid: false, pro: false, user: null, subscription: null, stage: 'no_cookie' };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  }
  if (u.pathname !== '/api/pbe-picks') return null;
  const cookie = persona === 'pro' ? fixture.sessionCookie('pro@propbetedge.test', { namespace: auth.HMAC_NAMESPACE, cookieName: auth.SESSION_COOKIE, now: fixture.NOW }) : '';
  const realNow = Date.now; Date.now = () => fixture.NOW;
  const headers = {}; let status = 200; let body = '';
  const res = { set statusCode(v) { status = v; }, get statusCode() { return status; }, setHeader(k, v) { headers[String(k).toLowerCase()] = String(v); }, end(b) { body = b == null ? '' : String(b); } };
  try { await handler({ method: 'GET', query: Object.fromEntries(u.searchParams), headers: cookie ? { cookie } : {} }, res); } finally { Date.now = realNow; }
  return { status, headers, body };
}

/* ---- chrome --------------------------------------------------------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-cardgate-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, '--headless=new', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
function finish(code) { try { chrome.kill(); } catch {} setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(code); }, 300); }
setTimeout(() => { console.error('HARD_DEADLINE'); finish(3); }, 900000).unref?.();
async function wsUrl() { for (let i = 0; i < 100; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find(x => x.type === 'page' && x.webSocketDebuggerUrl); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(200); } throw new Error('devtools_unavailable'); }
const ws = new WebSocket(await wsUrl());
await new Promise(r => { ws.onopen = r; });
let seq = 1; const pending = new Map();
const send = (method, params = {}) => { const n = seq++; ws.send(JSON.stringify({ id: n, method, params })); return new Promise((res, rej) => pending.set(n, { res, rej })); };

const MIME = { '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml' };
function localFile(url) {
  if (LIVE) return null; let u; try { u = new URL(url); } catch { return null; }
  if (u.origin !== ORIGIN || u.pathname.startsWith('/api/')) return null;
  const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
  if (!rel || rel.includes('..') || !MIME[extname(rel)]) return null;
  const fp = join(REPO, rel);
  try { if (!existsSync(fp) || !statSync(fp).isFile()) return null; return { body: readFileSync(fp), type: MIME[extname(rel)] }; } catch { return null; }
}

let persona = 'free';
const seen = { errors: [], cardBodies: [] };
ws.onmessage = async ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
  if (m.method === 'Fetch.requestPaused') {
    const { requestId, request } = m.params;
    try {
      const api = !CANARY ? await fixtureApi(request.url, persona) : null;
      if (api) {
        if (request.url.includes('/api/pbe-picks')) seen.cardBodies.push({ url: request.url, status: api.status, body: api.body });
        await send('Fetch.fulfillRequest', { requestId, responseCode: api.status, responseHeaders: Object.entries(api.headers).map(([name, value]) => ({ name, value })), body: Buffer.from(api.body).toString('base64') });
        return;
      }
      const local = localFile(request.url);
      if (local) { await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: local.type }, { name: 'cache-control', value: 'no-store' }], body: local.body.toString('base64') }); return; }
    } catch (e) { seen.errors.push(`[gate] ${request.url} ${e.message}`); }
    send('Fetch.continueRequest', { requestId }).catch(() => {});
    return;
  }
  /* Canary: capture every /api/pbe-picks body the page actually received. */
  if (m.method === 'Network.responseReceived' && CANARY && m.params.response.url.includes('/api/pbe-picks')) {
    const { requestId } = m.params; const url = m.params.response.url; const status = m.params.response.status;
    setTimeout(() => send('Network.getResponseBody', { requestId }).then(r => seen.cardBodies.push({ url, status, body: r.base64Encoded ? Buffer.from(r.body, 'base64').toString() : r.body })).catch(() => {}), 400);
  }
  if (m.method === 'Runtime.exceptionThrown') seen.errors.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 240));
};
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Fetch.enable', { patterns: [{ urlPattern: `${ORIGIN}/*`, requestStage: 'Request' }] });
const evaluate = async (expr, ms = 20000) => { try { const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }), sleep(ms).then(() => { throw new Error('WEDGED'); })]); return r.result?.value; } catch (e) { return { __error: e.message }; } };

async function setPersona(p) {
  persona = p;
  await send('Network.clearBrowserCookies');
  if (p === 'pro' && CANARY) {
    await send('Network.setCookie', { name: 'pbe_nfl_session_v2', value: PRO_COOKIE, url: ORIGIN, secure: true, httpOnly: true, sameSite: 'Lax' });
  }
}
async function open(path, width) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHTS[width] || 900, deviceScaleFactor: 1, mobile: width <= 768 });
  await send('Page.navigate', { url: 'about:blank' }); await sleep(150);
  await send('Page.navigate', { url: `${TARGET}${path}` });
  await sleep(SETTLE);
  /* A cold first load can still be painting; wait for the card store to land
     and the route to settle rather than trusting a fixed delay. */
  for (let i = 0; i < 30; i++) {
    const ready = await evaluate(`Boolean(window.PBECard?.store?.data || window.PBECard?.store?.error) && !window.PBECard?.store?.busy && getComputedStyle(document.getElementById('view-container') || document.body).opacity === '1'`);
    if (ready === true) break;
    await sleep(500);
  }
  await sleep(800);
}
async function shot(name, width) {
  const h = await evaluate('Math.min(document.documentElement.scrollHeight, 5200)');
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Number(h) || 900, scale: 1 } });
  const file = join(OUT, `${name}-${width}.png`); writeFileSync(file, Buffer.from(r.data, 'base64')); return file;
}

/* ---- assertions (run in the page) ----------------------------------------- */
const COMMON = `(() => { const de = document.documentElement; return { overflowX: de.scrollWidth - de.clientWidth, mode: window.PBECard?.store?.mode || null, status: window.PBECard?.store?.status || null }; })()`;
const PRO_PICKS = `(() => {
  const r = []; const d = window.PBECard?.store?.data; const picks = d?.picks || [];
  const hero = document.querySelector('.pbec-hero'); const deep = document.querySelector('.pbe2-deep-head');
  r.push({ name: "TODAY'S PBE CARD is the first section", ok: !!hero && (!deep || hero.getBoundingClientRect().top < deep.getBoundingClientRect().top) && /Today.s\\s*PBE Card/i.test(hero.innerText) });
  r.push({ name: 'server returned the Pro contract', ok: d?.entitlement === 'pro' && d?.contract === 'pbe-card-v3', detail: d?.entitlement });
  const cards = [...document.querySelectorAll('.pbec-grid:not(.is-module) .pbec-card:not(.is-locked)')];
  r.push({ name: 'every server decision renders as a card', ok: picks.length > 0 && cards.length === picks.length, detail: cards.length + '/' + picks.length });
  const am = v => (v > 0 ? '+' : '') + Math.round(v);
  const byId = new Map(picks.map(p => [p.id, p]));
  let exact = 0, labelOk = 0; const misses = [];
  for (const el of cards) {
    const p = byId.get(el.dataset.pbecCard); if (!p) { misses.push('unknown card'); continue; }
    const main = el.querySelector('.pbec-sel-main')?.innerText.replace(/\\s+/g, ' ').trim() || '';
    const want = (p.market === 'moneyline' ? p.selection.team : p.market === 'total' ? p.selection.over_under + ' ' + p.issue.line : p.selection.display) + ' ' + am(p.issue.price);
    const terms = el.querySelector('.pbec-terms')?.innerText || '';
    const edge = ((p.edge_pct * 100) > 0 ? '+' : '') + (p.edge_pct * 100).toFixed(1);
    const ok = main.replace(/\\s+/g, '') === want.replace(/\\s+/g, '') && terms.includes(edge) && terms.includes((p.model.prob * 100).toFixed(1) + '%') && terms.includes((p.market_prob * 100).toFixed(1) + '%') && terms.includes(Number(p.stake_units).toFixed(2) + 'u') && terms.includes(String(p.receipt.chain_hash).slice(0, 10));
    if (ok) exact++; else misses.push(want + ' vs ' + main);
    const label = el.querySelector('.pbec-scope')?.innerText.trim();
    if (label === (p.publication_scope === 'official' ? 'OFFICIAL PBE PICK' : 'PBE VALIDATION SIGNAL')) labelOk++;
  }
  r.push({ name: 'DOM selection/price/edge/probabilities/stake/receipt equal the response', ok: cards.length > 0 && exact === cards.length, detail: exact + '/' + cards.length + (misses.length ? ' ' + misses.slice(0, 2).join(' | ') : '') });
  r.push({ name: 'label matches each row publication_scope', ok: labelOk === cards.length, detail: labelOk + '/' + cards.length });
  const anyOfficial = picks.some(p => p.publication_scope === 'official');
  r.push({ name: 'no validation row is called official', ok: anyOfficial || !/OFFICIAL PBE PICK/.test(document.querySelector('.pbec')?.innerText || '') });
  const s = d?.summary?.strongest?.id; r.push({ name: 'strongest persisted edge is featured first', ok: !s || cards[0]?.dataset.pbecCard === s });
  r.push({ name: 'no superseded row on the card', ok: (d?.eligibility?.excluded?.superseded ?? 0) >= 0 && picks.every(p => p.status !== 'superseded') });
  r.push({ name: 'receipts verified server-side', ok: picks.every(p => p.receipt?.verified?.payload_hash && p.receipt?.verified?.issued_terms), detail: (d?.eligibility?.receipts?.verified ?? '?') + '/' + (d?.eligibility?.receipts?.checked ?? '?') });
  return { checks: r, first: picks[0] ? { id: picks[0].id, game: picks[0].game_id, market: picks[0].market, selection: picks[0].selection?.display, line: picks[0].issue?.line, price: picks[0].issue?.price, issued_at: picks[0].issue?.at, model_prob: picks[0].model?.prob, market_prob: picks[0].market_prob, edge: picks[0].edge_pct, confidence: picks[0].confidence_bucket, stake_units: picks[0].stake_units, model_version: picks[0].model?.version, scope: picks[0].publication_scope, lifecycle: picks[0].lifecycle, chain: picks[0].receipt?.chain_hash, receipt_verified: picks[0].receipt?.verified } : null, activeGame: picks.find(p => p.lifecycle === 'ACTIVE')?.game_id || null };
})()`;
const PRO_HOME = `(() => { const r = []; const dash = document.querySelector('.pbec-dash'); r.push({ name: "Dashboard shows Today's PBE Card", ok: !!dash && !dash.classList.contains('is-locked') && dash.querySelectorAll('.pbec-mini').length > 0, detail: (dash?.querySelectorAll('.pbec-mini').length || 0) + ' cards' });
  const badges = document.querySelectorAll('.pbecc-game .pbec-badge:not(.is-locked)'); r.push({ name: 'game cards carry the PBE selection badge', ok: badges.length > 0, detail: badges.length + ' badges' }); return { checks: r }; })()`;
const PRO_MODULE = sel => `(() => { const r = []; const cards = document.querySelectorAll('${sel} .pbec-card:not(.is-locked)'); r.push({ name: 'decision module renders the full Pro card', ok: cards.length > 0, detail: cards.length + ' cards' }); return { checks: r }; })()`;
const FREE = `(() => { const r = []; const d = window.PBECard?.store?.data;
  r.push({ name: 'free persona receives the public preview contract', ok: d?.entitlement === 'public' && Array.isArray(d?.previews) });
  r.push({ name: 'no Pro card in the DOM', ok: !document.querySelector('.pbec-card:not(.is-locked)') && !document.querySelector('.pbec-mini') });
  return { checks: r, html: document.documentElement.outerHTML }; })()`;

/* nflverse code -> team nickname (last word of the provider's full name). */
const NICK = { ARI: 'cardinals', ATL: 'falcons', BAL: 'ravens', BUF: 'bills', CAR: 'panthers', CHI: 'bears', CIN: 'bengals', CLE: 'browns',
  DAL: 'cowboys', DEN: 'broncos', DET: 'lions', GB: 'packers', HOU: 'texans', IND: 'colts', JAX: 'jaguars', KC: 'chiefs', LA: 'rams',
  LAC: 'chargers', LV: 'raiders', MIA: 'dolphins', MIN: 'vikings', NE: 'patriots', NO: 'saints', NYG: 'giants', NYJ: 'jets', PHI: 'eagles',
  PIT: 'steelers', SEA: 'seahawks', SF: '49ers', TB: 'buccaneers', TEN: 'titans', WAS: 'commanders' };

/* ---- run ------------------------------------------------------------------ */
const report = { mode: CANARY ? 'canary' : 'fixture', target: TARGET, static: LIVE ? 'deployed' : 'checkout', at: new Date().toISOString(), runs: [] };
let failed = 0;
function record(name, width, result, file, extra = {}) {
  const checks = [...(result?.checks || []), ...(extra.checks || [])];
  const bad = checks.filter(c => !c.ok);
  failed += bad.length;
  report.runs.push({ name, width, checks, shot: file, ...extra.meta });
  console.log(`${bad.length ? 'FAIL' : 'PASS'} ${name}@${width}${bad.length ? `\n   ${bad.map(b => `✗ ${b.name}${b.detail ? ` — ${b.detail}` : ''}`).join('\n   ')}` : ''}`);
}
const commonChecks = c => [{ name: 'no horizontal overflow', ok: (c?.overflowX ?? 1) <= 0, detail: `overflowX=${c?.overflowX}` }];

/* PRO */
let proFirst = null; const proSecrets = new Set();
const { assertNoSelection } = await import(pathToFileURL(join(REPO, 'workers/nfl-picks-engine-shared/publication.mjs')).href);
const keyLeak = body => { try { const j = JSON.parse(body); if (j?.entitlement === 'pro') return 'pro-contract'; assertNoSelection(j); return null; } catch (e) { return String(e.message).startsWith('selection_leak') ? e.message : null; } };
await setPersona('pro');
for (const width of (FREE_ONLY ? [] : WIDTHS)) {
  seen.errors.length = 0;
  await open('/#pbepicks', width);
  const res = await evaluate(PRO_PICKS); const c = await evaluate(COMMON);
  proFirst = proFirst || res?.first;
  const activeGame = res?.activeGame || null;
  const data = await evaluate('JSON.stringify(window.PBECard?.store?.data?.picks || [])');
  for (const p of JSON.parse(typeof data === 'string' ? data : '[]')) {
    if (p.receipt?.chain_hash) proSecrets.add(p.receipt.chain_hash);
    if (p.id) proSecrets.add(p.id);
    if (p.selection?.display) proSecrets.add(`"${p.selection.display}"`);
    if (p.selection?.display) proSecrets.add(`>${p.selection.display}<`);
  }
  record('pro/pbepicks', width, res, await shot('pro-pbepicks', width), { checks: [...commonChecks(c), { name: 'no page exceptions', ok: seen.errors.length === 0, detail: seen.errors.slice(0, 2).join(' | ') }] });

  await open('/', width);
  record('pro/dashboard', width, await evaluate(PRO_HOME), await shot('pro-dashboard', width), { checks: commonChecks(await evaluate(COMMON)) });

  /* A matchup page exists for games still on the odds board: use an ACTIVE decision. */
  const g = activeGame || proFirst?.game || '2026_01_BUF_HOU';
  const teams = /^\d{4}_\d{2}_([A-Z]+)_([A-Z]+)$/.exec(g) || [];
  const nick = NICK[teams[1]] && NICK[teams[2]] ? [NICK[teams[1]], NICK[teams[2]]] : null;
  const eventId = nick ? await evaluate(`fetch('https://nfl-api.propbetedge.ai/api/best-line?days=8').then(r=>r.json()).then(d=>{const last=s=>String(s||'').trim().split(/\\s+/).pop().toLowerCase();const ev=(d.events||[]).find(e=>last(e.away)==='${nick[0]}'&&last(e.home)==='${nick[1]}');return ev?ev.id:''}).catch(()=>'')`) : '';
  await open(`/?event=${encodeURIComponent(eventId || '')}#matchups`, width);
  record('pro/matchup', width, await evaluate(PRO_MODULE('[data-pbec-slot]')), await shot('pro-matchup', width), { checks: commonChecks(await evaluate(COMMON)), meta: { event: eventId, game: g } });

  const espn = await evaluate(`(window.PBECard?.cards?.()||[]).find(c=>c.game_id==='${g}')?.game?.espn_id || (window.PBECard?.cards?.()||[]).find(c=>c.game?.espn_id)?.game?.espn_id || ''`);
  await evaluate(`sessionStorage.setItem('pbe.pbecast.focus', JSON.stringify({ game_id: '${espn || ''}' }))`);
  await open('/#pbecast', width);
  record('pro/pbecast', width, await evaluate(PRO_MODULE('[data-pbecc-cast="pick"]')), await shot('pro-pbecast', width), { checks: commonChecks(await evaluate(COMMON)), meta: { espn_id: espn } });
}

/* FREE */
await setPersona('free');
for (const width of WIDTHS) {
  seen.cardBodies.length = 0;
  await open('/#pbepicks', width);
  const res = await evaluate(FREE); const c = await evaluate(COMMON);
  const html = String(res?.html || '');
  const leakedDom = [...proSecrets].filter(s => html.includes(s));
  const leakedNet = seen.cardBodies.filter(b => [...proSecrets].some(s => b.body.includes(s.replace(/^[">]|["<]$/g, '')))).map(b => b.url);
  const locked = await evaluate(`document.querySelectorAll('.pbec-card.is-locked').length`);
  const previews = await evaluate(`(window.PBECard?.store?.data?.previews||[]).length`);
  record('free/pbepicks', width, res, await shot('free-pbepicks', width), { checks: [
    ...commonChecks(c),
    { name: 'locked previews render for every current decision', ok: Number(locked) > 0 && Number(locked) === Number(previews), detail: `${locked}/${previews}` },
    { name: 'unlock CTA present', ok: Boolean(await evaluate(`!!document.querySelector('.pbec-unlock [data-pbec-upgrade]')`)) },
    { name: 'every /api/pbe-picks response the free page received is public and key-clean', ok: seen.cardBodies.length > 0 && seen.cardBodies.every(b => !keyLeak(b.body)), detail: seen.cardBodies.map(b => keyLeak(b.body)).filter(Boolean).join(',') || `${seen.cardBodies.length} responses` },
    { name: 'no Pro selection value in the DOM / page HTML', ok: (FREE_ONLY || proSecrets.size > 0) && leakedDom.length === 0, detail: `${proSecrets.size} secrets checked${leakedDom.length ? ` · leaked ${leakedDom.slice(0, 2).join(',')}` : ''}` },
    { name: 'no Pro selection value in any response the page received', ok: leakedNet.length === 0, detail: seen.cardBodies.map(b => `${new URL(b.url).search}=${b.status}`).join(' ') },
  ] });
  await open('/', width);
  record('free/dashboard', width, { checks: [{ name: 'dashboard shows the locked card teaser', ok: Boolean(await evaluate(`!!document.querySelector('.pbec-dash.is-locked [data-pbec-upgrade]')`)) }] }, await shot('free-dashboard', width), { checks: commonChecks(await evaluate(COMMON)) });
}

/* Direct anonymous API probe (no cookie at all). */
const anon = await evaluate(`(async () => { const a = await fetch('/api/pbe-picks?view=current', { credentials: 'omit' }); const b = await fetch('/api/pbe-picks?view=validation-history', { credentials: 'omit' }); const p = await fetch('/api/pbe-picks?view=preview', { credentials: 'omit' }).then(r => r.text()); return { current: a.status, history: b.status, currentBody: await a.text(), preview: p }; })()`);
const anonLeaks = [...proSecrets].filter(s => String(anon?.preview || '').includes(s.replace(/^[">]|["<]$/g, '')) || String(anon?.currentBody || '').includes(s.replace(/^[">]|["<]$/g, '')));
record('anonymous/api', 0, { checks: [
  { name: 'view=current refuses an anonymous caller', ok: anon?.current === 401, detail: String(anon?.current) },
  { name: 'view=validation-history refuses an anonymous caller', ok: anon?.history === 401, detail: String(anon?.history) },
  { name: 'public preview carries no Pro selection value', ok: anonLeaks.length === 0 && (FREE_ONLY || proSecrets.size > 0) && !keyLeak(String(anon?.preview || '')), detail: `${proSecrets.size} secrets checked · key scan ${keyLeak(String(anon?.preview || '')) || 'clean'}` },
] }, null);

/* Canary evidence: the first real card in full, so the operator can check it
   against the database row (select * from nfl_game_picks where id = …). */
report.pro_first_card = proFirst ? (CANARY ? proFirst : { ...proFirst, chain: proFirst.chain ? `${proFirst.chain.slice(0, 16)}…` : null, id: proFirst.id ? `${String(proFirst.id).slice(0, 8)}…` : null }) : null;
if (CANARY && proFirst) console.log(`CANARY first card: ${JSON.stringify(proFirst)}`);
report.failed = failed;
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\n${failed ? 'GATE FAILED' : 'GATE PASSED'} · ${report.runs.length} runs · ${failed} failed checks · ${OUT}`);
finish(failed ? 1 : 0);
