/* GET /api/qb-dna/game-context
 *   (no args)          the real upcoming slate from ESPN's public scoreboard
 *   ?event_id=401872931   one game, resolved into the exact context that
 *                         /api/qb-dna/compare?mode=context consumes
 *
 * This is the bridge between a LIVE schedule and our HISTORICAL splits. It
 * resolves the venue from our own venue table (not from a guess about the team
 * name), and it fetches a forecast ONLY for an open-air venue. A roofed game
 * gets no weather, and none is inferred for it.
 *
 * Every value is labelled with where it came from. Nothing is estimated.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';

let VENUES = null;
function venues() {
  if (!VENUES) VENUES = JSON.parse(readFileSync(join(process.cwd(), 'data', 'dist', 'nfl-venues.json'), 'utf8'));
  return VENUES;
}

function send(res, status, body, ttl = 0) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', status === 200 && ttl > 0
    ? `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}` : 'no-store');
  res.end(JSON.stringify(body));
}

async function getJSON(url, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/** The venue's own local wall-clock parts for a UTC instant. */
function localParts(iso, tz) {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(hour), minute: Number(p.minute) };
}

function shapeEvent(ev) {
  const c = ev.competitions && ev.competitions[0];
  if (!c) return null;
  const home = c.competitors.find(x => x.homeAway === 'home');
  const away = c.competitors.find(x => x.homeAway === 'away');
  if (!home || !away) return null;
  const homeAbbr = home.team.abbreviation, awayAbbr = away.team.abbreviation;
  const v = venues().teams[homeAbbr] || null;
  return {
    espn_event_id: String(ev.id),
    label: `${awayAbbr} @ ${homeAbbr}`,
    kickoff_utc: ev.date,
    status: c.status && c.status.type && c.status.type.name,
    home_team: homeAbbr, away_team: awayAbbr,
    home_team_espn_id: String(home.team.id), away_team_espn_id: String(away.team.id),
    espn_venue: (c.venue && c.venue.fullName) || null,
    espn_venue_indoor: c.venue ? Boolean(c.venue.indoor) : null,
    venue: v,
    // our own table is authoritative; ESPN's flag is kept for comparison
    roof_source: v ? 'pbe_venue_table' : 'espn_only',
    neutral_site: Boolean(c.neutralSite)
  };
}

export default async function handler(req, res) {
  const q = req.query || {};
  let board;
  try {
    board = await getJSON(SCOREBOARD);
  } catch (e) {
    return send(res, 502, { ok: false, error: 'scoreboard_unavailable', detail: String(e.message) });
  }
  const events = (board.events || []).map(shapeEvent).filter(Boolean);

  if (!q.event_id) {
    return send(res, 200, {
      ok: true,
      season: board.season, week: board.week,
      games: events,
      source: { scoreboard: SCOREBOARD, fetched_at: new Date().toISOString() }
    }, 120);
  }

  const g = events.find(e => e.espn_event_id === String(q.event_id));
  if (!g) return send(res, 404, { ok: false, error: 'event_not_on_current_scoreboard', event_id: String(q.event_id) });

  // A neutral-site game is NOT the home team's venue. Say so rather than
  // silently applying the wrong stadium's roof and coordinates.
  if (g.neutral_site) {
    return send(res, 200, {
      ok: true, game: g,
      context: { roof: null, indoor: null },
      unresolved: [{ field: 'venue', reason: 'neutral-site game - the home team venue does not apply' }],
      compare_query: null
    }, 300);
  }
  if (!g.venue) {
    return send(res, 200, {
      ok: true, game: g, context: { roof: null },
      unresolved: [{ field: 'venue', reason: `no venue row for home team ${g.home_team}` }],
      compare_query: null
    }, 300);
  }

  const local = localParts(g.kickoff_utc, g.venue.tz);
  const indoor = g.venue.indoor === true;
  const ctx = {
    roof: indoor ? 'closed' : 'outdoors',
    indoor,
    kickoff_local_date: local.date,
    kickoff_local_hour: local.hour,
    primetime: local.hour >= 19,
    home_team: g.home_team, away_team: g.away_team
  };

  const unresolved = [];
  let forecast = null;
  if (indoor) {
    unresolved.push({ field: 'weather',
      reason: 'roofed venue - no forecast is fetched and no conditions are inferred' });
  } else {
    const url = `${FORECAST}?latitude=${g.venue.lat}&longitude=${g.venue.lon}`
      + '&hourly=temperature_2m,wind_speed_10m,precipitation,rain,snowfall,weather_code'
      + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch'
      + `&timezone=${encodeURIComponent(g.venue.tz)}&start_date=${local.date}&end_date=${local.date}`;
    try {
      const f = await getJSON(url);
      const stamp = `${local.date}T${String(local.hour).padStart(2, '0')}:00`;
      const i = f.hourly.time.indexOf(stamp);
      if (i < 0) {
        unresolved.push({ field: 'weather', reason: `no forecast hour matching ${stamp}` });
      } else {
        forecast = {
          hour_local: stamp,
          temp_f: f.hourly.temperature_2m[i],
          wind_mph: f.hourly.wind_speed_10m[i],
          precip_in: f.hourly.precipitation[i],
          rain_in: f.hourly.rain[i],
          snow_in: f.hourly.snowfall[i],
          wmo_code: f.hourly.weather_code[i],
          source: 'open_meteo_forecast', source_url: url
        };
        ctx.temp_f = forecast.temp_f;
        ctx.wind_mph = forecast.wind_mph;
        // Our historical rain/snow flags are ACCUMULATION > 0. The forecast is
        // mapped on that same rule, so trace drizzle is not counted as rain.
        ctx.precip = forecast.snow_in > 0 ? 'snow' : forecast.rain_in > 0 ? 'rain' : 'none';
      }
    } catch (e) {
      unresolved.push({ field: 'weather', reason: `forecast unavailable: ${e.message}` });
    }
  }

  // the exact query string a caller passes to /api/qb-dna/compare
  const build = (playerId, isHome) => {
    const p = [`player_id=${playerId}`, `roof=${ctx.roof}`, `home=${isHome}`,
               `opponent=${isHome ? g.away_team : g.home_team}`, `primetime=${ctx.primetime}`];
    if (ctx.temp_f !== undefined) p.push(`temp_f=${ctx.temp_f}`);
    if (ctx.wind_mph !== undefined) p.push(`wind_mph=${ctx.wind_mph}`);
    if (ctx.precip !== undefined) p.push(`precip=${ctx.precip}`);
    return p.join('&');
  };

  send(res, 200, {
    ok: true,
    game: g,
    context: ctx,
    forecast,
    unresolved,
    // divisional is NOT supplied - it is a property of the two franchises and
    // this endpoint does not carry a division table, so it is left unevaluated
    // rather than guessed
    compare_query: { home_template: build('PLAYER_ID', true), away_template: build('PLAYER_ID', false) },
    build_hint: 'replace PLAYER_ID with a GSIS id and GET /api/qb-dna/compare?<query>',
    sources: {
      schedule: SCOREBOARD,
      venue: 'PropBetEdge venue table (ESPN teams API + Open-Meteo geocoding)',
      weather: indoor ? null : 'Open-Meteo forecast API'
    }
  }, 300);
}
