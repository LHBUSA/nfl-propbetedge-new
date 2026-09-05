/* Runs the whole audited corpus through the pipeline and reports coverage,
   fail-closed rate and (informationally) the player-name parse rate. */
import { readFileSync } from 'node:fs';
import { normalizePlayForArcade } from './arcade-normalize.js';

const SRC = readFileSync(new URL('../../api/nfl-live.js', import.meta.url), 'utf8');
const fnStart = SRC.indexOf('function play(p){');
const fnEnd = SRC.indexOf('\n}', fnStart) + 2;
const apiPlay = new Function(SRC.slice(0, fnEnd) + '\nreturn play;')();

const rows = readFileSync(process.argv[2], 'utf8').trim().split('\n').map(l => JSON.parse(l));
const stat = { total: 0, byKind: {}, conf: {}, failClosed: [], names: {}, unknown: {} };

for (const r of rows) {
  /* rebuild the upstream-ish shape the API normalizer expects */
  const raw = {
    id: r.id, sequenceNumber: r.seq, text: r.txt,
    type: { id: r.tid, text: r.ttx },
    period: { number: 1 }, clock: { displayValue: '0:00' },
    scoringPlay: r.score, statYardage: r.stat, isTurnover: r.turn, isPenalty: r.pen,
    start: { down: r.sd, distance: 10, yardsToEndzone: r.sy, team: r.st ? { id: r.st } : undefined },
    end: { down: r.ed, distance: 10, yardsToEndzone: r.ey, team: r.et ? { id: r.et } : undefined }
  };
  const a = normalizePlayForArcade(apiPlay(raw), { drive: { team: { abbreviation: 'OFF' } } });
  stat.total++;
  stat.byKind[a.kind] = (stat.byKind[a.kind] || 0) + 1;
  stat.conf[a.confidence.level] = (stat.conf[a.confidence.level] || 0) + 1;
  if (a.confidence.level === 'field_state_only') {
    stat.failClosed.push(a.typeText);
    if (a.kind === 'unknown') stat.unknown[`${a.typeId} ${a.typeText}`] = (stat.unknown[`${a.typeId} ${a.typeText}`] || 0) + 1;
  }
  /* name parse rate, informational only -- names never drive geometry */
  const wants = { rush: 'rusher', pass_complete: 'receiver', passing_touchdown: 'receiver',
    rushing_touchdown: 'rusher', pass_incomplete: 'passer', sack: 'passer',
    interception: 'interceptor', field_goal_good: 'kicker', field_goal_missed: 'kicker',
    punt: 'kicker', kickoff: 'kicker' }[a.kind];
  if (wants) {
    const k = stat.names[a.kind] || (stat.names[a.kind] = { got: 0, of: 0, field: wants });
    k.of++; if (a[wants]) k.got++;
  }
}
const pct = (n, d) => `${(100 * n / Math.max(d, 1)).toFixed(1)}%`;
console.log(`CORPUS: ${stat.total} plays\n`);
console.log('CONFIDENCE');
for (const [k, v] of Object.entries(stat.conf).sort((a, b) => b[1] - a[1]))
  console.log(`  ${k.padEnd(20)} ${String(v).padStart(6)}  ${pct(v, stat.total)}`);
console.log('\nKIND');
for (const [k, v] of Object.entries(stat.byKind).sort((a, b) => b[1] - a[1]))
  console.log(`  ${k.padEnd(22)} ${String(v).padStart(6)}  ${pct(v, stat.total)}`);
console.log('\nFAIL-CLOSED (field state only) BY TYPE');
const fc = {}; stat.failClosed.forEach(t => fc[t] = (fc[t] || 0) + 1);
for (const [k, v] of Object.entries(fc).sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log(`  ${String(k).padEnd(34)} ${String(v).padStart(5)}`);
console.log('\nUNMAPPED TYPE IDS (fell through to unknown)');
const u = Object.entries(stat.unknown).sort((a, b) => b[1] - a[1]);
console.log(u.length ? u.map(([k, v]) => `  ${k.padEnd(38)} ${v}`).join('\n') : '  (none)');
console.log('\nPLAYER-NAME PARSE RATE — INFORMATIONAL ONLY, never load-bearing');
for (const [k, v] of Object.entries(stat.names).sort((a, b) => b[1].of - a[1].of))
  console.log(`  ${k.padEnd(22)} ${v.field.padEnd(12)} ${String(v.got).padStart(5)}/${String(v.of).padEnd(6)} ${pct(v.got, v.of)}`);
