/* QB DNA — HISTORICAL DNA FRAMING GATE
 * node scripts/qbdna-historical-gate.mjs [width]
 *
 * Proves, against the rendered DOM, that a rare condition with N<5 is never
 * presented as evidence that the QUARTERBACK lacks history:
 *
 *   1. real veterans (Mahomes, Allen, Jackson, Burrow, Herbert) never render
 *      "Too few games to call either way" — and never a standing
 *      "Limited history in rare conditions" block either. Historical DNA is
 *      Strength / Watchout / Signal, or the one-line empty state. Rare-sample
 *      information appears only where it is contextually relevant.
 *   2. N<5 never renders as Strength / Watchout / Signal
 *   3. N=5 renders as Signal; N=10 with a clearing move as Strength/Watchout
 *   4. a rare window TODAY'S game falls into is surfaced in Today's Test as
 *      "Career history · N=2 · VERY SMALL SAMPLE · no directional conclusion"
 *      and not as a Watchout with a percentage
 *   5. a quarterback with no NFL games still renders the honest sample flag
 *
 * Cases 2-4 are DETERMINISTIC FIXTURES injected into the live module's state
 * and re-rendered, so they do not depend on the weather of any real week.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WIDTH = Number(process.argv[2] || 1440);
const OUT = process.env.PBE_OUT || 'shots/qbdna-history';
const PORT = process.env.PBE_PORT || '4321';
const TARGET = process.env.PBE_BASE || `http://localhost:${PORT}`;
const CHROME = process.env.PBE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DP = 9000 + Math.floor(Math.random() * 90);

mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'pbe-hist-'));
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
let id = 1; const pending = new Map(); const errors = [];
const send = (m, p = {}) => { const n = id++; ws.send(JSON.stringify({ id: n, method: m, params: p }));
  return new Promise((res, rej) => pending.set(n, { resolve: res, reject: rej })); };
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'exception');
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
};
await send('Runtime.enable'); await send('Page.enable');
const evalIn = async (expr, ms = 30000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
    sleep(ms).then(() => { throw new Error('WEDGED: ' + expr.slice(0, 70)); })
  ]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
};
async function shot(name, target = 'hist') {
  /* the evidence is the Historical DNA panel and Today's Test, which sit
     below the hero: bring them into the frame before photographing */
  await evalIn(`(()=>{const t=document.querySelector('.q2-today'); const h=[...document.querySelectorAll('.q2-panel')].find(p=>/Historical DNA/.test((p.querySelector('h2')||{}).textContent||'')); (${JSON.stringify(target)}==='today'?(t||h):(h||t))?.scrollIntoView({block:'start'}); window.scrollBy(0,-8); return true;})()`);
  await sleep(400);
  const cap = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(cap.data, 'base64'));
}
const results = []; let failures = 0;
function check(name, cond, detail) {
  results.push({ name, pass: Boolean(cond), detail: detail || '' });
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/* What Historical DNA and Today's Test actually say, read from the DOM. */
const READ = `(() => {
  const panels = [...document.querySelectorAll('.q2-panel')];
  const hist = panels.find(p => /Historical DNA/.test((p.querySelector('h2')||{}).textContent||''));
  const today = document.querySelector('.q2-today');
  const txt = el => el ? el.textContent.replace(/\\s+/g,' ').trim() : '';
  const lim = hist && hist.querySelector('[data-limited-history]');
  return {
    histText: txt(hist),
    rows: hist ? [...hist.querySelectorAll('.q2-sigrow-k')].map(x => txt(x)) : [],
    cards: hist ? [...hist.querySelectorAll('.q2-sig')].map(x => ({ label: txt(x.querySelector('.q2-sig-label')), tier: x.className.replace('q2-sig','').trim(), n: txt(x.querySelector('.q2-sig-meta')) })) : [],
    empty: txt(hist && hist.querySelector('.q2-empty')),
    limitedHead: txt(lim && lim.querySelector('.q2-insuf-k')),
    limitedChips: lim ? [...lim.querySelectorAll('.q2-insuf-list span')].map(x => txt(x)) : [],
    limitedNote: txt(lim && lim.querySelector('p')),
    todayFacts: today ? [...today.querySelectorAll('.q2-today-fact')].map(f => ({ k: txt(f.querySelector('.q2-today-fact-k')), v: txt(f.querySelector('.q2-today-fact-v')), s: txt(f.querySelector('.q2-today-fact-s')), rare: f.classList.contains('is-rare') })) : [],
    baselineN: window.PBEQBDna && PBEQBDna.state.dna && PBEQBDna.state.dna.dna_signals ? PBEQBDna.state.dna.dna_signals.baseline_n : null,
    limitedBlocks: document.querySelectorAll('[data-limited-history]').length,
    phraseCount: (document.body.textContent.match(/Limited history in rare conditions/gi) || []).length,
    policyParagraph: /however large the number looks/i.test(document.body.textContent),
    flag: txt(document.querySelector('.q2-hero-flag')),
    name: txt(document.querySelector('.q2-hero-name'))
  };
})()`;

await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: WIDTH <= 768 });
await send('Page.navigate', { url: `${TARGET}/#qbdna?t=${Date.now()}` });
await sleep(14000);

/* ---------- 1. REAL VETERANS ---------------------------------------------- */
const VETS = [['Patrick Mahomes', '00-0033873'], ['Josh Allen', '00-0034857'], ['Lamar Jackson', '00-0034796'],
              ['Joe Burrow', '00-0036442'], ['Justin Herbert', '00-0036355'], ['Jared Goff', '00-0033106'],
              ['Drake Maye', '00-0039851']];
const audit = [];
for (const [name, gid] of VETS) {
  await evalIn(`(()=>{const S=PBEQBDna.state; S.playerId=${JSON.stringify(gid)}; S.dna=null; S.lab=null; S.cmp=null; S.ctxCmp=null; S.ctx=null; S.eventId=null; S.tab='overview'; PBEQBDna.load(); return true;})()`);
  await sleep(9000);
  const m = await evalIn(READ);
  const counts = await evalIn(`(()=>{const g=PBEQBDna.state.dna&&PBEQBDna.state.dna.dna_signals; return g?{s:g.strengths.length,w:g.watchouts.length,sig:g.signals.length,ins:g.insufficient.length,base:g.baseline_n}:null;})()`);
  audit.push({ name, ...counts });
  check(`${name}: never "Too few games to call either way"`, !/Too few games/i.test(m.histText), `baseline N=${m.baselineN} · N<5 conditions ${counts ? counts.ins : '?'}`);
  check(`  "Limited history in rare conditions" appears ZERO times in the rendered DOM`, m.phraseCount === 0 && m.limitedBlocks === 0, `phrase ${m.phraseCount} · blocks ${m.limitedBlocks}`);
  check(`  no policy paragraph on the page`, !m.policyParagraph);
  check(`  Historical DNA is Strength / Watchout / Signal only`, m.rows.length > 0 && m.rows.every(r => /^(Strength|Watchout|Signal)/.test(r)), m.rows.join(' | '));
  check(`  no rare-condition chip anywhere in Historical DNA`, !/· N=[1-4]\b/.test(m.histText) || m.cards.every(c => !/N=[1-4]\b/.test(c.n)), '');
  if (name === 'Patrick Mahomes') await shot(`mahomes-${WIDTH}`);
  if (name === 'Josh Allen') await shot(`allen-${WIDTH}`);
  if (name === 'Drake Maye') await shot(`maye-${WIDTH}`);
}
console.log('\n  AUDIT  ' + audit.map(a => `${a.name}: base ${a.base} · S ${a.s} · W ${a.w} · Sig ${a.sig} · N<5 ${a.ins}`).join('\n         '));

/* ---------- 2-4. DETERMINISTIC FIXTURE: veteran + rare window today ------- */
const FIXTURE = `(() => {
  const S = PBEQBDna.state;
  const row = (key, label, games, move, group) => ({ key, group: group||'weather', label, tier: 'X', eligible: false,
    direction: move > 0 ? 'up' : 'down', baseline_delta_pct: move, passing_yards_avg: +(250 + 2.5*move).toFixed(1),
    games, record: '1-1', win_pct: 50, completion_pct: 65,
    sample_label: games >= 20 ? 'STRONG SAMPLE' : games >= 10 ? 'MODERATE SAMPLE' : games >= 5 ? 'SMALL SAMPLE' : 'VERY SMALL SAMPLE',
    statement: 'fixture' });
  const wind2 = row('wind_20_plus', 'Wind 20+ mph', 2, -10.1);
  const sig5 = { ...row('rain', 'Rain', 5, 9), tier: 'SIGNAL', eligible: true };
  const str10 = { ...row('dome', 'Dome / closed roof', 10, 6.5, 'venue'), tier: 'STRENGTH', eligible: true };
  const wo10 = { ...row('cold_33_50', '33-50 F', 10, -4.2), tier: 'WATCHOUT', eligible: true };
  S.dna.dna_signals = {
    policy: { qualifying_n: 10, signal_n: 5, min_move_pct: 4, rule: 'fixture policy' },
    baseline_mean: 250, baseline_n: 40,
    strengths: [str10], watchouts: [wo10], signals: [sig5],
    insufficient: [{ ...wind2, tier: 'INSUFFICIENT' }],
    limited_history: { label: 'Limited history in rare conditions',
      disclosure: 'Not used as Player DNA signals because fewer than 5 qualifying games are available.',
      rows: [{ key: 'wind_20_plus', label: 'Wind 20+ mph', games: 2, sample_label: 'VERY SMALL SAMPLE', classified: false }] },
    neutral_count: 3 };
  // today's game: 22 mph wind, outdoor. The wind_20_plus window has 2 games.
  const ctx = S.ctx || {};
  ctx.forecast = { temp_f: 41, wind_mph: 22 };
  ctx.context = Object.assign({}, ctx.context || {}, { roof: 'outdoor', precip: 'none', primetime: false });
  S.ctx = ctx;
  S.ctxCmp = Object.assign({}, S.ctxCmp || {}, {
    baseline: { passing_yards_avg: 250, games: 40 },
    windows: {
      wind_20_plus: { available: true, label: 'Wind 20+ mph', games: 2, passing_yards_avg: 224.8, vs_baseline: { pct: -10.1 }, sample_label: 'VERY SMALL SAMPLE' },
      wind_15_plus: { available: true, label: 'Wind 15+ mph', games: 7, passing_yards_avg: 238.0, vs_baseline: { pct: -4.8 }, sample_label: 'SMALL SAMPLE' },
      dry: { available: true, label: 'Dry', games: 33, passing_yards_avg: 252.0, vs_baseline: { pct: 0.8 }, sample_label: 'STRONG SAMPLE' }
    } });
  PBEQBDna.render();
  return true;
})()`;
await evalIn(`(()=>{const S=PBEQBDna.state; S.playerId='00-0033873'; S.dna=null; S.lab=null; S.cmp=null; S.ctxCmp=null; S.ctx=null; S.eventId=null; PBEQBDna.load(); return true;})()`);
await sleep(9000);
await evalIn(FIXTURE);
await sleep(600);
let m = await evalIn(READ);
check('FIXTURE: baseline N=40 with Wind 20+ N=2 never says "Too few games"', !/Too few games/i.test(m.histText));
check('  Historical DNA leads with Strength / Watchout / Signal', m.rows.length === 3 && /Strength/.test(m.rows[0]) && /Watchout/.test(m.rows[1]) && /Signal/.test(m.rows[2]), m.rows.join(' | '));
check('  N=10 renders as Strength and Watchout', m.cards.some(c => c.label === 'Dome / closed roof' && /t-up/.test(c.tier)) && m.cards.some(c => c.label === '33-50 F' && /t-down/.test(c.tier)), JSON.stringify(m.cards));
check('  N=5 renders as Signal', m.cards.some(c => c.label === 'Rain' && /t-sig/.test(c.tier)));
check('  N=2 is NOT a card in any tier', !m.cards.some(c => c.label === 'Wind 20+ mph'));
check('  N=2 appears NOWHERE on Historical DNA — no block, no chip, no phrase', m.limitedBlocks === 0 && m.phraseCount === 0 && !/Wind 20\+ mph · N=2/.test(m.histText), `phrase ${m.phraseCount}`);
const rare = m.todayFacts.find(f => f.rare);
check("  Today's Test surfaces the rare window today's game falls into", Boolean(rare) && rare.k === 'Wind 20+ mph', JSON.stringify(rare));
check('  … as "Career history · N=2"', rare && rare.v === 'Career history · N=2', rare && rare.v);
check('  … with VERY SMALL SAMPLE and no directional conclusion', rare && /VERY SMALL SAMPLE/.test(rare.s) && /no directional conclusion/i.test(rare.s), rare && rare.s);
check('  … and never as a Watchout or a -10.1%', !m.todayFacts.some(f => /Watchout|-10\\.1%/.test(f.k + ' ' + f.v + ' ' + f.s)), JSON.stringify(m.todayFacts));
check('  the N>=5 similar-conditions lead is still Wind 15+ mph (N=7), unchanged', m.todayFacts.some(f => !f.rare && f.k === 'Wind 15+ mph' && /N=7/.test(f.s)), JSON.stringify(m.todayFacts.map(f => f.k)));
await shot(`fixture-rare-today-${WIDTH}`, 'today');

/* ---------- 4b. NOTHING PROMOTED + one rare condition --------------------- */
await evalIn(`(()=>{const g=PBEQBDna.state.dna.dna_signals; g.strengths=[]; g.watchouts=[]; g.signals=[]; PBEQBDna.render(); return true;})()`);
await sleep(400);
m = await evalIn(READ);
check('EMPTY: with nothing promoted the wording is about the pattern, not the man', /No repeatable condition pattern clears the current Player DNA sample threshold/.test(m.empty), m.empty);
check('  and no rare-condition block is appended beneath it', m.limitedBlocks === 0 && m.phraseCount === 0);
check("  while Today's Test still carries the rare window today's game falls into", m.todayFacts.some(f => f.rare && /N=2/.test(f.v) && /VERY SMALL SAMPLE/.test(f.s)));
check('  and never "Too few games"', !/Too few games/i.test(m.histText));
await shot(`fixture-empty-${WIDTH}`);

/* ---------- 5. ZERO-HISTORY QUARTERBACK ----------------------------------- */
const zero = await evalIn(`(async()=>{const j=await (await fetch('/api/qb-dna?list=1')).json(); const p=(j.players||[]).find(x=>x.history_available===false); return p?{id:p.gsis_id,name:p.name}:null;})()`, 20000);
if (!zero) console.log('  (no zero-history quarterback in the index; case 5 skipped)');
else {
  await evalIn(`(()=>{const S=PBEQBDna.state; S.playerId=${JSON.stringify(zero.id)}; S.dna=null; S.lab=null; S.cmp=null; S.ctxCmp=null; S.ctx=null; S.eventId=null; PBEQBDna.load(); return true;})()`);
  await sleep(9000);
  m = await evalIn(READ);
  check(`ZERO HISTORY (${zero.name}): the honest sample flag still renders`, /No NFL game sample yet/i.test(m.flag), m.flag);
  check('  and never "Too few games"', !/Too few games/i.test(m.histText));
  await shot(`zero-history-${WIDTH}`);
}

/* ---------- 6. THE REST OF THE FAMILY: WR / RB / TE --------------------- */
for (const [route, label] of [['wrdna', 'WR DNA'], ['rbdna', 'RB DNA'], ['tedna', 'TE DNA']]) {
  await evalIn(`window.App && App.nav(${JSON.stringify(route)})`);
  await sleep(12000);
  const fam = await evalIn(`(()=>{
    const hist=[...document.querySelectorAll('.q2-panel')].find(p=>/^(Historical|Receiver|Back|Tight end) DNA$/.test(((p.querySelector('h2')||{}).textContent||'').trim()));
    const txt=el=>el?el.textContent.replace(/\\s+/g,' ').trim():'';
    return { hist: Boolean(hist), rows: hist?[...hist.querySelectorAll('.q2-sigrow-k')].map(txt):[],
      empty: txt(hist&&hist.querySelector('.q2-empty')),
      phraseCount:(document.body.textContent.match(/Limited history in rare conditions/gi)||[]).length,
      tooFew:/Too few games/i.test(document.body.textContent),
      blocks:document.querySelectorAll('[data-limited-history]').length,
      name: txt(document.querySelector('.q2-hero-name')) };})()`);
  check(`${label} (${fam.name}): Historical DNA panel renders`, fam.hist);
  check(`  "Limited history in rare conditions" appears ZERO times`, fam.phraseCount === 0 && fam.blocks === 0, `phrase ${fam.phraseCount}`);
  check(`  never "Too few games"`, !fam.tooFew);
  check(`  Strength / Watchout / Signal, or the one-line empty state`, (fam.rows.length > 0 && fam.rows.every(r => /^(Strength|Watchout|Signal)/.test(r))) || /No repeatable condition pattern/.test(fam.empty), fam.rows.join(' | ') || fam.empty);
  await shot(`${route}-${WIDTH}`);
}

writeFileSync(join(OUT, 'report.json'), JSON.stringify({ results, audit, errors }, null, 2));
console.log(`\n${results.length - failures}/${results.length} checks passed · console errors: ${errors.length}`);
errors.slice(0, 5).forEach(e => console.log('  !', String(e).slice(0, 160)));
if (errors.length) failures++;
ws.close(); finish(failures ? 1 : 0);
