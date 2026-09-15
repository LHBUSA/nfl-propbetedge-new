/* Week transition + Career Ledger browser gate.
 *
 *   node scripts/career-slate-gate.mjs --width=1440 [--shots]
 *
 *   PBE_GATE_TARGET=https://nfl.propbetedge.ai   site under test (default)
 *   PBE_GATE_LOCAL=1     serve THIS tree: static files, /api/player-career,
 *                        /api/nfl-live and the nfl-current season contract run
 *                        in-process (the contract reads the real provider via
 *                        production /api/nfl-live?range). Everything else is
 *                        production.
 *   PBE_GATE_OUT=dir     screenshots
 *
 * Dashboard assertions come from the season contract the page itself read, so
 * the gate is correct in any week: the slate key equals primary_slate.key, no
 * FINAL card is in an open group while the slate has scheduled games, the first
 * card is the next game, the previous week sits folded as RECENT FINALS.
 *
 * DNA assertions, all four products: the ledger mounts under the hero, the label
 * matches the API (CAREER vs TRACKED HISTORY), tabs and selectors work, a season
 * table never widens the page, and the analytical DNA sections are still there.
 * LIVE is exercised with the acceptance fixture (a live DEN @ KC box score over
 * Mahomes' real ledger): the counter must tick every second locally while the
 * network reads stay on the 15s cadence.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.cwd();
const TARGET = process.env.PBE_GATE_TARGET || 'https://nfl.propbetedge.ai';
const ORIGIN = new URL(TARGET).origin;
const GATEWAY = 'https://nfl-api.propbetedge.ai';
const LOCAL = process.env.PBE_GATE_LOCAL === '1';
const WIDTH = Number((process.argv.find(a => a.startsWith('--width=')) || '--width=1440').split('=')[1]);
const SHOTS = process.argv.includes('--shots');
const OUT = process.env.PBE_GATE_OUT || join(REPO, '.gate', 'career-slate');
const TAG = `${LOCAL ? 'local' : 'prod'}-${WIDTH}`;
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9380 + Math.floor(Math.random() * 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-cs-'));
mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, '--headless=new', '--no-first-run', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
function finish(c) { try { chrome.kill(); } catch {} setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(c); }, 300); }
setTimeout(() => { console.error('DEADLINE'); finish(3); }, 900000).unref?.();

/* ---- in-process handlers for LOCAL ------------------------------------------ */
const mods = {};
async function vercelCall(file, url) {
  mods[file] ||= import(pathToFileURL(join(REPO, 'api', file)).href);
  const mod = await mods[file];
  const u = new URL(url);
  const out = { status: 200, headers: {}, body: '' };
  const res = { statusCode: 200, setHeader: (k, v) => { out.headers[k.toLowerCase()] = String(v); }, getHeader: k => out.headers[k.toLowerCase()], end: b => { out.body = b == null ? '' : String(b); } };
  await mod.default({ method: 'GET', query: Object.fromEntries(u.searchParams), headers: {} }, res);
  out.status = res.statusCode;
  return out;
}
let worker = null; const kvMap = new Map();
const KV = { get: async (k, o) => (kvMap.has(k) ? (o?.type === 'json' ? JSON.parse(kvMap.get(k)) : kvMap.get(k)) : null), put: async (k, v) => { kvMap.set(k, v); }, delete: async k => { kvMap.delete(k); } };
async function seasonCall(url) {
  worker ||= (await import(pathToFileURL(join(REPO, 'workers/nfl-current/src/index.js')).href)).default;
  const r = await worker.fetch(new Request(url), { NFL_KV: KV });
  return { status: r.status, headers: { 'content-type': 'application/json' }, body: await r.text() };
}

/* LIVE acceptance fixture, served for Mahomes only when the gate asks. */
let liveFixture = null, careerReads = [];
async function liveCareerBody() {
  const core = await import(pathToFileURL(join(REPO, 'api/_career/ledger-core.js')).href);
  const ledger = JSON.parse(readFileSync(join(REPO, 'data/dist/career-ledger.json'), 'utf8'));
  const s = JSON.parse(readFileSync(join(REPO, 'tests/fixtures/career-summary-401872931-final.json'), 'utf8'));
  const c = s.header.competitions[0];
  c.status = { period: 3, displayClock: '8:21', type: { state: 'in', completed: false } };
  c.competitors.find(x => x.team.abbreviation === 'KC').score = '17';
  const pass = s.boxscore.players.find(t => t.team.abbreviation === 'KC').statistics.find(g => g.name === 'passing').athletes.find(a => a.athlete.id === '3139477');
  pass.stats[0] = '11/19'; pass.stats[1] = '131'; pass.stats[3] = '1';
  const body = core.composeCareer({ player: ledger.players['3139477'], currentSeason: 2026, currentRows: [], currentAvailable: true,
    boxScore: { event: core.eventState(s), line: core.boxScoreLine(s, '3139477') }, boxFetchedAt: new Date().toISOString(), historyMeta: ledger.meta });
  body.today = { event_id: '401872931', state: 'LIVE', kickoff: '2026-09-15T00:15Z' };
  return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
}

const MIME = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json; charset=utf-8' };
async function intercept(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (u.origin === ORIGIN && u.pathname === '/api/player-career') {
    careerReads.push({ at: Date.now(), espn: u.searchParams.get('espn_id') });
    if (liveFixture && u.searchParams.get('espn_id') === '3139477') return liveCareerBody();
    if (LOCAL) return vercelCall('player-career.js', url);
    return null;
  }
  if (!LOCAL) return null;
  if (u.origin === GATEWAY && u.pathname === '/api/season') return seasonCall(url);
  if (u.origin !== ORIGIN) return null;
  if (u.pathname === '/api/nfl-live') return vercelCall('nfl-live.js', url);
  if (u.pathname === '/api/qb-dna/game-context') return vercelCall('qb-dna/game-context.js', url);
  if (u.pathname.startsWith('/api/')) return null;
  const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
  if (!rel || rel.includes('..') || !MIME[extname(rel)]) return null;
  const fp = join(REPO, rel);
  if (!existsSync(fp) || !statSync(fp).isFile()) return null;
  return { status: 200, headers: { 'content-type': MIME[extname(rel)], 'cache-control': 'no-store' }, body: readFileSync(fp) };
}

/* ---- CDP ----------------------------------------------------------------------- */
async function wsUrl() { for (let i = 0; i < 120; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find(x => x.type === 'page' && x.webSocketDebuggerUrl); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(200); } throw new Error('devtools_unreachable'); }
const ws = new WebSocket(await wsUrl());
await new Promise(r => { ws.onopen = r; });
let id = 1; const pending = new Map();
const send = (m, p = {}) => { const n = id++; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => pending.set(n, { resolve: res, reject: rej })); };
let exceptions = [];
ws.onmessage = async ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.method === 'Fetch.requestPaused') {
    let l = null;
    try { l = await intercept(m.params.request.url); } catch (e) { l = { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gate_error: String(e?.message || e) }) }; }
    if (l) send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: l.status, responseHeaders: Object.entries({ ...l.headers, 'access-control-allow-origin': '*' }).map(([name, value]) => ({ name, value })), body: Buffer.from(l.body).toString('base64') }).catch(() => {});
    else send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 200));
};
await send('Runtime.enable'); await send('Page.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: `${ORIGIN}/*`, requestStage: 'Request' }, { urlPattern: `${GATEWAY}/api/season*`, requestStage: 'Request' }] });
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: WIDTH < 600 ? 860 : 1000, deviceScaleFactor: 1, mobile: WIDTH < 600 });
const evalIn = async (expr, ms = 45000) => {
  try { const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }), sleep(ms).then(() => { throw new Error('WEDGED'); })]); return r.result?.value; }
  catch (e) { return { __error: e.message }; }
};
async function shot(name, selector) {
  if (!SHOTS) return;
  await evalIn(`(()=>{document.documentElement.style.scrollBehavior='auto';const e=document.querySelector(${JSON.stringify(selector)});if(e)e.scrollIntoView({block:'start'});window.scrollBy(0,-70)})()`);
  await sleep(700);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const f = join(OUT, `${TAG}-${name}.png`);
  writeFileSync(f, Buffer.from(r.data, 'base64'));
  console.log(`  shot ${f}`);
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };

console.log(`career + slate gate -> ${TARGET} ${LOCAL ? '(LOCAL tree)' : '(production)'} @${WIDTH}px\n`);
await send('Page.navigate', { url: `${TARGET}/#home` });
await sleep(4000);

/* ---- dashboard -------------------------------------------------------------------- */
async function waitFor(expr, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await evalIn(expr, 8000); if (v && !v.__error) return v; await sleep(500); } return null; }
const ready = await waitFor(`(()=>{const d=window.PBESeason&&PBESeason.data;const s=document.querySelector('.pbecc-slate');return d&&s&&s.querySelector('.pbecc-game')?true:null})()`, 45000);
check('dashboard slate rendered', ready);
await sleep(2500);
const home = await evalIn(`(()=>{
  const d=PBESeason.data, ps=d.primary_slate, pv=d.previous_slate;
  const slate=document.querySelector('.pbecc-slate');
  const open=[...slate.querySelectorAll(':scope > .pbecc-group:not(details) .pbecc-game')];
  const folds=[...slate.querySelectorAll('details.pbecc-group')].map(x=>({key:x.dataset.ccFold,open:x.open,label:x.querySelector('summary').textContent.trim()}));
  return {contract:{current_week:d.current_week,primary_slate_week:d.primary_slate_week,key:ps&&ps.key,label:ps&&ps.label,state:ps&&ps.state,scheduled:ps&&ps.counts_in_window.scheduled,prev:pv&&pv.key,prevLabel:pv&&pv.label,next:d.next_game&&d.next_game.id,nextName:d.next_game&&d.next_game.name},
    key:slate.dataset.slateKey, source:slate.dataset.slateSource,
    eyebrow:slate.querySelector('.pbecc-eyebrow').textContent.trim(), title:slate.querySelector('h2').textContent.trim(),
    openCards:open.map(x=>({id:x.dataset.game,cls:x.className})), groups:[...slate.querySelectorAll(':scope > .pbecc-group')].map(x=>(x.querySelector('h3')||{}).textContent),
    folds, hero:(document.querySelector('.pbe7-hero [data-cast]')||{}).dataset?.cast||null, heroPill:(document.querySelector('.pbe7-live-pill')||{}).textContent||'',
    strip:(document.querySelector('[data-pbe-season-strip] .pbe-season-badge')||{}).textContent||'',
    overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}
})()`);
console.log(JSON.stringify(home, null, 1));
if (home && !home.__error) {
  const c = home.contract;
  check('contract exposes primary_slate (additive)', c.key && c.primary_slate_week != null, c);
  check('dashboard slate is the contract primary slate', home.key === c.key, `${home.key} vs ${c.key} (source ${home.source})`);
  check('eyebrow names the slate and its state', home.eyebrow.startsWith(`${c.label} · `), home.eyebrow);
  if (c.scheduled > 0) check('no FINAL card in an open group while games remain to play', home.openCards.every(x => !/is-final/.test(x.cls)), home.openCards.filter(x => /is-final/.test(x.cls)).length + ' finals open');
  if (c.state !== 'LIVE') check('first open card is the next game', home.openCards[0]?.id === c.next, `${home.openCards[0]?.id} vs ${c.next} ${c.nextName}`);
  check('featured hero is not a finished game while one is scheduled', c.scheduled ? home.hero === c.next || /LIVE/.test(home.heroPill) : true, `${home.hero} ${home.heroPill}`);
  if (c.prev) {
    const f = home.folds.find(x => x.key === 'previous');
    check('previous week is RECENT FINALS, folded by default', f && !f.open && f.label.includes(`RECENT FINALS · ${c.prevLabel}`), f);
  }
  check('season strip names the primary slate', home.strip.includes(c.label), home.strip);
  check('dashboard: no horizontal overflow', home.overflow <= 0, home.overflow);
  await shot('dashboard-slate', '.pbecc-slate');
  if (c.prev) {
    await evalIn(`(()=>{const d=document.querySelector('.pbecc-slate details[data-cc-fold="previous"]');d.open=true;return true})()`);
    const opened = await waitFor(`(()=>{const d=document.querySelector('.pbecc-slate details[data-cc-fold="previous"]');const n=d&&d.querySelectorAll('.pbecc-game').length;return n?{n,finals:d.querySelectorAll('.pbecc-game.is-final').length,open:d.open}:null})()`, 20000);
    check('RECENT FINALS opens on request with only final games', opened && opened.n > 0 && opened.n === opened.finals, opened);
    await shot('dashboard-recent-finals', '.pbecc-slate details[data-cc-fold="previous"]');
  }
}

if (!process.argv.includes('--dashboard-only')) {
/* ---- Player DNA ------------------------------------------------------------------- */
const CASES = [
  ['qbdna', 'PBEQBDna', '00-0034857', '3918298', 'QB Josh Allen (BUF next-game bug)'],
  ['qbdna', 'PBEQBDna', '00-0019596', '2330', 'QB full history (Brady)'],
  ['qbdna', 'PBEQBDna', '00-0023459', '8439', 'QB team change (Rodgers)'],
  ['rbdna', 'PBERBDna', '00-0032764', '3043078', 'RB full history + team change (Henry)'],
  ['wrdna', 'PBEWRDna', '00-0030564', '15795', 'WR full history, 5 teams (Hopkins)'],
  ['wrdna', 'PBEWRDna', '00-0033536', '3045138', 'WR duplicate name (Mike Williams 2017)'],
  ['tedna', 'PBETEDna', '00-0027061', '12537', 'TE full history, 6 teams (Jared Cook)'],
  ['tedna', 'PBETEDna', '00-0030506', '15847', 'TE missing history (Kelce)']
];
const READ = `(()=>{const s=document.querySelector('[data-pbe-career-ledger]');if(!s)return null;
  const hero=document.querySelector('.q2-hero');
  return {label:s.dataset.clLabel||null, espn:s.dataset.clEspn||null, underHero:!!hero&&hero.nextElementSibling===s,
    eyebrow:(s.querySelector('.pbe-car-eyebrow')||{}).textContent||'', tiles:[...s.querySelectorAll('.pbe-car-tiles dd')].map(x=>x.textContent).slice(0,12),
    tabs:[...s.querySelectorAll('[data-cl-tab]')].map(x=>x.textContent), why:(s.querySelector('.pbe-car-why')||{}).textContent||'',
    currentLayer:!!document.querySelector('[data-pbe-current-layer]'), analytics:document.querySelectorAll('.q2 section, .q2 .q2-card, .q2 [class*="q2-"]').length,
    height:Math.round(s.getBoundingClientRect().height), overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}})()`;
for (const [route, global, gsis, espn, label] of CASES) {
  exceptions = [];
  await evalIn(`(async()=>{App.nav('${route}');await new Promise(r=>setTimeout(r,1500));const m=window.${global};m.state.playerId='${gsis}';m.state.dna=null;m.state.lab=null;m.state.cmp=null;m.state.ctx=null;m.state.ctxCmp=null;m.state.eventId=null;await m.load();return true})()`, 60000);
  const r = await waitFor(`(()=>{const v=${READ};return v&&v.espn==='${espn}'&&v.tiles.length?v:null})()`, 40000);
  const api = await evalIn(`fetch('/api/player-career?espn_id=${espn}').then(r=>r.json()).then(b=>({label:b.label,games:b.totals&&b.totals.regular_season.games,teams:b.player&&b.player.teams,complete:b.coverage&&b.coverage.complete,missing:(b.coverage&&b.coverage.missing_seasons||[]).map(m=>m.season)}))`);
  check(`${label}: ledger mounted under the hero`, r && r.underHero, r && { underHero: r.underHero, eyebrow: r.eyebrow });
  check(`${label}: label matches API (${api?.label})`, r && api && r.label === api.label && r.eyebrow.trim() === api.label, { page: r?.label, api });
  check(`${label}: regular-season games tile = API total`, r && api && r.tiles[0] === Number(api.games).toLocaleString('en-US'), { tile: r?.tiles?.[0], api: api?.games });
  /* NEXT GAME TRUTH: the hero's next game comes from the schedule authority. */
  const nx = await waitFor(`(()=>{const m=window.${global};const p=m.state.dna&&m.state.dna.player;const team=p&&((p.team&&p.team.abbreviation)||p.current_team);
    const ts=PBESeason.data&&PBESeason.data.team_schedule;const sched=ts&&team?ts[team]:undefined;const el=document.querySelector('.q2-hero-next');
    if(!el||!ts)return null;return {team,active:!!(p&&m.state.dna.player.active_2026),sched:sched?{next:sched.next&&sched.next.name,kick:sched.next&&sched.next.kickoff_utc}:null,text:el.textContent.replace(/\\s+/g,' ').trim(),mkt:(el.querySelector('.q2-hero-next-mkt')||{}).textContent||null}})()`, 25000);
  if (nx && nx.sched && nx.sched.next) {
    const [aw, hm] = nx.sched.next.split(' @ ');
    const day = new Date(nx.sched.kick).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).toUpperCase();
    check(`${label}: hero NEXT is the scheduled ${nx.sched.next} (${day}), market state separate`,
      nx.text.includes(aw) && nx.text.includes(hm) && nx.text.includes(day) && !/no (upcoming|scheduled) game/i.test(nx.text) && /Market (open|unavailable)/.test(nx.text), nx);
  } else if (espn === '3918298' || (nx && nx.active)) {
    check(`${label}: hero NEXT resolved from the schedule authority`, false, nx);
  }
  if (espn === '15847') check(`${label}: says TRACKED HISTORY and names the gap`, r && r.label === 'TRACKED HISTORY' && /2013/.test(r.why), r?.why);
  check(`${label}: existing DNA analytics + current layer still render`, r && r.currentLayer && r.analytics > 5, { currentLayer: r?.currentLayer, analytics: r?.analytics });
  check(`${label}: no horizontal overflow`, r && r.overflow <= 0, r?.overflow);
  if (exceptions.length) check(`${label}: no page exceptions`, false, exceptions.slice(0, 3));
  if (espn === '2330' || espn === '15847' || espn === '3043078' || espn === '15795' || espn === '12537') {
    const slug = { '2330': 'qb-brady', '3043078': 'rb-henry', '15795': 'wr-hopkins', '12537': 'te-cook', '15847': 'te-kelce-tracked' }[espn];
    await shot(`${slug}-career`, '[data-pbe-career-ledger]');
    if (espn === '2330' || espn === '12537') {
      await evalIn(`document.querySelector('[data-pbe-career-ledger] [data-cl-tab="seasons"]').click()`);
      await sleep(400);
      const seasons = await evalIn(`(()=>{const s=document.querySelector('[data-pbe-career-ledger]');const t=s.querySelector('.pbe-car-table');const sc=s.querySelector('.pbe-car-scroll');return {rows:t?t.tBodies[0].rows.length:0,scrollInside:sc?sc.scrollWidth>=sc.clientWidth:false,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}})()`);
      check(`${label}: SEASONS table rows, scrolls inside its box`, seasons && seasons.rows > 5 && seasons.overflow <= 0, seasons);
      await shot(`${slug}-seasons`, '[data-pbe-career-ledger]');
      await evalIn(`document.querySelector('[data-pbe-career-ledger] [data-cl-tab="log"]').click()`);
      await sleep(400);
      const log1 = await evalIn(`(()=>{const s=document.querySelector('[data-pbe-career-ledger]');const sel=s.querySelector('[data-cl-logseason]');return {options:sel?sel.options.length:0,rows:s.querySelector('.pbe-car-table')?s.querySelector('.pbe-car-table').tBodies[0].rows.length:0,season:sel&&sel.value}})()`);
      const first = await evalIn(`(()=>{const sel=document.querySelector('[data-pbe-career-ledger] [data-cl-logseason]');sel.value=sel.options[sel.options.length-1].value;sel.dispatchEvent(new Event('change',{bubbles:true}));return sel.value})()`);
      await sleep(400);
      const log2 = await evalIn(`(()=>{const s=document.querySelector('[data-pbe-career-ledger]');return {rows:s.querySelector('.pbe-car-table').tBodies[0].rows.length,season:s.querySelector('[data-cl-logseason]').value,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}})()`);
      check(`${label}: GAME LOG is one season at a time (no wall of rows), selector switches seasons`, log1 && log1.rows > 0 && log1.rows <= 25 && log2 && log2.season === String(first) && log2.rows > 0 && log2.rows <= 25 && log2.overflow <= 0, { log1, log2 });
      await evalIn(`(()=>{const b=document.querySelector('[data-pbe-career-ledger] [data-cl-logtype="REG"]');b&&b.click();return true})()`);
      await shot(`${slug}-gamelog`, '[data-pbe-career-ledger]');
      await evalIn(`document.querySelector('[data-pbe-career-ledger] [data-cl-tab="career"]').click()`);
    }
  }
}

/* ---- LIVE fixture: counter ticks locally, network stays on cadence ------------------- */
liveFixture = true; careerReads = [];
await evalIn(`(async()=>{App.nav('qbdna');await new Promise(r=>setTimeout(r,1200));const m=window.PBEQBDna;m.state.playerId='00-0033873';m.state.dna=null;m.state.ctx=null;m.state.eventId=null;await m.load();return true})()`, 60000);
const live1 = await waitFor(`(()=>{const s=document.querySelector('[data-pbe-career-ledger]');const a=s&&s.querySelector('[data-cl-age]');return a&&s.dataset.clEspn==='3139477'?{age:a.textContent,banner:s.querySelector('.pbe-car-live').textContent.replace(/\\s+/g,' ').trim(),tiles:[...s.querySelectorAll('.pbe-car-tiles dd')].map(x=>x.textContent).slice(0,6)}:null})()`, 40000);
check('LIVE fixture: LIVE CAREER TOTALS banner with quarter + clock', live1 && /LIVE CAREER TOTALS/.test(live1.banner) && /Q3 · 8:21/.test(live1.banner), live1);
await shot('qb-mahomes-live-career', '[data-pbe-career-ledger]');
const t0 = careerReads.length, a0 = await evalIn(`document.querySelector('[data-pbe-career-ledger] [data-cl-age]').textContent`);
await sleep(4200);
const a1 = await evalIn(`document.querySelector('[data-pbe-career-ledger] [data-cl-age]').textContent`);
check('LIVE fixture: UPDATED counter advances every second locally', a0 !== a1 && /UPDATED \d+s AGO/.test(a1), `${a0} -> ${a1}`);
check('LIVE fixture: no network read during 4s of ticking (no one-second fetch loop)', careerReads.length === t0, careerReads.length - t0);
await sleep(31000);
const readsIn35 = careerReads.length - t0;
check('LIVE fixture: re-reads ride the 15s cadence (2 reads in ~35s, never ~35)', readsIn35 >= 1 && readsIn35 <= 3, readsIn35);
await evalIn(`App.nav('home')`);
careerReads = []; await sleep(20000);
check('LIVE fixture: polling stops when the route changes', careerReads.length === 0, careerReads.length);
liveFixture = false;

}

const failed = results.filter(r => !r.ok);
writeFileSync(join(OUT, `${TAG}-results.json`), JSON.stringify({ target: TARGET, local: LOCAL, width: WIDTH, at: new Date().toISOString(), results }, null, 1));
console.log(`\n${results.length - failed.length}/${results.length} passed @${WIDTH}${failed.length ? ` — FAILED: ${failed.map(f => f.name).join(' | ')}` : ''}`);
finish(failed.length ? 1 : 0);
