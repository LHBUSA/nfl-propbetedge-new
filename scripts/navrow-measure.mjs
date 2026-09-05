/* Measure the primary nav row's real geometry at a set of widths.
 * node scripts/navrow-measure.mjs [width,width,...]
 *
 * The nav gate reports "button outside the viewport"; this says by how much
 * and which group is responsible, so the fix is a measurement rather than a
 * guess.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WIDTHS = (process.argv[2] || '1440,1366,1280,1180,1051').split(',').map(Number);
const PORT = process.env.PBE_PORT || '4321';
const TARGET = process.env.PBE_BASE || `http://localhost:${PORT}`;
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DP = 9600 + Math.floor(Math.random() * 90);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-nav-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${DP}`, `--user-data-dir=${dir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
function finish(c) { try { chrome.kill(); } catch {} setTimeout(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(c); }, 200); }
setTimeout(() => { console.error('DEADLINE'); finish(3); }, 180000).unref?.();

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
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
};
await send('Runtime.enable'); await send('Page.enable');
const evalIn = async expr => (await send('Runtime.evaluate',
  { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

for (const width of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride',
    { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${TARGET}/#home?t=${Date.now()}` });
  await sleep(11000);
  const m = await evalIn(`(()=>{
    const row = document.querySelector('.pbes-primary');
    if (!row) return { none: true };
    const rr = row.getBoundingClientRect();
    const cs = getComputedStyle(row);
    const groups = [...row.querySelectorAll('.pbes-nav-group')].map(g => {
      const r = g.getBoundingClientRect();
      const k = g.querySelector('.pbes-nav-k, .pbes-nav-label, b, strong');
      return { name: (k ? k.textContent : '').trim().slice(0, 20),
               x: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
               btns: g.querySelectorAll('a,button').length };
    });
    const over = [...row.querySelectorAll('a,button')]
      .map(b => ({ t: (b.textContent||'').trim().slice(0,14),
                   right: Math.round(b.getBoundingClientRect().right) }))
      .filter(b => b.right > innerWidth - 2);
    return { rowW: Math.round(rr.width), rowRight: Math.round(rr.right),
             rowH: Math.round(rr.height), scrollW: row.scrollWidth,
             wrap: cs.flexWrap, gap: cs.gap, win: innerWidth,
             overflowing: row.scrollWidth > Math.ceil(rr.width) + 1,
             groups, over };
  })()`);
  const bad = m.overflowing || (m.over && m.over.length);
  console.log(`${bad ? 'OVER ' : 'ok   '} ${width}  row ${m.rowW}px (scroll ${m.scrollW}) h=${m.rowH} wrap=${m.wrap}`);
  for (const g of m.groups) console.log(`        ${g.name.padEnd(14)} x${String(g.x).padStart(5)} → ${String(g.right).padStart(5)}  ${g.btns} items`);
  if (m.over && m.over.length) console.log(`        PAST EDGE: ${m.over.map(o => o.t + '@' + o.right).join(', ')}`);
}
ws.close(); finish(0);
