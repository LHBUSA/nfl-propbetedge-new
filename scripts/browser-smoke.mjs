/* Browser smoke test — the regression gate for the main-thread freeze class.
 *
 * A wedged renderer cannot answer 1+1, so liveness is asserted directly rather
 * than inferred from a screenshot or a timeout. Fails if the initial
 * "Loading NFL Intelligence OS..." screen is never replaced, if any major route
 * stops responding, or if a headline feature disappears.
 *
 * PBE_SUBSTITUTE lets a local fix be proven against live production BEFORE it
 * is deployed, by swapping named files in via CDP Fetch.fulfillRequest.
 *
 *   node scripts/browser-smoke.mjs
 *   PBE_SUBSTITUTE=dashboard-v8-enhance.js node scripts/browser-smoke.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const REPO = process.env.PBE_REPO || process.cwd();
const SUBSTITUTE = (process.env.PBE_SUBSTITUTE || '').split(',').map(s => s.trim()).filter(Boolean);
const URL_TARGET = process.env.PBE_URL || 'https://nfl.propbetedge.ai';
const LOG = 'verify-all.log';
const PORT = 9700 + Math.floor(Math.random() * 90);
const CHROME = process.env.PBE_CHROME
  || (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : '/usr/bin/google-chrome');

const bodies = new Map();
for (const f of SUBSTITUTE) bodies.set(f, readFileSync(join(REPO, f)));

const out = l => { try { appendFileSync(LOG, l + String.fromCharCode(10)); } catch (_) {} console.log(l); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'pbe-all-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-timer-throttling',
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

function finish(code) {
  try { chrome.kill(); } catch (_) {}
  setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch (_) {} process.exit(code); }, 300);
}
const hard = setTimeout(() => { out('HARD_DEADLINE'); finish(3); }, 240000);
hard.unref?.();

async function wsUrl() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(200);
  }
  throw new Error('devtools_unavailable');
}

let id = 1;
const pending = new Map();
const exceptions = [];
const swapped = [];

const ws = new WebSocket(await wsUrl());
await new Promise(r => { ws.onopen = r; });
const send = (method, params = {}) => {
  const myId = id++;
  ws.send(JSON.stringify({ id: myId, method, params }));
  return new Promise((res, rej) => pending.set(myId, { resolve: res, reject: rej }));
};
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    return;
  }
  if (m.method === 'Fetch.requestPaused') {
    const url = m.params.request.url.split('?')[0];
    const name = basename(url);
    const body = bodies.get(name) || null;
    if (body) {
      swapped.push(name || 'index.html');
      send('Fetch.fulfillRequest', {
        requestId: m.params.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'content-type', value: 'application/javascript' },
          { name: 'cache-control', value: 'no-store' },
        ],
        body: body.toString('base64'),
      }).catch(() => {});
    } else {
      send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
    }
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push(String(m.params.exceptionDetails?.exception?.description
      || m.params.exceptionDetails?.text).slice(0, 160));
  }
};

await send('Runtime.enable');
await send('Page.enable');
if (SUBSTITUTE.length) {
  await send('Fetch.enable', {
    patterns: SUBSTITUTE.map(f => ({ urlPattern: `*${f}*`, requestStage: 'Request' })),
  });
}

out(`TARGET ${URL_TARGET}`);
out(`SUBSTITUTED: ${SUBSTITUTE.join(', ') || '(none - testing deployed site as-is)'}`);
await send('Page.navigate', { url: URL_TARGET });
await sleep(10000);

async function probe(expr, ms = 6000) {
  try {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true }),
      sleep(ms).then(() => { throw new Error('WEDGED'); }),
    ]);
    return r.result?.value;
  } catch (e) { return `<${e.message}>`; }
}

if (await probe('1+1') !== 2) { out('RESULT MAIN THREAD WEDGED'); ws.close(); finish(1); }

out('');
out('=== INITIAL LOAD ===');
const viewText = await probe('(document.querySelector("#view-container")?.textContent||"").trim()');
const spinner = typeof viewText === 'string' && viewText.length > 200 && !/Loading NFL Intelligence OS/.test(viewText);
out(`view-container chars   : ${typeof viewText === 'string' ? viewText.length : viewText}`);
out(`spinner cleared        : ${spinner}`);
out(`App.current            : ${await probe('window.App?.current ?? null')}`);
out(`loader phase / version : ${await probe('window.PBELoaderState?.phase')} / ${await probe('window.PBELoaderState?.version')}`);
out('');
out('=== FEATURE PRESERVATION (no rollback) ===');
const feats = [
  ['.pbehome7', 'Dashboard v7/v8 home'],
  ['#pbe8-core-market', 'v8 core market'],
  ['.pbe8-news-filters', 'v8 news impact filters'],
  ['.pbes-scorebar,.pbes-shell', 'Sports shell scorebar'],
  ['#pbe-network-footer', 'Network footer'],
  ['[class*=engine-story],[data-engine-route]', 'Engine Story'],
];
let featuresOk = true;
for (const [sel, label] of feats) {
  const present = await probe(`!!document.querySelector(${JSON.stringify(sel)})`);
  out(`${label.padEnd(24)}: ${present}`);
  if (present !== true) featuresOk = false;
}

const ROUTES = ['games', 'propboard', 'marketwatch', 'picks', 'pbepicks', 'trackrecord', 'pbecast', 'matchups', 'home'];
out('');
out('=== ROUTE NAVIGATION ===');
let allOk = true;
for (const r of ROUTES) {
  await probe(`window.App && App.nav(${JSON.stringify(r)})`, 8000);
  await sleep(2400);
  const ok = await probe('1+1', 6000) === 2;
  const cur = await probe('window.App?.current ?? null', 4000);
  const chars = await probe('(document.querySelector("#view-container")?.textContent||"").trim().length', 4000);
  out(`${r.padEnd(13)} responsive=${ok ? 'YES' : 'NO '} route=${String(cur).padEnd(13)} chars=${chars}`);
  if (!ok) { allOk = false; break; }
}

out('');
out('=== SOAK: 30 navigations ===');
const t0 = Date.now();
for (let i = 0; i < 30; i += 1) {
  await probe(`window.App && App.nav(${JSON.stringify(ROUTES[i % ROUTES.length])})`, 6000);
  await sleep(400);
}
const soak = await probe('1+1', 10000) === 2;
out(`30 navigations in ${Date.now() - t0}ms — responsive=${soak ? 'YES' : 'NO'}`);
out(`final spinner gone     : ${await probe('!/Loading NFL Intelligence OS/.test(document.querySelector("#view-container")?.textContent||"")')}`);
out('');
out(`substituted requests   : ${swapped.length} (${[...new Set(swapped)].join(', ')})`);
out(`exceptions (${exceptions.length})        : ${exceptions.slice(0, 4).join(' | ') || 'none'}`);
const pass = allOk && soak && spinner === true && featuresOk;
out(`RESULT ${pass ? 'PASS' : 'FAIL'}`);
ws.close();
finish(pass ? 0 : 1);
