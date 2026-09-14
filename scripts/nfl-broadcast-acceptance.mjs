/* NFL broadcast acceptance — runs the nfl-schedule broadcast authority's own
 * refresh + serve code against LIVE ESPN data, locally, and prints a review
 * table. Writes nothing anywhere except the optional --out file.
 *
 *   node scripts/nfl-broadcast-acceptance.mjs [--week=N ...] [--out=file.json] [--markdown]
 *
 * It drives refresh.js tick by tick (back to back, real clock) until the
 * full-season sweep completes, as consecutive cron ticks would, so the request
 * count it reports is the real cost of populating the snapshot from empty.
 */
import { writeFileSync } from 'node:fs';
import { SCHEDULE } from '../workers/nfl-schedule/schedule-2026.js';
import { runRefresh } from '../workers/nfl-schedule/refresh.js';
import { buildBroadcast, joinSummary, easternInstant } from '../workers/nfl-schedule/broadcast-core.js';

const args = process.argv.slice(2);
const weeks = args.filter(a => a.startsWith('--week=')).map(a => Number(a.slice(7)));
const outFile = args.find(a => a.startsWith('--out='))?.slice(6);
const markdown = args.includes('--markdown');

const log = [];
const countingFetch = async (url, init) => {
  const t0 = Date.now();
  const r = await fetch(url, init);
  log.push({ url, status: r.status, ms: Date.now() - t0 });
  return r;
};

let snapshot = null, ticks = 0;
for (; ticks < 6; ticks++) {
  const out = await runRefresh({ snapshot, schedule: SCHEDULE, now: Date.now(), fetchImpl: countingFetch });
  if (out.ran) snapshot = out.snapshot;
  if (snapshot?.lanes?.sweep?.completed_at) break;
}
const now = Date.now();
const summary = joinSummary(SCHEDULE, snapshot, now);
const et = iso => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const rows = SCHEDULE.filter(g => !weeks.length || weeks.includes(Number(g.week))).map(g => {
  const b = buildBroadcast(g, snapshot, now);
  return {
    week: g.week, game_id: g.game_id, game: `${g.away_team} @ ${g.home_team}`,
    kickoff_et: et(easternInstant(g.gameday, g.gametime)),
    source_kickoff: b.match?.source_kickoff || null, kickoff_agrees: b.match?.kickoff_agrees ?? null,
    status: b.status, primary: b.primary, networks: b.networks, streaming: b.streaming, unclassified: b.unclassified || [],
    distribution: b.distribution, distribution_basis: b.distribution_basis || null,
    source: b.source, source_event_id: b.source_event_id, join: b.match?.method || null, confidence: b.match?.confidence || null,
    verified_at: b.verified_at, destinations: b.destinations.map(d => `${d.provider}:${d.url}`)
  };
});

console.log(`ticks=${ticks + 1} upstream_requests=${log.length} bytes_not_measured statuses=${JSON.stringify([...new Set(log.map(l => l.status))])}`);
console.log(`join summary: ${JSON.stringify(summary.counts)} methods=${JSON.stringify(summary.methods)} problems=${summary.problems.length}`);
if (markdown) {
  console.log('| Wk | Game | Kickoff (ET) | Network(s) | Streaming | Distribution | Source | Event ID | verified_at | Status |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.week} | ${r.game} | ${r.kickoff_et} | ${r.networks.join(' / ') || '—'} | ${r.streaming.join(' / ') || '—'} | ${r.distribution} | ${r.source || '—'} | ${r.source_event_id || '—'} | ${r.verified_at || '—'} | ${r.status} |`);
} else {
  for (const r of rows) console.log(JSON.stringify(r));
}
if (summary.problems.length) console.log('problems:', JSON.stringify(summary.problems, null, 1));
if (outFile) writeFileSync(outFile, JSON.stringify({ generated_at: new Date(now).toISOString(), requests: log, summary, rows, snapshot }, null, 1));
