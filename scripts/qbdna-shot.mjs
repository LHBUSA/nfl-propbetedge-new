/* Full-page screenshots of /#qbdna against the local dev server.
 * node scripts/qbdna-shot.mjs <outDir> [width,width,...] [tab,tab,...]
 * Requires: node scripts/qbdna-dev-server.mjs running on PBE_PORT (default 4321).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] || 'shots';
const WIDTHS = (process.argv[3] || '1440,430,390').split(',').map(Number);
const TABS = (process.argv[4] || 'overview,props,conditions,compare').split(',');
const PORT = process.env.PBE_PORT || '4321';
const TARGET = `http://localhost:${PORT}`;
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DP = 9900 + Math.floor(Math.random() * 90);

mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-shot-'));
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
const errors = [];
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
    sleep(ms).then(() => { throw new Error('WEDGED: ' + expr.slice(0, 60)); })
  ]);
  return r.result?.value;
};

const report = [];
for (const width of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride',
    { width, height: width <= 768 ? 844 : 900, deviceScaleFactor: 1, mobile: width <= 768 });
  await send('Page.navigate', { url: `${TARGET}/#qbdna?t=${Date.now()}` });
  await sleep(15000);
  // the loader may boot to home; force the route
  await evalIn(`window.App && App.nav('qbdna')`, 15000);
  await sleep(6000);

  for (const tab of TABS) {
    await evalIn(`(()=>{const b=[...document.querySelectorAll('.qbd-tab')]
      .find(x=>x.dataset.tab===${JSON.stringify(tab)}); if(b) b.click(); return !!b;})()`);
    await sleep(tab === 'overview' ? 7000 : 5000);
    const m = await evalIn(`(()=>{const r=document.querySelector('.qbd');
      const d=document.documentElement;
      return { present:!!r, docH:d.scrollHeight, docW:d.scrollWidth, winW:innerWidth,
        overflowX: d.scrollWidth>innerWidth+1,
        panels:document.querySelectorAll('.qbd-panel').length,
        rows:document.querySelectorAll('.qbd-cond-row,.qbd-cmprow,.qbd-table tbody tr').length,
        /* A percentage must be accompanied by its sample: either an explicit
           N=, or the numerator/denominator it was computed from. */
        naked:(()=>{ let bad=0;
          document.querySelectorAll('.qbd-cond-row,.qbd-cmprow').forEach(el=>{
            const t=(el.textContent||'').replace(/\\s+/g,' ');
            if(/%/.test(t) && !/N=\\d/.test(t) && !/\\d+\\s*\\/\\s*\\d+/.test(t)) bad++; });
          return bad; })(),
        nakedRows:(()=>{ const out=[];
          document.querySelectorAll('.qbd-cond-row,.qbd-cmprow').forEach(el=>{
            const t=(el.textContent||'').replace(/\\s+/g,' ').trim();
            if(/%/.test(t) && !/N=\\d/.test(t) && !/\\d+\\s*\\/\\s*\\d+/.test(t)) out.push(t.slice(0,120)); });
          return out; })(),
        empty:document.querySelectorAll('.qbd-stat.is-empty').length,
        /* Any element wider than the viewport that is NOT inside a deliberate
           horizontal scroller (.qbd-tablewrap) is a layout bug, and it is
           invisible to documentElement.scrollWidth when an ancestor clips it. */
        wide:(()=>{ const out=[];
          document.querySelectorAll('.qbd *').forEach(el=>{
            if(el.closest('.qbd-tablewrap')) return;
            const r=el.getBoundingClientRect();
            if(r.width>innerWidth+1) out.push(el.className+':'+Math.round(r.width)); });
          return [...new Set(out)].slice(0,6); })(),
        err: !!document.querySelector('.qbd-error') };})()`);
    report.push({ width, tab, ...m });

    const cap = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const name = `qbdna-${tab}-${width}.png`;
    writeFileSync(join(OUT, name), Buffer.from(cap.data, 'base64'));
    console.log(`${name}  doc ${m.docH}px  panels ${m.panels}  rows ${m.rows}  `
      + `overflowX ${m.overflowX}  nakedPct ${m.naked}  wide ${m.wide.length}  error ${m.err}`
      + (m.wide.length ? `\n    OVERWIDE: ${m.wide.join(' | ')}` : ''));
  }
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ report, errors }, null, 2));
console.log('\nconsole errors:', errors.length);
errors.slice(0, 12).forEach(e => console.log('  !', String(e).slice(0, 180)));
ws.close(); finish(0);
