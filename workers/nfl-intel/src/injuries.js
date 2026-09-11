/* Injury ingest — ESPN core API, from Cloudflare.
 *
 * ESPN's site.api (the one-call league report) refuses Cloudflare Worker
 * egress. The core API does not, and it serves the same injury records — the
 * same `status`, the same ESPN `date`, the same attributed `shortComment` and
 * `details` — one reference per player per team. So the league report is
 * rebuilt here on a schedule and persisted, instead of being fetched through a
 * relay on every page view:
 *
 *   32 team lists  ->  every current injury record (re-read each run, so an
 *   in-place status change is caught)  ->  athlete identity (cached)  ->  one
 *   league report in KV, shaped exactly like ESPN's site report so the shared
 *   classification core reads either.
 *
 * Nothing is inferred. A team whose list fails keeps its previous entries,
 * flagged stale, and the report says which teams those are; if too many fail,
 * the previous report stands and the run is recorded as degraded.
 *
 * LEDGER SEED. Each run also records, per athlete, the designation it saw and
 * when, and appends a transition when that designation changes between two of
 * our own observations. That is the foundation of the durable change ledger;
 * it is stored, not yet displayed — the product still says UPDATED.
 */

export const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';

/* ESPN team ids (verified against nfl-current and the core API, 2026-09-11). */
export const TEAMS = {
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN',
  11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ',
  21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH', 29: 'CAR', 30: 'JAX',
  33: 'BAL', 34: 'HOU'
};

export const KV_KEYS = {
  report: 'inj:v1:report',
  athletes: 'inj:v1:athletes',
  state: 'inj:v1:state',
  transitions: 'inj:v1:transitions'
};
const MAX_TEAM_FAILURES = 4;
const ATHLETE_TTL_MS = 24 * 3600000;
const ATHLETE_REFRESH_PER_RUN = 300;
const TRANSITIONS_KEPT = 1000;

const https = u => String(u || '').replace(/^http:/, 'https:');

async function getJson(fetchImpl, url) {
  const r = await fetchImpl(https(url), { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`espn_core_${r.status}`);
  return r.json();
}

/* Run `fn` over `items` with at most `n` in flight. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; try { out[k] = { ok: true, value: await fn(items[k], k) }; } catch (e) { out[k] = { ok: false, error: String(e?.message || e) }; } } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/* Injury ids can be negative (e.g. -2000004): ESPN issues those for records
   entered without a numbered report item. They are current designations. */
const refIds = ref => {
  const m = /athletes\/(\d+)\/injuries\/(-?\d+)/.exec(String(ref || ''));
  return m ? { athleteId: m[1], injuryId: m[2] } : null;
};

function athleteFrom(doc, now) {
  const team = /teams\/(\d+)/.exec(String(doc?.team?.$ref || ''));
  return {
    team_id: team ? team[1] : null,
    hydrated_at: new Date(now).toISOString(),
    id: String(doc?.id || ''),
    displayName: doc?.displayName || doc?.fullName || null,
    shortName: doc?.shortName || null,
    position: doc?.position?.abbreviation ? { abbreviation: doc.position.abbreviation } : null,
    headshot: doc?.headshot?.href ? { href: doc.headshot.href } : null
  };
}

/* One ingest run. Returns a summary; persistence is to env.INTEL_KV. */
export async function ingestInjuries(env, { season, now = Date.now(), fetchImpl = fetch, concurrency = 24 } = {}) {
  if (!season) throw new Error('season_unknown');
  const teamIds = Object.keys(TEAMS).map(Number);
  const [prevReport, athletes, prevState] = await Promise.all([
    env.INTEL_KV.get(KV_KEYS.report, 'json'),
    env.INTEL_KV.get(KV_KEYS.athletes, 'json').then(v => v || {}),
    env.INTEL_KV.get(KV_KEYS.state, 'json').then(v => v || {})
  ]);

  /* 1 · every team's current injury references */
  const lists = await pool(teamIds, 8, id => getJson(fetchImpl, `${CORE}/teams/${id}/injuries?limit=200`));
  const refs = [];
  const failedTeams = [];
  lists.forEach((res, k) => {
    const teamId = teamIds[k];
    if (!res.ok) { failedTeams.push(teamId); return; }
    for (const item of res.value?.items || []) {
      const ids = refIds(item?.$ref);
      if (ids) refs.push({ teamId, ...ids, url: item.$ref });
    }
  });
  if (failedTeams.length > MAX_TEAM_FAILURES) {
    return { ok: false, status: 'degraded', reason: 'too_many_team_failures', failed_teams: failedTeams.map(t => TEAMS[t]) };
  }

  /* 2 · every record, re-read each run (a status can change in place) */
  const records = await pool(refs, concurrency, r => getJson(fetchImpl, r.url));

  /* 3 · athlete identity and CURRENT team. A team's injury list keeps records
     for players it no longer rosters, so a record counts only while the
     athlete's own current team is the listing team. Cached, refreshed after
     ATHLETE_TTL_MS, at most ATHLETE_REFRESH_PER_RUN stale ones per run. */
  const ids = [...new Set(refs.map(r => r.athleteId))];
  const fresh = id => athletes[id]?.hydrated_at && now - Date.parse(athletes[id].hydrated_at) < ATHLETE_TTL_MS;
  const missing = [...ids.filter(id => !athletes[id]), ...ids.filter(id => athletes[id] && !fresh(id)).slice(0, ATHLETE_REFRESH_PER_RUN)];
  const hydrated = await pool(missing, concurrency, id => getJson(fetchImpl, `${CORE}/seasons/${season}/athletes/${id}`));
  let athletesChanged = false;
  hydrated.forEach((res, k) => { if (res.ok) { athletes[missing[k]] = athleteFrom(res.value, now); athletesChanged = true; } });

  /* 4 · the league report, in ESPN's site-report shape */
  const byTeam = new Map(teamIds.map(id => [id, []]));
  let recordFailures = 0, offRoster = 0;
  records.forEach((res, k) => {
    const ref = refs[k];
    if (!res.ok) { recordFailures++; return; }
    const doc = res.value || {};
    const person = athletes[ref.athleteId];
    if (!person?.displayName) return;
    if (person.team_id && person.team_id !== String(ref.teamId)) { offRoster++; return; }
    byTeam.get(ref.teamId).push({
      id: String(doc.id || ref.injuryId),
      status: doc.status || doc.type?.description || null,
      date: doc.date || null,
      shortComment: doc.shortComment || null,
      type: doc.type ? { name: doc.type.name, description: doc.type.description, abbreviation: doc.type.abbreviation } : null,
      details: doc.details || null,
      athlete: { ...person, team: { id: String(ref.teamId), abbreviation: TEAMS[ref.teamId], displayName: TEAMS[ref.teamId] } }
    });
  });
  const prevByTeam = new Map((prevReport?.report?.injuries || []).map(t => [Number(t.id), t]));
  const injuries = teamIds.map(id => {
    if (failedTeams.includes(id) && prevByTeam.has(id)) return { ...prevByTeam.get(id), stale: true };
    return { id: String(id), displayName: TEAMS[id], injuries: byTeam.get(id) };
  });
  const fetchedAt = new Date(now).toISOString();
  const entries = injuries.reduce((a, t) => a + (t.injuries || []).length, 0);
  const report = { timestamp: fetchedAt, injuries };

  /* 5 · ledger seed: designation per athlete, transitions between our observations */
  const state = {};
  const transitions = [];
  for (const t of injuries) {
    if (t.stale) continue;
    for (const e of t.injuries || []) {
      const key = e.athlete?.id; if (!key) continue;
      const before = prevState[key];
      state[key] = { status: e.status, date: e.date, injury_id: e.id, team: e.athlete.team.abbreviation, observed_at: fetchedAt };
      if (before && before.status !== e.status) {
        transitions.push({ athlete_id: key, name: e.athlete.displayName, team: e.athlete.team.abbreviation, from: before.status, to: e.status, from_observed_at: before.observed_at, source_date: e.date, observed_at: fetchedAt });
      }
    }
  }
  /* A player who dropped off every list keeps his last state marked removed —
     leaving the report is itself an observation. */
  for (const [key, before] of Object.entries(prevState)) {
    if (state[key]) continue;
    const teamStale = injuries.some(t => t.stale && t.displayName === before.team);
    state[key] = teamStale ? before : { ...before, removed_at: before.removed_at || fetchedAt };
  }

  const writes = [
    env.INTEL_KV.put(KV_KEYS.report, JSON.stringify({ fetched_at: fetchedAt, season, entries, record_failures: recordFailures, failed_teams: failedTeams.map(t => TEAMS[t]), report })),
    env.INTEL_KV.put(KV_KEYS.state, JSON.stringify(state))
  ];
  if (athletesChanged) writes.push(env.INTEL_KV.put(KV_KEYS.athletes, JSON.stringify(athletes)));
  if (transitions.length) {
    const prior = (await env.INTEL_KV.get(KV_KEYS.transitions, 'json')) || [];
    writes.push(env.INTEL_KV.put(KV_KEYS.transitions, JSON.stringify([...transitions, ...prior].slice(0, TRANSITIONS_KEPT))));
  }
  await Promise.all(writes);
  return { ok: true, status: failedTeams.length || recordFailures ? 'partial' : 'ok', entries, refs: refs.length, off_roster_skipped: offRoster, athletes_hydrated: missing.length, record_failures: recordFailures, failed_teams: failedTeams.map(t => TEAMS[t]), transitions: transitions.length };
}
