/* ODDS SURFACE GATE
 *
 *   node scripts/odds-surface-gate.mjs [baseUrl] [dwellSeconds] [outDir]
 *
 * Opens Dashboard, Prop Board, QB / WR / RB / TE DNA, Model Lab and Market
 * Watch in headless Chrome against the dev server and proves that no surface
 * keeps re-requesting sportsbook odds. Every odds-shaped request the page
 * makes (/api/odds*, /api/home-market, the Player DNA current-market routes)
 * is intercepted, answered from the saved provider fixtures, and counted.
 *
 * Pass criteria per route:
 *   · zero requests to api.the-odds-api.com from the browser (there must be
 *     no browser provider access at all)
 *   · after the initial load settles, NO further odds requests arrive during
 *     the dwell window (no polling loop survives)
 *   · no console exceptions
 *
 * Live routes (scores, play-by-play, weather, breaking) are not intercepted
 * and not judged here; this gate is about odds only.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:4321';
const DWELL = Number(process.argv[3] || 45) * 1000;
const OUT = process.argv[4] || 'shots/odds-surface';
const SETTLE = 12000;
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
mkdirSync(OUT, { recursive: true });
const FEATURED = JSON.parse(readFileSync(new URL('../research/fixtures/odds/featured-2026-09-06.json', import.meta.url), 'utf8'));
const BOARD = JSON.parse(readFileSync(new URL('../research/fixtures/odds/board-NE-SEA-player_pass_yds-2026-09-06.json', import.meta.url), 'utf8'));
const CAPTURED = new Date().toISOString();
const FRESH = { semantics: 'LAST_VERIFIED_MARKET', batch_id: 'gate-fixture', captured_at: CAPTURED, captured_at_et: 'Sep 6, 1:02 PM ET', age_seconds: 60, age_hours: 0.02, ingest: { status: 'OK', last_success_at: CAPTURED }, source: { provider: 'the_odds_api', semantics: 'MARKET_SNAPSHOT', read_path: 'kv-snapshot' }, cache: 'snapshot' };
function fixtureFor(url) {
  const u = new URL(url);
  if (/\/api\/odds\/board/.test(u.pathname)) return { ...BOARD, ...FRESH, event: BOARD.event };
  if (/\/api\/odds\/events/.test(u.pathname)) return { ...FRESH, count: FEATURED.events.length, events: FEATURED.events.map((e) => ({ id: e.id, commence_time: e.commence_time, home_team: e.home_team, away_team: e.away_team })) };
  if (/\/api\/odds\/health/.test(u.pathname)) return { status: 'ok', service: 'nfl-odds', configured: true, semantics: 'LAST_VERIFIED_MARKET', snapshot: FRESH };
  if (/\/api\/odds/.test(u.pathname)) return { ...FEATURED, ...FRESH };
  if (/\/api\/home-market/.test(u.pathname)) return { ok: true, semantics: 'MARKET_SNAPSHOT', stale: false, captured_at: CAPTURED, captured_at_et: FRESH.captured_at_et, event: { id: '8c94552d022acec4a0458d70c19d3da9', away: 'New England Patriots', home: 'Seattle Seahawks' }, books: 11, quote_count: 66, provider_last_update: CAPTURED, spread: { away: 3.5, home: -3.5 }, total: { line: 44.5, over_price: -108, under_price: -110 }, moneyline: { away: 157, home: -185 }, vig_free_probability: { away: 0.375, home: 0.625 }, coverage: { h2h_quotes: 22, spread_quotes: 22, total_quotes: 22 } };
  return null;
}
const ODDS_RE = /\/api\/(odds|home-market)|the-odds-api\.com|\/api\/(qb|wr|rb|te)-dna\/(prop-lab|game-context)|_playerdna\/markets/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DP = 9500 + Math.floor(Math.random() * 90); const dir = mkdtempSync(join(tmpdir(), 'pbe-odds-gate-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${DP}`, `--user-data-dir=${dir}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
function finish(c) { try { chrome.kill(); } catch {} setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(c); }, 200); }
setTimeout(() => { console.error('DEADLINE'); finish(3); }, 900000).unref?.();
async function wsUrl() { for (let i = 0; i < 100; i++) { try { const l = await (await fetch(`http://127.0.0.1:${DP}/json/list`)).json(); const p = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(200); } throw new Error('devtools never came up'); }
const ws = new WebSocket(await wsUrl()); await new Promise((r) => { ws.onopen = r; });
let id = 1; const pending = new Map(); let errors = []; let odds = []; let providerHits = 0;
const send = (m, p = {}) => { const n = id++; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => pending.set(n, { resolve: res, reject: rej })); };
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exception');
  if (m.method === 'Fetch.requestPaused') {
    const { requestId, request } = m.params;
    if (/the-odds-api\.com/.test(request.url)) { providerHits++; send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {}); return; }
    if (ODDS_RE.test(request.url)) {
      odds.push({ t: Date.now(), url: request.url.replace(/^https?:\/\/[^/]+/, '') });
      const body = fixtureFor(request.url);
      if (body) { send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }], body: Buffer.from(JSON.stringify(body)).toString('base64') }).catch(() => {}); return; }
    }
    send('Fetch.continueRequest', { requestId }).catch(() => {});
  }
};
await send('Runtime.enable'); await send('Page.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const evalIn = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value; };

await send('Page.navigate', { url: `${BASE}/?oddsgate=${Date.now()}` }); await sleep(SETTLE);
const views = await evalIn(`Object.keys(window.App?.VIEWS || {})`);
const pick = (re) => views.find((v) => re.test(v));
const ROUTES = [
  ['Dashboard', 'home'], ['Prop Board', pick(/^prop(board|s)?$|propboard|prop-board/i) || pick(/prop/i)], ['QB DNA', pick(/^qbdna/i)], ['WR DNA', pick(/^wrdna/i)], ['RB DNA', pick(/^rbdna/i)], ['TE DNA', pick(/^tedna/i)],
  ['Model Lab', pick(/^picks$|model/i)], ['Market Watch', pick(/watch|market/i)],
].filter(([, v]) => v);
console.log('views:', views.join(', '));
let failures = 0; const check = (n, c, d) => { if (!c) failures++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); };
const report = [];
for (const [label, view] of ROUTES) {
  errors = []; odds = []; providerHits = 0;
  await evalIn(`window.App.nav(${JSON.stringify(view)})`);
  await sleep(SETTLE);
  const initial = odds.length; const settledAt = Date.now();
  await sleep(DWELL);
  const later = odds.filter((o) => o.t > settledAt);
  console.log(`\n[${label}] view=${view} initial odds reads=${initial} during ${DWELL / 1000}s dwell=${later.length}`);
  for (const u of [...new Set(odds.map((o) => o.url))].slice(0, 6)) console.log(`     ${u.slice(0, 120)}`);
  check('zero browser requests to the provider', providerHits === 0, `${providerHits}`);
  check(`no odds re-requests during the ${DWELL / 1000}s dwell (no polling loop)`, later.length === 0, later.map((o) => o.url).slice(0, 3).join(' | '));
  check('no console exceptions', errors.length === 0, errors[0]?.slice(0, 120));
  report.push({ label, view, initial, dwell: later.length, providerHits, errors: errors.length });
  const cap = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${label.replace(/\s+/g, '-').toLowerCase()}.png`), Buffer.from(cap.data, 'base64'));
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\n${ROUTES.length} routes · ${failures ? failures + ' FAILURES' : 'CLEAN'}`);
ws.close(); finish(failures ? 1 : 0);
