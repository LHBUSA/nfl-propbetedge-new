/* Probe the rendered /#qbdna DOM. node scripts/qbdna-probe.mjs "<expr>" [tab] [width] */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXPR = process.argv[2];
const TAB = process.argv[3] || 'overview';
const WIDTH = parseInt(process.argv[4] || '1440', 10);
const PORT = process.env.PBE_PORT || '4321';
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DP = 9900 + Math.floor(Math.random() * 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-probe-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${DP}`, `--user-data-dir=${dir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
function finish(c) { try { chrome.kill(); } catch {} setTimeout(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(c); }, 200); }
setTimeout(() => { console.error('DEADLINE'); finish(3); }, 180000).unref?.();

async function wsUrl() {
  for (let i = 0; i < 100; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${DP}/json/list`)).json();
      const p = l.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl; } catch {}
    await sleep(200);
  }
  throw new Error('devtools');
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
await send('Emulation.setDeviceMetricsOverride',
  { width: WIDTH, height: WIDTH <= 768 ? 844 : 900, deviceScaleFactor: 1, mobile: WIDTH <= 768 });
await send('Page.navigate', { url: `http://localhost:${PORT}/#qbdna?t=${Date.now()}` });
await sleep(15000);
const ev = async (e, ms = 25000) => {
  const r = await Promise.race([send('Runtime.evaluate',
    { expression: e, returnByValue: true, awaitPromise: true }),
    sleep(ms).then(() => { throw new Error('WEDGED'); })]);
  return r.result?.value;
};
await ev(`window.App && App.nav('qbdna')`, 12000);
await sleep(6000);
await ev(`(()=>{const b=[...document.querySelectorAll('.qbd-tab')]
  .find(x=>x.dataset.tab===${JSON.stringify(TAB)}); if(b)b.click(); return !!b;})()`);
await sleep(6000);
console.log(JSON.stringify(await ev(EXPR), null, 1));
ws.close(); finish(0);
