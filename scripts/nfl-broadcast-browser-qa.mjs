/* NFL broadcast browser QA (K desktop, L 390px mobile, M no-broadcast games).
 *
 *   PBE_CHROME=... node scripts/nfl-broadcast-browser-qa.mjs [--snapshot=acceptance.json] [--out=DIR] [--user-data-dir=DIR]
 *
 * Loads https://nfl.propbetedge.ai in headless Chrome with every same-origin
 * static file substituted from this checkout (the recovery-smoke pattern).
 * The gateway's /api/schedule is answered by THIS BRANCH's nfl-schedule Worker
 * code running locally over a broadcast snapshot (the live-ESPN snapshot from
 * scripts/nfl-broadcast-acceptance.mjs --out, or the test fixture weeks), so
 * the deployed Worker is never touched. Every other API is live production.
 * A second pass withholds broadcast for most games to prove the layout holds.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import worker, { resetSnapshotMemo } from '../workers/nfl-schedule/index.js';
import { emptySnapshot, observeCdnWeek, mergeObservations } from '../workers/nfl-schedule/broadcast-core.js';
import { allowedHostsById } from '../workers/nfl-schedule/broadcasters.js';

const REPO = process.cwd();
const TARGET = 'https://nfl.propbetedge.ai';
const GATEWAY = 'https://nfl-api.propbetedge.ai';
const CHROME = process.env.PBE_CHROME || '/usr/bin/google-chrome';
const PORT = 9500 + (process.pid % 300);
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const OUT = arg('out') || '.';
const argDir = arg('user-data-dir');
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOSTS = allowedHostsById();

function loadSnapshot() {
  const file = arg('snapshot');
  if (file) return JSON.parse(readFileSync(file, 'utf8')).snapshot;
  const fix = JSON.parse(readFileSync(join(REPO, 'tests/fixtures/espn-cdn-scoreboard-2026.json'), 'utf8'));
  const snap = emptySnapshot();
  for (const [k, w] of [['week1', 1], ['week2', 2], ['week4', 4], ['week18', 18]]) mergeObservations(snap, observeCdnWeek(fix[k], w).observations, new Date().toISOString());
  return snap;
}
const FULL = loadSnapshot();
/* Pass M: only week 1 keeps observations; everything else is UNAVAILABLE. */
const SPARSE = { ...FULL, events: Object.fromEntries(Object.entries(FULL.events).filter(([, e]) => e.week === 1 && !['DAL', 'NE'].includes(e.away))) };

const dir = argDir || mkdtempSync(join(tmpdir(), 'pbe-broadcast-qa-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-timer-throttling', '--hide-scrollbars', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
const results = [];
let failures = 0;
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`); };

const mime = p => ({ '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json' }[extname(p)] || 'application/octet-stream');
function localFile(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (u.origin !== TARGET || u.pathname.startsWith('/api/')) return null;
  const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
  if (!rel || rel.includes('..') || !['.js', '.css', '.html', '.json', '.webmanifest'].includes(extname(rel))) return null;
  const fp = join(REPO, rel);
  return existsSync(fp) && statSync(fp).isFile() ? { body: readFileSync(fp), type: mime(rel) } : null;
}

let snapshotInUse = FULL;
try {
  let wsu;
  for (let i = 0; i < 80 && !wsu; i++) { try { wsu = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.type === 'page')?.webSocketDebuggerUrl; } catch {} if (!wsu) await sleep(250); }
  const ws = new WebSocket(wsu); await new Promise(r => { ws.onopen = r; });
  let id = 1; const pending = new Map(); const exceptions = [];
  const send = (method, params = {}) => { const n = id++; ws.send(JSON.stringify({ id: n, method, params })); return new Promise((res, rej) => pending.set(n, { res, rej })); };
  const scheduleCalls = [], espnApiCalls = [];
  ws.onmessage = async ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.requestWillBeSent' && /site\.api\.espn\.com|cdn\.espn\.com\/core|sports\.core\.api\.espn\.com/.test(m.params.request.url)) espnApiCalls.push(m.params.request.url);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text).slice(0, 200));
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    const u = new URL(request.url);
    if (u.origin === GATEWAY && u.pathname.startsWith('/api/schedule')) {
      if (request.method === 'OPTIONS') { send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: [{ name: 'access-control-allow-origin', value: '*' }, { name: 'access-control-allow-headers', value: '*' }] }).catch(() => {}); return; }
      scheduleCalls.push(request.url);
      resetSnapshotMemo();
      const snap = snapshotInUse;
      const res = await worker.fetch(new Request(request.url), { NFL_KV: { get: async () => JSON.parse(JSON.stringify(snap)) } });
      const body = Buffer.from(await res.text());
      send('Fetch.fulfillRequest', { requestId, responseCode: res.status, responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }, { name: 'cache-control', value: 'no-store' }], body: body.toString('base64') }).catch(() => {});
      return;
    }
    const local = localFile(request.url);
    if (local) send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: local.type }, { name: 'cache-control', value: 'no-store' }], body: local.body.toString('base64') }).catch(() => {});
    else send('Fetch.continueRequest', { requestId }).catch(() => {});
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: `${TARGET}/*`, requestStage: 'Request' }, { urlPattern: `${GATEWAY}/api/schedule*`, requestStage: 'Request' }] });
  const probe = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.value; };
  const shot = async (name, clip) => {
    await send('Page.bringToFront');
    const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}) });
    const file = join(OUT, `broadcast-${name}.png`); writeFileSync(file, Buffer.from(r.data, 'base64')); console.log(`screenshot ${file}`);
  };
  const viewport = async (width, height, mobile) => { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); await sleep(500); };
  const noSmooth = `(()=>{const s=document.createElement('style');s.textContent='html,*{scroll-behavior:auto!important}';document.head.appendChild(s);return 1})()`;

  async function gamesAssertions(label, width) {
    await probe(`App.nav('games')`); await sleep(3500);
    await probe(`(()=>{const b=document.querySelector('.pbe25-week[data-week="1"]');b&&b.click();return 1})()`); await sleep(1200);
    const r = await probe(`(()=>{
      const HOSTS=${JSON.stringify(HOSTS)};
      const cards=[...document.querySelectorAll('.pbe25-card')];
      const links=[...document.querySelectorAll('.pbe25-games .pbe-tv-link')];
      const bad=links.filter(a=>{const u=new URL(a.href);const id=Object.keys(HOSTS).find(k=>HOSTS[k].includes(u.hostname));return !id||u.protocol!=='https:'||a.target!=='_blank'||!/noopener/.test(a.rel)||!/noreferrer/.test(a.rel)||!/^Watch \\/ view .+ at .+ broadcast information on /.test(a.getAttribute('aria-label')||'')});
      const text=document.querySelector('.pbe25-games')?.innerText||'';
      const vw=document.documentElement.clientWidth;
      const overflowing=[...document.querySelectorAll('.pbe25-games .pbe-tv')].filter(el=>{const b=el.getBoundingClientRect();return b.width>0&&(b.right>vw+1||b.left<-1)}).length;
      return {cards:cards.length,cardsAreLinks:cards.filter(c=>c.tagName==='A'||c.closest('a')).length,
        cardActions:cards.filter(c=>c.querySelector('[data-provider],[data-team]')).length,
        tvCards:cards.filter(c=>c.querySelector('.pbe-tv')).length,links:links.length,bad:bad.map(a=>a.outerHTML.slice(0,160)),
        smalls:cards.slice(0,16).map(c=>c.querySelector('.pbe25-time small')?.innerText),
        feature:document.querySelector('.pbe25-feature-date')?.innerText||null,
        badText:/undefined|\\[object Object\\]|\\bnull\\b/.test(text),
        scrollW:document.documentElement.scrollWidth,vw,overflowing,
        gmin:cards.map(c=>c.innerText).find(t=>/Green Bay/i.test(t)&&/Minnesota/i.test(t))?.replace(/\\s+/g,' ').slice(0,160)||null,
        heights:Object.fromEntries(cards.map(c=>{const t=[...c.querySelectorAll('.pbe25-team-name')].map(x=>x.textContent).join('@');return [t,Math.round(c.getBoundingClientRect().height)]}))}
    })()`);
    console.log(label, JSON.stringify(r));
    return r;
  }

  /* ---- K: desktop -------------------------------------------------------- */
  await viewport(1440, 900, false);
  await send('Page.navigate', { url: `${TARGET}/?broadcastqa=${Date.now()}#games` }); await sleep(14000); await probe(noSmooth);
  const k = await gamesAssertions('desktop', 1440);
  check('K desktop: week 1 cards render', k.cards === 16, k.cards);
  check('K desktop: every week 1 card shows its network', k.tvCards === 16, k.tvCards);
  check('K desktop: GB @ MIN card reads CBS', /CBS/.test(k.gmin || ''), k.gmin);
  check('K desktop: ESPN / ABC simulcast shows both', k.smalls.some(s => /ESPN\s*↗?\s*\/\s*ABC/.test(s || '')), k.smalls);
  check('K desktop: every broadcaster link is allow-listed, _blank, noopener noreferrer, labelled', k.links > 0 && !k.bad.length, { links: k.links, bad: k.bad });
  check('K desktop: game cards are not external links and keep their PropBetEdge actions', k.cardsAreLinks === 0 && k.cardActions === k.cards, { cardsAreLinks: k.cardsAreLinks, cardActions: k.cardActions });
  check('K desktop: no undefined / [object Object] / null text', !k.badText);
  const click = await probe(`(async()=>{const a=document.querySelector('.pbe25-card .pbe-tv-link');if(!a)return null;const before=location.hash;let cardSaw=false;const card=a.closest('.pbe25-card');card.addEventListener('click',()=>{cardSaw=true},{once:true});window.addEventListener('click',e=>{if(e.target.closest('.pbe-tv-link'))e.preventDefault()},{capture:true,once:true});a.click();await new Promise(r=>setTimeout(r,400));return{before,after:location.hash,cardSaw,href:a.href}})()`);
  check('K desktop: clicking the network link does not trigger the card or change route', click && click.before === click.after && click.cardSaw === false, click);
  await probe(`document.querySelector('.pbe25-feature')?.scrollIntoView({block:'start'})`); await sleep(400);
  await shot('games-desktop-feature');
  const listTop = await probe(`(()=>{const d=[...document.querySelectorAll('.pbe25-day')].find(x=>/Sunday/.test(x.innerText));const b=(d||document.querySelector('.pbe25-list')).getBoundingClientRect();return {x:0,y:Math.max(0,b.top+scrollY-8),width:document.documentElement.clientWidth,height:Math.min(1100,b.height+16)}})()`);
  await shot('games-desktop-cards', listTop);

  /* dashboard hero, command center slate, score rail, PBEcast pregame */
  await probe(`App.nav('home')`); await sleep(9000);
  const home = await probe(`(()=>({hero:document.querySelector('.pbe7-venue')?.innerText||null,heroLinks:document.querySelectorAll('.pbe7-venue .pbe-tv-link').length,slate:[...document.querySelectorAll('.pbecc-game .pbecc-status')].map(x=>x.innerText).slice(0,20),rail:[...document.querySelectorAll('.pbes-score-state')].map(x=>x.innerText),railLinks:document.querySelectorAll('.pbes-score .pbe-tv-link,.pbes-score a').length}))()`);
  console.log('home', JSON.stringify(home));
  check('rail: scheduled games carry a network as text only (no link inside the chip button)', home.rail.some(s => /·\s*(NBC|CBS|FOX|ESPN|Prime Video|ABC|NFL Network|Netflix)/i.test(s)) && home.railLinks === 0, home.rail);
  check('dashboard/command center: scheduled game shows canonical network', /·\s*(NBC|CBS|FOX|ESPN|Prime Video)/i.test(home.hero || '') || home.slate.some(s => /·\s*(NBC|CBS|FOX|ESPN|Prime Video)/i.test(s)), { hero: home.hero, slate: home.slate });
  await shot('home-desktop');
  const scheduled = await probe(`(()=>{const g=(window.PBEBroadcast?.state?.games||[]).find(x=>x.espn_event_id&&Date.parse(x.gameday+'T'+x.gametime+':00-04:00')>Date.now()&&x.broadcast?.status==='VERIFIED');return g?.espn_event_id||null})()`);
  if (scheduled) {
    await probe(`(()=>{try{sessionStorage.setItem('pbe.pbecast.focus',${JSON.stringify(scheduled)})}catch(e){};App.nav('pbecast');setTimeout(()=>window.PBEcastV6?.focus?.(${JSON.stringify(scheduled)}),300);return 1})()`); await sleep(9000);
    const cast = await probe(`(()=>({hero:document.querySelector('.cast6-score-center > small')?.innerText||null,links:document.querySelectorAll('.cast6-score-center .pbe-tv-link').length,tiles:[...document.querySelectorAll('.pbecb-tile .pbecb-st')].map(x=>x.innerText).slice(0,8),tileLinks:document.querySelectorAll('.pbecb-tile a').length}))()`);
    console.log('pbecast', JSON.stringify(cast));
    check('PBEcast pregame hero shows the network next to the venue', /·\s*(NBC|CBS|FOX|ESPN|Prime Video|ABC)/i.test(cast.hero || '') && cast.links > 0, cast);
    check('PBEcast board tiles never nest links in buttons', cast.tileLinks === 0, cast.tileLinks);
    await shot('pbecast-desktop');
  }

  /* ---- L: 390px mobile --------------------------------------------------- */
  await viewport(390, 844, true);
  const l = await gamesAssertions('mobile', 390);
  check('L mobile: every week 1 card shows its network', l.tvCards === 16, l.tvCards);
  check('L mobile: no horizontal overflow from broadcast labels', l.scrollW <= l.vw && l.overflowing === 0, { scrollW: l.scrollW, vw: l.vw, overflowing: l.overflowing });
  await probe(`document.querySelector('.pbe25-list')?.scrollIntoView({block:'start'})`); await sleep(400);
  await shot('games-mobile-390');
  await probe(`App.nav('home')`); await sleep(6000);
  const mh = await probe(`({scrollW:document.documentElement.scrollWidth,vw:document.documentElement.clientWidth})`);
  check('L mobile: home + rail do not overflow at 390px', mh.scrollW <= mh.vw, mh);
  await shot('home-mobile-390');

  /* ---- M: games with no broadcast ---------------------------------------- */
  snapshotInUse = SPARSE;
  await viewport(1440, 900, false);
  await send('Page.navigate', { url: `${TARGET}/?broadcastqa=sparse${Date.now()}#games` }); await sleep(14000);
  const m = await gamesAssertions('sparse', 1440);
  const heights = await probe(`(()=>{const cards=[...document.querySelectorAll('.pbe25-card')];return{smallsWithout:cards.filter(c=>!c.querySelector('.pbe-tv')).map(c=>c.querySelector('.pbe25-time small')?.innerText)}})()`);
  check('M: games without a broadcast render with no label, no placeholder text', m.cards === 16 && m.tvCards < 16 && heights.smallsWithout.every(s => /^WK \d+$/.test(s || '')) && !m.badText, heights.smallsWithout);
  const drift = Object.keys(m.heights).filter(key => k.heights[key] !== undefined && Math.abs(k.heights[key] - m.heights[key]) > 2).map(key => [key, k.heights[key], m.heights[key]]);
  check('M: no layout break (each card is the same height with and without its label)', drift.length === 0 && Object.keys(m.heights).length === 16, { drift, compared: Object.keys(m.heights).length });
  await shot('games-desktop-no-broadcast', await probe(`(()=>{const b=document.querySelector('.pbe25-list').getBoundingClientRect();return {x:0,y:b.top+scrollY,width:document.documentElement.clientWidth,height:Math.min(900,b.height)}})()`));
  /* UNASSIGNED: week 18 (kickoff times not final) with the full snapshot */
  snapshotInUse = FULL;
  await viewport(390, 844, true);
  await send('Page.navigate', { url: `${TARGET}/?broadcastqa=tba${Date.now()}#games` }); await sleep(14000);
  await probe(`(()=>{const b=document.querySelector('.pbe25-week[data-week="18"]');b&&b.click();return 1})()`); await sleep(1200);
  const tba = await probe(`(()=>{const cards=[...document.querySelectorAll('.pbe25-card')];return{cards:cards.length,tba:cards.filter(c=>/TV TBA/i.test(c.querySelector('.pbe25-time small')?.innerText||'')).length,links:document.querySelectorAll('.pbe25-card .pbe-tv-link').length,scrollW:document.documentElement.scrollWidth,vw:document.documentElement.clientWidth}})()`);
  check('G in UI: unassigned week 18 games read "TV TBA", with no link and no overflow', tba.cards === 16 && tba.tba === 16 && tba.links === 0 && tba.scrollW <= tba.vw, tba);
  await probe(`document.querySelector('.pbe25-list')?.scrollIntoView({block:'start'})`); await sleep(400);
  await shot('games-mobile-390-week18-tba');
  check('browser never calls an ESPN data API (TV comes only from /api/schedule)', espnApiCalls.length === 0, { espnApiCalls: espnApiCalls.slice(0, 5), scheduleCalls: scheduleCalls.length });
  check('no uncaught exceptions', exceptions.length === 0, exceptions.slice(0, 5));
  ws.close();
} catch (e) {
  failures++; console.log('FAIL harness', e?.stack || e);
} finally {
  try { chrome.kill(); } catch {}
  await sleep(1200);
  if (!argDir) try { rmSync(dir, { recursive: true, force: true }); } catch {}
  writeFileSync(join(OUT, 'broadcast-qa.json'), JSON.stringify(results, null, 1));
  console.log(`RESULT ${failures ? 'FAIL' : 'PASS'} (${results.length} checks, ${failures} failed)`);
  process.exit(failures ? 1 : 0);
}
