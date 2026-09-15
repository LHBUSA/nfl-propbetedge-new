/* PBEcast FULL GAME LOG collapse: the real pbecast-v6.js in a sandbox with a
 * counting fetch and counting timers. Collapsed by default, remembered per
 * game in memory, preserved across re-renders, plays and count kept current
 * while collapsed, and toggling costs no request and no timer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function sandbox() {
  const counts = { fetch: 0, setTimeout: 0 };
  const noop = () => {};
  const document = { visibilityState: 'visible', addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  const ctx = {
    window: { App: null, addEventListener: noop }, document, console, AbortController, Date, JSON, Math, Number, String, Array, Map, Set, Object, Promise,
    localStorage: { getItem: () => null, setItem: noop }, sessionStorage: { getItem: () => null, removeItem: noop },
    fetch: () => { counts.fetch++; return new Promise(noop); },
    setTimeout: () => { counts.setTimeout++; return 0; }, clearTimeout: noop
  };
  vm.runInNewContext(readFileSync(new URL('../pbecast-v6.js', import.meta.url), 'utf8'), ctx);
  return { cast: ctx.window.PBEcastV6, counts };
}
const plays = n => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, sequence: i + 1, type: 'Rush', text: `play ${i + 1}`, period: 1, clock: '10:00' }));
const view = html => ({
  expanded: /aria-expanded="(true|false)"/.exec(html)?.[1],
  controls: /aria-controls="([^"]+)"/.exec(html)?.[1],
  listId: /class="cast6-feed-scroll" id="([^"]+)"/.exec(html)?.[1],
  hidden: /id="cast6-feed-plays" hidden/.test(html),
  rows: (html.match(/class="cast6-play /g) || []).length,
  count: /data-feed-count>(\d+) published plays/.exec(html)?.[1],
  label: /<button[^>]*data-feed-toggle[^>]*><span>([^<]+)<\/span>/.exec(html)?.[1],
  open: /class="cast6-module cast6-feed is-open"/.test(html)
});

test('collapsed by default: header, count and button present; plays rendered but hidden', () => {
  const { cast } = sandbox();
  cast.state.activeId = 'G1';
  cast.state.detail = { plays: plays(87) };
  const v = view(cast.liveFeedHtml());
  assert.equal(v.expanded, 'false');
  assert.equal(v.controls, 'cast6-feed-plays');
  assert.equal(v.listId, 'cast6-feed-plays', 'aria-controls names the list');
  assert.equal(v.hidden, true);
  assert.equal(v.rows, 87, 'history already loaded while collapsed');
  assert.equal(v.count, '87');
  assert.equal(v.label, 'Show plays');
  assert.equal(v.open, false);
});

test('expand and collapse; the state is part of every later render; no request, no timer', () => {
  const { cast, counts } = sandbox();
  cast.state.activeId = 'G1';
  cast.state.detail = { plays: plays(87) };
  const before = { ...counts };
  cast.toggleFeed();
  let v = view(cast.liveFeedHtml());
  assert.deepEqual([v.expanded, v.hidden, v.label, v.open].join(), 'true,false,Hide plays,true');
  /* polling lands two more plays and re-renders */
  cast.state.detail = { plays: plays(89) };
  v = view(cast.liveFeedHtml());
  assert.equal(v.expanded, 'true', 'a re-render does not collapse it');
  assert.equal(v.rows, 89);
  cast.toggleFeed();
  v = view(cast.liveFeedHtml());
  assert.deepEqual([v.expanded, v.hidden, v.label].join(), 'false,true,Show plays');
  assert.deepEqual([counts.fetch - before.fetch, counts.setTimeout - before.setTimeout].join(), '0,0', 'toggling issues no fetch and arms no timer');
});

test('count and plays keep updating while collapsed', () => {
  const { cast } = sandbox();
  cast.state.activeId = 'G1';
  cast.state.detail = { plays: plays(40) };
  assert.equal(view(cast.liveFeedHtml()).count, '40');
  cast.state.detail = { plays: plays(41) };
  const v = view(cast.liveFeedHtml());
  assert.equal(v.count, '41');
  assert.equal(v.rows, 41);
  assert.equal(v.hidden, true);
});

test('another game defaults to collapsed; the expanded game is remembered in memory', () => {
  const { cast } = sandbox();
  cast.state.activeId = 'G1';
  cast.state.detail = { plays: plays(10) };
  cast.toggleFeed();
  assert.equal(view(cast.liveFeedHtml()).expanded, 'true');
  cast.state.activeId = 'G2';
  assert.equal(view(cast.liveFeedHtml()).expanded, 'false', 'new game starts collapsed');
  cast.state.activeId = 'G1';
  assert.equal(view(cast.liveFeedHtml()).expanded, 'true', 'returning to the game keeps its choice');
});

test('the log markup carries no internal scroll or height cap', () => {
  const css = readFileSync(new URL('../pbecast-v6.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of css.matchAll(/([^{}]*cast6-feed[^{}]*)\{([^{}]*)\}/g)) {
    assert.doesNotMatch(m[2], /max-height|overflow(-y)?\s*:\s*(auto|scroll|hidden)|(?<![-\w])height\s*:\s*\d/, `${m[1].trim()} must not cap or scroll`);
  }
});
