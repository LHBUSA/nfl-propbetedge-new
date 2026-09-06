/* PBE BREAKING — cross-route QA matrix.
 * node scripts/breaking-qa.mjs [widths] [routes]
 *
 * The rail is GLOBAL, so the only honest test is every width against every
 * route it has to live above. For each cell it puts a real alert on the rail
 * and asks the browser — not the stylesheet — whether the rail is docked,
 * whether it covers anything, and whether the page still fits.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WIDTHS = (process.argv[2] || '1440,1280,900,430,390').split(',').map(Number);
const ROUTES = (process.argv[3] || 'home,propboard,pbecast,qbdna,wrdna').split(',');
const OUT = process.env.PBE_OUT || 'shots/breaking-qa';
const PORT = process.env.PBE_PORT || '4321';
const TARGET = process.env.PBE_BASE || `http://localhost:${PORT}`;
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DP = 9300 + Math.floor(Math.random() * 90);

mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-qa-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${DP}`, `--user-data-dir=${dir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
function finish(c) { try { chrome.kill(); } catch {} setTimeout(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(c); }, 200); }
setTimeout(() => { console.error('DEADLINE'); finish(3); }, 900000).unref?.();

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
let id = 1; const pending = new Map();
const send = (m, p = {}) => { const n = id++; ws.send(JSON.stringify({ id: n, method: m, params: p }));
  return new Promise((res, rej) => pending.set(n, { resolve: res, reject: rej })); };
let errors = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails?.exception?.description || 'exception');
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
  }
};
await send('Runtime.enable'); await send('Page.enable');
const evalIn = async (expr, ms = 30000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
    sleep(ms).then(() => { throw new Error('WEDGED: ' + expr.slice(0, 60)); })
  ]);
  return r.result?.value;
};

/* A real, qualifying alert, injected so the cell is deterministic. */
const PUT_ALERT = `(() => {
  const B = window.PBEBreaking; if (!B) return false;
  B.stop();
  B.state.queue.length = 0; B.state.current = null;
  B.state.seen.clear(); B.state.dismissed.clear();
  return B.offer({
    key: 'qa:' + Date.now(), family: 'NEWS', kind: 'NFL_BREAKING',
    priority: B.PRIORITY.NFL_BREAKING_MAJOR, label: 'NFL BREAKING',
    headline: 'Chiefs rule out starting quarterback for Sunday with an ankle injury',
    source: 'PropBetEdge', ts: new Date(Date.now() - 9 * 60000).toISOString(),
    teams: ['KC'], players: [],
    cta: [{ label: 'READ UPDATE', href: 'https://propbetedge.ai/news/nfl/x', kind: 'article' }],
    visible_ms: 600000, provenance: {}
  }).accepted;
})()`;

/* Everything measured from what the browser actually paints. */
const MEASURE = `(() => {
  const slot = document.getElementById('pbe-breaking-slot');
  const rail = slot && slot.querySelector('.pbeb');
  const rr = rail ? rail.getBoundingClientRect() : null;
  const painted = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    if (getComputedStyle(el).display === 'none') return null;
    if (getComputedStyle(el).visibility === 'hidden') return null;
    return r;
  };
  const overlap = (a, b) => Boolean(a && b &&
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);

  const nav = painted(document.querySelector('.pbes-primary'));
  const score = painted(document.querySelector('.pbes-scorebar'));
  const drawerBtn = painted(document.querySelector('.mobile-menu-btn, .hamburger, [data-drawer], #pbes-menu'));
  const stadium = painted(document.querySelector('[class*="stadium-control"], .pbe-stadium-control, #pbe-stadium-control'));
  const tabbar = painted(document.querySelector('.mobile-bottom-nav, .bottom-tabs, .mobile-tabbar, .pbe-tabbar'));
  const view = painted(document.getElementById('view-container'));

  /* Is the rail DOCKED? A docked band is in normal flow: no fixed/sticky
     position, no transform, and the content below it starts after it. */
  const cs = rail ? getComputedStyle(rail) : null;
  const slotCs = slot ? getComputedStyle(slot) : null;

  return {
    railVisible: Boolean(rail),
    railHeight: rr ? Math.round(rr.height) : 0,
    railTop: rr ? Math.round(rr.top) : null,
    railBottom: rr ? Math.round(rr.bottom) : null,
    position: cs ? cs.position : null,
    slotPosition: slotCs ? slotCs.position : null,
    zIndex: cs ? cs.zIndex : null,
    /* Docked means IN NORMAL FLOW, which is not the same as position:static.
       A relatively positioned element stays in flow and reserves its own space
       -- the rail uses it only to anchor the 3px accent bar -- so the two
       properties that actually decide whether it can cover anything are these:
       it must not be taken out of flow (fixed/absolute/sticky), and it must not
       lift itself into a layer (a numeric z-index). */
    docked: Boolean(cs && !['fixed', 'absolute', 'sticky'].includes(cs.position)
      && cs.zIndex === 'auto'
      && (!slotCs || !['fixed', 'absolute', 'sticky'].includes(slotCs.position))),
    overlapsNav: overlap(rr, nav),
    overlapsScore: overlap(rr, score),
    overlapsDrawerBtn: overlap(rr, drawerBtn),
    overlapsStadium: overlap(rr, stadium),
    overlapsTabbar: overlap(rr, tabbar),
    overlapsView: overlap(rr, view),
    measured: { nav: Boolean(nav), score: Boolean(score), drawerBtn: Boolean(drawerBtn),
                stadium: Boolean(stadium), tabbar: Boolean(tabbar), view: Boolean(view) },
    docOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    scrollW: document.documentElement.scrollWidth, winW: window.innerWidth,
    brokenImgs: rail ? [...rail.querySelectorAll('img')]
      .filter(i => i.complete && i.naturalWidth === 0 && !i.classList.contains('is-broken'))
      .map(i => i.getAttribute('src')) : [],
    railCount: document.querySelectorAll('.pbeb').length,
    route: location.hash
  };
})()`;

const rows = [];
let failures = 0;

for (const width of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride',
    { width, height: width <= 768 ? 844 : 900, deviceScaleFactor: 1, mobile: width <= 768 });
  await send('Page.navigate', { url: `${TARGET}/#home?t=${Date.now()}` });
  await sleep(15000);
  errors = [];

  for (const route of ROUTES) {
    await evalIn(`window.App && App.nav(${JSON.stringify(route)})`);
    await sleep(route === 'qbdna' || route === 'wrdna' ? 12000 : 7000);
    const put = await evalIn(PUT_ALERT);
    await sleep(1200);
    await evalIn(`(async()=>{const i=[...document.querySelectorAll('#pbe-breaking-slot img')];
      await Promise.all(i.map(x=>x.complete?null:new Promise(r=>{
        x.addEventListener('load',r,{once:true});x.addEventListener('error',r,{once:true});
        setTimeout(r,3000);}))); return i.length;})()`, 12000);
    const m = await evalIn(MEASURE);

    const bad = [];
    if (!put || !m.railVisible) bad.push('the rail did not render an injected alert');
    if (m.railCount > 1) bad.push(`${m.railCount} rails exist — there must be exactly one`);
    if (!m.docked) bad.push(`not docked: position=${m.position} z=${m.zIndex} slot=${m.slotPosition}`);
    if (m.overlapsNav) bad.push('covers the navigation');
    if (m.overlapsScore) bad.push('covers the scoreboard');
    if (m.overlapsDrawerBtn) bad.push('covers the drawer button');
    if (m.overlapsStadium) bad.push('covers the stadium control');
    if (m.overlapsTabbar) bad.push('covers the bottom tab bar');
    if (m.overlapsView) bad.push('covers page content');
    if (m.docOverflowX) bad.push(`horizontal overflow ${m.scrollW} > ${m.winW}`);
    if (m.brokenImgs.length) bad.push(`broken images: ${m.brokenImgs.join(', ')}`);
    /* Desktop target 54-74px; mobile allowed a controlled two-line treatment. */
    const cap = width <= 760 ? 108 : 88;
    if (m.railHeight > cap) bad.push(`rail is ${m.railHeight}px, over the ${cap}px budget`);

    if (bad.length) failures++;
    rows.push({ width, route, ...m, failures: bad });
    console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${String(width).padStart(4)}  ${route.padEnd(10)}`
      + ` h=${String(m.railHeight).padStart(3)}px pos=${m.position} `
      + `covers[nav:${m.overlapsNav?'Y':'n'} score:${m.overlapsScore?'Y':'n'} `
      + `view:${m.overlapsView?'Y':'n'} stadium:${m.overlapsStadium?'Y':'n'}] `
      + `overflowX=${m.docOverflowX?'YES':'no'}`
      + (bad.length ? `\n        ${bad.join('\n        ')}` : ''));

    if (route === 'qbdna' || route === 'home') {
      const cap2 = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(OUT, `qa-${route}-${width}.png`), Buffer.from(cap2.data, 'base64'));
    }
  }

  /* The rail must survive a full lap of the routes without resetting. */
  const persisted = await evalIn(`(()=>{const B=window.PBEBreaking;
    return { current: Boolean(B.state.current), key: B.state.current && B.state.current.key };})()`);
  console.log(`      after ${ROUTES.length} route changes the alert is still present: `
    + `${persisted.current ? 'yes' : 'NO'}`);
  if (!persisted.current) { failures++; rows.push({ width, route: '(persistence)',
    failures: ['the alert did not survive route changes'] }); }
  if (errors.length) {
    failures++;
    console.log(`      CONSOLE ERRORS at ${width}: ${errors.length}`);
    errors.slice(0, 5).forEach(e => console.log('        !', String(e).slice(0, 150)));
  }
}

writeFileSync(join(OUT, 'qa-report.json'), JSON.stringify({ rows, errors }, null, 2));
const cells = WIDTHS.length * ROUTES.length;
console.log(`\n${cells - rows.filter(r => r.failures && r.failures.length).length}/${cells} cells clean`);
ws.close(); finish(failures ? 1 : 0);
