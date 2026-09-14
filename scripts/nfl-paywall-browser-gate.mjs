/* NFL access unlock + owner access + Best Line browser gate (real Chrome, raw CDP).
 *
 *   node scripts/nfl-access-local-server.mjs --port 8791 --odds fixture   (terminal 1)
 *   node scripts/nfl-paywall-browser-gate.mjs http://localhost:8791       (terminal 2)
 *
 * Every scenario runs in its own browser context (own cookie jar), at desktop
 * 1440x900 and phone 390x844 where layout matters. Identities come from the
 * harness ledger through the REAL passwordless landing (/api/auth-verify) and
 * the REAL auth Worker exchange (single-use links).
 *
 * The site is public; premium features and their data are NFL Pro
 * (api/_nfl-route-policy.js). Scenarios: anonymous visitor (site opens, premium
 * refused, inline Unlock Pro); client-side bypass attempt; signed in with no
 * subscription; orphan / null-expiry / expired / canceled / other-sport rows;
 * entitlement outage; verified owner (and reused / expired links, sign-out);
 * valid monthly subscriber (route soak); season pass; mid-session cancellation;
 * Best Line player props across kickoff; direct API canaries.
 *
 * Env: PBE_CHROME (chrome binary), PBE_QA_OUT (screenshots + log directory),
 *      PBE_QA_SCENARIOS (comma list; default all): anonymous,bypass,signedin,
 *      denied,outage,owner,subscriber,pass,cancel,bestline,canaries. Run
 *      `subscriber` against a `--odds live` harness: in fixture mode the
 *      product's real current event is not in the synthetic odds store, so
 *      board-driven routes answer 404.
 */
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = (process.argv[2] || 'http://localhost:8791').replace(/\/$/, '');
const CHROME = process.env.PBE_CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
const OUT = process.env.PBE_QA_OUT || join(process.cwd(), 'qa-paywall');
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, 'paywall-gate.log');
writeFileSync(LOG, '');
const log = s => { console.log(s); appendFileSync(LOG, `${s}\n`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = 9800 + Math.floor(Math.random() * 90);
const profile = mkdtempSync(join(process.env.PBE_QA_PROFILE_ROOT || tmpdir(), 'pbe-paywall-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

const SCENARIOS = new Set(String(process.env.PBE_QA_SCENARIOS || 'anonymous,bypass,signedin,denied,outage,owner,subscriber,pass,cancel,bestline,canaries').split(',').map(x => x.trim()));
const want = name => SCENARIOS.has(name);
const results = [];
function check(name, ok, detail = '') { results.push({ name, ok: Boolean(ok), detail }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }

function finish(code) {
  try { if (process.platform === 'win32') execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); else chrome.kill('SIGKILL'); } catch (_) {}
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch (_) {} process.exit(code); }, 600);
}
const deadline = setTimeout(() => { log('HARD DEADLINE'); finish(3); }, 15 * 60000); deadline.unref?.();

/* ------------------------------------------------------------------ CDP */
async function browserWs() {
  for (let i = 0; i < 100; i++) { try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch (_) { await sleep(150); } }
  throw new Error('devtools_unavailable');
}
const ws = new WebSocket(await browserWs());
await new Promise(r => { ws.onopen = r; });
let seq = 1; const pending = new Map(); const sessions = new Map();
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.sessionId && sessions.has(m.sessionId)) sessions.get(m.sessionId)(m);
};
const cdp = (method, params = {}, sessionId) => { const id = seq++; ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })); };

const DESKTOP = { label: 'desktop', width: 1440, height: 900, mobile: false };
const PHONE = { label: 'mobile', width: 390, height: 844, mobile: true };

async function withPage(view, fn) {
  const { browserContextId } = await cdp('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const exceptions = []; const requests = []; const failures = [];
  sessions.set(sessionId, m => {
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 200));
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
    if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) failures.push(`${m.params.response.status} ${m.params.response.url}`);
  });
  const s = (method, params) => cdp(method, params, sessionId);
  await s('Page.enable'); await s('Runtime.enable'); await s('Network.enable');
  await s('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: 1, mobile: view.mobile });
  if (view.mobile) await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const page = {
    view, exceptions, requests, failures,
    async eval(expression, timeout = 10000) {
      const r = await Promise.race([s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), sleep(timeout).then(() => ({ result: { value: '<timeout>' } }))]);
      if (r.exceptionDetails) return `<error ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}>`;
      return r.result?.value;
    },
    async goto(url, settle = 1500) { await s('Page.navigate', { url }); await sleep(settle); },
    async waitFor(expression, timeout = 15000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) { if (await page.eval(`Boolean(${expression})`) === true) return true; await sleep(200); }
      return false;
    },
    async shot(name) {
      await s('Page.bringToFront');
      const { data } = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = join(OUT, `${name}-${view.label}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    },
    async signIn(email) {
      await page.goto(`${BASE}/__qa/magic?email=${encodeURIComponent(email)}`, 400);
      const token = await page.eval(`JSON.parse(document.body.innerText).token`);
      await page.goto(`${BASE}/api/auth-verify?token=${encodeURIComponent(token)}`, 300);
      return token;
    },
  };
  try { return await fn(page); }
  finally { sessions.delete(sessionId); await cdp('Target.disposeBrowserContext', { browserContextId }).catch(() => {}); }
}

const accessState = page => page.eval(`document.documentElement.dataset.pbeAccess`);
const settled = page => page.waitFor(`document.documentElement.dataset.pbeAccess && document.documentElement.dataset.pbeAccess!=='checking'`);
const siteOpen = page => page.waitFor(`window.App && window.PBEUpgrades && window.PBEUpgrades.loading===false && (document.querySelector('#view-container')?.textContent||'').trim().length>80`, 60000);
const view = page => page.eval(`(()=>{const b=document.getElementById('pbe-pro-backdrop');const c=b?.querySelector('.pbe-pro-close');const shell=document.querySelector('.shell');return{app:typeof window.App,workspace:document.querySelectorAll('script[data-pbe-workspace]').length,shellVisible:!!shell&&getComputedStyle(shell).display!=='none',chars:(document.querySelector('#view-container')?.textContent||'').trim().length,modalOpen:!!b?.classList.contains('open'),isWall:!!b?.classList.contains('is-wall'),closeVisible:!!c&&getComputedStyle(c).display!=='none',funnel:document.querySelector('#pbe-pro-checkout .pbe-funnel-root')?.dataset.funnelState||null,plans:document.querySelectorAll('#pbe-pro-checkout [data-funnel-plan]').length,note:document.querySelector('.pbe-access-note')?.textContent||'',message:[...document.querySelectorAll('#pbe-pro-backdrop [id*="message"]')].map(e=>e.textContent).join(' ').trim(),account:document.querySelector('#pbe-pro-checkout .pbe-funnel-user strong')?.textContent||'',overflow:document.documentElement.scrollWidth-innerWidth}})()`);
/* {status, access}: x-pbe-access is set only by the entitlement gate */
const api = (page, path) => page.eval(`fetch(${JSON.stringify(path)},{credentials:'same-origin',cache:'no-store'}).then(r=>({status:r.status,access:r.headers.get('x-pbe-access')}))`);
const probeAll = async (page, list) => { const out = {}; for (const p of list) out[p] = await api(page, p); return out; };
const leakedGateway = page => page.requests.filter(u => u.startsWith('https://nfl-api.propbetedge.ai'));
const openUnlock = page => page.eval(`(()=>{const b=document.querySelector('[data-pbe-open-pro]');if(b){b.click();return 'cta'}window.PBEPro.open();return 'api'})()`);
const closeModal = page => page.eval(`(()=>{document.querySelector('#pbe-pro-backdrop .pbe-pro-close')?.click();return !document.getElementById('pbe-pro-backdrop')?.classList.contains('open')})()`);

/* Premium = proprietary PBE model output. Public = everything a visitor reads. */
const PREMIUM_PROBES = ['/api/gw/api/picks/pass', '/api/pro-model?event_id=x', '/api/pbe-picks?view=current', '/api/pbe-picks?view=validation-history', '/api/pbe-picks?view=decision', '/api/pbe-prop-picks?view=current'];
const PUBLIC_PROBES = ['/api/gw/api/best-line', '/api/gw/api/odds/prop-coverage', '/api/home-market?away=a&home=b', '/api/game-intel?event_id=x', '/api/qb-dna?list=1', '/api/wr-dna?list=1',
  '/api/qb-dna/prop-lab?player_id=x', '/api/pbe-picks?view=state', '/api/pbe-picks?view=trackrecord', '/api/pbe-prop-picks?view=trackrecord', '/api/pbe-validation', '/api/weather-watch', '/api/auth-session'];
const refusedAll = (probes, status, access) => Object.values(probes).every(r => r.status === status && r.access === access);
const neverRefused = probes => Object.values(probes).every(r => ![401, 403].includes(r.status) && !r.access);
const grantedAll = probes => Object.values(probes).every(r => r.access === 'granted' && ![401, 403].includes(r.status));

/* ============================================================= scenarios */
log(`TARGET ${BASE}`);

if (want('anonymous')) for (const vp of [DESKTOP, PHONE]) {
  await withPage(vp, async page => {
    await page.goto(`${BASE}/`, 2500);
    await settled(page);
    const opened = await siteOpen(page);
    let v = await view(page);
    check(`[${vp.label}] anonymous -> the site opens with no wall`, (await accessState(page)) === 'anonymous' && opened && v.app === 'object' && v.workspace > 0 && v.shellVisible && !v.modalOpen, v);
    check(`[${vp.label}] anonymous -> premium APIs 401, public APIs open`, refusedAll(await probeAll(page, PREMIUM_PROBES), 401, 'anonymous') && neverRefused(await probeAll(page, PUBLIC_PROBES)));
    check(`[${vp.label}] anonymous -> no direct gateway calls from the browser`, leakedGateway(page).length === 0, leakedGateway(page).slice(0, 3));
    check(`[${vp.label}] anonymous home fits the viewport`, v.overflow <= 0, { overflow: v.overflow });
    log(`  screenshot ${await page.shot('unlock-anonymous-home')}`);
    /* public research reads for a visitor */
    for (const route of ['bestline', 'games', 'qbdna', 'injuries']) {
      await page.eval(`window.App.nav(${JSON.stringify(route)})`); await sleep(1400);
      await page.waitFor(`(document.querySelector('#view-container')?.textContent||'').trim().length>80`, 8000);
      const r = await page.eval(`({route:window.App?.current,chars:(document.querySelector('#view-container')?.textContent||'').trim().length,modal:!!document.querySelector('#pbe-pro-backdrop.open')})`);
      check(`[${vp.label}] anonymous -> public route ${route} renders`, r.route === route && r.chars > 80 && !r.modal, r);
    }
    /* premium modules: a preview with an inline unlock (Prop Board renders on
       harness data; PBE Picks needs the picks tables, so it is only logged here
       and checked against production) */
    const unlocks = `[...document.querySelectorAll('#view-container button,#view-container a')].filter(b=>b.offsetParent&&/unlock/i.test(b.textContent))`;
    const locks = {};
    for (const route of ['pbepicks', 'modellab', 'marketwatch', 'propboard']) {
      await page.eval(`window.App.nav(${JSON.stringify(route)})`); await sleep(1500);
      await page.waitFor(`${unlocks}.length>0`, 6000);
      locks[route] = await page.eval(`${unlocks}.map(b=>b.textContent.trim()).slice(0,2)`);
    }
    log(`  inline unlock controls ${JSON.stringify(locks)}`);
    check(`[${vp.label}] anonymous -> Prop Board shows the market with an inline Unlock Pro`, locks.propboard.some(t => /Unlock/i.test(t)), locks.propboard);
    log(`  screenshot ${await page.shot('unlock-anonymous-propboard')}`);
    const how = await page.eval(`(()=>{const b=${unlocks}[0];b.scrollIntoView({block:'center'});b.click();return true})()`);
    await sleep(600);
    v = await view(page);
    check(`[${vp.label}] Unlock Pro -> plans for a visitor, dismissible (not a wall)`, how && v.modalOpen && !v.isWall && v.closeVisible && v.funnel === 'signed-out' && v.plans === 2, v);
    check(`[${vp.label}] Unlock Pro modal fits the viewport`, v.overflow <= 0, { overflow: v.overflow });
    log(`  screenshot ${await page.shot('unlock-anonymous-modal')}`);
    check(`[${vp.label}] Unlock Pro modal closes back to the site`, await closeModal(page) && (await view(page)).app === 'object');
    check(`[${vp.label}] anonymous -> no uncaught page exceptions`, page.exceptions.length === 0, page.exceptions.slice(0, 5));
  });
}

if (want('bypass')) await withPage(DESKTOP, async page => {
  await page.goto(`${BASE}/`, 2500);
  await page.waitFor(`document.documentElement.dataset.pbeAccess==='anonymous'`);
  /* Every client-side signal a tamperer could set, including an owner claim. */
  await page.eval(`(()=>{try{localStorage.setItem('pbe_pro','1');localStorage.setItem('pbe_role','owner')}catch(_){};document.cookie='subscribed=true; path=/';document.cookie='pbe_role=owner; path=/';document.cookie='pbe_nfl_session_v2=forged.forged.forged; path=/';const s=window.PBEPro.state;s.access='granted';s.pro=true;s.role='owner';s.user={email:'justin@proptechusa.ai'};window.dispatchEvent(new CustomEvent('pbe:pro-state'));return true})()`);
  await sleep(2500);
  const statuses = await probeAll(page, PREMIUM_PROBES);
  check('client-side bypass: forcing granted / owner in the page still gets 401 from every premium route', Object.values(statuses).every(r => r.status === 401 && r.access === 'anonymous'), statuses);
  const withEmail = await page.eval(`fetch('/api/pbe-picks?view=current&email=justin@proptechusa.ai&role=owner',{headers:{'x-pbe-role':'owner','x-user-email':'justin@proptechusa.ai'}}).then(r=>r.status)`);
  check('client-side bypass: typing the owner email into a request grants nothing', withEmail === 401, withEmail);
});

if (want('signedin')) for (const vp of [DESKTOP, PHONE]) {
  await withPage(vp, async page => {
    await page.signIn('free@qa.test');
    await settled(page);
    const opened = await siteOpen(page);
    const s = await page.eval(`fetch('/api/auth-session',{cache:'no-store'}).then(r=>r.json()).then(j=>({valid:j.valid,pro:j.pro,access:j.access,role:j.role||null}))`);
    check(`[${vp.label}] sign-in alone: identity valid, pro false, access no_entitlement`, s.valid === true && s.pro === false && s.access === 'no_entitlement' && s.role === null, s);
    const v0 = await view(page);
    check(`[${vp.label}] signed in, no subscription -> the site opens, no wall`, opened && v0.app === 'object' && !v0.modalOpen, v0);
    check(`[${vp.label}] signed in, no subscription -> premium APIs 403, public APIs open`, refusedAll(await probeAll(page, PREMIUM_PROBES), 403, 'no_entitlement') && neverRefused(await probeAll(page, PUBLIC_PROBES)));
    await openUnlock(page); await sleep(600);
    const v = await view(page);
    check(`[${vp.label}] signed in, no subscription -> Unlock Pro shows the account and plans`, v.modalOpen && !v.isWall && v.funnel === 'signed-in-free' && v.plans === 2 && v.account === 'free@qa.test' && /No current NFL Pro subscription/.test(v.note), v);
    check(`[${vp.label}] signed-in Unlock Pro fits the viewport`, v.overflow <= 0, { overflow: v.overflow });
    log(`  screenshot ${await page.shot('unlock-signed-in-no-subscription')}`);
  });
}

const DENIED = [['orphan@qa.test', /No current NFL Pro subscription/], ['nullexp@qa.test', /No current NFL Pro subscription/], ['expired@qa.test', /expired/], ['canceled@qa.test', /canceled/],
  ['mlb@qa.test', /No current NFL Pro subscription/], ['ufc@qa.test', /No current NFL Pro subscription/], ['nba@qa.test', /No current NFL Pro subscription/], ['nhl@qa.test', /No current NFL Pro subscription/]];
if (want('denied')) for (const [email, note] of DENIED) {
  await withPage(DESKTOP, async page => {
    await page.signIn(email);
    await settled(page);
    const premium = await probeAll(page, PREMIUM_PROBES);
    await page.waitFor(`window.PBEPro && window.App`, 30000);
    await openUnlock(page); await sleep(500);
    const v = await view(page);
    check(`${email} -> no Pro: premium 403, reason shown on Unlock Pro`, (await accessState(page)) === 'no_entitlement' && refusedAll(premium, 403, 'no_entitlement') && note.test(v.note), { note: v.note });
  });
}

if (want('outage')) for (const vp of [DESKTOP, PHONE]) {
  await withPage(vp, async page => {
    await page.goto(`${BASE}/__qa/supabase?mode=down`, 300);
    try {
      await page.signIn('pro@qa.test');
      await settled(page);
      const opened = await siteOpen(page);
      const premium = await probeAll(page, PREMIUM_PROBES);
      check(`[${vp.label}] entitlement outage -> access unavailable, premium 503 (fail closed), site still opens`, (await accessState(page)) === 'unavailable' && opened && Object.values(premium).every(r => r.status === 503 && r.access === 'unavailable'), premium);
      log(`  screenshot ${await page.shot('unlock-unavailable')}`);
    } finally { await page.goto(`${BASE}/__qa/supabase?mode=ok`, 300); }
  });
}

if (want('owner')) {
  for (const vp of [DESKTOP, PHONE]) {
    await withPage(vp, async page => {
      const token = await page.signIn('owner@qa.test');
      await page.waitFor(`document.documentElement.dataset.pbeAccess==='granted'`, 20000);
      const s = await page.eval(`fetch('/api/auth-session',{cache:'no-store'}).then(r=>r.json()).then(j=>({access:j.access,pro:j.pro,role:j.role||null,reason:j.entitlement?.reason,email:j.user?.email}))`);
      check(`[${vp.label}] owner via verified magic link -> granted as owner with no subscription row`, s.access === 'granted' && s.pro === true && s.role === 'owner' && s.reason === 'owner' && s.email === 'owner@qa.test', s);
      const premium = await probeAll(page, PREMIUM_PROBES);
      check(`[${vp.label}] owner -> every premium API passes the entitlement gate`, grantedAll(premium), premium);
      await siteOpen(page);
      await page.eval(`window.App.nav('pbepicks')`); await sleep(2500);
      const lock = await page.eval(`document.querySelectorAll('#view-container [data-pbe-open-pro]').length`);
      check(`[${vp.label}] owner -> PBE Picks shows no Unlock Pro prompt`, lock === 0, { unlockButtons: lock });
      log(`  screenshot ${await page.shot('owner-pbepicks')}`);
      if (vp === DESKTOP) {
        /* the same emailed link, clicked again in the same browser: refused */
        await page.goto(`${BASE}/api/auth-verify?token=${encodeURIComponent(token)}`, 1500);
        await sleep(1500);
        const reuse = await page.eval(`[...document.querySelectorAll('#pbe-pro-backdrop [id*="message"]')].map(e=>e.textContent).join(' ')`);
        log(`  reuse page ${JSON.stringify(await page.eval(`({url:location.href,access:document.documentElement.dataset.pbeAccess,open:!!document.querySelector('#pbe-pro-backdrop.open'),text:(document.querySelector('#pbe-pro-checkout')?.textContent||'').trim().slice(0,200)})`))}`);
        log(`  screenshot ${await page.shot('owner-link-reused')}`);
        check('owner link reused -> refused (link_already_used)', /already used/i.test(reuse) || /link_already_used/.test(reuse), reuse);
        /* sign-out removes owner access */
        await page.eval(`fetch('/api/auth-logout',{method:'POST',credentials:'same-origin'}).then(r=>r.status)`);
        const after = await probeAll(page, PREMIUM_PROBES);
        const sess = await page.eval(`fetch('/api/auth-session',{cache:'no-store'}).then(r=>r.json()).then(j=>({access:j.access,role:j.role||null}))`);
        check('owner signs out -> premium 401, session anonymous', refusedAll(after, 401, 'anonymous') && sess.access === 'anonymous' && sess.role === null, sess);
      }
    });
  }
  await withPage(DESKTOP, async page => {
    /* a link clicked after sign-out / in a new browser a second time: no session */
    const token = await page.signIn('owner@qa.test');
    await page.eval(`fetch('/api/auth-logout',{method:'POST',credentials:'same-origin'}).then(r=>r.status)`);
    await page.goto(`${BASE}/api/auth-verify?token=${encodeURIComponent(token)}`, 1500);
    await settled(page);
    check('owner link replayed after sign-out -> no session, premium 401', (await accessState(page)) === 'anonymous' && refusedAll(await probeAll(page, PREMIUM_PROBES), 401, 'anonymous'));
  });
  await withPage(DESKTOP, async page => {
    await page.goto(`${BASE}/__qa/magic?email=owner@qa.test&expired=1`, 400);
    const token = await page.eval(`JSON.parse(document.body.innerText).token`);
    await page.goto(`${BASE}/api/auth-verify?token=${encodeURIComponent(token)}`, 1500);
    await settled(page);
    const msg = await page.eval(`[...document.querySelectorAll('#pbe-pro-backdrop [id*="message"]')].map(e=>e.textContent).join(' ')`);
    check('expired owner link -> no session, premium 401, "expired" shown', (await accessState(page)) === 'anonymous' && refusedAll(await probeAll(page, PREMIUM_PROBES), 401, 'anonymous') && /expired/i.test(msg), msg);
  });
}

const PRIMARY = ['home', 'games', 'changes', 'propboard', 'bestline', 'pbecast', 'marketwatch', 'picks', 'pbepicks', 'trackrecord', 'matchups', 'usage', 'injuries', 'newsintel', 'qbdna', 'wrdna', 'rbdna', 'tedna'];
const RESEARCH = ['simulator', 'sgplab', 'propchain', 'teams', 'standings', 'stats', 'seasonhistory', 'standings2025', 'stats2025', 'records', 'hof', 'sb', 'prospects', 'trades'];

if (want('subscriber')) await withPage(DESKTOP, async page => {
  await page.signIn('pro@qa.test');
  const opened = await page.waitFor(`document.documentElement.dataset.pbeAccess==='granted' && window.App && window.PBEUpgrades && window.PBEUpgrades.loading===false`, 60000);
  const v = await view(page);
  check('valid NFL subscriber -> Pro granted, no modal', opened && !v.modalOpen && v.app === 'object', v);
  check('valid NFL subscriber -> premium APIs pass the gate through the same-origin route', grantedAll(await probeAll(page, PREMIUM_PROBES)));
  check('valid NFL subscriber -> the browser never calls the gateway directly', leakedGateway(page).length === 0, leakedGateway(page).slice(0, 3));
  await sleep(2500);
  log(`  screenshot ${await page.shot('subscriber-home')}`);
  const soak = [];
  for (const route of [...PRIMARY, ...RESEARCH, 'home']) {
    await page.eval(`window.App.nav(${JSON.stringify(route)})`); await sleep(1400);
    /* a workspace that is still reading its data gets up to 8s more */
    await page.waitFor(`(document.querySelector('#view-container')?.textContent||'').trim().length>80`, 8000);
    const r = await page.eval(`({route:window.App?.current,chars:(document.querySelector('#view-container')?.textContent||'').trim().length,access:document.documentElement.dataset.pbeAccess,modal:!!document.querySelector('#pbe-pro-backdrop.open')})`);
    soak.push({ route, ...r });
    if (!(r.route === route && r.chars > 80 && r.access === 'granted' && !r.modal)) check(`route soak: ${route}`, false, { ...r, http_errors: page.failures.slice(-6) });
  }
  const bad = soak.filter(r => !(r.chars > 80 && r.access === 'granted' && !r.modal));
  check(`route navigation smoke: ${soak.length} routes open for a subscriber`, bad.length === 0, { failed: bad.map(r => r.route) });
  check('route navigation smoke: no uncaught page exceptions', page.exceptions.length === 0, page.exceptions.slice(0, 5));
  check('route navigation smoke: still no direct gateway calls', leakedGateway(page).length === 0, leakedGateway(page).slice(0, 3));
});

if (want('pass')) await withPage(PHONE, async page => {
  await page.signIn('pass@qa.test');
  const opened = await page.waitFor(`document.documentElement.dataset.pbeAccess==='granted' && window.App`, 60000);
  const s = await page.eval(`fetch('/api/auth-session',{cache:'no-store'}).then(r=>r.json()).then(j=>j.entitlement)`);
  check('[mobile] valid season pass (one-time) -> Pro granted', opened && s?.plan === 'season_pass', s);
  await sleep(2500);
  log(`  screenshot ${await page.shot('season-pass-home')}`);
});

if (want('cancel')) await withPage(DESKTOP, async page => {
  await page.signIn('weekly@qa.test');
  await page.waitFor(`document.documentElement.dataset.pbeAccess==='granted' && window.App`, 60000);
  await page.eval(`fetch('/__qa/ledger?email=weekly@qa.test&state=canceled').then(()=>window.PBEPro.refreshAccess()).then(()=>true)`);
  const back = await page.waitFor(`document.documentElement.dataset.pbeAccess==='no_entitlement'`, 20000);
  const premium = await probeAll(page, PREMIUM_PROBES);
  const v = await view(page);
  check('subscription canceled mid-session -> Pro removed (premium 403), public site stays open', back && refusedAll(premium, 403, 'no_entitlement') && v.app === 'object' && !v.isWall, { app: v.app });
  await page.goto(`${BASE}/__qa/ledger?email=weekly@qa.test&state=weekly`, 300);
});

/* ---------------------------------------------------------------- Best Line */
const slate = want('bestline') ? await (await fetch(`${BASE}/__qa/slate`)).json().catch(() => null) : undefined;
if (slate === undefined) {
  /* not requested */
} else if (!slate) {
  check('Best Line player props (needs --odds fixture on the harness)', false, 'harness is not in fixture mode');
} else {
  for (const view of [DESKTOP, PHONE]) {
    await withPage(view, async page => {
      await page.signIn('pro@qa.test');
      await page.waitFor(`document.documentElement.dataset.pbeAccess==='granted' && window.App && window.PBEUpgrades && window.PBEUpgrades.loading===false`, 60000);
      await page.eval(`window.App.nav('bestline')`);
      await page.waitFor(`document.querySelector('.pbebl [data-bl-tab="props"]')`, 20000);
      await page.eval(`document.querySelector('.pbebl [data-bl-tab="props"]').click()`);
      await page.waitFor(`document.querySelector('.pbebl-props tbody tr') || document.querySelector('.pbebl .pbebl-unavailable')`, 20000);
      await sleep(1500);
      const state = () => page.eval(`(()=>{const sel=document.querySelector('[data-bl-event]');const opts=[...(sel?.options||[])].map(o=>({id:o.value,text:o.textContent,started:o.dataset.started==='1'}));const fresh=document.querySelector('.pbebl-fresh[data-bl-availability]');return{selected:sel?.value,options:opts,kickoff:document.querySelector('[data-bl-kickoff] b')?.textContent||'',headline:fresh?.querySelector('b')?.textContent||'',availability:fresh?.dataset.blAvailability||document.querySelector('.pbebl-unavailable[data-bl-availability]')?.dataset.blAvailability||'',captured:fresh?.dataset.blCaptured||'',rows:document.querySelectorAll('.pbebl-props tbody tr').length,rowCaptured:[...document.querySelectorAll('.pbebl-props tbody tr')].map(r=>r.dataset.capturedAt),capturedText:document.querySelector('.pbebl-captured')?.textContent||'',unavailable:document.querySelector('.pbebl-unavailable')?.textContent||'',live:/\\bLIVE\\b(?! and cannot)/.test(document.querySelector('.pbebl')?.textContent||'')&&!/not live/i.test(document.querySelector('.pbebl')?.textContent||''),overflow:document.documentElement.scrollWidth-innerWidth,selectWidth:Math.round(sel?.getBoundingClientRect().width||0)}})()`);
      const choose = async (event, market) => {
        /* a change repaints the selector, so each select is looked up fresh */
        if (event) { await page.eval(`(()=>{const e=document.querySelector('[data-bl-event]');if(e.value!==${JSON.stringify(event)}){e.value=${JSON.stringify(event)};e.dispatchEvent(new Event('change',{bubbles:true}))}return true})()`); await sleep(300); }
        if (market) { await page.eval(`(()=>{const m=document.querySelector('[data-bl-market]');if(m.value!==${JSON.stringify(market)}){m.value=${JSON.stringify(market)};m.dispatchEvent(new Event('change',{bubbles:true}))}return true})()`); await sleep(300); }
        await page.waitFor(`document.querySelector('[data-bl-event]')?.value===${JSON.stringify(event)} && document.querySelector('[data-bl-market]')?.value===${JSON.stringify(market)} && !/Reading the player board/.test(document.querySelector('.pbebl')?.textContent||'')`, 15000);
        await page.waitFor(`document.querySelector('.pbebl-props tbody tr') || document.querySelector('.pbebl .pbebl-unavailable')`, 15000);
        await sleep(900);
        return state();
      };

      let st = await state();
      check(`[${view.label}] Best Line props: started game stays selectable and is labelled`, st.options.some(o => o.id === slate.EARLY.id && o.started && /KICKED OFF/.test(o.text)), st.options);
      check(`[${view.label}] Best Line props: default is the nearest game with coverage (the kicked-off game), not the future game`, st.selected === slate.EARLY.id && st.selected !== slate.FUTURE.id, { selected: st.selected });
      check(`[${view.label}] Best Line props: kicked-off board says KICKED OFF — PRE-GAME MARKET SNAPSHOT`, st.kickoff === 'KICKED OFF — PRE-GAME MARKET SNAPSHOT' && st.headline === 'KICKED OFF — PRE-GAME MARKET SNAPSHOT' && st.availability === 'LAST_VERIFIED_PREGAME_SNAPSHOT', st);
      check(`[${view.label}] Best Line props: prices shown with their own capture time, never live`, st.rows > 0 && st.captured && Date.parse(st.captured) < Date.parse(slate.EARLY.commence_time) && st.rowCaptured.every(c => c === st.captured) && /^captured /.test(st.capturedText) && !st.live, { rows: st.rows, captured: st.captured, capturedText: st.capturedText });
      await page.eval(`document.querySelector('.pbebl-propbar')?.scrollIntoView({block:'start'});true`); await sleep(400);
      log(`  screenshot ${await page.shot('bestline-props-kicked-off')}`);

      for (const [market, label] of [['player_reception_yds', 'receiving yards'], ['player_pass_yds', 'passing yards'], ['player_rush_yds', 'rushing yards'], ['player_receptions', 'receptions'], ['player_anytime_td', 'anytime TD']]) {
        st = await choose(slate.EARLY.id, market);
        const yes = market === 'player_anytime_td' ? await page.eval(`!!document.querySelector('.pbebl-props th')&&/Best price · Yes/.test(document.querySelector('.pbebl-props thead').textContent)`) : true;
        check(`[${view.label}] Best Line props: kicked-off ${label} retained`, st.rows > 0 && st.availability === 'LAST_VERIFIED_PREGAME_SNAPSHOT' && st.kickoff && yes, { rows: st.rows, availability: st.availability });
      }

      st = await choose(slate.LATE.id, 'player_reception_yds');
      check(`[${view.label}] Best Line props: pre-game market pulled by a newer capture is retained with its older capture time`, st.rows > 0 && st.availability === 'LAST_VERIFIED_PREGAME_SNAPSHOT' && st.headline === 'LAST VERIFIED PRE-GAME SNAPSHOT' && !st.kickoff && Date.parse(st.captured) < Date.now() - 4 * 3600000, { availability: st.availability, captured: st.captured });
      st = await choose(slate.LATE.id, 'player_pass_yds');
      check(`[${view.label}] Best Line props: game before kickoff is a current MARKET SNAPSHOT`, st.rows > 0 && st.availability === 'IN_SNAPSHOT' && st.headline === 'MARKET SNAPSHOT' && !st.kickoff, { availability: st.availability });
      st = await choose(slate.FUTURE.id, 'player_reception_yds');
      check(`[${view.label}] Best Line props: future game with no props stays NOT_OFFERED_AT_INGEST, nothing fabricated`, st.rows === 0 && st.availability === 'NOT_OFFERED_AT_INGEST' && /have not posted/.test(st.unavailable), { availability: st.availability, text: st.unavailable.slice(0, 120) });
      await page.eval(`document.querySelector('.pbebl-propbar')?.scrollIntoView({block:'start'});true`); await sleep(400);
      log(`  screenshot ${await page.shot('bestline-props-future-not-offered')}`);
      st = await choose(slate.EARLY.id, 'player_reception_yds');
      if (view.mobile) {
        check('[mobile] Best Line selector: full-width, 44px targets, no horizontal overflow', st.overflow <= 0 && st.selectWidth >= view.width - 80 && await page.eval(`document.querySelector('[data-bl-event]').getBoundingClientRect().height>=44`), { overflow: st.overflow, selectWidth: st.selectWidth });
      } else {
        check('[desktop] Best Line selector: no horizontal overflow', st.overflow <= 0, { overflow: st.overflow });
      }
      check(`[${view.label}] Best Line props: no uncaught page exceptions`, page.exceptions.length === 0, page.exceptions.slice(0, 3));
    });
  }
}

/* ------------------------------------------------ direct API canaries (server) */
if (want('canaries')) {
  const premium = {};
  for (const probe of PREMIUM_PROBES) { const r = await fetch(`${BASE}${probe}`, { headers: { cookie: 'subscribed=true; pbe_pro=1; pbe_role=owner', 'x-pbe-role': 'owner' } }); premium[probe] = { status: r.status, access: r.headers.get('x-pbe-access') }; }
  check('direct API canaries (no browser, client flags only) -> 401 on every premium route', refusedAll(premium, 401, 'anonymous'), premium);
  const pub = {};
  for (const probe of PUBLIC_PROBES) { const r = await fetch(`${BASE}${probe}`); pub[probe] = { status: r.status, access: r.headers.get('x-pbe-access') }; }
  check('direct API canaries -> public routes are never refused for lack of a subscription', neverRefused(pub), pub);
}

const failed = results.filter(r => !r.ok);
log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map(f => f.name).join(' | ')}` : ''}`);
ws.close();
finish(failed.length ? 1 : 0);
