/* PBEcast selected-game gate (browser, real clicks).
 *
 *   node scripts/pbecast-selection-gate.mjs --width=1440 [--shots]
 *
 *   PBE_GATE_TARGET=https://nfl.propbetedge.ai   site under test (default)
 *   PBE_GATE_LOCAL=1   serve THIS tree's static files; every /api read still
 *                      goes to the target (the routing fix changes no API)
 *   PBE_GATE_OUT=dir   screenshots
 *
 * The invariant: a game the reader explicitly chose is the game PBEcast shows,
 * whatever today's board, the undated scoreboard, a persisted game or the
 * provider week say. Every assertion reads the page: the route, PBEcastV6
 * state.activeId, the rendered hero's game id and its team abbreviations, and
 * every selection is re-checked after the board lane has run and after a
 * manual refresh (the path that used to overwrite it).
 *
 * Games are chosen at run time from the season contract the page itself read,
 * so the gate is valid in any week. A scenario that needs a state the calendar
 * does not provide (a real LIVE game) is exercised with a board fixture and
 * says so.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

const REPO = process.cwd();
const TARGET = process.env.PBE_GATE_TARGET || 'https://nfl.propbetedge.ai';
const ORIGIN = new URL(TARGET).origin;
const LOCAL = process.env.PBE_GATE_LOCAL === '1';
const WIDTH = Number((process.argv.find(a => a.startsWith('--width=')) || '--width=1440').split('=')[1]);
const SHOTS = process.argv.includes('--shots');
const OUT = process.env.PBE_GATE_OUT || join(REPO, '.gate', 'pbecast-selection');
const TAG = `${LOCAL ? 'local' : 'prod'}-${WIDTH}`;
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9280 + Math.floor(Math.random() * 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-sel-'));
mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, '--headless=new', '--no-first-run', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
function finish(c) { try { chrome.kill(); } catch {} setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(c); }, 300); }
setTimeout(() => { console.error('DEADLINE'); finish(3); }, 1500000).unref?.();

/* ---- interception: LOCAL static tree, and the LIVE board fixture ----------- */
const MIME = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json; charset=utf-8' };
let liveFixtureId = null;
async function intercept(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (u.origin !== ORIGIN) return null;
  if (u.pathname === '/api/nfl-live' && liveFixtureId && !u.searchParams.get('event')) {
    /* one scheduled game on every board read is marked LIVE */
    const r = await fetch(`${TARGET}${u.pathname}${u.search}`, { headers: { accept: 'application/json' } });
    const body = await r.json();
    for (const g of Array.isArray(body?.games) ? body.games : []) if (String(g.id) === liveFixtureId) g.status = { ...g.status, semantics: 'LIVE', short_detail: 'Q2 7:31 (fixture)', period: 2, clock: '7:31' };
    return { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
  }
  if (!LOCAL || u.pathname.startsWith('/api/')) return null;
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
let seq = 1; const pending = new Map();
const send = (m, p = {}) => { const n = seq++; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => pending.set(n, { resolve: res, reject: rej })); };
const exceptions = [];
ws.onmessage = async ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.method === 'Fetch.requestPaused') {
    let l = null;
    try { l = await intercept(m.params.request.url); } catch (e) { l = null; }
    if (l) send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: l.status, responseHeaders: Object.entries({ ...l.headers, 'access-control-allow-origin': '*' }).map(([name, value]) => ({ name, value })), body: Buffer.from(l.body).toString('base64') }).catch(() => {});
    else send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 200));
};
await send('Runtime.enable'); await send('Page.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: `${ORIGIN}/*`, requestStage: 'Request' }] });
const MOBILE = WIDTH < 600;
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: MOBILE ? 860 : 1000, deviceScaleFactor: 1, mobile: MOBILE });
const evalIn = async (expr, ms = 45000) => {
  try { const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }), sleep(ms).then(() => { throw new Error('WEDGED'); })]); return r.result?.value; }
  catch (e) { return { __error: e.message }; }
};
async function waitFor(expr, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await evalIn(expr, 8000); if (v && !v.__error) return v; await sleep(400); } return null; }
async function shot(name) {
  if (!SHOTS) return;
  /* the selected game's hero, clear of the sticky header */
  await evalIn(`(()=>{document.documentElement.style.scrollBehavior='auto';const h=document.querySelector('.pbecast6 [data-cast6-hero]');if(h){h.scrollIntoView({block:'start'});window.scrollBy(0,-${MOBILE ? 60 : 120})}else window.scrollTo(0,0);return 1})()`);
  await sleep(900);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const f = join(OUT, `${TAG}-${name}.png`);
  writeFileSync(f, Buffer.from(r.data, 'base64'));
  console.log(`  shot ${f}`);
}
/* A real pointer click: open any fold holding the element (as a reader would),
   scroll it to the middle, confirm it is the topmost element at its centre,
   then press and release there. */
async function realClick(selectorExpr, label) {
  const box = await evalIn(`(()=>{document.documentElement.style.scrollBehavior='auto';const el=${selectorExpr};if(!el)return null;for(let d=el.closest('details');d;d=d.parentElement&&d.parentElement.closest('details'))d.open=true;el.scrollIntoView({block:'center',inline:'center'});const r=el.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;const top=document.elementFromPoint(x,y);return {x,y,hit:!!top&&(top===el||el.contains(top))}})()`);
  if (!box || box.__error) return { ok: false, why: `${label}: element not found` };
  await sleep(250);
  /* The dashboard reflows while modules land (and every few seconds on a LIVE
     board), so measure and press in one beat, and re-measure on a miss. */
  let again = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const scroll = attempt % 2 ? 'const r0=el.getBoundingClientRect();window.scrollBy(0,r0.top-innerHeight/3);' : "el.scrollIntoView({block:'center'});";
    again = await evalIn(`(()=>{const el=${selectorExpr};if(!el)return null;${scroll}const r=el.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;const top=document.elementFromPoint(x,y);return {x,y,hit:!!top&&(top===el||el.contains(top))}})()`);
    /* press only once the element has stopped moving (cards reflow as weather and market rows land) */
    if (again?.hit) { await sleep(400); const still = await evalIn(`(()=>{const el=${selectorExpr};const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`); if (still && Math.abs(still.x - again.x) < 1 && Math.abs(still.y - again.y) < 1) break; again = null; }
    await sleep(700);
  }
  if (!again?.hit) { const cov = await evalIn(`(()=>{const el=${selectorExpr};const r=el.getBoundingClientRect();const top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);const host=top&&top.closest('section,aside,header,nav,[class]');return top?{top:top.outerHTML.slice(0,160),host:host?host.className.toString().slice(0,80):null,rect:[r.left,r.top,r.width,r.height].map(Math.round),vh:innerHeight,elParent:el.parentElement.className.toString().slice(0,60)}:null})()`); if (SHOTS) { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, `${TAG}-click-miss-${label.replace(/\W+/g, '-')}.png`), Buffer.from(r.data, 'base64')); } return { ok: false, why: `${label}: covered at its centre ${JSON.stringify(cov)}` }; }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: again.x, y: again.y, button: 'left', clickCount: 1 });
  return { ok: true };
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
const note = (name, detail) => console.log(`NOTE  ${name}${detail ? `  — ${JSON.stringify(detail)}` : ''}`);

/* What PBEcast is showing, read from the page. */
const READ_CAST = `(()=>{const s=window.PBEcastV6&&PBEcastV6.state;const hero=document.querySelector('.pbecast6 .cast6-hero');
  const teams=hero?[...hero.querySelectorAll('.cast6-team b')].map(b=>b.textContent.trim()):[];
  return {route:window.App&&App.current,active:s?String(s.activeId||''):null,explicit:s?!!s.explicit:null,
    rendered:hero?(hero.dataset.cast6Game||(s.detail&&s.detail.game&&String(s.detail.game.id))||null):null,
    teams, kickoff:!!(hero&&hero.querySelector('.is-kickoff')), heroText:hero?hero.textContent.replace(/\\s+/g,' ').slice(0,160):'',
    unavailable:(document.querySelector('[data-cast6-unavailable]')||{}).dataset?.cast6Unavailable||null,
    boardReady:!!(s&&s.scoreboard), boardBusy:!!(window.PBEcastV6&&PBEcastV6.lanes&&PBEcastV6.lanes.board.busy),
    railActive:(document.querySelector('.pbecast6 [data-cast6-rail] [data-game].active')||{}).dataset?.game||null,
    stateUrl:window.PBEcastV6&&PBEcastV6.stateUrl?PBEcastV6.stateUrl():null, fast:s&&s.fastGame?String(s.fastGame.id):null, error:s?s.error:null,
    overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth}})()`;

/* Wait until PBEcast has painted a game and its board lane has settled, then
   let one more beat pass and force a manual refresh: the selection must still
   be the expected game afterwards. */
async function assertSelected(label, want, { expectTeams = null, scheduled = false, shotName = null } = {}) {
  const first = await waitFor(`(()=>{const v=${READ_CAST};return v.route==='pbecast'&&v.rendered&&v.boardReady&&!v.boardBusy?v:null})()`, 30000);
  await sleep(2500);
  await evalIn(`window.PBEcastV6&&PBEcastV6.refresh(true).then(()=>1)`, 30000);
  await sleep(1500);
  const v = await evalIn(READ_CAST);
  check(`${label}: route is pbecast`, v?.route === 'pbecast', v?.route);
  check(`${label}: PBEcastV6.state.activeId is ${want}`, v?.active === want, { first: first?.active, after_refresh: v?.active });
  check(`${label}: rendered hero is game ${want}`, v?.rendered === want, { rendered: v?.rendered, hero: v?.heroText });
  if (expectTeams) check(`${label}: hero teams ${expectTeams.join(' @ ')}`, v && v.teams.join('@') === expectTeams.join('@'), v?.teams);
  if (scheduled) check(`${label}: scheduled hero shows the kickoff, not a score`, v?.kickoff, v?.heroText);
  check(`${label}: no horizontal overflow`, v && v.overflow <= 0, v?.overflow);
  if (shotName) await shot(shotName);
  return v;
}
/* A hash-only navigation is same-document; hop through about:blank so every
   scenario starts from a real page load. */
async function hardNav(hash) {
  await send('Page.navigate', { url: 'about:blank' }); await sleep(300);
  await send('Page.navigate', { url: `${TARGET}/${hash}` }); await sleep(3500);
}
async function freshSession(hash = '#home', { keepLocal = false } = {}) {
  await evalIn(`(()=>{try{sessionStorage.clear();${keepLocal ? '' : "localStorage.removeItem('pbe_nfl_cast_active_v6');"}}catch(e){};return 1})()`);
  await hardNav(hash);
}

console.log(`pbecast selection gate -> ${TARGET} ${LOCAL ? '(LOCAL tree)' : '(production)'} @${WIDTH}px\n`);
await send('Page.navigate', { url: `${TARGET}/#home` });
await sleep(3000);
await freshSession('#home');

/* ---- the week, from the contract the page read ------------------------------ */
const contract = await waitFor(`(()=>{const d=window.PBESeason&&PBESeason.data;return d&&d.primary_slate&&d.primary_slate.dates?{ps:d.primary_slate,pv:d.previous_slate,next:d.next_game,latest:d.latest_final}:null})()`, 45000);
check('season contract loaded', contract);
if (!contract) finish(1);
const readWeek = dates => evalIn(`fetch('/api/nfl-live?range=${dates}&view=slate').then(r=>r.json()).then(b=>(b.games||[]).map(g=>({id:String(g.id),sem:g.status&&g.status.semantics,date:g.date,week:g.week,away:g.teams.away.abbreviation,home:g.teams.home.abbreviation,awayName:g.teams.away.display_name,homeName:g.teams.home.display_name})))`);
const week = (await readWeek(contract.ps.dates)) || [];
const prevWeek = contract.pv?.dates ? (await readWeek(contract.pv.dates)) || [] : [];
const byId = new Map([...prevWeek, ...week].map(g => [g.id, g]));
const WANT = [['DET', 'BUF'], ['PIT', 'NE'], ['PHI', 'TEN'], ['MIA', 'SF']];
const upcoming = week.filter(g => g.sem !== 'FINAL').sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
const picks = [];
for (const [a, h] of WANT) { const g = upcoming.find(x => x.away === a && x.home === h); if (g) picks.push(g); }
for (const g of upcoming) { if (picks.length >= 4) break; if (!picks.includes(g)) picks.push(g); }
check('at least four playable games in the primary slate', picks.length >= 4, picks.map(g => `${g.away}@${g.home}`));
/* PBE_GATE_ONLY=1,8 runs only those scenarios (3 includes 4 and 5). */
const ONLY = new Set(String(process.env.PBE_GATE_ONLY || '').split(',').filter(Boolean));
const run = n => !ONLY.size || ONLY.has(String(n));
const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/* ---- 1. Dashboard slate cards ------------------------------------------------ */
if (run(1)) {
for (const g of picks.slice(0, 4)) {
  await freshSession('#home');
  const ready = await waitFor(`document.querySelector('.pbecc-slate .pbecc-cast[data-cast="${g.id}"]')?1:null`, 40000);
  if (!ready) { check(`Dashboard ${g.away}@${g.home}: card present`, false); continue; }
  const c = await realClick(`document.querySelector('.pbecc-slate .pbecc-cast[data-cast="${g.id}"]')`, 'dashboard card');
  check(`Dashboard ${g.away}@${g.home}: card clicked`, c.ok, c.why);
  const v = await assertSelected(`Dashboard ${g.away}@${g.home}`, g.id, { expectTeams: [g.away, g.home], scheduled: g.sem === 'SCHEDULE', shotName: g === picks[0] ? `dashboard-${g.away}-${g.home}` : null });
  if (g.date.slice(0, 10) !== todayET && g.sem !== 'LIVE') {
    const fast = await waitFor(`(()=>{const s=PBEcastV6.state;return s.fastGame&&String(s.fastGame.id)==='${g.id}'?String(s.fastGame.id):null})()`, 20000);
    check(`Dashboard ${g.away}@${g.home}: fast state lane reads the game on its own date`, fast === g.id && /&date=\d{8}/.test(v?.stateUrl || ''), { stateUrl: v?.stateUrl, error: v?.error });
  }
}
}

/* ---- 2. Games page cards ----------------------------------------------------- */
if (run(2)) {
const gamesPicks = [...picks.slice(1, 4), picks[0]];
for (const g of gamesPicks) {
  await freshSession('#games');
  const sel = `(()=>{const cards=[...document.querySelectorAll('.pbe25-card')];const card=cards.find(c=>c.dataset.espnEvent==='${g.id}')||cards.find(c=>{const t=c.textContent;return t.includes(${JSON.stringify(g.awayName)})&&t.includes(${JSON.stringify(g.homeName)})});if(!card)return null;return card.querySelector('[data-cast-event]')||card.querySelector('[data-pbe-game-route="pbecast"]')||[...card.querySelectorAll('button')].find(b=>/Game Center|Preview|Replay/.test(b.textContent))||null})()`;
  const ready = await waitFor(`${sel}?1:null`, 40000);
  check(`Games ${g.away}@${g.home}: card has a PBEcast button`, ready);
  if (!ready) continue;
  const c = await realClick(sel, 'games card');
  check(`Games ${g.away}@${g.home}: card clicked`, c.ok, c.why);
  await assertSelected(`Games ${g.away}@${g.home}`, g.id, { expectTeams: [g.away, g.home], scheduled: g.sem === 'SCHEDULE', shotName: g === gamesPicks[0] ? `games-${g.away}-${g.home}` : null });
}
}

/* ---- 3. Persisted final must not outrank a fresh explicit click --------------- */
if (run(3)) {
const latestFinal = contract.latest?.id ? String(contract.latest.id) : prevWeek.find(x => x.sem === 'FINAL')?.id;
if (latestFinal) {
  await freshSession('#home');
  await evalIn(`(()=>{localStorage.setItem('pbe_nfl_cast_active_v6','${latestFinal}');return 1})()`);
  await hardNav('#home');
  const g = picks[1];
  await waitFor(`document.querySelector('.pbecc-slate .pbecc-cast[data-cast="${g.id}"]')?1:null`, 40000);
  const c = await realClick(`document.querySelector('.pbecc-slate .pbecc-cast[data-cast="${g.id}"]')`, 'dashboard card');
  check('Persisted final in ACTIVE_KEY: card clicked', c.ok, c.why);
  await assertSelected(`Persisted final ${latestFinal} in ACTIVE_KEY, click ${g.away}@${g.home}`, g.id, { expectTeams: [g.away, g.home] });

  /* ---- 4. Revisit in the same session: another route and back, then a reload */
  await evalIn(`App.nav('games')`); await sleep(2500);
  await evalIn(`App.nav('pbecast')`);
  await assertSelected(`Revisit via another route keeps ${g.away}@${g.home}`, g.id, { expectTeams: [g.away, g.home] });
  await hardNav('#pbecast');
  await assertSelected(`Reload in the same session keeps ${g.away}@${g.home}`, g.id, { expectTeams: [g.away, g.home] });

  /* ---- 5. Direct visit, no selection: default mode, the persisted final does not win */
  await freshSession('#pbecast', { keepLocal: true });
  await evalIn(`(()=>{localStorage.setItem('pbe_nfl_cast_active_v6','${latestFinal}');return 1})()`);
  await hardNav('#pbecast');
  const d = await waitFor(`(()=>{const v=${READ_CAST};return v.route==='pbecast'&&v.rendered&&v.boardReady?v:null})()`, 40000);
  await sleep(2000);
  const dv = await evalIn(READ_CAST);
  const liveNow = week.filter(x => x.sem === 'LIVE').map(x => x.id);
  const expected = liveNow.length ? liveNow : [String(contract.next?.id || upcoming[0]?.id)];
  check('Direct visit with no selection: default mode (not explicit)', dv && dv.explicit === false, dv?.explicit);
  check(`Direct visit with no selection: shows ${liveNow.length ? 'a LIVE game' : `the next game ${contract.next?.name || ''}`}, not the persisted final`, dv && expected.includes(dv.active) && dv.rendered === dv.active && dv.active !== latestFinal, { active: dv?.active, expected, persisted: latestFinal });
  if (d) await shot('direct-visit-default');
}
}

/* ---- 6. Explicit recent final (previous week, a different date) -------------- */
if (run(6)) {
const finalPick = prevWeek.filter(x => x.sem === 'FINAL').sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0];
if (finalPick) {
  await freshSession('#home');
  const opened = await waitFor(`(()=>{const f=document.querySelector('.pbecc-slate details[data-cc-fold="previous"]');if(!f)return null;f.open=true;return f.querySelector('.pbecc-cast[data-cast="${finalPick.id}"]')?1:null})()`, 40000);
  if (opened) {
    const c = await realClick(`document.querySelector('.pbecc-slate details[data-cc-fold="previous"] .pbecc-cast[data-cast="${finalPick.id}"]')`, 'recent final');
    check(`Recent final ${finalPick.away}@${finalPick.home}: clicked`, c.ok, c.why);
  } else {
    note('RECENT FINALS fold did not list the game; opening through the handoff', finalPick.id);
    await evalIn(`window.PBEGameHandoff?PBEGameHandoff.open('${finalPick.id}',{source:'gate'}):(sessionStorage.setItem('pbe.pbecast.focus',JSON.stringify({game_id:'${finalPick.id}'})),App.nav('pbecast'))`);
  }
  const v = await assertSelected(`Explicit recent final ${finalPick.away}@${finalPick.home} (${finalPick.date.slice(0, 10)})`, finalPick.id, { expectTeams: [finalPick.away, finalPick.home] });
  check(`Explicit recent final: hero reads FINAL`, v && /FINAL/i.test(v.heroText), v?.heroText);
}
}

/* ---- 7. Top score rail ------------------------------------------------------- */
if (run(7)) {
await freshSession('#games');
const railIds = await waitFor(`(()=>{const b=[...document.querySelectorAll('.pbes-score[data-cast-game]')];return b.length?b.map(x=>x.dataset.castGame):null})()`, 30000);
if (railIds?.length) {
  const rid = railIds[Math.min(2, railIds.length - 1)];
  const c = await realClick(`document.querySelector('.pbes-score[data-cast-game="${rid}"]')`, 'rail');
  if (!c.ok) { note('rail item not clickable at its centre (carousel); synthetic click', c.why); await evalIn(`document.querySelector('.pbes-score[data-cast-game="${rid}"]').click()`); }
  const rg = byId.get(rid);
  await assertSelected(`Top rail ${rg ? `${rg.away}@${rg.home}` : rid}`, rid, { expectTeams: rg ? [rg.away, rg.home] : null });
} else note('top score rail shows no games at this width', null);
}

/* ---- 8. LIVE: default mode picks it; an explicit other game is not pulled to it */
if (run(8)) {
const liveReal = week.find(x => x.sem === 'LIVE');
const liveTarget = liveReal || upcoming.find(x => x.id !== picks[0].id && x.id !== picks[2].id);
if (!liveReal) { liveFixtureId = liveTarget.id; note('no real LIVE game in the slate: board fixture marks one LIVE', `${liveTarget.away}@${liveTarget.home} ${liveTarget.id}`); }
await freshSession('#pbecast');
const dl = await waitFor(`(()=>{const v=${READ_CAST};return v.route==='pbecast'&&v.boardReady&&v.active==='${liveTarget.id}'?v:null})()`, 40000);
const dlv = dl || await evalIn(READ_CAST);
check(`LIVE${liveReal ? '' : ' (fixture)'}: default mode opens the live game ${liveTarget.away}@${liveTarget.home}`, dlv?.active === liveTarget.id, { active: dlv?.active });
await freshSession('#home');
const other = picks[2];
await waitFor(`document.querySelector('.pbecc-slate .pbecc-cast[data-cast="${other.id}"]')?1:null`, 40000);
const oc = await realClick(`document.querySelector('.pbecc-slate .pbecc-cast[data-cast="${other.id}"]')`, 'dashboard card');
check(`LIVE${liveReal ? '' : ' (fixture)'} elsewhere: card clicked`, oc.ok, oc.why);
await assertSelected(`LIVE${liveReal ? '' : ' (fixture)'} game on the board, explicit ${other.away}@${other.home} stays`, other.id, { expectTeams: [other.away, other.home] });
liveFixtureId = null;
}

/* ---- 9. An id the source cannot serve: honest unavailable, never a substitute */
if (run(9)) {
await freshSession('#home');
await waitFor(`window.PBEGameHandoff||window.App?1:null`, 20000);
await evalIn(`window.PBEGameHandoff?PBEGameHandoff.open('401999999',{source:'gate'}):(sessionStorage.setItem('pbe.pbecast.focus',JSON.stringify({game_id:'401999999'})),App.nav('pbecast'))`);
const un = await waitFor(`(()=>{const v=${READ_CAST};return v.unavailable?v:null})()`, 30000);
await sleep(3000);
const unv = await evalIn(READ_CAST);
check('Unavailable game: honest unavailable state for that id', un && unv.unavailable === '401999999', { unavailable: unv?.unavailable, hero: unv?.heroText });
check('Unavailable game: selection is not replaced by another game', unv?.active === '401999999' && !unv.rendered, { active: unv?.active, rendered: unv?.rendered });
}

check('no uncaught page exceptions', exceptions.length === 0, exceptions.slice(0, 5));
const passed = results.filter(r => r.ok).length;
writeFileSync(join(OUT, `${TAG}-results.json`), JSON.stringify({ target: TARGET, local: LOCAL, width: WIDTH, results }, null, 1));
console.log(`\n${passed}/${results.length} passed @${WIDTH}`);
finish(passed === results.length ? 0 : 1);
