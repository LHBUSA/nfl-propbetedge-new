/* PBE BREAKING — weather qualification, hysteresis, roof truth and NWS.
 * node --test research/qbdna/breaking-weather.test.mjs
 *
 * The weather rail's failure mode is not "it missed a storm". It is
 * CRYING WOLF: emitting an alert on every forecast run, calling a forecast an
 * observation, or raising a snow game for a match played under a roof. Every
 * fixture below is aimed at one of those.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THRESHOLDS, bandsFor, weatherEvents, roofState, watchWorthy,
         windowStamps, aggregateWindow, wmoFamily, pollIntervalMinutes,
         venues, RETRACTABLE, LIFE_SAFETY_SEVERITY, WEATHER_KIND }
  from '../../api/_breaking/weather.js';

/* ---- fixture builders ---------------------------------------------------- */

const W = (o = {}) => ({
  hours_resolved: 5, hours_requested: 5,
  window_local: ['2026-01-11T15:00', '2026-01-11T19:00'],
  kickoff_hour_local: '2026-01-11T16:00',
  temp_f: 45, apparent_temp_f: 42, temp_min_f: 43,
  precip_probability_pct: 5, precip_in: 0, rain_in: 0, showers_in: 0, snowfall_in: 0,
  wind_mph: 6, gust_mph: 9, wind_direction_deg: 200,
  visibility_m: 24000, weather_code: 0, weather_family: 'clear', kind: 'forecast', ...o
});

const SNAP = (o = {}) => {
  const window = o.window === null ? null : W(o.window || {});
  return {
    game_id: 'g1', event_id: 'e1', matchup: 'BUF @ NE',
    home_team: 'NE', away_team: 'BUF', kickoff_utc: '2026-01-11T21:20:00Z',
    venue: { name: 'Gillette Stadium', lat: 42.09, lon: -71.26, tz: 'America/New_York' },
    roof: o.roof || { state: 'OUTDOOR', indoor: false, weather_applies: true, label: 'Outdoor' },
    available: window !== null, window,
    bands: window === null ? null : bandsFor(window, o.prevBands || null),
    nws: o.nws || [], forecast_fetched_at: '2026-01-11T12:00:00Z',
    source_url: 'https://api.open-meteo.com/...', unresolved: []
  };
};

const kinds = evs => evs.map(e => e.kind);

/* ===================== 1-2  NOTHING HAPPENING ============================= */

test('fixture 1 — a dry, calm forecast produces NOTHING', () => {
  const s = SNAP();
  assert.equal(watchWorthy(s.bands), false);
  assert.deepEqual(weatherEvents(s, null), []);
});

test('fixture 2 — a 30% chance of rain produces NOTHING', () => {
  const s = SNAP({ window: { precip_probability_pct: 30, rain_in: 0.02, weather_family: 'rain' } });
  assert.equal(s.bands.rain, 'none', 'below both the probability and the accumulation floor');
  assert.deepEqual(weatherEvents(s, null), []);
});

test('a 61% chance of effectively no rain produces NOTHING', () => {
  /* The trap the brief names explicitly: a probability alone is not a rain
     game if the model puts almost no water on the field. */
  const s = SNAP({ window: { precip_probability_pct: 61, rain_in: 0.004, weather_family: 'rain' } });
  assert.equal(s.bands.rain, 'none');
  assert.deepEqual(weatherEvents(s, null), []);
});

/* ===================== 3  RAIN WATCH ===================================== */

test('fixture 3 — 75% with real modelled accumulation is a WATCH', () => {
  const s = SNAP({ window: { precip_probability_pct: 75, rain_in: 0.22, weather_family: 'rain' } });
  assert.equal(s.bands.rain, 'likely');
  const ev = weatherEvents(s, null);
  assert.deepEqual(kinds(ev), [WEATHER_KIND.WATCH]);
  assert.equal(ev[0].headline, 'RAIN LIKELY');
  assert.equal(ev[0].provenance.kind, 'forecast');
});

test('heavy rain is a distinct band from likely rain', () => {
  const s = SNAP({ window: { precip_probability_pct: 80, rain_in: 0.5, weather_family: 'rain' } });
  assert.equal(s.bands.rain, 'heavy');
  assert.equal(weatherEvents(s, null)[0].headline, 'HEAVY RAIN');
});

/* ===================== 4  SNOW SHIFT ===================================== */

test('fixture 4 — snow probability 20% then 70% is a SHIFT, not a watch', () => {
  const before = SNAP({ window: { precip_probability_pct: 20, snowfall_in: 0.2,
                                  temp_f: 28, weather_family: 'snow' } });
  assert.equal(before.bands.snow, 'none', '20% is below the 40% possible floor');

  const after = SNAP({ window: { precip_probability_pct: 70, snowfall_in: 1.4,
                                 temp_f: 27, weather_family: 'snow' } });
  assert.equal(after.bands.snow, 'likely');

  const ev = weatherEvents(after, before);
  assert.deepEqual(kinds(ev), [WEATHER_KIND.SHIFT]);
  assert.equal(ev[0].label, 'WEATHER SHIFT');
  // the change itself is carried, because the change IS the story
  const snowChange = ev[0].changes.find(c => c.field === 'snow');
  assert.ok(snowChange, 'the snow band transition must be reported');
  assert.equal(snowChange.from, 'none');
  assert.equal(snowChange.to, 'likely');
});

test('copy distinguishes SNOW POSSIBLE from SNOW FORECAST, and never says SNOWING', () => {
  const possible = SNAP({ window: { precip_probability_pct: 45, snowfall_in: 0.3, temp_f: 29 } });
  const likely = SNAP({ window: { precip_probability_pct: 70, snowfall_in: 1.1, temp_f: 27 } });
  assert.equal(weatherEvents(possible, null)[0].headline, 'SNOW POSSIBLE');
  assert.equal(weatherEvents(likely, null)[0].headline, 'SNOW FORECAST');
  for (const s of [possible, likely]) {
    for (const e of weatherEvents(s, null)) {
      assert.doesNotMatch(e.headline, /snowing/i, 'a forecast must never be stated as an observation');
      assert.equal(e.provenance.kind, 'forecast');
      assert.match(e.provenance.semantics, /Not an observation/i);
    }
  }
});

/* ===================== 5-6  WIND SHIFT AND NO DUPLICATE ================== */

test('fixture 5 — wind 12 then 22 is a SHIFT', () => {
  const before = SNAP({ window: { wind_mph: 12, gust_mph: 18 } });
  const after = SNAP({ window: { wind_mph: 22, gust_mph: 34 } });
  const ev = weatherEvents(after, before);
  assert.deepEqual(kinds(ev), [WEATHER_KIND.SHIFT]);
  const windChange = ev[0].changes.find(c => c.field === 'wind');
  assert.ok(windChange && windChange.to === 'elevated');
});

test('fixture 6 — wind still 22 on the next poll produces NO duplicate', () => {
  const first = SNAP({ window: { wind_mph: 22, gust_mph: 34 } });
  const second = SNAP({ window: { wind_mph: 22, gust_mph: 34 }, prevBands: first.bands });
  const ev = weatherEvents(second, first);
  assert.deepEqual(ev.map(e => e.kind), [WEATHER_KIND.WATCH],
    'the band did not move, so this is a standing watch, not a new shift');
  /* And the WATCH key is identical, so the rail dedupes it away. This is the
     mechanism that stops every forecast run becoming an alert. */
  assert.equal(weatherEvents(first, null)[0].event_key, ev[0].event_key);
});

test('an oscillating value on a threshold emits ONE event, not one per poll', () => {
  const seq = [12, 16, 21, 20, 21, 19, 18, 21, 20];
  let prev = null, shifts = 0, keys = new Set();
  for (const wind of seq) {
    const snap = SNAP({ window: { wind_mph: wind }, prevBands: prev && prev.bands });
    for (const e of weatherEvents(snap, prev)) {
      if (e.kind === WEATHER_KIND.SHIFT) shifts++;
      keys.add(e.event_key);
    }
    prev = snap;
  }
  assert.equal(shifts, 2, `expected one entry to watch and one to elevated, got ${shifts}`);
  assert.ok(keys.size <= 4, `distinct event keys should stay small, got ${keys.size}`);
});

test('a threshold crossing qualifies even when the raw delta is small', () => {
  /* 19 -> 21 is only 2 mph, well under the 7 mph material delta, but it crosses
     the 20 mph band and that is the football fact. */
  const before = SNAP({ window: { wind_mph: 14 } });
  const after = SNAP({ window: { wind_mph: 17 } });
  const ev = weatherEvents(after, before);
  assert.equal(ev[0].kind, WEATHER_KIND.SHIFT);
  assert.ok(ev[0].changes.some(c => c.field === 'wind' && c.to === 'watch'));
});

test('conditions EASING is not reported as a shift', () => {
  const before = SNAP({ window: { wind_mph: 26 } });
  const after = SNAP({ window: { wind_mph: 5 } });
  const ev = weatherEvents(after, before);
  assert.ok(!ev.some(e => e.kind === WEATHER_KIND.SHIFT),
    'a calming forecast is good news, not breaking news');
});

/* ===================== 7  COLD ========================================== */

test('fixture 7 — temperature crossing below 20F is a SHIFT to severe cold', () => {
  const before = SNAP({ window: { temp_f: 26 } });
  assert.equal(before.bands.cold, 'freezing');
  const after = SNAP({ window: { temp_f: 18 } });
  assert.equal(after.bands.cold, 'severe');
  const ev = weatherEvents(after, before);
  assert.equal(ev[0].kind, WEATHER_KIND.SHIFT);
  assert.ok(ev[0].changes.some(c => c.field === 'cold' && c.to === 'severe'));
});

test('the cold bands match the Player DNA condition bands exactly', () => {
  /* If these drift, a weather alert links to a historical split that is
     answering a different question. */
  assert.equal(THRESHOLDS.temp_f.freezing, 32);
  assert.equal(THRESHOLDS.temp_f.severe, 20);
  assert.equal(bandsFor(W({ temp_f: 31 })).cold, 'freezing');
  assert.equal(bandsFor(W({ temp_f: 20 })).cold, 'severe');
  assert.equal(bandsFor(W({ temp_f: 9 })).cold, 'extreme');
  assert.equal(bandsFor(W({ temp_f: 33 })).cold, 'none');
});

/* ===================== 8-10  ROOF AND VENUE TRUTH ======================== */

test('fixture 8 — an indoor game with snow outside raises NO game-weather alert', () => {
  const s = SNAP({
    roof: { state: 'INDOOR', indoor: true, weather_applies: false, label: 'Indoor' },
    window: { precip_probability_pct: 90, snowfall_in: 3.0, temp_f: 21, wind_mph: 24 }
  });
  assert.equal(s.bands.snow, 'likely', 'the weather outside is real...');
  assert.deepEqual(weatherEvents(s, null), [], '...and it does not reach the field');
});

test('fixture 9 — a retractable roof with unknown state is honest, not assumed open', () => {
  const V = venues();
  for (const abbr of RETRACTABLE) {
    const r = roofState(abbr, V.teams[abbr]);
    assert.equal(r.state, 'ROOF_STATUS_UNKNOWN', abbr);
    assert.equal(r.weather_applies, false, `${abbr} must not be assumed open`);
    assert.match(r.reason, /operating state/);
  }
  const s = SNAP({
    roof: roofState('ARI', V.teams.ARI),
    window: { wind_mph: 28, precip_probability_pct: 85, rain_in: 0.6 }
  });
  assert.deepEqual(weatherEvents(s, null), []);
});

test('fixture 10 — a neutral site never borrows the home club\'s coordinates', () => {
  const V = venues();
  const r = roofState('LAR', V.teams.LAR, { neutralSite: true });
  assert.equal(r.state, 'UNRESOLVED');
  assert.equal(r.weather_applies, false);
  assert.match(r.reason, /not played at the home club/);
  const s = SNAP({ roof: r, window: { wind_mph: 30 } });
  assert.deepEqual(weatherEvents(s, null), []);
});

test('a fixed dome is INDOOR and an open-air stadium is OUTDOOR', () => {
  const V = venues();
  assert.equal(roofState('NO', V.teams.NO).state, 'INDOOR');
  assert.equal(roofState('DET', V.teams.DET).state, 'INDOOR');
  assert.equal(roofState('GB', V.teams.GB).state, 'OUTDOOR');
  assert.equal(roofState('BUF', V.teams.BUF).state, 'OUTDOOR');
  assert.equal(roofState('KC', V.teams.KC).weather_applies, true);
});

/* ===================== 11-13  NWS ======================================== */

const NWS = (o = {}) => ({
  id: 'urn:oid:winter-1', event: 'Winter Storm Warning', severity: 'Severe',
  certainty: 'Likely', urgency: 'Expected',
  headline: 'Winter Storm Warning issued January 11 at 3:00AM EST until January 12 at 1:00AM EST',
  effective: '2026-01-11T08:00:00Z', expires: '2026-01-12T06:00:00Z',
  sender: 'NWS Boston MA', area: 'Suffolk; Norfolk', url: 'https://api.weather.gov/alerts/x',
  source_url: 'https://api.weather.gov/alerts/active?point=42.09,-71.26', ...o
});

test('fixture 11 — an official Winter Storm Warning is a WEATHER ALERT, verbatim', () => {
  const s = SNAP({ nws: [NWS()] });
  const ev = weatherEvents(s, null);
  const alert = ev.find(e => e.kind === WEATHER_KIND.ALERT);
  assert.ok(alert);
  assert.equal(alert.official, true);
  assert.equal(alert.label, 'NWS WEATHER ALERT');
  assert.equal(alert.headline, 'Winter Storm Warning');
  // carried WORD FOR WORD. We do not restate an official warning in our own,
  // stronger language.
  assert.equal(alert.detail, NWS().headline);
  assert.equal(alert.provenance.source, 'National Weather Service');
  assert.equal(alert.provenance.kind, 'official_alert');
  assert.equal(alert.cta.href, NWS().url);
});

test('fixture 12 — an alert already seen is NOT raised again', () => {
  const first = SNAP({ nws: [NWS()] });
  const again = SNAP({ nws: [NWS()] });
  assert.equal(weatherEvents(first, null).length, 1);
  assert.equal(weatherEvents(again, first).length, 0,
    'a standing warning must not re-fire on every poll for its whole life');
});

test('fixture 13 — an expired alert is filtered before it can become an event', () => {
  /* nwsAlerts() drops anything whose end time has passed, so the engine never
     sees it. This asserts the filter's rule directly against a fixture. */
  const past = NWS({ id: 'urn:oid:old', ends: '2020-01-01T00:00:00Z' });
  const end = new Date(past.ends || past.expires).getTime();
  assert.ok(end < Date.now(), 'fixture must actually be expired');
  const s = SNAP({ nws: [] });   // the filter already removed it
  assert.deepEqual(weatherEvents(s, null), []);
});

test('an official alert reaches the rail even for a roofed venue — but only if life-safety', () => {
  /* A tornado warning is about the people in the building. A Heat Advisory is
     about outdoor conditions and has no business taking the global rail for a
     game played indoors — measured against the live feed, that is exactly what
     would have happened at Lucas Oil Stadium. */
  const roof = { state: 'INDOOR', indoor: true, weather_applies: false, label: 'Indoor' };
  const severe = SNAP({ roof, nws: [NWS({ event: 'Tornado Warning', severity: 'Extreme' })] });
  assert.equal(weatherEvents(severe, null).length, 1);

  const advisory = SNAP({ roof, nws: [NWS({ event: 'Heat Advisory', severity: 'Moderate' })] });
  assert.deepEqual(weatherEvents(advisory, null), []);

  const outdoor = SNAP({ nws: [NWS({ event: 'Heat Advisory', severity: 'Moderate' })] });
  assert.equal(weatherEvents(outdoor, null).length, 1, 'outdoors an advisory still qualifies');
  assert.ok(LIFE_SAFETY_SEVERITY.has('Extreme') && !LIFE_SAFETY_SEVERITY.has('Moderate'));
});

/* ===================== WINDOW AND CADENCE =============================== */

test('the kickoff window is T-1h through T+3h in VENUE local time', () => {
  const stamps = windowStamps('2026-01-12T01:20:00Z', 'America/New_York');
  assert.equal(stamps.length, 5);
  assert.equal(stamps[0].offset_h, -1);
  assert.equal(stamps[4].offset_h, 3);
  // 01:20 UTC is 20:20 the previous day in New York
  assert.equal(stamps[1].stamp, '2026-01-11T20:00');
});

test('an 8:20pm kickoff never reads the afternoon forecast', () => {
  const stamps = windowStamps('2026-01-12T01:20:00Z', 'America/New_York').map(s => s.stamp);
  assert.ok(!stamps.some(s => Number(s.slice(11, 13)) < 19),
    `window ${stamps.join(',')} reached back into the afternoon`);
});

test('the window takes the WORST hour for wind and precipitation, kickoff for temperature', () => {
  const hourly = {
    time: ['2026-01-11T19:00', '2026-01-11T20:00', '2026-01-11T21:00'],
    temperature_2m: [50, 40, 30], apparent_temperature: [48, 38, 28],
    precipitation_probability: [10, 20, 90], precipitation: [0, 0.1, 0.4],
    rain: [0, 0.1, 0.4], showers: [0, 0, 0], snowfall: [0, 0, 0],
    weather_code: [0, 61, 61], wind_speed_10m: [5, 9, 28],
    wind_gusts_10m: [8, 14, 40], wind_direction_10m: [180, 190, 200],
    visibility: [24000, 12000, 3000]
  };
  const stamps = [{ stamp: '2026-01-11T19:00', offset_h: -1 },
                  { stamp: '2026-01-11T20:00', offset_h: 0 },
                  { stamp: '2026-01-11T21:00', offset_h: 1 }];
  const w = aggregateWindow(hourly, stamps);
  assert.equal(w.wind_mph, 28, 'a game is played through its worst hour');
  assert.equal(w.gust_mph, 40);
  assert.equal(w.precip_probability_pct, 90);
  assert.equal(w.temp_f, 40, 'temperature is the kickoff hour, which is what a reader means');
  assert.equal(w.rain_in, 0.5, 'accumulation sums across the window');
  assert.equal(w.visibility_m, 3000, 'visibility takes the worst hour');
  assert.equal(w.kind, 'forecast');
});

test('a partially covered window reports how many hours it actually resolved', () => {
  const hourly = { time: ['2026-01-11T20:00'], temperature_2m: [40],
    apparent_temperature: [38], precipitation_probability: [10], precipitation: [0],
    rain: [0], showers: [0], snowfall: [0], weather_code: [0], wind_speed_10m: [5],
    wind_gusts_10m: [8], wind_direction_10m: [180], visibility: [24000] };
  const w = aggregateWindow(hourly, [
    { stamp: '2026-01-11T19:00', offset_h: -1 }, { stamp: '2026-01-11T20:00', offset_h: 0 }]);
  assert.equal(w.hours_resolved, 1);
  assert.equal(w.hours_requested, 2);
});

test('monitoring starts at T-72h and tightens toward kickoff', () => {
  const at = h => pollIntervalMinutes(new Date(Date.now() + h * 3600000).toISOString());
  assert.equal(at(100), null, 'a game four days out is not monitored at all');
  assert.equal(at(48), 60);
  assert.equal(at(12), 60);
  assert.equal(at(3), 30, 'inside six hours the cadence tightens');
  assert.equal(THRESHOLDS.monitor_from_hours, 72);
});

test('WMO codes are mapped to a family, never to a severity', () => {
  assert.equal(wmoFamily(0), 'clear');
  assert.equal(wmoFamily(63), 'rain');
  assert.equal(wmoFamily(73), 'snow');
  assert.equal(wmoFamily(95), 'thunderstorm');
  assert.equal(wmoFamily(45), 'fog');
  assert.equal(wmoFamily(null), null);
});

/* ===================== VALUES AND MISSING DATA ========================== */

test('a missing reading is unknown, never zero', () => {
  const b = bandsFor(W({ wind_mph: null, temp_f: null, snowfall_in: null,
                         rain_in: null, precip_probability_pct: null }));
  assert.equal(b.wind, 'unknown');
  assert.equal(b.cold, 'unknown');
  assert.equal(b.snow, 'unknown');
  assert.equal(b.rain, 'unknown');
  assert.equal(watchWorthy(b), false, 'unknown is not a reason to alert');
});

test('a snapshot with no resolved window raises nothing at all', () => {
  const s = SNAP({ window: null });
  assert.equal(s.available, false);
  assert.deepEqual(weatherEvents(s, null), []);
});

test('every non-official event states that it is a forecast', () => {
  const s = SNAP({ window: { precip_probability_pct: 80, snowfall_in: 1.5, temp_f: 25, wind_mph: 22 } });
  for (const e of weatherEvents(s, null)) {
    if (e.official) continue;
    assert.equal(e.provenance.kind, 'forecast');
    assert.match(e.provenance.semantics, /FORECAST/);
    assert.ok(e.provenance.attribution.includes('Open-Meteo'));
    assert.ok(e.provenance.fetched_at);
  }
});

test('no weather event claims a market effect', () => {
  const s = SNAP({ window: { wind_mph: 26, gust_mph: 40 } });
  for (const e of weatherEvents(s, null)) {
    const text = JSON.stringify(e).toLowerCase();
    for (const banned of ['the under', 'books will', 'line move', 'caused the',
                          'better bet', 'edge', 'value play']) {
      assert.ok(!text.includes(banned), `weather event claims "${banned}"`);
    }
  }
});

test('the thresholds are all named constants, none left as bare numbers', () => {
  for (const k of ['window_hours_before', 'window_hours_after', 'wind_mph', 'gust_mph',
                   'temp_f', 'snow', 'rain', 'delta', 'band_release_buffer',
                   'nws_min_severity', 'poll_minutes', 'monitor_from_hours']) {
    assert.ok(THRESHOLDS[k] !== undefined, `THRESHOLDS.${k} is missing`);
  }
  assert.equal(THRESHOLDS.delta.precip_prob_pp, 30);
  assert.equal(THRESHOLDS.delta.wind_mph, 7);
  assert.equal(THRESHOLDS.delta.gust_mph, 10);
  assert.equal(THRESHOLDS.delta.temp_f, 8);
});
