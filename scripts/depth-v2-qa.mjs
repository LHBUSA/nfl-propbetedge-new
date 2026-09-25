/* Product Depth V2 browser QA: screenshots + console errors + failed requests
 * + document overflow, per route and width.
 *
 *   node scripts/depth-v2-qa.mjs [--base=https://<preview>.vercel.app] [--routes=usage,home] [--widths=320,390,1440]
 *
 * Without --base it starts scripts/local-serve.mjs on :8911 with
 * NFL_OPPORTUNITY_ORIGIN pointing at the isolated preview Worker, so the
 * real api/ handlers run against preview data — never production writes.
 *
 * Browser: the installed Chrome via playwright-core (PLAYWRIGHT_CORE may point
 * at any local copy). Output: .gate/depth-v2/<route>-<width>.png + report.json.
 * Overflow is measured, not hidden: a document wider than the viewport fails.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=').slice(1).join('=');
const PW = process.env.PLAYWRIGHT_CORE || 'D:/Workers/wnba/node_modules/playwright-core/index.js';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = arg('out', '.gate/depth-v2');
const WIDTHS = arg('widths', '320,360,390,430,768,1024,1440').split(',').map(Number);
const ROUTES = arg('routes', 'usage,home,matchups,mysunday').split(',');
const WAIT = Number(arg('wait', '4500'));
let base = arg('base', '');

const pw = await import(pathToFileURL(PW).href);
const chromium = pw.chromium || pw.default?.chromium;
let server = null;
if (!base) {
  server = spawn(process.execPath, ['scripts/local-serve.mjs', '--port=8911'], {
    env: { ...process.env, NFL_OPPORTUNITY_ORIGIN: process.env.NFL_OPPORTUNITY_ORIGIN || 'https://nfl-replay-preview.sales-fd3.workers.dev' },
    stdio: 'ignore'
  });
  base = 'http://localhost:8911';
  await new Promise(r => setTimeout(r, 1200));
}
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = [];
try {
  for (const route of ROUTES) {
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width, height: width < 768 ? 900 : 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      const errors = [], failed = [];
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 240)); });
      page.on('pageerror', e => errors.push(`pageerror: ${String(e.message).slice(0, 240)}`));
      page.on('requestfailed', r => failed.push(`${r.failure()?.errorText || 'failed'} ${r.url().slice(0, 160)}`));
      page.on('response', r => { if (r.status() >= 400 && !/favicon|espncdn|googletagmanager/.test(r.url())) failed.push(`${r.status()} ${r.url().slice(0, 160)}`); });
      await page.goto(`${base}/#${route}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(WAIT);
      const m = await page.evaluate(() => {
        const doc = document.scrollingElement || document.documentElement;
        const wide = [...document.querySelectorAll('#view-container *')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1); }).slice(0, 6).map(el => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} r=${Math.round(el.getBoundingClientRect().right)}`);
        return { scrollWidth: doc.scrollWidth, innerWidth, overflow: doc.scrollWidth > innerWidth + 1, wide, route: window.App?.current, title: document.querySelector('#view-container h1')?.textContent?.trim() || null };
      });
      const file = `${OUT}/${route}-${width}.png`;
      await page.screenshot({ path: file, fullPage: true });
      await page.screenshot({ path: `${OUT}/${route}-${width}-top.png`, fullPage: false });
      report.push({ route, width, ...m, errors, failed, file });
      console.log(`${m.overflow || errors.length ? 'FAIL' : 'ok  '} #${route} @${width}  sw=${m.scrollWidth}  errors=${errors.length} failed=${failed.length}${m.wide.length ? `  wide: ${m.wide.join(' | ')}` : ''}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server?.kill();
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
const bad = report.filter(r => r.overflow || r.errors.length);
console.log(`${report.length - bad.length}/${report.length} clean`);
process.exit(bad.length ? 1 : 0);
