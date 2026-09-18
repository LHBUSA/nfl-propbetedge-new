/* Game context: kickoff ET, where to watch, venue and weather for every game card.
 *
 * Fixtures are real captures: ESPN CDN scoreboard weeks 1-3 (2026-09-14,
 * trimmed to identity, kickoff, broadcast, venue and neutral-site fields) and
 * the nfl-intel weather snapshot (wx:v1:snapshot) of the same afternoon.
 * Nothing here reaches the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { SCHEDULE } from '../workers/nfl-schedule/schedule-2026.js';
import { observeCdnWeek, mergeObservations, emptySnapshot, buildBroadcast } from '../workers/nfl-schedule/broadcast-core.js';
import { buildVenue, buildKickoff } from '../workers/nfl-schedule/game-facts.js';
import worker, { resetSnapshotMemo } from '../workers/nfl-schedule/index.js';
import { gameWeatherView } from '../workers/nfl-intel/src/weather.js';
import { wmoDescription } from '../api/_breaking/weather.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/espn-cdn-venues-2026.json', import.meta.url), 'utf8'));
const WX = JSON.parse(readFileSync(new URL('./fixtures/nfl-intel-wx-snapshot-2026-09-14.json', import.meta.url), 'utf8'));
const VENUES = JSON.parse(readFileSync(new URL('../data/dist/nfl-venues.json', import.meta.url), 'utf8'));
const AT = '2026-09-14T19:30:00.000Z';
const NOW = Date.parse(AT);
const game = id => SCHEDULE.find(g => g.game_id === id);

function snapshot() {
  const snap = emptySnapshot();
  for (const w of [1, 2, 3]) {
    const obs = observeCdnWeek(FIX[`week${w}`], w);
    assert.equal(obs.ok, true, `week ${w} observes`);
    mergeObservations(snap, obs.observations, AT);
  }
  return snap;
}

/* the browser client, loaded as the page loads it (a separate realm: compare
   its objects by value, via JSON) */
function client() {
  const ctx = { console, URL, Intl, Date, CustomEvent: class { constructor(t) { this.type = t; } }, dispatchEvent() {} };
  ctx.window = ctx;
  ctx.document = { addEventListener() {} };
  ctx.addEventListener = () => {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../nfl-broadcast-v1.js', import.meta.url), 'utf8'), ctx);
  vm.runInContext(readFileSync(new URL('../nfl-game-context-v1.js', import.meta.url), 'utf8'), ctx);
  return ctx;
}

/* ---- venue + kickoff from the schedule authority ------------------------- */

test('DEN @ KC: Arrowhead Stadium, outdoor, ESPN / ABC, 8:15 PM ET kickoff from ESPN joined by event id', () => {
  const snap = snapshot();
  const g = game('2026_01_DEN_KC');
  const v = buildVenue(g, snap);
  assert.deepEqual([v.status, v.name, v.city, v.state, v.indoor, v.neutral_site, v.roof.state, v.source_event_id],
    ['VERIFIED', 'Arrowhead Stadium', 'Kansas City', 'MO', false, false, 'OUTDOOR', '401872931']);
  const k = buildKickoff(g, snap);
  assert.equal(k.utc, '2026-09-15T00:15:00.000Z');
  assert.equal(k.agrees_with_schedule, true);
  const b = buildBroadcast(g, snap, NOW);
  assert.deepEqual(b.networks, ['ESPN', 'ABC']);
});

test('roof states come from ESPN per-game venue flags plus the weather authority retractable list', () => {
  const snap = snapshot();
  assert.equal(buildVenue(game('2026_01_GB_MIN'), snap).roof.state, 'INDOOR', 'U.S. Bank Stadium is a fixed roof');
  assert.equal(buildVenue(game('2026_02_CAR_ATL'), snap).roof.state, 'ROOF_STATUS_UNKNOWN', 'Mercedes-Benz Stadium roof moves');
  const mel = buildVenue(game('2026_01_SF_LA'), snap);
  assert.deepEqual([mel.name, mel.neutral_site, mel.roof.state], ['Melbourne Cricket Ground', true, 'UNRESOLVED'], 'a neutral site never borrows the home stadium');
  const rio = buildVenue(game('2026_03_BAL_DAL'), snap);
  assert.deepEqual([rio.neutral_site, rio.roof.state], [true, 'UNRESOLVED'], 'Dallas home game in Rio is not AT&T Stadium');
  assert.equal(buildVenue(game('2026_02_NYG_LA'), snap).name, 'SoFi Stadium');
});

test('a game the source never published has no venue and falls back to the schedule kickoff', () => {
  const g = game('2026_18_BUF_NYJ') || SCHEDULE.find(x => x.week === 18);
  const v = buildVenue(g, snapshot());
  assert.equal(v.status, 'UNAVAILABLE');
  assert.equal(v.name, null);
  assert.equal(buildKickoff(g, snapshot()).source, 'nflverse_schedule');
});

test('API: every game carries broadcast, venue and kickoff', async () => {
  resetSnapshotMemo();
  const snap = snapshot();
  const res = await worker.fetch(new Request('https://nfl-schedule.internal/api/schedule?season=2026&week=2'), { NFL_KV: { get: async () => snap } });
  const body = await res.json();
  assert.equal(body.count, 16);
  for (const g of body.games) {
    assert.equal(g.venue.status, 'VERIFIED', g.game_id);
    assert.ok(g.venue.name && g.venue.roof?.state, g.game_id);
    assert.ok(Date.parse(g.kickoff.utc), g.game_id);
    assert.ok(['VERIFIED', 'UNASSIGNED'].includes(g.broadcast.status), g.game_id);
  }
});

test('shared venue table: both Los Angeles clubs play at SoFi Stadium', () => {
  assert.equal(VENUES.teams.LAC.venue, 'SoFi Stadium');
  assert.equal(VENUES.teams.LAR.venue, 'SoFi Stadium');
});

/* ---- weather view --------------------------------------------------------- */

test('game-weather view: compact kickoff-window forecast per ESPN event id, with a WMO condition', () => {
  const v = gameWeatherView(WX, Date.parse(WX.fetched_at) + 10 * 60000);
  assert.equal(v.ok, true);
  assert.equal(v.stale, false);
  const den = v.games.find(g => g.event_id === '401872931');
  assert.deepEqual([den.matchup, den.venue.name, den.roof.state, den.available], ['DEN @ KC', 'Arrowhead Stadium', 'OUTDOOR', true]);
  assert.equal(den.forecast.kind, 'forecast');
  assert.equal(den.forecast.temp_f, Math.round(WX.games.find(g => g.game_id === '401872931').window.temp_f));
  assert.equal(den.forecast.condition, wmoDescription(WX.games.find(g => g.game_id === '401872931').window.weather_code));
  assert.equal(gameWeatherView(WX, Date.parse(WX.fetched_at) + 3 * 3600000).stale, true, 'a snapshot older than two hours is stale');
  assert.equal(wmoDescription(2), 'Partly cloudy');
  assert.equal(wmoDescription(1234), null, 'an unknown code has no invented wording');
});

/* ---- the card strip -------------------------------------------------------- */

const view = () => ({ status: 'ok', body: gameWeatherView(WX, NOW) });
function cardGame(id) {
  const snap = snapshot();
  const g = game(id);
  return { espn_event_id: g.espn_event_id, away_team: g.away_team, home_team: g.home_team,
    kickoff_utc: buildKickoff(g, snap).utc, venue: buildVenue(g, snap), broadcast: buildBroadcast(g, snap, NOW), final: false, away_name: g.away_team, home_name: g.home_team };
}

test('card: DEN @ KC shows 8:15 PM ET, Mon Sep 14, ESPN and ABC links, Arrowhead Stadium and its forecast', () => {
  const C = client().PBEGameContext;
  const g = cardGame('2026_01_DEN_KC');
  const html = C.html(g, view(), { now: NOW });
  assert.match(html, /8:15 PM ET/);
  assert.match(html, /Mon, Sep 14/);
  assert.match(html, /href="https:\/\/www\.espn\.com\/watch\/" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /href="https:\/\/abc\.com\/watch-live" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /Arrowhead Stadium/);
  const m = C.weatherModel(g, view(), NOW);
  const row = WX.games.find(x => x.game_id === '401872931').window;
  assert.equal(m.kind, 'forecast');
  assert.equal(m.event_id, '401872931');
  assert.equal(m.title, `OUTDOOR · ${Math.round(row.temp_f)}°F · ${wmoDescription(row.weather_code)}`);
  assert.deepEqual(JSON.parse(JSON.stringify(m.lines)), [`Wind ${Math.round(row.wind_mph)} mph`, `Gusts ${Math.round(row.gust_mph)} mph`, `Rain ${Math.round(row.precip_probability_pct)}%`, 'Weather applies to the field']);
  assert.doesNotMatch(html, /LIVE WEATHER UNAVAILABLE/);
});

test('card: indoor, retractable, neutral site, beyond horizon and unavailable are explicit states', () => {
  const C = client().PBEGameContext;
  assert.deepEqual([C.weatherModel(cardGame('2026_01_GB_MIN'), view(), NOW).title, C.weatherModel(cardGame('2026_01_GB_MIN'), view(), NOW).detail], ['DOME / INDOOR', 'Local forecast unavailable']);
  const atl = C.weatherModel(cardGame('2026_02_CAR_ATL'), view(), NOW);
  assert.equal(atl.kind, 'forecast');
  assert.match(atl.title, /^RETRACTABLE ROOF · 87°F · Overcast$/);
  assert.ok(atl.lines.includes('Outdoor conditions · roof status not confirmed'));
  assert.equal(C.weatherModel(cardGame('2026_03_BAL_DAL'), view(), NOW).title, 'Weather unavailable', 'neutral site in Rio');
  const later = { ...cardGame('2026_02_NO_BAL'), espn_event_id: '999', kickoff_utc: '2026-10-11T17:00:00.000Z' };
  assert.equal(C.weatherModel(later, view(), NOW).title, 'Forecast pending');
  const missing = { ...cardGame('2026_02_NO_BAL') };
  assert.equal(C.weatherModel(missing, view(), NOW).title, 'Weather unavailable', 'inside the horizon but not in the snapshot');
  assert.equal(C.weatherModel(cardGame('2026_01_DEN_KC'), { status: 'error', body: null }, NOW).title, 'Weather unavailable');
  assert.equal(C.weatherModel(cardGame('2026_01_DEN_KC'), { status: 'ok', body: gameWeatherView(WX, NOW + 5 * 3600000) }, NOW).title, 'Weather unavailable', 'stale forecast');
  assert.equal(C.weatherModel({ ...cardGame('2026_01_DEN_KC'), final: true }, view(), NOW).kind, 'final');
});

test('card: weather joined to the wrong game is rejected, never shown', () => {
  const C = client().PBEGameContext;
  const den = cardGame('2026_01_DEN_KC');
  assert.equal(C.weatherModel({ ...den, home_team: 'LV' }, view(), NOW).rejected, true, 'teams disagree');
  assert.equal(C.weatherModel({ ...den, venue: { ...den.venue, name: 'GEHA Field' } }, view(), NOW).rejected, true, 'venue disagrees');
  assert.equal(C.weatherModel({ ...den, kickoff_utc: '2026-09-15T17:00:00.000Z' }, view(), NOW).rejected, true, 'kickoff disagrees');
  const nyg = cardGame('2026_02_NYG_LA');
  assert.equal(C.weatherModel(nyg, view(), NOW).rejected, true, 'a snapshot forecast at the old Coliseum row does not attach to SoFi Stadium');
});

test('card: kickoff is Eastern whatever the reader clock, and unknown broadcasts are text only', () => {
  const C = client().PBEGameContext;
  assert.deepEqual(JSON.parse(JSON.stringify(C.kickoffParts('2026-09-20T20:25:00.000Z'))), { time: '4:25 PM ET', day: 'Sun, Sep 20', longDay: 'Sunday, September 20' });
  const g = { ...cardGame('2026_01_DEN_KC'), broadcast: { status: 'VERIFIED', networks: ['ESPN+'], streaming: [], destinations: [{ provider: 'ESPN+', provider_id: 'espn_plus', url: 'https://plus.espn.com/', verified: true }] } };
  const html = C.html(g, view(), { now: NOW });
  assert.match(html, /ESPN\+/);
  assert.doesNotMatch(html, /plus\.espn\.com/, 'an unregistered destination never becomes a link');
  assert.match(C.html({ ...g, broadcast: { status: 'UNAVAILABLE' } }, view(), { now: NOW }), /Broadcast unavailable/);
});

test('games-intel-v5 carries no blanket weather state', () => {
  const src = readFileSync(new URL('../games-intel-v5.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /LIVE WEATHER UNAVAILABLE/);
  assert.doesNotMatch(src, /ROOF_BY_HOME/);
});
