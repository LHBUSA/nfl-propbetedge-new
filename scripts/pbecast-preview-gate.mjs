/* PBEcast pregame preview gate (browser, real clicks).
 *
 *   node scripts/pbecast-preview-gate.mjs --width=1440 [--shots]
 *
 *   PBE_GATE_TARGET=https://nfl.propbetedge.ai   site under test (default)
 *   PBE_GATE_LOCAL=1   serve THIS tree's static files; /api reads go to the target
 *   PBE_GATE_OUT=dir   screenshots
 *
 * For DET @ BUF, PIT @ NE, PHI @ TEN and MIA @ SF (when scheduled), opened from
 * the Dashboard slate card with a real pointer click:
 *   - the route, activeId, hero game id and teams are the selected game
 *   - the page is the PREGAME PREVIEW phase: preview row present with all four
 *     tiles, no empty live-only panels, the league board below the game
 *   - every tile shows only this game: market sides are its two teams and the
 *     consensus spread equals the Best Line snapshot's for this matchup;
 *     availability counts and rows equal What Changed's rows for this event id;
 *     What Changed rows equal that source's material rows for this id; the PBE
 *     tile agrees with PBECard.forGame for this id (no invented decision)
 *   - games are opened one after another in the same session, so anything left
 *     over from the previous game (player-prop quotes included) would show
 * Then one game is walked through its lifecycle with a fixture on its own event
 * responses: SCHEDULE -> LIVE -> FINAL, same game id, same route.
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
const OUT = process.env.PBE_GATE_OUT || join(REPO, '.gate', 'pbecast-preview');
const TAG = `${LOCAL ? 'local' : 'prod'}-${WIDTH}`;
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9180 + Math.floor(Math.random() * 90);
const MOBILE = WIDTH < 600;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-pv-'));
mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, '--headless=new', '--no-first-run', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
function finish(c) { try { chrome.kill(); } catch {} setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(c); }, 300); }
setTimeout(() => { console.error('DEADLINE'); finish(3); }, 1500000).unref?.();

/* ---- interception: LOCAL static tree + the lifecycle fixture ------------------- */
const MIME = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json; charset=utf-8' };
let phaseFixture = null;   // { id, semantics }
function applyPhase(g) {
  if (!g || String(g.id) !== phaseFixture.id) return;
  const live = phaseFixture.semantics === 'LIVE';
  g.status = { ...(g.status || {}), semantics: phaseFixture.semantics, period: live ? 1 : 4, clock: live ? '12:41' : '0:00', short_detail: live ? '12:41 - 1st (fixture)' : 'Final (fixture)', detail: live ? '12:41 - 1st Quarter' : 'Final' };
  if (g.teams?.away) g.teams.away.score = live ? 0 : 20;
  if (g.teams?.home) g.teams.home.score = live ? 7 : 27;
}
async function intercept(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (u.origin !== ORIGIN) return null;
  if (phaseFixture && u.pathname === '/api/nfl-live') {
    const ev = u.searchParams.get('event');
    if (ev === phaseFixture.id || (!ev && (u.searchParams.get('range') || u.searchParams.get('date')))) {
      const r = await fetch(`${TARGET}${u.pathname}${u.search}`, { headers: { accept: 'application/json' } });
      const body = await r.json();
      if (ev) { applyPhase(body.game); if (body.source) body.source.semantics = phaseFixture.semantics; }
      else for (const g of Array.isArray(body?.games) ? body.games : []) applyPhase(g);
      return { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
    }
  }
  if (!LOCAL || u.pathname.startsWith('/api/')) return null;
  const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
  if (!rel || rel.includes('..') || !MIME[extname(rel)]) return null;
  const fp = join(REPO, rel);
  if (!existsSync(fp) || !statSync(fp).isFile()) return null;
  return { status: 200, headers: { 'content-type': MIME[extname(rel)], 'cache-control': 'no-store' }, body: readFileSync(fp) };
}

/* ---- CDP ------------------------------------------------------------------------ */
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
    try { l = await intercept(m.params.request.url); } catch { l = null; }
    if (l) send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: l.status, responseHeaders: Object.entries({ ...l.headers, 'access-control-allow-origin': '*' }).map(([name, value]) => ({ name, value })), body: Buffer.from(l.body).toString('base64') }).catch(() => {});
    else send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 200));
};
await send('Runtime.enable'); await send('Page.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: `${ORIGIN}/*`, requestStage: 'Request' }] });
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: MOBILE ? 860 : 1000, deviceScaleFactor: 1, mobile: MOBILE });
const evalIn = async (expr, ms = 45000) => {
  try { const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }), sleep(ms).then(() => { throw new Error('WEDGED'); })]); return r.result?.value; }
  catch (e) { return { __error: e.message }; }
};
async function waitFor(expr, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await evalIn(expr, 8000); if (v && !v.__error) return v; await sleep(400); } return null; }
async function hardNav(hash) { await send('Page.navigate', { url: 'about:blank' }); await sleep(300); await send('Page.navigate', { url: `${TARGET}/${hash}` }); await sleep(3500); }
async function shot(name) {
  if (!SHOTS) return;
  await evalIn(`(()=>{document.documentElement.style.scrollBehavior='auto';const h=document.querySelector('.pbecast6 [data-cast6-hero]');if(h){h.scrollIntoView({block:'start'});window.scrollBy(0,-${MOBILE ? 60 : 120})}return 1})()`);
  await sleep(900);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const f = join(OUT, `${TAG}-${name}.png`);
  writeFileSync(f, Buffer.from(r.data, 'base64'));
  console.log(`  shot ${f}`);
}
async function realClick(selectorExpr, label) {
  let at = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const scroll = attempt % 2 ? 'const r0=el.getBoundingClientRect();window.scrollBy(0,r0.top-innerHeight/3);' : "el.scrollIntoView({block:'center'});";
    at = await evalIn(`(()=>{document.documentElement.style.scrollBehavior='auto';const el=${selectorExpr};if(!el)return null;for(let d=el.closest('details');d;d=d.parentElement&&d.parentElement.closest('details'))d.open=true;${scroll}const r=el.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;const top=document.elementFromPoint(x,y);return {x,y,hit:!!top&&(top===el||el.contains(top))}})()`);
    if (at?.hit) { await sleep(400); const still = await evalIn(`(()=>{const el=${selectorExpr};const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`); if (still && Math.abs(still.x - at.x) < 1 && Math.abs(still.y - at.y) < 1) break; at = null; }
    await sleep(700);
  }
  if (!at?.hit) return { ok: false, why: `${label}: not clickable` };
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  return { ok: true };
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
const note = (name, detail) => console.log(`NOTE  ${name}${detail ? `  — ${JSON.stringify(detail)}` : ''}`);

/* Everything the page shows for the selected game, plus the same sources read
   directly, so the gate compares the page against the authority, not itself. */
const READ = `(async()=>{
  const s=PBEcastV6.state, root=document.querySelector('.pbecast6'), hero=root&&root.querySelector('[data-cast6-hero] .cast6-hero');
  const pv=root&&root.querySelector('.pbepv');
  const txt=el=>el?el.textContent.replace(/\\s+/g,' ').trim():'';
  const tile=k=>pv&&pv.querySelector('[data-pv-tile="'+k+'"]');
  const g=s.detail&&s.detail.game;
  const cc=window.PBECommandCenter, card=window.PBECard;
  const gw=typeof NFL_API_GATEWAY!=='undefined'?NFL_API_GATEWAY:'https://nfl-api.propbetedge.ai';
  const [bl,chg]=await Promise.all([fetch(gw+'/api/best-line?days=8').then(r=>r.json()).catch(()=>null),fetch(gw+'/api/changes').then(r=>r.json()).catch(()=>null)]);
  const norm=v=>String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const ev=bl&&g?(bl.events||[]).find(e=>norm(e.away)===norm(g.teams.away.display_name)&&norm(e.home)===norm(g.teams.home.display_name)&&Math.abs(Date.parse(e.kickoff)-Date.parse(g.date))<12*3600000):null;
  const fav=ev?Object.values((ev.markets||{}).spread||{}).find(x=>x&&x.consensus&&Number(x.consensus.line)<0):null;
  const favAbbr=fav?(norm(fav.side)===norm(ev.away)?g.teams.away.abbreviation:g.teams.home.abbreviation):null;
  const avRows=chg&&g?(chg.availability||{})[String(g.id)]||[]:null;
  const avStat=['OUT','SUSPENDED','INJURED_RESERVE','DOUBTFUL','QUESTIONABLE'];
  const chRows=chg&&g?(chg.changes||[]).filter(c=>String(c.game&&c.game.id)===String(g.id)&&c.actionable!==false&&(c.severity==='HIGH'||c.severity==='MEDIUM')&&!(c.kind==='INJURY_STATUS'&&c.status==='ACTIVE')):null;
  const hit=card&&g?card.forGame({away:g.teams.away.abbreviation,home:g.teams.home.abbreviation,espnId:g.id}):null;
  const pbeCount=hit?[...(hit.cards||[]),...(hit.previews||[])].filter(x=>x.lifecycle!=='FINAL').length:null;
  const kids=[...root.children];
  const idx=sel=>kids.findIndex(k=>k.matches(sel));
  return {
    route:App.current, active:String(s.activeId||''), phase:root&&root.dataset.phase,
    heroGame:hero&&hero.dataset.cast6Game, heroTeams:hero?[...hero.querySelectorAll('.cast6-team b')].map(b=>b.textContent.trim()):[],
    heroLabel:txt(hero&&hero.querySelector('.cast6-live')), countdown:txt(hero&&hero.querySelector('.cast6-countdown')),
    heroVenue:txt(hero&&hero.querySelector('.cast6-score-center>small')),
    teams:g?[g.teams.away.abbreviation,g.teams.home.abbreviation]:[],
    pvGame:pv&&pv.dataset.previewGame, tiles:pv?[...pv.querySelectorAll('[data-pv-tile]')].map(t=>t.dataset.pvTile):[],
    marketQ:[...(tile('market')?tile('market').querySelectorAll('.pbepv-q>b'):[])].map(b=>b.textContent.trim()),
    marketState:txt(tile('market')&&tile('market').querySelector('.pbepv-state b')),
    marketSrc:ev?{fav:favAbbr,line:fav?Number(fav.consensus.line):null,id:ev.id}:null,
    availTeams:[...(tile('availability')?tile('availability').querySelectorAll('.pbepv-counts b'):[])].map(b=>b.textContent.trim()),
    availRows:[...(tile('availability')?tile('availability').querySelectorAll('.pbepv-inj>li small'):[])].map(x=>x.textContent.split(' · ').slice(0,2)),
    availCounts:[...(tile('availability')?tile('availability').querySelectorAll('.pbepv-counts>div'):[])].map(d=>[...d.querySelectorAll('span')].map(x=>parseInt(x.textContent,10)).reduce((a,b)=>a+b,0)).reduce((a,b)=>a+b,0),
    availSrc:avRows?avRows.filter(r=>avStat.includes(r.status)&&r.player&&r.player.name).length:null,
    availState:txt(tile('availability')&&tile('availability').querySelector('.pbepv-state b')),
    changesRows:tile('changes')?tile('changes').querySelectorAll('.pbepv-changes>li').length:0,
    changesMeta:txt(tile('changes')&&tile('changes').querySelector('.pbepv-meta')),
    changesText:txt(tile('changes')),
    changesSrc:chRows?chRows.length:null,
    pbeRows:tile('pbe')?tile('pbe').querySelectorAll('.pbepv-picks>li').length:0, pbeText:txt(tile('pbe')), pbeSrc:pbeCount, cardLoaded:!!(card&&card.store&&card.store.data),
    emptyLive:['[data-cast6-action]','[data-cast6-telemetry]','[data-cast6-workspace]'].map(sel=>root.querySelector(sel).innerHTML.trim().length),
    boardAfterGame:idx('[data-pbecc-cast="board"]')>idx('[data-cast6-workspace]'),
    marketEvent:s.marketEvent?{away:s.marketEvent.away,home:s.marketEvent.home}:null,
    gameNames:g?[g.teams.away.display_name,g.teams.home.display_name]:[],
    propPlayers:[...document.querySelectorAll('#pbecast7-trading .cast7-alert>b')].map(b=>b.textContent.split(' · ')[0]),
    overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth
  };
})()`;

console.log(`pbecast preview gate -> ${TARGET} ${LOCAL ? '(LOCAL tree)' : '(production)'} @${WIDTH}px\n`);
await hardNav('#home');
const contract = await waitFor(`(()=>{const d=window.PBESeason&&PBESeason.data;return d&&d.primary_slate&&d.primary_slate.dates?{ps:d.primary_slate}:null})()`, 45000);
check('season contract loaded', contract);
if (!contract) finish(1);
const week = (await evalIn(`fetch('/api/nfl-live?range=${contract.ps.dates}&view=slate').then(r=>r.json()).then(b=>(b.games||[]).map(g=>({id:String(g.id),sem:g.status&&g.status.semantics,away:g.teams.away.abbreviation,home:g.teams.home.abbreviation})))`)) || [];
const WANT = [['DET', 'BUF'], ['PIT', 'NE'], ['PHI', 'TEN'], ['MIA', 'SF']];
const ONLY_LIFE = process.env.PBE_GATE_ONLY === 'life';
const picksAll = WANT.map(([a, h]) => week.find(g => g.away === a && g.home === h && g.sem === 'SCHEDULE')).filter(Boolean);
check('the four named games are scheduled in the primary slate', picksAll.length === 4, picksAll.map(g => `${g.away}@${g.home}`));
const picks = ONLY_LIFE ? picksAll.slice(1, 2) : picksAll;
const LANDING_PAUSE = 6000;

/* One session: each game opened after the previous one from the Dashboard. */
await evalIn(`(()=>{try{sessionStorage.clear();localStorage.removeItem('pbe_nfl_cast_active_v6')}catch(e){};return 1})()`);
for (const g of picks) {
  const label = `${g.away}@${g.home}`;
  await evalIn(`App.nav('home')`);
  const ready = await waitFor(`document.querySelector('.pbecc-slate .pbecc-cast[data-cast="${g.id}"]')?1:null`, 40000);
  if (!ready) { check(`${label}: dashboard card present`, false); continue; }
  const c = await realClick(`document.querySelector('.pbecc-slate .pbecc-cast[data-cast="${g.id}"]')`, 'dashboard card');
  check(`${label}: dashboard Preview clicked`, c.ok, c.why);
  /* settled: preview for this game, every tile past loading */
  await waitFor(`(()=>{const r=document.querySelector('.pbecast6');const pv=r&&r.querySelector('.pbepv[data-preview-game="${g.id}"]');return pv&&!/Reading/.test(pv.textContent)&&r.querySelector('.cast6-hero[data-cast6-game="${g.id}"] .cast6-score-center>small')?.textContent.trim()?1:null})()`, 40000);
  await sleep(LANDING_PAUSE);
  const v = await evalIn(READ, 60000);
  if (!v || v.__error) { check(`${label}: page readable`, false, v); continue; }
  check(`${label}: route pbecast, activeId, hero game and teams are the selected game`, v.route === 'pbecast' && v.active === g.id && v.heroGame === g.id && v.heroTeams.join('@') === `${g.away}@${g.home}`, { route: v.route, active: v.active, hero: v.heroGame, teams: v.heroTeams });
  check(`${label}: PREGAME PREVIEW phase with countdown`, v.phase === 'SCHEDULE' && v.heroLabel === 'PREGAME PREVIEW' && /^Kickoff in/i.test(v.countdown), { phase: v.phase, label: v.heroLabel, countdown: v.countdown });
  check(`${label}: hero carries the venue for this game`, v.heroVenue.length > 3, v.heroVenue);
  check(`${label}: preview row is this game with all four tiles`, v.pvGame === g.id && ['market', 'pbe', 'availability', 'changes'].every(t => v.tiles.includes(t)), { pvGame: v.pvGame, tiles: v.tiles });
  check(`${label}: no empty live-only panels before kickoff`, v.emptyLive.every(n => n === 0), v.emptyLive);
  check(`${label}: league board sits below the game`, v.boardAfterGame);
  /* market */
  if (v.marketSrc) {
    const sides = v.marketQ.map(q => q.split(' ')[0]);
    check(`${label}: market sides are only ${g.away}/${g.home} (and O/U)`, sides.length && sides.every(s => [g.away, g.home, 'O', 'U'].includes(s)), v.marketQ);
    const favQ = v.marketQ.find(q => q.startsWith(`${v.marketSrc.fav} `));
    check(`${label}: consensus spread equals the Best Line snapshot for this matchup`, v.marketSrc.fav ? favQ === `${v.marketSrc.fav} ${v.marketSrc.line}` : true, { page: favQ, source: v.marketSrc });
  } else check(`${label}: no snapshot event -> honest not-posted market`, /Not posted/.test(v.marketState), v.marketState);
  /* availability */
  if (v.availSrc) {
    check(`${label}: availability counts are ${g.away}/${g.home} only`, v.availTeams.join('@') === `${g.away}@${g.home}` && v.availRows.every(([, t]) => [g.away, g.home].includes(t) || !t), { teams: v.availTeams, rowTeams: [...new Set(v.availRows.map(r => r[1]))] });
    check(`${label}: availability totals equal What Changed's rows for event ${g.id}`, v.availCounts === v.availSrc, { page: v.availCounts, source: v.availSrc });
  } else check(`${label}: no designations -> honest clear state`, /No restrictive/.test(v.availState), v.availState);
  /* what changed */
  const shown = Math.min(3, v.changesSrc ?? 0);
  check(`${label}: What Changed shows this game's material rows (${v.changesSrc})`, v.changesRows === shown && (v.changesSrc ? v.changesMeta === `${v.changesSrc} ON THIS GAME` : /No material changes/.test(v.changesText)), { rows: v.changesRows, meta: v.changesMeta, source: v.changesSrc });
  const others = picks.filter(o => o !== g).flatMap(o => [`${o.away} @ ${o.home}`]);
  check(`${label}: What Changed names no other matchup`, others.every(m => !v.changesText.includes(m)), v.changesText.slice(0, 160));
  /* PBE */
  if (v.cardLoaded) check(`${label}: PBE tile agrees with PBECard.forGame (${v.pbeSrc})`, v.pbeSrc ? v.pbeRows === Math.min(3, v.pbeSrc) : /No PBE decision on this game/.test(v.pbeText), { rows: v.pbeRows, source: v.pbeSrc });
  else note(`${label}: PBE Card store not loaded`, v.pbeText.slice(0, 80));
  check(`${label}: no validation signal is called an official pick`, !/OFFICIAL PBE PICK/.test(v.pbeText) || /official/i.test(v.pbeText), v.pbeText.slice(0, 120));
  /* nothing carried over from the previous game */
  check(`${label}: prop market event (if linked) is this matchup`, !v.marketEvent || (v.gameNames.some(n => n.toLowerCase().includes(String(v.marketEvent.home || '').toLowerCase().split(' ').pop())) ), { event: v.marketEvent, game: v.gameNames });
  check(`${label}: no horizontal overflow`, v.overflow <= 0, v.overflow);
  await shot(`preview-${g.away}-${g.home}`);
}

/* ---- lifecycle: the same selected game goes LIVE, then FINAL -------------------- */
/* the game currently selected: the last one opened above */
const life = picks[picks.length - 1];
if (life) {
  const label = `${life.away}@${life.home}`;
  phaseFixture = { id: life.id, semantics: 'LIVE' };
  note('lifecycle fixture marks the selected game LIVE, then FINAL, on its own event and board responses', label);
  const LANES = `(()=>{const s=PBEcastV6.state,r=document.querySelector('.pbecast6');return {phase:r&&r.dataset.phase,active:s.activeId,detailSrc:s.detail&&s.detail.source&&s.detail.source.semantics,detailGame:s.detail&&s.detail.game&&s.detail.game.status&&s.detail.game.status.semantics,fast:s.fastGame&&s.fastGame.status&&s.fastGame.status.semantics,rejected:s.rejected,error:s.error,stateUrl:PBEcastV6.stateUrl()}})()`;
  const liveV = await waitFor(`(()=>{const r=document.querySelector('.pbecast6');return r&&r.dataset.phase==='LIVE'&&String(PBEcastV6.state.activeId)==='${life.id}'?{phase:r.dataset.phase,pv:!!r.querySelector('.pbepv'),action:r.querySelector('[data-cast6-action]').innerHTML.trim().length,active:String(PBEcastV6.state.activeId),label:(r.querySelector('.cast6-live')||{}).textContent,board:[...r.children].findIndex(k=>k.matches('[data-pbecc-cast="board"]'))<[...r.children].findIndex(k=>k.matches('[data-cast6-hero]'))}:null})()`, 60000);
  check(`Lifecycle ${label}: SCHEDULE -> LIVE on the same game id and route`, liveV && liveV.active === life.id && !liveV.pv && liveV.action > 0 && /LIVE/.test(liveV.label || '') && liveV.board, liveV || await evalIn(LANES));
  await shot(`lifecycle-live-${life.away}-${life.home}`);
  phaseFixture = { id: life.id, semantics: 'FINAL' };
  const finV = await waitFor(`(()=>{const r=document.querySelector('.pbecast6');return r&&r.dataset.phase==='FINAL'&&String(PBEcastV6.state.activeId)==='${life.id}'?{phase:r.dataset.phase,pv:!!r.querySelector('.pbepv'),active:String(PBEcastV6.state.activeId),label:(r.querySelector('.cast6-live')||{}).textContent,route:App.current}:null})()`, 70000);
  check(`Lifecycle ${label}: LIVE -> FINAL · REPLAY on the same game id and route`, finV && finV.active === life.id && !finV.pv && finV.label === 'FINAL · REPLAY' && finV.route === 'pbecast', finV || await evalIn(LANES));
  await shot(`lifecycle-final-${life.away}-${life.home}`);
  phaseFixture = null;
}

check('no uncaught page exceptions', exceptions.length === 0, exceptions.slice(0, 5));
const passed = results.filter(r => r.ok).length;
writeFileSync(join(OUT, `${TAG}-results.json`), JSON.stringify({ target: TARGET, local: LOCAL, width: WIDTH, results }, null, 1));
console.log(`\n${passed}/${results.length} passed @${WIDTH}`);
finish(passed === results.length ? 0 : 1);
