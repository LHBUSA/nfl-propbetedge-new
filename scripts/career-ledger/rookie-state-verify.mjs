/* ROOKIE state production verification (player-career/v1 revision 1.1).
 *
 *   node scripts/career-ledger/rookie-state-verify.mjs [--target https://nfl.propbetedge.ai] [--expect <ids.json>] [--sample 80]
 *
 * Calls /api/player-career for EVERY rookie candidate in the committed ledger
 * (players with no ledger history) and for a deterministic sample of
 * non-candidates, then asserts:
 *   - label keeps its v1 values (CAREER | TRACKED HISTORY) everywhere
 *   - ROOKIE players: display_label "ROOKIE · NO PRIOR NFL HISTORY", coverage.complete false,
 *     rookie.failed empty, never CAREER
 *   - TRACKED candidates carry the failed criteria that kept them out
 *   - non-candidates: history_state mirrors label exactly (CAREER/TRACKED unchanged)
 *   - optional --expect: the ROOKIE set equals the expected id list
 * Prints aggregate counts; exits non-zero on any violation.
 */
import { readFileSync } from 'node:fs';
import { isRookieCandidate } from '../../api/_career/ledger-core.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const TARGET = arg('target', 'https://nfl.propbetedge.ai');
const SAMPLE = Number(arg('sample', 80));
const EXPECT = arg('expect', null);
/* --bust <token>: add a query token so edge-cached pre-deploy responses are not re-read after a release. */
const BUST = arg('bust', null);
const ledger = JSON.parse(readFileSync(new URL('../../data/dist/career-ledger.json', import.meta.url), 'utf8'));
const players = Object.entries(ledger.players);
const candidates = players.filter(([, p]) => isRookieCandidate(p)).map(([id]) => id);
const others = players.filter(([, p]) => !isRookieCandidate(p)).map(([id]) => id).sort();
const sample = others.filter((_, i) => i % Math.max(1, Math.floor(others.length / SAMPLE)) === 0).slice(0, SAMPLE);

async function get(id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${TARGET}/api/player-career?espn_id=${id}${BUST ? `&v=${encodeURIComponent(BUST)}` : ''}`, { headers: { accept: 'application/json' } });
      if (r.ok) return await r.json();
    } catch (_) {}
    await new Promise(res => setTimeout(res, 800 * (attempt + 1)));
  }
  return null;
}
async function pool(ids, n, fn) {
  const out = new Map(); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < ids.length) { const id = ids[i++]; out.set(id, await fn(id)); } }));
  return out;
}

const violations = [];
const bad = (id, why) => violations.push({ id, why });
const cand = await pool(candidates, 4, get);
const tally = { candidates: candidates.length, ROOKIE_NO_PRIOR_HISTORY: 0, TRACKED_HISTORY: 0, CAREER: 0, unreadable: 0 };
const failedCriteria = {};
const rookieIds = [];
for (const [id, b] of cand) {
  if (!b || b.ok === false) { tally.unreadable += 1; bad(id, 'no response'); continue; }
  tally[b.history_state] = (tally[b.history_state] || 0) + 1;
  if (!['CAREER', 'TRACKED HISTORY'].includes(b.label)) bad(id, `v1 label changed: ${b.label}`);
  if (b.contract !== 'player-career/v1' || b.contract_revision !== '1.1') bad(id, 'contract markers');
  if (b.history_state === 'CAREER') bad(id, 'a rookie candidate became CAREER');
  if (b.history_state === 'ROOKIE_NO_PRIOR_HISTORY') {
    rookieIds.push(id);
    if (b.display_label !== 'ROOKIE · NO PRIOR NFL HISTORY') bad(id, 'display label');
    if (b.coverage?.complete !== false || b.label !== 'TRACKED HISTORY') bad(id, 'rookie must stay incomplete / v1 TRACKED');
    if (!b.rookie?.qualifies || (b.rookie.failed || []).length) bad(id, 'rookie criteria');
    if ((b.game_log || []).some(g => g.season < b.coverage.current_season.season)) bad(id, 'prior-season game present');
  } else {
    for (const f of b.rookie?.failed || []) failedCriteria[f] = (failedCriteria[f] || 0) + 1;
    if (b.rookie?.qualifies) bad(id, 'qualifies but not ROOKIE');
  }
}
const oth = await pool(sample, 4, get);
const otherTally = { sampled: sample.length, CAREER: 0, TRACKED_HISTORY: 0, unreadable: 0 };
for (const [id, b] of oth) {
  if (!b || b.ok === false) { otherTally.unreadable += 1; bad(id, 'no response'); continue; }
  otherTally[b.history_state] = (otherTally[b.history_state] || 0) + 1;
  const mirror = b.label === 'CAREER' ? 'CAREER' : 'TRACKED_HISTORY';
  if (b.history_state !== mirror) bad(id, `non-candidate state ${b.history_state} vs label ${b.label}`);
  if (b.display_label !== b.label) bad(id, 'non-candidate display label differs from v1 label');
  if (b.rookie !== null) bad(id, 'non-candidate carries rookie evidence');
}
if (EXPECT) {
  const want = new Set(JSON.parse(readFileSync(EXPECT, 'utf8')));
  const got = new Set(rookieIds);
  const missing = [...want].filter(x => !got.has(x)), extra = [...got].filter(x => !want.has(x));
  if (missing.length || extra.length) bad('expect', { missing, extra });
  tally.expected = want.size;
}
console.log(JSON.stringify({ target: TARGET, candidates: tally, tracked_candidates_failed_criteria: failedCriteria, non_candidates: otherTally, violations: violations.length }, null, 1));
if (violations.length) { console.log(JSON.stringify(violations.slice(0, 20), null, 1)); process.exit(1); }
