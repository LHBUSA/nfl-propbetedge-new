/* Market history — cross-book consensus per nfl-odds batch, kept by nfl-intel.
 *
 * nfl-odds keeps only its latest snapshot. A move is a difference between two
 * observations, so something has to remember the earlier one. This module
 * records, once per new nfl-odds batch, the median-consensus line and price per
 * game / market / side (the same normalisation the picks engine's tape uses),
 * and the changes read path compares batches.
 *
 * Reads go through the NFL_ODDS service binding: zero provider credits, however
 * often this runs. A batch is recorded exactly once (keyed by batch_id). A
 * market observed at or after kickoff is not recorded — an in-game price is not
 * pre-game market history.
 */
import { normalizeEvent, consensusByside, teamCodeFromName } from '../../nfl-picks-engine-shared/odds-normalize.mjs';
import { parseSlate, matchGameForEvent } from '../../nfl-picks-engine-shared/current-slate.mjs';

export const MKT_KEYS = { index: 'mkt:v1:batches', batch: id => `mkt:v1:batch:${id}` };
const BATCHES_KEPT = 40;          // ~13 days at 3 ingests/day
const LOOKAHEAD_MS = 8 * 86400000;

async function odds(env, path) {
  const r = await env.NFL_ODDS.fetch(new Request(`https://nfl-odds.internal${path}`, { headers: { accept: 'application/json' } }));
  if (!r.ok) throw new Error(`nfl_odds_${r.status}`);
  return r.json();
}

/* Consensus rows for one featured-odds payload, keyed to nflverse game ids. */
export function consensusRows(payload, slate) {
  const captured = payload?.captured_at;
  const capturedMs = Date.parse(captured || '');
  const rows = [];
  let unmapped = 0, postKick = 0;
  for (const event of Array.isArray(payload?.events) ? payload.events : []) {
    const kickoff = Date.parse(event?.commence_time || '');
    if (!Number.isFinite(kickoff) || kickoff > capturedMs + LOOKAHEAD_MS) continue;
    if (kickoff <= capturedMs) { postKick++; continue; }
    const game = matchGameForEvent(slate.games, { away: teamCodeFromName(event?.away_team), home: teamCodeFromName(event?.home_team), commenceMs: kickoff });
    if (!game?.game_id) { unmapped++; continue; }
    for (const s of consensusByside(normalizeEvent(event, captured))) {
      rows.push({ game_id: game.game_id, market: s.market, team: s.team, over_under: s.over_under, is_home: s.is_home, line: s.line, price: s.price, book: s.book, captured_at: captured });
    }
  }
  return { rows, unmapped, postKick };
}

export async function captureMarket(env, { slateBody }) {
  const health = await odds(env, '/api/odds/health');
  const batchId = health?.snapshot?.batch_id;
  if (!batchId) return { ok: false, status: 'no_snapshot' };
  const index = (await env.INTEL_KV.get(MKT_KEYS.index, 'json')) || [];
  if (index.some(b => b.batch_id === batchId)) return { ok: true, status: 'unchanged', batch_id: batchId };
  const payload = await odds(env, '/api/odds');
  const { rows, unmapped, postKick } = consensusRows(payload, parseSlate(slateBody));
  await env.INTEL_KV.put(MKT_KEYS.batch(batchId), JSON.stringify(rows), { expirationTtl: 20 * 86400 });
  const next = [{ batch_id: batchId, captured_at: payload.captured_at, rows: rows.length }, ...index].slice(0, BATCHES_KEPT);
  await env.INTEL_KV.put(MKT_KEYS.index, JSON.stringify(next));
  return { ok: true, status: 'recorded', batch_id: batchId, rows: rows.length, unmapped, post_kick_skipped: postKick };
}

/* The tape-shaped rows of the most recent `n` recorded batches, oldest first. */
export async function recentRows(env, n = 12) {
  const index = (await env.INTEL_KV.get(MKT_KEYS.index, 'json')) || [];
  const picked = index.slice(0, n);
  const parts = await Promise.all(picked.map(b => env.INTEL_KV.get(MKT_KEYS.batch(b.batch_id), 'json')));
  return { index, rows: parts.filter(Array.isArray).flat() };
}
