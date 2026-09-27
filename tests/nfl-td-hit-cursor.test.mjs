/* TD target hit read cursor: the EVENT ID is the incremental cursor.
 *
 * view=hits is exercised against a fake nfl_td_target_hit_events that honours
 * the PostgREST filters the read actually sends (id=gt, id=lte, detected_at=gt,
 * order, limit) and keeps detected_at at MICROSECOND precision, as Postgres
 * does — the precision that made the old timestamp cursor re-serve its newest
 * event on every poll. The browser poller (touchdown-hit-live-v1.js) is then
 * run in a VM against the same fake, through a stand-in rail that records
 * offers and applies the rail's own tdhit:<pick_id> session rule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { hitsView, parseAfterId } from '../api/_td-target-hits.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-27T18:32:00Z');
/* the detector as deployed at 27ac822 (Worker 0b0f16d5) */
const DETECTOR_SHA = '2bef1f72b2b77146486065118f581e85a818233cb6eea9141c15fd4db4547460';
const LIVE_HIT_SHA = '821aadf094a1d54602b197fd05b5e2b7b8d76e6211c08c41a261569810e019d8';

/* ---- the fake table -------------------------------------------------------- */
function row(id, detectedAt, pick = `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`) {
  return {
    id, pick_id: pick, detected_at: detectedAt, espn_id: '401872950', season: 2026, week: 3,
    away_team: 'CIN', home_team: 'PIT', away_score: 16, home_score: 17, period: 2, clock: '0:34',
    player_name: `Player ${id}`, espn_player_id: String(4000000 + id), gsis_id: null, position: 'WR', team: 'CIN', opponent: 'PIT',
    headshot_url: null, target_rank: 'secondary', publication_scope: 'tracking', model_prob: 0.41, market_price: 190,
    confidence_bucket: 'B', play_id: `p${id}`, play_type: 'Passing Touchdown', play_text: 'x', play_wallclock: detectedAt,
    live_stats: {}, source: { play_yards: 28 },
  };
}
/* microsecond timestamps compare as strings of fixed width */
const micros = iso => { const m = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|\+00:00)$/.exec(iso); return `${m[1]}.${(m[2] || '').padEnd(6, '0')}`; };
function table(rows) {
  const reads = [];
  const sb = async (path, q) => {
    assert.equal(path, 'nfl_td_target_hit_events');
    const p = new URLSearchParams(q);
    reads.push(decodeURIComponent(q));
    let out = rows.slice();
    for (const [k, v] of p) {
      if (k === 'id' && v.startsWith('gt.')) out = out.filter(r => r.id > Number(v.slice(3)));
      if (k === 'id' && v.startsWith('lte.')) out = out.filter(r => r.id <= Number(v.slice(4)));
      if (k === 'detected_at' && v.startsWith('gt.')) out = out.filter(r => micros(r.detected_at) > micros(new Date(v.slice(3)).toISOString()));
    }
    const order = p.get('order');
    if (order === 'id.asc') out.sort((a, b) => a.id - b.id);
    if (order === 'id.desc') out.sort((a, b) => b.id - a.id);
    out = out.slice(0, Number(p.get('limit') || 1000));
    if (p.get('select') === 'id') return out.map(r => ({ id: r.id }));
    return out;
  };
  return { sb, reads, rows };
}
async function view(t, query, nowMs = NOW) {
  const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
  const send = (r, status, body, cache) => { r.statusCode = status; r.setHeader('cache-control', cache); r.end(JSON.stringify(body)); };
  await hitsView({ res, send, sb: t.sb, secret: 's', query, nowMs });
  return { status: res.statusCode, body: JSON.parse(res.body), cache: res.headers['cache-control'] };
}
const HIGGINS = row(1, '2026-09-27T18:31:28.077492+00:00', 'f6d4c300-9cb1-4334-946a-f22374265adb');

/* ============================================================== the API */

test('1/2 · bootstrap by since returns the recent event, and next_cursor is its id', async () => {
  const t = table([HIGGINS]);
  const out = await view(t, { since: '2026-09-27T18:29:00Z' });
  assert.equal(out.status, 200);
  assert.equal(out.cache, 'no-store');
  assert.equal(out.body.mode, 'since_bootstrap');
  assert.deepEqual(out.body.events.map(e => e.pick_id), [HIGGINS.pick_id]);
  assert.equal(out.body.next_cursor, 1);
  assert.deepEqual(out.body.hits, out.body.events, 'compat alias');
});

test('3/4 · the next poll with after_id returns zero rows — the same event is never re-served', async () => {
  const t = table([HIGGINS]);
  let cursor = (await view(t, { since: '2026-09-27T18:29:00Z' })).body.next_cursor;
  for (let i = 0; i < 60; i++) {
    const out = await view(t, { after_id: String(cursor) });
    assert.equal(out.body.count, 0);
    assert.deepEqual(out.body.events, []);
    assert.equal(out.body.next_cursor, cursor);
    cursor = out.body.next_cursor;
  }
});

test('the defect this replaces: the old since cursor re-served the newest event (microsecond detected_at)', async () => {
  const t = table([HIGGINS]);
  let since = '2026-09-27T18:29:00Z';
  let served = 0;
  for (let i = 0; i < 5; i++) {
    const out = await view(t, { since });
    served += out.body.count;
    since = out.body.cursor;
  }
  assert.equal(served, 5, 'timestamp cursor still re-serves for old clients (compat only)');
});

test('5 · two hits with an IDENTICAL detected_at both arrive exactly once', async () => {
  const same = '2026-09-27T18:31:28.077492+00:00';
  const t = table([row(7, same), row(8, same)]);
  const first = await view(t, { after_id: '6' });
  assert.deepEqual(first.body.events.map(e => e.id), [7, 8]);
  assert.equal(first.body.next_cursor, 8);
  const second = await view(t, { after_id: String(first.body.next_cursor) });
  assert.equal(second.body.count, 0);
  /* and split across two polls */
  const t2 = table([row(7, same)]);
  const a = await view(t2, { after_id: '6' });
  t2.rows.push(row(8, same));
  const b = await view(t2, { after_id: String(a.body.next_cursor) });
  assert.deepEqual([...a.body.events, ...b.body.events].map(e => e.id), [7, 8]);
});

test('6/7/8 · ids 10,11,12: after_id=10 -> 11,12 and next_cursor 12; after_id=12 -> [] and cursor 12', async () => {
  const t = table([row(10, '2026-09-27T18:10:00.000001+00:00'), row(11, '2026-09-27T18:11:00.000001+00:00'), row(12, '2026-09-27T18:12:00.000001+00:00')]);
  const out = await view(t, { after_id: '10' });
  assert.deepEqual(out.body.events.map(e => e.id), [11, 12]);
  assert.equal(out.body.next_cursor, 12);
  const none = await view(t, { after_id: '12' });
  assert.deepEqual(none.body.events, []);
  assert.equal(none.body.next_cursor, 12);
});

test('next_cursor never passes an event that was not returned (bounded page)', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(i + 1, `2026-09-27T18:${String(i).padStart(2, '0')}:00.5+00:00`));
  const t = table(rows);
  const page1 = await view(t, { after_id: '0' });
  assert.equal(page1.body.count, 25);
  assert.equal(page1.body.next_cursor, 25);
  const page2 = await view(t, { after_id: '25' });
  assert.deepEqual(page2.body.events.map(e => e.id), [26, 27, 28, 29, 30]);
});

test('an empty bootstrap hands back the high-water id, never 0 (after_id=0 would replay history)', async () => {
  const t = table([row(40, '2026-09-27T15:00:00.1+00:00'), row(41, '2026-09-27T16:00:00.1+00:00')]);
  const boot = await view(t, { since: '2026-09-27T18:29:00Z' });
  assert.equal(boot.body.count, 0);
  assert.equal(boot.body.next_cursor, 41);
  assert.equal((await view(t, { after_id: String(boot.body.next_cursor) })).body.count, 0);
  /* the high-water read comes first and bounds the window read */
  assert.match(t.reads[0], /select=id&order=id\.desc&limit=1/);
  assert.match(t.reads[1], /id=lte\.41/);
  assert.equal((await view(table([]), { since: '2026-09-27T18:29:00Z' })).body.next_cursor, 0);
});

test('an event inserted between the high-water read and the window read arrives on the first after_id read', async () => {
  const rows = [row(1, '2026-09-27T15:00:00.1+00:00')];
  const t = table(rows);
  const racing = { ...t, sb: async (path, q) => { const out = await t.sb(path, q); if (q.startsWith('select=id')) rows.push(row(2, '2026-09-27T18:31:59.9+00:00')); return out; } };
  const boot = await view(racing, { since: '2026-09-27T18:29:00Z' });
  assert.equal(boot.body.count, 0);
  assert.equal(boot.body.next_cursor, 1);
  assert.deepEqual((await view(t, { after_id: '1' })).body.events.map(e => e.id), [2]);
});

test('9 · an old since-only client still works', async () => {
  const t = table([HIGGINS]);
  const out = await view(t, { since: '2026-09-27T18:29:00Z' });
  assert.deepEqual(out.body.hits.map(e => e.pick_id), [HIGGINS.pick_id]);
  assert.equal(typeof out.body.cursor, 'string');
});

test('10 · after_id takes precedence when both are supplied', async () => {
  const t = table([HIGGINS]);
  const out = await view(t, { since: '2026-09-27T18:29:00Z', after_id: '1' });
  assert.equal(out.body.mode, 'after_id');
  assert.equal(out.body.count, 0);
  assert.ok(t.reads.every(q => !q.includes('detected_at=gt.')) && t.reads.every(q => q.includes('id=gt.1')));
});

test('after_id must be a non-negative integer', async () => {
  for (const bad of ['-1', 'abc', '1.5', '1;drop', '9'.repeat(20)]) {
    assert.equal(parseAfterId(bad), null);
    assert.equal((await view(table([]), { after_id: bad })).status, 400);
  }
  assert.equal(parseAfterId('0'), 0);
});

test('14 · a fresh new hit after the cursor is delivered normally, once', async () => {
  const t = table([HIGGINS]);
  const boot = await view(t, { since: '2026-09-27T18:29:00Z' });
  t.rows.push(row(2, '2026-09-27T20:41:03.123456+00:00'));
  const next = await view(t, { after_id: String(boot.body.next_cursor) });
  assert.deepEqual(next.body.events.map(e => e.id), [2]);
  assert.equal(next.body.next_cursor, 2);
  assert.equal((await view(t, { after_id: '2' })).body.count, 0);
});

/* ============================================================ the poller */

function loadPoller(t, { nowMs = NOW, storage = new Map() } = {}) {
  const offers = [];
  const seen = new Set();
  const requests = [];
  const PBEBreaking = {
    PRIORITY: { TD_TARGET_HIT: 2.5 }, CONFIG: { visible_ms: { TD_TARGET_HIT: 26000 } },
    offer(ev) { requests.at(-1).offered.push(ev.key); if (seen.has(ev.key)) return { accepted: false }; seen.add(ev.key); offers.push(ev.key); return { accepted: true }; },
  };
  const fetch = async url => {
    const u = new URL(url, 'https://nfl.propbetedge.ai');
    requests.push({ q: u.search, offered: [] });
    const out = await view(t, Object.fromEntries(u.searchParams), nowMs);
    return { ok: out.status === 200, json: async () => out.body };
  };
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [nowMs])); } static now() { return nowMs; } }
  const window = { PBEBreaking };
  const sessionStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) };
  const document = { readyState: 'loading', visibilityState: 'visible', addEventListener() {} };
  const ctx = vm.createContext({ window, document, sessionStorage, fetch, setInterval: () => 1, clearInterval() {}, Date: FakeDate, JSON, Number, Math, String, Array, encodeURIComponent, URL });
  vm.runInContext(read('touchdown-hit-live-v1.js'), ctx);
  return { api: window.PBETouchdownHits, offers, requests, storage, seen };
}

test('poller: bootstrap by since once, then after_id only — the Higgins event is offered once and never re-fetched', async () => {
  const t = table([HIGGINS]);
  const p = loadPoller(t, { nowMs: Date.parse('2026-09-27T18:32:00Z') });
  for (let i = 0; i < 10; i++) await p.api.poll();
  assert.match(p.requests[0].q, /since=/);
  assert.ok(p.requests.slice(1).every(r => /after_id=1$/.test(r.q) && !/since=/.test(r.q)), JSON.stringify(p.requests.map(r => r.q)));
  assert.deepEqual(p.requests.map(r => r.offered.length), [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(p.offers, [`tdhit:${HIGGINS.pick_id}`]);
});

test('13 · a same-session reload continues from the id cursor: no bootstrap, no replay', async () => {
  const t = table([HIGGINS]);
  const storage = new Map();
  const first = loadPoller(t, { storage });
  await first.api.poll();
  const reloaded = loadPoller(t, { storage, nowMs: NOW + 20_000 });
  await reloaded.api.poll();
  assert.match(reloaded.requests[0].q, /after_id=1$/);
  assert.equal(reloaded.requests[0].offered.length, 0);
});

test('a session cursor older than the bootstrap window is dropped: the tab bootstraps, it does not replay the gap', async () => {
  const t = table([HIGGINS]);
  const storage = new Map([['pbe.tdhit.after_id.v2', JSON.stringify({ id: 0, at: NOW - 60 * 60_000 })]]);
  const p = loadPoller(t, { storage, nowMs: Date.parse('2026-09-27T20:00:00Z') });
  await p.api.poll();
  assert.match(p.requests[0].q, /since=/);
  assert.equal(p.offers.length, 0, 'an afternoon hit is not celebrated in the evening');
});

test('11/14 · poller: a new hit after the cursor arrives once; session dedupe still sits underneath', async () => {
  const t = table([HIGGINS]);
  const p = loadPoller(t);
  await p.api.poll();
  t.rows.push(row(2, '2026-09-27T18:33:00.000001+00:00'));
  await p.api.poll();
  await p.api.poll();
  assert.equal(p.api._test.cursor(), 2);
  assert.deepEqual(p.offers, [`tdhit:${HIGGINS.pick_id}`, `tdhit:${row(2, 'x').pick_id}`]);
  const src = read('touchdown-hit-live-v1.js');
  assert.match(src, /key: `tdhit:\$\{hit\.pick_id\}`/);
  assert.match(read('pbe-breaking-v1.js'), /if \(state\.seen\.has\(ev\.key\)\) \{/);
});

test('poller never advances past an event the response did not return', () => {
  const t = loadPoller(table([]))._test ?? null;
  const { nextCursorFrom } = loadPoller(table([])).api._test;
  assert.equal(nextCursorFrom({ next_cursor: 99 }, [{ id: 11 }, { id: 12 }], 10), 12);
  assert.equal(nextCursorFrom({ next_cursor: 12 }, [{ id: 11 }, { id: 12 }], 10), 12);
  assert.equal(nextCursorFrom({ next_cursor: 50 }, [], 10), 10);
  assert.equal(nextCursorFrom({ next_cursor: 41 }, [], null), 41);
  assert.equal(nextCursorFrom({}, [], null), null);
  void t;
});

/* ========================================================= untouched parts */

test('15/16 · detector Worker, detection module and final grader are byte-for-byte unchanged by the cursor fix', () => {
  const sha = path => createHash('sha256').update(read(path).replace(/\r\n/g, '\n')).digest('hex');
  assert.equal(sha('workers/nfl-touchdown-targets-grader/src/index.js'), '8b28351932eb0f965683485647ddf6514e73ee551e696cc7755c5cd25b68df11');
  assert.equal(sha('workers/nfl-td-targets-shared/td-grading.mjs'), '2551516e7d2df3ef9442399a5b0595bc5eeeef9c5154a7a3b4480e3cdef7fa9a');
  assert.equal(sha('workers/nfl-touchdown-target-hit-alerts/src/index.js'), DETECTOR_SHA);
  assert.equal(sha('workers/nfl-td-targets-shared/td-live-hit.mjs'), LIVE_HIT_SHA);
});
