/**
 * Touchdown Targets nav install — boot regression.
 *
 * Production threw on every boot:
 *   NotFoundError: Failed to execute 'insertBefore' on 'Node': The node before
 *   which the new node is to be inserted is not a child of this node.
 *   at installNav (touchdown-targets-v1.js:659)
 * because the shell renders its nav buttons INSIDE <span class="pbes-nav-group">
 * wrappers (sports-shell-v2.js navGroup), so the anchor found with
 * primary.querySelector('[data-route="trackrecord"]') is a descendant of
 * .pbes-primary, not a child. installNav must insert relative to the anchor's
 * own parent. This test runs the real module against a tiny DOM whose
 * insertBefore enforces the browser's child check.
 *
 *   node --test tests/nfl-td-targets-nav.test.mjs
 *   TD_TARGETS_SRC=<path> …  runs another copy of the module (mutation proof)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const SRC = process.env.TD_TARGETS_SRC || new URL('../touchdown-targets-v1.js', import.meta.url);

/* ---- a minimal DOM with real tree semantics ------------------------------ */
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attributes = {}; this.dataset = {}; this.style = {}; this.innerHTML = ''; this.textContent = ''; this._classes = new Set(); this.listeners = {}; }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() { const s = this._classes; return { add: (...c) => c.forEach(x => s.add(x)), remove: (...c) => c.forEach(x => s.delete(x)), toggle: (c, f) => { (f === undefined ? !s.has(c) : f) ? s.add(c) : s.delete(c); return s.has(c); }, contains: c => s.has(c) }; }
  get id() { return this.attributes.id || ''; }
  set id(v) { this.attributes.id = v; }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5)] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  appendChild(node) { if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1); node.parentNode = this; this.children.push(node); return node; }
  insertBefore(node, ref) {
    if (ref == null) return this.appendChild(node);
    const i = this.children.indexOf(ref);
    if (i < 0) { const e = new Error("Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node."); e.name = 'NotFoundError'; throw e; }
    if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
    node.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, node); return node;
  }
  get previousElementSibling() { const p = this.parentNode; if (!p) return null; const i = p.children.indexOf(this); return i > 0 ? p.children[i - 1] : null; }
  matches(sel) {
    return sel.split(',').some(s => { s = s.trim();
      let m; if ((m = s.match(/^#([\w-]+)$/))) return this.id === m[1];
      if ((m = s.match(/^\.([\w-]+)$/))) return this._classes.has(m[1]);
      if ((m = s.match(/^\[data-route="([^"]+)"\]$/))) return this.dataset.route === m[1];
      return false; });
  }
  *descendants() { for (const c of this.children) { yield c; yield* c.descendants(); } }
  querySelector(sel) { for (const el of this.descendants()) if (el.matches(sel)) return el; if (sel.includes(' ')) { const [head, ...rest] = sel.split(/\s+/); const scope = this.querySelector(head); return scope ? scope.querySelector(rest.join(' ')) : null; } return null; }
  querySelectorAll(sel) { return [...this.descendants()].filter(el => el.matches(sel)); }
}
function makeDocument() {
  const root = new Element('html'); const body = new Element('body'); root.appendChild(body);
  const document = { body, documentElement: root, readyState: 'complete', addEventListener() {}, createElement: tag => new Element(tag), querySelector: s => root.querySelector(s), querySelectorAll: s => root.querySelectorAll(s), getElementById: id => [...root.descendants()].find(el => el.id === id) || null };
  return { document, body };
}
/* The shell as sports-shell-v2.js renders it: buttons inside nav groups. */
function mountShell(body) {
  const shell = new Element('div'); shell.id = 'pbe-sports-shell'; body.appendChild(shell);
  const primary = new Element('nav'); primary.className = 'pbes-primary'; shell.appendChild(primary);
  const group = new Element('span'); group.className = 'pbes-nav-group'; primary.appendChild(group);
  const label = new Element('span'); label.className = 'pbes-nav-label'; label.textContent = 'INTELLIGENCE'; group.appendChild(label);
  const picks = new Element('button'); picks.className = 'pbes-nav-btn'; picks.setAttribute('data-route', 'picks'); group.appendChild(picks);
  const trackrecord = new Element('button'); trackrecord.className = 'pbes-nav-btn'; trackrecord.setAttribute('data-route', 'trackrecord'); group.appendChild(trackrecord);
  // Legacy sidebar group: the anchor sits inside a wrapper too.
  const legacy = new Element('div'); legacy.id = 'intelligence-nav-group'; body.appendChild(legacy);
  const wrap = new Element('div'); legacy.appendChild(wrap);
  const navPicks = new Element('a'); navPicks.id = 'nav-picks'; wrap.appendChild(navPicks);
  return { primary, group, trackrecord, legacy, wrap, navPicks };
}
function boot(document) {
  const window = { App: { VIEWS: {}, current: 'home', nav() {} }, PBEPro: { state: { pro: false } }, location: { href: 'https://nfl.propbetedge.ai/', search: '', hash: '' }, addEventListener() {}, dispatchEvent() {}, matchMedia: () => ({ matches: false }) };
  window.window = window;
  const ctx = vm.createContext({ window, document, console, URL, setTimeout() { return 0; }, clearTimeout() {}, requestAnimationFrame() { return 0; }, CustomEvent: class {}, sessionStorage: { getItem() { return null; }, setItem() {} }, localStorage: { getItem() { return null; }, setItem() {} }, fetch: async () => ({ ok: false, json: async () => ({}) }), location: window.location, navigator: { userAgent: 'test' } });
  vm.runInContext(readFileSync(SRC, 'utf8'), ctx, { filename: 'touchdown-targets-v1.js' });
  return window;
}

test('installNav mounts TD Targets before Track Record INSIDE the shell nav group without throwing', () => {
  const { document, body } = makeDocument();
  const { group, trackrecord, wrap, navPicks } = mountShell(body);
  const window = boot(document);                       // init() already ran installNav once
  assert.doesNotThrow(() => window.PBETouchdownTargets.installNav());
  const shellBtn = group.children.find(el => el.dataset.route === 'tdtargets');
  assert.ok(shellBtn, 'TD Targets button is a child of the nav group');
  assert.equal(trackrecord.previousElementSibling, shellBtn, 'TD Targets sits immediately before Track Record');
  assert.equal(group.children.filter(el => el.dataset.route === 'tdtargets').length, 1, 'installed once, even after repeated installs');
  const legacyLink = wrap.children.find(el => el.id === 'nav-tdtargets');
  assert.ok(legacyLink, 'legacy sidebar link lands in the anchor\'s own parent');
  assert.equal(navPicks.previousElementSibling, legacyLink);
});

test('installNav is a no-op without the shell and never throws', () => {
  const { document } = makeDocument();
  const window = boot(document);
  assert.doesNotThrow(() => window.PBETouchdownTargets.installNav());
});
