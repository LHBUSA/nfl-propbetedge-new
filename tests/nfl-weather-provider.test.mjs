/* The weather provider is a rights decision, enforced in one place.
 *
 * Open-Meteo's free tier is described by its terms as non-commercial, and
 * PropBetEdge is a paid product. These tests prove the provider can be turned
 * off in one move: no request is made, no value is invented, and the surfaces
 * that do not depend on weather keep working.
 *
 *   node --test tests/nfl-weather-provider.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const provider = await import('../api/_weather/provider.mjs');
const weather = await import('../api/_breaking/weather.js');

const VENUES = { generated_at: '2026-09-18T00:00:00Z', source: 'test fixture', teams: { BUF: { team: 'BUF', name: 'Highmark Stadium', lat: 42.774, lon: -78.787, tz: 'America/New_York', indoor: false }, NE: { team: 'NE', name: 'Gillette Stadium', lat: 42.091, lon: -71.264, tz: 'America/New_York', indoor: false } } };
weather.setVenues(VENUES);

const GAME = {
  id: '401772936', espn_event_id: '401772936',
  kickoff_utc: new Date(Date.now() + 36 * 3600000).toISOString(),
  home_team: 'BUF', away_team: 'NE', neutral_site: false,
};

function fetchSpy(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return handler(String(url), init); };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const hourlyBody = () => {
  const now = new Date(GAME.kickoff_utc);
  const times = [];
  for (let h = -3; h <= 4; h++) {
    const t = new Date(now.getTime() + h * 3600000);
    times.push(`${t.toISOString().slice(0, 13)}:00`);
  }
  const fill = v => times.map(() => v);
  return {
    hourly: {
      time: times, temperature_2m: fill(41), apparent_temperature: fill(38), precipitation_probability: fill(10),
      precipitation: fill(0), rain: fill(0), showers: fill(0), snowfall: fill(0), weather_code: fill(1),
      wind_speed_10m: fill(9), wind_gusts_10m: fill(14), wind_direction_10m: fill(270), visibility: fill(16000),
    },
  };
};

test('default policy is the Open-Meteo forecast API, and its rights are stated', () => {
  provider.setWeatherPolicy({});
  const policy = provider.weatherPolicy();
  assert.equal(policy.enabled, true);
  assert.equal(policy.provider.id, 'open_meteo');
  const rights = provider.providerRights();
  assert.equal(rights.commercial_use, 'paid_plan_required');
  assert.match(rights.terms_url, /open-meteo\.com/);
});

test('an enabled provider builds the same request shape as before', () => {
  provider.setWeatherPolicy({});
  const req = provider.forecastRequest({ lat: 42.774, lon: -78.787, tz: 'America/New_York', startDate: '2026-09-20', endDate: '2026-09-20' });
  assert.equal(req.ok, true);
  assert.match(req.url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=42\.774&longitude=-78\.787/);
  assert.match(req.url, /temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch/);
  assert.match(req.url, /start_date=2026-09-20&end_date=2026-09-20/);
});

test('disabled: no forecast request is made and nothing is invented', async () => {
  provider.setWeatherPolicy({ PBE_WEATHER_DISABLED: '1' });
  const spy = fetchSpy(async () => new Response('{}', { status: 200 }));
  try {
    const snap = await weather.gameSnapshot(GAME, { fetchNws: false });
    assert.equal(snap.available, false, 'no weather is available');
    assert.equal(snap.window, null, 'no window is fabricated');
    assert.equal(snap.bands, null, 'no bands are fabricated');
    assert.equal(snap.source_url, null);
    assert.match(snap.unresolved.find(u => u.field === 'weather').reason, /disabled by configuration/);
    assert.equal(spy.calls.filter(u => u.includes('open-meteo')).length, 0, 'the provider must not be called');
  } finally { spy.restore(); provider.setWeatherPolicy({}); }
});

test('disabled: official NWS alerts still work, because they are a separate provider', async () => {
  provider.setWeatherPolicy({ PBE_WEATHER_DISABLED: '1' });
  const spy = fetchSpy(async url => {
    if (url.includes('weather.gov')) return new Response(JSON.stringify({ features: [] }), { status: 200 });
    throw new Error(`unexpected call: ${url}`);
  });
  try {
    const snap = await weather.gameSnapshot(GAME, { fetchNws: true });
    assert.equal(spy.calls.some(u => u.includes('weather.gov')), true, 'NWS is still consulted');
    assert.equal(snap.available, false);
    assert.deepEqual(snap.nws, []);
  } finally { spy.restore(); provider.setWeatherPolicy({}); }
});

test('enabled: the snapshot resolves a window from the provider response', async () => {
  provider.setWeatherPolicy({});
  const spy = fetchSpy(async url => {
    if (url.includes('open-meteo')) return new Response(JSON.stringify(hourlyBody()), { status: 200 });
    throw new Error(`unexpected call: ${url}`);
  });
  try {
    const snap = await weather.gameSnapshot(GAME, { fetchNws: false });
    assert.equal(spy.calls.filter(u => u.includes('open-meteo')).length, 1);
    assert.equal(snap.available, true);
    assert.equal(typeof snap.window.temp_f, 'number');
  } finally { spy.restore(); }
});

test('an unknown or unimplemented provider fails closed rather than falling back', () => {
  provider.setWeatherPolicy({ PBE_WEATHER_PROVIDER: 'some_provider_we_never_wrote' });
  const unknown = provider.forecastRequest({ lat: 1, lon: 2, tz: 'UTC', startDate: '2026-01-01', endDate: '2026-01-01' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /unknown weather provider/);

  provider.setWeatherPolicy({ PBE_WEATHER_PROVIDER: 'noaa_ghcnh' });
  const notYet = provider.forecastRequest({ lat: 1, lon: 2, tz: 'UTC', startDate: '2026-01-01', endDate: '2026-01-01' });
  assert.equal(notYet.ok, false);
  assert.match(notYet.reason, /not implemented yet/);
  provider.setWeatherPolicy({});
});

test('replacement providers are registered with their licence, so a switch is a config change', () => {
  for (const id of ['noaa_ghcnh', 'era5', 'meteostat']) {
    const p = provider.PROVIDERS[id];
    assert.ok(p, id);
    assert.equal(p.commercial_use, 'clear', `${id} is a rights-clean replacement candidate`);
    assert.equal(p.implemented, false, `${id} still needs a URL builder and normalizer`);
  }
});

test('the Worker lane sets the policy from its own env, since it has no process.env', () => {
  const src = weatherSource();
  assert.match(src, /setWeatherPolicy\(env\)/);
  assert.ok(src.indexOf('setWeatherPolicy(env)') < src.indexOf('gameSnapshot('), 'policy is set before any snapshot');
});
function weatherSource() {
  return require('node:fs').readFileSync(new URL('../workers/nfl-intel/src/weather.js', import.meta.url), 'utf8');
}
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
