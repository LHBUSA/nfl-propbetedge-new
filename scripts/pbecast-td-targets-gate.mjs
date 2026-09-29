/* PBEcast TOUCHDOWN TARGETS — browser acceptance gate.
 * node scripts/pbecast-td-targets-gate.mjs [widths] [outDir]
 *
 * Serves the real static site from the working tree. /api/nfl-live answers
 * with the REAL CIN @ PIT package captured 2026-09-27 (401872950); every other
 * /api/* is stubbed empty. /api/pbe-touchdown-targets?view=game is answered by
 * the REAL api/_td-game-view.js over fixture rows, so the browser receives the
 * exact production shape for each tier. At every width, in headless Chrome:
 *
 *   LOCKED  module present in position (after Game Pulse, before Key Moments);
 *           teaser + unlock; no name, face, probability or play in the module
 *   PRO     ranked cards; the HIT card in gold with the real play; the
 *           celebration on a fresh hit; the play-by-play marker on the real
 *           scoring play (Key Moments and the full game log)
 *   BOTH    zero horizontal overflow, zero page exceptions, zero write requests
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { gameView } from '../api/_td-game-view.js';
import { driversFrom } from '../api/pbe-touchdown-targets.js';
import { evaluateTarget } from '../workers/nfl-td-targets-shared/td-live-hit.mjs';

const WIDTHS = (process.argv[2] || '320,360,390,430,768,1024,1440').split(',').map(Number);
const OUT = process.argv[3] || 'shots/pbecast-td';
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = process.cwd();
const PORT = 4500 + Math.floor(Math.random() * 90);
const DP = 9700 + Math.floor(Math.random() * 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const GAME = '401872950';
const LIVE = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/td-hit/live-401872950.json'), 'utf8'));
const CHASE_PLAY = '401872950490';

const snapshot = (name, espnId, pos) => ({
  player: { espn_id: espnId, position: pos, team: 'CIN', opponent: 'PIT', name },
  event: { espn_id: GAME },
  probability: { published: 0.44, lambda: 0.58, components: { red_zone_role: { available: true, factor: 1.21, player_rz_opportunities_per_game: 2.4, position_rz_opportunities_per_game: 1.3 }, game_script: { available: true, factor: 1.08, bucket: 'favourite', sample_rows: 5120 } } },
  market: { probability: 0.38, books: 5, vig_removed: true },
});
const PICKS = [
  { id: '11111111-1111-4111-8111-111111111111', event_id: 'odds-cin-pit', season: 2026, week: 4, kickoff_ts: '2026-09-27T17:00:00.000Z', player_name: "Ja'Marr Chase", player_key: 'ja marr chase',
    model_prob: 0.4404, market_prob: 0.3812, edge_pct: 0.0592, confidence_bucket: 'A', market_price: 150, book: 'draftkings', target_rank: 'primary', projection_model_version: 'pbe-td-hazard-v1', selector_version: 3,
    publication_scope: 'tracking', status: 'open', created_at: '2026-09-27T15:10:00.000Z', model_snapshot: snapshot("Ja'Marr Chase", '4362628', 'WR') },
  { id: '22222222-2222-4222-8222-222222222222', event_id: 'odds-cin-pit', season: 2026, week: 4, kickoff_ts: '2026-09-27T17:00:00.000Z', player_name: 'Chase Brown', player_key: 'chase brown',
    model_prob: 0.3301, market_prob: 0.3012, edge_pct: 0.0289, confidence_bucket: 'B', market_price: 190, book: 'fanduel', target_rank: 'secondary', projection_model_version: 'pbe-td-hazard-v1', selector_version: 3,
    publication_scope: 'tracking', status: 'open', created_at: '2026-09-27T15:20:00.000Z', model_snapshot: snapshot('Chase Brown', '4362238', 'RB') },
];
const EVAL = { espn_id: GAME, event_id: 'odds-cin-pit', season: 2026, week: 4, kickoff_ts: '2026-09-27T17:00:00.000Z', away_team: 'CIN', home_team: 'PIT', outcome: 'target_issued', reason: null, publication_scope: 'tracking', decided_at: '2026-09-27T16:45:00Z' };
function hitRow() {
  const v = evaluateTarget({ target: PICKS[0], detail: LIVE, mode: 'final_backfill', statuses: ['open'] });
  return { ...v.row, detection: 'live_fresh', detected_at: new Date().toISOString() };
}
let TIER = 'anonymous';
let HIT = null;
async function gamePayload() {
  const project = (rows, q) => {
    const sel = /(?:^|&)select=([^&]*)/.exec(q)?.[1];
    if (!sel || sel === '*') return rows;
    return rows.map(row => Object.fromEntries(sel.split(',').filter(c => c in row).map(c => [c, row[c]])));
  };
  const sb = async (table, q) => {
    q = decodeURIComponent(q);
    if (table === 'nfl_td_final_pregame_evaluation') return project([EVAL], q);
    if (table === 'nfl_prop_picks') return project(PICKS, q);
    if (table === 'nfl_prop_pick_grades') return [];
    if (table === 'nfl_td_target_hit_events') return project(HIT ? [HIT] : [], q);
    return [];
  };
  let out;
  await gameView({ res: {}, send: (_r, status, body) => { out = { status, body }; }, sb, secret: 's', query: { espn_id: GAME }, resolveAccess: async () => ({ tier: TIER }), driversFrom });
  return out;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const gameBodies = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/api/pbe-touchdown-targets' && url.searchParams.get('view') === 'game') {
    const out = await gamePayload();
    gameBodies.push(JSON.stringify(out.body));
    return json(out.body, out.status);
  }
  if (url.pathname === '/api/pbe-touchdown-targets' && url.searchParams.get('view') === 'trackrecord') {
    return json({ records: { official: { all: { wins: 0, losses: 0, voids: 0, graded: 0, hit_rate: null, pending: 0 } }, tracking: { all: { wins: 8, losses: 13, voids: 2, graded: 21, hit_rate: 8 / 21, pending: 2 } } } });
  }
  if (url.pathname === '/api/nfl-live') {
    if (url.searchParams.get('event')) return json(LIVE);
    return json({ ok: true, games: [LIVE.game], source: LIVE.source });
  }
  if (url.pathname.startsWith('/api/')) return json({ ok: true, items: [], games: [], events: [], players: [] });
  let path = decodeURIComponent(url.pathname);
  if (path === '/' || !extname(path)) path = '/index.html';
  const file = resolve(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(PORT);

const dir = mkdtempSync(join(tmpdir(), 'pbe-tdcast-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${DP}`, `--user-data-dir=${dir}`, '--headless=new', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
function finish(code) {
  try { chrome.kill(); } catch {}
  server.close();
  setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(code); }, 300);
}
setTimeout(() => { console.error('DEADLINE'); finish(3); }, 600000).unref?.();

async function wsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${DP}/json/list`)).json();
      const p = l.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('devtools never came up');
}
const ws = new WebSocket(await wsUrl());
await new Promise(r => { ws.onopen = r; });
let seq = 1; const pending = new Map();
const send = (method, params = {}) => { const n = seq++; ws.send(JSON.stringify({ id: n, method, params }));
  return new Promise((ok, no) => pending.set(n, { ok, no })); };
const pageErrors = [];
const writes = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.no(new Error(m.error.message)) : p.ok(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'exception');
  if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method) && r.url.startsWith(`http://localhost:${PORT}`)) writes.push(`${r.method} ${r.url}`);
  }
};
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
const evalIn = async (expression, ms = 30000) => {
  const r = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    sleep(ms).then(() => { throw new Error(`WEDGED: ${expression.slice(0, 80)}`); })]);
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`);
  return r.result?.value;
};
const waitFor = async (expr, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await evalIn(expr).catch(() => false)) return true; await sleep(150); }
  return false;
};
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const MOD = `document.querySelector('.pbecast6 [data-pbecc-cast="tdtargets"] .pbetdc')`;
let loads = 0;
async function open(width) {
  const height = width <= 430 ? 860 : 1000;
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 430 });
  await evalIn('try{sessionStorage.clear()}catch(e){};true').catch(() => {});
  await send('Page.navigate', { url: `http://localhost:${PORT}/?gate=${++loads}#home` });
  await sleep(300);
  await waitFor('document.readyState==="complete" && !!window.PBEGameHandoff && !!window.PBEcastTDTargets', 30000);
  await evalIn(`window.PBEGameHandoff.open('${GAME}', { source: 'gate' }); true`);
  return waitFor(`!!${MOD} && !${MOD}.classList.contains('is-loading')`, 30000);
}
const overflow = `(() => { const w = document.documentElement.clientWidth; const bad = [];
  if (document.documentElement.scrollWidth > w + 1) bad.push('document ' + document.documentElement.scrollWidth + '>' + w);
  const mod = ${MOD}; if (mod) for (const el of mod.querySelectorAll('*')) { const r = el.getBoundingClientRect();
    if (r.width && (r.right > w + 0.5 || r.left < -0.5)) bad.push((el.className||el.tagName) + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); }
  return bad.slice(0, 6); })()`;
const order = `(() => { const r = document.querySelector('.pbecast6'); const q = n => r.querySelector('[data-pbecc-cast="' + n + '"]');
  const a = q('pulse'), b = q('tdtargets'), c = q('moments'); if (!a || !b || !c) return 'missing';
  const f = r.querySelector('.cast6-field') || r.querySelector('[data-cast6-action]');
  const before = (x, y) => Boolean(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
  return before(f, a) && before(a, b) && before(b, c) && before(c, r.querySelector('[data-cast6-workspace]')) ? 'ok' : 'wrong'; })()`;
async function shot(name) {
  await sleep(500);
  await evalIn(`${MOD}.scrollIntoView({block:'start'}); true`);
  await sleep(250);
  const box = await evalIn(`(() => { const r = ${MOD}.getBoundingClientRect(); return { y: Math.max(0, r.top + window.scrollY - 8), h: Math.min(r.height + 16, 2400) }; })()`);
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: box.y, width: await evalIn('document.documentElement.clientWidth'), height: box.h, scale: 1 } });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
}

for (const width of WIDTHS) {
  /* ---------------- LOCKED ---------------- */
  TIER = 'anonymous'; HIT = hitRow();
  const shown = await open(width);
  check(`${width} · LOCKED module renders`, shown);
  if (shown) {
    check(`${width} · placement: field -> Game Pulse -> TD TARGETS -> Key Moments -> game log`, (await evalIn(order)) === 'ok', await evalIn(order));
    const html = await evalIn(`${MOD}.outerHTML`);
    const flat = (await evalIn(`${MOD}.innerText`)).replace(/\s+/g, ' ');
    check(`${width} · teaser: "PBE identified 2 touchdown targets" + unlock`, /PBE identified 2 touchdown targets for this matchup\./.test(flat) && /Unlock with All Access Pro/.test(flat), flat.slice(0, 120));
    const leaks = ["Chase", '4362628', '4362238', '44.0', '33.0', 'RED-ZONE', 'headshots', 'Yd pass', '11111111', '22222222'].filter(s => html.includes(s));
    check(`${width} · locked module holds no identity, face, probability, reason or play`, leaks.length === 0, leaks.join(','));
    const body = gameBodies.at(-1) || '';
    check(`${width} · the locked JSON itself carries none of it`, !/Chase|4362628|model_prob|probability"|play_id|headshot/.test(body), body.slice(0, 120));
    check(`${width} · no PBP marker for a locked reader`, (await evalIn(`document.querySelectorAll('[data-pbetdc-marker]').length`)) === 0);
    const bad = await evalIn(overflow);
    check(`${width} · LOCKED zero horizontal overflow`, bad.length === 0, bad.join('; '));
    await shot(`locked-${width}`);
  }

  /* ---------------- PRO + fresh HIT ---------------- */
  TIER = 'pro'; HIT = hitRow();
  const pro = await open(width);
  check(`${width} · PRO module renders`, pro);
  if (!pro) continue;
  const flat = (await evalIn(`${MOD}.innerText`)).replace(/\s+/g, ' ');
  check(`${width} · ranked cards #1 PRIMARY, #2 SECONDARY with names`, /TARGET #1\s*PRIMARY/.test(flat) && /TARGET #2\s*SECONDARY/.test(flat) && /Ja'Marr Chase/.test(flat) && /Chase Brown/.test(flat));
  check(`${width} · probability, market, edge, confidence`, /TD PROBABILITY\s*44\.0%/.test(flat) && /MARKET\s*38\.1%/.test(flat) && /EDGE\s*\+5\.9 pp/.test(flat) && /CONFIDENCE\s*A/.test(flat));
  check(`${width} · reasons from the frozen snapshot`, /RED-ZONE ROLE/.test(flat) && /FAVOURABLE SCRIPT/.test(flat));
  check(`${width} · HIT card: gold state + real play (3-yard receiving touchdown · Q1 · 5:50)`,
    (await evalIn(`!!${MOD}.querySelector('.pbetdc-card.is-hit')`)) && /✓ TOUCHDOWN HIT/.test(flat) && /3-yard receiving touchdown/.test(flat) && /Q1 · 5:50/.test(flat));
  check(`${width} · PENDING on the target that has not scored`, (await evalIn(`${MOD}.querySelectorAll('.pbetdc-card.is-pending').length`)) === 1);
  check(`${width} · fresh hit celebrates (pulse class)`, await evalIn(`!!${MOD}.querySelector('.pbetdc-card.is-hit.is-celebrate')`));
  const photo = await evalIn(`(() => { const i = ${MOD}.querySelector('.pbetdc-card.is-hit .pbetdc-face img'); return i ? i.getAttribute('src') : null; })()`);
  check(`${width} · photo by ESPN athlete id`, photo === 'https://a.espncdn.com/i/headshots/nfl/players/full/4362628.png', photo);
  const marker = await evalIn(`(() => { const m = [...document.querySelectorAll('[data-pbetdc-marker="${CHASE_PLAY}"]')]; return m.map(x => ({ next: x.nextElementSibling?.dataset?.kmPlay || x.nextElementSibling?.dataset?.playId || null, text: x.innerText.replace(/\\s+/g,' ') })); })()`);
  check(`${width} · PBP marker sits on the real scoring play ${CHASE_PLAY}`, marker.length >= 1 && marker.every(m => m.next === CHASE_PLAY) && /PBE TOUCHDOWN TARGET HIT — Ja'Marr Chase/.test(marker[0]?.text || ''), JSON.stringify(marker[0] || null));
  check(`${width} · marker in Key Moments AND the full game log`, marker.length >= 2, `${marker.length} markers`);
  const bad = await evalIn(overflow);
  check(`${width} · PRO zero horizontal overflow`, bad.length === 0, bad.join('; '));
  await shot(`pro-hit-${width}`);
  /* a re-render (the live lane rewrites the log) keeps exactly one marker per list */
  await evalIn('window.PBEcastCommand.render(); window.PBEcastCommand.render(); true');
  check(`${width} · re-render does not duplicate the marker`, (await evalIn(`document.querySelectorAll('[data-pbetdc-marker="${CHASE_PLAY}"]').length`)) === marker.length);
}

check('zero page exceptions', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
check('zero browser write requests', writes.length === 0, writes.slice(0, 3).join(' | '));
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ results, pageErrors, writes }, null, 2));
finish(failed.length ? 1 : 0);
