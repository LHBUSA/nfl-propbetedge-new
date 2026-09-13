/* Broadcast authority core — pure functions, no I/O.
 *
 * observe  ESPN scoreboard event  -> source observation (what ESPN published)
 * merge    observations           -> snapshot (keeps verified_at / changed_at)
 * join     schedule game + events -> the one ESPN event that IS this game
 * build    game + snapshot        -> the normalized `broadcast` object
 *
 * Source authority, in priority order (established 2026-09-13):
 *   1. nflverse schedule network field — does not exist (games.csv has no
 *      network column), so it can never supply one.
 *   2. ESPN competition.broadcasts / geoBroadcasts, read from ESPN's CDN
 *      scoreboard by week (Cloudflare Workers can reach cdn.espn.com).
 *   3. The same ESPN scoreboard through the existing server-side relay
 *      nfl.propbetedge.ai/api/nfl-live?range= (site.api 403s Worker egress),
 *      used only when (2) fails for a week. It carries names only.
 *   4. Nothing: UNASSIGNED when ESPN says no TV is published, UNAVAILABLE
 *      when we could not read or could not safely join.
 * There is no weekday / time-slot / team rule anywhere in this file.
 */
import { providerForName, displayName, destinationFor } from './broadcasters.js';

export const SNAPSHOT_KEY = 'schedule:broadcast:v1';
export const SEASON = 2026;
export const SEASON_TYPE_REG = 2;

const A = v => (Array.isArray(v) ? v : []);
const S = v => (v === null || v === undefined ? '' : String(v).trim());

/* ESPN team codes that differ from the nflverse codes the schedule uses. */
const ESPN_TO_SCHEDULE_TEAM = { WSH: 'WAS', LAR: 'LA' };
export const scheduleTeam = code => ESPN_TO_SCHEDULE_TEAM[S(code).toUpperCase()] || S(code).toUpperCase();

/* nflverse gameday + gametime are America/New_York wall clock. */
export function easternInstant(day, time) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(S(day)), t = /^(\d{1,2}):(\d{2})$/.exec(S(time));
  if (!d || !t) return null;
  const guess = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
  const off = easternOffsetMs(guess);
  const first = guess - off;
  return new Date(guess - easternOffsetMs(first)).toISOString();
}
function easternOffsetMs(instant) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(instant));
  const g = k => Number(parts.find(x => x.type === k).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - instant;
}
export function easternDate(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const g = k => parts.find(x => x.type === k).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
/* ESPN writes "2026-09-13T20:25Z"; normalise to a full ISO instant. */
function isoOrNull(v) {
  const ms = Date.parse(S(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/* ---- observe ------------------------------------------------------------ */

/* Channels in source order. The type ESPN gives each geoBroadcast ("TV" /
   "Streaming") is authoritative; a name that appears only in broadcasts[] is
   typed from the registry identity, and a name we do not know is 'unknown'
   rather than guessed into either list. Radio is not a watch option. */
export function channelsFromCompetition(comp) {
  if (!comp || typeof comp !== 'object') return { ok: false, error: 'competition_missing' };
  const { broadcasts, geoBroadcasts } = comp;
  if (broadcasts !== undefined && broadcasts !== null && !Array.isArray(broadcasts)) return { ok: false, error: 'broadcasts_malformed' };
  if (geoBroadcasts !== undefined && geoBroadcasts !== null && !Array.isArray(geoBroadcasts)) return { ok: false, error: 'geo_broadcasts_malformed' };
  const geoType = new Map();
  for (const g of A(geoBroadcasts)) {
    if (!g || typeof g !== 'object') return { ok: false, error: 'geo_broadcast_entry_malformed' };
    if (S(g.region) && S(g.region).toLowerCase() !== 'us') continue;
    const name = S(g.media?.shortName);
    const type = S(g.type?.shortName).toLowerCase();
    if (!name) continue;
    if (!geoType.has(name)) geoType.set(name, type);
  }
  const names = [];
  for (const b of A(broadcasts)) {
    if (!b || typeof b !== 'object' || (b.names !== undefined && !Array.isArray(b.names))) return { ok: false, error: 'broadcast_entry_malformed' };
    for (const n of A(b.names)) { const name = S(n); if (name && !names.includes(name)) names.push(name); }
  }
  for (const name of geoType.keys()) if (!names.includes(name)) names.push(name);
  const channels = [];
  for (const name of names) {
    const t = geoType.get(name);
    if (t === 'radio') continue;
    const kind = t === 'tv' ? 'network' : t === 'streaming' ? 'streaming' : providerForName(name)?.kind || 'unknown';
    const basis = t === 'tv' || t === 'streaming' ? 'espn_geo_broadcast_type' : providerForName(name) ? 'registry_identity' : 'unclassified';
    channels.push({ name, kind, basis });
  }
  return { ok: true, channels };
}

/* One raw ESPN scoreboard event (CDN xhr or site shape). */
export function observeEspnEvent(event, source) {
  const comp = A(event?.competitions)[0];
  const id = S(event?.id || comp?.id);
  if (!/^\d+$/.test(id)) return { ok: false, error: 'event_id_missing' };
  const sides = Object.fromEntries(A(comp?.competitors).map(c => [c?.homeAway, scheduleTeam(c?.team?.abbreviation)]));
  const ch = channelsFromCompetition(comp);
  if (!ch.ok) return { ok: false, event_id: id, error: ch.error };
  return {
    ok: true,
    event_id: id,
    season: Number(event?.season?.year) || null,
    season_type: Number(event?.season?.type) || null,
    week: Number(event?.week?.number) || null,
    kickoff: isoOrNull(comp?.date || event?.date),
    time_valid: typeof comp?.timeValid === 'boolean' ? comp.timeValid : null,
    away: sides.away || null,
    home: sides.home || null,
    channels: ch.channels,
    source
  };
}

/* One game from the relay's range mode: names only, no type, no timeValid. */
export function observeRelayGame(game, source) {
  const id = S(game?.id);
  if (!/^\d+$/.test(id)) return { ok: false, error: 'event_id_missing' };
  if (game?.broadcast !== undefined && !Array.isArray(game.broadcast)) return { ok: false, event_id: id, error: 'broadcast_malformed' };
  const names = [];
  for (const n of A(game?.broadcast)) { const name = S(n); if (name && !names.includes(name)) names.push(name); }
  return {
    ok: true,
    event_id: id,
    season: Number(game?.season?.year) || null,
    season_type: Number(game?.season?.type) || null,
    week: Number(game?.week) || null,
    kickoff: isoOrNull(game?.date),
    time_valid: null,
    away: game?.teams?.away?.abbreviation ? scheduleTeam(game.teams.away.abbreviation) : null,
    home: game?.teams?.home?.abbreviation ? scheduleTeam(game.teams.home.abbreviation) : null,
    channels: names.map(name => ({ name, kind: providerForName(name)?.kind || 'unknown', basis: providerForName(name) ? 'registry_identity' : 'unclassified' })),
    source
  };
}

/* A week's payload -> observations. A payload with no events array is a
   failed read, not an empty week. Events from another season, season type or
   week (the CDN answers the current week when it ignores a parameter) are
   dropped rather than trusted. */
export function observeCdnWeek(payload, week, source = 'espn_cdn_scoreboard') {
  const events = payload?.content?.sbData?.events ?? payload?.events;
  if (!Array.isArray(events) || !events.length) return { ok: false, error: 'no_events_in_payload', observations: [], rejected: [] };
  const observations = [], rejected = [];
  for (const e of events) {
    const o = observeEspnEvent(e, source);
    if (!o.ok) { rejected.push({ event_id: o.event_id || null, reason: o.error }); continue; }
    if (o.season !== SEASON || o.season_type !== SEASON_TYPE_REG || o.week !== week) { rejected.push({ event_id: o.event_id, reason: `outside_requested_week:${o.season}/${o.season_type}/${o.week}` }); continue; }
    observations.push(o);
  }
  if (!observations.length) return { ok: false, error: 'no_usable_events', observations, rejected };
  return { ok: true, observations, rejected };
}
export function observeRelayRange(payload, week, source = 'espn_site_scoreboard_via_relay') {
  if (!payload || payload.ok !== true || !Array.isArray(payload.games)) return { ok: false, error: 'relay_payload_malformed', observations: [], rejected: [] };
  const observations = [], rejected = [];
  for (const g of payload.games) {
    const o = observeRelayGame(g, source);
    if (!o.ok) { rejected.push({ event_id: o.event_id || null, reason: o.error }); continue; }
    if (o.season !== SEASON || o.season_type !== SEASON_TYPE_REG || o.week !== week) { rejected.push({ event_id: o.event_id, reason: `outside_requested_week:${o.season}/${o.season_type}/${o.week}` }); continue; }
    observations.push(o);
  }
  if (!observations.length) return { ok: false, error: 'no_usable_events', observations, rejected };
  return { ok: true, observations, rejected };
}

/* ---- merge -------------------------------------------------------------- */

export function emptySnapshot() {
  return { version: 1, season: SEASON, updated_at: null, events: {}, lanes: {}, last_joins: null };
}
const signature = channels => JSON.stringify(A(channels).map(c => [c.name, c.kind]));

/* Applies what the source said at fetchedAt. verified_at moves every time the
   source confirms; changed_at and previous move only when the published
   channels actually change, so a network flex is visible and dated. */
export function mergeObservations(snapshot, observations, fetchedAt) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : emptySnapshot();
  snap.events = snap.events && typeof snap.events === 'object' ? snap.events : {};
  let changed = 0, added = 0;
  for (const o of A(observations)) {
    if (!o?.ok) continue;
    const prev = snap.events[o.event_id];
    const sameChannels = prev && signature(prev.channels) === signature(o.channels);
    /* The relay cannot type channels; do not let a names-only read downgrade
       a typed ESPN observation of the same names. */
    const channels = sameChannels && o.source !== 'espn_cdn_scoreboard' ? prev.channels : o.channels;
    const timeValid = o.time_valid !== null ? o.time_valid : (prev && prev.kickoff === o.kickoff ? prev.time_valid : null);
    const next = {
      event_id: o.event_id, week: o.week, kickoff: o.kickoff, time_valid: timeValid,
      away: o.away, home: o.home, channels, source: o.source,
      verified_at: fetchedAt,
      first_seen_at: prev?.first_seen_at || fetchedAt,
      changed_at: prev ? (sameChannels ? prev.changed_at || null : fetchedAt) : null,
      previous: prev && !sameChannels ? { channels: prev.channels, verified_at: prev.verified_at, source: prev.source } : prev?.previous || null
    };
    if (!prev) added++; else if (!sameChannels) changed++;
    snap.events[o.event_id] = next;
  }
  snap.updated_at = fetchedAt;
  return { snapshot: snap, added, changed };
}

/* ---- join --------------------------------------------------------------- */

/* The strongest identity first: the ESPN event id nflverse publishes for the
   game, confirmed by both teams. Fallback: same away team, same home team AND
   the same Eastern calendar date on a time-valid kickoff, and only when that
   is unique. A disagreement or an ambiguity joins nothing. */
export function joinGame(game, events) {
  const list = Object.values(events || {});
  const schedKick = easternInstant(game?.gameday, game?.gametime);
  const evidence = (method, ev, extra = {}) => ({
    method,
    source_event_id: ev?.event_id || null,
    schedule_game_id: game?.game_id || null,
    schedule_kickoff: schedKick,
    source_kickoff: ev?.kickoff || null,
    kickoff_agrees: ev ? (ev.time_valid === true && ev.kickoff && schedKick ? Date.parse(ev.kickoff) === Date.parse(schedKick) : null) : null,
    ...extra
  });
  const id = S(game?.espn_event_id);
  if (id) {
    const ev = events?.[id];
    if (ev) {
      if (ev.away === game.away_team && ev.home === game.home_team) return { event: ev, evidence: evidence('espn_event_id', ev, { confidence: 'exact' }) };
      return { event: null, evidence: evidence('espn_event_id', ev, { confidence: 'rejected', conflict: `teams_disagree:${ev.away}@${ev.home}` }) };
    }
  }
  const candidates = list.filter(ev => ev.away === game?.away_team && ev.home === game?.home_team
    && ev.time_valid === true && easternDate(ev.kickoff) === game?.gameday);
  if (candidates.length === 1) return { event: candidates[0], evidence: evidence('teams_and_eastern_gameday', candidates[0], { confidence: 'strong', espn_event_id_on_schedule: id || null }) };
  if (candidates.length > 1) return { event: null, evidence: evidence('teams_and_eastern_gameday', null, { confidence: 'rejected', conflict: 'ambiguous', candidates: candidates.map(c => c.event_id) }) };
  return { event: null, evidence: evidence(id ? 'espn_event_id' : 'teams_and_eastern_gameday', null, { confidence: 'none', conflict: 'not_observed' }) };
}

/* ---- distribution ------------------------------------------------------- */

/* National vs regional is not a field ESPN gets right: it labels every NFL
   broadcast, including 1 p.m. regional CBS/FOX games, market "national". It
   is derived instead from the published slate itself: one channel can carry
   only one game at a time in a given market, so a channel with another game
   kicking off inside the same window is showing each of them to part of the
   country. A game that is the only one on every channel it airs on in its
   window is national. Unknown when the kickoff is not final or nothing is
   published. */
export const WINDOW_MS = 150 * 60000;
export function distributionFor(ev, events) {
  const names = A(ev?.channels).map(c => c.name);
  if (!names.length) return { distribution: 'unknown', national: null, distribution_basis: 'no_broadcast_published' };
  if (ev.time_valid !== true || !ev.kickoff) return { distribution: 'unknown', national: null, distribution_basis: 'kickoff_time_not_final' };
  const t = Date.parse(ev.kickoff);
  const sharing = Object.values(events || {}).filter(o => o.event_id !== ev.event_id && o.time_valid === true && o.kickoff
    && Math.abs(Date.parse(o.kickoff) - t) < WINDOW_MS && A(o.channels).some(c => names.includes(c.name)));
  if (sharing.length) return { distribution: 'regional', national: false, distribution_basis: 'concurrent_games_on_same_channel', concurrent_event_ids: sharing.map(o => o.event_id) };
  return { distribution: 'national', national: true, distribution_basis: 'only_game_on_its_channels_in_window' };
}

/* ---- build -------------------------------------------------------------- */

const STALE_NEAR_MS = 6 * 3600000;   // kickoff within 36h: hourly refresh missed 6x
const STALE_FAR_MS = 60 * 3600000;   // otherwise: daily sweep missed twice

export function isStale(ev, now) {
  const kick = Date.parse(ev?.kickoff);
  const age = now - Date.parse(ev?.verified_at);
  if (!Number.isFinite(age)) return true;
  if (Number.isFinite(kick) && kick < now - 6 * 3600000) return false; // played; the fact is settled
  const near = Number.isFinite(kick) && kick - now < 36 * 3600000;
  return age > (near ? STALE_NEAR_MS : STALE_FAR_MS);
}

export function unavailableBroadcast(reason) {
  return {
    status: 'UNAVAILABLE', primary: null, networks: [], streaming: [],
    distribution: 'unknown', national: null, local_affiliate: null, destinations: [],
    source: null, source_event_id: null, verified_at: null, reason
  };
}

export function buildBroadcast(game, snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.events) return unavailableBroadcast('broadcast_snapshot_unavailable');
  const { event: ev, evidence } = joinGame(game, snapshot.events);
  if (!ev) return { ...unavailableBroadcast(evidence.conflict === 'not_observed' ? 'game_not_observed_at_source' : 'identity_join_rejected'), match: evidence };
  const networks = [], streaming = [], unclassified = [], destinations = [];
  for (const c of A(ev.channels)) {
    const label = displayName(c.name);
    const bucket = c.kind === 'network' ? networks : c.kind === 'streaming' ? streaming : unclassified;
    if (!bucket.includes(label)) bucket.push(label);
    if (c.kind === 'network' || c.kind === 'streaming') {
      const d = destinationFor(c.name, c.kind);
      if (d && !destinations.some(x => x.provider_id === d.provider_id)) destinations.push(d);
    }
  }
  const any = networks.length + streaming.length + unclassified.length > 0;
  const status = isStale(ev, now) ? 'STALE' : any ? 'VERIFIED' : 'UNASSIGNED';
  const out = {
    status,
    primary: networks[0] || streaming[0] || unclassified[0] || null,
    networks,
    streaming,
    ...distributionFor(ev, snapshot.events),
    local_affiliate: null,
    destinations,
    source: ev.source,
    source_event_id: ev.event_id,
    verified_at: ev.verified_at,
    changed_at: ev.changed_at || null,
    previous: ev.previous ? { networks: A(ev.previous.channels).filter(c => c.kind === 'network').map(c => displayName(c.name)), streaming: A(ev.previous.channels).filter(c => c.kind === 'streaming').map(c => displayName(c.name)), verified_at: ev.previous.verified_at } : null,
    match: evidence
  };
  if (unclassified.length) out.unclassified = unclassified;
  if (out.concurrent_event_ids) delete out.concurrent_event_ids;
  return out;
}

export function joinSummary(schedule, snapshot, now = Date.now()) {
  const counts = { VERIFIED: 0, UNASSIGNED: 0, STALE: 0, UNAVAILABLE: 0 };
  const methods = {}, problems = [];
  for (const g of A(schedule)) {
    const b = buildBroadcast(g, snapshot, now);
    counts[b.status] = (counts[b.status] || 0) + 1;
    if (b.match?.method && b.source_event_id) methods[b.match.method] = (methods[b.match.method] || 0) + 1;
    if (b.status === 'UNAVAILABLE' || b.match?.kickoff_agrees === false) problems.push({ game_id: g.game_id, status: b.status, reason: b.reason || null, match: b.match || null });
  }
  return { counts, methods, problems };
}
