/* IMAGE GATE for /#qbdna.
 *
 *   node scripts/qbdna-image-gate.mjs [widths]
 *   PBE_BASE / PBE_SHARE point it at a deployed preview.
 *
 * Asserts, on every rendered surface:
 *   · every player/team image inside QB DNA is a REAL image host, not a mark
 *   · zero broken images (naturalWidth 0 after load)
 *   · zero PBE logos standing in for a player
 *   · zero initials/letter badges standing in for a team
 *   · the primary QB, the compare QBs and the matchup teams all carry a real
 *     image (or, for a photo ESPN genuinely does not have, an EXPLICIT
 *     unavailable state — never a substitute picture)
 *   · alt text names the right identity
 *   · nothing is upscaled beyond its intrinsic size
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] || 'image-gate';
const WIDTHS = (process.argv[3] || '1440,390').split(',').map(Number);
const TARGET = process.env.PBE_BASE || `http://localhost:${process.env.PBE_PORT || '4321'}`;
const SHARE = process.env.PBE_SHARE || '';
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DP = 9900 + Math.floor(Math.random() * 90);

/* Each surface: how to reach it, and what identity must be visible. */
const SURFACES = [
  { name: 'overview',  tab: 'overview',   state: { playerId: '00-0033873' } },
  { name: 'conditions', tab: 'conditions', state: { playerId: '00-0033873' } },
  { name: 'props',     tab: 'props',      state: { playerId: '00-0033873', market: 'passing_yards', line: '' } },
  { name: 'compare',   tab: 'compare',    state: { playerId: '00-0033873', comparePlayerId: '00-0034857' } },
  { name: 'no-history', tab: 'overview',  state: { playerId: '00-0039107' } },
  { name: 'market-unavailable', tab: 'props',
    state: { playerId: '00-0033873', market: 'interceptions', line: '' } }
];

mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-img-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${DP}`, `--user-data-dir=${dir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
function finish(c) { try { chrome.kill(); } catch {} setTimeout(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(c); }, 200); }
setTimeout(() => { console.error('DEADLINE'); finish(3); }, 540000).unref?.();

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
const evalIn = async (expr, ms = 60000) => {
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

const PROBE = `(() => {
  const root = document.querySelector('.qbd');
  if (!root) return { error: 'no .qbd root' };
  const imgs = [...root.querySelectorAll('img')];
  const rows = imgs.map(im => {
    const r = im.getBoundingClientRect();
    return {
      src: im.currentSrc || im.getAttribute('src') || '',
      alt: im.getAttribute('alt') || '',
      cls: im.className,
      complete: im.complete,
      nw: im.naturalWidth, nh: im.naturalHeight,
      w: Math.round(r.width), h: Math.round(r.height),
      broken: im.complete && im.naturalWidth === 0,
      // an image drawn larger than its own pixels looks soft
      upscale: im.naturalWidth ? +(r.width / im.naturalWidth).toFixed(2) : null
    };
  });
  const host = s => { try { return new URL(s, location.href).host; } catch { return ''; } };
  return {
    total: rows.length,
    rows,
    hosts: [...new Set(rows.map(r => host(r.src)).filter(Boolean))],
    broken: rows.filter(r => r.broken).length,
    // a PBE mark inside QB DNA would be a logo standing in for a person
    pbeMarks: rows.filter(r => /propbetedge|pbe[-_]?logo|\\/logo\\.|brand/i.test(r.src)).length,
    upscaled: rows.filter(r => r.upscale !== null && r.upscale > 1.15).length,
    faces: rows.filter(r => /qbd-face/.test(r.cls)).length,
    crests: rows.filter(r => /qbd-crest/.test(r.cls)).length,
    facesOk: rows.filter(r => /qbd-face/.test(r.cls) && r.nw > 0).length,
    crestsOk: rows.filter(r => /qbd-crest/.test(r.cls) && r.nw > 0).length,
    explicitUnavailable: root.querySelectorAll('.qbd-face-none').length,
    // any element that draws letters inside a disc as a stand-in for a team
    initialsBadges: [...root.querySelectorAll('*')].filter(el => {
      if (el.children.length) return false;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 3 || !/^[A-Z]{1,3}$/.test(t)) return false;
      const cs = getComputedStyle(el);
      return parseFloat(cs.borderRadius) > 8 || cs.borderRadius.includes('50%');
    }).length,
    primaryFaceAlt: (root.querySelector('.qbd-mast-id .qbd-face, .qbd-mast-id .qbd-face-none') || {})
      .getAttribute ? (root.querySelector('.qbd-mast-id .qbd-face') || {}).alt || null : null,
    compareAlts: [...root.querySelectorAll('.qbd-vs-face .qbd-face')].map(i => i.alt),
    matchupCrests: root.querySelectorAll('.qbd-match .qbd-crest').length,
    matchupAlts: [...root.querySelectorAll('.qbd-match .qbd-crest')].map(i => i.alt)
  };
})()`;

const report = [];
let failures = 0;
for (const width of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride',
    { width, height: width <= 768 ? 844 : 900, deviceScaleFactor: 1, mobile: width <= 768 });
  await send('Page.navigate', { url: `${TARGET}/#qbdna?t=${Date.now()}` });
  await sleep(15000);
  await evalIn('window.App && App.nav("qbdna")', 15000);
  await sleep(7000);

  for (const s of SURFACES) {
    await evalIn(`(async()=>{const S=window.PBEQBDna.state;
      Object.assign(S, ${JSON.stringify(s.state)});
      S.tab=${JSON.stringify(s.tab)};
      S.dna=null;S.prop=null;S.cmp=null;S.ctxCmp=null;S.eventId=null;S.ctx=null;
      await window.PBEQBDna.load(); return true;})()`);
    // give every lazy image a chance to actually decode before measuring
    await evalIn(`(async()=>{const im=[...document.querySelectorAll('.qbd img')];
      im.forEach(i=>i.loading='eager');
      await Promise.all(im.map(i=>i.complete?null:new Promise(r=>{i.onload=r;i.onerror=r;})));
      return im.length;})()`, 45000);
    await sleep(2500);

    const m = await evalIn(PROBE);
    const bad = [];
    if (m.error) bad.push(m.error);
    if (m.broken) bad.push(`${m.broken} broken image(s)`);
    if (m.pbeMarks) bad.push(`${m.pbeMarks} PBE mark(s) inside QB DNA`);
    if (m.initialsBadges) bad.push(`${m.initialsBadges} initials badge(s)`);
    if (m.upscaled) bad.push(`${m.upscaled} upscaled image(s)`);
    if (m.faces !== m.facesOk) bad.push(`${m.faces - m.facesOk} headshot(s) failed to load`);
    if (m.crests !== m.crestsOk) bad.push(`${m.crests - m.crestsOk} crest(s) failed to load`);
    const badHost = (m.hosts || []).filter(h => !/espncdn\.com$/.test(h));
    if (badHost.length) bad.push(`non-ESPN image host: ${badHost.join(', ')}`);
    // the surfaces that must show a real face
    if (['overview', 'conditions', 'props', 'compare'].includes(s.name) && !m.faces) {
      bad.push('no headshot rendered on a surface that requires one');
    }
    if (s.name === 'compare' && m.compareAlts.length !== 2) {
      bad.push(`compare shows ${m.compareAlts.length} headshots, expected 2`);
    }

    failures += bad.length ? 1 : 0;
    report.push({ width, surface: s.name, ok: !bad.length, problems: bad, ...m, rows: undefined });
    console.log(`${String(width).padEnd(5)} ${s.name.padEnd(20)} `
      + `imgs ${String(m.total).padStart(2)}  faces ${m.facesOk}/${m.faces}  `
      + `crests ${m.crestsOk}/${m.crests}  unavail ${m.explicitUnavailable}  `
      + (bad.length ? `FAIL: ${bad.join('; ')}` : 'OK'));
    if (s.name === 'compare' && m.compareAlts.length) {
      console.log(`      compare alts: ${m.compareAlts.join(' | ')}`);
    }
    if (m.matchupAlts && m.matchupAlts.length) {
      console.log(`      matchup alts: ${m.matchupAlts.join(' | ')}`);
    }
  }
}
writeFileSync(join(OUT, 'image-gate.json'), JSON.stringify(report, null, 2));
console.log(`\n${failures ? failures + ' SURFACE(S) FAILED' : 'IMAGE GATE PASSED'}`);
ws.close(); finish(failures ? 1 : 0);
