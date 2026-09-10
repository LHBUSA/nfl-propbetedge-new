/* Durable run ledger for the picks engine lanes.
 *
 * A module-level `health` object is not evidence that a cron ran: Workers
 * isolates are ephemeral, and a scheduled() invocation and a /health request
 * are usually served by different isolates. Every lane therefore writes its run
 * state to KV (binding PICKS_KV), where an isolate restart cannot erase it.
 *
 * Four keys per lane, each written whole — no read-modify-write:
 *   run:tick:<lane>  every scheduled invocation, including cadence skips.
 *                    Proves the trigger is alive.
 *   run:work:<lane>  the last invocation that actually did work.
 *   run:ok:<lane>    the last invocation that did work and succeeded.
 *   run:err:<lane>   the last failure, kept until overwritten by the next one.
 *
 * Records are safe to publish: counts, timestamps, error CLASSES and source
 * freshness. Never a key, a payload, a pick's proprietary economics or a URL
 * with credentials.
 */

export const LANES = Object.freeze({
  'nfl-game-picks-orchestrator': { label: 'Game decisions', tick_sla_s: 1800, work_sla_s: 13 * 3600, critical: true },
  'nfl-odds-snapshot': { label: 'Market tape + closing', tick_sla_s: 1800, work_sla_s: 20 * 3600, critical: true },
  'nfl-game-grader': { label: 'Game grading', tick_sla_s: 1800, work_sla_s: 26 * 3600, critical: true },
  'nfl-weight-tuner': { label: 'Game champion/challenger', tick_sla_s: 8 * 86400, work_sla_s: 8 * 86400, critical: false },
  'nfl-prop-picks-orchestrator': { label: 'Prop decisions (pass yds)', tick_sla_s: 1800, work_sla_s: 13 * 3600, critical: true },
  'nfl-prop-picks-grader': { label: 'Prop grading', tick_sla_s: 1800, work_sla_s: 26 * 3600, critical: true },
  'nfl-prop-picks-tuner': { label: 'Prop selector challenger', tick_sla_s: 8 * 86400, work_sla_s: 8 * 86400, critical: false },
});

const key = (kind, lane) => `run:${kind}:${lane}`;

function safeRecord(lane, rec) {
  return {
    lane,
    version: rec.version || null,
    cron: rec.cron || null,
    trigger: rec.trigger || 'cron',
    started_at: rec.started_at || null,
    finished_at: rec.finished_at || new Date().toISOString(),
    status: rec.status || 'ok', // ok | skipped | degraded | failed
    reason: rec.reason ? String(rec.reason).slice(0, 120) : null,
    error_class: rec.error_class ? String(rec.error_class).slice(0, 80) : null,
    counts: rec.counts && typeof rec.counts === 'object' ? rec.counts : null,
    source_freshness: rec.source_freshness || null,
    detail: rec.detail || null,
  };
}

/* Writes never throw into the caller: losing a ledger write must not lose a
 * grade. The failure is logged so it is visible in Workers logs. */
export async function recordRun(env, lane, rec) {
  const kv = env?.PICKS_KV;
  if (!kv) { console.error(`[runs] ${lane} PICKS_KV binding missing`); return false; }
  const row = JSON.stringify(safeRecord(lane, rec));
  const ttl = { expirationTtl: 60 * 86400 };
  try {
    const writes = [kv.put(key('tick', lane), row, ttl)];
    if (rec.status !== 'skipped') writes.push(kv.put(key('work', lane), row, ttl));
    if (rec.status === 'ok') writes.push(kv.put(key('ok', lane), row, ttl));
    if (rec.status === 'failed' || rec.status === 'degraded') writes.push(kv.put(key('err', lane), row, ttl));
    await Promise.all(writes);
    return true;
  } catch (error) {
    console.error(`[runs] ${lane} ledger write failed ${String(error?.message || error).slice(0, 120)}`);
    return false;
  }
}

export async function readLane(env, lane) {
  const kv = env?.PICKS_KV;
  if (!kv) return null;
  const [tick, work, ok, err] = await Promise.all(
    ['tick', 'work', 'ok', 'err'].map(kind => kv.get(key(kind, lane), { type: 'json' }).catch(() => null)),
  );
  return { tick, work, ok, err };
}

/* Health from persisted evidence only.
 *   HEALTHY   trigger alive within SLA, last work succeeded within SLA
 *   DEGRADED  trigger alive but last work failed/degraded, or work overdue
 *   STALE     no tick within SLA — the cron is not running (or cannot write)
 *   UNKNOWN   no record at all — never deployed, or never ran
 * UNKNOWN and STALE are never rendered as healthy. */
export function laneHealth(lane, rec, nowMs = Date.now()) {
  const spec = LANES[lane] || { tick_sla_s: 1800, work_sla_s: 86400, critical: false };
  const age = iso => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? Math.round((nowMs - t) / 1000) : null; };
  const tickAge = age(rec?.tick?.finished_at);
  const workAge = age(rec?.work?.finished_at);
  const okAge = age(rec?.ok?.finished_at);
  let state;
  let reason = null;
  if (tickAge === null) { state = 'UNKNOWN'; reason = 'no_run_recorded'; }
  else if (tickAge > spec.tick_sla_s) { state = 'STALE'; reason = `last_tick_${tickAge}s_exceeds_${spec.tick_sla_s}s`; }
  else if (rec?.work && (rec.work.status === 'failed' || rec.work.status === 'degraded')) {
    state = 'DEGRADED'; reason = rec.work.error_class || rec.work.reason || rec.work.status;
  } else if (workAge !== null && workAge > spec.work_sla_s) {
    state = 'DEGRADED'; reason = `last_work_${workAge}s_exceeds_${spec.work_sla_s}s`;
  } else state = 'HEALTHY';
  return {
    lane,
    label: spec.label,
    critical: spec.critical,
    state,
    reason,
    tick_age_s: tickAge,
    work_age_s: workAge,
    ok_age_s: okAge,
    sla: { tick_s: spec.tick_sla_s, work_s: spec.work_sla_s },
    last_tick: rec?.tick || null,
    last_work: rec?.work || null,
    last_ok_at: rec?.ok?.finished_at || null,
    last_error: rec?.err ? { at: rec.err.finished_at, status: rec.err.status, error_class: rec.err.error_class, reason: rec.err.reason } : null,
  };
}

export function overallHealth(lanes) {
  const critical = lanes.filter(l => l.critical);
  if (!critical.length) return 'UNKNOWN';
  if (critical.some(l => l.state === 'STALE' || l.state === 'UNKNOWN')) return 'STALE';
  if (critical.some(l => l.state === 'DEGRADED')) return 'DEGRADED';
  return 'HEALTHY';
}

export async function readAllLanes(env, lanes = Object.keys(LANES), nowMs = Date.now()) {
  const out = [];
  for (const lane of lanes) out.push(laneHealth(lane, await readLane(env, lane), nowMs));
  return out;
}

export async function lastWorkMs(env, lane) {
  try {
    const rec = await env?.PICKS_KV?.get(key('work', lane), { type: 'json' });
    const t = Date.parse(rec?.finished_at || rec?.started_at || '');
    return Number.isFinite(t) ? t : null;
  } catch (_) { return null; }
}

export async function lastWorkRecord(env, lane) {
  try { return (await env?.PICKS_KV?.get(key('work', lane), { type: 'json' })) || null; } catch (_) { return null; }
}
