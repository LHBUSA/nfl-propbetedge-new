/* PropBetEdge NFL — production real-logo browser gate.
 *
 * Runs only after deployment. It visits every route exposed by the live sports
 * shell and fails if a synthetic logo/initials fallback is visible, if a
 * visible image is broken, or if the global real-logo authority is missing.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TARGET = process.env.PBE_URL || 'https://nfl.propbetedge.ai';
const CHROME = process.env.PBE_CHROME || '/usr/bin/google-chrome';
const PORT = 9860 + Math.floor(Math.random() * 80);
const LOG = 'real-logo-audit.log';
const out = (s) => { console.log(s); try { appendFileSync(LOG, `${s}\n`); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-real-logo-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${dir}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-timer-throttling',
  '--window-size=1440,1000',
  'about:blank'
], { stdio: 'ignore' });

function finish(code) {
  try { chrome.kill(); } catch {}
  setTimeout(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    process.exit(code);
  }, 200);
}

const hard = setTimeout(() => { out('HARD_DEADLINE'); finish(3); }, 300000);
hard.unref?.();

async function wsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('devtools_unavailable');
}

const ws = new WebSocket(await wsUrl());
await new Promise((resolve) => { ws.onopen = resolve; });
let id = 1;
const pending = new Map();
const exceptions = [];
const send = (method, params = {}) => {
  const n = id++;
  ws.send(JSON.stringify({ id: n, method, params }));
  return new Promise((resolve, reject) => pending.set(n, { resolve, reject }));
};
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    exceptions.push(String(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || '').slice(0, 280));
  }
};

await send('Runtime.enable');
await send('Page.enable');
const probe = async (expression, timeout = 9000) => {
  try {
    const result = await Promise.race([
      send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeout).then(() => { throw new Error('WEDGED'); })
    ]);
    return result.result?.value;
  } catch (error) {
    return `<${error.message}>`;
  }
};
const shot = async (name) => {
  try {
    const cap = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(`real-logo-${name}.png`, Buffer.from(cap.data, 'base64'));
  } catch {}
};

out(`TARGET ${TARGET}`);
await send('Page.navigate', { url: `${TARGET}/?realLogoAudit=${Date.now()}#home` });
await sleep(12000);

if (await probe('1+1') !== 2) {
  out('FAIL main thread wedged');
  await shot('wedged');
  ws.close();
  finish(1);
}

const authority = await probe(`typeof window.PBENFLMediaV2?.scan === 'function'`);
out(`real logo authority    : ${authority}`);
if (authority !== true) {
  out('FAIL PBENFLMediaV2.scan is not loaded');
  await shot('authority-missing');
  ws.close();
  finish(1);
}

const discovered = await probe(`(()=>[...new Set([...document.querySelectorAll('#pbe-sports-shell [data-route]')].map(n=>n.dataset.route).filter(Boolean))])()`);
const fallbackRoutes = ['home','games','propboard','pbecast','marketwatch','picks','pbepicks','trackrecord','matchups','usage','injuries','newsintel','qbdna','wrdna','rbdna','tedna','simulator','sgplab','propchain','teams','standings','stats','seasonhistory','records','hof','sb','prospects','trades'];
const routes = Array.isArray(discovered) && discovered.length >= 20 ? discovered : fallbackRoutes;
out(`routes                 : ${routes.join(', ')}`);

const auditExpr = `(()=>{
  const visible = (el) => {
    const s=getComputedStyle(el),r=el.getBoundingClientRect();
    return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0.01&&r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight;
  };
  const selectors=[
    '.pbes-score-logo-fallback',
    '.pbe25-logo-fallback',
    '.pbe-team-logo-fallback',
    '.pbe2-team-fallback',
    '.pbe7-team-logo b',
    '.home5-logo strong',
    '.sidebar-logo>svg',
    '.pbe-v2-brand>svg',
    '.pbe22-bookmark>span',
    'i.pbe5-mark',
    'svg.team-crest'
  ];
  const fake=[];
  for(const sel of selectors) for(const el of document.querySelectorAll(sel)) if(visible(el)) fake.push({sel,text:(el.textContent||'').trim().slice(0,40)});
  for(const el of document.querySelectorAll('.pbe-team-img:not(img)')) if(visible(el)&&el.querySelector('b')) fake.push({sel:'.pbe-team-img:not(img)',text:(el.textContent||'').trim().slice(0,40)});
  const visibleImgs=[...document.images].filter(visible);
  const broken=visibleImgs.filter(img=>img.complete&&!img.naturalWidth).map(img=>({src:img.currentSrc||img.src,alt:img.alt||''}));
  const team=visibleImgs.filter(img=>/a\\.espncdn\\.com\\/i\\/teamlogos\\/nfl/i.test(img.currentSrc||img.src)).length;
  const books=visibleImgs.filter(img=>img.classList.contains('pbe-official-book-logo')).length;
  const brands=visibleImgs.filter(img=>img.classList.contains('pbe-official-brand-logo')||/propbetedge\\.ai\\/logo\\/pbe-/i.test(img.currentSrc||img.src)).length;
  const chars=(document.querySelector('#view-container')?.textContent||'').trim().length;
  return{fake,broken,team,books,brands,chars,route:window.App?.current||location.hash.slice(1)};
})()`;

let pass = true;
const results = [];
for (const route of routes) {
  const nav = await probe(`window.App?.nav?.(${JSON.stringify(route)},{history:false});true`);
  if (nav !== true) {
    out(`${route.padEnd(14)} FAIL navigation unavailable`);
    pass = false; break;
  }
  await sleep(1700);
  await probe(`window.PBENFLMediaV2?.scan?.();true`);
  await sleep(350);
  const a = await probe(auditExpr);
  results.push({ route, audit: a });
  if (!a || typeof a !== 'object') {
    out(`${route.padEnd(14)} FAIL audit=${String(a)}`);
    pass = false; await shot(route); break;
  }
  out(`${route.padEnd(14)} fake=${a.fake.length} broken=${a.broken.length} team=${a.team} book=${a.books} brand=${a.brands} chars=${a.chars}`);
  if (a.fake.length) out(`  fake: ${JSON.stringify(a.fake)}`);
  if (a.broken.length) out(`  broken: ${JSON.stringify(a.broken)}`);
  if (a.fake.length || a.broken.length || Number(a.chars) < 60 || a.route !== route) {
    pass = false;
    await shot(route);
    break;
  }
}

const finalExceptions = exceptions.filter(Boolean);
out(`exceptions             : ${finalExceptions.length}`);
if (finalExceptions.length) out(`  ${finalExceptions.join('\n  ')}`);
if (finalExceptions.length) pass = false;

const totalFakes = results.reduce((n,r)=>n+(Array.isArray(r.audit?.fake)?r.audit.fake.length:0),0);
const totalBroken = results.reduce((n,r)=>n+(Array.isArray(r.audit?.broken)?r.audit.broken.length:0),0);
out(`audited routes         : ${results.length}/${routes.length}`);
out(`visible fake logos     : ${totalFakes}`);
out(`visible broken images  : ${totalBroken}`);
out(`RESULT ${pass && results.length===routes.length ? 'PASS' : 'FAIL'}`);

ws.close();
clearTimeout(hard);
finish(pass && results.length===routes.length ? 0 : 1);
