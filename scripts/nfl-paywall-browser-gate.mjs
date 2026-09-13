/* NFL paywall + Best Line browser gate (real Chrome, raw CDP).
 *
 *   node scripts/nfl-access-local-server.mjs --port 8791 --odds fixture   (terminal 1)
 *   node scripts/nfl-paywall-browser-gate.mjs http://localhost:8791       (terminal 2)
 *
 * Every scenario runs in its own browser context (own cookie jar), at desktop
 * 1440x900 and phone 390x844 where layout matters. Identities come from the
 * harness ledger through the REAL passwordless landing (/api/auth-verify).
 *
 * Scenarios: anonymous wall; client-side bypass attempt; signed-in with no
 * subscription; orphan / null-expiry / expired / canceled / MLB / UFC / NBA /
 * NHL rows; entitlement outage; valid monthly subscriber (workspace + route
 * soak); season pass; mid-session cancellation; Best Line player props across
 * kickoff; direct API negative-access canaries.
 *
 * Env: PBE_CHROME (chrome binary), PBE_QA_OUT (screenshots + log directory),
 *      PBE_QA_SCENARIOS (comma list; default all): wall,bypass,signedin,denied,
 *      outage,subscriber,pass,cancel,bestline,canaries. Run `subscriber` against
 *      a `--odds live` harness: in fixture mode the product's real current event
 *      is not in the synthetic odds store, so board-driven routes answer 404.
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

const SCENARIOS = new Set(String(process.env.PBE_QA_SCENARIOS || 'wall,bypass,signedin,denied,outage,subscriber,pass,cancel,bestline,canaries').split(',').map(x => x.trim()));
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
    },
  };
  try { return await fn(page); }
  finally { sessions.delete(sessionId); await cdp('Target.disposeBrowserContext', { browserContextId }).catch(() => {}); }
}

const accessState = page => page.eval(`document.documentElement.dataset.pbeAccess`);
const workspaceLoaded = page => page.eval(`document.querySelectorAll('script[data-pbe-workspace]').length`);
const wall = page => page.eval(`(()=>{const b=document.getElementById('pbe-pro-backdrop');const c=b?.querySelector('.pbe-pro-close');const shell=document.querySelector('.shell');return{open:!!b?.classList.contains('open'),isWall:!!b?.classList.contains('is-wall'),closeVisible:!!c&&getComputedStyle(c).display!=='none',shellHidden:!shell||getComputedStyle(shell).display==='none',funnel:document.querySelector('#pbe-pro-checkout .pbe-funnel-root')?.dataset.funnelState||null,plans:document.querySelectorAll('#pbe-pro-checkout [data-funnel-plan]').length,note:document.querySelector('.pbe-access-note')?.textContent||'',account:document.querySelector('#pbe-pro-checkout .pbe-funnel-user strong')?.textContent||'',signOut:!!document.querySelector('[data-pbe-access-signout]'),app:typeof window.App,overflow:document.documentElement.scrollWidth-innerWidth}})()`);
const apiStatus = (page, path) => page.eval(`fetch(${JSON.stringify(path)},{credentials:'same-origin',cache:'no-store'}).then(r=>r.status)`);
const leakedGateway = page => page.requests.filter(u => u.startsWith('https://nfl-api.propbetedge.ai'));

const GATED_PROBES = ['/api/gw/api/best-line', '/api/gw/api/odds/board?event_id=x&markets=player_pass_yds', '/api/gw/api/odds/prop-coverage', '/api/pro-model?event_id=x',
  '/api/home-market?away=a&home=b', '/api/game-intel?event_id=x', '/api/qb-dna?list=1', '/api/wr-dna?list=1', '/api/rb-dna?list=1', '/api/te-dna?list=1',
  '/api/qb-dna/prop-lab?player_id=x', '/api/pbe-picks?view=current', '/api/pbe-picks?view=trackrecord', '/api/pbe-prop-picks?view=trackrecord', '/api/pbe-validation', '/api/weather-watch'];

/* ============================================================= scenarios */
log(`TARGET ${BASE}`);

if (want('wall')) for (const view of [DESKTOP, PHONE]) {
  await withPage(view, async page => {
    await page.goto(`${BASE}/`, 2500);
    await page.waitFor(`document.documentElement.dataset.pbeAccess!=='checking'`);
    const w = await wall(page);
    check(`[${view.label}] anonymous -> subscription wall`, (await accessState(page)) === 'anonymous' && w.open && w.isWall && !w.closeVisible && w.funnel === 'signed-out' && w.plans === 2, w);
    check(`[${view.label}] anonymous -> no paid workspace rendered or requested`, w.shellHidden && w.app === 'undefined' && (await workspaceLoaded(page)) === 0 && leakedGateway(page).length === 0, { app: w.app, gatewayRequests: leakedGateway(page).length });
    check(`[${view.label}] anonymous wall fits the viewport`, w.overflow <= 0, { overflow: w.overflow });
    await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));document.getElementById('pbe-pro-backdrop')?.click();window.PBEPro?.close?.();true`);
    check(`[${view.label}] the wall cannot be dismissed`, (await wall(page)).open === true);
    log(`  screenshot ${await page.shot('paywall-anonymous')}`);
  });
}

if (want('bypass')) await withPage(DESKTOP, async page => {
  await page.goto(`${BASE}/`, 2500);
  await page.waitFor(`document.documentElement.dataset.pbeAccess==='anonymous'`);
  /* Force every client-side signal a tamperer could set. */
  await page.eval(`(()=>{try{localStorage.setItem('pbe_pro','1')}catch(_){};document.cookie='subscribed=true; path=/';const s=window.PBEPro.state;s.access='granted';s.pro=true;s.user={email:'hacker@qa.test'};window.dispatchEvent(new CustomEvent('pbe:pro-state'));return true})()`);
  await sleep(3500);
  const statuses = {};
  for (const probe of GATED_PROBES) statuses[probe] = await apiStatus(page, probe);
  check('client-side bypass: forcing granted in the page still gets 401 from every paid route', Object.values(statuses).every(s => s === 401), statuses);
  const bestLine = await page.eval(`(async()=>{window.App?.nav?.('bestline');await new Promise(r=>setTimeout(r,2500));return (document.querySelector('.pbebl')?.textContent||'').slice(0,160)})()`, 8000);
  check('client-side bypass: the forced workspace shows no market data', !/DraftKings|FanDuel|BetMGM/.test(String(bestLine)), bestLine);
});

if (want('signedin')) for (const view of [DESKTOP, PHONE]) {
  await withPage(view, async page => {
    await page.signIn('free@qa.test');
    await page.waitFor(`document.documentElement.dataset.pbeAccess!=='checking'`);
    const w = await wall(page);
    check(`[${view.label}] signed in, no subscription -> wall with account email and plans`, (await accessState(page)) === 'no_entitlement' && w.funnel === 'signed-in-free' && w.plans === 2 && w.account === 'free@qa.test' && w.signOut && /No current NFL Pro subscription/.test(w.note), w);
    check(`[${view.label}] signed in, no subscription -> no workspace`, (await workspaceLoaded(page)) === 0 && w.shellHidden && w.app === 'undefined');
    const s = await page.eval(`fetch('/api/auth-session',{cache:'no-store'}).then(r=>r.json()).then(j=>({valid:j.valid,pro:j.pro,access:j.access}))`);
    check(`[${view.label}] sign-in alone: identity valid, pro false, access no_entitlement`, s.valid === true && s.pro === false && s.access === 'no_entitlement', s);
    check(`[${view.label}] signed-in wall fits the viewport`, w.overflow <= 0, { overflow: w.overflow });
    log(`  screenshot ${await page.shot('paywall-signed-in-no-subscription')}`);
    const direct = {};
    for (const probe of GATED_PROBES) direct[probe] = await apiStatus(page, probe);
    check(`[${view.label}] direct API calls with a session but no entitlement -> 403`, Object.values(direct).every(s => s === 403), direct);
  });
}

const DENIED = [['orphan@qa.test', /No current NFL Pro subscription/], ['nullexp@qa.test', /No current NFL Pro subscription/], ['expired@qa.test', /expired/], ['canceled@qa.test', /canceled/],
  ['mlb@qa.test', /No current NFL Pro subscription/], ['ufc@qa.test', /No current NFL Pro subscription/], ['nba@qa.test', /No current NFL Pro subscription/], ['nhl@qa.test', /No current NFL Pro subscription/]];
if (want('denied')) for (const [email, note] of DENIED) {
  await withPage(DESKTOP, async page => {
    await page.signIn(email);
    await page.waitFor(`document.documentElement.dataset.pbeAccess!=='checking'`);
    const w = await wall(page);
    const gw = await apiStatus(page, '/api/gw/api/best-line');
    check(`${email} -> denied, wall shown, no workspace`, (await accessState(page)) === 'no_entitlement' && w.funnel === 'signed-in-free' && note.test(w.note) && (await workspaceLoaded(page)) === 0 && gw === 403, { note: w.note, gw });
    if (email === 'expired@qa.test') log(`  screenshot ${await page.shot('paywall-expired')}`);
  });
}

if (want('outage')) for (const view of [DESKTOP, PHONE]) {
  await withPage(view, async page => {
    await page.goto(`${BASE}/__qa/supabase?mode=down`, 300);
    try {
      await page.signIn('pro@qa.test');
      await page.waitFor(`document.documentElement.dataset.pbeAccess!=='checking'`);
      const w = await wall(page);
      const text = await page.eval(`document.querySelector('#pbe-pro-checkout')?.textContent||''`);
      check(`[${view.label}] entitlement outage -> "Unable to verify access", fail closed`, (await accessState(page)) === 'unavailable' && /Unable to verify access/.test(text) && w.plans === 0 && (await workspaceLoaded(page)) === 0, { funnel: w.funnel, plans: w.plans });
      check(`[${view.label}] entitlement outage -> paid API answers 503`, (await apiStatus(page, '/api/gw/api/best-line')) === 503);
      log(`  screenshot ${await page.shot('paywall-unavailable')}`);
    } finally { await page.goto(`${BASE}/__qa/supabase?mode=ok`, 300); }
  });
}

const PRIMARY = ['home', 'games', 'changes', 'propboard', 'bestline', 'pbecast', 'marketwatch', 'picks', 'pbepicks', 'trackrecord', 'matchups', 'usage', 'injuries', 'newsintel', 'qbdna', 'wrdna', 'rbdna', 'tedna'];
const RESEARCH = ['simulator', 'sgplab', 'propchain', 'teams', 'standings', 'stats', 'seasonhistory', 'standings2025', 'stats2025', 'records', 'hof', 'sb', 'prospects', 'trades'];

if (want('subscriber')) await withPage(DESKTOP, async page => {
  await page.signIn('pro@qa.test');
  const opened = await page.waitFor(`document.documentElement.dataset.pbeAccess==='granted' && window.App && window.PBEUpgrades && window.PBEUpgrades.loading===false`, 60000);
  const w = await wall(page);
  check('valid NFL subscriber -> product opens, no wall', opened && !w.open && !w.shellHidden && w.app === 'object', w);
  check('valid NFL subscriber -> paid API 200 through the same-origin route', (await apiStatus(page, '/api/gw/api/best-line')) === 200);
  check('valid NFL subscriber -> the browser never calls the gateway directly', leakedGateway(page).length === 0, leakedGateway(page).slice(0, 3));
  await sleep(2500);
  log(`  screenshot ${await page.shot('subscriber-home')}`);
  const soak = [];
  for (const route of [...PRIMARY, ...RESEARCH, 'home']) {
    await page.eval(`window.App.nav(${JSON.stringify(route)})`); await sleep(1400);
    /* a workspace that is still reading its data gets up to 8s more */
    await page.waitFor(`(document.querySelector('#view-container')?.textContent||'').trim().length>80`, 8000);
    const r = await page.eval(`({alive:1+1===2,route:window.App?.current,chars:(document.querySelector('#view-container')?.textContent||'').trim().length,text:(document.querySelector('#view-container')?.textContent||'').trim().replace(/\s+/g,' ').slice(0,140),access:document.documentElement.dataset.pbeAccess,wall:!!document.querySelector('#pbe-pro-backdrop.open')})`);
    soak.push({ route, ...r });
    if (!(r.alive && r.route === route && r.chars > 80 && r.access === 'granted' && !r.wall)) { check(`route soak: ${route}`, false, { ...r, http_errors: page.failures.slice(-6) }); }
  }
  const bad = soak.filter(r => !(r.alive && r.route === r.route && r.chars > 80 && r.access === 'granted' && !r.wall));
  check(`route navigation smoke: ${soak.length} routes open for a subscriber`, bad.length === 0, { failed: bad.map(r => r.route) });
  check('route navigation smoke: no uncaught page exceptions', page.exceptions.length === 0, page.exceptions.slice(0, 5));
  check('route navigation smoke: still no direct gateway calls', leakedGateway(page).length === 0, leakedGateway(page).slice(0, 3));
});

if (want('pass')) await withPage(PHONE, async page => {
  await page.signIn('pass@qa.test');
  const opened = await page.waitFor(`document.documentElement.dataset.pbeAccess==='granted' && window.App`, 60000);
  const s = await page.eval(`fetch('/api/auth-session',{cache:'no-store'}).then(r=>r.json()).then(j=>j.entitlement)`);
  check('[mobile] valid season pass (one-time) -> product opens', opened && s?.plan === 'season_pass', s);
  await sleep(2500);
  log(`  screenshot ${await page.shot('subscriber-home')}`);
});

if (want('cancel')) await withPage(DESKTOP, async page => {
  await page.signIn('weekly@qa.test');
  await page.waitFor(`document.documentElement.dataset.pbeAccess==='granted' && window.App`, 60000);
  await page.eval(`fetch('/__qa/ledger?email=weekly@qa.test&state=canceled').then(()=>window.PBEPro.refreshAccess()).then(()=>true)`);
  const back = await page.waitFor(`document.documentElement.dataset.pbeAccess==='no_entitlement' && !window.App`, 20000);
  const w = await wall(page);
  check('subscription canceled mid-session -> workspace torn down, back to the wall', back && w.open && /canceled/.test(w.note), { note: w.note, app: w.app });
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

/* ------------------------------------------------ negative canaries (server) */
if (want('canaries')) {
  const statuses = {};
  for (const probe of GATED_PROBES) statuses[probe] = (await fetch(`${BASE}${probe}`, { headers: { cookie: 'subscribed=true; pbe_pro=1' } })).status;
  check('direct API negative canaries (no browser, client flags only) -> 401 on every paid route', Object.values(statuses).every(s => s === 401), statuses);
  const publicOk = (await fetch(`${BASE}/api/auth-session`)).status === 200;
  check('public routes stay public: /api/auth-session', publicOk);
}

const failed = results.filter(r => !r.ok);
log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map(f => f.name).join(' | ')}` : ''}`);
ws.close();
finish(failed.length ? 1 : 0);
