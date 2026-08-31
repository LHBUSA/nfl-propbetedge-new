/* Repo-wide guard against the freeze class that wedged production.
 *
 * The defect: a MutationObserver watching document.body with subtree:true,
 * whose callback performs an UNCONDITIONAL DOM write. The write re-triggers
 * the observer that scheduled it. When the work is scheduled with
 * queueMicrotask, observer delivery and the work are both microtasks, so the
 * queue never drains: no paint, no input, no DevTools. That is what froze
 * https://nfl.propbetedge.ai.
 *
 * The previous CI check hand-listed five files and missed the offender
 * entirely. This one derives the ACTIVE module set from index.html and
 * page-loader.js, so a module cannot escape by not being on a list.
 */

import { readFileSync, existsSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const loader = readFileSync('page-loader.js', 'utf8');

const active = new Set();
for (const m of html.matchAll(/src="\.\/([^"?]+\.js)"/g)) active.add(m[1]);
for (const m of loader.matchAll(/'\.\/([a-z0-9._-]+\.js)'/gi)) active.add(m[1]);

const files = [...active].filter(f => existsSync(f)).sort();
if (!files.length) { console.error('no active modules resolved'); process.exit(1); }

/* Modules allowed to observe document.body, with the reason. Each still may
 * NOT schedule DOM work on a microtask (see the second rule). */
const BODY_OBSERVER_ALLOWLIST = new Map([
  ['network-footer-v1.js', 'footer re-insert is guarded by getElementById early-return'],
  ['sports-shell-auth-state.js', 'guarded by [data-pbe-auth-degraded] idempotence check'],
  ['model-lab-v2-enhance.js', 'route-guarded and diffs before writing'],
  ['prop-board-v4.js', 'route-guarded enhance queue'],
  ['simulator-v3-enhance.js', 'route-guarded and diffs before writing'],
]);

let failures = 0;
const note = (file, msg) => { console.error(`FAIL ${file}: ${msg}`); failures += 1; };

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  if (!/new MutationObserver/.test(src)) continue;

  const observesBody = /\.observe\(\s*(document\.body|document\.documentElement|root)\b/.test(src)
    && /subtree\s*:\s*true/.test(src);

  if (observesBody && !BODY_OBSERVER_ALLOWLIST.has(file)) {
    note(file, 'observes document.body with subtree:true and is not allowlisted. '
      + 'Scope the observer to its own host element, or add it to the allowlist with a reason.');
  }

  /* The specific killer: microtask-scheduled work from an observer. A
   * microtask cannot yield to the event loop, so a feedback loop is fatal
   * rather than merely wasteful. */
  if (/new MutationObserver\([\s\S]{0,400}?queueMicrotask/.test(src)) {
    note(file, 'schedules work with queueMicrotask from a MutationObserver callback. '
      + 'Use a coalesced setTimeout/requestAnimationFrame so the event loop can still paint.');
  }
}

/* The exact regression that caused the outage. */
const v8 = 'dashboard-v8-enhance.js';
if (existsSync(v8)) {
  const src = readFileSync(v8, 'utf8');
  if (/host\.innerHTML\s*=\s*marketHtml\(\)/.test(src)) {
    note(v8, 'renderMarket() writes innerHTML unconditionally. It must diff first '
      + '(if (host.innerHTML !== next) ...) or it re-triggers its own observer.');
  }
}

if (failures) {
  console.error(`\n${failures} observer-safety violation(s) across ${files.length} active modules.`);
  process.exit(1);
}
console.log(`Observer safety OK across ${files.length} active modules.`);
