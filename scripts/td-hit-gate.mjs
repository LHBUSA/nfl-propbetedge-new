/* TOUCHDOWN TARGET HIT — browser acceptance gate.
 * node scripts/td-hit-gate.mjs [widths] [outDir]
 *
 * Serves the real static site from the working tree with every /api/* stubbed
 * (deterministic: no live slate, wire or storm), and the one endpoint under
 * test, /api/pbe-touchdown-targets?view=hits, answering with fixture events in
 * the exact shape the production read returns. Then, in headless Chrome over
 * CDP, at every width:
 *   - the event arrives through the real poller -> PBEBreaking.offer() -> rail
 *   - photo, name, PRIMARY/SECONDARY, TRACKING/OFFICIAL, probability, price,
 *     play, clock, score, live stat line, footer, both CTAs are on screen
 *   - nothing overflows the viewport horizontally
 *   - the event renders once per session: a second poll, a route change and a
 *     reload in the same session do not replay it
 *   - WATCH IN PBECAST hands off the exact ESPN game; VIEW TOUCHDOWN TARGETS
 *     opens #tdtargets; VIEW PLAYER DNA appears only on an exact gsis id
 *   - reduced motion removes the ring animation
 *   - the browser makes no write request of any kind
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';

const WIDTHS = (process.argv[2] || '320,360,390,430,768,1024,1440').split(',').map(Number);
const OUT = process.argv[3] || 'shots/td-hit';
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = process.cwd();
const PORT = 4400 + Math.floor(Math.random() * 90);
const DP = 9600 + Math.floor(Math.random() * 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

/* ---- fixture events, production shape (api/_td-target-hits.js shapeHit) ---- */
let clockStart = Date.now();
const hit = (over = {}) => ({
  id: 1, pick_id: '38546b74-4058-41d5-9087-d789fd7b1dbc', detected_at: null,
  game: { espn_id: '401872954', away: 'NYJ', home: 'DET', away_score: 7, home_score: 14, period: 2, clock: '8:14' },
  player: { name: 'Jahmyr Gibbs', espn_id: '4429795', gsis_id: '00-0039139', position: 'RB', team: 'DET', opponent: 'NYJ',
            headshot_url: 'https://a.espncdn.com/i/headshots/nfl/players/full/4429795.png' },
  target: { rank: 'primary', publication_scope: 'tracking', scope_label: 'TRACKING TARGET', model_prob: 0.533039, market_price: -275, confidence_bucket: 'tracking' },
  play: { id: '401872954500', type: 'Rushing Touchdown', text: 'Jahmyr Gibbs 2 Yd Rush (Jake Bates Kick)', yards: 2, wallclock: null },
  live_stats: { carries: 8, rush_yards: 42, rushing_td: 1, targets: 4, receptions: 3, receiving_yards: 27, receiving_td: 0 },
  ...over,
});
/* The published event log. publish() models the detector writing new rows:
   each gets the next identity id and a detected_at of "now". */
let LOG = [];
let SEQ = 100;
function publish(fixtures) {
  LOG = fixtures.map((h, i) => ({ ...h, id: ++SEQ, detected_at: new Date(clockStart + i * 1000).toISOString(),
    play: { ...h.play, wallclock: new Date(clockStart - 45000).toISOString() } }));
  return LOG.map(h => h.id);
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const hitsRequests = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/api/pbe-touchdown-targets' && url.searchParams.get('view') === 'hits') {
    /* the production contract: after_id is the cursor; since is bootstrap only */
    const afterRaw = url.searchParams.get('after_id');
    let rows, next;
    if (afterRaw !== null) {
      const after = Number(afterRaw);
      rows = LOG.filter(h => h.id > after);
      next = rows.length ? Math.max(...rows.map(h => h.id)) : after;
    } else {
      const since = Date.parse(url.searchParams.get('since') || '') || 0;
      const hw = LOG.length ? Math.max(...LOG.map(h => h.id)) : SEQ;
      rows = LOG.filter(h => Date.parse(h.detected_at) > since && h.id <= hw);
      next = rows.length ? Math.max(...rows.map(h => h.id)) : hw;
    }
    hitsRequests.push({ method: req.method, mode: afterRaw !== null ? 'after_id' : 'since', q: url.search, ids: rows.map(h => h.id) });
    return json({ view: 'hits', count: rows.length, next_cursor: next, limit: 25, events: rows, hits: rows });
  }
  if (url.pathname === '/api/rb-dna' && url.searchParams.get('list')) {
    return json({ players: [{ gsis_id: '00-0039139', name: 'Jahmyr Gibbs', team_2026: 'DET', market_priced_2026: true, games: 40 }] });
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

const dir = mkdtempSync(join(tmpdir(), 'pbe-tdhit-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${DP}`, `--user-data-dir=${dir}`, '--headless=new', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
function finish(code) {
  try { chrome.kill(); } catch {}
  server.close();
  setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(code); }, 300);
}
setTimeout(() => { console.error('DEADLINE'); finish(3); }, 540000).unref?.();

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
    if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method)) writes.push(`${r.method} ${r.url}`);
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

let loads = 0;
async function load(width, { clearSession = true, reload = false } = {}) {
  const height = width <= 430 ? 860 : 1000;
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 430 });
  if (clearSession) await evalIn('try{sessionStorage.clear()}catch(e){};true').catch(() => {});
  /* A unique URL per load: navigating to the same URL with only a hash is a
     same-document change and would reuse the previous page's rail state. */
  if (reload) await send('Page.reload', { ignoreCache: true });
  else await send('Page.navigate', { url: `http://localhost:${PORT}/?gate=${++loads}#home` });
  await sleep(300);
  await waitFor('document.readyState==="complete" && !!window.PBEBreaking && !!window.PBETouchdownHits', 30000);
}
const CARD = `document.querySelector('#pbe-breaking-slot .pbeb[data-tone="tdhit"]')`;
const overflow = `(() => { const w = document.documentElement.clientWidth; const bad = [];
  if (document.documentElement.scrollWidth > w + 1) bad.push('document ' + document.documentElement.scrollWidth + '>' + w);
  const card = ${CARD}; if (card) for (const el of card.querySelectorAll('*')) { const r = el.getBoundingClientRect();
    if (r.width && (r.right > w + 0.5 || r.left < -0.5)) bad.push((el.className||el.tagName) + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); }
  return bad.slice(0, 6); })()`;
const text = `(${CARD}?.innerText || '')`;
const visible = sel => `(() => { const el = ${CARD}?.querySelector(${JSON.stringify(sel)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'; })()`;
async function shot(name) {
  /* the rail re-renders (and re-runs its entrance) on pbe:upgrades-ready; let it settle */
  await sleep(900);
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: await evalIn('document.documentElement.clientWidth'), height: Math.min(900, await evalIn('Math.max(600, (' + CARD + '?.getBoundingClientRect().bottom||600) + 40)')), scale: 1 } });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
}

for (const width of WIDTHS) {
  clockStart = Date.now();
  publish([hit()]);
  await load(width);
  const shown = await waitFor(`!!${CARD}`, 20000);
  check(`${width} · the event arrives through the poller and renders`, shown);
  if (!shown) continue;
  const t = await evalIn(text);
  const flat = t.replace(/\s+/g, ' ');
  check(`${width} · title + player`, /TOUCHDOWN TARGET HIT/.test(flat) && /JAHMYR GIBBS/i.test(flat), flat.slice(0, 80));
  check(`${width} · PRIMARY TARGET · VERIFIED LIVE TARGET, badge TRACKING, never OFFICIAL`, /PRIMARY TARGET · VERIFIED LIVE TARGET/.test(flat) && /TRACKING TARGET/.test(flat) && !/OFFICIAL/.test(flat));
  check(`${width} · probability 53.3% and locked price -275`, /PBE TD PROBABILITY\s*53\.3%/.test(flat) && /LOCKED PRICE\s*-275/.test(flat));
  check(`${width} · play, clock and score`, /Q2 · 8:14/.test(flat) && /2-YARD RUSHING TOUCHDOWN/.test(flat) && /DET 14/.test(flat) && /NYJ 7/.test(flat));
  check(`${width} · live stat line`, /8 CAR · 42 YDS · 1 TD/.test(flat) && /3 REC · 27 YDS · 4 TGT/.test(flat), (flat.match(/LIVE\s*8 CAR[^A-Z]*.*?TGT/) || [''])[0]);
  check(`${width} · footer: live hit, final settles after the game`, /LIVE HIT · FINAL RESULT SETTLES AFTER THE GAME/.test(flat));
  const photo = await evalIn(`(() => { const i = ${CARD}?.querySelector('.pbeb-tdface img'); if (!i) return null; const r = i.getBoundingClientRect(); return { src: i.getAttribute('src'), w: Math.round(r.width) }; })()`);
  const photoOk = photo && photo.src === 'https://a.espncdn.com/i/headshots/nfl/players/full/4429795.png' && (width <= 760 ? photo.w >= 56 && photo.w <= 68 : photo.w >= 70 && photo.w <= 90);
  check(`${width} · real player photo at the specified size`, photoOk, JSON.stringify(photo));
  const labels = await evalIn(`[...${CARD}.querySelectorAll('.pbeb-cta')].filter(b => b.getBoundingClientRect().width > 0 && getComputedStyle(b).display !== 'none').map(b => b.innerText.replace(/\\s+/g, ' ').trim())`);
  check(`${width} · CTAs visible: WATCH IN PBECAST + VIEW TOUCHDOWN TARGETS (+ exact-id PLAYER DNA)`,
    labels.some(l => l.startsWith('WATCH IN PBECAST')) && labels.some(l => l.startsWith('VIEW TOUCHDOWN TARGETS')), labels.join(' | '));
  const bad = await evalIn(overflow);
  check(`${width} · zero horizontal overflow`, bad.length === 0, bad.join('; '));
  const top = await evalIn(`Math.round(${CARD}.querySelector('.pbeb-tdnums').getBoundingClientRect().bottom)`);
  check(`${width} · primary information visible without scrolling`, top <= (width <= 430 ? 860 : 1000), `numbers end at ${top}px`);
  await shot(`tdhit-${width}`);

  /* once per session: poll again, change route, reload */
  await evalIn(`PBEBreaking.dismiss(); true`);
  await evalIn(`PBETouchdownHits.poll().then(() => true)`);
  await sleep(400);
  check(`${width} · a repeat poll does not replay it`, !(await evalIn(`!!${CARD}`)));
  await evalIn(`(window.App && App.nav) ? App.nav('games') : (location.hash = 'games'); true`);
  await sleep(1500);
  check(`${width} · a route change does not replay it`, !(await evalIn(`!!${CARD}`)));
  await load(width, { clearSession: false, reload: true });
  await sleep(2500);
  check(`${width} · a reload in the same session does not replay it`, !(await evalIn(`!!${CARD}`)));
}

/* ---- variants, driven through the same poller at the narrowest and widest -- */
const VARIANTS = [
  ['secondary-official', hit({ pick_id: 'aaaaaaaa-0000-4000-8000-000000000001', target: { rank: 'secondary', publication_scope: 'official', scope_label: 'OFFICIAL TARGET', model_prob: 0.333899, market_price: 500 },
    player: { name: 'Isaac TeSlaa', espn_id: '5123663', gsis_id: '00-0040669', position: 'WR', team: 'DET', opponent: 'NYJ', headshot_url: 'https://a.espncdn.com/i/headshots/nfl/players/full/5123663.png' },
    play: { id: 'p2', type: 'Passing Touchdown', text: 'Isaac TeSlaa 31 Yd pass from Jared Goff (Jake Bates Kick)', yards: 31 },
    live_stats: { targets: 5, receptions: 4, receiving_yards: 77, receiving_td: 1 } }),
    f => /SECONDARY TARGET HIT/.test(f) && /SECONDARY TARGET · OFFICIAL TARGET/.test(f) && !/VERIFIED LIVE TARGET/.test(f) && /\+500/.test(f) && /33\.4%/.test(f) && /31-YARD RECEIVING TOUCHDOWN/.test(f) && /4 REC · 77 YDS · 1 TD · 5 TGT/.test(f) && /FINAL RESULT SETTLES AFTER THE GAME/.test(f)],
  ['no-photo-long-name', hit({ pick_id: 'aaaaaaaa-0000-4000-8000-000000000002',
    player: { name: 'Christopher Rodriguez-Montgomery Jr.', espn_id: '1', gsis_id: null, position: 'RB', team: 'JAX', opponent: 'NE', headshot_url: null },
    game: { espn_id: '401872957', away: 'NE', home: 'JAX', away_score: 3, home_score: 10, period: 1, clock: '0:41' },
    live_stats: { carries: 6 } }),
    f => /CHRISTOPHER RODRIGUEZ-MONTGOMERY JR\./i.test(f) && /6 CAR/.test(f) && !/REC/.test(f) && !/VIEW PLAYER DNA/.test(f)],
  ['qb-no-stats-no-price', hit({ pick_id: 'aaaaaaaa-0000-4000-8000-000000000003', target: { rank: 'primary', publication_scope: 'tracking', model_prob: null, market_price: null },
    player: { name: 'Trevor Lawrence', espn_id: '4360310', gsis_id: '00-0036971', position: 'QB', team: 'JAX', opponent: 'NE', headshot_url: 'https://a.espncdn.com/i/headshots/nfl/players/full/4360310.png' },
    live_stats: {} }),
    f => /TREVOR LAWRENCE/i.test(f) && !/PBE TD PROBABILITY/.test(f) && !/LOCKED PRICE/.test(f) && !/\bLIVE\s+\d/.test(f)],
];
for (const width of [320, 1440]) {
  for (const [name, fixture, expect] of VARIANTS) {
    clockStart = Date.now();
    publish([fixture]);
    await load(width);
    const shown = await waitFor(`!!${CARD}`, 20000);
    const flat = shown ? (await evalIn(text)).replace(/\s+/g, ' ') : '';
    check(`${width} · variant ${name}`, shown && expect(flat), flat.slice(0, 160));
    const bad = shown ? await evalIn(overflow) : ['not shown'];
    check(`${width} · variant ${name} · zero horizontal overflow`, bad.length === 0, bad.join('; '));
    await shot(`tdhit-${name}-${width}`);
  }
}

/* ---- Player DNA only on an exact gsis id; the Gibbs fixture resolves ------- */
clockStart = Date.now();
publish([hit({ pick_id: 'aaaaaaaa-0000-4000-8000-000000000009' })]);
await load(1440);
await waitFor(`!!${CARD}`);
await evalIn(`PBEBreaking.dismiss(); true`);
await waitFor(`!!(window.PBEBreaking._test.DNA_INDEX.loaded)`, 10000);
clockStart = Date.now();
publish([hit({ pick_id: 'aaaaaaaa-0000-4000-8000-000000000010' })]);
await evalIn(`PBETouchdownHits.poll().then(() => true)`);
await waitFor(`!!${CARD}`);
const dnaLabels = await evalIn(`[...${CARD}.querySelectorAll('.pbeb-cta')].map(b => b.innerText.trim())`);
check('Player DNA CTA appears on an exact gsis id match', dnaLabels.some(l => l.startsWith('VIEW PLAYER DNA')), dnaLabels.join(' | '));

/* ---- CTAs ------------------------------------------------------------------ */
await evalIn(`window.__handoff = []; (() => { const o = PBEGameHandoff.open; PBEGameHandoff.open = (id, opts) => { window.__handoff.push([id, opts]); return o(id, opts); }; })(); true`);
await evalIn(`[...${CARD}.querySelectorAll('.pbeb-cta')].find(b => b.innerText.startsWith('WATCH IN PBECAST')).click(); true`);
await sleep(600);
const handoff = await evalIn('window.__handoff');
check('WATCH IN PBECAST opens the exact game through PBEGameHandoff', handoff.length === 1 && handoff[0][0] === '401872954' && handoff[0][1].source === 'breaking', JSON.stringify(handoff));
check('... and lands on #pbecast', (await evalIn('location.hash')) === '#pbecast');
clockStart = Date.now();
publish([hit({ pick_id: 'aaaaaaaa-0000-4000-8000-000000000011' })]);
await evalIn(`PBETouchdownHits.poll().then(() => true)`);
await waitFor(`!!${CARD}`);
await evalIn(`[...${CARD}.querySelectorAll('.pbeb-cta')].find(b => b.innerText.startsWith('VIEW TOUCHDOWN TARGETS')).click(); true`);
await sleep(600);
check('VIEW TOUCHDOWN TARGETS opens #tdtargets', (await evalIn('location.hash')) === '#tdtargets');

/* ---- reduced motion --------------------------------------------------------- */
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
clockStart = Date.now();
publish([hit({ pick_id: 'aaaaaaaa-0000-4000-8000-000000000012' })]);
await load(390);
await waitFor(`!!${CARD}`);
const anim = await evalIn(`getComputedStyle(${CARD}.querySelector('.pbeb-tdface')).animationName`);
check('reduced motion: no ring animation', anim === 'none', anim);
await send('Emulation.setEmulatedMedia', { features: [] });

/* ---- the browser writes nothing, and asks for a bounded window -------------- */
check('no browser write request of any kind (POST/PUT/PATCH/DELETE)', writes.length === 0, writes.slice(0, 5).join(' ; '));
const served = new Map();
for (const r of hitsRequests) for (const i of r.ids) served.set(i, (served.get(i) || 0) + 1);
const multi = [...served].filter(([, n]) => n !== 1);
check('id cursor: every published event is served exactly once across the whole run (no re-serve)', served.size > 0 && multi.length === 0,
  `${served.size} events; re-served: ${JSON.stringify(multi)}`);
const modes = hitsRequests.reduce((m, r) => (m[r.mode] = (m[r.mode] || 0) + 1, m), {});
check('bootstrap by since, then after_id: incremental polls outnumber bootstraps', (modes.after_id || 0) > (modes.since || 0), JSON.stringify(modes));
const ownErrors = pageErrors.filter(e => /pbe-breaking|touchdown-hit/.test(e));
check('no page error from the rail or the poller', ownErrors.length === 0, ownErrors.slice(0, 3).join(' | '));

const failed = results.filter(r => !r.ok);
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), widths: WIDTHS, passed: results.length - failed.length, failed: failed.length, results, other_page_errors: pageErrors.filter(e => !/pbe-breaking|touchdown-hit/.test(e)).slice(0, 10) }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
finish(failed.length ? 1 : 0);
