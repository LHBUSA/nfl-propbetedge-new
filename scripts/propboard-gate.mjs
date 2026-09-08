/* PROP BOARD ACCEPTANCE GATE (Prop Board v5)
 *   node scripts/propboard-gate.mjs [baseUrl] [outDir]
 *
 * Headless Chrome against the dev server. Board data comes from the real
 * market snapshot API (free reads). The PRO state is simulated only inside
 * this gate: PBEPro.state.pro is flipped and /api/pro-model is answered
 * with a clearly-labelled TEST fixture so modeled / unmodeled / status
 * rendering can be exercised without a paid session. Nothing here ships.
 *
 * Checks, per width (1600 / 1440 / 1280 / 1024 / 768 / 390):
 *   · no horizontal page scroll, no clipped Status, no font < 10px in the board
 *   · desktop shows exactly 7 columns; tablet/mobile show cards, no table
 *   · at most one lock CTA in view (no repeated lock spam)
 *   · no console errors
 * Behaviour (at 1440 unless noted):
 *   · anonymous: model cells gated once (PRO mark in header), status MARKET
 *   · PRO: modeled row shows fair line, signed edge, MODELED-family status;
 *     unmodeled row shows MARKET ONLY; signal strip present
 *   · search, market filter, sportsbook filter narrow the board
 *   · pin persists to localStorage and floats the row to the top
 *   · row expands inline with book quotes + CURRENT SNAPSHOT label
 *   · player name opens Player Research; ?player= deep link opens it too
 *   · event change (PBEEventSelector.choose) refetches the NEW event id
 *   · Refresh re-reads the board; no odds request repeats during a 20s dwell
 *   · single-book row and empty-filter state render without error
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:4321';
const OUT = process.argv[3] || 'shots/propboard-gate';
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DP = 9200 + Math.floor(Math.random() * 90); const dir = mkdtempSync(join(tmpdir(), 'pbe-pbgate-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${DP}`, `--user-data-dir=${dir}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
function finish(c) { try { chrome.kill(); } catch {} setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(c); }, 200); }
setTimeout(() => { console.error('DEADLINE'); finish(3); }, 900000).unref?.();
async function wsUrl() { for (let i = 0; i < 100; i++) { try { const l = await (await fetch(`http://127.0.0.1:${DP}/json/list`)).json(); const p = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(200); } throw new Error('devtools never came up'); }
const ws = new WebSocket(await wsUrl()); await new Promise((r) => { ws.onopen = r; });
let id = 1; const pending = new Map(); let errors = []; let boardCalls = [];
let PRO = false;
const TEST_MODEL = { source: 'PROPBOARD GATE TEST FIXTURE — not production model output', models: [
  { player: 'Sam Darnold', fair_line: 236.5, model_over_at_consensus_pct: 57.1, fair_line_gap_yards: 8, decision_status: 'MODELED', missing_inputs: [], predictive_sd: 61.2, projected_attempts: 33.1, effective_games: 17 },
  { player: 'Drake Maye', fair_line: 218, model_over_at_consensus_pct: 44.9, fair_line_gap_yards: -17.5, decision_status: 'MODELED', missing_inputs: ['weather'], predictive_sd: 58.7, projected_attempts: 31.4, effective_games: 17 },
] };
const send = (m, p = {}) => { const n = id++; ws.send(JSON.stringify({ id: n, method: m, params: p })); return new Promise((res, rej) => pending.set(n, { resolve: res, reject: rej })); };
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'exception');
  if (m.method === 'Fetch.requestPaused') {
    const { requestId, request } = m.params;
    if (/\/api\/odds\/board/.test(request.url)) boardCalls.push({ t: Date.now(), url: request.url });
    if (PRO && /\/api\/pro-model/.test(request.url)) { send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(TEST_MODEL)).toString('base64') }).catch(() => {}); return; }
    send('Fetch.continueRequest', { requestId }).catch(() => {});
  }
};
await send('Runtime.enable'); await send('Page.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/odds/board*', requestStage: 'Request' }, { urlPattern: '*/api/pro-model*', requestStage: 'Request' }] });
const evalIn = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value; };
let failures = 0; const check = (n, c, d) => { if (!c) failures++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d !== undefined ? '  ' + d : ''}`); };
const shot = async (name) => { const cap = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, `${name}.png`), Buffer.from(cap.data, 'base64')); };
const size = async (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w <= 768 });
const open = async (query = '') => { errors = []; await send('Page.navigate', { url: `${BASE}/?g=${Date.now()}${query}#propboard` }); await sleep(2500); await evalIn(`(()=>{try{window.App?.nav('propboard')}catch{}return 1})()`); await waitBoard(); };
async function waitBoard() { for (let i = 0; i < 60; i++) { const ok = await evalIn(`!!document.querySelector('.pbe5 [data-pbe5-row], .pbe5-empty')`); if (ok) break; await sleep(500); } await sleep(800); }
const PROBE = `(() => { const root = document.querySelector('.pbe5'); if (!root) return { missing: true }; const vw = innerWidth; let minFont = 99, clippedStatus = 0; for (const el of root.querySelectorAll('*')) { const cs = getComputedStyle(el); if (cs.display === 'none') continue; const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue; if ([...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) minFont = Math.min(minFont, parseFloat(cs.fontSize)); } for (const el of root.querySelectorAll('.pbe5-status')) if (el.scrollWidth > el.clientWidth + 1) clippedStatus++; const text = root.innerText; return { overflow: document.documentElement.scrollWidth - vw, cols: root.querySelectorAll('.pbe5-table thead th').length, rows: root.querySelectorAll('[data-pbe5-row]').length, cards: root.querySelectorAll('.pbe5-card').length, minFont, clippedStatus, locks: (text.match(/Unlock NFL Pro/g) || []).length, statuses: [...new Set([...root.querySelectorAll('.pbe5-status')].map(s => s.textContent.trim()))], head: root.querySelector('.pbe5-head')?.innerText.replace(/\\s+/g, ' ').slice(0, 160), signal: !!root.querySelector('.pbe5-signal:not(.pbe5-signal-locked)') }; })()`;

/* ------------------------------------------------ layout at six widths */
for (const [w, h] of [[1600, 1000], [1440, 1000], [1280, 800], [1024, 768], [768, 1024], [390, 844]]) {
  await size(w, h); await open();
  const m = await evalIn(PROBE);
  console.log(`\n[${w}x${h}] cols=${m.cols} rows=${m.rows} cards=${m.cards} minFont=${m.minFont} overflow=${m.overflow}`);
  check('no horizontal page scroll', m.overflow <= 1, `${m.overflow}px`);
  check('no clipped Status', m.clippedStatus === 0);
  check('no font under 10px in the board', m.minFont >= 10, `${m.minFont}px`);
  if (w >= 1024) { check('desktop scan table has exactly 7 columns', m.cols === 7, m.cols); check('no cards on desktop', m.cards === 0); }
  else { check('cards, not a table, below 1024', m.cols === 0 && m.cards > 0, `${m.cards} cards`); }
  check('at most one unlock CTA on the board', m.locks <= 1, m.locks);
  check('anonymous status is MARKET', m.statuses.every((s) => s === 'MARKET'), m.statuses.join(','));
  check('no console errors', errors.length === 0, errors[0]?.slice(0, 120));
  await shot(`anon-${w}`);
}

/* --------------------------------------------- behaviour at 1440 (anon) */
await size(1440, 1000); await open();
console.log('\n[behaviour · anonymous]');
const baseline = await evalIn(`document.querySelectorAll('.pbe5 [data-pbe5-row]').length`);
await evalIn(`(()=>{const i=document.querySelector('[data-pbe5-search]');i.value='maye';i.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`); await sleep(300);
const searched = await evalIn(`[...document.querySelectorAll('.pbe5 [data-pbe5-row] .pbe5-name')].map(a=>a.textContent)`);
check('search narrows to the player', searched.length > 0 && searched.length < baseline && searched.every((n) => /maye/i.test(n)), `${searched.length}/${baseline}`);
await evalIn(`(()=>{const i=document.querySelector('[data-pbe5-search]');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));const s=document.querySelector('[data-pbe5-market]');s.value='receiving';s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`); await sleep(300);
const recv = await evalIn(`[...document.querySelectorAll('.pbe5 [data-pbe5-row] .pbe5-player small')].map(e=>e.textContent)`);
check('market filter keeps only receiving props', recv.length > 0 && recv.every((t) => /Receiving Yards|Receptions/.test(t)), `${recv.length} rows`);
await evalIn(`(()=>{const s=document.querySelector('[data-pbe5-market]');s.value='all';s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`); await sleep(200);
const firstBook = await evalIn(`document.querySelector('[data-pbe5-book] option:nth-child(2)')?.value || ''`);
await evalIn(`(()=>{const s=document.querySelector('[data-pbe5-book]');s.value=${JSON.stringify(firstBook)};s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`); await sleep(300);
const bookRows = await evalIn(`document.querySelectorAll('.pbe5 [data-pbe5-row]').length`);
check(`sportsbook filter (${firstBook}) narrows the board`, bookRows > 0 && bookRows <= baseline, `${bookRows}/${baseline}`);
await evalIn(`(()=>{const s=document.querySelector('[data-pbe5-book]');s.value='';s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`); await sleep(200);
const secondKey = await evalIn(`document.querySelectorAll('.pbe5 [data-pbe5-row]')[3]?.dataset.pbe5Row || ''`);
await evalIn(`document.querySelector('[data-pbe5-pin="${secondKey.replace(/"/g, '\\"')}"]').click()`); await sleep(300);
const afterPin = await evalIn(`({ first: document.querySelector('.pbe5 [data-pbe5-row]')?.dataset.pbe5Row, stored: Object.keys(localStorage).filter(k=>k.startsWith('pbe_propboard_v4_pins_')).map(k=>localStorage.getItem(k)).join('|') })`);
check('pinned row floats to the top and persists', afterPin.first === secondKey && afterPin.stored.includes(secondKey), afterPin.first);
await evalIn(`document.querySelector('[data-pbe5-pin="${secondKey.replace(/"/g, '\\"')}"]').click()`); await sleep(200);
await evalIn(`document.querySelector('.pbe5 [data-pbe5-row] .pbe5-td-cons').click()`); await sleep(400);
const detail = await evalIn(`(()=>{const d=document.querySelector('.pbe5-detail');return d?{quotes:d.querySelectorAll('.pbe5-quotes tbody tr').length,snapshot:/CURRENT SNAPSHOT · NOT HISTORICAL MOVEMENT/.test(d.innerText),unlock:(d.innerText.match(/Unlock NFL Pro/g)||[]).length,meta:/snapshot captured/i.test(d.innerText)}:null})()`);
check('row expands inline with book quotes, snapshot label and metadata', detail && detail.quotes > 0 && detail.snapshot && detail.meta, JSON.stringify(detail));
check('the expanded detail carries the single model unlock', detail && detail.unlock === 1);
await shot('anon-1440-expanded');
await evalIn(`document.querySelector('.pbe5 [data-pbe5-player]').click()`); await sleep(2500);
const research = await evalIn(`!!document.querySelector('.pbe17-player')`);
check('player name opens Player Research', research);
await evalIn(`window.PBEPlayerResearch?.close?.()`); await sleep(200);
const single = await evalIn(`(()=>{const rows=window.PBEPropBoardV3.state.rows;const one=rows.find(r=>r.bookCount===1);return one?{key:one.key,rendered:!!document.querySelector('[data-pbe5-row="'+CSS.escape(one.key)+'"]')}:{none:true}})()`);
check('single-book row renders (or none exists in this slate)', single.none || single.rendered, JSON.stringify(single));
await evalIn(`(()=>{const i=document.querySelector('[data-pbe5-search]');i.value='zzzz-no-such-player';i.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`); await sleep(300);
check('empty filter state renders', await evalIn(`!!document.querySelector('.pbe5-empty')`));
await evalIn(`(()=>{const i=document.querySelector('[data-pbe5-search]');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));return 1})()`);
check('no console errors during anonymous behaviour', errors.length === 0, errors[0]?.slice(0, 120));

/* deep link */
await open('&player=Drake%20Maye'); await sleep(3000);
const deep = await evalIn(`({ drawer: !!document.querySelector('.pbe17-player'), name: document.querySelector('.pbe17-name')?.textContent || '', rows: [...document.querySelectorAll('.pbe5 [data-pbe5-row] .pbe5-name')].map(a=>a.textContent) })`);
check('?player=Drake%20Maye#propboard opens Player Research', deep.drawer && /maye/i.test(deep.name), deep.name);
check('deep link narrows the board to that player', deep.rows.length > 0 && deep.rows.every((n) => /maye/i.test(n)), `${deep.rows.length} rows`);
await evalIn(`window.PBEPlayerResearch?.close?.()`);

/* refresh + no polling */
await open(); boardCalls = [];
await evalIn(`document.querySelector('[data-pbe5="refresh"]').click()`); await waitBoard();
const afterRefresh = boardCalls.length; const settled = Date.now(); await sleep(20000);
check('Refresh re-reads the board', afterRefresh >= 1, `${afterRefresh} board reads`);
check('no odds re-request during a 20s dwell', boardCalls.filter((c) => c.t > settled).length === 0);

/* event change through the shared selector */
const beforeEvent = await evalIn(`window.PBEPropBoardV3.state.eventId`);
const otherEvent = await evalIn(`(async()=>{await window.PBEEventSelector.discover();const e=window.PBEEventSelector.state.events.find(x=>x.id!==window.PBEPropBoardV3.state.eventId);return e?e.id:''})()`);
if (otherEvent) {
  boardCalls = [];
  await evalIn(`window.PBEEventSelector.choose(${JSON.stringify(otherEvent)})`); await sleep(1500); await waitBoard();
  const fetched = boardCalls.map((c) => new URL(c.url).searchParams.get('event_id'));
  check('event change refetches the NEW event', fetched.length > 0 && fetched.every((e) => e === otherEvent), `${fetched[0]} (was ${beforeEvent})`);
  check('board state follows the selector', (await evalIn(`window.PBEPropBoardV3.state.eventId`)) === otherEvent);
  await evalIn(`window.PBEEventSelector.choose(${JSON.stringify(beforeEvent)})`); await sleep(1500); await waitBoard();
} else check('event change (no second event available in the slate to test)', true);

/* ------------------------------------------------------- PRO simulated */
PRO = true;
await open();
await evalIn(`(()=>{window.PBEPro.state.pro=true;window.dispatchEvent(new CustomEvent('pbe:pro-state',{detail:{pro:true,signedIn:true}}));return 1})()`); await sleep(1500); await waitBoard();
console.log('\n[behaviour · PRO (test fixture)]');
const pro = await evalIn(`(()=>{const root=document.querySelector('.pbe5');const rows=[...root.querySelectorAll('[data-pbe5-row]')];const m=rows.find(r=>r.querySelector('.pbe5-fair'));const u=rows.find(r=>!r.querySelector('.pbe5-fair'));return{ modeled:m?{name:m.querySelector('.pbe5-name').textContent,fair:m.querySelector('.pbe5-fair')?.textContent,edge:m.querySelector('.pbe5-edge')?.textContent,status:m.querySelector('.pbe5-status')?.textContent}:null, unmodeled:u?{status:u.querySelector('.pbe5-status')?.textContent}:null, signal:!!root.querySelector('.pbe5-signal:not(.pbe5-signal-locked)'), locks:(root.innerText.match(/Unlock NFL Pro/g)||[]).length, first:rows[0]?.querySelector('.pbe5-name')?.textContent }})()`);
check('modeled row shows PBE fair + signed edge + MODELED status', pro.modeled && /^[+-]/.test(pro.modeled.edge || '') && /MODELED/.test(pro.modeled.status || ''), JSON.stringify(pro.modeled));
check('unmodeled row shows MARKET ONLY', pro.unmodeled?.status === 'MARKET ONLY', pro.unmodeled?.status);
check('signal strip present for PRO', pro.signal);
check('no unlock CTA for PRO', pro.locks === 0, pro.locks);
check('modeled rows sort first by default', /Darnold|Maye/.test(pro.first || ''), pro.first);
await evalIn(`(()=>{const b=document.querySelector('[data-pbe5="modeled"]');b.click();return 1})()`); await sleep(300);
const onlyModeled = await evalIn(`[...document.querySelectorAll('.pbe5 [data-pbe5-row]')].every(r=>r.querySelector('.pbe5-fair'))`);
check('Modeled only toggle hides unmodeled rows', onlyModeled);
await evalIn(`document.querySelector('[data-pbe5="modeled"]').click()`); await sleep(200);
await evalIn(`document.querySelector('.pbe5 [data-pbe5-row] .pbe5-td-cons').click()`); await sleep(400);
const proDetail = await evalIn(`(()=>{const d=document.querySelector('.pbe5-detail');return d?{prob:/pbe over probability/i.test(d.innerText),gap:/model gap/i.test(d.innerText),unlock:/Unlock NFL Pro/.test(d.innerText)}:null})()`);
check('PRO detail shows probability + gap without an unlock', proDetail && proDetail.prob && proDetail.gap && !proDetail.unlock, JSON.stringify(proDetail));
check('no console errors during PRO behaviour', errors.length === 0, errors[0]?.slice(0, 120));
await shot('pro-1440');
await size(390, 844); await open(); await evalIn(`(()=>{window.PBEPro.state.pro=true;window.dispatchEvent(new CustomEvent('pbe:pro-state',{detail:{pro:true}}));return 1})()`); await sleep(1500); await waitBoard();
const proMobile = await evalIn(PROBE);
check('PRO mobile: cards, no overflow', proMobile.cards > 0 && proMobile.overflow <= 1, `${proMobile.cards} cards, ${proMobile.overflow}px`);
await shot('pro-390');

console.log(`\n${failures ? failures + ' FAILURES' : 'CLEAN'}`);
ws.close(); finish(failures ? 1 : 0);
