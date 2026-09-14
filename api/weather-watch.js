/* GET /api/weather-watch
 *   (no args)                every monitored game in the slate, with snapshots
 *   ?event_id=401772936      one game
 *   ?nws=0                   skip the NWS lookup (used by the fixture tests)
 *
 * The weather half of PBE BREAKING. It returns SNAPSHOTS and the THRESHOLDS
 * that classify them; it does not decide what appears on the rail.
 *
 * WHY THE CLIENT HOLDS THE PRIOR SNAPSHOT
 * A WEATHER SHIFT is the difference between two observations, so something has
 * to remember the earlier one. This prototype has no durable store — a
 * serverless function keeps nothing between invocations — so the session holds
 * its own prior snapshots and posts the relevant part back as `bands`. The
 * CLASSIFICATION still happens here, in one place, so there is no second copy
 * of the thresholds to drift: the client sends what it saw, the server says
 * what that means.
 *
 * Given a durable store this moves server-side unchanged, because
 * weatherEvents(next, prev) is already a pure function of two snapshots.
 */
import { gameSnapshot, weatherEvents, pollIntervalMinutes, THRESHOLDS, venues }
  from './_breaking/weather.js';

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

function send(res, status, body, ttl = 0) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', status === 200 && ttl > 0
    ? `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}` : 'no-store');
  res.end(JSON.stringify(body));
}

async function slate() {
  const r = await fetch(SCOREBOARD, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`scoreboard responded ${r.status}`);
  const j = await r.json();
  return (j.events || []).map(e => {
    const c = (e.competitions || [])[0] || {};
    const cs = c.competitors || [];
    const home = cs.find(x => x.homeAway === 'home') || {};
    const away = cs.find(x => x.homeAway === 'away') || {};
    return {
      id: String(e.id), espn_event_id: String(e.id),
      kickoff_utc: e.date,
      home_team: (home.team || {}).abbreviation || null,
      away_team: (away.team || {}).abbreviation || null,
      neutral_site: Boolean(c.neutralSite),
      status: ((e.status || {}).type || {}).state || null
    };
  }).filter(g => g.home_team && g.away_team);
}

export default async function handler(req, res) {
  const q = req.query || {};
  const now = Date.now();
  const fetchNws = q.nws !== '0';

  let games;
  try {
    games = await slate();
  } catch (e) {
    return send(res, 502, { ok: false, error: 'slate_unavailable', detail: e.message });
  }
  if (q.event_id) games = games.filter(g => g.espn_event_id === String(q.event_id));
  if (!games.length) {
    return send(res, 200, { ok: true, games: [], monitored: 0,
      reason: q.event_id ? 'no game with that event id in the current slate'
                         : 'no games in the current slate',
      thresholds: THRESHOLDS }, 120);
  }

  /* Only games inside the monitoring horizon are fetched. Pulling a forecast
     for a game eight days out would be data we have no use for and a request
     the source did not need to serve. */
  const monitored = games.filter(g => pollIntervalMinutes(g.kickoff_utc, now) !== null);
  const skipped = games.filter(g => pollIntervalMinutes(g.kickoff_utc, now) === null)
    .map(g => ({ event_id: g.espn_event_id, matchup: `${g.away_team} @ ${g.home_team}`,
                 kickoff_utc: g.kickoff_utc,
                 reason: `kickoff is more than ${THRESHOLDS.monitor_from_hours}h away` }));

  /* The client's prior band strings, if it has any:
       ?prev=<event_id>:<wind>/<gust>/<cold>/<snow>/<rain>,<event_id>:...
     Only the bands travel, not a whole snapshot — they are the only part the
     transition test reads, and a short opaque token keeps the URL cacheable. */
  const priorBands = new Map();
  if (q.prev) {
    for (const part of String(q.prev).split(',')) {
      const [id, key] = part.split(':');
      if (!id || !key) continue;
      const [wind, gust, cold, snow, rain] = key.split('/');
      if (rain === undefined) continue;
      priorBands.set(id, { wind, gust, cold, snow, rain });
    }
  }
  /* Alert ids the client has already shown, so a standing NWS warning is not
     re-raised on every poll for the life of the warning. */
  const seenAlerts = new Set(String(q.seen_alerts || '').split(',').filter(Boolean));

  const results = await Promise.all(monitored.map(async g => {
    try {
      const snap = await gameSnapshot(g, { fetchNws, now });
      const prevB = priorBands.get(g.espn_event_id) || null;
      const prev = prevB
        ? { bands: prevB, window: null,
            nws: [...seenAlerts].map(id => ({ id })) }
        : (seenAlerts.size ? { bands: null, window: null,
                               nws: [...seenAlerts].map(id => ({ id })) } : null);
      const events = weatherEvents(snap, prev, THRESHOLDS);
      return { ...snap, events,
        poll_in_minutes: pollIntervalMinutes(g.kickoff_utc, now),
        hours_to_kickoff: +(((new Date(g.kickoff_utc).getTime() - now) / 3600000)).toFixed(1) };
    } catch (e) {
      return { game_id: g.id, event_id: g.espn_event_id,
        matchup: `${g.away_team} @ ${g.home_team}`, available: false, events: [],
        unresolved: [{ field: 'snapshot', reason: e.message }] };
    }
  }));

  const events = results.flatMap(r => r.events || []);
  send(res, 200, {
    ok: true,
    games: results,
    monitored: results.length,
    skipped,
    events,
    event_count: events.length,
    /* Silence is the normal state and the payload says so out loud, so an empty
       rail reads as "nothing is happening" rather than "something is broken". */
    silent: events.length === 0,
    thresholds: THRESHOLDS,
    roof_policy: {
      INDOOR: 'a fixed roof produces no game-impact weather event',
      ROOF_STATUS_UNKNOWN: 'a retractable roof whose operating state is unpublished is '
                         + 'reported as unknown and produces no game-impact weather event; '
                         + 'it is never assumed open',
      UNRESOLVED: 'a neutral-site game uses the actual venue or nothing — the home club\'s '
                + 'stadium coordinates are never borrowed'
    },
    semantics: {
      forecast: 'Open-Meteo modelled values across the kickoff window. NOT an observation.',
      official: 'National Weather Service active alerts, carried verbatim.',
      never: 'This endpoint does not claim current conditions at the stadium and does not '
           + 'attribute any market movement to weather.'
    },
    sources: [
      { name: 'Open-Meteo forecast', url: 'https://open-meteo.com/', licence: 'CC-BY-4.0',
        attribution: 'Weather data by Open-Meteo.com, licensed CC BY 4.0' },
      { name: 'National Weather Service active alerts', url: 'https://api.weather.gov/',
        licence: 'US Government public domain',
        attribution: 'Official alerts from the National Weather Service' },
      { name: 'ESPN public scoreboard', url: SCOREBOARD, licence: 'public endpoint' }
    ],
    venue_registry: { teams: Object.keys(venues().teams).length,
                      source: 'data/dist/nfl-venues.json' },
    fetched_at: new Date(now).toISOString()
  }, 300);
}
