/* PropBetEdge NFL — PBE Card v3 render + leak + canary gate.
 *
 * Real headless Chrome. Personas: NFL Pro, anonymous, forged cookie, signed-in
 * free account. Surfaces: PBE Picks, Dashboard, Matchup, PBEcast. Widths 1440
 * and 390.
 *
 *   --fixture (default)  static files from THIS checkout; /api/pbe-picks is the
 *                        real handler run in-process against the fixture slate
 *                        (tests/fixtures/pbe-card-v3.fixture.mjs); sessions
 *                        are minted exactly like the auth Worker's.
 *   --canary             REAL data, production APIs end to end. Sessions come
 *                        from files the operator saved; they are only ever sent
 *                        to the target origin and never printed:
 *                          PBE_PRO_COOKIE_FILE   pbe_nfl_session_v2 of an NFL Pro account
 *                          PBE_FREE_COOKIE_FILE  pbe_nfl_session_v2 of a signed-in free account
 *                        (PBE_PRO_COOKIE / PBE_FREE_COOKIE env values also work.)
 *   --live               use the deployed static files instead of this checkout
 *   --free-only          skip the Pro persona (public half of the canary)
 *
 * The canary proves one real decision end to end:
 *   persisted nfl_game_picks row (view=decision, Pro)  ->  card response
 *   (view=current, Pro)  ->  rendered NFL Pro card (DOM)
 * field by field, and that the same record is unavailable to every non-Pro
 * persona in the DOM, in the page HTML and in every API response.
 *
 *   node scripts/pbe-card-gate.mjs [--canary] [--live] [--free-only] [--out dir] [--widths 1440,390]
 * Exit 1 on a failed check, 4 when a required persona could not be run.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const REPO = process.cwd();
const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const arg = (n, f) => { const i = argv.indexOf(`--${n}`); return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : f; };
const CANARY = flag('canary');
const LIVE = flag('live');
const FREE_ONLY = flag('free-only');
const TARGET = process.env.PBE_TARGET || 'https://nfl.propbetedge.ai';
const ORIGIN = new URL(TARGET).origin;
const OUT = resolve(arg('out', join(REPO, '.pbe-card-gate')));
const WIDTHS = arg('widths', '1440,390').split(',').map(n => parseInt(n, 10));
const HEIGHTS = { 390: 844, 1440: 900 };
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9800 + Math.floor(Math.random() * 90);
const SETTLE = Number(arg('settle', '6500'));
const COOKIE_NAME = 'pbe_nfl_session_v2';

function cookieFrom(envValue, envFile) {
  let v = String(process.env[envValue] || '').trim();
  if (!v && process.env[envFile]) { try { v = readFileSync(process.env[envFile], 'utf8').trim(); } catch { v = ''; } }
  return v.replace(new RegExp(`^${COOKIE_NAME}=`), '').replace(/;.*$/, '').trim();
}
const PRO_COOKIE = cookieFrom('PBE_PRO_COOKIE', 'PBE_PRO_COOKIE_FILE');
const FREE_COOKIE = cookieFrom('PBE_FREE_COOKIE', 'PBE_FREE_COOKIE_FILE');
if (CANARY && !FREE_ONLY && !PRO_COOKIE) { console.error('canary needs PBE_PRO_COOKIE_FILE (a file holding the pbe_nfl_session_v2 value of a real NFL Pro session)'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

/* A well-formed session token with a signature nobody signed. */
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const FORGED = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ email: 'forged-pro@propbetedge.test', type: 'session', iat: 1, exp: 4102444800, jti: 'forged' }))}.${b64u(randomBytes(32))}`;

/* ---- fixture API (in-process real handler) ------------------------------ */
let fixture = null, handler = null, auth = null;
if (!CANARY) {
  fixture = await import(pathToFileURL(join(REPO, 'tests/fixtures/pbe-card-v3.fixture.mjs')).href);
  Object.assign(process.env, fixture.ENV);
  fixture.installMockFetch();
  handler = (await import(pathToFileURL(join(REPO, 'api/pbe-picks.js')).href)).default;
  auth = await import(pathToFileURL(join(REPO, 'api/_nfl-auth.js')).href);
}
function fixtureCookie(persona) {
  const mint = email => fixture.sessionCookie(email, { namespace: auth.HMAC_NAMESPACE, cookieName: auth.SESSION_COOKIE, now: fixture.NOW });
  if (persona === 'pro') return mint('pro@propbetedge.test');
  if (persona === 'free') return mint('free@propbetedge.test');
  if (persona === 'forged') return `${COOKIE_NAME}=${FORGED}`;
  return '';
}
async function fixtureApi(url, persona) {
  const u = new URL(url);
  if (u.origin !== ORIGIN) return null;
  if (u.pathname === '/api/auth-session') {
    const body = persona === 'pro'
      ? { valid: true, pro: true, user: { email: 'pro@propbetedge.test' }, subscription: { status: 'active' }, stage: 'entitlement_active' }
      : persona === 'free'
        ? { valid: true, pro: false, user: { email: 'free@propbetedge.test' }, subscription: null, stage: 'entitlement_missing' }
        : { valid: false, pro: false, user: null, subscription: null, stage: persona === 'forged' ? 'cookie_present_invalid' : 'no_cookie' };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  }
  if (u.pathname !== '/api/pbe-picks') return null;
  const cookie = fixtureCookie(persona);
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
setTimeout(() => { console.error('HARD_DEADLINE'); finish(3); }, 1200000).unref?.();
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

let persona = 'anonymous';
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
const evaluate = async (expr, ms = 25000) => { try { const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }), sleep(ms).then(() => { throw new Error('WEDGED'); })]); return r.result?.value; } catch (e) { return { __error: e.message }; } };

async function setPersona(p) {
  persona = p;
  await send('Network.clearBrowserCookies');
  if (!CANARY) return;
  const value = p === 'pro' ? PRO_COOKIE : p === 'free' ? FREE_COOKIE : p === 'forged' ? FORGED : '';
  if (value) await send('Network.setCookie', { name: COOKIE_NAME, value, url: ORIGIN, secure: true, httpOnly: true, sameSite: 'Lax' });
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
  const h = await evaluate('Math.min(document.documentElement.scrollHeight, 6000)');
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Number(h) || 900, scale: 1 } });
  const file = join(OUT, `${name}-${width}.png`); writeFileSync(file, Buffer.from(r.data, 'base64')); return file;
}

/* ---- page-side checks ----------------------------------------------------- */
const COMMON = `(() => { const de = document.documentElement; return { overflowX: de.scrollWidth - de.clientWidth }; })()`;
const PRO_PICKS = `(() => {
  const r = []; const d = window.PBECard?.store?.data; const picks = d?.picks || [];
  const hero = document.querySelector('.pbec-hero'); const deep = document.querySelector('.pbe2-deep-head');
  r.push({ name: "TODAY'S PBE CARD is the first section", ok: !!hero && (!deep || hero.getBoundingClientRect().top < deep.getBoundingClientRect().top) && hero.innerText.includes('PBE Card') });
  r.push({ name: 'server returned the Pro contract', ok: d?.entitlement === 'pro' && d?.contract === 'pbe-card-v3', detail: d?.entitlement });
  const cards = [...document.querySelectorAll('.pbec-grid:not(.is-module) .pbec-card:not(.is-locked)')];
  r.push({ name: 'every server decision renders as a card', ok: picks.length > 0 && cards.length === picks.length, detail: cards.length + '/' + picks.length });
  const am = v => (v > 0 ? '+' : '') + Math.round(v);
  const squash = t => String(t || '').split(' ').join('').split('\\n').join('');
  const byId = new Map(picks.map(p => [p.id, p]));
  let exact = 0, labelOk = 0, replOk = 0, replNeed = 0; const misses = [];
  for (const el of cards) {
    const p = byId.get(el.dataset.pbecCard); if (!p) { misses.push('unknown card'); continue; }
    const main = squash(el.querySelector('.pbec-sel-main')?.innerText);
    const want = squash((p.market === 'moneyline' ? p.selection.team : p.market === 'total' ? p.selection.over_under + ' ' + p.issue.line : p.selection.display) + ' ' + am(p.issue.price));
    const terms = el.querySelector('.pbec-terms')?.innerText || '';
    const edge = ((p.edge_pct * 100) > 0 ? '+' : '') + (p.edge_pct * 100).toFixed(1);
    const ok = main === want && terms.includes(edge) && terms.includes((p.model.prob * 100).toFixed(1) + '%') && terms.includes((p.market_prob * 100).toFixed(1) + '%') && terms.includes(Number(p.stake_units).toFixed(2) + 'u') && terms.includes(String(p.receipt.chain_hash).slice(0, 10));
    if (ok) exact++; else misses.push(want + ' vs ' + main);
    const label = el.querySelector('.pbec-scope')?.innerText.trim();
    if (label === (p.publication_scope === 'official' ? 'OFFICIAL PBE PICK' : 'PBE VALIDATION SIGNAL')) labelOk++;
    if (p.lineage?.replaces) {
      replNeed++;
      const block = el.querySelector('.pbec-replaced');
      const txt = block?.innerText || '';
      const was = p.lineage.replaces;
      if (block && txt.includes('SIGNAL REPLACED') && txt.includes(String(was.receipt?.chain_hash || '').slice(0, 10)) && txt.includes(String(p.receipt?.chain_hash || '').slice(0, 10)) && block.querySelector('.was strong')) replOk++;
    }
  }
  r.push({ name: 'DOM selection/price/edge/probabilities/stake/receipt equal the response', ok: cards.length > 0 && exact === cards.length, detail: exact + '/' + cards.length + (misses.length ? ' ' + misses.slice(0, 2).join(' | ') : '') });
  r.push({ name: 'label matches each row publication_scope', ok: labelOk === cards.length, detail: labelOk + '/' + cards.length });
  r.push({ name: 'every replacement card shows SIGNAL REPLACED with the frozen original and both receipts', ok: replOk === replNeed, detail: replOk + '/' + replNeed + ' replacement cards' });
  const replacedIds = new Set(picks.flatMap(p => (p.lineage?.replaced || []).map(x => x.id)));
  r.push({ name: 'no replaced decision renders as a current card', ok: cards.every(el => !replacedIds.has(el.dataset.pbecCard)), detail: replacedIds.size + ' replaced ids' });
  r.push({ name: 'no validation row is called official', ok: picks.some(p => p.publication_scope === 'official') || !(document.querySelector('.pbec')?.innerText || '').includes('OFFICIAL PBE PICK') });
  r.push({ name: 'lock integrity: no change after a real kickoff', ok: (d?.eligibility?.lock_integrity?.violations ?? 1) === 0, detail: JSON.stringify(d?.eligibility?.lock_integrity?.kinds || {}) });
  r.push({ name: 'receipts verified server-side', ok: picks.every(p => p.receipt?.verified?.payload_hash && p.receipt?.verified?.issued_terms), detail: (d?.eligibility?.receipts?.verified ?? '?') + '/' + (d?.eligibility?.receipts?.checked ?? '?') });
  const active = picks.find(p => p.lifecycle === 'ACTIVE');
  const repl = picks.find(p => p.lifecycle === 'ACTIVE' && p.lineage?.replaces);
  return { checks: r, canary: (active || picks[0] || {}).id || null, replacement: repl ? repl.id : null, activeGame: active?.game_id || null,
    secrets: picks.flatMap(p => [p.id, p.receipt?.chain_hash, p.receipt?.payload_sha256, ...(p.lineage?.replaced || []).flatMap(x => [x.id, x.receipt?.chain_hash])]).filter(Boolean),
    summary: { cards: picks.length, active: d?.summary?.active, locked: d?.summary?.locked, final: d?.summary?.final, replaced_before_lock: d?.summary?.replaced_before_lock, eligibility: d?.eligibility && { considered: d.eligibility.considered, published: d.eligibility.published, excluded: d.eligibility.excluded, receipts: d.eligibility.receipts, lock_integrity: { violations: d.eligibility.lock_integrity?.violations, kinds: d.eligibility.lock_integrity?.kinds }, replacements: d.eligibility.replacements } } };
})()`;

/* persisted row (view=decision) -> card (view=current) -> DOM, field by field */
const ROW_MATCH = id => `(async () => {
  const d = window.PBECard?.store?.data; const card = (d?.picks || []).find(p => p.id === ${JSON.stringify(id)});
  if (!card) return { error: 'card_not_in_response' };
  const res = await fetch('/api/pbe-picks?view=decision&id=' + encodeURIComponent(card.id), { credentials: 'same-origin', cache: 'no-store' });
  const dec = await res.json().catch(() => null);
  if (!res.ok || !dec?.row) return { error: 'decision_view_' + res.status };
  const row = dec.row;
  const el = document.querySelector('[data-pbec-card="' + card.id + '"]');
  const squash = t => String(t || '').split(' ').join('').split('\\n').join('');
  const sel = squash(el?.querySelector('.pbec-sel-main')?.innerText);
  const terms = el?.querySelector('.pbec-terms')?.innerText || '';
  const scope = el?.querySelector('.pbec-scope')?.innerText.trim() || '';
  const receiptText = el?.querySelector('.pbec-receipt')?.textContent || '';
  const DISP = { LA: 'LAR', WAS: 'WSH' };
  const am = v => (v > 0 ? '+' : '') + Math.round(v);
  const ln = v => (v === 0 ? 'PK' : (v > 0 ? '+' : '') + (Number.isInteger(v) ? v : v.toFixed(1)));
  const pct = v => (v * 100).toFixed(1) + '%';
  const ET = { timeZone: 'America/New_York' };
  const stamp = v => { const x = new Date(v); return x.toLocaleDateString('en-US', { ...ET, weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + x.toLocaleTimeString('en-US', { ...ET, hour: 'numeric', minute: '2-digit' }) + ' ET'; };
  const N = v => (v === null || v === undefined ? null : Number(v));
  const selDb = row.market === 'total' ? row.selection_over_under : (DISP[row.selection_team] || row.selection_team);
  const selResp = card.market === 'total' ? card.selection.over_under : card.selection.team;
  const out = [
    ['selection', row.market === 'total' ? row.selection_over_under : row.selection_team, selResp, selDb === selResp && sel.startsWith(squash(selDb)), sel],
    ['line', row.market_line, card.issue.line, N(row.market_line) === N(card.issue.line) && (row.market_line === null || sel.includes(squash(row.market === 'total' ? String(N(row.market_line)) : ln(N(row.market_line))))), row.market_line === null ? 'n/a (moneyline)' : sel],
    ['price', row.market_price, card.issue.price, N(row.market_price) === N(card.issue.price) && sel.endsWith(squash(am(N(row.market_price)))), sel],
    ['issue_timestamp', row.created_at, card.issue.at, Date.parse(row.created_at) === Date.parse(card.issue.at) && terms.includes(stamp(row.created_at)), stamp(row.created_at)],
    ['model_probability', row.model_prob, card.model.prob, N(row.model_prob) === N(card.model.prob) && terms.includes(pct(N(row.model_prob))), pct(N(row.model_prob))],
    ['market_probability', row.market_prob, card.market_prob, N(row.market_prob) === N(card.market_prob) && terms.includes(pct(N(row.market_prob))), pct(N(row.market_prob))],
    ['edge', row.edge_pct, card.edge_pct, N(row.edge_pct) === N(card.edge_pct) && terms.includes(((N(row.edge_pct) * 100) > 0 ? '+' : '') + (N(row.edge_pct) * 100).toFixed(1)), (N(row.edge_pct) * 100).toFixed(1) + 'pp'],
    ['stake_units', row.stake_units, card.stake_units, N(row.stake_units) === N(card.stake_units) && terms.includes(N(row.stake_units).toFixed(2) + 'u'), N(row.stake_units).toFixed(2) + 'u'],
    ['model_version', row.model_version, card.model.version, N(row.model_version) === N(card.model.version) && terms.includes('model v' + row.model_version), 'model v' + row.model_version],
    ['confidence', row.confidence_bucket, card.confidence_bucket, row.confidence_bucket === card.confidence_bucket && terms.includes(row.confidence_bucket), row.confidence_bucket],
    ['publication_scope', row.publication_scope, card.publication_scope, row.publication_scope === card.publication_scope && scope === (row.publication_scope === 'official' ? 'OFFICIAL PBE PICK' : 'PBE VALIDATION SIGNAL'), scope],
    ['receipt', dec.receipt?.chain_hash, card.receipt?.chain_hash, !!dec.receipt?.chain_hash && dec.receipt.chain_hash === card.receipt?.chain_hash && receiptText.includes(dec.receipt.chain_hash) && dec.receipt.pick_id === row.id && dec.verification?.ok === true, 'chain hash in DOM; payload digest ' + (dec.verification?.payload_hash ? 'recomputed' : 'NOT recomputed') + '; chain link ' + dec.verification?.chain_link],
  ].map(([field, persisted, response, match, dom]) => ({ field, persisted, response, dom, match: Boolean(match) }));
  return { id: card.id, game_id: row.game_id, market: row.market, status: row.status, lifecycle: card.lifecycle, fields: out };
})()`;

/* The replaced decision behind a replacement card, against its own row. */
const REPLACEMENT_MATCH = id => `(async () => {
  const d = window.PBECard?.store?.data; const card = (d?.picks || []).find(p => p.id === ${JSON.stringify(id)});
  const was = card?.lineage?.replaces; if (!was) return { error: 'no_replacement' };
  const res = await fetch('/api/pbe-picks?view=decision&id=' + encodeURIComponent(was.id), { credentials: 'same-origin', cache: 'no-store' });
  const dec = await res.json().catch(() => null); const row = dec?.row || {};
  const N = v => (v === null || v === undefined ? null : Number(v));
  const block = document.querySelector('[data-pbec-card="' + card.id + '"] .pbec-replaced');
  const checks = [
    ['row is frozen as superseded, pointing at the replacement', row.status === 'superseded' && row.superseded_by === card.id],
    ['original selection preserved', (row.selection_team || row.selection_over_under) === (was.selection.team && ({ LAR: 'LA', WSH: 'WAS' }[was.selection.team] || was.selection.team) || was.selection.over_under)],
    ['original issue line/price preserved', N(row.market_line) === N(was.issue.line) && N(row.market_price) === N(was.issue.price)],
    ['original issue timestamp preserved', Date.parse(row.created_at) === Date.parse(was.issue.at)],
    ['original model version preserved', N(row.model_version) === N(was.model.version)],
    ['original receipt verified and shown', dec?.verification?.ok === true && dec?.receipt?.chain_hash === was.receipt?.chain_hash && (block?.innerText || '').includes(String(was.receipt?.chain_hash).slice(0, 10))],
    ['replacement time = replacement issuance', Date.parse(was.replaced_at) === Date.parse(card.issue.at)],
    ['not graded, before lock', was.graded === false && was.before_lock === true],
    ['SIGNAL REPLACED rendered', (block?.innerText || '').includes('SIGNAL REPLACED')],
  ].map(([name, ok]) => ({ name, ok: Boolean(ok) }));
  return { replacement_id: card.id, replaced_id: was.id, was: was.selection.display + ' ' + was.issue.price, now: card.selection.display + ' ' + card.issue.price, reason: was.reason?.rule || null, checks };
})()`;

const PRO_HOME = `(() => { const r = []; const dash = document.querySelector('.pbec-dash'); r.push({ name: "Dashboard shows Today's PBE Card", ok: !!dash && !dash.classList.contains('is-locked') && dash.querySelectorAll('.pbec-mini').length > 0, detail: (dash?.querySelectorAll('.pbec-mini').length || 0) + ' cards' });
  const badges = document.querySelectorAll('.pbecc-game .pbec-badge:not(.is-locked)'); r.push({ name: 'game cards carry the PBE selection badge', ok: badges.length > 0, detail: badges.length + ' badges' }); return { checks: r }; })()`;
const PRO_MODULE = sel => `(() => { const r = []; const cards = document.querySelectorAll('${sel} .pbec-card:not(.is-locked)'); r.push({ name: 'decision module renders the full Pro card', ok: cards.length > 0, detail: cards.length + ' cards' }); return { checks: r }; })()`;
const NONPRO_PAGE = `(() => { const d = window.PBECard?.store?.data; return {
  entitlement: d?.entitlement || null, previews: (d?.previews || []).length, locked: document.querySelectorAll('.pbec-card.is-locked').length,
  proCard: !!document.querySelector('.pbec-card:not(.is-locked)') || !!document.querySelector('.pbec-mini'),
  cta: !!document.querySelector('.pbec-unlock [data-pbec-upgrade]'), html: document.documentElement.outerHTML }; })()`;
const PROBE = id => `(async () => { const get = async q => { const r = await fetch('/api/pbe-picks?' + q, { credentials: 'same-origin', cache: 'no-store' }); return { status: r.status, body: await r.text() }; };
  return { current: await get('view=current'), decision: await get('view=decision&id=' + encodeURIComponent(${JSON.stringify(id || '00000000-0000-4000-8000-000000000000')})), history: await get('view=validation-history'), preview: await get('view=preview') }; })()`;

/* nflverse code -> team nickname (last word of the provider's full name). */
const NICK = { ARI: 'cardinals', ATL: 'falcons', BAL: 'ravens', BUF: 'bills', CAR: 'panthers', CHI: 'bears', CIN: 'bengals', CLE: 'browns',
  DAL: 'cowboys', DEN: 'broncos', DET: 'lions', GB: 'packers', HOU: 'texans', IND: 'colts', JAX: 'jaguars', KC: 'chiefs', LA: 'rams',
  LAC: 'chargers', LV: 'raiders', MIA: 'dolphins', MIN: 'vikings', NE: 'patriots', NO: 'saints', NYG: 'giants', NYJ: 'jets', PHI: 'eagles',
  PIT: 'steelers', SEA: 'seahawks', SF: '49ers', TB: 'buccaneers', TEN: 'titans', WAS: 'commanders' };

/* ---- run ------------------------------------------------------------------ */
const { assertNoSelection } = await import(pathToFileURL(join(REPO, 'workers/nfl-picks-engine-shared/publication.mjs')).href);
const keyLeak = body => { try { const j = JSON.parse(body); if (j?.entitlement === 'pro') return 'pro-contract'; assertNoSelection(j); return null; } catch (e) { return String(e.message).startsWith('selection_leak') ? e.message : null; } };
const report = { mode: CANARY ? 'canary' : 'fixture', target: TARGET, static: LIVE ? 'deployed' : 'checkout', at: new Date().toISOString(), runs: [], canary: null, replacement: null, personas: {} };
let failed = 0, incomplete = 0;
function record(name, width, checks, file, meta = {}) {
  const bad = checks.filter(c => !c.ok);
  failed += bad.length;
  report.runs.push({ name, width, checks, shot: file, ...meta });
  console.log(`${bad.length ? 'FAIL' : 'PASS'} ${name}${width ? `@${width}` : ''}${bad.length ? `\n   ${bad.map(b => `✗ ${b.name}${b.detail ? ` — ${b.detail}` : ''}`).join('\n   ')}` : ''}`);
}
const noOverflow = c => ({ name: 'no horizontal overflow', ok: (c?.overflowX ?? 1) <= 0, detail: `overflowX=${c?.overflowX}` });

/* PRO */
let canaryId = null, replacementId = null, activeGame = null; const secrets = new Set();
if (!FREE_ONLY) {
  await setPersona('pro');
  for (const width of WIDTHS) {
    seen.errors.length = 0;
    await open('/#pbepicks', width);
    const res = await evaluate(PRO_PICKS);
    (res?.secrets || []).forEach(s => secrets.add(s));
    canaryId = canaryId || res?.canary; replacementId = replacementId || res?.replacement; activeGame = activeGame || res?.activeGame;
    report.summary = report.summary || res?.summary;
    record('pro/pbepicks', width, [...(res?.checks || [{ name: 'page evaluated', ok: false, detail: JSON.stringify(res).slice(0, 200) }]), noOverflow(await evaluate(COMMON)), { name: 'no page exceptions', ok: seen.errors.length === 0, detail: seen.errors.slice(0, 2).join(' | ') }], await shot('pro-pbepicks', width));
    if (width === WIDTHS[0] && canaryId) {
      const m = await evaluate(ROW_MATCH(canaryId));
      report.canary = m;
      record('pro/persisted-row-match', 0, m?.fields ? m.fields.map(f => ({ name: `${f.field}: persisted = response = DOM`, ok: f.match, detail: `persisted=${JSON.stringify(f.persisted)} response=${JSON.stringify(f.response)} dom=${JSON.stringify(f.dom)}` })) : [{ name: 'persisted row fetched', ok: false, detail: m?.error || JSON.stringify(m).slice(0, 200) }]);
      if (replacementId) {
        const rm = await evaluate(REPLACEMENT_MATCH(replacementId));
        report.replacement = rm;
        record('pro/replacement-lineage', 0, rm?.checks || [{ name: 'replacement fetched', ok: false, detail: rm?.error }]);
      } else {
        report.replacement = { note: 'no ACTIVE card with a replacement in this response' };
        console.log('NOTE pro/replacement-lineage — no ACTIVE card with a replacement in this response');
      }
    }
    await open('/', width);
    record('pro/dashboard', width, [...((await evaluate(PRO_HOME))?.checks || []), noOverflow(await evaluate(COMMON))], await shot('pro-dashboard', width));

    const g = activeGame || '2026_01_BUF_HOU';
    const teams = /^\d{4}_\d{2}_([A-Z]+)_([A-Z]+)$/.exec(g) || [];
    const nick = NICK[teams[1]] && NICK[teams[2]] ? [NICK[teams[1]], NICK[teams[2]]] : null;
    const eventId = nick ? await evaluate(`fetch('https://nfl-api.propbetedge.ai/api/best-line?days=8').then(r=>r.json()).then(d=>{const last=s=>String(s||'').trim().split(' ').pop().toLowerCase();const ev=(d.events||[]).find(e=>last(e.away)==='${nick[0]}'&&last(e.home)==='${nick[1]}');return ev?ev.id:''}).catch(()=>'')`) : '';
    await open(`/?event=${encodeURIComponent(eventId || '')}#matchups`, width);
    record('pro/matchup', width, [...((await evaluate(PRO_MODULE('[data-pbec-slot]')))?.checks || []), noOverflow(await evaluate(COMMON))], await shot('pro-matchup', width), { event: eventId, game: g });

    const espn = await evaluate(`(window.PBECard?.cards?.()||[]).find(c=>c.game?.espn_id)?.game?.espn_id || ''`);
    await evaluate(`sessionStorage.setItem('pbe.pbecast.focus', JSON.stringify({ game_id: '${espn || ''}' }))`);
    await open('/#pbecast', width);
    record('pro/pbecast', width, [...((await evaluate(PRO_MODULE('[data-pbecc-cast="pick"]')))?.checks || []), noOverflow(await evaluate(COMMON))], await shot('pro-pbecast', width), { espn_id: espn });
  }
}

/* NON-PRO: anonymous, forged cookie, signed-in free account */
const expected = { anonymous: 401, forged: 401, free: 403 };
for (const who of ['anonymous', 'forged', 'free']) {
  if (who === 'free' && CANARY && !FREE_COOKIE) {
    incomplete += 1;
    report.personas.free = 'NOT RUN — PBE_FREE_COOKIE_FILE not supplied';
    console.log('SKIP free — signed-in free account cookie not supplied (PBE_FREE_COOKIE_FILE)');
    continue;
  }
  await setPersona(who);
  const scan = t => [...secrets].filter(s => String(t || '').includes(s));
  for (const width of (who === 'anonymous' ? WIDTHS : [WIDTHS[0]])) {
    seen.cardBodies.length = 0;
    await open('/#pbepicks', width);
    const pg = await evaluate(NONPRO_PAGE);
    const probe = await evaluate(PROBE(canaryId));
    const bodies = [...seen.cardBodies.map(b => ({ label: new URL(b.url).search, status: b.status, body: b.body })), ...['current', 'decision', 'history', 'preview'].map(k => ({ label: `probe:${k}`, status: probe?.[k]?.status, body: probe?.[k]?.body || '' }))];
    const leaked = bodies.filter(b => scan(b.body).length || keyLeak(b.body)).map(b => `${b.label}=${b.status}`);
    const checks = [
      { name: 'locked previews render for every current decision', ok: pg?.locked > 0 && pg.locked === pg.previews, detail: `${pg?.locked}/${pg?.previews}` },
      { name: 'no Pro card in the DOM', ok: pg?.proCard === false },
      { name: 'unlock CTA present', ok: pg?.cta === true },
      { name: `view=current refused (${expected[who]})`, ok: probe?.current?.status === expected[who], detail: String(probe?.current?.status) },
      { name: `view=decision for the canary record refused (${expected[who]})`, ok: probe?.decision?.status === expected[who], detail: String(probe?.decision?.status) },
      { name: `view=validation-history refused (${expected[who]})`, ok: probe?.history?.status === expected[who], detail: String(probe?.history?.status) },
      { name: 'canary record absent from DOM and page HTML', ok: (FREE_ONLY || secrets.size > 0) && scan(pg?.html).length === 0, detail: `${secrets.size} identifiers checked` },
      { name: 'canary record absent from every API response the page saw or probed', ok: leaked.length === 0, detail: leaked.join(', ') || `${bodies.length} responses clean` },
      noOverflow(await evaluate(COMMON)),
    ];
    report.personas[who] = report.personas[who] || { statuses: { current: probe?.current?.status, decision: probe?.decision?.status, history: probe?.history?.status, preview: probe?.preview?.status } };
    record(`${who}/pbepicks`, width, checks, await shot(`${who}-pbepicks`, width));
  }
  if (who === 'anonymous') {
    await open('/', WIDTHS[0]);
    record('anonymous/dashboard', WIDTHS[0], [{ name: 'dashboard shows the locked card teaser', ok: Boolean(await evaluate(`!!document.querySelector('.pbec-dash.is-locked [data-pbec-upgrade]')`)) }, noOverflow(await evaluate(COMMON))], await shot('anonymous-dashboard', WIDTHS[0]));
  }
}

report.failed = failed;
report.incomplete = incomplete;
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
if (report.canary?.fields) {
  console.log(`\nCANARY ${report.canary.id} · ${report.canary.game_id} · ${report.canary.market} · ${report.canary.lifecycle}`);
  for (const f of report.canary.fields) console.log(`  ${f.match ? 'MATCH' : 'DIFF '} ${f.field.padEnd(18)} persisted=${JSON.stringify(f.persisted)}  response=${JSON.stringify(f.response)}  dom=${JSON.stringify(f.dom)}`);
}
if (report.replacement?.checks) console.log(`REPLACEMENT ${report.replacement.was} -> ${report.replacement.now} (${report.replacement.reason || 'no reason stated'})`);
console.log(`\n${failed ? 'GATE FAILED' : incomplete ? 'GATE INCOMPLETE' : 'GATE PASSED'} · ${report.runs.length} runs · ${failed} failed checks · ${incomplete} personas not run · ${OUT}`);
finish(failed ? 1 : incomplete ? 4 : 0);
