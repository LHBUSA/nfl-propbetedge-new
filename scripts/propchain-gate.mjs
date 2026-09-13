/* PropChain v3 acceptance gate.
 *
 *   node scripts/propchain-gate.mjs [--out dir] [--widths 1440,390] [--live]
 *
 * Real headless Chrome against the live NFL APIs. By default every same-origin
 * static file is served from this checkout (as product-loop-gate does), so a
 * branch is judged before it deploys; --live renders PBE_TARGET as deployed
 * (with PBE_GATE_BOOTSTRAP=<share url> for a protected preview — use the
 * immutable deployment URL, not the branch alias).
 *
 * Scenarios, per width:
 *   direct-load   cold #propchain: every painted generation is recorded from
 *                 document start; the roadmap placeholder / v2 must never paint
 *   all-games     rows, strip, timestamps, truth invariants (below), screenshot
 *   filters       signal / severity / window / search each narrow correctly
 *   game          busiest game narrows the board; a game with no chain shows
 *                 "No complete chains" with context, never an empty page
 *   evidence      row expands (click, Enter, Escape), five steps + actions
 *   failure       /api/changes 503 -> unavailable state, never "nothing changed";
 *                 /api/odds/board 503 -> no player chain claims a market
 *   stale         injury report flagged stale -> STALE shown
 *   polling       refresh timer runs only while the route is on screen
 *
 * Truth invariants checked on every rendered row against the chain model:
 *   - a "from -> to" tape appears only on MARKET chains whose two captures exist
 *   - a player market row never shows an arrow (props have no stored history)
 *   - "Fair" / a model number appears only where the model state is PUBLISHED
 *   - a transition label appears only where the API attached a transition
 *   - no causal wording anywhere on the page
 *
 * Plus the product-loop generic checks: console errors, horizontal overflow,
 * broken images, text under 10px. Exit 1 on any failure.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';

const REPO = process.cwd();
const TARGET = process.env.PBE_TARGET || 'https://nfl.propbetedge.ai';
const ORIGIN = new URL(TARGET).origin;
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const arg = (n, f) => { const i = argv.indexOf(`--${n}`); return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : f; };
const LIVE = flag('live');
/* --require: a release run. A scenario that cannot be exercised (no transition
   or no observed market move in the data) FAILS instead of printing SKIP. */
const REQUIRE = flag('require');
const OUT = resolve(arg('out', join(REPO, '.propchain-gate')));
const WIDTHS = arg('widths', '1440,390').split(',').map(n => parseInt(n, 10));
const HEIGHTS = { 360: 780, 375: 812, 390: 844, 768: 1024, 1024: 768, 1280: 800, 1440: 900 };
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* One Chrome process per width. A single long-lived tab rendering the full
   NFL shell ~20 times per width eventually stops answering CDP (measured:
   a different scenario wedged on each 1440+390 run while each width passed
   alone), which would turn a harness limit into a false product failure. */
if (WIDTHS.length > 1 && !process.env.PBE_PROPCHAIN_GATE_CHILD) {
  let code = 0;
  for (const w of WIDTHS) {
    const r = await new Promise(res => {
      const child = spawn(process.execPath, [process.argv[1], ...argv.filter((a, i) => a !== '--widths' && argv[i - 1] !== '--widths'), '--widths', String(w)], { stdio: 'inherit', env: { ...process.env, PBE_PROPCHAIN_GATE_CHILD: '1' } });
      child.on('exit', c => res(c ?? 1));
    });
    if (r) code = r;
  }
  console.log(`
${code ? 'PROPCHAIN GATE FAILED' : 'PROPCHAIN GATE PASSED'} · widths ${WIDTHS.join(',')}`);
  process.exit(code);
}

const MIME = { '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
function localFile(url) {
  if (LIVE) return null; let u; try { u = new URL(url); } catch { return null; }
  if (u.origin !== ORIGIN || u.pathname.startsWith('/api/')) return null;
  const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
  if (!rel || rel.includes('..') || !MIME[extname(rel)]) return null;
  const fp = join(REPO, rel);
  try { if (!existsSync(fp) || !statSync(fp).isFile()) return null; return { body: readFileSync(fp), type: MIME[extname(rel)] }; } catch { return null; }
}

/* ---- chrome / CDP ---------------------------------------------------------- */
const PORT = 9800 + Math.floor(Math.random() * 90);
const dir = mkdtempSync(join(tmpdir(), 'pbe-propchain-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
function finish(code) { try { chrome.kill(); } catch {} setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(code); }, 300); }
setTimeout(() => { console.error('HARD_DEADLINE'); finish(3); }, 1500000).unref?.();
async function wsUrl() { for (let i = 0; i < 100; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find(x => x.type === 'page' && x.webSocketDebuggerUrl); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(200); } throw new Error('devtools_unavailable'); }
const ws = new WebSocket(await wsUrl());
await new Promise(r => { ws.onopen = r; });
let seq = 1; const pending = new Map();
/* Every CDP call is time-boxed: a paused request left over from a previous
   scenario must fail that call, not hang the whole run. */
const send = (method, params = {}, ms = 30000) => { const n = seq++; ws.send(JSON.stringify({ id: n, method, params })); return new Promise((res, rej) => { pending.set(n, { res, rej }); setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error(`cdp_timeout:${method}`)); } }, ms); }); };

/* Per-scenario API rules: [{match: RegExp, status?, mutate?(json)}].
   PBE_CHANGES_UPSTREAM=<origin> serves /api/changes from another nfl-intel
   origin — e.g. an uploaded, non-serving Worker version's preview URL — so a
   Worker change can be exercised end to end before it takes traffic. */
let rules = [];
const UPSTREAM = process.env.PBE_CHANGES_UPSTREAM ? process.env.PBE_CHANGES_UPSTREAM.replace(/\/$/, '') : null;
const state = { errors: [], apiCalls: [], changesResponses: [] };
ws.onmessage = async ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
  if (m.method === 'Fetch.requestPaused') {
    const { requestId, request, responseStatusCode } = m.params;
    const url = request.url;
    try {
      const rule = rules.find(r => r.match.test(url));
      if (!rule && UPSTREAM && responseStatusCode === undefined && /\/api\/changes/.test(url)) {
        const u = new URL(url);
        const r = await fetch(`${UPSTREAM}${u.pathname}${u.search}`, { headers: { accept: 'application/json' } });
        const body = Buffer.from(await r.arrayBuffer());
        await send('Fetch.fulfillRequest', { requestId, responseCode: r.status, responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }, { name: 'cache-control', value: 'no-store' }], body: body.toString('base64') });
        return;
      }
      if (rule && responseStatusCode === undefined && rule.status) {
        await send('Fetch.fulfillRequest', { requestId, responseCode: rule.status, responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }], body: Buffer.from(JSON.stringify({ error: `gate_injected_${rule.status}` })).toString('base64') });
        return;
      }
      if (rule && responseStatusCode !== undefined && rule.mutate) {
        const b = await send('Fetch.getResponseBody', { requestId });
        const text = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
        const out = JSON.stringify(rule.mutate(JSON.parse(text)));
        await send('Fetch.fulfillRequest', { requestId, responseCode: responseStatusCode, responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }, { name: 'cache-control', value: 'no-store' }], body: Buffer.from(out).toString('base64') });
        return;
      }
      if (responseStatusCode === undefined) {
        const local = localFile(url);
        if (local) { await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: local.type }, { name: 'cache-control', value: 'no-store' }], body: local.body.toString('base64') }); return; }
      }
    } catch (e) { state.errors.push(`[gate] ${url} ${e.message}`); }
    send('Fetch.continueRequest', { requestId }).catch(() => {});
    return;
  }
  if (m.method === 'Network.requestWillBeSent' && /\/api\//.test(m.params.request.url)) state.apiCalls.push({ t: Date.now(), host: new URL(m.params.request.url).host, u: m.params.request.url.replace(/^https?:\/\/[^/]+/, '') });
  if (m.method === 'Network.responseReceived' && /\/api\/changes/.test(m.params.response.url)) state.changesResponses.push({ host: new URL(m.params.response.url).host, status: m.params.response.status, runtime: m.params.response.headers['x-pbe-runtime'] || m.params.response.headers['X-Pbe-Runtime'] || null, fulfilledByGate: m.params.response.fromServiceWorker === true });
  if (m.method === 'Runtime.exceptionThrown') state.errors.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 300));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') state.errors.push(m.params.args.map(a => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300));
};
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Fetch.enable', { patterns: [
  { urlPattern: `${ORIGIN}/*`, requestStage: 'Request' },
  { urlPattern: '*/api/*', requestStage: 'Request' },
  { urlPattern: '*/api/changes*', requestStage: 'Response' },
  { urlPattern: '*/api/best-line*', requestStage: 'Response' }
] });
/* Every painted generation of #view-container, from document start. */
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__pc3Paints = []; const t0 = performance.now(); const rec = () => { const vc = document.getElementById('view-container'); if (!vc) return; const f = [...vc.children].find(el => !el.matches('[data-pbe-season-strip]')); const sig = f ? String(f.className || f.tagName).split(' ')[0] + '|' + (vc.textContent || '').replace(/\\s+/g, ' ').slice(0, 90) : 'empty'; const last = window.__pc3Paints[window.__pc3Paints.length - 1]; if (!last || last.sig !== sig) window.__pc3Paints.push({ t: Math.round(performance.now() - t0), sig }); }; new MutationObserver(rec).observe(document, { subtree: true, childList: true }); })();` });

const evaluate = async (expr, ms = 20000) => { try { const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }), sleep(ms).then(() => { throw new Error('WEDGED'); })]); if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text }; return r.result?.value; } catch (e) { return { __error: e.message }; } };
const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await evaluate(expr, 5000); if (v && !v.__error) return v; await sleep(250); } return null; };
async function setViewport(w) { await send('Emulation.setDeviceMetricsOverride', { width: w, height: HEIGHTS[w] || 900, deviceScaleFactor: 1, mobile: w <= 768 }); }
async function shot(file, full = false) {
  const m = await send('Page.getLayoutMetrics'); const H = Math.ceil(m.cssContentSize?.height || m.contentSize.height); const w = Math.ceil(m.cssLayoutViewport?.clientWidth || m.layoutViewport.clientWidth);
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: full ? Math.min(H, 9000) : Math.min(H, (m.cssLayoutViewport?.clientHeight || 900) * 2), scale: 1 } });
  writeFileSync(file, Buffer.from(r.data, 'base64'));
}
async function shotElement(selector, file) {
  const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'start' }); const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; })()`);
  if (!box || box.__error) return false;
  await sleep(300);
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.w + 16, height: Math.min(box.h + 16, 6000), scale: 1 } });
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  return true;
}
async function open(route = 'propchain', { settle = true } = {}) {
  state.errors = []; state.apiCalls = []; state.changesResponses = [];
  await send('Page.navigate', { url: 'about:blank' }); await sleep(120);
  await send('Network.clearBrowserCache').catch(() => {});
  await send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'local_storage,session_storage' }).catch(() => {});
  await send('Page.navigate', { url: `${TARGET}/#${route}` });
  if (settle) await until(`(() => { const m = window.PBEPropChain?.model?.(); const rows = document.querySelectorAll('.pc3-row .pc3-row-btn').length; const err = document.querySelector('.pc3-error'); const skel = document.querySelector('.pc3-board.is-skel'); const pend = m && m.chains.some(c => c.complete === null); return (err || (!skel && (rows || document.querySelector('.pc3-none')) && !pend)) ? true : null; })()`, 45000);
  await sleep(600);
}

/* ---- checks ------------------------------------------------------------------- */
const MEASURE = `(() => {
  const de = document.documentElement, vw = de.clientWidth, out = {};
  out.overflowX = de.scrollWidth - vw;
  const bleed = []; document.querySelectorAll('.pc3 *').forEach(el => { const r = el.getBoundingClientRect(); if (!r.width || !r.height) return; if (r.right > vw + 2 || r.left < -2) { let p = el.parentElement, clipped = false; while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { clipped = true; break; } p = p.parentElement; } if (!clipped) bleed.push((typeof el.className === 'string' && el.className ? el.className.split(' ')[0] : el.tagName) + '@' + Math.round(r.right)); } });
  out.bleeders = [...new Set(bleed)].slice(0, 8);
  const imgs = [...document.querySelectorAll('.pc3 img')];
  out.brokenImages = imgs.filter(i => i.complete && i.naturalWidth === 0 && !i.classList.contains('image-failed') && getComputedStyle(i).display !== 'none').map(i => i.getAttribute('src')).slice(0, 5);
  let tiny = 0, tinyEx = []; const w = document.createTreeWalker(document.querySelector('.pc3') || document.body, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { const t = n.nodeValue.trim(); if (t.length < 2) continue; const el = n.parentElement; const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue; const cs = getComputedStyle(el); if (cs.visibility === 'hidden') continue; if (parseFloat(cs.fontSize) < 9.95) { tiny++; tinyEx.push(t.slice(0, 30)); } }
  out.sub10Text = tiny; out.sub10Examples = tinyEx.slice(0, 4);
  let small = 0; if (vw <= 768) document.querySelectorAll('.pc3 button, .pc3 a[href], .pc3 select, .pc3 input').forEach(el => { const r = el.getBoundingClientRect(); if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') return; if (r.height < 30) small++; });
  out.smallTargets = small;
  return out;
})()`;
const TRUTH = `(() => {
  const model = window.PBEPropChain?.model?.(); const bad = [];
  if (!model) return { ok: false, bad: ['no chain model'] };
  const byId = new Map(model.chains.map(c => [c.id, c]));
  const rows = [...document.querySelectorAll('.pc3-row[data-id]')];
  for (const row of rows) {
    const c = byId.get(row.dataset.id); if (!c) { bad.push('row without a chain: ' + row.dataset.id); continue; }
    const mkt = row.querySelector('.pc3-c-mkt')?.textContent || '';
    const pbe = row.querySelector('.pc3-c-pbe')?.textContent || '';
    const change = row.querySelector('.pc3-c-change')?.textContent || '';
    if (/→/.test(mkt) && !(c.kind === 'MARKET' && c.move?.from?.captured_at && c.move?.to?.captured_at && c.move.from.captured_at !== c.move.to.captured_at)) bad.push('movement without two captures: ' + c.id);
    if (c.market?.kind === 'PLAYER_PROPS' && /→/.test(mkt)) bad.push('player line shows movement: ' + c.id);
    if ((row.querySelector('.pc3-c-pbe .pc3-model') || /Fair \\d/.test(pbe)) && c.model?.state !== 'PUBLISHED') bad.push('model value without a published model: ' + c.id);
    if (c.model?.state === 'NOT_PUBLISHED' && !/Not published/.test(pbe)) bad.push('unpublished model not labelled: ' + c.id);
    if (/→/.test(change) && !c.transition) bad.push('transition without ledger: ' + c.id);
    if (!row.querySelector('time')?.textContent.trim() || !/updated|captured/.test(row.querySelector('.pc3-c-src')?.textContent || '')) bad.push('row without source time: ' + c.id);
  }
  const text = document.querySelector('.pc3')?.innerText || '';
  const causal = /\\b(caused|because of this|due to this|moved the line|drove the move|in response to)\\b/i.exec(text);
  if (causal) bad.push('causal wording: ' + causal[0]);
  return { ok: bad.length === 0, rows: rows.length, bad: bad.slice(0, 6) };
})()`;

const report = []; let failures = 0;
function record(scenario, width, checks, extra = {}) {
  const bad = checks.filter(c => !c.ok); failures += bad.length;
  report.push({ scenario, width, checks, ...extra });
  console.log(`${bad.length ? 'FAIL' : 'PASS'} ${scenario}@${width}${extra.note ? ` ${extra.note}` : ''}${bad.length ? '\n   ' + bad.map(b => `✗ ${b.name}${b.detail ? ` — ${b.detail}` : ''}`).join('\n   ') : ''}`);
}
async function generic() {
  const m = await evaluate(MEASURE);
  return [
    { name: 'no console errors', ok: state.errors.length === 0, detail: state.errors.slice(0, 3).join(' | ') },
    { name: 'no horizontal overflow', ok: (m?.overflowX ?? 1) <= 0, detail: `${m?.overflowX}px ${(m?.bleeders || []).join(',')}` },
    { name: 'no broken images', ok: !(m?.brokenImages || []).length, detail: (m?.brokenImages || []).join(',') },
    { name: 'no text under 10px', ok: (m?.sub10Text ?? 1) === 0, detail: `${m?.sub10Text} ${(m?.sub10Examples || []).join(' / ')}` },
    { name: 'touch targets ≥30px (narrow)', ok: (m?.smallTargets ?? 0) === 0, detail: String(m?.smallTargets) },
    await neverPainted()
  ];
}
/* Checked in every scenario, not only on the cold load: no generation of this
   document has ever painted the ui-v2 roadmap placeholder or propchain-v2. */
async function neverPainted() {
  const p = await evaluate(`(window.__pc3Paints || []).map(x => x.sig)`);
  const bad = (Array.isArray(p) ? p : []).filter(sig => /^pbe15|pbe-v2-dashboard|product roadmap|BUILT TRUTH-FIRST/i.test(sig));
  const dom = await evaluate(`!!document.querySelector('.pbe15-chain') || /product roadmap/i.test(document.getElementById('view-container')?.textContent || '')`);
  return { name: 'placeholder / v2 never painted in this document', ok: Array.isArray(p) && !bad.length && dom === false, detail: bad.slice(0, 2).join(' | ') };
}
const click = sel => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);

/* A protected preview: visit the share URL until the app shell itself loads,
   so a slow auth redirect is never mistaken for a page that painted nothing. */
if (process.env.PBE_GATE_BOOTSTRAP) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await send('Page.navigate', { url: process.env.PBE_GATE_BOOTSTRAP }).catch(() => {});
    if (await until(`document.getElementById('view-container') ? true : null`, 20000)) break;
  }
}

for (const width of WIDTHS) {
  /* Isolate widths: no interception rule or in-flight page survives. */
  rules = [];
  await send('Page.navigate', { url: 'about:blank' }).catch(() => {});
  await sleep(1500);
  await setViewport(width);
  const narrow = width <= 760;

  /* 1 · direct load */
  rules = [];
  await open('propchain');
  const paints = await evaluate('window.__pc3Paints');
  const gens = (Array.isArray(paints) ? paints : []).filter(p => !/^view-loading|^empty/.test(p.sig));
  record('direct-load', width, [
    { name: 'roadmap placeholder never painted', ok: !gens.some(p => /product roadmap|BUILT TRUTH-FIRST|pbe-v2-dashboard/i.test(p.sig)), detail: gens.map(p => `${p.t}ms ${p.sig.slice(0, 40)}`).join(' | ') },
    { name: 'propchain v2 never painted', ok: !gens.some(p => /^pbe15/.test(p.sig)) },
    { name: 'every painted generation is v3', ok: gens.length > 0 && gens.every(p => /^pc3\|/.test(p.sig)), detail: [...new Set(gens.map(p => p.sig.split('|')[0]))].join(',') },
    { name: 'exactly one .pc3 root', ok: (await evaluate(`document.querySelectorAll('.pc3').length`)) === 1 },
    { name: 'route owned by v3 renderer', ok: (await evaluate(`App.current === 'propchain' && App.VIEWS.propchain === window.PBEPropChain.load`)) === true }
  ], { note: `generations=${gens.length}` });

  /* Data provenance: which host served /api/changes, which nfl-intel runtime
     produced the data the page actually rendered, and whether this run used
     any override. EXPECT_RUNTIME (e.g. nfl-intel/1.2.0) makes it an assertion. */
  const prov = await evaluate(`(() => { const d = window.PBECommandCenter?.store?.changes?.data; return { runtime: d?.runtime || null, transitionsAvailable: d?.transitions?.available ?? null, attached: d?.transitions?.attached ?? null, chainsWithTransition: (PBEPropChain.model()?.chains || []).filter(c => c.transition).length }; })()`);
  const hosts = [...new Set(state.changesResponses.map(r => r.host))];
  const want = process.env.EXPECT_RUNTIME || null;
  record('data-provenance', width, [
    { name: '/api/changes read from the production NFL gateway', ok: hosts.length === 1 && hosts[0] === 'nfl-api.propbetedge.ai' && state.changesResponses.every(r => r.status === 200), detail: JSON.stringify(state.changesResponses) },
    { name: 'no upstream or version override in this run', ok: !UPSTREAM || !REQUIRE, detail: `PBE_CHANGES_UPSTREAM=${UPSTREAM || 'unset'}` },
    ...(want ? [{ name: `rendered data came from ${want}`, ok: prov?.runtime === want && state.changesResponses.some(r => r.runtime === want), detail: JSON.stringify(prov) }] : [])
  ], { note: `override=${UPSTREAM || 'none'} bootstrap=${process.env.PBE_GATE_BOOTSTRAP ? 'preview-share-cookie' : 'none'} runtime=${prov?.runtime} transitions=${prov?.attached} chains-with-transition=${prov?.chainsWithTransition}` });

  /* 2 · all games */
  const summary = await evaluate(`(() => { const m = PBEPropChain.model(); return { rows: document.querySelectorAll('.pc3-row').length, chains: m.chains.length, none: !!document.querySelector('.pc3-none'), strip: [...document.querySelectorAll('.pc3-stat b')].map(b => b.textContent), kinds: [...new Set(m.chains.map(c => c.kind))] }; })()`);
  const truth = await evaluate(TRUTH);
  await shot(join(OUT, `all-games-${width}.png`));
  record('all-games', width, [
    ...(await generic()),
    { name: 'board renders chains or the honest empty state', ok: summary?.rows > 0 || summary?.none === true, detail: JSON.stringify(summary) },
    { name: 'strip values are counts or honest dashes', ok: Array.isArray(summary?.strip) && summary.strip.length === 6 && summary.strip.every(v => /^(\d+|—|…|\d+[mhd]( \d+m)?|just now)$/.test(v.trim())), detail: summary?.strip?.join(' | ') },
    { name: 'truth invariants', ok: truth?.ok === true, detail: JSON.stringify(truth?.bad || truth) },
    { name: 'freshness line present', ok: /Injury report/i.test(await evaluate(`document.querySelector('.pc3-status')?.textContent || ''`)) },
    { name: 'player-prop best is named "Best main line", never a bare "Best line"', ok: (await evaluate(`(() => { const t = document.querySelector('.pc3')?.innerText || ''; const bare = t.split('Best Line page').join('').match(/best line/gi) || []; const head = document.querySelector('.pc3-board-head')?.textContent || ''; const lbl = [...document.querySelectorAll('.pc3-lbl')].filter(x => /best/i.test(x.textContent)).every(x => x.textContent.trim() === 'Best main line'); return bare.length === 0 && (!head || /Best main line/.test(head)) && lbl; })()`)) === true },
    { name: 'best main line definition available', ok: (await evaluate(`(document.querySelector('.pc3-tip')?.getAttribute('data-tip') || '').includes('alternate ladders are not treated as the same wager')`)) === true }
  ], { note: `rows=${summary?.rows} chains=${summary?.chains}` });

  /* 3 · filters */
  if (narrow) await click('[data-pc3-filters]');
  const filterChecks = [];
  if (narrow) filterChecks.push({ name: 'filters disclosure opens', ok: (await evaluate(`getComputedStyle(document.querySelector('.pc3-more')).display !== 'none'`)) === true });
  if (narrow) await shot(join(OUT, `filters-open-${width}.png`));
  for (const [key, value, test] of [
    ['signal', 'market', `rows.every(r => r.c.kind === 'MARKET')`],
    ['signal', 'injury', `rows.every(r => r.c.kind === 'INJURY')`],
    ['severity', 'high', `rows.every(r => r.c.severity === 'HIGH')`],
    ['window', '24', `rows.every(r => !r.c.time || Date.parse(r.c.time) >= Date.now() - 24 * 3600000)`]
  ]) {
    await click(`[data-pc3-set="${key}:${value}"]`); await sleep(900);
    const r = await evaluate(`(() => { const m = PBEPropChain.model(); const by = new Map(m.chains.map(c => [c.id, c])); const rows = [...document.querySelectorAll('.pc3-row[data-id]')].map(el => ({ c: by.get(el.dataset.id) })); return { n: rows.length, ok: rows.every(r => r.c) && ${test}, none: !!document.querySelector('.pc3-none'), pressed: document.querySelector('[data-pc3-set="${key}:${value}"]')?.getAttribute('aria-pressed') }; })()`);
    filterChecks.push({ name: `${key}=${value} narrows the board`, ok: r?.ok === true && r?.pressed === 'true' && (r.n > 0 || r.none), detail: JSON.stringify(r) });
    await click(`[data-pc3-set="${key}:${key === 'window' ? '48' : 'all'}"]`); await sleep(500);
  }
  const probe = await evaluate(`(() => { const m = PBEPropChain.model(); const c = m.chains.find(x => x.entity?.type === 'PLAYER' && x.complete); return c ? c.entity.name : null; })()`);
  if (probe && !probe.__error) {
    await evaluate(`(() => { const i = document.querySelector('[data-pc3-q]'); i.focus(); i.value = ${JSON.stringify(probe)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(900);
    const r = await evaluate(`(() => { const names = [...document.querySelectorAll('.pc3-row .pc3-c-change')].map(x => x.textContent); return { n: names.length, all: names.every(t => t.toLowerCase().includes(${JSON.stringify(probe.toLowerCase())}) || true), first: names[0] || null, focus: document.activeElement?.matches?.('[data-pc3-q]') }; })()`);
    const chainsMatch = await evaluate(`(() => { const m = PBEPropChain.model(); const by = new Map(m.chains.map(c => [c.id, c])); return [...document.querySelectorAll('.pc3-row[data-id]')].every(el => PBEPropChainCore.normName(by.get(el.dataset.id).search).includes(PBEPropChainCore.normName(${JSON.stringify(probe)}))); })()`);
    filterChecks.push({ name: `search "${probe}" finds only matching chains`, ok: r?.n > 0 && chainsMatch === true, detail: JSON.stringify(r) });
    filterChecks.push({ name: 'search keeps input focus across repaint', ok: r?.focus === true });
    await evaluate(`(() => { const i = document.querySelector('[data-pc3-q]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(500);
  }
  record('filters', width, [...filterChecks, ...(await generic())]);
  if (narrow) await click('[data-pc3-filters]');

  /* 4 · game selector */
  const games = await evaluate(`(() => { const m = PBEPropChain.model(); const count = new Map(); m.chains.filter(c => c.complete && PBEPropChainCore.matches(c, PBEPropChain.ui, Date.now())).forEach(c => count.set(c.game?.id, (count.get(c.game?.id) || 0) + 1)); const opts = [...document.querySelectorAll('[data-pc3-game] option')].map(o => o.value).filter(v => v !== 'all'); const busiest = [...count.entries()].sort((a, b) => b[1] - a[1])[0]; const quiet = opts.find(v => !m.chains.some(c => c.complete && String(c.game?.id) === v)); return { busiest: busiest ? busiest[0] : null, quiet: quiet || null }; })()`);
  const pick = async id => { await evaluate(`(() => { const s = document.querySelector('[data-pc3-game]'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await until(`(() => !PBEPropChain.model()?.chains.some(c => c.complete === null && String(c.game?.id) === ${JSON.stringify(id)}) || null)()`, 30000); await sleep(900); };
  const gameChecks = [];
  if (games?.busiest) {
    await pick(games.busiest);
    const r = await evaluate(`(() => { const m = PBEPropChain.model(); const by = new Map(m.chains.map(c => [c.id, c])); const rows = [...document.querySelectorAll('.pc3-row[data-id]')].map(el => by.get(el.dataset.id)); return { n: rows.length, same: rows.every(c => String(c.game?.id) === ${JSON.stringify(String(games.busiest))}), ctx: document.querySelectorAll('.pc3-ctx').length }; })()`);
    gameChecks.push({ name: 'a game with changes narrows the board to that game', ok: r?.n > 0 && r.same, detail: JSON.stringify(r) });
    gameChecks.push({ name: 'selected game shows market, injury and weather context', ok: r?.ctx >= 3, detail: String(r?.ctx) });
    await shot(join(OUT, `game-${width}.png`));
  } else gameChecks.push({ name: 'a game with chains exists to test', ok: false, detail: JSON.stringify(games) });
  if (games?.quiet) {
    await pick(games.quiet);
    const r = await evaluate(`({ none: !!document.querySelector('.pc3-none'), text: document.querySelector('.pc3-none b')?.textContent, ctx: document.querySelectorAll('.pc3-ctx').length, fresh: !!document.querySelector('.pc3-status') })`);
    gameChecks.push({ name: 'a game without chains says so and still shows context', ok: r?.none === true && /No complete chains meet these filters/.test(r.text || '') && r.ctx >= 2 && r.fresh, detail: JSON.stringify(r) });
    await shot(join(OUT, `no-chain-game-${width}.png`));
  }
  await pick('all');
  record('game', width, [...gameChecks, ...(await generic())], { note: JSON.stringify(games) });

  /* 5 · evidence */
  const target = await evaluate(`(() => { const m = PBEPropChain.model(); const rows = [...document.querySelectorAll('.pc3-row[data-id]')].map(r => r.dataset.id); const by = new Map(m.chains.map(c => [c.id, c])); return rows.find(id => by.get(id)?.kind === 'MARKET') || rows.find(id => by.get(id)?.market?.kind === 'PLAYER_PROPS') || rows[0] || null; })()`);
  const evChecks = [];
  if (target && !target.__error) {
    await click(`[data-pc3-open="${target}"]`); await sleep(700);
    const r = await evaluate(`(() => { const row = document.querySelector('.pc3-row.is-open'); const ev = row?.querySelector('.pc3-evidence'); return { open: !!ev, expanded: row?.querySelector('.pc3-row-btn')?.getAttribute('aria-expanded'), steps: [...(ev?.querySelectorAll('.pc3-step header span') || [])].map(s => s.textContent), actions: ev?.querySelectorAll('.pc3-actions button, .pc3-actions a').length || 0, times: (ev?.textContent.match(/ET\\b/g) || []).length }; })()`);
    evChecks.push({ name: 'evidence opens with the five ordered steps', ok: r?.open && r.expanded === 'true' && JSON.stringify(r.steps) === JSON.stringify(['Source event', 'Entity', 'Market tape', 'Marketplace', 'PBE model']), detail: JSON.stringify(r) });
    evChecks.push({ name: 'evidence carries timestamps and next-step actions', ok: r?.times >= 2 && r.actions >= 2, detail: `times=${r?.times} actions=${r?.actions}` });
    evChecks.push({ name: 'truth invariants with a row open', ok: (await evaluate(TRUTH))?.ok === true });
    await shotElement('.pc3-row.is-open', join(OUT, `evidence-${width}.png`));
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(400);
    const closed = await evaluate(`({ open: !!document.querySelector('.pc3-row.is-open'), focus: document.activeElement?.dataset?.pc3Open || null })`);
    evChecks.push({ name: 'Escape closes and returns focus to the row', ok: closed?.open === false && closed.focus === target, detail: JSON.stringify(closed) });
    await evaluate(`document.querySelector('[data-pc3-open="${target}"]').focus()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(600);
    evChecks.push({ name: 'Enter on a focused row opens it', ok: (await evaluate(`!!document.querySelector('.pc3-row.is-open')`)) === true });
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  } else evChecks.push({ name: 'a row exists to expand', ok: false });
  record('evidence', width, [...evChecks, ...(await generic())]);

  /* 5b · transitions, when the API publishes them */
  const tr = await evaluate(`(() => { const m = PBEPropChain.model(); const c = m.chains.find(x => x.transition && x.complete && PBEPropChainCore.matches(x, PBEPropChain.ui, Date.now())); return { published: m.chains.some(x => x.transition) || m.context.some(x => x.transition), id: c ? c.id : null }; })()`);
  if (tr?.published && tr.id) {
    const rowOnPage = await evaluate(`(() => { const i = document.querySelector('[data-pc3-q]'); const c = PBEPropChain.model().chains.find(x => x.id === ${JSON.stringify(tr.id)}); i.value = c.entity.name; i.dispatchEvent(new Event('input', { bubbles: true })); return c.entity.name; })()`);
    await sleep(900);
    await click(`[data-pc3-open="${tr.id}"]`); await sleep(700);
    const r = await evaluate(`(() => { const row = document.querySelector('.pc3-row.is-open'); return { label: row?.querySelector('.pc3-trans')?.textContent || null, block: row?.querySelector('.pc3-transition')?.textContent || null }; })()`);
    record('transitions', width, [
      { name: 'a ledger transition renders as FROM → TO on the row', ok: /→/.test(r?.label || ''), detail: JSON.stringify(r) },
      { name: 'evidence shows both capture times', ok: /Last captured as[\s\S]*ET[\s\S]*First captured as[\s\S]*ET/.test(r?.block || ''), detail: (r?.block || '').slice(0, 120) },
      { name: 'truth invariants', ok: (await evaluate(TRUTH))?.ok === true }
    ], { note: String(rowOnPage) });
    await shotElement('.pc3-row.is-open', join(OUT, `transition-evidence-${width}.png`));
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await evaluate(`(() => { const i = document.querySelector('[data-pc3-q]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(500);
  } else if (REQUIRE) record('transitions', width, [{ name: 'a published ledger transition exists to exercise', ok: false, detail: JSON.stringify(tr) }]);
  else console.log(`SKIP transitions@${width} — the change API publishes no transitions${UPSTREAM ? '' : ' (production nfl-intel; set PBE_CHANGES_UPSTREAM to exercise 1.2.0)'}`);

  /* 5c · market movement evidence: a MARKET chain opens to a tape with both
     capture times, both values and the book counts */
  const mv = await evaluate(`(() => { const m = PBEPropChain.model(); const c = m.chains.find(x => x.kind === 'MARKET' && PBEPropChainCore.matches(x, PBEPropChain.ui, Date.now())); return c ? c.id : null; })()`);
  if (mv && !mv.__error) {
    await click('[data-pc3-set="signal:market"]'); await sleep(700);
    await click(`[data-pc3-open="${mv}"]`); await sleep(700);
    const r = await evaluate(`(() => { const c = PBEPropChain.model().chains.find(x => x.id === ${JSON.stringify(mv)}); const t = document.querySelector('.pc3-row.is-open .pc3-bigtape'); const txt = t?.textContent || ''; return { has: !!t, from: c.move.from.captured_at, to: c.move.to.captured_at, times: (txt.match(/ET/g) || []).length, books: (txt.match(/books/g) || []).length, delta: !!t?.querySelector('.pc3-delta') }; })()`);
    record('market-move-evidence', width, [
      { name: 'movement evidence shows two captures, two values, books and the delta', ok: r?.has && r.from && r.to && r.from !== r.to && r.times >= 2 && r.books >= 2 && r.delta, detail: JSON.stringify(r) },
      { name: 'evidence tile labels (incl. Best main line + help) sit on one line', ok: (await evaluate(`(() => { const labels = [...document.querySelectorAll('.pc3-row.is-open .pc3-quad small')]; const bad = labels.filter(el => { const lh = parseFloat(getComputedStyle(el).lineHeight) || 14; const tip = el.querySelector('.pc3-tip'); const one = Math.max(lh, tip ? tip.getBoundingClientRect().height : 0) + 4; return el.getBoundingClientRect().height > one || el.scrollWidth > el.clientWidth + 1; }).map(el => el.textContent.trim() + '@' + Math.round(el.getBoundingClientRect().height)); return labels.length > 0 && bad.length === 0 ? true : { labels: labels.length, bad }; })()`)) === true },
      { name: 'truth invariants', ok: (await evaluate(TRUTH))?.ok === true },
      ...(await generic())
    ]);
    await shotElement('.pc3-row.is-open', join(OUT, `market-move-evidence-${width}.png`));
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await click('[data-pc3-set="signal:all"]'); await sleep(500);
  } else if (REQUIRE) record('market-move-evidence', width, [{ name: 'an observed market move exists to exercise', ok: false }]);
  else console.log(`SKIP market-move-evidence@${width} — no observed consensus move in scope`);

  /* 6 · polling stops off-route */
  const polling = [];
  polling.push({ name: 'refresh timer runs on the route', ok: (await evaluate('PBEPropChain.refreshing()')) === true });
  await evaluate(`App.nav('home')`); await sleep(800);
  polling.push({ name: 'refresh timer stops when the route is left', ok: (await evaluate('PBEPropChain.refreshing()')) === false });
  record('polling', width, polling);

  /* 7 · failure states */
  rules = [{ match: /\/api\/changes/, status: 503 }];
  await open('propchain');
  const fail = await evaluate(`({ err: document.querySelector('.pc3-error')?.innerText || null, none: !!document.querySelector('.pc3-none'), rows: document.querySelectorAll('.pc3-row[data-id]').length })`);
  await shot(join(OUT, `changes-unavailable-${width}.png`));
  const failErrors = state.errors.filter(e => !/503|gate_injected|Failed to load resource/.test(e));
  record('failure:changes-503', width, [
    { name: 'unavailable state, never "nothing changed"', ok: /unavailable/i.test(fail?.err || '') && !fail.none && fail.rows === 0, detail: JSON.stringify(fail) },
    { name: 'retry offered', ok: (await evaluate(`!!document.querySelector('[data-pc3-retry]')`)) === true },
    { name: 'no unexpected console errors', ok: failErrors.length === 0, detail: failErrors.slice(0, 2).join(' | ') }
  ]);
  rules = [{ match: /\/api\/odds\/board/, status: 503 }];
  await open('propchain');
  const boardFail = await evaluate(`(() => { const m = PBEPropChain.model(); return { props: m.chains.filter(c => c.market?.kind === 'PLAYER_PROPS').length, stops: m.context.filter(c => c.stop === 'MARKET_UNAVAILABLE').length, rows: document.querySelectorAll('.pc3-row[data-id]').length, truth: null }; })()`);
  record('failure:boards-503', width, [
    { name: 'no player chain claims a market it could not read', ok: boardFail?.props === 0 && boardFail.stops > 0, detail: JSON.stringify(boardFail) },
    { name: 'truth invariants', ok: (await evaluate(TRUTH))?.ok === true }
  ]);

  /* 8 · stale */
  rules = [{ match: /\/api\/changes/, mutate: j => { if (j.sources?.injuries) { j.sources.injuries.stale = true; j.sources.injuries.age_seconds = 5400; } return j; } }];
  await open('propchain');
  const stale = await evaluate(`document.querySelector('.pc3-status')?.innerText || ''`);
  record('stale', width, [{ name: 'stale injury report is labelled STALE', ok: /STALE/.test(stale), detail: stale.slice(0, 160) }]);
  rules = [];
}

writeFileSync(join(OUT, `report-${WIDTHS.join('-')}.json`), JSON.stringify(report, null, 2));
console.log(`\n${failures ? `${failures} FAILED CHECK(S)` : 'ALL CHECKS PASSED'} · ${report.length} scenario runs · ${OUT}`);
finish(failures ? 1 : 0);
