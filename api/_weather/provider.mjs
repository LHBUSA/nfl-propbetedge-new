/* PropBetEdge NFL — weather provider policy.
 *
 * Which weather provider may be used is a RIGHTS decision, not a code detail,
 * so it lives in one place that both runtimes read: the Vercel functions
 * (process.env) and the nfl-intel Worker (setWeatherPolicy from its env).
 *
 * Why this exists: the forecast behind Player DNA context, the BREAKING weather
 * rail, /api/game-weather and the historical DNA weather splits is Open-Meteo,
 * whose free tier its terms describe as non-commercial
 * (https://open-meteo.com/en/terms). PropBetEdge is a paid product. Until that
 * is resolved — a paid Open-Meteo plan, or a switch to NOAA/ERA5/Meteostat —
 * the provider must be disableable in one move, without breaking Player DNA,
 * the games board or PBEcast.
 *
 * Fail closed: an unknown or disabled provider yields no request and no value.
 * Every consumer already treats a missing forecast as unresolved, never as
 * "calm and mild", so disabling degrades honestly.
 *
 * NOTE: disabling stops NEW forecast reads. It does not retract the weather
 * already baked into data/dist/*-dna-dataset.json from the Open-Meteo archive;
 * that data keeps its CC-BY attribution and is a separate decision.
 */

export const PROVIDERS = Object.freeze({
  open_meteo: {
    id: 'open_meteo',
    label: 'Open-Meteo forecast API',
    forecast_base: 'https://api.open-meteo.com/v1/forecast',
    licence: 'CC-BY-4.0 (data)',
    terms_url: 'https://open-meteo.com/en/terms',
    commercial_use: 'paid_plan_required',
    attribution: 'Open-Meteo',
    enabled_by_default: true,
  },
  /* Prepared, not implemented: each needs its own URL builder and a normalizer
     into the same hourly shape. See history/docs/PLAN.md stage 2. */
  noaa_ghcnh: { id: 'noaa_ghcnh', label: 'NOAA NCEI hourly (US stations)', licence: 'public domain (17 U.S.C. §105)', terms_url: 'https://www.ncei.noaa.gov/', commercial_use: 'clear', implemented: false },
  era5: { id: 'era5', label: 'Copernicus ERA5 reanalysis', licence: 'CC-BY', terms_url: 'https://cds.climate.copernicus.eu/', commercial_use: 'clear', implemented: false },
  meteostat: { id: 'meteostat', label: 'Meteostat', licence: 'CC-BY-4.0', terms_url: 'https://dev.meteostat.net/license.html', commercial_use: 'clear', implemented: false },
});

export const HOURLY_FIELDS = Object.freeze(['temperature_2m', 'apparent_temperature', 'precipitation_probability',
  'precipitation', 'rain', 'showers', 'snowfall', 'weather_code',
  'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'visibility']);

const truthy = v => v === true || v === 1 || /^(1|true|yes|on)$/i.test(String(v ?? ''));

function resolve(source = {}) {
  const disabled = truthy(source.PBE_WEATHER_DISABLED);
  const requested = String(source.PBE_WEATHER_PROVIDER || '').trim() || 'open_meteo';
  const provider = PROVIDERS[requested];
  if (disabled) return { enabled: false, provider: null, requested, reason: 'weather provider disabled by configuration' };
  if (!provider) return { enabled: false, provider: null, requested, reason: `unknown weather provider "${requested}"` };
  if (provider.implemented === false) return { enabled: false, provider: null, requested, reason: `weather provider "${requested}" is not implemented yet` };
  return { enabled: true, provider, requested, reason: null };
}

let override = null;

/** Workers have no process.env: nfl-intel calls this once with its own env. */
export function setWeatherPolicy(source) {
  override = source ? resolve(source) : null;
  return weatherPolicy();
}

export function weatherPolicy() {
  if (override) return override;
  const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
  return resolve(env);
}

/**
 * Build the forecast request for the active provider.
 * @returns {{ok:true, url:string, provider:string, attribution:string}|{ok:false, reason:string}}
 */
export function forecastRequest({ lat, lon, tz, startDate, endDate, hourly = HOURLY_FIELDS }) {
  const policy = weatherPolicy();
  if (!policy.enabled) return { ok: false, reason: policy.reason };
  if (![lat, lon].every(v => Number.isFinite(Number(v)))) return { ok: false, reason: 'venue coordinates unavailable' };
  const url = `${policy.provider.forecast_base}?latitude=${lat}&longitude=${lon}`
    + `&hourly=${hourly.join(',')}`
    + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch'
    + `&timezone=${encodeURIComponent(tz)}`
    + `&start_date=${startDate}&end_date=${endDate}`;
  return { ok: true, url, provider: policy.provider.id, attribution: policy.provider.attribution };
}

/** What a surface should say about the provider it used (or did not use). */
export function providerRights() {
  const policy = weatherPolicy();
  return policy.enabled
    ? { provider: policy.provider.id, licence: policy.provider.licence, terms_url: policy.provider.terms_url, commercial_use: policy.provider.commercial_use }
    : { provider: null, reason: policy.reason };
}
