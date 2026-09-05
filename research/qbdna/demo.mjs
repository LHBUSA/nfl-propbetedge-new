/* Generates the QB DNA demo payloads from REAL upcoming games.
 * node research/qbdna/demo.mjs [outDir]
 *
 * The two games are the actual 2026 Week 1 schedule read from ESPN's public
 * scoreboard, and the KC weather is the actual Open-Meteo forecast for the
 * venue's local kickoff hour. Nothing here is invented.
 */
import { call } from './call.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] || 'data/dist/qbdna-demo';
mkdirSync(OUT, { recursive: true });

const MAHOMES = '00-0033873', ALLEN = '00-0034857';

/* Real, from https://site.api.espn.com/.../nfl/scoreboard on 2026-09-05 */
export const GAMES = {
  den_at_kc: {
    espn_event_id: '401872931',
    label: 'DEN @ KC',
    kickoff_utc: '2026-09-15T00:15Z',
    kickoff_local: '2026-09-14 19:15 America/Chicago',
    venue: 'Arrowhead Stadium', roof: 'outdoors', indoor: false, divisional: true,
    qb: MAHOMES, qb_name: 'Patrick Mahomes', home: true, opponent: 'DEN',
    // Open-Meteo forecast, 2026-09-14T19:00 America/Chicago, fetched 2026-09-05
    forecast: { temp_f: 81, wind_mph: 13.6, precip_in: 0.004, rain_in: 0, snow_in: 0, wmo_code: 51 }
  },
  buf_at_hou: {
    espn_event_id: '401872660',
    label: 'BUF @ HOU',
    kickoff_utc: '2026-09-13T17:00Z',
    kickoff_local: '2026-09-13 12:00 America/Chicago',
    venue: 'Reliant Stadium', roof: 'closed', indoor: true, divisional: false,
    qb: ALLEN, qb_name: 'Josh Allen', home: false, opponent: 'HOU',
    forecast: null   // roofed venue - no weather is fetched, and none is inferred
  }
};

function ctxQuery(g) {
  const p = [`player_id=${g.qb}`, `roof=${g.roof}`, `home=${g.home}`,
             `opponent=${g.opponent}`, `divisional=${g.divisional}`];
  // primetime is decided by the venue's LOCAL kickoff hour, same as the split
  const hour = Number(g.kickoff_local.slice(11, 13));
  p.push(`primetime=${hour >= 19}`);
  if (g.forecast) {
    p.push(`temp_f=${g.forecast.temp_f}`, `wind_mph=${g.forecast.wind_mph}`);
    // the historical rain/snow flags are ACCUMULATION > 0; the forecast is mapped
    // on the same rule, so trace drizzle with 0 accumulation is not "rain"
    p.push(`precip=${g.forecast.snow_in > 0 ? 'snow' : g.forecast.rain_in > 0 ? 'rain' : 'none'}`);
  }
  return p.join('&');
}

const save = (name, body) => {
  writeFileSync(join(OUT, name + '.json'), JSON.stringify(body, null, 2));
  return body;
};

const kcCtx = ctxQuery(GAMES.den_at_kc);
const houCtx = ctxQuery(GAMES.buf_at_hou);

const out = {
  mahomes:        save('01-mahomes-qb-dna',   (await call('qb-dna', `player_id=${MAHOMES}`)).body),
  allen:          save('02-allen-qb-dna',     (await call('qb-dna', `player_id=${ALLEN}`)).body),
  mahomes_prop:   save('03-mahomes-prop-274_5',
    (await call('prop-history', `player_id=${MAHOMES}&market=passing_yards&line=274.5`)).body),
  mahomes_prop_c: save('04-mahomes-prop-274_5-below-freezing',
    (await call('prop-history', `player_id=${MAHOMES}&market=passing_yards&line=274.5&condition=below_freezing`)).body),
  allen_prop:     save('05-allen-prop-passing-tds-1_5',
    (await call('prop-history', `player_id=${ALLEN}&market=passing_touchdowns&line=1.5`)).body),
  mahomes_today:  save('06-mahomes-today-vs-history-DEN-at-KC',
    (await call('compare', kcCtx)).body),
  allen_today:    save('07-allen-today-vs-history-BUF-at-HOU',
    (await call('compare', houCtx)).body),
  head_to_head:   save('08-mahomes-vs-allen',
    (await call('compare', `player_a=${MAHOMES}&player_b=${ALLEN}`)).body)
};

save('00-games', GAMES);
save('index', {
  generated_at: new Date().toISOString(),
  games: GAMES,
  queries: {
    mahomes_today: '/api/qb-dna/compare?' + kcCtx,
    allen_today: '/api/qb-dna/compare?' + houCtx,
    head_to_head: `/api/qb-dna/compare?player_a=${MAHOMES}&player_b=${ALLEN}`
  }
});

console.log('wrote', OUT);
console.log('KC context query :', kcCtx);
console.log('HOU context query:', houCtx);
export default out;
