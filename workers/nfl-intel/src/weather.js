/* Weather lane — official NWS alerts and Open-Meteo forecast bands per game,
 * computed on a schedule and persisted, so the prior snapshot a WEATHER SHIFT
 * needs is durable instead of living in one browser session.
 *
 * Classification is the existing PBE Breaking weather module — one venue table,
 * one set of thresholds, whichever runtime asks. Game identity comes from
 * nfl-current; neutral-site flags (an international game is not played at the
 * home team's stadium) come from ESPN's CDN scoreboard, which Workers can reach.
 * If neutral-site flags cannot be read, the previous snapshot stands rather than
 * forecasting a neutral-site game at the wrong venue.
 */
import VENUE_TABLE from '../../../data/dist/nfl-venues.json' with { type: 'json' };
import { setVenues, gameSnapshot, weatherEvents, THRESHOLDS } from '../../../api/_breaking/weather.js';

setVenues(VENUE_TABLE);

export const WX_KEY = 'wx:v1:snapshot';
export const WX_MAX_AGE_MS = 30 * 60000;
const HORIZON_MS = 8 * 86400000;
const SHIFT_KEEP_MS = 24 * 3600000;

async function neutralFlags(fetchImpl) {
  const r = await fetchImpl('https://cdn.espn.com/core/nfl/scoreboard?xhr=1&limit=100', { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`espn_cdn_${r.status}`);
  const j = await r.json();
  const out = {};
  for (const e of j?.content?.sbData?.events || []) out[String(e.id)] = Boolean(e?.competitions?.[0]?.neutralSite);
  return out;
}

export async function refreshWeather(env, { games, now = Date.now(), fetchImpl = fetch } = {}) {
  const prev = await env.INTEL_KV.get(WX_KEY, 'json');
  let neutral;
  try { neutral = await neutralFlags(fetchImpl); }
  catch (e) { return { ok: false, status: 'degraded', reason: `neutral_site_unavailable:${e.message}` }; }
  const open = games.filter(g => g.semantics !== 'FINAL' && Date.parse(g.kickoff) > now - 4 * 3600000 && Date.parse(g.kickoff) < now + HORIZON_MS);
  const snaps = await Promise.all(open.map(g => gameSnapshot({
    id: g.id, espn_event_id: g.id, kickoff_utc: g.kickoff,
    home_team: g.home.abbreviation, away_team: g.away.abbreviation,
    neutral_site: neutral[g.id] === true
  }, { now }).catch(e => ({ game_id: g.id, available: false, error: String(e?.message || e) }))));
  const prevById = new Map((prev?.games || []).map(s => [String(s.game_id), s]));
  const fetchedAt = new Date(now).toISOString();
  /* Current-state events (official alerts, significant conditions) are
     recomputed every run; SHIFT events come from comparing against the last
     accepted snapshot and are kept for a day, stamped with when we saw them. */
  const current = snaps.flatMap(s => weatherEvents(s, null, THRESHOLDS));
  const shifts = snaps.flatMap(s => weatherEvents(s, prevById.get(String(s.game_id)) || null, THRESHOLDS)
    .filter(e => e.kind === 'WEATHER_SHIFT').map(e => ({ ...e, observed_at: fetchedAt })));
  const keptShifts = [...shifts, ...(prev?.shifts || []).filter(e => now - Date.parse(e.observed_at) < SHIFT_KEEP_MS)];
  const snapshot = {
    fetched_at: fetchedAt,
    games: snaps,
    events: current,
    shifts: keptShifts,
    monitored: snaps.length,
    semantics: {
      forecast: 'Open-Meteo modelled values across the kickoff window. NOT an observation.',
      official: 'National Weather Service active alerts, carried verbatim.',
      never: 'Does not claim current conditions at the stadium and does not attribute any market movement to weather.'
    }
  };
  await env.INTEL_KV.put(WX_KEY, JSON.stringify(snapshot));
  return { ok: true, status: 'ok', monitored: snaps.length, events: current.length, shifts: shifts.length };
}
