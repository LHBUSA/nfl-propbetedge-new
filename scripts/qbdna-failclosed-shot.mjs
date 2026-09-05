/* Captures the FAIL-CLOSED states of /#qbdna, which are as much a part of the
 * product as the best case:
 *   · a 2026 quarterback with no NFL history        -> NFL SAMPLE UNAVAILABLE
 *   · a market nobody is offering                   -> CURRENT MARKET UNAVAILABLE
 *   · a very small sample, stated as such
 *
 * node scripts/qbdna-failclosed-shot.mjs <outDir> [widths]
 * PBE_BASE / PBE_SHARE point it at a deployed preview.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] || 'shots-failclosed';
const WIDTHS = (process.argv[3] || '1440,390').split(',').map(Number);
const TARGET = process.env.PBE_BASE || `http://localhost:${process.env.PBE_PORT || '4321'}`;
const SHARE = process.env.PBE_SHARE || '';
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DP = 9900 + Math.floor(Math.random() * 90);

/* Each case sets state directly, then re-runs the view's own loader, so what is
   captured is the real render path and not a mocked-up DOM. */
const CASES = [
  { name: 'no-nfl-history', tab: 'overview',
    state: { playerId: '00-0039107' },            // Stetson Bennett, LAR, 0 NFL games
    expect: '.qbd-unavail' },
  { name: 'market-unavailable', tab: 'props',
    state: { playerId: '00-0033873', market: 'interceptions', line: '' },
    expect: '.qbd-unavail' },
  { name: 'very-small-sample', tab: 'conditions',
    state: { playerId: '00-0033873' },
    expect: '.qbd-samp[data-s="VERY SMALL SAMPLE"]' },
  { name: 'thin-starter', tab: 'overview',
    state: { playerId: '00-0040743' },            // Tyler Shough, NO — real but small
    expect: '.qbd-panel' }
];

mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-fc-'));
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
const errors = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.text || 'exception');
};
await send('Runtime.enable'); await send('Page.enable');
const evalIn = async (expr, ms = 40000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
    sleep(ms).then(() => { throw new Error('WEDGED'); })
  ]);
  return r.result?.value;
};

if (SHARE) {
  await send('Page.navigate', { url: `${TARGET}/?_vercel_share=${SHARE}` });
  await sleep(9000);
}

const report = [];
for (const width of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride',
    { width, height: width <= 768 ? 844 : 900, deviceScaleFactor: 1, mobile: width <= 768 });
  await send('Page.navigate', { url: `${TARGET}/#qbdna?t=${Date.now()}` });
  await sleep(15000);
  await evalIn('window.App && App.nav("qbdna")', 15000);
  await sleep(7000);

  for (const c of CASES) {
    const applied = await evalIn(`(async()=>{
      const S = window.PBEQBDna.state;
      Object.assign(S, ${JSON.stringify(c.state)});
      S.tab = ${JSON.stringify(c.tab)};
      S.dna = null; S.prop = null; S.cmp = null; S.ctxCmp = null;
      /* Clear the selected game exactly as the player-change handler does, so
         each case resolves THIS quarterback's own next game rather than
         inheriting the previous case's selection. */
      S.eventId = null; S.ctx = null;
      await window.PBEQBDna.load();
      return true;
    })()`, 60000);
    await sleep(4000);

    const m = await evalIn(`(()=>{
      const el = document.querySelector(${JSON.stringify(c.expect)});
      const d = document.documentElement;
      return {
        matched: !!el,
        text: el ? (el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,220) : null,
        docH: d.scrollHeight,
        overflowX: d.scrollWidth > innerWidth + 1,
        wide: (()=>{ const o=[]; document.querySelectorAll('.qbd *').forEach(x=>{
          if(x.closest('.qbd-tablewrap')) return;
          if(x.getBoundingClientRect().width > innerWidth+1) o.push(x.className); });
          return [...new Set(o)].slice(0,4); })(),
        /* the point of these captures: a withheld answer must contain no
           fabricated figure where a real one would have been */
        fabricated: (()=>{
          const p = document.querySelector('.qbd-unavail');
          if (!p) return null;
          return /\\b\\d+\\.\\d\\b/.test(p.textContent||'');
        })(),
        err: !!document.querySelector('.qbd-error')
      };})()`);
    report.push({ width, case: c.name, ...m });

    const cap = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(OUT, `qbdna-${c.name}-${width}.png`), Buffer.from(cap.data, 'base64'));
    console.log(`qbdna-${c.name}-${width}.png  matched ${m.matched}  doc ${m.docH}px  `
      + `overflowX ${m.overflowX}  wide ${m.wide.length}  fabricated ${m.fabricated}  error ${m.err}`);
    if (m.text) console.log(`    "${m.text.slice(0, 150)}"`);
  }
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ report, errors }, null, 2));
console.log('\nconsole errors:', errors.length);
ws.close(); finish(0);
