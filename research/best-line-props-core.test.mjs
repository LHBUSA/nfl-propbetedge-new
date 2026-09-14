/* Best Line player props: price shopping, identity and the model boundary.
 * best-line-props-core-v2.js is pure; these tests exercise the shipped file. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

await import('../best-line-props-core-v2.js');
const core = globalThis.PBEBestLinePropsCore;
const view = readFileSync(new URL('../best-line-v1.js', import.meta.url), 'utf8');

const EVENT = { id: 'evt-den-kc', commence_time: '2099-09-15T00:15:00Z', away_team: 'Denver Broncos', home_team: 'Kansas City Chiefs', started: false };
const q = (player, market, direction, point, price, book) => ({ player, market, direction, point, price, book, captured_at: '2099-09-14T17:00:16Z' });
const BOARD = {
  event: EVENT,
  market_availability: { player_pass_yds: 'IN_SNAPSHOT' },
  market_provenance: { player_pass_yds: { captured_at: '2099-09-14T17:00:16Z', captured_at_et: 'Sep 14, 1:00 PM ET', books: ['Bovada', 'DraftKings', 'FanDuel', 'Fanatics'] } },
  quotes: [
    q('Bo Nix', 'player_pass_yds', 'OVER', 230.5, -112, 'DraftKings'), q('Bo Nix', 'player_pass_yds', 'UNDER', 230.5, -112, 'DraftKings'),
    q('Bo Nix', 'player_pass_yds', 'OVER', 200.5, -250, 'Bovada'), q('Bo Nix', 'player_pass_yds', 'UNDER', 200.5, 185, 'Bovada'),
    q('Bo Nix', 'player_pass_yds', 'OVER', 260.5, 170, 'Bovada'), q('Bo Nix', 'player_pass_yds', 'UNDER', 260.5, -230, 'Bovada'),
    q('Bo Nix', 'player_pass_yds', 'OVER', 227.5, -113, 'FanDuel'),
    q('Patrick Mahomes', 'player_pass_yds', 'OVER', 224.5, -115, 'FanDuel'), q('Patrick Mahomes', 'player_pass_yds', 'UNDER', 224.5, -105, 'FanDuel'),
    q('Patrick Mahomes', 'player_pass_yds', 'OVER', 224.5, -110, 'DraftKings'), q('Patrick Mahomes', 'player_pass_yds', 'UNDER', 224.5, -110, 'DraftKings'),
    q('Travis Kelce', 'player_reception_yds', 'OVER', 41.5, -110, 'FanDuel'),
  ],
  market_summary: [
    { player: 'Bo Nix', market: 'player_pass_yds', consensus_line: 229.5, line_low: 200.5, line_high: 260.5 },
    { player: 'Patrick Mahomes', market: 'player_pass_yds', consensus_line: 224.5, line_low: 224.5, line_high: 224.5 },
  ],
};

test('best over is the lowest line then the best price; best under the highest line', () => {
  const rows = core.playerRows(BOARD, 'player_pass_yds');
  assert.deepEqual(rows.map(r => r.player).sort(), ['Bo Nix', 'Patrick Mahomes'], 'one row per quoted player, other markets excluded');
  const nix = rows.find(r => r.player === 'Bo Nix');
  assert.equal(nix.over.point, 200.5); assert.equal(nix.over.book, 'Bovada');
  assert.equal(nix.under.point, 260.5); assert.equal(nix.under.price, -230);
  assert.deepEqual(nix.books, ['Bovada', 'DraftKings', 'FanDuel']);
  const mahomes = rows.find(r => r.player === 'Patrick Mahomes');
  assert.equal(mahomes.over.book, 'DraftKings', 'same line: -110 pays more than -115');
  assert.equal(mahomes.under.book, 'FanDuel', 'same line: -105 pays more than -110');
});

test('the ladder keeps every quote and never invents a missing side', () => {
  const nix = core.playerRows(BOARD, 'player_pass_yds').find(r => r.player === 'Bo Nix');
  const rungs = core.ladder(nix);
  assert.equal(rungs.length, 4, 'one row per book and line');
  const fanduel = rungs.find(r => r.book === 'FanDuel');
  assert.ok(fanduel.over && fanduel.under === null, 'FanDuel quoted only the over');
  assert.equal(rungs.filter(r => r.bestOver).length, 1);
  assert.equal(rungs.filter(r => r.bestUnder).length, 1);
  assert.deepEqual(core.booksNotQuoting(BOARD, nix), ['Fanatics']);
});

test('anytime TD: best yes is the best price, the ladder marks it, no line is assumed', () => {
  const board = { event: EVENT, quotes: [q('Bo Nix', 'player_anytime_td', 'YES', null, 425, 'DraftKings'), q('Bo Nix', 'player_anytime_td', 'YES', null, 575, 'Fanatics'), q('Kansas City Chiefs D/ST', 'player_anytime_td', 'YES', null, 525, 'BetMGM'), q('No Scorer', 'player_anytime_td', 'YES', null, 4000, 'Fanatics')], market_summary: [] };
  const rows = core.playerRows(board, 'player_anytime_td');
  const nix = rows.find(r => r.player === 'Bo Nix');
  assert.equal(nix.yes.price, 575); assert.equal(nix.over, null); assert.equal(nix.consensus, null);
  assert.deepEqual([nix.priceLow, nix.priceHigh], [425, 575]);
  assert.equal(core.ladder(nix).filter(r => r.bestYes).length, 1, 'a quote with no point still matches itself');
  assert.deepEqual(rows.find(r => r.player === 'Kansas City Chiefs D/ST').outcome, { kind: 'team_defense', team: 'KC' });
  assert.equal(rows.find(r => r.player === 'No Scorer').outcome.kind, 'no_scorer');
});

const list = (players) => ({ players });
const person = (name, espn, team, extra = {}) => ({ name, espn_id: espn, gsis_id: `00-${espn}`, team_2026: team, active_2026: true, media: { headshot_url: `https://a.espncdn.com/i/headshots/nfl/players/full/${espn}.png`, resolved_by: 'espn_athlete_id' }, ...extra });

test('identity: exact name, a team in this game, exactly one candidate — otherwise no face', () => {
  const identity = core.identityIndex([
    { position: 'QB', route: 'qbdna', body: list([person('Bo Nix', '4426338', 'DEN'), person('Patrick Mahomes', '3139477', 'KC'), person('Retired Guy', '1', 'KC', { active_2026: false })]) },
    { position: 'WR', route: 'wrdna', body: list([person('Same Name', '11', 'DEN'), person('Same Name', '12', 'KC'), person('Elsewhere Player', '13', 'BUF'), person('J.K. Dobbins', '4241985', 'DEN')]) },
    { position: 'TE', route: 'tedna', body: null },
  ]);
  const ev = { away: 'Denver Broncos', home: 'Kansas City Chiefs' };
  const nix = core.resolveIdentity(identity, 'Bo Nix', ev);
  assert.equal(nix.status, 'verified'); assert.equal(nix.espn_id, '4426338'); assert.equal(nix.team, 'DEN'); assert.equal(nix.position, 'QB'); assert.equal(nix.route, 'qbdna');
  assert.equal(core.resolveIdentity(identity, '  patrick   MAHOMES ', ev).espn_id, '3139477', 'case and whitespace only');
  assert.equal(core.resolveIdentity(identity, 'JK Dobbins', ev).status, 'unresolved', 'punctuation is never folded');
  assert.equal(core.resolveIdentity(identity, 'Pat Mahomes', ev).status, 'unresolved', 'no similarity matching');
  assert.equal(core.resolveIdentity(identity, 'Same Name', ev).status, 'ambiguous');
  assert.equal(core.resolveIdentity(identity, 'Elsewhere Player', ev).status, 'not_on_event_roster', 'a roster team outside this game is not confirmation');
  assert.equal(core.resolveIdentity(identity, 'Retired Guy', ev).status, 'unresolved', 'only 2026 roster players');
  assert.deepEqual(identity.loaded, ['QB', 'WR']);
});

const MODEL = { event: { id: EVENT.id }, market: 'player_pass_yds', semantics: 'MODEL', model_version: 'PBE_PASS_BASELINE_V1_2', decision_status: 'CONTEXT_ADJUSTED_BASELINE', models: [
  { player: 'Bo Nix', available: true, semantics: 'MODEL', fair_line: 227.8, fair_line_gap_yards: -1.7, model_over_at_consensus_pct: 49.1, market_consensus_line: 229.5, predictive_sd: 74.1, model_version: 'PBE_PASS_BASELINE_V1_2' },
  { player: 'Rookie Passer', available: false, reason: 'insufficient_history' },
] };
const PRO = { pro: true, loading: false };

test('model: passing yards only, NFL Pro only, values straight from the model object', () => {
  assert.equal(core.modelState('player_rush_yds', { pro: PRO, load: { status: 200, body: MODEL } }, 'Bo Nix', EVENT.id).kind, 'not_modeled');
  assert.equal(core.modelState('player_pass_yds', { pro: { pro: false, loading: false }, load: { status: 200, body: MODEL } }, 'Bo Nix', EVENT.id).kind, 'locked', 'a free reader is locked even if data were present');
  assert.equal(core.modelState('player_pass_yds', { pro: { pro: false, loading: true } }, 'Bo Nix', EVENT.id).kind, 'checking');
  assert.equal(core.modelState('player_pass_yds', { pro: PRO }, 'Bo Nix', EVENT.id).kind, 'loading');
  const ready = core.modelState('player_pass_yds', { pro: PRO, load: { status: 200, body: MODEL } }, 'Bo Nix', EVENT.id);
  assert.equal(ready.kind, 'ready');
  assert.deepEqual([ready.fair_line, ready.gap, ready.over_pct, ready.consensus, ready.model_version], [227.8, -1.7, 49.1, 229.5, 'PBE_PASS_BASELINE_V1_2']);
  assert.equal(core.modelState('player_pass_yds', { pro: PRO, load: { status: 200, body: MODEL } }, 'Rookie Passer', EVENT.id).kind, 'inputs_unavailable');
  assert.equal(core.modelState('player_pass_yds', { pro: PRO, load: { status: 200, body: MODEL } }, 'Nobody', EVENT.id).kind, 'not_evaluated');
  assert.equal(core.modelState('player_pass_yds', { pro: PRO, load: { status: 503, body: null } }, 'Bo Nix', EVENT.id).kind, 'service_unavailable');
  assert.equal(core.modelState('player_pass_yds', { pro: PRO, load: { status: 403, body: null } }, 'Bo Nix', EVENT.id).kind, 'locked');
  assert.equal(core.modelState('player_pass_yds', { pro: PRO, load: { status: 200, body: { ...MODEL, event: { id: 'other' } } } }, 'Bo Nix', EVENT.id).kind, 'service_unavailable', 'another event is never shown');
  assert.equal(core.modelState('player_pass_yds', { pro: PRO, load: { status: 200, body: { ...MODEL, semantics: 'VALIDATION' } } }, 'Bo Nix', EVENT.id).kind, 'not_published');
});

test('market state: kickoff and retained captures are never called current', () => {
  const later = Date.parse('2099-09-15T00:16:00Z');
  const m = core.marketState({ ...BOARD, event: { ...EVENT, started: true }, market_availability: { player_pass_yds: 'LAST_VERIFIED_PREGAME_SNAPSHOT' } }, 'player_pass_yds', later);
  assert.equal(m.started, true); assert.equal(m.retained, true); assert.equal(m.live, false);
  assert.equal(m.captured_at_et, 'Sep 14, 1:00 PM ET', 'the market carries its own capture time');
  assert.equal(core.marketState({ event: EVENT, market_availability: { player_pass_yds: 'NOT_OFFERED_AT_INGEST' } }, 'player_pass_yds', 0).served, false);
});

test('search, sort and outcomes', () => {
  const rows = core.playerRows(BOARD, 'player_pass_yds');
  assert.deepEqual(core.filterRows(rows, 'maho').map(r => r.player), ['Patrick Mahomes']);
  assert.deepEqual(core.sortRows(rows, 'consensus').map(r => r.player), ['Bo Nix', 'Patrick Mahomes']);
  assert.deepEqual(core.sortRows(rows, 'books').map(r => r.player), ['Bo Nix', 'Patrick Mahomes']);
});

test('the view requests model output only for an NFL Pro reader, and never derives it', () => {
  const fetches = [...view.matchAll(/fetch\(`\$\{API\}\/api\/picks\/pass/g)];
  assert.equal(fetches.length, 1, 'one model read site');
  const loader = view.slice(view.indexOf('async function loadModel'), view.indexOf('function venueFor'));
  assert.match(loader, /proState\(\)\.pro !== true\) return;/, 'guarded by the entitlement before any request');
  assert.match(view, /if \(proState\(\)\.pro !== true\) state\.models\.clear\(\)/, 'model output is dropped when Pro ends');
  assert.doesNotMatch(view, /fair_line\s*[:=][^=]*consensus/i, 'no fair line is computed from consensus');
});
