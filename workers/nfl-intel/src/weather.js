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
import { setVenues, gameSnapshot, weatherEvents, wmoDescription, THRESHOLDS } from '../../../api/_breaking/weather.js';

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

/* ---- GET /api/game-weather ------------------------------------------------
   The persisted snapshot, one compact row per game, keyed by the ESPN event id
   the schedule authority publishes for the same game. A read never contacts a
   source. Values are the kickoff-window FORECAST: temperature at the kickoff
   hour; wind, gusts and precipitation chance as the worst hour of the window. */
export const WX_STALE_MS = 2 * 3600000;
export function gameWeatherView(snapshot, now = Date.now()) {
  const fetchedMs = Date.parse(snapshot?.fetched_at || '');
  const age = Number.isFinite(fetchedMs) ? now - fetchedMs : null;
  const round = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
  const games = (Array.isArray(snapshot?.games) ? snapshot.games : []).map(s => {
    const w = s.window || null;
    return {
      event_id: String(s.event_id || s.game_id || ''),
      matchup: s.matchup || null,
      away_team: s.away_team || null,
      home_team: s.home_team || null,
      kickoff_utc: s.kickoff_utc || null,
      venue: s.venue ? { name: s.venue.name, city: s.venue.city, state: s.venue.state } : null,
      roof: s.roof ? { state: s.roof.state, label: s.roof.label, weather_applies: Boolean(s.roof.weather_applies) } : null,
      available: Boolean(s.available && w),
      forecast: w ? {
        kind: 'forecast',
        temp_f: round(w.temp_f),
        condition: wmoDescription(w.weather_code),
        weather_code: w.weather_code ?? null,
        wind_mph: round(w.wind_mph),
        gust_mph: round(w.gust_mph),
        precip_probability_pct: round(w.precip_probability_pct),
        kickoff_hour_local: w.kickoff_hour_local || null,
        window_local: w.window_local || null,
        hours_resolved: w.hours_resolved ?? null,
        hours_requested: w.hours_requested ?? null
      } : null,
      nws: (Array.isArray(s.nws) ? s.nws : []).map(a => ({ event: a.event, severity: a.severity, headline: a.headline, url: a.url, expires: a.ends || a.expires || null })),
      unresolved: Array.isArray(s.unresolved) ? s.unresolved.map(u => ({ field: u.field, reason: u.reason })) : [],
      error: s.error || null
    };
  }).filter(g => /^\d+$/.test(g.event_id));
  return {
    ok: Boolean(snapshot),
    semantics: 'KICKOFF_WINDOW_FORECAST',
    fetched_at: snapshot?.fetched_at || null,
    age_seconds: age === null ? null : Math.round(age / 1000),
    stale: age === null ? true : age > WX_STALE_MS,
    horizon_hours: Math.round(HORIZON_MS / 3600000),
    monitored: games.length,
    window: 'temperature at the kickoff hour; wind, gusts and precipitation chance are the worst hour from one hour before to three hours after kickoff',
    roof_policy: { INDOOR: 'fixed roof: weather neutralized', ROOF_STATUS_UNKNOWN: 'retractable roof, operating state not published', UNRESOLVED: 'venue not resolved (neutral site or no venue row): no forecast' },
    source: { name: 'Open-Meteo forecast', licence: 'CC-BY-4.0', attribution: 'Weather data by Open-Meteo.com, licensed CC BY 4.0', alerts: 'National Weather Service active alerts' },
    games
  };
}
