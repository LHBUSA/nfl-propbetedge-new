/* College Path visual gate.
 *
 *   node scripts/local-serve.mjs --port=8899 &
 *   node scripts/college-path-shot.mjs [--width=1440] [--player=<espn_id>]
 *
 * Drives the real page against the real handler on a local server, asserts the
 * section rendered on the Player DNA surface, and writes a screenshot to
 * .gate/college/. Development only.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TARGET = process.env.PBE_CP_TARGET || 'http://localhost:8899';
const WIDTH = Number((process.argv.find(a => a.startsWith('--width=')) || '--width=1440').split('=')[1]);
const PLAYER = (process.argv.find(a => a.startsWith('--player=')) || '').split('=')[1] || '';
const GSIS = (process.argv.find(a => a.startsWith('--gsis=')) || '').split('=')[1] || '';
const LABEL = (process.argv.find(a => a.startsWith('--label=')) || '--label=desktop').split('=')[1];
const OUT = join(process.cwd(), '.gate', 'college');
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9380 + Math.floor(Math.random() * 90);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-cp-'));
mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
  '--headless=new', '--no-first-run', '--disable-extensions', '--hide-scrollbars', 'about:blank'],
  { stdio: 'ignore' });
function finish(code) {
  try { chrome.kill(); } catch {}
  setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(code); }, 250);
}
setTimeout(() => { console.error('DEADLINE'); finish(3); }, 180000).unref?.();

async function wsUrl() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('devtools_unreachable');
}

const ws = new WebSocket(await wsUrl());
await new Promise(r => { ws.onopen = r; });
let id = 1; const pending = new Map();
const send = (m, p = {}) => {
  const n = id++;
  ws.send(JSON.stringify({ id: n, method: m, params: p }));
  return new Promise((res, rej) => pending.set(n, { resolve: res, reject: rej }));
};
const exceptions = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push(String(m.params.exceptionDetails?.exception?.description || '').slice(0, 200));
  }
};
const evaluate = async expr => (await send('Runtime.evaluate',
  { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride',
  { width: WIDTH, height: WIDTH < 600 ? 880 : 1100, deviceScaleFactor: 1, mobile: WIDTH < 600 });

/* The product consumes a one-shot focus token from session storage on boot,
   which is how PBE BREAKING opens a named player. Using the same door means the
   gate exercises the real selection path rather than poking at internal state. */
await send('Page.navigate', { url: `${TARGET}/#home` });
await sleep(2500);
if (GSIS) {
  await evaluate(`sessionStorage.setItem('pbe.playerdna.focus', JSON.stringify(
    { route: 'qbdna', player_id: '${GSIS}' }))`);
}
await send('Page.navigate', { url: `${TARGET}/#qbdna` });
await sleep(7000);
if (GSIS) {
  console.log('focused ->', await evaluate(
    `String(window.PBEQBDna?.state?.dna?.player?.name || 'unknown')`));
}

const found = await evaluate(`(() => {
  const el = document.querySelector('[data-pbe-college-path]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { text: el.innerText.slice(0, 600), top: r.top + window.scrollY, height: r.height,
           classes: el.className };
})()`);

if (!found) {
  console.error('FAIL college path section did not render');
  console.error('exceptions:', exceptions.slice(0, 5));
  finish(1);
} else {
  await evaluate(`window.scrollTo(0, ${Math.max(0, Math.round(found.top - 90))})`);
  await sleep(700);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT, `college-path-${LABEL}-${WIDTH}.png`);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`PASS  ${found.classes}  height=${Math.round(found.height)}  -> ${file}`);
  console.log('---- rendered text ----');
  console.log(found.text);
  if (exceptions.length) console.log('page exceptions:', exceptions.slice(0, 3));
  finish(0);
}
