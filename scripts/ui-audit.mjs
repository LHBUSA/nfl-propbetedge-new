/* PropBetEdge NFL — UI audit harness.
 *
 * Loads https://nfl.propbetedge.ai in real headless Chrome while substituting
 * every same-origin static HTML/JS/CSS request with the checked-out branch, so
 * what we screenshot is THIS working tree running against live production APIs.
 *
 * For each route x viewport it captures a full-page screenshot and a set of
 * measured design defects (horizontal overflow, sub-legible type, tiny touch
 * targets, broken images, low-contrast text, console errors).
 *
 * Usage:
 *   node scripts/ui-audit.mjs --out <dir> [--routes a,b,c] [--widths 390,768,1280,1440]
 */
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,extname} from 'node:path';

const REPO = process.cwd();
const TARGET = process.env.PBE_TARGET || 'https://nfl.propbetedge.ai';
const ORIGIN = new URL(TARGET).origin;
const PORT = 9800 + Math.floor(Math.random() * 90);
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const LIVE = process.env.PBE_LIVE === '1'; // screenshot deployed production instead of working tree

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT = arg('out', join(REPO, '.ui-audit'));
const ROUTES = arg('routes', 'home,games,propboard,marketwatch,matchups,picks,pbepicks,usage,injuries,newsintel,pbecast,simulator,sgplab,propchain,teams,standings,stats,records').split(',').map(s => s.trim()).filter(Boolean);
const WIDTHS = arg('widths', '390,768,1280,1440').split(',').map(n => parseInt(n, 10));
const HEIGHTS = {390: 844, 768: 1024, 1280: 800, 1440: 900};

mkdirSync(OUT, {recursive: true});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-uiaudit-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${dir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-timer-throttling',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  'about:blank'
], {stdio: 'ignore'});

function finish(code) {
  try { chrome.kill(); } catch {}
  setTimeout(() => { try { rmSync(dir, {recursive: true, force: true}); } catch {} process.exit(code); }, 250);
}
const hard = setTimeout(() => { console.error('HARD_DEADLINE'); finish(3); }, 900000);
hard.unref?.();

async function wsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('devtools_unavailable');
}

const ws = new WebSocket(await wsUrl());
await new Promise(r => { ws.onopen = r; });

let id = 1;
const pending = new Map();
const send = (method, params = {}) => {
  const n = id++;
  ws.send(JSON.stringify({id: n, method, params}));
  return new Promise((resolve, reject) => pending.set(n, {resolve, reject}));
};

const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};
const mime = p => MIME[extname(p)] || 'application/octet-stream';

function localFile(url) {
  if (LIVE) return null;
  let u; try { u = new URL(url); } catch { return null; }
  if (u.origin !== ORIGIN || u.pathname.startsWith('/api/')) return null;
  let rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
  if (!rel || rel.includes('..')) return null;
  if (!Object.keys(MIME).includes(extname(rel))) return null;
  const fp = join(REPO, rel);
  try {
    if (!existsSync(fp) || !statSync(fp).isFile()) return null;
    return {rel, body: readFileSync(fp), type: mime(rel)};
  } catch { return null; }
}

const consoleErrors = [];
const failedRequests = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Fetch.requestPaused') {
    const local = localFile(m.params.request.url);
    if (local) {
      send('Fetch.fulfillRequest', {
        requestId: m.params.requestId,
        responseCode: 200,
        responseHeaders: [{name: 'content-type', value: local.type}, {name: 'cache-control', value: 'no-store'}],
        body: local.body.toString('base64')
      }).catch(() => {});
    } else {
      send('Fetch.continueRequest', {requestId: m.params.requestId}).catch(() => {});
    }
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 300));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map(a => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300));
  }
  if (m.method === 'Network.loadingFailed') {
    failedRequests.push(`${m.params.type} ${m.params.errorText}`);
  }
};

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Fetch.enable', {patterns: [{urlPattern: `${ORIGIN}/*`, requestStage: 'Request'}]});

const probe = async (expr, ms = 12000) => {
  try {
    const r = await Promise.race([
      send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true}),
      sleep(ms).then(() => { throw new Error('WEDGED'); })
    ]);
    return r.result?.value;
  } catch (e) { return {__error: e.message}; }
};

/* ---- in-page measurement -------------------------------------------- */
const AUDIT_EXPR = `(() => {
  const out = {};
  const de = document.documentElement;
  out.scrollW = de.scrollWidth;
  out.clientW = de.clientWidth;
  out.overflowX = de.scrollWidth - de.clientWidth;

  // elements that stick out past the viewport
  const bleeders = [];
  const vw = de.clientWidth;
  document.querySelectorAll('body *').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.right > vw + 2 || r.left < -2) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed') return;
      bleeders.push({
        sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,3).join('.') : ''),
        left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width)
      });
    }
  });
  // dedupe by selector, keep worst
  const bmap = new Map();
  bleeders.forEach(b => { const p = bmap.get(b.sel); if (!p || b.right > p.right) bmap.set(b.sel, b); });
  out.bleeders = [...bmap.values()].sort((a,b) => b.right - a.right).slice(0, 12);

  // sub-legible type: visible text nodes rendered under 11px
  const tiny = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.nodeValue && n.nodeValue.trim();
    if (!t || t.length < 2) continue;
    const el = n.parentElement;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const fs = parseFloat(cs.fontSize);
    if (fs < 11) {
      const key = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '') + '@' + fs.toFixed(1) + 'px';
      const rec = tiny.get(key) || {key, fs, count: 0, sample: t.slice(0, 40)};
      rec.count++;
      tiny.set(key, rec);
    }
  }
  out.tinyType = [...tiny.values()].sort((a,b) => a.fs - b.fs || b.count - a.count).slice(0, 20);
  out.tinyTypeTotal = [...tiny.values()].reduce((s,r) => s + r.count, 0);

  // touch targets below 44px on narrow viewports
  if (vw <= 768) {
    const small = [];
    document.querySelectorAll('a[onclick],button,[role="button"],.nav-item,.mbn-item,input,select,[data-route]').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.height < 40 || r.width < 30) {
        small.push({sel: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : ''), h: Math.round(r.height), w: Math.round(r.width)});
      }
    });
    const smap = new Map();
    small.forEach(s => { if (!smap.has(s.sel)) smap.set(s.sel, {...s, count: 0}); smap.get(s.sel).count++; });
    out.smallTargets = [...smap.values()].slice(0, 15);
  }

  // images
  const imgs = [...document.images];
  out.images = {
    total: imgs.length,
    broken: imgs.filter(i => i.complete && !i.naturalWidth).length,
    // alt="" is the correct marker for a decorative image whose meaning is
    // already carried by adjacent text; only a MISSING alt attribute is a defect.
    noAlt: imgs.filter(i => i.getAttribute('alt') === null).length,
    decorative: imgs.filter(i => i.getAttribute('alt') === '').length,
    noDims: imgs.filter(i => !i.getAttribute('width') && !i.style.aspectRatio && !getComputedStyle(i).aspectRatio.includes('/')).length,
    lazy: imgs.filter(i => i.loading === 'lazy').length
  };

  // low contrast text (approximate; solid backgrounds only)
  const srgb = c => { c /= 255; return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
  const lum = rgb => 0.2126*srgb(rgb[0]) + 0.7152*srgb(rgb[1]) + 0.0722*srgb(rgb[2]);
  const parse = s => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(x => parseFloat(x)); return p.length > 3 && p[3] < 0.95 ? null : p; };
  // A gradient fill leaves backgroundColor transparent, so walking to the page
  // ground reported dark-ink-on-gold buttons as 1.01:1 when they are really
  // ~8.9:1. Resolve the gradient's first colour stop instead.
  function gradientColor(cs) {
    const img = cs.backgroundImage;
    if (!img || img === 'none' || !/gradient\\(/.test(img)) return null;
    const stops = [...img.matchAll(/rgba?\\(([^)]+)\\)/g)].map(m => m[1].split(',').map(x => parseFloat(x)));
    if (!stops.length) return null;
    // A gradient of near-transparent stops is an overlay, not a background --
    // it does not determine what the text sits on, so keep walking the tree.
    const opaque = stops.filter(p => p.length < 4 || p[3] > 0.6);
    if (!opaque.length) return null;
    return [0,1,2].map(i => Math.round(opaque.reduce((s,p) => s + p[i], 0) / opaque.length));
  }
  function bgOf(el) {
    let e = el;
    while (e && e !== document.documentElement) {
      const cs = getComputedStyle(e);
      const g = gradientColor(cs);
      if (g) return g;
      const c = parse(cs.backgroundColor);
      if (c) return c;
      e = e.parentElement;
    }
    return [20, 17, 13];
  }
  const lowC = new Map();
  document.querySelectorAll('body *').forEach(el => {
    if (!el.childNodes.length) return;
    const hasText = [...el.childNodes].some(c => c.nodeType === 3 && c.nodeValue.trim().length > 1);
    if (!hasText) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) return;
    const bg = bgOf(el);
    const l1 = lum(fg), l2 = lum(bg);
    const ratio = (Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05);
    const fs = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = fs >= 24 || (fs >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    if (ratio < need) {
      const key = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '');
      const rec = lowC.get(key) || {key, ratio: +ratio.toFixed(2), fs, count: 0, color: cs.color};
      rec.count++;
      if (ratio < rec.ratio) rec.ratio = +ratio.toFixed(2);
      lowC.set(key, rec);
    }
  });
  out.lowContrast = [...lowC.values()].sort((a,b) => a.ratio - b.ratio).slice(0, 15);
  out.lowContrastTotal = [...lowC.values()].reduce((s,r) => s + r.count, 0);

  // view content sanity
  const vc = document.getElementById('view-container');
  out.viewChars = (vc?.textContent || '').trim().length;
  out.pending = !!document.querySelector('[data-pbe-pending-route]');
  out.route = window.App?.current || null;
  out.docHeight = document.body.scrollHeight;
  return out;
})()`;

async function setViewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1,
    mobile: width <= 768,
    screenWidth: width, screenHeight: height
  });
  if (width <= 768) {
    await send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
  } else {
    await send('Emulation.setTouchEmulationEnabled', {enabled: false});
  }
}

async function shot(name, fullPage) {
  const opts = {format: 'png', optimizeForSpeed: true};
  if (fullPage) opts.captureBeyondViewport = true;
  const r = await send('Page.captureScreenshot', opts);
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

/* ---- run ------------------------------------------------------------- */
const report = {target: TARGET, mode: LIVE ? 'live-production' : 'working-tree', at: new Date().toISOString(), viewports: {}};

console.log(`TARGET ${TARGET}  MODE ${report.mode}`);

for (const width of WIDTHS) {
  const height = HEIGHTS[width] || 900;
  await setViewport(width, height);
  await send('Page.navigate', {url: `${TARGET}/?uiaudit=${Date.now()}`});
  await sleep(14000);

  const vp = {width, height, routes: {}};
  for (const route of ROUTES) {
    consoleErrors.length = 0;
    await probe(`window.App && App.nav(${JSON.stringify(route)})`, 10000);
    await sleep(2600);
    const a = await probe(AUDIT_EXPR, 25000);
    const file = await shot(`${route}-${width}`, true);
    vp.routes[route] = {...(a && typeof a === 'object' ? a : {raw: a}), consoleErrors: [...new Set(consoleErrors)].slice(0, 6), shot: file};
    const ov = a?.overflowX ?? '?';
    console.log(`  ${String(width).padEnd(5)} ${route.padEnd(14)} overflow=${String(ov).padEnd(5)} tiny=${String(a?.tinyTypeTotal ?? '?').padEnd(4)} lowC=${String(a?.lowContrastTotal ?? '?').padEnd(4)} chars=${a?.viewChars ?? '?'} err=${vp.routes[route].consoleErrors.length}`);
  }
  report.viewports[width] = vp;
}

writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\nWrote ${join(OUT, 'report.json')}`);
ws.close();
finish(0);
