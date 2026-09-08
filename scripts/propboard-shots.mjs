/* PROP BOARD SCREENSHOT + LAYOUT PROBE
 *   node scripts/propboard-shots.mjs <label> [baseUrl] [outDir] [pro=0|1] [query]
 * Opens #propboard at 1600×1000, 1440×1000, 1280×800, 1024×768, 768×1024 and
 * 390×844, waits for the board to settle, screenshots the viewport and the
 * full page, and prints: horizontal overflow, clipped cells, smallest font
 * size in the board, column count, row count, console errors.
 * pro=1 flips PBEPro.state.pro in-page after load (rendering only; the
 * server-gated model still requires a real session, so model cells stay empty).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [LABEL = 'before', BASE = 'http://127.0.0.1:4321', OUT = 'shots/propboard', PRO = '0', QUERY = ''] = process.argv.slice(2);
const WIDTHS = [[1600, 1000], [1440, 1000], [1280, 800], [1024, 768], [768, 1024], [390, 844]];
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DP = 9300 + Math.floor(Math.random() * 90); const dir = mkdtempSync(join(tmpdir(), 'pbe-pb-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${DP}`, `--user-data-dir=${dir}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
function finish(c) { try { chrome.kill(); } catch {} setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(c); }, 200); }
setTimeout(() => { console.error('DEADLINE'); finish(3); }, 600000).unref?.();
async function wsUrl() { for (let i = 0; i < 100; i++) { try { const l = await (await fetch(`http://127.0.0.1:${DP}/json/list`)).json(); const p = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(200); } throw new Error('devtools never came up'); }
const ws = new WebSocket(await wsUrl()); await new Promise((r) => { ws.onopen = r; });
let id = 1; const pending = new Map(); let errors = [];
const send = (m, p = {}) => { const n = id++; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => pending.set(n, { resolve: res, reject: rej })); };
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'exception'); };
await send('Runtime.enable'); await send('Page.enable');
const evalIn = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value; };
const PROBE = `(() => {
  const root = document.querySelector('.pbe5, .pbe3-propboard') || document.querySelector('#view-container') || document.body;
  const vw = innerWidth, docOverflow = document.documentElement.scrollWidth - vw;
  const table = root.querySelector('table');
  const cols = table ? table.querySelectorAll('thead th').length : 0;
  const rows = root.querySelectorAll('[data-pbe5-row], .pbe4-mobile-card, .pbe3-table tbody tr[data-row-key]').length;
  let minFont = 99, clipped = 0, overflowEls = [];
  for (const el of root.querySelectorAll('*')) {
    const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
    const fs = parseFloat(cs.fontSize); if (el.childNodes.length && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) minFont = Math.min(minFont, fs);
    if (r.right > vw + 1 && cs.position !== 'fixed') overflowEls.push(el.className && String(el.className).slice(0, 40));
    if (cs.overflow === 'hidden' && cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) clipped++;
  }
  const text = root.innerText || '';
  const locks = (text.match(/UNLOCK|LOCKED|PRO ONLY|Upgrade/gi) || []).length;
  const upper = (text.match(/\\b[A-Z]{4,}(?:\\s[A-Z]{3,})*\\b/g) || []).length;
  return { vw, docOverflow, cols, rows, minFont, clipped, overflowEls: [...new Set(overflowEls)].slice(0, 5), locks, upperLabels: upper, height: document.documentElement.scrollHeight, title: (root.querySelector('h1,h2')?.innerText || '').slice(0, 60) };
})()`;
const results = [];
for (const [w, h] of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w <= 768 });
  errors = [];
  await send('Page.navigate', { url: `${BASE}/?pb=${Date.now()}${QUERY ? '&' + QUERY : ''}#propboard` });
  await sleep(2500);
  await evalIn(`(() => { try { window.App?.nav('propboard'); } catch {} return 1; })()`);
  if (PRO === '1') { await sleep(4000); await evalIn(`(() => { try { window.PBEPro.state.pro = true; window.dispatchEvent(new CustomEvent('pbe:pro-state', { detail: { pro: true } })); } catch {} return 1; })()`); }
  await sleep(w === 1600 ? 14000 : 9000);
  const m = await evalIn(PROBE);
  console.log(`${LABEL} ${w}x${h}: cols=${m.cols} rows=${m.rows} overflow=${m.docOverflow}px clipped=${m.clipped} minFont=${m.minFont}px locks=${m.locks} upperLabels=${m.upperLabels} pageH=${m.height}${m.overflowEls.length ? ' overflowing: ' + m.overflowEls.join(',') : ''}${errors.length ? ' ERR: ' + errors[0].slice(0, 100) : ''}`);
  results.push({ label: LABEL, w, h, ...m, errors: errors.slice(0, 3) });
  const cap = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${LABEL}-${w}x${h}.png`), Buffer.from(cap.data, 'base64'));
  if (w === 1440 || w === 390) { const full = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: Math.min(m.height, 6000), scale: 1 } }); writeFileSync(join(OUT, `${LABEL}-${w}-full.png`), Buffer.from(full.data, 'base64')); }
}
writeFileSync(join(OUT, `${LABEL}-report.json`), JSON.stringify(results, null, 2));
ws.close(); finish(0);
