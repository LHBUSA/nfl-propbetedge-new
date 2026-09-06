/* PBE BREAKING — deterministic fixture harness.
 * node scripts/breaking-fixtures.mjs [widths] [outDir]
 *
 * Drives every event path with fixed data rather than waiting for a storm, a
 * touchdown or a wire story. The live pollers are stopped first, so nothing
 * observed here came from the network: each state is injected, rendered,
 * asserted against the real DOM, and photographed.
 *
 * It also proves the two things that only show up when surfaces coexist:
 * the rail never overlaps the navigation, and the Player DNA switcher still
 * sits above everything while an alert is on screen.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WIDTHS = (process.argv[2] || '1440,390').split(',').map(Number);
const OUT = process.argv[3] || 'shots/breaking';
const PORT = process.env.PBE_PORT || '4321';
const TARGET = process.env.PBE_BASE || `http://localhost:${PORT}`;
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DP = 9500 + Math.floor(Math.random() * 90);

mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-brk-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${DP}`, `--user-data-dir=${dir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
function finish(c) { try { chrome.kill(); } catch {} setTimeout(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(c); }, 200); }
setTimeout(() => { console.error('DEADLINE'); finish(3); }, 600000).unref?.();

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
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails?.exception?.description
      || m.params.exceptionDetails?.text || 'exception');
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
  }
};
await send('Runtime.enable'); await send('Page.enable');
const evalIn = async (expr, ms = 30000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
    sleep(ms).then(() => { throw new Error('WEDGED: ' + expr.slice(0, 70)); })
  ]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' +
    (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
};

/* ---- FIXTURES ----------------------------------------------------------
   All timestamps are computed in-page relative to now, so "recent" stays
   recent whenever this is run. */
const FIXTURES = `
(() => {
const nowIso = m => new Date(Date.now() - m * 60000).toISOString();

window.FX = {
  // 1. a breaking injury headline — qualifies through is_breaking
  breakingInjury: {
    id: 'fx-injury-1', title: 'Chiefs rule out starting quarterback for Sunday with ankle injury',
    summary: 'A generated dek that must never reach the rail.',
    url: 'https://propbetedge.ai/news/nfl/chiefs-qb-ruled-out',
    source: 'PropBetEdge', published_at: nowIso(12), topic_kind: 'injury',
    teams: ['KC'], players: ['Patrick Mahomes'], impact_score: 94, is_breaking: true
  },
  // 2. a high-impact trade — qualifies through impact_score, not is_breaking
  highImpactTrade: {
    id: 'fx-trade-1', title: 'Jets trade All-Pro cornerback to the Rams for a first-round pick',
    url: 'https://propbetedge.ai/news/nfl/jets-trade-cb',
    source: 'PropBetEdge', published_at: nowIso(22), topic_kind: 'trade',
    teams: ['NYJ','LAR'], players: [], impact_score: 86, is_breaking: false
  },
  // 3. ordinary news — MUST NOT SHOW
  ordinary: {
    id: 'fx-ordinary-1', title: 'Five things to watch in Sunday\\u2019s early window',
    url: 'https://propbetedge.ai/news/nfl/five-things',
    source: 'PropBetEdge', published_at: nowIso(30), topic_kind: 'preview',
    teams: [], players: [], impact_score: 41, is_breaking: false
  },
  // 3b. high impact but STALE — MUST NOT SHOW
  staleHighImpact: {
    id: 'fx-stale-1', title: 'Star receiver expected to return from injured reserve',
    url: 'https://propbetedge.ai/news/nfl/wr-returns',
    source: 'PropBetEdge', published_at: nowIso(600), topic_kind: 'injury',
    teams: ['MIN'], players: [], impact_score: 91, is_breaking: false
  },
  // 3c. breaking but STALE — MUST NOT SHOW
  staleBreaking: {
    id: 'fx-stale-2', title: 'Veteran guard signs with the Broncos',
    url: 'https://propbetedge.ai/news/nfl/guard-signs',
    source: 'PropBetEdge', published_at: nowIso(400), topic_kind: 'signing',
    teams: ['DEN'], players: [], impact_score: 55, is_breaking: true
  },
  // 4. the CORRUPTED payload: one duplicated fallback dek and an injected
  //    player tag on an unrelated story. This is the real measured defect.
  corrupted: [
    { id: 'fx-corrupt-a', title: 'Rams place defensive lineman on injured reserve',
      summary: 'Kansas City\\u2019s quarterback cleared nine months after ACL surgery and is expected to start.',
      url: 'https://propbetedge.ai/news/nfl/rams-dl-ir', source: 'Wire',
      published_at: nowIso(9), teams: ['LAR'], players: ['Patrick Mahomes'],
      impact_score: 84, is_breaking: true },
    { id: 'fx-corrupt-b', title: 'Raiders sign practice squad tight end',
      summary: 'Kansas City\\u2019s quarterback cleared nine months after ACL surgery and is expected to start.',
      url: 'https://propbetedge.ai/news/nfl/raiders-ts', source: 'Wire',
      published_at: nowIso(11), teams: ['LV'], players: ['Patrick Mahomes'],
      impact_score: 82, is_breaking: true }
  ],

  // 5-7. live scoreboard payloads
  touchdown: { games: [{ id: 'g-401', status: { semantics: 'LIVE', period: 4, clock: '2:14' },
    teams: { home: { abbreviation: 'KC', score: 21 }, away: { abbreviation: 'BUF', score: 24 } },
    situation: { last_play: { id: 'p-771', scoring_play: true, score_value: 6,
      type: 'Passing Touchdown', period: 4, clock: '2:14',
      text: 'Josh Allen 38 yard pass to Keon Coleman for a touchdown',
      home_score: 21, away_score: 24,
      participants: [{ id: '3918298', name: 'Josh Allen', position: 'QB',
        headshot: 'https://a.espncdn.com/i/headshots/nfl/players/full/3918298.png' }] } } }] },

  fieldGoal: { games: [{ id: 'g-402', status: { semantics: 'LIVE', period: 2, clock: '0:03' },
    teams: { home: { abbreviation: 'GB', score: 10 }, away: { abbreviation: 'CHI', score: 13 } },
    situation: { last_play: { id: 'p-412', scoring_play: true, score_value: 3,
      type: 'Field Goal Good', period: 2, clock: '0:03',
      text: 'Cairo Santos 47 yard field goal is good', home_score: 10, away_score: 13,
      participants: [] } } }] },

  extraPoint: { games: [{ id: 'g-403', status: { semantics: 'LIVE', period: 3, clock: '8:40' },
    teams: { home: { abbreviation: 'DAL', score: 14 }, away: { abbreviation: 'PHI', score: 17 } },
    situation: { last_play: { id: 'p-333', scoring_play: true, score_value: 1,
      type: 'Extra Point Good', period: 3, clock: '8:40',
      text: 'Brandon Aubrey extra point is good', home_score: 14, away_score: 17,
      participants: [] } } }] },

  unclassifiedScore: { games: [{ id: 'g-404', status: { semantics: 'LIVE', period: 1, clock: '5:00' },
    teams: { home: { abbreviation: 'SEA', score: 6 }, away: { abbreviation: 'SF', score: 0 } },
    situation: { last_play: { id: 'p-909', scoring_play: true, score_value: null,
      type: '', period: 1, clock: '5:00',
      text: 'Blocked punt recovered in the end zone', home_score: 6, away_score: 0,
      participants: [] } } }] },

  // 9. a game reaching FINAL
  liveBeforeFinal: { games: [{ id: 'g-405', status: { semantics: 'LIVE', period: 4, clock: '0:20' },
    teams: { home: { abbreviation: 'BUF', score: 28 }, away: { abbreviation: 'KC', score: 31 } },
    situation: { last_play: null } }] },
  final: { games: [{ id: 'g-405', status: { semantics: 'FINAL', period: 4, clock: '0:00' },
    teams: { home: { abbreviation: 'BUF', score: 28 }, away: { abbreviation: 'KC', score: 31 } },
    situation: { last_play: null } }] },

  // weather events, in the shape /api/weather-watch emits
  wxGame: { game_id: 'wx-1', event_id: 'wx-1', matchup: 'BUF @ NE', home_team: 'NE',
    away_team: 'BUF', kickoff_utc: new Date(Date.now() + 5 * 3600000).toISOString(),
    venue: 'Gillette Stadium',
    roof: { state: 'OUTDOOR', weather_applies: true, label: 'Outdoor' } },

  wxWindow: { temp_f: 27, apparent_temp_f: 19, precip_probability_pct: 78,
    rain_in: 0, snowfall_in: 1.8, wind_mph: 19, gust_mph: 28,
    window_local: ['2026-01-11T19:00','2026-01-11T23:00'], hours_resolved: 5, hours_requested: 5,
    weather_family: 'snow', kind: 'forecast' }
};

window.FX.snowWatch = {
  kind: 'WEATHER_WATCH', official: false, event_key: 'wx-watch:wx-1:watch/watch/freezing/likely/none',
  label: 'WEATHER WATCH', headline: 'SNOW FORECAST',
  window: window.FX.wxWindow, bands: { wind:'watch', gust:'watch', cold:'freezing', snow:'likely', rain:'none' },
  cta: { label: 'VIEW WEATHER' }, game: window.FX.wxGame,
  provenance: { source: 'Open-Meteo forecast', kind: 'forecast',
    attribution: 'Weather data by Open-Meteo.com, licensed CC BY 4.0',
    semantics: 'FORECAST — modelled values for the kickoff window. Not an observation.' }
};

window.FX.rainWatch = {
  kind: 'WEATHER_WATCH', official: false, event_key: 'wx-watch:wx-2:none/none/none/none/heavy',
  label: 'WEATHER WATCH', headline: 'HEAVY RAIN',
  window: { temp_f: 58, apparent_temp_f: 55, precip_probability_pct: 88, rain_in: 0.62,
    snowfall_in: 0, wind_mph: 12, gust_mph: 19, window_local: ['2026-01-11T12:00','2026-01-11T16:00'],
    hours_resolved: 5, hours_requested: 5, weather_family: 'rain', kind: 'forecast' },
  bands: { wind:'none', gust:'none', cold:'none', snow:'none', rain:'heavy' },
  cta: { label: 'VIEW WEATHER' },
  game: { ...window.FX.wxGame, game_id: 'wx-2', event_id: 'wx-2', matchup: 'MIA @ NYJ',
          home_team: 'NYJ', away_team: 'MIA', venue: 'MetLife Stadium' },
  provenance: { source: 'Open-Meteo forecast', kind: 'forecast',
    attribution: 'Weather data by Open-Meteo.com, licensed CC BY 4.0',
    semantics: 'FORECAST — modelled values for the kickoff window. Not an observation.' }
};

window.FX.windShift = {
  kind: 'WEATHER_SHIFT', official: false, event_key: 'wx-shift:wx-3:elevated/elevated/none/none/none',
  label: 'WEATHER SHIFT', headline: 'WIND FORECAST RISING',
  changes: [{ field: 'wind', from: 13, to: 22, copy: 'WIND FORECAST RISING', delta: 9, unit: 'mph' },
            { field: 'gust', from: 18, to: 34, copy: 'GUSTS RISING', delta: 16, unit: 'mph' }],
  window: { temp_f: 41, apparent_temp_f: 33, precip_probability_pct: 20, rain_in: 0,
    snowfall_in: 0, wind_mph: 22, gust_mph: 34, window_local: ['2026-01-11T12:00','2026-01-11T16:00'],
    hours_resolved: 5, hours_requested: 5, weather_family: 'cloud', kind: 'forecast' },
  bands: { wind:'elevated', gust:'elevated', cold:'none', snow:'none', rain:'none' },
  cta: { label: 'VIEW GAME CONTEXT' },
  game: { ...window.FX.wxGame, game_id: 'wx-3', event_id: 'wx-3', matchup: 'GB @ CHI',
          home_team: 'CHI', away_team: 'GB', venue: 'Soldier Field' },
  provenance: { source: 'Open-Meteo forecast', kind: 'forecast',
    attribution: 'Weather data by Open-Meteo.com, licensed CC BY 4.0',
    semantics: 'FORECAST — modelled values for the kickoff window. Not an observation.' }
};

window.FX.nwsWarning = {
  kind: 'WEATHER_ALERT', official: true, event_key: 'nws:wx-4:urn-oid-winter-1',
  label: 'NWS WEATHER ALERT', headline: 'Winter Storm Warning',
  detail: 'Winter Storm Warning issued January 11 at 3:04AM MST until January 12 at 11:00PM MST by NWS Denver',
  severity: 'Severe', certainty: 'Likely', urgency: 'Expected',
  expires: new Date(Date.now() + 8 * 3600000).toISOString(),
  cta: { label: 'VIEW OFFICIAL ALERT', href: 'https://api.weather.gov/alerts/urn:oid:winter-1',
         external: true },
  game: { ...window.FX.wxGame, game_id: 'wx-4', event_id: 'wx-4', matchup: 'KC @ DEN',
          home_team: 'DEN', away_team: 'KC', venue: 'Empower Field at Mile High' },
  provenance: { source: 'National Weather Service', alert_id: 'urn:oid:winter-1',
                kind: 'official_alert' }
};
return 'FIXTURES READY';
})()
`;

/* ---- helpers ------------------------------------------------------------ */

const RESET = `(() => {
  const B = window.PBEBreaking;
  B.stop();
  B.state.queue.length = 0;
  B.state.current = null;
  B.state.seen.clear(); B.state.dismissed.clear();
  B.state.lastPlay.clear(); B.state.lastStatus.clear();
  try { sessionStorage.removeItem(B.CONFIG.storage_key);
        sessionStorage.removeItem(B.CONFIG.dismiss_key); } catch {}
  B._test.render();
  return true;
})()`;

/* What the rail is actually showing, read from the DOM rather than from state. */
const READ = `(() => {
  const slot = document.getElementById('pbe-breaking-slot');
  const el = slot && slot.querySelector('.pbeb');
  const B = window.PBEBreaking;
  const r = slot ? slot.getBoundingClientRect() : null;
  /* A DISPLAYED element only. Below 900px the shell hides its primary nav row,
     and a hidden element reports a rect of all zeros — comparing against that
     makes the overlap test trivially true and the assertion meaningless. This
     is the same trap the nav gate hit: measure what is painted, not what is
     in the DOM. */
  const shown = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    if (getComputedStyle(el).display === 'none') return null;
    return r;
  };
  const nr = shown(document.querySelector('.pbes-primary'));
  const sr = shown(document.querySelector('.pbes-scorebar'));
  return {
    visible: Boolean(el),
    hidden: slot ? slot.hidden : null,
    height: r ? Math.round(r.height) : null,
    tone: el ? el.dataset.tone : null,
    key: el ? (el.querySelector('.pbeb-key')||{}).textContent?.replace(/\\s+/g,' ').trim() : null,
    headline: el ? (el.querySelector('.pbeb-headline')||{}).textContent?.trim() : null,
    tag: el ? (el.querySelector('.pbeb-tag')||{}).textContent?.trim() : null,
    play: el ? (el.querySelector('.pbeb-play span')||{}).textContent?.trim() : null,
    meta: el ? (el.querySelector('.pbeb-meta')||{}).textContent?.replace(/\\s+/g,' ').trim() : null,
    nwsText: el ? (el.querySelector('.pbeb-nws')||{}).textContent?.trim() : null,
    shift: el ? (el.querySelector('.pbeb-shift')||{}).textContent?.replace(/\\s+/g,' ').trim() : null,
    ctas: el ? [...el.querySelectorAll('.pbeb-cta')].map(b=>b.textContent.replace(/\\s+/g,' ').trim()) : [],
    imgs: el ? [...el.querySelectorAll('img')].map(i=>({src:i.getAttribute('src'),
            ok:i.complete && i.naturalWidth>0, broken:i.classList.contains('is-broken')})) : [],
    queued: B.state.queue.length,
    queueKeys: B.state.queue.map(q=>q.key),
    currentKey: B.state.current ? B.state.current.key : null,
    /* the two structural guarantees */
    navMeasured: Boolean(nr), scoreMeasured: Boolean(sr),
    overlapsNav: Boolean(r && nr && r.height>0 && r.bottom > nr.top + 1),
    overlapsScore: Boolean(r && sr && r.height>0 && r.bottom > sr.top + 1),
    docOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    summaryRendered: el ? /generated dek|ACL surgery/i.test(el.textContent) : false,
    text: el ? el.textContent.replace(/\\s+/g,' ').trim().slice(0,300) : ''
  };
})()`;

const results = [];
let failures = 0;
function check(name, cond, detail) {
  results.push({ name, pass: Boolean(cond), detail: detail || '' });
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/* Wait for every image in the rail to settle before judging it. Reading
   naturalWidth the instant after render measures the network, not the code. */
const SETTLE = `(async () => {
  const imgs = [...document.querySelectorAll('#pbe-breaking-slot img')];
  await Promise.all(imgs.map(i => i.complete ? null : new Promise(r => {
    i.addEventListener('load', r, { once: true });
    i.addEventListener('error', r, { once: true });
    setTimeout(r, 4000);
  })));
  return imgs.length;
})()`;

async function shot(name) {
  const cap = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(cap.data, 'base64'));
}

/* ---- run ---------------------------------------------------------------- */

for (const width of WIDTHS) {
  console.log(`\n================ ${width}px ================`);
  await send('Emulation.setDeviceMetricsOverride',
    { width, height: width <= 768 ? 844 : 900, deviceScaleFactor: 1, mobile: width <= 768 });
  await send('Page.navigate', { url: `${TARGET}/#home?t=${Date.now()}` });
  await sleep(15000);
  await evalIn(FIXTURES);
  const ready = await evalIn(`Boolean(window.PBEBreaking && window.PBEBreaking._test)`);
  check('the breaking module is loaded and mounted', ready);
  if (!ready) continue;

  /* ---------- 10. NO ALERTS -------------------------------------------- */
  await evalIn(RESET);
  let m = await evalIn(READ);
  check('fixture 10 — with nothing qualifying the rail is ABSENT and zero height',
    !m.visible && m.hidden === true && (m.height === 0 || m.height === null),
    `hidden=${m.hidden} height=${m.height}`);
  await shot(`00-silent-${width}`);

  /* ---------- 1. BREAKING INJURY --------------------------------------- */
  await evalIn(`(()=>{const B=window.PBEBreaking;
    if(window.PBENewsTrust) PBENewsTrust.prepare([window.FX.breakingInjury]);
    const q=B._test.qualifyNews(window.FX.breakingInjury);
    return B.offer(B._test.newsEvent(window.FX.breakingInjury,q));})()`);
  await evalIn(SETTLE, 15000);
  m = await evalIn(READ);
  check('fixture 1 — a breaking injury headline SHOWS as NFL BREAKING',
    m.visible && m.tone === 'news' && /NFL BREAKING/.test(m.key || ''), m.key);
  check('  the rail renders the TITLE, not the upstream dek',
    m.headline && m.headline.startsWith('Chiefs rule out') && !m.summaryRendered);
  check('  source and time travel with it', /PropBetEdge/.test(m.meta || '') && /ago|just now/.test(m.meta || ''));
  check('  the canonical PropBetEdge article is the primary action',
    (m.ctas[0] || '').startsWith('READ UPDATE'), m.ctas.join(' | '));
  check('  the rail does not overlap the navigation', !m.overlapsNav,
    m.navMeasured ? 'nav measured' : 'nav not painted at this width');
  check('  the rail does not overlap the scoreboard', !m.overlapsScore,
    m.scoreMeasured ? 'scoreboard measured' : 'scoreboard not painted at this width');
  check('  no horizontal document overflow', !m.docOverflowX);
  check('  every rendered image resolved', m.imgs.every(i => i.ok || i.broken),
    m.imgs.map(i => (i.ok ? 'ok' : 'BROKEN')).join(','));
  await shot(`01-nfl-breaking-${width}`);

  /* ---------- 3. ORDINARY NEWS MUST NOT SHOW --------------------------- */
  await evalIn(RESET);
  const ord = await evalIn(`(()=>{const B=window.PBEBreaking;
    return ['ordinary','staleHighImpact','staleBreaking'].map(k=>{
      const q=B._test.qualifyNews(window.FX[k]); return {k, ok:q.ok, reason:q.reason};});})()`);
  for (const o of ord) {
    check(`fixture 3 — "${o.k}" is REFUSED`, !o.ok, o.reason);
  }
  m = await evalIn(READ);
  check('  the rail stayed silent', !m.visible);

  /* ---------- 2. HIGH IMPACT TRADE ------------------------------------- */
  const trade = await evalIn(`(()=>{const B=window.PBEBreaking;
    const q=B._test.qualifyNews(window.FX.highImpactTrade);
    if(q.ok){ if(window.PBENewsTrust) PBENewsTrust.prepare([window.FX.highImpactTrade]);
      B.offer(B._test.newsEvent(window.FX.highImpactTrade,q)); }
    return q;})()`);
  check('fixture 2 — a high-impact trade qualifies through impact_score',
    trade.ok && trade.door === 'impact_score', trade.reason);

  /* ---------- 4. CORRUPTED PAYLOAD ------------------------------------- */
  await evalIn(RESET);
  const corrupt = await evalIn(`(()=>{const B=window.PBEBreaking;
    const items=window.FX.corrupted.map(x=>({...x}));
    PBENewsTrust.prepare(items);
    const out=[];
    for(const it of items){ const q=B._test.qualifyNews(it);
      if(q.ok){ const ev=B._test.newsEvent(it,q); B.offer(ev);
        out.push({title:it.title, players:ev.players,
                  trustPlayers:it._trust.players, suppressed:it._trust.summarySuppressed}); } }
    return out;})()`);
  check('fixture 4 — the duplicated fallback dek is detected and suppressed',
    corrupt.length === 2 && corrupt.every(c => c.suppressed),
    corrupt.map(c => c.suppressed).join(','));
  check('fixture 4 — the injected player tag NEVER reaches the rail',
    corrupt.every(c => c.players.length === 0),
    corrupt.map(c => `${c.title.slice(0, 22)}→[${c.players}]`).join(' | '));
  m = await evalIn(READ);
  check('  no Mahomes text on a Rams or Raiders story', !/Mahomes/i.test(m.text), m.text.slice(0, 90));
  check('  and no summary text at all', !m.summaryRendered);

  /* ---------- 5. TOUCHDOWN --------------------------------------------- */
  await evalIn(RESET);
  await evalIn(`window.PBEBreaking._test.ingestScoreboard(window.FX.touchdown)`);
  await evalIn(SETTLE, 15000);
  m = await evalIn(READ);
  check('fixture 5 — a touchdown SHOWS as GAME BREAK · LIVE',
    m.visible && m.tone === 'game' && /GAME BREAK/.test(m.key || '') && /LIVE/.test(m.key || ''), m.key);
  check('  it is labelled TOUCHDOWN from the structured play type', m.tag === 'TOUCHDOWN', m.tag);
  check('  the published play text is shown verbatim',
    m.play === 'Josh Allen 38 yard pass to Keon Coleman for a touchdown', m.play);
  check('  real crests and a real participant headshot rendered',
    m.imgs.length >= 3 && m.imgs.every(i => i.ok),
    m.imgs.map(i => (i.ok ? 'ok' : 'BROKEN ' + i.src)).join(', '));
  check('  PBEcast is the action', /PBECAST/.test(m.ctas.join(' ')), m.ctas.join(' | '));
  check('  no overlap with the nav or scoreboard', !m.overlapsNav && !m.overlapsScore,
    `nav ${m.navMeasured ? 'measured' : 'not painted'}, scoreboard ${m.scoreMeasured ? 'measured' : 'not painted'}`);
  await shot(`02-game-break-${width}`);

  /* ---------- 7. DUPLICATE POLL ---------------------------------------- */
  const dupe = await evalIn(`(()=>{const B=window.PBEBreaking;
    const before={cur:B.state.current&&B.state.current.key, q:B.state.queue.length};
    B._test.ingestScoreboard(window.FX.touchdown);
    B._test.ingestScoreboard(window.FX.touchdown);
    return {before, after:{cur:B.state.current&&B.state.current.key, q:B.state.queue.length}};})()`);
  check('fixture 7 — re-polling the SAME touchdown shows nothing again',
    dupe.after.q === dupe.before.q && dupe.after.cur === dupe.before.cur,
    `queue ${dupe.before.q}→${dupe.after.q}`);

  /* ---------- 6. FIELD GOAL, and XP suppression ------------------------ */
  await evalIn(RESET);
  await evalIn(`window.PBEBreaking._test.ingestScoreboard(window.FX.fieldGoal)`);
  m = await evalIn(READ);
  check('fixture 6 — a field goal SHOWS and is labelled FIELD GOAL',
    m.visible && m.tag === 'FIELD GOAL', m.tag);

  await evalIn(RESET);
  await evalIn(`window.PBEBreaking._test.ingestScoreboard(window.FX.extraPoint)`);
  m = await evalIn(READ);
  check('an ordinary extra point does NOT take the global rail', !m.visible);

  await evalIn(RESET);
  await evalIn(`window.PBEBreaking._test.ingestScoreboard(window.FX.unclassifiedScore)`);
  m = await evalIn(READ);
  check('an unclassifiable scoring play shows its PUBLISHED TEXT without inventing a label',
    m.visible && m.tag === 'SCORING PLAY'
      && m.play === 'Blocked punt recovered in the end zone', `${m.tag} / ${m.play}`);

  /* ---------- 9. FINAL -------------------------------------------------- */
  await evalIn(RESET);
  await evalIn(`window.PBEBreaking._test.ingestScoreboard(window.FX.liveBeforeFinal)`);
  await evalIn(`window.PBEBreaking._test.ingestScoreboard(window.FX.final)`);
  m = await evalIn(READ);
  check('fixture 9 — a game reaching FINAL shows as GAME FINAL, not BREAKING',
    m.visible && m.tone === 'final' && /GAME FINAL/.test(m.key || '')
      && !/BREAKING/i.test(m.key || ''), m.key);
  check('  it reports the result and nothing more',
    /KC 31/.test(m.text) && /BUF 28/.test(m.text)
      && !/(comeback|upset|game-winning|thriller)/i.test(m.text), m.text.slice(0, 80));

  /* ---------- 8. SIMULTANEOUS TD + BREAKING NEWS ----------------------- */
  await evalIn(RESET);
  await evalIn(`window.PBEBreaking._test.ingestScoreboard(window.FX.touchdown)`);
  await sleep(4500);   // let the minimum dwell elapse; preemption is not a yank
  const both = await evalIn(`(()=>{const B=window.PBEBreaking;
    if(window.PBENewsTrust) PBENewsTrust.prepare([window.FX.breakingInjury]);
    const q=B._test.qualifyNews(window.FX.breakingInjury);
    B.offer(B._test.newsEvent(window.FX.breakingInjury,q));
    return { current:B.state.current.key, currentPriority:B.state.current.priority,
             queue:B.state.queue.map(x=>({k:x.key,p:x.priority})) };})()`);
  check('fixture 8 — with a touchdown and major breaking news together, NEWS wins the rail',
    both.current.startsWith('news:'), `${both.current} (p${both.currentPriority})`);
  check('  and the touchdown QUEUES rather than stacking a second banner',
    both.queue.length === 1 && both.queue[0].k.startsWith('play:'),
    JSON.stringify(both.queue));
  m = await evalIn(READ);
  check('  exactly one rail element exists', m.visible && m.queued === 1);

  /* ---------- SUNDAY FLOOD CONTROL ------------------------------------- */
  await evalIn(RESET);
  const flood = await evalIn(`(()=>{const B=window.PBEBreaking; const res=[];
    // eight simultaneous scoring plays plus two low-value weather watches
    for(let i=0;i<8;i++){
      res.push(B.offer({key:'play:flood-'+i, family:'GAME', kind:'GAME_BREAK',
        priority:B.PRIORITY.GAME_BREAK, label:'GAME BREAK', headline:'TOUCHDOWN',
        game:{id:'g'+i,home:{abbr:'KC',score:7},away:{abbr:'BUF',score:0}},
        cta:[{label:'WATCH IN PBECAST',route:'pbecast'}], visible_ms:16000, provenance:{}}));
    }
    for(let i=0;i<2;i++){
      res.push(B.offer({key:'wx:flood-'+i, family:'WEATHER', kind:'WEATHER_WATCH',
        priority:B.PRIORITY.WEATHER_WATCH, label:'WEATHER WATCH', headline:'RAIN LIKELY',
        game:{game_id:'w'+i,home_team:'NYJ',away_team:'MIA'},
        cta:[{label:'VIEW WEATHER',kind:'weather-detail'}], visible_ms:18000, provenance:{}}));
    }
    return { queue:B.state.queue.length, max:B.CONFIG.queue_max,
             kinds:B.state.queue.map(x=>x.kind), dropped:res.reduce((a,r)=>a+(r.dropped||0),0) };})()`);
  check('Sunday flood — the queue is capped',
    flood.queue <= flood.max, `queue=${flood.queue} max=${flood.max}`);
  check('  and the low-value weather watches are the ones dropped',
    !flood.kinds.includes('WEATHER_WATCH'), flood.kinds.join(','));

  /* ---------- PRIORITY ORDER ------------------------------------------- */
  await evalIn(RESET);
  const prio = await evalIn(`(()=>{const B=window.PBEBreaking; const P=B.PRIORITY;
    return { nws:P.NWS_EMERGENCY, major:P.NFL_BREAKING_MAJOR, game:P.GAME_BREAK,
             shift:P.WEATHER_SHIFT, news:P.NFL_BREAKING, watch:P.WEATHER_WATCH,
             final:P.GAME_FINAL };})()`);
  check('priority order: NWS emergency > major news > game break > shift > news > watch > final',
    prio.nws < prio.major && prio.major < prio.game && prio.game < prio.shift
      && prio.shift < prio.news && prio.news < prio.watch && prio.watch < prio.final,
    JSON.stringify(prio));

  const displace = await evalIn(`(()=>{const B=window.PBEBreaking;
    B.state.queue.length=0; B.state.current=null; B.state.seen.clear();
    B.offer(B._test.weatherEventToRail(window.FX.rainWatch));
    const afterRain = B.state.current.kind;
    if(window.PBENewsTrust) PBENewsTrust.prepare([window.FX.breakingInjury]);
    const q=B._test.qualifyNews(window.FX.breakingInjury);
    B.offer(B._test.newsEvent(window.FX.breakingInjury,q));
    return { afterRain, queued:B.state.queue.map(x=>x.kind) };})()`);
  check('a routine rain watch does not displace a star QB ruled out',
    displace.afterRain === 'WEATHER_WATCH' && displace.queued.includes('NFL_BREAKING'),
    JSON.stringify(displace));

  /* ---------- DISMISS BY EVENT ID -------------------------------------- */
  await evalIn(RESET);
  const dism = await evalIn(`(()=>{const B=window.PBEBreaking;
    B._test.ingestScoreboard(window.FX.touchdown);
    const key=B.state.current.key;
    B.dismiss();
    const readd=B.offer({key, family:'GAME', kind:'GAME_BREAK', priority:3, label:'GAME BREAK',
      headline:'TOUCHDOWN', game:{id:'x',home:{abbr:'KC'},away:{abbr:'BUF'}}, cta:[], visible_ms:1, provenance:{}});
    const other=B.offer({key:'play:other', family:'GAME', kind:'GAME_BREAK', priority:3,
      label:'GAME BREAK', headline:'TOUCHDOWN',
      game:{id:'y',home:{abbr:'GB',score:7},away:{abbr:'CHI',score:0}},
      cta:[{label:'WATCH IN PBECAST',route:'pbecast'}], visible_ms:16000, provenance:{}});
    return { readd, other, current:B.state.current&&B.state.current.key };})()`);
  check('dismissal is BY EVENT ID — the same event cannot return',
    dism.readd.accepted === false && /dismissed/.test(dism.readd.reason), dism.readd.reason);
  check('  but a DIFFERENT event still can',
    dism.other.accepted === true && dism.current === 'play:other', dism.current);

  /* ---------- ROUTE CHANGE MUST NOT REPLAY ----------------------------- */
  await evalIn(RESET);
  await evalIn(`window.PBEBreaking._test.ingestScoreboard(window.FX.touchdown)`);
  await evalIn(`window.App && App.nav('wrdna')`); await sleep(3500);
  await evalIn(`window.App && App.nav('propboard')`); await sleep(3500);
  const replay = await evalIn(`(()=>{const B=window.PBEBreaking;
    const before=B.state.seen.size;
    B._test.ingestScoreboard(window.FX.touchdown);
    return { before, after:B.state.seen.size, queue:B.state.queue.length,
             route: location.hash };})()`);
  check('changing route does NOT replay the same alert',
    replay.after === replay.before && replay.queue === 0,
    `seen ${replay.before}→${replay.after}, queue ${replay.queue}, route ${replay.route}`);
  await evalIn(`window.App && App.nav('home')`); await sleep(3000);

  /* ---------- WEATHER STATES ------------------------------------------- */
  for (const [fx, name] of [['snowWatch', '03-snow-watch'], ['rainWatch', '04-rain-watch'],
                            ['windShift', '05-wind-shift'], ['nwsWarning', '06-nws-warning']]) {
    await evalIn(RESET);
    await evalIn(`(()=>{const B=window.PBEBreaking;
      return B.offer(B._test.weatherEventToRail(window.FX.${fx}));})()`);
    await evalIn(SETTLE, 15000);
    m = await evalIn(READ);
    check(`${fx} renders`, m.visible, `${m.key} | ${m.tag || ''} ${m.shift || ''}`);
    check(`  ${fx} does not overlap nav or scoreboard`, !m.overlapsNav && !m.overlapsScore,
      `nav ${m.navMeasured ? 'measured' : 'not painted'}, scoreboard ${m.scoreMeasured ? 'measured' : 'not painted'}`);
    check(`  ${fx} causes no horizontal overflow`, !m.docOverflowX);
    check(`  ${fx} crests resolved`, m.imgs.every(i => i.ok),
      m.imgs.filter(i => !i.ok).map(i => i.src).join(','));
    await shot(`${name}-${width}`);
  }

  /* the NWS card must carry the official wording untouched */
  await evalIn(RESET);
  await evalIn(`(()=>{const B=window.PBEBreaking;
    return B.offer(B._test.weatherEventToRail(window.FX.nwsWarning));})()`);
  m = await evalIn(READ);
  check('the NWS warning carries the official headline verbatim',
    (m.nwsText || '').includes('Winter Storm Warning issued January 11'), m.nwsText);
  check('the NWS card names the National Weather Service',
    /National Weather Service/.test(m.text));
  check('the primary action opens the OFFICIAL alert',
    /VIEW OFFICIAL ALERT/.test(m.ctas.join(' ')), m.ctas.join(' | '));

  /* ---------- WEATHER DETAIL DRAWER ------------------------------------ */
  await evalIn(RESET);
  await evalIn(`(()=>{const B=window.PBEBreaking;
    B.offer(B._test.weatherEventToRail(window.FX.snowWatch));
    return B._test.openWeatherDetail(B.state.current);})()`, 30000);
  await sleep(2500);
  const drawer = await evalIn(`(()=>{
    const p=document.querySelector('.pbeb-panel');
    if(!p) return {open:false};
    const r=p.getBoundingClientRect();
    const root=document.getElementById('pbe-player-dna-modal-root');
    const pts=[[r.left+r.width*0.5,r.top+12],[r.left+r.width*0.5,r.top+r.height*0.5]];
    const buried=pts.filter(([x,y])=>{const t=document.elementFromPoint(x,y);
      return t && !p.contains(t) && t!==p;});
    return { open:true, inRoot:Boolean(root&&root.contains(p)),
      rootIsBodyChild:Boolean(root&&root.parentElement===document.body),
      buried:buried.length, fits:r.width<=window.innerWidth+1,
      text:p.textContent.replace(/\\s+/g,' ').trim(),
      w:Math.round(r.width), h:Math.round(r.height) };})()`);
  check('the weather detail drawer opens', drawer.open);
  check('  it uses the SAME body-level modal root as the player switcher',
    drawer.inRoot && drawer.rootIsBodyChild);
  check('  nothing is painted over it', drawer.buried === 0);
  check('  it fits the viewport', drawer.fits, `${drawer.w}x${drawer.h} in ${width}`);
  check('  it states the forecast semantics, not an observation',
    /not an observation/i.test(drawer.text || ''));
  check('  it attributes Open-Meteo', /Open-Meteo/.test(drawer.text || ''));
  check('  it offers the Player DNA hand-off', /QB DNA/.test(drawer.text || ''));
  check('  it never claims a market effect',
    !/(the under|books will|line move|caused the line)/i.test(drawer.text || ''));
  await shot(`07-weather-drawer-${width}`);
  await evalIn(`document.querySelector('.pbeb-dx')?.click()`);
  await sleep(600);
  check('  closing the drawer releases the scroll lock',
    await evalIn(`document.body.style.overflow !== 'hidden' && !document.body.classList.contains('pdna-modal-open')`));

  /* ---------- THE DRAWER ANSWERS WHY / WHAT CHANGED / WHEN / WHO --------- */
  await evalIn(RESET);
  await evalIn(`(()=>{const B=window.PBEBreaking;
    B.offer(B._test.weatherEventToRail(window.FX.windShift));
    return B._test.openWeatherDetail(B.state.current);})()`, 30000);
  await sleep(2000);
  const shiftDrawer = await evalIn(`(()=>{const p=document.querySelector('.pbeb-panel'); if(!p) return {open:false};
    const lead=p.querySelector('.pbeb-dlead'), grid=p.querySelector('.pbeb-dgrid');
    const lr=lead&&lead.getBoundingClientRect(), gr=grid&&grid.getBoundingClientRect();
    return {open:true, tone:p.dataset.tone,
      leadText:lead?lead.textContent.replace(/\\s+/g,' ').trim():'',
      leadAboveGrid:Boolean(lr&&gr&&lr.top<gr.top),
      /* the first change is the drawer's hero fact; the rest are listed below it */
      deltas:[...p.querySelectorAll('.pbeb-dhero, .pbeb-ddelta-v')].map(x=>x.textContent.replace(/\\s+/g,' ').trim()),
      sub:(p.querySelector('.pbeb-dsub')||{}).textContent?.replace(/\\s+/g,' ').trim()||'',
      text:p.textContent.replace(/\\s+/g,' ').trim()};})()`);
  check('the SHIFT drawer opens with the shift tone', shiftDrawer.open && shiftDrawer.tone === 'shift');
  check('  it leads with WHAT CHANGED, above the forecast grid',
    /what changed/i.test(shiftDrawer.leadText) && shiftDrawer.leadAboveGrid, shiftDrawer.leadText.slice(0, 70));
  check('  the wind delta 13 → 22 mph is the hero fact', shiftDrawer.deltas.length > 0 && /13\s*→\s*22\s*mph/.test(shiftDrawer.deltas[0]), shiftDrawer.deltas.join(' | '));
  check('  the gust delta reads 18 → 34 mph', shiftDrawer.deltas.some(d => /18\s*→\s*34\s*mph/.test(d)));
  check('  it names the game, the stadium and the kickoff DAY',
    /GB @ CHI/.test(shiftDrawer.text) && /Soldier Field/.test(shiftDrawer.sub) && /Kickoff · \w{3}, \w{3} \d+ · /.test(shiftDrawer.sub), shiftDrawer.sub.slice(0, 90));
  check('  the window is a clock, not a raw ISO stamp',
    /Jan 11 · 12 PM – 4 PM local/.test(shiftDrawer.text) && !/T12:00/.test(shiftDrawer.text));
  await shot(`09-shift-drawer-${width}`);
  await evalIn(`window.PBEBreaking._test.closeWeatherDetail()`); await sleep(400);

  await evalIn(RESET);
  await evalIn(`(()=>{const B=window.PBEBreaking;
    B.offer(B._test.weatherEventToRail(window.FX.nwsWarning));
    return B._test.openWeatherDetail(B.state.current);})()`, 30000);
  await sleep(2000);
  const nwsDrawer = await evalIn(`(()=>{const p=document.querySelector('.pbeb-panel'); if(!p) return {open:false};
    return {open:true, tone:p.dataset.tone, text:p.textContent.replace(/\\s+/g,' ').trim(),
      cells:[...p.querySelectorAll('.pbeb-dnws-cell')].map(c=>c.textContent.replace(/\\s+/g,' ').trim())};})()`);
  check('the NWS drawer opens with the official tone', nwsDrawer.open && nwsDrawer.tone === 'nws');
  check('  it carries event, severity, certainty and urgency as published',
    /Winter Storm Warning/.test(nwsDrawer.text) && nwsDrawer.cells.some(c => /Severity\s*Severe/.test(c))
      && nwsDrawer.cells.some(c => /Certainty\s*Likely/.test(c)) && nwsDrawer.cells.some(c => /Urgency\s*Expected/.test(c)),
    nwsDrawer.cells.join(' | '));
  check('  the official wording is verbatim and the action is the official alert',
    /issued January 11 at 3:04AM MST/.test(nwsDrawer.text) && /VIEW OFFICIAL ALERT/.test(nwsDrawer.text));
  await shot(`10-nws-drawer-${width}`);
  await evalIn(`window.PBEBreaking._test.closeWeatherDetail()`); await sleep(400);

  /* ---------- WEATHER -> PLAYER DNA: real players for THIS game ---------- */
  await evalIn(RESET);
  await evalIn(`(()=>{const B=window.PBEBreaking;
    B.offer(B._test.weatherEventToRail(window.FX.snowWatch));
    return B._test.openWeatherDetail(B.state.current);})()`, 30000);
  await sleep(2000);
  const who = await evalIn(`(()=>{const p=document.querySelector('.pbeb-panel'); if(!p) return {open:false, chips:[]};
    const chips=[...p.querySelectorAll('.pbeb-chip[data-player]')].map(c=>({route:c.dataset.dna, id:c.dataset.player,
      text:c.textContent.replace(/\\s+/g,' ').trim(), face:Boolean(c.querySelector('img'))}));
    return {open:true, chips, lead:(p.querySelector('.pbeb-dlead-h')||{}).textContent||''};})()`);
  check('the WATCH drawer leads with the condition', /SNOW FORECAST/.test(who.lead), who.lead);
  check('  it resolves market-priced players for BUF and NE at all four positions',
    who.chips.length >= 4 && ['qbdna', 'wrdna', 'rbdna', 'tedna'].every(r => who.chips.some(c => c.route === r)),
    who.chips.map(c => `${c.route}:${c.text.slice(0, 16)}`).join(' | '));
  check('  every chip is a BUF or NE player with a real headshot',
    who.chips.length > 0 && who.chips.every(c => /(BUF|NE) ·/.test(c.text) && c.face));
  check('  the QB chip is Josh Allen — the one priced quarterback on that roster',
    who.chips.some(c => c.route === 'qbdna' && /Josh Allen/.test(c.text) && c.id === '00-0034857'));
  await evalIn(`document.querySelector('.pbeb-chip[data-player="00-0034857"]')?.click()`);
  await sleep(12000);
  const landed = await evalIn(`(()=>({route:location.hash, player:window.PBEQBDna&&PBEQBDna.state.playerId,
    drawerOpen:Boolean(document.querySelector('.pbeb-panel')), scrollLocked:document.body.style.overflow==='hidden',
    token:sessionStorage.getItem('pbe.playerdna.focus')}))()`);
  check('  the QB chip lands on QB DNA with Josh Allen selected',
    /qbdna/.test(landed.route) && landed.player === '00-0034857', `${landed.route} ${landed.player}`);
  check('  the drawer closed, the scroll lock released, the one-shot token consumed',
    !landed.drawerOpen && !landed.scrollLocked && !landed.token);
  await shot(`11-qbdna-from-weather-${width}`);

  /* ---------- GAME BREAK -> PBECAST focuses THAT game -------------------- */
  await evalIn(`window.App && App.nav('home')`); await sleep(3000);
  await evalIn(RESET);
  const cast = await evalIn(`(async()=>{
    const j=await (await fetch('/api/nfl-live')).json(); const games=j.games||[];
    if(games.length<2) return {skip:true, n:games.length};
    const g=games[games.length-1];
    const fx=JSON.parse(JSON.stringify(window.FX.touchdown)); fx.games[0].id=String(g.id);
    fx.games[0].teams.home.abbreviation=g.teams.home.abbreviation;
    fx.games[0].teams.away.abbreviation=g.teams.away.abbreviation;
    window.PBEBreaking._test.ingestScoreboard(fx);
    const cta=document.querySelector('#pbe-breaking-slot .pbeb-cta'); if(cta) cta.click();
    return {skip:false, id:String(g.id)};})()`, 20000);
  await sleep(9000);
  const castState = await evalIn(`(()=>({route:location.hash, active:window.PBEcastV6&&PBEcastV6.state.activeId,
    token:sessionStorage.getItem('pbe.pbecast.focus'),
    activeCard:(document.querySelector('.cast6-rail button.active')||{}).textContent?.replace(/\\s+/g,' ').trim()||''}))()`);
  if (cast.skip) console.log(`  (PBEcast focus check skipped: ${cast.n} games on the slate)`);
  else {
    check('GAME BREAK -> WATCH IN PBECAST lands on PBEcast', /pbecast/.test(castState.route), castState.route);
    check('  and focuses THAT game, not the default pick',
      castState.active === cast.id, `active ${castState.active}, expected ${cast.id} · ${castState.activeCard.slice(0, 40)}`);
    check('  the one-shot focus token was consumed', !castState.token);
  }
  await shot(`12-pbecast-from-gamebreak-${width}`);

  /* ---------- RB DNA and TE DNA under an active alert -------------------- */
  if (width >= 1280) {
    for (const [route, name] of [['rbdna', '13-rbdna-with-breaking'], ['tedna', '14-tedna-with-breaking']]) {
      await evalIn(`window.App && App.nav('${route}')`); await sleep(12000);
      await evalIn(`(()=>{const B=window.PBEBreaking; B.state.queue.length=0; B.state.current=null;
        B.state.seen.clear(); B.state.dismissed.clear();
        return B.offer(B._test.weatherEventToRail(window.FX.windShift));})()`);
      await evalIn(SETTLE, 15000);
      m = await evalIn(READ);
      check(`${route} + active WEATHER SHIFT: the rail renders and covers nothing`,
        m.visible && !m.overlapsNav && !m.overlapsScore && !m.docOverflowX, `h=${m.height}px`);
      await shot(`${name}-${width}`);
    }
  }

  /* ---------- THE COEXISTENCE PROOF ------------------------------------ */
  await evalIn(`window.App && App.nav('qbdna')`);
  await sleep(14000);
  await evalIn(`(()=>{const B=window.PBEBreaking;
    B.state.queue.length=0; B.state.current=null; B.state.seen.clear(); B.state.dismissed.clear();
    if(window.PBENewsTrust) PBENewsTrust.prepare([window.FX.breakingInjury]);
    const q=B._test.qualifyNews(window.FX.breakingInjury);
    return B.offer(B._test.newsEvent(window.FX.breakingInjury,q));})()`);
  await sleep(900);
  await evalIn(`document.querySelector('[data-picker]')?.click()`);
  await sleep(1600);
  const coexist = await evalIn(`(()=>{
    const panel=document.querySelector('.pdna-modal-panel');
    const rail=document.querySelector('.pbeb');
    if(!panel) return { picker:false, rail:Boolean(rail) };
    const r=panel.getBoundingClientRect();
    const pts=[];
    for(const fx of [0.12,0.5,0.88]) for(const fy of [0.06,0.5,0.94])
      pts.push([Math.round(r.left+r.width*fx), Math.round(r.top+r.height*fy)]);
    const buried=pts.filter(([x,y])=>{ if(x<0||y<0||x>innerWidth||y>innerHeight) return false;
      const t=document.elementFromPoint(x,y); return t && !panel.contains(t) && t!==panel; });
    const rr = rail ? rail.getBoundingClientRect() : null;
    return { picker:true, rail:Boolean(rail),
      railHeight: rr?Math.round(rr.height):0,
      buried:buried.length, buriedOn:buried.map(([x,y])=>{
        const t=document.elementFromPoint(x,y);
        return t?(t.tagName+'.'+String(t.className||'')).slice(0,60):'?';}),
      overflowX: document.documentElement.scrollWidth>innerWidth+1 };})()`);
  check('COEXISTENCE — the rail is showing an alert', coexist.rail && coexist.railHeight > 0,
    `rail height ${coexist.railHeight}px`);
  check('COEXISTENCE — the Player DNA switcher is open', coexist.picker);
  check('COEXISTENCE — the switcher is topmost at all 9 points despite the rail',
    coexist.buried === 0, (coexist.buriedOn || []).join(', '));
  check('COEXISTENCE — no horizontal overflow', !coexist.overflowX);
  await shot(`08-picker-with-breaking-${width}`);
  await evalIn(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await sleep(500);
}

writeFileSync(join(OUT, 'fixtures-report.json'),
  JSON.stringify({ results, errors, widths: WIDTHS }, null, 2));
console.log(`\n${results.length - failures}/${results.length} checks passed`);
console.log(`console errors: ${errors.length}`);
errors.slice(0, 10).forEach(e => console.log('  !', String(e).slice(0, 160)));
if (errors.length) failures++;
ws.close(); finish(failures ? 1 : 0);
