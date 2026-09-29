#!/usr/bin/env node
/* PBE Touchdown Targets — FINAL BACKFILL of hit rows. One-off, operator-run.
 *
 * Finds locked targets whose FINAL grade is a WIN and that have no row in
 * nfl_td_target_hit_events (a touchdown scored while the live detector was not
 * watching, or before detection v1.1 persisted late hits), and records the
 * real scoring play from the game's own package with the SAME detector
 * (td-live-hit.mjs, mode final_backfill) and the SAME atomic claim the Worker
 * uses. Rows are detection = 'final_backfill': persisted so PBEcast shows the
 * permanent HIT with its play, and never announced (view=hits serves only
 * live_fresh), so nothing is celebrated after the fact.
 *
 * It never creates a target, never touches a grade, and only writes for a
 * target the grader has ALREADY settled as a win from the official box score.
 * A target whose play cannot be matched by ESPN athlete id + scoring play is
 * reported and skipped, never guessed.
 *
 *   node scripts/td-hit-backfill.mjs            # dry run: report only
 *   node scripts/td-hit-backfill.mjs --apply    # insert (idempotent)
 *
 * Env: SUPABASE_SERVICE_ROLE_KEY (tkmln), optional SUPABASE_URL, NFL_SITE_URL.
 */
import { select } from '../workers/nfl-picks-engine-shared/supabase.mjs';
import { evaluateTarget } from '../workers/nfl-td-targets-shared/td-live-hit.mjs';
import { claim } from '../workers/nfl-touchdown-target-hit-alerts/src/index.js';

const APPLY = process.argv.includes('--apply');
const env = {
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://tkmlnhmylqnttmnsnief.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
};
const SITE = String(process.env.NFL_SITE_URL || 'https://nfl.propbetedge.ai').replace(/\/$/, '');
if (!env.SUPABASE_SERVICE_ROLE_KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY is required'); process.exit(2); }

const FIELDS = 'id,event_id,season,week,kickoff_ts,player_name,player_key,market,model_prob,market_price,confidence_bucket,target_rank,publication_scope,status,model_snapshot';

const wins = await select(env, 'nfl_prop_pick_grades', 'result=eq.win&select=pick_id&limit=5000') || [];
const winIds = wins.map(row => row.pick_id).filter(id => /^[0-9a-f-]{36}$/i.test(String(id)));
const targets = [];
for (let i = 0; i < winIds.length; i += 100) {
  const group = winIds.slice(i, i + 100);
  targets.push(...(await select(env, 'nfl_prop_picks', `id=in.(${group.join(',')})&market=eq.player_anytime_td&status=eq.graded&select=${FIELDS}`) || []));
}
const existing = new Set();
for (let i = 0; i < targets.length; i += 100) {
  const group = targets.slice(i, i + 100).map(t => t.id);
  for (const row of await select(env, 'nfl_td_target_hit_events', `pick_id=in.(${group.join(',')})&select=pick_id`) || []) existing.add(row.pick_id);
}
const missing = targets.filter(t => !existing.has(t.id));
console.log(`graded TD wins: ${targets.length} · with hit row: ${existing.size} · missing: ${missing.length} · mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);

const details = new Map();
let written = 0;
for (const target of missing) {
  const espn = String(target.model_snapshot?.event?.espn_id || '');
  if (!details.has(espn)) {
    const response = await fetch(`${SITE}/api/nfl-live?event=${encodeURIComponent(espn)}`, { headers: { accept: 'application/json', 'user-agent': 'pbe-td-hit-backfill/1' } });
    details.set(espn, response.ok ? await response.json() : null);
  }
  const detail = details.get(espn);
  const semantics = String(detail?.game?.status?.semantics || '').toUpperCase();
  if (!detail || semantics !== 'FINAL') { console.log(`SKIP ${target.id} game ${espn}: package ${detail ? semantics : 'unavailable'}`); continue; }
  const verdict = evaluateTarget({ target, detail, mode: 'final_backfill', statuses: ['graded'] });
  if (verdict.outcome !== 'hit') { console.log(`SKIP ${target.id} game ${espn}: ${verdict.outcome}`); continue; }
  const row = verdict.row;
  console.log(`${APPLY ? 'WRITE' : 'WOULD WRITE'} ${target.id} game ${espn} ${target.target_rank} play ${row.play_id} "${row.play_text}" Q${row.period} ${row.clock} detection=${row.detection}`);
  if (APPLY) { if (await claim(env, row)) written += 1; else console.log(`  duplicate (already recorded) ${target.id}`); }
}
console.log(`done · written ${written}`);
