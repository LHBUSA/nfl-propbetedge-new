/* FIRST VIEWPORT captures — what a reader actually sees before scrolling.
 *   node scripts/qbdna-firstview.mjs <outDir> [width] [height]
 * PBE_BASE / PBE_SHARE point it at a deployed preview.
 *
 * Also reports what the first viewport CONTAINS, because the point of the
 * capture is that the best information is not buried below the fold.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] || 'firstview';
const WIDTH = Number(process.argv[3] || 1440);
const HEIGHT = Number(process.argv[4] || 900);
const TABS = ['overview', 'props', 'conditions', 'compare'];
const TARGET = process.env.PBE_BASE || `http://localhost:${process.env.PBE_PORT || '4321'}`;
const SHARE = process.env.PBE_SHARE || '';
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DP = 9900 + Math.floor(Math.random() * 90);

mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-fv-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${DP}`, `--user-data-dir=${dir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
function finish(c) { try { chrome.kill(); } catch {} setTimeout(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(c); }, 200); }
setTimeout(() => { console.error('DEADLINE'); finish(3); }, 420000).unref?.();

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
const evalIn = async (e, ms = 45000) => (await Promise.race([
  send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }),
  sleep(ms).then(() => { throw new Error('WEDGED'); })])).result?.value;

if (SHARE) { await send('Page.navigate', { url: `${TARGET}/?_vercel_share=${SHARE}` }); await sleep(9000); }

await send('Emulation.setDeviceMetricsOverride',
  { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: WIDTH <= 768 });
await send('Page.navigate', { url: `${TARGET}/#wrdna?t=${Date.now()}` });
await sleep(16000);
await evalIn('window.App && App.nav("wrdna")', 15000);
await sleep(7000);

for (const tab of TABS) {
  await evalIn(`(()=>{const b=[...document.querySelectorAll('.q2-tab')]
    .find(x=>x.dataset.tab===${JSON.stringify(tab)}); if(b) b.click(); return !!b;})()`);
  await sleep(tab === 'overview' ? 8000 : 6000);
  await evalIn('window.scrollTo(0,0)');
  await sleep(700);

  /* What is actually ABOVE the fold — the whole point of the capture. */
  const above = await evalIn(`(()=>{
    const fold = innerHeight;
    const seen = [];
    document.querySelectorAll('.q2-hero-name,.q2-hero-line b,.q2-hero-next-m,'
      + '.q2-head h2,.q2-big-k,.q2-mkt-k,.q2-today-fact-k,.q2-vs-name').forEach(el=>{
      const r = el.getBoundingClientRect();
      if (r.top < fold && r.bottom > 0) {
        const t = (el.textContent||'').replace(/\\s+/g,' ').trim();
        if (t) seen.push(t.slice(0,42));
      }
    });
    return { fold, seen: [...new Set(seen)] };
  })()`);

  const cap = await send('Page.captureScreenshot', { format: 'png' });
  const name = `firstview-wr-${tab}-${WIDTH}.png`;
  writeFileSync(join(OUT, name), Buffer.from(cap.data, 'base64'));
  console.log(`${name}`);
  console.log(`   above the fold: ${above.seen.join(' | ')}`);
}
ws.close(); finish(0);
