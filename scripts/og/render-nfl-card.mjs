// Renders nfl-card.html (beside this file) to og/propbetedge-nfl-1200x630.png (RGB).
//   PW_CHROMIUM=<chrome.exe> PLAYWRIGHT_MODULE=<.../playwright-core/index.mjs> node scripts/og/render-nfl-card.mjs
// Bump the ?v= on og:image / twitter:image in index.html whenever the PNG changes.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../../og/propbetedge-nfl-1200x630.png');
const mod = process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright';
const { chromium } = await import(mod);
const b = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
const p = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await p.goto(pathToFileURL(path.join(HERE, 'nfl-card.html')).href, { waitUntil: 'networkidle' });
await p.evaluate(() => document.fonts.ready);
await p.screenshot({ path: OUT });
await b.close();
console.log(OUT);
