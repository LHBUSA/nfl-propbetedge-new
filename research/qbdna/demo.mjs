/* Generates the QB DNA demo payloads from REAL current data.
 * node research/qbdna/demo.mjs [outDir]
 *
 * Nothing here is hardcoded except the two quarterbacks under review. The
 * games, the venue, the forecast and every line are resolved live:
 *   · schedule and venue  — ESPN public endpoints + our venue table
 *   · forecast            — Open-Meteo, outdoor venues only
 *   · lines               — the existing PropBetEdge market source
 *
 * It deliberately captures the FAIL-CLOSED states as well as the good ones:
 * a roofed game with no inferred weather, a market nobody is offering, a
 * very small sample, and a quarterback with no NFL history at all.
 */
import { call } from './call.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataset, gamesFor } from '../../api/_qbdna/engine.js';

const OUT = process.argv[2] || 'data/dist/qbdna-demo';
mkdirSync(OUT, { recursive: true });

const MAHOMES = '00-0033873', ALLEN = '00-0034857';
const save = (name, body) => {
  writeFileSync(join(OUT, name + '.json'), JSON.stringify(body, null, 2));
  return body;
};

const slate = (await call('game-context', '')).body;
const teamGame = abbr => slate.games.find(g => g.home_team === abbr || g.away_team === abbr);

const kcGame = teamGame('KC');            // expected outdoor
const bufGame = teamGame('BUF');          // expected roofed (at HOU)
if (!kcGame || !bufGame) throw new Error('could not resolve both demo games from the live slate');

const kcCtx = (await call('game-context', `event_id=${kcGame.espn_event_id}`)).body;
const bufCtx = (await call('game-context', `event_id=${bufGame.espn_event_id}`)).body;

/** Build the compare?mode=context query the UI builds, from live context. */
function ctxQuery(playerId, ctxRes, team) {
  const g = ctxRes.game, c = ctxRes.context;
  const isHome = g.home_team === team;
  const p = [`player_id=${playerId}`, `roof=${c.roof}`, `home=${isHome}`,
             `opponent=${isHome ? g.away_team : g.home_team}`, `primetime=${c.primetime}`];
  if (c.temp_f !== undefined) p.push(`temp_f=${c.temp_f}`);
  if (c.wind_mph !== undefined) p.push(`wind_mph=${c.wind_mph}`);
  if (c.precip !== undefined) p.push(`precip=${c.precip}`);
  return p.join('&');
}

const kcQ = ctxQuery(MAHOMES, kcCtx, 'KC');
const bufQ = ctxQuery(ALLEN, bufCtx, 'BUF');

/* the fail-closed cases, chosen from the data rather than assumed */
const D = dataset();
const noHistory = D.players.find(p => p.active_2026 && !gamesFor(p.gsis_id).length
  && p.team_2026);
const thinStarter = D.players
  .filter(p => p.market_priced_2026 && gamesFor(p.gsis_id).length)
  .sort((a, b) => gamesFor(a.gsis_id).length - gamesFor(b.gsis_id).length)[0];

/* a market the books are NOT offering for Mahomes in this game */
const mine = kcCtx.markets && kcCtx.markets.available
  ? kcCtx.markets.players.find(p => p.gsis_id === MAHOMES) : null;
const missingMarket = mine && mine.unavailable_markets.length
  ? mine.unavailable_markets[0].market : null;

const files = {
  '00-slate':  { season: slate.season, week: slate.week, data_window: slate.data_window,
                 games: slate.games },
  '01-mahomes-qb-dna':  (await call('qb-dna', `player_id=${MAHOMES}`)).body,
  '02-allen-qb-dna':    (await call('qb-dna', `player_id=${ALLEN}`)).body,

  // OUTDOOR game with a real forecast
  '03-context-outdoor-KC': kcCtx,
  '04-mahomes-today-vs-history': (await call('compare', kcQ)).body,

  // ROOFED game: no forecast fetched, no conditions inferred
  '05-context-roofed-HOU': bufCtx,
  '06-allen-today-vs-history': (await call('compare', bufQ)).body,

  // AT TODAY'S LINE, straight from the current market
  '07-mahomes-prop-at-market': (await call('prop-history',
    `player_id=${MAHOMES}&market=passing_yards&event_id=${kcCtx.market_event_id}`)).body,
  '08-allen-prop-at-market': (await call('prop-history',
    `player_id=${ALLEN}&market=passing_yards&event_id=${bufCtx.market_event_id}`)).body,

  // VERY SMALL SAMPLE, stated as such
  '09-mahomes-prop-snow-very-small-sample': (await call('prop-history',
    `player_id=${MAHOMES}&market=passing_yards&condition=snow&event_id=${kcCtx.market_event_id}`)).body,

  '10-mahomes-vs-allen': (await call('compare', `player_a=${MAHOMES}&player_b=${ALLEN}`)).body
};

// CURRENT MARKET UNAVAILABLE — a market the books are not offering
if (missingMarket) {
  files['11-market-unavailable'] = (await call('prop-history',
    `player_id=${MAHOMES}&market=${missingMarket}&event_id=${kcCtx.market_event_id}`)).body;
}
// NFL SAMPLE UNAVAILABLE — a 2026 quarterback with no NFL history
if (noHistory) {
  files['12-no-nfl-history'] = (await call('qb-dna', `player_id=${noHistory.gsis_id}`)).body;
  files['13-no-nfl-history-prop'] = (await call('prop-history',
    `player_id=${noHistory.gsis_id}&market=passing_yards&line=225`)).body;
}
// the thinnest market-priced starter — real but small
if (thinStarter) {
  files['14-thin-starter'] = (await call('qb-dna', `player_id=${thinStarter.gsis_id}`)).body;
}

for (const [name, body] of Object.entries(files)) save(name, body);

save('index', {
  generated_at: new Date().toISOString(),
  data_window: slate.data_window,
  demo_cases: {
    outdoor_with_weather: { game: kcCtx.game.label, venue: kcCtx.game.venue.venue,
      roof: kcCtx.context.roof, forecast: kcCtx.forecast },
    roofed_no_weather_inferred: { game: bufCtx.game.label, venue: bufCtx.game.venue.venue,
      roof: bufCtx.context.roof, forecast: bufCtx.forecast,
      unresolved: bufCtx.unresolved },
    market_unavailable: missingMarket,
    no_nfl_history: noHistory ? { name: noHistory.display_name, team: noHistory.team_2026 } : null,
    thinnest_market_priced_starter: thinStarter
      ? { name: thinStarter.display_name, team: thinStarter.team_2026,
          games: gamesFor(thinStarter.gsis_id).length } : null
  },
  queries: {
    mahomes_today: '/api/qb-dna/compare?' + kcQ,
    allen_today: '/api/qb-dna/compare?' + bufQ,
    mahomes_at_market: `/api/qb-dna/prop-history?player_id=${MAHOMES}`
      + `&market=passing_yards&event_id=${kcCtx.market_event_id}`,
    head_to_head: `/api/qb-dna/compare?player_a=${MAHOMES}&player_b=${ALLEN}`
  }
});

console.log('wrote', OUT, `(${Object.keys(files).length + 1} files)`);
console.log(' outdoor :', kcCtx.game.label, '·', kcCtx.game.venue.venue, '·',
  kcCtx.forecast ? `${kcCtx.forecast.temp_f}F / ${kcCtx.forecast.wind_mph}mph` : 'no forecast');
console.log(' roofed  :', bufCtx.game.label, '·', bufCtx.game.venue.venue, '· forecast',
  bufCtx.forecast);
console.log(' market unavailable :', missingMarket || 'none — every market offered');
console.log(' no NFL history     :', noHistory ? noHistory.display_name : 'none');
