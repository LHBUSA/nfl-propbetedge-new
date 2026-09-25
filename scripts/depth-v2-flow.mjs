/* Product Depth V2 journey checks in a real browser.
 *
 *   node scripts/depth-v2-flow.mjs [--base=https://<preview>] [--flow=device|synced|script]
 *                                  [--cookie-a=<session token> --cookie-b=<session token>]
 *
 * device  signed out: save a game from Games and a player from Opportunity
 *         Radar, see both in My Sunday, reload (still there), remove one.
 * synced  two REAL sessions (tokens minted by the preview's own signing key,
 *         read from files, never printed): A saves, a second context for A
 *         sees it, B sees nothing, sign-out clears A's client state.
 * script  Matchups -> Explore game script: run a scenario, reset, save it.
 *
 * Local (no --base) serves the tree with scripts/local-serve.mjs on :8912.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=').slice(1).join('=');
const PW = process.env.PLAYWRIGHT_CORE || 'D:/Workers/wnba/node_modules/playwright-core/index.js';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = '.gate/depth-v2/flow';
const FLOW = arg('flow', 'device');
const WIDTH = Number(arg('width', '1440'));
let base = arg('base', '');
const pw = await import(pathToFileURL(PW).href);
const chromium = pw.chromium || pw.default?.chromium;
let server = null;
if (!base) {
  server = spawn(process.execPath, ['scripts/local-serve.mjs', '--port=8912'], {
    env: { ...process.env, NFL_OPPORTUNITY_ORIGIN: 'https://nfl-replay-preview.sales-fd3.workers.dev', MY_SUNDAY_ENABLED: '1' },
    stdio: 'ignore'
  });
  base = 'http://localhost:8912';
  await new Promise(r => setTimeout(r, 1200));
}
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const shot = (page, name) => page.screenshot({ path: `${OUT}/${FLOW}-${name}-${WIDTH}.png`, fullPage: false });
const host = new URL(base).hostname;

async function ctxWith(token) {
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: WIDTH < 768 ? 900 : 1000 }, reducedMotion: 'reduce' });
  if (token) await ctx.addCookies([{ name: 'pbe_nfl_session_v2', value: token, domain: host, path: '/', httpOnly: true, secure: base.startsWith('https'), sameSite: 'Lax' }]);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e.message).slice(0, 200)));
  return { ctx, page };
}
async function go(page, route, wait = 4000) { await page.goto(`${base}/#${route}`, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(wait); }
const savedCount = page => page.evaluate(() => window.PBEMySunday?.store && (window.PBEMySunday.store.mode === 'synced' ? window.PBEMySunday.store.items.length : JSON.parse(localStorage.getItem('pbe_mysunday_device_v1') || '[]').length));

try {
  if (FLOW === 'device') {
    const { page } = await ctxWith(null);
    await go(page, 'games', 6000);
    const mode = await page.evaluate(() => window.PBEMySunday?.store?.mode);
    check('signed out -> device mode', mode === 'device', mode);
    const btn = page.locator('.pbe25-card .pms-save').first();
    check('game cards carry Save', await btn.count() > 0);
    if (await btn.count()) { await btn.click(); await page.waitForTimeout(500); check('game saved (button pressed)', (await btn.getAttribute('aria-pressed')) === 'true'); }
    await go(page, 'usage', 5000);
    const pbtn = page.locator('.por-card .pms-save').first();
    check('radar cards carry Save', await pbtn.count() > 0);
    if (await pbtn.count()) { await pbtn.click(); await page.waitForTimeout(400); }
    await go(page, 'mysunday', 5000);
    const items = await page.locator('.pms-item').count();
    check('My Sunday lists both items', items === 2, `${items}`);
    check('device banner says this device only', (await page.locator('.pms-banner').innerText()).includes('this device only'));
    await shot(page, 'list');
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(5000);
    check('items survive a refresh', (await page.locator('.pms-item').count()) === 2);
    await page.locator('.pms-remove').first().click(); await page.waitForTimeout(500);
    check('remove works', (await page.locator('.pms-item').count()) === 1);
    await go(page, 'games', 4000);
    check('persistent control shows the saved count', await page.locator('#pms-dock:not([hidden]), #pms-head:not([hidden])').count() === 1);
    await shot(page, 'dock');
    check('no page errors', !page.errors.length, page.errors.join(' | '));
  }

  if (FLOW === 'synced') {
    const A = readFileSync(arg('cookie-a', ''), 'utf8').trim(), B = readFileSync(arg('cookie-b', ''), 'utf8').trim();
    const a1 = await ctxWith(A);
    await go(a1.page, 'mysunday', 6000);
    check('A: synced mode', (await a1.page.evaluate(() => window.PBEMySunday.store.mode)) === 'synced');
    await a1.page.evaluate(() => fetch('/api/my-sunday').then(r => r.json())).then(b => (b.items || []).length).then(async n => {
      if (n) for (const it of await a1.page.evaluate(() => window.PBEMySunday.store.items.map(i => i.item_key))) await a1.page.evaluate(k => fetch('/api/my-sunday?op=remove', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pbe-csrf': '1' }, body: JSON.stringify({ item_key: k }) }), it);
    });
    await go(a1.page, 'usage', 6000);
    const save = a1.page.locator('.por-card .pms-save').first();
    await save.click(); await a1.page.waitForTimeout(1500);
    check('A: saved via server', (await save.getAttribute('aria-pressed')) === 'true');
    await save.click(); await a1.page.waitForTimeout(1500);
    await save.click(); await a1.page.waitForTimeout(1500);
    check('A: repeat save stays one item', (await savedCount(a1.page)) === 1, String(await savedCount(a1.page)));
    const a2 = await ctxWith(A);
    await go(a2.page, 'mysunday', 6000);
    check('A: second context sees the item', (await a2.page.locator('.pms-item').count()) === 1);
    await shot(a2.page, 'second-context');
    const b = await ctxWith(B);
    await go(b.page, 'mysunday', 6000);
    check('B: sees none of A\'s items', (await b.page.locator('.pms-item').count()) === 0);
    const stolen = await b.page.evaluate(async key => (await fetch('/api/my-sunday?op=remove', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pbe-csrf': '1' }, body: JSON.stringify({ item_key: key }) })).json(), (await a2.page.evaluate(() => window.PBEMySunday.store.items[0]?.item_key)));
    check('B: cannot delete A\'s item', stolen.deleted === false);
    const csrf = await b.page.evaluate(async () => (await fetch('/api/my-sunday?op=save', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status);
    check('write without CSRF header is refused', csrf === 403, String(csrf));
    await a2.page.evaluate(() => window.PBEPro?.signOut ? window.PBEPro.signOut() : fetch('/api/auth-logout', { method: 'POST' }).then(() => window.dispatchEvent(new CustomEvent('pbe:pro-state', { detail: { pro: false, signedIn: false } }))));
    await a2.page.waitForTimeout(3000);
    const after = await a2.page.evaluate(() => ({ mode: window.PBEMySunday.store.mode, n: window.PBEMySunday.store.items.length, alerts: window.PBEMySunday.store.alerts.length }));
    check('sign-out clears synced client state', after.mode !== 'synced' && after.n === 0 && after.alerts === 0, JSON.stringify(after));
    await go(a1.page, 'mysunday', 5000);
    check('A: item still in the account after the other context signed out', (await a1.page.locator('.pms-item').count()) === 1);
    for (const p of [a1.page, a2.page, b.page]) check('no page errors', !p.errors.length, p.errors.join(' | '));
  }

  if (FLOW === 'script') {
    const { page } = await ctxWith(arg('cookie-a', '') ? readFileSync(arg('cookie-a', ''), 'utf8').trim() : null);
    await go(page, 'matchups', 7000);
    const panel = page.locator('[data-gsl]');
    check('Game Script Lab panel inside Matchups', await panel.count() === 1);
    await panel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2500);
    await shot(page, 'baseline');
    const base0 = await page.locator('[data-gsl-out="scenario"] [data-gsl-targets]').first().innerText().catch(() => '');
    const setRange = (sel, v) => page.locator(sel).first().evaluate((el, val) => { el.value = String(val); el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
    await setRange('[data-gsl-volume]', 72); await page.waitForTimeout(300);
    const more = await page.locator('[data-gsl-out="scenario"] [data-gsl-targets]').first().innerText().catch(() => '');
    check('more volume -> more scenario targets', Number(more) > Number(base0), `${base0} -> ${more}`);
    await setRange('[data-gsl-pass]', 75); await page.waitForTimeout(300);
    const passier = await page.locator('[data-gsl-out="scenario"] [data-gsl-targets]').first().innerText().catch(() => '');
    check('higher dropback rate -> more targets again', Number(passier) > Number(more), `${more} -> ${passier}`);
    const thin = page.locator('[data-gsl-state][data-thin]').first();
    if (await thin.count()) { await thin.click(); await page.waitForTimeout(300); check('a thin state is explained, not extrapolated', (await panel.innerText()).includes('Scenario unavailable')); check('an unavailable scenario cannot be saved', (await panel.locator('.pms-save').count()) === 0); }
    await page.locator('[data-gsl-reset]').first().click(); await page.waitForTimeout(400);
    const reset = await page.locator('[data-gsl-out="scenario"] [data-gsl-targets]').first().innerText().catch(() => '');
    check('reset returns to baseline', reset === base0, reset);
    check('labelled scenario estimate', (await panel.innerText()).includes('Scenario estimate — not an official PBE prediction'));
    await setRange('[data-gsl-volume]', 70); await page.waitForTimeout(300);
    await shot(page, 'scenario');
    const save = panel.locator('.pms-save').first();
    if (await save.count()) { await save.click(); await page.waitForTimeout(1500); check('scenario saved', (await save.getAttribute('aria-pressed')) === 'true'); }
    check('no page errors', !page.errors.length, page.errors.join(' | '));
  }
} finally {
  await browser.close();
  server?.kill();
}
writeFileSync(`${OUT}/${FLOW}-${WIDTH}.json`, JSON.stringify(results, null, 1));
const bad = results.filter(r => !r.ok);
console.log(`${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
