#!/usr/bin/env node
/* PBE Touchdown Targets — RECORD INTEGRITY AUDIT. Read-only.
 *
 *   node scripts/td-record-audit.mjs [--json]
 *
 * For every player_anytime_td target it checks, from the database alone:
 *
 *   created_before_kickoff      created_at < kickoff_ts (issuance is frozen)
 *   no_lifecycle_after_kickoff  no created/confirmed/withdrawn/replaced audit
 *                               event at or after kickoff (the set locked at
 *                               kickoff: locked_at = kickoff_ts)
 *   in_canonical_locked_set     the target is its game's final pregame
 *                               evaluation primary_pick_id / secondary_pick_id
 *   one_grade                   graded targets carry exactly one grade row,
 *                               for this pick id
 *   no_duplicate_rank           one primary / one secondary per game in the
 *                               canonical set
 *   no_duplicate_player         no player twice in a game's canonical set
 *   win_has_scoring_play        every WIN has a hit row naming an ESPN
 *                               scoring play (espn_id + play_id)
 *
 * and prints the record the public view computes (canonical graded targets
 * only) plus every excluded target with its reason. Exit 1 if a canonical
 * target fails any rule.
 *
 * Env: SUPABASE_SERVICE_ROLE_KEY (tkmln), optional SUPABASE_URL.
 */
import { select } from '../workers/nfl-picks-engine-shared/supabase.mjs';
import { splitCanonical } from '../api/_td-record-scope.js';

const env = {
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://tkmlnhmylqnttmnsnief.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
};
if (!env.SUPABASE_SERVICE_ROLE_KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY is required'); process.exit(2); }
const JSON_OUT = process.argv.includes('--json');

const inIds = ids => ids.map(id => `"${id}"`).join(',');
async function byIds(table, column, ids, fields) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...(await select(env, table, `${column}=in.(${inIds(ids.slice(i, i + 100))})&select=${fields}&limit=5000`) || []));
  return out;
}

const picks = await select(env, 'nfl_prop_picks',
  'market=eq.player_anytime_td&select=id,event_id,season,week,player_name,target_rank,status,publication_scope,created_at,kickoff_ts,player_espn_id:model_snapshot->player->>espn_id,espn_id:model_snapshot->event->>espn_id&order=kickoff_ts.asc&limit=5000') || [];
const ids = picks.map(p => p.id);
const [finals, grades, hits, audits] = await Promise.all([
  select(env, 'nfl_td_final_pregame_evaluation', 'select=event_id,espn_id,primary_pick_id,secondary_pick_id&limit=5000'),
  byIds('nfl_prop_pick_grades', 'pick_id', ids, 'pick_id,result,settlement_note'),
  byIds('nfl_td_target_hit_events', 'pick_id', ids, 'pick_id,espn_id,play_id,detection'),
  byIds('nfl_prop_pick_audit_events', 'pick_id', ids, 'pick_id,event_type,occurred_at'),
]);
const gradesBy = Map.groupBy ? Map.groupBy(grades, g => g.pick_id) : grades.reduce((m, g) => m.set(g.pick_id, [...(m.get(g.pick_id) || []), g]), new Map());
const hitBy = new Map(hits.map(h => [h.pick_id, h]));
const LIFECYCLE = new Set(['td_target_created', 'td_target_confirmed', 'td_target_withdrawn', 'td_target_replaced']);

const rows = picks.map(p => ({ ...p, grade: (gradesBy.get(p.id) || [])[0] || null }));
const { locked, excluded } = splitCanonical({ rows, evaluations: finals || [] });
const canonicalByEvent = new Map();
for (const row of locked) canonicalByEvent.set(row.event_id, [...(canonicalByEvent.get(row.event_id) || []), row]);

const results = locked.map(row => {
  const kick = Date.parse(row.kickoff_ts);
  const g = gradesBy.get(row.id) || [];
  const peers = canonicalByEvent.get(row.event_id) || [];
  const late = audits.filter(a => a.pick_id === row.id && LIFECYCLE.has(a.event_type) && Date.parse(a.occurred_at) >= kick);
  const hit = hitBy.get(row.id);
  const checks = {
    created_before_kickoff: Date.parse(row.created_at) < kick,
    no_lifecycle_after_kickoff: late.length === 0,
    in_canonical_locked_set: true,
    one_grade: row.status !== 'graded' || (g.length === 1 && g[0].pick_id === row.id),
    no_duplicate_rank: peers.filter(p => p.target_rank === row.target_rank).length === 1,
    no_duplicate_player: peers.filter(p => p.player_espn_id === row.player_espn_id).length === 1,
    win_has_scoring_play: row.grade?.result !== 'win' || Boolean(hit && /^\d+$/.test(String(hit.play_id || '')) && hit.espn_id),
  };
  return { id: row.id, game: row.event_id, espn: row.espn_id, player: row.player_name, rank: row.target_rank, status: row.status, result: row.grade?.result || null, hit_detection: hit?.detection || null, checks, ok: Object.values(checks).every(Boolean) };
});

const graded = results.filter(r => r.status === 'graded');
const totals = {
  audited_targets: picks.length,
  canonical_targets: locked.length,
  canonical_graded: graded.length,
  pending: results.filter(r => r.status === 'open').length,
  hit: graded.filter(r => r.result === 'win').length,
  miss: graded.filter(r => r.result === 'loss').length,
  void: graded.filter(r => r.result === 'void').length,
};
totals.hit_rate = totals.hit + totals.miss ? Number((totals.hit / (totals.hit + totals.miss)).toFixed(4)) : null;
const failures = results.filter(r => !r.ok);
const exclusions = excluded.map(x => ({ id: x.id, reason: x.reason, player: x.row.player_name, rank: x.row.target_rank, game: x.row.event_id, created_at: x.row.created_at, kickoff_ts: x.row.kickoff_ts, grade: x.row.grade?.result || null }));

if (JSON_OUT) console.log(JSON.stringify({ totals, failures, exclusions, results }, null, 2));
else {
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.id.slice(0, 8)} ${r.espn} ${r.rank.padEnd(9)} ${String(r.result || r.status).padEnd(6)} ${r.hit_detection || ''} ${r.ok ? '' : JSON.stringify(Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k))}`);
  for (const x of exclusions) console.log(`EXCL ${x.id.slice(0, 8)} ${x.rank} ${x.reason} (grade ${x.grade})`);
  console.log(JSON.stringify(totals));
}
process.exit(failures.length ? 1 : 0);
