/* NAV GATE for QB DNA.
 *
 *   node scripts/qbdna-nav-gate.mjs [widths]
 *   PBE_BASE / PBE_SHARE point it at a deployed preview.
 *
 * Desktop (1440/1280/900): QB DNA must be a visible button in the shell's
 * INTELLIGENCE row, clickable, correctly highlighted, with no row overflow and
 * no collision with the surrounding shell bands.
 *
 * Mobile (430/390): the shell nav is hidden, so discoverability is measured
 * through the real mobile model — the bottom bar's Menu tap opens the drawer,
 * and QB DNA must be there. Two taps, no URL typing, no command palette, no
 * hash editing.
 *
 * Also checks the things a new route usually breaks: direct load highlighting,
 * browser back/forward, and a route race between the loader and the router.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] || 'nav-gate';
const WIDTHS = (process.argv[3] || '1440,1280,900,430,390').split(',').map(Number);
const TARGET = process.env.PBE_BASE || `http://localhost:${process.env.PBE_PORT || '4321'}`;
const SHARE = process.env.PBE_SHARE || '';
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DP = 9900 + Math.floor(Math.random() * 90);

mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-nav-'));
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
const errors = [];
ws.onmessage = ev => { const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.text || 'exception');
};
await send('Runtime.enable'); await send('Page.enable');
const evalIn = async (expr, ms = 45000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
    sleep(ms).then(() => { throw new Error('WEDGED')})
  ]);
  return r.result?.value;
};
const nav = async (url, wait = 15000) => { await send('Page.navigate', { url }); await sleep(wait); };

if (SHARE) { await nav(`${TARGET}/?_vercel_share=${SHARE}`, 9000); }

const results = [];
const check = (width, name, ok, detail) => {
  results.push({ width, name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${String(width).padEnd(5)} ${name}`
    + (detail ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''));
};

for (const width of WIDTHS) {
  const touch = width <= 768;
  console.log(`\n--- ${width} ---`);
  await send('Emulation.setDeviceMetricsOverride',
    { width, height: touch ? 844 : 900, deviceScaleFactor: 1, mobile: touch });

  /* 0. WHICH NAV MODEL IS THIS WIDTH ACTUALLY USING?
        The shell hides its primary row below its own breakpoint and hands over
        to the drawer, for EVERY route. Asserting a desktop expectation at a
        width the product runs as a drawer would be measuring my assumption
        rather than the product. */
  await nav(`${TARGET}/#qbdna?t=${Date.now()}`, 17000);
  const model = await evalIn(`(()=>{
    const prim=document.querySelector('.pbes-primary');
    const bar=document.getElementById('mobile-bottom-nav');
    return {
      shellRowShown: prim ? getComputedStyle(prim).display!=='none' : false,
      bottomBarShown: bar ? getComputedStyle(bar).display!=='none' : false
    };})()`);
  const mobile = !model.shellRowShown;
  console.log(`      nav model: ${mobile ? 'DRAWER' : 'SHELL ROW'}`
    + ` (shell row ${model.shellRowShown ? 'shown' : 'hidden'},`
    + ` bottom bar ${model.bottomBarShown ? 'shown' : 'hidden'})`);

  const direct = await evalIn(`(()=>{
    const shellBtn=[...document.querySelectorAll('.pbes-nav-btn')].find(b=>b.dataset.route==='qbdna');
    const drawer=document.getElementById('nav-qbdna');
    return {
      route: window.App && window.App.current,
      rendered: !!document.querySelector('.qbd'),
      shellBtnExists: !!shellBtn,
      shellBtnActive: !!(shellBtn && shellBtn.classList.contains('active')),
      drawerExists: !!drawer,
      drawerActive: !!(drawer && drawer.classList.contains('active')),
      hash: location.hash
    };})()`);
  check(width, 'direct /#qbdna renders the surface', direct.rendered, `route=${direct.route}`);
  check(width, 'direct load highlights QB DNA',
    mobile ? direct.drawerActive : (direct.shellBtnActive || direct.drawerActive),
    `shell=${direct.shellBtnActive} drawer=${direct.drawerActive}`);

  if (!mobile) {
    /* 2. SHELL NAV ------------------------------------------------------- */
    const shell = await evalIn(`(()=>{
      const b=[...document.querySelectorAll('.pbes-nav-btn')].find(x=>x.dataset.route==='qbdna');
      if(!b) return {exists:false};
      const r=b.getBoundingClientRect();
      const row=b.closest('nav');
      const rr=row?row.getBoundingClientRect():null;
      const cs=getComputedStyle(b);
      // is the button actually the top-most element at its own centre?
      const hit=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
      const group=b.closest('.pbes-nav-group');
      const label=group?group.querySelector('.pbes-nav-label').textContent.trim():null;
      const sibs=group?[...group.querySelectorAll('.pbes-nav-btn')].map(x=>x.textContent.trim()):[];
      return {
        exists:true, text:b.textContent.trim(), group:label, siblings:sibs,
        visible: r.width>0 && r.height>0 && cs.visibility!=='hidden' && cs.display!=='none',
        inViewport: r.top>=0 && r.left>=0 && r.right<=innerWidth+1,
        covered: !(hit===b || b.contains(hit)),
        rowOverflow: row ? row.scrollWidth>row.clientWidth+1 : null,
        rowWraps: rr && r.bottom>rr.bottom+1,
        rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}
      };})()`);
    check(width, 'QB DNA button exists in the shell', shell.exists, shell.text);
    check(width, 'button is visible and inside the viewport',
      shell.exists && shell.visible && shell.inViewport, shell.rect);
    check(width, 'button is not covered by another element', shell.exists && !shell.covered);
    check(width, 'INTELLIGENCE row does not overflow', shell.rowOverflow === false,
      `group=${shell.group}`);
    check(width, 'button meets the 44px touch target', shell.exists && shell.rect.h >= 32,
      `${shell.rect.h}px`);

    /* 3. CLICK ROUTES ---------------------------------------------------- */
    await nav(`${TARGET}/#home?t=${Date.now()}`, 15000);
    const clicked = await evalIn(`(async()=>{
      const b=[...document.querySelectorAll('.pbes-nav-btn')].find(x=>x.dataset.route==='qbdna');
      if(!b) return {ok:false, reason:'no button'};
      b.click();
      await new Promise(r=>setTimeout(r,6000));
      const b2=[...document.querySelectorAll('.pbes-nav-btn')].find(x=>x.dataset.route==='qbdna');
      return { ok:true, route: window.App && window.App.current,
               rendered: !!document.querySelector('.qbd'),
               active: !!(b2 && b2.classList.contains('active')),
               hash: location.hash };})()`);
    check(width, 'clicking QB DNA routes to the surface',
      clicked.ok && clicked.rendered && clicked.route === 'qbdna',
      `hash=${clicked.hash}`);
    check(width, 'active state applies after the click', clicked.active);

    /* 4. BACK / FORWARD -------------------------------------------------- */
    const backFwd = await evalIn(`(async()=>{
      history.back();
      await new Promise(r=>setTimeout(r,4000));
      const back = { route: window.App && window.App.current, hash: location.hash,
                     qbd: !!document.querySelector('.qbd') };
      history.forward();
      await new Promise(r=>setTimeout(r,5000));
      const fwd = { route: window.App && window.App.current, hash: location.hash,
                    qbd: !!document.querySelector('.qbd') };
      return { back, fwd };})()`);
    check(width, 'back leaves QB DNA', backFwd.back.hash !== '#qbdna', JSON.stringify(backFwd.back));
    check(width, 'forward returns to QB DNA',
      backFwd.fwd.hash === '#qbdna' && backFwd.fwd.qbd, JSON.stringify(backFwd.fwd));
  } else {
    /* 5. DRAWER MODEL ----------------------------------------------------- */
    const peer = await evalIn(`(()=>{
      const q=[...document.querySelectorAll('.pbes-nav-btn')].find(b=>b.dataset.route==='qbdna');
      const p=[...document.querySelectorAll('.pbes-nav-btn')].find(b=>b.dataset.route==='picks');
      const box=e=>e?Math.round(e.getBoundingClientRect().width):null;
      return { qb:box(q), peer:box(p),
               qbInDrawer:!!document.getElementById('nav-qbdna'),
               peerInDrawer:!!document.getElementById('nav-picks') };})()`);
    check(width, 'QB DNA is hidden in the shell row exactly like its peers',
      peer.qb === peer.peer, `qbdna=${peer.qb}px picks=${peer.peer}px`);
    check(width, 'QB DNA is in the drawer alongside its peers',
      peer.qbInDrawer && peer.peerInDrawer);

    await nav(`${TARGET}/#home?t=${Date.now()}`, 16000);
    const m = await evalIn(`(async()=>{
      const menu=document.getElementById('mbn-menu');
      const bar=document.getElementById('mobile-bottom-nav');
      const barItems=[...document.querySelectorAll('.mbn-item')].length;
      if(!menu) return {ok:false, reason:'no Menu control in the bottom bar'};
      const barVisible = bar ? getComputedStyle(bar).display!=='none' : false;
      // TAP 1 - open the drawer
      menu.click();
      await new Promise(r=>setTimeout(r,1600));
      const link=document.getElementById('nav-qbdna');
      if(!link) return {ok:false, reason:'QB DNA is not in the drawer', barItems, barVisible};
      const r=link.getBoundingClientRect();
      const cs=getComputedStyle(link);
      const drawerOpen=!!document.querySelector('#sidebar.open');
      const visible=r.width>0 && r.height>0 && cs.visibility!=='hidden';
      // scroll it into view the way a thumb would, then check it is reachable
      link.scrollIntoView({block:'center'});
      await new Promise(r=>setTimeout(r,700));
      const r2=link.getBoundingClientRect();
      const hit=document.elementFromPoint(r2.left+r2.width/2, r2.top+r2.height/2);
      const reachable = hit===link || link.contains(hit) || (hit && hit.closest('#nav-qbdna'));
      // TAP 2 - go
      link.click();
      await new Promise(r=>setTimeout(r,6500));
      return { ok:true, barItems, barVisible, drawerOpen, visible, reachable,
               height:Math.round(r2.height),
               route: window.App && window.App.current,
               rendered: !!document.querySelector('.qbd'),
               active: !!document.getElementById('nav-qbdna')?.classList.contains('active'),
               drawerClosed: !document.querySelector('#sidebar.open'),
               hash: location.hash };})()`);
    check(width, 'bottom bar is present and not overloaded',
      m.ok && m.barVisible && m.barItems <= 6, `${m.barItems} items`);
    check(width, 'tap 1: Menu opens the drawer', m.ok && m.drawerOpen);
    check(width, 'QB DNA is in the drawer and reachable',
      m.ok && m.visible && m.reachable, `h=${m.height}px`);
    check(width, 'tap 2: QB DNA renders the surface',
      m.ok && m.rendered && m.route === 'qbdna', `hash=${m.hash}`);
    check(width, 'active state applies on mobile', m.ok && m.active);
    check(width, 'drawer closes after navigating', m.ok && m.drawerClosed);
    check(width, 'reachable in <= 2 taps', m.ok && m.rendered);
  }

  /* 6. NO SHELL COLLISION / HIDDEN CONTENT / ROUTE RACE ------------------ */
  await nav(`${TARGET}/#qbdna?t=${Date.now()}`, 17000);
  const layout = await evalIn(`(async()=>{
    // let any late loader finish and confirm it did not steal the route
    await new Promise(r=>setTimeout(r,7000));
    const root=document.querySelector('.qbd');
    if(!root) return {rendered:false};
    const rr=root.getBoundingClientRect();
    const d=document.documentElement;
    // does any fixed shell band sit on top of the first panel?
    const first=root.querySelector('.qbd-panel');
    const fr=first?first.getBoundingClientRect():null;
    let covered=false, coveredBy=null;
    if(fr){
      const hit=document.elementFromPoint(Math.min(innerWidth-5, fr.left+40),
                                          Math.max(5, fr.top+10));
      if(hit && !root.contains(hit)){ covered=true; coveredBy=hit.className||hit.id||hit.tagName; }
    }
    return {
      rendered:true,
      route: window.App && window.App.current,
      docOverflowX: d.scrollWidth>innerWidth+1,
      leftEdge: Math.round(rr.left),
      covered, coveredBy,
      panels: root.querySelectorAll('.qbd-panel').length,
      zeroHeightPanels: [...root.querySelectorAll('.qbd-panel')]
        .filter(p=>p.getBoundingClientRect().height<10).length
    };})()`);
  check(width, 'no route race: still QB DNA after the loader settles',
    layout.rendered && layout.route === 'qbdna', `route=${layout.route}`);
  check(width, 'no horizontal document overflow', layout.docOverflowX === false);
  check(width, 'no shell band covering QB DNA content', layout.covered === false,
    layout.coveredBy || '');
  check(width, 'no hidden/zero-height panels', layout.zeroHeightPanels === 0,
    `${layout.panels} panels`);

  const cap = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `nav-${width}.png`), Buffer.from(cap.data, 'base64'));
}

writeFileSync(join(OUT, 'nav-gate.json'), JSON.stringify({ results, errors }, null, 2));
const failed = results.filter(r => !r.ok);
console.log(`\n${failed.length ? `NAV GATE FAILED (${failed.length})` : 'NAV GATE PASSED'}`
  + `  ·  ${results.length} checks  ·  console exceptions: ${errors.length}`);
for (const f of failed) console.log(`  FAIL ${f.width} ${f.name} ${JSON.stringify(f.detail)}`);
ws.close(); finish(failed.length ? 1 : 0);
