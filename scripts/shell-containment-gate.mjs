/* SHELL CONTAINMENT GATE — the global chrome must never clip, crop or strand
 * a control, and the stadium selector's menu must open fully inside the
 * viewport, above everything it is supposed to be above.
 *
 *   node scripts/shell-containment-gate.mjs [widths] [outDir]
 *   PBE_ALERT=1   also inject a PBE BREAKING alert before measuring
 *
 * Everything is MEASURED from what the browser paints: bounding rects of every
 * top-bar control, document scrollWidth against the viewport, the open menu's
 * rect, and hit testing across the open menu so an ancestor with overflow
 * clipping or a stacking context that buries it cannot pass by reading right
 * in the stylesheet.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WIDTHS = (process.argv[2] || '1440,1280,1100,1024,987,900,768,430,390').split(',').map(Number);
const OUT = process.argv[3] || 'shots/shell';
const PORT = process.env.PBE_PORT || '4321';
const TARGET = process.env.PBE_BASE || `http://localhost:${PORT}`;
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WITH_ALERT = process.env.PBE_ALERT === '1';
const SHOT_WIDTHS = new Set((process.env.PBE_SHOTS || '1440,987,900,390').split(',').map(Number));
const DP = 9300 + Math.floor(Math.random() * 90);

mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-shell-'));
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
let errors = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails?.exception?.description
      || m.params.exceptionDetails?.text || 'exception');
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
  }
};
await send('Runtime.enable'); await send('Page.enable');
const evalIn = async (expr, ms = 30000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
    sleep(ms).then(() => { throw new Error('WEDGED: ' + expr.slice(0, 70)); })
  ]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' +
    (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
};
async function shot(name) {
  const cap = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(cap.data, 'base64'));
}

const PUT_ALERT = `(() => {
  const B = window.PBEBreaking; if (!B) return false;
  B.stop(); B.state.queue.length = 0; B.state.current = null; B.state.seen.clear(); B.state.dismissed.clear();
  return B.offer({ key: 'shell-gate:' + Date.now(), family: 'NEWS', kind: 'NFL_BREAKING',
    priority: B.PRIORITY.NFL_BREAKING_MAJOR, label: 'NFL BREAKING',
    headline: 'Chiefs rule out starting quarterback for Sunday with an ankle injury',
    source: 'PropBetEdge', ts: new Date().toISOString(), teams: ['KC'], players: [],
    cta: [{ label: 'READ UPDATE', href: 'https://propbetedge.ai/news/nfl/x', kind: 'article' }],
    visible_ms: 600000, provenance: {} }).accepted;
})()`;

/* The controls that must be reachable. A control that is display:none at a
   width is not measured (the phone header is a different authority). */
const MEASURE = `(() => {
  const vw = window.innerWidth;
  const painted = el => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top),
             bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const clipAncestor = el => {
    for (let a = el && el.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (/(hidden|clip|auto|scroll)/.test(cs.overflow + cs.overflowX + cs.overflowY)) {
        return (a.id ? '#' + a.id : a.tagName.toLowerCase()) + '.' + String(a.className || '').split(' ')[0];
      }
    }
    return null;
  };
  const q = s => document.querySelector(s);
  const controls = {
    brand: q('#pbe-sports-shell .pbes-brand'),
    livePill: q('#pbes-live-pill'),
    date: q('#pbe-sports-shell .pbes-date'),
    stadium: q('.pbe-stadium-toggle'),
    search: q('#pbes-search'),
    account: q('#pbes-account'),
    scorebar: q('#pbe-sports-shell .pbes-scorebar'),
    scorePrev: q('#pbes-score-prev'),
    scoreNext: q('#pbes-score-next'),
    primary: q('#pbe-sports-shell .pbes-primary'),
    research: q('#pbe-sports-shell .pbes-research'),
    rail: q('#pbe-breaking-slot .pbeb'),
    mobileMenu: q('.mobile-menu-btn, .hamburger, [data-drawer], #pbes-menu')
  };
  const out = {}; const problems = [];
  for (const [k, el] of Object.entries(controls)) {
    const r = painted(el);
    out[k] = r;
    if (!r) continue;
    if (r.left < 0) problems.push(k + ' starts off-screen left (' + r.left + ')');
    if (r.right > vw) problems.push(k + ' ends off-screen right (' + r.right + ' > ' + vw + ')');
  }
  // the top bar and its right cluster: is the cluster wider than its box?
  const top = q('#pbe-sports-shell .pbes-top'), right = q('#pbe-sports-shell .pbes-right');
  const wants = el => el ? { scroll: el.scrollWidth, client: el.clientWidth } : null;
  const shellOverflow = wants(q('#pbe-sports-shell')), topOverflow = wants(top), rightOverflow = wants(right);
  if (topOverflow && topOverflow.scroll > topOverflow.client + 1) problems.push('top bar content wider than its box (' + topOverflow.scroll + ' > ' + topOverflow.client + ')');
  if (rightOverflow && rightOverflow.scroll > rightOverflow.client + 1) problems.push('right cluster wider than its box (' + rightOverflow.scroll + ' > ' + rightOverflow.client + ')');
  const docOverflow = document.documentElement.scrollWidth - vw;
  if (docOverflow > 1) problems.push('document overflows horizontally by ' + docOverflow + 'px');
  // the stadium control's clipping ancestors
  const stadiumClip = clipAncestor(q('.pbe-stadium-menu'));
  // does the stadium button collide with a neighbour?
  const overlap = (a, b) => a && b && a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
  for (const [a, b] of [['stadium', 'search'], ['stadium', 'account'], ['stadium', 'date'], ['stadium', 'livePill'], ['date', 'livePill'], ['brand', 'livePill'], ['brand', 'stadium'], ['search', 'account']]) {
    if (overlap(out[a], out[b])) problems.push(a + ' overlaps ' + b);
  }
  return { vw, docOverflow, shellOverflow, topOverflow, rightOverflow, stadiumClip, controls: out, problems };
})()`;

const OPEN_MENU = `(() => {
  const t = document.querySelector('.pbe-stadium-toggle'); if (!t) return false;
  const c = t.closest('.pbe-stadium-control');
  if (!c.classList.contains('open')) t.click();
  return c.classList.contains('open');
})()`;
const CLOSE_MENU = `(() => {
  const c = document.querySelector('.pbe-stadium-control');
  if (c && c.classList.contains('open')) document.querySelector('.pbe-stadium-toggle').click();
  return c ? !c.classList.contains('open') : true;
})()`;

const MEASURE_MENU = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const m = document.querySelector('.pbe-stadium-menu'); if (!m) return { open: false };
  const cs = getComputedStyle(m);
  const r = m.getBoundingClientRect();
  const shell = document.getElementById('pbe-sports-shell');
  const shellR = shell ? shell.getBoundingClientRect() : null;
  const pts = [];
  for (const fx of [0.08, 0.5, 0.92]) for (const fy of [0.06, 0.5, 0.94])
    pts.push([Math.round(r.left + r.width * fx), Math.round(r.top + r.height * fy)]);
  const buried = pts.filter(([x, y]) => {
    if (x < 0 || y < 0 || x > vw || y > vh) return true;
    const t = document.elementFromPoint(x, y); return !t || !m.contains(t);
  }).map(([x, y]) => { const t = document.elementFromPoint(x, y);
    return x + ',' + y + ':' + (t ? (t.tagName + '.' + String(t.className || '')).slice(0, 40) : 'off-viewport'); });
  const opts = [...m.querySelectorAll('.pbe-stadium-option')].map(o => {
    const rr = o.getBoundingClientRect();
    const cx = Math.round(rr.left + rr.width / 2), cy = Math.round(rr.top + Math.min(rr.height / 2, 30));
    const t = document.elementFromPoint(cx, cy);
    return { visibleInMenu: rr.bottom > r.top && rr.top < r.bottom, hit: Boolean(t && o.contains(t)) };
  });
  const problems = [];
  if (cs.opacity === '0' || cs.pointerEvents === 'none') problems.push('menu did not open');
  if (r.left < 8) problems.push('menu left edge ' + Math.round(r.left) + ' < 8');
  if (r.right > vw - 8) problems.push('menu right edge ' + Math.round(r.right) + ' > ' + (vw - 8));
  if (r.top < 0) problems.push('menu top ' + Math.round(r.top) + ' above viewport');
  if (r.bottom > vh + 1) problems.push('menu bottom ' + Math.round(r.bottom) + ' below viewport ' + vh);
  if (buried.length) problems.push('menu buried at ' + buried.length + '/9 points: ' + buried.join(' | '));
  if (!opts.every(o => !o.visibleInMenu || o.hit)) problems.push('a visible option is not hit-testable');
  const inShell = shell && shell.contains(m);
  return { open: true, rect: { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) },
    vw, vh, position: cs.position, zIndex: cs.zIndex, inShell, scrollable: m.scrollHeight > m.clientHeight + 1,
    parent: m.parentElement ? (m.parentElement.id ? '#' + m.parentElement.id : m.parentElement.className) : null,
    shellBottom: shellR ? Math.round(shellR.bottom) : null, options: opts.length, problems };
})()`;

const COEX = new Set((process.env.PBE_COEX || '1440,987,390').split(',').map(Number));
const RAIL_OVER_MENU = `(() => {
  const r = document.querySelector('#pbe-breaking-slot .pbeb'), m = document.querySelector('.pbe-stadium-menu');
  if (!r || !m) return { rail: Boolean(r), menu: Boolean(m) };
  const a = r.getBoundingClientRect(), b = m.getBoundingClientRect();
  const x = Math.max(a.left, b.left), y = Math.max(a.top, b.top), X = Math.min(a.right, b.right), Y = Math.min(a.bottom, b.bottom);
  if (X <= x || Y <= y) return { rail: true, menu: true, overlap: false };
  const t = document.elementFromPoint((x + X) / 2, (y + Y) / 2);
  return { rail: true, menu: true, overlap: true, menuOnTop: Boolean(t && m.contains(t)) };
})()`;
const PICKER_OVER_MENU = `(() => {
  const panel = document.querySelector('.pdna-modal-panel'), c = document.querySelector('.pbe-stadium-control');
  if (!panel) return { picker: false };
  const r = panel.getBoundingClientRect(); const pts = [];
  for (const fx of [0.12, 0.5, 0.88]) for (const fy of [0.06, 0.5, 0.94]) pts.push([r.left + r.width * fx, r.top + r.height * fy]);
  const buried = pts.filter(([x, y]) => { const t = document.elementFromPoint(x, y); return t && !panel.contains(t); }).length;
  return { picker: true, buried, stadiumClosed: !c.classList.contains('open') };
})()`;

const rows = []; let failures = 0;
for (const width of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride',
    { width, height: width <= 768 ? 844 : 900, deviceScaleFactor: 1, mobile: width <= 768 });
  await send('Page.navigate', { url: `${TARGET}/#home?t=${Date.now()}` });
  await sleep(12000);
  errors = [];
  if (WITH_ALERT) { await evalIn(PUT_ALERT); await sleep(800); }
  await evalIn(CLOSE_MENU);
  const closed = await evalIn(MEASURE);
  if (SHOT_WIDTHS.has(width)) await shot(`stadium-closed${WITH_ALERT ? '-alert' : ''}-${width}`);
  const opened = await evalIn(OPEN_MENU);
  await sleep(500);
  const menu = opened ? await evalIn(MEASURE_MENU) : { open: false, problems: ['toggle not found or would not open'] };
  if (SHOT_WIDTHS.has(width)) await shot(`stadium-open${WITH_ALERT ? '-alert' : ''}-${width}`);
  await evalIn(CLOSE_MENU);

  const bad = [...closed.problems, ...menu.problems];

  /* ---- COEXISTENCE: one stacking order, understood by measurement ------ */
  const coex = {};
  if (COEX.has(width) && !WITH_ALERT) {
    // the rail and the menu, together
    await evalIn(PUT_ALERT); await sleep(700);
    await evalIn(OPEN_MENU); await sleep(500);
    coex.withRail = await evalIn(MEASURE_MENU);
    coex.railOverMenu = await evalIn(RAIL_OVER_MENU);
    if (coex.withRail.problems.length) bad.push('with the rail showing: ' + coex.withRail.problems.join('; '));
    if (coex.railOverMenu.overlap && !coex.railOverMenu.menuOnTop) bad.push('the breaking rail paints over the open stadium menu');
    await shot(`stadium-open-rail-${width}`);
    await evalIn(CLOSE_MENU);

    // a Player DNA page, the menu, then the switcher over it
    await evalIn(`window.App && App.nav('qbdna')`); await sleep(12000);
    await evalIn(OPEN_MENU); await sleep(500);
    coex.onQbDna = await evalIn(MEASURE_MENU);
    if (coex.onQbDna.problems.length) bad.push('on QB DNA: ' + coex.onQbDna.problems.join('; '));
    await evalIn(`document.querySelector('[data-picker]')?.click()`); await sleep(1500);
    coex.picker = await evalIn(PICKER_OVER_MENU);
    if (!coex.picker.picker) bad.push('the Player DNA switcher did not open while the stadium menu was open');
    else {
      if (coex.picker.buried) bad.push(`the switcher is buried at ${coex.picker.buried}/9 points with the stadium menu involved`);
      if (!coex.picker.stadiumClosed) bad.push('the stadium menu stayed open under the modal switcher');
    }
    await shot(`stadium-picker-${width}`);
    await evalIn(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await sleep(500);

    // PBEcast and the menu
    await evalIn(`window.App && App.nav('pbecast')`); await sleep(8000);
    await evalIn(OPEN_MENU); await sleep(500);
    coex.onPbecast = await evalIn(MEASURE_MENU);
    if (coex.onPbecast.problems.length) bad.push('on PBEcast: ' + coex.onPbecast.problems.join('; '));
    await evalIn(CLOSE_MENU);

    // the phone drawer: opening it from the tab bar must close the popover
    if (width <= 900) {
      await evalIn(OPEN_MENU); await sleep(300);
      coex.drawer = await evalIn(`(()=>{const items=[...document.querySelectorAll('.mbn-item')];
        const tab=items.find(i=>/menu/i.test(i.textContent)); if(!tab) return {found:false};
        tab.click(); return {found:true};})()`);
      await sleep(900);
      coex.afterDrawer = await evalIn(`(()=>({stadiumOpen:document.querySelector('.pbe-stadium-control').classList.contains('open'),
        menuInBody:document.querySelector('body > .pbe-stadium-menu')!==null}))()`);
      if (coex.drawer.found && coex.afterDrawer.stadiumOpen) bad.push('the stadium menu stayed open when the phone drawer was opened');
      await shot(`stadium-drawer-${width}`);
      await evalIn(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await sleep(400);
    }
    await evalIn(`window.App && App.nav('home')`); await sleep(2500);
    await evalIn(`window.PBEBreaking && (PBEBreaking.state.current=null, PBEBreaking._test.render())`);
  }

  if (errors.length) bad.push(`${errors.length} console errors: ${errors[0].slice(0, 100)}`);
  if (bad.length) failures++;
  rows.push({ width, closed, menu, coex, failures: bad });
  const c = closed.controls;
  const fmt = k => c[k] ? `${c[k].left}-${c[k].right}` : '—';
  console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${String(width).padStart(4)}  docOverflow=${closed.docOverflow}  `
    + `brand ${fmt('brand')}  pill ${fmt('livePill')}  date ${fmt('date')}  stadium ${fmt('stadium')}  search ${fmt('search')}  pro ${fmt('account')}`
    + `\n        menu: ${menu.open ? `${menu.rect.left}-${menu.rect.right} x ${menu.rect.top}-${menu.rect.bottom} pos=${menu.position} z=${menu.zIndex} inShell=${menu.inShell} clipAncestor=${closed.stadiumClip}` : 'not open'}`
    + (bad.length ? `\n        ${bad.join('\n        ')}` : ''));
}
writeFileSync(join(OUT, `shell-report${WITH_ALERT ? '-alert' : ''}.json`), JSON.stringify({ rows }, null, 2));
console.log(`\n${WIDTHS.length - failures}/${WIDTHS.length} widths clean`);
ws.close(); finish(failures ? 1 : 0);
