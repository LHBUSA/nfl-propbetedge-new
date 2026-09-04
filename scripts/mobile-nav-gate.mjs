/* Production gate for the isolated mobile-navigation hotfix.
 *
 * Renders the checked-out tree against live production APIs in real Chrome and
 * asserts the full navigation contract at every width that matters, including
 * the 900/901 boundary where navigation authority changes hands from the
 * legacy drawer + bottom tab bar to the shell's desktop rails.
 *
 * Checks, per width:
 *   - which navigation authority is active, and that exactly one is
 *   - drawer opens, is above the shell chrome, and closes
 *   - bottom tab bar present and its items are real touch targets
 *   - every destination in the active authority resolves to a live renderer
 *   - PBE Picks and Track Record specifically (added by this commit)
 *   - no horizontal document overflow
 *   - no broken images
 *   - no console exceptions
 *   - the dashboard-v8 observer-loop alarm is installed and silent
 */
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,extname} from 'node:path';

const REPO = process.cwd();
const TARGET = process.env.PBE_TARGET || 'https://nfl.propbetedge.ai';
const ORIGIN = new URL(TARGET).origin;
const PORT = 9600 + Math.floor(Math.random() * 90);
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = process.env.PBE_OUT || join(REPO, '.gate');
const WIDTHS = [390, 430, 768, 900, 901, 1440];

mkdirSync(OUT, {recursive: true});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-gate-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-timer-throttling',
  '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'
], {stdio: 'ignore'});

let failures = [];
function finish(code) {
  try { chrome.kill(); } catch {}
  setTimeout(() => { try { rmSync(dir, {recursive: true, force: true}); } catch {} process.exit(code); }, 250);
}
setTimeout(() => { console.error('HARD_DEADLINE'); finish(3); }, 900000).unref?.();

async function wsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('devtools_unavailable');
}
const ws = new WebSocket(await wsUrl());
await new Promise(r => { ws.onopen = r; });
let id = 1;
const pending = new Map();
const send = (m, p = {}) => { const n = id++; ws.send(JSON.stringify({id: n, method: m, params: p})); return new Promise((res, rej) => pending.set(n, {resolve: res, reject: rej})); };

const MIME = {'.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.json':'application/json; charset=utf-8'};
function localFile(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (u.origin !== ORIGIN || u.pathname.startsWith('/api/')) return null;
  const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
  if (!rel || rel.includes('..') || !MIME[extname(rel)]) return null;
  const fp = join(REPO, rel);
  try { if (!existsSync(fp) || !statSync(fp).isFile()) return null; return {body: readFileSync(fp), type: MIME[extname(rel)]}; } catch { return null; }
}
const exceptions = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.method === 'Fetch.requestPaused') {
    const l = localFile(m.params.request.url);
    if (l) send('Fetch.fulfillRequest', {requestId: m.params.requestId, responseCode: 200, responseHeaders: [{name:'content-type',value:l.type},{name:'cache-control',value:'no-store'}], body: l.body.toString('base64')}).catch(()=>{});
    else send('Fetch.continueRequest', {requestId: m.params.requestId}).catch(()=>{});
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 200));
};
await send('Runtime.enable'); await send('Page.enable');
await send('Fetch.enable', {patterns: [{urlPattern: `${ORIGIN}/*`, requestStage: 'Request'}]});

const probe = async (expr, ms = 20000) => {
  try {
    const r = await Promise.race([send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true}), sleep(ms).then(() => { throw new Error('WEDGED'); })]);
    return r.result?.value;
  } catch (e) { return {__error: e.message}; }
};
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  ' + JSON.stringify(detail)}`);
  return ok;
};

const ROUTES = ['home','games','propboard','marketwatch','matchups','picks','pbepicks','trackrecord','simulator','sgplab','usage','propchain','pbecast','newsintel','injuries','trades','teams','stats','standings','seasonhistory','hof','records','sb','prospects'];

console.log(`GATE  target=${TARGET}  mode=working-tree + live APIs`);
console.log(`branch content under test: mobile-navigation hotfix\n`);

for (const width of WIDTHS) {
  const height = width <= 768 ? 844 : 900;
  const mobileAuthority = width <= 900;
  console.log(`--- ${width}x${height}  (expected authority: ${mobileAuthority ? 'drawer + bottom tab bar' : 'desktop rails'}) ---`);
  exceptions.length = 0;
  await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: mobileAuthority, screenWidth: width, screenHeight: height});
  // maxTouchPoints must be 1-16 even when disabling; 0 is rejected by CDP.
  await send('Emulation.setTouchEmulationEnabled', {enabled: mobileAuthority, maxTouchPoints: mobileAuthority ? 5 : 1});
  await send('Page.navigate', {url: `${TARGET}/?gate=${Date.now()}`});
  await sleep(14000);

  // --- navigation authority -------------------------------------------------
  const auth = await probe(`(()=>{
    const cs=el=>el?getComputedStyle(el):null;
    const sb=document.getElementById('sidebar'), bn=document.getElementById('mobile-bottom-nav');
    const mh=document.getElementById('mobile-header');
    const rails=[...document.querySelectorAll('#pbe-sports-shell .pbes-primary, #pbe-sports-shell .pbes-research')];
    return {
      sidebarDisplay: cs(sb)?.display ?? 'missing',
      bottomNav: cs(bn)?.display ?? 'missing',
      bottomNavH: Math.round(bn?.getBoundingClientRect().height||0),
      mobileHeader: cs(mh)?.display ?? 'missing',
      railsVisible: rails.filter(r=>getComputedStyle(r).display!=='none').length,
      railWidth: Math.round(rails.reduce((s,r)=>s+r.getBoundingClientRect().width,0)),
      shellPresent: !!document.getElementById('pbe-sports-shell')
    }})()`);
  if (mobileAuthority) {
    check(`${width} bottom tab bar visible`, auth.bottomNav === 'block', auth);
    check(`${width} desktop rails hidden`, auth.railsVisible === 0, auth);
  } else {
    check(`${width} desktop rails visible`, auth.railsVisible === 2, auth);
    check(`${width} bottom tab bar hidden`, auth.bottomNav === 'none', auth);
    check(`${width} legacy sidebar hidden`, auth.sidebarDisplay === 'none', auth);
  }
  check(`${width} legacy mobile-header retired at all widths`, auth.mobileHeader === 'none', auth);
  check(`${width} shell present`, auth.shellPresent === true, auth);

  // --- drawer open / stacking / close ---------------------------------------
  if (mobileAuthority) {
    const drawer = await probe(`(()=>{
      const sb=document.getElementById('sidebar'), ov=document.getElementById('mobile-overlay');
      const shell=document.getElementById('pbe-sports-shell');
      const before=sb.getBoundingClientRect().x;
      App.toggleMobile();
      return new Promise(r=>setTimeout(()=>{
        const rect=sb.getBoundingClientRect();
        const sz=+getComputedStyle(sb).zIndex, oz=+getComputedStyle(ov).zIndex, shz=+getComputedStyle(shell).zIndex;
        const logo=sb.querySelector('.sidebar-logo'), search=document.getElementById('global-search');
        const topEl=logo?document.elementFromPoint(Math.round(logo.getBoundingClientRect().left+10),Math.round(logo.getBoundingClientRect().top+10)):null;
        r({before:Math.round(before),after:Math.round(rect.x),width:Math.round(rect.width),
           items:sb.querySelectorAll('.nav-item').length,
           drawerZ:sz,overlayZ:oz,shellZ:shz,
           logoOnTop: !!(topEl&&sb.contains(topEl)),
           searchVisible: !!(search&&search.getBoundingClientRect().width>0),
           overlayOpen: ov.classList.contains('open')});
      },450));
    })()`);
    check(`${width} drawer opens on screen`, drawer.after === 0 && drawer.before < 0, drawer);
    check(`${width} drawer above shell chrome`, drawer.drawerZ > drawer.shellZ && drawer.overlayZ > drawer.shellZ, drawer);
    check(`${width} drawer top controls reachable`, drawer.logoOnTop === true && drawer.searchVisible === true, drawer);
    check(`${width} drawer exposes full destination set`, drawer.items >= 24, {items: drawer.items});

    const closed = await probe(`(()=>{App.toggleMobile();return new Promise(r=>setTimeout(()=>r({x:Math.round(document.getElementById('sidebar').getBoundingClientRect().x),overlayOpen:document.getElementById('mobile-overlay').classList.contains('open')}),450))})()`);
    check(`${width} drawer closes`, closed.x < 0 && closed.overlayOpen === false, closed);

    const tabs = await probe(`(()=>[...document.querySelectorAll('.mbn-item')].map(el=>{const r=el.getBoundingClientRect();return{id:el.id,w:Math.round(r.width),h:Math.round(r.height)}}))()`);
    check(`${width} bottom tabs are real touch targets`, Array.isArray(tabs) && tabs.length === 5 && tabs.every(t => t.h >= 44 && t.w >= 44), tabs);
  }

  // --- every destination resolves ------------------------------------------
  const dead = [];
  for (const route of ROUTES) {
    const r = await probe(`(()=>{App.nav(${JSON.stringify(route)});return new Promise(res=>setTimeout(()=>res({route:App.current,registered:typeof App.VIEWS[${JSON.stringify(route)}]==='function',pending:!!document.querySelector('[data-pbe-pending-route]'),chars:(document.getElementById('view-container')?.textContent||'').trim().length}),1400))})()`, 12000);
    if (!r || r.__error || r.route !== route || r.registered !== true || r.pending === true || Number(r.chars) < 120) dead.push({route, r});
  }
  check(`${width} all ${ROUTES.length} destinations render`, dead.length === 0, dead.slice(0, 4));

  // PBE Picks and Track Record are the two routes this commit adds to the drawer
  const added = await probe(`(()=>{
    const ids=['nav-pbepicks','nav-trackrecord'];
    return ids.map(i=>{const el=document.getElementById(i);return{id:i,present:!!el,text:el?el.textContent.trim().replace(/\\s+/g,' ').slice(0,24):null}})
  })()`);
  check(`${width} PBE Picks + Track Record present in drawer`, Array.isArray(added) && added.every(a => a.present), added);

  // --- overflow / images / exceptions --------------------------------------
  await probe(`App.nav('home')`); await sleep(1600);
  const health = await probe(`(()=>{
    const de=document.documentElement;
    const imgs=[...document.images];
    return {overflowX:de.scrollWidth-de.clientWidth, scrollW:de.scrollWidth, innerW:window.innerWidth,
      images:imgs.length, broken:imgs.filter(i=>i.complete&&!i.naturalWidth).length}})()`);
  check(`${width} no horizontal document overflow`, health.overflowX <= 8, health);
  check(`${width} no broken images`, health.broken === 0, health);
  check(`${width} no console exceptions`, exceptions.length === 0, exceptions.slice(0, 3));

  const shot = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
  writeFileSync(join(OUT, `gate-${width}.png`), Buffer.from(shot.data, 'base64'));
  console.log('');
}

// --- observer-loop alarm ----------------------------------------------------
console.log('--- observer loop alarm ---');
await send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
await send('Page.navigate', {url: `${TARGET}/?gate=alarm${Date.now()}`});
await sleep(14000);
const alarm = await probe(`(()=>{const a=window.__PBE_OBSERVER_ALARM;return{installed:!!a,count:a?a.count:null}})()`);
check('observer alarm is installed', alarm.installed === true, alarm);
check('observer alarm is silent', alarm.count === 0, alarm);

console.log(`\n${failures.length ? 'GATE FAILED' : 'GATE PASSED'}  (${failures.length} failure${failures.length === 1 ? '' : 's'})`);
failures.forEach(f => console.log('  ! ' + f));
ws.close();
finish(failures.length ? 1 : 0);
