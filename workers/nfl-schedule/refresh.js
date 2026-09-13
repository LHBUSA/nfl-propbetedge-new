/* Broadcast refresh — the only code in nfl-schedule that contacts a source,
 * and it runs only from the cron trigger. Page traffic never reaches it.
 *
 * Cadence (cron every 15 minutes; this planner decides whether a tick reads):
 *   sweep    every week of the season once a day, 6 weeks per tick, so a full
 *            pass is 18 requests spread over three ticks
 *   near     the current and next week every hour (2 requests)
 *   gameday  the current week every 15 minutes while any game kicks off in
 *            the next 12 hours or kicked off in the last 4 (1 request)
 * A tick issues at most 8 upstream requests. Idle ticks issue none.
 *
 * Each week is read from ESPN's CDN scoreboard, which Workers can reach. If
 * that read fails, the same week is read through the existing server-side
 * relay (nfl.propbetedge.ai/api/nfl-live?range=), which fronts site.api for
 * Worker egress. A week that fails both keeps its previous observations; the
 * serve path marks them STALE once they age past the staleness bounds.
 */
import {
  SNAPSHOT_KEY, SEASON, emptySnapshot, mergeObservations, observeCdnWeek, observeRelayRange,
  easternInstant, joinSummary
} from './broadcast-core.js';

export const CDN_WEEK_URL = w => `https://cdn.espn.com/core/nfl/scoreboard?xhr=1&limit=100&week=${w}&seasontype=2&year=${SEASON}`;
export const RELAY_RANGE_URL = range => `https://nfl.propbetedge.ai/api/nfl-live?range=${range}`;

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const SWEEP_EVERY_MS = DAY;
export const SWEEP_CHUNK = 6;
export const NEAR_EVERY_MS = HOUR;
export const GAMEDAY_EVERY_MS = 15 * MIN;
const RETRY_AFTER_MS = 14 * MIN;
const TICK_SLACK_MS = 60000;   // cron ticks are not exact to the second
export const MAX_REQUESTS_PER_TICK = 8;
export const LAST_WEEK = 18;

const kickoffOf = g => Date.parse(easternInstant(g.gameday, g.gametime));

export function currentWeek(schedule, now) {
  const open = schedule.filter(g => kickoffOf(g) >= now - 6 * HOUR).map(g => Number(g.week));
  return open.length ? Math.min(...open) : LAST_WEEK;
}
export function isGameday(schedule, now) {
  return schedule.some(g => { const k = kickoffOf(g); return k >= now - 4 * HOUR && k <= now + 12 * HOUR; });
}
const since = (now, iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? now - t : Infinity; };

/* Pure: which weeks this tick reads, and why. */
export function planRefresh(snapshot, schedule, now) {
  const lanes = snapshot?.lanes || {};
  const weeks = new Map();
  const add = (w, why) => { if (w >= 1 && w <= LAST_WEEK) weeks.set(w, [...(weeks.get(w) || []), why]); };

  const sweep = lanes.sweep || {};
  const sweepRunning = Number(sweep.cursor) > 1;
  const sweepDue = sweepRunning || since(now, sweep.completed_at) >= SWEEP_EVERY_MS - TICK_SLACK_MS;
  let sweepWeeks = [];
  if (sweepDue && since(now, sweep.last_failure_at) >= RETRY_AFTER_MS) {
    const from = sweepRunning ? Number(sweep.cursor) : 1;
    for (let w = from; w < from + SWEEP_CHUNK && w <= LAST_WEEK; w++) sweepWeeks.push(w);
    sweepWeeks.forEach(w => add(w, 'sweep'));
  }

  const cur = currentWeek(schedule, now);
  const near = lanes.near || {};
  if (since(now, near.last_success_at) >= NEAR_EVERY_MS - TICK_SLACK_MS && since(now, near.last_attempt_at) >= RETRY_AFTER_MS) {
    add(cur, 'near'); add(Math.min(LAST_WEEK, cur + 1), 'near');
  }
  const gd = lanes.gameday || {};
  const gameday = isGameday(schedule, now);
  if (gameday && since(now, gd.last_success_at) >= GAMEDAY_EVERY_MS - TICK_SLACK_MS && since(now, gd.last_attempt_at) >= GAMEDAY_EVERY_MS - TICK_SLACK_MS) add(cur, 'gameday');

  const list = [...weeks.entries()].sort((a, b) => a[0] - b[0]).slice(0, MAX_REQUESTS_PER_TICK);
  return { weeks: list.map(([week, reasons]) => ({ week, reasons })), current_week: cur, gameday, sweep_weeks: sweepWeeks };
}

/* Compact YYYYMMDD range around a week's scheduled dates, for the relay. */
export function relayRangeForWeek(schedule, week) {
  const days = schedule.filter(g => Number(g.week) === week).map(g => Date.parse(`${g.gameday}T12:00:00Z`)).filter(Number.isFinite);
  if (!days.length) return null;
  const fmt = ms => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
  return `${fmt(Math.min(...days) - DAY)}-${fmt(Math.max(...days) + DAY)}`;
}

async function readJson(fetchImpl, url) {
  const r = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`http_${r.status}`);
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error('non_json'); }
}

export async function readWeek(week, schedule, fetchImpl) {
  const attempts = [];
  try {
    const obs = observeCdnWeek(await readJson(fetchImpl, CDN_WEEK_URL(week)), week);
    attempts.push({ source: 'espn_cdn_scoreboard', ok: obs.ok, error: obs.error || null, events: obs.observations.length, rejected: obs.rejected.length });
    if (obs.ok) return { ok: true, week, observations: obs.observations, attempts, requests: 1 };
  } catch (e) {
    attempts.push({ source: 'espn_cdn_scoreboard', ok: false, error: String(e?.message || e).slice(0, 120) });
  }
  const range = relayRangeForWeek(schedule, week);
  if (!range) return { ok: false, week, observations: [], attempts, requests: 1 };
  try {
    const obs = observeRelayRange(await readJson(fetchImpl, RELAY_RANGE_URL(range)), week);
    attempts.push({ source: 'espn_site_scoreboard_via_relay', ok: obs.ok, error: obs.error || null, events: obs.observations.length, rejected: obs.rejected.length });
    return { ok: obs.ok, week, observations: obs.observations, attempts, requests: 2 };
  } catch (e) {
    attempts.push({ source: 'espn_site_scoreboard_via_relay', ok: false, error: String(e?.message || e).slice(0, 120) });
    return { ok: false, week, observations: [], attempts, requests: 2 };
  }
}

/* Runs one tick against a snapshot. Pure apart from fetchImpl; the caller
   owns reading and writing KV. Returns the next snapshot (or null when this
   tick had nothing to do). */
export async function runRefresh({ snapshot, schedule, now = Date.now(), fetchImpl = fetch }) {
  const plan = planRefresh(snapshot, schedule, now);
  if (!plan.weeks.length) return { ran: false, plan, snapshot: null };
  const snap = snapshot && typeof snapshot === 'object' ? structuredClone(snapshot) : emptySnapshot();
  snap.lanes = snap.lanes || {};
  const at = new Date(now).toISOString();
  const results = [];
  let requests = 0;
  for (const { week, reasons } of plan.weeks) {
    const r = await readWeek(week, schedule, fetchImpl);
    requests += r.requests;
    if (r.ok) mergeObservations(snap, r.observations, at);
    results.push({ week, reasons, ok: r.ok, attempts: r.attempts });
  }
  const okFor = reason => results.filter(r => r.reasons.includes(reason));
  const laneUpdate = (name, rows) => {
    if (!rows.length) return;
    const lane = snap.lanes[name] || {};
    lane.last_attempt_at = at;
    if (rows.every(r => r.ok)) { lane.last_success_at = at; lane.last_error = null; }
    else { lane.last_failure_at = at; lane.last_error = rows.filter(r => !r.ok).map(r => `wk${r.week}:${r.attempts.map(a => `${a.source}:${a.error}`).join('|')}`).join(' ; ').slice(0, 400); }
    snap.lanes[name] = lane;
  };
  laneUpdate('near', okFor('near'));
  laneUpdate('gameday', okFor('gameday'));

  const sweepRows = okFor('sweep');
  if (sweepRows.length) {
    const lane = snap.lanes.sweep || {};
    lane.last_attempt_at = at;
    if (sweepRows.every(r => r.ok)) {
      const last = Math.max(...plan.sweep_weeks);
      if (last >= LAST_WEEK) { lane.cursor = 1; lane.completed_at = at; } else { lane.cursor = last + 1; }
      if (plan.sweep_weeks[0] === 1) lane.started_at = at;
      lane.last_error = null;
    } else {
      lane.last_failure_at = at;
      lane.last_error = sweepRows.filter(r => !r.ok).map(r => `wk${r.week}`).join(',');
    }
    snap.lanes.sweep = lane;
  }
  snap.last_tick = { at, requests, weeks: results.map(r => ({ week: r.week, reasons: r.reasons, ok: r.ok, attempts: r.attempts })) };
  snap.last_joins = { at, ...summaryCounts(joinSummary(schedule, snap, now)) };
  return { ran: true, plan, snapshot: snap, requests, results };
}

function summaryCounts(s) {
  return { counts: s.counts, methods: s.methods, problems: s.problems.slice(0, 40) };
}

export async function scheduledRefresh(env, schedule, now = Date.now(), fetchImpl = fetch) {
  /* A failed read is not an empty store: writing a fresh snapshot over it
     would erase verified_at / changed_at history, so the tick stops. A
     missing key (first run) is null and starts clean. */
  let snapshot;
  try { snapshot = await env.NFL_KV.get(SNAPSHOT_KEY, { type: 'json' }); }
  catch (e) { return { ran: false, error: `snapshot_read_failed:${String(e?.message || e).slice(0, 120)}` }; }
  const out = await runRefresh({ snapshot, schedule, now, fetchImpl });
  if (out.ran && out.snapshot) await env.NFL_KV.put(SNAPSHOT_KEY, JSON.stringify(out.snapshot));
  return out;
}
