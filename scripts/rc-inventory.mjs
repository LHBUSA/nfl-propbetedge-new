/* RELEASE-CANDIDATE VISUAL INVENTORY
 * node scripts/rc-inventory.mjs [widths] [outDir]
 *   PBE_ROUTES=home,qbdna,...     routes to render (default: the nine product routes)
 *   PBE_STATES=1                  also render the active states at 1440 and 390
 *
 * Renders every route at every width, photographs the FIRST VIEWPORT, and
 * records what the browser actually paints: console errors, horizontal
 * overflow, broken or fabricated imagery, shell height, where the product's
 * own content starts, and the text-size floor. Nothing here is a judgement;
 * it is the evidence a judgement is made from.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WIDTHS = (process.argv[2] || '1440,1280,1024,900,768,430,390').split(',').map(Number);
const OUT = process.argv[3] || 'shots/rc';
const ROUTES = (process.env.PBE_ROUTES || 'home,propboard,pbecast,qbdna,wrdna,rbdna,tedna,newsintel,marketwatch').split(',');
const STATES = process.env.PBE_STATES === '1';
const PORT = process.env.PBE_PORT || '4321';
const TARGET = process.env.PBE_BASE || `http://localhost:${PORT}`;
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DP = 9100 + Math.floor(Math.random() * 90);

mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-rc-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${DP}`, `--user-data-dir=${dir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
function finish(c) { try { chrome.kill(); } catch {} setTimeout(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(c); }, 200); }
setTimeout(() => { console.error('DEADLINE'); finish(3); }, 1500000).unref?.();

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
let errors = [];
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
async function shot(name) {
  const cap = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(cap.data, 'base64'));
}

const MEASURE = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const rect = el => { if (!el) return null; const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height) }; };
  const shell = document.getElementById('pbe-sports-shell');
  const view = document.getElementById('view-container');
  // where does the product's own content start? first painted descendant of the view container
  let contentTop = null;
  if (view) {
    const walker = document.createTreeWalker(view, NodeFilter.SHOW_ELEMENT);
    let n; while ((n = walker.nextNode())) {
      const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = n.getBoundingClientRect(); if (r.height < 8 || r.width < 8) continue;
      contentTop = Math.round(r.top); break;
    }
  }
  // text floor inside the first viewport
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let smallest = 99, under10 = 0, caps = 0, mono = 0, textNodes = 0; let t;
  while ((t = tw.nextNode())) {
    if (!t.nodeValue.trim()) continue;
    const el = t.parentElement; if (!el) continue;
    const r = el.getBoundingClientRect(); if (r.bottom < 0 || r.top > vh || r.width === 0) continue;
    const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const fs = parseFloat(cs.fontSize); textNodes++;
    if (fs < smallest) smallest = fs; if (fs < 10) under10++;
    if (cs.textTransform === 'uppercase' && fs <= 11) caps++;
    if (/mono/i.test(cs.fontFamily)) mono++;
  }
  const imgs = [...document.images].filter(i => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < vh && r.width > 0; });
  const broken = imgs.filter(i => i.complete && i.naturalWidth === 0 && !i.classList.contains('is-broken')).map(i => i.getAttribute('src'));
  const fallbacks = [...document.querySelectorAll('.pbes-score-logo-fallback')].filter(f => { const r = f.getBoundingClientRect(); return r.width > 0 && r.top < vh; }).length;
  return {
    route: location.hash, vw, vh,
    docOverflow: document.documentElement.scrollWidth - vw,
    shell: rect(shell), rail: rect(document.querySelector('#pbe-breaking-slot .pbeb')),
    scorebar: rect(document.querySelector('.pbes-scorebar')),
    primary: rect(document.querySelector('.pbes-primary')), research: rect(document.querySelector('.pbes-research')),
    contentTop, contentShare: contentTop === null ? null : +((vh - contentTop) / vh).toFixed(2),
    text: { nodes: textNodes, smallest, under10, capsSmall: caps, mono, monoShare: textNodes ? +(mono / textNodes).toFixed(2) : null },
    imgs: imgs.length, broken, initialsFallbacks: fallbacks,
    h1: (document.querySelector('#view-container h1') || {}).textContent?.trim().slice(0, 60) || null
  };
})()`;

const rows = [];
for (const width of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride',
    { width, height: width <= 768 ? 844 : 900, deviceScaleFactor: 1, mobile: width <= 768 });
  await send('Page.navigate', { url: `${TARGET}/#home?t=${Date.now()}` });
  await sleep(12000);
  for (const route of ROUTES) {
    errors = [];
    await evalIn(`window.App && App.nav(${JSON.stringify(route)})`);
    await sleep(/dna/.test(route) ? 12000 : 8000);
    await evalIn(`window.PBEBreaking && (PBEBreaking.state.current=null, PBEBreaking._test.render())`);
    await evalIn(`scrollTo(0,0)`); await sleep(300);
    const m = await evalIn(MEASURE);
    m.errors = errors.slice(0, 3);
    rows.push({ width, route, ...m });
    await shot(`${route}-${width}`);
    console.log(`${String(width).padStart(4)} ${route.padEnd(11)} shell=${m.shell ? m.shell.h : '—'}px content@${m.contentTop} (${m.contentShare}) overflow=${m.docOverflow} `
      + `text<10:${m.text.under10} min=${m.text.smallest} caps=${m.text.capsSmall} mono=${m.text.monoShare} imgs=${m.imgs} broken=${m.broken.length} initials=${m.initialsFallbacks} errors=${m.errors.length}`);
  }
}

if (STATES) {
  const FX = `(() => {
    const B = window.PBEBreaking; const nowIso = m => new Date(Date.now() - m*60000).toISOString();
    B.stop(); const reset = () => { B.state.queue.length=0; B.state.current=null; B.state.seen.clear(); B.state.dismissed.clear(); };
    const game = { game_id:'wx-1', event_id:'wx-1', matchup:'BUF @ NE', home_team:'NE', away_team:'BUF',
      kickoff_utc: new Date(Date.now()+5*3600000).toISOString(), venue:'Gillette Stadium', roof:{state:'OUTDOOR', weather_applies:true, label:'Outdoor'} };
    const win = { temp_f:27, apparent_temp_f:19, precip_probability_pct:78, rain_in:0, snowfall_in:1.8, wind_mph:19, gust_mph:28,
      window_local:['2026-01-11T19:00','2026-01-11T23:00'], hours_resolved:5, hours_requested:5, weather_family:'snow', kind:'forecast' };
    window.RC = { reset,
      news: () => { reset(); const it = { id:'rc-1', title:'Chiefs rule out starting quarterback for Sunday with ankle injury', url:'https://propbetedge.ai/news/nfl/x',
        source:'PropBetEdge', published_at: nowIso(12), teams:['KC'], players:[], impact_score:94, is_breaking:true };
        if (window.PBENewsTrust) PBENewsTrust.prepare([it]); B.offer(B._test.newsEvent(it, B._test.qualifyNews(it))); },
      td: () => { reset(); B._test.ingestScoreboard({ games:[{ id:'g-rc', status:{semantics:'LIVE',period:4,clock:'2:14'},
        teams:{home:{abbreviation:'KC',score:21},away:{abbreviation:'BUF',score:24}},
        situation:{last_play:{id:'p-rc',scoring_play:true,score_value:6,type:'Passing Touchdown',period:4,clock:'2:14',
          text:'Josh Allen 38 yard pass to Keon Coleman for a touchdown',home_score:21,away_score:24,
          participants:[{id:'3918298',name:'Josh Allen',position:'QB',headshot:'https://a.espncdn.com/i/headshots/nfl/players/full/3918298.png'}]}}}]}); },
      final: () => { reset(); B._test.ingestScoreboard({games:[{id:'g-f',status:{semantics:'LIVE'},teams:{home:{abbreviation:'BUF',score:28},away:{abbreviation:'KC',score:31}},situation:{}}]});
        B._test.ingestScoreboard({games:[{id:'g-f',status:{semantics:'FINAL'},teams:{home:{abbreviation:'BUF',score:28},away:{abbreviation:'KC',score:31}},situation:{}}]}); },
      watch: () => { reset(); B.offer(B._test.weatherEventToRail({ kind:'WEATHER_WATCH', official:false, event_key:'rc-watch', label:'WEATHER WATCH', headline:'SNOW FORECAST',
        window: win, bands:{wind:'watch',gust:'watch',cold:'freezing',snow:'likely',rain:'none'}, cta:{label:'VIEW WEATHER'}, game, provenance:{source:'Open-Meteo forecast', fetched_at: nowIso(3)} })); },
      shift: () => { reset(); B.offer(B._test.weatherEventToRail({ kind:'WEATHER_SHIFT', official:false, event_key:'rc-shift', label:'WEATHER SHIFT', headline:'WIND FORECAST RISING',
        changes:[{field:'wind',from:13,to:22,copy:'WIND FORECAST RISING',delta:9,unit:'mph'},{field:'gust',from:18,to:34,copy:'GUSTS RISING',delta:16,unit:'mph'}],
        window:{...win, temp_f:41, apparent_temp_f:33, precip_probability_pct:20, snowfall_in:0, wind_mph:22, gust_mph:34, weather_family:'cloud'},
        bands:{wind:'elevated',gust:'elevated',cold:'none',snow:'none',rain:'none'}, cta:{label:'VIEW GAME CONTEXT'},
        game:{...game, matchup:'GB @ CHI', home_team:'CHI', away_team:'GB', venue:'Soldier Field'}, provenance:{source:'Open-Meteo forecast', fetched_at: nowIso(3)} })); },
      nws: () => { reset(); B.offer(B._test.weatherEventToRail({ kind:'WEATHER_ALERT', official:true, event_key:'rc-nws', label:'NWS WEATHER ALERT', headline:'Winter Storm Warning',
        detail:'Winter Storm Warning issued January 11 at 3:04AM MST until January 12 at 11:00PM MST by NWS Denver', severity:'Severe', certainty:'Likely', urgency:'Expected',
        expires:new Date(Date.now()+8*3600000).toISOString(), cta:{label:'VIEW OFFICIAL ALERT', href:'https://api.weather.gov/alerts/x', external:true},
        game:{...game, matchup:'KC @ DEN', home_team:'DEN', away_team:'KC', venue:'Empower Field at Mile High'}, provenance:{source:'National Weather Service'} })); }
    };
    return true;
  })()`;
  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride',
      { width, height: width <= 768 ? 844 : 900, deviceScaleFactor: 1, mobile: width <= 768 });
    await send('Page.navigate', { url: `${TARGET}/#home?t=${Date.now()}` });
    await sleep(12000);
    await evalIn(FX);
    for (const st of ['news', 'td', 'final', 'watch', 'shift', 'nws']) {
      await evalIn(`RC.${st}()`); await sleep(1500);
      await shot(`state-${st}-${width}`);
    }
    await evalIn(`RC.shift()`); await sleep(600);
    await evalIn(`PBEBreaking._test.openWeatherDetail(PBEBreaking.state.current)`, 30000); await sleep(2500);
    await shot(`state-drawer-shift-${width}`);
    await evalIn(`PBEBreaking._test.closeWeatherDetail()`); await sleep(300);
    await evalIn(`RC.watch()`); await sleep(600);
    await evalIn(`PBEBreaking._test.openWeatherDetail(PBEBreaking.state.current)`, 30000); await sleep(2500);
    await shot(`state-drawer-watch-${width}`);
    await evalIn(`PBEBreaking._test.closeWeatherDetail()`); await sleep(300);
    await evalIn(`RC.news()`); await sleep(400);
    await evalIn(`window.PBEStadiums && PBEStadiums.open()`); await sleep(600);
    await shot(`state-stadium-${width}`);
    await evalIn(`window.PBEStadiums && PBEStadiums.close()`);
    await evalIn(`window.App && App.nav('qbdna')`); await sleep(12000);
    await evalIn(`document.querySelector('[data-picker]')?.click()`); await sleep(1500);
    await shot(`state-picker-${width}`);
    await evalIn(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  }
}

writeFileSync(join(OUT, 'inventory.json'), JSON.stringify(rows, null, 2));
console.log(`\n${rows.length} cells rendered · ${rows.filter(r => r.errors.length).length} with console errors · ${rows.filter(r => r.docOverflow > 1).length} with overflow · ${rows.filter(r => r.broken.length).length} with broken images`);
ws.close(); finish(0);
