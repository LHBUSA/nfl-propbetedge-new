/* PBE BREAKING — weather engine.
 * =============================================================================
 * Turns two public sources into a deterministic per-game weather snapshot, and
 * turns a PAIR of snapshots into an event. Nothing here decides what a reader
 * sees; it decides what is TRUE, and the rail decides what is worth showing.
 *
 * SOURCES
 *   Open-Meteo forecast   — the modelled kickoff-window conditions (CC-BY-4.0)
 *   api.weather.gov       — official NWS active alerts for the stadium point
 *
 * Both are already used or already permitted by this product. No new provider,
 * no scraping, no key.
 *
 * THE FOUR RULES THIS FILE EXISTS TO ENFORCE
 *
 * 1. A FORECAST IS NOT AN OBSERVATION.
 *    Every value carries `kind: 'forecast'`. The copy layer may say "SNOW
 *    FORECAST AT KICKOFF"; nothing in this file will ever let it say "SNOWING".
 *
 * 2. A ROOF ENDS THE QUESTION.
 *    A confirmed indoor/closed venue produces NO game-impact weather event, no
 *    matter what the sky is doing outside. A retractable roof whose operating
 *    state we do not know produces ROOF STATUS UNKNOWN — never an assumption
 *    that it is open.
 *
 * 3. A NEUTRAL SITE IS NOT THE HOME TEAM'S STADIUM.
 *    Borrowing the home club's coordinates would describe the weather in the
 *    wrong city, confidently. Without the actual venue we resolve nothing.
 *
 * 4. A NEW FORECAST RUN IS NOT NEWS.
 *    Open-Meteo updates continually and wind oscillates 20/21/20/21. Events are
 *    emitted on BAND TRANSITIONS and on material deltas, never on every poll.
 *    That is what `bands` is for: a small set of strings whose CHANGE is the
 *    event, so the comparison is exact rather than a re-derived threshold.
 * ========================================================================== */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* ---------------------------------------------------------------------------
   THRESHOLDS — every number the product reasons about, in one place, named.
   These are football thresholds, not meteorological ones: 20 mph matters
   because it is where kicking and the deep ball change, not because the
   atmosphere does anything special at 20.
   ------------------------------------------------------------------------ */
export const THRESHOLDS = {
  /* Kickoff window. "What will the game actually experience", not "what is the
     weather today" — a 1pm forecast tells you nothing about an 8:20 kickoff. */
  window_hours_before: 1,
  window_hours_after: 3,

  wind_mph: { watch: 15, elevated: 20, high: 25 },
  gust_mph: { watch: 25, elevated: 35, high: 45 },

  /* Cold. Aligned with the QB/WR/RB/TE DNA condition bands so a weather alert
     and the historical split it links to are talking about the same thing. */
  temp_f: { freezing: 32, severe: 20, extreme: 10 },

  /* Snow needs BOTH modelled accumulation and a real chance of it. Either one
     alone produces alerts on days it does not snow. */
  snow: { min_accum_in: 0.01, prob_possible_pct: 40, prob_likely_pct: 60 },

  /* Rain needs a probability AND non-trivial modelled accumulation, because a
     61% chance of nothing is not a rain game. */
  rain: { min_accum_in: 0.05, heavy_accum_in: 0.30,
          prob_possible_pct: 60, prob_likely_pct: 75 },

  /* What counts as a MATERIAL change between two accepted snapshots. */
  delta: { precip_prob_pp: 30, wind_mph: 7, gust_mph: 10, temp_f: 8 },

  /* Hysteresis. A band is only surrendered once the value falls this far back
     below its floor, so 19/20/19/20 does not alternate. */
  band_release_buffer: { wind_mph: 2, gust_mph: 3, temp_f: 2 },

  /* NWS severities we will carry. Anything below this is real weather but not
     a reason to seize the one global rail. */
  nws_min_severity: ['Extreme', 'Severe', 'Moderate'],

  /* Poll cadence by time to kickoff. Faster than the source updates is waste. */
  poll_minutes: [
    { within_hours: 6, minutes: 30 },
    { within_hours: 24, minutes: 60 },
    { within_hours: 72, minutes: 60 }
  ],
  monitor_from_hours: 72
};

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const NWS_ALERTS = 'https://api.weather.gov/alerts/active';
/* NWS asks for a contact in the User-Agent. Sending one is the price of using
   a public service politely, and an anonymous request may be refused. */
const NWS_UA = 'PropBetEdge-NFL/1.0 (https://nfl.propbetedge.ai)';

let VENUES = null;
export function venues() {
  if (!VENUES) {
    VENUES = JSON.parse(readFileSync(join(process.cwd(), 'data', 'dist', 'nfl-venues.json'), 'utf8'));
  }
  return VENUES;
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const maxOf = xs => { const v = xs.filter(x => x !== null); return v.length ? Math.max(...v) : null; };
const sumOf = xs => { const v = xs.filter(x => x !== null); return v.length ? +v.reduce((a, b) => a + b, 0).toFixed(3) : null; };
const minOf = xs => { const v = xs.filter(x => x !== null); return v.length ? Math.min(...v) : null; };

async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers: { accept: 'application/json', ...headers } });
  if (!r.ok) throw new Error(`${new URL(url).host} responded ${r.status}`);
  return r.json();
}

/* ---------------------------------------------------------------------------
   ROOF TRUTH
   The venue table carries `indoor`, which covers fixed domes and permanently
   closed roofs. It does NOT record whether a retractable roof will be open on
   the day. Where we know the venue is retractable and do not know the day's
   state, we say so rather than picking the convenient answer.
   ------------------------------------------------------------------------ */

/* Venues whose roof MOVES. Their operating state is a game-day decision that
   no feed we hold reports, so the honest answer is UNKNOWN, not "open". */
export const RETRACTABLE = new Set([
  'ARI',  // State Farm Stadium
  'ATL',  // Mercedes-Benz Stadium
  'DAL',  // AT&T Stadium
  'HOU',  // NRG Stadium
  'IND'   // Lucas Oil Stadium
]);

export function roofState(teamAbbr, venueRow, { neutralSite = false } = {}) {
  if (neutralSite) {
    return { state: 'UNRESOLVED', indoor: null, weather_applies: false,
      label: 'Neutral site',
      reason: 'a neutral-site game is not played at the home club\'s stadium, so that '
            + 'venue\'s roof and coordinates do not apply and nothing is borrowed from it' };
  }
  if (!venueRow) {
    return { state: 'UNRESOLVED', indoor: null, weather_applies: false,
      label: 'Venue unresolved',
      reason: `no venue row for ${teamAbbr}` };
  }
  if (venueRow.indoor === true) {
    if (RETRACTABLE.has(teamAbbr)) {
      /* The building is indoor-capable and the roof moves. We know the venue;
         we do not know the day's setting. Both halves are stated. */
      return { state: 'ROOF_STATUS_UNKNOWN', indoor: null, weather_applies: false,
        label: 'Roof status unknown', retractable: true,
        reason: 'this venue has a retractable roof and no source we hold publishes '
              + 'its operating state for this game. Outdoor conditions are shown as '
              + 'venue context only and produce no game-impact alert.' };
    }
    return { state: 'INDOOR', indoor: true, weather_applies: false,
      label: 'Indoor', reason: 'fixed roof — outdoor conditions do not reach the field' };
  }
  return { state: 'OUTDOOR', indoor: false, weather_applies: true, label: 'Outdoor', reason: null };
}

/* ---------------------------------------------------------------------------
   KICKOFF WINDOW
   ------------------------------------------------------------------------ */

/** The venue's local wall-clock parts for a UTC instant. */
export function localParts(iso, tz) {
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(d);
  const g = t => (p.find(x => x.type === t) || {}).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) % 24 };
}

/** Every local hour stamp the game is expected to occupy. */
export function windowStamps(kickoffIso, tz, T = THRESHOLDS) {
  const out = [];
  for (let h = -T.window_hours_before; h <= T.window_hours_after; h++) {
    const t = new Date(new Date(kickoffIso).getTime() + h * 3600000);
    const { date, hour } = localParts(t.toISOString(), tz);
    out.push({ stamp: `${date}T${String(hour).padStart(2, '0')}:00`, offset_h: h });
  }
  return out;
}

const HOURLY = ['temperature_2m', 'apparent_temperature', 'precipitation_probability',
  'precipitation', 'rain', 'showers', 'snowfall', 'weather_code',
  'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'visibility'];

export function forecastUrl(lat, lon, tz, dates) {
  return `${FORECAST}?latitude=${lat}&longitude=${lon}`
    + `&hourly=${HOURLY.join(',')}`
    + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch'
    + `&timezone=${encodeURIComponent(tz)}`
    + `&start_date=${dates[0]}&end_date=${dates[dates.length - 1]}`;
}

/** WMO code families. Only used to say WHAT KIND, never how bad. */
export function wmoFamily(code) {
  const c = num(code);
  if (c === null) return null;
  if (c === 0 || c === 1) return 'clear';
  if (c === 2 || c === 3) return 'cloud';
  if (c >= 45 && c <= 48) return 'fog';
  if ((c >= 51 && c <= 57) || (c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if (c >= 95) return 'thunderstorm';
  return 'other';
}

/**
 * Aggregate the hourly forecast across the kickoff window.
 * Wind, gust and precipitation probability take the WORST hour, because a game
 * is played through its worst hour and an average would hide it. Temperature
 * takes the kickoff hour, which is what a reader means by "how cold is it".
 */
export function aggregateWindow(hourly, stamps) {
  const idx = stamps.map(s => ({ ...s, i: hourly.time.indexOf(s.stamp) })).filter(s => s.i >= 0);
  if (!idx.length) return null;
  const pick = (key, i) => num((hourly[key] || [])[i]);
  const all = key => idx.map(s => pick(key, s.i));
  const at0 = idx.find(s => s.offset_h === 0) || idx[0];

  return {
    hours_resolved: idx.length, hours_requested: stamps.length,
    window_local: [idx[0].stamp, idx[idx.length - 1].stamp],
    kickoff_hour_local: at0.stamp,

    temp_f: pick('temperature_2m', at0.i),
    apparent_temp_f: pick('apparent_temperature', at0.i),
    temp_min_f: minOf(all('temperature_2m')),

    precip_probability_pct: maxOf(all('precipitation_probability')),
    precip_in: sumOf(all('precipitation')),
    rain_in: sumOf(all('rain')),
    showers_in: sumOf(all('showers')),
    snowfall_in: sumOf(all('snowfall')),

    wind_mph: maxOf(all('wind_speed_10m')),
    gust_mph: maxOf(all('wind_gusts_10m')),
    wind_direction_deg: pick('wind_direction_10m', at0.i),

    visibility_m: minOf(all('visibility')),
    weather_code: pick('weather_code', at0.i),
    weather_family: wmoFamily(pick('weather_code', at0.i)),
    /* Stated on every reading so no consumer can mistake it for an observation. */
    kind: 'forecast'
  };
}

/* ---------------------------------------------------------------------------
   BANDS — the unit of change
   A band is a short string. Two snapshots produce an event when their band
   strings differ, which makes "did this cross a threshold" an equality test
   rather than a second, drift-prone re-derivation of the thresholds.
   ------------------------------------------------------------------------ */

export function bandsFor(w, prevBands = null, T = THRESHOLDS) {
  if (!w) return null;
  const rel = T.band_release_buffer;

  /* A band is held until the value drops clearly below its floor. Without this
     a value oscillating on a threshold emits an event every poll.

     The hold has to be tested BEFORE the natural band is returned. Checking it
     afterwards makes it unreachable: 19mph matches `watch` (>=15) on the way
     down and returns immediately, so a prior `elevated` band is released on the
     first dip instead of being held through the buffer — which is the exact
     flapping this exists to prevent. */
  const stepped = (value, steps, prev, buffer) => {
    if (value === null) return 'unknown';
    const names = Object.keys(steps).sort((a, b) => steps[b] - steps[a]);
    const natural = names.find(n => value >= steps[n]) || 'none';
    if (prev && prev !== 'none' && prev !== 'unknown' && steps[prev] !== undefined
        && steps[prev] > (steps[natural] ?? -Infinity)
        && value >= steps[prev] - buffer) {
      return prev;                       // still inside the release buffer: hold
    }
    return natural;
  };

  const wind = stepped(w.wind_mph, T.wind_mph, prevBands && prevBands.wind, rel.wind_mph);
  const gust = stepped(w.gust_mph, T.gust_mph, prevBands && prevBands.gust, rel.gust_mph);

  let cold = 'none';
  if (w.temp_f === null) cold = 'unknown';
  else if (w.temp_f <= T.temp_f.extreme) cold = 'extreme';
  else if (w.temp_f <= T.temp_f.severe) cold = 'severe';
  else if (w.temp_f < T.temp_f.freezing) cold = 'freezing';
  else if (prevBands && prevBands.cold === 'freezing'
           && w.temp_f < T.temp_f.freezing + rel.temp_f) cold = 'freezing';

  let snow = 'none';
  const snowAccum = (w.snowfall_in ?? 0) >= T.snow.min_accum_in;
  const prob = w.precip_probability_pct;
  if (w.snowfall_in === null && prob === null) snow = 'unknown';
  else if (snowAccum && prob !== null && prob >= T.snow.prob_likely_pct) snow = 'likely';
  else if (snowAccum && prob !== null && prob >= T.snow.prob_possible_pct) snow = 'possible';

  let rain = 'none';
  const rainAccum = (w.rain_in ?? 0) + (w.showers_in ?? 0);
  if (w.rain_in === null && prob === null) rain = 'unknown';
  else if (rainAccum >= T.rain.heavy_accum_in && prob !== null && prob >= T.rain.prob_possible_pct) rain = 'heavy';
  else if (rainAccum >= T.rain.min_accum_in && prob !== null && prob >= T.rain.prob_likely_pct) rain = 'likely';
  else if (rainAccum >= T.rain.min_accum_in && prob !== null && prob >= T.rain.prob_possible_pct) rain = 'possible';

  return { wind, gust, cold, snow, rain };
}

/** Is any band worth a WEATHER WATCH on its own? */
export function watchWorthy(bands) {
  if (!bands) return false;
  return bands.wind !== 'none' && bands.wind !== 'unknown'
      || bands.gust !== 'none' && bands.gust !== 'unknown'
      || bands.cold !== 'none' && bands.cold !== 'unknown'
      || bands.snow === 'possible' || bands.snow === 'likely'
      || bands.rain === 'possible' || bands.rain === 'likely' || bands.rain === 'heavy';
}

/* ---------------------------------------------------------------------------
   NWS OFFICIAL ALERTS
   ------------------------------------------------------------------------ */

/** Only US points are covered; the endpoint is a US government service. */
export async function nwsAlerts(lat, lon, T = THRESHOLDS, now = Date.now()) {
  const url = `${NWS_ALERTS}?point=${lat},${lon}`;
  const j = await getJSON(url, { 'user-agent': NWS_UA });
  const wanted = new Set(T.nws_min_severity);
  return (j.features || []).map(f => {
    const p = f.properties || {};
    return {
      id: p.id || f.id, event: p.event || null, severity: p.severity || null,
      certainty: p.certainty || null, urgency: p.urgency || null,
      headline: p.headline || null,
      /* The NWS wrote this. We carry it verbatim and never restate it in our
         own, stronger words. */
      description_source: 'National Weather Service',
      effective: p.effective || null, onset: p.onset || null,
      expires: p.expires || null, ends: p.ends || null,
      sender: p.senderName || null,
      area: p.areaDesc || null,
      url: (p.id && String(p.id).startsWith('http')) ? p.id : (f.id || url),
      source_url: url
    };
  }).filter(a => {
    if (!wanted.has(a.severity)) return false;
    // An expired warning is not an active one, whatever the feed still lists.
    const end = a.ends || a.expires;
    if (end && new Date(end).getTime() < now) return false;
    return true;
  }).sort((a, b) => {
    const rank = s => (s === 'Extreme' ? 0 : s === 'Severe' ? 1 : 2);
    return rank(a.severity) - rank(b.severity);
  });
}

/* ---------------------------------------------------------------------------
   SNAPSHOT
   ------------------------------------------------------------------------ */

export async function gameSnapshot(game, { fetchNws = true, now = Date.now() } = {}) {
  const V = venues();
  const row = game.neutral_site ? null : (V.teams[game.home_team] || null);
  const roof = roofState(game.home_team, row, { neutralSite: game.neutral_site });

  const base = {
    game_id: game.id, event_id: game.espn_event_id || game.id,
    matchup: `${game.away_team} @ ${game.home_team}`,
    home_team: game.home_team, away_team: game.away_team,
    kickoff_utc: game.kickoff_utc,
    venue_id: row ? (row.venue || null) : null,
    venue: row ? { name: row.venue, city: row.city, state: row.state,
                   lat: row.lat, lon: row.lon, tz: row.tz } : null,
    roof,
    forecast_fetched_at: new Date(now).toISOString(),
    source: 'open_meteo_forecast', source_kind: 'forecast'
  };

  if (!row) {
    return { ...base, available: false, window: null, bands: null, nws: [],
      unresolved: [{ field: 'venue', reason: roof.reason }] };
  }

  const stamps = windowStamps(game.kickoff_utc, row.tz);
  const dates = [...new Set(stamps.map(s => s.stamp.slice(0, 10)))].sort();
  const url = forecastUrl(row.lat, row.lon, row.tz, dates);

  let window = null; const unresolved = [];
  try {
    const f = await getJSON(url);
    window = aggregateWindow(f.hourly, stamps);
    if (!window) unresolved.push({ field: 'weather', reason: 'no forecast hour matched the kickoff window' });
  } catch (e) {
    unresolved.push({ field: 'weather', reason: `forecast unavailable: ${e.message}` });
  }

  let nws = [];
  if (fetchNws) {
    try { nws = await nwsAlerts(row.lat, row.lon, THRESHOLDS, now); }
    catch (e) { unresolved.push({ field: 'nws', reason: `NWS unavailable: ${e.message}` }); }
  }

  return {
    ...base, available: Boolean(window), window, bands: bandsFor(window),
    nws, source_url: url, unresolved
  };
}

/* ---------------------------------------------------------------------------
   EVENTS — a snapshot pair becomes an event, or it becomes silence
   ------------------------------------------------------------------------ */

/* Severities that describe a threat to people rather than to playing
   conditions. These reach the rail even for a game under a roof. */
export const LIFE_SAFETY_SEVERITY = new Set(['Extreme', 'Severe']);

export const WEATHER_KIND = {
  ALERT: 'WEATHER_ALERT',   // official NWS, or an extreme deterministic state
  SHIFT: 'WEATHER_SHIFT',   // materially changed since the last accepted snapshot
  WATCH: 'WEATHER_WATCH'    // significant condition present, no material change
};

const SNOW_COPY = { possible: 'SNOW POSSIBLE', likely: 'SNOW FORECAST' };
const RAIN_COPY = { possible: 'RAIN POSSIBLE', likely: 'RAIN LIKELY', heavy: 'HEAVY RAIN' };
const WIND_COPY = { watch: 'WIND 15+ MPH', elevated: 'WIND 20+ MPH', high: 'WIND 25+ MPH' };
const COLD_COPY = { freezing: 'FREEZING CONDITIONS', severe: 'SEVERE COLD GAME',
                    extreme: 'EXTREME COLD' };

/**
 * Compare a new snapshot against the previously ACCEPTED one and return the
 * events it justifies. `prev` may be null on the first observation.
 *
 * Returns [] — silence — far more often than not, and that is the point.
 */
export function weatherEvents(next, prev = null, T = THRESHOLDS) {
  const out = [];
  if (!next) return out;

  /* An official warning stands on its own and is not subject to our football
     thresholds. It is also the only weather event a roofed venue can raise,
     because a tornado warning is about the people, not the passing game.

     But that exemption has a limit. A Moderate ADVISORY — heat, wind, winter
     weather — describes outdoor conditions, and outdoor conditions do not reach
     a field under a fixed roof. Measured against the live feed on 2026-09-05, a
     Heat Advisory at Lucas Oil Stadium would otherwise have taken the one
     global rail for a game played indoors. So a roofed or unresolved venue
     carries only life-safety severities, which are about the people in the
     building and remain true whatever the roof is doing. */
  const roofOpen = Boolean(next.roof && next.roof.weather_applies);
  for (const a of (next.nws || [])) {
    const seen = prev && (prev.nws || []).some(p => p.id === a.id);
    if (seen) continue;
    if (!roofOpen && !LIFE_SAFETY_SEVERITY.has(a.severity)) continue;
    out.push({
      kind: WEATHER_KIND.ALERT, official: true,
      event_key: `nws:${next.game_id}:${a.id}`,
      label: 'NWS WEATHER ALERT',
      headline: a.event,
      /* The NWS headline, unedited. We do not paraphrase a warning. */
      detail: a.headline,
      severity: a.severity, certainty: a.certainty, urgency: a.urgency,
      effective: a.effective, expires: a.ends || a.expires,
      cta: { label: 'VIEW OFFICIAL ALERT', href: a.url, external: true },
      game: gameRef(next),
      provenance: { source: 'National Weather Service', alert_id: a.id,
                    source_url: a.source_url, kind: 'official_alert' }
    });
  }

  // Beyond an official alert, a roofed or unresolved venue raises nothing.
  if (!next.roof || !next.roof.weather_applies) return out;
  if (!next.available || !next.bands) return out;

  const nb = next.bands, pb = prev && prev.bands;
  const w = next.window, pw = prev && prev.window;

  /* ---- SHIFT: a band transition, or a material delta ---------------------- */
  const changes = [];
  if (pb) {
    const moved = (k, copy) => {
      if (nb[k] === pb[k]) return;
      if (nb[k] === 'none' || nb[k] === 'unknown') return;   // easing is not news
      changes.push({ field: k, from: pb[k], to: nb[k], copy: copy[nb[k]] || nb[k] });
    };
    moved('wind', WIND_COPY); moved('gust', {
      watch: 'GUSTS 25+ MPH', elevated: 'GUSTS 35+ MPH', high: 'GUSTS 45+ MPH' });
    moved('snow', SNOW_COPY); moved('rain', RAIN_COPY); moved('cold', COLD_COPY);

    if (pw) {
      /* Deltas are DIRECTIONAL. An unsigned comparison reports a forecast
         falling from 26mph to 5mph as "WIND FORECAST RISING", which is both
         wrong and not news: conditions easing is good news, and a rail that
         fires on improvement is a rail readers learn to close.

         So each delta fires only when it worsens — wind, gusts and rain going
         up, temperature going down. The band transitions above already ignore
         easing for the same reason. */
      const worse = (nowV, thenV, limit, rising) => {
        if (nowV === null || thenV === null || nowV === undefined || thenV === undefined) return null;
        const signed = rising ? nowV - thenV : thenV - nowV;
        return signed >= limit ? +signed.toFixed(1) : null;
      };
      const dp = worse(w.precip_probability_pct, pw.precip_probability_pct, T.delta.precip_prob_pp, true);
      const dw = worse(w.wind_mph, pw.wind_mph, T.delta.wind_mph, true);
      const dg = worse(w.gust_mph, pw.gust_mph, T.delta.gust_mph, true);
      const dt = worse(w.temp_f, pw.temp_f, T.delta.temp_f, false);
      if (dp !== null) {
        changes.push({ field: 'precip_probability', from: pw.precip_probability_pct,
                       to: w.precip_probability_pct, copy: 'PRECIPITATION CHANCE RISING',
                       delta: dp, unit: 'percentage points' });
      }
      if (dw !== null) {
        changes.push({ field: 'wind', from: pw.wind_mph, to: w.wind_mph,
                       copy: 'WIND FORECAST RISING', delta: dw, unit: 'mph' });
      }
      if (dg !== null) {
        changes.push({ field: 'gust', from: pw.gust_mph, to: w.gust_mph,
                       copy: 'GUSTS RISING', delta: dg, unit: 'mph' });
      }
      if (dt !== null) {
        changes.push({ field: 'temp', from: pw.temp_f, to: w.temp_f,
                       copy: 'TEMPERATURE FALLING', delta: dt, unit: '°F' });
      }
      if (pw.weather_family !== w.weather_family
          && ['snow', 'rain', 'thunderstorm'].includes(w.weather_family)) {
        changes.push({ field: 'weather_family', from: pw.weather_family,
                       to: w.weather_family, copy: 'CONDITIONS CHANGING' });
      }
    }
  }

  if (changes.length) {
    const lead = changes[0];
    out.push({
      kind: WEATHER_KIND.SHIFT, official: false,
      /* The band string is IN the key, so the same band re-observed produces
         the same key and is deduped. A genuine new transition produces a new
         one. This is what stops every forecast run becoming an alert. */
      event_key: `wx-shift:${next.game_id}:${bandKey(nb)}`,
      label: 'WEATHER SHIFT', headline: lead.copy,
      changes, window: w, bands: nb,
      cta: { label: 'VIEW GAME CONTEXT', route: 'weather-detail', game_id: next.game_id },
      game: gameRef(next),
      provenance: provenanceOf(next)
    });
    return out;
  }

  /* ---- WATCH: significant, but nothing changed --------------------------- */
  if (watchWorthy(nb)) {
    const headline =
      nb.snow !== 'none' && nb.snow !== 'unknown' ? SNOW_COPY[nb.snow]
      : nb.rain !== 'none' && nb.rain !== 'unknown' ? RAIN_COPY[nb.rain]
      : nb.wind !== 'none' && nb.wind !== 'unknown' ? WIND_COPY[nb.wind]
      : nb.cold !== 'none' && nb.cold !== 'unknown' ? COLD_COPY[nb.cold]
      : 'GUSTY CONDITIONS FORECAST';
    out.push({
      kind: WEATHER_KIND.WATCH, official: false,
      event_key: `wx-watch:${next.game_id}:${bandKey(nb)}`,
      label: 'WEATHER WATCH', headline,
      window: w, bands: nb,
      cta: { label: 'VIEW WEATHER', route: 'weather-detail', game_id: next.game_id },
      game: gameRef(next),
      provenance: provenanceOf(next)
    });
  }
  return out;
}

const bandKey = b => `${b.wind}/${b.gust}/${b.cold}/${b.snow}/${b.rain}`;

function gameRef(s) {
  return { game_id: s.game_id, event_id: s.event_id, matchup: s.matchup,
           home_team: s.home_team, away_team: s.away_team,
           kickoff_utc: s.kickoff_utc, venue: s.venue ? s.venue.name : null,
           roof: s.roof };
}

function provenanceOf(s) {
  return {
    source: 'Open-Meteo forecast', licence: 'CC-BY-4.0',
    attribution: 'Weather data by Open-Meteo.com, licensed CC BY 4.0',
    kind: 'forecast',
    semantics: 'FORECAST — modelled values for the kickoff window. Not an observation '
             + 'of current conditions at the stadium.',
    fetched_at: s.forecast_fetched_at,
    window_local: s.window ? s.window.window_local : null,
    hours_resolved: s.window ? s.window.hours_resolved : 0,
    source_url: s.source_url || null
  };
}

/** How often this game should be re-checked, given how close kickoff is. */
export function pollIntervalMinutes(kickoffIso, now = Date.now(), T = THRESHOLDS) {
  const hours = (new Date(kickoffIso).getTime() - now) / 3600000;
  if (hours < 0) return T.poll_minutes[0].minutes;      // live
  if (hours > T.monitor_from_hours) return null;         // not yet monitored
  for (const rule of T.poll_minutes) if (hours <= rule.within_hours) return rule.minutes;
  return T.poll_minutes[T.poll_minutes.length - 1].minutes;
}
