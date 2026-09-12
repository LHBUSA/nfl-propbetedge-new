import { readFileSync, writeFileSync } from 'node:fs';

const read = p => readFileSync(p, 'utf8');
const write = (p, s) => writeFileSync(p, s, 'utf8');
function once(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`missing marker: ${label}`);
  return text.replace(from, to);
}
function between(text, start, end, replacement, label) {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0 || b <= a) throw new Error(`missing range: ${label}`);
  return text.slice(0, a) + replacement + text.slice(b);
}

// 1) Canonical inactive model cells: every ready-but-inactive market is a dash.
const overlayPath = 'best-line-model-overlay-v1.js';
let overlay = read(overlayPath);
overlay = once(
  overlay,
  `    const card = currentCard(event, market);\n    if (!card) return {\n      fair: '<span class="pbebl-na">No active signal</span><small>No issued PBE value for this market</small>',\n      edge: '<span class="pbebl-na">No active signal</span><small>Best Line will not invent one</small>'\n    };`,
  `    const card = currentCard(event, market);\n    if (!card || card.active === false) return {\n      fair: '<span class="pbebl-na">—</span>',\n      edge: '<span class="pbebl-na">—</span>'\n    };`,
  'canonical inactive model state',
);
write(overlayPath, overlay);

// 2) Best Line: week boundaries + market-specific book coverage explanation.
const bestPath = 'best-line-v1.js';
let best = read(bestPath);
best = once(
  best,
  `  function row(market, s) {\n    if (!s) return '';\n    const range = s.line_range && s.line_range.low !== s.line_range.high ? \`${'${market === \'spread\' ? signed(s.line_range.low) : s.line_range.low}'} to ${'${market === \'spread\' ? signed(s.line_range.high) : s.line_range.high}'}\` : s.line_range ? 'All books agree' : \`${'${american(s.price_range.low)}'} to ${'${american(s.price_range.high)}'}\`;`,
  `  function coverageNote(e, market, s) {\n    const coverage = s?.coverage || {};\n    const eventBooks = Number.isFinite(num(coverage.event_book_count)) ? num(coverage.event_book_count) : num(e?.books);\n    const marketBooks = Number.isFinite(num(coverage.market_book_count)) ? num(coverage.market_book_count) : num(s?.book_count);\n    if (!Number.isFinite(eventBooks) || !Number.isFinite(marketBooks) || marketBooks >= eventBooks) return '';\n    const missing = Math.max(0, eventBooks - marketBooks);\n    const pickem = arr(coverage.pickem_spread_books);\n    if (market === 'moneyline' && pickem.length) {\n      const who = pickem.length <= 4 ? \`: ${'${pickem.join(\', \')}'}\` : '';\n      return \`${'${pickem.length}'} ${'${pickem.length === 1 ? \'book prices\' : \'books price\'}'} this matchup as PK/0 spread instead of an explicit moneyline${'${who}'}\`;\n    }\n    return \`${'${missing}'} ${'${missing === 1 ? \'snapshot book does\' : \'snapshot books do\'}'} not quote this market\`;\n  }\n  function row(e, market, s) {\n    if (!s) return '';\n    const range = s.line_range && s.line_range.low !== s.line_range.high ? \`${'${market === \'spread\' ? signed(s.line_range.low) : s.line_range.low}'} to ${'${market === \'spread\' ? signed(s.line_range.high) : s.line_range.high}'}\` : s.line_range ? 'All books agree' : \`${'${american(s.price_range.low)}'} to ${'${american(s.price_range.high)}'}\`;\n    const coverage = coverageNote(e, market, s);`,
  'coverage helper and row signature',
);
best = once(
  best,
  `      <td data-label="Range">${'${esc(range)}'}<small>${'${esc(s.book_count)}'} books</small></td>`,
  `      <td data-label="Range">${'${esc(range)}'}<small>${'${esc(s.book_count)}'} books${'${coverage ? ` · ${esc(coverage)}` : \'\'}'}</small></td>`,
  'market coverage note',
);
best = once(
  best,
  `    const rows = order.flatMap(([k, sides]) => Object.values(sides || {}).filter(Boolean).map(s => row(k, s))).join('');`,
  `    const rows = order.flatMap(([k, sides]) => Object.values(sides || {}).filter(Boolean).map(s => row(e, k, s))).join('');`,
  'event-aware rows',
);
best = once(
  best,
  `<span>${'${esc(e.books)}'} books</span>`,
  `<span>${'${esc(e.books)}'} books in snapshot</span>`,
  'snapshot book label',
);
const oldGames = `  function gamesHtml(d) {\n    const events = arr(d?.events);\n    if (!events.length) return '<div class="pbebl-unavailable"><b>No games in the snapshot window</b><span>The market snapshot carries no NFL games in the next eight days.</span></div>';\n    return \`<div class="pbebl-layout"><div class="pbebl-games">${'${events.map(gameCard).join(\'\')}'}</div>${'${leaderboard(d)}'}</div>\`;\n  }\n`;
const newGames = `  function gamesHtml(d) {\n    const events = arr(d?.events);\n    if (!events.length) return '<div class="pbebl-unavailable"><b>No games in the snapshot window</b><span>The market snapshot carries no NFL games in the next eight days.</span></div>';\n    const currentWeek = Number.isFinite(num(d?.current_week)) ? num(d.current_week) : null;\n    const groups = new Map();\n    for (const e of events) {\n      const week = Number.isFinite(num(e?.week)) ? num(e.week) : null;\n      const key = week === null ? 'snapshot' : String(week);\n      if (!groups.has(key)) groups.set(key, { week, events: [] });\n      groups.get(key).events.push(e);\n    }\n    const ordered = [...groups.values()].sort((a, b) => {\n      if (a.week === null) return 1;\n      if (b.week === null) return -1;\n      return a.week - b.week;\n    });\n    const cards = ordered.map(group => {\n      const label = group.week === null ? 'SNAPSHOT' : \`WEEK ${'${group.week}'}\`;\n      const context = group.week === null || currentWeek === null ? ''\n        : group.week === currentWeek ? 'CURRENT SLATE'\n          : group.week > currentWeek ? 'LOOKAHEAD' : 'PREVIOUS WEEK';\n      return \`<section class="pbebl-week" data-week="${'${group.week ?? \'unknown\'}'}"><div class="pbebl-week-head"><b>${'${esc(label)}'}</b>${'${context ? `<span>${esc(context)}</span>` : \'\'}'}</div>${'${group.events.map(gameCard).join(\'\')}'}</section>\`;\n    }).join('');\n    return \`<div class="pbebl-layout"><div class="pbebl-games">${'${cards}'}</div>${'${leaderboard(d)}'}</div>\`;\n  }\n`;
best = once(best, oldGames, newGames, 'week-grouped slate');
write(bestPath, best);

// 3) Backend market summary: explain why market book count differs from event count.
const corePath = 'workers/nfl-intel/src/bestline-core.js';
let core = read(corePath);
core = once(
  core,
  `export function summarizeMarket(quotes, market, sides) {\n  const out = {};`,
  `export function summarizeMarket(quotes, market, sides) {\n  const out = {};\n  const eventBooks = [...new Set(quotes.map(q => q.book))];\n  const marketBooks = [...new Set(quotes.filter(q => q.market === market).map(q => q.book))];\n  const missingBooks = eventBooks.filter(book => !marketBooks.includes(book));\n  const pickemSpreadBooks = market === 'moneyline'\n    ? missingBooks.filter(book => quotes.some(q => q.market === 'spread' && q.book === book && Number(q.line) === 0))\n    : [];\n  const coverage = {\n    event_book_count: eventBooks.length,\n    market_book_count: marketBooks.length,\n    missing_books: missingBooks,\n    pickem_spread_books: pickemSpreadBooks,\n  };`,
  'market coverage metadata',
);
core = once(
  core,
  `      book_count: books.length,\n      quotes: mine`,
  `      book_count: books.length,\n      coverage,\n      quotes: mine`,
  'attach coverage metadata',
);
write(corePath, core);

// 4) Backend endpoint: attach authoritative week metadata from nfl-current.
const indexPath = 'workers/nfl-intel/src/index.js';
let index = read(indexPath);
const oldBestLineTail = `  const horizon = now + days * 86400000;\n  const events = (Array.isArray(snap?.events) ? snap.events : [])\n    .filter(e => (only ? String(e.id) === only : true))\n    .filter(e => { const k = Date.parse(e?.commence_time || ''); return Number.isFinite(k) && k <= horizon && k > now - 5 * 3600000; })\n    .map(e => summarizeEvent(e, { now }))\n    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));\n  return json({`;
const newBestLineTail = `  let slateBody = null;\n  try { slateBody = await currentGames(env); } catch (_) { /* market price shopping remains available */ }\n  const slateGames = slateBody ? gamesFromCurrent(slateBody) : [];\n  const teamKey = value => String(value || '').trim().toLowerCase().replace(/\\s+/g, ' ');\n  const matchupKey = (away, home) => \`${'${teamKey(away)}'}|${'${teamKey(home)}'}\`;\n  const slateByMatchup = new Map(slateGames.map(g => [matchupKey(g.away?.name, g.home?.name), g]));\n  const horizon = now + days * 86400000;\n  const events = (Array.isArray(snap?.events) ? snap.events : [])\n    .filter(e => (only ? String(e.id) === only : true))\n    .filter(e => { const k = Date.parse(e?.commence_time || ''); return Number.isFinite(k) && k <= horizon && k > now - 5 * 3600000; })\n    .map(e => {\n      const summary = summarizeEvent(e, { now });\n      const slate = slateByMatchup.get(matchupKey(e?.away_team, e?.home_team));\n      return { ...summary, season: slate?.season ?? null, week: slate?.week ?? null };\n    })\n    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));\n  const currentWeekRaw = slateBody?.current_week ?? slateBody?.week;\n  const currentWeek = Number.isFinite(Number(currentWeekRaw)) ? Number(currentWeekRaw)\n    : events.map(e => Number(e.week)).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? null;\n  return json({`;
index = once(index, oldBestLineTail, newBestLineTail, 'authoritative week enrichment');
index = once(
  index,
  `    window_days: days,\n    definitions: {`,
  `    window_days: days,\n    current_week: currentWeek,\n    definitions: {`,
  'current week response field',
);
write(indexPath, index);

// 5) CSS for week boundaries and coverage notes.
const cssPath = 'best-line-v1.css';
let css = read(cssPath);
if (!css.includes('.pbebl-week-head')) {
  css += `\n/* Explicit slate boundaries and market-specific coverage notes. */\n.pbebl-week{display:grid;gap:var(--s-3,12px)}\n.pbebl-week+.pbebl-week{margin-top:var(--s-4,16px);padding-top:var(--s-4,16px);border-top:1px solid var(--pbe-line-strong)}\n.pbebl-week-head{display:flex;align-items:center;gap:8px;min-height:28px;padding:0 2px;font:700 var(--fs-micro,10px)/1.2 var(--pbe-font-data);letter-spacing:.12em;text-transform:uppercase;color:var(--pbe-faint)}\n.pbebl-week-head b{color:var(--pbe-gold);font:800 12px/1.2 var(--pbe-font-data);letter-spacing:.14em}\n.pbebl-week-head span{border-left:1px solid var(--pbe-line-strong);padding-left:8px}\n.pbebl-table td[data-label="Range"] small{max-width:340px}\n@media (max-width:768px){.pbebl-week+.pbebl-week{margin-top:8px;padding-top:14px}.pbebl-table td[data-label="Range"] small{max-width:none}}\n`;
}
write(cssPath, css);

// 6) Contract tests.
const overlayTestPath = 'research/best-line-model-overlay.test.mjs';
let overlayTest = read(overlayTestPath);
overlayTest = once(
  overlayTest,
  `test('non-Pro and missing-signal states are explicit and fail closed', () => {\n  assert.match(src, /Model layer locked/);\n  assert.match(src, /No active signal/);\n  assert.match(src, /Best Line will not invent one/);\n  assert.match(src, /No model value is guessed/);\n});`,
  `test('inactive model markets use one canonical dash while access errors stay explicit', () => {\n  assert.match(src, /Model layer locked/);\n  assert.match(src, /pbebl-na\\\">—/);\n  assert.doesNotMatch(src, /No active signal/);\n  assert.doesNotMatch(src, /Best Line will not invent one/);\n  assert.match(src, /No model value is guessed/);\n});`,
  'overlay empty-state contract',
);
write(overlayTestPath, overlayTest);

const workerTestPath = 'tests/nfl-intel-worker.test.mjs';
let workerTest = read(workerTestPath);
workerTest = between(
  workerTest,
  `test('GET /api/best-line keeps fair value and edge empty and names the snapshot age', async () => {`,
  `test('manual lane run requires the admin token', async () => {`,
  `test('GET /api/best-line carries week boundaries and explains market-specific book coverage', async () => {\n  const snap = { semantics: 'LAST_VERIFIED_MARKET', captured_at: '2026-09-11T12:00:00Z', captured_at_et: 'Sep 11, 8:00 AM ET', age_seconds: 3600, ingest: { status: 'OK' }, events: [\n    { id: 'e1', commence_time: new Date(Date.now() + 2 * 86400000).toISOString(), away_team: 'Tampa Bay Buccaneers', home_team: 'Cincinnati Bengals', bookmakers: [\n      { key: 'dk', title: 'DraftKings', markets: [{ key: 'h2h', outcomes: [{ name: 'Tampa Bay Buccaneers', price: 150 }, { name: 'Cincinnati Bengals', price: -175 }] }] },\n      { key: 'lowvig', title: 'LowVig.ag', markets: [{ key: 'spreads', outcomes: [{ name: 'Tampa Bay Buccaneers', point: 0, price: -110 }, { name: 'Cincinnati Bengals', point: 0, price: -110 }] }] }\n    ] }\n  ] };\n  const env = { NFL_ODDS: { fetch: async () => respond(snap) }, NFL_CURRENT: currentBinding };\n  const res = await worker.fetch(new Request('https://x/api/best-line'), env, {});\n  const body = await res.json();\n  assert.equal(body.window_days, 8, 'absent days is the default window, not one day');\n  assert.equal(body.price_semantics, 'SCHEDULED_SNAPSHOT_NOT_LIVE');\n  assert.equal(body.current_week, 1);\n  assert.equal(body.events[0].week, 1);\n  assert.equal(body.events[0].books, 2, 'event header counts every book represented in the snapshot');\n  const side = body.events[0].markets.moneyline['Tampa Bay Buccaneers'];\n  assert.equal(side.best.price, 150);\n  assert.equal(side.book_count, 1);\n  assert.equal(side.coverage.event_book_count, 2);\n  assert.equal(side.coverage.market_book_count, 1);\n  assert.deepEqual(side.coverage.pickem_spread_books, ['LowVig.ag']);\n  assert.equal(side.pbe_fair, null);\n  assert.equal(side.model_edge, null);\n});\n\n`,
  'best line worker contract',
);
write(workerTestPath, workerTest);

console.log('Best Line integrity UI repair applied');
