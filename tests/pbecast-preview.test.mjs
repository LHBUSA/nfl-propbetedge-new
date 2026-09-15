/* PBEcast pregame preview: lifecycle, identity and truthful empty states.
 *
 * The preview is built only for the selected, scheduled game and only from the
 * existing authorities' payloads (Best Line snapshot, What Changed availability
 * and changes, PBE Card store). These tests hold two Week 2 games side by side
 * and assert nothing from one ever appears in the other's preview.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* the browser module, evaluated as the page does (UMD; module.exports in this sandbox) */
const sandbox = { module: { exports: {} } };
vm.runInNewContext(readFileSync(new URL('../pbecast-preview-v1.js', import.meta.url), 'utf8'), sandbox);
const P = sandbox.module.exports;
const plain = v => JSON.parse(JSON.stringify(v));   // values cross the vm realm
const NOW = Date.parse('2026-09-15T18:00:00Z');

const team = (abbreviation, display_name) => ({ abbreviation, display_name });
const DETBUF = { id: '401872932', date: '2026-09-18T00:15Z', status: { semantics: 'SCHEDULE' }, teams: { away: team('DET', 'Detroit Lions'), home: team('BUF', 'Buffalo Bills') } };
const PITNE = { id: '401872946', date: '2026-09-20T17:00Z', status: { semantics: 'SCHEDULE' }, teams: { away: team('PIT', 'Pittsburgh Steelers'), home: team('NE', 'New England Patriots') } };
const side = (s, line, price, best) => ({ side: s, consensus: { line, price }, best });
const EV_DETBUF = {
  id: 'odds-detbuf', away: 'Detroit Lions', home: 'Buffalo Bills', books: 11, started: false,
  markets: {
    spread: { 'Detroit Lions': side('Detroit Lions', 4.5, -108, { book: 'Bovada', line: 5, price: -110 }), 'Buffalo Bills': side('Buffalo Bills', -4.5, -112, { book: 'Caesars', line: -4.5, price: -109 }) },
    moneyline: { 'Detroit Lions': side('Detroit Lions', null, 186, { book: 'BetUS', price: 195 }), 'Buffalo Bills': side('Buffalo Bills', null, -225, { book: 'DraftKings', price: -218 }) },
    total: { OVER: side('OVER', 53.5, -115, { book: 'X', line: 53.5, price: -115 }), UNDER: side('UNDER', 53.5, -105, { book: 'BetMGM', line: 54, price: -108 }) }
  }
};
const SNAP = { captured_at: '2026-09-15T17:00:21Z', captured_at_et: 'Sep 15, 1:00 PM ET', ingest: { status: 'OK' } };
const row = (status, name, pos, abbr, prop = true, updated = '2026-09-14T12:00:00Z') => ({ status, updated_at: updated, player: { name, position: pos, prop_relevant: prop }, team: { abbreviation: abbr }, injury: { type: 'Knee' } });
const CHANGES = {
  window_hours: 48,
  availability: {
    '401872932': [row('OUT', 'Tyrell Shavers', 'WR', 'BUF', true, '2026-08-30T20:42:00Z'), row('QUESTIONABLE', 'Ty Johnson', 'RB', 'BUF'), row('OUT', 'Brian Branch', 'S', 'DET', false), row('DOUBTFUL', 'Jahmyr Gibbs', 'RB', 'DET')],
    '401872946': [row('QUESTIONABLE', 'Joey Porter Jr.', 'CB', 'PIT', false)]
  },
  changes: [
    { kind: 'MARKET_MOVE', status: 'KEY_NUMBER', severity: 'HIGH', observed_at: '2026-09-15T17:00:21Z', observed_basis: 'SOURCE_TIMESTAMP', headline: 'DET @ BUF — BUF spread -3 → -4.5', detail: 'Crossed the key number 3.', game: { id: '401872932', matchup: 'DET @ BUF' } },
    { kind: 'MARKET_MOVE', status: 'MOVED', severity: 'MEDIUM', observed_at: '2026-09-15T16:00:00Z', headline: 'DET @ BUF — Total 51.5 → 53.5', game: { id: '401872932', matchup: 'DET @ BUF' } },
    { kind: 'MARKET_MOVE', status: 'MOVED', severity: 'LOW', observed_at: '2026-09-15T16:00:00Z', headline: 'DET @ BUF — tiny', game: { id: '401872932', matchup: 'DET @ BUF' } },
    { kind: 'INJURY_STATUS', status: 'ACTIVE', severity: 'MEDIUM', observed_at: '2026-09-15T16:00:00Z', headline: 'cleared', player: { name: 'Cleared Guy' }, game: { id: '401872932', matchup: 'DET @ BUF' } },
    { kind: 'MARKET_MOVE', status: 'MOVED', severity: 'HIGH', observed_at: '2026-09-15T15:00:00Z', headline: 'PIT @ NE — NE spread -3.5 → -5.5', game: { id: '401872946', matchup: 'PIT @ NE' } }
  ]
};
const CARD_HIT = { cards: [], previews: [{ publication_scope: 'validation', label: 'PBE VALIDATION SIGNAL', market: 'moneyline', lifecycle: 'ACTIVE', revisions: 0 }, { publication_scope: 'validation', market: 'spread', lifecycle: 'ACTIVE', revisions: 2 }] };

function build(game, over = {}) {
  return P.model({
    now: NOW, detail: { game }, activeId: game.id,
    market: { event: game === DETBUF ? EV_DETBUF : null, snapshot: SNAP, loaded: true },
    pbe: { hit: game === DETBUF ? CARD_HIT : { cards: [], previews: [] }, loaded: true, engine: { publication: 'GATED' } },
    availability: { rows: CHANGES.availability[game.id], loaded: true },
    changes: { data: CHANGES, loaded: true },
    ...over
  });
}

test('lifecycle: the preview exists only for the selected, scheduled game', () => {
  assert.ok(build(DETBUF));
  for (const s of ['LIVE', 'FINAL']) assert.equal(build({ ...DETBUF, status: { semantics: s } }), null, `${s} renders no preview`);
  assert.equal(P.model({ detail: { game: DETBUF }, activeId: PITNE.id }), null, 'detail for another game than the selection renders nothing');
  assert.equal(P.model({ detail: null, activeId: DETBUF.id }), null);
  assert.equal(P.html(null), '');
});

test('identity: two games side by side never share market, injuries, changes or decisions', () => {
  const a = build(DETBUF), b = build(PITNE);
  const ha = P.html(a), hb = P.html(b);
  assert.match(ha, /data-preview-game="401872932"/);
  assert.match(hb, /data-preview-game="401872946"/);
  for (const other of ['Shavers', 'Branch', 'BUF', 'DET', 'Bovada', '-4.5', 'VALIDATION SIGNAL', 'key number']) assert.doesNotMatch(hb, new RegExp(other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `PIT @ NE preview must not show ${other}`);
  for (const other of ['Porter', 'PIT', 'NE spread']) assert.doesNotMatch(ha, new RegExp(other), `DET @ BUF preview must not show ${other}`);
  assert.equal(b.market.state, 'not_posted');
  assert.deepEqual(plain(b.availability.teams.map(t => t.team)), ['PIT', 'NE']);
  assert.equal(b.changes.total, 1);
  assert.equal(b.pbe.state, 'none');
});

test('identity: a market event for another matchup is refused even if handed in', () => {
  const m = P.marketModel({ event: EV_DETBUF, snapshot: SNAP, game: PITNE, loaded: true, now: NOW });
  assert.equal(m.state, 'not_posted');
  assert.equal(m.rejected, true);
});

test('market: consensus and best available from the snapshot, favourite first, nothing recomputed', () => {
  const m = build(DETBUF).market;
  assert.equal(m.state, 'posted');
  assert.equal(m.books, 11);
  assert.deepEqual(plain(m.spread.map(q => [q.team, q.line, q.price])), [['BUF', -4.5, -112], ['DET', 4.5, -108]]);
  assert.deepEqual(plain(m.moneyline.map(q => [q.team, q.price, q.best.price, q.best.book])), [['BUF', -225, -218, 'DraftKings'], ['DET', 186, 195, 'BetUS']]);
  assert.deepEqual(plain(m.total.map(q => [q.team, q.line, q.price])), [['O', 53.5, -115], ['U', 53.5, -105]]);
  assert.equal(m.fresh.label, 'Sep 15, 1:00 PM ET');
  assert.equal(m.fresh.ago, '59m ago', 'an age is never rounded up');
  const h = P.html(build(DETBUF));
  assert.match(h, /best \+5 -110 · Bovada/);
  assert.match(h, /NOT LIVE/);
});

test('market: loading, unavailable and not-posted are distinct, honest states', () => {
  assert.equal(P.marketModel({ loaded: false, game: DETBUF }).state, 'loading');
  assert.equal(P.marketModel({ loaded: false, error: '503', game: DETBUF }).state, 'error');
  assert.match(P.html(build(PITNE)), /Not posted/);
  const partial = P.marketModel({ event: { ...EV_DETBUF, markets: { spread: EV_DETBUF.markets.spread } }, snapshot: SNAP, game: DETBUF, loaded: true, now: NOW });
  assert.equal(partial.moneyline, null);
  assert.equal(partial.total, null);
});

test('PBE intelligence: validation signals are never called official picks; no decision is never invented', () => {
  const p = build(DETBUF).pbe;
  assert.equal(p.state, 'decisions');
  assert.equal(p.locked, true);
  assert.equal(p.official, 0);
  const h = P.html(build(DETBUF));
  assert.match(h, /VALIDATION SIGNAL/);
  assert.doesNotMatch(h, /OFFICIAL PBE PICK/);
  assert.match(h, /not Official PBE Picks/);
  assert.match(h, /Official publication gated/);
  assert.match(P.html(build(PITNE)), /No PBE decision on this game/);
  assert.equal(P.pbeModel({ loaded: false }).state, 'loading');
  assert.equal(P.pbeModel({ loaded: false, error: 'x' }).state, 'error');
  const pro = P.pbeModel({ loaded: true, hit: { cards: [{ publication_scope: 'official', market: 'spread', selection: { display: 'BUF -4.5' }, lifecycle: 'ACTIVE' }] } });
  assert.equal(pro.official, 1);
  assert.equal(pro.rows[0].selection, 'BUF -4.5');
  const finalOnly = P.pbeModel({ loaded: true, hit: { cards: [{ publication_scope: 'official', market: 'spread', lifecycle: 'FINAL' }] } });
  assert.equal(finalOnly.state, 'none', 'a graded decision is not a current pregame decision');
});

test('availability: counts per team, strongest context first, full list folded, stale notes kept', () => {
  const a = build(DETBUF).availability;
  assert.deepEqual(plain(a.teams), [{ team: 'DET', out: 1, doubtful: 1, questionable: 0 }, { team: 'BUF', out: 1, doubtful: 0, questionable: 1 }]);
  assert.deepEqual(plain(a.top.map(r => r.name)), ['Tyrell Shavers', 'Jahmyr Gibbs', 'Ty Johnson']);
  assert.equal(a.top[0].stale, 'Sun, Aug 30', 'a designation not updated in 14 days says so');
  assert.equal(a.all.length, 4);
  assert.match(P.html(build(DETBUF)), /All 4 designations/);
  assert.equal(P.availabilityModel({ rows: [], game: PITNE, loaded: true }).state, 'clear');
  assert.equal(P.availabilityModel({ loaded: false }).state, 'loading');
});

test('what changed: only this game, material rows, HIGH first, cleared players excluded', () => {
  const c = build(DETBUF).changes;
  assert.equal(c.total, 2);
  assert.deepEqual(plain(c.top.map(x => x.headline)), ['BUF spread -3 → -4.5', 'Total 51.5 → 53.5']);
  assert.equal(P.changesModel({ data: { changes: [], window_hours: 48 }, gameId: '1', loaded: true }).state, 'quiet');
});

test('countdown: inside a week only, never negative', () => {
  assert.equal(P.countdown('2026-09-18T00:15Z', NOW).text, 'Kickoff in 2d 6h');
  assert.equal(P.countdown('2026-09-15T20:05Z', NOW).text, 'Kickoff in 2h 5m');
  assert.equal(P.countdown('2026-09-30T20:05Z', NOW), null);
  assert.equal(P.countdown('2026-09-15T17:00Z', NOW).started, true);
  assert.equal(P.countdown(null, NOW), null);
});
