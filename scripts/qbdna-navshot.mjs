/* Captures HOW QB DNA is reached, at a given width.
 *   node scripts/qbdna-navshot.mjs <outDir> <width>
 * Desktop: the shell row with the QB DNA tab highlighted.
 * Mobile:  the bottom bar, then the drawer opened by Menu with QB DNA in view.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] || 'navshot';
const WIDTH = Number(process.argv[3] || 390);
const TARGET = process.env.PBE_BASE || `http://localhost:${process.env.PBE_PORT || '4321'}`;
const SHARE = process.env.PBE_SHARE || '';
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DP = 9900 + Math.floor(Math.random() * 90);

mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-ns-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${DP}`, `--user-data-dir=${dir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
function finish(c) { try { chrome.kill(); } catch {} setTimeout(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(c); }, 200); }
setTimeout(() => { console.error('DEADLINE'); finish(3); }, 300000).unref?.();

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
ws.onmessage = ev => { const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
await send('Runtime.enable'); await send('Page.enable');
const evalIn = async (e, ms = 30000) => (await Promise.race([
  send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }),
  sleep(ms).then(() => { throw new Error('WEDGED'); })])).result?.value;
const shot = async name => {
  const c = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(c.data, 'base64'));
  console.log('  wrote', name);
};

if (SHARE) { await send('Page.navigate', { url: `${TARGET}/?_vercel_share=${SHARE}` }); await sleep(9000); }

const touch = WIDTH <= 768;
await send('Emulation.setDeviceMetricsOverride',
  { width: WIDTH, height: touch ? 844 : 900, deviceScaleFactor: 1, mobile: touch });
await send('Page.navigate', { url: `${TARGET}/#qbdna?t=${Date.now()}` });
await sleep(17000);

const model = await evalIn(`(()=>{const p=document.querySelector('.pbes-primary');
  return p ? getComputedStyle(p).display!=='none' : false;})()`);

if (model) {
  // desktop: the tab, highlighted, in its row
  await evalIn(`window.scrollTo(0,0)`);
  await sleep(600);
  await shot(`nav-desktop-${WIDTH}.png`);
} else {
  // mobile step 1: the bottom bar, on the QB DNA surface
  await evalIn(`window.scrollTo(0, document.body.scrollHeight)`);
  await sleep(900);
  await shot(`nav-mobile-${WIDTH}-1-bottombar.png`);
  // mobile step 2: Menu opens the drawer, QB DNA scrolled into view
  await evalIn(`(async()=>{document.getElementById('mbn-menu').click();
    await new Promise(r=>setTimeout(r,1500));
    const l=document.getElementById('nav-qbdna');
    if(l){ l.scrollIntoView({block:'center'});
      l.style.outline='2px solid #d4af37'; l.style.outlineOffset='2px'; }
    await new Promise(r=>setTimeout(r,900));
    return !!l;})()`);
  await sleep(900);
  await shot(`nav-mobile-${WIDTH}-2-drawer.png`);
}
ws.close(); finish(0);
