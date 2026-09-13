/* PropChain v3 core: what a chain is, and every way it refuses to invent one.
 * Fixtures mirror the production shapes measured on 2026-09-13 (nfl-intel
 * /api/changes 1.2.0, /api/best-line, nfl-odds /api/odds/board, PBE Card v3
 * previews, the passing model). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = {};
vm.runInNewContext(readFileSync(new URL('../propchain-core-v3.js', import.meta.url), 'utf8'), ctx);
const C = ctx.PBEPropChainCore;
const plain = v => JSON.parse(JSON.stringify(v));

const NOW = Date.parse('2026-09-13T16:00:00Z');
const GAME = {
  id: '401872923', matchup: 'NO @ DET', kickoff: '2026-09-13T17:00:00.000Z', semantics: 'SCHEDULE', week: 1,
  away: { abbreviation: 'NO', name: 'New Orleans Saints' }, home: { abbreviation: 'DET', name: 'Detroit Lions' }
};
const FINAL = { id: '401872656', matchup: 'NE @ SEA', kickoff: '2026-09-10T00:20:00.000Z', semantics: 'FINAL', away: { abbreviation: 'NE', name: 'New England Patriots' }, home: { abbreviation: 'SEA', name: 'Seattle Seahawks' } };
const ODDS_ID = 'odds-no-det';

const q = (player, market, direction, point, price, book) => ({ player, market, direction, point, price, book });
function board({ captured_at = '2026-09-13T12:00:56.717Z', extra = [] } = {}) {
  return {
    captured_at, captured_at_et: 'Sep 13, 8:00 AM ET', age_seconds: 14400, ingest: { status: 'OK' },
    quotes: [
      /* DraftKings main 64.5; FanDuel main 63.5 plus an alt ladder that must not
         become the "best over"; Bovada only an alt ladder, no two-sided line */
      q('Chris Olave', 'player_reception_yds', 'OVER', 64.5, -114, 'DraftKings'),
      q('Chris Olave', 'player_reception_yds', 'UNDER', 64.5, -114, 'DraftKings'),
      q('Chris Olave', 'player_reception_yds', 'OVER', 63.5, -110, 'FanDuel'),
      q('Chris Olave', 'player_reception_yds', 'UNDER', 63.5, -118, 'FanDuel'),
      q('Chris Olave', 'player_reception_yds', 'OVER', 44.5, -300, 'FanDuel'),
      q('Chris Olave', 'player_reception_yds', 'UNDER', 44.5, 220, 'FanDuel'),
      q('Chris Olave', 'player_reception_yds', 'OVER', 39.5, -400, 'Bovada'),
      q('Chris Olave', 'player_reception_yds', 'OVER', 64.5, -105, 'BetMGM'),
      q('Chris Olave', 'player_reception_yds', 'UNDER', 64.5, -125, 'BetMGM'),
      q('Chris Olave', 'player_anytime_td', 'YES', null, 175, 'DraftKings'),
      q('Chris Olave', 'player_anytime_td', 'YES', null, 190, 'FanDuel'),
      q('Alvin Kamara', 'player_anytime_td', 'YES', null, 400, 'DraftKings'),
      q('New Orleans Saints D/ST', 'player_anytime_td', 'YES', null, 900, 'DraftKings'),
      q('Derek Carr', 'player_pass_yds', 'OVER', 231.5, -112, 'DraftKings'),
      q('Derek Carr', 'player_pass_yds', 'UNDER', 231.5, -112, 'DraftKings'),
      ...extra
    ]
  };
}
const boardsWith = b => new Map([[ODDS_ID, { status: 'ok', data: b, index: C.boardPlayers(b) }]]);
const BESTLINE = {
  captured_at: '2026-09-13T12:00:56.717Z', captured_at_et: 'Sep 13, 8:00 AM ET', age_seconds: 14400,
  events: [{ id: ODDS_ID, away: 'New Orleans Saints', home: 'Detroit Lions', kickoff: '2026-09-13T17:00:00.000Z',
    markets: {
      spread: { 'Detroit Lions': { consensus: { line: -6.5, price: -110 }, best: { book: 'FanDuel', line: -6, price: -115 }, book_count: 11, line_range: { low: -7, high: -6 } } },
      total: { OVER: { consensus: { line: 47.5, price: -110 }, best: { book: 'BetMGM', line: 47, price: -110 }, book_count: 11, line_range: { low: 47, high: 48 } } }
    } }]
};
function injury(name, status, { position = 'WR', espn = '1', prop = true, at = '2026-09-13T15:48:00.000Z', game = GAME, transition = null, severity = 'HIGH' } = {}) {
  return { id: `inj:${espn}:${status}`, kind: 'INJURY_STATUS', status, severity, actionable: game.semantics !== 'FINAL', observed_at: at, observed_basis: 'SOURCE_TIMESTAMP',
    source: { provider: 'espn_injury_report', label: 'ESPN injury report' }, headline: `${name} (${position}, NO) — ${status}`, detail: 'inactive',
    player: { espn_id: espn, name, position, prop_relevant: prop }, team: { abbreviation: 'NO' }, game: { id: game.id, matchup: game.matchup, kickoff: game.kickoff, semantics: game.semantics },
    ...(transition ? { transition } : {}) };
}
const MOVE = { id: 'mkt:2026_01_NO_DET:spread:DET:2026-09-13T12:00:56.717Z', kind: 'MARKET_MOVE', status: 'MOVED', severity: 'MEDIUM', observed_at: '2026-09-13T12:00:56.717Z',
  source: { provider: 'pbe_market_history', label: 'PropBetEdge market history · cross-book consensus per ingest' }, headline: 'NO @ DET — DET spread -5.5 → -6.5', detail: null,
  market: { market: 'spread', selection: 'DET', from: { line: -5.5, price: -110, captured_at: '2026-09-11T12:01:20.692Z', books: 11 }, to: { line: -6.5, price: -110, captured_at: '2026-09-13T12:00:56.717Z', books: 10 }, delta: -1, unit: 'pts', key_number: null, basis: 'FIRST_OBSERVATION', observations: 7 },
  team: { abbreviation: 'DET' }, game: { id: GAME.id, matchup: GAME.matchup, kickoff: GAME.kickoff, semantics: 'SCHEDULE' } };
function changes(list, extra = {}) {
  return { games: [GAME, FINAL], changes: list, sources: { market: { available: true, batches: 7, latest_captured_at: '2026-09-13T12:00:56.717Z', first_captured_at: '2026-09-11T12:01:20.692Z' } }, weather: { available: false }, ...extra };
}
const noCards = () => ({ cards: [], previews: [] });
const build = (over = {}) => C.build({ changes: changes([]), bestline: BESTLINE, boards: boardsWith(board()), news: null, cards: noCards, pro: false, now: NOW, ...over });
const UI = { game: 'all', signal: 'all', severity: 'all', window: 48, q: '' };

test('main line per book: alternate ladders never become the best number', () => {
  const m = C.propMarket(board().quotes.filter(x => x.player === 'Chris Olave'), 'player_reception_yds');
  assert.equal(m.kind, 'OU');
  assert.equal(m.main_books, 3, 'Bovada quotes only one side, so it has no main line');
  assert.equal(m.consensus_line, 64.5, 'median of 64.5 / 63.5 / 64.5');
  assert.deepEqual(plain(m.best_over), { point: 63.5, price: -110, book: 'FanDuel' }, 'lowest MAIN over, not the 44.5 or 39.5 ladder');
  assert.deepEqual(plain(m.best_under), { point: 64.5, price: -114, book: 'DraftKings' }, 'highest main under, best price at it');
  assert.deepEqual(plain(m.at_consensus), { books: 2, over: { price: -105, book: 'BetMGM' }, under: { price: -114, book: 'DraftKings' } });
  const td = C.propMarket(board().quotes.filter(x => x.player === 'Chris Olave'), 'player_anytime_td');
  assert.deepEqual(plain(td), { market: 'player_anytime_td', label: 'Anytime TD', kind: 'YES', books: 2, consensus_price: 183, best_yes: { price: 190, book: 'FanDuel' } });
});

test('identity: exact normalized name inside one board, never fuzzy, never a defense', () => {
  const b = board({ extra: [q('Marvin Harrison Jr.', 'player_receptions', 'OVER', 5.5, -110, 'DK'), q('Mike Williams', 'player_receptions', 'OVER', 2.5, -110, 'DK'), q('Mike  Williams', 'player_receptions', 'UNDER', 2.5, -110, 'FD')] });
  const idx = C.boardPlayers(b);
  assert.equal(C.resolvePlayer(b, 'Marvin Harrison', idx), 'Marvin Harrison Jr.');
  assert.equal(C.resolvePlayer(b, 'Chris Olav', idx), null, 'no fuzzy match');
  assert.equal(C.resolvePlayer(b, 'Mike Williams', idx), null, 'two board spellings for one name is ambiguous');
  assert.equal(C.resolvePlayer(b, 'New Orleans Saints D/ST', idx), null);
  assert.equal(C.normName("Ja'Marr Chase"), C.normName('JaMarr Chase'));
});

test('odds event join needs both team names and a kickoff inside 12 hours', () => {
  assert.equal(C.matchOddsEvent(GAME, BESTLINE.events)?.id, ODDS_ID);
  assert.equal(C.matchOddsEvent({ ...GAME, kickoff: '2026-09-20T17:00:00.000Z' }, BESTLINE.events), null, 'same teams next week is a different game');
  assert.equal(C.matchOddsEvent({ ...GAME, home: { name: 'Dallas Cowboys' } }, BESTLINE.events), null);
});

test('tape: moves are placed in time relative to the change, never attributed to it', () => {
  const d = changes([MOVE]);
  const before = C.tapeFor(d, GAME.id, '2026-09-13T15:48:00Z');
  assert.equal(before.moves[0].relation, 'BEFORE');
  assert.equal(before.no_capture_after_source, true, 'latest capture 12:00Z predates a 15:48Z change');
  assert.equal(C.tapeFor(d, GAME.id, '2026-09-12T09:00:00Z').moves[0].relation, 'SPANS');
  assert.equal(C.tapeFor(d, GAME.id, '2026-09-10T09:00:00Z').moves[0].relation, 'AFTER');
  assert.equal(C.tapeFor(changes([MOVE], { sources: { market: { available: false, reason: 'one_capture_so_far_a_move_needs_two' } } }), GAME.id, NOW).reason, 'one_capture_so_far_a_move_needs_two');
  assert.equal(C.moveKind(MOVE.market), 'NUMBER');
  assert.equal(C.moveKind({ ...MOVE.market, key_number: 3 }), 'KEY_NUMBER');
  assert.equal(C.moveKind({ unit: 'pp', delta: 5 }), 'PRICE');
  assert.equal(C.bookChange(MOVE.market), -1, 'book count is liquidity, reported separately');
});

test('injury chain: complete only when the player is priced, with the pre-change market labelled as such', () => {
  const tr = { from: 'QUESTIONABLE', to: 'OUT', from_observed_at: '2026-09-13T15:41:04.723Z', observed_at: '2026-09-13T15:51:04.337Z', basis: 'PBE_LEDGER_OBSERVATIONS' };
  const out = build({ changes: changes([
    injury('Chris Olave', 'OUT', { espn: '1', transition: tr }),
    injury('Alvin Kamara', 'QUESTIONABLE', { position: 'RB', espn: '2', severity: 'MEDIUM' }),
    injury('Taysom Hill', 'OUT', { position: 'TE', espn: '3' }),
    injury('Erik McCoy', 'OUT', { position: 'C', espn: '4', prop: false }),
    MOVE
  ]) });
  const olave = out.chains.find(c => c.entity.name === 'Chris Olave');
  assert.equal(olave.complete, true);
  assert.equal(olave.event_label, 'QUESTIONABLE → OUT', 'transition only because the ledger observed both');
  assert.equal(olave.market.kind, 'PLAYER_PROPS');
  assert.equal(olave.market.primary.market, 'player_reception_yds', 'a WR is priced by receiving first');
  assert.equal(olave.market.snapshot.before_source, true, '8:00 AM capture predates the 11:48 AM designation');
  assert.equal(olave.tape.no_capture_after_source, true);
  assert.equal(olave.tape.moves[0].relation, 'BEFORE', 'the spread move happened before the change');
  const kamara = out.chains.find(c => c.entity.name === 'Alvin Kamara');
  assert.equal(kamara.event_label, 'Status updated: QUESTIONABLE', 'no transition claimed without two observations');
  const hill = out.context.find(c => c.entity.name === 'Taysom Hill');
  assert.equal(hill.stop, 'NOT_ON_BOARD', 'an unpriced player is context, not a chain');
  assert.equal(out.context.find(c => c.entity.name === 'Erik McCoy').stop, 'POSITION_NOT_PRICED');
  assert.ok(!out.chains.some(c => /caus|because|due to/i.test(JSON.stringify(c))), 'no causal language anywhere in a chain');
});

test('a board still loading is pending, never counted and never empty', () => {
  const out = build({ changes: changes([injury('Chris Olave', 'OUT')]), boards: new Map([[ODDS_ID, { status: 'pending' }]]) });
  assert.equal(out.chains[0].complete, null);
  assert.equal(out.chains[0].market.kind, 'PENDING');
  const n = C.counts(out, null, UI, NOW);
  assert.equal(n.pending, true);
  assert.equal(n.active, 0);
  const failed = build({ changes: changes([injury('Chris Olave', 'OUT')]), boards: new Map([[ODDS_ID, { status: 'error', error: 'Event not in the player-market snapshot window' }]]) });
  assert.equal(failed.context[0].stop, 'MARKET_UNAVAILABLE');
});

test('game model: published card only for Pro, a locked preview names nothing, otherwise not published', () => {
  const card = { market: 'spread', model: { fair_line: -7.2, prob: 0.56 }, market_prob: 0.52, label: 'PBE VALIDATION SIGNAL' };
  const pro = build({ changes: changes([MOVE]), cards: () => ({ cards: [card], previews: [] }), pro: true });
  assert.equal(pro.chains[0].model.state, 'PUBLISHED');
  const pub = build({ changes: changes([MOVE]), cards: () => ({ cards: [], previews: [{ market: 'spread', locked: true }] }) });
  assert.equal(pub.chains[0].model.state, 'LOCKED');
  assert.equal(pub.chains[0].model.card, undefined, 'a locked preview carries no selection or value');
  const none = build({ changes: changes([MOVE]), cards: () => ({ cards: [card], previews: [] }) });
  assert.equal(none.chains[0].model.state, 'PUBLISHED', 'the card store itself only holds cards for an entitled reader');
  const other = build({ changes: changes([MOVE]), cards: () => ({ cards: [{ ...card, market: 'total' }], previews: [] }) });
  assert.equal(other.chains[0].model.state, 'NOT_PUBLISHED', 'a signal on another market is not this market');
  const mk = pro.chains[0];
  assert.equal(mk.market.kind, 'GAME_LINE');
  assert.equal(mk.market.line.best.book, 'FanDuel');
  assert.equal(mk.move.book_change, -1);
});

test('player model: passing model only, Pro only, never inferred from consensus', () => {
  const carr = injury('Derek Carr', 'QUESTIONABLE', { position: 'QB', espn: '9', severity: 'HIGH' });
  const locked = build({ changes: changes([carr]) });
  assert.equal(locked.chains[0].model.state, 'LOCKED');
  const pending = build({ changes: changes([carr]), pro: true, passModels: new Map() });
  assert.equal(pending.chains[0].model.state, 'PENDING');
  const models = { model_version: 'PBE_PASS_BASELINE_V1_2', models: [{ player: 'Derek Carr', available: true, fair_line: 238, market_consensus_line: 231.5, fair_line_gap_yards: 6.5, missing_inputs: ['injury_adjustment'] }] };
  const pub = build({ changes: changes([carr]), pro: true, passModels: new Map([[ODDS_ID, { status: 'ok', data: models }]]) });
  assert.equal(pub.chains[0].model.state, 'PUBLISHED');
  assert.equal(pub.chains[0].model.row.fair_line, 238);
  const missing = build({ changes: changes([carr]), pro: true, passModels: new Map([[ODDS_ID, { status: 'ok', data: { models: [] } }]]) });
  assert.equal(missing.chains[0].model.state, 'NOT_PUBLISHED');
  const wr = build({ changes: changes([injury('Chris Olave', 'OUT')]), pro: true });
  assert.equal(wr.chains[0].model.state, 'NOT_PUBLISHED', 'no published model for receiving markets');
});

test('weather: expired alerts and repeats are dropped, a fixed roof is context', () => {
  const ev = (headline, extra = {}) => ({ kind: 'WEATHER_ALERT', official: true, event_key: `nws:${headline}:${extra.effective || ''}`, headline, severity: 'Severe', effective: '2026-09-13T09:37:00-04:00',
    game: { event_id: GAME.id, matchup: GAME.matchup, kickoff_utc: GAME.kickoff, venue: 'Ford Field', roof: { weather_applies: true } }, provenance: { source: 'National Weather Service' }, ...extra });
  const wx = { available: true, fetched_at: '2026-09-13T15:42:39Z', events: [
    ev('Flash Flood Warning', { expires: '2026-09-13T12:00:00-04:00' }),
    ev('Flood Watch', { expires: '2026-09-13T18:00:00-04:00' }),
    ev('Flood Watch', { expires: '2026-09-13T18:00:00-04:00', effective: '2026-09-13T08:00:00-04:00' }),
    ev('High Wind Warning', { expires: '2026-09-13T20:00:00-04:00', game: { event_id: GAME.id, matchup: GAME.matchup, venue: 'Ford Field', roof: { weather_applies: false } } })
  ] };
  const out = build({ changes: changes([], { weather: wx }) });
  const wxChains = out.chains.filter(c => c.kind === 'WEATHER');
  assert.deepEqual(plain(wxChains.map(c => c.title)), ['NO @ DET · Flood Watch'], 'noon warning expired at 16:00Z; one Flood Watch');
  assert.equal(wxChains[0].market.line.market, 'total');
  assert.equal(out.context.find(c => c.kind === 'WEATHER').stop, 'INDOOR');
});

test('news: a tagged player counts only when the article text names him and he is priced', () => {
  const art = (title, players, extra = {}) => ({ id: title, title, summary: 'Saints notes.', published_at: '2026-09-13T15:16:07Z', teams: ['NO'], players, source: 'espn', url: 'https://propbetedge.ai/news/nfl/x', ...extra });
  const out = build({ news: [
    art('Olave limited again as Saints finalize receiver plan', ['Chris Olave', 'Alvin Kamara']),
    art('Joseph Ossai notes', ['Chris Olave']),
    art('Olave injury update', ['Chris Olave'], { teams: ['KC'] })
  ] });
  const news = out.chains.filter(c => c.kind === 'NEWS');
  assert.equal(news.length, 1);
  assert.equal(news[0].entity.name, 'Chris Olave');
  assert.equal(news[0].severity, 'LOW', 'news is context unless the desk flags it breaking');
});

test('scope, filters and counts are computed from loaded chains only', () => {
  const finalInjury = injury('Kenneth Walker III', 'OUT', { position: 'RB', espn: '7', game: FINAL });
  const out = build({ changes: changes([injury('Chris Olave', 'OUT', { at: '2026-09-13T15:48:00Z' }), injury('Derek Carr', 'QUESTIONABLE', { position: 'QB', espn: '9', severity: 'HIGH', at: '2026-09-12T06:00:00Z' }), finalInjury, MOVE]) });
  const visible = ui => plain(out.chains.filter(c => C.matches(c, { ...UI, ...ui }, NOW)).map(c => c.title).sort());
  assert.deepEqual(visible({}), ['Chris Olave', 'DET spread', 'Derek Carr']);
  assert.deepEqual(visible({ window: 24 }), ['Chris Olave', 'DET spread']);
  assert.deepEqual(visible({ signal: 'market' }), ['DET spread']);
  assert.deepEqual(visible({ severity: 'medium' }), ['DET spread']);
  assert.deepEqual(visible({ q: 'receiving' }), ['Chris Olave']);
  assert.deepEqual(visible({ game: FINAL.id }), [], 'Walker is not priced on any board, so not a chain even when his game is selected');
  assert.equal(C.openWeek([GAME, FINAL, { ...GAME, id: 'w2', week: 2 }]), 1, 'the earliest week with a game still to finish');
  assert.deepEqual(visible({ week: 2 }), [], 'All open games is the open week; week 2 is a selection away');
  assert.deepEqual(visible({ week: 2, game: GAME.id }).length, 3, 'a selected game is never hidden by the week scope');
  const n = C.counts(out, null, UI, NOW);
  assert.deepEqual({ active: n.active, moves: n.moves, players: n.players, games: n.games }, { active: 3, moves: 1, players: 2, games: 1 });
  assert.deepEqual(plain(C.rank(out.chains.filter(c => C.matches(c, UI, NOW)), 'latest').map(c => c.title)), ['Chris Olave', 'DET spread', 'Derek Carr']);
});
