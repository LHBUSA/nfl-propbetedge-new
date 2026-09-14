/* NFL access v2 acceptance — one identity, the full route matrix, 1440 and 390.
 *
 *   node scripts/qa-access-v2/acceptance.mjs <identity> <origin> [entryUrl]
 *
 * Real headless Chrome over raw CDP. The same route checks as the 2026-09-14
 * recovery archaeology (boot, nav, data, first paint vs later, loader loops,
 * duplicate ownership, overflow, console errors, failed requests, 401/403/5xx)
 * plus the identity's access contract (session verdict, premium API gate, Pro
 * UI state, upgrade / owner / failure copy).
 *
 * Identities needing harness controls (auth-down, auth-hang, ledger-down,
 * authworker-down) change global harness state: run them on their own harness.
 * Link identities use /__qa/magic, so they need scripts/qa-access-v2/harness.mjs.
 * `anonymous` runs anywhere (production, a Vercel preview via its share link).
 *
 * Never sends email, never opens Stripe: those URLs are blocked in the browser.
 * Env: PBE_ACC_OUT (output root), PBE_CHROME.
 */
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const [identity = 'anonymous', originArg, entryArg] = process.argv.slice(2);
const ORIGIN = String(originArg || 'http://localhost:8801').replace(/\/$/, '');
const OUT = join(process.env.PBE_ACC_OUT || join(process.cwd(), 'qa-access-v2'), identity);
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------ identities */
const PREMIUM = { anonymous: 401, none: 403, allowed: 'allowed', unavailable: 503 };
const IDS = {
  anonymous: { expect: { access: 'anonymous', premium: PREMIUM.anonymous, modal: 'signed-out', unlock: true } },
  'new-unpaid': { email: 'newuser@qa.test', expect: { access: 'no_entitlement', reason: 'no_subscription', premium: PREMIUM.none, modal: 'signed-in-free', unlock: true, modalText: /Your account is ready/ } },
  'non-subscriber': { email: 'nonsub@qa.test', expect: { access: 'no_entitlement', premium: PREMIUM.none, modal: 'signed-in-free', unlock: true, modalText: /No active NFL Pro subscription/ } },
  weekly: { email: 'weekly@qa.test', expect: { access: 'granted', role: 'subscriber', plan: 'founding_weekly', premium: PREMIUM.allowed, modal: 'active-pro', unlock: false } },
  monthly: { email: 'monthly@qa.test', expect: { access: 'granted', role: 'subscriber', plan: 'founding_monthly', premium: PREMIUM.allowed, modal: 'active-pro', unlock: false } },
  owner: { email: 'owner@qa.test', expect: { access: 'granted', role: 'owner', premium: PREMIUM.allowed, modal: 'active-owner', unlock: false, modalText: /Owner access/ } },
  expired: { email: 'expired@qa.test', expect: { access: 'no_entitlement', reason: 'expired', premium: PREMIUM.none, modal: 'signed-in-free', unlock: true, modalText: /has expired/ } },
  canceled: { email: 'canceled@qa.test', expect: { access: 'no_entitlement', reason: 'canceled', premium: PREMIUM.none, modal: 'signed-in-free', unlock: true, modalText: /was canceled/ } },
  'invalid-link': { link: { email: 'owner@qa.test', forged: true }, expect: { access: 'anonymous', premium: PREMIUM.anonymous, returnText: /not valid/, unlock: true } },
  'expired-link': { link: { email: 'owner@qa.test', expired: true }, expect: { access: 'anonymous', premium: PREMIUM.anonymous, returnText: /has expired/, unlock: true } },
  'reused-link': { link: { email: 'monthly@qa.test', reuse: true }, expect: { access: 'anonymous', premium: PREMIUM.anonymous, returnText: /already used/, unlock: true } },
  'auth-down': { control: '/__qa/authsession?mode=500', expect: { access: 'unavailable', premium: PREMIUM.anonymous, modal: 'unavailable', unlock: true } },
  'auth-hang': { control: '/__qa/authsession?mode=hang', expect: { access: 'unavailable', premium: PREMIUM.anonymous, modal: 'unavailable', unlock: true, slow: true } },
  'ledger-down': { email: 'monthly@qa.test', control: '/__qa/supabase?mode=down', expect: { access: 'unavailable', premium: PREMIUM.unavailable, modal: 'unavailable', unlock: true } },
  'authworker-down': { link: { email: 'monthly@qa.test' }, control: '/__qa/authworker?mode=down', expect: { access: 'anonymous', premium: PREMIUM.anonymous, returnText: /temporarily unavailable/, unlock: true } },
};
const ID = IDS[identity];
if (!ID) { console.error(`unknown identity ${identity}: ${Object.keys(IDS).join(', ')}`); process.exit(2); }

const PORT = 9600 + Math.floor(Math.random() * 90);
const profile = mkdtempSync(join(tmpdir(), 'pbe-accv2-'));
const CHROME = process.env.PBE_CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
async function control(q) { if (q) await fetch(`${ORIGIN}${q}`).catch(() => {}); }
async function restore() { for (const k of ['supabase', 'authsession', 'authworker']) await fetch(`${ORIGIN}/__qa/${k}?mode=ok`).catch(() => {}); }
async function finish(code) {
  if (ID.control) await restore();
  try { if (process.platform === 'win32') execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: 'ignore' }); else chrome.kill('SIGKILL'); } catch (_) {}
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch (_) {} process.exit(code); }, 800);
}
setTimeout(() => { console.log('HARD DEADLINE'); finish(3); }, 25 * 60000);

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
const cdp = (method, params = {}, sessionId) => { const id = seq++; ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`cdp_timeout ${method}`)); } }, 30000); }); };
const step = msg => { if (process.env.PBE_ACC_TRACE) console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); };

const ROUTES = [
  ['home', 'Dashboard'], ['games', 'Games'], ['propboard', 'Props'], ['bestline', 'Best Line'], ['picks', 'Model Lab'],
  ['matchups', 'Matchups'], ['usage', 'Player Research'],
  ['qbdna', 'Player DNA QB'], ['rbdna', 'Player DNA RB'], ['wrdna', 'Player DNA WR'], ['tedna', 'Player DNA TE'],
  ['injuries', 'Injuries'], ['newsintel', 'News'], ['propchain', 'PropChain'], ['pbepicks', 'PBE Picks'], ['trackrecord', 'Track Record'],
];
const BOOKS = /DraftKings|FanDuel|BetMGM|Caesars|ESPN ?BET|Fanatics|BetRivers|Bovada/;
const TEAMS = /Bills|Dolphins|Patriots|Jets|Ravens|Bengals|Browns|Steelers|Texans|Colts|Jaguars|Titans|Broncos|Chiefs|Raiders|Chargers|Cowboys|Giants|Eagles|Commanders|Bears|Lions|Packers|Vikings|Falcons|Panthers|Saints|Buccaneers|Cardinals|Rams|49ers|Seahawks/;
const DATA = {
  home: t => t.length > 400 && TEAMS.test(t), games: t => TEAMS.test(t),
  propboard: t => BOOKS.test(t) || /Passing Yards|Receiving Yards|Rushing Yards/.test(t), bestline: t => BOOKS.test(t),
  picks: t => t.length > 200, matchups: t => TEAMS.test(t) || t.length > 300, usage: t => t.length > 300,
  qbdna: t => t.length > 300, rbdna: t => t.length > 300, wrdna: t => t.length > 300, tedna: t => t.length > 300,
  injuries: t => /Questionable|Doubtful|\bOut\b|Injur/i.test(t), newsintel: t => t.length > 300,
  propchain: t => t.length > 200, pbepicks: t => t.length > 200, trackrecord: t => t.length > 150,
};
/* retired or stale pricing must never be shown (the canonical source is window.PBEPricing) */
const STALE_PRICE = /\$\s*9\.99\s*(\/|per)\s*(wk|week)|\$99\b|\bseason pass\b/i;
const BLOCKED = ['*propbetedge-nfl-auth*/v1/auth/request*', '*propbetedge-nfl-auth*/v1/auth/email*', '*api.resend.com*', '*buy.stripe.com*', '*checkout.stripe.com*', '*/api/checkout*'];

async function runView(view) {
  const { browserContextId } = await cdp('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const exceptions = []; const responses = []; const failedLoads = []; const consoleErrors = []; const reqUrl = new Map();
  sessions.set(sessionId, m => {
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').split('\n')[0].slice(0, 180));
    if (m.method === 'Network.requestWillBeSent') reqUrl.set(m.params.requestId, m.params.request.url);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').split('\n')[0].slice(0, 180));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(`${m.params.entry.source}: ${m.params.entry.text}`.slice(0, 180));
    if (m.method === 'Network.responseReceived') responses.push({ url: m.params.response.url, status: m.params.response.status, type: m.params.type });
    if (m.method === 'Network.loadingFailed' && !m.params.canceled) failedLoads.push({ type: m.params.type, error: m.params.errorText, url: reqUrl.get(m.params.requestId) || '' });
  });
  const s = (method, params) => cdp(method, params, sessionId);
  await s('Page.enable'); await s('Runtime.enable'); await s('Network.enable'); await s('Log.enable');
  await s('Network.setBlockedURLs', { urls: BLOCKED });
  await s('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: 1, mobile: view.mobile });
  if (view.mobile) await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const ev = async (expression, timeout = 12000) => {
    const r = await Promise.race([s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), sleep(timeout).then(() => ({ result: { value: '<timeout>' } }))]);
    if (r.exceptionDetails) return `<error ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}>`;
    return r.result?.value;
  };
  const waitFor = async (expr, timeout) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await ev(`Boolean(${expr})`) === true) return true; await sleep(250); } return false; };
  const shot = async name => { await s('Page.bringToFront'); const { data } = await s('Page.captureScreenshot', { format: 'png' }); const f = join(OUT, `${name}-${view.label}.png`); writeFileSync(f, Buffer.from(data, 'base64')); return f; };
  const go = async (url, settle = 400) => { await s('Page.navigate', { url }); await sleep(settle); };
  const token = async (q = '') => (await (await fetch(`${ORIGIN}/__qa/magic?${q}`)).json()).token;
  const text = `(document.querySelector('#view-container')?.innerText||'').trim()`;
  const out = { view: view.label, routes: {}, identity: {} };

  try {
    if (entryArg) { await go(entryArg, 2500); }
    /* identity setup */
    if (ID.email) { const t = await token(`email=${encodeURIComponent(ID.email)}`); await go(`${ORIGIN}/api/auth-verify?token=${encodeURIComponent(t)}`, 300); }
    await control(ID.control);
    let navStart = Date.now();
    if (ID.link) {
      const l = ID.link;
      const t = await token(`email=${encodeURIComponent(l.email)}${l.forged ? '&forged=1' : ''}${l.expired ? '&expired=1' : ''}`);
      if (l.reuse) {
        await go(`${ORIGIN}/api/auth-verify?token=${encodeURIComponent(t)}`, 1500);
        await ev(`fetch('/api/auth-logout',{method:'POST',credentials:'same-origin'}).then(r=>r.status)`);
      }
      navStart = Date.now();
      await go(`${ORIGIN}/api/auth-verify?token=${encodeURIComponent(t)}`, 50);
    } else {
      navStart = Date.now();
      await go(`${ORIGIN}/`, 50);
    }
    step(`${view.label} boot`);
    /* the application boots regardless of what access is doing */
    const booted = await waitFor(`window.App && typeof window.App.nav==='function' && ${text}.length>80`, 45000);
    out.boot = { booted, ms: Date.now() - navStart, accessAtBoot: await ev(`window.PBEPro?.state?.access`), stuckLoader: await ev(`/Loading NFL Intelligence OS/.test(document.body.innerText)`) };
    await waitFor(`window.PBEPro && !window.PBEPro.state.loading`, ID.expect.slow ? 15000 : 10000);
    out.shell = await ev(`(()=>{const shell=document.querySelector('.shell');const cs=shell?getComputedStyle(shell):null;return{app:typeof window.App,shellVisible:!!shell&&cs.display!=='none'&&cs.visibility!=='hidden',navButtons:document.querySelectorAll('[data-route]').length}})()`);
    out.identity.returnMessage = await ev(`[...document.querySelectorAll('#pbe-pro-message,#pbe-funnel-message')].map(e=>e.textContent).join(' ').trim()`);
    await ev(`window.PBEPro?.close?.();true`);
    out.identity.state = await ev(`(()=>{const s=window.PBEPro?.state||{};return{access:s.access,pro:s.pro,role:s.role,reason:s.entitlement?.reason||null,plan:s.subscription?.plan||null,user:s.user?.email||null,htmlAccess:document.documentElement.dataset.pbeAccess||null,account:(document.getElementById('pbe-pro-account')?.textContent||'').trim()}})()`);
    out.identity.session = await ev(`fetch('/api/auth-session',{cache:'no-store',credentials:'same-origin'}).then(async r=>{const j=await r.json().catch(()=>({}));return{status:r.status,access:j.access,role:j.role,pro:j.pro,reason:j.entitlement?.reason||null,plan:j.entitlement?.plan||null}}).catch(e=>({error:String(e)}))`, 15000);
    out.identity.premium = await ev(`fetch('/api/pro-model?event_id=qa-access-v2',{cache:'no-store',credentials:'same-origin'}).then(async r=>({status:r.status,error:(await r.json().catch(()=>({}))).error||null}))`, 15000);
    out.shell.screenshot = await shot('home');

    for (const [route, name] of ROUTES) {
      step(`${view.label} route ${route}`);
      const before = responses.length; const beforeFail = failedLoads.length; const beforeCons = consoleErrors.length; const beforeExc = exceptions.length;
      const how = await ev(`(()=>{const b=[...document.querySelectorAll('[data-route="${route}"]')][0];if(b){b.click();return 'click'}if(window.App?.nav){window.App.nav('${route}');return 'App.nav'}return 'none'})()`);
      await waitFor(`window.App?.current==='${route}' && ${text}.length>80 && !/^(Loading|Checking|Reading)/.test(${text})`, 12000);
      const sig = `(()=>{const vc=document.querySelector('#view-container');if(!vc)return null;const kids=[...vc.children].filter(e=>!['SCRIPT','STYLE','LINK'].includes(e.tagName));return kids.map(e=>e.tagName.toLowerCase()+'.'+String(e.className||'').split(/\\s+/).filter(Boolean).slice(0,2).join('.'))})()`;
      const first = await ev(sig);
      await sleep(6000);
      const final = await ev(sig);
      const r = await ev(`(()=>{const t=${text};return{current:window.App?.current||null,chars:t.length,sample:t.replace(/\\s+/g,' ').slice(0,160),overflow:document.documentElement.scrollWidth-innerWidth,unlock:[...document.querySelectorAll('#view-container button,#view-container a')].filter(b=>b.offsetParent&&/unlock/i.test(b.textContent)).length,unlockText:[...document.querySelectorAll('#view-container button,#view-container a')].filter(b=>b.offsetParent&&/unlock/i.test(b.textContent)).map(b=>b.textContent.trim()).slice(0,2),body:document.body.innerText,t}})()`);
      if (typeof r !== 'object' || !r) { out.routes[route] = { name, how, error: String(r) }; continue; }
      const rsp = responses.slice(before);
      out.routes[route] = { name, how, stalePricing: (STALE_PRICE.exec(r.body) || [null])[0], unlockText: r.unlockText, navOk: r.current === route, chars: r.chars, dataOk: r.current === route && DATA[route](r.t), overflow: r.overflow, unlock: r.unlock, sample: r.sample,
        firstPaint: first, finalPaint: final, replacedAfterPaint: JSON.stringify(first) !== JSON.stringify(final),
        loaderStuck: /^(Loading|Checking|Reading)/.test(r.t) && r.chars < 300,
        http4xx: rsp.filter(x => [401, 403].includes(x.status)).map(x => `${x.status} ${x.url.slice(0, 110)}`),
        http5xx: rsp.filter(x => x.status >= 500).map(x => `${x.status} ${x.url.slice(0, 110)}`),
        netFailed: failedLoads.slice(beforeFail).filter(f => !BLOCKED.some(b => f.error === 'net::ERR_BLOCKED_BY_CLIENT')).map(f => `${f.type} ${f.error} ${f.url.slice(0, 100)}`),
        consoleErrors: consoleErrors.slice(beforeCons), exceptions: exceptions.slice(beforeExc) };
      await shot(`route-${route}`);
    }
    out.shell.navButtons = Math.max(out.shell.navButtons || 0, await ev(`document.querySelectorAll('[data-route]').length`));
    step(`${view.label} modal`);
    /* the Pro modal for this identity */
    await ev(`window.App.nav('home');true`); await sleep(800);
    await ev(`window.PBEPro.open('qa');true`); await sleep(1200);
    out.identity.modal = await ev(`(()=>{const h=document.getElementById('pbe-pro-checkout');const b=document.getElementById('pbe-pro-backdrop');return{open:!!b?.classList.contains('open'),state:h?.querySelector('.pbe-funnel-root')?.dataset.funnelState||(h?.querySelector('.pbe-access-unavailable,[data-pbe-auth-degraded]')?'unavailable':null),text:(h?.innerText||'').replace(/\\s+/g,' ').slice(0,1500),overflow:document.documentElement.scrollWidth-innerWidth}})()`);
    await shot('modal');
    await ev(`window.PBEPro.close();true`);
  } catch (e) { out.error = String(e?.message || e); }
  const sameOrigin = responses.filter(x => x.url.startsWith(ORIGIN));
  out.moduleFailures = [...sameOrigin.filter(x => /\.(m?js|css)(\?|$)/.test(x.url) && x.status >= 400).map(x => `${x.status} ${x.url.slice(ORIGIN.length).split('?')[0]}`),
    ...failedLoads.filter(f => ['Script', 'Stylesheet'].includes(f.type)).map(f => `${f.type} ${f.error} ${f.url.slice(0, 90)}`)];
  out.http401_403 = [...new Set(responses.filter(x => [401, 403].includes(x.status)).map(x => `${x.status} ${x.url.replace(ORIGIN, '').split('?')[0]}`))];
  out.http5xx = [...new Set(responses.filter(x => x.status >= 500).map(x => `${x.status} ${x.url.replace(ORIGIN, '').split('?')[0]}`))];
  out.exceptions = [...new Set(exceptions)].slice(0, 20);
  out.consoleErrors = [...new Set(consoleErrors)].slice(0, 20);
  sessions.delete(sessionId);
  await cdp('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  return out;
}

/* identity contract judged per view */
function judge(v) {
  const e = ID.expect; const st = v.identity?.state || {}; const se = v.identity?.session || {}; const pm = v.identity?.premium || {}; const md = v.identity?.modal || {};
  const checks = {
    bootsWithoutWaitingOnAuth: v.boot?.booted && !v.boot?.stuckLoader && v.shell?.shellVisible && v.boot.ms < 15000,
    clientAccess: st.access === e.access && st.pro === (e.access === 'granted'),
    serverAccess: e.access === 'unavailable' && identity !== 'ledger-down' ? true : (se.access === e.access && (e.role ? se.role === e.role : true) && (e.reason ? se.reason === e.reason : true) && (e.plan ? se.plan === e.plan : true)),
    role: e.role ? st.role === e.role : st.role == null,
    premiumGate: e.premium === 'allowed' ? ![401, 403, 503].includes(pm.status) && !['sign_in_required', 'nfl_pro_required', 'entitlement_unavailable'].includes(pm.error) : pm.status === e.premium,
    modal: e.modal ? md.state === e.modal && (e.modalText ? e.modalText.test(md.text) : true) : true,
    returnMessage: e.returnText ? e.returnText.test(v.identity?.returnMessage || '') : true,
    propboardUnlock: e.unlock ? (v.routes?.propboard?.unlock || 0) > 0 : (v.routes?.propboard?.unlock || 0) === 0,
    noStalePricing: Object.values(v.routes || {}).every(r => !r.stalePricing) && !STALE_PRICE.test(md.text || ''),
    planCards: ['signed-out', 'signed-in-free'].includes(md.state) ? /\$9\.99 \/ month/i.test(md.text) && /\$3\.99 \/ week/i.test(md.text) && /No free trial/i.test(md.text) : true,
  };
  return checks;
}

const result = { identity, origin: ORIGIN, at: new Date().toISOString(), views: [] };
for (const view of [{ label: 'desktop', width: 1440, height: 900, mobile: false }, { label: 'mobile', width: 390, height: 844, mobile: true }]) {
  if (ID.control) await restore();
  const v = await runView(view);
  v.checks = judge(v);
  result.views.push(v);
}
if (ID.control) await restore();
const all = f => result.views.every(f);
const R = (v, k) => v.routes?.[k] || {};
const ALL = ROUTES.map(r => r[0]);
result.matrix = {
  access: all(v => Object.values(v.checks).every(Boolean)),
  home: all(v => R(v, 'home').dataOk), nav: all(v => v.shell?.navButtons > 10 && ALL.every(k => R(v, k).navOk)),
  games: all(v => R(v, 'games').dataOk), props: all(v => R(v, 'propboard').dataOk), bestline: all(v => R(v, 'bestline').dataOk),
  modelLab: all(v => R(v, 'picks').dataOk), matchups: all(v => R(v, 'matchups').dataOk), research: all(v => R(v, 'usage').dataOk),
  playerDna: all(v => ['qbdna', 'rbdna', 'wrdna', 'tedna'].every(k => R(v, k).dataOk)), injuries: all(v => R(v, 'injuries').dataOk),
  news: all(v => R(v, 'newsintel').dataOk), propchain: all(v => R(v, 'propchain').dataOk), picks: all(v => R(v, 'pbepicks').dataOk), trackrecord: all(v => R(v, 'trackrecord').dataOk),
  desktop: ALL.every(k => R(result.views[0], k).dataOk && (R(result.views[0], k).overflow ?? 1) <= 0),
  mobile: ALL.every(k => R(result.views[1], k).dataOk && (R(result.views[1], k).overflow ?? 1) <= 0),
  noLoaderStuck: all(v => ALL.every(k => !R(v, k).loaderStuck)), noExceptions: all(v => (v.exceptions || []).length === 0),
  noModuleFailures: all(v => (v.moduleFailures || []).length === 0),
};
writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ identity, matrix: result.matrix }));
for (const v of result.views) {
  console.log(`-- ${v.view} boot=${JSON.stringify(v.boot)} checks=${JSON.stringify(v.checks)}`);
  console.log(`   state=${JSON.stringify(v.identity?.state)} session=${JSON.stringify(v.identity?.session)} premium=${JSON.stringify(v.identity?.premium)}`);
  console.log(`   modal=${JSON.stringify({ state: v.identity?.modal?.state, text: (v.identity?.modal?.text || '').slice(0, 140) })} return="${v.identity?.returnMessage || ''}"`);
  for (const [k, r] of Object.entries(v.routes || {})) if (!r.dataOk || !r.navOk || r.overflow > 0 || r.loaderStuck || r.exceptions?.length) console.log(`   ${k}: nav=${r.navOk} data=${r.dataOk} chars=${r.chars} ovf=${r.overflow} stuck=${r.loaderStuck} "${r.sample || r.error || ''}"`);
  console.log(`   modules=${JSON.stringify(v.moduleFailures)} 401/403=${JSON.stringify(v.http401_403)} 5xx=${JSON.stringify(v.http5xx)} exc=${JSON.stringify(v.exceptions)} err=${v.error || ''}`);
}
ws.close();
finish(result.matrix.access ? 0 : 1);
