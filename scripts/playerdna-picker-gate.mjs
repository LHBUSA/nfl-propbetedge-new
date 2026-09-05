/* PHASE 0 PROOF — the shared player switcher must actually sit above the shell.
 * node scripts/playerdna-picker-gate.mjs [width,width,...]
 *   PBE_ROUTE=qbdna|wrdna|rbdna|tedna   (default: all four)
 *
 * WHY THIS IS NOT A Z-INDEX CHECK
 * A z-index assertion proves nothing. A descendant of an ancestor that
 * establishes its own stacking context cannot escape it however large its
 * z-index is, so `z-index: 99999` can read as correct in the stylesheet and
 * still render underneath the navigation. The only honest test is the one the
 * browser itself performs: HIT TESTING. At several points across the open
 * panel, ask document.elementFromPoint what is actually on top. If anything
 * answers that is not inside the picker, the picker is buried.
 *
 * The gate also proves the portal itself — that the panel is a child of
 * document.body and NOT of the product's own view container — because a
 * picker that happens to render on top today while still living inside the
 * page subtree will be reburied by the next stacking context anyone adds.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WIDTHS = (process.argv[2] || '1440,1280,900,430,390').split(',').map(Number);
const ROUTES = process.env.PBE_ROUTE ? [process.env.PBE_ROUTE]
  : ['qbdna', 'wrdna', 'rbdna', 'tedna'];
const OUT = process.env.PBE_OUT || 'shots/picker';
const PORT = process.env.PBE_PORT || '4321';
const TARGET = process.env.PBE_BASE || `http://localhost:${PORT}`;
const SHARE = process.env.PBE_SHARE || '';
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DP = 9700 + Math.floor(Math.random() * 90);

mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-pick-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${DP}`, `--user-data-dir=${dir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
function finish(c) { try { chrome.kill(); } catch {} setTimeout(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(c); }, 200); }
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
let id = 1; const pending = new Map();
const send = (m, p = {}) => { const n = id++; ws.send(JSON.stringify({ id: n, method: m, params: p }));
  return new Promise((res, rej) => pending.set(n, { resolve: res, reject: rej })); };
const errors = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails?.exception?.description || 'exception');
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

if (SHARE) {
  await send('Page.navigate', { url: `${TARGET}/?_vercel_share=${SHARE}` });
  await sleep(9000);
}

const PROBE = `(() => {
  const panel = document.querySelector('.pdna-modal-panel');
  const modal = document.querySelector('.pdna-modal');
  const root  = document.getElementById('pbe-player-dna-modal-root');
  if (!panel || !modal) return { open: false };

  const r = panel.getBoundingClientRect();
  /* Nine points across the panel. A single centre point can sit in a gap in
     the overlaying element and report a false pass. */
  const pts = [];
  for (const fx of [0.12, 0.5, 0.88]) {
    for (const fy of [0.06, 0.5, 0.94]) {
      pts.push([Math.round(r.left + r.width * fx), Math.round(r.top + r.height * fy)]);
    }
  }
  const buried = [];
  for (const [x, y] of pts) {
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
    const top = document.elementFromPoint(x, y);
    if (!top) { buried.push({ x, y, on: 'nothing' }); continue; }
    if (!panel.contains(top) && top !== panel) {
      buried.push({ x, y, on: (top.tagName + '.' + String(top.className || '')).slice(0, 90) });
    }
  }

  /* The portal itself. The panel must hang off document.body, not off the
     product's own view container, or it is one new stacking context away
     from being reburied. */
  const inRoot = Boolean(root && root.contains(panel));
  const rootParentIsBody = Boolean(root && root.parentElement === document.body);
  const inView = Boolean(document.getElementById('view-container')?.contains(panel));

  /* What the shell is actually painting, so a failure names its cause. */
  const shellTop = (() => {
    const el = document.elementFromPoint(Math.round(innerWidth / 2), 8);
    return el ? (el.tagName + '.' + String(el.className || '')).slice(0, 90) : 'none';
  })();

  const cs = getComputedStyle(root || document.body);
  return {
    open: true, buried, buriedCount: buried.length,
    inRoot, rootParentIsBody, inView,
    rootZ: cs.zIndex, rootPos: cs.position,
    panelRect: { x: Math.round(r.left), y: Math.round(r.top),
                 w: Math.round(r.width), h: Math.round(r.height) },
    fitsViewport: r.width <= innerWidth + 1 && r.height <= innerHeight + 1,
    scrollLocked: document.body.classList.contains('pdna-modal-open'),
    focusInside: panel.contains(document.activeElement),
    listed: document.querySelectorAll('.pdna-modal .q2-pick-row, .pdna-modal [data-pick]').length,
    shellTopAtHeader: shellTop
  };
})()`;

const results = [];
let failures = 0;

for (const route of ROUTES) {
  for (const width of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride',
      { width, height: width <= 768 ? 844 : 900, deviceScaleFactor: 1, mobile: width <= 768 });
    await send('Page.navigate', { url: `${TARGET}/#${route}?t=${Date.now()}` });
    await sleep(14000);
    await evalIn(`window.App && App.nav(${JSON.stringify(route)})`, 15000);
    await sleep(7000);

    // open the switcher exactly the way a reader would: by clicking it
    const opened = await evalIn(`(()=>{const b=document.querySelector('.q2-change[data-picker], [data-picker]');
      if(!b) return false; b.click(); return true;})()`);
    await sleep(1200);

    const m = await evalIn(PROBE);
    const row = { route, width, opened, ...m };

    const bad = [];
    if (!opened) bad.push('no switcher control found');
    else if (!m.open) bad.push('clicking the switcher opened nothing');
    else {
      if (m.buriedCount) bad.push(`BURIED at ${m.buriedCount}/9 points by ${m.buried.map(b => b.on).join(', ')}`);
      if (!m.inRoot) bad.push('panel is not inside #pbe-player-dna-modal-root');
      if (!m.rootParentIsBody) bad.push('the modal root is not a direct child of document.body');
      if (m.inView) bad.push('panel is still inside #view-container — it was not portalled');
      if (!m.fitsViewport) bad.push(`panel ${m.panelRect.w}x${m.panelRect.h} overflows the viewport`);
      if (!m.scrollLocked) bad.push('background scroll is not locked');
      if (!m.focusInside) bad.push('focus was not moved into the panel');
      if (!m.listed) bad.push('the panel lists no players');
    }
    row.failures = bad;
    if (bad.length) failures++;
    results.push(row);

    const cap = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `picker-${route}-${width}.png`), Buffer.from(cap.data, 'base64'));

    console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${route} @ ${width}  `
      + `hit-test ${9 - (m.buriedCount ?? 9)}/9 topmost  portal=${m.inRoot ? 'body' : 'NO'}  `
      + `z=${m.rootZ}  panel ${m.panelRect ? m.panelRect.w + 'x' + m.panelRect.h : '—'}  `
      + `players ${m.listed ?? 0}`
      + (bad.length ? `\n      ${bad.join('\n      ')}` : ''));

    await evalIn(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await sleep(400);
  }
}

writeFileSync(join(OUT, 'picker-report.json'), JSON.stringify({ results, errors }, null, 2));
console.log(`\n${results.length - failures}/${results.length} route/width combinations pass`);
if (errors.length) { console.log('console errors:'); errors.slice(0, 8).forEach(e => console.log('  !', String(e).slice(0, 160))); }
ws.close(); finish(failures ? 1 : 0);
